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
 * `suggestion`. The boundary is the opener's own line, not the page: a
 * container prefix (`> `, `- `, `1. `, nested mixes) is peeled before this
 * pattern is applied, so the same rewrite applies behind a blockquote or a list
 * marker (#1112) — the prefix is preserved on the rewrite, and a reserved block
 * dissolves only against a closer inside the same blockquote and list depth.
 */
const SUGGESTION_OPENER_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*suggestion[ \t]*$/i;

/** Any fence-shaped line: optional whitespace, then a run of 3+ backticks or
 * tildes — an opener (with or without an info string), a closer, or a fence
 * too short to close the block it sits in. Loose on purpose: while a reserved
 * block is dissolving, every fence-shaped line inside it must be caught —
 * including behind a container prefix, so it is matched against the line's
 * CORE (#1112), never against the raw line. */
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
 * rewritten prose. `blockquotes` / `lists` / `contentColumn` (#1112) are the
 * container the opener sat in — only a closer inside the same one can end the
 * dissolution; they are 0 / 0 / 0 and unused for an ordinary block. */
interface FenceState {
  ch: string;
  minLength: number;
  dissolving: boolean;
  blockquotes: number;
  lists: number;
  contentColumn: number;
}

/** #1112: one line split at its container prefix — the leading blockquote and
 * list markers a renderer strips before it decides whether the rest opens a
 * fence. `container` is those exact bytes, in the order they appear. */
interface ContainerPrefix {
  /** The bytes consumed as a container prefix ("" when there is none). */
  container: string;
  /** The line without them — the fence, if any, lives here. */
  core: string;
  /** How many `>` markers were consumed. */
  blockquotes: number;
  /** How many list markers were consumed. */
  lists: number;
  /** Byte index at which a fence would start: `container.length`. */
  contentColumn: number;
}

const LIST_MARKER_RE = /^(?:[-+*]|\d{1,9}[.)])[ \t]/;
const LEADING_SPACE_RE = /^[ \t]*/;

/**
 * #1112: split a line into its container prefix and its content, consuming a
 * whitespace run then a blockquote marker (`>` after at most three of those
 * spaces, plus at most one space/tab) or a list marker (plus its space/tab),
 * in any order and any nesting, while a marker matches.
 *
 * Loose on purpose — fail-closed. A prefix this over-reads rewrites a line that
 * was never live, which is harmless; a prefix it misses leaves a prescription
 * the publish boundary never validated. The whitespace after the LAST marker is
 * left in `core` (only one space/tab of a `>`'s is consumed), so `> ` plus a
 * 4-space indent keeps today's over-indent reading — rewritten, never a real
 * fence — and a line with no marker returns `core` = the whole line, byte for
 * byte.
 */
function splitContainer(line: string): ContainerPrefix {
  let index = 0;
  let blockquotes = 0;
  let lists = 0;
  for (;;) {
    const rest = line.slice(index);
    const indent = LEADING_SPACE_RE.exec(rest)![0].length;
    const head = rest.slice(indent);
    let width: number;
    if (head.startsWith(">") && indent <= 3) {
      width = head[1] === " " || head[1] === "\t" ? 2 : 1;
      blockquotes += 1;
    } else {
      const list = LIST_MARKER_RE.exec(head);
      if (list === null) break;
      width = list[0].length;
      lists += 1;
    }
    index += indent + width;
  }
  if (index === 0) return { container: "", core: line, blockquotes: 0, lists: 0, contentColumn: 0 };
  return { container: line.slice(0, index), core: line.slice(index), blockquotes, lists, contentColumn: index };
}

/**
 * #1112: the closer of a dissolving reserved block must be the same fence
 * inside the SAME container, at the opener's content column. A fence that
 * drifted out of the container does not close a fenced block there — a lazy bare
 * fence cannot close one inside a blockquote, and a `- ``` ` opens a list item
 * of its own rather than closing a fence that started outside it — and treating
 * it as a closer would end the dissolution early and leave the real closer live,
 * where it captures everything the action appends next. Container depth is
 * therefore compared in full: a bare opener and a list-prefixed fence both sit
 * inside the first three columns, so column position alone cannot stand in for
 * it. Over-strict is the safe direction — any other fence-shaped line in the
 * region is escaped instead.
 */
function closesDissolving(prefix: ContainerPrefix, open: FenceState): boolean {
  if (prefix.blockquotes !== open.blockquotes) return false;
  if (prefix.lists !== open.lists) return false;
  const column = prefix.contentColumn + LEADING_SPACE_RE.exec(prefix.core)![0].length;
  if (column < open.contentColumn || column > open.contentColumn + 3) return false;
  return closesFence(prefix.core, open.ch, open.minLength);
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
 * nothing is deleted and a second pass is a no-op. #1112: it rewrites the
 * line's CORE; the caller re-prepends the container verbatim, so `> ``` `
 * becomes `> \`\`\` ` and a bare line is escaped exactly as before. */
function escapeFence(core: string): string {
  return core.replace(FENCE_SHAPED_RE, (_match, indent: string, run: string) =>
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
 * dissolved block pass through untouched, so benign code blocks are intact.
 *
 * #1112: the opener is matched on the line's CONTENT, behind any blockquote or
 * list container, and the prefix is preserved on the rewrite — `> ```suggestion`
 * renders a live prescription exactly as the bare spelling does, so leaving it
 * alone was the same hole one container over. Container awareness stops there:
 * only reserved openers and the lines inside a dissolving reserved block are
 * tracked container-aware, so benign container prose (`> ```ts`) stays
 * byte-identical and an ordinary block still closes the way it always did.
 *
 * #1136: an ordinary block still open at end of text — the model's unclosed
 * fence — is dissolved the same way, so no top-level fence is left open and
 * nothing appended after this pass (the validated prescription region) can be
 * swallowed as its content. (Dissolution matches fence-shaped lines
 * container-blind, exactly as ordinary-block tracking does: a `> ``` ` inside the
 * dissolved block stays as written, which is safe because CommonMark ends it with
 * its enclosing block construct and every appended region is introduced by a
 * column-0 blank line that closes that construct first.)
 *
 * That dissolution is fence-scoped: it only un-codes the unclosed block's own
 * lines (an HTML block, heading, or table inside it now renders live, which the
 * message field always was) and deletes nothing. Text without the token that
 * already ends fence-closed is returned byte-identically. Idempotent. */
export function reserveSuggestionOpeners(text: string): string {
  const out: string[] = [];
  let open: FenceState | null = null;
  // #1136: the output index of the line that opened the current ordinary
  // (non-reserved) block, so a block still open at end of text can be
  // dissolved from its opener onward.
  let openIndex = -1;
  // A CommonMark line ends at CR, LF, or CRLF — GitHub normalizes a lone CR
  // into a line break, so splitting on LF alone would hide a live opener
  // inside what this pass treats as one long line. Text that needs no
  // rewrite returns byte-identically from the fast path at the bottom, so
  // rejoining with LF only ever applies to text this pass actually edited.
  for (const line of text.split(/\r\n|\n|\r/)) {
    const prefix = splitContainer(line);
    const reserved = SUGGESTION_OPENER_RE.exec(prefix.core);
    if (open === null) {
      if (reserved !== null) {
        // The rewrite is loose (any indent, any container) so no spelling of
        // the opener survives; the dissolution it starts is strict, because
        // only a real fence (CommonMark indent, no open block) leaves a closer
        // behind that could capture what the action appends next.
        out.push(`${prefix.container}${reserved[1]!}suggestion`);
        const real = fenceOpener(prefix.core);
        if (real !== null) {
          open = {
            ch: real.ch,
            minLength: real.minLength,
            dissolving: true,
            blockquotes: prefix.blockquotes,
            lists: prefix.lists,
            contentColumn: prefix.contentColumn,
          };
        }
        continue;
      }
      const opener = fenceOpener(line);
      if (opener !== null) {
        // #1112: an ordinary block is tracked container-blind (blockquotes /
        // lists / contentColumn are unused for it), exactly as it always was —
        // `> ```ts` never opened a top-level fence. #1136 records where its
        // opener landed in the output so an unclosed one can be dissolved.
        open = { ...opener, dissolving: false, blockquotes: 0, lists: 0, contentColumn: 0 };
        openIndex = out.length;
      }
      out.push(line);
      continue;
    }
    if (reserved !== null) {
      // A reserved shape inside an open block is content there — the same
      // fail-closed rewrite the top-level opener gets — and never changes
      // which line closes the block we are already inside.
      out.push(`${prefix.container}${reserved[1]!}suggestion`);
      continue;
    }
    if (open.dissolving) {
      if (closesDissolving(prefix, open)) {
        out.push(prefix.container + escapeFence(prefix.core));
        open = null;
        continue;
      }
      out.push(FENCE_SHAPED_RE.test(prefix.core) ? prefix.container + escapeFence(prefix.core) : line);
      continue;
    }
    if (closesFence(line, open.ch, open.minLength)) open = null;
    out.push(line);
  }
  // #1136: an ORDINARY block still open at end of text is the model's
  // unclosed fence, and everything appended after this pass — the action's
  // validated prescription region in particular — would render as its
  // content. Policy, pinned: the walk dissolves it the same way a reserved
  // block is dissolved — its opener and every fence-shaped line inside it are
  // escaped, so no top-level fence is left open and the validated prescription
  // stays live. A block that IS closed never reaches this branch and its bytes
  // pass through untouched. (Container-nested fences inside the dissolved block
  // are matched container-blind, exactly as ordinary-block tracking is: they stay
  // as written and self-limit at the column-0 blank line that precedes every
  // appended region.)
  //
  // This must hold regardless of the `suggestion` token: a message whose
  // unclosed fence carries no token is exactly the shape where a validated
  // prescription on the same finding would be swallowed silently, so the
  // token-free fast path below only applies when the walk also ends
  // fence-closed.
  if (open !== null && !open.dissolving) {
    for (let index = openIndex; index < out.length; index += 1) {
      if (FENCE_SHAPED_RE.test(out[index]!)) out[index] = escapeFence(out[index]!);
    }
    return out.join("\n");
  }
  // Token-free text that already ends fence-closed is returned byte-identical
  // (CR/CRLF endings included); the pass would otherwise only normalize line
  // endings, which benign text must not pay for.
  if (open === null && !text.toLowerCase().includes("suggestion")) return text;
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
  /** #847: the tool loop's stop reason for the route the marker was built
   * from, recorded on every harness run so budget stops with complete
   * coverage stay visible (#810 measurement). */
  toolStopReason?: string;
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
    tool_stop_reason: context.toolStopReason ?? null,
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
