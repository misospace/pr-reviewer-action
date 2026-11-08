/**
 * The published review-obligations document (`review-obligations/v1`) — #1521.
 *
 * #1521 asks a remote controller to be able to NAME every review obligation
 * that BLOCKED a review, not only count them. The published handoff
 * (`review-handoff/v1`, `src/publish/handoff.ts`) answers that for a
 * COMPACT list: it is an 8 KiB document that also carries the items, the
 * two merge-gating id lists and the derived state, so its obligation list
 * can only ever be a disclosed prefix of the blocking rows. The local
 * `review-bundle/v1` document rides the `review-bundle` step output and a
 * run-directory file, so only a workflow inside the same run can read it.
 *
 * This module is the THIRD surface, and the one that carries the COMPLETE
 * set: a second published document, in its own container, whose only job is
 * to name every qualifying blocking row — the id, the source that made it
 * blocking, the status, the cause and the obligation's own text. A
 * controller needs nothing but a comment or review read to get it, and it
 * gets EVERY row, not a prefix.
 *
 * Contract discipline mirrors `src/publish/handoff.ts`:
 * - a strict schema string that fails closed on parse;
 * - one line of JSON with a fixed key order and no `undefined` members;
 * - bounded-and-redacted construction (every text field passes the shared
 *   `boundedPublishedText`, so the reserved marker grammar is stripped, a
 *   secret is redacted and the text is capped BEFORE serialization);
 * - the rows are the SHARED projection's rows (the same projection the
 *   handoff and the local bundle use), so the three documents can never
 *   disagree about what a blocking row says;
 * - a byte bound checked on the exact serialized string, and the bound is
 *   met by SHORTENING every row's text, NEVER by dropping a row: the list
 *   this document carries is the COMPLETE set of qualifying blocking rows,
 *   and the effective per-row text cap is disclosed in the document
 *   (`unresolved_review_obligations_text_chars`) so a consumer knows how
 *   long a row's text may be. The only disclosure that can fire is the
 *   row-COUNT bound (`unresolved_review_obligations_total` /
 *   `unresolved_review_obligations_truncated`), and it never binds for a
 *   real run — see `REVIEW_OBLIGATIONS_MAX_ROWS`.
 *
 * Trust rules (why a consumer may believe the FIRST block it finds):
 * - the action renders the container into the marker preamble, which precedes
 *   every model-authored surface in the published body;
 * - the anchor is reserved against model markdown
 *   (`RESERVED_MARKER_PATTERNS` in `src/metadata/markers.ts`), so model prose
 *   can never emit it;
 * - `parseReviewObligationsBlock` therefore reads the FIRST anchored block
 *   only — a later model-authored copy can never be mistaken for the
 *   action's.
 */
import { fenceDelimiterFor } from "../context/fence.js";
import {
  boundedObligationRows,
  boundedPublishedText,
  countersAgreeWithList,
  parseObligationRow,
  REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS,
  REVIEW_HANDOFF_MAX_TOKEN_CHARS,
  type ReviewObligationRow,
} from "./handoff.js";
import { REVIEW_OBLIGATIONS_ANCHOR } from "../metadata/markers.js";
import type { ReviewObligation } from "../enforcement/review-obligations.js";

export { REVIEW_OBLIGATIONS_ANCHOR };

/** The schema identifier. A consumer must refuse a document whose `schema`
 * is not byte-identical to this string (the ledger pattern, #1027). */
export const REVIEW_OBLIGATIONS_SCHEMA = "review-obligations/v1";

