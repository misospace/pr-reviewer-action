/**
 * Publication dispatcher (#680 port of `scripts/publish.sh` +
 * `scripts/publish_helpers.sh`).
 *
 * The model can run for minutes, so the publication-boundary head re-check
 * (#451) runs first: nothing — comment, blocking review, or approval — may
 * land against a head the model never saw. A superseded head skips the
 * publish silently; an undeterminable head fails closed.
 *
 * Publication failure must never be mistaken for a successful review: every
 * fatal path returns `status: "failed"` (the orchestrator turns that into a
 * step failure), and approval-specific failures surface the exact remediation
 * the v2 error text names.
 */
import { sanitizeMarkdown, stripReservedMarkers, stripEmptyConditionalSections, type ConditionalSectionPresence, type UpstreamLinkMode } from "./sanitize.js";
import { publicAnalysisEngine } from "../prompt/index.js";
import { ACTION_VERSION } from "../version.js";
import { buildComments, SEVERITY_LABELS } from "./inline-findings.js";
import { redactText } from "../context/redact.js";
import { buildRunMetadataMarker, emitReviewMarkers, type MarkerPreamble, type RunMarkerContext } from "../metadata/markers.js";
import { resolveSupersededThreads, cleanupManagedReviews, resolveCleanupFlag, type CleanupLog } from "./cleanup.js";
import { strictReviewResult } from "../enforcement/verdict-policy.js";
import { escapeTableCell } from "../gates/ci-wait.js";
import { COVERAGE_NOTICE_MAX_ITEMS, type PartialCoverage } from "../tools/coverage.js";
import { isIncompleteReason, type IncompleteReason } from "./outputs.js";
import type { NativeReviewComment, NativeReviewRequest, PublishPlatformApi } from "../platform/publish-api.js";

export type PublishMode = "comment" | "review_comment" | "review_verdict";
export type NativeReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PublishInput {
  mode: PublishMode;
  /** Raw model-produced review markdown (unsanitized). */
  reviewMarkdown: string;
  verdict: string;
  /** The configured `verdict_policy`. "strict" (the v3 default, #811) turns
   * on the derived review_result (clean/findings/partial/issues), the
   * findings + coverage-gap rendering at the top of the body, and the
   * verdict-line counts. Any other value (including undefined) keeps the
   * v2 body bytes and the binary clean/issues marker exactly as before. */
  verdictPolicy?: string;
  analysisEngine: string;
  baseSha: string;
  headSha: string;
  prNumber: string;
  commentMarker: string;
  broadFingerprint?: string;
  /** Required-checks validation status for the metadata marker. */
  requiredChecks: string;
  /** #954: why coverage is incomplete (see IncompleteReason). Absent means derive from requiredChecks/partialCoverage (legacy callers). */
  incompleteReason?: string;
  reviewRoute: string;
  escalationReason: string;
  cacheHitRatio: string;
  inlineFindings: boolean;
  inlineFindingsMax: number;
  /** Structured findings (parsed array or raw). */
  findings: unknown;
  cleanupPreviousNativeReviews: string;
  allowApprove: boolean;
  approveForks: boolean;
  /** Fork-ness from the precheck (fail-closed); null derives from the platform. */
  isForkPr: boolean | null;
  upstreamLinkMode: UpstreamLinkMode;
  /** Per-section presence for the #415 conditional-section backstop. v2
   * maps its four file signals onto these five keys: TOOL_HARNESS_PRESENT
   * drives both tool-harness sections (strip_empty_conditional_sections.py). */
  conditionalPresence: ConditionalSectionPresence;
  /** When set, removed after publish (the re-review label cleanup). */
  rerunLabel?: string;
  /** #812: folded external-CI conclusion at headSha ("success" | "failure"
   * | "pending" | "none"), recorded in the marker so the next diff-unchanged
   * skip can tell a stale carried request_changes from a live one. Omitted
   * when the caller did not read CI. */
  ciState?: string;
  /** Forgejo inline-comment position backend. */
  forgejoPositions: boolean;
  /** #810: deterministic partial-coverage record from the tool harness.
   * When set, the published body carries the coverage notice near the top
   * and the metadata marker records `coverage: partial` with the stop
   * reason. Presentation beyond this notice is #811's. */
  partialCoverage?: PartialCoverage;
  /** #873/#838: true when the caller could not determine the tool-loop
   * coverage state at all (the standalone `publish` CLI path: no explicit,
   * non-empty `PR_REVIEWER_RUN_DIR`, or its harness artifact was missing or
   * unreadable — never a fallback to the checkout). Distinct from
   * `partialCoverage` being absent (a confirmed-complete run): this means
   * publish could not confirm completeness, so it fails closed exactly like
   * a confirmed gap — see `markerReviewResult`. */
  coverageUnknown?: boolean;
  /** #847: the #810/#702 tool-loop request budget this run resolved, so the
   * size-scaled default can be measured from published reviews alone.
   * Omitted when no tool harness ran. */
  toolBudget?: number;
  /** #847: which source won ("primary-override" | "smart-override" |
   * "explicit" | "tier-default" | "size-scaled"). */
  toolBudgetSource?: string;
  /** #847: tool calls the loop actually executed against that budget. */
  toolCalls?: number;
  /** #895: loop rounds used, and the round cap they ran against. */
  toolRounds?: number;
  maxRounds?: number;
  /** #922: the loop's conversation budget and peak (approx tokens). */
  contextBudget?: number;
  contextPeak?: number;
}

