/**
 * The #1027 finding-outcome and feedback data contract — schema version
 * `finding-outcomes/v1`. One normalized event shape shared by Action mode
 * (derived statelessly from forge state each run) and operator mode (which
 * may persist the same events through the controller). The schema
 * distinguishes reported / repeated / resolved / dismissed / still-open /
 * unknown findings, 👍/👎 usefulness feedback, and explicit human
 * adjudications — and keeps them SEPARATE: a resolved thread, a thumbs-down,
 * or a vanished comment is never auto-promoted into a verified true/false
 * label; only an `adjudication` event from a trusted operator moves the
 * adjudicated precision denominator.
 *
 * Serialized field names are snake_case by repo convention: this IS an
 * explicit persisted artifact. Events carry digests, counts, and bounded
 * metadata only — never finding message text, never reaction logins, never
 * private review content.
 */
import { redactText } from "../context/redact.js";
import { pyJsonDumps } from "../evidence/pyjson.js";
import { aggregateOutcomeEvents } from "./report.js";
import type { OutcomeAggregate } from "./report.js";
import { outcomeEventInstant } from "./reconcile.js";

export const FINDING_OUTCOMES_SCHEMA = "finding-outcomes/v1";

export type OutcomeEventKind =
  | "reported"
  | "repeated"
  | "resolved"
  | "dismissed"
  | "still_open"
  | "unknown"
  | "feedback"
  | "adjudication";

export type AdjudicationLabel =
  | "confirmed_valid_defect"
  | "confirmed_false_positive"
  | "valid_but_unhelpful"
  | "uncertain";

/** Where an event's provenance comes from. `operator` events (adjudications
 * and operator-persisted corrections) are the only ones that may carry a
 * trusted actor identity; forge-derived events carry counts only. */
export type OutcomeProvenance = "current-review" | "forge-thread" | "forge-reaction" | "prior-ledger" | "operator";

export interface OutcomeEvent {
  /** 64 lowercase hex — the stable finding identity digest. */
  finding_id: string;
  kind: OutcomeEventKind;
  /** ISO-8601 instant of the observation, or null when unprovable. */
  at: string | null;
  /** The exact head the observation is anchored to, or null. */
  head_sha: string | null;
  /** Review route (model/profile metadata), low cardinality, or null. */
  route: string | null;
  /** Analysis engine string (model metadata), low cardinality, or null. */
  model: string | null;
  provenance: OutcomeProvenance;
  /** `dismissed` only: bounded redacted reason category/text. */
  reason?: string | null;
  /** `adjudication` only: the explicit human label. */
  label?: AdjudicationLabel;
  /** `adjudication` only: who adjudicated (trusted operator input). */
  actor?: string | null;
  /** `feedback` only. */
  signal?: "helpful" | "not_helpful";
  /** `feedback` only: how many reactions of `signal` the observation
   * carries. A stateless run's event is the full per-run snapshot; an
   * operator-mode event merged onto a prior ledger is the verified DELTA
   * against the prior cumulative total (the ledger sums to the current
   * total, so one unchanged reaction is never counted per re-review). */
  count?: number;
  /** `feedback` only: how the reacting actors were proven trusted. v1
   * feedback is always forge-derived, so the normalizer only ever emits
   * false; a ledger claiming true fails closed (informational counts only). */
  trusted?: boolean;
}

const EVENT_KINDS: ReadonlySet<OutcomeEventKind> = new Set([
  "reported", "repeated", "resolved", "dismissed", "still_open", "unknown", "feedback", "adjudication",
]);
const ADJUDICATION_LABELS: ReadonlySet<AdjudicationLabel> = new Set([
  "confirmed_valid_defect", "confirmed_false_positive", "valid_but_unhelpful", "uncertain",
]);
const PROVENANCES: ReadonlySet<OutcomeProvenance> = new Set([
  "current-review", "forge-thread", "forge-reaction", "prior-ledger", "operator",
]);
const FEEDBACK_SIGNALS: ReadonlySet<"helpful" | "not_helpful"> = new Set(["helpful", "not_helpful"]);
/** The contract table (docs/architecture/finding-outcomes.md): each kind has
 * exactly ONE permitted provenance — the seam that could observe it. Kind and
 * provenance validated independently would let an untrusted ledger claim an
 * observation it never made (a `resolved` thread "seen" by the current review,
 * forge reaction counts asserting a trusted actor). Pairing is structural. */
