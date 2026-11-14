/**
 * The machine-readable review bundle (#1425).
 *
 * The published Markdown comment is the human presentation surface; this is
 * the automation surface: one bounded, versioned JSON document per action
 * run that a coding agent can consume without scraping rendered comments.
 *
 * Contract discipline follows the #1027 `finding-outcomes/v1` ledger:
 * a strict schema string that fails closed on parse, snake_case persisted
 * fields, bounded-and-redacted construction (every text field passes
 * `redactText` and a codepoint cap BEFORE serialization, so no secret and no
 * unbounded model text can reach the output even if a caller forgets), and
 * deterministic serialization (fixed key order, no `undefined` members).
 *
 * Security properties, by construction rather than by validation:
 * - The output is a single-line JSON document produced by `JSON.stringify`,
 *   so finding text — however hostile (quotes, braces, newlines, fake
 *   headings, delimiter tokens) — is confined to its own string value and
 *   can never forge structure.
 * - The aggregate byte bound is enforced on the exact serialized string:
 *   findings are admitted only while the document still fits
 *   `REVIEW_BUNDLE_MAX_BYTES`, and an omission is disclosed by
 *   `findings_total`/`findings_truncated` rather than passed off as the
 *   whole set.
 * - `findings` is PRESENT (possibly empty) only when a review actually
 *   produced a verdict (`complete`/`partial`/`superseded`); a `skipped` or
 *   `failed` bundle carries no `findings` key at all, so "no findings" and
 *   "no review" are distinguishable by field presence alone.
 */
import { redactText } from "../context/redact.js";
import { pyCodepointSlice } from "../platform/py.js";
import { FORGE_COMMENT_MAX_BYTES } from "../platform/comment-ceiling.js";
import { findingIdentityFromRecord } from "../outcomes/identity.js";
import { boundedIdListWithTotal, sourceIdCount } from "../context/id-lists.js";
import {
  boundedObligationRows,
  countersAgreeWithList,
  DERIVED_OBLIGATION_STATES,
  parseObligationRow,
  publishedDerivedObligationState,
  type PublishedDerivedObligationState,
  type ReviewObligationRow,
} from "./handoff.js";
import type { ReviewObligation } from "../enforcement/review-obligations.js";
import { parseReviewAttestation, type ReviewAttestation } from "./attestation.js";

/** The schema identifier. A consumer must refuse a document whose `schema`
 * is not byte-identical to this string (the ledger pattern, #1027). */
export const REVIEW_BUNDLE_SCHEMA = "review-bundle/v1";

/** The closed lifecycle vocabulary. Every run that reaches an output
 * boundary lands in exactly one of these:
 * - `complete`: a review finished with full coverage.
 * - `partial`: a review finished but its execution or requirement-trace
 *   coverage was incomplete (or its publication carried partial coverage).
 * - `skipped`: no review ran (precheck skip, plain-issue no-op, follow-up
 *   consumption). A carried verdict may still appear in `disposition`.
 * - `failed`: the run crashed and produced no verdict.
 * - `superseded`: the review completed but publication was withheld at the
 *   publication boundary because a newer push landed; the bundle documents
 *   the EXACT head that was reviewed, which is what a consumer compares
 *   against the current PR head to prove staleness. */
export const REVIEW_BUNDLE_STATES = ["complete", "partial", "skipped", "failed", "superseded"] as const;
export type ReviewBundleState = (typeof REVIEW_BUNDLE_STATES)[number];

export function isReviewBundleState(value: unknown): value is ReviewBundleState {
  return typeof value === "string" && (REVIEW_BUNDLE_STATES as readonly string[]).includes(value);
}

/** Hard ceiling on the whole serialized document (UTF-8 bytes). The bundle
 * rides a step output and a run-directory file; nothing in it is worth more
 * than this, and a consumer can rely on the cap without trusting the
 * producer.
 *
 * The bound is derived from the single shared forge comment-ceiling
 * declaration (`FORGE_COMMENT_MAX_BYTES` in
 * `src/platform/comment-ceiling.ts`, #1569) rather than redeclared here:
 * the bundle rides inside the published comment body, so its ceiling must
 * stay exactly the comment ceiling (#1558). */
export const REVIEW_BUNDLE_MAX_BYTES = FORGE_COMMENT_MAX_BYTES;

/** Findings admitted before the `findings_truncated` disclosure fires. */
export const REVIEW_BUNDLE_MAX_FINDINGS = 100;

