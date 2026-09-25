import { readFileSync } from "node:fs";
import { evaluateRequiredCheckCoverage } from "../enforcement/required-checks.js";
import type { NormalizedRequiredCheckDisposition } from "../model/types.js";

/**
 * Escalation telemetry, ported from pr_reviewer/escalation.py.
 * #721 invariant: heuristics never gate a smart call; only the structured
 * reviewer request may trigger post-primary escalation.
 */
export const STUB_REVIEW_MIN_CHARS = 80;
const UNKNOWNS_HEADER_RE = /^#{1,6}\s*unknowns?\b[^\n]*$/im;
const EMPTY_SECTION_RE = /^\(?(none|n\/?a|nothing)\)?[.!]?$/i;
const ENVIRONMENTAL_UNKNOWN_TERMS = [
  "ci", "check result", "test", "pytest", "test suite", "tool output", "evidence", "corpus", "environment", "not configured", "not available", "unavailable", "not provided", "missing", "not executed", "not run",
];
const SUBSTANTIVE_UNKNOWN_TERMS = [
  "behavior", "code path", "correctness", "data loss", "invariant", "logic", "regression", "security", "state transition", "upstream changelog", "release notes",
];

type RecordLike = Record<string, unknown>;
export type EscalationFlags = {
  onIncomplete?: boolean;
  onRequestChanges?: boolean;
  onLowConfidence?: boolean;
  onBlockers?: boolean;
  onPlanningFailure?: boolean;
};

/** Read an artifact record, degrading to an empty object on every read/parse error. */
export function loadJsonRecord(path: string): RecordLike {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : {};
  } catch {
    return {};
  }
}

function hasPopulatedUnknowns(text: string): boolean {
  const match = UNKNOWNS_HEADER_RE.exec(text);
  if (!match || match.index === undefined) return false;
  const rest = text.slice(match.index + match[0].length).trim();
  const section = (rest.split(/^#{1,6}\s/m, 1)[0] ?? "").trim();
  if (!section || EMPTY_SECTION_RE.test(section) || section.length <= 40) return false;
  const normalized = section.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const environmental = ENVIRONMENTAL_UNKNOWN_TERMS.some((term) => normalized.includes(term));
  const substantive = SUBSTANTIVE_UNKNOWN_TERMS.some((term) => normalized.includes(term));
  return !(environmental && !substantive);
}

export function isLowConfidence(reviewMarkdown: string, minChars = STUB_REVIEW_MIN_CHARS): boolean {
  const text = (reviewMarkdown || "").trim();
  return text.length < minChars || hasPopulatedUnknowns(text);
}

function hasBlockerSignals(evidence: RecordLike, harness: RecordLike): boolean {
  if (evidence.has_blocker) return true;
  const executed = harness.executed_request_count ?? 0;
  const results = Array.isArray(harness.tool_results) ? harness.tool_results.filter(isRecord) : [];
  return Boolean(executed && results.length && !results.some((result) => result.status === "ok"));
}
function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasPlanningFailure(harness: RecordLike): boolean {
  return (harness.planning_error !== null && harness.planning_error !== undefined)
    || (harness.error !== null && harness.error !== undefined);
}

// v2 legacy keyword table in pr_reviewer/completeness.py; retained only for
// outputs where required_check_dispositions is truly absent.
const CONCEPTS: Record<string, string[]> = {
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
const FALLBACK_STOPWORDS = new Set("verify check review test with that this the for and are not all any from into after before changes change ensure explicitly".split(" "));
function legacyCheckAddressed(check: string, lower: string): boolean {
  const keywords = CONCEPTS[check] ?? (check.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((word) => !FALLBACK_STOPWORDS.has(word));
  return (keywords.length ? keywords : [check.toLowerCase()]).some((word) => lower.includes(word));
}

/** Heuristic escalation signals are telemetry only (#721), never smart-call gates. */
export function shouldEscalate(
  output: RecordLike = {},
  classification: RecordLike = {},
  evidence: RecordLike = {},
  harness: RecordLike = {},
  flags: EscalationFlags = {},
): { escalate: boolean; reasons: string[] } {
  const onIncomplete = flags.onIncomplete ?? false;
  const onRequestChanges = flags.onRequestChanges ?? true;
  const onLowConfidence = flags.onLowConfidence ?? true;
  const onBlockers = flags.onBlockers ?? true;
  const onPlanningFailure = flags.onPlanningFailure ?? false;
  const review = typeof output.review_markdown === "string" ? output.review_markdown : "";
  const reasons: string[] = [];
  if (onRequestChanges && output.verdict === "request_changes") reasons.push("fast_request_changes");
  if (onIncomplete) {
    const mustCheck = Array.isArray(classification.must_check) ? classification.must_check.filter(Boolean).map(String) : [];
    if (mustCheck.length) {
      const structuredPresent = Object.hasOwn(output, "required_check_dispositions");
      if (structuredPresent) {
        const raw = output.required_check_dispositions;
        const dispositions: NormalizedRequiredCheckDisposition[] | null = Array.isArray(raw) ? raw.filter(isRecord).map((item) => ({
          check: typeof item.check === "string" ? item.check : "",
          status: item.status === "satisfied" || item.status === "not_applicable" || item.status === "unresolved" ? item.status : "invalid",
          rationale: typeof item.rationale === "string" ? item.rationale : null,
        })) : null;
        if (evaluateRequiredCheckCoverage(mustCheck, dispositions).status !== "complete") reasons.push("incomplete_required_checks");
      } else {
        const lower = review.toLowerCase();
        if (mustCheck.some((check) => !legacyCheckAddressed(check, lower))) reasons.push("incomplete_required_checks");
      }
    }
  }
  if (onLowConfidence && isLowConfidence(review)) reasons.push("fast_low_confidence");
  if (onBlockers && hasBlockerSignals(evidence, harness)) reasons.push("tool_or_evidence_blockers");
  if (onPlanningFailure && hasPlanningFailure(harness)) reasons.push("tool_planning_failed");
  return { escalate: reasons.length > 0, reasons };
}

/** The only post-primary trigger (#721); heuristic signals never gate a smart call. */
export function reviewerRequestedEscalation(output: RecordLike): { requested: boolean; reason: string | null } {
  try {
    const requested = output?.smart_review_requested === true;
    const rawReason = output?.smart_review_reason;
    return { requested, reason: requested && typeof rawReason === "string" && rawReason.trim() ? rawReason : null };
  } catch {
    return { requested: false, reason: null };
  }
}
