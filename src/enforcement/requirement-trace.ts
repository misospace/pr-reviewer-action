/**
 * Requirement-trace enforcement (#874).
 *
 * PR #854 is the motivating failure: the linked issue required matching a
 * source SHA, the review repeated that requirement, and approved anyway —
 * the cited line existed and even carried the right field name
 * (`sourceSha: ctx.sourceSha,`), but only copied the value; nothing ever
 * compared it. Plain `requirement_coverage` (#624) lets a `satisfied` claim
 * stand on a file/diff glance; this module additionally requires, per
 * acceptance/normative ledger requirement, a bounded trace to BOTH the code
 * that enforces it and the test that would fail if that enforcement broke —
 * and that the cited enforcement location actually contains a predicate
 * (a comparison, guard, assertion, or match call) naming the requirement's
 * concept, not merely an assignment or property copy. All of this is
 * deterministically verified against the checkout at head; nothing here is
 * trusted from the model's say-so.
 *
 * Additive to the existing `requirement_coverage` contract (#624): the model
 * emits the same `requirement_coverage` array, and each claim MAY carry
 * `enforcement`/`test` (arrays of `{file, line}`), an optional `symbol`
 * (an identifier name for the enforced concept), a `reason`, and a
 * `disposition` (`met`|`unmet`|`not_applicable`|`unverifiable`) alongside the
 * existing `status`/`evidence` fields `normalizeRequirementCoverage` already
 * reads. This module reads those additive fields independently and never
 * mutates `requirement_coverage` normalization — the two folds are siblings
 * over the same untrusted payload.
 *
 * `met` requires: a location-valid enforcement citation, a location-valid
 * AND test-path-classified test citation, and a predicate involving one of
 * the requirement's derived key terms at (or near) the enforcement
 * location — see `extractRequirementTerms`/`enforcementPredicateFound`
 * below for the exact heuristic and its documented limits. `not_applicable`,
 * `unmet`, and an explicit `unverifiable` each require a non-empty, bounded
 * `reason`; a missing one downgrades to `unverifiable`. Any downgrade or
 * missing trace marks the requirement `unverifiable`, and a well-formed
 * `unmet` is itself a known coverage stop; both fold into
 * `required_checks=incomplete` via `applyRequirementTraceEnforcement`, so a
 * known-unmet requirement can never publish a clean approval under any
 * verdict policy.
 *
 * Scope: ledger entries of kind `acceptance` or `normative` only — the
 * explicit MUST/acceptance-criteria items. `invariant`-kind entries
 * (ordering/sequencing text, and #796 harness obligations, which are always
 * injected as `invariant`) are out of scope here; their own
 * verification-required coverage rule already applies via
 * `requirement-coverage.ts`. Bounded by the ledger's own MAX_REQUIREMENTS
 * cap; never throws on malformed input.
 */
import { readFileSync } from "node:fs";
import type { ArtifactFinding, ReviewArtifact } from "./artifact.js";
import { workspaceRegularFile, workspaceFsPath, workspacePathExists } from "../context/workspace-path.js";
import { detectLanguage, isTestPath } from "../context/change-anchors.js";

export const TRACE_DISPOSITIONS: readonly string[] = ["met", "unmet", "not_applicable", "unverifiable"];

export const MAX_TRACE_LOCATIONS = 5;
export const MAX_GROUPS_PER_RULE = MAX_TRACE_LOCATIONS - 1;
export const MAX_DECLARED_GROUPS_PER_RULE = 16;
export const MAX_GROUP_NAME_CHARS = 60;
export const MAX_RENDERED_ID_CHARS = 64;
export const MIN_DISTRIBUTED_GROUPS = 2;
export const MAX_DISTRIBUTED_HINTS = 20;
export const MAX_REASON_CHARS = 300;
/** Hard cap on the artifact's `errors` diagnostics, so a hostile payload
 * cannot bloat the persisted artifact with unbounded parser noise. */
export const MAX_ARTIFACT_ERRORS = 8;
const TRUNCATION_MARKER = "…";

export interface TraceLocation {
  file: string;
  line: number;
}

export interface RequirementTraceRow {
  requirement_id: string;
  disposition: string;
  /** #985: the deterministic proof shape this requirement was validated
   * against — `runtime_behavior` | `structural_state` | `test_required` |
   * `distributed`, or `not_applicable` for an out-of-scope row. Derived from
   * the ledger requirement text by this module, never from a model field, so
   * it is explainable from the artifact alone. */
  proof: string;
  enforcement: TraceLocation[];
  test: TraceLocation[];
  reason: string;
  /** Deterministic downgrade/degradation notes, mirroring the
   * requirement_coverage `notes` convention. */
  notes: string[];
}

export interface RequirementTraceArtifact {
  version: number;
  rows: RequirementTraceRow[];
  /** True when at least one in-scope requirement has no usable trace
   * (missing claim, a claim downgraded to `unverifiable`) or is a known
   * gap (a well-formed `unmet`) — the signal that folds into
   * `required_checks=incomplete` (review_result=partial). */
  incomplete: boolean;
  /** Bounded, field-naming diagnostics for artifact-level parser/validation
   * problems in the model's `requirement_coverage` claim list — entries that
   * are not objects or lack a string `requirement_id` are skipped here and
   * their requirement falls back to the missing-claim path. Capped at
   * MAX_ARTIFACT_ERRORS with a final truncation note. Diagnostic metadata
   * only; never rendered into the review body. */
  errors: string[];
}

export const ARTIFACT_VERSION = 1;

function capReason(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > MAX_REASON_CHARS) return text.slice(0, MAX_REASON_CHARS - 1) + TRUNCATION_MARKER;
  return text;
}

/** Reads and caches each cited file's lines once, so a file cited by several
 * requirements (or both an enforcement and a test location) is read once. */
class FileTextCache {
  private readonly linesByFile = new Map<string, string[] | null>();
  constructor(private readonly workspace: string) {}

  private load(file: string): string[] | null {
    if (this.linesByFile.has(file)) return this.linesByFile.get(file) ?? null;
    let lines: string[] | null = null;
    if (workspaceRegularFile(this.workspace, file)) {
      try {
        const text = readFileSync(workspaceFsPath(this.workspace, file), "utf8");
        if (text === "") {
          lines = [];
        } else {
          const raw = text.split("\n");
          // A trailing newline does not add a phantom line.
          lines = text.endsWith("\n") ? raw.slice(0, -1) : raw;
        }
      } catch {
        lines = null;
      }
    }
    this.linesByFile.set(file, lines);
    return lines;
  }

  lineCount(file: string): number | null {
    const lines = this.load(file);
    return lines === null ? null : lines.length;
  }

  /** The file's lines, or `null` when it is not a readable regular file in
   * the checkout. 1-indexed callers convert via `lines[line - 1]`. */
  lines(file: string): string[] | null {
    return this.load(file);
  }
}

/** Parse and bound a claimed location list; each entry must be a
 * `{file, line}` pair with a non-empty string file and a positive integer
 * line. Malformed entries are dropped rather than failing the whole claim. */
function parseLocations(raw: unknown): TraceLocation[] {
  if (!Array.isArray(raw)) return [];
  const locations: TraceLocation[] = [];
  for (const item of raw) {
    if (locations.length >= MAX_TRACE_LOCATIONS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const file = record.file;
    const line = record.line;
    if (typeof file !== "string" || file.trim() === "") continue;
    if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) continue;
    locations.push({ file, line });
  }
  return locations;
}

/** True when the location exists at head with the claimed line inside the
 * file's line count. */
function locationValid(loc: TraceLocation, cache: FileTextCache): boolean {
  const count = cache.lineCount(loc.file);
  return count !== null && loc.line <= count;
}

/** True when at least one location in the list exists at head with the
 * claimed line inside the file's line count. */
function anyLocationValid(locations: readonly TraceLocation[], cache: FileTextCache): boolean {
  return locations.some((loc) => locationValid(loc, cache));
}

/** True when at least one location both exists at head AND follows the
 * repository's test/fixture path conventions (`isTestPath`, the same
 * classification the related-code and change-anchors layers use) — a
 * "test" citing a production file is not a regression test. */
function anyTestLocationValid(locations: readonly TraceLocation[], cache: FileTextCache): boolean {
  return locations.some((loc) => isTestPath(loc.file) && locationValid(loc, cache));
}

// ---------------------------------------------------------------------------
// Enforcement-predicate check (#874 maintainer follow-up on PR #883).
//
// A cited enforcement location that merely EXISTS is not proof of
// enforcement: PR #854's real defect was a line that existed and even named
// the right field (`sourceSha: ctx.sourceSha,`) but only copied the value —
// nothing ever compared it. This check derives the requirement's key terms
// from its text (plus an optional model-supplied `symbol`), normalizes them
// to code-ish forms, and requires that at least one cited enforcement
// location's line (or a small surrounding window) contains one of those
// terms used inside something predicate-shaped: a comparison, a guard, a
// throw/assert/expect call, or a string-match call — not just an assignment
// or object-literal property.
//
// This is a bounded heuristic over source text, not a parser: it can miss
// enforcement spread across multiple lines outside the window, expressed via
// a helper function whose name doesn't echo the term, or written in a
// language/style its regexes don't recognize; and on rare occasions a term
// coincidentally near unrelated comparison syntax could pass. It is
// deliberately permissive when the requirement text yields no usable terms
// at all (documented below) rather than fail every odd phrasing closed.
// ---------------------------------------------------------------------------

