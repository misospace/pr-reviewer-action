import {
  summarizeGovernorTelemetry,
  renderGovernorTelemetryLine,
  type GovernorQueueTelemetry,
  type GovernorTelemetrySummary,
} from "./telemetry.js";

/**
 * The run-wide inference governor (#1515): ONE admission point every model
 * request path of a review run flows through before any wire attempt. It
 * bounds how many provider requests one run may have in flight at once and
 * schedules the queued ones by priority, so the review's authoritative work
 * is not the thing that queues behind an advisory burst. The cap comes from
 * the ambient env knob `AI_MAX_CONCURRENT_MODEL_REQUESTS` and is ON by
 * default at the conservative `DEFAULT_MAX_CONCURRENT_REQUESTS`; an explicit
 * `0` opts out (the disabled compatibility posture).
 *
 * What it is NOT, deliberately (#1515 non-goals):
 * - not a quota/token-plan answer: hard account exhaustion (a provider 429
 *   that states a quota) is a terminal condition the transport already
 *   classifies, not a concurrency problem;
 * - not a retry layer: no retries, no backoff, no budget changes;
 * - not a route authority: admission never rewrites primary/smart/fallback/
 *   provider selection — a request queues under the identity its caller
 *   already chose, and the wire payload is handed to the transport verbatim.
 *
 * Scheduling contract (deterministic and testable):
 * - bounded concurrency: at most `maxConcurrent` requests are in flight;
 * - priority classes, highest first: 1 authoritative review / verdict
 *   continuation; 2 merge-gating required
 *   pre-passes; 3 smart/fallback recovery when it owns the authoritative
 *   result; 4 advisory specialists / confidence / optional enrichment;
 * - FIFO within a priority class (monotonic arrival sequence);
 * - no starvation as #1515 defines it: a lower-priority request runs as soon
 *   as no higher-priority request is waiting — strict priority applies only
 *   while higher-priority work is actually contending, and bounded
 *   concurrency means in-flight requests finish, so a freed slot is offered
 *   to the highest-priority waiter, or (when none waits) to lower classes;
 * - cancellation/deadline-aware while queued: an abort or a deadline expiry
 *   removes the request from the queue and rejects it — it never reaches the
 *   transport, consumes no provider attempt, and no retry budget (a queued
 *   request has not dispatched, so the caller's attempt accounting has not
 *   started either);
 * - secrets never participate in scheduling identity: the endpoint key is
 *   built by `inferenceEndpointKey` from base URL, wire format, and model
 *   only — the function takes no credential-bearing input, so a key or an
 *   extra-header value cannot enter the queue, the records, or a log line.
 */

/** The #1515 priority classes, highest first. */
export const GOVERNOR_PRIORITY_AUTHORITATIVE = 1;
export const GOVERNOR_PRIORITY_REQUIRED_PREPASS = 2;
export const GOVERNOR_PRIORITY_RECOVERY = 3;
export const GOVERNOR_PRIORITY_ADVISORY = 4;
export type GovernorPriority = 1 | 2 | 3 | 4;

/** The conservative default cap — two concurrent provider requests per run —
 * used BOTH when a governor is constructed without an explicit cap and when
 * the operator sets no cap at all (#1515 review fix: the unconfigured default
 * must bound the burst it exists to control, so unset/empty enables the
 * governor at this cap; an explicit `0` is the operator's opt-out). */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;

/** Upper bound on a configured cap: an operator typo must not disable the
 * bound entirely (a cap of "unbounded" is what the knob exists to prevent),
 * so out-of-range values are refused as invalid rather than clamped to a
 * silently huge number. */
export const MAX_CONFIGURABLE_CONCURRENCY = 256;

/** Rejection for a request that left the queue without dispatching. The
 * transport-facing seams translate this into their own typed cancelled
 * failure; it never carries provider or credential text by construction. */
export class GovernorCancelledError extends Error {
  /** Why the queued request left: a caller abort ("cancelled") or a queue
   * deadline expiry ("deadline"). */
  readonly reason: "cancelled" | "deadline";
  constructor(reason: "cancelled" | "deadline") {
    super(reason === "deadline"
      ? "inference request expired while queued for an inference slot"
      : "inference request cancelled while queued for an inference slot");
    this.name = "GovernorCancelledError";
    this.reason = reason;
  }
}

