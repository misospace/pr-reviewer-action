/**
 * Managed metadata markers for publication (#680).
 *
 * The action-owned markers are the seam between runs: the sticky-comment
 * marker drives managed-comment cleanup, the metadata marker carries the
 * carry-forward verdict (#674), and the head-sha/fingerprint markers feed the
 * precheck. Model output can never forge them: `stripReservedMarkers` runs on
 * every model-produced markdown before it is wrapped in a published body, so
 * a prompt-injected marker is stripped before the action appends its own.
 *
 * Build/parse primitives live in `src/precheck/metadata.ts` (ported for
 * #674); this module is the publication-side boundary that composes them
 * with the marker emission discipline from `scripts/publish_helpers.sh`.
 */
import { DEFAULT_MANAGED_MARKER } from "../context/pr-thread.js";
import { buildMetadataMarker, parseMetadata, type MetadataOptions } from "../precheck/metadata.js";

export { buildMetadataMarker, parseMetadata };
export type { MetadataOptions };

/**
 * Reserved internal marker patterns, case-insensitive — the verbatim port of
 * `scripts/strip_metadata_markers.py`'s `RESERVED_PATTERNS`. These two marker
 * forms are action-owned state (`ai-pr-review-sha`, `ai-pr-review-fingerprint`);
 * a model must never be able to emit them into a published body, because the
 * precheck scans comment bodies for them (skip-on-unchanged, carry-forward).
 * The patterns stop at the first `>` so they cannot swallow past `-->`.
 *
 * This list is the *removal* half of the reserved-grammar boundary; #1107's
 * prescription opener is the other half (`reserveSuggestionOpeners`), which is a
 * rewrite rather than a removal and so lives beside `stripReservedMarkers`.
 */
export const RESERVED_MARKER_PATTERNS: readonly RegExp[] = [
  /<!--\s*ai-pr-review-fingerprint\s*:\s*[^>]*-->/gi,
  /<!--\s*ai-pr-review-sha\s*:\s*[^>]*-->/gi,
  // #762: the rejection carry marker is action-owned state — model markdown
  // can never carry it into a published body (digest forgery is
  // withhold-only, but reserved is reserved).
  /<!--\s*pr-reviewer:rejected-prescriptions\s*:[^>]*-->/gi,
  // #1027: finding identity is action-owned state and model markdown cannot forge it.
  /<!--\s*pr-reviewer:finding-id\s*:[^>]*-->/gi,
];

/**
 * #1107: the reserved prescription opener — a fence line whose info string is
 * exactly `suggestion`. GitHub renders that as a live one-click prescription
 * over model prose, and the publish boundary never validated it:
 * `publishablePrescription` in `src/publish/inline-findings.ts` is the only
 * producer of one we ever publish. A second opener inside a comment of ours
 * also makes `recoverPublishedSuggestion` bail ("several openers"), so that
 * comment's real prescription becomes permanently uncorrelatable and a trusted
 * 👎 on it can never suppress the replacement it reviewed (fail-open).
 *
 * Reserved the same way the carry-marker grammar is: on every model-authored
 * surface, on the text that is finally rendered, before the action appends
 * anything of its own. Matched at any indent, with either fence character and
 * any fence length, case-insensitively, across CR / LF / CRLF line endings —
 * GitHub normalizes a lone CR into a line break, so a spelling that only
 * renders as an opener after that normalization must be caught too. The fence
 * characters are dropped and the word kept, so the author still reads
 * `suggestion`. (The boundary is line-initial, unprefixed openers; a marker
 * prefix like a blockquote `>` around one is tracked as a follow-up.)
 */
const SUGGESTION_OPENER_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*suggestion[ \t]*$/i;

/** Any fence-shaped line: optional whitespace, then a run of 3+ backticks or
 * tildes — an opener (with or without an info string), a closer, or a fence
 * too short to close the block it sits in. Loose on purpose: while a reserved
 * block is dissolving, every fence-shaped line inside it must be caught. */
