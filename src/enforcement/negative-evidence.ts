/**
 * Deterministic negative-evidence application (#1517).
 *
 * The consumer half of `src/evidence/negative-evidence.ts`: read the
 * evidence phase's persisted rules, refuse every rule whose provenance does
 * not pin the exact head under review, then — after finding normalization —
 * demote the narrow classes of model findings an authoritative clean tool
 * run positively contradicts.
 *
 * Safety boundaries (all fail-closed):
 * - A clean tool run is evidence about its OWN declared domain only. The
 *   rule's declared `categories`, the per-domain claim-shape gates below and
 *   the covered-path match must ALL agree before a finding is touched; a
 *   formatter-clean signal can never reach a semantic or security finding.
 * - #1517 calibration hardening (2026-11-06 corpus eval): a message about
 *   ALTERING the tool's coverage — "the diff removes the yamllint
 *   duplicate-key detection from the validate job" (pr-reviewer-action#467)
 *   — is not a claim of violating that tool and is never demoted; a
 *   formatter cue inside a comparative construction ("rather than
 *   whitespace", "isn't treated as indented", courier#108) describes the
 *   code rather than claiming a violation; and a generic identity token
 *   ("the" word-boundedly matched 71/74 real corpus findings) is refused at
 *   parse time and re-refused at the persisted-rule gate.
 * - `blocker`-severity findings are NEVER contradicted by negative evidence
 *   (the spec parser already refuses a blocker ceiling; this is the second,
 *   independent cap). Security-category findings never match a rule at all
 *   (the parser refuses `security` in a rule's categories).
 * - Findings synthesized by the deterministic enforcement layer
 *   (DETERMINISTIC_FINDING_CATEGORIES) are not model claims and are never
 *   touched.
 * - Missing, skipped, stale, timed-out, errored and truncated runs produced
 *   no rule at derivation; a rule whose recorded head differs from the head
 *   under review (or that has no usable head) is ignored here. Partial file
 *   coverage affects only the covered paths.
 * - A provider that REPORTED findings derived no rule, so a positive tool
 *   finding and a contradictory model finding both stay visible.
 * - The original finding is never removed: a demotion records the original
 *   severity in `capped_from` and the decision + reason on the finding and
 *   in the artifact-level `negative_evidence` record for eval calibration.
 *
 * Like the other deterministic content-level passes (outside-diff tagging,
 * blocker verification), this changes finding severity/labels only — it
 * never adds a verdict overlay; the existing verdict policy sees the final
 * severities. No model input, no model call.
 */

import type { NegativeEvidenceRule } from "../evidence/negative-evidence.js";
import { NEGATIVE_EVIDENCE_SCHEMA } from "../evidence/negative-evidence.js";
import { isGenericNegativeEvidenceToken } from "../evidence/providers.js";
import type { ArtifactFinding } from "./artifact.js";
import { DETERMINISTIC_FINDING_CATEGORIES, canonicalTreePath, safeFile } from "./blocker-verification.js";

/** The demotion ladder: a contradicted finding drops exactly one severity
 * level (major → minor, minor → info). `info` cannot drop further. */
const DEMOTE_ONE_LEVEL: Partial<Record<ArtifactFinding["severity"], ArtifactFinding["severity"]>> = {
  major: "minor",
  minor: "info",
};

const SEVERITY_ADMISSIBILITY: Record<NonNullable<NegativeEvidenceRule["max_severity"]> | "blocker", number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export type NegativeEvidenceDecision = "demoted" | "unchanged";

export interface NegativeEvidenceFindingDecision {
  index: number;
  provider: string;
  domain: string;
  decision: NegativeEvidenceDecision;
  reason: string;
}

export interface NegativeEvidenceApplyResult {
  decisions: NegativeEvidenceFindingDecision[];
  demoted: number;
}

export interface NegativeEvidenceRecord {
  rules: number;
  decisions: NegativeEvidenceFindingDecision[];
  /** Rules that were refused at the freshness gate (stale-head provenance,
   * unknown head) — recorded so an operator can see why nothing fired. */
  stale_rules: number;
}

/**
 * Read the persisted sidecar into applicable rules. Every gate is
 * fail-closed: wrong/absent schema, non-array rules, a malformed rule, a
 * rule whose recorded head is missing, or a rule (or sidecar) whose head
 * does not equal the exact head under review yields NO rules.
 */
