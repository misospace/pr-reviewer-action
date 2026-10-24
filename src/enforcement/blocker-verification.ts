import { authorizesLiteralClaim, verifySourceSpan } from "../context/evidence-provenance.js";
import type { EvidenceProvenance } from "../context/evidence-provenance.js";
import type { ArtifactFinding } from "./artifact.js";
import { ACTION_GATES, UNCOVERED_GATE_SUBJECTS } from "./action-gates.js";
import type { ActionGate } from "./action-gates.js";
import type { ActionSourceReadResult, ActionSourceReader } from "./action-source.js";

export type GroundingStatus = "grounded" | "refuted" | "unverified" | "unsupported";
export type GroundingKind = "committed_literal" | "requirement_claim" | "input_declaration" | "gate_absence";

export const SANITIZER_MARKERS: readonly string[] = ["⟦redacted:credential⟧", "⟦•⟧", "[REDACTED]"];
export const REQUIREMENT_NOT_ENFORCED_RE = /^\s*requirement\s+not\s+enforced\b/i;
export const MAX_VERIFICATION_READS = 20;
/**
 * #1238: upper bound on the action-source reads one boundary pass may
 * spend on the executing action's own implementation (the gate-absence
 * witness). Separate from MAX_VERIFICATION_READS, which budgets reads of
 * the REVIEWED repository's source.
 */
export const MAX_ACTION_SOURCE_READS = 4;
/**
 * #1016 (review pass): a `requirement_claim` is grounded only when the cited
 * span is present within ±EVIDENCE_LINE_WINDOW lines of the cited line. A
 * span found only elsewhere in the file is unknown evidence, not
 * confirmation.
 */
export const EVIDENCE_LINE_WINDOW = 2;

export interface SourceReadOk { status: "ok"; text: string; provenance: EvidenceProvenance; }
export interface SourceReadUnavailable { status: "unavailable"; reason: string; }
export type SourceReadResult = SourceReadOk | SourceReadUnavailable;
export type SourceReader = (file: string) => Promise<SourceReadResult>;

export interface BlockerVerificationOptions {
  readSource: SourceReader;
  expectedRevision: string | null;
  declaredActionInputs?: ReadonlySet<string> | null | undefined;
  /**
   * #1238: witness for gate-absence claims — a reader over the EXECUTING
   * action's own source tree. Absent (or null) means no witness is
   * available, which is the pre-#1238 behavior: the claim stays
   * unverified.
   */
  readActionSource?: ActionSourceReader | null | undefined;
}

export interface FindingGrounding {
  index: number;
  status: GroundingStatus;
  kind: GroundingKind | null;
  reason: string;
}

export interface BlockerVerificationResult {
  findings: FindingGrounding[];
  demoted: number;
}

export function safeFile(file: unknown): file is string {
  return typeof file === "string"
    && file.length > 0
    && !file.startsWith("/")
    // A leading `-` is never a valid repo-relative path a reviewer should
    // verify and keeps a git argv option shape out of the reader entirely.
    && !file.startsWith("-")
    && !file.split(/[\\/]/).includes("..")
    && !file.includes("\0");
}

/**
 * Mention/expectation cues: sentence-level wording that marks a marker as
 * *expected output* of a sanitizer (or an absent mechanism / comparison)
 * rather than as bytes the reviewer claims the committed source contains.
 */
const COMMITTED_MARKER_CUE_RE = /\bshould\b|\bmust be\b|\bexpected\b|instead of|\breplac\w*\b|\bnever\b|\bwithout\b|\bmissing\b|\bfails? to\b/i;

/**
 * Existence-assertion cues: sentence-level wording that positively locates
 * the cited token in the committed source (committed/contained/hardcoded
 * as written). Without one, a quoted marker is ambiguous — e.g. "the
 * masking helper returns `[REDACTED]` but is not wired into this writer"
 * describes the token as another function's return value, not as committed
 * bytes — and ambiguity falls through to untouched (the fail-safe
 * direction: an over-narrow boundary leaves a real finding blocking, it
 * never refutes one it does not understand).
 */
const COMMITTED_MARKER_ASSERTION_RE = /\bcontain\w*\b|\bcommit\w*\b|\bhardcod\w*\b|\bliteral\w*\b|\bas written\b|\binside\b|\bpresent\b|\bequals\b|\bis set to\b/i;

/**
 * Upper bound on the message text the quoted-citation scan inspects. The
 * scan is superlinear on pathological all-backtick input, and an oversized
 * message is by definition not a pinpoint citation: it falls through as
 * ambiguous (untouched), which also caps the boundary's worst-case work.
 */
export const MAX_CLAIM_SCAN_LENGTH = 16_384;

const SENTENCE_DELIMITERS = new Set([".", "!", "?", ";", "\n"]);

/**
 * #1242: characters that can be part of a path-like citation token written
 * in bare prose — a repo path (`src/precheck/decide.ts`), an owner/repo@ref
 * reference, a dotted version. The `.` inside such a token is path
 * structure, not sentence punctuation.
 */
const PATH_LIKE_TOKEN_CHAR_RE = /[A-Za-z0-9._~+@/-]/;

/**
 * #1242: true when the `.` at `index` sits strictly INSIDE a token that
 * contains a path separator. A terminal dot (the one ending a sentence after
 * a cited path) and a leading dot are still boundaries, and a dotted token
 * without a separator ("e.g.", a bare ratio, `decide.ts` alone) still
 * splits — the widening stays confined to unmistakable path citations.
 */
