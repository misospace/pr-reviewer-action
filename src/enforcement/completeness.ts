/**
 * Deterministic review-completeness validation (#680 port of
 * `pr_reviewer/completeness.py`, structured-authoritative per #750).
 *
 * A `must_check` item is a mandatory review QUESTION. The model records one
 * structured disposition per item in `required_check_dispositions`; this
 * module folds those dispositions against the deterministic check list.
 *
 * v3 contract change (the #680 cutover): the v2 coexistence bridge — the
 * legacy shallow keyword match used when the model emitted no structured
 * dispositions at all — is REMOVED here, exactly as the Python module's
 * bridge note scheduled. Key absence is treated like present-but-unusable:
 * every check is conservatively unresolved. The structured evaluation is
 * always authoritative; no keyword mention can substitute for a missing or
 * malformed disposition.
 *
 * The version-1 coverage artifact itself is `evaluateRequiredCheckCoverage`
 * in `src/enforcement/required-checks.ts` (the #750 parity boundary); this
 * module composes it and owns the mode handling and markdown consequences.
 */
import type { ReviewArtifact } from "./artifact.js";
import {
  evaluateRequiredCheckCoverage,
  type RequiredCheckCoverage,
} from "./required-checks.js";
import type { NormalizedRequiredCheckDisposition } from "../model/types.js";

export type RequiredCheckValidationMode = "warn" | "fail" | "metadata_only";

export interface RequiredCheckValidationResult {
  /** "complete" | "incomplete" | "none" (none = validation did not run). */
  status: "complete" | "incomplete" | "none";
  mode: RequiredCheckValidationMode;
  /** The completeness result artifact written to completeness.json (v2 shape). */
  result: Record<string, unknown>;
}

/**
 * Legacy keyword concept table kept ONLY as the documented v2 oracle for the
 * parity qualification of the cutover (the v3 path never consults it — see
 * the module docstring). Ported verbatim so an approved-divergence fixture
 * can pin exactly what the removal changes.
 */
export const CHECK_CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  "verify no functional changes beyond lockfile hashes": ["lockfile", "hash", "digest", "functional change"],
  "check for breaking API changes in updated dependencies": ["breaking", "backward", "compatib", "api change"],
  "run full test suite after upgrade": ["test"],
  "validate manifest against target cluster version": ["cluster", "api version", "apiversion", "manifest"],
  "check for resource quota / limit changes": ["quota", "limit", "resource"],
  "review auth flow for regression": ["auth"],
  "verify session token handling is correct": ["session", "token"],
  "verify route access controls are in place": ["access control", "authoriz", "route"],
  "check for unintended public endpoints": ["public", "unauthenticated", "endpoint"],
  "verify file path sanitization": ["sanitiz", "normaliz", "realpath", "resolved path", "path containment"],
  "check for directory traversal vulnerabilities": ["traversal", "../", "symlink", "escape"],
  "review for path traversal vulnerabilities": ["traversal", "../", "symlink", "escape"],
  "test with edge-case paths (null bytes, symlinks)": ["null byte", "symlink", "edge case", "edge-case"],
  "verify secrets are not logged or exposed in diffs": ["secret", "leak", "exposed", "logged"],
  "check secret rotation impact": ["rotat"],
  "review migration for data loss risk": ["data loss", "destructive", "migration"],
  "test migration on a copy of production schema": ["schema", "migration"],
  "explicitly address the linked security issue": ["security"],
  "verify audit findings are addressed": ["audit"],
  "treat as critical — verify all changes thoroughly": ["critical", "p0", "thorough"],
  "treat as high priority — verify correctness carefully": ["high priority", "p1", "correct"],
};

const FALLBACK_STOPWORDS: ReadonlySet<string> = new Set([
  "verify", "check", "review", "test", "with", "that", "this", "the",
  "for", "and", "are", "not", "all", "any", "from", "into", "after",
  "before", "changes", "change", "ensure", "explicitly",
]);

function fallbackKeywords(item: string): string[] {
  const words = item.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  const filtered = words.filter((w) => !FALLBACK_STOPWORDS.has(w));
  return filtered.length > 0 ? filtered : [item.toLowerCase()];
}

/** v2 `is_addressed` — keyword oracle only (see module docstring). */
export function isAddressed(item: string, reviewLower: string): boolean {
  const keywords = CHECK_CONCEPTS[item] ?? fallbackKeywords(item);
  return keywords.some((keyword) => reviewLower.includes(keyword));
}

