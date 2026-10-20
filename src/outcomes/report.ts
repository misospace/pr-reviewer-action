/**
 * #1027 denominator-aware aggregation over outcome events, plus the minimal
 * operator-facing report renderer. The aggregate reads LATEST state: each
 * finding identity's status is its most recent status-bearing event, so a
 * finding resolved earlier but re-reported by a later run counts open again.
 * Adjudication follows the same latest-wins rule per finding identity, so a
 * corrected label replaces the one it corrects and counts once.
 *
 * The separation the issue demands is structural: adjudicated precision is
 * computed ONLY from explicit `adjudication` events. A resolved thread, a
 * 👎 reaction, or a vanished comment can move open/resolved/dismissed counts
 * and reaction tallies, but never the adjudicated numbers.
 */
import { outcomeEventInstant } from "./reconcile.js";
import type { AdjudicationLabel, OutcomeEvent } from "./schema.js";

export interface OutcomeAggregate {
  unique_findings: number;
  open: number;
  resolved: number;
  dismissed: number;
  unknown: number;
  reactions: { helpful: number; not_helpful: number };
  adjudicated: {
    confirmed_valid_defect: number;
    confirmed_false_positive: number;
    valid_but_unhelpful: number;
    uncertain: number;
    /** confirmed_valid_defect / (confirmed_valid_defect +
     * confirmed_false_positive), null when there is no adjudication pair —
     * never inflated by resolution or reaction signals. */
    precision: number | null;
  };
}

type OutcomeStatus = "open" | "resolved" | "dismissed" | "unknown";

const STATUS_OF_KIND: Partial<Record<OutcomeEvent["kind"], OutcomeStatus>> = {
  reported: "open",
  repeated: "open",
  still_open: "open",
  resolved: "resolved",
  dismissed: "dismissed",
  unknown: "unknown",
};

export function aggregateOutcomeEvents(
  events: readonly OutcomeEvent[],
): OutcomeAggregate {
  const identities = new Set<string>();
  const status = new Map<string, OutcomeStatus>();
  const adjudication = new Map<string, AdjudicationLabel>();
  let helpful = 0;
  let notHelpful = 0;
  for (const event of events) {
    identities.add(event.finding_id);
    if (event.kind === "feedback") {
      if (event.signal === "helpful") helpful += event.count ?? 0;
      else if (event.signal === "not_helpful") notHelpful += event.count ?? 0;
    }
  }
  // Latest-wins by INSTANT, not raw text or array position: a merged ledger
  // can carry events whose array order does not match their instants (an older
  // run merged after a newer one), and an operator-written instant may carry a
  // UTC offset. Ties fall back to array order.
  const order = events
    .map((event, index) => ({ event, index, at: outcomeEventInstant(event.at) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index));
  for (const { event } of order) {
    const kindStatus = STATUS_OF_KIND[event.kind];
    if (kindStatus !== undefined) status.set(event.finding_id, kindStatus);
    // Adjudication counts FINDINGS, not events: a corrected label
    // (`confirmed_false_positive` at t1, `confirmed_valid_defect` at t2) is
    // one finding that was mislabeled once, not two findings. Counting every
    // historical event put one finding in both precision denominators and let
    // two identical labels double-count it.
    if (event.kind === "adjudication" && event.label !== undefined) adjudication.set(event.finding_id, event.label);
  }
  const adjudicated = {
    confirmed_valid_defect: 0,
    confirmed_false_positive: 0,
    valid_but_unhelpful: 0,
    uncertain: 0,
  };
  for (const label of adjudication.values()) adjudicated[label] += 1;
  const counts: Record<OutcomeStatus, number> = { open: 0, resolved: 0, dismissed: 0, unknown: 0 };
  for (const value of status.values()) counts[value] += 1;
  const precisionDenominator = adjudicated.confirmed_valid_defect + adjudicated.confirmed_false_positive;
  return {
    unique_findings: identities.size,
    open: counts.open,
    resolved: counts.resolved,
    dismissed: counts.dismissed,
    unknown: counts.unknown,
    reactions: { helpful, not_helpful: notHelpful },
    adjudicated: {
      ...adjudicated,
      precision: precisionDenominator === 0 ? null : adjudicated.confirmed_valid_defect / precisionDenominator,
    },
  };
}

/** Minimal markdown report for operators — counts and rates only, no paths,
 * no message text, no logins. */
export function renderOutcomeReportMarkdown(aggregate: OutcomeAggregate): string {
  const precision = aggregate.adjudicated.precision === null
    ? "n/a (no adjudications)"
    : `${(aggregate.adjudicated.precision * 100).toFixed(0)}%`;
  return [
    "## Finding outcomes",
    "",
    `- Unique findings: ${aggregate.unique_findings}`,
    `- Open: ${aggregate.open} · Resolved: ${aggregate.resolved} · Dismissed: ${aggregate.dismissed} · Unknown: ${aggregate.unknown}`,
    `- Reactions: ${aggregate.reactions.helpful} helpful / ${aggregate.reactions.not_helpful} not helpful (informational)`,
    `- Adjudicated: ${aggregate.adjudicated.confirmed_valid_defect} valid / `
      + `${aggregate.adjudicated.confirmed_false_positive} false positive / `
      + `${aggregate.adjudicated.valid_but_unhelpful} valid-but-unhelpful / `
      + `${aggregate.adjudicated.uncertain} uncertain — precision ${precision}`,
  ].join("\n");
}