function isPathInternalDot(text: string, index: number): boolean {
  if (text[index] !== ".") return false;
  let start = index;
  while (start > 0 && PATH_LIKE_TOKEN_CHAR_RE.test(text[start - 1] ?? "")) start -= 1;
  let end = index + 1;
  while (end < text.length && PATH_LIKE_TOKEN_CHAR_RE.test(text[end] ?? "")) end += 1;
  if (start === index || end === index + 1) return false;
  return text.slice(start, end).includes("/");
}

/**
 * #1242: the claim-unit boundary for the two #1238 scanners (input
 * declaration and gate absence). A claim unit is wider than a sentence: a
 * `;`-joined clause chain is ONE assertion, and a `.` inside a path-like
 * citation token is path structure, not a split — the incident shapes
 * "The action never filters by label; its metadata declares no label
 * input." and "The action never skips drafts (see src/precheck/decide.ts),
 * metadata declares no label input." must reach the cue families whole.
 * The decision safety does NOT widen with the unit: cue direction stays
 * clause-scoped inside it (`clauseWindow`, `gateClauseRanges`), so a
 * semicolon-joined neighbor clause can never attribute a cue to a token or
 * gate its own clause does not carry.
 *
 * The committed-literal scanner (#1016 `sentenceContaining`) deliberately
 * KEEPS the tight sentence split: its assertion/expectation cues are judged
 * over the whole sentence, not per clause, so widening the unit there would
 * let an expectation cue from a semicolon-joined neighbor clause ("...never
 * wired up") bleed into the marker's own existence assertion and flip its
 * classification. The #1238 scanners can widen safely only because their
 * cue attribution is clause-anchored within the unit.
 */
function isClaimUnitBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char === undefined || !SENTENCE_DELIMITERS.has(char)) return false;
  if (char === ";") return false;
  if (char === ".") return !isPathInternalDot(text, index);
  return true;
}

/**
 * Character ranges `[start, end)` of quoted spans in `message`: the interior
 * of single-backtick spans (`...`) and triple-backtick fences
 * (```...```), i.e. text a reviewer explicitly cites rather than prose.
 */
function quotedSpans(message: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of message.matchAll(/```(?:[^\n]*\n)?[\s\S]*?```/g)) {
    const chunk = match[0] ?? "";
    const index = match.index ?? 0;
    const contentStart = chunk.includes("\n") ? chunk.indexOf("\n") + 1 : 3;
    const contentEnd = chunk.length - 3;
    if (contentStart < contentEnd) spans.push({ start: index + contentStart, end: index + contentEnd });
  }
  for (const match of message.matchAll(/`([^`]+)`/g)) {
    const index = match.index ?? 0;
    spans.push({ start: index + 1, end: index + 1 + (match[1] ?? "").length });
  }
  return spans;
}

/**
 * The sentence containing a character range: the maximal substring around
 * it delimited by `.`, `!`, `?`, `;`, or a newline.
 */
function sentenceContaining(message: string, from: number, to: number): string {
  let start = from;
  while (start > 0 && !SENTENCE_DELIMITERS.has(message[start - 1] ?? "")) start -= 1;
  let end = to;
  while (end < message.length && !SENTENCE_DELIMITERS.has(message[end] ?? "")) end += 1;
  return message.slice(start, end);
}

/**
 * True when `message` asserts that committed source contains a sanitizer
 * marker: at least one marker occurrence must sit inside a quoted span, and
 * the sentence carrying that cited occurrence must assert existence
 * (COMMITTED_MARKER_ASSERTION_RE) while carrying no mention/expectation cue.
 * Anything else — including oversized messages and phrasings the scan does
 * not recognize — is ambiguous and returns false (untouched).
 */
function assertsCommittedMarker(message: string): boolean {
  if (message.length > MAX_CLAIM_SCAN_LENGTH) return false;
  const spans = quotedSpans(message);
  if (spans.length === 0) return false;
  for (const marker of SANITIZER_MARKERS) {
    let from = 0;
    for (;;) {
      const index = message.indexOf(marker, from);
      if (index === -1) break;
      const end = index + marker.length;
      for (const span of spans) {
        if (span.start <= index && end <= span.end) {
          const sentence = sentenceContaining(message, index, end);
          if (!COMMITTED_MARKER_CUE_RE.test(sentence) && COMMITTED_MARKER_ASSERTION_RE.test(sentence)) {
            return true;
          }
        }
      }
      from = index + 1;
    }
  }
  return false;
}

/**
 * Classify a finding message into the claim kinds the boundary can verify.
 *
 * Invariant (#1016 review pass): `committed_literal` fires only on markers
 * *cited as committed content* — a marker inside a quoted span
 * (single backticks or a triple-backtick fence) whose carrying sentence
 * positively asserts existence in the source and carries no
 * mention/expectation cue. Prose mentions of expected output, absent
 * masking, comparisons, and any ambiguous phrasing (including oversized
 * messages) never classify as committed source claims; they fall through
 * to the requirement regex, then to null, and the finding is left
 * untouched. Accepted recall trade-off: an existence assertion that cites
 * the marker in bare prose (no quotes) also escapes verification — it
 * stays blocking, which is the fail-safe side of this boundary.
 */
// ── #1238: input-declaration and gate-absence claim kinds ───────────────
// The #1016 incident family this boundary extends: fabricated claims about
// the REVIEWING ACTION's own declared inputs ("declares `ai-key`, not
// `ai-api-key`") and about its deterministic gates ("no draft/label
// filtering because the metadata declares no such input") survived as
// substantiated findings and drove request_changes with zero blockers.
// Verification witness: the executing action's own embedded contract
// (`declaredActionInputs`) — the exact revision the run executes, offline
// and deterministic. Classification is claim-unit-scoped (#1242: one unit
// may span a `;`-joined clause chain or a bare path citation) with a clause
// window so one unit carrying both directions ("declares `ai-key` ..., so
// `ai-api-key` is unexpected") still resolves each token's direction.

const ACTION_SUBJECT_CUE_RE = /\b(?:pinned|upstream|the )?action(?:'s)?\b/i;
/** The action's own manifest cited by file name is a legitimate subject for
 * an input-declaration claim, even though the citation sits inside a quoted
 * span (where cue scanning is masked). */
const MANIFEST_SUBJECT_RE = /\baction\.ya?ml\b/i;
/**
 * A reference to some OTHER action: an owner/repo path WITH an explicit ref
 * (actions/checkout@v4, owner/repo@sha) or a `uses:` key. The @ref is
 * required — an optional-ref shape would swallow every word/word path
 * citation ("src/run/action.ts", "docs/inputs.md", a ratio) and silently
 * exempt path-bearing fabricated claims from verification. Evaluated on the
 * raw sentence because the reference typically sits inside a quoted span
 * (masked for cue scanning). A bare owner/repo mention without a ref is not
 * recognized (fail-safe: the candidate survives to the witness, which can
 * only ground or mark unverified, never wrongly refute).
 */
const OTHER_ACTION_REF_RE = /\b[\w.-]+\/[\w.-]+@[^\s`,]*|\buses\s*:/i;
/**
 * Broad other-action MENTION: any word/word path (a file path, a ratio, a
 * bare owner/repo reference) or a `uses:` key. When the claim's own sentence
 * mentions such a path, a refutation would decide facts about THAT artifact
 * with the EXECUTING action's registry, so a positively-contradicted
 * candidate downgrades to unverified instead of refuting. Candidates are
 * still selected with the narrow @ref guard (OTHER_ACTION_REF_RE) so path
 * citations do not silently exempt claims from verification.
 */
