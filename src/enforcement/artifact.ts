import type {
  NormalizedFinding,
  ParsedReviewVerdict,
  ReviewTriageDecision,
  VerdictValue,
} from "../model/types.js";

/**
 * The persisted review artifact (`ai-output.json` in v2) — the single object
 * every downstream consumer reads: enforcement mutates it, the outputs step
 * serializes it, the publish step renders it.
 *
 * This is a persisted-shape serialization boundary, so the field names stay
 * snake_case exactly as v2 writes them (see AGENTS.md naming rules): consumers
 * like `jq -r '.verdict'`, the metadata marker builder, and the focused
 * artifact tests compare these bytes. The working object is this artifact itself —
 * v2 enforcement mutates `ai-output.json` in place, and #680 keeps that
 * observable contract while moving the mutation into typed functions.
 */

export interface ArtifactFinding {
  severity: "blocker" | "major" | "minor" | "info";
  category: string;
  file: string | null;
  line: number | null;
  message: string;
  /** Specialist provenance (#624-era), passed through by the parser. */
  preliminary_finding?: number;
  /** #762: optional actionable fields; never verdict authority. */
  end_line?: number;
  suggestion?: string;
  agent_prompt?: string;
  /** Set only on findings re-emitted from unresolved review threads (#766):
   * the publish step skips inlining these — the thread already exists. */
  thread_id?: string;
  /** #775: original severity when the non-blocking category cap reduced it. */
  capped_from?: string;
  /** #976: this finding was capped because it relied only on a CI conclusion. */
  ci_capped?: boolean;
  /** v3-only, no v2 counterpart: set by the deterministic outside-diff pass
   * when the finding's file isn't in the diff, or its line falls outside
   * every hunk's new-side range. Content-level only — never changes
   * verdict, requirement coverage, or any other policy input. */
  outside_diff?: boolean;
  /** #1016, extended #1238: set by the deterministic blocker-verification
   * boundary when a model-authored source-backed claim (committed-source
   * literal, requirement claim, action-input declaration, or gate-absence)
   * was not substantiated by its witness — exact-head source for the first
   * two, the executing action's embedded contract for input declarations,
   * and the executing action's own implementation tree for gate-absence
   * claims.
   * One of "refuted" (the witness positively contradicts the claim),
   * "unverified" (the witness could not check it), or "unsupported" (no
   * concrete evidence to verify). Blocker/major findings are demoted to
   * minor with it; minor/info findings carry it without a severity change.
   * Never set on a grounded finding. */
  grounding_status?: "refuted" | "unverified" | "unsupported";
}

export interface ArtifactThreadDisposition {
  thread_id: string;
  disposition: "fixed" | "open" | "disputed" | "withdrawn";
  evidence: string | null;
  /** Downgrade note recorded by enforcement ("no disposition given", …). */
  enforced?: string;
}

export interface ArtifactHumanReviewDisposition {
  review_id: string;
  disposition: "addressed" | "not_addressed";
  evidence: string | null;
}

export interface ReviewArtifact {
  verdict: VerdictValue;
  review_markdown: string;
  findings: ArtifactFinding[];
  /** "model" | "findings" | "enforcement" — written by the verdict-policy pass. */
  verdict_source?: string;
  /** "complete" | "incomplete" | "none" — written by the completeness pass. */
  required_checks?: string;
  /** #954: true when the requirement-trace pass found an in-scope requirement that is unverifiable/unmet. Distinct from `required_checks` so a traceability gap is not conflated with review-execution incompleteness. */
  requirement_trace_incomplete?: boolean;
  /** #750: the model's structured dispositions, when the key was emitted. */
  required_check_dispositions?: Array<Record<string, unknown>>;
  /** #766: replaced with the settled (enforced) records by thread enforcement. */
  thread_dispositions?: Array<ArtifactThreadDisposition | Record<string, unknown>>;
  /** #774: replaced with the settled records by human-review enforcement. */
  human_review_dispositions?: Array<ArtifactHumanReviewDisposition | Record<string, unknown>>;
  /** #624: the reviewer's raw requirement_coverage claims (untrusted). */
  requirement_coverage?: unknown;
  /** #721: structured reviewer-requested smart escalation. */
  smart_review_requested?: boolean;
  smart_review_reason?: string | null;
  /** #1003: the human-review triage answer as the parser normalized it
   * (fail-closed to `unknown`), plus its bounded reason ("" when the model
   * gave none). Persisted in the artifact so the outputs, publish and step
   * summary all read the same normalized value, and so an operator can see
   * what the model actually answered. */
  review_triage_decision?: ReviewTriageDecision;
  review_triage_reason?: string;
  /** #1005: the model's selected LOGICAL routing target IDs (bounded,
   * lowercased). Persisted so the routing resolver reads the same normalized
   * value; never a concrete GitHub identity. */
  review_triage_targets?: string[];
  /** Every additional key the model produced passes through untouched. */
  [key: string]: unknown;
}