export function negativeEvidenceRulesFromArtifact(
  value: unknown,
  currentHeadSha: string | null | undefined,
): { rules: NegativeEvidenceRule[]; stale: number } {
  const current = (currentHeadSha ?? "").trim().toLowerCase();
  if (current === "" || value === null || typeof value !== "object" || Array.isArray(value)) {
    return { rules: [], stale: 0 };
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== NEGATIVE_EVIDENCE_SCHEMA) return { rules: [], stale: 0 };
  // Sidecar-level provenance: the whole file must speak for the head under
  // review, not just individual rules.
  const sidecarHead = typeof record.head_sha === "string" ? record.head_sha.trim().toLowerCase() : "";
  if (sidecarHead !== current) return { rules: [], stale: 0 };
  if (!Array.isArray(record.rules)) return { rules: [], stale: 0 };

  const rules: NegativeEvidenceRule[] = [];
  let stale = 0;
  for (const raw of record.rules) {
    const rule = parsePersistedRule(raw);
    if (rule === null) {
      stale += 1;
      continue;
    }
    const ruleHead = (rule.head_sha ?? "").trim().toLowerCase();
    if (ruleHead !== current) {
      stale += 1;
      continue;
    }
    rules.push(rule);
    if (rules.length >= 128) break;
  }
  return { rules, stale };
}

/** Re-validate a persisted rule defensively (bounded shapes, same limits the
 * spec parser enforced at derivation — including the generic-token refusal:
 * a tampered or legacy sidecar cannot smuggle an identity like "the" past
 * the persistence gate). */
function parsePersistedRule(raw: unknown): NegativeEvidenceRule | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const provider = record.provider;
  const domain = record.domain;
  if (typeof provider !== "string" || provider === "" || provider.length > 128) return null;
  if (domain !== "formatter" && domain !== "lint" && domain !== "schema") return null;
  if (!isBoundedStringArray(record.paths, 64, 256) || record.paths.length === 0) return null;
  if (!isBoundedStringArray(record.categories, 16, 32) || record.categories.length === 0) return null;
  if (record.max_severity !== "major" && record.max_severity !== "minor" && record.max_severity !== "info") return null;
  if (typeof record.identity !== "string" || record.identity === "" || record.identity.length > 128) return null;
  if (record.identity.trim() !== record.identity) return null;
  if (isGenericNegativeEvidenceToken(record.identity)) return null;
  if (!isBoundedStringArray(record.rules, 64, 128)) return null;
  for (const ruleId of record.rules) {
    if (ruleId.trim() !== ruleId || isGenericNegativeEvidenceToken(ruleId)) return null;
  }
  if (record.head_sha !== null && (typeof record.head_sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.head_sha))) return null;
  return {
    provider,
    domain,
    paths: record.paths,
    categories: record.categories,
    max_severity: record.max_severity,
    identity: record.identity,
    rules: record.rules,
    head_sha: record.head_sha,
  };
}

function isBoundedStringArray(value: unknown, max: number, maxChars: number): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length > max) return false;
  return value.every((item) => typeof item === "string" && item !== "" && item.length <= maxChars);
}

// ── Per-domain claim-shape gates ─────────────────────────────────────────
// Deliberately conservative word-bounded cues: an unmatched claim stays
// untouched (the fail-safe direction — an over-narrow gate leaves a real
// formatting claim blocking, it never wrongly demotes a different claim).

/** A PURE formatting/whitespace claim (formatter domain). */
const FORMATTER_CLAIM_RE =
  /\b(?:whitespace|indent(?:ation|s|ed|ing)?|spacing|trailing[ -](?:space|whitespace|tab)s?|formatting|formatted|format[ -]?(?:issue|problem|violation|error)|line[ -]length|code[ -]style|style[ -](?:issue|problem|violation|error))\b/i;

/** A schema/config-validation failure claim (schema domain). */
const SCHEMA_CLAIM_RE =
  /\b(?:schema|does[ -]not[ -]conform|invalid[ -]?(?:config|configuration|syntax|hcl|yaml|json)|fails?[ -]?(?:schema[ -]?)?validation|validation[ -]?(?:error|failure|fail)|malformed[ -]?(?:config|configuration)|not[ -]valid)\b/i;

/**
 * #1517 calibration hardening (courier#108 shape): a cue word used in a
 * comparative/treatment construction DESCRIBES the code rather than claiming
 * a formatting violation — "continuation lines start with a box-drawing
 * character rather than whitespace", "the reason line isn't treated as
 * indented". A clean formatter says nothing about such a claim, so a cue
 * that only occurs inside one of these constructions is refused. A cue
 * occurring anywhere else still claims ("trailing whitespace on line 3",
 * "the file is not formatted").
 */
const COMPARATIVE_CUE_RE =
  /(?:\b(?:rather than|instead of|in place of|treated as|treats? (?:[\w-]+\s+){0,3}as|considered as|regarded as|classified as|counts as|counted as|viewed as|read as)\s*)$/i;