export interface PublishResult {
  status: "published" | "superseded" | "failed";
  messages: string[];
  error?: string;
}

const VERDICT_PREFIXES: Record<string, string> = {
  request_changes: "⚠️ **Automated recommendation: REQUEST CHANGES**",
  approve: "✅ **Automated recommendation: APPROVE**",
};

/** (#873) The `comment`-mode header for an approve whose coverage is
 * incomplete: never "APPROVE", since the coverage notice right below it
 * says the review did not finish. */
const INCOMPLETE_COVERAGE_PREFIX = "🟡 **Automated recommendation: INCOMPLETE — not an approval**";
const TRACE_INCOMPLETE_PREFIX = "🟡 **Automated recommendation: APPROVAL WITHHELD — requirement trace incomplete**";
const BOTH_INCOMPLETE_PREFIX = "🟡 **Automated recommendation: APPROVAL WITHHELD — review coverage incomplete**";

/**
 * Sanitize model output: strip reserved metadata markers (the model can
 * never forge action-owned markers), neutralize upstream references, and
 * strip conditional sections the corpus never offered (#415 backstop).
 */
export function sanitizeForPublication(
  reviewMarkdown: string,
  linkMode: UpstreamLinkMode,
  presence: ConditionalSectionPresence,
): string {
  return stripEmptyConditionalSections(
    sanitizeMarkdown(stripReservedMarkers(reviewMarkdown), linkMode),
    presence,
  );
}

/** The metadata marker's review_result, shared by publish and the run
 * entry. Under verdict_policy=strict (#811): clean / findings / partial /
 * issues from the still-open findings and required-check coverage, with a
 * #810 tool-loop coverage gap also reported as `partial`. Any other policy
 * keeps the binary clean/issues v2 consumers rely on for `verdict:
 * request_changes` vs everything else, but (#873) still reports `partial`
 * rather than `clean` when required-check coverage is incomplete or the
 * tool loop stopped short — coverage honesty is not opt-in to a verdict
 * policy, only the findings-driven states (findings/clean vs issues) are.
 * `coverageUnknown` (#838: the standalone `publish` CLI could not confirm
 * the tool-loop coverage state at all) folds into the same `partial`
 * bucket — publish never reads "I couldn't check" as "it was clean". Since
 * #874, a known-`unmet` requirement trace is itself a required-check
 * coverage stop, so it lands in the same `partial` bucket under every
 * policy. */
export function markerReviewResult(input: {
  verdictPolicy?: string | undefined;
  verdict: string;
  findings?: unknown;
  requiredChecks: string;
  partialCoverage?: PartialCoverage | undefined;
  coverageUnknown?: boolean | undefined;
}): string {
  const coverageGap = Boolean(input.partialCoverage) || Boolean(input.coverageUnknown);
  const coverageIncomplete = input.requiredChecks === "incomplete" || coverageGap;
  if (input.verdictPolicy !== "strict") {
    if (input.verdict === "request_changes") return "issues";
    return coverageIncomplete ? "partial" : "clean";
  }
  const result = strictReviewResult(input.verdict, input.findings, input.requiredChecks);
  return coverageGap && result !== "issues" ? "partial" : result;
}

/** (#873) True when the review's own coverage signals say it did not
 * finish: `review_result` (the marker state computed by
 * `markerReviewResult`, above) is `partial`. This is the one gate every
 * publish mode and every verdict policy shares — an approve can never
 * publish as an approval while this is true, regardless of which policy
 * or layer produced the approve. */
export function reviewCoverageIncomplete(reviewResult: string): boolean {
  return reviewResult === "partial";
}