const KIND_PROVENANCE: Readonly<Record<OutcomeEventKind, OutcomeProvenance>> = {
  reported: "current-review",
  repeated: "current-review",
  resolved: "forge-thread",
  dismissed: "forge-thread",
  still_open: "forge-thread",
  unknown: "prior-ledger",
  feedback: "forge-reaction",
  adjudication: "operator",
};
const FINDING_ID_RE = /^[0-9a-f]{64}$/;
const HEAD_SHA_RE = /^[0-9a-f]{1,64}$/;

/** THE head-SHA proof rule (#1128), in one place. Every surface that decides
 * whether a head is provable applies this predicate — the reader's envelope
 * check, event normalization, and the producer's export decision — because a
 * producer-side inline copy that drifts from the reader is exactly how the
 * action ends up exporting an artifact its own reader rejects. */
export function isProvenHeadSha(value: unknown): value is string {
  return typeof value === "string" && HEAD_SHA_RE.test(value);
}
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T/;
// #1151: `ISO_TIMESTAMP_RE` is an unanchored prefix and `Date.parse` tolerates
// trailing control characters (NUL is not JS whitespace, so `trim` leaves it),
// so without this guard "…T00:00:00Z\u0000" persists verbatim and two events
// for the SAME instant persist as distinct strings. Reject any control
// character outright — the persisted field must be canonical. A string that
// PARSES despite carrying a control character is not an unprovable instant
// (which normalizes to `at: null`); it is a crafted observation no legitimate
// seam ever emits, so the whole event fails closed, not just the field.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  return Array.from(redactText(text)).slice(0, max).join("");
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // Date.parse alone accepts far too much ("0" parses as 2000-01-01); an
  // event's instant must look like an ISO-8601 timestamp before the parse
  // result is trusted.
  if (text === "" || CONTROL_CHARS_RE.test(text) || !ISO_TIMESTAMP_RE.test(text) || Number.isNaN(Date.parse(text))) return null;
  return text;
}

/** Normalize one untrusted candidate event, or null when it cannot be
 * proven to be a well-formed event of its claimed kind. Kind-specific
 * fields are dropped for every other kind, so a forged event cannot smuggle
 * an adjudication label into a `feedback` record, and the claimed provenance
 * must be the ONE seam that could produce that kind (`KIND_PROVENANCE`), so
 * an untrusted ledger cannot re-label where an observation came from. */
export function normalizeOutcomeEvent(raw: unknown): OutcomeEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.finding_id !== "string" || !FINDING_ID_RE.test(rec.finding_id)) return null;
  if (typeof rec.kind !== "string" || !EVENT_KINDS.has(rec.kind as OutcomeEventKind)) return null;
  const kind = rec.kind as OutcomeEventKind;
  if (typeof rec.provenance !== "string" || !PROVENANCES.has(rec.provenance as OutcomeProvenance)) return null;
  if (KIND_PROVENANCE[kind] !== rec.provenance) return null;
  // #1151 acceptance: a control character riding an otherwise well-formed,
  // Date.parse-ACCEPTED timestamp is a crafted value no legitimate seam
  // emits, so the EVENT fails closed — nulling the field would keep the
  // hostile observation in the ledger. This is distinct from an ordinary
  // unparseable `at` (no control characters), which is an unprovable instant
  // and normalizes to null while the event survives. Tested on the TRIMMED
  // value so real JS whitespace padding (itself C0) stays canonical.
  if (typeof rec.at === "string" && CONTROL_CHARS_RE.test(rec.at.trim())) return null;
  const headSha = isProvenHeadSha(rec.head_sha) ? rec.head_sha : null;
  const event: OutcomeEvent = {
    finding_id: rec.finding_id,
    kind,
    at: isoTimestamp(rec.at),
    head_sha: headSha,
    route: boundedText(rec.route, 200),
    model: boundedText(rec.model, 200),
    provenance: rec.provenance as OutcomeProvenance,
  };
  if (kind === "dismissed") {
    // A dismissal without a reason is exactly the silent promotion the
    // contract forbids (head-unchanged resolution read as a code fix), so
    // the bounded reason is REQUIRED, not optional decoration.
    const reason = boundedText(rec.reason, 200);
    if (reason === null) return null;
    event.reason = reason;
  }
  if (kind === "adjudication") {
    // #1027: adjudications are the one trusted surface — the pairing check
    // above already forces `operator` provenance; the record must also carry
    // WHO recorded it. An otherwise unproven claim of an adjudication label
    // fails closed here so it can never reach the precision denominator.
    if (typeof rec.label !== "string" || !ADJUDICATION_LABELS.has(rec.label as AdjudicationLabel)) return null;
    const actor = boundedText(rec.actor, 200);
    if (actor === null) return null;
    event.label = rec.label as AdjudicationLabel;
    event.actor = actor;
  }
  if (kind === "feedback") {
    if (typeof rec.signal !== "string" || !FEEDBACK_SIGNALS.has(rec.signal as "helpful" | "not_helpful")) return null;
    event.signal = rec.signal as "helpful" | "not_helpful";
    if (typeof rec.count === "number" && Number.isSafeInteger(rec.count) && rec.count >= 0) {
      event.count = rec.count;
    }
    // The pairing check forces `forge-reaction` provenance, and forge-derived
    // feedback is ALWAYS untrusted — a ledger claiming `trusted: true` asserts
    // an actor proof this contract can never derive, so it fails closed.
    if (rec.trusted === true) return null;
    event.trusted = false;
  }
  return event;
}