const OTHER_ACTION_MENTION_RE = /\b[\w.-]+\/[\w.-]+|\buses\s*:/i;
/**
 * Attribute-scope cues: the claim constrains an attribute of the input
 * (requiredness, default, documentation, fork behavior) that the declared-id
 * registry cannot speak to. Such claims are not candidates — the boundary
 * never refutes a fact its witness cannot decide.
 */
const INPUT_ATTRIBUTE_SCOPE_RE = /\b(?:as\s+(?:required|optional)|defaults?\s+(?:to|of|value)|\bdocs\b|documentation|deprecated|forks?\b)/i;
/**
 * Presence/absence cue classes for the claim's direction. Absence is tested
 * first: a negated-declaration phrase ("declares no X", "not declared",
 * "does not declare") shares its verb with the presence vocabulary, so when
 * it matches it defines the direction by itself. An independent absence cue
 * next to a presence cue in the same clause ("declares input `x` that is
 * unexpected") is a mixed window and stays unresolvable — the fail-safe
 * direction: ambiguity never fabricates refutation and never grounds a
 * claim the boundary does not structurally understand. Runtime-behavior
 * cues ("is dropped", "is ignored") are deliberately absent: they describe
 * what the action DOES, not what its metadata DECLARES.
 */
const INPUT_NEGATED_DECLARATION_RE = /\b(?:not\s+declared|declares?\s+no|declared\s+no|does\s+not\s+(?:declare|appear|accept|forward|support))\b/i;
const INPUT_ABSENCE_CUE_RE = /\b(?:unexpected|not\s+declared|declares?\s+no|declared\s+no|does\s+not\s+(?:declare|appear|accept|forward|support)|not\s+an?\s+input|no\s+such\s+input|undeclared|unknown\s+input|invalid\s+input|not\s+recognized|unrecognized|missing\s+input)\b/i;
const INPUT_PRESENCE_CUE_RE = /\b(?:declares?|declared|accepts?|accepting|accepted|uses?|exposes?|named|requires?|expects?|has\s+(?:an?\s+)?[a-z-]+\s+inputs?)\b/i;
/** Action input ids: kebab-case identifiers, length-bounded. Quoted spans
 * only — plain-prose mechanism words ("no label input") are deliberately
 * not candidates; no semantic matching. */
const INPUT_TOKEN_RE = /^[a-z][a-z0-9-]{2,63}$/i;
/** Clause delimiters for the direction window. Parentheses are deliberately
 * NOT delimiters: a parenthetical source citation ("... as `ai-key`
 * (action.yml at v3.7.0), so ...") must not cut the token off from its
 * carrying clause. Windows are bounded by the token's sentence. */
const CLAUSE_DELIMITER_RE = /[,;]|\b(?:but|and|so|yet|or)\b/gi;
const GATE_BEHAVIOR_RE = /\b(?:drafts?|labels?|skips?|gates?|filters?|dedupes?|fingerprints?)\b/i;
/**
 * Absence cues for the gate-absence shape. The declaration family
 * ("declares no", "has no", "contains no", ...) is what the incident's
 * premise used; the negation family ("never", "does not", "not
 * implemented") covers the direct behavioral phrasing. A bare "no" is
 * deliberately absent: it would match any negation in any sentence.
 */