/** The blocking obligation rows may claim at most this many bytes of the
 * bundle's budget. The rows are merge-gating disclosure, but they must never
 * starve the findings list: the findings are the review's own content, and
 * they have no other machine surface. Half the budget leaves the other half
 * for the findings in every case. */
export const REVIEW_BUNDLE_MAX_OBLIGATION_BYTES = 32_768;

/** Per-field codepoint caps applied AFTER redaction. */
export const REVIEW_BUNDLE_MAX_MESSAGE_CHARS = 1_000;
export const REVIEW_BUNDLE_MAX_SUGGESTION_CHARS = 500;
export const REVIEW_BUNDLE_MAX_AGENT_PROMPT_CHARS = 1_000;
export const REVIEW_BUNDLE_MAX_FILE_CHARS = 300;
export const REVIEW_BUNDLE_MAX_CATEGORY_CHARS = 64;
export const REVIEW_BUNDLE_MAX_TOKEN_CHARS = 200;
export const REVIEW_BUNDLE_MAX_FAILURE_REASON_CHARS = 200;

const BUNDLE_SEVERITIES = ["blocker", "major", "minor", "info"] as const;

/** Every text field of the bundle goes through this: redaction first (a
 * secret must not survive into a machine artifact), then the caller's cap.
 * Idempotent with the publish/outputs boundary (`redactText` is idempotent). */
function redactBounded(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return pyCodepointSlice(redactText(text), max);
}

export interface ReviewBundleFinding {
  /** Stable cross-run identity (the #1027 finding identity digest) when the
   * record can prove one; null when it cannot (unanchorable path, empty
   * message). Never a positional index — those drift between reruns. */
  id: string | null;
  severity: string;
  category: string;
  /** Closed to `open` today: every finding listed here was still open when
   * the review completed. Cross-run resolution state lives in the
   * finding-outcomes ledger, not in this snapshot. */
  status: "open";
  file: string | null;
  line: number | null;
  end_line?: number;
  message: string;
  suggestion?: string;
  agent_prompt?: string;
}

export interface ReviewBundleInput {
  /** Lifecycle state chosen by the host (the only component that knows the
   * publication outcome). */
  state: ReviewBundleState;
  /** Random per-run identifier, pairs with `head_sha` to name THIS bundle's
   * review of THIS head across reruns. */
  reviewId: string;
  /** ISO-8601 UTC timestamp; injectable so serialization is deterministic
   * under test. */
  generatedAt: string;
  repository: string;
  /** PR number as a number, or null when the run could not prove one. */
  prNumber: number | null;
  /** Exact head SHA this run reviewed (or tried to). "" when unknown. */
  headSha: string;
  /** Base SHA when known. "" when unknown. */
  baseSha: string;
  /** Configuration/model identity of the run. */
  identity: {
    diffFingerprint: string;
    analysisEngine: string;
    actionVersion: string;
  };
  /** Authoritative disposition. Included for review-producing states and
   * for a skipped run's CARRIED verdict (fields then describe the carried
   * decision, and `verdict_source` names its origin, e.g. `carry_forward`);
   * omitted for `failed`. */
  disposition?: {
    verdict: string;
    verdictSource: string;
    requiredChecks: string;
    reviewResult: string;
    incompleteReason: string;
    degraded: boolean;
    /** #1656: the authoritative final disposition's kind and machine
     * reason, additive so the bundle states WHAT the run concluded in the
     * one vocabulary every consumer shares. Absent on a caller without
     * the disposition (legacy). */
    dispositionKind?: string;
    dispositionReason?: string;
  };
  /** Publication outcome for this run, only when publication was attempted
   * (mirrors the `publish-status` output). */
  publication?: { status: "published" | "superseded" | "failed" };
  /** Fixed skip constant, `skipped` state only. */
  skipReason?: string;
  /** Bounded, redacted failure shape, `failed` state only. Never a stack
   * trace, a request body, or credential material. */
  failureReason?: string;
  /** Normalized findings (the review artifact's finding records); consulted
   * only for the review-producing states. */
  findings: unknown;
  /** #1518: the requirement ids the deterministic enforcement pass could not
   * discharge (unmet or unverifiable). Serialized only for the
   * review-producing states, on the same presence rule as `findings`. */
  unresolvedRequirementIds?: readonly string[];
  /** #1518: the required-check ids the deterministic enforcement pass could
   * not resolve. Serialized only for the review-producing states. */
  unresolvedRequiredChecks?: readonly string[];
  /** #1521: the review-obligation rows that BLOCKED the review. The same
   * shared projection (and the same caps) as the published handoff, so the
   * two documents never disagree about the rows. Serialized only for the
   * review-producing states. */
  unresolvedReviewObligations?: readonly ReviewObligation[];
  /** #1521: the run's derived-obligation state ("complete" | "unresolved" |
   * "unavailable"); anything else is published as null (unknown). */
  derivedObligationState?: string;
  /** #1541: the number of DISTINCT requirement ids the enforcement pass
   * produced BEFORE the shared 20-entry id cap shortened the list. The
   * producers carry it here; without it the bundle discloses nothing about
   * that bound, and an absent count is unknown — never zero. */
  unresolvedRequirementIdsSourceTotal?: number;
  /** #1541: the same honest count for the required-check ids. */
  unresolvedRequiredChecksSourceTotal?: number;
  /** #1576: the machine-verifiable final review attestation (closed
   * conclusion vocabulary + reason code + exact head). Present on EVERY
   * state the host reaches — `skipped`, `failed` and `superseded` included —
   * because the whole point is that a green-looking lifecycle state cannot
   * hide the conclusion. The host supplies it from the same signals the
   * bundle already carries, so the two documents can never disagree. */
  attestation?: ReviewAttestation;
}

