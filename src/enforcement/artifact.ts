import type {
  NormalizedFinding,
  ParsedReviewVerdict,
  ReviewTriageDecision,
  VerdictValue,
} from "../model/types.js";
import { aspectStatusLookup, rollupDependencyCoverage } from "../model/dependency-coverage.js";

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
  /** #1016, extended #1238, extended #1240: set by the deterministic
   * blocker-verification boundary when a model-authored source-backed claim
   * (committed-source literal, requirement claim, action-input declaration,
   * or gate-absence) was not substantiated by its witness — exact-head
   * source for the first two, the executing action's embedded contract and
   * the reviewed repository's own workflow input names for input
   * declarations, and the executing action's own implementation tree for
   * gate-absence claims.
   * The workflow witness is PER FILE and anchored to the finding's OWN
   * cited file: it reports only what that file's DIRECT action step
   * passes, it corroborates (grounds) a workflow-scoped claim about the
   * mapping, and it never establishes an absence — so it never refutes.
   * The action-side witnesses speak for the EXECUTING revision's release
   * line only: a claim that names a different line or another patch is
   * unverified — never refuted, never grounded.
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
  /** #1337: the model's structured dependency-upgrade coverage accounting
   * answer (fail-closed normalized), when the key was emitted. Purely
   * informational: the deterministic rollup never gates the verdict and
   * never fabricates a finding from an evidence gap. */
  dependency_coverage?: Array<Record<string, unknown>>;
  /** #1337: deterministic rollup (`complete` | `partial` | `unavailable`)
   * over the closed aspect set; written whenever the answer was emitted. */
  dependency_coverage_status?: string;
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
  // #1337: publish the accounting only for a REAL array answer. The strict
  // wire schema always carries the key (null permitted), so key-presence
  // alone would make every json_schema run report an empty accounting —
  // a null/malformed answer is "not reported", never an empty rollup.
  if (parsed.dependencyCoverageEmitted && parsed.dependencyCoverage !== null) {
    artifact.dependency_coverage = parsed.dependencyCoverage.map((entry) => ({
      aspect: entry.aspect,
      status: entry.status,
      note: entry.note,
    }));
    // The rollup is deterministic over the normalized answer (the model's
    // prose never contributes), so it can be written here once.
    artifact.dependency_coverage_status = rollupDependencyCoverage(
      aspectStatusLookup(parsed.dependencyCoverage),
    );
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

/**
 * #1248: the four action-authored relaxation disclosures, as exact full-text
 * constants shared with the writers in `verdict-policy.ts` (single source of
 * truth: a note edited there can never silently stop matching here).
 */
export const GATED_FINDINGS_RELAXATION_NOTE =
  "_Verdict relaxed from structured findings (verdict_policy=findings_severity_gated): "
  + "every blocking finding was in a category this repository marks non-blocking "
  + "(non_blocking_finding_categories); they remain listed above._";

export const VERIFICATION_ONLY_RELAXATION_NOTE =
  "_Verdict relaxed from structured findings (#977): every open finding is a "
  + "verification request the review tools cannot check, so the author has nothing to "
  + "change. The findings remain listed above._";

export const CI_ONLY_RELAXATION_NOTE =
  "_Verdict relaxed from CI-only findings (#976): check conclusions are shown for "
  + "context and gate the merge independently; they are not review blockers._";

export const REFUTED_GROUNDING_RELAXATION_NOTE =
  "_Verdict relaxed from structured findings (#1016): every open finding was either a "
  + "verification request or a source claim the deterministic blocker-verification "
  + "boundary positively refuted against exact-head source; the findings remain listed "
  + "above and deterministic gates are unaffected._";

const RELAXATION_NOTES: readonly string[] = [
  GATED_FINDINGS_RELAXATION_NOTE,
  VERIFICATION_ONLY_RELAXATION_NOTE,
  CI_ONLY_RELAXATION_NOTE,
  REFUTED_GROUNDING_RELAXATION_NOTE,
];

function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #1248: matches a relaxation note only as its complete action-authored line
 * (full exact text, anchored start-to-end of line — the same exact-full-text
 * posture as the enforcement-banner matcher in `enforce.ts`). Matching the
 * opener prefix alone would rewrite model prose that merely begins a line
 * with "_Verdict relaxed from … findings"; model prose can still only be
 * rewritten by reproducing one of the notes byte-identically as its own
 * whole line, which is indistinguishable from the action's own note.
 */
const RELAXATION_NOTE_RE = new RegExp(
  `^(?:${RELAXATION_NOTES.map(escapeRegExpLiteral).join("|")})$`,
  "gm",
);

const RELAXATION_NOTE_OPENER = "_Verdict relaxed";

/**
 * #1248: retire stale relaxation claims in the published body. A
 * findings-policy relaxation appends "_Verdict relaxed from … findings …_"
 * while the verdict is approve; when a deterministic layer later flips the
 * verdict back to request_changes (relax-then-force), that note would keep
 * asserting a relaxation that no longer holds. Marking it superseded keeps
 * the body honest without deleting the original disclosure. The rewritten
 * text can never re-match (idempotent).
 */
export function markRelaxationNotesSuperseded(artifact: ReviewArtifact): void {
  artifact.review_markdown = (artifact.review_markdown || "")
    .replace(
      RELAXATION_NOTE_RE,
      (note) => `_Verdict relaxation superseded by enforcement: originally `
        + `relaxed${note.slice(RELAXATION_NOTE_OPENER.length)}`,
    );
}
