import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { ACTION_SOURCE_FILES } from "../../.v3-generated/action-source.generated.js";

/**
 * #1238: the witness for gate-absence claims — the EXECUTING action's own
 * implementation, and nothing else. A claim that a deterministic gate of
 * the action is absent can only be decided by the action's own
 * implementation; the boundary uses this reader to consult it.
 *
 * #1240: the witness bytes are EMBEDDED INTO THE EXECUTING BUNDLE at build
 * time (scripts/generate-action-source.mjs), and this reader performs NO
 * filesystem content read at all. The bundle IS the executing action's own
 * implementation — the install tree's `src/` is not what runs — so the
 * embedded bytes are revision-bound by construction and no check/read race
 * can exist: there is no check, no path walk, and no read to race. The
 * earlier filesystem reader resolved a path, proved containment, and opened
 * the file in separate steps, so a concurrent mutation of the action tree
 * could swap an intermediate component between the proof and the read and
 * serve bytes from outside the action root.
 *
 * The reader is offline and bounded: no shell, no exec, no network, no
 * writes. Only paths that come from the registry constants are ever
 * consulted — a path taken from a finding, a model message, or any other
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
 * registry cites are tens of kilobytes; the cap keeps a pathological embed
 * from turning the boundary into a memory sink.
 */
export const MAX_ACTION_SOURCE_BYTES = 1024 * 1024;

export interface ActionSourceReaderOptions {
  /**
   * The action's own source root. Defaults to `GITHUB_ACTION_PATH` when
   * the runner provides it, else the shipped bundle's own location. #1240:
   * it carries no bytes — it only proves the executing implementation is
   * not the reviewed repository's own.
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
 * action's install directory as the runner reports it.
 * (b) otherwise the bundle's own location: in the shipped `dist/index.js`
 * this is the action root (the parent of `dist/`), while in the test build
 * it points inside `.test-build`.
 *
 * #1240: the root no longer supplies the witness bytes — they are embedded
 * in the bundle — so it is consulted for ONE thing only: proving the
 * executing implementation is not the reviewed repository's own.
 */
export function resolveActionSourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.GITHUB_ACTION_PATH;
  if (typeof candidate === "string" && candidate.trim() !== "" && isAbsolute(candidate)) {
    return resolve(candidate);
  }
  return resolve(__dirname, "..");
}

/** True when `candidate` IS `parent` or lies inside it. */
function isInside(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep);
}

/** The realpath of `path`, or null when it cannot be resolved. */
async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

type ActionRootProvenance = { ok: true } | { ok: false; reason: string };

/**
 * #1240: the ONE provenance rule left to a path-based decision — the
 * executing bytes must not be the reviewed repository's bytes.
 *
 * The `uses: ./` shape runs the reviewed repository itself as the action,
 * so the executing bytes are PR-controlled and must never decide a
 * refutation of the action's own gates. The root is refused when it lies
 * inside the reviewed workspace — lexically, or after resolving both paths
 * (a symlinked root's lexical path can lie outside the workspace while its
 * bytes live inside it).
 *
 * A root that does not exist is NOT refused on that basis: the witness no
 * longer depends on the tree at all, so a missing install directory
 * proves nothing about the bytes being served.
 */
async function checkRootProvenance(base: string, workspaceRoot: string | null): Promise<ActionRootProvenance> {
  if (workspaceRoot === null) return { ok: true };
  if (isInside(base, workspaceRoot)) return { ok: false, reason: "root-inside-workspace" };
  const rootReal = await realPathOrNull(base);
  const workspaceReal = await realPathOrNull(workspaceRoot);
  if (rootReal !== null && workspaceReal !== null && isInside(rootReal, workspaceReal)) {
    return { ok: false, reason: "root-inside-workspace" };
  }
  return { ok: true };
}

/**
 * A reader over the executing action's own implementation bytes.
 *
 * The served bytes are the ones embedded in this bundle at build time, so
 * a read is a map lookup: there is no path arithmetic, no containment
 * check, and no filesystem access whose result could change under the
 * reader's feet. A mutation of the action's install tree — including a
 * swap of an intermediate directory for a symlink pointing outside it —
 * cannot change what is served.
 *
 * Everything the reader cannot serve is reported as `unavailable`, never
 * as evidence: a path that is not embedded, a path carrying a NUL byte,
 * and a root that is the reviewed repository (the `uses: ./` shape).
 */
export function createActionSourceReader(options: ActionSourceReaderOptions = {}): ActionSourceReader {
  const base = options.root === undefined || options.root === null || options.root.trim() === ""
    ? resolveActionSourceRoot(process.env)
    : resolve(options.root);
  const workspaceRoot = options.workspaceRoot === undefined || options.workspaceRoot === null || options.workspaceRoot.trim() === ""
    ? null
    : resolve(options.workspaceRoot);
  // The root's provenance is decided once per reader: it cannot change
  // under the reader's own feet, and re-checking it per read would
  // resolve the same paths for every cited file.
  let rootCheck: Promise<ActionRootProvenance> | null = null;
  const checkRoot = (): Promise<ActionRootProvenance> => {
    if (rootCheck === null) rootCheck = checkRootProvenance(base, workspaceRoot);
    return rootCheck;
  };
  return async (relativePath: string): Promise<ActionSourceReadResult> => {
    if (typeof relativePath !== "string" || relativePath.length === 0) {
      return { status: "unavailable", reason: "invalid-path" };
    }
    // A NUL byte truncates the path at the OS boundary: it can never name
    // an embedded file, and refusing it explicitly keeps the refusal
    // visible instead of folding it into "not found".
    if (relativePath.includes("\0")) {
      return { status: "unavailable", reason: "invalid-path" };
    }
    const root = await checkRoot();
    if (!root.ok) return { status: "unavailable", reason: root.reason };
    const text = ACTION_SOURCE_FILES.get(relativePath);
    if (text === undefined) return { status: "unavailable", reason: "not-found" };
    // Defensive: the generator refuses to embed an oversize file, so this
    // never fires — but the bound the reader advertises is enforced here
    // rather than assumed.
    if (Buffer.byteLength(text, "utf8") > MAX_ACTION_SOURCE_BYTES) {
      return { status: "unavailable", reason: "too-large" };
    }
    return { status: "ok", text };
  };
}
