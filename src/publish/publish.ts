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
import { buildComments } from "./inline-findings.js";
import { buildRunMetadataMarker, emitReviewMarkers, type MarkerPreamble } from "../metadata/markers.js";
import { resolveSupersededThreads, cleanupManagedReviews, resolveCleanupFlag, type CleanupLog } from "./cleanup.js";
import type { NativeReviewComment, NativeReviewRequest, PublishPlatformApi } from "../platform/publish-api.js";

export type PublishMode = "comment" | "review_comment" | "review_verdict";
export type NativeReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PublishInput {
  mode: PublishMode;
  /** Raw model-produced review markdown (unsanitized). */
  reviewMarkdown: string;
  verdict: string;
  analysisEngine: string;
  baseSha: string;
  headSha: string;
  prNumber: string;
  commentMarker: string;
  broadFingerprint?: string;
  /** Required-checks validation status for the metadata marker. */
  requiredChecks: string;
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
  /** Forgejo inline-comment position backend. */
  forgejoPositions: boolean;
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

/** Build the published body: marker preamble + engine line + sanitized review. */
export function buildPublishedBody(options: {
  markers: string;
  header?: string;
  note?: string;
  analysisEngine: string;
  sanitizedMarkdown: string;
}): string {
  const lines = [options.markers];
  if (options.header) {
    lines.push(options.header, "");
  }
  if (options.note) {
    lines.push(options.note, "");
  }
  lines.push(`_Analysis engine: ${options.analysisEngine}_`, "");
  lines.push(options.sanitizedMarkdown);
  return `${lines.join("\n")}\n`;
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

  // Sanitize model output first — the same pipeline for every mode.
  const sanitized = sanitizeForPublication(input.reviewMarkdown, input.upstreamLinkMode, input.conditionalPresence);
  const reviewResult = input.verdict === "request_changes" ? "issues" : "clean";
  const metadataMarker = buildRunMetadataMarker({
    headSha: input.headSha,
    baseSha: input.baseSha,
    reviewResult,
    requiredChecks: input.requiredChecks,
    reviewRoute: input.reviewRoute,
    escalationReason: input.escalationReason,
    cacheHitRatio: input.cacheHitRatio,
  });
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
      const prefix = VERDICT_PREFIXES[input.verdict] ?? "✅ **Automated recommendation: APPROVE**";
      const body = buildPublishedBody({
        markers,
        header: prefix,
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
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
      let body = buildPublishedBody({
        markers,
        header: "# AI Automated Review",
        note: "_Full PR review._",
        analysisEngine: input.analysisEngine,
        sanitizedMarkdown: sanitized,
      });
      if (!guardrails.canApprove && input.verdict === "approve") {
        body += "\n> **Approval blocked by policy**: this clean review is advisory. Native approvals require `allow_approve: true` (and `approve_forks: true` for cross-repository PRs).\n";
        messages.push(
          `Withholding native approval for #${input.prNumber} (allow_approve=${input.allowApprove}, approve_forks=${input.approveForks}, is_fork=${guardrails.isForkPr ?? input.isForkPr})`,
        );
      }
      const event: NativeReviewEvent = guardrails.canApprove
        ? "APPROVE"
        : input.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
      if (guardrails.canApprove) {
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
