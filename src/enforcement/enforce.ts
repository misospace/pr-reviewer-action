/**
 * Enforcement overlays (#680 port of `pr_reviewer/enforcement.py`).
 *
 * Deterministic fail-closed rules that override the model's verdict to
 * request_changes when configured conditions are met: evidence-provider
 * blockers, tool-harness planning/execution failure, minimum successful tool
 * requests, and the banner normalization that explains an enforced verdict.
 * The final reviewer still owns the verdict — these overlays run after the
 * verdict policy and are themselves deterministic policy, not model input.
 */
import type { ReviewArtifact } from "./artifact.js";
import { applyReviewThreadEnforcement, type EnforcementThread } from "./threads.js";
import { applyHumanReviewEnforcement, type EnforcementHumanReview } from "./human-reviews.js";

export interface EvidenceProviderArtifact {
  has_blocker?: boolean;
  providers?: Array<{ id?: string; provider_severity?: string }>;
}

export interface ToolHarnessArtifact {
  planning_error?: string | null;
  error?: string | null;
  planned_request_count?: number;
  executed_request_count?: number;
  tool_results?: Array<{ status?: string }>;
}

export interface EnforcementOutcome {
  applied: boolean;
  reason: string;
}

/** Shared output-mutation discipline: append the section, force the verdict. */
function forceRequestChanges(
  artifact: ReviewArtifact,
  sectionMd: string,
  reason: string,
): EnforcementOutcome {
  artifact.review_markdown = (artifact.review_markdown || "") + sectionMd;
  artifact.verdict = "request_changes";
  return { applied: true, reason };
}

/** Override the verdict when any evidence provider reported a blocker. */
export function applyEvidenceBlockerEnforcement(
  artifact: ReviewArtifact,
  evidence: EvidenceProviderArtifact | null,
): EnforcementOutcome {
  if (!evidence || !evidence.has_blocker) {
    return { applied: false, reason: "" };
  }
  const blockerIds = (evidence.providers ?? [])
    .filter((p) => p && p.provider_severity === "blocker")
    .map((p) => p.id ?? "");
  const ids = blockerIds.join(", ");
  return forceRequestChanges(
    artifact,
    "\n\n## Evidence Provider Blockers\n"
    + "One or more configured evidence providers reported blocker-level findings"
    + (ids !== "" ? ` (${ids})` : "")
    + ". Resolve blocker findings before approval.",
    "Evidence provider blocker detected"
    + (ids !== "" ? `: ${ids}` : "")
    + ". One or more configured evidence providers reported blocker-level findings.",
  );
}

function toolHarnessFailureReason(harness: ToolHarnessArtifact | null): string | null {
  if (!harness) return null;
  if (harness.planning_error !== undefined && harness.planning_error !== null) {
    return String(harness.planning_error);
  }
  if (harness.error !== undefined && harness.error !== null) {
    return String(harness.error);
  }
  const executed = harness.executed_request_count ?? 0;
  if (executed > 0) {
    const statuses = harness.tool_results ?? [];
    if (!statuses.some((t) => t && t.status === "ok")) {
      return "all tool requests failed";
    }
  }
  return null;
}

function countSuccessfulRequests(harness: ToolHarnessArtifact | null): number {
  if (!harness) return 0;
  return (harness.tool_results ?? []).filter((t) => t && t.status === "ok").length;
}

/** Override the verdict when tool-harness planning or execution failed. */
export function applyToolHarnessFailureEnforcement(
  artifact: ReviewArtifact,
  harness: ToolHarnessArtifact | null,
): EnforcementOutcome {
  const reason = toolHarnessFailureReason(harness);
  if (!reason) {
    return { applied: false, reason: "" };
  }
  return forceRequestChanges(
    artifact,
    "\n\n## Tool Harness Failure\n"
    + `The tool harness failed during planning or execution (${reason}). `
    + "This workflow is configured fail-closed for tool harness failures; "
    + "rerun after reducing tool planning context or fixing connectivity.",
    `Tool harness failure detected (${reason}). `
    + "The tool harness failed during planning or execution; "
    + "this workflow is configured fail-closed for tool harness failures.",
  );
}

/** Override the verdict when fewer than minRequired tool requests succeeded. */
export function applyToolMinSuccessfulEnforcement(
  artifact: ReviewArtifact,
  minRequired: number,
  harness: ToolHarnessArtifact | null,
): EnforcementOutcome {
  const successful = countSuccessfulRequests(harness);
  if (successful >= minRequired) {
    return { applied: false, reason: "" };
  }
  return forceRequestChanges(
    artifact,
    "\n\n## Tool Harness Insufficient Evidence\n"
    + `This workflow requires at least ${minRequired} successful tool requests, `
    + `but only ${successful} succeeded. Rerun after adjusting tool planning settings.`,
    "Tool harness gathered insufficient evidence. "
    + `This workflow requires at least ${minRequired} successful tool requests, `
    + `but only ${successful} succeeded.`,
  );
}

/**
 * Add the "Final Recommendation: Request changes" banner when enforcement
 * forced request_changes, rewriting a model "Recommendation: Approve"
 * heading so the published review never contradicts its verdict.
 */
