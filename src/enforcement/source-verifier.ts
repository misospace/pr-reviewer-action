import { execFileSync } from "node:child_process";
import { redactSourceTextDetailed } from "../context/redact.js";
import { committedSourceProvenance, sanitizedSourceProvenance } from "../context/evidence-provenance.js";
import { safeFile } from "./blocker-verification.js";
import type { SourceReadResult, SourceReader } from "./blocker-verification.js";

/**
 * Canonicalize a cited tree path before it is used as a git revarg or
 * pathspec. Git's tree lookups key on the canonical path — a raw citation
 * like `src//a.ts` or `./src/a.ts` fails `git show` even when the canonical
 * entry exists — so the reader normalizes empty and `.` segments on both
 * sides of the seam and never lets a normalization mismatch become an
 * affirmative "path absent". `safeFile` has already rejected absolute
 * paths, leading `-`, `..` segments, and NUL, so stripping empty/dot
 * segments cannot introduce traversal.
 */
function canonicalTreePath(file: string): string {
  return file.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

/**
 * A `-z` `ls-tree` record header: `<mode> SP <type> SP <object-id>`. git
 * emits six octal mode digits, one of the three tree entry types, and a full
 * hex object id (40 for sha1, 64 for sha256) — so a record whose header does
 * not match this shape is truncated or otherwise not a record git wrote.
 */
const LS_TREE_HEADER_RE = /^[0-7]{6} (?:blob|tree|commit) [0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * #1016 (review pass, blocker): `not-found` is an affirmative disproof — the
 * boundary is allowed to relax a blocker on it — so absence must be PROVEN,
 * not inferred from a listing that merely failed to contain the cited path.
 * A record stream that is truncated mid-record, does not end on a record
 * boundary, or holds a record this reader cannot parse is unknown evidence:
 * the entry that would refute the claim may be in the part that never
 * arrived.
 *
 * Three outcomes:
 * - "listed": a byte-exact match for the cited path is present (the entry
 *   exists, only its blob could not be read) — unknown evidence.
 * - "absent": a successfully completed, structurally complete, EMPTY
 *   listing. Absence is asserted for this shape only.
 * - "unknown": everything else, including a cleanly parsed listing that
 *   carries entries but none matching — a non-empty answer to an
 *   exact-pathspec query is not a complete record of what the tree holds, so
 *   it cannot prove absence.
 */
function inspectLsTreeListing(listing: Buffer, wanted: Buffer): "listed" | "absent" | "unknown" {
  if (listing.length === 0) return "absent";
  // `-z` NUL-terminates every record, so a non-empty listing must end on a
  // NUL. A buffer that does not was cut short mid-record.
  if (listing[listing.length - 1] !== 0) return "unknown";
  let cursor = 0;
  while (cursor < listing.length) {
    const nul = listing.indexOf(0, cursor);
    if (nul === -1) return "unknown";
    // Entry format: `<mode> <type> <object-id>\t<path>`. The path starts
    // after the FIRST tab (mode/type/object-id never contain one), so a tab
    // inside the path itself still compares exactly. That separator is the
    // invariant the header regex depends on: `tab` is searched from `cursor`,
    // so it is the record's separator, never a byte borrowed from its path.
    const tab = listing.indexOf(0x09, cursor);
    if (tab === -1 || tab >= nul || nul === tab + 1) return "unknown";
    // The header is ASCII by construction; decode it byte-per-character so
    // no multi-byte sequence can shift the record boundary.
    if (!LS_TREE_HEADER_RE.test(listing.toString("latin1", cursor, tab))) return "unknown";
    // The comparison is byte-exact on the raw listing: a tree path with
    // non-UTF-8 bytes must never match (or falsely miss through a lossy
    // decode) the cited path.
    if (listing.subarray(tab + 1, nul).equals(wanted)) return "listed";
    cursor = nul + 1;
  }
  // Every record parsed cleanly and none matched, yet the listing is
  // non-empty: unknown evidence, never a disproof.
  return "unknown";
}

export interface HeadSourceReaderOptions {
  workspace: string;
  revision: string | null | undefined;
  timeoutSec?: number;
  maxBytes?: number;
  execFile?: (file: string, args: readonly string[], options: Record<string, unknown>) => Buffer;
}

export function createHeadSourceReader(options: HeadSourceReaderOptions): SourceReader {
  const timeoutSec = options.timeoutSec ?? 15;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const exec = options.execFile ?? ((file, args, execOptions) =>
    execFileSync(file, [...args], execOptions as Parameters<typeof execFileSync>[2]) as Buffer);

  return async (file: string): Promise<SourceReadResult> => {
    if (typeof options.revision !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.revision)) {
      return { status: "unavailable", reason: "no-exact-revision" };
    }
    if (!safeFile(file)) return { status: "unavailable", reason: "path-invalid" };
    const treePath = canonicalTreePath(file);
    if (treePath === "") return { status: "unavailable", reason: "path-invalid" };

    const revision = options.revision;
    const execOptions = {
      cwd: options.workspace,
      timeout: timeoutSec * 1000,
      stdio: ["ignore", "pipe", "pipe"] as const,
      windowsHide: true,
    };

    // Pre-flight: verify the SHA names an object in this workspace's object
    // DB. A well-formed hex SHA does not by itself prove that exact commit is
    // local — without this check, a non-repository workspace, a corrupt
    // object DB, or a SHA that simply does not exist in this checkout all
    // surface as `git show` exit-nonzero, and the boundary would treat
    // them as `not-found` (i.e. refute the blocker and risk a false
    // APPROVE). `git cat-file -e` succeeds exactly when the SHA resolves
    // to a commit object reachable from this workspace; any failure
    // here is unknown evidence, not proven path absence.
    try {
      exec("git", ["cat-file", "-e", `${revision}^{commit}`], {
        ...execOptions,
        maxBuffer: 1_000_000,
      });
    } catch (error) {
      const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
      if (failure.code === "ENOENT" || failure.killed || failure.signal) {
        return { status: "unavailable", reason: "read-failed" };
      }
      if (failure.code === "ENOBUFS" || /buffer|large/i.test(String(failure.message ?? ""))) {
        return { status: "unavailable", reason: "too-large" };
      }
      return { status: "unavailable", reason: "revision-unreachable" };
    }

    let stdout: Buffer;
    try {
      stdout = exec("git", ["show", `${revision}:${treePath}`], {
        ...execOptions,
        maxBuffer: maxBytes,
      });
    } catch (error) {
      const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
      if (failure.code === "ENOENT" || failure.killed || failure.signal) {
        return { status: "unavailable", reason: "read-failed" };
      }
      if (failure.code === "ENOBUFS" || /buffer|large/i.test(String(failure.message ?? ""))) {
        return { status: "unavailable", reason: "too-large" };
      }
      // A reachable commit does not prove that a failed `git show` means
      // the path is absent: the tree entry can exist while its blob is
      // missing or unreadable (partial clone/promisor failure, corrupted or
      // incomplete object DB, permissions). Before allowing the affirmative
      // `not-found` disproof, independently prove absence in the validated
      // commit tree with a bounded exact-path `git ls-tree` (argv-only,
      // literal pathspec so no glob interpretation, byte- and time-capped).
      // Anything but a clean, complete, empty listing is unknown evidence.
      try {
        // `-z`: NUL-separated entries with RAW paths. Without it git quotes
        // non-ASCII/special names (core.quotePath), which would break the
        // exact-name comparison and let a corrupted-blob path refute as
        // falsely "not listed".
        const listing = exec("git", ["ls-tree", "-z", revision, "--", `:(literal)${treePath}`], {
          ...execOptions,
          maxBuffer: 1_000_000,
        });
        const outcome = inspectLsTreeListing(listing, Buffer.from(treePath, "utf8"));
        if (outcome === "listed") {
          // The path is listed in the tree but its blob could not be
          // read: unknown evidence, never positive refutation.
          return { status: "unavailable", reason: "read-failed" };
        }
        if (outcome === "absent") {
          return { status: "unavailable", reason: "not-found" };
        }
        return { status: "unavailable", reason: "read-failed" };
      } catch (error) {
        const failure = error as { code?: unknown; message?: unknown };
        if (failure.code === "ENOBUFS" || /buffer|large/i.test(String(failure.message ?? ""))) {
          return { status: "unavailable", reason: "too-large" };
        }
        return { status: "unavailable", reason: "read-failed" };
      }
    }

    const raw = stdout.toString("utf8");
    const { text, redactionCount } = redactSourceTextDetailed(raw, treePath);
    const provenance = redactionCount > 0
      ? sanitizedSourceProvenance(redactionCount, treePath, revision)
      : committedSourceProvenance(treePath, revision);
    return { status: "ok", text, provenance };
  };
}
