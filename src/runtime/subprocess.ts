import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { assertPosixProcessTree } from "./platform.js";
import { terminateProcessTree, type TerminationReport } from "./process-tree.js";

/**
 * Bounded, typed subprocess ownership (#679). Replaces the Bash background
 * PID + trap bookkeeping with an explicit lifecycle:
 *
 * - the caller always passes a purpose-built environment (allowlist via
 *   `buildChildEnv`) — there is no implicit `process.env` passthrough;
 * - the child is spawned detached (POSIX process-group leader), so timeout,
 *   cancellation, and abnormal-exit cleanup can terminate the whole tree,
 *   not just the leader;
 * - `timeoutMs` and an external `AbortSignal` both funnel into the same
 *   tree-termination path (TERM group → bounded grace → KILL group → pgrep
 *   sweep for PGID escapees), so transport calls and grandchildren cannot
 *   outlive the deadline that killed their parent;
 * - stdout/stderr are captured as bytes with per-stream caps; output stays
 *   data and is never interpreted;
 * - the result is a structured `{status, exitCode, signal, stdout, stderr,
 *   durationMs, termination}` — never a thrown error for workload failures.
 *
 * Fail-closed refusals (non-POSIX platform, pre-aborted signal) resolve to a
 * `spawn_error` result without launching anything; there is no degraded
 * leader-only mode.
 */

export type ProcessStatus = "exited" | "signalled" | "timeout" | "cancelled" | "spawn_error";

export interface ProcessResult {
  status: ProcessStatus;
  /** Null unless the workload exited on its own. */
  exitCode: number | null;
  /** Termination signal name when the leader died to a signal. */
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  /** Tree-termination details; null when the workload ran to completion. */
  termination: TerminationReport | null;
  /** Set only for `spawn_error` (policy refusal, ENOENT, pre-abort). */
  launchError?: string;
}

export interface ProcessHandle {
  /** Leader PID, or null when nothing was launched. */
  pid: number | null;
  result: Promise<ProcessResult>;
  /** Set synchronously when the launch was refused before spawn. */
  launchRefusal: string | null;
  /** Terminate the whole tree now. Idempotent. */
  abort(): Promise<void>;
}

