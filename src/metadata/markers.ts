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
 */
export const RESERVED_MARKER_PATTERNS: readonly RegExp[] = [
  /<!--\s*ai-pr-review-fingerprint\s*:\s*[^>]*-->/gi,
  /<!--\s*ai-pr-review-sha\s*:\s*[^>]*-->/gi,
];

/** Remove every reserved metadata marker from *text* (port of
 * `strip_reserved_markers`). Applied to model-produced markdown before any
 * action-owned marker is appended, so model output cannot forge the markers
 * the precheck and cleanup logic trust. */
export function stripReservedMarkers(text: string): string {
  let stripped = text;
  for (const pattern of RESERVED_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
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
    ci_state: context.ciState ?? null,
    tool_budget: context.toolBudget ?? null,
    tool_budget_source: context.toolBudgetSource ?? null,
    tool_calls: context.toolCalls ?? null,
    tool_rounds: context.toolRounds ?? null,
    max_rounds: context.maxRounds ?? null,
    context_budget: context.contextBudget ?? null,
    context_peak: context.contextPeak ?? null,
    action_version: av === "" ? null : av,
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
