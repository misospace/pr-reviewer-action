/**
 * #1606: the harness artifact's execution counters, read by ONE rule so
 * every consumer sees the same numbers — and the ONE predicate that tells
 * a deadline-clamped executor error apart from a real tool failure (#1464),
 * shared by the smart-tier fallback trigger and the all-failed overlay so
 * the two can never disagree on what a failure IS.
 *
 * The harness artifact carries two settled counters (#1597):
 * `executed_request_count` counts every call that reached an executor
 * (successful OR failed) and `successful_request_count` counts the calls
 * that succeeded (executor status "ok"). Each consumer asks its own
 * question — the tool-failure overlay asks "were calls attempted?", the
 * unresolved-evidence cause asks "did any call succeed?" — and each must
 * read the counter that matches its question. Reading the wrong one made
 * the tool-failure overlay impossible to fire: it asked the successful
 * count whether calls were attempted, and the successful count is zero
 * exactly when every call failed.
 *
 * The rule:
 * - The settled counter is the source (it is the snapshot the step summary
 *   and the marker publish).
 * - An artifact that carries no settled counter is read from the per-call
 *   trace: `tool_results` holds one entry per executed call, and
 *   `tool_calls` holds the same population.
 * - A count that is neither reported nor traceable is UNKNOWN (null), not
 *   zero. A consumer that asks "is it exactly zero?" must not read an
 *   unknown state as zero.
 */

export interface HarnessExecutionCounts {
  /** Calls that reached an executor (successful or failed); null = unknown. */
  attempted: number | null;
  /** Calls that succeeded (executor status "ok"); null = unknown. */
  succeeded: number | null;
}

interface TraceEntry {
  status: string;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The per-call trace: one entry per executed call, with its status. */
function harnessTrace(harness: Record<string, unknown>): TraceEntry[] {
  const source = Array.isArray(harness.tool_results)
    ? harness.tool_results
    : Array.isArray(harness.tool_calls)
      ? harness.tool_calls
      : [];
  return source
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
    .map((entry) => ({ status: typeof entry.status === "string" ? entry.status : "" }));
}

/**
 * #1606: read the harness artifact's execution counters. One rule for every
 * consumer, so no two of them can read the same field with different
 * meanings. The argument is the parsed artifact (any shape): a value that
 * is not an object reports nothing. */
export function harnessExecutionCounts(harness: unknown): HarnessExecutionCounts {
  if (harness === null || typeof harness !== "object") return { attempted: null, succeeded: null };
  const record = harness as Record<string, unknown>;
  const executed = finiteNumber(record.executed_request_count);
  const successful = finiteNumber(record.successful_request_count);
  const trace = harnessTrace(record);
  return {
    attempted: executed ?? (trace.length > 0 ? trace.length : null),
    succeeded: successful ?? (trace.length > 0 ? trace.filter((entry) => entry.status === "ok").length : null),
  };
}

/**
 * #1606: true when the artifact reports ZERO successful tool calls — the
 * run gathered no evidence, so an unresolved evidence row must read as a
 * missing tool capability. An artifact that reports no successful count at
 * all says nothing: unknown is not zero. */
export function harnessGatheredNoEvidence(harness: unknown): boolean {
  return harnessExecutionCounts(harness).succeeded === 0;
}

/**
 * #1464: the executor's canned error when the tool loop's own time budget
 * stopped a call BEFORE it ran — the exploration-boundary clamp (a round
 * that started before the verdict-reserve threshold) and the whole-run
 * deadline. A deadline stop is NOT a tool failure: the smart-tier
 * tool-error fallback trigger ignores it so the closing verdict keeps its
 * reserved slice, and the #1606 all-failed overlay must read it the same
 * way. The constants live HERE — the leaf module that owns the artifact's
 * execution meaning — so the two enforcement points cannot drift apart.
 */
export const TOOL_LOOP_EXPLORATION_DEADLINE_ERROR = "tool-loop exploration deadline exceeded";
export const TOOL_LOOP_DEADLINE_ERROR = "tool-loop deadline exceeded";

/** True when an executor error IS the loop deadline stopping the call. */
export function isToolLoopDeadlineError(error: unknown): boolean {
  return error === TOOL_LOOP_EXPLORATION_DEADLINE_ERROR || error === TOOL_LOOP_DEADLINE_ERROR;
}

/**
 * #1606 review: true when the artifact's per-call trace shows that EVERY
 * failed call failed ONLY because a loop deadline clamped it (#1464) — at
 * least one non-ok entry exists and each one's executor error IS the
 * deadline marker. The `tool_results` trace is the only representation
 * carrying the per-call error text; an artifact without it says nothing
 * about WHY calls failed, so this reports false and the all-failed overlay
 * keeps its fail-closed reading of the settled counters.
 */
export function harnessFailuresAllDeadlineClamps(harness: unknown): boolean {
  if (harness === null || typeof harness !== "object") return false;
  const source = (harness as Record<string, unknown>).tool_results;
  if (!Array.isArray(source)) return false;
  let failures = 0;
  for (const entry of source) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.status === "ok") continue;
    failures += 1;
    const nested = record.result;
    const error = nested !== null && typeof nested === "object"
      ? (nested as Record<string, unknown>).error
      : undefined;
    if (!isToolLoopDeadlineError(error)) return false;
  }
  return failures > 0;
}
