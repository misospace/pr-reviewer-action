/**
 * #1027 deterministic reconciliation: turn (current findings × prior
 * published-observation state × optional prior ledger) into normalized
 * outcome events. Pure and total — every input shape is validated, and any
 * state the action cannot prove emits either a conservative event or
 * nothing, never a stronger claim:
 *
 * - A thread resolved while the head provably advanced is `resolved` (after
 *   a newer head); with the head unchanged or unprovable it is `dismissed`
 *   with an explicit reason — never silently promoted to a code fix.
 * - A thread still open is `still_open`; an unprovable thread state emits no
 *   thread event at all.
 * - Reactions are informational `feedback` events with counts only; they
 *   never resolve, dismiss, or reclassify anything.
 * - An identity whose LATEST status in the prior ledger is still open, and
 *   which is gone from both the current findings and the current forge
 *   observations, is `unknown` (lost history). A finding already resolved or
 *   dismissed before the ledger event is never re-declared unknown.
 */
import { MAX_LEDGER_EVENTS, type OutcomeEvent } from "./schema.js";

export interface PriorFindingObservation {
  /** 64-hex identity recovered from the published finding-id marker. */
  findingId: string;
  commentId: string;
  /** Thread resolution state, or null when it cannot be proven. */
  resolved: boolean | null;
  /** All-actor 👍/👎 counts on the published comment (informational). */
  reactions: { helpful: number; notHelpful: number };
}

export interface DeriveOutcomeOptions {
  /** Stable identities of the findings this run is actually about to
   * publish (parsed from the marker each posted comment carries) — never
   * the raw finding array, so a finding the anchor validation skips can
   * never produce a `reported` event for a comment that does not exist. */
  postedIdentities: readonly string[];
  prior: readonly PriorFindingObservation[];
  priorHeadSha: string | null;
  currentHeadSha: string;
  route: string | null;
  model: string | null;
  at: string;
  /** Operator-mode persistence: a prior ledger to merge into. Absent in
   * stateless Action mode. */
  priorLedger?: readonly OutcomeEvent[];
}

/** Every kind that carries a finding's lifecycle status (as opposed to the
 * two informational kinds, `feedback` and `adjudication`). The latest such
 * event per identity is that identity's state. */
const STATUS_KINDS: ReadonlySet<OutcomeEvent["kind"]> = new Set([
  "reported", "repeated", "still_open", "resolved", "dismissed", "unknown",
]);
/** The statuses that mean "this finding is still live": only these can be lost
 * history. A finding whose latest status is closed (`resolved`/`dismissed`) or
 * already unknown was accounted for and must never be re-declared. */
const OPEN_STATUS_KINDS: ReadonlySet<OutcomeEvent["kind"]> = new Set([
  "reported", "repeated", "still_open",
]);

function sameHead(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.trim() !== "" && b.trim() !== "" && a === b;
}

/** Chronological position of an event's instant. `at` is either an
 * ISO-8601 instant the normalizer already parsed or absent, so ordering on the
 * parsed value — not on the raw text — is what makes mixed UTC offsets
 * (`…T23:00:00-05:00` is LATER than `…T01:00:00Z`) compare correctly. An
 * unprovable instant sorts as the oldest, which can only move a claim toward
 * `open`, never toward `resolved`. */