export function resolveIncompleteReason(input: {
  requiredChecks: string;
  incompleteReason?: string | undefined;
  partialCoverage?: PartialCoverage | undefined;
  coverageUnknown?: boolean | undefined;
}): IncompleteReason {
  const reason = isIncompleteReason(input.incompleteReason) ? input.incompleteReason : undefined;
  const trace = reason === "requirement_trace" || reason === "both";
  const execution = reason === "execution" || reason === "both"
    || (reason === undefined || reason === "none") && input.requiredChecks === "incomplete"
    || Boolean(input.partialCoverage)
    || Boolean(input.coverageUnknown);
  return execution && trace ? "both"
    : execution ? "execution"
    : trace ? "requirement_trace"
    : "none";
}

/** Build the published body: marker preamble + engine line + the optional
 * action-owned #810 coverage notice + the strict state block (#811, when
 * present) + sanitized review. Both blocks are inserted AFTER sanitization
 * (action-owned, never model text) so no stripping pass can drop them, and
 * sit near the top so a partial-coverage run cannot read as complete. */
export function buildPublishedBody(options: {
  markers: string;
  header?: string;
  note?: string;
  analysisEngine: string;
  sanitizedMarkdown: string;
  /** Rendered #810 tool-loop partial-coverage notice. */
  coverageNotice?: string;
  /** Rendered coverage-gap notice + findings summary for verdict_policy=strict. */
  stateBlock?: string | undefined;
  /** #915: defaults to the build-time stamp; explicit "" forces unstamped. */
  actionVersion?: string;
}): string {
  const lines = [options.markers];
  if (options.header) {
    lines.push(options.header, "");
  }
  if (options.note) {
    lines.push(options.note, "");
  }
  const actionVersion = options.actionVersion ?? ACTION_VERSION;
  const versionSuffix = actionVersion === "" ? "" : ` · pr-reviewer-action ${actionVersion}`;
  lines.push(`_Analysis engine: ${publicAnalysisEngine(options.analysisEngine)}${versionSuffix}_`, "");
  if (options.coverageNotice) {
    lines.push(options.coverageNotice, "");
  }
  if (options.stateBlock) {
    lines.push(options.stateBlock, "");
  }
  lines.push(options.sanitizedMarkdown);
  return `${lines.join("\n")}\n`;
}

/**
 * Fence-safe single-line code span for untrusted-derived text (changed-file
 * paths, specialist lead excerpts): backticks cannot be escaped inside a
 * code span, so they (and control characters) are replaced, and the length
 * is capped. Deterministic; biases toward rendering less rather than
 * letting hostile content break the section out.
 */
function escapeCodeSpan(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").replace(/[`]/g, "'");
  const stripped = [...singleLine].filter((ch) => ch.charCodeAt(0) >= 0x20).join("").trim();
  return stripped.length > maxChars ? stripped.slice(0, maxChars) + "…" : stripped;
}

/**
 * Render the #810 partial-coverage notice: a short, deterministic section
 * stating which changed files and specialist leads the tool loop never read
 * or resolved before a budget stopped it. Full presentation is #811's; this
 * only makes the gap impossible to miss (and impossible for a
 * partial-coverage review to pass as a plain clean approve).
 */
export function renderPartialCoverageNotice(coverage: PartialCoverage): string {
  const lines = [
    "## Partial Coverage Notice",
    "",
    `> **This review is incomplete.** The evidence-gathering tool loop stopped on its budget ` +
      `(\`${escapeCodeSpan(coverage.stop_reason, 80)}\`) before finishing.`,
  ];
  if (coverage.unread_files.length > 0) {
    const listed = coverage.unread_files.slice(0, COVERAGE_NOTICE_MAX_ITEMS);
    const more = coverage.unread_files.length - listed.length;
    lines.push(
      `> Changed files never read (${coverage.unread_files.length} of ` +
        `${coverage.changed_files_total}): ` +
        listed.map((path) => `\`${escapeCodeSpan(path, 200)}\``).join(", ") +
        (more > 0 ? `, … and ${more} more` : ""),
    );
  }
  if (coverage.unresolved_leads.length > 0) {
    const listed = coverage.unresolved_leads.slice(0, COVERAGE_NOTICE_MAX_ITEMS);
    const more = coverage.unresolved_leads.length - listed.length;
    const items = listed.map((lead) =>
      `\`${escapeCodeSpan(lead.role, 60)}\`` +
      (lead.file ? ` (\`${escapeCodeSpan(lead.file, 200)}\`)` : " (no file path)") +
      (lead.excerpt ? `: ${escapeCodeSpan(lead.excerpt, 120)}` : ""),
    );
    lines.push(
      `> Specialist leads never resolved (${coverage.unresolved_leads.length} of ` +
        `${coverage.leads_total}): ` +
        items.join("; ") +
        (more > 0 ? `; … and ${more} more` : ""),
    );
  }
  lines.push("> Absence of findings in the unread paths is not evidence they are safe.");
  return lines.join("\n");
}

