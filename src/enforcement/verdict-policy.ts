/**
 * Verdict policy (#680 port of `pr_reviewer/enforcement.py::apply_verdict_policy`,
 * carrying #772 and the #775 opt-in rework; #811 adds the strict mapping).
 *
 * Monotonic escalation from structured findings: with
 * `findings_severity_gated`, blocker-severity findings escalate an approve to
 * request_changes. When the consumer opts in via the non-blocking category
 * list, blocker/major findings in those categories are first capped at minor
 * (unless the PR carries a security risk flag); when that cap leaves nothing
 * blocking, no required check is unresolved, and the model asked for changes,
 * the verdict is relaxed to approve — the one downgrade this policy makes.
 * Non-blocker findings never downgrade a model request_changes, and when the
 * model produced no findings the model verdict stands.
 *
 * `strict` (the v3 default, #811) is not an escalation on top of the model
 * verdict but a derivation: see `applyStrictVerdictPolicy` below.
 */
import type { ReviewArtifact, ArtifactFinding } from "./artifact.js";
import type { VerdictValue } from "../model/types.js";

/**
 * Categories a consumer may declare non-blocking (`non_blocking_finding_categories`,
 * opt-in, empty by default): under findings_severity_gated their findings are
 * capped at minor so a review cannot keep requesting changes on those asks
 * alone. security is never eligible, and a PR carrying a security risk flag is
 * exempt — a missing test on auth or path handling can still block.
 */
export const NON_BLOCKING_ELIGIBLE: ReadonlySet<string> = new Set([
  "tests", "docs", "style", "question", "performance", "bug", "other",
]);

/**
 * #977: finding categories that can never request changes, under every
 * verdict policy. A `verification` finding asks the author to confirm
 * something the review tools cannot reach (a production metric, a flag, an
 * external service, a value in another repository); it cannot be satisfied
 * by a code change, so it must never block. It stays visible as an open
 * finding — under strict it publishes as an approve carrying findings.
 */
export const ALWAYS_NON_BLOCKING_CATEGORIES: ReadonlySet<string> = new Set(["verification"]);

/** True when a finding's category is unconditionally non-blocking (#977). */
export function isAlwaysNonBlockingCategory(category: unknown): boolean {
  return typeof category === "string" && ALWAYS_NON_BLOCKING_CATEGORIES.has(category);
}

/** The severities that can request changes on their own (#811): blocker and major. */
export function isBlockingSeverity(severity: unknown): boolean {
  return severity === "blocker" || severity === "major";
}

/** A finding that can be counted as blocking: blocker/major and not #977. */
function isBlockingFinding(finding: ArtifactFinding): boolean {
  return isBlockingSeverity(finding.severity) && !isAlwaysNonBlockingCategory(finding.category);
}

export const SECURITY_RISK_FLAGS: ReadonlySet<string> = new Set([
  "auth_changes", "public_route_changes", "file_serving_changes",
  "path_handling_changes", "secret_handling_changes", "db_or_migration_changes",
  "linked_security_issue",
]);

/** Parse the configured category list, intersected with the eligible set. */
export function parseNonBlockingCategories(raw: string | undefined | null): Set<string> {
  const wanted = new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part !== ""),
  );
  return new Set([...wanted].filter((category) => NON_BLOCKING_ELIGIBLE.has(category)));
}

/** True when the classification carried any security risk flag. */
export function securityRiskFlagged(classification: unknown): boolean {
  const flags = (classification as { risk_flags?: unknown } | null | undefined)?.risk_flags;
  return Array.isArray(flags) && flags.some((flag) => SECURITY_RISK_FLAGS.has(flag as string));
}

/**
 * #976 accepts only an anchored list of pure check-status restatements.
 * The maintainer's invariant is "status-only syntax, not merely status-only vocabulary";
 * false negatives are preferable to deterministic false approvals.
 */
