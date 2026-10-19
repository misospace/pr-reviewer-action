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
import {
  buildComments, hasPublishablePrescription, INLINE_DISCLAIMER, parseRejectionCarryover, prescriptionKey,
  prescriptionKeyDigest, recoverPublishedSuggestion, MAX_CARRYOVER_KEYS_PER_RUN, SEVERITY_LABELS,
} from "./inline-findings.js";
import { redactText } from "../context/redact.js";
import { buildRunMetadataMarker, emitReviewMarkers, isManagedBody, type MarkerPreamble, type RunMarkerContext } from "../metadata/markers.js";
import { resolveSupersededThreads, cleanupManagedReviews, resolveCleanupFlag, retireManagedInlineComments, resolvePublishTrustedOwner, selectManagedReviews, minimizeSupersededAdvisoryReviews, type CleanupLog } from "./cleanup.js";
import { ownerMatchesIdentity } from "../platform/owner-identity.js";
import { strictReviewResult } from "../enforcement/verdict-policy.js";
import { escapeTableCell } from "../gates/ci-wait.js";
import { COVERAGE_NOTICE_MAX_ITEMS, type PartialCoverage } from "../tools/coverage.js";
import { isIncompleteReason, renderFindingsSummary, severityCountsLabel, MAX_REVIEW_TRIAGE_REASON_CHARS, type IncompleteReason } from "./outputs.js";
import { resolveReviewTriageDecision } from "../model/triage.js";
import type { HumanReviewRoutingPlan } from "../routing/human-review-routing.js";
import { MAX_FEEDBACK_COMMENT_IDS } from "../platform/publish-api.js";
import type { CollaboratorPermissionReading, NativeReviewComment, NativeReviewRequest, NativeReviewSurface, PublishPlatformApi } from "../platform/publish-api.js";

export type PublishMode = "comment" | "review_comment" | "review_verdict" | "review_blockers";
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
  /** #1161: DEPRECATED and inert. The input stays accepted for backward
   * compatibility, but it gates nothing and changes no published event —
   * it is read only to warn the operator that it no longer has an effect. */
  allowApprove?: boolean;
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
  /** #978: whether the final verdict may bypass fail-on-request-changes. */
  degradedGateBypass?: boolean;
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
  /** #847 measurement follow-up: the tool loop's stop reason, recorded on
   * every harness run so budget stops with complete coverage stay visible in
   * published markers. Omitted when no harness reported one. */
  toolStopReason?: string;
  /** #1003: the human-review triage answer, present ONLY when triage ran
   * (`review-triage` enabled) and the review produced one. Absent means
   * "did not run" and renders no section — never a silent "not required". */
  reviewTriage?: { decision: string; reason: string };
  /** #1005: the deterministic reviewer-routing plan, present ONLY when
   * routing ran. Its `status` is action-owned; `users`/`teams` come only from
   * trusted base-ref configuration. The publish step performs the reviewer
   * request only for `status: "request"`. */
  reviewRouting?: HumanReviewRoutingPlan;
}

export interface PublishResult {
  status: "published" | "superseded" | "failed";
  messages: string[];
  error?: string;
}

const VERDICT_PREFIXES: Record<"approve" | "request_changes", string> = {
  request_changes: "⚠️ **Automated recommendation: REQUEST CHANGES**",
  approve: "✅ **Automated recommendation: APPROVE**",
};

/** (#1161) The header for a run that produced no valid verdict: neither
 * `approve` nor `request_changes`. It must never read as an approval
 * recommendation — a missing or invalid verdict is a failed run, not a
 * clean review. */
const NO_VERDICT_PREFIX = "🟡 **Automated recommendation: NO VERDICT**";

/** (#1161) The only two verdicts that can carry a native review event. A
 * missing or invalid verdict is neither an approval nor a blocking
 * request. */
export function isValidPublishVerdict(verdict: string): verdict is "approve" | "request_changes" {
  return verdict === "approve" || verdict === "request_changes";
}

/** (#1161) The publish modes whose authoritative published body lives in a
 * PR review rather than a sticky comment. The precheck reads the previous
 * run's published body from PR reviews for these modes: a sticky comment
 * would not carry the verdict, so the mode's own publication would be
 * invisible to the next run's fingerprint and carry-forward. (`review_comment`
 * also posts a native review, but only for inline findings — its
 * authoritative body is the sticky comment.) */
export function isNativeVerdictMode(mode: string): boolean {
  const value = (mode ?? "").toLowerCase();
  return value === "review_verdict" || value === "review_blockers";
}

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
  // The model echoes diff lines: redact on the published body, not only on
  // finding messages. Redaction last so markdown escaping cannot re-expose
  // a redacted span; redactText is idempotent on its own marker. Redaction
  // also runs first so escaping cannot split a secret shape before the outer
  // pass sees it (idempotent either way).
  return redactText(
    stripEmptyConditionalSections(
      sanitizeMarkdown(stripReservedMarkers(redactText(reviewMarkdown)), linkMode),
      presence,
    ),
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
 * `markerReviewResult`, above) is `partial`. #1145 changed what this gates:
 * in `review_verdict` it no longer downgrades a valid verdict's native event
 * — the publish mode is authoritative. It still drives the comment-mode
 * header (an approve recommendation never headers as APPROVE over an
 * unfinished review) and the #1145 approval-with-gaps body note, and it keeps
 * marking the marker/telemetry `partial` for every consumer. */
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
 * present) + the optional #1003 human-review triage section + sanitized
 * review. Every block is action-owned and inserted AFTER sanitization (never
 * model text) so no stripping pass can drop them, and they sit near the top
 * so a partial-coverage run cannot read as complete. */
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
  /** #1003: rendered human-review triage section (only when triage ran). */
  triageBlock?: string | undefined;
  /** #1005: rendered reviewer-routing section (only when routing ran and the
   * status carries a decision). */
  routingBlock?: string | undefined;
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
  if (options.triageBlock) {
    lines.push(options.triageBlock, "");
  }
  if (options.routingBlock) {
    lines.push(options.routingBlock, "");
  }
  lines.push(options.sanitizedMarkdown);
  return `${lines.join("\n")}\n`;
}

/** #1003: the three literal triage decisions live with the other publish-layer
 * triage constants in outputs.js, so the published body and the step summary
 * validate against one set. */

const REVIEW_TRIAGE_LABELS: Record<string, string> = {
  not_required: "no specialized human review required",
  required: "specialized human review required",
  unknown: "unknown — the reviewer could not determine this",
};

/**
 * #1003: the compact human-review triage section. Action-owned prose (never
 * model text), rendered only when triage ran, and it carries the reason for
 * ALL three decisions — `unknown` in particular must be visible rather than
 * read as "nothing to do". The reason is model-authored, so it takes the same
 * discipline as every other untrusted string on this surface: redaction,
 * link sanitization, whitespace flattening, a length cap and pipe escaping,
 * none of which can break out of the blockquote line.
 */