/** Build inline review comments from structured findings against the diff.
 * `max` is clamped to at least 1 here (v2 clamps in main()); this is the one
 * clamp site so it cannot drift from `parseInlineFindingsMax`. */
export function buildInlineComments(options: {
  findings: unknown;
  diffText: string;
  max: number;
  forgejoPositions: boolean;
  linkMode: UpstreamLinkMode;
}): NativeReviewComment[] {
  const { comments } = buildComments(options.findings, options.diffText, Math.max(1, options.max), {
    forgejoPositions: options.forgejoPositions,
    linkMode: options.linkMode,
  });
  return comments as NativeReviewComment[];
}

/** Resolve the cleanup flag exactly like `resolve_cleanup_flag`. */
export { resolveCleanupFlag } from "./cleanup.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One rendered line for the outside-diff appendix — the same severity
 * label/category/redaction/sanitization discipline as `findingToBody`
 * (`./inline-findings.js`), minus the per-comment disclaimer, since this
 * renders as one bullet in a shared section rather than a standalone
 * comment. */
function renderOutsideDiffLine(finding: Record<string, unknown>, linkMode: UpstreamLinkMode): string {
  const severity = typeof finding.severity === "string" ? finding.severity : "info";
  const label = Object.hasOwn(SEVERITY_LABELS, severity) ? SEVERITY_LABELS[severity]! : severity;
  const category = finding.category;
  const suffix = category && category !== "other" ? ` (${String(category)})` : "";
  const message = String(finding.message || "").replace(/\s+/g, " ").trim();
  const prefix = finding.pre_existing === true ? "(pre-existing, outside this diff)" : "(outside this diff)";
  const line = `- **${label}${suffix}:** ${prefix} ${message}`;
  return sanitizeMarkdown(redactText(line), linkMode);
}

/**
 * Render an appendix for findings the deterministic outside-diff pass tagged.
 * Inline comments can never anchor these — the anchor line isn't in any
 * diff hunk — so without this section they would otherwise vanish from the
 * published review the moment the model's own prose doesn't happen to
 * mention them. Returns "" when there is nothing to render (no section is
 * added). v3-only, content-level: never touches verdict or any other
 * policy-relevant output.
 */
export function renderOutsideDiffSection(findings: unknown, linkMode: UpstreamLinkMode): string {
  if (!Array.isArray(findings)) return "";
  const flagged = findings.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.outside_diff === true,
  );
  if (flagged.length === 0) return "";
  const lines = flagged.map((finding) => renderOutsideDiffLine(finding, linkMode));
  return `\n\n## Findings Outside This Diff\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// #752 rendering, as adopted by #811: the normalized still-open findings and
// the coverage gap are rendered near the top of every review published under
// verdict_policy=strict, so an approve with findings never reads as clean.
// Opt-out policies keep today's bodies byte-for-byte.
// ---------------------------------------------------------------------------

/** Rows rendered before the visible "N more" cap keeps the body bounded
 * (50 findings of up to 2000 characters each would overrun a comment). */
export const FINDINGS_SUMMARY_MAX_ROWS = 50;

const SEVERITY_RANK = ["blocker", "major", "minor", "info"] as const;

/** Per-severity counts in rank order, zero entries omitted: `2 major, 4 minor`. */
export function severityCountsLabel(findings: unknown): string {
  if (!Array.isArray(findings)) return "";
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const severity = isRecord(finding) && typeof finding.severity === "string"
      ? finding.severity
      : "info";
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  const ordered = [
    ...SEVERITY_RANK.filter((severity) => counts.has(severity)),
    ...[...counts.keys()].filter((severity) => !(SEVERITY_RANK as readonly string[]).includes(severity)).sort(),
  ];
  return ordered.map((severity) => `${counts.get(severity)} ${severity}`).join(", ");
}

/** A path (model-controlled) as one bounded code span: whitespace collapsed
 * and fenced by a backtick run longer than any inside it, so it cannot open
 * markdown structure; pipes are escaped because GFM tables split cells even
 * inside code spans. */
function locationCell(finding: Record<string, unknown>): string {
  const file = typeof finding.file === "string" ? finding.file : "";
  const line = typeof finding.line === "number" && Number.isFinite(finding.line) ? String(finding.line) : "";
  if (file === "" && line === "") return "";
  const raw = file === "" ? line : line === "" ? file : `${file}:${line}`;
  const body = escapeTableCell(raw.replace(/\s+/g, " ").trim());
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1) + body + "`".repeat(longest + 1);
}