/** Hard cap on events in one ledger: past it, the OLDEST events are dropped
 * (the latest state is what aggregates read), so an unbounded history can
 * never bloat the artifact. */
export const MAX_LEDGER_EVENTS = 1000;

export interface OutcomeLedger {
  schema: string;
  generated_at: string;
  head_sha: string;
  route: string | null;
  model: string | null;
  events: OutcomeEvent[];
  aggregate: OutcomeAggregate;
}

/** Compact deterministic serialization for the run artifact (the same
 * Python-faithful JSON other artifacts use). */
export function serializeOutcomeLedger(ledger: OutcomeLedger): string {
  return pyJsonDumps(ledger);
}

/** Fail-closed parse of a prior ledger (operator-mode persistence): any
 * malformed shape, wrong schema string, or unusable event makes the whole
 * ledger null — callers then run without prior history rather than acting on
 * unprovable state.
 *
 * The `aggregate` field is DERIVED, never trusted: the serialized counts in an
 * untrusted ledger string are recomputed from the already-validated events, so
 * a tampered or stale aggregate can never reach a reader. */
export function parseOutcomeLedger(raw: string): OutcomeLedger | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== FINDING_OUTCOMES_SCHEMA) return null;
  const generatedAt = isoTimestamp(rec.generated_at);
  if (generatedAt === null) return null;
  if (!isProvenHeadSha(rec.head_sha)) return null;
  if (!Array.isArray(rec.events)) return null;
  const events: OutcomeEvent[] = [];
  for (const candidate of rec.events) {
    // Fail closed: one unprovable event poisons the whole ledger, so a
    // caller never acts on a partially-reconstructed history.
    const event = normalizeOutcomeEvent(candidate);
    if (event === null) return null;
    events.push(event);
  }
  // Cap applies event RECENCY, not array position — same chronology rule
  // `mergeLedger` applies to the merged ledger: a delayed older run merged
  // after a newer one must not let the newest status event be evicted while
  // an older delayed event is retained. Order by parsed instant with the
  // original array order as the explicit tie-breaker, then keep the latest
  // MAX_LEDGER_EVENTS.
  const capped = events.length > MAX_LEDGER_EVENTS
    ? events
        .map((event, index) => ({ event, index, at: outcomeEventInstant(event.at) }))
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index))
        .slice(-MAX_LEDGER_EVENTS)
        .map((entry) => entry.event)
    : events;
  return {
    schema: FINDING_OUTCOMES_SCHEMA,
    generated_at: generatedAt,
    head_sha: rec.head_sha,
    route: boundedText(rec.route, 200),
    model: boundedText(rec.model, 200),
    events: capped,
    // Recomputed over exactly the events a reader sees, so the aggregate can
    // never disagree with them.
    aggregate: aggregateOutcomeEvents(capped),
  };
}
