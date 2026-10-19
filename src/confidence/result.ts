/**
 * #1073: the deterministic result contract and tolerant parser for the
 * independent post-review confidence scorer.
 *
 * The scorer is advisory telemetry only: its answer never touches the
 * verdict, the findings, the review-result state, required checks, the
 * escalation reason, native review events, or approvals, and it never writes
 * into any `reviewRecord` field the enforcement/marker pipeline reads. This
 * module owns the shape every consumer (outputs, step summary, published
 * section, marker, persisted artifact) reads, plus the tolerant parser for
 * the scorer's free-form answer.
 *
 * Parser policy: a malformed value is flagged `unknown` or fails the whole
 * answer closed — it is never silently defaulted or CLAMPED to a confident
 * `5`/`low`. A missing, non-integer, or OUT-OF-RANGE `score` fails the answer
 * to `unscored` (#1140 review: an out-of-range integer like 999 must never
 * become a qualified top score); the answer only ever becomes a number
 * through an explicit in-range integer the model produced.
 */

export const CONFIDENCE_RISK_VALUES = ["low", "medium", "high", "critical", "unknown"] as const;
export type ConfidenceRisk = (typeof CONFIDENCE_RISK_VALUES)[number];

export type ConfidenceStatus = "disabled" | "scored" | "unscored";

/** One bounded advisory concern the scorer attached to its answer. */
export interface ConfidenceConcern {
  file: string;
  line: number | null;
  evidence: string;
}

/** The single shape every consumer reads; `status` discriminates. */
export interface ConfidenceResult {
  status: ConfidenceStatus;
  /** Integer 0..5, ONLY when `status === "scored"`; null otherwise (never a
   * spurious 0). */
  score: number | null;
  /** The risk band; "" when disabled (the scorer never ran). */
  risk: ConfidenceRisk | "";
  /** Bounded scorer explanation; "" when disabled or unscored (the cause
   * lives in the persisted artifact and the log, never in a public output).
   * Cap notes are appended here when a deterministic ceiling fired. */
  reason: string;
  /** Bounded advisory concerns; empty unless scored. */
  concerns: ConfidenceConcern[];
  /** The model identity that produced the score; set whenever the scorer's
   * transport call was ATTEMPTED (including a failed/malformed one), ""
   * before any call or when disabled. */
  model: string;
  /** Redacted machine-token cause ("missing_credential", "timeout", …);
   * "" when scored or disabled. Never contains provider text or secrets. */
  cause: string;
  /** Deterministic ceilings that fired, action-owned tokens, e.g.
   * "blocker_cap_2". Empty for disabled/unscored. */
  caps: string[];
}

export const CONFIDENCE_DISABLED: ConfidenceResult = Object.freeze({
  status: "disabled",
  score: null,
  risk: "",
  reason: "",
  concerns: Object.freeze([]) as readonly ConfidenceConcern[] as ConfidenceConcern[],
  model: "",
  cause: "",
  caps: Object.freeze([]) as readonly string[] as string[],
}) as ConfidenceResult;

export function unscoredConfidenceResult(cause: string, model = ""): ConfidenceResult {
  return {
    status: "unscored",
    score: null,
    risk: "unknown",
    reason: "",
    concerns: [],
    model,
    cause,
    caps: [],
  };
}

export function scoredConfidenceResult(input: {
  score: number;
  risk: ConfidenceRisk;
  reason: string;
  concerns: ConfidenceConcern[];
  model: string;
  caps: string[];
}): ConfidenceResult {
  return {
    status: "scored",
    score: input.score,
    risk: input.risk,
    reason: input.reason,
    concerns: input.concerns,
    model: input.model,
    cause: "",
    caps: input.caps,
  };
}

// ── Bounded answer parsing ───────────────────────────────────────────────

export const MAX_CONFIDENCE_REASON_CHARS = 600;
export const MAX_CONFIDENCE_CONCERNS = 8;
export const MAX_CONFIDENCE_CONCERN_FILE_CHARS = 300;
export const MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS = 400;

/** A successfully parsed, pre-ceiling scorer answer. */
export interface ParsedConfidenceAnswer {
  score: number;
  risk: ConfidenceRisk;
  reason: string;
  concerns: ConfidenceConcern[];
  /** Parser notes (unknown risk) — action-owned tokens. */
  notes: string[];
}

export type ConfidenceParseOutcome =
  | { ok: true; answer: ParsedConfidenceAnswer }
  | { ok: false; cause: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull a JSON object out of the scorer's answer: bare JSON preferred, then a
 * ```json/``` fence, then the first `{`..last `}` span of surrounding prose
 * (self-hosted models like to narrate). No verdict-schema parsing, no
 * retries. */
export function extractConfidenceJson(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? "");
  if (text.trim() === "") return null;
  const candidates: string[] = [];
  const direct = text.trim();
  candidates.push(direct);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) candidates.push(fenced[1]!.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // try the next candidate shape
    }
  }
  return null;
}

function parseConcern(entry: unknown): ConfidenceConcern | null {
  if (!isRecord(entry)) return null;
  const file = typeof entry.file === "string" ? entry.file.trim().slice(0, MAX_CONFIDENCE_CONCERN_FILE_CHARS) : "";
  const evidence = typeof entry.evidence === "string"
    ? entry.evidence.replace(/\s+/g, " ").trim().slice(0, MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS)
    : "";
  const lineValue = entry.line;
  const line = typeof lineValue === "number" && Number.isInteger(lineValue) && lineValue >= 0
    ? lineValue
    : null;
  if (file === "" && evidence === "") return null;
  return { file, line, evidence };
}

