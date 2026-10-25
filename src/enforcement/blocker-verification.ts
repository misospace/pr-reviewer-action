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

/**
 * #1240 (pinned-revision witness): the witness for the revision the
 * CONSUMER pinned — the exact commit the consumer's workflow pins, and
 * nothing else.
 *
 * Unlike the executing witnesses (the embedded contract and the embedded
 * implementation tree), which speak for the revision THIS run executes,
 * this one speaks for a DIFFERENT revision: the pinned one. Its bytes are
 * a content-addressed fetch through the platform API at the exact pinned
 * commit (runner metadata `GITHUB_ACTION_REPOSITORY` / `GITHUB_ACTION_REF`)
 * — never bytes of the reviewed workspace, never the executing bundle —
 * and they are bounded and cached: `read` serves one registry-cited file
 * AT the pinned revision, `declaredInputs` the pinned revision's own
 * declared input ids (null when undecidable).
 */
export interface PinnedActionWitness {
  /** Full lowercase 40-hex commit SHA the consumer pinned. */
  readonly revision: string;
  /** Bounded, cached read of one registry-cited file AT the pinned revision. */
  read(relativePath: string): Promise<ActionSourceReadResult>;
  /** Lowercased input ids the pinned revision's action.yml declares; null when undecidable. */
  declaredInputs(): Promise<ReadonlySet<string> | null>;
}

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
  /**
   * #1238: witness for the WORKFLOW half of the input mapping — the input
   * names the REVIEWED repository's own workflows pass to this action at the
   * exact reviewed head, keyed by the workflow file that passes them.
   *
   * It is a separate witness from the embedded contract because it answers
   * a different question: the contract speaks for what the action DECLARES,
   * this one for what a workflow PASSES.
   *
   * The map is PER FILE and only a file that was read completely AND
   * contains a DIRECT step invoking this action has an entry, so the
   * boundary may only speak about the file the FINDING itself cited: no
   * entry for that file means no witness for that finding, and the claim
   * keeps exactly the behavior it had before. A workflow that reaches the
   * action through a local composite action or a reusable workflow has no
   * direct action step, so it has no entry, so nothing is refuted on its
   * word.
   *
   * The witness CORROBORATES and NEVER REFUTES. It grounds a workflow-scoped
   * claim about the mapping when the cited file's direct action step passes
   * that name, and it establishes NO absence: the reader sees only the
   * direct action steps of a file, so "this file does not pass X" is not an
   * absence it can establish. An uncorroborated workflow-scoped claim is
   * never refuted — it falls through to the ordinary unknown-evidence path
   * and the review fails closed on it.
   *
   * Absent (or null) means no witness is available, which is the pre-#1238
   * behavior: the claim stays exactly as it was decided before.
   */
  workflowInputsByFile?: ReadonlyMap<string, ReadonlySet<string>> | null | undefined;
  /**
   * #1240: the build stamp of the revision THIS run executes ("v3.7.0" for
   * a release build, "v3.7.0-dev+abc1234" for a dogfood build, "" for an
   * unstamped local/test build).
   *
   * The declared-input registry and the implementation tree speak for the
   * EXECUTING revision's RELEASE LINE, so a claim that names a DIFFERENT
   * line or another patch is not decidable with them: it is unverified —
   * never refuted, never grounded. A dogfood build of the `v3.7.0` line
   * answers for `v3.7.0` (the same line). Known limitation: a dev build's
   * contract may carry inputs added after the release, so a claim about
   * such an input stays unverified rather than refuted.
   *
   * The stamp comes from the bundle's own build stamp (src/version.ts) and
   * never from an environment variable, an Action input, or any byte
   * OUTSIDE the bundle. On the dogfood path the bundle itself is built
   * from the PR head, so the stamp — like the embedded contract — inherits
   * the PR's trust level.
   *
   * An unstamped build (null/undefined/"") applies NO revision scoping.
   * Only the builds that ship to consumers are stamped
   * (.github/workflows/manual-release.yml and release-please.yaml stamp
   * `release`; ai-pr-review.yaml and ai-pr-review-fork.yaml stamp `dev`),
   * so an unstamped build is a local/test-only configuration, not a
   * production path.
   */
  executingActionVersion?: string | null | undefined;
  /**
   * #1240 (pinned-revision witness): the witness for the exact commit the
   * CONSUMER pinned (runner metadata `GITHUB_ACTION_REPOSITORY` /
   * `GITHUB_ACTION_REF`, a content-addressed fetch through the platform
   * API — never reviewed-workspace bytes).
   *
   * The declared-input registry and the implementation tree speak for the
   * EXECUTING revision's release line, so a claim naming a DIFFERENT
   * revision is not decidable with them — it is unverified. This witness
   * is the exception: when every qualifier the message names that fails
   * the executing match matches the pinned revision, the claim is decided
   * with THIS witness (the pinned contract, the pinned implementation
   * tree) instead of being left unverified. A claim naming any other
   * revision stays unverified exactly as before.
   *
   * Absent (or null) means no pinned witness is available, which is
   * exactly today's behavior: every claim naming a different revision
   * stays unverified.
   */
  pinnedActionSource?: PinnedActionWitness | null | undefined;
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
 * Canonicalize a cited tree path before it is used as a git revarg or
 * pathspec, or as a lookup key into a per-file witness.
 *
 * Git's tree lookups key on the canonical path — a raw citation like
 * `src//a.ts` or `./src/a.ts` fails `git show` even when the canonical
 * entry exists — so the reader normalizes empty and `.` segments on both
 * sides of the seam and never lets a normalization mismatch become an
 * affirmative "path absent". `safeFile` has already rejected absolute
 * paths, leading `-`, `..` segments, and NUL, so stripping empty/dot
 * segments cannot introduce traversal.
 */