export function renderReviewTriageBlock(
  triage: { decision: string; reason: string },
  linkMode: UpstreamLinkMode,
): string {
  const decision = resolveReviewTriageDecision(triage.decision, triage.reason);
  const reason = escapeTableCell(
    sanitizeMarkdown(redactText(String(triage.reason ?? "")), linkMode).replace(/\s+/g, " ").trim().slice(0, MAX_REVIEW_TRIAGE_REASON_CHARS),
  );
  const label = REVIEW_TRIAGE_LABELS[decision]!;
  const line = reason === ""
    ? `> **Human review triage: ${label}**`
    : `> **Human review triage: ${label}** — ${reason}`;
  const lines = [
    "## Human Review Triage",
    "",
    line,
    ">",
    "_Advisory only: this triage answer does not change the review's verdict or findings, and it requests no reviewer._",
  ];
  return lines.join("\n");
}

/** #1005: labels for the reviewer-routing statuses that render a section.
 * `off`/`not_required`/`no_targets` render nothing (there is nothing to
 * report), so a common triage-enabled run's published body stays compact. */
const REVIEW_ROUTING_LABELS: Record<string, string> = {
  invalid: "invalid selection — no reviewer requested",
  advisory: "advisory — no reviewer requested",
  requested: "configured reviewers requested",
  request_failed: "reviewer request failed",
  fork_blocked: "blocked on a fork pull request — no reviewer requested",
};

/** A single-line code span for a trusted-config value; no `@` so an advisory
 * block never pings a reviewer that was not actually requested. */
function routingCodeSpan(value: string, maxChars: number): string {
  return escapeCodeSpan(value, maxChars);
}

/**
 * #1005: the compact reviewer-routing section. Every value is action-owned
 * (the status label) or trusted base-ref configuration (the logical target ids
 * and the concrete reviewers) — model text never appears here, and the model
 * cannot name a concrete identity. Rendered only for statuses that carry a
 * decision (invalid/advisory/requested/request_failed/fork_blocked).
 */
