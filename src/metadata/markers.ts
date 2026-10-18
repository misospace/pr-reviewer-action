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
 * any fence length, case-insensitively and `\r`-tolerant, so no spelling of the
 * opener survives as a fence. The fence characters are dropped and the word
 * kept, so the author still reads `suggestion` and no fence is left to open —
 * and a body without the token is returned byte-identical.
 */
const SUGGESTION_OPENER_RE = /^([ \t]*)(?:`{3,}|~{3,})[ \t]*suggestion[ \t\r]*$/gim;

/** #1107: drop the fence from every model-authored prescription opener, keeping
 * the `suggestion` word. Idempotent, and a no-op on text with no opener. */
export function reserveSuggestionOpeners(text: string): string {
  if (!text.toLowerCase().includes("suggestion")) return text;
  SUGGESTION_OPENER_RE.lastIndex = 0;
  return text.replace(SUGGESTION_OPENER_RE, (_match, indent: string) => `${indent}suggestion`);
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