const FENCE_SHAPED_RE = /^([ \t]*)(`{3,}|~{3,})/;

/**
 * The closing fence of an open block, CommonMark-accurate: up to three spaces
 * of indentation, the same character, at least the opening length, and nothing
 * but whitespace after. Stricter than loose here is what fails closed —
 * treating an indented content line as the closer would end the dissolution
 * early and let a later fence of the block survive live.
 */
function closesFence(core: string, ch: string, minLength: number): boolean {
  return new RegExp(`^ {0,3}\\${ch}{${minLength},}[ \\t]*$`).test(core);
}

/** One fenced-code block the scanner is inside of. `dissolving` marks a block
 * that began at a RESERVED opener: its fence characters are gone from the
 * output, so the block no longer exists in the rendered text and every other
 * fence-shaped line inside it would otherwise become a live fence in the
 * rewritten prose. */
interface FenceState {
  ch: string;
  minLength: number;
  dissolving: boolean;
}

/**
 * Classify a line as a fenced-code opener, CommonMark-accurate: up to three
 * spaces of indentation (a tab or a 4-space indent makes the line an indented
 * code block, not a fence), and an info string on a backtick fence may not
 * itself contain a backtick. Only a REAL opener may start or close tracking —
 * misreading an indented code line as a fence would hide a following reserved
 * opener inside a phantom block and leave its closer live.
 */
function fenceOpener(core: string): { ch: string; minLength: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(core);
  if (match === null) return null;
  const ch = match[1]![0]!;
  if (ch === "`" && match[2]!.includes("`")) return null;
  return { ch, minLength: match[1]!.length };
}

/** Backslash-escape the fence characters of a line inside a dissolved block:
 * the line stops being a fence (it no longer starts with a fence character)
 * while still rendering the characters the author wrote. A pure rewrite, so
 * nothing is deleted and a second pass is a no-op. */
function escapeFence(line: string): string {
  return line.replace(FENCE_SHAPED_RE, (_match, indent: string, run: string) =>
    indent + [...run].map((ch) => `\\${ch}`).join(""),
  );
}

/** #1107: drop the fence from every model-authored prescription opener, keeping
 * the `suggestion` word — and dissolve the rest of that block, so the rewrite
 * cannot leave a fence behind. Rewriting only the opener would turn its
 * closing fence (and any other fence-shaped line inside the block) into a live
 * plain-fence opener in the rendered prose, which captures everything the
 * action appends afterward — including the one prescription this action DID
 * validate. So the pass walks the original fence structure: while a reserved
 * block is dissolving, its closer and every fence-shaped line inside it are
 * escaped (`\`\`\`` renders as text and opens nothing); fences outside a
 * dissolved block pass through untouched, so benign code blocks are intact and
 * text without the token is returned byte-identically. Idempotent. */
export function reserveSuggestionOpeners(text: string): string {
  if (!text.toLowerCase().includes("suggestion")) return text;
  const out: string[] = [];
  let open: FenceState | null = null;
  // A CommonMark line ends at CR, LF, or CRLF — GitHub normalizes a lone CR
  // into a line break, so splitting on LF alone would hide a live opener
  // inside what this pass treats as one long line. Only token-bearing text
  // reaches this pass (the early return above keeps token-free text
  // byte-identical), so rejoining with LF loses nothing the boundary cares
  // about and makes the output uniform for the passes that follow.
  for (const line of text.split(/\r\n|\n|\r/)) {
    const reserved = SUGGESTION_OPENER_RE.test(line);
    const opener = reserved ? null : fenceOpener(line);
    if (open === null) {
      if (reserved) {
        // The rewrite is loose (any indent) so no spelling of the opener
        // survives; the dissolution it starts is strict, because only a real
        // fence (CommonMark indent, no open block) leaves a closer behind
        // that could capture what the action appends next.
        const real = fenceOpener(line);
        out.push(`${line.match(SUGGESTION_OPENER_RE)![1]!}suggestion`);
        if (real !== null) open = { ch: real.ch, minLength: real.minLength, dissolving: true };
        continue;
      }
      if (opener !== null) open = { ch: opener.ch, minLength: opener.minLength, dissolving: false };
      out.push(line);
      continue;
    }
    if (reserved) {
      // A reserved shape inside an open block is content there — the same
      // fail-closed rewrite the top-level opener gets — and never changes
      // which line closes the block we are already inside.
      out.push(`${line.match(SUGGESTION_OPENER_RE)![1]!}suggestion`);
      continue;
    }
    if (open.dissolving) {
      if (closesFence(line, open.ch, open.minLength)) {
        out.push(escapeFence(line));
        open = null;
        continue;
      }
      out.push(FENCE_SHAPED_RE.test(line) ? escapeFence(line) : line);
      continue;
    }
    if (closesFence(line, open.ch, open.minLength)) open = null;
    out.push(line);
  }
  // A reserved block still open at end of text left no closer behind: its
  // opener is gone and nothing inside it was left a fence, so the output ends
  // fence-closed by construction.
  return out.join("\n");
}

