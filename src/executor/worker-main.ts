/** The production review-worker entrypoint (#733 worker-image contract,
 * #738 Phase A1 self-hosted packaging): the process a worker image (or the
 * local executor) runs to perform ONE review execution from the executor's
 * request envelope.
 *
 * The contract it satisfies is `src/executor/image.ts`'s portable
 * worker-image contract:
 *
 * - The request-envelope path arrives as the FINAL argv element (the
 *   executor appends it after the image's fixed args) or, failing that,
 *   via the request coordination env var. Nothing else in argv is
 *   meaningful: the executor appends ONLY the envelope path, so the last
 *   element IS the envelope whether or not the image carried operator
 *   args before it.
 * - The structured result is written to the envelope's `resultPath` —
 *   never stdout — and validated with the executor's own
 *   `validateExecutionResult` BEFORE it is written, so the worker can
 *   never emit a result its own contract refuses.
 * - SIGTERM (and SIGINT) abort the engine's cancellation signal promptly
 *   and settle a `cancelled` result before exit, so cancellation is
 *   observable through the result-file protocol.
 * - No environment beyond the two coordination variables plus generic
 *   PATH/HOME/TMPDIR keys is required: request/job/repo-derived data
 *   reaches the worker exclusively inside the envelope file.
 *
 * The worker is a DRIVER, not a policy layer: it maps the validated
 * `ExecutionRequest` onto the engine's `ReviewRequest` (the same mapping
 * shape `engine/cli.ts` builds from its request file), runs the real
 * review engine inside the acquired workspace, and reports the terminal
 * outcome through the result-file protocol. It never talks to a forge and
 * never executes anything the envelope names beyond driving the engine.
 *
 * Status/failure mapping (agreed with the local executor's classification
 * in `src/executor/local.ts`):
 *
 * - engine completed AND the publication artifact
 *   (`<runDir>/ai-output.json`, the file `src/controller/publication.ts`
 *   consumes via `ExecutionResult.resultArtifactPath`) exists on disk →
 *   `completed`, `resultHeadSha` = the engine's verified reviewed head
 *   (identical to the envelope's head pin when one was carried —
 *   admission guarantees the pin and the verified head agree);
 * - SIGTERM/SIGINT → `cancelled`, diagnostics naming the signal;
 * - deadline expiry → `failed` `deadline`, the same category the local
 *   executor assigns a timed-out worker;
 * - any engine failure → `failed` `worker_error`;
 * - no result file could be produced (unreadable or invalid envelope,
 *   unprovable result path, failed write) → non-zero exit with NO result
 *   file: there is nothing to correlate, and the executor's contract
 *   classifies that absence fail-closed (`no_result`/`worker_error`),
 *   never as a guessed success.
 *
 * An engine run that ends without the publication artifact (e.g. an
 * admission skip writes no `ai-output.json`) is a `failed`
 * `worker_error`, never a `completed` result pointing at a missing file:
 * a completed result whose publication read would always refuse is worse
 * than an honest infrastructure failure.
 *
 * Operator-mode library (like `src/executor/`): wired as the `worker`
 * subcommand of the runtime bundle (`src/index.ts`); the Action pipeline
 * is untouched.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { runReviewEngine, type RunReviewResult } from "../engine/review.js";
import type { ReviewDependencies, ReviewRequest } from "../engine/types.js";
import { EXECUTION_REQUEST_ENV_KEY } from "./local.js";
import { ensureContained, readBoundedFileNoFollow, writeFileNoFollow } from "./paths.js";
import { boundedFailureMessage } from "./result-file.js";
import {
  MAX_EXECUTION_RESULT_FILE_BYTES,
  validateExecutionRequest,
  validateExecutionResult,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionFailureCategory,
} from "./types.js";

/** The engine surface the worker consumes. The engine's full
 * `RunReviewResult` satisfies this shape; tests inject a narrower fake. */
export type WorkerEngineOutcome = Pick<RunReviewResult, "reviewedHeadSha">;

/** Injected seams — all optional; the defaults are the production ones.
 * Tests inject a fake review runner instead of invoking the real engine
 * (the worker must not need model calls to be testable). */
export interface WorkerMainDeps {
  /** The review runner. Default: the real `runReviewEngine`. */
  readonly runReview?: (
    request: ReviewRequest,
    dependencies: ReviewDependencies,
  ) => Promise<WorkerEngineOutcome>;
  /** Clock. Default: `Date.now`. */
  readonly nowMs?: () => number;
}

