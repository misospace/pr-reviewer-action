/** Usage/cost accounting policy (#736).
 *
 * Usage accounting is durable product state, not raw prompt retention:
 * a run's token/request counts are queryable without a single prompt or
 * model response being persisted. The ONE policy rule lives here: cost
 * is never fabricated. A model with no configured monetary price — the
 * common self-hosted case — records its tokens and requests normally
 * while its cost stays explicitly `unknown` with a zero value; a
 * caller that wants an estimate must label it `configured-estimate`
 * (operator-configured pricing) or `provider-reported` (the provider's
 * own numbers), and the provenance travels WITH the cost everywhere it
 * is aggregated (`UsageAggregateRow.costProvenance`, `"mixed"` when a
 * scope mixes sources).
 */

import type { UsageCostProvenance, UsageRecord } from "./types.js";

/** The zero-cost, no-basis usage entry shape a caller records for a
 * model/tool route with no configured price: every count carried, cost
 * explicitly unknown and zero — never a fabricated figure. */
export function usageWithoutCost(
  input: Omit<UsageRecord, "costMicros" | "costProvenance">,
): UsageRecord {
  const record: UsageRecord = Object.freeze({
    ...input,
    costMicros: 0,
    costProvenance: "unknown",
  });
  return record;
}

/** True when the entry's cost came from a real basis
 * (`provider-reported` or `configured-estimate`); `unknown` entries
 * carry no trustworthy cost figure and must be excluded from any
 * money sum that claims a basis. */
export function hasCostBasis(provenance: UsageCostProvenance): boolean {
  return provenance !== "unknown";
}