const GATE_ABSENCE_RE = /\b(?:absent|absence|doesn'?t|does\s+not|never|lacks?|missing|not\s+implement(?:ed|ing)?|not\s+perform(?:ed|ing)?|declares?\s+no|has\s+no|have\s+no|contains?\s+no|lists?\s+no|exposes?\s+no|offers?\s+no)\b/i;
const GATE_METADATA_RE = /\b(?:metadata|manifest|inputs?\s+(?:list|block|names?))\b/i;
/**
 * #1238: the gate-absence decision vocabulary. The witness (the executing
 * action's own implementation) proves that a gate EXISTS, so it can only
 * contradict a claim that says the action LACKS the behavior — a claim
 * that affirms the gate's presence is not contradicted by its existence and
 * stays unverified.
 *
 * - ABSENCE_CUE_WORDS negate ("never", "not", "no", "without", ...).
 * - MECHANISM_WORDS name a gate BEHAVIOR ("skips", "filters", "gates", ...).
 *   A cue bound to a mechanism word is a claim about what the action does.
 * - QUALIFIER_WORDS SCOPE a subject ("whose", "only", "except", ...). A
 *   scoped claim is not decidable by an implementation witness.
 * - DISPLACED_FORM_WORDS are the passive forms of a behavior claim ("is
 *   done by", "is handled by", ...) whose agent decides WHO performs it.
 */
const GATE_ABSENCE_CUE_WORDS: ReadonlySet<string> = new Set([
  "never", "not", "no", "without", "lacks", "lack", "lacking", "missing", "absent",
  "cannot", "can't", "wont", "won't", "fails", "fail", "failed", "neither", "nor",
]);
const GATE_MECHANISM_WORDS: ReadonlySet<string> = new Set([
  "skip", "skips", "skipped", "skipping",
  "filter", "filters", "filtering", "filtered",
  "gate", "gates", "gated", "gating",
  "screen", "screens", "screened", "screening",
  "exclude", "excludes", "excluding", "excluded",
  "reject", "rejects", "rejecting", "rejected",
  "ignore", "ignores", "ignoring", "ignored",
  "drop", "drops", "dropping", "dropped",
  "handle", "handles", "handling", "handled",
  "enforce", "enforces", "enforcing", "enforced",
  "perform", "performs", "performing", "performed",
  "implement", "implements", "implementing", "implemented",
  "process", "processes", "processing", "processed",
]);
const GATE_QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  "whose", "which", "when", "unless", "except", "where", "only", "just",
  "specifically", "besides", "within", "under",
]);
const GATE_DISPLACED_FORM_WORDS: ReadonlySet<string> = new Set([
  "done", "handled", "provided", "implemented", "performed", "executed",
]);
/**
 * A word of a claim sentence, with its character span. The gate scan
 * matches words, never substrings: "no" must not match inside "not", and
 * a possessive keeps its head word ("action's" is the action subject).
 */
interface GateToken {
  word: string;
  start: number;
  end: number;
}

/** Word tokens of a sentence: letters/digits, with intra-word apostrophes. */
const GATE_WORD_RE = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*/g;
/**
 * Upper bound on quoted spans the input-claim scan inspects per message.
 * The incident-class claim cites a handful of names; a pathological
 * all-backticks message must not turn the boundary into an O(spans x bytes)
 * stall (see MAX_CLAIM_SCAN_LENGTH for the message-level bound). Spans past
 * the cap are not candidates (untouched, the fail-safe direction).
 */
const MAX_CLAIM_SPANS = 24;

type InputDirection = "presence" | "absence" | "ambiguous";

interface InputCandidate {
  token: string;
  direction: InputDirection;
  /** The raw claim sentence mentions another action (broad path shape): a
   * positive contradiction from the registry cannot decide THAT action's
   * inputs, so refutation downgrades to unverified. */
  otherActionMention: boolean;
}

/**
 * The message with every quoted span — including its backtick delimiters —
 * replaced by "a" glyphs: same length and indices, so sentence/clause scans
 * and cue regexes never read inside or across a citation — "`action.yml`"
 * no longer splits a sentence at its dot, a comma inside backticks no
 * longer splits a clause, a quoted token can never complete (or forge) a
 * cue phrase, and filler shapes like "has an `ai-key` input" remain one
 * contiguous word run to the cue scanner. Other-action guards that must see
 * cited references evaluate the RAW text instead.
 */
function maskedForScan(message: string): string {
  const chars = message.split("");
  for (const span of quotedSpans(message)) {
    for (let i = Math.max(0, span.start - 1); i < Math.min(message.length, span.end + 1); i += 1) {
      chars[i] = "a";
    }
  }
  return chars.join("");
}

/** Claim-unit bounds around a span (#1242 boundaries, see
 * isClaimUnitBoundary; NOT the committed-literal scanner's tight split). */
function sentenceBounds(masked: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  while (start > 0 && !isClaimUnitBoundary(masked, start - 1)) start -= 1;
  let end = to;
  while (end < masked.length && !isClaimUnitBoundary(masked, end)) end += 1;
  return { start, end };
}

/** The clause window around a token span, bounded by the token's sentence
 * so a direction cue in a later sentence can never leak backwards. */
function clauseWindow(masked: string, sentenceStart: number, sentenceEnd: number, from: number, to: number): string {
  let start = sentenceStart;
  let end = sentenceEnd;
  for (const match of masked.slice(sentenceStart, sentenceEnd).matchAll(CLAUSE_DELIMITER_RE)) {
    const index = sentenceStart + (match.index ?? 0);
    if (index < from) {
      start = index + match[0]!.length;
    } else {
      end = index;
      break;
    }
  }
  return masked.slice(start, end);
}

function windowDirection(window: string): InputDirection | "none" {
  if (INPUT_ABSENCE_CUE_RE.test(window)) {
    if (INPUT_NEGATED_DECLARATION_RE.test(window)) return "absence";
    return INPUT_PRESENCE_CUE_RE.test(window) ? "ambiguous" : "absence";
  }
  return INPUT_PRESENCE_CUE_RE.test(window) ? "presence" : "none";
}

