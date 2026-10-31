/**
 * #1073: the deterministic result contract and tolerant parser for the
 * independent post-review confidence scorer — as of #1369 an INDEPENDENT
 * MERGE-SAFETY VERIFIER: it reads the PR description and diff itself and
 * audits the completed primary review against the change, rather than
 * grading the review's evidence quality.
 *
 * The verifier is advisory telemetry only: its answer never touches the
 * verdict, the findings, the review-result state, required checks, the
 * escalation reason, native review events, or approvals, and it never writes
 * into any `reviewRecord` field the enforcement/marker pipeline reads. This
 * module owns the shape every consumer (outputs, step summary, published
 * section, marker, persisted artifact) reads, plus the tolerant parser for
 * the verifier's free-form answer.
 *
 * Parser policy: a malformed value is flagged `unknown` or fails the whole
 * answer closed — it is never silently defaulted or CLAMPED to a confident
 * `5`/`low`. A missing, non-integer, or OUT-OF-RANGE `score` fails the answer
 * to `unscored` (#1140 review: an out-of-range integer like 999 must never
 * become a qualified top score); the answer only ever becomes a number
 * through an explicit in-range integer the model produced. A `cannot_verify`
 * answer fails closed to `unscored` too (#1369): uncertainty the model
 * declared is never promoted to a confident pass.
 */

import { maskKnownSecrets } from "../context/redact.js";

export const CONFIDENCE_RISK_VALUES = ["low", "medium", "high", "critical", "unknown"] as const;
export type ConfidenceRisk = (typeof CONFIDENCE_RISK_VALUES)[number];

/** #1369: the closed vocabulary for the verifier's own concerns — what kind
 * of audit disagreement the entry records. */
export const CONFIDENCE_CONCERN_TYPES = ["missed_issue", "unsupported_finding"] as const;
export type ConfidenceConcernType = (typeof CONFIDENCE_CONCERN_TYPES)[number];
export const CONFIDENCE_CONCERN_SEVERITIES = ["blocker", "major"] as const;
export type ConfidenceConcernSeverity = (typeof CONFIDENCE_CONCERN_SEVERITIES)[number];

/** #1369: the rubric the verifier scores against, versioned so persisted
 * artifacts and the precheck fingerprint can tell prose-quality-era scores
 * apart from merge-readiness verifier results. */
export const CONFIDENCE_RUBRIC_VERSION = "merge-readiness-verifier-v1";

/**
 * #1368: the scorer's OWN compact strict-mode JSON schema, carried on the
 * wire only under the operator's structured-output assertion
 * (`ai-confidence-structured-output-support`) — never the pinned verdict
 * schema. It matches what `parseConfidenceAnswer` tolerates: every property
 * is in `required` (OpenAI strict mode requires that) with optionality
 * expressed via the null type, exactly like the verdict schema's
 * nullable-but-required fields. The wire enum for `risk` is the four
 * meaningful bands; a malformed risk still degrades to `unknown` in the
 * parser, so the schema and the parser stay compatible in both directions.
 * The schema rides BOTH wire families through `ModelRequestConfig`'s
 * `responseSchema` (see `src/model/request.ts`).
 */
export const CONFIDENCE_ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 5 },
    risk: { type: "string", enum: ["low", "medium", "high", "critical"] },
    reason: { type: "string" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          evidence: { type: ["string", "null"] },
        },
        required: ["file", "line", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["score", "risk", "reason", "concerns"],
  additionalProperties: false,
};

export type ConfidenceStatus = "disabled" | "scored" | "unscored";

/** One bounded advisory concern the verifier attached to its answer. */
export interface ConfidenceConcern {
  /** Closed-vocabulary audit kind: what the verifier is flagging. */
  type: ConfidenceConcernType;
  /** Closed-vocabulary severity (blocker/major): the advisory relevance of
   * the concern. Advisory only — it never gates anything by itself. */
  severity: ConfidenceConcernSeverity;
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
   * Cap notes are appended here when a deterministic ceiling fired, and a
   * model-authored look-alike of the note is stripped (#1166). */
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
  /** #1369: action-owned parser notes from the scored answer (e.g. a
   * `concern_dropped_*` token when a malformed concern entry was dropped, or
   * `risk_unknown_malformed`). Persisted in the artifact so a dropped
   * concern — and the ceiling implication it would have carried — stays
   * operator-visible. Empty for disabled/unscored. */
  parserNotes: string[];
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
  parserNotes: Object.freeze([]) as readonly string[] as string[],
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
    parserNotes: [],
  };
}