export function canonicalTreePath(file: string): string {
  return file.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
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
// and deterministic. Classification is sentence-scoped with a clause window
// so one sentence carrying both directions ("declares `ai-key` ..., so
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
 * recognized here: the subject of a claim is decided by the clause-subject
 * resolution (clauseNamesOtherAction), and a mention alone — a path or a
 * bare name anywhere in the sentence — never disarms the witness (#1240
 * review round: exempting path-cited claims let a fabricated major keep
 * forcing request_changes).
 */
const OTHER_ACTION_REF_RE = /\b[\w.-]+\/[\w.-]+@[^\s`,]*|\buses\s*:/i;
/**
 * Broad other-action MENTION: any word/word path (a file path, a ratio, a
 * bare owner/repo reference) or a `uses:` key. It guards the GATE-absence
 * decision only: a gate sentence naming any path could be about another
 * artifact's implementation, and the gate path has no clause-subject
 * resolution, so the conservative guard keeps such a sentence unverified
 * instead of risking a false refutation.
 *
 * The INPUT-declaration path deliberately does NOT use it (#1240 review):
 * its subject is resolved per clause (clauseNamesOtherAction), which treats
 * a file-path citation as what it is — "src/run/action.ts" is a path, not
 * another action. A bare-mention downgrade there would let a fabricated
 * claim escape refutation by citing any path, keeping a source-contradicted
 * major finding blocking (#1238 is exactly about that outcome).
 */
const OTHER_ACTION_MENTION_RE = /\b[\w.-]+\/[\w.-]+|\buses\s*:/i;
/**
 * The modifiers that refer to the EXECUTING action itself. A claim whose
 * action noun carries one of them ("the action", "the pinned action",
 * "the executing action") is about this action; any other modifier names
 * another artifact ("the checkout action", "the `owner/repo` action").
 *
 * The boundary has no repository identity, so it cannot tell a name that
 * refers to this action ("the pr-reviewer-action") from one that refers
 * to another one. An unrecognized modifier is therefore read as another
 * action — the fail-safe direction: an unknown claim is never treated as
 * confirmed, and an unverified blocker/major still fails closed.
 */
const SELF_ACTION_MODIFIERS: ReadonlySet<string> = new Set([
  "", "a", "an", "the", "this", "that", "these", "those", "its", "their",
  "our", "own", "same", "current", "pinned", "upstream", "reviewed",
  "executing", "running", "published", "released", "deployed", "shipped",
  "configured", "target", "given", "above", "following", "present",
  "mentioned", "cited", "included", "underlying",
]);
/**
 * The modifier of an action noun: what names the action the claim is
 * about. A quoted reference ("`owner/repo` action") and a plain name
 * ("the checkout action") both name the action; "the", "its" and a bare
 * noun refer to the EXECUTING action.
 */
function actionModifier(raw: string, start: number): string {
  let cursor = start - 1;
  while (cursor >= 0 && /\s/.test(raw[cursor]!)) cursor -= 1;
  // A possessive modifier ("`owner/repo`'s action"): the name carries the
  // possessive, so the name is read past it.
  if (cursor >= 1 && raw[cursor] === "s" && raw[cursor - 1] === "'") {
    cursor -= 2;
    while (cursor >= 0 && /\s/.test(raw[cursor]!)) cursor -= 1;
  }
  if (cursor < 0) return "";
  if (raw[cursor] === "`") {
    const open = raw.lastIndexOf("`", cursor - 1);
    if (open === -1) return "";
    return raw.slice(open + 1, cursor).toLowerCase();
  }
  const end = cursor;
  while (cursor >= 0 && /[A-Za-z0-9]/.test(raw[cursor]!)) cursor -= 1;
  return raw.slice(cursor + 1, end + 1).toLowerCase();
}

/**
 * Does the clause attribute its claim to ANOTHER action?
 *
 * The subject of an action claim is the noun phrase ending in "action", so
 * the modifier immediately before that noun decides whose action it is:
 * "the action" (this action) versus "the checkout action" / "the
 * `owner/repo` action" (another one). The registry witnesses the
 * EXECUTING action only, so a claim about another one is never decided
 * with it — neither grounded nor refuted.
 *
 * A file-path citation is not an action subject: "action.yml" and
 * "src/run/action.ts" are path components, not nouns, so they are skipped
 * (#1238: path citations do not exempt claims — a genuine
 * missing-declaration claim that cites a path stays decidable). The
 * sentence split cuts at the "." of "action.yml", so the path component is
 * recognized from the text that follows the clause.
 */
function clauseNamesOtherAction(rawClause: string, rawTail: string): boolean {
  for (const match of rawClause.matchAll(/action/gi)) {
    const start = match.index ?? 0;
    const end = start + match[0]!.length;
    const before = start > 0 ? rawClause[start - 1]! : "";
    const after = rawClause[end] ?? "";
    // A standalone word only: "actionary" is not the action noun.
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
    // A path component: "src/run/action.ts" (the "/" is inside the clause)
    // and "action.yml" (the sentence split cut the clause at its ".").
    if (before === "/") continue;
    if (end === rawClause.length && /^\.[a-z][a-z0-9]*/.test(rawTail)) continue;
    if (!SELF_ACTION_MODIFIERS.has(actionModifier(rawClause, start))) return true;
  }
  return false;
}
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
/**
 * #1238: the workflow-to-action mapping vocabulary. A clause whose SUBJECT
 * is the WORKFLOW and a mapping verb asserts that the workflow supplies
 * that input name to the action ("the workflow passes `ai-key`"); the same
 * verb in a clause that does not name the workflow — or that only mentions
 * it — says nothing about the mapping and is not a cue at all.
 */