/**
 * The `### Findings (…)` section: one row per normalized still-open finding
 * — severity, `file:line` (or `file`, or blank), message — the same array
 * the verdict was decided on, so the body is the one place a reader sees the
 * whole set. Messages get redact_text, upstream-link neutralization,
 * whitespace collapse, a length cap, and table-cell escaping; a hostile
 * message cannot split the row or forge headings. Returns "" when there is
 * nothing to render.
 */
export function renderFindingsSummary(findings: unknown, linkMode: UpstreamLinkMode): string {
  if (!Array.isArray(findings)) return "";
  const rows = findings.filter((item): item is Record<string, unknown> => isRecord(item));
  if (rows.length === 0) return "";
  const counts = severityCountsLabel(rows);
  const lines = [
    `### Findings${counts ? ` (${counts})` : ""}`,
    "",
    "| Severity | Location | Finding |",
    "| --- | --- | --- |",
  ];
  for (const finding of rows.slice(0, FINDINGS_SUMMARY_MAX_ROWS)) {
    const rawSeverity = typeof finding.severity === "string" ? finding.severity : "info";
    const label = Object.hasOwn(SEVERITY_LABELS, rawSeverity) ? SEVERITY_LABELS[rawSeverity]! : rawSeverity;
    const message = escapeTableCell(
      sanitizeMarkdown(redactText(String(finding.message ?? "")), linkMode)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300),
    );
    lines.push(`| ${escapeTableCell(label)} | ${locationCell(finding)} | ${message} |`);
  }
  if (rows.length > FINDINGS_SUMMARY_MAX_ROWS) {
    lines.push("", `_…and ${rows.length - FINDINGS_SUMMARY_MAX_ROWS} more finding(s) not listed._`);
  }
  return `\n\n${lines.join("\n")}\n`;
}

/** The deterministic coverage-gap notice rendered above the findings, with
 * separate prose for execution incompleteness and requirement traceability. */
export function renderCoverageGapNotice(reason: string): string {
  const execution = "\n\n> **Partial coverage**: required-check coverage is incomplete — this review did not resolve every required check and must not be read as a complete pass.\n";
  const trace = "\n\n> **Requirement traceability gap**: the review itself completed, but one or more in-scope requirements could not be verified against enforcement or test evidence. Approval is withheld until that requirement is covered.\n";
  const both = "\n\n> **Partial coverage and requirement traceability gap**: required-check coverage is incomplete, and one or more in-scope requirements could not be verified against enforcement or test evidence. Approval is withheld until both gaps are addressed.\n";
  switch (reason === "incomplete" ? "execution" : reason) {
    case "execution": return execution;
    case "requirement_trace": return trace;
    case "both": return both;
    default: return "";
  }
}

/** The top-of-body state block for verdict_policy=strict: coverage gap first
 * (it qualifies the whole review), then the findings summary. */
function renderStrictStateBlock(options: {
  incompleteReason: string;
  findings: unknown;
  linkMode: UpstreamLinkMode;
}): string {
  return renderCoverageGapNotice(options.incompleteReason)
    + renderFindingsSummary(options.findings, options.linkMode);
}

/**
 * Evaluate the native approval guardrails: approval is opt-in
 * (`allow_approve`) and separately fork-gated (`approve_forks`). A clean
 * verdict withheld by a guardrail stays advisory — a blocking
 * REQUEST_CHANGES would invent an issue the model did not find. Missing
 * fork-ness fails closed (treated as a fork: approval needs approve_forks).
 */
export function evaluateApprovalGuardrails(options: {
  verdict: string;
  allowApprove: boolean;
  approveForks: boolean;
  isForkPr: boolean | null;
}): { canApprove: boolean; isForkPr: boolean | null } {
  if (options.verdict !== "approve" || !options.allowApprove) {
    return { canApprove: false, isForkPr: options.isForkPr };
  }
  const isFork = options.isForkPr ?? true;
  if (!isFork) return { canApprove: true, isForkPr: options.isForkPr };
  return { canApprove: options.approveForks, isForkPr: options.isForkPr };
}

/**
 * Submit the native review bound to the reviewed commit, attaching inline
 * comments when present. If the platform rejects the JSON payload (e.g. an
 * anchor raced a new push), fall back to the body-only review so publishing
 * never breaks because of inline findings or commit binding.
 */