/** One request offered for admission. `endpointKey` is the scheduling
 * identity (see `inferenceEndpointKey`); `signal` and `deadlineMs` bound how
 * long the request is willing to WAIT — once dispatched, the request's own
 * transport timeouts and cancellation scope take over. */
export interface GovernedRequest {
  priority: GovernorPriority;
  endpointKey: string;
  /** Abort while queued: a signal already aborted at submission is refused
   * before dispatch (both the immediate and the queued path — the enabled
   * governor never hands an aborted request to the transport), and a signal
   * that aborts DURING the wait removes the request from the queue. Once
   * dispatched, the caller's signal keeps riding the transport itself. */
  signal?: AbortSignal;
  /** Maximum wall-clock wait in the queue, in milliseconds; expiry cancels
   * the request before dispatch. */
  deadlineMs?: number;
}

/** The governor seam. `admit` resolves when a slot is held and rejects (with
 * `GovernorCancelledError`) when the request left the queue without
 * dispatching; the slot is released when the admitted task settles, whatever
 * its outcome. */
export interface InferenceGovernor {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  admit<R>(request: GovernedRequest, task: () => Promise<R>): Promise<R>;
  /** Telemetry recorded since the last drain, then clears it. A disabled
   * governor records nothing and drains nothing. */
  drainTelemetry(): GovernorQueueTelemetry[];
  /** The folded per-run summary over the records since the last drain. */
  summarizeTelemetry(): GovernorTelemetrySummary;
}

/** The scheduling identity of a model request: endpoint URL, wire format,
 * model. Deliberately total over NON-credential inputs only — the parameter
 * object cannot carry an API key or an extra-header value, so scheduling
 * identity can never become a secret carrier (#1515). Requests to different
 * endpoints/models/format thus schedule under distinct identities without
 * ever being distinguishable by credential. */
export function inferenceEndpointKey(input: { baseUrl: string; apiFormat: string; model: string }): string {
  return `${input.baseUrl}|${input.apiFormat}|${input.model}`;
}

interface Waiter {
  readonly seq: number;
  readonly priority: GovernorPriority;
  readonly request: GovernedRequest;
  readonly task: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
  readonly queuedAtMs: number;
  /** Set when the waiter leaves the queue by cancellation/deadline, so a
   * late signal or the pump can never dispatch it twice. */
  removed: boolean;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

class RunInferenceGovernor implements InferenceGovernor {
  readonly maxConcurrent: number;
  readonly enabled: boolean;
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly records: GovernorQueueTelemetry[] = [];
  private seq = 0;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
    this.enabled = Number.isInteger(maxConcurrent) && maxConcurrent >= 1;
  }

  admit<R>(request: GovernedRequest, task: () => Promise<R>): Promise<R> {
    if (!this.enabled) return task();
    // A signal already aborted at submission is refused in BOTH paths: the
    // enqueue path checks below, and the immediate path must not run the task
    // either — an aborted request never dispatches, so it never reaches the
    // transport and records as cancelled-before-dispatch like any other
    // request that left admission without a wire attempt.
    if (request.signal?.aborted) {
      this.records.push({
        priority: request.priority,
        endpointKey: request.endpointKey,
        queueWaitMs: 0,
        activeCount: this.active,
        cancelledBeforeDispatch: true,
      });
      return Promise.reject(new GovernorCancelledError("cancelled"));
    }
    if (this.active < this.maxConcurrent) return this.dispatch(request, task, 0);
    return this.enqueue(request, task);
  }

  drainTelemetry(): GovernorQueueTelemetry[] {
    // Copy BEFORE clearing: the returned records and the internal buffer must
    // not alias, or the clear would empty the caller's result too.
    const drained = [...this.records];
    this.records.length = 0;
    return drained;
  }

  summarizeTelemetry(): GovernorTelemetrySummary {
    return summarizeGovernorTelemetry(this.records);
  }