function cueInsideComparativeConstruction(message: string, cueStart: number): boolean {
  const before = message.slice(Math.max(0, cueStart - 64), cueStart);
  return COMPARATIVE_CUE_RE.test(before);
}

/**
 * #1517 calibration hardening (pr-reviewer-action#467 shape): a claim ABOUT
 * the validation tool or check itself — removing/altering its coverage
 * ("the diff removes the yamllint duplicate-key detection from the validate
 * job") — is not a claim of violating that tool, and a clean run of the
 * tool does not contradict it. Refuse the whole message when coverage-
 * alteration vocabulary and a coverage noun co-occur; every domain gate
 * consults this before its own cues. Deliberately over-refusing (an
 * unmatched claim stays untouched — the fail-safe direction).
 */
const COVERAGE_ALTERATION_RE =
  /\b(?:remov\w+|delet\w+|disabl\w+|enabl\w+|drop(?:s|ped|ping)?|skip(?:s|ped|ping)?|ignor\w+|exclud\w+|includ\w+|add(?:s|ed|ing)?|replac\w+|updat\w+|weaken\w+|relax\w+|tighten\w+|loosen\w+|downgrad\w+|upgrad\w+|renam\w+|no longer)\b/i;
const COVERAGE_NOUN_RE =
  /\b(?:checks?|coverage|detection|validat\w+|suite|jobs?|gates?|enforcement|steps?|pipelines?|workflows?|ci)\b/i;