/**
 * Collect the quoted input-id candidates a message asserts about the
 * EXECUTING action's declared inputs. Each candidate must sit in a claim
 * unit (#1242 boundaries) carrying the action-subject cue (or a
 * manifest-file citation) and input vocabulary, must not name another
 * action, and its direction resolves within that token's unit-bounded
 * clause window. Attribute-scoped
 * claims and directionless mentions are not candidates.
 */
function classifyInputDeclaration(message: string): InputCandidate[] {
  const candidates: InputCandidate[] = [];
  // Cheap prefilter before the span walk: no action subject and no input
  // vocabulary anywhere means no input claim.
  if (message.length > MAX_CLAIM_SCAN_LENGTH) return candidates;
  if (!/action/i.test(message) || !/\binputs?\b/i.test(message)) return candidates;
  const masked = maskedForScan(message);
  const spans = quotedSpans(message).slice(0, MAX_CLAIM_SPANS);
  for (const span of spans) {
    const raw = message.slice(span.start, span.end).trim();
    if (!INPUT_TOKEN_RE.test(raw)) continue;
    const { start, end } = sentenceBounds(masked, span.start, span.end);
    const maskedSentence = masked.slice(start, end);
    if (!ACTION_SUBJECT_CUE_RE.test(maskedSentence) && !MANIFEST_SUBJECT_RE.test(message.slice(start, end))) continue;
    if (!/\binputs?\b/i.test(maskedSentence)) continue;
    // The registry only answers for the executing action.
    if (OTHER_ACTION_REF_RE.test(message.slice(start, end))) continue;
    const windowText = clauseWindow(masked, start, end, span.start, span.end);
    // Attribute-scope claims (requiredness, defaults, docs, fork behavior)
    // are outside the declared-id witness's authority.
    if (INPUT_ATTRIBUTE_SCOPE_RE.test(windowText)) continue;
    const direction = windowDirection(windowText);
    if (direction === "none") continue;
    candidates.push({
      token: raw.toLowerCase(),
      direction,
      otherActionMention: OTHER_ACTION_MENTION_RE.test(message.slice(start, end)),
    });
  }
  return candidates;
}

/**
 * A claim unit of a message that carries the gate-absence shape: the
 * action subject, a gate behavior word, an absence cue and a
 * metadata/input-list cue, all in ONE claim unit (#1242: a `;`-joined
 * clause chain or a message spanning a bare path citation counts as one).
 */
interface GateSentence {
  /** The unit as written — the other-action guard must see citations. */
  raw: string;
  /** The same unit with quoted spans masked — cues, subjects and
   * qualifiers can never be forged by a cited span. */
  masked: string;
}

/**
 * Gate-absence recognition (#1238): the message asserts that a
 * deterministic behavior of the action is absent while deriving that
 * conclusion from the action's metadata/input list (the incident's "no
 * label input" premise). Claim-unit-scoped (#1242 boundaries): every cue
 * family must co-occur in one unit, bounded by MAX_CLAIM_SCAN_LENGTH.
 *
 * Each matching unit is returned twice — masked (so a quoted span can
 * never forge a cue) and raw (so the other-action guard can see a cited
 * `owner/repo@ref` or `uses:` key). The masking preserves length and
 * indices, so both views describe the same characters.
 *
 * An empty list means the message asserts no gate absence.
 */
function gateAbsenceSentences(message: string): GateSentence[] {
  const sentences: GateSentence[] = [];
  if (message.length > MAX_CLAIM_SCAN_LENGTH) return sentences;
  if (!/action/i.test(message)) return sentences;
  const masked = maskedForScan(message);
  let cursor = 0;
  while (cursor < masked.length) {
    while (cursor < masked.length && isClaimUnitBoundary(masked, cursor)) cursor += 1;
    let end = cursor;
    while (end < masked.length && !isClaimUnitBoundary(masked, end)) end += 1;
    const maskedSentence = masked.slice(cursor, end);
    if (
      ACTION_SUBJECT_CUE_RE.test(maskedSentence)
      && GATE_BEHAVIOR_RE.test(maskedSentence)
      && GATE_ABSENCE_RE.test(maskedSentence)
      && GATE_METADATA_RE.test(maskedSentence)
    ) sentences.push({ raw: message.slice(cursor, end), masked: maskedSentence });
    cursor = end;
  }
  return sentences;
}

interface ClaimClassification {
  kind: GroundingKind | null;
  inputCandidates: InputCandidate[];
  /** #1238: the sentences that assert a gate absence. */
  gateSentences: GateSentence[];
}

/** Classify once per finding; the input candidates and the gate-absence
 * sentences are reused by the verification branch instead of rescanning the
 * message. */
function classifyClaim(message: string): ClaimClassification {
  if (assertsCommittedMarker(message)) return { kind: "committed_literal", inputCandidates: [], gateSentences: [] };
  const inputCandidates = classifyInputDeclaration(message);
  if (inputCandidates.length > 0) return { kind: "input_declaration", inputCandidates, gateSentences: [] };
  const gateSentences = gateAbsenceSentences(message);
  if (gateSentences.length > 0) return { kind: "gate_absence", inputCandidates: [], gateSentences };
  if (REQUIREMENT_NOT_ENFORCED_RE.test(message)) return { kind: "requirement_claim", inputCandidates: [], gateSentences: [] };
  return { kind: null, inputCandidates: [], gateSentences: [] };
}