/** Remove every reserved metadata marker from *text* (port of
 * `strip_reserved_markers`), and reserve the prescription opener #1107 adds to
 * the same reserved-grammar boundary. Applied to model-produced markdown before
 * any action-owned marker is appended, so model output can neither forge the
 * markers the precheck and cleanup logic trust nor present a prescription this
 * action never validated. */
export function stripReservedMarkers(text: string): string {
  let stripped = text;
  for (const pattern of RESERVED_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    stripped = stripped.replace(pattern, "");
  }
  // #1107: reserve the opener LAST, on the text that is actually rendered.
  // Removing a marker can leave what it sat next to: a model that writes
  // `<!-- ai-pr-review-fingerprint:x -->```suggestion` on one line passes an
  // opener check that ran first and is left with a live one-click prescription
  // the moment the marker next to it is removed. Scanning the final string can
  // only ever catch less, never more, and no earlier transform here can
  // manufacture a fence the published body would not have shown us.
  return reserveSuggestionOpeners(stripped);
}

/** The bare legacy prefix reviews created by older action versions carry. */
export const LEGACY_MANAGED_PREFIX = "<!-- ai-pr-reviewer";

/**
 * Managed-review identity: a body is action-owned when it STARTS with the
 * configured marker or the legacy prefix. Matching is by content, never by
 * author — the posting identity can change across token types (#190).
 */
export function isManagedBody(body: string, marker: string = DEFAULT_MANAGED_MARKER): boolean {
  const text = body ?? "";
  return text.startsWith(marker) || text.startsWith(LEGACY_MANAGED_PREFIX);
}

export interface RunMarkerContext {
  /** PR head SHA this review is bound to ("unknown" when absent). */
  headSha: string;
  baseSha: string;
  /** "clean" | "issues" — the resolved review result. */
  reviewResult: string;
  /** "complete" | "incomplete" | "none" | "" — omitted when empty/none. */
  requiredChecks?: string;
  /** Omitted when empty or "legacy". */
  reviewRoute?: string;
  /** Comma-separated escalation reasons; omitted when empty. */
  escalationReason?: string;
  /** Cache-hit-ratio step output; "-" or empty means absent. */
  cacheHitRatio?: string;
  /** #810: "partial" when the tool loop stopped on a budget with changed
   * files / specialist leads it never read; omitted for complete coverage. */
  coverage?: string;
  /** #810: the loop stop reason behind coverage: partial. */
  coverageStopReason?: string;
  /** #954: why coverage is incomplete ("execution" | "requirement_trace" | "both"); omitted when complete. */
  incompleteReason?: string;
  /** #812: folded external-CI conclusion at the reviewed head; omitted when
   * CI was not read so complete runs keep their pre-#812 marker bytes. */
  ciState?: string;
  /** #847: the #810/#702 tool-loop request budget this run resolved
   * (resolveToolMaxRequests()'s `budget`), omitted when no tool harness ran. */
  toolBudget?: number;
  /** #847: the #810/#702 budget provenance ("primary-override" |
   * "smart-override" | "explicit" | "tier-default" | "size-scaled"). */
  toolBudgetSource?: string;
  /** #847: tool calls the loop actually executed against that budget. */
  toolCalls?: number;
  /** #895: rounds the loop actually used against `maxRounds` (see
   * `adaptiveLoopBudgets` in src/tools/loop.ts). */
  toolRounds?: number;
  /** #895: the resolved round cap the loop ran against for this run. */
  maxRounds?: number;
  /** #922: the loop's conversation budget and peak (approx tokens). */
  contextBudget?: number;
  contextPeak?: number;
  /** #915 build-time stamp; ""/unset means unstamped and is omitted. */
  actionVersion?: string;
  /** #978: true when the final verdict is eligible for the gate bypass. */
  degradedGateBypass?: boolean;
}