export function scoredConfidenceResult(input: {
  score: number;
  risk: ConfidenceRisk;
  reason: string;
  concerns: ConfidenceConcern[];
  model: string;
  caps: string[];
  parserNotes: string[];
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
    parserNotes: input.parserNotes,
  };
}

// ── Bounded answer parsing ───────────────────────────────────────────────

export const MAX_CONFIDENCE_REASON_CHARS = 600;
export const MAX_CONFIDENCE_CONCERNS = 8;
export const MAX_CONFIDENCE_CONCERN_FILE_CHARS = 300;
export const MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS = 400;

/**
 * Re-apply a documented field bound AFTER credential masking/redaction
 * (#1140 review round 9). Exact-value masking is not length-preserving:
 * `maskKnownSecrets` replaces every occurrence of a non-empty configured
 * secret — including a one-character one — with the three-character `⟦•⟧`
 * marker, so a field the parser bounded to exactly its limit can leave masking
 * OVER its limit, and the oversized value would flow into
 * `confidence-score.json` and the step outputs. (The `src/publish/` renderers
 * apply their own tighter slice on the way to the comment, so the comment was
 * never the oversized surface — the artifact and outputs were.) The generic
 * `redactText` heuristics emit the ten-character `[REDACTED]` and every rule
 * matches at least that many characters, so they can substitute but never widen
 * — the widening to pin here is the exact-value mask. Slicing after masking is
 * the safe direction: truncation can never re-expose what masking already
 * removed, even when it cuts a marker in half.
 */
export function boundConfidenceField(text: string, maxChars: number): string {
  return text.slice(0, maxChars);
}

/** The action-owned note `applyConfidenceCeilings` appends to the reason,
 * rebuilt from `caps` so a caller can recognize/reserve it without parsing
 * model-authored text. "" when no cap fired. */
export function confidenceCapNote(caps: readonly string[]): string {
  return caps.length === 0 ? "" : ` [deterministic cap: ${caps.join(", ")}]`;
}

/**
 * #1268: the model-authored share of a canonical scored reason — the reason
 * with the action-owned cap note removed, so the caller can mask the model
 * text and the note as SEPARATE values. `applyConfidenceCeilings` is the
 * only producer that appends the note, and it appends exactly
 * `confidenceCapNote(caps)`; a reason that does not end in the expected note
 * is returned untouched (the post-masking reveal strip in
 * `boundConfidenceReason` still bounds the trailing edge). The note is
 * re-appended from `caps` AFTER masking — never parsed back out of masked
 * text, which could neither preserve nor rebuild it safely: the note can
 * carry a configured credential, so an unmasked rebuild would leak it.
 */
export function confidenceReasonWithoutCapNote(reason: string, caps: readonly string[]): string {
  const note = confidenceCapNote(caps);
  if (note === "" || !reason.endsWith(note)) return reason;
  return reason.slice(0, reason.length - note.length);
}

const CONFIDENCE_CAP_NOTE_TEMPLATE = "deterministic cap:";

/**
 * #1166: the note vocabulary above is ACTION-OWNED — it is emitted only by
 * `confidenceCapNote` from the structured `caps` field, never by the model.
 * A scorer reason that already ends in a look-alike tail must not survive
 * into a published surface: after a real cap fires the appended note would
 * sit beside the forgery, and with no cap at all the forgery would stand in
 * for a ceiling that never fired while `caps` stayed `[]`. Only the TRAILING
 * tail is reserved for the note — a look-alike in mid-sentence prose is
 * model text, not an appended note, and is left alone.
 *
 * Each trailing tail matches `confidenceCapNote`'s template with any casing
 * and token list: optional whitespace, `[`, `deterministic cap:`, any
 * `]`-free content, `]`. The backward scan keeps a tail-crowded answer from
 * going quadratic — the reason arrives unbounded from a transport response,
 * where every earlier step is a single linear pass — and `]`/`[` handling
 * mirrors the template's own `[^]]`-content rule.
 */