const WORKFLOW_MAPPING_PRESENCE_RE = /\b(?:passes|passed|provides|provided|supplies|supplied|sends|sent|feeds|fed)\b/i;
/**
 * #1238: the NEGATED mapping verb ("does not pass", "never passes", "no
 * longer provides") is an absence cue of its own: it asserts that the
 * workflow does NOT supply that input name. The negated verb may take its
 * base form ("pass"), so the base forms join the mapping vocabulary here.
 * Like its positive counterpart, it is a cue only in a workflow-SUBJECT
 * clause, and only when the finding has a workflow witness.
 */
const WORKFLOW_MAPPING_NEGATION_RE = /\b(?:does\s+not|do\s+not|doesn't|don't|never|no\s+longer|not)\s+(?:pass|passes|passed|provide|provides|provided|supply|supplies|supplied|send|sends|sent|feed|feeds|fed)\b/i;
/**
 * #1238: the words that may stand between the start of a clause and the
 * workflow noun without breaking the workflow's SUBJECT position: the
 * determiners, plus the few adjectives and nouns that name the workflow
 * itself ("the calling workflow", "the CI workflow"). Any other word — a
 * verb, or a noun like "action" or "input" — means the workflow is only
 * MENTIONED in that clause, not its subject.
 */
const WORKFLOW_SUBJECT_DETERMINERS: ReadonlySet<string> = new Set([
  "the", "this", "that", "its", "a", "an", "each", "every", "one",
  "review", "reviewing", "calling", "consumer", "current", "ci",
]);
/**
 * #1238: a clause that names the WORKFLOW. The mapping witness speaks only
 * about the workflow-to-action input mapping, so only a workflow-scoped
 * claim can be decided with it. The word is read from the MASKED clause
 * window: a citation cannot forge the scope.
 */
const WORKFLOW_SUBJECT_RE = /\bworkflows?\b/i;
/**
 * #1238: is the WORKFLOW the SUBJECT of this clause?
 *
 * The workflow witness may only decide a claim that is ABOUT the workflow's
 * own mapping. A claim whose subject is the ACTION ("the action declares
 * the `ai-api-key` input the workflow expects") is about what the action
 * declares, and PR-controlled workflow bytes must never refute it.
 *
 * The rule: the FIRST workflow mention in the clause's MASKED text must be
 * in subject position — the text before it may consist of nothing but
 * determiners/adjectives (WORKFLOW_SUBJECT_DETERMINERS) and whitespace.
 * A quoted span cannot forge the mention (the scan reads the masked view),
 * and a masked-out citation is not a word of the claim, so it neither
 * establishes nor breaks the subject position.
 *
 * The rule is deliberately conservative: an unrecognized word in front of
 * the workflow noun means "not workflow-scoped", which leaves the claim
 * undecided rather than refuted.
 */