  /** The critical sections here are deliberately SYNCHRONOUS between the
   * active-count read and the queue write (the same discipline the gateway
   * budget ledger documents): JavaScript runs admission decisions to
   * completion, so a cap admits exactly what fits under concurrent calls. */
  private enqueue<R>(request: GovernedRequest, task: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const waiter: Waiter = {
        seq: ++this.seq,
        priority: request.priority,
        request,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAtMs: Date.now(),
        removed: false,
      };
      if (request.signal !== undefined) {
        if (request.signal.aborted) {
          this.cancel(waiter, "cancelled");
          return;
        }
        waiter.onAbort = () => this.cancel(waiter, "cancelled");
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (request.deadlineMs !== undefined) {
        waiter.timer = setTimeout(() => this.cancel(waiter, "deadline"), Math.max(0, request.deadlineMs));
      }
      this.queue.push(waiter);
    });
  }

  /** Remove a queued waiter: record it as cancelled-before-dispatch and
   * reject it. A no-op for a waiter already dispatched or already removed. */
  private cancel(waiter: Waiter, reason: "cancelled" | "deadline"): void {
    if (waiter.removed) return;
    waiter.removed = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined && waiter.request.signal !== undefined) {
      waiter.request.signal.removeEventListener("abort", waiter.onAbort);
    }
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    this.records.push({
      priority: waiter.priority,
      endpointKey: waiter.request.endpointKey,
      queueWaitMs: Date.now() - waiter.queuedAtMs,
      activeCount: this.active,
      cancelledBeforeDispatch: true,
    });
    waiter.reject(new GovernorCancelledError(reason));
  }

  /** Hold a slot and run the task; release and pump on any settlement. The
   * task starts exactly once — the release watcher awaits the SAME promise
   * the caller receives, so a task outcome is never observed twice and a
   * rejection can never strand the slot. */
  private dispatch<R>(request: GovernedRequest, task: () => Promise<R>, queueWaitMs: number): Promise<R> {
    this.active++;
    this.records.push({
      priority: request.priority,
      endpointKey: request.endpointKey,
      queueWaitMs,
      activeCount: this.active,
      cancelledBeforeDispatch: false,
    });
    const result = task();
    void result.then(
      () => {
        this.active--;
        this.pump();
      },
      () => {
        // The task's own outcome belongs to the promise the caller holds;
        // releasing the slot must never depend on it.
        this.active--;
        this.pump();
      },
    );
    return result;
  }

  /** Offer a freed slot to the highest-priority waiter (FIFO within the
   * class), skipping — and cancelling — waiters whose deadline expired while
   * they sat in the queue. A waiter that is selected is dispatched even if
   * its signal aborted in the same instant JavaScript noticed both: the
   * signal bound the WAIT, and the dispatch decision is atomic with the
   * removal from the queue. */
  private pump(): void {
    while (this.queue.length > 0 && this.active < this.maxConcurrent) {
      let best: Waiter | null = null;
      for (const waiter of this.queue) {
        if (waiter.removed) continue;
        if (waiter.request.deadlineMs !== undefined && Date.now() - waiter.queuedAtMs >= waiter.request.deadlineMs) {
          this.cancel(waiter, "deadline");
          continue;
        }
        if (best === null || waiter.priority < best.priority || (waiter.priority === best.priority && waiter.seq < best.seq)) {
          best = waiter;
        }
      }
      if (best === null) break;
      best.removed = true;
      if (best.timer !== undefined) clearTimeout(best.timer);
      if (best.onAbort !== undefined && best.request.signal !== undefined) {
        best.request.signal.removeEventListener("abort", best.onAbort);
      }
      const index = this.queue.indexOf(best);
      if (index >= 0) this.queue.splice(index, 1);
      this.dispatch(best.request, best.task as () => Promise<unknown>, Date.now() - best.queuedAtMs)
        .then(best.resolve, best.reject);
    }
  }
}

/** Build a governor. Without a cap the governor uses the conservative
 * `DEFAULT_MAX_CONCURRENT_REQUESTS`; with a cap of
 * 1..`MAX_CONFIGURABLE_CONCURRENCY` it bounds the run's in-flight provider
 * requests to it. `0` (or any other value that is not a positive integer)
 * builds a DISABLED governor: `admit` runs the task directly, records no
 * telemetry, and adds no scheduling — the operator's explicit opt-out. */
export function createInferenceGovernor(config?: { maxConcurrent?: number }): InferenceGovernor {
  const raw = config?.maxConcurrent;
  const cap = raw === undefined ? DEFAULT_MAX_CONCURRENT_REQUESTS : raw;
  return new RunInferenceGovernor(cap);
}

