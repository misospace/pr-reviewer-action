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
      // The SHA is reachable in this workspace's object DB; any remaining
      // exit nonzero is the file path's proven absence in a verified tree.
      return { status: "unavailable", reason: "not-found" };
    }

    const raw = stdout.toString("utf8");
    const { text, redactionCount } = redactSourceTextDetailed(raw, file);
    const provenance = redactionCount > 0
      ? sanitizedSourceProvenance(redactionCount, file, revision)
      : committedSourceProvenance(file, revision);
    return { status: "ok", text, provenance };
  };
}
