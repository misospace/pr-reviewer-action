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

    let stdout: Buffer;
    try {
      stdout = exec("git", ["show", `${options.revision}:${file}`], {
        cwd: options.workspace,
        timeout: timeoutSec * 1000,
        maxBuffer: maxBytes,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
      if (failure.code === "ENOENT" || failure.killed || failure.signal) {
        return { status: "unavailable", reason: "read-failed" };
      }
      if (failure.code === "ENOBUFS" || /buffer|large/i.test(String(failure.message ?? ""))) {
        return { status: "unavailable", reason: "too-large" };
      }
      return { status: "unavailable", reason: "not-found" };
    }

    const raw = stdout.toString("utf8");
    const { text, redactionCount } = redactSourceTextDetailed(raw, file);
    const provenance = redactionCount > 0
      ? sanitizedSourceProvenance(redactionCount, file, options.revision)
      : committedSourceProvenance(file, options.revision);
    return { status: "ok", text, provenance };
  };
}
