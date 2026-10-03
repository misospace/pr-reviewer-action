import type {
  NormalizedFinding,
  ParsedReviewVerdict,
  VerdictValue,
} from "../model/types.js";

/**
 * The persisted review artifact (`ai-output.json` in v2) — the single object
 * every downstream consumer reads: enforcement mutates it, the outputs step
 * serializes it, the publish step renders it.
 *
 * This is a persisted/parity serialization boundary, so the field names stay
 * snake_case exactly as v2 writes them (see AGENTS.md naming rules): consumers
 * like `jq -r '.verdict'`, the metadata marker builder, and the parity
 * fixtures compare these bytes. The working object is this artifact itself —
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
  /** Set only on findings re-emitted from unresolved review threads (#766):
   * the publish step skips inlining these — the thread already exists. */
  thread_id?: string;
  /** #775: original severity when the non-blocking category cap reduced it. */
  capped_from?: string;
  /** v3-only, no v2 counterpart: set by the deterministic outside-diff pass
   * when the finding's file isn't in the diff, or its line falls outside
   * every hunk's new-side range. Content-level only — never changes
   * verdict, requirement coverage, or any other policy input. */
  outside_diff?: boolean;
}

export interface ArtifactThreadDisposition {
  thread_id: string;
  disposition: "fixed" | "open" | "disputed";
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