function clauseWorkflowSubject(maskedClause: string): boolean {
  const match = WORKFLOW_SUBJECT_RE.exec(maskedClause);
  if (match === null) return false;
  const before = maskedClause.slice(0, match.index);
  for (const word of before.split(/[^A-Za-z0-9']+/)) {
    if (word === "") continue;
    // A run of the mask glyph is a masked-out citation, not a word of the
    // claim: the mask replaces a quoted span AND its delimiters, so such a
    // run is never shorter than three glyphs.
    if (/^a{3,}$/i.test(word)) continue;
    if (!WORKFLOW_SUBJECT_DETERMINERS.has(word.toLowerCase())) return false;
  }
  return true;
}
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
  /** The raw claim CLAUSE names another action as its subject (a modifier
   *   in front of the action noun: "the `owner/repo` action", "the
   *   checkout action"): the registry speaks for the executing action only,
   *   so such a claim is never decided with it — neither grounded nor
   *   refuted. A file-path citation is not a subject (#1240 review): it
   *   never downgrades a positive contradiction. */
  otherActionSubject: boolean;
  /** #1238: the clause's SUBJECT is the WORKFLOW (the workflow noun opens
   *   the clause), so the claim is about the workflow-to-action input
   *   mapping. The declaration registry does NOT speak for what a
   *   workflow passes or declares, so such a claim is never decided with
   *   the registry — neither grounded nor refuted by it. */
  workflowSubject: boolean;
}

// ── #1240: revision scoping ──────────────────────────────────────────────
// The witnesses this boundary uses for the action's own claims belong to the
// EXECUTING revision: the embedded V3 contract (declared inputs) and the
// action's own implementation tree (deterministic gates). A claim that names
// a DIFFERENT revision — a workflow pinning `owner/repo@v3.6.1`, or prose
// saying "the action at v3.6.1 does not declare `x`" — is not decidable with
// those witnesses: a TRUE claim about another revision would be refuted
// (false refutation) and a FALSE one grounded. Such a claim is UNVERIFIED:
// never refuted, never grounded.
//
// The exception is the pinned-revision witness (PinnedActionWitness): the
// consumer pins the action at an exact commit, and that PIN's own contract
// and implementation tree are a second, separate witness. Per finding, the
// qualifiers that FAIL the executing match are "other"; when every "other"
// qualifier matches the pinned revision, the claim is decided with the
// PINNED witnesses instead of being left unverified (the reasons are
// prefixed `pinned-`). Only SHA-like qualifiers can match the pin — it is
// an exact commit, not a release line — so a version-like qualifier never
// does: a message naming both a different line and the pin is still a
// claim about the other line and stays unverified. A message naming any
// revision neither witness answers for stays unverified exactly as before.
//
// The scope of the revision scan is the WHOLE finding message: a claim and
// the revision it talks about can sit in different sentences ("The action
// does not declare `x` input; the v3.6.1 manifest confirms it."), and a
// scan that only looked at the claim's own sentence would decide the claim
// with the executing revision's witnesses while the message itself names
// another revision.

/**
 * #1240: a revision identifier a finding message names.
 */
interface RevisionQualifier {
  /** The identifier as written, lowercased. */
  text: string;
  kind: "version" | "sha";
}

/**
 * A version-shaped token: `v` + one to three numeric components with an
 * optional pre-release/build suffix ("v3", "v3.7", "v3.7.0",
 * "v3.7.0-dev+abc1234"), or the unprefixed form with at least three numeric
 * components ("3.7.0").
 */
const VERSION_QUALIFIER_RE = /^v?(\d+(?:\.\d+)*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
/** A commit sha in its short or full form: 7–40 hex characters. */
const SHA_QUALIFIER_RE = /^[0-9a-f]{7,40}$/i;
/**
 * The words that INTRODUCE a revision identifier. The introduced token
 * counts as a qualifier only when it is version-like or SHA-like: a bare
 * integer ("version 2", "ref: 1234") names no revision, and a prose word
 * ("release notes") names none either.
 */
const REVISION_KEYWORD_RE = /\b(?:revision|release|tag|version|commit|branch|ref)\b\s*[:=]?\s*([^\s]+)/gi;

/**
 * #1240: is the token a version identifier? The `v` form is a version
 * marker on its own and carries one to three numeric components; the bare
 * form needs a full major.minor.patch ("3.7.0") to be unambiguously a
 * version — a bare integer or a bare major.minor is a number, not a
 * revision.
 */
function isVersionLike(token: string): boolean {
  const match = VERSION_QUALIFIER_RE.exec(token);
  if (match === null) return false;
  const components = match[1]!.split(".").length;
  if (/^v/i.test(token)) return components >= 1 && components <= 3;
  return components >= 3;
}

/**
 * #1240: is the token a commit sha? A sha carries at least one digit: an
 * all-letter hex word ("defaced") is prose, not a revision identifier.
 */
function isShaLike(token: string): boolean {
  return SHA_QUALIFIER_RE.test(token) && /\d/.test(token);
}

/**
 * The token without the punctuation that surrounds it: a citation's
 * backticks, quotes, brackets and a trailing period are not part of the
 * identifier ("`v3.7.0`" and "v3.7.0)." both name "v3.7.0").
 */
function stripTokenEdges(token: string): string {
  return token.replace(/^[`"'([{<]+/, "").replace(/[`"')\]}>.,;:!?]+$/, "");
}

/**
 * #1240: the revision qualifiers a finding message names.
 *
 * A qualifier is a revision identifier appearing as a STANDALONE token:
 * version-like ("v3.7.0", "3.7.0"), SHA-like ("abc1234"), or a token a
 * revision keyword introduces that is itself version-like or SHA-like
 * ("version: v3.6.1"). The scan is O(message) and bounded by
 * MAX_CLAIM_SCAN_LENGTH.
 */
function revisionQualifiers(message: string): RevisionQualifier[] {
  const found: RevisionQualifier[] = [];
  if (message.length > MAX_CLAIM_SCAN_LENGTH) return found;
  const seen = new Set<string>();
  const push = (text: string, kind: RevisionQualifier["kind"]): void => {
    const key = `${kind}:${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ text, kind });
  };
  for (const raw of message.split(/\s+/)) {
    const token = stripTokenEdges(raw);
    if (token === "") continue;
    // Cheap prefilter: every revision identifier carries a digit, so an
    // ordinary prose word never qualifies.
    if (!/\d/.test(token)) continue;
    if (isVersionLike(token)) push(token.toLowerCase(), "version");
    else if (isShaLike(token)) push(token.toLowerCase(), "sha");
  }
  for (const match of message.matchAll(REVISION_KEYWORD_RE)) {
    const token = stripTokenEdges(match[1] ?? "");
    if (token === "") continue;
    if (isVersionLike(token)) push(token.toLowerCase(), "version");
    else if (isShaLike(token)) push(token.toLowerCase(), "sha");
  }
  return found;
}

/**
 * #1240: the revision identifier without an optional leading `v`, lowercased
 * — the comparison form for "is this the executing revision?".
 */
function normalizeRevisionToken(text: string): string {
  const lower = text.trim().toLowerCase();
  return lower.startsWith("v") ? lower.slice(1) : lower;
}

/**
 * #1240: the executing stamp, normalized once.
 *
 * - `full`: the stamp lowercased, leading `v` stripped ("v3.7.0-dev+abc1234"
 *   → "3.7.0-dev+abc1234");
 * - `base`: the numeric components of the version BEFORE any `-`/`+` suffix
 *   ("v3.7.0-dev+abc1234" → "3.7.0");
 * - `sha`: the hex run after `+` in the stamp, if any (dev builds only).
 */
interface ExecutingRevision {
  full: string;
  base: readonly string[];
  sha: string | null;
}

function executingRevision(stamp: string): ExecutingRevision {
  const full = normalizeRevisionToken(stamp);
  const version = full.split(/[-+]/)[0] ?? full;
  const plus = full.indexOf("+");
  const build = plus === -1 ? "" : full.slice(plus + 1);
  return {
    full,
    base: version.split("."),
    sha: SHA_QUALIFIER_RE.test(build) ? build : null,
  };
}

/**
 * #1240: does the qualifier name the EXECUTING revision?
 *
 * The action-side witnesses speak for the executing revision's RELEASE
 * LINE, so a qualifier matches when it names that line:
 *
 * (a) a version-like qualifier with no pre-release/build suffix of its own
 *     whose numeric components are a PREFIX of the executing base
 *     components — "3", "3.7" and "3.7.0" match the base "3.7.0", while
 *     "2" and "3.7.1" do not;
 * (b) any qualifier whose normalized full text EQUALS the executing full
 *     text — "v3.7.0-dev+abc1234" matches that stamp exactly;
 * (c) a SHA-like qualifier that is a prefix of the sha a dogfood build
 *     embeds ("abc1234" against "v3.7.0-dev+abc1234").
 *
 * Every other qualifier names a DIFFERENT revision.
 */
function qualifierMatchesExecutingRevision(qualifier: RevisionQualifier, executing: ExecutingRevision): boolean {
  const text = normalizeRevisionToken(qualifier.text);
  if (text === executing.full) return true;
  if (qualifier.kind === "sha") {
    return executing.sha !== null && executing.sha.startsWith(text);
  }
  const match = VERSION_QUALIFIER_RE.exec(text);
  if (match === null) return false;
  // A qualifier carrying its own pre-release/build suffix names a specific
  // build, not a line: only the exact-stamp rule (b) can match it.
  if (/[-+]/.test(text)) return false;
  const components = match[1]!.split(".");
  return components.every((component, index) => executing.base[index] === component);
}

/**
 * #1240: does the qualifier name the PINNED revision?
 *
 * The pin is an EXACT COMMIT, not a release line: only a SHA-like
 * qualifier can name it, and it matches when the pinned sha EXTENDS the
 * qualifier — the full 40-hex sha, or the short form the consumer quoted
 * (a prefix of the pin). A version-like qualifier names a line, never a
 * commit, so it can never match the pin: a message naming both a
 * different line and the pin is still a claim about the other line, and
 * it stays unverified.
 */
function qualifierMatchesPinnedRevision(qualifier: RevisionQualifier, pinned: string): boolean {
  if (qualifier.kind !== "sha") return false;
  return pinned.startsWith(normalizeRevisionToken(qualifier.text));
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

/** Sentence bounds around a span, mirroring sentenceContaining's delimiters. */
function sentenceBounds(masked: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  while (start > 0 && !SENTENCE_DELIMITERS.has(masked[start - 1] ?? "")) start -= 1;
  let end = to;
  while (end < masked.length && !SENTENCE_DELIMITERS.has(masked[end] ?? "")) end += 1;
  return { start, end };
}

/** The clause window around a token span, bounded by the token's sentence
 * so a direction cue in a later sentence can never leak backwards. The
 * offsets are returned so the RAW text of the same clause can be read
 * (the mask preserves length and indices). */
function clauseWindow(masked: string, sentenceStart: number, sentenceEnd: number, from: number, to: number): { start: number; end: number } {
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
  return { start, end };
}

/**
 * The direction a clause window asserts.
 *
 * The absence/presence cue families behave exactly as they did before
 * #1238. The workflow-mapping vocabulary is ADDED for a workflow-scoped
 * clause only: "the workflow passes `ai-key`" asserts that the workflow
 * supplies that input name (presence), while the negated form ("the
 * workflow does not pass `ai-key`") asserts that it does not (absence). In
 * a clause that does not name the workflow the same verbs are not cues at
 * all — they say nothing about the workflow-to-action mapping.
 *
 * The mapping vocabulary is a cue ONLY when the finding has a workflow
 * witness entry: without one, those sentences are classified exactly as
 * they were before this feature, so the boundary's decision — and the
 * artifact it produces — is byte-for-byte what it was.
 */
function windowDirection(window: string, workflowSubject: boolean, workflowWitnessAvailable: boolean): InputDirection | "none" {
  const mappingActive = workflowSubject && workflowWitnessAvailable;
  const mappingNegated = mappingActive && WORKFLOW_MAPPING_NEGATION_RE.test(window);
  const mappingPresence = mappingActive && WORKFLOW_MAPPING_PRESENCE_RE.test(window);
  if (INPUT_ABSENCE_CUE_RE.test(window) || mappingNegated) {
    if (INPUT_NEGATED_DECLARATION_RE.test(window) || mappingNegated) return "absence";
    return (INPUT_PRESENCE_CUE_RE.test(window) || mappingPresence) ? "ambiguous" : "absence";
  }
  return (INPUT_PRESENCE_CUE_RE.test(window) || mappingPresence) ? "presence" : "none";
}

/**
 * Collect the quoted input-id candidates a message asserts about the
 * EXECUTING action's declared inputs. Each candidate must sit in a sentence
 * carrying the action-subject cue (or a manifest-file citation) and input
 * vocabulary, must not name another action, and its direction resolves
 * within that token's sentence-bounded clause window. Attribute-scoped
 * claims and directionless mentions are not candidates.
 *
 * `workflowWitnessAvailable` gates the workflow-mapping cue vocabulary: it
 * is a cue only for a finding that HAS a workflow witness entry. Without
 * one, the message is classified exactly as it was before #1238.
 */
function classifyInputDeclaration(message: string, workflowWitnessAvailable: boolean): InputCandidate[] {
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
    const clause = clauseWindow(masked, start, end, span.start, span.end);
    const windowText = masked.slice(clause.start, clause.end);
    // Attribute-scope claims (requiredness, defaults, docs, fork behavior)
    // are outside the declared-id witness's authority.
    if (INPUT_ATTRIBUTE_SCOPE_RE.test(windowText)) continue;
    // #1238: the workflow scope is resolved by SUBJECT, from the MASKED
    // clause window — the same window the direction is read from — so a
    // citation can neither forge nor hide it. It is a property of the
    // message and is always computed.
    const workflowSubject = clauseWorkflowSubject(windowText);
    const direction = windowDirection(windowText, workflowSubject, workflowWitnessAvailable);
    if (direction === "none") continue;
    candidates.push({
      token: raw.toLowerCase(),
      direction,
      // The subject of the claim is the clause's action noun: the clause
      // is read RAW because a cited reference (`owner/repo`, "checkout")
      // names the action it talks about. A bare path citation in the
      // sentence is not a subject and must not disarm the witness.
      otherActionSubject: clauseNamesOtherAction(
        message.slice(clause.start, clause.end),
        message.slice(clause.end),
      ),
      workflowSubject,
    });
  }
  return candidates;
}

/**
 * A sentence of a claim message that carries the gate-absence shape: the
 * action subject, a gate behavior word, an absence cue and a
 * metadata/input-list cue, all in ONE sentence.
 */
interface GateSentence {
  /** The sentence as written — the other-action guard must see citations. */
  raw: string;
  /** The same sentence with quoted spans masked — cues, subjects and
   * qualifiers can never be forged by a cited span. */
  masked: string;
}

/**
 * Gate-absence recognition (#1238): the message asserts that a
 * deterministic behavior of the action is absent while deriving that
 * conclusion from the action's metadata/input list (the incident's "no
 * label input" premise). Sentence-scoped: every cue family must co-occur
 * in one sentence, bounded by MAX_CLAIM_SCAN_LENGTH.
 *
 * Each matching sentence is returned twice — masked (so a quoted span can
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
    while (cursor < masked.length && SENTENCE_DELIMITERS.has(masked[cursor] ?? "")) cursor += 1;
    let end = cursor;
    while (end < masked.length && !SENTENCE_DELIMITERS.has(masked[end] ?? "")) end += 1;
    const maskedSentence = masked.slice(cursor, end);
    if (
      ACTION_SUBJECT_CUE_RE.test(maskedSentence)
      && GATE_BEHAVIOR_RE.test(maskedSentence)
      && GATE_ABSENCE_RE.test(maskedSentence)
      && GATE_METADATA_RE.test(maskedSentence)
    ) {
      sentences.push({
        raw: message.slice(cursor, end),
        masked: maskedSentence,
      });
    }
    cursor = end;
  }
  return sentences;
}

interface ClaimClassification {
  kind: GroundingKind | null;
  inputCandidates: InputCandidate[];
  /** #1238: the sentences that assert a gate absence. */
  gateSentences: GateSentence[];
  /** #1240: the revision qualifiers the WHOLE finding message names — the
   * scope of the revision scan (a claim and the revision it talks about
   * can sit in different sentences). */
  qualifiers: RevisionQualifier[];
}

/** Classify once per finding; the input candidates and the gate-absence
 * sentences are reused by the verification branch instead of rescanning the
 * message. The revision-qualifier scan (#1240) runs once per message, over
 * the whole message. */
function classifyClaim(message: string, workflowWitnessAvailable: boolean): ClaimClassification {
  if (assertsCommittedMarker(message)) {
    return { kind: "committed_literal", inputCandidates: [], gateSentences: [], qualifiers: [] };
  }
  const inputCandidates = classifyInputDeclaration(message, workflowWitnessAvailable);
  if (inputCandidates.length > 0) {
    return { kind: "input_declaration", inputCandidates, gateSentences: [], qualifiers: revisionQualifiers(message) };
  }
  const gateSentences = gateAbsenceSentences(message);
  if (gateSentences.length > 0) {
    return { kind: "gate_absence", inputCandidates: [], gateSentences, qualifiers: revisionQualifiers(message) };
  }
  if (REQUIREMENT_NOT_ENFORCED_RE.test(message)) {
    return { kind: "requirement_claim", inputCandidates: [], gateSentences: [], qualifiers: [] };
  }
  return { kind: null, inputCandidates: [], gateSentences: [], qualifiers: [] };
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
 * #1238: decide a gate-absence claim, ONE SENTENCE AT A TIME.
 *
 * The decision is never made across sentences: a manifest-only sentence
 * (a declaration about the action's inputs) is never refuted because
 * another sentence in the same message carries a behavioral absence. Each
 * sentence is judged on its own:
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
 *
 * #1240: the witness speaks for ONE revision only — the executing
 * revision's release line, or the pinned revision (when the caller
 * selected the pinned witness). The revision check is driven by the
 * CALLER: `blockedRevision` is true when the message names a revision
 * neither witness answers for, and then every gate sentence of the
 * message is undecidable — the result is unverified with the
 * other-revision reason. The per-sentence logic below runs against the
 * SELECTED witness as written; only the attested-success reason is
 * prefixed `pinned-` when the pinned witness decided.
 */
async function decideGateAbsence(
  sentences: readonly GateSentence[],
  witness: ActionSourceReader | null | undefined,
  budget: ActionSourceBudget,
  blockedRevision: boolean,
  usePinned: boolean,
): Promise<{ status: GroundingStatus; reason: string }> {
  const unverifiable = { status: "unverified", reason: "gate-absence-unverifiable" } as const;
  // #1240: the message names a revision neither witness answers for — no
  // gate sentence of it is decidable.
  if (blockedRevision) {
    return { status: "unverified", reason: "other-revision-unverifiable" };
  }
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
      return { status: "refuted", reason: `${usePinned ? "pinned-" : ""}gate-implemented:${attested.sort().join(",")}` };
    }
  }
  return unverifiable;
}

/**
 * #1238: a workflow-directory path citation in a finding message
 * (`.github/workflows/…`, `.gitea/workflows/…`, `.forgejo/workflows/…`).
 *
 * The witness is anchored to the finding's OWN cited file, so a message
 * that names a DIFFERENT workflow file is talking about a file this
 * witness says nothing about.
 */
const WORKFLOW_FILE_CITATION_RE = /(?:\.github|\.gitea|\.forgejo)\/workflows\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g;

/**
 * #1238: does the finding's RAW message cite a workflow file OTHER than
 * the finding's own file?
 *
 * The witness speaks only about the file the finding cited. A message that
 * names a different workflow file is making its claim about THAT file, so
 * the witness must not decide it: the finding keeps the behavior it had
 * before the witness existed.
 *
 * The scan reads the RAW message (a citation inside a quoted span is still
 * a citation) and compares each cited path with the canonical form of the
 * finding's own file. A citation of the finding's OWN file is not a
 * mismatch.
 */
function citesAnotherWorkflowFile(message: string, ownTreePath: string): boolean {
  for (const match of message.matchAll(WORKFLOW_FILE_CITATION_RE)) {
    // A trailing "." is sentence punctuation, not part of the path.
    const cited = canonicalTreePath(match[0].replace(/\.+$/, ""));
    if (cited !== ownTreePath) return true;
  }
  return false;
}

/**
 * The workflow witness for ONE finding: the input names the finding's OWN
 * cited file passes to the action under review.
 *
 * The witness is anchored to the file the model itself cited. A file with
 * no entry — never read completely, unparsable, without a DIRECT action
 * step, or a different file — yields NO witness, and the claim keeps the
 * behavior it had before the witness existed. A message that names a
 * DIFFERENT workflow file yields no witness either: the witness says
 * nothing about that other file.
 *
 * The witness speaks ONLY from POSITIVE evidence about the finding's own
 * file: it grounds a workflow-scoped presence claim whose token IS among
 * the names the file's direct action step passes, and it establishes NO
 * absence — so it never refutes a claim.
 */
function workflowWitnessNames(
  finding: ArtifactFinding,
  byFile: ReadonlyMap<string, ReadonlySet<string>> | null | undefined,
): ReadonlySet<string> | null {
  if (byFile === undefined || byFile === null) return null;
  const file = finding.file;
  if (!safeFile(file)) return null;
  const treePath = canonicalTreePath(file);
  if (treePath === "") return null;
  // The witness is per file: a message that cites another workflow file
  // is not about this one, so the witness stays out of it.
  if (citesAnotherWorkflowFile(finding.message, treePath)) return null;
  const names = byFile.get(treePath);
  if (names === undefined) return null;
  return new Set([...names].map((name) => name.toLowerCase()));
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
  // The PINNED revision's implementation reads of this pass: a SEPARATE
  // budget from the executing one — the pinned and the executing bytes
  // must never share a path cache — with the same MAX_ACTION_SOURCE_READS
  // semantics.
  const pinnedBudget: ActionSourceBudget = { reads: 0, cache: new Map<string, ActionSourceReadResult>() };
  // #1240 (pinned-revision witness): the exact commit the CONSUMER pinned,
  // and its own contract/implementation witnesses. Absent (or null) means
  // no pinned witness: every claim naming a different revision stays
  // unverified exactly as before.
  const pinned = options.pinnedActionSource;
  // #1240: the revision THIS run executes. An unstamped build (null,
  // undefined or "") applies NO revision scoping: only the builds that ship
  // to consumers are stamped (.github/workflows/manual-release.yml and
  // release-please.yaml stamp `release`; ai-pr-review.yaml and
  // ai-pr-review-fork.yaml stamp `dev`), so an unstamped build is a
  // local/test-only configuration, not a production path — and the
  // decision path is then exactly what it is today.
  const executing = typeof options.executingActionVersion === "string" && options.executingActionVersion.trim() !== ""
    ? executingRevision(options.executingActionVersion)
    : null;

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
    // #1238: the workflow witness for THIS finding: the input names the
    // finding's own cited file passes to the action under review. No entry
    // for that file means no witness, and the claim keeps the behavior it
    // had before the witness existed.
    const workflowNames = workflowWitnessNames(finding, options.workflowInputsByFile);
    const { kind, inputCandidates, gateSentences, qualifiers } = classifyClaim(finding.message, workflowNames !== null);
    if (kind === null) continue;

    // #1240: the revision qualifiers that fail the EXECUTING match. An
    // unstamped build applies NO scoping: there is no executing revision,
    // so nothing is "other" and the decision path is exactly what it is
    // today. When a pinned witness is available and EVERY "other"
    // qualifier matches the pinned revision, the claim is decided with
    // the PINNED witnesses (usePinned); any other revision named keeps
    // today's unverified outcome (blockedRevision).
    const other: RevisionQualifier[] = executing === null
      ? []
      : qualifiers.filter((qualifier) => !qualifierMatchesExecutingRevision(qualifier, executing));
    const usePinned = other.length > 0 && pinned != null
      && other.every((qualifier) => qualifierMatchesPinnedRevision(qualifier, pinned.revision));
    const blockedRevision = other.length > 0 && !usePinned;

    let status: GroundingStatus;
    let reason: string;
    if (kind === "input_declaration") {
      // #1240: the declared-input registry speaks for the EXECUTING
      // revision's release line only. A message that names a DIFFERENT
      // line or another patch is not decidable with it: the whole finding
      // becomes unverified — never refuted, never grounded — unless every
      // "other" qualifier matches the pinned revision, in which case the
      // claim is decided with the PINNED revision's own contract instead.
      // This check runs before the contradiction/grounding logic and
      // before the other-action downgrade: a revision mismatch wins the
      // reason.
      const declared = usePinned && pinned != null
        ? await pinned.declaredInputs()
        : options.declaredActionInputs;
      if (blockedRevision) {
        status = "unverified";
        reason = "other-revision-unverified";
      } else if (declared === undefined || declared === null) {
        status = "unverified";
        reason = usePinned ? "pinned-input-registry-unavailable" : "input-registry-unavailable";
      } else {
        const normalized = new Set([...declared].map((input) => input.toLowerCase()));
        const resolved = inputCandidates.filter((candidate) => candidate.direction !== "ambiguous");
        // #1238: the registry speaks for what the ACTION DECLARES. A
        // WORKFLOW-scoped claim is about what the WORKFLOW passes or
        // declares, so the registry may neither refute it nor ground it:
        // refuting it would be a false refutation (PR-controlled workflow
        // bytes deciding a claim about the action's own manifest), and
        // grounding it would certify a claim about a mapping the registry
        // does not speak for. Such a claim is unknown evidence here — the
        // workflow witness corroborates it, and only in the presence
        // direction: the witness grounds the claim when the cited file's
        // direct action step passes that name, and never refutes it.
        //
        // A claim that the action does NOT declare an input the registry
        // lacks is a genuine defect claim, and the witness POSITIVELY
        // confirms it: the input really is undeclared. It therefore keeps
        // the finding alive even when a sibling claim in the same finding
        // is contradicted — a finding that carries a true defect must not
        // be demoted whole (#1238: preserve true findings, including
        // genuinely undeclared inputs).
        //
        // The claim must be about the EXECUTING action: a claim that names
        // another action as its subject is never decided with this
        // registry (neither grounded nor refuted), so it cannot ground the
        // finding either.
        const missing = resolved.find((candidate) =>
          candidate.direction === "absence"
          && !normalized.has(candidate.token)
          && !candidate.otherActionSubject
          && !candidate.workflowSubject);
        // Refutation requires POSITIVE contradiction by the witness: an
        // absence claim about an input the registry declares. A presence
        // claim about an input the registry lacks is NOT a contradiction —
        // the claim may describe a manifest revision the running bundle
        // predates (a PR adding the input to this very action) — so it is
        // marked unverified, never refuted (#1238 review: refutation only
        // on facts the witness can decide).
        const contradicted = resolved.find((candidate) =>
          candidate.direction === "absence"
          && normalized.has(candidate.token)
          && !candidate.workflowSubject);
        // A claim about another action's inputs is unknown evidence, never
        // a refutation: the registry witnesses the executing action only.
        // A foreign claim the registry WOULD have decided (grounded or
        // refuted) had it been about this action is undecided for that
        // reason; a foreign claim the registry could not decide anyway
        // keeps the ordinary unknown-evidence reason.
        const foreign = resolved.some((candidate) =>
          candidate.otherActionSubject
          && (candidate.direction === "absence" || normalized.has(candidate.token)));
        // #1238: the WORKFLOW-side witness — the input names the finding's
        // own cited file passes to the action under review at the exact
        // reviewed head. It answers exactly one question: does the
        // workflow-to-action mapping of THAT file carry that name?
        //
        // It NEVER decides a claim that is not workflow-scoped (the claim's
        // subject must BE the workflow), and it NEVER decides an
        // absence-direction claim: the mapping witness says which names
        // the workflow passes, not which names the action lacks.
        //
        // The witness is absent (null) whenever the finding's own file has
        // no entry: then every claim below keeps the behavior it had
        // before the witness existed.
        //
        // A workflow-scoped presence claim the workflow witness
        // CORROBORATES: the cited file's direct action step passes that
        // name. That is a POSITIVE fact about the finding's own file, so
        // it grounds the claim.
        //
        // The witness NEVER refutes. The reader sees only the DIRECT
        // action steps of the cited file, so "this file does not pass X"
        // is NOT an absence it can establish: a local composite action, a
        // reusable workflow or a remote composite can pass an input name
        // to the action through a surface the reader never sees. A claim
        // the witness does not corroborate therefore falls through to the
        // ordinary unknown-evidence path below — never refuted, so the
        // review fails closed on it.
        const workflowGrounded = workflowNames === null ? undefined : resolved.find((candidate) =>
          candidate.workflowSubject
          && candidate.direction === "presence"
          && workflowNames.has(candidate.token)
          && !candidate.otherActionSubject);
        // The three registry-decided outcomes are prefixed `pinned-` when
        // the PINNED witness decided (the claim is a fact about that
        // revision's manifest, not the executing one's); the shared
        // reasons (other-action, workflow-input, the unverified
        // fallthroughs) are unchanged either way.
        if (missing !== undefined) {
          status = "grounded";
          reason = `${usePinned ? "pinned-" : ""}input-absent:${missing.token}`;
        } else if (foreign) {
          // Unknown evidence must never certify a clean review (#1016): a
          // finding that carries a claim about another action cannot be
          // refuted whole.
          status = "unverified";
          reason = "other-action-claim-unverified";
        } else if (contradicted !== undefined) {
          status = "refuted";
          reason = `${usePinned ? "pinned-" : ""}input-declared:${contradicted.token}`;
        } else if (workflowGrounded !== undefined) {
          status = "grounded";
          reason = `workflow-input:${workflowGrounded.token}`;
        } else {
          // A presence claim about an input the registry declares is
          // confirmed, but it asserts no defect of its own: it does not by
          // itself keep a finding blocking that also carries a refuted
          // claim.
          const grounded = resolved.find((candidate) =>
            candidate.direction === "presence"
            && normalized.has(candidate.token)
            && !candidate.otherActionSubject);
          if (grounded !== undefined) {
            status = "grounded";
            reason = `${usePinned ? "pinned-" : ""}input-declared:${grounded.token}`;
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
      //
      // #1240: the witness is the one the selection above chose — the
      // executing action's own tree, or the PINNED revision's tree — and
      // each witness draws on its OWN budget: the pinned and the
      // executing bytes must never share a path cache.
      const decision = await decideGateAbsence(
        gateSentences,
        usePinned && pinned != null ? pinned.read.bind(pinned) : options.readActionSource,
        usePinned ? pinnedBudget : actionSourceBudget,
        blockedRevision,
        usePinned,
      );
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