/** The disabled module singleton every seam defaults to before a run
 * configures its policy: one boolean branch per request, no queue, no
 * records. A review run replaces this at pipeline start with the governor
 * its env selects (unset env = the conservative default cap); only surfaces
 * that never configure a run keep this one. */
let sharedGovernor: InferenceGovernor | null = null;
const disabledGovernor = createInferenceGovernor({ maxConcurrent: 0 });

/** The run-scoped governor instance for the current process. One process = one
 * review run in the shipped action (the same run-scoping rule the terminal
 * lane latch uses), so a module-scoped instance IS run-scoped; tests inject
 * their own governors instead of relying on this. Returns the disabled
 * governor until (and after) a run configures one. */
export function sharedRunInferenceGovernor(): InferenceGovernor {
  return sharedGovernor ?? disabledGovernor;
}

/** Install (or clear, with null) the run-scoped governor. The engine calls
 * this once at pipeline start and clears it in its finally, so a run can
 * never inherit another run's policy. */
export function configureSharedRunInferenceGovernor(governor: InferenceGovernor | null): void {
  sharedGovernor = governor;
}

/** Drain the shared governor's admission records, when one is configured and
 * enabled. Returns null when no enabled governor is installed (the default
 * posture — the pipeline then logs no governor line at all). */
export function drainSharedRunInferenceGovernor(): GovernorTelemetrySummary | null {
  if (sharedGovernor === null || !sharedGovernor.enabled) return null;
  return sharedGovernor.summarizeTelemetry();
}

/** The env knob (#1515): a run-wide cap on concurrent model requests.
 * Unset/empty enables the CONSERVATIVE DEFAULT cap
 * (`DEFAULT_MAX_CONCURRENT_REQUESTS`) — the issue's "bounded configurable
 * concurrency with a conservative default": the unconfigured burst is exactly
 * the one the knob exists to bound, so the default posture is bounded. An
 * explicit `0` is the operator's opt-out (the disabled compatibility
 * posture); a positive integer `1..MAX_CONFIGURABLE_CONCURRENCY` is the cap;
 * anything else is invalid and reported as such so the engine can warn by
 * name and fall back to the conservative default — a typo never silently
 * unbounds the run (and never aborts a review). */
export const RUN_INFERENCE_CAP_ENV = "AI_MAX_CONCURRENT_MODEL_REQUESTS";

export type RunInferenceCapConfig =
  | { kind: "disabled" }
  | { kind: "enabled"; cap: number }
  | { kind: "invalid"; raw: string };

export function parseRunInferenceCap(raw: string | undefined): RunInferenceCapConfig {
  if (raw === undefined) return { kind: "enabled", cap: DEFAULT_MAX_CONCURRENT_REQUESTS };
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "enabled", cap: DEFAULT_MAX_CONCURRENT_REQUESTS };
  const value = Number(trimmed);
  if (!Number.isInteger(value)) return { kind: "invalid", raw: trimmed };
  if (value === 0) return { kind: "disabled" };
  if (value < 0 || value > MAX_CONFIGURABLE_CONCURRENCY) return { kind: "invalid", raw: trimmed };
  return { kind: "enabled", cap: value };
}

/** The governor a run configures from its env. Unset/empty enables the
 * conservative default cap; an explicit `0` returns null (the disabled
 * posture); an invalid value returns the conservative default cap too — the
 * caller warns by name, and the run stays bounded either way. */
export function inferenceGovernorFromEnv(env: Record<string, string | undefined>): InferenceGovernor | null {
  const parsed = parseRunInferenceCap(env[RUN_INFERENCE_CAP_ENV]);
  if (parsed.kind === "disabled") return null;
  const cap = parsed.kind === "enabled" ? parsed.cap : DEFAULT_MAX_CONCURRENT_REQUESTS;
  return createInferenceGovernor({ maxConcurrent: cap });
}

/** The one bounded observability line for a drained summary (the record
 * shape lives in src/model/telemetry.ts). */
export function renderRunInferenceTelemetryLine(summary: GovernorTelemetrySummary): string {
  return `inference governor: ${renderGovernorTelemetryLine(summary)}`;
}
