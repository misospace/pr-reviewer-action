/**
 * The published remediation handoff (`review-handoff/v1`) — #1518.
 *
 * The `review-bundle/v1` document is the LOCAL machine surface: it rides the
 * `review-bundle` step output and a run-directory file, so only a workflow
 * inside the same run can read it. An external controller that wants to act
 * on a review needs a surface it can reach with ordinary pull-request reads.
 * This module is that surface: one compact, versioned JSON document that
 * rides the action-owned MANAGED body (the sticky comment or the native
 * review body) inside a fence-safe container. A consumer therefore needs
 * nothing but a comment or review read — no artifact download and no
 * forge-specific API.
 *
 * The serialization contract is forge-neutral: the container rides the body
 * every forge adapter already writes, so no new platform capability is
 * needed.
 *
 * Contract discipline mirrors `src/publish/bundle.ts`:
 * - a strict schema string that fails closed on parse;
 * - one line of JSON with a fixed key order and no `undefined` members;
 * - bounded-and-redacted construction (every text field passes `redactText`
 *   and a codepoint cap BEFORE serialization);
 * - the items are the FINAL post-enforcement findings, never raw model
 *   output;
 * - #1521: the blocking review-obligation rows ride the document too, so a
 *   controller sees WHAT blocked the review and not only an opaque id;
 * - a byte bound checked on the exact serialized string, with omissions
 *   disclosed (`items_total` / `items_truncated`) rather than hidden;
 * - #1538: the two merge-gating id lists carry the same disclosure — the
 *   byte budget shortens them first, so each list carries its honest count
 *   and a truncation flag and a shortened list is never read as the whole
 *   set.
 *
 * Trust rules (why a consumer may believe the FIRST block it finds):
 * - the action renders the container into the marker preamble, which precedes
 *   every model-authored surface in the published body;
 * - the anchor is reserved against model markdown
 *   (`RESERVED_MARKER_PATTERNS` in `src/metadata/markers.ts`), so model prose
 *   can never emit it;
 * - `parseReviewHandoffBlock` therefore reads the FIRST anchored block only —
 *   a later model-authored copy can never be mistaken for the action's.
 */
import { redactText } from "../context/redact.js";
import { fenceDelimiterFor } from "../context/fence.js";
import { boundedIdList, MAX_ID_LIST_CHARS, MAX_ID_LIST_ENTRIES } from "../context/id-lists.js";
import { pyCodepointSlice } from "../platform/py.js";
import { findingIdentityFromRecord } from "../outcomes/identity.js";
import { safePath } from "../findings/safe-path.js";
import { RESERVED_MARKER_PATTERNS, REVIEW_HANDOFF_ANCHOR } from "../metadata/markers.js";
import type { ReviewObligation } from "../enforcement/review-obligations.js";

/** The container anchor. It marks the START of the action-owned block and is
 * reserved against model-authored text on every published surface, so the
 * first occurrence in a published body is always the action's own. It lives
 * in the reserved-grammar home (`src/metadata/markers.ts`) because every
 * model-authored surface strips it from there. */
export { REVIEW_HANDOFF_ANCHOR };

/** The shared bounded id list (the neutral module owns the bound; the
 * publish layer re-exports it so its own callers keep one import site). */
export { boundedIdList, MAX_ID_LIST_CHARS, MAX_ID_LIST_ENTRIES };

/** The schema identifier. A consumer must refuse a document whose `schema`
 * is not byte-identical to this string (the ledger pattern, #1027). */
export const REVIEW_HANDOFF_SCHEMA = "review-handoff/v1";

/** Hard ceiling on the whole serialized document (UTF-8 bytes). The handoff
 * rides a public comment body, so it stays small enough to read and to
 * publish on every forge. */
export const REVIEW_HANDOFF_MAX_BYTES = 8192;

/** Items admitted before the `items_truncated` disclosure fires. */
export const REVIEW_HANDOFF_MAX_ITEMS = 25;

/** Per-field codepoint caps applied AFTER redaction. */
export const REVIEW_HANDOFF_MAX_MESSAGE_CHARS = 400;
/** The suggestion cap. A published replacement is NEVER truncated: a
 * replacement longer than this loses the suggestion and keeps the item, so
 * no consumer ever receives a syntactically invalid patch. */
export const REVIEW_HANDOFF_MAX_SUGGESTION_CHARS = 2000;
export const REVIEW_HANDOFF_MAX_AGENT_PROMPT_CHARS = 400;
export const REVIEW_HANDOFF_MAX_PATH_CHARS = 300;
export const REVIEW_HANDOFF_MAX_CATEGORY_CHARS = 64;
export const REVIEW_HANDOFF_MAX_TOKEN_CHARS = 200;