export function outcomeEventInstant(at: string | null | undefined): number {
  if (typeof at !== "string" || at.trim() === "") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function deriveOutcomeEvents(options: DeriveOutcomeOptions): OutcomeEvent[] {
  const base: OutcomeEvent[] = deriveCurrentEvents(options);
  if (options.priorLedger === undefined) return base;
  return mergeLedger(options.priorLedger, base, options);
}

function deriveCurrentEvents(options: DeriveOutcomeOptions): OutcomeEvent[] {
  const events: OutcomeEvent[] = [];
  const currentIdentities = new Set<string>();
  // Chronological order inside one derivation: the prior published state is
  // observed first, the current review reports last — so the LATEST
  // status-bearing event per identity is the current truth (a finding whose
  // old thread was resolved but that this run re-reports is open again).
  for (const observation of options.prior) {
    if (observation.resolved === true) {
      const headAdvanced = options.priorHeadSha !== null
        && options.priorHeadSha.trim() !== ""
        && options.currentHeadSha.trim() !== ""
        && !sameHead(options.priorHeadSha, options.currentHeadSha);
      if (headAdvanced) {
        events.push({
          finding_id: observation.findingId,
          kind: "resolved",
          at: options.at,
          head_sha: options.currentHeadSha || null,
          route: options.route,
          model: options.model,
          provenance: "forge-thread",
        });
      } else {
        events.push({
          finding_id: observation.findingId,
          kind: "dismissed",
          at: options.at,
          head_sha: options.currentHeadSha || null,
          route: options.route,
          model: options.model,
          provenance: "forge-thread",
          reason: options.priorHeadSha === null || options.priorHeadSha.trim() === ""
            ? "thread_resolved_head_unverified"
            : "thread_resolved",
        });
      }
    } else if (observation.resolved === false) {
      events.push({
        finding_id: observation.findingId,
        kind: "still_open",
        at: options.at,
        head_sha: options.currentHeadSha || null,
        route: options.route,
        model: options.model,
        provenance: "forge-thread",
      });
    }
    if (observation.reactions.helpful > 0) {
      events.push({
        finding_id: observation.findingId,
        kind: "feedback",
        at: options.at,
        head_sha: options.currentHeadSha || null,
        route: options.route,
        model: options.model,
        provenance: "forge-reaction",
        signal: "helpful",
        count: observation.reactions.helpful,
        trusted: false,
      });
    }
    if (observation.reactions.notHelpful > 0) {
      events.push({
        finding_id: observation.findingId,
        kind: "feedback",
        at: options.at,
        head_sha: options.currentHeadSha || null,
        route: options.route,
        model: options.model,
        provenance: "forge-reaction",
        signal: "not_helpful",
        count: observation.reactions.notHelpful,
        trusted: false,
      });
    }
  }

  const findings = options.postedIdentities;
  for (const identity of findings) {
    if (currentIdentities.has(identity)) continue;
    currentIdentities.add(identity);
    const seen = options.prior.some((observation) => observation.findingId === identity);
    events.push({
      finding_id: identity,
      kind: seen ? "repeated" : "reported",
      at: options.at,
      head_sha: options.currentHeadSha || null,
      route: options.route,
      model: options.model,
      provenance: "current-review",
    });
  }
  if (options.priorLedger === undefined) return events;
  // Ledger-driven lost history: an identity the ledger tracked as live that
  // is gone from both the current findings and the current forge
  // observations. The current-run events above are authoritative for what
  // WAS observed, so an identity they still carry is never declared unknown.
  const observed = new Set(currentIdentities);
  for (const observation of options.prior) observed.add(observation.findingId);
  // Latest-wins by INSTANT, not array position — the same rule
  // `aggregateOutcomeEvents` applies to the merged ledger (an older run can
  // be merged after a newer one, so array order is not chronology). An
  // identity's LATEST status is what decides whether its absence is lost
  // history: `reported(A,t1)` followed by `resolved(A,t2)` means A was
  // accounted for, and re-declaring it `unknown` would be a false alarm.
  const ordered = options.priorLedger
    .map((event, index) => ({ event, index, at: outcomeEventInstant(event.at) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index));
  const lastStatus = new Map<string, OutcomeEvent["kind"]>();
  for (const { event } of ordered) {
    if (STATUS_KINDS.has(event.kind)) lastStatus.set(event.finding_id, event.kind);
  }
  for (const [identity, kind] of lastStatus) {
    if (!observed.has(identity) && OPEN_STATUS_KINDS.has(kind)) {
      events.push({
        finding_id: identity,
        kind: "unknown",
        at: options.at,
        head_sha: options.currentHeadSha || null,
        route: options.route,
        model: options.model,
        provenance: "prior-ledger",
      });
    }
  }
  return events;
}

/** Dedupe identity of one event. JSON-serialized, not NUL-joined: `reason`
 * is bounded free text and `at` is an ISO-shaped parse-validated string that
 * Date.parse accepts with trailing NULs, so a crafted prior-ledger event
 * could embed the bare-NUL separators and collide two DISTINCT events into
 * one key (one then silently dropped by `mergeLedger`). The JSON encoding is
 * injective over exactly these field values. */
function eventKey(event: OutcomeEvent): string {
  return JSON.stringify([
    event.finding_id,
    event.kind,
    event.at ?? "",
    event.signal ?? "",
    event.reason ?? "",
    event.label ?? "",
    event.provenance,
    event.count ?? "",
  ]);
}

/** Append this run's events to a prior ledger, dropping exact duplicates
 * and keeping the latest `MAX_LEDGER_EVENTS` (oldest dropped first — the
 * aggregate reads latest state). */
function mergeLedger(
  priorLedger: readonly OutcomeEvent[],
  events: OutcomeEvent[],
  options: DeriveOutcomeOptions,
): OutcomeEvent[] {
  const seen = new Set<string>();
  const merged: OutcomeEvent[] = [];
  for (const event of [...priorLedger, ...events]) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.length > MAX_LEDGER_EVENTS ? merged.slice(merged.length - MAX_LEDGER_EVENTS) : merged;
}
