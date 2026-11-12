/**
 * #1606: the harness artifact's execution counters, read by ONE rule so
 * every consumer sees the same numbers.
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
