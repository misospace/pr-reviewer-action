/**
 * Verdict policy (#680 port of `pr_reviewer/enforcement.py::apply_verdict_policy`,
 * carrying #772 and the #775 opt-in rework).
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
 */
import type { ReviewArtifact, ArtifactFinding } from "./artifact.js";

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
 * Cap blocker/major findings in the configured non-blocking categories at
 * minor, in place, recording the original severity. Returns whether anything
 * changed. (#775: the category list is opt-in; #772's fixed baseline is the
 * `tests,docs,style,question` configuration the repository itself sets.)
 */
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
  return !findings.some((f) => f.severity === "blocker" || f.severity === "major");
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

export interface VerdictPolicyResult {
  /** "model" | "findings" — the applied verdict source. */
  source: "model" | "findings";
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
  let source: "model" | "findings" = "model";

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
    const blockers = findings.filter((finding) => finding.severity === "blocker");
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