export interface RunProcessOptions {
  file: string;
  args?: readonly string[];
  cwd?: string;
  /** Explicit child environment — build it with `buildChildEnv`. Required. */
  env: NodeJS.ProcessEnv;
  /** Whole-process deadline; expiry terminates the tree. */
  timeoutMs?: number;
  /** External cancellation (parent scope / gate join). */
  signal?: AbortSignal;
  /** Per-stream capture cap in bytes (capture stops, drain continues). */
  maxOutputBytes?: number;
  /** TERM→KILL grace for tree termination. Default 2000ms. */
  terminateGraceMs?: number;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_TERMINATE_GRACE_MS = 2_000;
/** After the leader exits, stray pipe holders get this long before streams are cut. */
const EXIT_STREAM_DRAIN_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function runProcess(options: RunProcessOptions): ProcessHandle {
  const graceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

interface CaptureTarget {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

const stdoutCapture: CaptureTarget = { chunks: [], bytes: 0, truncated: false };
const stderrCapture: CaptureTarget = { chunks: [], bytes: 0, truncated: false };

  let child: ChildProcess | null = null;
  let pid: number | null = null;
  let settled = false;
  let terminateReason: "timeout" | "cancelled" | null = null;
  let terminationReport: TerminationReport | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let aborting: Promise<void> | null = null;

  let resolveResult!: (result: ProcessResult) => void;
  const resultPromise = new Promise<ProcessResult>((resolve) => {
    resolveResult = resolve;
  });

  const spawnErrorResult = (message: string): ProcessResult => ({
    status: "spawn_error",
    exitCode: null,
    signal: null,
    stdout: Buffer.concat(stdoutCapture.chunks),
    stderr: Buffer.concat(stderrCapture.chunks),
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    durationMs: Date.now() - startedAt,
    termination: null,
    launchError: message,
  });

  const settle = (build: () => ProcessResult): void => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    resolveResult(build());
  };

  const settleTerminate = (): void => {
    const signal = child?.signalCode ?? null;
    const code = child?.exitCode ?? null;
    const status: ProcessStatus =
      terminateReason === "timeout"
        ? "timeout"
        : terminateReason === "cancelled"
          ? "cancelled"
          : signal !== null
            ? "signalled"
            : "exited";
    settle(() => ({
      status,
      exitCode: status === "exited" ? code : null,
      signal: signal ?? (status === "timeout" || status === "cancelled" ? ("SIGTERM" as NodeJS.Signals) : null),
      stdout: Buffer.concat(stdoutCapture.chunks),
      stderr: Buffer.concat(stderrCapture.chunks),
      stdoutTruncated: stdoutCapture.truncated,
      stderrTruncated: stderrCapture.truncated,
      durationMs: Date.now() - startedAt,
      termination: terminationReport,
    }));
  };

  const collectChunk = (target: CaptureTarget, chunk: Buffer): void => {
    if (target.truncated) return;
    if (target.bytes + chunk.length > maxBytes) {
      const room = maxBytes - target.bytes;
      if (room > 0) target.chunks.push(chunk.subarray(0, room));
      target.truncated = true;
      return;
    }
    target.chunks.push(chunk);
    target.bytes += chunk.length;
  };

  const terminateTree = async (reason: "timeout" | "cancelled"): Promise<void> => {
    if (terminateReason !== null) {
      await (aborting ?? Promise.resolve());
      return;
    }
    terminateReason = reason;
    aborting = (async () => {
      if (child !== null && pid !== null) {
        terminationReport = await terminateProcessTree(child, { graceMs });
        // A PGID escapee holding an inherited stdio pipe can keep `close`
        // from firing; never let the result hang on a stray descriptor.
        await sleep(Math.min(graceMs, EXIT_STREAM_DRAIN_MS));
        child.stdout?.destroy();
        child.stderr?.destroy();
        settleTerminate();
      }
    })();
    await aborting;
  };

  // ── Fail-closed pre-launch checks ────────────────────────────────────────
  const externalSignal = options.signal;
  try {
    assertPosixProcessTree(options.file);
  } catch (error) {
    const refusal = error instanceof Error ? error.message : String(error);
    return refusedHandle(refusal, spawnErrorResult(refusal));
  }
  if (externalSignal?.aborted) {
    const refusal = `${options.file}: cancelled before launch (${externalSignal.reason instanceof Error ? externalSignal.reason.message : String(externalSignal.reason)})`;
    return refusedHandle(refusal, spawnErrorResult(refusal));
  }

  child = spawn(options.file, options.args ?? [], {
    detached: true,
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  pid = child.pid ?? null;

  child.stdout?.on("data", (chunk: Buffer) => {
    collectChunk(stdoutCapture, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    collectChunk(stderrCapture, chunk);
  });

  child.on("error", (error: Error) => {
    settle(() => spawnErrorResult(`${options.file}: ${error.message}`));
  });

  child.on("close", (code, signalTerm) => {
    if (terminateReason !== null) {
      // A termination is in flight; the structured result must carry its
      // report, so settle only once the tree cleanup has completed.
      void (async () => {
        await (aborting ?? Promise.resolve());
        settleTerminate();
      })();
      return;
    }
    settle(() => ({
      status: signalTerm !== null ? "signalled" : "exited",
      exitCode: signalTerm !== null ? null : code ?? null,
      signal: signalTerm,
      stdout: Buffer.concat(stdoutCapture.chunks),
      stderr: Buffer.concat(stderrCapture.chunks),
      stdoutTruncated: stdoutCapture.truncated,
      stderrTruncated: stderrCapture.truncated,
      durationMs: Date.now() - startedAt,
      termination: null,
    }));
  });

  // A normal leader exit can still leave an inherited stdio pipe open in a
  // detached descendant; cut the streams after a short drain instead of
  // hanging on `close`.
  child.on("exit", () => {
    if (settled || terminateReason !== null) return;
    const drainTimer = setTimeout(() => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }, EXIT_STREAM_DRAIN_MS);
    drainTimer.unref?.();
  });

  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      void terminateTree("timeout");
    }, options.timeoutMs);
  }

  const handle: ProcessHandle = {
    pid,
    launchRefusal: null,
    result: resultPromise,
    abort: () => terminateTree("cancelled"),
  };

  externalSignal?.addEventListener(
    "abort",
    () => {
      void terminateTree("cancelled");
    },
    { once: true },
  );

  return handle;
}

function refusedHandle(refusal: string, result: ProcessResult): ProcessHandle {
  return {
    pid: null,
    launchRefusal: refusal,
    result: Promise.resolve(result),
    abort: () => Promise.resolve(),
  };
}