const CI_STATUS_RESTATEMENT_PREDICATES = [
  "failed", "has failed", "is failing", "is still failing", "still failing",
  "keeps failing", "keeps on failing", "has a terminal failure", "is red", "went red",
  "timed out", "was cancelled", "was canceled", "is cancelled", "is canceled",
  "cancelled", "canceled", "did not pass", "has not passed", "was superseded",
  "is broken", "is stuck", "is pending", "is not passing",
] as const;

export function capCiOnlyFindings(
  findings: ArtifactFinding[],
  checkNames: ReadonlySet<string>,
): boolean {
  const names = [...checkNames]
    .filter((name) => name.trim() !== "")
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (names.length === 0) return false;

  const nameSlot = `(?<![\\p{L}\\p{N}_])(?:${names.join("|")})(?![\\p{L}\\p{N}_])`;
  const namePhrase = `${nameSlot}(?:\\s*(?:,|\\band\\b|\\bor\\b)\\s*${nameSlot})*`;
  const predicates = CI_STATUS_RESTATEMENT_PREDICATES.map(escapeRegExp).join("|");
  const restatement = new RegExp(
    `^(?:(?:the|a|an)\\s+)?${namePhrase}\\s+(?:again\\s+|still\\s+)?(?:${predicates})(?:\\s+again)?[.!]?$`,
    "iu",
  );

  let capped = false;
  for (const finding of findings) {
    if (
      finding.file !== null
      || !isBlockingSeverity(finding.severity)
      || !restatement.test(finding.message.trim())
    ) continue;

    finding.capped_from = finding.severity;
    finding.severity = "info";
    finding.ci_capped = true;
    capped = true;
  }
  return capped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function capNonBlockingFindings(
  findings: ArtifactFinding[],
  categories: ReadonlySet<string>,
  securityFlagged: boolean,
): boolean {
  // v2 intersects the configured list with the eligible set inside
  // _cap_non_blocking_findings; keep that defense here so a caller that
  // bypasses parseNonBlockingCategories can never cap `security`.
  const effective = new Set([...categories].filter((c) => NON_BLOCKING_ELIGIBLE.has(c)));
  if (effective.size === 0 || securityFlagged) {
    return false;
  }
  let capped = false;
  for (const finding of findings) {
    if (
      effective.has(finding.category)
      && (finding.severity === "blocker" || finding.severity === "major")
    ) {
      finding.capped_from = finding.severity;
      finding.severity = "minor";
      capped = true;
    }
  }
  return capped;
}

function noBlockingFindings(findings: ArtifactFinding[]): boolean {
  return !findings.some(isBlockingFinding);
}

function canRelaxForCiOnly(artifact: ReviewArtifact, forced: boolean): boolean {
  return !forced
    && !hasUnresolvedRequiredCheck(artifact)
    && artifact.required_checks !== "incomplete"
    && artifact.requirement_trace_incomplete !== true;
}

/**
 * #770 interplay: the MODEL's own structured `unresolved` dispositions also
 * hold the relaxation gate — a review that left a required check unresolved
 * does not get relaxed to approve by category capping.
 */
function hasUnresolvedRequiredCheck(artifact: ReviewArtifact): boolean {
  const rows = artifact.required_check_dispositions;
  return Array.isArray(rows)
    && rows.some((row) => (row as { status?: unknown } | null)?.status === "unresolved");
}

/**
 * #977: relax a model-authored request_changes whose ONLY still-open findings
 * are verification asks — the author has nothing to change.
 *
 * Deliberately narrow. It never fires for a zero-finding request_changes, a
 * mixed finding set, or when any independent deterministic gate is in play:
 * a fail-closed enforcement layer, an unresolved required check, incomplete
 * required-check coverage, or an unmet requirement trace. Everywhere else the
 * model pass-through contract is unchanged.
 */
export function relaxVerificationOnlyVerdict(
  artifact: ReviewArtifact,
  options: { forced: boolean },
): boolean {
  if (artifact.verdict !== "request_changes") return false;
  if (!canRelaxForCiOnly(artifact, options.forced)) return false;
  const findings = artifact.findings;
  if (!Array.isArray(findings) || findings.length === 0) return false;
  if (!findings.every((finding) => isAlwaysNonBlockingCategory(finding.category))) return false;
  artifact.review_markdown = (artifact.review_markdown || "")
    + "\n\n_Verdict relaxed from structured findings (#977): every open finding is a "
    + "verification request the review tools cannot check, so the author has nothing to "
    + "change. The findings remain listed above._";
  artifact.verdict = "approve";
  artifact.verdict_source = "findings";
  return true;
}

/**
 * #976: relax a model-authored request_changes when every open finding is
 * either #977 verification or a CI-only conclusion capped to info. It keeps
 * the same forced/unresolved-check safeguards but is separate from #977's
 * verification-only contract.
 */
export function relaxCiOnlyVerdict(
  artifact: ReviewArtifact,
  options: { forced: boolean },
): boolean {
  if (artifact.verdict !== "request_changes") return false;
  if (!canRelaxForCiOnly(artifact, options.forced)) return false;
  const findings = artifact.findings;
  if (!Array.isArray(findings) || findings.length === 0) return false;
  const allRelaxable = findings.every((finding) =>
    isAlwaysNonBlockingCategory(finding.category)
    || (finding.ci_capped === true && finding.severity === "info"));
  if (!allRelaxable) return false;
  artifact.review_markdown = (artifact.review_markdown || "")
    + "\n\n_Verdict relaxed from CI-only findings (#976): check conclusions are shown for context and gate the merge independently; they are not review blockers._";
  artifact.verdict = "approve";
  artifact.verdict_source = "findings";
  return true;
}

/**
 * #1016: a finding whose grounding_status is "refuted" or "unsupported"
 * carries positive evidence the claim is wrong (source contradicted it, or
 * there was no specific violation to verify). A "grounded" finding keeps
 * its severity; an "unverified" finding could not be checked at all.
 *
 * The relaxation below only accepts refuted/unsupported demotions — never
 * unverified ones. Unknown evidence cannot certify a clean review: the
 * verifier did not disprove the claim, it just could not read the source.
 * The review and the publish guard keep `request_changes` for those
 * (strict mapping sees the unverified list via the `forced` signal at its
 * call site; this relaxer refuses to flip a verdict whose only blockers
 * could not be checked).
 */
function isRefutedOrUnsupportedGrounding(finding: ArtifactFinding): boolean {
  const status = (finding as { grounding_status?: unknown }).grounding_status;
  return status === "refuted" || status === "unsupported";
}

function isUnverifiedGrounding(finding: ArtifactFinding): boolean {
  return (finding as { grounding_status?: unknown }).grounding_status === "unverified";
}

/**
 * #1016: relax a model-authored request_changes whose every still-open finding
 * is non-blocking because the deterministic blocker-verification boundary
 * positively refuted it (grounding_status refuted/unsupported) — alongside
 * #977 verification and #976 CI-only findings. Same forced/unresolved-check
 * safeguards as #977; never fires for zero findings, a mixed finding set, any
 * independent deterministic gate, or when any demoted grounding is
 * "unverified" (unknown evidence, not a refutation).
 */
export function relaxUnverifiedBlockerVerdict(
  artifact: ReviewArtifact,
  options: { forced: boolean },
): boolean {
  if (artifact.verdict !== "request_changes") return false;
  if (!canRelaxForCiOnly(artifact, options.forced)) return false;
  const findings = artifact.findings;
  if (!Array.isArray(findings) || findings.length === 0) return false;
  // Unknown evidence must never certify a clean review: refuse the relaxer
  // outright when any open finding has grounding_status="unverified". The
  // strict verdict mapping applies the same fail-closed rule via the
  // `forced` flag at its call site.
  if (findings.some(isUnverifiedGrounding)) return false;
  const allRelaxable = findings.every((finding) =>
    isAlwaysNonBlockingCategory(finding.category)
    || isRefutedOrUnsupportedGrounding(finding)
    || (finding.ci_capped === true && finding.severity === "info"));
  if (!allRelaxable) return false;
  if (!findings.some(isRefutedOrUnsupportedGrounding)) return false;
  artifact.review_markdown = (artifact.review_markdown || "")
    + "\n\n_Verdict relaxed from structured findings (#1016): every open finding was either a verification request or a source claim the deterministic blocker-verification boundary positively refuted against exact-head source; the findings remain listed above and deterministic gates are unaffected._";
  artifact.verdict = "approve";
  artifact.verdict_source = "findings";
  return true;
}

export interface VerdictPolicyResult {
  /** "model" | "findings" | "enforcement" — the applied verdict source:
   * "findings" when the strict mapping overrode the model verdict from the
   * open-findings rule, "enforcement" when a fail-closed layer forced a
   * verdict the model did not produce, "model" otherwise. */
  source: "model" | "findings" | "enforcement";
}

/**
 * Apply the verdict policy to the artifact in place. `policy` is the
 * `verdict_policy` config value ("model" default). `nonBlockingCategories`
 * is the parsed #775 opt-in list; `securityFlagged` the classification
 * risk-flag exemption. Returns (and records as `verdict_source`) the source
 * applied. Enforcement overlays run after this and can still force
 * request_changes.
 */
export function applyVerdictPolicy(
  artifact: ReviewArtifact,
  policy: string,
  options: { nonBlockingCategories: ReadonlySet<string>; securityFlagged: boolean },
): VerdictPolicyResult {
  const findings = artifact.findings;
  let source: "model" | "findings" | "enforcement" = "model";

  if (policy === "findings_severity_gated" && Array.isArray(findings)) {
    if (
      capNonBlockingFindings(findings, options.nonBlockingCategories, options.securityFlagged)
      && noBlockingFindings(findings)
      && artifact.verdict === "request_changes"
      && !hasUnresolvedRequiredCheck(artifact)
    ) {
      artifact.review_markdown += (
        "\n\n_Verdict relaxed from structured findings "
        + "(verdict_policy=findings_severity_gated): every blocking finding "
        + "was in a category this repository marks non-blocking "
        + "(non_blocking_finding_categories); they remain listed above._"
      );
      artifact.verdict = "approve";
      source = "findings";
    }
    const blockers = findings.filter((finding) => finding.severity === "blocker" && !isAlwaysNonBlockingCategory(finding.category));
    if (blockers.length > 0 && artifact.verdict !== "request_changes") {
      artifact.review_markdown += (
        "\n\n_Verdict escalated from structured findings "
        + `(verdict_policy=findings_severity_gated): ${blockers.length} blocker finding(s) `
        + `out of ${findings.length}; model verdict was '${artifact.verdict}'._`
      );
      artifact.verdict = "request_changes";
      source = "findings";
    }
  }

  artifact.verdict_source = source;
  return { source };
}

// ---------------------------------------------------------------------------
// #811: the strict verdict — the published verdict is a deterministic
// function of the normalized still-open findings and required-check
// coverage; the model's verdict is an input, not the final answer.
// ---------------------------------------------------------------------------

/**
 * The published review state under `verdict_policy=strict`, recorded in the
 * metadata marker's `review_result`: `issues` (blocking), `partial`
 * (coverage gap), `findings` (open non-blocking findings), `clean` (nothing
 * open, coverage complete). Precedence is blocking > partial > findings >
 * clean. `clean`/`issues` keep their v2 meaning because the unchanged-diff
 * carry-forward reads them; `findings`/`partial` carry an approve.
 */
export type StrictReviewResult = "issues" | "partial" | "findings" | "clean";

/** The open finding severities that can request changes (#811): blocker and
 * major only. Minor and info can never request changes on their own. */
export function hasBlockingOpenFinding(findings: unknown): boolean {
  return Array.isArray(findings) && findings.some((finding) => {
    const severity = (finding as { severity?: unknown } | null)?.severity;
    const category = (finding as { category?: unknown } | null)?.category;
    return (severity === "blocker" || severity === "major")
      && !isAlwaysNonBlockingCategory(category);
  });
}

/**
 * The strict state rule, shared by the enforcement mapping (which decides
 * the verdict from these inputs) and the publish step (which labels the
 * marker from the same inputs), so the two cannot drift. `requiredChecks`
 * is the completeness pass status; `none` (validation off or nothing to
 * check) is not a gap. #810's tool-loop partial coverage joins this once
 * implemented.
 */
export function strictReviewResult(
  verdict: string,
  findings: unknown,
  requiredChecks: unknown,
): StrictReviewResult {
  if (verdict === "request_changes") return "issues";
  if (requiredChecks === "incomplete") return "partial";
  if (Array.isArray(findings) && findings.length > 0) return "findings";
  return "clean";
}

export interface StrictVerdictOutcome {
  verdict: VerdictValue;
  reviewResult: StrictReviewResult;
  /** "model" when the published verdict equals the model's, "findings" when
   * the strict mapping overrode it (same vocabulary as applyVerdictPolicy). */
  source: "model" | "findings" | "enforcement";
  /** True when the strict mapping's verdict differs from the model's own. */
  overridden: boolean;
}

function severityCounts(findings: ArtifactFinding[]): { blocking: number; total: number } {
  let blocking = 0;
  for (const finding of findings) {
    if (isBlockingFinding(finding)) blocking += 1;
  }
  return { blocking, total: findings.length };
}

function appendStrictNote(artifact: ReviewArtifact, detail: string, modelVerdict: string): void {
  artifact.review_markdown = (artifact.review_markdown || "")
    + `\n\n_Verdict set from open findings (verdict_policy=strict): ${detail}; `
    + `model verdict was '${modelVerdict}'._`;
}

/**
 * Build the strict-mapping attribution note for an override to
 * `request_changes`. Names every contributing safety signal so the reader
 * can see exactly why the verdict is what it is: a blocker count when
 * open blockers exist, an "unknown evidence" note when an unverified
 * demotion co-exists, and an enforcement-forced note when a fail-closed
 * layer fired. Multiple signals compose with `;` so the override line
 * stays one attribution note rather than three.
 */
function strictRequestChangesDetail(input: {
  counts: { blocking: number; total: number };
  unverifiedGrounding: boolean;
  forced: boolean;
}): string {
  const parts: string[] = [];
  if (input.counts.blocking > 0) {
    parts.push(`${input.counts.blocking} blocker/major finding(s) out of ${input.counts.total} open`);
  }
  if (input.unverifiedGrounding) {
    parts.push("blocker-verification boundary could not confirm a demoted source claim (unknown evidence, not refuted; #1016)");
  }
  if (input.forced) {
    parts.push("a fail-closed enforcement layer forced request_changes");
  }
  if (parts.length === 0) {
    // No findings, no unverified, no forced — the reviewer would be a
    // request_changes with nothing to attribute to. This branch is
    // unreachable in practice: the caller already established that at
    // least one signal fires when this helper runs.
    return "request_changes";
  }
  return parts.join("; ");
}

/**
 * Apply the strict verdict mapping (#811) to the artifact in place. Runs
 * LAST in the enforcement pipeline — after the completeness pass (which
 * records `required_checks`) and after the enforcement overlays — so it
 * sees the final still-open findings set: the normalized findings array
 * including any threads the settlement pass re-emitted. That array is the
 * single source of truth ("still-open" = after carry-forward resolution,
 * #792); there is no other open-findings set to reconcile with.
 *
 * Mapping: request_changes only when at least one open finding is blocker
 * or major; otherwise approve. `forced` is the caller's fail-closed signal
 * — a forcing layer (evidence blocker, tool-harness failure, min-successful,
 * `required_check_validation_mode=fail`) fired for these inputs. The
 * mapping also computes a #1016 unknown-evidence signal from the artifact's
 * own `grounding_status`: any demoted finding with `grounding_status ===
 * "unverified"` (the verifier could not check the claim — it did not disprove
 * the claim) forces `request_changes` with a `#1016` attribution note, so
 * an approve cannot silently certify a clean review the verifier never
 * confirmed. Refuted/unsupported demotions alone do not force — they flow
 * through the normal strict mapping.
 *
 * When an override flips the model verdict, the attribution note names
 * EVERY contributing safety signal — blocker counts, unverified-grounding
 * (#1016), and forced enforcement — so the review markdown discloses the
 * full authority model. A blocker count alone produces the unchanged
 * "N blocker/major finding(s) out of M open" prose; an unverified
 * co-existence adds the #1016 attribution; a forced layer adds the
 * enforcement-forced disclosure. Provenance (`verdict_source`) reflects
 * the dominant authority per branch ("findings" for blocker count,
 * "enforcement" for forced/unverified-only), so a mixed-blocker-plus-
 * unverified verdict still disclaims the model layer while disclosing
 * both contributions inline.
 * When the mapping overrides the model verdict the review says so in one
 * line, as findings_severity_gated does.
 */
export function applyStrictVerdictPolicy(
  artifact: ReviewArtifact,
  options: { modelVerdict: string; forced: boolean },
): StrictVerdictOutcome {
  const findings = Array.isArray(artifact.findings) ? artifact.findings : [];
  const modelVerdict = options.modelVerdict;
  const counts = severityCounts(findings);
  const unverifiedGrounding = findings.some(isUnverifiedGrounding);

  let verdict: VerdictValue;
  let overridden: boolean;
  let source: "model" | "findings" | "enforcement";
  if (counts.blocking > 0) {
    verdict = "request_changes";
    overridden = modelVerdict !== "request_changes";
    source = overridden ? "findings" : "model";
    if (overridden) {
      appendStrictNote(
        artifact,
        strictRequestChangesDetail({ counts, unverifiedGrounding, forced: options.forced }),
        modelVerdict,
      );
    }
  } else if (options.forced || unverifiedGrounding) {
    // A fail-closed enforcement layer decided this verdict. When the model
    // did not produce it, attributing the verdict to "model" would lie
    // about provenance — the deciding authority is the enforcement layer
    // ("enforcement"); the layer's own section discloses the forcing.
    // #1016: when the only blocker-level demotions are "unverified"
    // (unknown evidence, not refutation), the boundary did not disprove the
    // claim — it could not check it — so an approve would silently
    // certify a clean review the verifier never confirmed. Treat as a
    // fail-closed forcing condition with a #1016 attribution note.
    //
    // Reached only when `counts.blocking === 0` (the first branch
    // captures the blocker-count path), so the helper emits a
    // single-signal attribution line — the unverified #1016 note
    // when present, the fail-closed enforcement note when present,
    // or both joined with `;` when both fire.
    verdict = "request_changes";
    overridden = modelVerdict !== "request_changes";
    source = overridden ? "enforcement" : "model";
    if (overridden) {
      appendStrictNote(
        artifact,
        strictRequestChangesDetail({ counts, unverifiedGrounding, forced: options.forced }),
        modelVerdict,
      );
    }
  } else {
    verdict = "approve";
    overridden = modelVerdict !== "approve";
    source = overridden ? "findings" : "model";
    if (overridden) {
      appendStrictNote(
        artifact,
        counts.total > 0
          ? `no blocker or major finding out of ${counts.total} open`
          : "no open findings",
        modelVerdict,
      );
    }
  }

  const reviewResult = strictReviewResult(verdict, findings, artifact.required_checks);
  artifact.verdict = verdict;
  artifact.verdict_source = source;
  return { verdict, reviewResult, source, overridden };
}