/** The review artifact the publication layer consumes
 * (`src/controller/publication.ts` reads `ExecutionResult.resultArtifactPath`
 * and parses it as the review record the engine persisted there). */
const ENGINE_ARTIFACT_NAME = "ai-output.json";

/** The engine's CI-evidence table location, mirroring the standalone
 * `run` orchestrator's default (`src/run/review.ts`). */
const CI_CHECKS_ARTIFACT_NAME = "ci-checks-context.md";

/** The envelope is the controller-written correlation source of truth,
 * but it is still read with the subsystem's bounded no-follow semantics:
 * an oversized or non-regular file at the path is refused, never parsed. */
const MAX_ENVELOPE_FILE_BYTES = MAX_EXECUTION_RESULT_FILE_BYTES;

/** Diagnostics tail bound: at most this many characters of the engine's
 * log/error stream survive into a result. */
const DIAGNOSTIC_TAIL_CHARS = 2_000;

/** Bounded single-line stderr diagnostic: the worker's own diagnostics are
 * operator-facing stderr text, never the result protocol. */
const MAX_DIAGNOSTIC_LINE_CHARS = 2_000;

function boundedLine(message: string): string {
  if (message.length <= MAX_DIAGNOSTIC_LINE_CHARS) return message;
  return `${message.slice(0, MAX_DIAGNOSTIC_LINE_CHARS - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The engine's log/error stream, tail-bounded behind a one-line summary —
 * stderr is diagnostics, never the result protocol. */
function diagnosticsWith(summary: string, tail: readonly string[]): string {
  const text = tail.join("\n");
  const trimmed = text.length > DIAGNOSTIC_TAIL_CHARS ? text.slice(-DIAGNOSTIC_TAIL_CHARS) : text;
  return trimmed.trim() === "" ? summary : `${summary}\n${trimmed}`;
}

/** The terminal-shaped fields every result shares: the correlation
 * identity echoed from the envelope, bounded diagnostics, the measured
 * wall time, and the settle timestamp. */
interface TerminalContext {
  readonly request: ExecutionRequest;
  readonly startedAtMs: number;
  readonly nowMs: () => number;
  readonly summary: string;
  readonly tail: readonly string[];
}

function terminalBase(context: TerminalContext): {
  runId: string;
  jobId: string;
  diagnostics: string;
  artifactPaths: readonly string[];
  resourceMs: number;
  observedAtMs: number;
} {
  return {
    runId: context.request.runId,
    jobId: context.request.jobId,
    diagnostics: diagnosticsWith(context.summary, context.tail),
    artifactPaths: Object.freeze([]) as readonly string[],
    resourceMs: Math.max(0, context.nowMs() - context.startedAtMs),
    observedAtMs: context.nowMs(),
  };
}

/** The cancelled outcome: correlation echoed, no head, no artifact. */
function cancelledResult(context: TerminalContext): ExecutionResult {
  return Object.freeze({
    ...terminalBase(context),
    status: "cancelled" as const,
    resultHeadSha: "" as const,
    failureCategory: "" as const,
    failureMessage: "" as const,
    resultArtifactPath: "" as const,
  });
}

/** A failed outcome with an explicit `ExecutionFailureCategory`. */
function failedResult(
  context: TerminalContext,
  failureCategory: ExecutionFailureCategory,
  failureMessage: string,
): ExecutionResult {
  return Object.freeze({
    ...terminalBase(context),
    status: "failed" as const,
    resultHeadSha: "" as const,
    failureCategory,
    failureMessage: boundedFailureMessage(failureMessage),
    resultArtifactPath: "" as const,
  });
}

/** The completed outcome: the publication artifact the engine persisted
 * in the run directory. A completed result is only ever built for a run
 * that left that artifact on disk (the caller checks); a completed result
 * pointing at a missing file would be refused by publication forever.
 *
 * `resultHeadSha` is the engine's verified reviewed head, VERBATIM — never
 * the envelope's head pin. An engine outcome that names no verified head
 * (`reviewedHeadSha === ""`) builds a completed candidate the executor's
 * own contract refuses (`validateExecutionResult` requires a non-empty
 * `resultHeadSha` when completed), so `settleResult` fails the run closed
 * as a `worker_error` instead of publishing a "verified at head X" claim
 * the engine never made (#1500). */
function completedResult(context: TerminalContext, reviewedHeadSha: string): ExecutionResult {
  return Object.freeze({
    ...terminalBase(context),
    status: "completed" as const,
    resultHeadSha: reviewedHeadSha,
    failureCategory: "" as const,
    failureMessage: "" as const,
    resultArtifactPath: join(context.request.runDir, ENGINE_ARTIFACT_NAME),
  });
}

/** Validate the candidate result against the executor's own contract
 * BEFORE writing it; a candidate that cannot validate (possible only when
 * the engine violates its own contract — e.g. completing without
 * reporting a verified reviewed head, #1500) fails closed to a
 * `worker_error` failure instead of writing a result the executor would
 * refuse. Returns null only when even the fallback cannot validate, in
 * which case no result file is written at all. */
function settleResult(context: TerminalContext, candidate: ExecutionResult): ExecutionResult | null {
  try {
    return validateExecutionResult(candidate, { runDir: context.request.runDir });
  } catch (error) {
    const fallback = failedResult(
      context,
      "worker_error",
      `the worker's own result violated the execution-result contract: ${errorMessage(error)}`,
    );
    try {
      return validateExecutionResult(fallback, { runDir: context.request.runDir });
    } catch {
      return null;
    }
  }
}

