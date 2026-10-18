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
import type { OutcomeAggregate } from "./report.js";

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
  /** `feedback` only: how many reactions of `signal` were observed. */
  count?: number;
  /** `feedback` only: true only when the caller proved the reacting actors
   * trusted. Forge-derived v1 feedback is always false (informational). */
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
const FINDING_ID_RE = /^[0-9a-f]{64}$/;
const HEAD_SHA_RE = /^[0-9a-f]{1,64}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T/;

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
  if (text === "" || !ISO_TIMESTAMP_RE.test(text) || Number.isNaN(Date.parse(text))) return null;
  return text;
}

/** Normalize one untrusted candidate event, or null when it cannot be
 * proven to be a well-formed event of its claimed kind. Kind-specific
 * fields are dropped for every other kind, so a forged event cannot smuggle
 * an adjudication label into a `feedback` record. */
export function normalizeOutcomeEvent(raw: unknown): OutcomeEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.finding_id !== "string" || !FINDING_ID_RE.test(rec.finding_id)) return null;
  if (typeof rec.kind !== "string" || !EVENT_KINDS.has(rec.kind as OutcomeEventKind)) return null;
  const kind = rec.kind as OutcomeEventKind;
  if (typeof rec.provenance !== "string" || !PROVENANCES.has(rec.provenance as OutcomeProvenance)) return null;
  const headSha = typeof rec.head_sha === "string" && HEAD_SHA_RE.test(rec.head_sha) ? rec.head_sha : null;
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
    const reason = boundedText(rec.reason, 200);
    if (reason !== null) event.reason = reason;
  }
  if (kind === "adjudication") {
    // #1027: adjudications are the one trusted surface — they may only come
    // from operator input carrying WHO recorded it. A forge-derived or
    // otherwise unproven record claiming an adjudication label is not an
    // adjudication; it fails closed here so it can never reach the
    // precision denominator.
    if (rec.provenance !== "operator") return null;
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
    event.trusted = rec.trusted === true;
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
 * unprovable state. */
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
  if (typeof rec.head_sha !== "string" || !HEAD_SHA_RE.test(rec.head_sha)) return null;
  if (!Array.isArray(rec.events)) return null;
  const events: OutcomeEvent[] = [];
  for (const candidate of rec.events) {
    // Fail closed: one unprovable event poisons the whole ledger, so a
    // caller never acts on a partially-reconstructed history.
    const event = normalizeOutcomeEvent(candidate);
    if (event === null) return null;
    events.push(event);
  }
  const aggregate = parseAggregate(rec.aggregate);
  if (aggregate === null) return null;
  return {
    schema: FINDING_OUTCOMES_SCHEMA,
    generated_at: generatedAt,
    head_sha: rec.head_sha,
    route: boundedText(rec.route, 200),
    model: boundedText(rec.model, 200),
    events: events.length > MAX_LEDGER_EVENTS ? events.slice(events.length - MAX_LEDGER_EVENTS) : events,
    aggregate,
  };
}

function parseAggregate(raw: unknown): OutcomeAggregate | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const adjudicated = rec.adjudicated !== null && typeof rec.adjudicated === "object" && !Array.isArray(rec.adjudicated)
    ? rec.adjudicated as Record<string, unknown>
    : {};
  const precision = typeof adjudicated.precision === "number" && Number.isFinite(adjudicated.precision)
    ? adjudicated.precision
    : null;
  return {
    unique_findings: count(rec.unique_findings),
    open: count(rec.open),
    resolved: count(rec.resolved),
    dismissed: count(rec.dismissed),
    unknown: count(rec.unknown),
    reactions: {
      helpful: count((rec.reactions as Record<string, unknown> | undefined)?.helpful),
      not_helpful: count((rec.reactions as Record<string, unknown> | undefined)?.not_helpful),
    },
    adjudicated: {
      confirmed_valid_defect: count(adjudicated.confirmed_valid_defect),
      confirmed_false_positive: count(adjudicated.confirmed_false_positive),
      valid_but_unhelpful: count(adjudicated.valid_but_unhelpful),
      uncertain: count(adjudicated.uncertain),
      precision,
    },
  };
}