const PREDICATE_WINDOW_RADIUS = 3;
const MAX_TERMS = 40;
const MIN_TERM_LENGTH = 3;

/** Generic connective/verb words that do not themselves name a concept the
 * enforcing code would reference by name — filtered out of candidate terms.
 * Domain nouns ("source", "target", "branch", "identity", "context", …) are
 * deliberately kept: they are exactly the words that compose real identifier
 * names like `sourceSha`/`targetBranch`. */
const TERM_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "of", "to", "from", "in", "on", "at", "for",
  "with", "by", "must", "shall", "should", "not", "no", "is", "are", "was",
  "were", "be", "been", "being", "this", "that", "these", "those", "it",
  "its", "as", "when", "then", "if", "else", "also", "plus", "so", "such",
  "than", "into", "onto", "via", "per", "without", "within", "any", "all",
  "resolve", "resolved", "resolving", "resolves", "bind", "binds", "binding",
  "match", "matches", "matching", "check", "checks", "checking", "verify",
  "verifies", "verifying", "validate", "validates", "validating", "ensure",
  "ensures", "ensuring", "compare", "compares", "comparing",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Derive candidate code-ish terms from a requirement's text — every
 * surviving unigram and adjacent-word bigram (e.g. "source SHA" from
 * "...match the source SHA and target branch...") in concatenated,
 * snake_case, and camelCase forms — plus the model's own `symbol`, when it
 * supplied one. Bounded and lowercase; `enforcementPredicateFound` matches
 * case-insensitively regardless. */
export function extractRequirementTerms(text: string, symbol?: string): string[] {
  const rawWords = text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  const keptIndex = new Set<number>();
  rawWords.forEach((word, index) => {
    if (word.length < 2) return;
    if (TERM_STOPWORDS.has(word.toLowerCase())) return;
    keptIndex.add(index);
  });

  const phrases: string[][] = [];
  rawWords.forEach((word, index) => {
    if (keptIndex.has(index)) phrases.push([word]);
  });
  for (let index = 0; index < rawWords.length - 1; index += 1) {
    if (keptIndex.has(index) && keptIndex.has(index + 1)) {
      phrases.push([rawWords[index] as string, rawWords[index + 1] as string]);
    }
  }
  if (symbol && symbol.trim() !== "") phrases.push([symbol.trim()]);

  const terms = new Set<string>();
  for (const words of phrases) {
    const lower = words.map((w) => w.toLowerCase());
    terms.add(lower.join(""));
    terms.add(lower.join("_"));
    terms.add(lower[0] + lower.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(""));
  }
  return [...terms].filter((t) => t.length >= MIN_TERM_LENGTH).slice(0, MAX_TERMS);
}