/**
 * Hard ceiling on the whole serialized document (UTF-8 bytes).
 *
 * The published handoff (8 KiB) plus this document (24 KiB) stay well
 * inside a forge comment body's limit — the two documents ride the SAME
 * published body.
 *
 * The bound is met by SHORTENING the rows' text, never by dropping a row:
 * the document carries the COMPLETE set of qualifying blocking rows, and the
 * effective per-row text cap is disclosed in the document. 24 KiB holds the
 * realistic worst case's complete row set: a run holds at most 42 qualifying
 * blocking rows (see `REVIEW_OBLIGATIONS_MAX_ROWS`), so even the widest
 * rows — a 64-codepoint id and a 300-codepoint text of four-byte codepoints
 * — fit once the text cap gives way to the budget. The published body never
 * grows by more than this bound plus the container that holds it.
 */
export const REVIEW_OBLIGATIONS_MAX_BYTES = 24_576;

/**
 * The publication bound on the row COUNT (#1521).
 *
 * The document carries the COMPLETE set of qualifying blocking rows, so the
 * byte budget gives way on the rows' TEXT, never on the row LIST. The COUNT
 * still needs a publication bound, and it never binds for a real run: the
 * run's blocking rows come from two deterministic sources — the classifier's
 * `must_check` checklist (at most 37 distinct static items: `KIND_CHECKS`,
 * `FLAG_CHECKS` and the shared `*_EVIDENCE_CHECKS` tables in
 * `src/classification/classify.ts`) and the trusted base's guidance asks (at
 * most 5, `MAX_APPROVAL_PREREQUISITES` in
 * `src/enforcement/review-obligations.ts`) — so a run holds at most 42
 * qualifying rows, and 64 leaves headroom over that derivation.
 *
 * The bound exists so the published shape has a FIXED upper limit. When it
 * does bind, `unresolved_review_obligations_truncated` says so: a shortened
 * list is never read as the whole set.
 */
export const REVIEW_OBLIGATIONS_MAX_ROWS = 64;

/**
 * The upper bound of the disclosed per-row text cap (codepoints).
 *
 * It is the SHARED projection's own per-row text cap
 * (`REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS`), so the disclosed cap can
 * never exceed the cap the projection applies — and a consumer that trusts
 * the disclosure knows the row text is at most this long.
 */
export const REVIEW_OBLIGATIONS_MAX_TEXT_CHARS = REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS;

export interface ReviewObligationsInput {
  /** The run's own review id; it pairs with `headSha` to name THIS review
   * of THIS head across reruns. */
  reviewId?: string | undefined;
  headSha: string;
  /** The review-obligation rows that blocked the review. The shared
   * projection filters them (forcing sources only, `unmet` only). */
  unresolvedReviewObligations?: readonly ReviewObligation[] | undefined;
  /** The byte budget for the WHOLE serialized document. Defaults to
   * `REVIEW_OBLIGATIONS_MAX_BYTES`. The publish layer lowers it when the
   * rest of the published body leaves less room, so the container never
   * pushes a body that would have fit over the forge's comment ceiling. */
  maxBytes?: number | undefined;
}