interface BundleFindingCandidate {
  record: Record<string, unknown>;
}

function normalizeFinding(value: unknown): BundleFindingCandidate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { record: value as Record<string, unknown> };
}

/** Project one artifact finding into the bundle's normalized record:
 * bounded, redacted, closed-vocabulary severity (anything the normalizer
 * could not have produced is honestly reported as `info`), and the stable
 * #1027 identity digest where one is provable. */
function bundleFinding(record: Record<string, unknown>): ReviewBundleFinding {
  const rawSeverity = typeof record.severity === "string" ? record.severity : "info";
  const severity = (BUNDLE_SEVERITIES as readonly string[]).includes(rawSeverity) ? rawSeverity : "info";
  const file = typeof record.file === "string" && record.file !== ""
    ? redactBounded(record.file, REVIEW_BUNDLE_MAX_FILE_CHARS)
    : null;
  const line = typeof record.line === "number" && Number.isFinite(record.line) ? Math.trunc(record.line) : null;
  const finding: ReviewBundleFinding = {
    id: findingIdentityFromRecord(record),
    severity,
    category: redactBounded(record.category ?? "", REVIEW_BUNDLE_MAX_CATEGORY_CHARS),
    status: "open",
    file,
    line,
    message: redactBounded(record.message ?? "", REVIEW_BUNDLE_MAX_MESSAGE_CHARS),
  };
  if (typeof record.end_line === "number" && Number.isFinite(record.end_line)) {
    finding.end_line = Math.trunc(record.end_line);
  }
  if (typeof record.suggestion === "string" && record.suggestion !== "") {
    finding.suggestion = redactBounded(record.suggestion, REVIEW_BUNDLE_MAX_SUGGESTION_CHARS);
  }
  if (typeof record.agent_prompt === "string" && record.agent_prompt !== "") {
    finding.agent_prompt = redactBounded(record.agent_prompt, REVIEW_BUNDLE_MAX_AGENT_PROMPT_CHARS);
  }
  return finding;
}

function parseFindingsArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Build the deterministic `review-bundle/v1` document (single-line JSON).
 * The envelope fields are serialized first and the findings array is then
 * admitted one record at a time only while the WHOLE document still fits
 * `REVIEW_BUNDLE_MAX_BYTES` — the worst-case disclosure (both findings
 * counters at their largest reachable values) is reserved up front, so the
 * byte bound holds for the exact string returned. */
