/** The worker side of the syntax-provider seam (#764).
 *
 * Every provider runs in an ISOLATED WORKER THREAD, and this module is
 * what runs inside it. Two consequences shape the whole file:
 *
 *   - The parent bounds every call with a REAL timer and TERMINATES the
 *     worker when the bound expires, so a provider that blocks — even
 *     synchronously, even forever — cannot outlive the bound.
 *   - NO FILE CONTENT CROSSES THE THREAD BOUNDARY. A request carries the
 *     repository-relative path (plus the line and the name); the worker
 *     reads the file itself through the repository's own safe reader
 *     (`readHeadLines`), which refuses absolute paths, `..`, `.git`
 *     components, symlinks and oversized files, and never throws.
 *
 * The worker is the only place a provider's code runs. A provider that
 * throws is reported as a FAILED CALL (the builder counts the failures and
 * disables a provider that keeps failing); a file that cannot be read is
 * reported as a NULL answer, which is a per-file skip and NOT a provider
 * failure. */

import { createRequire } from "node:module";
import type { MessagePort } from "node:worker_threads";
import { detectLanguage, readHeadLines } from "../change-anchors.js";
import { structuralSyntaxProvider } from "./providers/structural.js";
import type { SyntaxFile, SyntaxProvider, SyntaxProviderRegistration } from "./types.js";

/** How many parsed files the worker keeps. The builder processes ONE file
 * at a time, so a ONE-file cache keeps the documented property (the
 * candidate phase holds one file, so neither its time nor its memory grows
 * with the repository) and costs at most one extra re-read per file. A
 * bigger cache would let a provider keep a parsed form of every file it
 * was handed. */
export const MAX_SYNTAX_WORKER_CACHED_FILES = 1;

/** The methods a provider implements. */
export type SyntaxProviderMethod = "declarations" | "identifiersOnLine" | "classify";

/** One request from the parent. */
export interface SyntaxProviderRequest {
  requestId: number;
  method: SyntaxProviderMethod;
  /** Repository-relative POSIX path. */
  path: string;
  /** 1-based line, for the line-scoped methods. */
  line?: number;
  /** The name at the site, for `classify`. */
  name?: string;
}

/** The worker's init: the port to serve, the provider to build and the
 * workspace it reads from. */