function isCoverageAlterationClaim(message: string): boolean {
  return COVERAGE_ALTERATION_RE.test(message) && COVERAGE_NOUN_RE.test(message);
}

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-bounded substring test for a tool/rule identity token. */
function mentionsToken(message: string, token: string): boolean {
  const needle = escapeRegExpLiteral(token);
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${needle}(?:$|[^A-Za-z0-9_-])`, "i").test(message);
}

/** True when the finding's message is the claim class the rule's domain
 * contradicts. */
export function negativeEvidenceClaimMatches(message: string, rule: NegativeEvidenceRule): boolean {
  if (isCoverageAlterationClaim(message)) return false;
  if (rule.domain === "formatter") {
    // At least one cue must occur OUTSIDE a comparative construction for
    // the message to claim a formatting violation.
    for (const match of message.matchAll(new RegExp(FORMATTER_CLAIM_RE.source, "gi"))) {
      if (!cueInsideComparativeConstruction(message, match.index ?? 0)) return true;
    }
    return false;
  }
  const identityHit = mentionsToken(message, rule.identity)
    || rule.rules.some((ruleId) => message.toLowerCase().includes(ruleId.toLowerCase()));
  if (rule.domain === "lint") return identityHit;
  return SCHEMA_CLAIM_RE.test(message) || identityHit;
}

/**
 * The covered-path match: a plain pattern covers the exact path and
 * everything beneath it (a directory or a file); a trailing `/` is the same
 * directory form; `*` matches within one path segment and `**` across
 * segments. Returns the matched pattern as written, or null.
 */
export function negativeEvidencePathCovered(file: string, patterns: readonly string[]): string | null {
  const segments = canonicalTreePath(file).split("/");
  for (const rawPattern of patterns) {
    const pattern = rawPattern.endsWith("/") ? rawPattern.slice(0, -1) : rawPattern;
    if (pattern === "") continue;
    const parts = pattern.split("/");
    if (globMatch(parts, segments)) return rawPattern;
    // A plain (non-glob) pattern covers its own subtree: "src" covers
    // "src/a.ts" and "src/x/b.ts" but not "srcx.ts".
    if (!pattern.includes("*") && parts.length <= segments.length
      && parts.every((part, index) => part === segments[index])) return rawPattern;
  }
  return null;
}

function globMatch(pattern: readonly string[], segments: readonly string[]): boolean {
  if (pattern.length === 0) return segments.length === 0;
  const head = pattern[0]!;
  const rest = pattern.slice(1);
  if (head === "**") {
    for (let skip = 0; skip <= segments.length; skip += 1) {
      if (globMatch(rest, segments.slice(skip))) return true;
    }
    return false;
  }
  if (segments.length === 0) return false;
  const file = segments[0]!;
  if (!globSegment(head, file)) return false;
  return globMatch(rest, segments.slice(1));
}

function globSegment(pattern: string, segment: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return segment === pattern;
  // Segment-local glob: `*` runs match any (possibly empty) run of
  // non-separator characters.
  const regex = new RegExp(`^${escapeRegExpLiteral(pattern).replaceAll("\\*", ".*")}$`);
  return regex.test(segment);
}

interface MatchedRule {
  rule: NegativeEvidenceRule;
  pattern: string;
}

/** The first rule (artifact order) that may speak about this finding, or
 * null. The category/security/deterministic hard caps live here so no
 * caller can bypass them; the blocker cap is applied by the caller so a
 * refused blocker match is still RECORDED (see applyNegativeEvidence). */
function matchFinding(finding: ArtifactFinding, rules: readonly NegativeEvidenceRule[]): MatchedRule | null {
  const category = typeof finding.category === "string" ? finding.category : "";
  // Hard caps independent of the rule declaration: security findings never
  // match, deterministic findings are not model claims.
  if (category === "security") return null;
  if (DETERMINISTIC_FINDING_CATEGORIES.has(category)) return null;
  const file = finding.file;
  if (typeof file !== "string" || !safeFile(file)) return null;
  const message = typeof finding.message === "string" ? finding.message : "";
  for (const rule of rules) {
    if (!rule.categories.includes(category)) continue;
    // Severity admissibility: a rule may contradict severities at or below
    // its ceiling (rank grows as severity shrinks). A `blocker` finding is
    // admitted past this check only so the caller can record the refusal —
    // it is never demoted.
    if (finding.severity !== "blocker"
      && (SEVERITY_ADMISSIBILITY[finding.severity] ?? 3) < SEVERITY_ADMISSIBILITY[rule.max_severity]) continue;
    const pattern = negativeEvidencePathCovered(file, rule.paths);
    if (pattern === null) continue;
    if (!negativeEvidenceClaimMatches(message, rule)) continue;
    return { rule, pattern };
  }
  return null;
}

/**
 * Apply the rules to the findings array in place. Returns the per-finding
 * decisions (demotions and refusals, each with its reason) for the
 * artifact-level calibration record. Idempotent: an already-marked finding
 * is re-matched but never demoted twice.
 */
export function applyNegativeEvidence(
  findings: ArtifactFinding[],
  rules: readonly NegativeEvidenceRule[],
): NegativeEvidenceApplyResult {
  const decisions: NegativeEvidenceFindingDecision[] = [];
  let demoted = 0;
  if (rules.length === 0) return { decisions, demoted };
  findings.forEach((finding, index) => {
    const matched = matchFinding(finding, rules);
    if (matched === null) return;
    const { rule, pattern } = matched;
    const head = rule.head_sha === null ? "" : rule.head_sha.slice(0, 12);
    const origin = `negative evidence: ${rule.domain} provider '${rule.provider}' ran clean at head ${head} covering '${pattern}'`;
    // The one severity hard cap: a blocker finding is never demoted by
    // negative evidence — the refusal is recorded (calibration) and the
    // finding is left exactly as it was.
    if (finding.severity === "blocker") {
      decisions.push({ index, provider: rule.provider, domain: rule.domain, decision: "unchanged", reason: "blocker findings are never contradicted by negative evidence" });
      return;
    }
    if (finding.negative_evidence !== undefined) {
      // Already decided by an earlier pass; keep the first decision, never
      // demote twice.
      return;
    }
    const target = DEMOTE_ONE_LEVEL[finding.severity];
    if (target === undefined) {
      decisions.push({ index, provider: rule.provider, domain: rule.domain, decision: "unchanged", reason: `${origin}; severity already non-blocking` });
      finding.negative_evidence = { provider: rule.provider, domain: rule.domain, decision: "unchanged", reason: `${origin}; severity already non-blocking` };
      return;
    }
    const original = finding.severity;
    if (finding.capped_from === undefined) finding.capped_from = original;
    finding.severity = target;
    const reason = `${origin}; ${original} demoted to ${target}`;
    finding.negative_evidence = { provider: rule.provider, domain: rule.domain, decision: "demoted", reason };
    decisions.push({ index, provider: rule.provider, domain: rule.domain, decision: "demoted", reason });
    demoted += 1;
  });
  return { decisions, demoted };
}

/**
 * The engine-side seam: apply the rules to a review record's findings and
 * persist the decision record on the artifact (`negative_evidence`) for eval
 * calibration. A record without a findings array, or a run with no
 * applicable rules, is a no-op that leaves the artifact bytes untouched.
 */
export function applyNegativeEvidenceToRecord(
  record: Record<string, unknown>,
  rules: readonly NegativeEvidenceRule[],
  staleRules: number,
): void {
  if (rules.length === 0) return;
  const findings = record.findings;
  if (!Array.isArray(findings)) return;
  const outcome = applyNegativeEvidence(findings as ArtifactFinding[], rules);
  const persisted: NegativeEvidenceRecord = {
    rules: rules.length,
    decisions: outcome.decisions,
    stale_rules: staleRules,
  };
  record.negative_evidence = persisted;
}