/** The word tokens of a sentence, lowercased, with their character spans. */
function gateTokens(sentence: string): GateToken[] {
  const tokens: GateToken[] = [];
  for (const match of sentence.matchAll(GATE_WORD_RE)) {
    const start = match.index ?? 0;
    tokens.push({ word: match[0].toLowerCase(), start, end: start + match[0].length });
  }
  return tokens;
}

/**
 * The clause ranges of a sentence: the segments between the clause
 * delimiters (a comma, a semicolon, or the words but/and/so/yet/or — the
 * same boundary semantics the input-declaration direction window uses). A
 * delimiter word is part of no clause.
 */
function gateClauseRanges(sentence: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const match of sentence.matchAll(CLAUSE_DELIMITER_RE)) {
    const at = match.index ?? 0;
    if (at > cursor) ranges.push({ start: cursor, end: at });
    cursor = at + match[0].length;
  }
  if (cursor < sentence.length) ranges.push({ start: cursor, end: sentence.length });
  return ranges;
}

/** True when the token names the executing action ("action", "action's"). */
function isActionSubjectToken(word: string): boolean {
  return word === "action" || word === "action's";
}

/**
 * #1238: does the claim assert that the ACTION lacks the behavior? The
 * implementation witness proves the gate EXISTS, so it may contradict only
 * a claim of absence. Two forms qualify:
 *
 * (a) NEGATION-BOUND: an absence cue is followed, in the same clause, by a
 *     mechanism word with at most two intervening tokens. The clause must
 *     name the action — otherwise the cue is attributed to a different
 *     actor ("the workflow never skips drafts") and says nothing about the
 *     action's own gates.
 * (b) DISPLACEMENT: a mechanism word is followed by "is|are" + a passive
 *     form + "by", and the words right after "by" do not name the action.
 *     The behavior is attributed to something else, which the action's own
 *     implementation contradicts — the shape the #1238 incident claim used
 *     ("that filtering is done by this workflow's own `if`").
 *
 * The sentence and its tokens are the MASKED view: a quoted span can never
 * forge a cue, a subject or a qualifier.
 */
function assertsActionAbsence(sentence: string, tokens: readonly GateToken[]): boolean {
  for (const range of gateClauseRanges(sentence)) {
    const clause = tokens.filter((token) => token.start >= range.start && token.end <= range.end);
    // (a) negation bound.
    if (clause.some((token) => isActionSubjectToken(token.word))) {
      for (let i = 0; i < clause.length; i += 1) {
        if (!GATE_ABSENCE_CUE_WORDS.has(clause[i]!.word)) continue;
        for (let j = i + 1; j < clause.length && j - i - 1 <= 2; j += 1) {
          if (GATE_MECHANISM_WORDS.has(clause[j]!.word)) return true;
        }
      }
    }
    // (b) displacement: the behavior is attributed to another agent.
    for (let m = 0; m + 3 < clause.length; m += 1) {
      if (!GATE_MECHANISM_WORDS.has(clause[m]!.word)) continue;
      const verb = clause[m + 1]!.word;
      if (verb !== "is" && verb !== "are") continue;
      if (!GATE_DISPLACED_FORM_WORDS.has(clause[m + 2]!.word)) continue;
      if (clause[m + 3]!.word !== "by") continue;
      const target = clause.slice(m + 4, m + 7).map((token) => token.word);
      if (!target.some(isActionSubjectToken)) return true;
    }
  }
  return false;
}

/**
 * #1238: the registry gates whose behavior subject a sentence names,
 * sorted by id. A subject occurrence QUALIFIED by a scoping word ("whose",
 * "only", ...) drops that gate from the covered set entirely: the claim is
 * scoped, and an implementation witness cannot decide a scoped claim.
 */
function coveredActionGates(tokens: readonly GateToken[]): ActionGate[] {
  const covered: ActionGate[] = [];
  for (const gate of ACTION_GATES) {
    const occurrences = tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => gate.subjects.includes(token.word));
    if (occurrences.length === 0) continue;
    const qualified = occurrences.some(({ index }) => {
      for (let offset = -3; offset <= 3; offset += 1) {
        if (offset === 0) continue;
        const neighbor = tokens[index + offset];
        if (neighbor !== undefined && GATE_QUALIFIER_WORDS.has(neighbor.word)) return true;
      }
      return false;
    });
    if (qualified) continue;
    covered.push(gate);
  }
  return covered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * #1238: the action-source budget of one boundary pass — the reads spent
 * on the executing action's own implementation and the per-file cache (one
 * read per cited file, however many gates cite it).
 */
interface ActionSourceBudget {
  reads: number;
  cache: Map<string, ActionSourceReadResult>;
}

/**
 * #1238: is the gate attested by the action's own implementation? Only a
 * POSITIVE marker presence in the cited implementation file counts. A
 * missing marker is NOT proof the gate is absent (it may be implemented
 * elsewhere), and an unreadable file is no evidence at all — both are
 * undecided, never refutation and never grounding.
 */
async function gateAttested(
  gate: ActionGate,
  read: ActionSourceReader,
  budget: ActionSourceBudget,
): Promise<boolean> {
  let result = budget.cache.get(gate.implementation);
  if (result === undefined) {
    if (budget.reads >= MAX_ACTION_SOURCE_READS) return false;
    budget.reads += 1;
    result = await read(gate.implementation);
    budget.cache.set(gate.implementation, result);
  }
  if (result.status === "unavailable") return false;
  return result.text.includes(gate.marker);
}

