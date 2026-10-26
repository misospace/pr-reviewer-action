/** Local reference executor for #733: the development/self-hosted backend
 * that runs one review worker as a local child process.
 *
 * Built on the v3 runtime's typed process lifecycle (`src/runtime/`): the
 * child is spawned argv-only through `runProcess` (POSIX process-group
 * leader, tree-terminated on deadline/cancel), and its environment is an
 * explicit allowlist — exactly the generic PATH/HOME/TMPDIR-style keys plus
 * the two executor coordination variables. NO request/job/repo-derived key
 * ever enters the environment: hostile repository-config data must not be
 * able to alter the command, its argv, or the child's env. The command and
 * argv come only from the operator's `LocalExecutorSpec`; PR-derived data
 * travels exclusively inside the request envelope file.
 *
 * Protocol: the executor writes the request envelope JSON to
 * `requestPath` BEFORE launching (the correlation source of truth) and
 * passes both envelope and result paths via the two env vars and the final
 * argv element. The worker writes its structured result to the result path
 * — stdout/stderr are captured (bounded) and used ONLY as diagnostics,
 * never as the result protocol. Every collected result is validated with
 * `validateExecutionResult` and correlation-checked against the request
 * before it is believed; anything else fails closed with an explicit
 * `ExecutionFailureCategory`.
 *
 * Containment: the request validator only proves LEXICAL containment of
 * the envelope paths inside the run directory, and lexical containment is
 * not enough — a symlink planted BELOW the run directory would redirect
 * the envelope write or the result read outside it. Both envelope paths
 * are therefore proven against the run directory on disk
 * (`ensureContained`, which creates the missing parent components inside
 * the run directory and refuses a symlinked one) before anything is
 * written, and the envelope is written with no-follow semantics
 * (`writeFileNoFollow`); the result file is read with no-follow, bounded
 * semantics (`readBoundedFileNoFollow`). A path that cannot be proven
 * contained refuses the launch (`launch_refused`) — nothing is launched,
 * no envelope and no state file are written. The recovery record is read
 * the same way (no-follow, byte-capped), because it lives in the same
 * worker-writable directory.
 *
 * Crash recovery: the executor records the in-flight execution (correlation
 * identity, pid, state) in `<runDir>/.pr-reviewer-execution.json`, so
 * `reconcile` — called by the controller after a restart — can classify the
 * orphan without ever collecting across generations: a state file whose
 * runId/jobId/attempt does not match the request is foreign, and a foreign
 * execution is never collected.
 *
 * Operator-mode library (like `src/queue/` and `src/acquisition/`): NOT
 * wired into the Action runtime.
 */

import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildChildEnv, extendAllowlist } from "../runtime/env.js";
import { runProcess } from "../runtime/subprocess.js";
import type { ProcessHandle, ProcessResult, RunProcessOptions } from "../runtime/subprocess.js";
import type { LocalExecutorSpec } from "../config/instance-config.js";
import {
  MAX_EXECUTION_FAILURE_MESSAGE_CHARS,
  MAX_EXECUTION_RESULT_FILE_BYTES,
  validateExecutionRequest,
  validateExecutionResult,
  ExecutionRequestError,
  type ExecutionHandle,
  type ExecutionReconcileOutcome,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatusReport,
  type Executor,
} from "./types.js";
import { ensureContained, proveContained, readBoundedFileNoFollow, writeFileNoFollow } from "./paths.js";

/** The executor's coordination variables — the ONLY non-generic keys the
 * child environment ever carries. */
export const EXECUTION_REQUEST_ENV_KEY = "PR_REVIEWER_EXECUTION_REQUEST";
export const EXECUTION_RESULT_ENV_KEY = "PR_REVIEWER_EXECUTION_RESULT";

/** Per-execution recovery record the executor maintains in the run
 * directory; `reconcile` reads it after a controller restart. */
export const EXECUTION_STATE_FILE = ".pr-reviewer-execution.json";

/** Generic keys every local child may inherit from the controller
 * environment — the allowlist base. Anything secret or job-specific stays
 * out unless a future, explicit extension names it. */
const BASE_CHILD_ALLOWLIST = ["PATH", "HOME", "TMPDIR"] as const;

/** Diagnostics tail bound: at most this many characters of stderr survive
 * into a result. */
const DIAGNOSTIC_TAIL_CHARS = 2_000;