export function renderReviewRoutingBlock(routing: HumanReviewRoutingPlan): string {
  const label = REVIEW_ROUTING_LABELS[routing.status];
  if (label === undefined) return "";
  const targets = routing.targetIds.map((id) => routingCodeSpan(id, 120)).join(", ");
  const reviewers: string[] = [
    ...routing.users.map((user) => routingCodeSpan(user, 60)),
    ...routing.teams.map((team) => routingCodeSpan(`team:${team}`, 120)),
  ];
  const lines = ["## Reviewer Routing", "", `> **Reviewer routing: ${label}**`];
  if (targets !== "") {
    lines.push(">", `> Configured target(s): ${targets}`);
  }
  if (reviewers.length > 0) {
    lines.push(">", `> Reviewer(s): ${reviewers.join(", ")}`);
  }
  lines.push(">", "_Advisory: reviewer routing never changes the review's verdict or findings, and concrete reviewers come only from trusted repository configuration._");
  return lines.join("\n");
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
 * #588: the platform's native-review degradation reason, flattened to one
 * bounded line. It is rendered inside a blockquote notice and inside a step
 * message, so a reason carrying a newline (or an unbounded length) could
 * break out of the notice or flood the log. A platform-owned constant today;
 * this keeps a future one from becoming a rendering hole.
 */
function flattenSurfaceReason(reason: string | undefined): string {
  const flat = (reason ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "this platform has no native pull-review surface";
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
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
 * clamp site so it cannot drift from `parseInlineFindingsMax`. #762:
 * `rejectedPrescriptions` holds the digests of already-rejected prescriptions
 * and drops only the replacement block of a matching finding (the finding
 * itself always posts); `suppressed` counts how many were dropped. */
export function buildInlineComments(options: {
  findings: unknown;
  diffText: string;
  max: number;
  forgejoPositions: boolean;
  linkMode: UpstreamLinkMode;
  rejectedPrescriptions?: ReadonlySet<string>;
}): { comments: NativeReviewComment[]; suppressed: number } {
  const { comments, suppressed } = buildComments(options.findings, options.diffText, Math.max(1, options.max), {
    forgejoPositions: options.forgejoPositions,
    linkMode: options.linkMode,
    ...(options.rejectedPrescriptions === undefined ? {} : { rejectedPrescriptions: options.rejectedPrescriptions }),
  });
  return { comments: comments as NativeReviewComment[], suppressed };
}

/** #762: the bound on the distinct reaction logins this run will verify. Each
 * login costs one collaborator request and the logins arrive from untrusted
 * reaction data, so the count is capped: past the cap this run verifies nobody
 * and trusts no rejection (fail-open) instead of letting drive-by reactors
 * drive the run's own request budget. */
export const FEEDBACK_ACTOR_CAP = 20;

/** #762: the trusted-actor bar for a 👎 suppression — the same bar the
 * comment-command re-review applies (#914, `src/precheck/decide.ts:170-184`),
 * duplicated rather than imported so the publish seam takes no dependency on
 * the precheck policy module: the repository permission levels that authorize
 * triage-or-higher, plus the un-collapsed `role_name` that is the only proof
 * when a forge collapses GitHub `triage`/`maintain` into `permission: "read"`.
 * Everything else — `read`, `none`, and any unrecognized value — fails
 * closed. */
const FEEDBACK_AUTHORIZED_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
  "owner",
]);

/** #762: `role_name` values that prove triage-or-higher behind a collapsed
 * `read` permission. Custom roles are deliberately not authorized — an
 * unrecognizable role cannot prove the bar. */
const FEEDBACK_AUTHORIZED_ROLE_NAMES: ReadonlySet<string> = new Set([
  "triage",
  "triage_plus",
]);

/** #762: the fail-closed authorization decision for one reaction actor. A
 * null reading (lookup error, non-200, no usable permission), an unusable or
 * mismatched response subject, and any permission below the bar are all "not
 * trusted" — an untrusted reaction stays telemetry. */
function feedbackActorAuthorized(reading: CollaboratorPermissionReading | null, login: string): boolean {
  if (reading === null) return false;
  if (reading.subject === "unusable") return false;
  if (reading.subject === "named" && reading.subjectLogin !== login.toLowerCase()) return false;
  if (FEEDBACK_AUTHORIZED_PERMISSIONS.has(reading.permission)) return true;
  return reading.permission === "read" && FEEDBACK_AUTHORIZED_ROLE_NAMES.has(reading.roleName);
}

interface RejectionSnapshot {
  /** Digests of the prescriptions a trusted actor has rejected (directly, or
   * through a carry marker this action itself published). */
  keys: ReadonlySet<string>;
  /** How many prior comments carrying a recoverable prescription were read. */
  inspected: number;
  /** How many distinct actors reacted with a negative reaction. */
  logins: number;
  /** How many of those actors passed the trusted-actor gate. */
  trusted: number;
  /** How many distinct actors exceeded the verification cap and were therefore
   * never looked up. */
  overCap: number;
  /** How many rejection digests were inherited from carry markers this
   * action's own prior comments published, rather than from live reactions. */
  carried: number;
}

/** #762: read the usefulness feedback for the prescriptions a previous run
 * published, and turn trusted 👎 into the keys of the prescriptions they
 * reject.
 *
 * The whole read is FAIL-OPEN: any thrown error, an unsupported forge, an
 * incomplete enumeration, or an incomplete reaction read contributes no
 * reaction-derived key, i.e. exactly today's behavior (every prescription is
 * posted). The bot-self exclusion, however, is REQUIRED PROOF: if the
 * authenticated identity cannot be resolved (absent seam, thrown read, or a
 * non-login result), no reaction can be distinguished from the bot's own, so
 * nobody is authorized from reactions — a fail-open read with fail-closed
 * trust. Nothing here can skip, resolve, retire, or de-duplicate a finding,
 * and nothing can change the verdict. Reaction logins and comment bodies are
 * never returned, rendered, or logged — only counts are.
 *
 * DURABLE CARRY (review round on #1101): the reaction lives on the comment
 * cleanup retires, so a rejection read from reactions alone lasts exactly one
 * re-review. The prior run therefore embeds the SHA-256 digest of each
 * suppressed prescription key in a hidden HTML carry marker on the
 * replacement comment it publishes. A carry marker is trusted only with
 * provenance: a top-level comment of a marker-managed review whose author
 * matches the trusted owner identity the retirement path itself proves —
 * never a body from an actor this run cannot authenticate. Its effect remains
 * withhold-only: digest matching can drop a replacement block and nothing
 * else. The marker grammar is reserved against model-authored content (the
 * carry line is stripped from every assembled finding body and listed among
 * the reserved publication markers), so a rejection can only ever originate
 * from a trusted 👎 this action itself observed. */
async function readRejectedPrescriptions(
  api: PublishPlatformApi,
  marker: string,
): Promise<RejectionSnapshot> {
  const none: RejectionSnapshot = { keys: new Set<string>(), inspected: 0, logins: 0, trusted: 0, overCap: 0, carried: 0 };
  if (typeof api.reviewCommentFeedback !== "function" || typeof api.collaboratorPermission !== "function") return none;
  try {
    const reviews = await api.listReviews();
    // Same managed-review derivation the cleanup path uses (marker-prefixed
    // bodies, never author matching).
    const reviewIds = selectManagedReviews(reviews, marker, []).map((review) => review.id);
    if (reviewIds.length === 0) return none;
    const listed = await api.listManagedInlineComments(reviewIds);
    if (!listed.supported || !listed.complete) return none;
    const candidates: Array<{ id: string; key: string }> = [];
    const carried = new Set<string>();
    // The carry-marker authority is resolved lazily and at most once, and
    // only because some comment actually carries a marker to authenticate.
    let carryOwner: Awaited<ReturnType<typeof resolvePublishTrustedOwner>>["owner"] | undefined;
    for (const comment of listed.comments) {
      const id = String(comment.id ?? "");
      if (!/^[1-9]\d*$/.test(id)) continue;
      // A reply inherits its parent review's id, so only a TOP-LEVEL comment
      // of ours can carry the prescription region this action published — and
      // equally, only a top-level comment can carry its rejection marker.
      if (comment.in_reply_to_id != null || comment.inReplyToId != null) continue;
      const body = typeof comment.body === "string" ? comment.body : "";
      // Same own-comment shape proof the prescription recovery demands: the
      // disclaimer trailer must be present before any line is read as state.
      const digests = body.includes(INLINE_DISCLAIMER) ? parseRejectionCarryover(body) : [];
      if (digests.length > 0) {
        if (carryOwner === undefined) carryOwner = (await resolvePublishTrustedOwner(api)).owner;
        // Provenance, not body text: the marker counts only on a comment
        // this run can prove its own identity published. Unprovable author,
        // unprovable identity — the marker carries nothing.
        if (carryOwner !== null && ownerMatchesIdentity(comment.user ?? null, carryOwner)) {
          for (const digest of digests) {
            if (carried.size >= MAX_CARRYOVER_KEYS_PER_RUN) break;
            carried.add(digest);
          }
        }
      }
      const path = comment.path;
      // A published range is reported with its END as `line` and its start as
      // `start_line`: reconstruct the exact range the key describes, and skip
      // the comment rather than guess when any part of it is unusable.
      const end = comment.line;
      if (typeof path !== "string" || path === "" || typeof end !== "number" || !Number.isInteger(end) || end <= 0) continue;
      const start = comment.start_line ?? end;
      if (!Number.isInteger(start) || start <= 0 || start > end) continue;
      // Only our own previously published suggestion region is parsed; an
      // unrecoverable one simply carries no prior prescription.
      const replacement = recoverPublishedSuggestion(body);
      if (replacement === null) continue;
      candidates.push({ id, key: prescriptionKeyDigest(prescriptionKey(path, start, end, replacement)) });
    }
    if (candidates.length === 0) {
      // Carry-only survival: the reacted-to comment was retired and only a
      // replacement comment's marker remains — no reaction request is needed.
      if (carried.size === 0) return none;
      return { keys: new Set(carried), inspected: 0, logins: 0, trusted: 0, overCap: 0, carried: carried.size };
    }
    // Newest first, so the bounded read covers the comments most likely to
    // still be on screen.
    candidates.sort((a, b) => (a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    const bounded = candidates.slice(0, MAX_FEEDBACK_COMMENT_IDS);
    const feedback = await api.reviewCommentFeedback(bounded.map((candidate) => candidate.id));
    if (!feedback.supported || !feedback.complete) {
      return carried.size === 0 ? none : { keys: new Set(carried), inspected: 0, logins: 0, trusted: 0, overCap: 0, carried: carried.size };
    }
    const rejections = feedback.records.filter((record) => record.content === "-1");
    const distinct = [...new Set(rejections.map((record) => record.login))].filter((login) => login !== "");
    // Untrusted reaction data must never control the request budget: past the
    // cap, verify nobody and trust no rejection (carried digests need no
    // lookup and keep standing).
    if (distinct.length > FEEDBACK_ACTOR_CAP) {
      return { keys: new Set(carried), inspected: bounded.length, logins: distinct.length, trusted: 0, overCap: distinct.length, carried: carried.size };
    }
    const keys = new Set(carried);
    let trusted = 0;
    let self: string | null = null;
    let selfResolved = false;
    for (const login of distinct) {
      if (!selfResolved) {
        selfResolved = true;
        // Resolved at most once, and only because there is at least one
        // distinct reacting login to authorize. An absent seam, a thrown
        // read, or a non-login result makes the bot-self exclusion
        // unprovable, so nobody is authorized from reactions.
        try {
          const identity = typeof api.authenticatedIdentity === "function"
            ? await api.authenticatedIdentity()
            : null;
          self = typeof identity === "string" && identity.trim() !== "" ? identity : null;
        } catch { self = null; }
        if (self === null) {
          return { keys: new Set(carried), inspected: bounded.length, logins: distinct.length, trusted: 0, overCap: 0, carried: carried.size };
        }
      }
      // The bot's own reaction is never a rejection signal — it is the
      // publisher of the prescription, not a reviewer of it.
      if (self !== null && self.trim().toLowerCase() === login.toLowerCase()) continue;
      let reading: CollaboratorPermissionReading | null;
      try { reading = await api.collaboratorPermission(login); }
      catch { reading = null; }
      if (!feedbackActorAuthorized(reading, login)) continue;
      trusted += 1;
      for (const record of rejections) {
        if (record.login !== login) continue;
        const prior = bounded.find((candidate) => candidate.id === record.commentId);
        if (prior !== undefined) keys.add(prior.key);
      }
    }
    return { keys, inspected: bounded.length, logins: distinct.length, trusted, overCap: 0, carried: carried.size };
  } catch {
    return none;
  }
}

/** Resolve the cleanup flag exactly like `resolve_cleanup_flag`. */
export { resolveCleanupFlag } from "./cleanup.js";
export { renderFindingsSummary, severityCountsLabel, FINDINGS_SUMMARY_MAX_ROWS } from "./outputs.js";

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

/** The deterministic coverage-gap notice rendered above the findings, with
 * separate prose for execution incompleteness and requirement traceability. */
export function renderCoverageGapNotice(reason: string): string {
  const execution = "\n\n> **Partial coverage**: required-check coverage is incomplete — this review did not resolve every required check and must not be read as a complete pass.\n";
  const trace = "\n\n> **Requirement traceability gap**: the review itself completed, but one or more in-scope requirements could not be verified against enforcement or test evidence. This review must not be read as a clean pass until that requirement is covered.\n";
  const both = "\n\n> **Partial coverage and requirement traceability gap**: required-check coverage is incomplete, and one or more in-scope requirements could not be verified against enforcement or test evidence. This review must not be read as a clean pass until both gaps are addressed.\n";
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
 * Evaluate the native approval guardrails (#1161): the final verdict
 * decides whether an approval is possible at all, and the cross-repository
 * scope policy (`approve_forks`) decides whether it is allowed. The
 * deprecated `allow_approve` input no longer gates anything. Missing
 * fork-ness fails closed (treated as a fork: approval needs
 * approve_forks). A clean verdict withheld by the scope policy stays
 * advisory — a blocking REQUEST_CHANGES would invent an issue the model
 * did not find.
 */
export function evaluateApprovalGuardrails(options: {
  verdict: string;
  approveForks: boolean;
  isForkPr: boolean | null;
}): { canApprove: boolean; scopeBlocked: boolean; verdictAllowsApproval: boolean; isForkPr: boolean | null } {
  const verdictAllowsApproval = options.verdict === "approve";
  const isFork = options.isForkPr ?? true;
  const scopeBlocked = verdictAllowsApproval && isFork && !options.approveForks;
  return {
    canApprove: verdictAllowsApproval && !scopeBlocked,
    scopeBlocked,
    verdictAllowsApproval,
    isForkPr: options.isForkPr,
  };
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
): Promise<{ ok: boolean; inlineCount: number; fellBack: boolean; error?: string; reviewId?: number | string }> {
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
    return { ok: true, inlineCount, fellBack: false, ...(created.reviewId !== undefined ? { reviewId: created.reviewId } : {}) };
  }
  const plain = await api.createReview({ body: options.body, event: options.event });
  if (plain.ok) {
    return { ok: true, inlineCount, fellBack: true, ...(plain.reviewId !== undefined ? { reviewId: plain.reviewId } : {}) };
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
  // #588: the platform's native pull-review surface, read ONCE for the whole
  // publication. An ABSENT capability (an untyped caller, an `as unknown as`
  // cast) keeps the historical behavior — the platform is assumed to have a
  // native review surface — while a platform that DECLARES no native surface
  // takes the managed-record path: the review body is published as the
  // platform's managed top-level record, no native approval, blocking
  // request, or inline comment is created, and the degradation is stated
  // explicitly in the body and in the step messages.
  const nativeSurface: NativeReviewSurface = api.nativeReviewSurface ?? { supported: true };
  if (api.nativeReviewSurface === undefined) {
    // #588: an undeclared capability is an untyped caller. The historical
    // behavior is kept (the platform is assumed to have a native review
    // surface), but the gap is reported: a platform that FORGOT to declare
    // the capability must not fail silently.
    messages.push("WARN: the publish platform did not declare a native review surface; assuming it has one");
  }
  // #1161: `allow-approve` is deprecated and inert — it changes no
  // published event. It is read here only to tell the operator that the
  // input no longer has an effect. `undefined` means the operator never
  // set it; an explicit value (true OR false) warns, because an operator
  // who set it to "false" to suppress approvals has to learn that the
  // input no longer does that.
  if (input.allowApprove !== undefined) {
    messages.push(`WARN: 'allow-approve' is deprecated and no longer affects publication (value: ${input.allowApprove}); use 'publish-mode: review_verdict' to publish the verdict, or 'publish-mode: review_blockers' for blockers-only behavior.`);
  }
  let nativeReviewId: number | string | undefined;
  // #1093: the sticky summary comment as the replacement checkpoint when
  // review_comment mode publishes no inline findings review (a clean re-review
  // must not emit an empty native "Inline findings" review just to anchor
  // cleanup). The PATCH/POST response timestamp anchors it.
  let stickyCommentId: number | string | undefined;
  let stickyUpdatedAt: string | undefined;
  // #1093: the exact sticky body this run published — the checkpoint's
  // body anchor, so a same-second re-publication by an overlapping run
  // (refreshed timestamp equal to the checkpoint) with a DIFFERENT body
  // cannot pass for this run's own sticky state.
  let stickyBody: string | undefined;
  // #1093: the sticky is a complete replacement only when the run had no
  // inline findings to post or that findings review was actually created;
  // a failed findings submission leaves the previous set un-replaced.
  let stickyCheckpointUsable = true;

  if (!input.prNumber) {
    return { status: "failed", messages, error: `publish_${input.mode} requires a pull_request event or explicit pr_number` };
  }

  // Publication-boundary head re-check (#451): fail closed.
  const currentHead = await api.getHeadSha();
  if (!currentHead) {
    // #588: a platform that knows WHY the current head is unavailable (it
    // has no trustworthy current-head source) says so; a platform whose read
    // simply failed keeps the generic wording. The native path's wording is
    // unchanged.
    const headReason = api.currentHeadUnavailableReason;
    return {
      status: "failed",
      messages,
      error: headReason === undefined || headReason === ""
        ? `Could not re-fetch the current head of the pull request; refusing to publish a potentially stale review.`
        : `Could not determine the current head of the pull request: ${headReason}. Refusing to publish a potentially stale review.`,
    };
  }
  if (currentHead !== input.headSha) {
    messages.push(`A newer push superseded reviewed commit ${input.headSha}; not publishing this review.`);
    return { status: "superseded", messages };
  }

  // #1005: perform the additive reviewer request for a "request" plan. Runs
  // only after the head-sha guard, so a stale review never requests a
  // reviewer. The boundary re-checks the plan's own invariants rather than
  // trusting a carried-forward artifact: the mode must itself be `request`,
  // and a fork PR (or an unknown fork state, `null`) never mutates. A failure
  // is surfaced clearly and never substitutes another reviewer; it does not
  // fail the review publication (the request is auxiliary, and the published
  // section reports the outcome).
  let reviewRouting = input.reviewRouting;
  if (reviewRouting && reviewRouting.status === "request") {
    if (reviewRouting.mode === "request" && input.isForkPr === false) {
      const request = await api.requestReviewers(reviewRouting.users, reviewRouting.teams);
      if (request.ok) {
        const sent = [
          ...request.requestedUsers,
          ...request.requestedTeams.map((team) => `team:${team}`),
        ];
        const already = [
          ...request.alreadyRequestedUsers,
          ...request.alreadyRequestedTeams.map((team) => `team:${team}`),
        ];
        messages.push(
          `Reviewer routing: requested ${sent.length > 0 ? sent.join(", ") : "(none new)"}`
          + (already.length > 0 ? `; already requested: ${already.join(", ")}` : ""),
        );
        reviewRouting = { ...reviewRouting, status: "requested" };
      } else {
        messages.push(`WARN: reviewer routing failed (${request.supported ? "request" : "unsupported platform"}): ${request.error ?? "unknown error"}`);
        reviewRouting = { ...reviewRouting, status: "request_failed" };
      }
    } else {
      // A carried-forward/tampered artifact claims a request while its mode is
      // not `request` or the PR is a fork/unknown: refuse to mutate and report
      // the inconsistency rather than a phantom request.
      messages.push("WARN: reviewer routing plan is inconsistent at the publish boundary; no reviewer was requested");
      reviewRouting = { ...reviewRouting, status: "invalid" };
    }
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
  // #588: the platform's degradation reason, flattened to ONE bounded line:
  // it is rendered inside a blockquote notice and inside a step message, so
  // a reason carrying a newline could otherwise break out of both.
  const surfaceReason = flattenSurfaceReason(nativeSurface.reason);
  // #588: the structured findings this run carries. On a platform WITHOUT a
  // native review surface they have no native channel (no inline review
  // comments), so the published body is the only place they can reach the
  // reader — the count drives the explicit degradation note.
  const findingCount = Array.isArray(input.findings) ? input.findings.length : 0;
  /** The deterministic state section of the body.
   *
   * Under the strict policy (#811) it is the coverage-gap notice plus the
   * findings table. On a platform WITHOUT a native review surface the
   * findings table is published even under a non-strict policy — but only
   * for the modes whose forge counterpart publishes the findings as native
   * inline review comments (`review_comment`, `review_verdict`,
   * `review_blockers`). There the body is the only remaining channel, so
   * the findings are never silently dropped (#588) — within the findings
   * table's own bounds (at most 50 rows; the overflow is disclosed in the
   * body, exactly as the strict policy discloses it). The `comment` mode
   * publishes no findings natively on any platform, so it compensates
   * nothing and its body is unchanged.
   * `platformNotice` is the action-owned notice for such a platform; it
   * precedes the untrusted review text so no model content can swallow it. */
  const stateSection = (platformNotice = "", compensateFindings = true): string | undefined => {
    const parts: string[] = [];
    if (platformNotice !== "") parts.push(platformNotice);
    if (strict) {
      parts.push(renderStrictStateBlock({ incompleteReason, findings: input.findings, linkMode: input.upstreamLinkMode }));
    } else if (!nativeSurface.supported && compensateFindings) {
      parts.push(renderFindingsSummary(input.findings, input.upstreamLinkMode));
    }
    return parts.length === 0 ? undefined : parts.join("");
  };
  /** #588: what this publication IS on this platform. A forge with a comment
   * surface publishes a comment; a platform without a native review surface
   * publishes a managed review record. Only the non-native wording differs —
   * the native path's bytes are unchanged. */
  const advisoryNoun = nativeSurface.supported ? "advisory comment" : "advisory review record";
  // #1003: rendered only when triage ran; the three modes share the one
  // block so a triage answer can never differ by publish mode.
  const triageBlock = input.reviewTriage ? renderReviewTriageBlock(input.reviewTriage, input.upstreamLinkMode) : "";
  // #1005: rendered only when routing ran and the status carries a decision.
  const routingBlock = reviewRouting ? renderReviewRoutingBlock(reviewRouting) : "";
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
    degradedGateBypass: input.degradedGateBypass === true,
    ...(input.toolBudget !== undefined ? { toolBudget: input.toolBudget } : {}),
    ...(input.toolBudgetSource !== undefined && input.toolBudgetSource !== "" ? { toolBudgetSource: input.toolBudgetSource } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.toolRounds !== undefined ? { toolRounds: input.toolRounds } : {}),
    ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
    ...(input.contextBudget !== undefined ? { contextBudget: input.contextBudget } : {}),
    ...(input.contextPeak !== undefined ? { contextPeak: input.contextPeak } : {}),
    ...(input.toolStopReason !== undefined && input.toolStopReason !== "" ? { toolStopReason: input.toolStopReason } : {}),
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
    // #762/#1107: usefulness feedback from the prior run's published
    // prescriptions. Read immediately before the build and fail-open end to
    // end, so the published review is unchanged when the read is unsupported or
    // uncertain. A finding set that can carry no prescription — blank,
    // fence-hostile, out-of-range, or marker-stripped-to-nothing — can never
    // contain one, so the read (and every request behind it) is skipped;
    // `hasPublishablePrescription` is the same predicate publication renders
    // through, over the same diff, so the pre-check cannot be weaker.
    const feedback = hasPublishablePrescription(input.findings, options.diffText)
      ? await readRejectedPrescriptions(api, input.commentMarker)
      : { keys: new Set<string>(), inspected: 0, logins: 0, trusted: 0, overCap: 0, carried: 0 };
    const built = buildInlineComments({
      findings: input.findings,
      diffText: options.diffText,
      max: input.inlineFindingsMax,
      forgejoPositions: input.forgejoPositions,
      linkMode: input.upstreamLinkMode,
      rejectedPrescriptions: feedback.keys,
    });
    inlineComments = built.comments;
    if (feedback.inspected > 0 || feedback.carried > 0) {
      messages.push(
        `Inline finding usefulness feedback: inspected ${feedback.inspected} prior comment(s), `
          + `${feedback.logins} distinct rejection login(s), ${feedback.trusted} trusted rejection(s), `
          + `${built.suppressed} suppressed prescription(s)`
          + (feedback.carried > 0
            ? `; ${feedback.carried} carried rejection key(s) inherited from this action's own prior comments`
            : "")
          + (feedback.overCap > 0
            ? `; ${feedback.overCap} login(s) past the verification cap — none verified`
            : ""),
      );
    }
  }

  const cleanupEnabled = input.mode !== "comment"
    && resolveCleanupFlag(input.cleanupPreviousNativeReviews, input.mode) === "true";
  const cleanupLog: CleanupLog = (line) => messages.push(line);
  let previousReviews: Awaited<ReturnType<PublishPlatformApi["listReviews"]>> = [];
  if (cleanupEnabled) {
    try { previousReviews = await api.listReviews(); }
    catch { messages.push("WARN: Could not snapshot previous reviews; cleanup skipped"); }
  }
  const completeCoverage = !input.partialCoverage && !input.coverageUnknown
    && reviewResult !== "partial" && incompleteReason === "none" && input.degradedGateBypass !== true;
  let fallbackSubmission = false;

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
          : (isValidPublishVerdict(input.verdict) ? VERDICT_PREFIXES[input.verdict]! : NO_VERDICT_PREFIX)
      ) + suffix;
      const body = buildPublishedBody({
        markers,
        header: prefix,
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
        coverageNotice,
        // #588: the `comment` mode publishes no findings natively on any
        // platform, so it compensates nothing for a missing native surface.
        stateBlock: stateSection("", false),
        triageBlock: triageBlock || undefined,
        routingBlock: routingBlock || undefined,
      });
      const result = await api.upsertStickyComment(input.commentMarker, body);
      if (!result.ok) {
        return { status: "failed", messages, error: `sticky comment publication failed: ${result.error ?? "unknown error"}` };
      }
    } else if (input.mode === "review_comment") {
      // #588: on a platform without a native review surface the findings
      // have no native channel, so the body states the degradation BEFORE
      // the untrusted review text and publishes the findings table itself.
      const platformNotice = nativeSurface.supported
        ? ""
        : `\n> **Native inline comments are unavailable on this platform**: ${surfaceReason}. The findings are published in this review body instead of as native review comments.\n`;
      const body = buildPublishedBody({
        markers,
        header: "# AI Automated Review",
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
        coverageNotice,
        stateBlock: stateSection(platformNotice),
        triageBlock: triageBlock || undefined,
        routingBlock: routingBlock || undefined,
      });
      const result = await api.upsertStickyComment(input.commentMarker, body);
      if (!result.ok) {
        return { status: "failed", messages, error: `sticky comment publication failed: ${result.error ?? "unknown error"}` };
      }
      stickyCommentId = result.commentId;
      stickyUpdatedAt = result.updatedAt;
      stickyBody = body;
      // #1093: inline findings reviews are created ONLY when there are inline
      // findings — a clean re-review must not publish an empty native review
      // just so cleanup has a checkpoint. The sticky comment (with its
      // response timestamp) is the replacement checkpoint instead.
      if (nativeSurface.supported) {
        if (inlineComments.length > 0) {
          const inlineBody = `${input.commentMarker}\n_Inline findings from the automated review (summary in the sticky comment)._`;
          const submitted = await api.createReview({ body: inlineBody, event: "COMMENT", commit_id: input.headSha, comments: inlineComments });
          if (submitted.ok) {
            nativeReviewId = submitted.reviewId;
            messages.push(`Attached ${inlineComments.length} inline finding comment(s)`);
          } else {
            // The findings review is this run's replacement for the previous
            // inline set; without it the sticky summary is NOT a complete
            // replacement, so the sticky checkpoint must not authorize
            // retiring the old owned comments.
            stickyCheckpointUsable = false;
            messages.push("WARN: inline findings review submission failed; summary comment was still published");
          }
        }
      } else if (findingCount > 0) {
        // #588: no native review surface — the managed record IS the complete
        // publication (the findings are in its body), so no native review is
        // created and the sticky checkpoint stays usable.
        messages.push(`NOTE: ${findingCount} finding(s) were published in the review body instead of as native review comments (no native review surface: ${surfaceReason})`);
      }
    } else {
      // #1161: `review_verdict` and `review_blockers` both publish a native
      // review; only `review_verdict` can ever approve.
      const validVerdict = isValidPublishVerdict(input.verdict);
      if (input.mode === "review_verdict" && !validVerdict) {
        // #1145: verdict mode must publish a verdict. A run that reaches this
        // point without a valid final verdict is an explicit action failure —
        // never a COMMENT disguised as a completed advisory review. The
        // blockers-only mode keeps #1161's advisory "No review verdict"
        // comment: that mode's published output IS a comment.
        return {
          status: "failed",
          messages,
          error: `review_verdict mode requires a final verdict of approve or request_changes, got "${input.verdict}" — refusing to publish a COMMENT substitute (#1145)`,
        };
      }
      const guardrails = evaluateApprovalGuardrails({
        verdict: input.verdict,
        approveForks: input.approveForks,
        isForkPr: input.isForkPr,
      });
      // #1145: the publish mode is authoritative — a valid final verdict maps
      // to its native event. Coverage/requirement-trace incompleteness does
      // NOT gate the approval: the shortfall stays visible in the marker
      // (`review_result: partial`), the #810 coverage notice, and the
      // explicit body note below, never by downgrading the verdict. Only the
      // operator's own guardrails (approve_forks / fork-ness fail-closed)
      // still withhold.
      // #1161: `review_blockers` publishes blocking findings only — it never
      // approves, under any verdict, input, or pull-request scope.
      const coverageIncomplete = reviewCoverageIncomplete(reviewResult);
      const canApprove = input.mode === "review_verdict" && guardrails.canApprove;
      // #588: on a platform without a native review surface there is no
      // native event to carry the recommendation, so the body states it —
      // BEFORE the untrusted review text, so no model content can swallow it
      // (a model blockquote can still LOOK similar; that exposure is the
      // pre-existing one of every action-owned notice in this body, and the
      // action's own marker stays the authoritative one). The verdict itself
      // never changes: the recommendation is published as advisory text only.
      const platformNotice = nativeSurface.supported
        ? ""
        : validVerdict && (input.verdict === "request_changes" || canApprove)
          ? `\n> **Automated recommendation: ${input.verdict === "request_changes" ? "REQUEST CHANGES" : "APPROVE"}** — advisory only: ${surfaceReason}. The review is published as a managed top-level review record; no native approval, blocking request, or inline comment was submitted.\n`
          : `\n> **Native review verdicts are unavailable on this platform**: ${surfaceReason}. The review is published as a managed top-level review record; no native approval, blocking request, or inline comment was submitted.\n`;
      let body = buildPublishedBody({
        markers,
        header: "# AI Automated Review",
        note: "_Full PR review._",
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
        coverageNotice,
        stateBlock: stateSection(platformNotice),
        triageBlock: triageBlock || undefined,
        routingBlock: routingBlock || undefined,
      });
      if (!validVerdict) {
        // #1161: a missing or invalid verdict is a failed run, not a clean
        // review — it must never publish as an approval or as a blocking
        // request, and it must not read as a successful clean review.
        // (#1145: in `review_verdict` this run already failed above — the
        // branch is reachable only in the blockers-only mode, whose published
        // output is an advisory comment.)
        body += "\n> **No review verdict**: this run produced no valid verdict (model failure or an invalid verdict payload), so neither an approval nor a blocking request is published.\n";
        messages.push(`Publishing advisory review for #${input.prNumber} (no valid verdict produced)`);
      } else if (input.mode === "review_verdict" && input.verdict === "approve" && guardrails.scopeBlocked) {
        // #1161: the cross-repository scope policy is the only thing that
        // withholds an approval here (the deprecated allow_approve input
        // no longer gates anything). A withheld approval stays advisory:
        // a blocking REQUEST_CHANGES would invent an issue the model did
        // not find.
        const scope = guardrails.isForkPr === null
          ? "the fork status of this pull request could not be determined, so it is treated as a cross-repository (fork) pull request"
          : "this is a cross-repository (fork) pull request";
        // #752: a review with open findings or a coverage gap must not
        // call itself clean, even when its verdict is an approve.
        const advisory = reviewResult === "clean"
          ? "this clean review is advisory"
          : "this review is advisory rather than a clean approval — the findings and coverage notes above are informational";
        body += `\n> **Approval withheld by scope policy**: ${scope} and native approvals for fork pull requests are disabled (\`approve-forks: ${input.approveForks}\`), so ${advisory}.\n`;
        messages.push(
          `Withholding native approval for #${input.prNumber} (cross-repository PR, approve_forks=${input.approveForks}, is_fork=${guardrails.isForkPr ?? "unknown"})`,
        );
      } else if (input.mode === "review_verdict" && input.verdict === "approve" && coverageIncomplete && nativeSurface.supported) {
        // #1145: the verdict still publishes as a native approval, but never
        // silently — the marker keeps reading `review_result: partial`,
        // the #810 notice (when present) names the tool-loop gap, and this
        // line names the trace/coverage shortfall on the approved review.
        // #588: on a platform WITHOUT a native review surface no approval is
        // published at all — the platform notice above already states that
        // degradation, so a note about a PUBLISHED approval is not rendered
        // there (the coverage gap is still disclosed by the #810 notice and
        // the marker).
        const gap = incompleteReason === "requirement_trace"
          ? "an in-scope requirement lacks fully verified enforcement or test evidence"
            : incompleteReason === "both"
              ? "execution coverage is incomplete and an in-scope requirement lacks fully verified enforcement or test evidence"
            : input.coverageUnknown
              ? "this review's tool-loop coverage could not be verified (the run directory or its coverage artifact was unavailable to confirm it)"
              : "required-check coverage or the tool-loop investigation did not finish";
        body += `\n> **Approval published with incomplete coverage**: ${gap}. The verdict above is the review's final verdict; the coverage notes remain informational.\n`;
        messages.push(
          `Publishing native approval for #${input.prNumber} with incomplete coverage (#1145; reason=${incompleteReason})`,
        );
      }
      if (input.mode === "review_blockers" && input.verdict === "approve") {
        // #1161: the mode is blockers-only — a review without blockers is
        // published as an advisory comment and never as an approval. (A
        // missing/invalid verdict is covered by the "No review verdict"
        // notice above: it is a failed run, not a clean review.)
        body += `\n> **Advisory review (blockers-only mode)**: \`publish-mode: review_blockers\` publishes blocking findings only; a clean review is published as an ${advisoryNoun} and is never published as an approval.\n`;
        messages.push(`Publishing advisory review for #${input.prNumber} (blockers-only mode; no approval published)`);
      }
      if (!nativeSurface.supported) {
        // #588: the platform has no native pull-review surface, so the
        // review is published as its managed top-level record. The body's
        // platform notice (above, before the untrusted text) states the
        // degradation: no native approval, blocking request, or inline
        // comment was submitted, and the recommendation is advisory. The
        // managed record IS the complete publication.
        const result = await api.upsertStickyComment(input.commentMarker, body);
        if (!result.ok) {
          return { status: "failed", messages, error: `managed review record publication failed: ${result.error ?? "unknown error"}` };
        }
        stickyCommentId = result.commentId;
        stickyUpdatedAt = result.updatedAt;
        stickyBody = body;
        messages.push(`Published the review as a managed top-level review record (no native review surface: ${surfaceReason}); no native approval or blocking request was submitted`);
      } else {
        // #1145: every valid final verdict maps to its native event. COMMENT
        // is reachable here only when an operator guardrail (approve_forks /
        // fork fail-closed) blocks an approve, or when the blockers-only mode
        // publishes its advisory output — never from a requirement-trace or
        // coverage downgrade branch.
        const event: NativeReviewEvent = input.verdict === "request_changes"
          ? "REQUEST_CHANGES"
          : canApprove ? "APPROVE" : "COMMENT";
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
        fallbackSubmission = submitted.fellBack;
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
        nativeReviewId = submitted.reviewId;
        messages.push(`Submitted native review (${event}) with ${submitted.inlineCount} inline comment(s)`);
      }
    }
  } catch (error) {
    return {
      status: "failed",
      messages,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Retire old inline findings only after a complete replacement at the expected head.
  if (cleanupEnabled) {
    // #1093: what proves this run fully replaced the previous publication.
    // review-verdict/inline-finding runs use the native review they created;
    // a review_comment run with no inline findings uses the sticky summary
    // comment plus its publication timestamp (a clean re-review creates no
    // native review at all). Missing both: no cleanup (fail closed).
    type ReplacementCheckpoint =
      | { kind: "review"; reviewId: number | string }
      | { kind: "sticky"; commentId: number | string; updatedAt: string; body: string };
    const replacementCheckpoint: ReplacementCheckpoint | undefined =
      nativeReviewId !== undefined
        ? { kind: "review", reviewId: nativeReviewId }
        : stickyCheckpointUsable && stickyCommentId !== undefined && stickyUpdatedAt !== undefined && stickyBody !== undefined
          ? { kind: "sticky", commentId: stickyCommentId, updatedAt: stickyUpdatedAt, body: stickyBody }
          : undefined;
    const replacementComplete = completeCoverage && !fallbackSubmission && replacementCheckpoint !== undefined;
    // #1114: verification below (head, trusted owner, supersession ordering,
    // still-current revalidation) is what proves staleness — not coverage
    // completeness. A published checkpoint therefore authorizes the safe,
    // presentation-only minimization of superseded advisory bodies even when
    // the replacement is incomplete; the destructive/authoritative effects
    // (inline retirement, dismissal, thread resolution) stay behind the
    // strict complete-replacement gate.
    if (replacementCheckpoint !== undefined) {
      try {
        const verifiedHead = await api.getHeadSha();
        if (verifiedHead !== input.headSha) {
          messages.push("  WARN: Head changed after publication; leaving previous inline comments and review bodies unchanged");
        } else {
          // #1093: ownership decisions run under the shared forge-agnostic
          // owner-identity policy (login proof, or - for Forgejo Authorized
          // Integration - the audience-derived user id). Unproven identity
          // fails closed: nothing is deleted.
          const { owner, reason } = await resolvePublishTrustedOwner(api);
          if (owner === null) {
            messages.push("WARN: Could not verify authenticated owner (identity reason: " + reason + "); no inline comments retired");
          } else {
            const previous = previousReviews.filter((r) => ownerMatchesIdentity(r.user, owner));
            const reviewInstant = (r: { submitted_at?: string; updated_at?: string }): string => {
              if (typeof r.submitted_at === "string" && r.submitted_at !== "") return r.submitted_at;
              return typeof r.updated_at === "string" && r.updated_at !== "" ? r.updated_at : "";
            };
            let olderManaged: typeof previous;
            if (replacementCheckpoint.kind === "review") {
              const newestId = BigInt(String(replacementCheckpoint.reviewId));
              olderManaged = previous.filter((r) => {
                if (!isManagedBody(typeof r.body === "string" ? r.body : "", input.commentMarker)) return false;
                try { return BigInt(String(r.id)) < newestId; } catch { return false; }
              });
            } else {
              const checkpointMs = Date.parse(replacementCheckpoint.updatedAt);
              olderManaged = Number.isNaN(checkpointMs)
                ? []
                : previous.filter((r) => {
                  if (!isManagedBody(typeof r.body === "string" ? r.body : "", input.commentMarker)) return false;
                  const instant = reviewInstant(r);
                  const stamp = instant === "" ? Number.NaN : Date.parse(instant);
                  return !Number.isNaN(stamp) && stamp < checkpointMs;
                });
            }
            if (olderManaged.length > 100) {
              messages.push("WARN: Previous managed review snapshot exceeds cleanup bound; cleanup skipped");
            } else {
              const stillCurrent = async () => {
                if (await api.getHeadSha() !== input.headSha) return false;
                if (replacementCheckpoint.kind === "review") {
                  const latest = await api.listReviews();
                  const replacement = latest.find((r) => String(r.id) === String(replacementCheckpoint.reviewId));
                  if (!replacement || !isManagedBody(typeof replacement.body === "string" ? replacement.body : "", input.commentMarker)) return false;
                  const newest = latest
                    .filter((r) => isManagedBody(typeof r.body === "string" ? r.body : "", input.commentMarker))
                    .reduce<bigint | null>((max, r) => { try { const id = BigInt(String(r.id)); return max === null || id > max ? id : max; } catch { return max; } }, null);
                  return newest === BigInt(String(replacementCheckpoint.reviewId));
                }
                // Sticky checkpoint: the sticky comment must still exist, still
                // be the managed body owned by this run, and must not have been
                // re-published after the checkpoint - and no managed review of
                // ANY author may be newer than the checkpoint (a foreign
                // model's review supersedes the run too). A review without a
                // usable timestamp fails closed.
                const checkpointMs = Date.parse(replacementCheckpoint.updatedAt);
                if (Number.isNaN(checkpointMs)) return false;
                const latest = await api.listReviews();
                const stickyLatest = (await api.listIssueComments()).find((c) => String(c.id) === String(replacementCheckpoint.commentId));
                if (!stickyLatest || !isManagedBody(typeof stickyLatest.body === "string" ? stickyLatest.body : "", input.commentMarker)) return false;
                if (!ownerMatchesIdentity(stickyLatest.user, owner)) return false;
                // The sticky body must be byte-identical to what THIS run
                // published: an overlapping run re-publishing in the same
                // second (refreshed timestamp equal to the checkpoint) with a
                // different body would otherwise pass for this run's state.
                if (stickyLatest.body !== replacementCheckpoint.body) return false;
                const refreshedMs = Date.parse(stickyLatest.updated_at ?? "");
                // A newer instant means the sticky was re-published after
                // this checkpoint (an overlapping run owns the replacement);
                // a missing/older one is unproven. Either way: fail closed.
                if (Number.isNaN(refreshedMs) || refreshedMs !== checkpointMs) return false;
                return !latest.some((r) => {
                  if (!isManagedBody(typeof r.body === "string" ? r.body : "", input.commentMarker)) return false;
                  const instant = reviewInstant(r);
                  const stamp = instant === "" ? Number.NaN : Date.parse(instant);
                  // Fail closed on ties too: a competing managed review
                  // submitted in the SAME second as the checkpoint cannot be
                  // proven older than it.
                  return Number.isNaN(stamp) || stamp >= checkpointMs;
                });
              };
              if (await stillCurrent()) {
                if (replacementComplete) {
                  // #1099: the identity resolved above is threaded into retirement
                  // (one resolution, one Forgejo reaction probe per publish run).
                  await retireManagedInlineComments(api, olderManaged, input.commentMarker, cleanupLog, { owner, reason }, stillCurrent);
                  if (await stillCurrent()) {
                    const managedIds = await cleanupManagedReviews(api, input.prNumber, input.commentMarker, cleanupLog, [], olderManaged);
                    if (api.platform === "github") await resolveSupersededThreads(api, managedIds, cleanupLog);
                    else messages.push("NOTE: Skipping review-thread resolution (platform=forgejo; no GraphQL API)");
                  }
                } else {
                  // #1114: the checkpoint proves a newer managed publication at
                  // the current head, so proven-stale advisory bodies can be
                  // hidden presentation-only. Nothing is deleted and no
                  // APPROVED/CHANGES_REQUESTED verdict is dismissed: a partial
                  // review must never make a blocking review disappear.
                  messages.push("NOTE: Replacement is not complete (incomplete coverage or fallback submission); previous inline comments and verdicts left in place, attempting presentation-only minimization of superseded advisory review bodies");
                  await minimizeSupersededAdvisoryReviews(api, olderManaged, input.commentMarker, cleanupLog, { owner, reason }, [], stillCurrent);
                }
              } else messages.push("WARN: A newer review superseded this run; cleanup skipped");
            }
          }
        }
      } catch { messages.push("WARN: Cleanup failed safely; replacement review remains published"); }
    } else {
      // #1093: distinguish "cleanup never had a checkpoint" from the other
      // skip reasons so operators can tell retirement did not run at all
      // (e.g. a failed inline-findings submission, or a forge response
      // without a usable sticky timestamp).
      messages.push("WARN: No replacement checkpoint (no native review id and no sticky publication timestamp); previous inline comments left in place");
    }
  }

  // Re-review label cleanup: best-effort, never fails the run.
  if (input.rerunLabel) {
    await api.removeLabel(input.rerunLabel);
  }

  return { status: "published", messages };
}