export async function submitNativeReview(
  api: PublishPlatformApi,
  options: {
    event: NativeReviewEvent;
    body: string;
    commitId: string;
    comments: NativeReviewComment[];
  },
): Promise<{ ok: boolean; inlineCount: number; fellBack: boolean; error?: string }> {
  if (options.event !== "APPROVE" && options.event !== "REQUEST_CHANGES" && options.event !== "COMMENT") {
    return { ok: false, inlineCount: 0, fellBack: false, error: `Unsupported native review event: ${options.event}` };
  }
  const inlineCount = options.comments.length;
  const request: NativeReviewRequest = {
    body: options.body,
    event: options.event,
  };
  if (options.commitId !== "") {
    request.commit_id = options.commitId;
  }
  if (inlineCount > 0) {
    request.comments = options.comments;
  }
  const created = await api.createReview(request);
  if (created.ok) {
    return { ok: true, inlineCount, fellBack: false };
  }
  const plain = await api.createReview({ body: options.body, event: options.event });
  if (plain.ok) {
    return { ok: true, inlineCount, fellBack: true };
  }
  const error = plain.error ?? created.error;
  return error === undefined
    ? { ok: false, inlineCount, fellBack: true }
    : { ok: false, inlineCount, fellBack: true, error };
}

/** The approval-failure guidance the v2 publish step prints verbatim. */
export const APPROVAL_FAILURE_GUIDANCE = [
  "ERROR: Native approval failed.",
  "This may be caused by the 'Allow GitHub Actions to create and approve pull requests' setting being disabled.",
  "Enable this setting at: Repository Settings → Actions → General → Allow GitHub Actions to create and approve pull requests",
  "Or at the organization level: Organization Settings → Actions → Organization permissions → Allow GitHub Actions to create and approve pull requests",
];

/**
 * Publish the review. Runs the three v2 publish modes with the exact
 * ordering: sanitize → head re-check → per-mode cleanup/flag resolution →
 * sticky/native publication → optional inline findings → label cleanup.
 */
