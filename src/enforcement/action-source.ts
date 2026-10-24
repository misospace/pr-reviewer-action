import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * #1238: reads a file from the EXECUTING ACTION's own source tree — the
 * tree of the revision this run executes (the action's install directory),
 * not the reviewed repository. The blocker-verification boundary uses it as
 * the witness for gate-absence claims: a claim that a deterministic gate of
 * the action is absent can only be decided by the action's own
 * implementation.
 *
 * The reader is read-only, offline, and bounded: no shell, no exec, no
 * network, no writes. Only paths that come from the registry constants are
 * ever read — a path taken from a finding, a model message, or any other
 * untrusted input never reaches this module.
 */
export interface ActionSourceReadOk {
  status: "ok";
  text: string;
}

export interface ActionSourceReadUnavailable {
  status: "unavailable";
  reason: string;
}

export type ActionSourceReadResult = ActionSourceReadOk | ActionSourceReadUnavailable;
export type ActionSourceReader = (relativePath: string) => Promise<ActionSourceReadResult>;

/**
 * Upper bound on the bytes one action-source read may pull. The files the
 * registry cites are tens of kilobytes; the cap keeps a pathological tree
 * from turning the boundary into a memory sink.
 */
export const MAX_ACTION_SOURCE_BYTES = 1024 * 1024;

export interface ActionSourceReaderOptions {
  /**
   * The action's own source root. Defaults to `GITHUB_ACTION_PATH` when
   * the runner provides it, else the shipped bundle's own location.
   */
  root?: string | null;
  /**
   * The REVIEWED repository's checkout path. A root inside it is refused:
   * the reviewed repository's bytes are PR-controlled, so they must never
   * decide a refutation (the `uses: ./` shape — the action under review
   * IS the reviewed repository).
   */
  workspaceRoot?: string | null;
}

/**
 * The action's own source root.
 *
 * (a) `GITHUB_ACTION_PATH` when it is a non-empty absolute path — the
 * action's install directory as the runner reports it; read if present,
 * never required.
 * (b) otherwise the bundle's own location: in the shipped `dist/index.js`
 * this is the action root (the parent of `dist/`), while in the test build
 * it points inside `.test-build` and simply finds nothing — the intended
 * fail-safe.
 */
export function resolveActionSourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.GITHUB_ACTION_PATH;
  if (typeof candidate === "string" && candidate.trim() !== "" && isAbsolute(candidate)) {
    return resolve(candidate);
  }
  return resolve(__dirname, "..");
}

type ActionRootCheck = { ok: true; real: string } | { ok: false; reason: string };

/** The realpath of `path`, or null when it cannot be resolved. */
async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** True when `candidate` IS `parent` or lies inside it. */
function isInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep);
}

/**
 * #1238: the witness root's provenance. Two properties must hold before a
 * single byte is served:
 *
 * (a) the root must NOT be the reviewed repository (or live inside it) —
 *     PR-controlled bytes can never decide a refutation of the action's own
 *     gates;
 * (b) the root must BE an action checkout: it must carry an `action.yml`
 *     manifest that resolves (under the same containment rule as every
 *     other read) to a regular file inside it.
 *
 * A root failing either check refuses every read; a refused read is no
 * evidence, so the boundary keeps the claim unverified.
 */
async function verifyActionRoot(base: string, workspaceRoot: string | null): Promise<ActionRootCheck> {
  if (workspaceRoot !== null) {
    const rootReal = await realPathOrNull(base);
    const workspaceReal = await realPathOrNull(workspaceRoot);
    if (rootReal !== null && workspaceReal !== null && isInside(rootReal, workspaceReal)) {
      return { ok: false, reason: "root-inside-workspace" };
    }
    if (isInside(base, workspaceRoot)) return { ok: false, reason: "root-inside-workspace" };
  }
  const rootReal = await realPathOrNull(base);
  if (rootReal === null) return { ok: false, reason: "root-not-an-action" };
  const manifest = resolve(base, "action.yml");
  if (manifest !== base && !manifest.startsWith(base + sep)) {
    return { ok: false, reason: "root-not-an-action" };
  }
  const manifestReal = await realPathOrNull(manifest);
  if (manifestReal === null) return { ok: false, reason: "root-not-an-action" };
  if (!isInside(manifestReal, rootReal)) return { ok: false, reason: "root-not-an-action" };
  const info = await stat(manifestReal).catch(() => null);
  if (info === null || !info.isFile()) return { ok: false, reason: "root-not-an-action" };
  return { ok: true, real: rootReal };
}

/**
 * A reader over the action's own source tree.
 *
 * Containment: the relative path is resolved under the root and the file's
 * realpath is compared against the root's realpath, so a symlink escaping
 * the root is rejected. Everything the reader cannot decide — a missing
 * file, an oversized file, an escaping symlink, a root that is not an
 * action checkout — is reported as `unavailable`, never as evidence.
 */
export function createActionSourceReader(options: ActionSourceReaderOptions = {}): ActionSourceReader {
  const base = options.root === undefined || options.root === null || options.root.trim() === ""
    ? resolveActionSourceRoot(process.env)
    : resolve(options.root);
  const workspaceRoot = options.workspaceRoot === undefined || options.workspaceRoot === null || options.workspaceRoot.trim() === ""
    ? null
    : resolve(options.workspaceRoot);
  // The root's provenance is decided once per reader: it cannot change
  // under the reader's own feet, and re-checking it per read would stat
  // the same paths for every cited file.
  let rootCheck: Promise<ActionRootCheck> | null = null;
  const checkRoot = (): Promise<ActionRootCheck> => {
    if (rootCheck === null) rootCheck = verifyActionRoot(base, workspaceRoot);
    return rootCheck;
  };
  return async (relativePath: string): Promise<ActionSourceReadResult> => {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      return { status: "unavailable", reason: "invalid-path" };
    }
    const target = resolve(base, relativePath);
    if (target !== base && !target.startsWith(base + sep)) {
      return { status: "unavailable", reason: "outside-action-root" };
    }
    const root = await checkRoot();
    if (!root.ok) return { status: "unavailable", reason: root.reason };
    let targetReal: string;
    try {
      targetReal = await realpath(target);
    } catch {
      return { status: "unavailable", reason: "not-found" };
    }
    if (!isInside(targetReal, root.real)) {
      return { status: "unavailable", reason: "outside-action-root" };
    }
    try {
      const info = await stat(targetReal);
      if (!info.isFile()) return { status: "unavailable", reason: "not-a-file" };
      if (info.size > MAX_ACTION_SOURCE_BYTES) return { status: "unavailable", reason: "too-large" };
    } catch {
      return { status: "unavailable", reason: "not-found" };
    }
    try {
      return { status: "ok", text: await readFile(targetReal, "utf8") };
    } catch {
      return { status: "unavailable", reason: "read-failed" };
    }
  };
}