export function stripConfidenceCapNoteTails(reason: string): string {
  let end = reason.length;
  for (;;) {
    let at = end;
    while (at > 0 && /\s/.test(reason[at - 1]!)) at -= 1;
    if (at === 0 || reason[at - 1] !== "]") break;
    at -= 1; // the trailing bracket of a candidate tail
    // Walk backward through the candidate's content for the template
    // start. Content forbids `]` exactly like the note template does; a
    // `[` may appear inside it, so the template literal decides.
    let tailStart = -1;
    let probe = at - 1;
    while (probe >= 0) {
      const char = reason.charCodeAt(probe);
      if (char === 0x5d /* ] */) break;
      if (char === 0x5b /* [ */
        && reason.slice(probe + 1, probe + 1 + CONFIDENCE_CAP_NOTE_TEMPLATE.length).toLowerCase()
          === CONFIDENCE_CAP_NOTE_TEMPLATE) {
        tailStart = probe;
        break;
      }
      probe -= 1;
    }
    if (tailStart < 0) break;
    while (tailStart > 0 && /\s/.test(reason[tailStart - 1]!)) tailStart -= 1;
    end = tailStart;
  }
  return reason.slice(0, end);
}

/**
 * #1166: strip the cap-note look-alikes a LENGTH CUT can reveal at the
 * trailing edge. The mid-answer pass above removes look-alike tails from the
 * model's raw answer, but a bound — the parser's own
 * `MAX_CONFIDENCE_REASON_CHARS` or `boundConfidenceReason`'s masked re-bind —
 * can pull an INTERIOR look-alike onto the trailing edge, either complete or
 * truncated into an unterminated fragment that still reads as the note
 * (`… [deterministic cap: yyy`). Post-bound text is inside the documented
 * bound, so a plain regex pass stays linear; the loop re-runs the complete
 * strip because removing one fragment can reveal another.
 */
const CONFIDENCE_TRUNCATED_CAP_NOTE_RE = new RegExp(`\\[${CONFIDENCE_CAP_NOTE_TEMPLATE}[^\\]]*$`, "i");

export function stripRevealedCapNoteTails(reason: string): string {
  let text = stripConfidenceCapNoteTails(reason);
  for (;;) {
    const match = CONFIDENCE_TRUNCATED_CAP_NOTE_RE.exec(text);
    if (match === null) return text.trimEnd();
    text = stripConfidenceCapNoteTails(text.slice(0, match.index));
  }
}

/**
 * Re-bind the MASKED model share of the reason to `MAX_CONFIDENCE_REASON_CHARS`
 * while keeping the deterministic cap note (#1140 review round 9; #1268).
 *
 * #1268: `maskedReason` is the note-FREE model share — the caller splits the
 * action-owned note off BEFORE masking (`confidenceReasonWithoutCapNote`) and
 * passes the note separately. Masking a combined text lets `redactText`
 * COMPLETE a look-alike the model only half-wrote: the credential-value rule
 * consumes the model's closing bracket and the `[REDACTED]` marker supplies
 * a new one, so a reason whose `caps` stayed `[]` could be published ending
 * in a note-shaped span no ceiling produced (`x [deterministic cap: password:
 * a]bcdefgh` → `x [deterministic cap: [REDACTED]`). So the masked model share
 * is reveal-stripped here as well, and the note — the only note-shaped span
 * this function can emit — is re-appended from `caps`, never parsed back out
 * of masked text (the note can carry a configured credential, so an unmasked
 * rebuild would leak it).
 *
 * `capNote` MUST be the note already run through the caller's masking (build
 * it as `mask(confidenceCapNote(caps))`): masking has to stay TERMINAL on
 * this surface, and a configured credential is allowed to be any length —
 * including one character occurring inside the note template
 * (`blocker_cap_2`) — so an unmasked rebuilt note would put the run's own
 * credential back on the surface that was just masked. Over-redacting the
 * note is the accepted cost, and the exact caps are still recorded verbatim
 * in the result's structured `caps` field. The room below is reserved from
 * the note's MASKED length. #1166: a cut inside the model share is itself
 * reveal-stripped before the note lands.
 */
export function boundConfidenceReason(maskedReason: string, capNote: string): string {
  const model = stripRevealedCapNoteTails(maskedReason);
  if (capNote === "") {
    if (model.length <= MAX_CONFIDENCE_REASON_CHARS) return model;
    return stripRevealedCapNoteTails(model.slice(0, MAX_CONFIDENCE_REASON_CHARS));
  }
  const room = Math.max(0, MAX_CONFIDENCE_REASON_CHARS - capNote.length);
  if (model.length <= room) return `${model}${capNote}`;
  const head = stripRevealedCapNoteTails(model.slice(0, room)).trimEnd();
  return `${head}${capNote}`.slice(0, MAX_CONFIDENCE_REASON_CHARS);
}