/** v2 `validate_review` — keyword oracle only (see module docstring). */
export function validateReview(mustCheck: readonly string[], reviewMarkdown: string): {
  validated: boolean;
  missing: string[];
  addressed: string[];
} {
  const reviewLower = (reviewMarkdown || "").toLowerCase();
  const missing = mustCheck.filter((item) => !isAddressed(item, reviewLower));
  const addressed = mustCheck.filter((item) => !missing.includes(item));
  return { validated: missing.length === 0, missing, addressed };
}

/**
 * Fold the artifact's structured dispositions (tri-state) against the
 * deterministic check list. `null` coverage means the model emitted no
 * usable dispositions array — including the v3 key-absence case, which is
 * conservatively unresolved (module docstring).
 */
export function structuredCoverage(
  mustCheck: readonly string[],
  artifact: ReviewArtifact,
): RequiredCheckCoverage {
  const emitted = Object.prototype.hasOwnProperty.call(artifact, "required_check_dispositions");
  const raw = artifact.required_check_dispositions;
  const dispositions: NormalizedRequiredCheckDisposition[] | null = emitted && Array.isArray(raw)
    ? (raw as unknown as NormalizedRequiredCheckDisposition[])
    : null;
  return evaluateRequiredCheckCoverage(mustCheck, dispositions);
}

/**
 * Validate the final review against must_check and act per mode (port of
 * `apply_required_check_validation`).
 *
 * enabled: auto (validate when must_check is non-empty) | true | false.
 * mode:    warn (append an Unaddressed-required-checks section; never flips
 *          the verdict) | fail (also force request_changes) | metadata_only
 *          (record the result without touching the published review).
 *
 * Mutates the artifact (`required_checks` status, warn/fail markdown) and
 * returns the recorded status plus the completeness.json result object.
 * Incompleteness never triggers smart escalation by itself (#721).
 */
export function applyRequiredCheckValidation(
  artifact: ReviewArtifact,
  options: {
    enabled: string;
    mode: string;
    mustCheck: readonly string[];
  },
): RequiredCheckValidationResult {
  const enabled = (options.enabled || "auto").trim().toLowerCase();
  let mode = (options.mode || "warn").trim().toLowerCase() as RequiredCheckValidationMode;
  if (mode !== "warn" && mode !== "fail" && mode !== "metadata_only") {
    mode = "warn";
  }
  const mustCheck = options.mustCheck;

  let status: "complete" | "incomplete" | "none";
  let result: Record<string, unknown>;

  if (enabled === "false" || ((enabled === "auto" || enabled === "true") && mustCheck.length === 0)) {
    status = "none";
    result = { status, mode, missing: [], addressed: [] };
  } else {
    // #750: the structured disposition contract is authoritative. Key
    // absence is no longer a bridge to the legacy keyword match (module
    // docstring): every check is conservatively unresolved.
    const coverage = structuredCoverage(mustCheck, artifact);
    status = coverage.status === "none" ? "none" : coverage.status;
    const unresolved = coverage.checks.filter((row) => row.status === "unresolved").map((row) => row.check);
    const resolved = coverage.checks.filter((row) => row.status !== "unresolved").map((row) => row.check);
    result = {
      status,
      mode,
      structured: coverage.structured,
      missing: unresolved,
      addressed: resolved,
      checks: coverage.checks.map((row) => ({
        check: row.check,
        status: row.status,
        rationale: row.rationale,
        reason: row.reason,
      })),
      dropped_unknown: coverage.droppedUnknown,
    };

    if (status === "incomplete" && (mode === "warn" || mode === "fail")) {
      const bullets = unresolved.map((item) => `- ${item}`).join("\n");
      artifact.review_markdown = (
        (artifact.review_markdown || "")
        + "\n\n### Unaddressed required checks\n"
        + "The classifier marked these checks as required for this PR's "
        + "risk profile, but the review does not resolve or disposition "
        + "them:\n\n"
        + bullets
      );
    }
    if (status === "incomplete" && mode === "fail") {
      artifact.verdict = "request_changes";
      artifact.review_markdown += (
        "\n\n_required_check_validation_mode=fail: treating the missing "
        + "required checks as blocking._"
      );
    }
  }

  artifact.required_checks = status;
  return { status, mode, result };
}