export interface ReviewObligations {
  schema: typeof REVIEW_OBLIGATIONS_SCHEMA;
  review_id: string;
  head_sha: string;
  /** The qualifying blocking rows this document carries — the COMPLETE set,
   * never a prefix of it. */
  unresolved_review_obligations: ReviewObligationRow[];
  /** The honest count of the qualifying blocking rows — the projection's
   * FULL count, never the listed length. */
  unresolved_review_obligations_total: number;
  /** Whether the published list is shorter than that count. It can only be
   * true when the row-COUNT publication bound binds. */
  unresolved_review_obligations_truncated: boolean;
  /** The effective per-row text cap in codepoints (0..300). A consumer
   * knows every row's text is at most this long. */
  unresolved_review_obligations_text_chars: number;
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
function serializeObligations(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** One row in the published shape, with the fixed key order
 * (`id`, `source`, `status`, `cause`, `text`) built by construction rather
 * than by the order the projection happened to use. */
function publishedRow(row: ReviewObligationRow): ReviewObligationRow {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    cause: row.cause,
    text: row.text,
  };
}

/**
 * Build the deterministic `review-obligations/v1` document (one line of
 * JSON), or `""` when the run has NO qualifying blocking row.
 *
 * No qualifying row means nothing to name, so no document is published at
 * all: the published body stays byte-identical to a run that never had a
 * blocking obligation.
 *
 * The byte bound is checked on the EXACT serialized string and is met by
 * SHORTENING every row's text — never by dropping a row. The serialized size
 * is monotone in the text cap (a longer cap can only lengthen the escaped
 * text), so the largest cap that still fits is found by a binary search over
 * `0..300`, and the document that is returned is the very string that was
 * measured.
 *
 * The complete row list is what makes this document answer #1521: a
 * controller can NAME every blocking row, and the effective text cap is
 * disclosed (`unresolved_review_obligations_text_chars`) so a consumer knows
 * how long a row's text may be. The count disclosure
 * (`unresolved_review_obligations_total` /
 * `unresolved_review_obligations_truncated`) covers the row-COUNT bound
 * only, which never binds for a real run.
 *
 * When even empty-text rows do not fit the budget, no document is published:
 * a container that could not carry the complete set would tell a controller
 * less than no container at all.
 */
export function buildReviewObligations(input: ReviewObligationsInput): string {
  // The SHARED projection, with the publication bound on the COUNT and the
  // shared per-row text cap: this document carries the COMPLETE set, so the
  // handoff's ten-row bound does not apply here. The rows are the same rows
  // the handoff and the local bundle project, so the three documents can
  // never disagree.
  const projection = boundedObligationRows(
    input.unresolvedReviewObligations,
    REVIEW_OBLIGATIONS_MAX_ROWS,
    REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS,
  );
  if (projection.rows.length === 0) return "";
  const maxBytes = Math.max(0, input.maxBytes ?? REVIEW_OBLIGATIONS_MAX_BYTES);
  const reviewId = boundedPublishedText(input.reviewId ?? "", REVIEW_HANDOFF_MAX_TOKEN_CHARS);
  const headSha = boundedPublishedText(input.headSha, REVIEW_HANDOFF_MAX_TOKEN_CHARS);
  const total = projection.total;
  // The truncation flag is computed from the LIST it describes, so the
  // measured string and the returned string are the same string.
  const truncated = projection.rows.length < total;
  const documentAt = (textChars: number): string => {
    // Only the TEXT depends on the cap: the row set (and the count) does
    // not, so the row list is the same at every cap.
    const rows = textChars === REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS
      ? projection.rows
      : boundedObligationRows(input.unresolvedReviewObligations, REVIEW_OBLIGATIONS_MAX_ROWS, textChars).rows;
    return serializeObligations({
      schema: REVIEW_OBLIGATIONS_SCHEMA,
      review_id: reviewId,
      head_sha: headSha,
      unresolved_review_obligations: rows.map(publishedRow),
      unresolved_review_obligations_total: total,
      unresolved_review_obligations_truncated: truncated,
      unresolved_review_obligations_text_chars: textChars,
    });
  };
  // The largest text cap whose serialized document still fits. The size is
  // monotone in the cap, so the search is exact.
  let low = 0;
  let high = REVIEW_OBLIGATIONS_MAX_TEXT_CHARS;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(documentAt(mid), "utf8") <= maxBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // Even empty-text rows do not fit: no document at all.
  if (best < 0) return "";
  return documentAt(best);
}

/**
 * Fail-closed parse of a review-obligations document: the exact schema
 * string, a non-empty `review_id`, a string `head_sha`, the row list, the two
 * disclosure counters and the disclosed text cap — or null. A consumer must
 * treat anything this refuses as absent.
 *
 * Every row goes through the SHARED row parser, so a row outside the
 * published vocabulary — a `derived` coverage row, a `satisfied` row, an
 * `unresolved` row, an unknown cause — refuses the WHOLE document rather
 * than being read as "an obligation that blocked the review".
 *
 * The counters are cross-checked against the list they carry with the SAME
 * rule the handoff and the local bundle use (`countersAgreeWithList`): a
 * total below the listed count, a total that disagrees with the list while
 * the document claims no truncation, and a truncation claim whose total
 * matches the list exactly are all contradictions, and a contradictory
 * document is refused.
 *
 * The disclosed text cap is checked too: it must be present, an integer in
 * `0..300`, and every row's text must be at most that many CODEPOINTS (not
 * UTF-16 units — an astral codepoint counts once). A document that lies
 * about its own bound is refused: the consumer would otherwise believe a
 * guarantee the document does not make.
 */
export function parseReviewObligations(text: string): ReviewObligations | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== REVIEW_OBLIGATIONS_SCHEMA) return null;
  if (typeof record.review_id !== "string" || record.review_id === "") return null;
  if (typeof record.head_sha !== "string") return null;
  if (!Array.isArray(record.unresolved_review_obligations)) return null;
  const rows: ReviewObligationRow[] = [];
  for (const raw of record.unresolved_review_obligations) {
    const row = parseObligationRow(raw);
    if (row === null) return null;
    rows.push(row);
  }
  const total = record.unresolved_review_obligations_total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return null;
  const truncated = record.unresolved_review_obligations_truncated;
  if (typeof truncated !== "boolean") return null;
  if (!countersAgreeWithList(rows.length, total, truncated)) return null;
  const textChars = record.unresolved_review_obligations_text_chars;
  if (typeof textChars !== "number" || !Number.isInteger(textChars)) return null;
  if (textChars < 0 || textChars > REVIEW_OBLIGATIONS_MAX_TEXT_CHARS) return null;
  for (const row of rows) {
    if (Array.from(row.text).length > textChars) return null;
  }
  return {
    schema: REVIEW_OBLIGATIONS_SCHEMA,
    review_id: record.review_id,
    head_sha: record.head_sha,
    unresolved_review_obligations: rows,
    unresolved_review_obligations_total: total,
    unresolved_review_obligations_truncated: truncated,
    unresolved_review_obligations_text_chars: textChars,
  };
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
export function renderReviewObligationsBlock(obligationsJson: string): string {
  const delimiter = fenceDelimiterFor(obligationsJson);
  return `${REVIEW_OBLIGATIONS_ANCHOR}\n${delimiter}json\n${obligationsJson}\n${delimiter}`;
}