/**
 * Tolerant bounded parse of the scorer's answer across OpenAI/Anthropic/
 * self-hosted response shapes. `score` must be an IN-RANGE (0..5) integer:
 * non-integers AND out-of-range integers are both rejected as
 * `malformed_score` — clamping `999` to a published `5` would let a
 * malformed answer qualify as a top-confidence pass (#1140 review). `risk`
 * is validated against the enum with anything malformed flagged `unknown`
 * (the answer stays scored — the integer is the primary signal); `reason`
 * and every concern field are bounded.
 */
export function parseConfidenceAnswer(raw: string): ConfidenceParseOutcome {
  const parsed = extractConfidenceJson(raw);
  if (parsed === null) return { ok: false, cause: "malformed_answer" };
  const notes: string[] = [];
  const scoreValue = parsed.score;
  if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue) || !Number.isInteger(scoreValue)
    || scoreValue < 0 || scoreValue > 5) {
    // A float, a string, a missing score, or an out-of-range integer is
    // never defaulted or clamped — not to 5, not to 0. The whole answer
    // fails closed to unscored, so a malformed answer can never qualify as
    // a top-confidence pass.
    return { ok: false, cause: "malformed_score" };
  }
  const score = scoreValue;
  const riskValue = parsed.risk;
  const risk: ConfidenceRisk = typeof riskValue === "string"
    && (CONFIDENCE_RISK_VALUES as readonly string[]).includes(riskValue)
    ? riskValue as ConfidenceRisk
    : "unknown";
  if (risk === "unknown" && riskValue !== "unknown") notes.push("risk_unknown_malformed");
  const reason = typeof parsed.reason === "string"
    ? parsed.reason.replace(/\s+/g, " ").trim().slice(0, MAX_CONFIDENCE_REASON_CHARS)
    : "";
  const concerns = Array.isArray(parsed.concerns)
    ? parsed.concerns.slice(0, MAX_CONFIDENCE_CONCERNS)
      .map(parseConcern)
      .filter((concern): concern is ConfidenceConcern => concern !== null)
    : [];
  return { ok: true, answer: { score, risk, reason, concerns, notes } };
}

// ── Deterministic ceilings ───────────────────────────────────────────────

export interface ConfidenceCeilingInput {
  /** The FINAL normalized still-open findings the review published. */
  findings: unknown;
  /** The review's own coverage record (the `reviewCoverage` fields verbatim:
   * partial_coverage / incomplete_reason drive the incomplete-coverage cap). */
  coverage?: Record<string, unknown> | null;
}

/**
 * Deterministic score ceilings, applied AFTER parsing — the scorer's own
 * opinion can never outrank what the review actually found:
 * - any blocker finding → score capped at 2;
 * - any major finding → score capped at 3 (blocker wins when both fire);
 * - incomplete/partial review coverage → capped at 3: insufficient proof
 *   context must never produce an eligible confident pass.
 * Each fired cap is recorded in `caps` and noted in the reason.
 */
export function applyConfidenceCeilings(
  answer: ParsedConfidenceAnswer,
  input: ConfidenceCeilingInput,
): { score: number; risk: ConfidenceRisk; reason: string; caps: string[] } {
  let score = answer.score;
  const caps: string[] = [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const severityOf = (finding: unknown): string =>
    isRecord(finding) && typeof finding.severity === "string" ? finding.severity.toLowerCase() : "";
  const hasBlocker = findings.some((finding) => severityOf(finding) === "blocker");
  const hasMajor = findings.some((finding) => severityOf(finding) === "major");
  if (hasBlocker && score > 2) {
    score = 2;
    caps.push("blocker_cap_2");
  }
  if (hasMajor && score > 3) {
    score = 3;
    caps.push("major_cap_3");
  }
  const coverage = input.coverage ?? null;
  const coverageIncomplete = coverage !== null
    && ((coverage.partial_coverage !== null && coverage.partial_coverage !== undefined)
      || (typeof coverage.incomplete_reason === "string" && coverage.incomplete_reason !== ""
        && coverage.incomplete_reason !== "none"));
  if (coverageIncomplete && score > 3) {
    score = 3;
    caps.push("incomplete_coverage_cap_3");
  }
  if (caps.length === 0) {
    return { score, risk: answer.risk, reason: answer.reason, caps };
  }
  const note = ` [deterministic cap: ${caps.join(", ")}]`;
  const reason = `${answer.reason}${note}`.slice(0, MAX_CONFIDENCE_REASON_CHARS + note.length);
  return { score, risk: answer.risk, reason, caps };
}

// ── Public output mapping ────────────────────────────────────────────────

/** The five `confidence-*` step-output fields as strings. Disabled and
 * unscored runs stay "" everywhere (never a spurious `0`); only a scored
 * answer carries the integer. */
export function confidenceOutputFields(result: ConfidenceResult): {
  status: string;
  score: string;
  risk: string;
  reason: string;
  model: string;
} {
  if (result.status === "disabled") {
    return { status: "", score: "", risk: "", reason: "", model: "" };
  }
  if (result.status === "unscored") {
    return { status: "unscored", score: "", risk: "unknown", reason: "", model: result.model };
  }
  return {
    status: "scored",
    score: String(result.score),
    risk: result.risk,
    reason: result.reason,
    model: result.model,
  };
}