/** Recovery-record bound: the state file is a small JSON record, so its
 * read is capped (and no-follow) like every other file this executor
 * consumes — the run directory is worker-writable space, and a planted
 * file must never be able to make the controller allocate without
 * bound. */
const MAX_STATE_FILE_BYTES = 16_384;

/** Failure messages are bounded by the result contract
 * (`MAX_EXECUTION_FAILURE_MESSAGE_CHARS`). The refusal message embeds
 * filesystem paths — which the request contract itself allows to be long
 * — so the message is truncated to the cap: an executor result must
 * always satisfy the contract it is validated against, or the queue
 * seam would reject the executor's OWN result. */
function boundedFailureMessage(message: string): string {
  if (message.length <= MAX_EXECUTION_FAILURE_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_EXECUTION_FAILURE_MESSAGE_CHARS - 1)}…`;
}

const FAILURE_CATEGORIES: readonly string[] = [
  "launch_refused", "deadline", "worker_crash", "worker_error", "no_result", "stale_result", "orphaned",
];

/** Shared frozen tri-state sentinels for `reconcile` (settled outcomes are
 * built per call — they carry a result). */
const RECONCILE_NONE: ExecutionReconcileOutcome = Object.freeze({ kind: "none" });
const RECONCILE_RUNNING: ExecutionReconcileOutcome = Object.freeze({ kind: "running" });

/** A handle over an execution that was refused before launch: already
 * terminal, idempotently collectable, cancellation is a no-op. */
function refusedHandle(result: ExecutionResult): ExecutionHandle {
  return {
    observe: async () => Object.freeze({
      phase: "terminal" as const,
      status: result.status,
      observedAtMs: result.observedAtMs,
    }),
    cancel: async () => {},
    collect: async () => result,
  };
}

/** Injected seams — all optional; the defaults are the real runtime
 * primitives. Tests inject recordings/fakes instead of spawning. */
export interface LocalExecutorDeps {
  /** The typed subprocess runner. Default: the real `runProcess`. */
  readonly runProcess?: (options: RunProcessOptions) => ProcessHandle;
  /** Clock. Default: `Date.now`. */
  readonly nowMs?: () => number;
  /** Liveness probe for reconcile. Default: `process.kill(pid, 0)`
   * try/catch semantics (see `src/runtime/process-tree.ts`). */
  readonly pidAlive?: (pid: number) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  // pid 0 is not a process: `process.kill(0, 0)` would signal the whole
  // process group, so a never-assigned pid is dead by definition.
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What reading the worker's result file concluded. `stale` is distinct:
 * a parseable file from ANOTHER correlation identity is a different
 * failure than no file at all, and neither is ever believed. */
type ResultFileOutcome =
  | { readonly kind: "ok"; readonly result: ExecutionResult }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "stale" };

interface LocalRun {
  readonly request: ExecutionRequest;
  readonly startedAtMs: number;
  readonly signal: AbortSignal;
  /** The worker pid once assigned; 0 until then (never a process). */
  pid: number;
  cancelRequested: boolean;
  phase: "starting" | "running";
  /** The FIRST terminal result; never replaced once set. */
  result: ExecutionResult | null;
  /** Serialized per-run state-file writes: every write appends to this
   * chain, so a terminal write can never be overtaken by an earlier
   * non-terminal one. */
  stateWriteChain: Promise<void>;
}

interface ExecutionStateRecord {
  readonly runId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly state: "starting" | "running" | "completed" | "failed" | "cancelled";
  readonly failureCategory?: string;
  readonly failureMessage?: string;
}

/** One local worker execution, from envelope to collected result. */
export class LocalExecutor implements Executor {
  private readonly spec: LocalExecutorSpec;
  private readonly deps: Required<LocalExecutorDeps>;
  /** In-flight runs keyed by correlation runId. A settled run removes
   * itself: the map never outlives the execution. */
  private readonly runs = new Map<string, LocalRun>();

  constructor(spec: LocalExecutorSpec, deps: LocalExecutorDeps = {}) {
    this.spec = spec;
    this.deps = {
      runProcess: deps.runProcess ?? ((options) => runProcess(options)),
      nowMs: deps.nowMs ?? (() => Date.now()),
      pidAlive: deps.pidAlive ?? defaultPidAlive,
    };
  }

  async start(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionHandle> {
    // Fail closed: a pre-aborted signal never launches anything.
    if (signal.aborted) {
      throw new Error(
        `execution ${request.runId} refused: the caller's signal was already aborted`,
      );
    }
    const validated = validateExecutionRequest(request);
    if (this.runs.has(validated.runId)) {
      throw new ExecutionRequestError(
        `execution ${validated.runId} is already in flight for this executor`,
      );
    }
    // Synchronous in-flight reservation (before the first await): every
    // failure path below removes the entry, so two concurrent starts with
    // the same runId cannot both proceed.
    const run: LocalRun = {
      request: validated,
      startedAtMs: this.deps.nowMs(),
      signal,
      pid: 0,
      cancelRequested: false,
      phase: "starting",
      result: null,
      stateWriteChain: Promise.resolve(),
    };
    this.runs.set(validated.runId, run);

    // A deadline already in the past never launches: an expired
    // `timeoutMs` would be read by the runtime as "no timeout". Settle
    // failed immediately — no envelope, no state file, no child process.
    if (validated.deadlineAtMs !== 0 && validated.deadlineAtMs - this.deps.nowMs() <= 0) {
      this.runs.delete(validated.runId);
      return refusedHandle(this.refusedResult(
        validated,
        "deadline",
        "the execution deadline already passed before the worker was launched",
      ));
    }

    try {
      // The envelope is written BEFORE launch: it is the correlation source
      // of truth, embedding the full validated request (runId/jobId/attempt
      // included) so the worker — and any post-restart audit — sees exactly
      // what was asked.
      await mkdir(validated.runDir, { recursive: true });
      // Containment proof BEFORE anything is written or launched: lexical
      // containment (the validator's job) does not survive a symlink
      // planted below the run directory, and such a symlink would
      // redirect the envelope write or the result read outside it. The
      // missing parent directories are created INSIDE the run directory
      // (a symlinked component is refused, never followed), so a nested
      // envelope path is still usable. An unprovable path refuses the
      // launch: nothing is written, nothing is launched.
      const requestProof = await ensureContained(validated.runDir, validated.requestPath);
      const resultProof = await ensureContained(validated.runDir, validated.resultPath);
      const refusal = !requestProof.contained
        ? requestProof
        : !resultProof.contained
          ? resultProof
          : null;
      if (refusal !== null) {
        this.runs.delete(validated.runId);
        return refusedHandle(this.refusedResult(
          validated,
          "launch_refused",
          `the execution was refused before launch: ${refusal.problem}`,
        ));
      }
      await writeFileNoFollow(validated.requestPath, JSON.stringify(validated, null, 2));
      // Crash-window record: the state file exists (pid 0 — not yet
      // launched) BEFORE the spawn, so a crash in the launch window leaves
      // something reconcile can classify instead of an unknown.
      await this.writeState(run, "starting");

      // The child environment is an allowlist, built only through the runtime
      // mechanics; the two coordination variables are the sole per-run keys.
      const env = buildChildEnv(
        extendAllowlist(BASE_CHILD_ALLOWLIST, [EXECUTION_REQUEST_ENV_KEY, EXECUTION_RESULT_ENV_KEY]),
      );
      env[EXECUTION_REQUEST_ENV_KEY] = validated.requestPath;
      env[EXECUTION_RESULT_ENV_KEY] = validated.resultPath;

      const processHandle = this.deps.runProcess({
        file: this.spec.command,
        args: [...this.spec.args, validated.requestPath],
        cwd: validated.workspace.rootPath,
        env,
        signal,
        ...(validated.deadlineAtMs !== 0
          ? { timeoutMs: Math.max(1, validated.deadlineAtMs - this.deps.nowMs()) }
          : {}),
      });

      // Terminal classification happens exactly once, when the process
      // settles; the first built result is cached and never replaced.
      const settled = processHandle.result.then(async (outcome) => {
        const result = await this.classify(run, outcome);
        run.result = result;
        this.runs.delete(validated.runId);
        // Best-effort recovery metadata: a failed write only means a future
        // reconcile reports `orphaned` (fail-safe), never a wrong success.
        await this.writeState(run, result.status, result);
        return result;
      });

      await processHandle.launched;
      run.pid = processHandle.pid ?? 0;
      if (processHandle.launchRefusal === null && run.result === null) {
        run.phase = "running";
        await this.writeState(run, "running");
      }

      return {
        observe: async (): Promise<ExecutionStatusReport> => {
          // Give an already-settled process one microtask to cache its
          // result, then report from in-flight state.
          await Promise.race([settled, Promise.resolve()]);
          const result = run.result;
          if (result !== null) {
            return Object.freeze({
              phase: "terminal" as const,
              status: result.status,
              observedAtMs: result.observedAtMs,
            });
          }
          return Object.freeze({
            phase: run.phase,
            status: "" as const,
            observedAtMs: this.deps.nowMs(),
          });
        },
        cancel: async (): Promise<void> => {
          if (run.result !== null) return;
          run.cancelRequested = true;
          await processHandle.abort();
        },
        collect: async (): Promise<ExecutionResult> => {
          // Always await the settled promise: it carries the terminal
          // state-record write, so a collector that returned the cached
          // result early could observe a recovery record that still says
          // "running". The promise resolves to the same frozen result
          // every time (first terminal wins).
          return settled;
        },
      };
    } catch (err) {
      this.runs.delete(validated.runId);
      throw err;
    }
  }

  /** A frozen failed result synthesized by `start` for a refusal that
   * never reached the process lifecycle. */
  private refusedResult(
    request: ExecutionRequest,
    failureCategory: ExecutionResult["failureCategory"],
    failureMessage: string,
  ): ExecutionResult {
    return Object.freeze({
      runId: request.runId,
      jobId: request.jobId,
      status: "failed" as const,
      resultHeadSha: "" as const,
      failureCategory,
      failureMessage: boundedFailureMessage(failureMessage),
      resultArtifactPath: "" as const,
      diagnostics: "refused before launch",
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: 0,
      observedAtMs: this.deps.nowMs(),
    });
  }

  /** Crash-recovery reconciliation: classify an execution found on disk for
   * this request's correlation identity. Never collects across
   * generations: a state file whose runId/jobId/attempt does not match the
   * request is foreign. */
  async reconcile(request: ExecutionRequest): Promise<ExecutionReconcileOutcome> {
    const validated = validateExecutionRequest(request);
    const statePath = join(validated.runDir, EXECUTION_STATE_FILE);
    // The recovery record lives in worker-writable space: it is read
    // no-follow and byte-capped like every other file this executor
    // consumes, so a planted file (a symlink, a huge blob) can neither
    // redirect the read nor make the controller allocate without bound.
    // An unreadable or oversized record means "nothing to collect"
    // (fail-safe: the caller may start fresh), exactly like a missing
    // one.
    const read = await readBoundedFileNoFollow(statePath, MAX_STATE_FILE_BYTES);
    if (read.kind !== "ok") {
      return RECONCILE_NONE;
    }
    const text = read.text;
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      return RECONCILE_NONE;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      return RECONCILE_NONE;
    }
    const item = record as Record<string, unknown>;
    if (
      item["runId"] !== validated.runId ||
      item["jobId"] !== validated.jobId ||
      item["attempt"] !== validated.attempt
    ) {
      return RECONCILE_NONE;
    }
    const state = item["state"];
    if (state === "cancelled") {
      return this.settledOutcome(validated, { status: "cancelled" });
    }
    if (state === "failed") {
      const recordedCategory = item["failureCategory"];
      const category = typeof recordedCategory === "string" &&
          (FAILURE_CATEGORIES as readonly string[]).includes(recordedCategory)
        ? recordedCategory
        : "worker_error";
      const recordedMessage = item["failureMessage"];
      const message = typeof recordedMessage === "string" && recordedMessage !== ""
        ? recordedMessage
        : "the recorded execution failed (no message was recorded)";
      return this.settledOutcome(validated, {
        status: "failed",
        failureCategory: category as ExecutionResult["failureCategory"],
        failureMessage: message,
      });
    }
    if (state === "completed") {
      const file = await this.readResultFile(validated);
      if (file.kind === "ok" && file.result.status === "completed") {
        return Object.freeze({
          kind: "settled" as const,
          result: Object.freeze({
            runId: validated.runId,
            jobId: validated.jobId,
            status: "completed" as const,
            resultHeadSha: file.result.resultHeadSha,
            failureCategory: "" as const,
            failureMessage: "" as const,
            resultArtifactPath: file.result.resultArtifactPath,
            diagnostics: "reconciled from the local execution state file",
            artifactPaths: file.result.artifactPaths,
            resourceMs: 0,
            observedAtMs: this.deps.nowMs(),
          }),
        });
      }
      // A recorded completion without a verifiable own result is a
      // contradiction: fail closed, never guess a success.
      return this.settledOutcome(validated, {
        status: "failed",
        failureCategory: "no_result",
        failureMessage: "the recorded-completed execution left no verifiable result",
      });
    }
    // Still recorded as running: a live pid means the caller retries later;
    // a dead pid (0 = never assigned) with no terminal state is an orphan —
    // it can never produce a result, so it IS settled-failed.
    const pid = typeof item["pid"] === "number" ? item["pid"] : 0;
    if (pid > 0 && this.deps.pidAlive(pid)) return RECONCILE_RUNNING;
    return this.settledOutcome(validated, {
      status: "failed",
      failureCategory: "orphaned",
      failureMessage: `the recorded worker (pid ${pid}) is gone with no terminal state`,
    });
  }

  /** Wrap a synthesized terminal result into the `settled` reconcile
   * outcome. */
  private settledOutcome(
    request: ExecutionRequest,
    partial:
      & Pick<ExecutionResult, "status">
      & Partial<Pick<ExecutionResult, "failureCategory" | "failureMessage">>,
  ): ExecutionReconcileOutcome {
    return Object.freeze({
      kind: "settled" as const,
      result: this.reconciledResult(request, partial),
    });
  }

  /** Map a settled `ProcessResult` (plus the result file) onto the
   * `ExecutionResult` contract. The worker's own report only counts when it
   * is present, parseable, validated, AND correlation-matched; the signal
   * path wins over everything (a cancelled run is cancelled, whatever the
   * process then reported). */
  private async classify(run: LocalRun, outcome: ProcessResult): Promise<ExecutionResult> {
    const base = {
      runId: run.request.runId,
      jobId: run.request.jobId,
      diagnostics: this.diagnosticsOf(outcome),
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: outcome.durationMs,
      observedAtMs: this.deps.nowMs(),
    };
    const cancelled = (): ExecutionResult => Object.freeze({
      ...base,
      status: "cancelled" as const,
      resultHeadSha: "",
      failureCategory: "" as const,
      failureMessage: "" as const,
      resultArtifactPath: "",
    });
    const failed = (
      failureCategory: ExecutionResult["failureCategory"],
      failureMessage: string,
    ): ExecutionResult => Object.freeze({
      ...base,
      status: "failed" as const,
      resultHeadSha: "",
      failureCategory,
      failureMessage: boundedFailureMessage(failureMessage),
      resultArtifactPath: "",
    });

    if (run.cancelRequested || run.signal.aborted) return cancelled();
    if (outcome.status === "timeout") {
      return failed("deadline", "the worker exceeded the execution deadline");
    }
    if (outcome.status === "spawn_error") {
      return failed("launch_refused", outcome.launchError ?? "the worker could not be launched");
    }
    if (outcome.status === "signalled") {
      return failed("worker_crash", `the worker died to signal ${outcome.signal ?? "unknown"}`);
    }
    if (outcome.status === "cancelled") {
      // Tree-terminated by an abort this executor did not record (the same
      // shared signal aborted elsewhere): a cancelled run stays cancelled.
      return cancelled();
    }
    if (outcome.exitCode !== 0) {
      return failed("worker_error", `the worker exited with code ${outcome.exitCode}`);
    }
    const file = await this.readResultFile(run.request);
    if (file.kind === "ok") {
      if (file.result.status === "completed") {
        return Object.freeze({
          ...base,
          status: "completed" as const,
          resultHeadSha: file.result.resultHeadSha,
          failureCategory: "" as const,
          failureMessage: "" as const,
          resultArtifactPath: file.result.resultArtifactPath,
          artifactPaths: file.result.artifactPaths,
        });
      }
      return failed(
        "worker_error",
        `the worker reported '${file.result.status}' in its result file`,
      );
    }
    if (file.kind === "stale") {
      return failed(
        "stale_result",
        "the result file belongs to a different correlation identity",
      );
    }
    return failed(
      "no_result",
      file.kind === "missing"
        ? "the worker exited 0 without writing a result file"
        : "the worker exited 0 with a result file that violates the execution-result contract",
    );
  }

  /** Read, correlation-check, and validate the worker's structured result
   * file. The file is proven contained (no symlink, canonical directory
   * inside the run directory) and read with no-follow, bounded semantics
   * before it is parsed at all — a planted symlink is never followed and
   * an oversized file never reaches the parser. Correlation comes NEXT and
   * stays first among the CONTENT checks: a parseable file from another
   * generation is `stale`, never a validation target. */
  private async readResultFile(request: ExecutionRequest): Promise<ResultFileOutcome> {
    const proof = await proveContained(request.runDir, request.resultPath);
    if (!proof.contained) {
      return { kind: "invalid" };
    }
    const read = await readBoundedFileNoFollow(
      request.resultPath,
      MAX_EXECUTION_RESULT_FILE_BYTES,
    );
    if (read.kind === "missing") return { kind: "missing" };
    if (read.kind === "invalid") return { kind: "invalid" };
    let raw: unknown;
    try {
      raw = JSON.parse(read.text);
    } catch {
      return { kind: "invalid" };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "invalid" };
    const item = raw as Record<string, unknown>;
    if (item["runId"] !== request.runId || item["jobId"] !== request.jobId) {
      return { kind: "stale" };
    }
    try {
      return { kind: "ok", result: validateExecutionResult(raw, { runDir: request.runDir }) };
    } catch {
      return { kind: "invalid" };
    }
  }

  /** Build a frozen result synthesized by `reconcile` (no live process to
   * classify; timing details are unavailable after a restart). */
  private reconciledResult(
    request: ExecutionRequest,
    partial:
      & Pick<ExecutionResult, "status">
      & Partial<Pick<ExecutionResult, "failureCategory" | "failureMessage">>,
  ): ExecutionResult {
    return Object.freeze({
      runId: request.runId,
      jobId: request.jobId,
      status: partial.status,
      resultHeadSha: "",
      failureCategory: partial.failureCategory ?? ("" as const),
      failureMessage: boundedFailureMessage(partial.failureMessage ?? ("" as const)),
      resultArtifactPath: "",
      diagnostics: "reconciled from the local execution state file",
      artifactPaths: Object.freeze([]) as readonly string[],
      resourceMs: 0,
      observedAtMs: this.deps.nowMs(),
    });
  }

  /** Bounded diagnostics: a one-line exit summary plus the stderr tail.
   * Stderr is data, never the result protocol. */
  private diagnosticsOf(outcome: ProcessResult): string {
    const exitInfo = outcome.status === "exited"
      ? `worker exited with exitCode ${outcome.exitCode}`
      : outcome.status === "signalled"
        ? `worker died to signal ${outcome.signal ?? "unknown"}`
        : `worker ${outcome.status}`;
    const stderr = outcome.stderr.toString("utf8");
    const tail = stderr.length > DIAGNOSTIC_TAIL_CHARS
      ? stderr.slice(-DIAGNOSTIC_TAIL_CHARS)
      : stderr;
    return tail.trim() === "" ? exitInfo : `${exitInfo}\n${tail}`;
  }

  /** Best-effort recovery-record write; never fails the execution. Writes
   * are serialized per run through the run's write chain, and a
   * non-terminal record never overwrites a settled one: the terminal state
   * write stays final. */
  private writeState(
    run: LocalRun,
    state: ExecutionStateRecord["state"],
    result: ExecutionResult | null = null,
  ): Promise<void> {
    const write = run.stateWriteChain.then(async () => {
      if (result === null && run.result !== null) return;
      await this.writeStateRecord(run, state, result);
    });
    run.stateWriteChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /** One atomic state-file write: temp file + rename, mirroring the
   * queue-store persistence mechanism, so a reader never sees a torn
   * record. The temp path carries a RANDOM suffix and is opened
   * `O_EXCL|O_NOFOLLOW`: a pre-created symlink at the temp path can
   * never be followed, and two writers never share a temp file. */
  private async writeStateRecord(
    run: LocalRun,
    state: ExecutionStateRecord["state"],
    result: ExecutionResult | null,
  ): Promise<void> {
    const record: ExecutionStateRecord = {
      runId: run.request.runId,
      jobId: run.request.jobId,
      attempt: run.request.attempt,
      pid: run.pid,
      startedAtMs: run.startedAtMs,
      state,
      ...(result !== null && result.status === "failed"
        ? { failureCategory: result.failureCategory, failureMessage: result.failureMessage }
        : {}),
    };
    const target = join(run.request.runDir, EXECUTION_STATE_FILE);
    const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
    try {
      const handle = await open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(Buffer.from(JSON.stringify(record), "utf8"));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      // Recovery metadata only: reconcile degrades to `none`/`orphaned`,
      // which is fail-safe, never fail-open.
    }
  }
}