/** The two id lists are bounded independently of the items: each holds at
 * most this many ids, each id at most this many characters. The bound lives
 * in the neutral `src/context/id-lists.ts` module; these names are the
 * publish layer's aliases of it. */
export const REVIEW_HANDOFF_MAX_IDS = MAX_ID_LIST_ENTRIES;
export const REVIEW_HANDOFF_MAX_ID_CHARS = MAX_ID_LIST_CHARS;

/** #1521: the blocking obligation rows are bounded independently of the
 * items too: at most this many rows ride the document, each row's text at
 * most this many codepoints. The row projection is SHARED with the local
 * `review-bundle/v1` document (see `boundedObligationRows`), so the two
 * documents can never disagree about what a blocking row says. */
export const REVIEW_HANDOFF_MAX_OBLIGATIONS = 10;
export const REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS = 300;

/** The closed severity vocabulary. Anything else is reported as `info`
 * rather than smuggled into the closed set. */
const HANDOFF_SEVERITIES = ["blocker", "major", "minor", "info"] as const;

/**
 * Remove the action-owned marker grammar from text the handoff carries.
 *
 * The handoff's own anchor is action-owned state, and so is every other
 * reserved marker. A model-authored finding message must never be able to
 * carry a second copy of the handoff anchor into the published container: a
 * consumer that counts anchors, or that takes the last one, would then read
 * the wrong block. Only the marker grammar is removed — the text stays a
 * string and the finding is never dropped.
 */
