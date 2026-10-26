import { readFileSync } from "node:fs";

/**
 * Escalation primitives, ported from pr_reviewer/escalation.py.
 * #721 invariant: heuristics never gate a smart call; only the structured
 * reviewer request may trigger post-primary escalation.
 * #1252: the v2 keyword-table escalation heuristics (`should_escalate` and
 * its keyword fallback) are removed; the sole post-primary trigger is the
 * structured reviewer request below.
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