/**
 * #1268 review hardening: the caller masks the model share and the note as
 * SEPARATE values, so a configured secret whose literal spans the
 * model/note boundary is found in neither half and the re-append would
 * reconstruct it verbatim — a tear in the "masking is terminal" invariant
 * the split exists to serve. One exact-value `maskKnownSecrets` pass over
 * the COMPOSED reason closes it. `maskKnownSecrets` only, never
 * `redactText`: the `⟦•⟧` marker carries no brackets or template text, so
 * this pass can never complete a cap-note look-alike the way `redactText`'s
 * `[REDACTED]` can, and the #1268 guarantee — the only note-shaped span in
 * the composed reason is the action-owned one — survives it (the pass can
 * over-redact the note itself, the cost #1140 round 9 already accepted).
 * The substitution can grow the composed reason past the bound only when
 * the operator's own credential is shorter than the marker; the left cut
 * keeps the trailing edge — the note — intact, and cutting after masking
 * can never re-expose what masking already removed.
 */
export function maskComposedConfidenceReason(composed: string, secrets: readonly (string | null | undefined)[]): string {
  const masked = maskKnownSecrets(composed, secrets);
  return masked.length <= MAX_CONFIDENCE_REASON_CHARS
    ? masked
    : masked.slice(masked.length - MAX_CONFIDENCE_REASON_CHARS);
}