const COMPARISON_RE = /(===|!==|==|!=|<=|>=|<|>)/;
const GUARD_RE = /\b(if|unless)\b/i;
const LOGICAL_OR_TERNARY_RE = /(\?|&&|\|\|)/;
const ASSERTION_CALL_RE = /\b(throw|reject|assert\w*|expect|invariant|must\w*)\b/i;
const MATCH_CALL_RE = /\.(includes|startsWith|endsWith|equals|match|test)\s*\(/i;

/** A line is predicate-shaped when it carries a comparison, a guard/logical
 * operator, an assertion-style call, or a string-match call — the shapes
 * that actually enforce something, as opposed to merely naming a value. */
function linePredicateSignal(line: string): boolean {
  return COMPARISON_RE.test(line)
    || GUARD_RE.test(line)
    || LOGICAL_OR_TERNARY_RE.test(line)
    || ASSERTION_CALL_RE.test(line)
    || MATCH_CALL_RE.test(line);
}

function windowLines(lines: readonly string[], line1Based: number, radius: number): readonly string[] {
  const start = Math.max(0, line1Based - 1 - radius);
  const end = Math.min(lines.length, line1Based + radius);
  return lines.slice(start, end);
}

/** True when a predicate-shaped line occurs near one of the given citations. */
function predicateSignalFound(locations: readonly TraceLocation[], cache: FileTextCache): boolean {
  for (const loc of locations) {
    const lines = cache.lines(loc.file);
    if (lines === null || loc.line > lines.length) continue;
    if (windowLines(lines, loc.line, PREDICATE_WINDOW_RADIUS).some(linePredicateSignal)) return true;
  }
  return false;
}

/**
 * True when at least one of the given (already location-valid) enforcement
 * locations has a term from `terms` and a predicate signal on the SAME
 * line, within `PREDICATE_WINDOW_RADIUS` lines of the cited one — the
 * line-level co-occurrence is what rules out a term merely being named
 * somewhere nearby while the actual comparison lives in unrelated code.
 *
 * When `terms` is empty (the requirement text yielded no usable candidate —
 * e.g. it is all stopwords/short words), the predicate check is skipped and
 * location validity alone stands: a documented limitation, not a silent
 * pass-everything default, since this only fires when term extraction
 * itself found nothing to check.
 */
export function enforcementPredicateFound(
  locations: readonly TraceLocation[],
  terms: readonly string[],
  cache: FileTextCache,
): boolean {
  if (terms.length === 0) return true;
  for (const loc of locations) {
    const lines = cache.lines(loc.file);
    if (lines === null || loc.line > lines.length) continue;
    const window = windowLines(lines, loc.line, PREDICATE_WINDOW_RADIUS);
    for (const line of window) {
      if (!linePredicateSignal(line)) continue;
      for (const term of terms) {
        if (new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(line)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// #985: deterministic proof classification.
//
// #874/#854 require a `met` to carry a real runtime predicate plus a
// regression test. That is right for BEHAVIOURAL requirements, but wrong for
// requirements whose truth is a property of repository STATE: "`.dockerignore`
// must not exclude `assets/`" is provable by reading the checkout, and
// withholding approval because it has no dedicated test is a false gap.
//
// The classification is derived from the ledger requirement text by THIS
// module — never from a model-supplied field. The model supplies citations
// only, so it cannot authorise itself out of the test requirement. The
// classifier is deliberately narrow and fail-closed: anything it cannot parse
// unambiguously falls through to `runtime_behavior`, the strict path.
// ---------------------------------------------------------------------------

export type RequirementProofKind = "runtime_behavior" | "structural_state" | "test_required" | "distributed";

/** Behavioural markers: if the requirement describes what the code DOES (when
 * it fails, what it compares, what it loads), its truth is not a property of
 * file content and must never be classified structural. This veto is what
 * stops a subordinate clause ("must fail when `config.yaml` does not contain
 * `api_key`") from being misread as a state assertion about `config.yaml`. */
const BEHAVIORAL_VETO_RE = /\b(when|whenever|if|unless|upon|during|while|fail|fails|failing|reject|rejects|retry|retries|block|blocks|abort|aborts|throw|throws|load|loads|run|runs|execute|executes|handle|handles|process|processes|validate|validates|enforce|enforces|compare|compares|match|matches|check|checks|verify|verifies|ensure|ensures|assert|asserts|detect|detects|prevent|prevents|allow|allows|permit|permits|emit|emits|invoke|invokes|parse|parses|compute|computes|render|renders|send|sends|fetch|fetches|request|requests|respond|responds|return|returns|exit|exits|crash|crashes|timeout|await|awaits)\b/i;

/** Assertion phrases, matched whole rather than parsed: negation scope in
 * prose is not recoverable with a regex, so the shape is pinned by the phrase
 * itself. A text that matches both sets (or neither) is ambiguous and stays
 * on the strict path. */
const CONTENT_VERBS = "contain|contains|include|includes|list|lists|declare|declares|have|has|exclude|excludes|reference|references|mention|mentions|name|names|specify|specifies|define|defines";
const NEGATIVE_CONTENT_VERBS = "omit|omits|remove|removes|drop|drops|strip|strips|delete|deletes|forbid|forbids|ban|bans";

/** Content assertions, checked against the named file's lines. */
const CONTENT_PRESENT_PHRASES: readonly RegExp[] = [
  new RegExp(`\\b(must|shall|should)\\s+(${CONTENT_VERBS})\\b`, "i"),
  new RegExp(`\\b(must|shall|should)\\s+not\\s+(${NEGATIVE_CONTENT_VERBS})\\b`, "i"),
];
const CONTENT_ABSENT_PHRASES: readonly RegExp[] = [
  new RegExp(`\\b(must|shall|should)\\s+not\\s+(${CONTENT_VERBS})\\b`, "i"),
  new RegExp(`\\b(must|shall|should)\\s+(${NEGATIVE_CONTENT_VERBS})\\b`, "i"),
];
/** Existence assertions, checked against the named path itself. */
const EXISTENCE_PRESENT_RE = /\b(must|shall|should)\s+(exist|be\s+present|be\s+defined)\b/i;
const EXISTENCE_ABSENT_RE = /\b(must|shall|should)\s+(not\s+exist|not\s+be\s+present|be\s+absent|be\s+missing)\b/i;
/** Every verb the structural grammar can assert, bound and unbound. */
const ASSERTION_VERB_ALTERNATION = `${CONTENT_VERBS}|${NEGATIVE_CONTENT_VERBS}|exist|exists|be\\s+present|be\\s+absent|be\\s+missing|be\\s+defined`;
const ASSERTION_VERB_RE = new RegExp(`\\b(${ASSERTION_VERB_ALTERNATION})\\b`, "i");
const BOUND_ASSERTION_VERB_RE = new RegExp(`\\b(must|shall|should)\\s+(not\\s+)?(${ASSERTION_VERB_ALTERNATION})\\b`, "gi");
/** A conjunction inside the assertion region introduces a further clause. */
const CONJUNCTION_RE = /[,;]|\b(and|or|nor|plus|but)\b/i;
/** Every assertion phrase, for locating where the assertion starts. */
const ASSERTION_PHRASES: readonly RegExp[] = [
  ...CONTENT_PRESENT_PHRASES,
  ...CONTENT_ABSENT_PHRASES,
  EXISTENCE_PRESENT_RE,
  EXISTENCE_ABSENT_RE,
];

const QUOTED_TOKEN_RE = /`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g;
const CONFIG_EXT_RE = /\.(json|ya?ml|toml|ini|cfg|conf|lock|txt|md|xml|csv|env|properties|editorconfig)$/i;

/** A checkout-relative path: absolute paths and `..` components are refused,
 * so a structural proof can only ever read repository state — the same rule
 * the #805 checkout guard applies. */
function isRepoRelativePath(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return false;
  return !trimmed.split("/").includes("..");
}

/** Containment-aware existence. `workspacePathExists` alone does not refuse
 * `..` or absolute paths, so an existence claim could otherwise be satisfied
 * from runner filesystem state outside the reviewed checkout. */
function repoPathExists(workspace: string, path: string): boolean {
  return isRepoRelativePath(path) && workspacePathExists(workspace, path);
}

/** A path-shaped token: names a file the checkout can be read for. Bare
 * (unquoted) tokens are accepted for the FILE target only — the asserted
 * literal must be a quoted/backticked token from the requirement text, so the
 * classifier can never invent a literal out of prose and mark a vacuous
 * requirement `met`. */
function looksLikePath(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed === "" || /\s/.test(trimmed) || trimmed.length > 200) return false;
  if (trimmed.includes("/")) return true;
  if (trimmed.startsWith(".")) return true;
  return CONFIG_EXT_RE.test(trimmed);
}

/** The requirement text's backticked/quoted spans (candidate literals and
 * file targets) and its bare word-ish tokens (candidate file targets only). */
function verbatimTokens(text: string): { quoted: string[]; bare: string[] } {
  const quoted: string[] = [];
  for (const match of text.matchAll(QUOTED_TOKEN_RE)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (token !== "") quoted.push(token);
  }
  const bare = (text.match(/[A-Za-z0-9_.@/+-]+/g) ?? [])
    .map((token) => token.replace(/[.,;:]+$/, ""))
    .filter((token) => token !== "");
  return { quoted, bare };
}

export interface StructuralClaim {
  /** The file the requirement names — must equal the cited location's file. */
  file: string;
  /** The asserted content (verbatim from the requirement), or `file` itself
   * for an existence assertion. */
  literal: string;
  /** true: the literal must be present / the path must exist. */
  presence: boolean;
  mode: "content" | "exists";
}

/** Bounds the asserted literal, so a hostile requirement text cannot push an
 * unbounded subject into the pattern-anchored structural check. */
const MAX_STRUCTURAL_LITERAL_CHARS = 200;

/** The index where the requirement's assertion phrase starts, or -1. */
function firstAssertionIndex(text: string): number {
  let first = -1;
  for (const phrase of ASSERTION_PHRASES) {
    const index = text.search(phrase);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  return first;
}

/**
 * The structural grammar represents exactly ONE modal-bound assertion, with no
 * other assertion verb anywhere in the text.
 *
 * "must contain `foo` and omit debug logging" names a second clause the grammar
 * cannot represent; proving `foo` is present must not certify the whole
 * requirement. The same guard rejects "must exist and contain `foo`" (an
 * unbound `contain`) and two modal-bound clauses
 * ("must contain `foo` and must omit `bar`").
 *
 * Quoted spans are ignored, so a backticked literal that happens to name a verb
 * ("must contain the `omit` key") does not trip it.
 *
 * This is a NAMED-VERB net, so it only catches clauses whose verb it knows.
 * `conjunctiveTailIsRepresentable` is the syntactic rule that actually closes
 * the class; this one is a secondary net over the verbs the grammar models.
 */
function hasExactlyOneRepresentableAssertion(text: string): boolean {
  const unquoted = text.replace(QUOTED_TOKEN_RE, " ");
  if ((unquoted.match(BOUND_ASSERTION_VERB_RE) ?? []).length !== 1) return false;
  return !ASSERTION_VERB_RE.test(unquoted.replace(BOUND_ASSERTION_VERB_RE, " "));
}

/**
 * The syntactic counterpart: a conjunction anywhere inside the assertion
 * region introduces a further clause, and the only such clause the grammar
 * models is an explicit test demand — which asserts no additional state.
 *
 * This is deliberately not a verb list. "must contain `foo` and enable debug
 * logging" is caught because `and` starts a clause the grammar cannot
 * represent, whatever verb follows it — the same rule covers `use`, `set`,
 * `keep`, `disable` and anything else. Leading prose before the assertion is
 * exempt (it is not part of the claim), and a bare trailing noun
 * ("must contain the `omit` key") has no conjunction, so it stays valid.
 */
function conjunctiveTailIsRepresentable(text: string): boolean {
  const from = firstAssertionIndex(text);
  const region = from < 0 ? text : text.slice(from);
  const conjunction = region.search(CONJUNCTION_RE);
  if (conjunction < 0) return true;
  return explicitlyRequiresTest(region.slice(conjunction));
}

/**
 * Derive a structural state claim from a requirement, or `null` when the text
 * is not unambiguously one. Everything that fails to parse — behavioural
 * language, no single named config file, no quoted literal, ambiguous
 * polarity, the file appearing only as a locator after the assertion, or any
 * assertion clause the grammar cannot represent — returns `null`, which routes
 * the requirement to the strict runtime path.
 */
export function structuralStateClaim(text: string): StructuralClaim | null {
  if (BEHAVIORAL_VETO_RE.test(text)) return null;
  // The claim must be representable in full — one modal-bound assertion and
  // nothing else asserted.
  if (!hasExactlyOneRepresentableAssertion(text)) return null;

  const contentPresent = CONTENT_PRESENT_PHRASES.some((re) => re.test(text));
  const contentAbsent = CONTENT_ABSENT_PHRASES.some((re) => re.test(text));
  const present = contentPresent || EXISTENCE_PRESENT_RE.test(text);
  const absent = contentAbsent || EXISTENCE_ABSENT_RE.test(text);
  // Both or neither ⇒ the polarity is not recoverable; stay strict.
  if (present === absent) return null;

  // A conjunctive tail is a further clause; unless it is the one modeled
  // adjunct it cannot be represented, so the whole claim stays strict.
  if (!conjunctiveTailIsRepresentable(text)) return null;

  const { quoted, bare } = verbatimTokens(text);
  // `detectLanguage(...) === "non_source"` is the safety gate: a requirement
  // naming executable source (`src/foo.ts`) is behavioural by construction and
  // never structural, and the `unknown` bucket (extensionless scripts,
  // Dockerfile, Makefile) is excluded too — it admits code.
  const candidates = [...new Set([...quoted, ...bare])]
    .filter(looksLikePath)
    // The proof is repository-state proof, so a target that escapes the
    // checkout (`../outside.json`, `/tmp/outside.json`) is never a structural
    // target — otherwise runner filesystem state could satisfy it.
    .filter(isRepoRelativePath)
    // Ignore files are non-source by construction even when the shared
    // extension list does not enumerate them (`.npmignore`, `.eslintignore`).
    .filter((token) => detectLanguage(token) === "non_source" || isIgnoreFile(token));
  // Exactly one named file. Two candidates means one of them would be read as
  // the other's literal ("`a.json` and `b.json` must contain `x`" would check
  // a.json for the string "b.json"), which is how a multi-file requirement
  // turns into a vacuous `met`.
  if (candidates.length !== 1) return null;
  const file = candidates[0] as string;

  // The file must be the SUBJECT of the assertion, not a locator. In
  // "`config.yaml` must contain `x`" the file precedes the assertion; in
  // "error responses must not include `stack_trace` in `sample.json`" it
  // follows it, and the assertion is about runtime behaviour, not that file.
  const fileIndex = text.indexOf(file);
  const assertionIndex = firstAssertionIndex(text);
  if (fileIndex < 0 || assertionIndex < 0 || fileIndex > assertionIndex) return null;

  // The claim must represent the WHOLE assertion. A compound requirement can
  // only be partially re-derived from one literal, so it stays on the strict
  // path rather than certifying a subset of what it asserts.
  const existenceAsserted = EXISTENCE_PRESENT_RE.test(text) || EXISTENCE_ABSENT_RE.test(text);
  const contentVerbPresent = new RegExp(`\\b(${CONTENT_VERBS}|${NEGATIVE_CONTENT_VERBS})\\b`, "i").test(text);
  // "must exist and contain `k`" (no repeated modal) would otherwise collapse
  // to an existence-only proof and drop the containment half.
  if (existenceAsserted && contentVerbPresent) return null;

  // Quoted tokens other than the file are the asserted literals.
  const literals = quoted.filter((token) => token.trim() !== "" && token !== file);

  // Existence mode only when there is no content clause to check as well.
  if (!contentPresent && !contentAbsent) {
    // An existence claim asserts exactly one thing about exactly one path.
    if (literals.length !== 0) return null;
    return { file, literal: file, presence: present, mode: "exists" };
  }

  // A content claim asserts exactly one literal: "must contain `a` and `b`"
  // cannot be certified by proving `a` alone.
  if (literals.length !== 1) return null;
  const literal = literals[0] as string;
  if (literal.length > MAX_STRUCTURAL_LITERAL_CHARS) return null;
  // The literal must not itself be a config file target, or a requirement
  // naming two config files degrades into a file-existence check.
  if (detectLanguage(literal) === "non_source" || isIgnoreFile(literal)) return null;
  return { file, literal, presence: present, mode: "content" };
}

/** Bounds the pattern lines fed to the glob matcher, so a pathological
 * checkout line cannot drive the regex engine into backtracking. Over-long
 * lines are treated as a match instead (see below). */
const MAX_GLOB_PATTERN_CHARS = 500;

/** Ignore-style files — dotfiles whose name ends in `ignore` — whose lines are
 * glob patterns rather than literals. The leading dot is required: an
 * extensionless file that merely ends in `-ignore` is not an ignore file and
 * must not slip past the non-source gate. */
function isIgnoreFile(file: string): boolean {
  const trimmed = file.trim().toLowerCase();
  return /^\.[a-z0-9-]*ignore$/.test(trimmed.slice(trimmed.lastIndexOf("/") + 1));
}

/** A literal occurrence that is not merely part of a longer identifier:
 * `enable_audit_log` must not be satisfied by `enable_audit_logger`. The
 * boundary is only required on the side where the literal itself is
 * identifier-shaped, so a path like `assets/` still matches `foo/assets/bar`. */
function containsLiteralToken(line: string, literal: string): boolean {
  const identifierChar = /[A-Za-z0-9_]/;
  const needsBefore = identifierChar.test(literal.charAt(0));
  const needsAfter = identifierChar.test(literal.charAt(literal.length - 1));
  for (let index = line.indexOf(literal); index >= 0; index = line.indexOf(literal, index + 1)) {
    const before = index === 0 ? "" : (line[index - 1] as string);
    const after = index + literal.length >= line.length ? "" : (line[index + literal.length] as string);
    if ((!needsBefore || !identifierChar.test(before)) && (!needsAfter || !identifierChar.test(after))) return true;
  }
  return false;
}

/**
 * `presence: true` — the literal must genuinely appear, so this is a
 * containment test: a hit is real evidence, and a miss fails closed. Blank,
 * comment and `!`-negation lines assert no content of their own, so they never
 * count, and the match is token-bounded so a key is not satisfied by a longer
 * key that merely begins with it.
 */
function lineMentionsLiteral(line: string, literal: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("!")) return false;
  return containsLiteralToken(line, literal);
}

/**
 * `presence: false` — the literal must genuinely be ABSENT, so this
 * OVER-approximates "mentions": comments and `!`-un-ignore lines cannot
 * exclude anything, a line whose glob metacharacters stripped away names the
 * literal (`dist*` excludes `dist/`), and — in an ignore file, where lines ARE
 * patterns — an unmodellable or over-long pattern counts too.
 * Over-approximating here can only ever cost a fail-closed `unverifiable`,
 * never a wrong `met`.
 */
function lineExcludesLiteral(line: string, literal: string, ignoreFile: boolean): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) return false;
  if (line.includes(literal)) return true;
  const bare = trimmed.replace(/\/+$/, "");
  const target = literal.replace(/\/+$/, "");
  if (bare !== "" && bare === target) return true;
  // `dist*` / `dist**` / `**/dist/` all name the literal once the wildcards go.
  const stripped = trimmed.replace(/[*?]/g, "");
  if (target !== "" && (stripped === target || stripped === `/${target}` || stripped.startsWith(`${target}/`) || stripped.startsWith(`/${target}/`))) {
    return true;
  }
  if (!ignoreFile) return false;
  // A pattern this matcher cannot model could still match — assume it does.
  if (trimmed.includes("[") || trimmed.includes("\\") || trimmed.length > MAX_GLOB_PATTERN_CHARS) return true;
  return target !== "" && (globPatternMatches(trimmed, target) || globPatternMatches(bare, target));
}

/** gitignore-ish glob match: a double star crosses `/`, `*` and `?` do not,
 * a leading double-star slash group is optional, and a leading slash anchors
 * to the root. An approximation used only in the fail-closed direction
 * (`lineExcludesLiteral`). */
function globPatternMatches(pattern: string, target: string): boolean {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;
  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char === "*") {
      if (body[index + 1] === "*") {
        if (body[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
        else { source += ".*"; index += 1; }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  try {
    return new RegExp(`${prefix}${source}(?:/.*)?$`).test(target);
  } catch {
    return false;
  }
}

/**
 * The #985 structural proof: the cited location must be the file the
 * requirement names, and the requirement's assertion must actually hold in the
 * checkout. The model contributes the citation; the truth is re-derived here.
 */
function structuralProofHolds(
  claim: StructuralClaim,
  cache: FileTextCache,
  workspace: string,
): boolean {
  // An existence claim's evidence is the path itself, contained to the
  // checkout.
  if (claim.mode === "exists") return repoPathExists(workspace, claim.file) === claim.presence;
  const lines = cache.lines(claim.file);
  if (lines === null) return false;
  const ignoreFile = isIgnoreFile(claim.file);
  const mentioned = lines.some((line) => claim.presence
    ? lineMentionsLiteral(line, claim.literal)
    : lineExcludesLiteral(line, claim.literal, ignoreFile));
  return claim.presence ? mentioned : !mentioned;
}

/** A structural citation names the FILE — the line is not the evidence, so the
 * citation is accepted as file-level provenance. A non-empty file must still
 * have the cited line in range, so a fabricated line number cannot persist on
 * a `met` row; an empty file, and a satisfied "must be absent" (no file to
 * cite), are the deliberate exceptions. */
function structuralCitationLineInRange(cited: TraceLocation, claim: StructuralClaim, cache: FileTextCache): boolean {
  const count = cache.lineCount(claim.file);
  if (count === null) return true;
  return count === 0 || cited.line <= count;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** The requirement text explicitly demands a test. Detected independently of
 * the structural classification, so a requirement can be BOTH structural and
 * test-demanding — the state check then replaces the predicate requirement and
 * the test evidence is additionally required. Over-eager matching is the safe
 * direction: it can only add a test requirement, never remove one. */
export function explicitlyRequiresTest(text: string): boolean {
  const demand = /\b(must|shall|should|required?|needs?|requires?|mandatory|have to|has to)\b/i.test(text);
  if (!demand) return false;
  if (/\btests?\s+coverage\b/i.test(text)) return true;
  if (/\bcovered\s+by\s+(a|an|the)?\s*(regression|adversarial|unit|integration|end-to-end|e2e)?\s*tests?\b/i.test(text)) return true;
  return /\b(must|shall|should|required?|needs?|requires?|have|has|include|includes|add|adds|provide|provides)\b[^.;]{0,60}\b(regression|adversarial|unit|integration|end-to-end|e2e)?\s*tests?\b(?![\s/]*(job|step|fixture|fixtures|data|runner|harness|matrix|dir|directory|folder))/i.test(text);
}

/** Duck-typed in-scope ledger entry: the persisted artifact shape
 * (`requirement-ledger.json`, snake_case) or the internal camelCase form —
 * only `id`/`text`/`kind` are read, so either serialization works. */
export interface TracedLedgerEntry {
  id: string;
  text: string;
  kind: string;
}

/** Read `ledger.requirements` from an untrusted value (the parsed
 * `requirement-ledger.json`, or `null` when it never ran) without assuming
 * either serialization's field casing beyond `id`/`text`/`kind`.
 * Returns every acceptance/normative entry with its provenance sources. */
function ledgerTraceCandidates(ledger: unknown): { entry: TracedLedgerEntry; sources: string[] | null }[] {
  const raw = (ledger as { requirements?: unknown } | null | undefined)?.requirements;
  if (!Array.isArray(raw)) return [];
  const out: { entry: TracedLedgerEntry; sources: string[] | null }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const { id, text, kind } = record;
    if (typeof id !== "string" || typeof text !== "string" || typeof kind !== "string") continue;
    if (kind !== "acceptance" && kind !== "normative") continue;
    const provenance = record.provenance;
    const sources = Array.isArray(provenance) && provenance.length > 0
      ? provenance.map((p) => (p && typeof p === "object" ? String((p as { source?: unknown }).source ?? "") : "")).filter((s) => s !== "")
      : null;
    out.push({ entry: { id, text, kind }, sources });
  }
  return out;
}

function ledgerEntriesInScope(ledger: unknown): TracedLedgerEntry[] {
  return ledgerTraceCandidates(ledger).map((candidate) => candidate.entry);
}

/** #959: the ledger texts for a set of ids (acceptance/normative only, the
 * same set `requirementTraceScope` scopes), so the repair pass can ask the
 * model for exactly the missing entries. */
export function ledgerRequirementsById(ledger: unknown, ids: readonly string[]): TracedLedgerEntry[] {
  const wanted = new Set(ids);
  return ledgerEntriesInScope(ledger).filter((entry) => wanted.has(entry.id));
}

/** #935: the text a change touches: changed file paths plus the added and
 * removed diff lines, lowercased, for the subject test below. */
export function changedSubjectText(diff: string, files: readonly string[]): string {
  const lines = diff.split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => line.slice(1));
  return [...files, ...lines].join("\n").toLowerCase();
}

/** A single kept word longer than this cannot be a meaningful requirement
 * concept; it is dropped so untrusted requirement text cannot build a
 * `new RegExp` pattern large enough to throw (the module promises never to
 * throw on malformed input). */
const MAX_SUBJECT_TERM_CHARS = 200;

/** #957: the two ways a requirement's text can establish subject overlap
 * with a change. A *phrase* is an adjacent run of kept words — a multi-token
 * concept like "source SHA" or "trust boundary". A *strong term* is a single
 * kept word shaped like a distinctive identifier: it carries a digit
 * (`sha256`, `utf8`) or an internal capital beyond the first letter
 * (`sourceSha`, `repoDid`, `SQLite`). Plain single words — `docs`, `repo`,
 * `request`, `only`, `never`, … — and bare acronyms (`PR`, `API`, `URLs`),
 * which occur as ordinary prose in almost every diff, name nothing specific
 * enough to establish scope on their own. That generic overlap is what let
 * #956's unrelated standards leak in. */
interface RequirementSubjectSignals {
  phrases: string[][];
  strongTerms: string[];
}

/** A single word is a strong term when it is identifier-shaped. */
function isStrongTerm(word: string): boolean {
  // A digit-bearing term is identifier-ish, but a one-letter-plus-digit
  // fragment (`v3`, `p0`) is a version/flag token that occurs in ordinary
  // paths (`tests-v3/`); those scope in only via a phrase.
  if (/[0-9]/.test(word)) return word.length >= 3;
  if (!/[A-Z]/.test(word.slice(1))) return false; // plain lowercase, or Capitalized
  if (word === word.toUpperCase()) return false; // pure acronym: HTTP, API, PR, URL
  if (/^[A-Z]{2,}s$/.test(word)) return false; // acronym + plural: URLs, APIs, JSONs
  return true; // identifier: sourceSha, repoDid, SQLite, HTTPServer, GitHub
}

/** Split a requirement's text into its subject-overlap signals. Adjacency is
 * over the raw word stream, so a stopword between two kept words (as in
 * "compare the source SHA") breaks the phrase rather than gluing its halves
 * together. */
export function requirementSubjectSignals(text: string): RequirementSubjectSignals {
  const rawWords = text.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  const kept: { word: string; index: number }[] = [];
  rawWords.forEach((word, index) => {
    if (word.length < 2) return;
    if (word.length > MAX_SUBJECT_TERM_CHARS) return;
    if (TERM_STOPWORDS.has(word.toLowerCase())) return;
    kept.push({ word, index });
  });
  const phrases: string[][] = [];
  for (let i = 0; i < kept.length - 1; i += 1) {
    if (kept[i + 1]!.index === kept[i]!.index + 1) phrases.push([kept[i]!.word, kept[i + 1]!.word]);
  }
  const strongTerms = kept.filter((entry) => isStrongTerm(entry.word)).map((entry) => entry.word.toLowerCase());
  return { phrases, strongTerms };
}

/** True when the changed text contains a multi-token phrase. The joined
 * spelling (`commitsha`) is a bare substring so it still catches camelCase
 * concatenations like `validateCsrfToken` — with the deliberate trade-off
 * that the same joined form can match inside a longer identifier; the
 * delimited spellings (`commit sha`, `commit_sha`, `commit-sha`,
 * `commit/sha`) are word-boundary anchored, so they cannot match inside a
 * longer word (the pre-#957 rule let `data never` match `metadata never`). */
function phraseMatched(words: readonly string[], changed: string): boolean {
  const lower = words.map((word) => word.toLowerCase());
  if (changed.includes(lower.join(""))) return true;
  return [lower.join(" "), lower.join("_"), lower.join("-"), lower.join("/")].some((variant) => new RegExp(`\\b${escapeRegExp(variant)}\\b`).test(changed));
}

function termWordMatch(term: string, changed: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(changed);
}

/** #958: explicit boundary ownership, supplied by repository config (never
 * hardcoded here). `match` terms identify the requirement — every token must
 * appear (case-insensitively, as a whole word) in its text; `owners` are
 * narrow path globs whose changed files own that requirement. A requirement
 * whose subject prose the diff never repeats stays in scope when a changed
 * file is one of its declared owners. */
export interface RequirementGroup {
  name: string;
  owners: readonly string[];
  tests: readonly string[];
}

export interface RequirementOwnership {
  match: readonly string[];
  owners: readonly string[];
  groups?: readonly RequirementGroup[];
}

/** Compile a requirement's `match` tokens and owner globs once, so a large
 * changed-file list does not recompile a regex per path. */
interface CompiledOwnership {
  match: RegExp[];
  owners: RegExp[];
}

/** Compile one narrow owner glob to a full-path regex. Only `*` (within a
 * path segment) and `?` are wildcards; `**` and absolute/`..` patterns are
 * rejected at config-parse time, so this never sees them. */
function ownerPatternRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.split("?").map((chunk) => escapeRegExp(chunk)).join("[^/]"))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

interface DistributedGroupSet {
  groups: RequirementGroup[];
  overflow: boolean;
  excess: string[];
}

function ruleMatchesRequirement(rule: RequirementOwnership, text: string): boolean {
  if (!Array.isArray(rule.match) || rule.match.length === 0) return false;
  const haystack = text.toLowerCase();
  return rule.match.every((token) => {
    if (typeof token !== "string" || token === "") return false;
    try {
      return new RegExp(`\\b${escapeRegExp(token.toLowerCase())}\\b`).test(haystack);
    } catch {
      return false;
    }
  });
}

function distributedGroupsForText(
  text: string,
  ownership: readonly RequirementOwnership[] | undefined,
): DistributedGroupSet {
  const byName = new Map<string, RequirementGroup>();
  for (const rule of ownership ?? []) {
    if (!rule || !ruleMatchesRequirement(rule, text) || !Array.isArray(rule.groups) || rule.groups.length < MIN_DISTRIBUTED_GROUPS) continue;
    for (const group of rule.groups) {
      if (!group || typeof group.name !== "string" || !Array.isArray(group.owners) || !Array.isArray(group.tests)) continue;
      const current = byName.get(group.name);
      byName.set(group.name, current ? {
        name: group.name,
        owners: [...new Set([...current.owners, ...(group.owners as readonly unknown[]).filter((value): value is string => typeof value === "string" && value !== "")])],
        tests: [...new Set([...current.tests, ...(group.tests as readonly unknown[]).filter((value): value is string => typeof value === "string" && value !== "")])],
      } : {
        name: group.name,
        owners: [...new Set((group.owners as readonly unknown[]).filter((value): value is string => typeof value === "string" && value !== ""))],
        tests: [...new Set((group.tests as readonly unknown[]).filter((value): value is string => typeof value === "string" && value !== ""))],
      });
    }
  }
  const sorted = [...byName.values()]
    .filter((group) => group.owners.length > 0)
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    groups: sorted.slice(0, MAX_DECLARED_GROUPS_PER_RULE),
    overflow: sorted.length > MAX_GROUPS_PER_RULE,
    excess: sorted.slice(MAX_GROUPS_PER_RULE).map((group) => group.name),
  };
}

/** Resolve trusted distributed topology for the requested ledger ids. */
export function distributedRequirementHints(
  ledger: unknown,
  ownership: readonly RequirementOwnership[] | undefined,
  scopeIds: readonly string[],
): { requirementId: string; groups: readonly string[] }[] {
  const entries = new Map(ledgerEntriesInScope(ledger).map((entry) => [entry.id, entry]));
  const hints: { requirementId: string; groups: readonly string[] }[] = [];
  const seenScopeIds = new Set<string>();
  for (const requirementId of scopeIds) {
    if (seenScopeIds.has(requirementId)) continue;
    seenScopeIds.add(requirementId);
    const entry = entries.get(requirementId);
    if (!entry) continue;
    const { groups, overflow } = distributedGroupsForText(entry.text, ownership);
    if (overflow || groups.length < MIN_DISTRIBUTED_GROUPS) continue;
    hints.push({ requirementId, groups: groups.map((group) => group.name) });
    if (hints.length >= MAX_DISTRIBUTED_HINTS) break;
  }
  return hints;
}

/** Warning diagnostics for effective distributed topology that exceeds the representable cap. */
export function distributedRequirementWarnings(
  ledger: unknown,
  ownership: readonly RequirementOwnership[] | undefined,
  scopeIds: readonly string[],
): string[] {
  const entries = new Map(ledgerEntriesInScope(ledger).map((entry) => [entry.id, entry]));
  const warnings: string[] = [];
  const seenScopeIds = new Set<string>();
  for (const requirementId of scopeIds) {
    if (seenScopeIds.has(requirementId)) continue;
    seenScopeIds.add(requirementId);
    const entry = entries.get(requirementId);
    if (!entry) continue;
    const { overflow, excess } = distributedGroupsForText(entry.text, ownership);
    if (overflow) {
      warnings.push(`requirement '${requirementId}' exceeds ${MAX_GROUPS_PER_RULE} distributed groups; excess: ${excess.join(", ")}.`);
    }
  }
  return warnings;
}

function citationMatchesPatterns(loc: TraceLocation, patterns: readonly string[]): boolean {
  const file = loc.file.toLowerCase();
  return patterns.some((pattern) => {
    try {
      return ownerPatternRegex(pattern).test(file);
    } catch {
      return false;
    }
  });
}

/** Maximum matching, with each concrete file:line citation usable once. */
function matchCitationsToGroups(
  groups: readonly RequirementGroup[],
  citations: readonly TraceLocation[],
  patternsFor: (group: RequirementGroup) => readonly string[],
): Map<string, TraceLocation> {
  const unique = [...new Map(citations.map((location) => [`${location.file}\0${location.line}`, location])).values()];
  const citationToGroup = new Map<number, number>();
  const assign = (groupIndex: number, visited: Set<number>): boolean => {
    const group = groups[groupIndex]!;
    for (let citationIndex = 0; citationIndex < unique.length; citationIndex += 1) {
      if (visited.has(citationIndex) || !citationMatchesPatterns(unique[citationIndex]!, patternsFor(group))) continue;
      visited.add(citationIndex);
      const prior = citationToGroup.get(citationIndex);
      if (prior === undefined || assign(prior, visited)) {
        citationToGroup.set(citationIndex, groupIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < groups.length; index += 1) assign(index, new Set());
  const groupToCitation = new Map<string, TraceLocation>();
  for (const [citationIndex, groupIndex] of citationToGroup) {
    groupToCitation.set(groups[groupIndex]!.name, unique[citationIndex]!);
  }
  return groupToCitation;
}

function compileOwnership(ownership: readonly RequirementOwnership[]): CompiledOwnership[] {
  const compiled: CompiledOwnership[] = [];
  for (const rule of ownership) {
    if (!Array.isArray(rule.match) || !Array.isArray(rule.owners)) continue;
    const match = rule.match
      .filter((token) => typeof token === "string" && token !== "")
      .map((token) => new RegExp(`\\b${escapeRegExp(token.toLowerCase())}\\b`));
    const owners = rule.owners.filter((pattern) => typeof pattern === "string" && pattern !== "").map(ownerPatternRegex);
    if (match.length === 0 || owners.length === 0) continue;
    compiled.push({ match, owners });
  }
  return compiled;
}

/** True when a changed file path is a declared owner of the requirement: every
 * `match` token appears as a whole word in the requirement text, and at least
 * one of the rule's owner globs matches a changed path. */
function ownershipTouched(compiled: readonly CompiledOwnership[], text: string, paths: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  for (const rule of compiled) {
    if (rule.match.length === 0 || !rule.match.every((pattern) => pattern.test(haystack))) continue;
    if (rule.owners.some((pattern) => paths.some((path) => pattern.test(path)))) return true;
  }
  return false;
}

/** A requirement's subject is touched when the changed text contains one of
 * its multi-word phrases (in any spelling) or one of its distinctive
 * identifier-shaped terms. Two plain words like `docs` and `repo` are
 * deliberately NOT enough — see `requirementSubjectSignals`. Bounded
 * heuristic, like `enforcementPredicateFound`. */
function subjectTouched(text: string, changed: string): boolean {
  const { phrases, strongTerms } = requirementSubjectSignals(text);
  if (phrases.some((words) => phraseMatched(words, changed))) return true;
  return strongTerms.some((term) => termWordMatch(term, changed));
}

export interface RequirementTraceScope {
  inScope: TracedLedgerEntry[];
  outOfScope: { entry: TracedLedgerEntry; reason: string }[];
}

/** #935/#958: which requirements the trace demands. A linked-issue
 * requirement (what the PR was asked to deliver, #874), an entry without
 * provenance, any requirement whose subject the change touches, and any
 * requirement whose declared owner path the change modifies are in scope; a
 * standards / PR-body / harness requirement the change never touches is out
 * of scope and is dispositioned `not_applicable` with a reason. Without
 * changed text every entry stays in scope (fail closed). #957 tightened the
 * subject test: only a multi-word phrase or an identifier-shaped single term
 * counts, so unrelated standards can no longer ride in on generic vocabulary
 * shared with every diff. #958 adds explicit `ownership` (from repository
 * config) so a change to a boundary's own file scopes its requirement in
 * even when the diff repeats none of its prose. */
export function requirementTraceScope(
  ledger: unknown,
  changed?: string,
  context: { ownership?: readonly RequirementOwnership[] | undefined; paths?: readonly string[] | undefined } = {},
): RequirementTraceScope {
  const ownership = context.ownership ?? [];
  const paths = context.paths ?? [];
  const compiledOwnership = ownership.length > 0 && paths.length > 0 ? compileOwnership(ownership) : [];
  const scope: RequirementTraceScope = { inScope: [], outOfScope: [] };
  for (const { entry, sources } of ledgerTraceCandidates(ledger)) {
    const owned = compiledOwnership.length > 0 && ownershipTouched(compiledOwnership, entry.text, paths);
    if (changed === undefined || sources === null || sources.includes("linked_issues") || subjectTouched(entry.text, changed) || owned) {
      scope.inScope.push(entry);
    } else {
      scope.outOfScope.push({
        entry,
        reason: `out of scope: from ${[...new Set(sources)].join("/")}, and neither its subject terms nor any declared owner path appear in the changed files or lines`,
      });
    }
  }
  return scope;
}

interface RawClaim {
  requirement_id?: unknown;
  disposition?: unknown;
  enforcement?: unknown;
  test?: unknown;
  reason?: unknown;
  /** Optional model-supplied identifier name for the enforced concept (e.g.
   * "sourceSha") — folded into the requirement's term set for the
   * enforcement-predicate check below. */
  symbol?: unknown;
}

/** Records an artifact-level parser/validation diagnostic. The final slot of
 * `errors` is reserved for the truncation note, so the array is bounded at
 * MAX_ARTIFACT_ERRORS even when a hostile payload is entirely malformed;
 * returns false once the cap is reached. */
function recordArtifactError(errors: string[], message: string): boolean {
  if (errors.length >= MAX_ARTIFACT_ERRORS - 1) return false;
  errors.push(message);
  return true;
}

/**
 * Validate the model's per-requirement trace claims (read from the same
 * untrusted `requirement_coverage` payload `normalizeRequirementCoverage`
 * consumes) against the ledger's in-scope requirements and the checkout at
 * head. Never throws; every degradation is recorded in `notes`/`errors`.
 */
export function validateRequirementTrace(
  coveragePayload: unknown,
  ledger: unknown,
  workspace: string,
  changed?: string,
  context: { ownership?: readonly RequirementOwnership[] | undefined; paths?: readonly string[] | undefined } = {},
): RequirementTraceArtifact {
  const { inScope, outOfScope } = requirementTraceScope(ledger, changed, context);
  if (inScope.length === 0 && outOfScope.length === 0) {
    return { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] };
  }

  const cache = new FileTextCache(workspace);
  const claimsById = new Map<string, RawClaim>();
  const errors: string[] = [];
  let errorsTruncated = false;
  if (Array.isArray(coveragePayload)) {
    for (const [index, claim] of coveragePayload.entries()) {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
        if (!recordArtifactError(errors, `requirement_trace[${index}]: entry is not an object; skipped`)) {
          errorsTruncated = true;
        }
        continue;
      }
      const record = claim as RawClaim;
      const rid = record.requirement_id;
      if (typeof rid !== "string") {
        if (!recordArtifactError(errors, `requirement_trace[${index}]: missing or non-string requirement_id; skipped`)) {
          errorsTruncated = true;
        }
        continue;
      }
      if (!claimsById.has(rid)) claimsById.set(rid, record);
    }
    if (errorsTruncated) {
      errors.push(`requirement_trace: additional malformed entries omitted (diagnostics capped at ${MAX_ARTIFACT_ERRORS})`);
    }
  }

  const rows: RequirementTraceRow[] = [];
  let incomplete = false;

  for (const entry of inScope) {
    const claim = claimsById.get(entry.id);
    const notes: string[] = [];
    const distributedSet = distributedGroupsForText(entry.text, context.ownership);
    const distributedGroups = distributedSet.groups;
    const isDistributed = distributedGroups.length >= MIN_DISTRIBUTED_GROUPS;
    // #985: the deterministic proof shape for this requirement, derived from
    // its text (never from a model field) — recorded on the row so the
    // decision is explainable from the artifact alone.
    const structural = structuralStateClaim(entry.text);
    const requiresTest = explicitlyRequiresTest(entry.text);
    const proof: RequirementProofKind = isDistributed
      ? "distributed"
      : structural !== null
        ? "structural_state"
        : requiresTest
          ? "test_required"
          : "runtime_behavior";
    let disposition: string;
    let enforcement: TraceLocation[];
    let test: TraceLocation[];
    let reason: string;

    if (claim === undefined) {
      disposition = "unverifiable";
      enforcement = [];
      test = [];
      reason = "";
      notes.push("not-traced-by-reviewer");
    } else {
      const rawDisposition = typeof claim.disposition === "string" ? claim.disposition.toLowerCase() : null;
      disposition = rawDisposition !== null && TRACE_DISPOSITIONS.includes(rawDisposition) ? rawDisposition : "unverifiable";
      if (rawDisposition === null || !TRACE_DISPOSITIONS.includes(rawDisposition)) notes.push("disposition-invalid");
      enforcement = parseLocations(claim.enforcement);
      test = parseLocations(claim.test);
      reason = capReason(claim.reason);
      const symbol = typeof claim.symbol === "string" ? claim.symbol : undefined;

      if (disposition === "not_applicable" || disposition === "unmet" || disposition === "unverifiable") {
        // Every disposition other than `met` is a claim the reviewer cannot
        // back with a location, so it must be backed with a reason instead —
        // a bare "not_applicable"/"unmet"/"unverifiable" with nothing to
        // read is as unusable as no trace at all.
        if (reason === "") {
          disposition = "unverifiable";
          notes.push("missing-reason");
        }
      } else if (disposition === "met") {
        if (isDistributed && !distributedSet.overflow) {
          const validEnforcementLocations = enforcement.filter((loc) => locationValid(loc, cache));
          const enforcementMatches = matchCitationsToGroups(distributedGroups, validEnforcementLocations, (group) => group.owners);
          const uncoveredEnforcement = distributedGroups.filter((group) => !enforcementMatches.has(group.name));
          for (const group of uncoveredEnforcement) {
            notes.push(`distributed-enforcement-group-uncovered:${group.name}`);
          }

          const validTests = test.filter((loc) => isTestPath(loc.file) && locationValid(loc, cache));
          const testMatches = matchCitationsToGroups(distributedGroups, validTests, (group) => group.tests);
          for (const group of distributedGroups) {
            if (!testMatches.has(group.name)) notes.push(`distributed-test-group-uncovered:${group.name}`);
          }
          if (validTests.length === 0) notes.push("distributed-test-location-uncovered");
          if (uncoveredEnforcement.length > 0 || distributedGroups.some((group) => !testMatches.has(group.name)) || validTests.length === 0) {
            disposition = "unverifiable";
          } else {
            const terms = extractRequirementTerms(entry.text);
            const matchedLocations = [...enforcementMatches.values()];
            const predicateFound = terms.length === 0
              ? predicateSignalFound(matchedLocations, cache)
              : enforcementPredicateFound(matchedLocations, terms, cache);
            if (!predicateFound) {
              disposition = "unverifiable";
              notes.push("enforcement-location-copies-without-comparing");
            }
          }
        } else if (!isDistributed) {
          if (structural !== null) {
            // #985: a state requirement's truth is a property of the checkout,
            // so the proof is the cited state itself — re-derived here, not
            // asserted by the model — and a dedicated regression test is not
            // required. A requirement that ALSO demands test coverage gets it.
            const cited = enforcement.find((loc) => normalizeRepoPath(loc.file) === normalizeRepoPath(structural.file));
            if (cited === undefined) {
              disposition = "unverifiable";
              notes.push("downgraded-no-valid-enforcement-location");
            } else if (!structuralCitationLineInRange(cited, structural, cache)) {
              disposition = "unverifiable";
              notes.push("structural-citation-line-out-of-range");
            } else if (!structuralProofHolds(structural, cache, workspace)) {
              disposition = "unverifiable";
              notes.push("structural-proof-unconfirmed");
            }
            if (requiresTest && !anyTestLocationValid(test, cache)) {
              disposition = "unverifiable";
              notes.push("downgraded-no-valid-test-location");
            }
          } else {
            // runtime_behavior / test_required: full narrow trace required — a
            // valid enforcement location AND a valid test location, then a
            // predicate near a requirement term (#854).
            if (!anyLocationValid(enforcement, cache)) {
              disposition = "unverifiable";
              notes.push("downgraded-no-valid-enforcement-location");
            }
            if (!anyTestLocationValid(test, cache)) {
              disposition = "unverifiable";
              notes.push("downgraded-no-valid-test-location");
            }
            if (disposition === "met") {
              const terms = extractRequirementTerms(entry.text, symbol);
              const validEnforcementLocations = enforcement.filter((loc) => locationValid(loc, cache));
              if (!enforcementPredicateFound(validEnforcementLocations, terms, cache)) {
                disposition = "unverifiable";
                notes.push("enforcement-location-copies-without-comparing");
              }
            }
          }
        }
      }
    }

    if (distributedSet.overflow && isDistributed) {
      disposition = "unverifiable";
      notes.push("distributed-topology-overflow");
    }

    // #874 maintainer follow-up: a well-formed `unmet` is a KNOWN gap, not
    // an untraceable one — it must stop coverage too (`required_checks=
    // incomplete`), so #878's publication guard withholds approval under
    // every verdict policy. The synthesized major finding alone reaches the
    // non-strict verdict mapping too late to matter (strict maps after this
    // pass; findings_severity_gated/model map before it).
    if (disposition === "unverifiable" || disposition === "unmet") incomplete = true;

    rows.push({ requirement_id: entry.id, disposition, proof, enforcement, test, reason, notes });
  }

  // #935: an out-of-scope requirement is grounded not_applicable and never
  // makes coverage incomplete, unless the reviewer itself reports it unmet.
  for (const { entry, reason } of outOfScope) {
    const claim = claimsById.get(entry.id);
    const claimedUnmet = typeof claim?.disposition === "string" && claim.disposition.toLowerCase() === "unmet" && capReason(claim.reason) !== "";
    if (claimedUnmet) {
      incomplete = true;
      rows.push({ requirement_id: entry.id, disposition: "unmet", proof: "not_applicable", enforcement: parseLocations(claim!.enforcement), test: parseLocations(claim!.test), reason: capReason(claim!.reason), notes: ["out-of-scope-reported-unmet"] });
    } else {
      rows.push({ requirement_id: entry.id, disposition: "not_applicable", proof: "not_applicable", enforcement: [], test: [], reason, notes: ["out-of-scope"] });
    }
  }

  return { version: ARTIFACT_VERSION, rows, incomplete, errors };
}

/** #959: the in-scope ids the coverage payload carried NO claim for — the
 * `claim === undefined` path in `validateRequirementTrace`, distinct from a
 * claim whose locations are unusable. Mirrors the validator's own id
 * extraction (first claim per id wins; malformed entries are skipped) so the
 * two never disagree about what counts as "present". */
export function missingTraceRequirementIds(coveragePayload: unknown, inScopeIds: readonly string[]): string[] {
  const present = new Set<string>();
  if (Array.isArray(coveragePayload)) {
    for (const claim of coveragePayload) {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
      const rid = (claim as { requirement_id?: unknown }).requirement_id;
      if (typeof rid === "string") present.add(rid);
    }
  }
  return inScopeIds.filter((id) => !present.has(id));
}

/** #959: append repaired claims after the verdict's own coverage payload,
 * keeping only ids that had NO claim (never overwriting an existing claim, so
 * a claim with bad locations stays fail-closed). Returns the merged array.
 * Defensive on a non-array `repaired` (the "never throws" contract holds even
 * if a future caller bypasses the types). */
export function mergeTraceClaims(coveragePayload: unknown, repaired: readonly unknown[] | undefined): unknown[] {
  const merged: unknown[] = Array.isArray(coveragePayload) ? [...coveragePayload] : [];
  const present = new Set<string>();
  for (const claim of merged) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
    const rid = (claim as { requirement_id?: unknown }).requirement_id;
    if (typeof rid === "string") present.add(rid);
  }
  for (const claim of Array.isArray(repaired) ? repaired : []) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
    const rid = (claim as { requirement_id?: unknown }).requirement_id;
    if (typeof rid !== "string" || present.has(rid)) continue;
    present.add(rid);
    merged.push(claim);
  }
  return merged;
}

/**
 * Deterministic finding text for an unmet (violated) requirement with no
 * finding already covering it — mirrors the violated-obligation and
 * unresolved-thread re-emission rules elsewhere in enforcement/.
 */
export function requirementNotEnforcedMessage(requirementText: string): string {
  return `requirement not enforced: ${requirementText}`;
}

/**
 * Ensure every `unmet` in-scope requirement has a corresponding finding.
 * Mutates `artifact.findings` in place (creating the array if absent) and
 * returns the count of findings synthesized. A finding already present for
 * the requirement (matched by message substring, the same "did the model
 * already surface this" heuristic other enforcement passes use) is left
 * alone — this only fills a gap, never duplicates.
 */
export function ensureUnmetRequirementFindings(
  artifact: ReviewArtifact,
  trace: RequirementTraceArtifact,
  ledger: unknown,
): number {
  const unmet = trace.rows.filter((row) => row.disposition === "unmet");
  if (unmet.length === 0) return 0;

  const textById = new Map<string, string>();
  for (const entry of ledgerEntriesInScope(ledger)) textById.set(entry.id, entry.text);

  const findings: ArtifactFinding[] = Array.isArray(artifact.findings) ? artifact.findings : [];
  let added = 0;
  for (const row of unmet) {
    const text = textById.get(row.requirement_id);
    if (text === undefined) continue;
    const message = requirementNotEnforcedMessage(text);
    const alreadyCovered = findings.some((f) => f.message.includes(text) || f.message === message);
    if (alreadyCovered) continue;
    const location = row.enforcement[0] ?? row.test[0] ?? null;
    findings.push({
      severity: "major",
      category: "other",
      file: location ? location.file : null,
      line: location ? location.line : null,
      message,
    });
    added += 1;
  }
  if (added > 0) artifact.findings = findings;
  return added;
}

const MAX_RENDERED_ROWS = 20;
/** Collapse the rendered section behind `<details>` once the ledger has
 * more than this many in-scope requirements — the issue's "do not dump an
 * enormous matrix into the public review" ask. */
const COLLAPSE_THRESHOLD = 5;

/**
 * Render the published-body "Requirement trace" section: only the
 * not-fully-verified rows (`unmet`/`unverifiable`) — a fully `met`/
 * `not_applicable` ledger has nothing to add to the review the coverage
 * fold and the verdict itself don't already say. Returns `""` when there is
 * nothing to render (the common case), so callers can append unconditionally.
 *
 * #959: a row whose claim was missing entirely (the `not-traced-by-reviewer`
 * note) says so, rather than borrowing the "no valid enforcement location"
 * wording that belongs to a claim whose cited location is genuinely unusable —
 * the two are different failures and an author must be able to tell them
 * apart.
 */
export function renderRequirementTraceMarkdown(trace: RequirementTraceArtifact): string {
  const notable = trace.rows.filter((row) => row.disposition === "unmet" || row.disposition === "unverifiable");
  if (notable.length === 0) return "";
  const cleanSeam = (name: string): string => name.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, MAX_GROUP_NAME_CHARS);
  const cleanRequirementId = (id: string): string => id.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, MAX_RENDERED_ID_CHARS);
  const seamNames = (row: RequirementTraceRow, prefix: string): string[] => [...new Set(
    row.notes.filter((note) => note.startsWith(prefix)).map((note) => cleanSeam(note.slice(prefix.length))).filter(Boolean),
  )].slice(0, MAX_GROUPS_PER_RULE);
  const lines = notable.slice(0, MAX_RENDERED_ROWS).map((row) => {
    const enforcementMisses = seamNames(row, "distributed-enforcement-group-uncovered:");
    const testMisses = seamNames(row, "distributed-test-group-uncovered:");
    const loc = row.enforcement[0]
      ? `\`${row.enforcement[0].file}:${row.enforcement[0].line}\``
      : row.notes.includes("not-traced-by-reviewer")
        ? "the reviewer reported no trace for this requirement"
        : "no valid enforcement location";
    const details: string[] = [];
    if (row.notes.includes("distributed-topology-overflow")) {
      details.push(`distributed topology exceeds the ${MAX_GROUPS_PER_RULE} representable seams`);
    } else {
      if (enforcementMisses.length > 0) {
        if (row.enforcement.length > 0) details.push(loc);
        details.push(`uncovered enforcement seams: ${enforcementMisses.map((name) => `\`${name}\``).join(", ")}`);
      } else {
        details.push(loc);
      }
      if (testMisses.length > 0) {
        details.push(`uncovered test seams: ${testMisses.map((name) => `\`${name}\``).join(", ")}`);
      }
      if (row.notes.includes("distributed-test-location-uncovered")) details.push("no test location cited");
    }
    // #985: a structural row whose state check failed is otherwise
    // indistinguishable from a missing citation at the rendered level.
    if (row.notes.includes("structural-proof-unconfirmed")) {
      details.push("the cited state does not satisfy the requirement");
    }
    if (row.notes.includes("structural-citation-line-out-of-range")) {
      details.push("the cited line is outside the cited file");
    }
    const reason = row.reason !== "" ? `: ${row.reason}` : "";
    return `- \`${cleanRequirementId(row.requirement_id)}\` — **${row.disposition}** (${details.join("; ")})${reason}`;
  });
  if (notable.length > MAX_RENDERED_ROWS) lines.push(`- …and ${notable.length - MAX_RENDERED_ROWS} more`);
  const summary = `${notable.length} of ${trace.rows.length} requirement(s) not fully traced to enforcement and a test:`;
  const body = `${summary}\n\n${lines.join("\n")}`;
  if (trace.rows.length <= COLLAPSE_THRESHOLD) {
    return `\n\n### Requirement trace\n${body}`;
  }
  return `\n\n<details>\n<summary>Requirement trace (${notable.length} unresolved of ${trace.rows.length})</summary>\n\n${body}\n\n</details>`;
}

export interface RequirementTraceEnforcementResult {
  applied: boolean;
  trace: RequirementTraceArtifact;
  findingsAdded: number;
}

/**
 * Apply requirement-trace enforcement to the artifact in place: validate the
 * trace, synthesize findings for unmet requirements the model did not
 * already flag, and — when any in-scope requirement is unverifiable or
 * untraced — record that traceability gap separately and escalate
 * `required_checks` to `incomplete` (never relaxing an already-incomplete
 * status from the must_check pass). Run this AFTER
 * `applyRequiredCheckValidation` (whose unconditional write would otherwise
 * clobber the escalation) and BEFORE the verdict mapping (strict or
 * findings_severity_gated) that reads `required_checks`/`findings`. No-op
 * when disabled or the ledger has no in-scope requirements.
 */
export function applyRequirementTraceEnforcement(
  artifact: ReviewArtifact,
  options: {
    enabled: boolean;
    ledger: unknown;
    workspace: string;
    changed?: string | undefined;
    /** #958 explicit boundary ownership (repository config). */
    ownership?: readonly RequirementOwnership[] | undefined;
    /** Changed file paths, for owner-glob matching. */
    paths?: readonly string[] | undefined;
  },
): RequirementTraceEnforcementResult {
  if (!options.enabled) {
    return { applied: false, trace: { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] }, findingsAdded: 0 };
  }
  const trace = validateRequirementTrace(artifact.requirement_coverage, options.ledger, options.workspace, options.changed, {
    ownership: options.ownership,
    paths: options.paths,
  });
  if (trace.rows.length === 0) {
    return { applied: false, trace, findingsAdded: 0 };
  }
  const findingsAdded = ensureUnmetRequirementFindings(artifact, trace, options.ledger);
  if (trace.incomplete) artifact.requirement_trace_incomplete = true;
  if (trace.incomplete && artifact.required_checks !== "incomplete") {
    artifact.required_checks = "incomplete";
  }
  const rendered = renderRequirementTraceMarkdown(trace);
  if (rendered !== "") {
    artifact.review_markdown = `${String(artifact.review_markdown ?? "")}${rendered}`;
  }
  return { applied: true, trace, findingsAdded };
}