export function normalizeEnforcedReviewMarkdown(
  artifact: ReviewArtifact,
  reasons: string[] | null,
): void {
  if (artifact.verdict !== "request_changes") {
    return;
  }
  let markdown = artifact.review_markdown || "";
  markdown = markdown.replace(
    /^(#{1,6}\s*)?Recommendation:\s*Approve\s*$/gim,
    (_match, heading: string | undefined) => `${heading ?? ""}Model recommendation before enforcement: Approve`,
  );
  if (!markdown.trimStart().startsWith("## Final Recommendation")) {
    if (reasons && reasons.length > 0) {
      const reasonsBullet = reasons.map((r) => `- ${r}`).join("\n");
      markdown = (
        "## Final Recommendation\n"
        + "Request changes. The following enforcement check(s) require this PR "
        + "to be treated as blocking even if the model's initial review text was approving:\n\n"
        + `${reasonsBullet}\n\n`
        + markdown.trimStart()
      );
    } else {
      markdown = (
        "## Final Recommendation\n"
        + "Request changes. One or more configured enforcement checks require this PR "
        + "to be treated as blocking even if the model's initial review text was approving.\n\n"
        + markdown.trimStart()
      );
    }
  }
  artifact.review_markdown = markdown;
}

/**
 * The action-authored banner `normalizeEnforcedReviewMarkdown` prepends,
 * matched exactly (both sentence forms, with or without the reason bullets).
 * Anchored at the start: the banner is always prepended, and only this
 * module's own text matches, so model-authored prose is never stripped.
 */
const ENFORCED_BANNER_RE =
  /^## Final Recommendation\nRequest changes\. (?:The following enforcement check\(s\) require this PR to be treated as blocking even if the model's initial review text was approving:\n\n(?:- [^\n]*\n)*\n|One or more configured enforcement checks require this PR to be treated as blocking even if the model's initial review text was approving\.\n\n)/;

/**
 * #977: the enforcement banner is written while the verdict is still the
 * model's, but the strict mapping and the verification-only relaxation can
 * both change the verdict afterwards. Reconcile the markdown with the FINAL
 * verdict so an approve can never ship an action-authored banner saying the
 * final recommendation is request changes. Purely subtractive: it never adds
 * a banner, so every other case keeps the output it has today.
 */
export function reconcileEnforcedReviewMarkdown(artifact: ReviewArtifact): void {
  if (artifact.verdict === "request_changes") return;
  artifact.review_markdown = (artifact.review_markdown || "").replace(ENFORCED_BANNER_RE, "");
}

export interface EnforcementInputs {
  evidenceBlockerEnabled: boolean;
  toolFailureEnabled: boolean;
  toolMinSuccessful: number;
  evidence: EvidenceProviderArtifact | null;
  toolHarness: ToolHarnessArtifact | null;
  threads: readonly EnforcementThread[] | null;
  humanReviews: readonly EnforcementHumanReview[] | null;
  verdictPolicy: string;
}

/**
 * True when a fail-closed verdict-forcing rule fired for these inputs —
 * evidence blockers, tool-harness failure, or the min-successful fallback
 * (the same conditions `applyAllEnforcement` forces `request_changes` on;
 * thread/human settlement never force). The #811 strict verdict mapping
 * consults this so it can never relax a request_changes these layers
 * forced, including when the model itself also asked for changes.
 */
export function failClosedEnforcementFired(inputs: Pick<
  EnforcementInputs,
  "evidenceBlockerEnabled" | "evidence" | "toolFailureEnabled" | "toolHarness" | "toolMinSuccessful"
>): boolean {
  if (inputs.evidenceBlockerEnabled && inputs.evidence?.has_blocker) return true;
  if (inputs.toolFailureEnabled) {
    if (toolHarnessFailureReason(inputs.toolHarness ?? null)) return true;
    if (inputs.toolMinSuccessful > 0
      && countSuccessfulRequests(inputs.toolHarness ?? null) < inputs.toolMinSuccessful) {
      return true;
    }
  }
  return false;
}

/**
 * Apply all configured enforcement rules in sequence (port of
 * `apply_all_enforcement`): evidence blockers, tool-harness failure (with
 * the min-successful fallback), review-thread settlement, human change-request
 * settlement, then the banner normalization. Returns the number of
 * enforcement actions applied. The banner is reconciled against the final
 * verdict afterwards by `reconcileEnforcedReviewMarkdown`.
 */
export function applyAllEnforcement(artifact: ReviewArtifact, inputs: EnforcementInputs): number {
  let applied = 0;
  const reasons: string[] = [];

  if (inputs.evidenceBlockerEnabled) {
    const outcome = applyEvidenceBlockerEnforcement(artifact, inputs.evidence);
    if (outcome.applied) {
      applied += 1;
      reasons.push(outcome.reason);
    }
  }

  if (inputs.toolFailureEnabled) {
    const outcome = applyToolHarnessFailureEnforcement(artifact, inputs.toolHarness);
    if (outcome.applied) {
      applied += 1;
      reasons.push(outcome.reason);
    } else if (inputs.toolMinSuccessful > 0) {
      const minOutcome = applyToolMinSuccessfulEnforcement(artifact, inputs.toolMinSuccessful, inputs.toolHarness);
      if (minOutcome.applied) {
        applied += 1;
        reasons.push(minOutcome.reason);
      }
    }
  }

  const threads = applyReviewThreadEnforcement(artifact, inputs.threads, inputs.verdictPolicy);
  if (threads.applied) {
    applied += 1;
    reasons.push(threads.reason);
  }

  const humanReviews = applyHumanReviewEnforcement(artifact, inputs.humanReviews);
  if (humanReviews.applied) {
    applied += 1;
    reasons.push(humanReviews.reason);
  }

  if (applied > 0) {
    normalizeEnforcedReviewMarkdown(artifact, reasons.length > 0 ? reasons : null);
  }

  return applied;
}
