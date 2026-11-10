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
import { markRelaxationNotesSuperseded, type ReviewArtifact } from "./artifact.js";
import { applyReviewObligationEnforcement, isForcingObligation, type ReviewObligation } from "./review-obligations.js";
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
  /** #1597: the ok-status count, truthfully named. `executed_request_count`
   * now counts ATTEMPTED executions; this enforcement keeps the historical
   * successful-only predicate exactly (fail-closed behavior must not shift
   * with a diagnostics rename). */
  successful_request_count?: number;
  executed_request_count?: number;
  tool_results?: Array<{ status?: string }>;
}

export interface EnforcementOutcome {
  applied: boolean;
  reason: string;
}

/**
 * Shared output-mutation discipline: append the section, force the verdict.
 * #1248: when this flips a verdict that was not already request_changes,
 * enforcement owns the final verdict — record `verdict_source=enforcement`
 * (a no-flip overlay leaves existing provenance untouched) and retire any
 * earlier relaxation note the flip contradicts.
 */
export function forceRequestChanges(
  artifact: ReviewArtifact,
  sectionMd: string,
  reason: string,
): EnforcementOutcome {
  const flipsVerdict = artifact.verdict !== "request_changes";
  artifact.review_markdown = (artifact.review_markdown || "") + sectionMd;
  artifact.verdict = "request_changes";
  if (flipsVerdict) {
    artifact.verdict_source = "enforcement";
    markRelaxationNotesSuperseded(artifact);
  }
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
  // #1597: read the successful count, exactly the value the historical
  // `executed_request_count` carried — this fail-closed gate is approval
  // policy, so it must not change when a diagnostics field is renamed.
  const successful = harness.successful_request_count ?? 0;
  if (successful > 0) {
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
  /** #1381: the folded review-owned obligation rows; null when none were
   * tracked (no must_check items and no injected trusted-base guidance). */
  reviewObligations?: readonly ReviewObligation[] | null;
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
  "evidenceBlockerEnabled" | "evidence" | "toolFailureEnabled" | "toolHarness" | "toolMinSuccessful" | "reviewObligations"
>): boolean {
  if (inputs.evidenceBlockerEnabled && inputs.evidence?.has_blocker) return true;
  if (inputs.toolFailureEnabled) {
    if (toolHarnessFailureReason(inputs.toolHarness ?? null)) return true;
    if (inputs.toolMinSuccessful > 0
      && countSuccessfulRequests(inputs.toolHarness ?? null) < inputs.toolMinSuccessful) {
      return true;
    }
  }
  // #1381/#1505: an `unmet` (confirmed-negative) review-owned obligation —
  // from EITHER forcing source (`must_check`, `trusted_base_guidance`) — is
  // a required check the reviewer performed and confirmed NOT satisfied,
  // a real blocking result like a blocker/major finding: a fail-closed
  // forcing condition like the layers above. No per-source exemption
  // between those two: an unmet review-owned row must never be able to
  // certify a native APPROVE through a weaker second class.
  //
  // An `unresolved` review-owned row is NOT forcing: the evidence was never
  // gathered, so it is incomplete coverage, never a defect claim (#1447).
  // It withholds the trusted approve at the publish boundary and marks the
  // review partial (a publish COMMENT), and must not manufacture a
  // blocking request out of an incomplete review.
  //
  // #1449: the `derived` source is NOT a forcing row. An undischarged
  // derived obligation is missing COVERAGE (the review never established a
  // cross-path relationship), never a defect claim (#1447), so it must not
  // manufacture a blocking request out of a coverage gap. It still withholds
  // the trusted approval — through the publish boundary
  // (`evaluateApprovalGuardrails`), which refuses a native approval while
  // the derived state is not `complete` — so the #1381 anti-relax guarantee
  // holds without turning an abstention into a block.
  if ((inputs.reviewObligations ?? []).some((obligation) => obligation.status !== "satisfied" && isForcingObligation(obligation))) {
    return true;
  }
  return false;
}

/**
 * Apply all configured enforcement rules in sequence (port of
 * `apply_all_enforcement`): evidence blockers, tool-harness failure (with
 * the min-successful fallback), review-thread settlement, human change-request
 * settlement, then the banner normalization. Returns the number of
 * enforcement actions applied.
 *
 * #977: only a rule that actually FORCED request_changes may create or
 * contribute to the enforcement banner. Its text attributes the block to
 * enforcement, so a settlement that merely changes bookkeeping — thread and
 * human-review settlement never force a verdict — must not claim it. The
 * banner is reconciled against the final verdict afterwards by
 * `reconcileEnforcedReviewMarkdown`.
 */
export function applyAllEnforcement(artifact: ReviewArtifact, inputs: EnforcementInputs): number {
  let applied = 0;
  // Only the forcing rules contribute here; `applied` counts every action.
  const forcingReasons: string[] = [];

  if (inputs.evidenceBlockerEnabled) {
    const outcome = applyEvidenceBlockerEnforcement(artifact, inputs.evidence);
    if (outcome.applied) {
      applied += 1;
      forcingReasons.push(outcome.reason);
    }
  }

  if (inputs.toolFailureEnabled) {
    const outcome = applyToolHarnessFailureEnforcement(artifact, inputs.toolHarness);
    if (outcome.applied) {
      applied += 1;
      forcingReasons.push(outcome.reason);
    } else if (inputs.toolMinSuccessful > 0) {
      const minOutcome = applyToolMinSuccessfulEnforcement(artifact, inputs.toolMinSuccessful, inputs.toolHarness);
      if (minOutcome.applied) {
        applied += 1;
        forcingReasons.push(minOutcome.reason);
      }
    }
  }

  // #1381: the review-obligation gate runs with the other forcing rules and
  // before the banner normalization, so its reason contributes to the same
  // enforced banner instead of leaving a verdict the body contradicts.
  const obligationGate = applyReviewObligationEnforcement(artifact, inputs.reviewObligations ?? []);
  if (obligationGate.applied) {
    applied += 1;
    forcingReasons.push(obligationGate.reason);
  }

  const verdictBeforeThreads = artifact.verdict;
  const threads = applyReviewThreadEnforcement(artifact, inputs.threads, inputs.verdictPolicy);
  if (threads.applied) {
    applied += 1;
    // Settlement is bookkeeping, except under findings_severity_gated where a
    // re-emitted blocker escalates the verdict — that escalation did force it.
    if (verdictBeforeThreads !== "request_changes" && artifact.verdict === "request_changes") {
      forcingReasons.push(threads.reason);
    }
  }

  const humanReviews = applyHumanReviewEnforcement(artifact, inputs.humanReviews);
  if (humanReviews.applied) {
    applied += 1;
    // Human change-request settlement never forces a verdict, so it never
    // contributes to the banner.
  }

  if (forcingReasons.length > 0) {
    normalizeEnforcedReviewMarkdown(artifact, forcingReasons);
  }

  return applied;
}