function findingToArtifact(finding: NormalizedFinding): ArtifactFinding {
  const artifact: ArtifactFinding = {
    severity: finding.severity,
    category: finding.category,
    file: finding.file,
    line: finding.line,
    message: finding.message,
  };
  if (finding.preliminaryFinding !== undefined) {
    artifact.preliminary_finding = finding.preliminaryFinding;
  }
  if (finding.endLine !== undefined) {
    artifact.end_line = finding.endLine;
  }
  if (finding.suggestion !== undefined) {
    artifact.suggestion = finding.suggestion;
  }
  if (finding.agentPrompt !== undefined) {
    artifact.agent_prompt = finding.agentPrompt;
  }
  return artifact;
}

/**
 * Build the enforcement-stage artifact from the typed parsed verdict
 * (#680 composes the #677/#750/#766/#774 parser output; it does not re-parse
 * model JSON). Tri-state disposition keys are preserved exactly: a key the
 * model emitted is carried even when it normalized to no usable array, so
 * the completeness evaluation sees present-but-malformed as
 * structured-incomplete rather than key-absence.
 */
export function reviewArtifactFromParsed(parsed: ParsedReviewVerdict): ReviewArtifact {
  const artifact: ReviewArtifact = {
    verdict: parsed.verdict,
    review_markdown: parsed.reviewMarkdown,
    findings: parsed.findings.map(findingToArtifact),
    requirement_coverage: parsed.requirementCoverage,
    smart_review_requested: parsed.smartReviewRequested,
    smart_review_reason: parsed.smartReviewReason,
    // #1003: v3-only triage keys. Written unconditionally (like the #721
    // escalation fields) so the persisted artifact always records what the
    // model answered, including the fail-closed `unknown`; whether triage ran
    // at all is the caller's `review-triage` input, not this artifact.
    review_triage_decision: parsed.reviewTriageDecision,
    review_triage_reason: parsed.reviewTriageReason,
    review_triage_targets: parsed.reviewTriageTargets,
  };
  if (parsed.requiredCheckDispositionsEmitted) {
    artifact.required_check_dispositions = parsed.requiredCheckDispositions === null
      ? []
      : parsed.requiredCheckDispositions.map((d) => ({
          check: d.check,
          status: d.status,
          rationale: d.rationale,
        }));
  }
  if (parsed.threadDispositionsEmitted) {
    artifact.thread_dispositions = parsed.threadDispositions === null
      ? []
      : parsed.threadDispositions.map((d) => ({
          thread_id: d.threadId,
          disposition: d.disposition,
          evidence: d.evidence,
        }));
  }
  if (parsed.humanReviewDispositionsEmitted) {
    artifact.human_review_dispositions = parsed.humanReviewDispositions === null
      ? []
      : parsed.humanReviewDispositions.map((d) => ({
          review_id: d.reviewId,
          disposition: d.disposition,
          evidence: d.evidence,
        }));
  }
  for (const [key, value] of Object.entries(parsed.extra)) {
    // This field is deterministic enforcement state, never model input.
    if (key !== "requirement_trace_incomplete" && !(key in artifact)) {
      artifact[key] = value;
    }
  }
  return artifact;
}

/**
 * Canonical persisted serialization: `json.dumps(..., ensure_ascii=False)`
 * plus a trailing newline, byte-identical to every v2 artifact writer.
 */
export function serializeReviewArtifact(artifact: ReviewArtifact): string {
  return `${JSON.stringify(artifact)}\n`;
}
