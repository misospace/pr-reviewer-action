import { execFileSync } from "node:child_process";

/**
 * The Tangled Git read surface (#1690 protocol pivot): the knot serves each
 * repository over the Git transport (clone/fetch URLs), and the Spindle host
 * checks the pull's selected round out into the run workspace. The reviewed
 * diff/files are therefore derived LOCALLY with fixed-argv git commands
 * anchored to the selected patch revision's TRUSTED `base.oid`/`head.oid` —
 * never from the working tree state, never from untrusted patch text.
 *
 * Boundaries (mirroring repo-map.ts's git discipline and the tool catalog's
 * fixed-command rule):
 * - every invocation is a FIXED argv built from typed values (the two
 *   validated object ids and the workspace path) — never a shell, never
 *   model-generated text, no interpolated command strings;
 * - output is bounded (`maxBuffer`), execution is time-capped, and every
 *   failure (git missing, timeout, nonzero exit, unbounded output) throws a
 *   typed `TangledGitError` — the run fails closed rather than degrading;
 * - object ids are validated 40/64-hex (SHA-1 migrated knots, SHA-256 new
 *   ones) before they ever reach argv;
 * - a missing object (a shallow checkout without the base or head commit)
 *   is a normal nonzero git exit → fail closed with the oid named, never a
 *   partial diff.
 */

export class TangledGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TangledGitError";
  }
}

/** One changed file, in the GitHub-REST file-object family the engine's
 * projection consumes: `filename`, `status`, `additions`/`deletions`/
 * `changes`, optional `previous_filename` (renames), and the per-file
 * `patch` (omitted for binary files, which carry no textual hunks). */
export interface TangledGitFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  previous_filename?: string;
  patch?: string;
}

export interface TangledGitDiff {
  diff: string;
  files: TangledGitFile[];
}

export interface TangledGitReadOptions {
  timeoutSec?: number | undefined;
  maxBuffer?: number | undefined;
}

const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

interface GitRun {
  stdout: string;
}

/** One fixed-argv git invocation in `workspace`. The argv pieces are typed
 * values only; nothing is ever routed through a shell. */
function runGit(workspace: string, args: readonly string[], options?: TangledGitReadOptions): GitRun {
  const timeoutSec = options?.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  let stdout: Buffer;
  try {
    stdout = execFileSync("git", args, {
      cwd: workspace,
      timeout: timeoutSec * 1000,
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string | number | null; status?: number | null; stderr?: Buffer; killed?: boolean; signal?: string | null };
    if (typeof err.code === "string" && err.code === "ENOENT") {
      throw new TangledGitError("git executable not found");
    }
    if (err.killed || err.signal) {
      throw new TangledGitError(`git ${args[0] ?? "diff"} timed out after ${timeoutSec}s`);
    }
    const exitCode = typeof err.status === "number" ? err.status : 1;
    const stderr = (err.stderr ?? Buffer.alloc(0)).toString("utf8").trim().slice(0, 300);
    throw new TangledGitError(
      `git ${args[0] ?? "diff"} exited ${exitCode}${stderr === "" ? "" : `: ${stderr}`}`,
    );
  }
  return { stdout: stdout.toString("utf8") };
}

/** Validate one patch-record object id before it reaches argv. */
function validatedOid(oid: string, what: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) {
    throw new TangledGitError(`patch ${what} oid is not a 40/64-hex git object id`);
  }
  return oid;
}

/** One `--numstat -z` entry. The wire format is NUL-separated records:
 * `added\tdeleted\tpath\0`, and a rename row is
 * `added\tdeleted\t\0old\0new\0` — the two paths are their own records. */
interface NumstatEntry {
  added: number;
  deleted: number;
  filename: string;
  previousFilename: string | undefined;
}