/**
 * #1238: decide a gate-absence claim, ONE CLAIM UNIT AT A TIME.
 *
 * The decision is never made across units: a manifest-only unit (a
 * declaration about the action's inputs) is never refuted because another
 * unit in the same message carries a behavioral absence. Each unit is
 * judged on its own (#1242: a `;`-joined clause chain is ONE unit, but the
 * absence assertion below stays CLAUSE-scoped, so joining clauses never
 * attributes one clause's negation to another clause's subject):
 *
 *  (a) it must not mention ANOTHER action — the executing action's
 *      implementation cannot decide another action's gates;
 *  (b) it must not name a behavior the registry does not cover;
 *  (c) it must name at least one covered, unqualified gate subject;
 *  (d) it must ASSERT the action's absence of that behavior;
 *  (e) every covered gate of that sentence must be ATTESTED by the
 *      action's own implementation.
 *
 * Only then is the finding refuted. Anything else — a scoped claim, an
 * absent marker, an unreadable file, a claim the registry cannot decide —
 * stays unverified, and a gate-absence claim is NEVER grounded.
 */
async function decideGateAbsence(
  sentences: readonly GateSentence[],
  witness: ActionSourceReader | null | undefined,
  budget: ActionSourceBudget,
): Promise<{ status: GroundingStatus; reason: string }> {
  const unverifiable = { status: "unverified", reason: "gate-absence-unverifiable" } as const;
  if (witness === undefined || witness === null) return unverifiable;
  for (const sentence of sentences) {
    // The other-action guards read the RAW sentence: a cited
    // `owner/repo@ref` or `uses:` key usually sits inside a quoted span,
    // which the masked view hides.
    if (OTHER_ACTION_REF_RE.test(sentence.raw) || OTHER_ACTION_MENTION_RE.test(sentence.raw)) continue;
    // Everything else reads the masked view, like every other cue scan in
    // this boundary: a quoted span can never forge a cue, a subject or a
    // qualifier.
    const tokens = gateTokens(sentence.masked);
    if (UNCOVERED_GATE_SUBJECTS.some((subject) => tokens.some((token) => token.word === subject))) continue;
    const covered = coveredActionGates(tokens);
    if (covered.length === 0) continue;
    if (!assertsActionAbsence(sentence.masked, tokens)) continue;
    const attested: string[] = [];
    let allAttested = true;
    for (const gate of covered) {
      if (!await gateAttested(gate, witness, budget)) {
        allAttested = false;
        break;
      }
      attested.push(gate.id);
    }
    if (allAttested) {
      return { status: "refuted", reason: `gate-implemented:${attested.sort().join(",")}` };
    }
  }
  return unverifiable;
}

/**
 * Extract backtick-delimited code spans from a finding message. Used by the
 * `requirement_claim` branch: a generic "requirement not enforced" assertion
 * carries no machine-checkable evidence of a specific violation unless it
 * cites specific code. Bare line numbers and bare file references cannot
 * establish that the cited code matches what the source actually contains;
 * only quoted code does.
 */