/** The production worker entrypoint. Returns the process exit code:
 * 0 whenever a result file was written (any status), non-zero only when
 * no result could be written. */
export async function workerMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: WorkerMainDeps = {},
): Promise<number> {
  const nowMs = deps.nowMs ?? ((): number => Date.now());
  const startedAtMs = nowMs();

  // ── Envelope resolution: the FINAL argv element, else the coordination
  // env var. The executor appends only the envelope path, so the last
  // element is the envelope whether the image carried operator args or
  // none at all.
  const finalArg = argv.length > 0 ? argv[argv.length - 1] ?? "" : "";
  const requestPath = finalArg !== "" ? finalArg : (env[EXECUTION_REQUEST_ENV_KEY] ?? "");
  if (requestPath === "") {
    process.stderr.write(
      `worker: no request envelope path (expected the final argv element or ${EXECUTION_REQUEST_ENV_KEY})\n`,
    );
    return 2;
  }
  const read = await readBoundedFileNoFollow(requestPath, MAX_ENVELOPE_FILE_BYTES);
  if (read.kind !== "ok") {
    process.stderr.write(
      `${boundedLine(`worker: the request envelope ${requestPath} could not be read (missing or not a bounded regular file)`)}\n`,
    );
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    process.stderr.write(`worker: the request envelope ${requestPath} is not JSON\n`);
    return 2;
  }
  let request: ExecutionRequest;
  try {
    request = validateExecutionRequest(raw);
  } catch (error) {
    process.stderr.write(
      `${boundedLine(`worker: the request envelope is not a valid execution request: ${errorMessage(error)}`)}\n`,
    );
    return 2;
  }

  // ── Cancellation lifecycle, exactly `engine/cli.ts`'s: SIGINT/SIGTERM
  // abort the engine's cancellation signal instead of killing the process
  // mid-write; the handlers are removed again once the run settles.
  const controller = new AbortController();
  const abortHandlers: Array<[NodeJS.Signals, () => void]> = [];
  let abortReason = "";
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      abortReason = signalName;
      controller.abort(signalName);
    };
    process.on(signalName, handler);
    abortHandlers.push([signalName, handler]);
  }

  // ── Deadline backstop: the executor turns the deadline into the
  // worker's whole-process timeout and terminates the tree itself; this
  // timer makes the deadline observable THROUGH the result protocol too
  // (an OCI/container executor may not enforce the kill), aborting the
  // engine and settling a `deadline` failure like the executor would. A
  // deadline that already expired never runs the engine at all.
  let deadlineFired = request.deadlineAtMs !== 0 && request.deadlineAtMs - nowMs() <= 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (!deadlineFired && request.deadlineAtMs !== 0) {
    deadlineTimer = setTimeout(() => {
      deadlineFired = true;
      abortReason = "the execution deadline";
      controller.abort("deadline");
    }, request.deadlineAtMs - nowMs());
  }

  // ── The engine request, mapped the way `engine/cli.ts` maps its request
  // file's fields onto the engine's contract.
  const tail: string[] = [];
  const engineRequest: ReviewRequest = {
    signal: controller.signal,
    repository: request.repoFullName,
    prNumber: String(request.prNumber),
    headSha: request.headSha,
    baseRef: request.baseSha,
    isForkPr: "",
    platform: request.platform,
    // The envelope carries the non-secret forge API base (#1433/#1348): "" is
    // the GitHub default and the engine's admission applies `||`, so the
    // value passes through verbatim (never `??`, which never fires on "").
    forgejoApiUrl: request.forgeApiUrl,
    ciChecksFile: join(request.runDir, CI_CHECKS_ARTIFACT_NAME),
    // The envelope carries no contract inputs by design: operator
    // configuration is operator-side state, and repository config is
    // resolved by the engine from the trusted base ref (`baseRef` above).
    inputs: {},
    // The worker environment is the executor's generic allowlist, never
    // forge context; downstream adapters resolve what they can from the
    // platform and repository identity in the envelope.
    ambient: {},
    triggerReason: request.kind,
    forceRereview: false,
  };
  const engineDependencies: ReviewDependencies = {
    workspace: request.workspace.rootPath,
    runDir: request.runDir,
    outputsSink: "/dev/null",
    log: (line) => {
      tail.push(line);
      process.stderr.write(`[v3] ${line}\n`);
    },
    error: (line) => {
      tail.push(`ERROR: ${line}`);
      process.stderr.write(`[v3] ERROR: ${line}\n`);
    },
    annotate: (line) => process.stdout.write(`${line}\n`),
  };

  const context = (summary: string): TerminalContext => ({
    request,
    startedAtMs,
    nowMs,
    summary,
    tail,
  });
  const DEADLINE_SUMMARY = "the worker exceeded the execution deadline";
  const cancelledSummary = (): string => `cancelled by ${abortReason || "an abort"}`;

  let candidate: ExecutionResult;
  try {
    if (deadlineFired) {
      candidate = failedResult(context(DEADLINE_SUMMARY), "deadline", DEADLINE_SUMMARY);
    } else {
      try {
        const outcome = await (deps.runReview ?? runReviewEngine)(engineRequest, engineDependencies);
        if (deadlineFired) {
          candidate = failedResult(context(DEADLINE_SUMMARY), "deadline", DEADLINE_SUMMARY);
        } else if (controller.signal.aborted) {
          candidate = cancelledResult(context(cancelledSummary()));
        } else {
          const artifactInfo = statSync(join(request.runDir, ENGINE_ARTIFACT_NAME), {
            throwIfNoEntry: false,
          });
          if (artifactInfo === undefined || !artifactInfo.isFile()) {
            candidate = failedResult(
              context("the engine run left no publication artifact"),
              "worker_error",
              `the engine run left no ${ENGINE_ARTIFACT_NAME} artifact in the run directory`,
            );
          } else {
            candidate = completedResult(context("the engine run completed"), outcome.reviewedHeadSha);
          }
        }
      } catch (error) {
        if (deadlineFired) {
          candidate = failedResult(context(DEADLINE_SUMMARY), "deadline", DEADLINE_SUMMARY);
        } else if (controller.signal.aborted) {
          candidate = cancelledResult(context(cancelledSummary()));
        } else {
          candidate = failedResult(
            context("the engine run failed"),
            "worker_error",
            errorMessage(error),
          );
        }
      }
    }
  } finally {
    // A finished run never keeps the process's signal handlers (and a
    // stale controller or deadline timer) alive: repeated in-process
    // invocations must not accumulate listeners or abort each other's
    // controllers.
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    for (const [signalName, handler] of abortHandlers) process.removeListener(signalName, handler);
  }

  // The summary here lands only in the fallback's diagnostics (a candidate
  // that fails its own contract validation), so it states what the run
  // actually settled to — never a blanket failure claim.
  const settled = settleResult(
    context(candidate.status === "completed" ? "the engine run completed" : `the engine run settled as ${candidate.status}`),
    candidate,
  );
  if (settled === null) {
    process.stderr.write("worker: no contract-valid result could be built; exiting without a result file\n");
    return 1;
  }

  // The result file is written with the subsystem's own fail-closed care:
  // the parent path is proven contained in the run directory on disk (a
  // planted symlink is refused, never followed) and the write itself is
  // no-follow. Nothing outside the controller-owned run directory is ever
  // created.
  const proof = await ensureContained(request.runDir, request.resultPath);
  if (!proof.contained) {
    process.stderr.write(
      `${boundedLine(`worker: the result path is not contained in the run directory: ${proof.problem}`)}\n`,
    );
    return 1;
  }
  try {
    await writeFileNoFollow(request.resultPath, JSON.stringify(settled, null, 2));
  } catch (error) {
    process.stderr.write(
      `${boundedLine(`worker: the result file ${request.resultPath} could not be written: ${errorMessage(error)}`)}\n`,
    );
    return 1;
  }
  return 0;
}