/**
 * The CONSUMER-side parser: find the FIRST anchored block in a published
 * body and parse it.
 *
 * FIRST is the trust rule. The action renders the container in the
 * action-owned marker preamble, which precedes every model-authored surface
 * in the body, and the anchor is reserved against model markdown — so the
 * first occurrence is the action's own. A later model-authored copy can
 * never be mistaken for it. A body without an anchor has no obligations
 * document.
 *
 * The caller must additionally select the body by the FORGE-REPORTED AUTHOR
 * (the action's own posting identity) and the managed marker: a content
 * prefix alone is forgeable, because any reader of the repository can post
 * a look-alike comment.
 */
export function parseReviewObligationsBlock(body: string): ReviewObligations | null {
  if (typeof body !== "string") return null;
  const anchorAt = body.indexOf(REVIEW_OBLIGATIONS_ANCHOR);
  if (anchorAt === -1) return null;
  const lines = body.slice(anchorAt + REVIEW_OBLIGATIONS_ANCHOR.length).split(/\r\n|\n|\r/);
  // The anchor must end its line, then the fence opens, then the payload
  // sits on one line, then the closing fence is exactly the opener.
  if (lines[0] !== "") return null;
  const fence = /^(`{3,})json$/.exec(lines[1] ?? "");
  if (fence === null) return null;
  const delimiter = fence[1]!;
  if (lines[3] !== delimiter) return null;
  const payload = lines[2];
  if (payload === undefined) return null;
  return parseReviewObligations(payload);
}