function stripReservedMarkerGrammar(text: string): string {
  let stripped = text;
  for (const pattern of RESERVED_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
}

/** Every text field goes through this: the reserved marker grammar first (so
 * no action-owned marker can be forged into the container), then redaction
 * (a secret must not survive into a machine artifact), then the caller's
 * cap. */
function bounded(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return pyCodepointSlice(redactText(stripReservedMarkerGrammar(text)), max);
}

/** The codepoint length of a string (never the UTF-16 length: an astral
 * codepoint counts once, exactly like Python's `len`). */
function codepointLength(text: string): number {
  return Array.from(text).length;
}

export interface ReviewHandoffItem {
  /** Stable cross-run identity (the #1027 finding identity digest) when the
   * record can prove one; null when it cannot. Never a positional index —
   * those drift between reruns. */
  id: string | null;
  severity: string;
  category: string;
  path: string | null;
  line: number | null;
  end_line?: number;
  message: string;
  /** Present ONLY when THIS run published that exact replacement as a
   * review comment (see `publishedPrescriptions`). */
  suggestion?: string;
  agent_prompt?: string;
}

/**
 * #1521: one published blocking obligation row.
 *
 * The row names WHAT blocked the review — the id, the source that made it
 * blocking, the status, the cause and the obligation's own text — so a
 * controller never has to guess what an opaque id refers to. The row is
 * untrusted text: every string in it is redacted, stripped of the reserved
 * marker grammar and capped before serialization.
 *
 * `source` and `status` are plain strings here because the wire shape is
 * what the parser guarantees: it refuses a row outside the closed
 * vocabularies below, and the BUILDER only ever publishes rows inside them.
 */
export interface ReviewObligationRow {
  id: string;
  source: string;
  status: string;
  cause: string | null;
  text: string;
}

/** #1521: the sources a BLOCKING row may carry. A `derived` row is a
 * coverage statement, never a block (#1449), and anything outside this
 * vocabulary cannot be proven non-derived — so such a row is dropped, fail
 * closed. */
const PUBLISHED_OBLIGATION_SOURCES = ["must_check", "trusted_base_guidance"] as const;

/** #1521/#1505: the ONLY status a published blocking row carries. A block
 * is a confirmed negative — the check was performed and did not hold
 * (`unmet`). A `satisfied` row blocked nothing and an `unresolved` row is
 * an availability failure (coverage, never a defect), so neither ever
 * rides a block, and the parser refuses a document that lists either one
 * as blocking. */
const PUBLISHED_OBLIGATION_STATUSES = ["unmet"] as const;

/** #1521: the closed cause vocabulary (the enforcement layer's own). The
 * cause EXPLAINS a block, it never decides one, so an unknown cause is
 * published as null rather than invented. */
const PUBLISHED_OBLIGATION_CAUSES = [
  "tool-capability",
  "budget-exhausted",
  "provider-failure",
  "missing-source-evidence",
  "derivation-incomplete",
] as const;

/** #1521: the run's derived-obligation state (#1449's closed vocabulary).
 * `null` means the state is UNKNOWN — the feature was off, or the run could
 * not prove it. An unknown state is never read as `complete`, so the
 * disclosure stays conservative. Exported so the local bundle validates the
 * SAME vocabulary. */
export const DERIVED_OBLIGATION_STATES = ["complete", "unresolved", "unavailable"] as const;
export type PublishedDerivedObligationState = (typeof DERIVED_OBLIGATION_STATES)[number];

function isPublishedObligationSource(value: unknown): boolean {
  return typeof value === "string" && (PUBLISHED_OBLIGATION_SOURCES as readonly string[]).includes(value);
}

/** #1521: the parser's own vocabulary checks. The builder already emits only
 * these values, so a document that carries anything else was not produced by
 * this action — and a consumer must never read a `derived` coverage row or a
 * discharged row as "an obligation that blocked the review". The parser
 * refuses such a document instead of accepting it. */
function isPublishedObligationStatus(value: unknown): boolean {
  return typeof value === "string" && (PUBLISHED_OBLIGATION_STATUSES as readonly string[]).includes(value);
}

function isPublishedObligationCause(value: unknown): boolean {
  return value === null || (typeof value === "string" && (PUBLISHED_OBLIGATION_CAUSES as readonly string[]).includes(value));
}

function publishedObligationCause(value: unknown): string | null {
  return typeof value === "string" && (PUBLISHED_OBLIGATION_CAUSES as readonly string[]).includes(value)
    ? value
    : null;
}

/** #1521: the derived-obligation state as published — the closed vocabulary
 * or null (unknown). Anything outside the vocabulary is unknown, never
 * `complete`. Exported so the local bundle publishes the SAME state. */
export function publishedDerivedObligationState(value: unknown): PublishedDerivedObligationState | null {
  return typeof value === "string" && (DERIVED_OBLIGATION_STATES as readonly string[]).includes(value)
    ? value as PublishedDerivedObligationState
    : null;
}

/**
 * #1521: the shared projection of the blocking obligation rows.
 *
 * ONE implementation, shared with the local `review-bundle/v1` document
 * (`src/publish/bundle.ts` imports it from here), so the published handoff
 * and the local bundle can never disagree about what a blocking row says or
 * how many rows there are.
 *
 * The projection is deliberately strict:
 * - only the FORCING sources ride (`must_check`, `trusted_base_guidance`) —
 *   a `derived` row is coverage, never a block (#1449), and a row whose
 *   source cannot be proven non-derived is dropped too (fail closed);
 * - a `satisfied` row never rides (it blocked nothing);
 * - the id is redacted, marker-stripped and capped like an id list entry,
 *   and a row whose id bounds to nothing is dropped (an unaddressable row
 *   cannot be acted on);
 * - duplicate ids are dropped (first wins);
 * - the text is redacted, marker-stripped and capped.
 *
 * `total` is the honest count of the blocking rows the run had BEFORE the
 * listing bound, so a truncated list is never passed off as the whole set.
 */
export interface BoundedObligationRows {
  /** The rows that ride the document (at most `REVIEW_HANDOFF_MAX_OBLIGATIONS`). */
  rows: ReviewObligationRow[];
  /** The count of the qualifying blocking rows, before the listing bound. */
  total: number;
}

export function boundedObligationRows(obligations: readonly ReviewObligation[] | undefined): BoundedObligationRows {
  const rows: ReviewObligationRow[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const obligation of obligations ?? []) {
    if (obligation === null || typeof obligation !== "object") continue;
    if (!isPublishedObligationSource(obligation.source)) continue;
    // #1505: only a FORCING row rides as a blocking obligation — a
    // review-owned `unmet` row. An `unresolved` row is an availability
    // failure (coverage, never a defect) and `satisfied` blocked nothing;
    // a `derived` row is coverage (#1449). None of those ever ride here.
    if (obligation.status !== "unmet") continue;
    if (typeof obligation.id !== "string") continue;
    const id = bounded(obligation.id.trim(), MAX_ID_LIST_CHARS);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    total += 1;
    if (rows.length >= REVIEW_HANDOFF_MAX_OBLIGATIONS) continue;
    rows.push({
      id,
      source: obligation.source,
      // The filter above proved it: a riding row is exactly `unmet`.
      status: obligation.status,
      cause: publishedObligationCause(obligation.cause),
      text: bounded(obligation.text, REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS),
    });
  }
  return { rows, total };
}

export interface ReviewHandoff {
  schema: typeof REVIEW_HANDOFF_SCHEMA;
  review_id: string;
  head_sha: string;
  verdict: string;
  review_result: string;
  required_checks: string;
  items: ReviewHandoffItem[];
  items_total: number;
  items_truncated: boolean;
  unresolved_requirement_ids: string[];
  /** #1538: the number of merge-gating requirement ids this document could
   * carry BEFORE the byte budget shortened the list. `null` when the
   * document discloses no count (a handoff published before #1538): an
   * unknown count is never read as "the list is the whole set". */
  unresolved_requirement_ids_total: number | null;
  /** #1538: whether the byte budget dropped a requirement id. `false` means
   * the list is the whole set; `null` means the document discloses nothing
   * (a handoff published before #1538) and is never read as `false`. */
  unresolved_requirement_ids_truncated: boolean | null;
  unresolved_required_checks: string[];
  /** #1538: the same honest count for the required-check ids. */
  unresolved_required_checks_total: number | null;
  /** #1538: the same truncation flag for the required-check ids. */
  unresolved_required_checks_truncated: boolean | null;
/** #1521: the review-obligation rows that BLOCKED the review — the
   * deterministic enforcement pass's own rows, so a controller sees WHAT
   * blocked it and not only an opaque id. */
  unresolved_review_obligations: ReviewObligationRow[];
  /** #1521: the honest count of the blocking rows the run had, BEFORE the
   * listing bound — a truncated list is never passed off as the whole set. */
  unresolved_review_obligations_total: number;
  /** #1521: whether the listing was shortened. */
  unresolved_review_obligations_truncated: boolean;
  /** #1521: the run's derived-obligation state (#1449), null when unknown.
   * ALWAYS present, so the document's key set stays fixed. */
  derived_obligation_state: PublishedDerivedObligationState | null;}

export interface ReviewHandoffInput {
  /** The run's own review id; it pairs with `headSha` to name THIS review
   * of THIS head across reruns. */
  reviewId?: string | undefined;
  headSha: string;
  verdict: string;
  reviewResult: string;
  requiredChecks: string;
  /** The FINAL post-enforcement findings (the artifact's findings), never
   * raw model output. */
  findings: unknown;
  unresolvedRequirementIds?: readonly string[] | undefined;
  unresolvedRequiredChecks?: readonly string[] | undefined;
  /** #1521: the review-obligation rows that blocked the review. Only the
   * forcing rows ride (see `blockingReviewObligations`): a review-owned
   * `unmet` row (#1505). An `unresolved` row is coverage, never a block,
   * and a `derived` row is likewise coverage. */
  unresolvedReviewObligations?: readonly ReviewObligation[] | undefined;
  /** #1521: the run's derived-obligation state ("complete" | "unresolved" |
   * "unavailable"). Anything else is published as null (unknown). */
  derivedObligationState?: string | undefined;
  /** The replacements THIS run published as review comments, keyed by the
   * finding's stable identity digest. A suggestion rides an item only when
   * the action itself published that exact replacement, so the handoff can
   * never propose anything the action did not publish (a rejected or
   * unpublishable replacement never rides it). */
  publishedPrescriptions?: ReadonlyMap<string, string> | undefined;
}

function findingsArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value !== "") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The suggestion this item may carry, or null when it may not.
 *
 * A suggestion rides the handoff ONLY when this run published that exact
 * replacement as a review comment: the published map is the proof. A
 * replacement the action suppressed (a trusted 👎, #762) or never published
 * (no anchor, no diff, a hostile replacement) has no entry, so it never
 * rides the handoff. The published replacement is never truncated: a
 * replacement longer than the suggestion cap loses the suggestion and keeps
 * the item, because a cut-off patch is worse than no patch.
 */
function publishedSuggestion(
  id: string | null,
  published: ReadonlyMap<string, string> | undefined,
): string | null {
  if (id === null || published === undefined) return null;
  const replacement = published.get(id);
  if (replacement === undefined) return null;
  const text = redactText(stripReservedMarkerGrammar(replacement));
  if (codepointLength(text) > REVIEW_HANDOFF_MAX_SUGGESTION_CHARS) return null;
  return text;
}

/** Project one final finding record into the handoff's normalized item. The
 * key order is fixed by construction (the optional members are spread in
 * place), and every text field is redacted and capped. */
function handoffItem(
  record: Record<string, unknown>,
  published: ReadonlyMap<string, string> | undefined,
): ReviewHandoffItem {
  const rawSeverity = typeof record.severity === "string" ? record.severity : "info";
  const severity = (HANDOFF_SEVERITIES as readonly string[]).includes(rawSeverity) ? rawSeverity : "info";
  // #1518: the path rides a PUBLIC document, so it must pass the same
  // `safePath` bar every other untrusted-path surface applies (#1163): an
  // absolute, traversing, or NUL-bearing path proves no anchor and is
  // dropped (`null`), never serialized.
  const path = safePath(record.file)
    ? bounded(record.file, REVIEW_HANDOFF_MAX_PATH_CHARS)
    : null;
  const line = typeof record.line === "number" && Number.isFinite(record.line) ? Math.trunc(record.line) : null;
  const endLine = typeof record.end_line === "number" && Number.isFinite(record.end_line)
    ? Math.trunc(record.end_line)
    : null;
  const id = findingIdentityFromRecord(record);
  const suggestion = publishedSuggestion(id, published);
  const agentPrompt = typeof record.agent_prompt === "string" && record.agent_prompt !== ""
    ? bounded(record.agent_prompt, REVIEW_HANDOFF_MAX_AGENT_PROMPT_CHARS)
    : null;
  return {
    id,
    severity,
    category: bounded(record.category ?? "", REVIEW_HANDOFF_MAX_CATEGORY_CHARS),
    path,
    line,
    ...(endLine !== null ? { end_line: endLine } : {}),
    message: bounded(record.message ?? "", REVIEW_HANDOFF_MAX_MESSAGE_CHARS),
    ...(suggestion !== null ? { suggestion } : {}),
    ...(agentPrompt !== null ? { agent_prompt: agentPrompt } : {}),
  };
}

/**
 * Serialize the document so it is inert in every context the published body
 * can be rendered in.
 *
 * The HTML-significant characters are written as JSON unicode escapes: the
 * document stays valid JSON (a consumer's `JSON.parse` returns the original
 * characters), but the RAW body can never carry an HTML tag or an HTML
 * comment out of the payload. The JavaScript line separators are escaped for
 * the same reason (they are line terminators in a script context).
 */
function serializeHandoff(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Build the deterministic `review-handoff/v1` document (one line of JSON).
 *
 * The byte bound is checked on the EXACT serialized string: the disclosure
 * segment (the item counters) is reserved up front, and items are admitted
 * one at a time only while the whole document still fits. An omission is
 * disclosed through `items_total` / `items_truncated`, so a truncated set is
 * never passed off as the whole set.
 *
 * #1538: the two merge-gating id lists carry the SAME disclosure. They are
 * the first thing the byte budget gives way, so each one publishes the
 * count it was shortened FROM (`*_total`) and whether it was shortened at
 * all (`*_truncated`) — a consumer can never read a shortened list as the
 * whole set. The counters ride the base, so they are reserved in the byte
 * budget exactly like the item counters are.
* #1521: the blocking obligation rows are part of the document BASE, exactly
 * like the two id lists — they name WHAT blocked the review, so they are the
 * last thing the byte budget gives way (and only after both id lists are
 * empty). Their own omission is disclosed by
 * `unresolved_review_obligations_total` / `unresolved_review_obligations_truncated`. */
export function buildReviewHandoff(input: ReviewHandoffInput): string {
  const candidates = findingsArray(input.findings).filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const requirementIds = boundedIdList(input.unresolvedRequirementIds);
  const checkIds = boundedIdList(input.unresolvedRequiredChecks);
  // #1538: the honest count of the ids each list could carry BEFORE the byte
  // budget shortens it. The lists arrive already bounded by their producers
  // (`unresolvedTraceRequirementIds`, `unresolvedRequiredCheckIds`), so the
  // received length IS the whole set this document knows about; the byte
  // budget is the only thing that shortens it here.
  const requirementTotal = requirementIds.length;
  const checkTotal = checkIds.length;
  // #1521: the shared row projection (the local bundle uses the same one).
  const obligations = boundedObligationRows(input.unresolvedReviewObligations);
  const derivedState = publishedDerivedObligationState(input.derivedObligationState);
  const serialize = (
    items: ReviewHandoffItem[],
    reqIds: string[],
    chkIds: string[],
    obligationRows: ReviewObligationRow[],
    obligationTotal: number,
    obligationTruncated: boolean,
  ): string => serializeHandoff({
    schema: REVIEW_HANDOFF_SCHEMA,
    review_id: bounded(input.reviewId ?? "", REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    head_sha: bounded(input.headSha, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    verdict: bounded(input.verdict, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    review_result: bounded(input.reviewResult, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    required_checks: bounded(input.requiredChecks, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    items,
    items_total: candidates.length,
    items_truncated: items.length < candidates.length,
    unresolved_requirement_ids: reqIds,
    unresolved_requirement_ids_total: requirementTotal,
    unresolved_requirement_ids_truncated: reqIds.length < requirementTotal,
    unresolved_required_checks: chkIds,
    unresolved_required_checks_total: checkTotal,
    unresolved_required_checks_truncated: chkIds.length < checkTotal,
    unresolved_review_obligations: obligationRows,
    unresolved_review_obligations_total: obligationTotal,
    unresolved_review_obligations_truncated: obligationTruncated,
    derived_obligation_state: derivedState,
  });

  // The document without any item is the base the disclosure rides on. The
  // bounded id lists alone can still exceed the cap (twenty four-byte
  // codepoint ids per list), so the base itself is shrunk before any item is
  // admitted: the LAST ids of the LONGER list are dropped one at a time
  // (requirements first on a tie) until the zero-item document fits. The
  // empty-list base is far below the cap, so the loop always terminates —
  // and the cap holds on the exact serialized string in every input.
  //
  // #1538: the shrink is DISCLOSED, never silent. Each list publishes the
  // count it was shortened from (`*_total`) and whether it was shortened
  // (`*_truncated`), and both counters ride the base — so they are measured
  // in the very byte budget that shortens the lists, and the shortened
  // document still fits the cap.
  let baseRequirementIds = requirementIds;
  let baseCheckIds = checkIds;
  // #1521: the obligation rows shrink only AFTER both id lists are empty —
  // they are the disclosure that says WHAT blocked the review, so they are
  // the last thing to go, and their omission is disclosed.
  let baseObligationRows = obligations.rows;
  const baseObligationTotal = obligations.total;
  let baseObligationTruncated = obligations.rows.length < obligations.total;
  while (Buffer.byteLength(serialize([], baseRequirementIds, baseCheckIds, baseObligationRows, baseObligationTotal, baseObligationTruncated), "utf8") > REVIEW_HANDOFF_MAX_BYTES
    && (baseRequirementIds.length > 0 || baseCheckIds.length > 0 || baseObligationRows.length > 0)) {
    if (baseRequirementIds.length >= baseCheckIds.length && baseRequirementIds.length > 0) {
      baseRequirementIds = baseRequirementIds.slice(0, -1);
    } else if (baseCheckIds.length > 0) {
      baseCheckIds = baseCheckIds.slice(0, -1);
    } else {
      baseObligationRows = baseObligationRows.slice(0, -1);
      baseObligationTruncated = true;
    }
  }

  const included: ReviewHandoffItem[] = [];
  if (Buffer.byteLength(serialize(included, baseRequirementIds, baseCheckIds, baseObligationRows, baseObligationTotal, baseObligationTruncated), "utf8") <= REVIEW_HANDOFF_MAX_BYTES) {
    for (const candidate of candidates.slice(0, REVIEW_HANDOFF_MAX_ITEMS)) {
      const item = handoffItem(candidate, input.publishedPrescriptions);
      const next = serialize([...included, item], baseRequirementIds, baseCheckIds, baseObligationRows, baseObligationTotal, baseObligationTruncated);
      if (Buffer.byteLength(next, "utf8") > REVIEW_HANDOFF_MAX_BYTES) break;
      included.push(item);
    }
  }
  return serialize(included, baseRequirementIds, baseCheckIds, baseObligationRows, baseObligationTotal, baseObligationTruncated);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseHandoffItem(value: unknown): ReviewHandoffItem | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!(record.id === null || typeof record.id === "string")) return null;
  if (typeof record.severity !== "string") return null;
  if (typeof record.category !== "string") return null;
  if (!(record.path === null || typeof record.path === "string")) return null;
  if (!(record.line === null || (typeof record.line === "number" && Number.isInteger(record.line)))) return null;
  if (record.end_line !== undefined && !(typeof record.end_line === "number" && Number.isInteger(record.end_line))) return null;
  if (typeof record.message !== "string") return null;
  if (record.suggestion !== undefined && typeof record.suggestion !== "string") return null;
  if (record.agent_prompt !== undefined && typeof record.agent_prompt !== "string") return null;
  const item: ReviewHandoffItem = {
    id: record.id as string | null,
    severity: record.severity,
    category: record.category,
    path: record.path as string | null,
    line: record.line as number | null,
    message: record.message,
  };
  if (typeof record.end_line === "number") item.end_line = record.end_line;
  if (typeof record.suggestion === "string") item.suggestion = record.suggestion;
  if (typeof record.agent_prompt === "string") item.agent_prompt = record.agent_prompt;
  return item;
}

/**
 * #1538: the id-list disclosure counters must agree with the list they
 * describe.
 *
 * A count below the listed length, a count that disagrees with the list
 * while the document claims no truncation, and a truncation claim whose count
 * matches the list exactly are all contradictions, and a contradictory
 * document is refused. An UNKNOWN counter (`null` — a handoff published
 * before #1538) is never a contradiction: the document simply discloses
 * nothing, and nothing is read from it.
 */
function idCountersAgree(ids: string[], total: number | null, truncated: boolean | null): boolean {
  if (total !== null && total < ids.length) return false;
  if (truncated === false && total !== null && total !== ids.length) return false;
  if (truncated === true && total !== null && total === ids.length) return false;
  return true;
}

/**
 * #1521: one published blocking obligation row, checked fail-closed.
 *
 * The row's shape is the published contract: a string `id`, `source`,
 * `status` and `text`, and a `cause` that is a string or null. A row that
 * does not have that shape refuses the whole document — a consumer must
 * never read a half-formed row as a blocking obligation.
 *
 * The three vocabularies are checked too, not only the types. A `derived`
 * row is a COVERAGE statement, a `satisfied` row blocked nothing, and an
 * `unresolved` row is an availability failure — coverage, never a defect
 * (#1505) — so a document that carries any of them as a blocking obligation
 * tells the consumer the review was blocked by something it was not. The
 * builder never emits such a row, so a document that does carry one was not
 * produced by this action, and it is refused rather than read.
 */
export function parseObligationRow(value: unknown): ReviewObligationRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  if (!isPublishedObligationSource(record.source)) return null;
  if (!isPublishedObligationStatus(record.status)) return null;
  if (typeof record.text !== "string") return null;
  if (!isPublishedObligationCause(record.cause)) return null;
  return {
    id: record.id,
    source: record.source as string,
    status: record.status as string,
    cause: record.cause as string | null,
    text: record.text,
  };}

/**
 * Fail-closed parse of a handoff document: the exact schema string and the
 * exact member types, or null. A consumer must treat anything this refuses
 * as absent.
 *
 * The counters are cross-checked, not just typed: a document that claims
 * fewer items than it lists, or that claims no truncation while its total
 * disagrees with the list it carries, is contradictory and refused. An
 * empty `review_id` is refused too — a handoff that cannot name its review
 * names nothing (the bundle's parser refuses the same).
 *
 * #1538: the two id lists carry the same disclosure, and the same
 * cross-check. Their counters are OPTIONAL on parse — a handoff published
 * before #1538 carries none of them and stays parseable — but an absent
 * counter is UNKNOWN (`null`), never read as "the list is the whole set":
 * the byte budget could have shortened that list without saying so.
 */
export function parseReviewHandoff(text: string): ReviewHandoff | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== REVIEW_HANDOFF_SCHEMA) return null;
  if (typeof record.review_id !== "string" || record.review_id === "") return null;
  if (typeof record.head_sha !== "string") return null;
  if (typeof record.verdict !== "string") return null;
  if (typeof record.review_result !== "string") return null;
  if (typeof record.required_checks !== "string") return null;
  if (!Array.isArray(record.items)) return null;
  if (typeof record.items_total !== "number" || !Number.isInteger(record.items_total)) return null;
  if (typeof record.items_truncated !== "boolean") return null;
  if (!isStringArray(record.unresolved_requirement_ids)) return null;
  if (!isStringArray(record.unresolved_required_checks)) return null;
  // #1538: the id-list disclosure counters — absent means unknown, never
  // "not truncated".
  const requirementTotal = record.unresolved_requirement_ids_total === undefined
    ? null
    : record.unresolved_requirement_ids_total;
  if (!(requirementTotal === null
    || (typeof requirementTotal === "number" && Number.isInteger(requirementTotal) && requirementTotal >= 0))) return null;
  const requirementTruncated = record.unresolved_requirement_ids_truncated === undefined
    ? null
    : record.unresolved_requirement_ids_truncated;
  if (!(requirementTruncated === null || typeof requirementTruncated === "boolean")) return null;
  const checkTotal = record.unresolved_required_checks_total === undefined
    ? null
    : record.unresolved_required_checks_total;
  if (!(checkTotal === null
    || (typeof checkTotal === "number" && Number.isInteger(checkTotal) && checkTotal >= 0))) return null;
  const checkTruncated = record.unresolved_required_checks_truncated === undefined
    ? null
    : record.unresolved_required_checks_truncated;
  if (!(checkTruncated === null || typeof checkTruncated === "boolean")) return null;
// #1521: the four #1521 members are OPTIONAL on parse — a handoff
  // published before #1521 carries none of them, and it must stay
  // parseable. An absent list parses as empty, an absent state as null.
  const obligationRows: ReviewObligationRow[] = [];
  if (record.unresolved_review_obligations !== undefined) {
    if (!Array.isArray(record.unresolved_review_obligations)) return null;
    for (const raw of record.unresolved_review_obligations) {
      const row = parseObligationRow(raw);
      if (row === null) return null;
      obligationRows.push(row);
    }
  }
  const obligationTotal = record.unresolved_review_obligations_total === undefined
    ? obligationRows.length
    : record.unresolved_review_obligations_total;
  if (typeof obligationTotal !== "number" || !Number.isInteger(obligationTotal)) return null;
  const obligationTruncated = record.unresolved_review_obligations_truncated === undefined
    ? false
    : record.unresolved_review_obligations_truncated;
  if (typeof obligationTruncated !== "boolean") return null;
  const derivedState = record.derived_obligation_state === undefined
    ? null
    : record.derived_obligation_state;
  if (!(derivedState === null
    || (typeof derivedState === "string" && (DERIVED_OBLIGATION_STATES as readonly string[]).includes(derivedState)))) {
    return null;
  }  const items: ReviewHandoffItem[] = [];
  for (const raw of record.items) {
    const item = parseHandoffItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  // The counters must agree with the list: a document that lists more items
  // than it counts, or that claims no truncation while its total disagrees
  // with the list, contradicts itself.
  if (record.items_total < items.length) return null;
  if (record.items_truncated === false && record.items_total !== items.length) return null;
  // #1538: the same cross-check for the two id lists.
  if (!idCountersAgree(record.unresolved_requirement_ids, requirementTotal, requirementTruncated)) return null;
  if (!idCountersAgree(record.unresolved_required_checks, checkTotal, checkTruncated)) return null;
// #1521: the same cross-check for the obligation rows — a document that
  // claims fewer blocking rows than it lists, or that claims no truncation
  // while its total disagrees with the list it carries, contradicts itself.
  if (obligationTotal < obligationRows.length) return null;
  if (obligationTruncated === false && obligationTotal !== obligationRows.length) return null;  return {
    schema: REVIEW_HANDOFF_SCHEMA,
    review_id: record.review_id,
    head_sha: record.head_sha,
    verdict: record.verdict,
    review_result: record.review_result,
    required_checks: record.required_checks,
    items,
    items_total: record.items_total,
    items_truncated: record.items_truncated,
    unresolved_requirement_ids: [...record.unresolved_requirement_ids],
    unresolved_requirement_ids_total: requirementTotal,
    unresolved_requirement_ids_truncated: requirementTruncated,
    unresolved_required_checks: [...record.unresolved_required_checks],
    unresolved_required_checks_total: checkTotal,
    unresolved_required_checks_truncated: checkTruncated,
unresolved_review_obligations: obligationRows,
    unresolved_review_obligations_total: obligationTotal,
    unresolved_review_obligations_truncated: obligationTruncated,
    derived_obligation_state: derivedState as PublishedDerivedObligationState | null,  };
}

/**
 * Render the published container: the anchor line, then the fence, then the
 * single-line JSON payload, then the closing fence.
 *
 * The fence delimiter is longer than any backtick run inside the payload
 * (`fenceDelimiterFor`), so no payload byte can close the block. The payload
 * itself is a single line (`JSON.stringify` escapes the newlines), so it
 * cannot break out of the fence either.
 */
export function renderReviewHandoffBlock(handoffJson: string): string {
  const delimiter = fenceDelimiterFor(handoffJson);
  return `${REVIEW_HANDOFF_ANCHOR}\n${delimiter}json\n${handoffJson}\n${delimiter}`;
}

/**
 * The CONSUMER-side parser: find the FIRST anchored block in a published
 * body and parse it.
 *
 * FIRST is the trust rule. The action renders the container in the
 * action-owned marker preamble, which precedes every model-authored surface
 * in the body, and the anchor is reserved against model markdown — so the
 * first occurrence is the action's own. A later model-authored copy can
 * never be mistaken for it. A body without an anchor has no handoff.
 *
 * The caller must additionally select the body by the FORGE-REPORTED AUTHOR
 * (the action's own posting identity) and the managed marker: a content
 * prefix alone is forgeable, because any reader of the repository can post
 * a look-alike comment.
 */
export function parseReviewHandoffBlock(body: string): ReviewHandoff | null {
  if (typeof body !== "string") return null;
  const anchorAt = body.indexOf(REVIEW_HANDOFF_ANCHOR);
  if (anchorAt === -1) return null;
  const lines = body.slice(anchorAt + REVIEW_HANDOFF_ANCHOR.length).split(/\r\n|\n|\r/);
  // The anchor must end its line, then the fence opens, then the payload
  // sits on one line, then the closing fence is exactly the opener.
  if (lines[0] !== "") return null;
  const fence = /^(`{3,})json$/.exec(lines[1] ?? "");
  if (fence === null) return null;
  const delimiter = fence[1]!;
  if (lines[3] !== delimiter) return null;
  const payload = lines[2];
  if (payload === undefined) return null;
  return parseReviewHandoff(payload);
}

/**
 * Whether this handoff speaks about the given head. A handoff that cannot
 * name its head matches nothing — the fail-closed direction, because a
 * consumer that acts on a stale or unknown head changes the wrong code.
 */
export function handoffMatchesHead(handoff: ReviewHandoff, headSha: string): boolean {
  if (handoff.head_sha === "") return false;
  return handoff.head_sha === headSha;
}
