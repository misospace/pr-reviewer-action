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
 * - a byte bound checked on the exact serialized string, with omissions
 *   disclosed (`items_total` / `items_truncated`) rather than hidden.
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
  unresolved_required_checks: string[];
}

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
 */
export function buildReviewHandoff(input: ReviewHandoffInput): string {
  const candidates = findingsArray(input.findings).filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const requirementIds = boundedIdList(input.unresolvedRequirementIds);
  const checkIds = boundedIdList(input.unresolvedRequiredChecks);
  const serialize = (items: ReviewHandoffItem[], requirementIds: string[], checkIds: string[]): string => serializeHandoff({
    schema: REVIEW_HANDOFF_SCHEMA,
    review_id: bounded(input.reviewId ?? "", REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    head_sha: bounded(input.headSha, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    verdict: bounded(input.verdict, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    review_result: bounded(input.reviewResult, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    required_checks: bounded(input.requiredChecks, REVIEW_HANDOFF_MAX_TOKEN_CHARS),
    items,
    items_total: candidates.length,
    items_truncated: items.length < candidates.length,
    unresolved_requirement_ids: requirementIds,
    unresolved_required_checks: checkIds,
  });

  // The document without any item is the base the disclosure rides on. The
  // bounded id lists alone can still exceed the cap (twenty four-byte
  // codepoint ids per list), so the base itself is shrunk before any item is
  // admitted: the LAST ids of the LONGER list are dropped one at a time
  // (requirements first on a tie) until the zero-item document fits. The
  // empty-list base is far below the cap, so the loop always terminates —
  // and the cap holds on the exact serialized string in every input.
  let baseRequirementIds = requirementIds;
  let baseCheckIds = checkIds;
  while (Buffer.byteLength(serialize([], baseRequirementIds, baseCheckIds), "utf8") > REVIEW_HANDOFF_MAX_BYTES
    && (baseRequirementIds.length > 0 || baseCheckIds.length > 0)) {
    if (baseRequirementIds.length >= baseCheckIds.length && baseRequirementIds.length > 0) {
      baseRequirementIds = baseRequirementIds.slice(0, -1);
    } else {
      baseCheckIds = baseCheckIds.slice(0, -1);
    }
  }

  const included: ReviewHandoffItem[] = [];
  if (Buffer.byteLength(serialize(included, baseRequirementIds, baseCheckIds), "utf8") <= REVIEW_HANDOFF_MAX_BYTES) {
    for (const candidate of candidates.slice(0, REVIEW_HANDOFF_MAX_ITEMS)) {
      const item = handoffItem(candidate, input.publishedPrescriptions);
      const next = serialize([...included, item], baseRequirementIds, baseCheckIds);
      if (Buffer.byteLength(next, "utf8") > REVIEW_HANDOFF_MAX_BYTES) break;
      included.push(item);
    }
  }
  return serialize(included, baseRequirementIds, baseCheckIds);
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
 * Fail-closed parse of a handoff document: the exact schema string and the
 * exact member types, or null. A consumer must treat anything this refuses
 * as absent.
 *
 * The counters are cross-checked, not just typed: a document that claims
 * fewer items than it lists, or that claims no truncation while its total
 * disagrees with the list it carries, is contradictory and refused. An
 * empty `review_id` is refused too — a handoff that cannot name its review
 * names nothing (the bundle's parser refuses the same).
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
  const items: ReviewHandoffItem[] = [];
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
  return {
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
    unresolved_required_checks: [...record.unresolved_required_checks],
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