function extractCodeSpans(message: string): string[] {
  const out: string[] = [];
  for (const match of message.matchAll(/`([^`]+)`/g)) {
    const span = (match[1] ?? "").trim();
    // Single characters and pure punctuation do not constitute a citable
    // claim — a minimum length alone would let a ubiquitous token like
    // `=>` "ground" any claim, so require at least one identifier
    // character.
    if (span.length >= 2 && /[A-Za-z0-9_$]/.test(span)) out.push(span);
  }
  return out;
}

export async function applyBlockerVerification(
  findings: ArtifactFinding[],
  options: BlockerVerificationOptions,
): Promise<BlockerVerificationResult> {
  const entries: FindingGrounding[] = [];
  let reads = 0;
  let demoted = 0;
  // The action's own implementation reads of this pass: one read per cited
  // file (however many gates cite it), bounded by MAX_ACTION_SOURCE_READS.
  const actionSourceBudget: ActionSourceBudget = { reads: 0, cache: new Map<string, ActionSourceReadResult>() };

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]!;
    if (finding.category === "verification") continue;
    // Already processed by an earlier pass of this boundary (the engine runs
    // it again after thread settlement re-emits prior findings): never
    // re-verify, re-demote, or overwrite a recorded grounding.
    if (finding.grounding_status !== undefined) continue;
    // Another deterministic capping path (#775 non-blocking categories,
    // #976 CI evidence) already claimed this finding's severity: re-deriving
    // it here could misattribute the original severity and re-force a
    // verdict those paths settled.
    if (finding.capped_from !== undefined || finding.ci_capped === true) continue;
    const { kind, inputCandidates, gateSentences } = classifyClaim(finding.message);
    if (kind === null) continue;

    let status: GroundingStatus;
    let reason: string;
    if (kind === "input_declaration") {
      const declared = options.declaredActionInputs;
      if (declared === undefined || declared === null) {
        status = "unverified";
        reason = "input-registry-unavailable";
      } else {
        const normalized = new Set([...declared].map((input) => input.toLowerCase()));
        const resolved = inputCandidates.filter((candidate) => candidate.direction !== "ambiguous");
        // Refutation requires POSITIVE contradiction by the witness: an
        // absence claim about an input the registry declares. A presence
        // claim about an input the registry lacks is NOT a contradiction —
        // the claim may describe a manifest revision the running bundle
        // predates (a PR adding the input to this very action) — so it is
        // marked unverified, never refuted (#1238 review: refutation only
        // on facts the witness can decide).
        const contradicted = resolved.find((candidate) =>
          candidate.direction === "absence" && normalized.has(candidate.token));
        if (contradicted !== undefined && contradicted.otherActionMention) {
          // The claim's sentence names another artifact (a path or bare
          // owner/repo reference): the registry cannot decide ITS inputs,
          // so even a positively-contradicted candidate only marks
          // unverified.
          status = "unverified";
          reason = "other-action-claim-unverified";
        } else if (contradicted !== undefined) {
          status = "refuted";
          reason = `input-declared:${contradicted.token}`;
        } else {
          const grounded = resolved.find((candidate) =>
            (candidate.direction === "absence" && !normalized.has(candidate.token))
            || (candidate.direction === "presence" && normalized.has(candidate.token)));
          if (grounded !== undefined) {
            status = "grounded";
            reason = `${grounded.direction === "presence" ? "input-declared" : "input-absent"}:${grounded.token}`;
          } else {
            status = "unverified";
            reason = resolved.some((candidate) => candidate.direction === "presence")
              ? "input-presence-unverified"
              : "input-claim-unresolvable";
          }
        }
      }
    } else if (kind === "gate_absence") {
      // #1238: the metadata cannot decide a behavior-existence claim —
      // the action's own implementation can. The decision is made per
      // sentence (never across sentences): a claim whose named gate the
      // executing implementation POSITIVELY implements is refuted; every
      // other shape stays unverified, the fail-safe direction — a missing
      // marker is no proof of absence, and a claim the registry does not
      // cover cannot be decided at all.
      const decision = await decideGateAbsence(gateSentences, options.readActionSource, actionSourceBudget);
      status = decision.status;
      reason = decision.reason;
    } else if (!safeFile(finding.file)) {
      status = kind === "committed_literal" ? "unverified" : "unsupported";
      reason = kind === "committed_literal" ? "no-location" : "no-concrete-location";
    } else if (reads >= MAX_VERIFICATION_READS) {
      status = "unverified";
      reason = "read-budget-exhausted";
    } else {
      reads += 1;
      const read = await options.readSource(finding.file);
      if (read.status === "unavailable") {
        if (read.reason === "not-found") {
          status = "refuted";
          reason = kind === "committed_literal" ? "marker-absent" : "location-missing";
        } else {
          status = "unverified";
          reason = read.reason;
        }
      } else if (!authorizesLiteralClaim(read.provenance, options.expectedRevision)) {
        // Defense-in-depth: the reader binds provenance to the same exact
        // revision, so this is normally just "committed_source and
        // unsynthesized". A reader that reads a different revision (or a
        // stale one) still fails closed here rather than grounding the claim.
        status = "unverified";
        reason = "non-authoritative-source";
      } else if (kind === "committed_literal") {
        const present = SANITIZER_MARKERS.some((marker) => verifySourceSpan(read.text, marker).present);
        status = present ? "grounded" : "refuted";
        reason = present ? "marker-present" : "marker-absent";
      } else {
        // requirement_claim: a generic standard assertion cannot promote
        // CHANGES_REQUESTED on file/line existence alone — line 3 of
        // `const x = 1; const y = 2; const z = 3;` does not establish that
        // a violated standard lives there. Independent, machine-checkable
        // evidence of a specific violation is required: a backticked code
        // span whose bytes match the exact-head source. The evidence must
        // sit at the cited location (#1016 review pass): the span is
        // grounded only when it occurs within ±EVIDENCE_LINE_WINDOW lines
        // of the cited line. A span found only elsewhere in the file is
        // unknown evidence, not confirmation (unverified); a claim with no
        // cited evidence is unsupported, and one whose spans the source
        // contains nowhere is refuted (source positively disproves the
        // cited pattern). A span without a concrete cited line can never
        // ground, even when it matches elsewhere.
        const spans = extractCodeSpans(finding.message);
        if (spans.length === 0) {
          status = "unsupported";
          reason = "no-cited-evidence";
        } else {
          const line = finding.line;
          const citedLine = typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : null;
          if (citedLine === null) {
            status = "unsupported";
            reason = "no-concrete-location";
          } else {
            const lines = read.text.split(/\r?\n/);
            if (citedLine > lines.length) {
              // A cited line past the end of the file is an unverifiable
              // location, not positive disproof (the model may count a
              // trailing-newline-terminated file one line longer), so it
              // must not refute into the relaxable path.
              status = "unverified";
              reason = "line-beyond-end";
            } else {
              // Compare cited spans to the window modulo carriage returns:
              // model citations carry LF line endings even when the commit
              // uses CRLF, and the line-ending representation must never
              // by itself flip grounded into refuted.
              const strip = (s: string): string => s.replace(/\r/g, "");
              const windowText = strip(lines
                .slice(Math.max(0, citedLine - 1 - EVIDENCE_LINE_WINDOW), citedLine + EVIDENCE_LINE_WINDOW)
                .join("\n"));
              if (spans.some((span) => verifySourceSpan(windowText, strip(span)).present)) {
                status = "grounded";
                reason = "evidence-verified";
              } else if (spans.some((span) => verifySourceSpan(strip(read.text), strip(span)).present)) {
                status = "unverified";
                reason = "evidence-location-mismatch";
              } else {
                status = "refuted";
                reason = "evidence-mismatch";
              }
            }
          }
        }
      }
    }

    if (status !== "grounded") {
      finding.grounding_status = status;
      if (finding.severity === "blocker" || finding.severity === "major") {
        if (finding.capped_from === undefined) finding.capped_from = finding.severity;
        finding.severity = "minor";
        demoted += 1;
      }
    }
    entries.push({ index, status, kind, reason });
  }

  return { findings: entries, demoted };
}