function parseNumstat(stdout: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const tokens = stdout.split("\u0000");
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i] ?? "";
    if (head === "") {
      i += 1;
      continue;
    }
    const parts = head.split("\t");
    const added = parts[0] === "-" ? 0 : Number(parts[0]);
    const deleted = parts[1] === "-" ? 0 : Number(parts[1]);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) {
      throw new TangledGitError("git diff --numstat produced an unusable count row");
    }
    const inlinePath = parts[2] ?? "";
    if (inlinePath !== "") {
      if (parts.length > 3) {
        throw new TangledGitError("git diff --numstat produced an unusable path row");
      }
      entries.push({ added, deleted, filename: inlinePath, previousFilename: undefined });
      i += 1;
      continue;
    }
    // Rename row: the two paths follow as their own NUL records.
    const oldPath = tokens[i + 1];
    const newPath = tokens[i + 2];
    if (oldPath === undefined || oldPath === "" || newPath === undefined || newPath === "") {
      throw new TangledGitError("git diff --numstat produced an unusable rename row");
    }
    entries.push({ added, deleted, filename: newPath, previousFilename: oldPath });
    i += 3;
  }
  return entries;
}

/** Split one unified diff into per-file hunks keyed by the new path.
 * Binary entries carry no hunks and are returned without a `patch`. */
function parsePerFilePatches(diff: string): Map<string, { patch: string; oldPath: string | null }> {
  const chunks = new Map<string, { patch: string; oldPath: string | null }>();
  const lines = diff.split("\n");
  let current: { path: string | null; oldPath: string | null; lines: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined && current.path !== null) {
      chunks.set(current.path, { patch: current.lines.join("\n"), oldPath: current.oldPath });
    }
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { path: null, oldPath: null, lines: [line] };
      continue;
    }
    if (current === undefined) continue;
    current.lines.push(line);
    if (current.path === null && line.startsWith("+++ b/")) {
      current.path = line.slice("+++ b/".length);
    } else if (current.path === null && line === "+++ /dev/null") {
      // A deleted file's textual diff ends at the old path (`--- a/<old>`);
      // the chunk is keyed by the OLD path so it joins its numstat row.
      current.path = current.oldPath;
    } else if (current.oldPath === null && line.startsWith("--- a/")) {
      current.oldPath = line.slice("--- a/".length);
    } else if (current.oldPath === null && line === "--- /dev/null") {
      current.oldPath = null;
    }
  }
  flush();
  return chunks;
}

/**
 * The reviewed diff and changed files for one patch revision: `git diff`
 * between the revision's trusted base and head inside the checked-out
 * round. The workspace must contain both commits (the knot's git transport
 * is the read surface that put them there); a checkout that cannot produce
 * the diff fails closed with the missing state named.
 */
export function readTangledPatchDiff(
  workspace: string,
  baseOid: string,
  headOid: string,
  options?: TangledGitReadOptions,
): TangledGitDiff {
  const base = validatedOid(baseOid, "base");
  const head = validatedOid(headOid, "head");
  if (workspace === "") {
    throw new TangledGitError("the run workspace path is empty; the checked-out round is the diff read surface");
  }
  const numstat = parseNumstat(runGit(workspace, ["diff", "--numstat", "-z", base, head], options).stdout);
  const diff = runGit(workspace, ["diff", "--no-color", "--no-ext-diff", base, head], options).stdout;
  const perFile = parsePerFilePatches(diff);

  const files: TangledGitFile[] = numstat.map((entry) => {
    const chunk = perFile.get(entry.filename);
    const chunkLines = chunk !== undefined ? chunk.patch.split("\n") : [];
    const status: TangledGitFile["status"] = entry.previousFilename !== undefined
      ? "renamed"
      : chunk !== undefined && chunk.oldPath === null
        ? "added"
        : chunkLines.includes("+++ /dev/null")
          ? "removed"
          : "modified";
    const file: TangledGitFile = {
      filename: entry.filename,
      status,
      additions: entry.added,
      deletions: entry.deleted,
      changes: entry.added + entry.deleted,
    };
    if (entry.previousFilename !== undefined) file.previous_filename = entry.previousFilename;
    if (chunk !== undefined && chunk.patch !== "") file.patch = chunk.patch;
    return file;
  });
  return { diff, files };
}
