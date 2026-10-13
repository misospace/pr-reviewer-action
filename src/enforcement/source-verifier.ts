import { execFileSync } from "node:child_process";
import { redactSourceTextDetailed } from "../context/redact.js";
import { committedSourceProvenance, sanitizedSourceProvenance } from "../context/evidence-provenance.js";
import { safeFile } from "./blocker-verification.js";
import type { SourceReadResult, SourceReader } from "./blocker-verification.js";

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
      stdout = exec("git", ["show", `${revision}:${file}`], {
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
      // Anything but a clean no-entry listing is unknown evidence.
      try {
        // `-z`: NUL-separated entries with RAW paths. Without it git quotes
        // non-ASCII/special names (core.quotePath), which would break the
        // exact-name comparison and let a corrupted-blob path refute as
        // falsely "not listed".
        const listing = exec("git", ["ls-tree", "-z", revision, "--", `:(literal)${file}`], {
          ...execOptions,
          maxBuffer: 1_000_000,
        }).toString("utf8");
        // Entry format: `<mode> <type> <object-id>\t<path>\0`. The path
        // starts after the FIRST tab (mode/type/object-id never contain
        // one), so a tab inside the path itself still compares exactly.
        for (const entry of listing.split("\0")) {
          const tab = entry.indexOf("\t");
          if (tab !== -1 && entry.slice(tab + 1) === file) {
            // The path is listed in the tree but its blob could not be
            // read: unknown evidence, never positive refutation.
            return { status: "unavailable", reason: "read-failed" };
          }
        }
        return { status: "unavailable", reason: "not-found" };
      } catch {
        return { status: "unavailable", reason: "read-failed" };
      }
    }

    const raw = stdout.toString("utf8");
    const { text, redactionCount } = redactSourceTextDetailed(raw, file);
    const provenance = redactionCount > 0
      ? sanitizedSourceProvenance(redactionCount, file, revision)
      : committedSourceProvenance(file, revision);
    return { status: "ok", text, provenance };
  };
}