export function buildReviewBundle(input: ReviewBundleInput): string {
  const envelope: Record<string, unknown> = {
    schema: REVIEW_BUNDLE_SCHEMA,
    review_id: redactBounded(input.reviewId, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    generated_at: redactBounded(input.generatedAt, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    action_version: redactBounded(input.identity.actionVersion, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    repository: redactBounded(input.repository, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    pr_number: input.prNumber,
    head_sha: redactBounded(input.headSha, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    base_sha: redactBounded(input.baseSha, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    state: input.state,
    identity: {
      diff_fingerprint: redactBounded(input.identity.diffFingerprint, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      analysis_engine: redactBounded(input.identity.analysisEngine, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    },
  };
  if (input.disposition !== undefined) {
    envelope.disposition = {
      verdict: redactBounded(input.disposition.verdict, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      verdict_source: redactBounded(input.disposition.verdictSource, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      required_checks: redactBounded(input.disposition.requiredChecks, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      review_result: redactBounded(input.disposition.reviewResult, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      incomplete_reason: redactBounded(input.disposition.incompleteReason, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      degraded: input.disposition.degraded === true,
      ...(input.disposition.dispositionKind !== undefined
        ? { disposition_kind: redactBounded(input.disposition.dispositionKind, REVIEW_BUNDLE_MAX_TOKEN_CHARS) }
        : {}),
      ...(input.disposition.dispositionReason !== undefined
        ? { disposition_reason: redactBounded(input.disposition.dispositionReason, REVIEW_BUNDLE_MAX_TOKEN_CHARS) }
        : {}),
    };
  }
  if (input.publication !== undefined) {
    envelope.publication = { status: input.publication.status };
  }
  if (input.state === "skipped" && input.skipReason !== undefined && input.skipReason !== "") {
    envelope.skip_reason = redactBounded(input.skipReason, REVIEW_BUNDLE_MAX_TOKEN_CHARS);
  }
  if (input.state === "failed") {
    envelope.failure_reason = redactBounded(input.failureReason ?? "unknown error", REVIEW_BUNDLE_MAX_FAILURE_REASON_CHARS);
  }
  // #1576: the attestation rides its own key on every state. Its fields are
  // closed-vocabulary tokens and an action-owned head SHA (never model
  // text), so no redaction surface is needed. The builder projects the
  // shape; the parser re-validates it against the closed vocabularies and
  // refuses the whole document on any mismatch, so a foreign object can
  // never survive a round trip on this trust key.
  if (input.attestation !== undefined) {
    envelope.attestation = {
      conclusion: input.attestation.conclusion,
      reason_code: input.attestation.reason_code,
      head_sha: input.attestation.head_sha,
    };
  }

  const reviewsProduced = input.state === "complete" || input.state === "partial" || input.state === "superseded";
  const candidates = reviewsProduced
    ? parseFindingsArray(input.findings).flatMap((item) => {
      const candidate = normalizeFinding(item);
      return candidate === null ? [] : [candidate];
    })
    : [];
  // Every review-producing document ends with the disclosure segment
  // `,"findings":[…],"findings_total":N,"findings_truncated":b`. Measure it
  // (empty-array shape, true truncation flag) into the base up front, then
  // charge one comma per included finding, so the byte bound holds for the
  // exact string returned no matter how the counters land.
  const disclosure = JSON.stringify({ findings: [], findings_total: candidates.length, findings_truncated: true }).slice(1, -1);
  // #1518: the two id arrays ride the envelope's tail. They are bounded
  // already, so their EXACT serialized byte length is reserved up front —
  // never a synthetic ASCII worst case. The id cap counts CODEPOINTS, so a
  // four-byte codepoint id is four bytes long: a synthetic worst case
  // under-counts it, and the document could then exceed the 64 KiB cap.
  const incomingRequirements = boundedIdListWithTotal(input.unresolvedRequirementIds);
  const incomingChecks = boundedIdListWithTotal(input.unresolvedRequiredChecks);
  const requirementIds = reviewsProduced ? incomingRequirements.ids : [];
  const checkIds = reviewsProduced ? incomingChecks.ids : [];
  // #1541: the honest count the enforcement pass produced BEFORE the shared
  // 20-entry id cap shortened the lists. The lists arrive already bounded by
  // their producers, so the bundle cannot see that bound from the list
  // alone; the producers carry the count and the bundle publishes it. An
  // absent count is UNKNOWN, never a count of zero.
  const requirementSourceTotal = reviewsProduced
    ? sourceIdCount(input.unresolvedRequirementIdsSourceTotal, incomingRequirements)
    : null;
  const checkSourceTotal = reviewsProduced
    ? sourceIdCount(input.unresolvedRequiredChecksSourceTotal, incomingChecks)
    : null;
  const idSegmentBytes = reviewsProduced
    ? Buffer.byteLength(
      `,"unresolved_requirement_ids":${JSON.stringify(requirementIds)}`
      + (requirementSourceTotal !== null ? `,"unresolved_requirement_ids_source_total":${requirementSourceTotal}` : "")
      + `,"unresolved_required_checks":${JSON.stringify(checkIds)}`
      + (checkSourceTotal !== null ? `,"unresolved_required_checks_source_total":${checkSourceTotal}` : ""),
      "utf8",
    )
    : 0;
  // #1521 (review): the blocking obligation rows and the derived-obligation
  // state ride the envelope's tail, on the same presence rule as the id
  // lists. The row projection is the SHARED one (`boundedObligationRows` in
  // `src/publish/handoff.ts`), so both documents project the SAME rows in
  // the SAME order with the SAME honest total — the handoff's list is always
  // a prefix of the bundle's. But the bundle is the CONTROLLER's complete
  // machine-readable set: it does NOT apply the handoff's 10-row listing
  // bound. Its own bound is the 64 KiB byte budget: rows are admitted one at
  // a time (charged exactly, like the findings), ahead of the findings
  // because they name WHAT blocked the review. A byte-shed row is disclosed
  // by the same total/truncated pair, so a shortened list is never passed
  // off as the whole set.
  const projectedObligations = reviewsProduced
    ? boundedObligationRows(input.unresolvedReviewObligations, Number.POSITIVE_INFINITY)
    : { rows: [], total: 0 };
  const derivedState = reviewsProduced ? publishedDerivedObligationState(input.derivedObligationState) : null;
  // Reserve the segment with the EMPTY row list (the truncation flag reserved
  // as `false`, one byte longer than `true`, so the reservation never
  // under-counts), then charge one row plus one comma per admitted row — the
  // exact serialized string can only land at or below the reservation.
  const obligationSegmentBytes = reviewsProduced
    ? Buffer.byteLength(
      `,"unresolved_review_obligations":[]`
      + `,"unresolved_review_obligations_total":${projectedObligations.total}`
      + `,"unresolved_review_obligations_truncated":false`
      + `,"derived_obligation_state":${JSON.stringify(derivedState)}`,
      "utf8",
    )
    : 0;
  let bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8")
    + (reviewsProduced ? Buffer.byteLength(disclosure, "utf8") + 1 : 0)
    + idSegmentBytes
    + obligationSegmentBytes;
  const includedObligations: ReviewObligationRow[] = [];
  let obligationBytes = 0;
  for (const row of projectedObligations.rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + rowBytes > REVIEW_BUNDLE_MAX_BYTES) break;
    // #1521: the rows may claim only their own share of the budget, so a
    // large row set never starves the findings list. The findings are the
    // review's own content, and no other machine surface carries them.
    if (obligationBytes + rowBytes > REVIEW_BUNDLE_MAX_OBLIGATION_BYTES) break;
    bytes += rowBytes;
    obligationBytes += rowBytes;
    includedObligations.push(row);
  }
  const included: ReviewBundleFinding[] = [];
  for (const candidate of candidates.slice(0, REVIEW_BUNDLE_MAX_FINDINGS)) {
    const finding = bundleFinding(candidate.record);
    const findingBytes = Buffer.byteLength(JSON.stringify(finding), "utf8") + 1;
    if (bytes + findingBytes > REVIEW_BUNDLE_MAX_BYTES) break;
    bytes += findingBytes;
    included.push(finding);
  }
  if (reviewsProduced) {
    envelope.findings = included;
    envelope.findings_total = candidates.length;
    envelope.findings_truncated = included.length < candidates.length;
    // #1518: the merge-gating ids of the deterministic enforcement pass,
    // last in the envelope so the pinned key order above stays stable.
    envelope.unresolved_requirement_ids = requirementIds;
    // #1541: the count the enforcement pass produced before the shared id
    // cap shortened that list. Absent when the producer carried none — an
    // absent count is unknown, never a count of zero.
    if (requirementSourceTotal !== null) envelope.unresolved_requirement_ids_source_total = requirementSourceTotal;
    envelope.unresolved_required_checks = checkIds;
    if (checkSourceTotal !== null) envelope.unresolved_required_checks_source_total = checkSourceTotal;
    // #1521: the blocking obligation rows and the derived-obligation state,
    // after the id lists — the controller's document names EVERY blocking
    // row the byte budget can carry, and the published handoff's list stays
    // a disclosed prefix of it.
    envelope.unresolved_review_obligations = includedObligations;
    envelope.unresolved_review_obligations_total = projectedObligations.total;
    envelope.unresolved_review_obligations_truncated = includedObligations.length < projectedObligations.total;
    envelope.derived_obligation_state = derivedState;
  }
  return JSON.stringify(envelope);
}

export interface ReviewBundle {
  schema: typeof REVIEW_BUNDLE_SCHEMA;
  review_id: string;
  generated_at: string;
  action_version: string;
  repository: string;
  pr_number: number | null;
  head_sha: string;
  base_sha: string;
  state: ReviewBundleState;
  identity: { diff_fingerprint: string; analysis_engine: string };
  disposition?: Record<string, unknown>;
  publication?: { status: string };
  skip_reason?: string;
  failure_reason?: string;
  findings?: unknown[];
  findings_total?: number;
  findings_truncated?: boolean;
  /** #1518: the requirement ids the deterministic enforcement pass could not
   * discharge. Present only on a review-producing state. */
  unresolved_requirement_ids?: string[];
  /** #1518: the required-check ids the deterministic enforcement pass could
   * not resolve. Present only on a review-producing state. */
  unresolved_required_checks?: string[];
  /** #1521: the review-obligation rows that blocked the review. Present
   * only on a review-producing state, with the same shape and caps as the
   * published handoff's rows. */
  unresolved_review_obligations?: ReviewObligationRow[];
  /** #1521: the count of the blocking rows, before the listing bound.
   * Present only on a review-producing state. */
  unresolved_review_obligations_total?: number;
  /** #1521: whether the row listing was shortened. Present only on a
   * review-producing state. */
  unresolved_review_obligations_truncated?: boolean;
  /** #1521: the run's derived-obligation state, null when unknown. Present
   * only on a review-producing state. */
  derived_obligation_state?: PublishedDerivedObligationState | null;
  /** #1576: the machine-verifiable final review attestation. Optional on
   * parse (a bundle written before #1576 carries none and stays parseable);
   * when present it is validated fail-closed, and a malformed attestation
   * refuses the whole document — a consumer must never fall back to reading
   * the lifecycle `state` as an approval signal. */
  attestation?: ReviewAttestation;
  /** #1541: the number of DISTINCT merge-gating requirement ids the
   * deterministic enforcement pass produced, BEFORE the shared 20-entry id
   * cap shortened the list. A count larger than the listed length means the
   * shared cap dropped ids. `null` when the document discloses no count: an
   * unknown count is never read as zero and never read as "the list is the
   * whole set". */
  unresolved_requirement_ids_source_total?: number | null;
  /** #1541: the same honest count for the required-check ids. */
  unresolved_required_checks_source_total?: number | null;
}

/** Fail-closed parse of a bundle document: exact schema string, closed
 * state vocabulary, and required field types, or null. A consumer of the
 * `review-bundle` output must treat anything this refuses as absent.
 *
 * #1542: the findings counters are cross-checked against the findings list
 * they carry. A document that lists more findings than it counts, that
 * claims no truncation while its total disagrees with the list, or that
 * claims a truncation while its total matches the list, contradicts itself
 * and is refused. The published handoff refuses the same contradictions for
 * its id lists (#1538) and the first two for its item counters. */
export function parseReviewBundle(text: string): ReviewBundle | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== REVIEW_BUNDLE_SCHEMA) return null;
  if (!isReviewBundleState(record.state)) return null;
  if (typeof record.review_id !== "string" || record.review_id === "") return null;
  if (typeof record.generated_at !== "string") return null;
  if (typeof record.repository !== "string") return null;
  if (!(record.pr_number === null || (typeof record.pr_number === "number" && Number.isInteger(record.pr_number)))) return null;
  if (typeof record.head_sha !== "string" || typeof record.base_sha !== "string") return null;
  const identity = record.identity;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) return null;
  const identityRecord = identity as Record<string, unknown>;
  if (typeof identityRecord.diff_fingerprint !== "string" || typeof identityRecord.analysis_engine !== "string") return null;
  if (record.publication !== undefined) {
    const publication = record.publication;
    if (publication === null || typeof publication !== "object" || Array.isArray(publication)) return null;
    const status = (publication as Record<string, unknown>).status;
    if (status !== "published" && status !== "superseded" && status !== "failed") return null;
  }
  // State-specific key rules, enforced on parse as strictly as on build:
  // the presence/absence of `findings` is the "no review vs no findings"
  // contract, so a foreign document may not smuggle a findings set (or a
  // skip/failure reason) onto a state that contradicts it.
  const reviewProducing = record.state === "complete" || record.state === "partial" || record.state === "superseded";
  if (record.findings !== undefined) {
    if (!reviewProducing) return null;
    if (!Array.isArray(record.findings)) return null;
    // #1542: the two counters are a count and a flag, so both must be
    // there and the count must be a whole number.
    if (typeof record.findings_total !== "number" || !Number.isInteger(record.findings_total)) return null;
    if (typeof record.findings_truncated !== "boolean") return null;
    const findings = record.findings;
    const total = record.findings_total;
    const truncated = record.findings_truncated;
    // #1542: the counters must agree with the list they describe. A
    // document that lists more findings than it counts, that claims no
    // truncation while its total disagrees with the list it carries, or
    // that claims a truncation while its total matches the list exactly,
    // contradicts itself and is refused. The published handoff refuses the
    // same contradictions for its id lists (#1538) and the first two for
    // its item counters. #1521: the ONE shared rule
    // (`countersAgreeWithList`) reads all of them.
    if (!countersAgreeWithList(findings.length, total, truncated)) return null;
  } else if (record.findings_total !== undefined || record.findings_truncated !== undefined) {
    // #1542: a counter with no list to check against is a claim the
    // document cannot back. A skipped or failed run proves no review, and
    // a review-producing state with no `findings` key proves no findings
    // list. The counters and the list are one unit.
    return null;
  }
  // #1518: the merge-gating id lists follow the same presence rule as the
  // findings set — a state that proves no review may not claim unresolved
  // requirements or checks.
  for (const key of ["unresolved_requirement_ids", "unresolved_required_checks"]) {
    const value = record[key];
    if (value === undefined) continue;
    if (!reviewProducing) return null;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  }
  // #1521: the blocking obligation rows, their counters and the
  // derived-obligation state follow the SAME presence rule as the id lists
  // (a state that proves no review may not claim what blocked a review it
  // never produced). When present they are shape-checked fail-closed, and
  // the counters are cross-checked against the list they carry.
  const obligationRows: ReviewObligationRow[] = [];
  if (record.unresolved_review_obligations !== undefined) {
    if (!reviewProducing) return null;
    if (!Array.isArray(record.unresolved_review_obligations)) return null;
    for (const raw of record.unresolved_review_obligations) {
      const row = parseObligationRow(raw);
      if (row === null) return null;
      obligationRows.push(row);
    }
  }
  // The counters are OPTIONAL on parse (a bundle written before #1521
  // carries none of them, and it stays parseable), but a counter that IS
  // present is cross-checked against the list it carries. An absent counter
  // defaults to the list's own length (the total) or to `false` (the
  // truncation flag) — the same defaults the published handoff's parser
  // uses, so the two documents read one contract.
  if (record.unresolved_review_obligations_total !== undefined && !reviewProducing) return null;
  const obligationTotal = record.unresolved_review_obligations_total === undefined
    ? obligationRows.length
    : record.unresolved_review_obligations_total;
  if (typeof obligationTotal !== "number" || !Number.isInteger(obligationTotal)) return null;
  if (record.unresolved_review_obligations_truncated !== undefined && !reviewProducing) return null;
  const obligationTruncated = record.unresolved_review_obligations_truncated === undefined
    ? false
    : record.unresolved_review_obligations_truncated;
  if (typeof obligationTruncated !== "boolean") return null;
// The counters must agree with the list: a document that lists more
// blocking rows than it counts, that claims no truncation while its
// total disagrees with the list it carries, or that claims a truncation
// while its total matches the list exactly, contradicts itself and is
// refused. #1521: the SAME shared rule the published handoff and the
// published `review-obligations/v1` document read — one implementation of
// "the counters must agree with the list they describe".
if (!countersAgreeWithList(obligationRows.length, obligationTotal, obligationTruncated)) return null;
  if (record.derived_obligation_state !== undefined) {
    if (!reviewProducing) return null;
    const state = record.derived_obligation_state;
    if (!(state === null
      || (typeof state === "string" && (DERIVED_OBLIGATION_STATES as readonly string[]).includes(state)))) return null;
  }
  // #1576: an attestation key that fails its own vocabulary check refuses
  // the document (the "malformed attestation is never read as any
  // conclusion, least of all approved" rule). Its presence is NOT required:
  // a bundle written before #1576 parses exactly as before.
  let attestation: ReviewAttestation | undefined;
  if (record.attestation !== undefined) {
    const parsedAttestation = parseReviewAttestation(record.attestation);
    if (parsedAttestation === null) return null;
    attestation = parsedAttestation;
  }
  // #1541: the shared-cap counters follow the same presence rule and are
  // cross-checked the same way. An absent counter is UNKNOWN (`null`), never
  // a count of zero: the shared cap could have shortened the list without
  // saying so. A counter without the list it describes is refused, and a
  // count below the listed length contradicts itself (the shared cap only
  // DROPS ids, so the count can never be smaller than the list).
  for (const [counterKey, listKey] of [
    ["unresolved_requirement_ids_source_total", "unresolved_requirement_ids"],
    ["unresolved_required_checks_source_total", "unresolved_required_checks"],
  ] as const) {
    const value = record[counterKey];
    // An explicit `null` is an absent counter, exactly like a missing key:
    // the handoff parser reads it as unknown, and so does this one.
    if (value === undefined || value === null) continue;
    if (!reviewProducing) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    const list = record[listKey];
    if (!Array.isArray(list)) return null;
    if (value < list.length) return null;
  }
  const requirementSourceTotal = record.unresolved_requirement_ids_source_total === undefined
    || record.unresolved_requirement_ids_source_total === null
    ? null
    : record.unresolved_requirement_ids_source_total as number;
  const checkSourceTotal = record.unresolved_required_checks_source_total === undefined
    || record.unresolved_required_checks_source_total === null
    ? null
    : record.unresolved_required_checks_source_total as number;
  if (record.skip_reason !== undefined && (typeof record.skip_reason !== "string" || record.state !== "skipped")) return null;
  if (record.failure_reason !== undefined && (typeof record.failure_reason !== "string" || record.state !== "failed")) return null;
  const bundle = {
    schema: REVIEW_BUNDLE_SCHEMA,
    review_id: record.review_id,
    generated_at: record.generated_at,
    action_version: typeof record.action_version === "string" ? record.action_version : "",
    repository: record.repository,
    pr_number: record.pr_number,
    head_sha: record.head_sha,
    base_sha: record.base_sha,
    state: record.state,
    identity: { diff_fingerprint: identityRecord.diff_fingerprint, analysis_engine: identityRecord.analysis_engine },
  } as ReviewBundle;
  if (record.disposition !== undefined && typeof record.disposition === "object" && record.disposition !== null && !Array.isArray(record.disposition)) {
    bundle.disposition = record.disposition as Record<string, unknown>;
  }
  if (record.publication !== undefined) bundle.publication = record.publication as { status: string };
  if (typeof record.skip_reason === "string") bundle.skip_reason = record.skip_reason;
  if (typeof record.failure_reason === "string") bundle.failure_reason = record.failure_reason;
  if (record.findings !== undefined) {
    bundle.findings = record.findings;
    bundle.findings_total = record.findings_total as number;
    bundle.findings_truncated = record.findings_truncated as boolean;
  }
  if (Array.isArray(record.unresolved_requirement_ids)) {
    bundle.unresolved_requirement_ids = [...record.unresolved_requirement_ids] as string[];
  }
  if (Array.isArray(record.unresolved_required_checks)) {
    bundle.unresolved_required_checks = [...record.unresolved_required_checks] as string[];
  }
  // #1541: the shared-cap counts are unknown when the document carries none.
  bundle.unresolved_requirement_ids_source_total = requirementSourceTotal;
  bundle.unresolved_required_checks_source_total = checkSourceTotal;
  // #1521: the blocking rows, their counters and the derived-obligation
  // state, present only on a review-producing state.
  if (obligationRows.length > 0 || record.unresolved_review_obligations !== undefined) {
    bundle.unresolved_review_obligations = obligationRows;
  }
  if (typeof record.unresolved_review_obligations_total === "number") {
    bundle.unresolved_review_obligations_total = record.unresolved_review_obligations_total;
  }
  if (typeof record.unresolved_review_obligations_truncated === "boolean") {
    bundle.unresolved_review_obligations_truncated = record.unresolved_review_obligations_truncated;
  }
  if (record.derived_obligation_state !== undefined) {
    bundle.derived_obligation_state = record.derived_obligation_state as PublishedDerivedObligationState | null;
  }
  // #1576: the validated attestation, present exactly when the document
  // carried one.
  if (attestation !== undefined) bundle.attestation = attestation;
  return bundle;
}