/**
 * Build the metadata marker exactly as `build_metadata_marker` does in
 * `scripts/publish_helpers.sh` (jq -nc): fixed key order, conditional keys,
 * `escalation_reason` as a split array, `cache_hit_ratio` as a number.
 * A non-numeric cache-hit ratio fails closed (jq's `tonumber` would abort
 * the v2 publish under `set -e`; silently dropping the field here would
 * publish a marker the precheck cannot trust).
 */
export function buildRunMetadataMarker(context: RunMarkerContext): string {
  const checks = context.requiredChecks ?? "";
  const route = context.reviewRoute ?? "";
  const esc = context.escalationReason ?? "";
  const chr = context.cacheHitRatio ?? "";
  const cov = context.coverage ?? "";
  const covStop = context.coverageStopReason ?? "";
  const incompleteReason = context.incompleteReason ?? "";
  const av = context.actionVersion ?? "";
  let cacheHitRatio: number | null = null;
  if (chr !== "" && chr !== "-") {
    const parsed = Number(chr);
    if (!Number.isFinite(parsed)) {
      throw new Error(`metadata marker: cache_hit_ratio is not a number: ${JSON.stringify(chr)}`);
    }
    cacheHitRatio = parsed;
  }
  return buildMetadataMarker({
    head_sha: context.headSha || "unknown",
    base_sha: context.baseSha,
    review_result: context.reviewResult,
    required_checks: checks === "" || checks === "none" ? null : checks,
    review_route: route === "" || route === "legacy" ? null : route,
    escalation_reason: esc === "" ? null : esc.split(","),
    cache_hit_ratio: cacheHitRatio,
    coverage: cov === "" ? null : cov,
    coverage_stop_reason: covStop === "" ? null : covStop,
    incomplete_reason: incompleteReason === "" || incompleteReason === "none" ? null : incompleteReason,
    ci_state: context.ciState ?? null,
    tool_budget: context.toolBudget ?? null,
    tool_budget_source: context.toolBudgetSource ?? null,
    tool_calls: context.toolCalls ?? null,
    tool_rounds: context.toolRounds ?? null,
    max_rounds: context.maxRounds ?? null,
    context_budget: context.contextBudget ?? null,
    context_peak: context.contextPeak ?? null,
    action_version: av === "" ? null : av,
    degradedGateBypass: context.degradedGateBypass === true ? true : null,
  });
}

export interface MarkerPreamble {
  commentMarker: string;
  metadataMarker: string;
  headSha?: string;
  broadFingerprint?: string;
}

/**
 * Emit the managed marker preamble for a published body: the sticky marker,
 * the metadata marker, and (when set) the head-sha and fingerprint markers.
 * Missing required markers throw — the v2 `:${VAR:?}` guard exists so a
 * refactor that forgets to set them fails loudly instead of publishing an
 * unmatchable comment that cleanup and skip-on-unchanged depend on.
 */
export function emitReviewMarkers(preamble: MarkerPreamble): string {
  if (!preamble.commentMarker) {
    throw new Error("emit_review_markers: COMMENT_MARKER must be set");
  }
  if (!preamble.metadataMarker) {
    throw new Error("emit_review_markers: METADATA_MARKER must be set");
  }
  const lines = [preamble.commentMarker, preamble.metadataMarker];
  if (preamble.headSha) {
    // The value is the PR head SHA (a git commit hash), not a fingerprint.
    lines.push(`<!-- ai-pr-review-sha:${preamble.headSha} -->`);
  }
  if (preamble.broadFingerprint) {
    lines.push(`<!-- ai-pr-review-fingerprint:${preamble.broadFingerprint} -->`);
  }
  return `${lines.join("\n")}\n`;
}