export async function publishReview(
  input: PublishInput,
  api: PublishPlatformApi,
  options: { diffText: string },
): Promise<PublishResult> {
  const messages: string[] = [];

  if (!input.prNumber) {
    return { status: "failed", messages, error: `publish_${input.mode} requires a pull_request event or explicit pr_number` };
  }

  // Publication-boundary head re-check (#451): fail closed.
  const currentHead = await api.getHeadSha();
  if (!currentHead) {
    return {
      status: "failed",
      messages,
      error: `Could not re-fetch the current head of the pull request; refusing to publish a potentially stale review.`,
    };
  }
  if (currentHead !== input.headSha) {
    messages.push(`A newer push superseded reviewed commit ${input.headSha}; not publishing this review.`);
    return { status: "superseded", messages };
  }

  // Sanitize model output first — the same pipeline for every mode. Any
  // outside-diff findings are appended as their own section: unlike inline
  // comments (which can only anchor in-diff findings), every publish mode
  // renders review_markdown, so this is the one place that never drops them.
  const sanitized = sanitizeForPublication(input.reviewMarkdown, input.upstreamLinkMode, input.conditionalPresence)
    + renderOutsideDiffSection(input.findings, input.upstreamLinkMode);
  // The marker's review_result. Under verdict_policy=strict (#811) it
  // distinguishes the non-blocking states (clean / findings / partial) from
  // issues, from the same still-open findings and coverage the strict
  // mapping decided the verdict on; a #810 tool-loop coverage gap is also
  // `partial`. Every other policy keeps the binary clean/issues consumers
  // rely on; the unchanged-diff carry-forward reads this field
  // (findings/partial carry an approve).
  const strict = input.verdictPolicy === "strict";
  const incompleteReason = resolveIncompleteReason(input);
  const reviewResult = markerReviewResult(input);
  const coverageNotice = input.partialCoverage ? renderPartialCoverageNotice(input.partialCoverage) : "";
  const markerContext: RunMarkerContext = {
    headSha: input.headSha,
    baseSha: input.baseSha,
    reviewResult,
    requiredChecks: input.requiredChecks,
    reviewRoute: input.reviewRoute,
    escalationReason: input.escalationReason,
    cacheHitRatio: input.cacheHitRatio,
    ...(incompleteReason !== "none" ? { incompleteReason } : {}),
    ...(input.ciState !== undefined && input.ciState !== "" ? { ciState: input.ciState } : {}),
    ...(input.toolBudget !== undefined ? { toolBudget: input.toolBudget } : {}),
    ...(input.toolBudgetSource !== undefined && input.toolBudgetSource !== "" ? { toolBudgetSource: input.toolBudgetSource } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.toolRounds !== undefined ? { toolRounds: input.toolRounds } : {}),
    ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    ...(input.contextBudget !== undefined ? { contextBudget: input.contextBudget } : {}),
    ...(input.contextPeak !== undefined ? { contextPeak: input.contextPeak } : {}),
    actionVersion: ACTION_VERSION,
  };
  if (input.partialCoverage) {
    // #810: the marker records partial coverage additively; a complete run
    // serializes byte-identically to the pre-#810 marker.
    markerContext.coverage = "partial";
    markerContext.coverageStopReason = input.partialCoverage.stop_reason;
  } else if (input.coverageUnknown) {
    // #873/#838: distinct from a confirmed #810 gap — the standalone
    // `publish` CLI had no explicit run dir (or an unreadable harness) and
    // so could not confirm coverage at all. No stop reason to report.
    markerContext.coverage = "unknown";
  }
  const metadataMarker = buildRunMetadataMarker(markerContext);
  const markers = emitReviewMarkers((() => {
    const preamble: MarkerPreamble = { commentMarker: input.commentMarker, metadataMarker };
    if (input.headSha) preamble.headSha = input.headSha;
    if (input.broadFingerprint) preamble.broadFingerprint = input.broadFingerprint;
    return preamble;
  })());

  // Structured findings → inline comments (both review modes, when enabled).
  let inlineComments: NativeReviewComment[] = [];
  if (input.mode !== "comment" && input.inlineFindings && input.findings !== undefined && input.findings !== null) {
    inlineComments = buildInlineComments({
      findings: input.findings,
      diffText: options.diffText,
      max: input.inlineFindingsMax,
      forgejoPositions: input.forgejoPositions,
      linkMode: input.upstreamLinkMode,
    });
  }

  // Cleanup of previous managed native reviews runs before anything new is
  // posted, in both native modes.
  if (input.mode !== "comment") {
    const flag = resolveCleanupFlag(input.cleanupPreviousNativeReviews, input.mode);
    if (flag === "true") {
      const cleanupLog: CleanupLog = (line) => messages.push(line);
      const managedIds = await cleanupManagedReviews(api, input.prNumber, input.commentMarker, cleanupLog);
      if (api.platform === "github") {
        await resolveSupersededThreads(api, managedIds, cleanupLog);
      } else {
        messages.push(`  NOTE: Skipping review-thread resolution (platform=${api.platform}; no GraphQL API)`);
      }
    }
  }

  try {
    if (input.mode === "comment") {
      // #752: counts where the verdict is stated, under the strict policy.
      const counts = strict ? severityCountsLabel(input.findings) : "";
      const suffix = counts ? ` · ${counts}` : "";
      // #873: an approve recommendation can never sit above a coverage
      // notice saying the review isn't finished — the header would
      // contradict the body directly below it.
      const prefix = (
        input.verdict === "approve" && reviewCoverageIncomplete(reviewResult)
          ? incompleteReason === "requirement_trace" ? TRACE_INCOMPLETE_PREFIX
            : incompleteReason === "both" ? BOTH_INCOMPLETE_PREFIX
            : INCOMPLETE_COVERAGE_PREFIX
          : (VERDICT_PREFIXES[input.verdict] ?? "✅ **Automated recommendation: APPROVE**")
      ) + suffix;
      const body = buildPublishedBody({
        markers,
        header: prefix,
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
        coverageNotice,
        stateBlock: strict
          ? renderStrictStateBlock({ incompleteReason, findings: input.findings, linkMode: input.upstreamLinkMode })
          : undefined,
      });
      const result = await api.upsertStickyComment(input.commentMarker, body);
      if (!result.ok) {
        return { status: "failed", messages, error: `sticky comment publication failed: ${result.error ?? "unknown error"}` };
      }
    } else if (input.mode === "review_comment") {
      const body = buildPublishedBody({
        markers,
        header: "# AI Automated Review",
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
        coverageNotice,
        stateBlock: strict
          ? renderStrictStateBlock({ incompleteReason, findings: input.findings, linkMode: input.upstreamLinkMode })
          : undefined,
      });
      const result = await api.upsertStickyComment(input.commentMarker, body);
      if (!result.ok) {
        return { status: "failed", messages, error: `sticky comment publication failed: ${result.error ?? "unknown error"}` };
      }
      // Best-effort inline findings as a separate COMMENT review carrying the
      // managed marker: the summary comment above is already published.
      if (inlineComments.length > 0) {
        const inlineBody = `${input.commentMarker}\n_Inline findings from the automated review (summary in the sticky comment)._`;
        const submitted = await api.createReview({ body: inlineBody, event: "COMMENT", comments: inlineComments });
        if (submitted.ok) {
          messages.push(`Attached ${inlineComments.length} inline finding comment(s)`);
        } else {
          messages.push("WARN: inline findings review submission failed; summary comment was still published");
        }
      }
    } else {
      // review_verdict
      const guardrails = evaluateApprovalGuardrails({
        verdict: input.verdict,
        allowApprove: input.allowApprove,
        approveForks: input.approveForks,
        isForkPr: input.isForkPr,
      });
      // #873: coverage incompleteness withholds approval independently of
      // the allow_approve/approve_forks guardrails and of which verdict
      // policy produced the approve — required-check coverage incomplete,
      // review_result=partial, or a #810 tool-loop coverage gap must never
      // reach a GitHub/Forgejo APPROVE event.
      const coverageIncomplete = reviewCoverageIncomplete(reviewResult);
      const canApprove = guardrails.canApprove && !coverageIncomplete;
      let body = buildPublishedBody({
        markers,
        header: "# AI Automated Review",
        note: "_Full PR review._",
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
        coverageNotice,
        stateBlock: strict
          ? renderStrictStateBlock({ incompleteReason, findings: input.findings, linkMode: input.upstreamLinkMode })
          : undefined,
      });
      if (input.verdict === "approve" && !canApprove) {
        if (!guardrails.canApprove) {
          // #752: a review with open findings or a coverage gap must not
          // call itself clean, even when its verdict is an approve.
          const advisory = reviewResult === "clean"
            ? "this clean review is advisory"
            : "this review is advisory rather than a clean approval — the findings and coverage notes above are informational";
          body += `\n> **Approval blocked by policy**: ${advisory}. Native approvals require \`allow_approve: true\` (and \`approve_forks: true\` for cross-repository PRs).\n`;
          messages.push(
            `Withholding native approval for #${input.prNumber} (allow_approve=${input.allowApprove}, approve_forks=${input.approveForks}, is_fork=${guardrails.isForkPr ?? input.isForkPr})`,
          );
        } else if (input.coverageUnknown) {
          // #873/#838: the standalone publish path had no explicit run dir
          // (or an unreadable harness artifact) and so could not confirm
          // whether the tool-loop investigation finished — fail closed
          // rather than guess it was clean.
          body += `\n> **Approval withheld**: this review's tool-loop coverage could not be verified (no run directory was available to confirm it), so it is publishing as an advisory comment rather than an approval.\n`;
          messages.push(`Withholding native approval for #${input.prNumber} (review coverage unknown)`);
        } else if (incompleteReason === "requirement_trace") {
          body += "\n> **Approval withheld**: the review completed, but an in-scope requirement lacks verifiable enforcement or test evidence, so it is publishing as an advisory comment rather than an approval.\n";
          messages.push(`Withholding native approval for #${input.prNumber} (requirement trace incomplete)`);
        } else if (incompleteReason === "both") {
          body += "\n> **Approval withheld**: this review has incomplete execution coverage and an in-scope requirement lacks verifiable enforcement or test evidence, so it is publishing as an advisory comment rather than an approval.\n";
          messages.push(`Withholding native approval for #${input.prNumber} (execution and requirement trace incomplete)`);
        } else {
          // #873: the guardrails would allow it, but the review's own
          // execution-coverage signals say it did not finish — fail closed
          // rather than publish an approval the metadata marker itself disputes.
          body += `\n> **Approval withheld**: this review's coverage is incomplete — required-check coverage or the tool-loop investigation did not finish, so it is publishing as an advisory comment rather than an approval.\n`;
          messages.push(`Withholding native approval for #${input.prNumber} (review coverage incomplete)`);
        }
      }
      const event: NativeReviewEvent = canApprove
        ? "APPROVE"
        : input.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
      if (canApprove) {
        messages.push(`Submitting native approval for #${input.prNumber}`);
      } else if (event === "REQUEST_CHANGES") {
        messages.push(`Submitting blocking findings for #${input.prNumber}`);
      }
      const submitted = await submitNativeReview(api, {
        event,
        body,
        commitId: input.headSha,
        comments: inlineComments,
      });
      if (submitted.fellBack) {
        messages.push("WARN: commit-bound review submission failed; falling back to plain review");
      }
      if (!submitted.ok) {
        if (event === "APPROVE") {
          for (const line of APPROVAL_FAILURE_GUIDANCE) messages.push(line);
          return { status: "failed", messages, error: `native approval failed for #${input.prNumber}` };
        }
        return { status: "failed", messages, error: `native review submission failed: ${submitted.error ?? "unknown error"}` };
      }
      messages.push(`Submitted native review (${event}) with ${submitted.inlineCount} inline comment(s)`);
    }
  } catch (error) {
    return {
      status: "failed",
      messages,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Re-review label cleanup: best-effort, never fails the run.
  if (input.rerunLabel) {
    await api.removeLabel(input.rerunLabel);
  }

  return { status: "published", messages };
}