/** A successfully parsed, pre-ceiling verifier answer. */
export interface ParsedConfidenceAnswer {
  score: number;
  risk: ConfidenceRisk;
  reason: string;
  concerns: ConfidenceConcern[];
  /** Parser notes — action-owned tokens: malformed-risk
   * `risk_unknown_malformed` and #1369's `concern_dropped_*` drop notes. */
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

/** #1369: the outcome of one concern-entry parse — either a fully validated
 * concern, or the action-owned note explaining why the entry was dropped. */
interface ParsedConcern {
  concern: ConfidenceConcern | null;
  note: string;
}

function parseConcern(entry: unknown): ParsedConcern {
  if (!isRecord(entry)) return { concern: null, note: "concern_dropped_not_an_object" };
  const typeValue = entry.type;
  const type = typeof typeValue === "string"
    && (CONFIDENCE_CONCERN_TYPES as readonly string[]).includes(typeValue)
    ? typeValue as ConfidenceConcernType
    : null;
  if (type === null) return { concern: null, note: "concern_dropped_invalid_type" };
  const severityValue = entry.severity;
  const severity = typeof severityValue === "string"
    && (CONFIDENCE_CONCERN_SEVERITIES as readonly string[]).includes(severityValue)
    ? severityValue as ConfidenceConcernSeverity
    : null;
  if (severity === null) return { concern: null, note: "concern_dropped_invalid_severity" };
  const file = typeof entry.file === "string" ? entry.file.trim().slice(0, MAX_CONFIDENCE_CONCERN_FILE_CHARS) : "";
  const evidence = typeof entry.evidence === "string"
    ? entry.evidence.replace(/\s+/g, " ").trim().slice(0, MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS)
    : "";
  // A concern without both a location and grounded evidence is not auditable
  // advisory telemetry — it is dropped, with a note, never guessed.
  if (file === "" || evidence === "") return { concern: null, note: "concern_dropped_missing_field" };
  const lineValue = entry.line;
  const line = typeof lineValue === "number" && Number.isInteger(lineValue) && lineValue >= 0
    ? lineValue
    : null;
  return { concern: { type, severity, file, line, evidence }, note: "" };
}

/**
 * Tolerant bounded parse of the verifier's answer across OpenAI/Anthropic/
 * self-hosted response shapes. `score` must be an IN-RANGE (0..5) integer:
 * non-integers AND out-of-range integers are both rejected as
 * `malformed_score` — clamping `999` to a published `5` would let a
 * malformed answer qualify as a top-confidence pass (#1140 review). `risk`
 * is validated against the enum with anything malformed flagged `unknown`
 * (the answer stays scored — the integer is the primary signal); `reason`
 * and every concern field are bounded.
 *
 * #1369: a `cannot_verify` answer (`cannot_verify: true`, or the legacy-ish
 * `status: "cannot_verify"` shape) fails the whole answer closed to
 * `unscored(cannot_verify)` BEFORE the score is read or validated — declared
 * uncertainty must never be promoted to a scored result, and a hostile or
 * confused answer pairing `cannot_verify` with a confident `5` must never
 * publish the 5. Concern entries missing a valid `type`/`severity` or an
 * empty `file`/`evidence` are DROPPED with an action-owned parser note
 * (`concern_dropped_*`) in `notes`; kept concerns always carry the closed
 * vocabulary.
 */
export function parseConfidenceAnswer(raw: string): ConfidenceParseOutcome {
  const parsed = extractConfidenceJson(raw);
  if (parsed === null) return { ok: false, cause: "malformed_answer" };
  if (parsed.cannot_verify === true || parsed.status === "cannot_verify") {
    // The verifier said it could not verify: fail closed to unscored without
    // reading or validating the score at all.
    return { ok: false, cause: "cannot_verify" };
  }
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
  // #1166: pre-bound, the model's trailing look-alike tails are stripped so
  // a bound cannot slide one into the published head; post-bound, the reveals
  // the cut itself drags onto the trailing edge are stripped too.
  const reasonRaw = typeof parsed.reason === "string"
    ? parsed.reason.replace(/\s+/g, " ").trim()
    : "";
  const reasonHead = boundConfidenceField(
    stripConfidenceCapNoteTails(reasonRaw),
    MAX_CONFIDENCE_REASON_CHARS,
  );
  const reason = stripRevealedCapNoteTails(reasonHead);
  const concerns: ConfidenceConcern[] = [];
  if (Array.isArray(parsed.concerns)) {
    for (const entry of parsed.concerns.slice(0, MAX_CONFIDENCE_CONCERNS)) {
      const { concern, note } = parseConcern(entry);
      if (concern !== null) concerns.push(concern);
      else if (note !== "") notes.push(note);
    }
  }
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
 * Deterministic score ceilings, applied AFTER parsing — the verifier's own
 * opinion can never outrank what the review actually found, nor its own
 * audit disagreement:
 * - any blocker finding → score capped at 2;
 * - any major finding → score capped at 3 (blocker wins when both fire);
 * - incomplete/partial review coverage → capped at 3: insufficient proof
 *   context must never produce an eligible confident pass;
 * - #1369: any structured concern the verifier itself raised → capped at 4:
 *   an independent concern can never score 5, deterministically, not just by
 *   prompt instruction.
 * Each fired cap is recorded in `caps` and noted in the reason. The
 * concern cap applies AFTER the finding/coverage caps; the lower cap wins.
 */
export function applyConfidenceCeilings(
  answer: ParsedConfidenceAnswer,
  input: ConfidenceCeilingInput,
): { score: number; risk: ConfidenceRisk; reason: string; caps: string[] } {
  // #1166: the reason is cleaned of a model-authored note look-alike in
  // BOTH branches — with caps the real note is appended beside clean model
  // text, and with no caps a forged note never stands in for a ceiling that
  // did not fire.
  const cleanReason = stripConfidenceCapNoteTails(answer.reason);
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
  // #1369: the verifier's own structured concern caps the score at 4 —
  // "an independent concern can never score 5" is deterministic here, not a
  // prompt hope. Kept concerns always carry a validated closed-vocabulary
  // severity, so any kept concern qualifies. Applied last: the
  // blocker/major/coverage caps above still win when they land lower.
  if (answer.concerns.some((concern) => concern.severity === "blocker" || concern.severity === "major") && score > 4) {
    score = 4;
    caps.push("verifier_concern_cap_4");
  }
  if (caps.length === 0) {
    return { score, risk: answer.risk, reason: cleanReason, caps };
  }
  // The cap note is appended to the model's own reason, so the model's share
  // shrinks to whatever the note leaves — the RESULT stays within the same
  // documented bound either way (slicing to MAX + note.length instead would
  // publish a reason longer than MAX_CONFIDENCE_REASON_CHARS). #1166: the
  // room cut itself can reveal a look-alike at the trailing edge, so the cut
  // head is reveal-stripped before the real note is appended.
  const note = confidenceCapNote(caps);
  const room = Math.max(0, MAX_CONFIDENCE_REASON_CHARS - note.length);
  const head = cleanReason.length > room
    ? stripRevealedCapNoteTails(cleanReason.slice(0, room)).trimEnd()
    : cleanReason;
  const reason = `${head}${note}`.slice(0, MAX_CONFIDENCE_REASON_CHARS);
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