export interface SyntaxProviderWorkerInit {
  parentPort: MessagePort;
  registration: SyntaxProviderRegistration;
  /** Workspace root (absolute). */
  workspace: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a value implements the provider seam. */
function isProvider(value: unknown): value is SyntaxProvider {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<SyntaxProvider>;
  return (
    typeof candidate.declarations === "function" &&
    typeof candidate.identifiersOnLine === "function" &&
    typeof candidate.classify === "function"
  );
}

/** The module's BASE NAME.
 *
 * A load failure reaches the published artifact, and an absolute path in
 * it leaks the runner's filesystem layout into a PR comment. The module is
 * named by its base name only. */
function moduleBasename(modulePath: string): string {
  const parts = modulePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? modulePath;
}

/** An absolute path (POSIX or Windows) inside a message. The path must not
 * start in the middle of a word ("and/or" is not a path). */
const ABSOLUTE_PATH_PATTERN = /(?<![\w])((?:[A-Za-z]:)?(?:[\\/][^\s'"()]+)+)/g;

/** The FIRST LINE of a cause, with every absolute path reduced to its base
 * name: the runner's own layout (the require stack, the module's own
 * path) must never reach the published artifact. */
function firstLineOf(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.replace(ABSOLUTE_PATH_PATTERN, (match) => moduleBasename(match));
}

/** Build the provider the registration describes.
 *
 * `builtin` is the dependency-free structural provider. `module` loads the
 * named module in THIS thread and takes the exported factory (the
 * `default` export unless another name is configured); the factory is
 * called with the registration's options and must return a provider. A
 * module that cannot be loaded, that does not export the factory, or that
 * returns something which does not implement the seam fails with a clear
 * message — the parent turns that into a degraded stage.
 *
 * The message names the provider id, the module's BASE NAME and the FIRST
 * LINE of the cause: an absolute path (the module's own, or the runner's
 * require stack) must never reach the published artifact. */
function loadProvider(registration: SyntaxProviderRegistration): SyntaxProvider {
  const loader = registration.loader;
  if (loader.kind === "builtin") return structuralSyntaxProvider;
  const request = createRequire(__filename);
  const modulePath = loader.module;
  const base = moduleBasename(modulePath);
  let moduleExports: unknown;
  try {
    moduleExports = request(modulePath);
  } catch (error) {
    throw new Error(
      `syntax provider "${registration.id}" could not load module "${base}": ${firstLineOf(messageOf(error))}`,
    );
  }
  const name = loader.export ?? "default";
  const holder = moduleExports as Record<string, unknown> | null;
  let exported: unknown = holder === null ? undefined : holder[name];
  // A CommonJS module may export the factory itself.
  if (exported === undefined && name === "default" && typeof moduleExports === "function") {
    exported = moduleExports;
  }
  if (exported === undefined) {
    throw new Error(`syntax provider "${registration.id}" could not load module "${base}": it does not export "${name}"`);
  }
  const provider =
    typeof exported === "function"
      ? (exported as (options?: Record<string, unknown>) => unknown)(loader.options ?? {})
      : exported;
  if (!isProvider(provider)) {
    throw new Error(
      `syntax provider "${registration.id}" does not implement the provider seam (declarations, identifiersOnLine, classify)`,
    );
  }
  return provider;
}

/** The request the parent sent, or null when the message is not one. */
function parseRequest(message: unknown): SyntaxProviderRequest | null {
  if (message === null || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  const requestId = record.requestId;
  const method = record.method;
  const path = record.path;
  if (typeof requestId !== "number" || !Number.isFinite(requestId)) return null;
  if (typeof path !== "string" || path === "") return null;
  if (method !== "declarations" && method !== "identifiersOnLine" && method !== "classify") return null;
  const line = typeof record.line === "number" && Number.isFinite(record.line) ? record.line : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  return {
    requestId,
    method,
    path,
    ...(line === undefined ? {} : { line }),
    ...(name === undefined ? {} : { name }),
  };
}

/** Serve the parent's requests until the parent terminates the worker. */
export function syntaxProviderWorker(init: SyntaxProviderWorkerInit): void {
  const { parentPort, registration, workspace } = init;
  // A provider that cannot even be built fails HERE: the parent's worker
  // "error" event turns it into a recorded, non-fatal degradation.
  const provider = loadProvider(registration);

  const cache = new Map<string, SyntaxFile | null>();

  /** The file a request names, read through the safe reader. Null when the
   * file cannot be read: a per-file skip, not a provider failure. */
  const fileFor = (path: string): SyntaxFile | null => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const lines = readHeadLines(workspace, path);
    const language = detectLanguage(path);
    const file = lines === null ? null : { path, language, lines };
    if (cache.size >= MAX_SYNTAX_WORKER_CACHED_FILES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(path, file);
    return file;
  };

  parentPort.on("message", (message: unknown) => {
    const request = parseRequest(message);
    if (request === null) return;
    try {
      const file = fileFor(request.path);
      if (file === null) {
        // The file could not be read: an EMPTY answer, not an error.
        parentPort.postMessage({ requestId: request.requestId, ok: true, value: null });
        return;
      }
      let value: unknown;
      if (request.method === "declarations") {
        value = provider.declarations(file);
      } else if (request.method === "identifiersOnLine") {
        value = provider.identifiersOnLine(file, request.line ?? 1);
      } else {
        value = provider.classify(file, request.line ?? 1, request.name ?? "");
      }
      parentPort.postMessage({ requestId: request.requestId, ok: true, value });
    } catch (error) {
      parentPort.postMessage({ requestId: request.requestId, ok: false, error: messageOf(error) });
    }
  });
}
