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
 * verdict policy. #1095: the enforcement pass never synthesizes a finding
 * from an unmet row — the model's prompt contract obliges it to file the
 * matching finding itself, and a blocking review must rest on a substantiated
 * implementation violation, not on ledger text promoted out of a
 * process/risk note (miso-gallery#543).
 *
 * Scope: ledger entries of kind `acceptance` or `normative` only — the
 * explicit MUST/acceptance-criteria items. `invariant`-kind entries
 * (ordering/sequencing text, and #796 harness obligations, which are always
 * injected as `invariant`) are out of scope here; their own
 * verification-required coverage rule already applies via
 * `requirement-coverage.ts`. Bounded by the ledger's own MAX_REQUIREMENTS
 * cap; never throws on malformed input.
 *
 * #1062: not every acceptance criterion is a code/test-verifiable obligation.
 * A process or external item — an inventory to record in the PR description,
 * the preservation of external workflows / CI green state, whether an unrelated
 * PR will merge in the future — has no runtime predicate a unit test could
 * exercise, and demanding one falsely withheld approval on PR #1060 (9/11 rows
 * `unverifiable`). `nonCodeProofDomain` classifies such rows deterministically
 * from ledger text (NEVER a model field) into an `external_state` or
 * `documentation` proof kind, dispositioned `pending` (a non-blocking advisory)
 * or, for a documentation obligation whose literal is positively present in
 * that obligation's OWN target source, `met`: the trusted PR body for a
 * PR-description/body obligation, the exact-head checkout's README/CHANGELOG/
 * docs for a checkout-document obligation (never cross-confirmed). This is a
 * proof-domain split, not a waiver: a genuine
 * code obligation, a mandatory test, or any row with a code-action/enforcement
 * verb is vetoed out of the domain and stays on the strict `unverifiable`-blocks
 * path, and the model can never claim `pending` to escape a code proof.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import type { ReviewArtifact } from "./artifact.js";
import { workspaceRegularFile, workspaceFsPath, workspacePathExists, workspacePathHasSymlinkComponent } from "../context/workspace-path.js";
import { detectLanguage, isTestPath } from "../context/change-anchors.js";

export const TRACE_DISPOSITIONS: readonly string[] = ["met", "unmet", "not_applicable", "unverifiable"];

/** #1062: a module-derived disposition for an in-scope requirement that lives
 * in a non-code proof domain and is therefore not verifiable from the checkout
 * at head. It is NOT in {@link TRACE_DISPOSITIONS}: the model can never claim
 * `pending`, so it cannot self-authorise out of a mandatory code proof. The
 * validator derives it only after it has independently classified the row's
 * proof domain from ledger text; a well-formed model `unmet` (with reason) on
 * such a row is honoured as a real gap instead. A `pending` row is surfaced to
 * the author as an advisory and never folds into `required_checks=incomplete`. */
export const PENDING_DISPOSITION = "pending";

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
    * `distributed` | `external_state` | `documentation` (#1062), or
    * `not_applicable` for an out-of-scope row. Derived from the ledger
    * requirement text by this module, never from a model field, so it is
    * explainable from the artifact alone. */
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

export type RequirementProofKind = "runtime_behavior" | "structural_state" | "test_required" | "distributed" | "external_state" | "documentation";

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
const CONJUNCTION_GLOBAL_RE = /[,;]|\b(and|or|nor|plus|but)\b/gi;
/** The clause shapes that demand test coverage, stripped to test the tail. */
const TEST_DEMAND_CLAUSE_RE = new RegExp(
  "\\b(?:must|shall|should|needs?\\s+to|has\\s+to|have\\s+to|is|are|requires?|needs?)?\\s*"
  + "(?:also\\s+)?(?:be\\s+)?(?:covered\\s+by|verified\\s+by|validated\\s+by|checked\\s+by|tested|"
  + "have|has|add|adds|include|includes|provide|provides|require|requires|need|needs)?\\s*"
  + "(?:a|an|the)?\\s*(?:dedicated\\s+|new\\s+|regression\\s+|adversarial\\s+|unit\\s+|integration\\s+|end-to-end\\s+|e2e\\s+)*"
  + "(?:tests?|test\\s+coverage|coverage)\\b",
  "gi",
);
/** Connectives, punctuation and whitespace — nothing on their own. */
const TAIL_FILLER_RE = /[\s,;.:!?]+|\b(?:and|or|nor|plus|but)\b/gi;
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

/** Containment-aware existence for a structural claim.
 *
 * A symlinked component — a direct symlink, a dangling one, or an intermediate
 * directory — makes the path resolve into state the containment guard cannot
 * vouch for, so NEITHER existence nor absence can be asserted from it: fail
 * closed. That is what closes `linked -> outside-dir` plus
 * "`linked/missing.json` must be absent", which would otherwise prove absence
 * by looking through a symlink into external filesystem state.
 *
 * Without symlink traversal, "must exist" is simply the presence of the entry
 * and "must be absent" its absence — a dangling symlink is still an entry, so
 * it cannot be called absent. */
function repoPathSatisfies(presence: boolean, workspace: string, path: string): boolean {
  if (workspacePathHasSymlinkComponent(workspace, path)) return false;
  const exists = workspacePathExists(workspace, path);
  return presence ? exists : !exists;
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
 * Split the claim core from the one trailing adjunct the grammar models.
 *
 * A conjunction anywhere inside the assertion region introduces a further
 * clause, and the only such clause the grammar represents is an explicit test
 * demand — which asserts no additional state. The tail must be EXACTLY that
 * adjunct, not merely contain one: once every test-demand clause is stripped,
 * nothing but connectives and punctuation may remain. So
 *
 *   `config.json` must contain `foo`
 *   and enable debug logging
 *   and must add a regression test
 *
 * is refused — the `enable debug logging` clause survives the strip — while
 * `must contain \`foo\` and must have a regression test` keeps its claim.
 *
 * This is deliberately not a verb list: `and enable`, `and use`, `and set`,
 * `and disable` are all caught because `and` starts a clause the grammar
 * cannot represent, whatever verb follows it. Leading prose before the
 * assertion is exempt (it is not part of the claim), and a bare trailing noun
 * ("must contain the `omit` key") carries no conjunction, so it stays valid.
 *
 * Returns the claim text with the adjunct removed, or `null` when the tail is
 * unrepresentable.
 */
function claimCoreWithoutAdjunct(text: string): string | null {
  const from = firstAssertionIndex(text);
  const region = from < 0 ? text : text.slice(from);
  const conjunction = region.search(CONJUNCTION_RE);
  if (conjunction < 0) return text;
  const tail = region.slice(conjunction);
  // A second conjunction means a second clause.
  if ((tail.match(CONJUNCTION_GLOBAL_RE) ?? []).length > 1) return null;
  const residual = tail.replace(TEST_DEMAND_CLAUSE_RE, " ").replace(TAIL_FILLER_RE, " ").trim();
  if (residual !== "") return null;
  return text.slice(0, from + conjunction);
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
  // Split off the one modeled adjunct first: it asserts no state of its own,
  // so every remaining check runs against the claim core alone.
  const core = claimCoreWithoutAdjunct(text);
  if (core === null) return null;
  // The claim must be representable in full — one modal-bound assertion and
  // nothing else asserted.
  if (!hasExactlyOneRepresentableAssertion(core)) return null;

  const contentPresent = CONTENT_PRESENT_PHRASES.some((re) => re.test(core));
  const contentAbsent = CONTENT_ABSENT_PHRASES.some((re) => re.test(core));
  const present = contentPresent || EXISTENCE_PRESENT_RE.test(core);
  const absent = contentAbsent || EXISTENCE_ABSENT_RE.test(core);
  // Both or neither ⇒ the polarity is not recoverable; stay strict.
  if (present === absent) return null;

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
  const existenceAsserted = EXISTENCE_PRESENT_RE.test(core) || EXISTENCE_ABSENT_RE.test(core);
  const contentVerbPresent = new RegExp(`\\b(${CONTENT_VERBS}|${NEGATIVE_CONTENT_VERBS})\\b`, "i").test(core);
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
  if (claim.mode === "exists") return repoPathSatisfies(claim.presence, workspace, claim.file);
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

// ---------------------------------------------------------------------------
// #1062: non-code proof domains — external/future outcomes and PR metadata.
//
// #874/#985 demand that a `met` trace a requirement to a runtime predicate AND
// a regression test. That is exactly right for BEHAVIOURAL requirements, but it
// is the wrong shape for a criterion whose truth is not a property of the code
// at head. PR #1060 is the motivating false block: a Python-test-cleanup PR was
// held at `review_result=partial` with 9/11 rows `unverifiable` because its
// linked-issue acceptance criteria included process and external items — an
// inventory recorded in the PR description, the preservation of external
// workflows / CI green state, and whether an UNRELATED pull request (#1052)
// would merge in the future. None of those has a code predicate a unit test
// could exercise, so each was reported `unverifiable` and folded into
// `required_checks=incomplete`, withholding an approval the code itself earned.
//
// This is a proof-DOMAIN distinction, not a waiver: the classifier reads the
// ledger requirement text (never a model field, so the model cannot authorise
// itself out of a mandatory code proof) and only ever CARVES OUT the two shapes
// below. Everything it cannot place unambiguously falls through to the strict
// runtime path, exactly like `structuralStateClaim`. A genuine implementation
// obligation is never pending: any code-action/enforcement verb, any named
// source/test path, or an explicit test demand vetoes the row out of the
// non-code domain and keeps a hostile/empty/non-enforcing claim blocking.
// ---------------------------------------------------------------------------

export type NonCodeProofDomain = "external_state" | "documentation";

/** Code-action / enforcement verbs that make a requirement an IMPLEMENTATION
 * obligation no matter what process or external words surround it. Two groups:
 * the security/crypto/compare core (#854-adjacent), and the publish/report/ship
 * verbs this product's OWN pipeline performs (it reports status checks, ships
 * releases) — without the second group a real obligation like "publish a green
 * status check on pull request #1000" or "ship the release once CI is green"
 * would ride the external-state signal out of strict proof. The softer verbs
 * (`check`, `run`, `load`, …) are NOT here because they co-occur with the
 * external-system wording this domain recognizes ("CI checks must stay green").
 * The veto is safe in only the fail-closed direction: it can keep a genuinely
 * external criterion strict (it stays blocking, the conservative outcome), never
 * the reverse. */
const NON_CODE_VETO_RE = /\b(implement[sd]?|compar\w+|hash(?:es|ing)?|encod\w+|decod\w+|authenticat\w+|authori[sz]\w+|redact\w*|saniti[sz]\w*|escap\w+|signature|fingerprint|tokens?|secrets?|credentials?|validat\w*|verif\w+|enforce\w+|assert\w*|throw\w*|reject\w*|guard\w*|allow\w*|deny\w*|permit\w*|forbid\w*|prevent[s]?|report[s]?|publish(?:es|ed|ing)?|pos(?:t|ts|ted|ting)|deploy(?:s|ed|ing)?|print(?:s|ed|ing)?|emit(?:s|ted|ting)?|upload(?:s|ed|ing)?|ship(?:s|ped|ping)?|releas\w+|pars(?:e|es|ed|ing))\b/i;

/** #1095: a TEST-EXECUTION OUTCOME demand — the requirement asks whether tests
 * pass (or the suite is green), not that code enforce something. This is the
 * miso-gallery#543 shape: an acceptance criterion reading "tests/... and
 * tests/... pass with only import-path updates" names four test paths as the
 * SUBJECT of a passing outcome; the named-path veto below would otherwise read
 * those subjects as implementation obligations and hold a green run at
 * `unverifiable`. Whether the tests pass is observable only by executing them
 * (the CI gate's exact-head conclusion, surfaced in the advisory's diagnostic
 * notes), never from checkout inspection — so the row is `external_state` and
 * pends as a non-blocking advisory, exactly like the #1062 external-CI rows.
 * Deliberately narrow: the pass/green verb must FOLLOW a tests/suite subject
 * within one clause span, so "tests must exercise the new boundary" (a code
 * demand) and "feature tests must be added" (a test demand, caught upstream)
 * stay strict; phrasal passes ("pass through the proxy") are excluded; and the
 * code-verb veto above still runs first, so any enforcement vocabulary in the
 * row keeps it on the strict path. */
const TEST_EXECUTION_OUTCOME_RE = /\b(?:tests?[\w./-]*|(?:test\s+|full\s+)?suite)\b[^.;]{0,200}?\bpass(?:es|ed|ing)?\b(?!\s*(?:through|along|over|under|across|between)\b)/i;

/** An external system whose state this review cannot own — CI, an external
 * workflow, or an unrelated pull request — but ONLY when the requirement frames
 * it as explicitly external/unrelated. A bare `CI` or `PR #N` mention is not
 * enough: this product's own requirements are full of CI/PR vocabulary, so
 * "make CI green" or "report a status check on PR #1000" must stay on the strict
 * path. Requiring the modifier keeps the carve-out genuinely about a dependency
 * the review does not control (the #1060 case: "external workflows", "unrelated
 * pull request #1052"). */
const EXTERNAL_SUBJECT_RE = /\b(?:external|unrelated|separate|independent|another|upstream|the\s+base)\b(?:[^.]){0,40}?\b(?:CI|continuous integration|workflows?|checks?|pull[\s-]requests?|PR)\b/i;

/** A state/outcome word that turns an external subject into a completed- or
 * future-state claim rather than a passing mention. */
const EXTERNAL_OUTCOME_RE = /\b(green|passing|passed|passes|status|merge[sd]?|merging|land(?:ed|s|ing)?|succes\w+)\b/i;

/** The recording TARGET of a documentation obligation: the place content is
 * asked to be recorded (PR description / body, README, CHANGELOG, docstring,
 * docs). Naming this artifact is what distinguishes "record X in the PR
 * description" (a metadata obligation) from "the audit logger must record the
 * actor" (a runtime logging obligation) — the bare verb alone is never enough.
 *
 * #1062 review follow-up: the target ALSO selects the proof SOURCE. A literal
 * recorded in the PR body proves only a PR-metadata obligation; "README must
 * document X" is satisfied by the README in the exact-head checkout, not by
 * the description mentioning X. The two target groups are therefore matched
 * separately and never cross-confirmed. */
const PR_BODY_TARGET_RE = /\b(PR description|pull[\s-]request description|PR body|pull[\s-]request body)\b/i;
const CHECKOUT_DOC_TARGET_RE = /\b(README|CHANGELOG|docstring|documentation|docs)\b/i;
const DOC_TARGET_RE = /\b(PR description|pull[\s-]request description|PR body|pull[\s-]request body|README|CHANGELOG|docstring|documentation|docs)\b/i;

/** A recording verb, required alongside {@link DOC_TARGET_RE}. */
const DOC_VERB_RE = /\b(document(?:ed|ation|s)?|record(?:ed|s|ing)?|inventor(?:y|ied|ies)|captured?|note(?:d|s)?)\b/i;

/**
 * Classify a requirement into a non-code proof domain, or `null` when it is a
 * code/test-verifiable implementation obligation (the strict path). Fail-closed:
 * the only way OUT of strict proof is an affirmative, *explicitly external*,
 * *test-execution-outcome*, or *documenting-into-a-named-artifact* signal — in
 * the presence of NO code verb and NO explicit test demand. The model
 * contributes nothing here.
 */
export function nonCodeProofDomain(text: string): NonCodeProofDomain | null {
  // A mandatory test/regression/security obligation is never non-code.
  if (explicitlyRequiresTest(text)) return null;
  // Any implementation/enforcement/publish verb (incl. security/crypto terms) is strict.
  if (NON_CODE_VETO_RE.test(text)) return null;
  const { quoted, bare } = verbatimTokens(text);
  const namedTokens = [...new Set([...quoted, ...bare])];
  // Naming real source or a non-test path is an implementation obligation.
  // #1095 review: checked BEFORE the test-execution signal so a compound
  // requirement ("`app.py` must define `X`; the existing tests pass
  // unchanged") cannot ride its tests-pass clause out of strict proof — only
  // requirements whose named paths are ALL test subjects may pend. The path
  // predicate is broader than `looksLikePath` here (any dotted source-style
  // token counts), so a quoted `app.py` is caught even though `.py` is not a
  // config extension; over-counting a prose token as a path only ever fails
  // CLOSED (the row stays strict), never pends.
  const pathish = (token: string): boolean =>
    looksLikePath(token) || (token.includes(".") && detectLanguage(token) !== "non_source");
  const namesSourcePath = namedTokens.some((token) =>
    pathish(token) && !isTestPath(token) && detectLanguage(token) !== "non_source");
  if (namesSourcePath) return null;
  // #1095: a test-execution outcome ("tests/... pass with only import-path
  // updates") is external state — observable only by running the tests — and
  // the four #543 criteria name test paths as the subject of the outcome. See
  // TEST_EXECUTION_OUTCOME_RE for the narrow shape and its exclusions.
  if (TEST_EXECUTION_OUTCOME_RE.test(text)) return "external_state";
  // Naming a test path with no test-execution outcome is a test demand.
  if (namedTokens.some((token) => looksLikePath(token) && isTestPath(token))) return null;
  // External/future state: an explicitly-external system subject AND a state/outcome word.
  if (EXTERNAL_SUBJECT_RE.test(text) && EXTERNAL_OUTCOME_RE.test(text)) return "external_state";
  // Documentation: a recording verb INTO a named documentation/metadata artifact.
  if (DOC_TARGET_RE.test(text) && DOC_VERB_RE.test(text)) return "documentation";
  return null;
}

/** The single checkable literal a documentation obligation names — a quoted
 * token that is not itself a repository path — or `null` when the requirement
 * asserts no verifiable string (pure prose like "record the inventory"). */
function documentationLiteral(text: string): string | null {
  const { quoted } = verbatimTokens(text);
  const candidates = [...new Set(quoted
    .map((token) => token.trim())
    .filter((token) => token !== "" && !looksLikePath(token) && detectLanguage(token) !== "non_source"))];
  if (candidates.length !== 1) return null;
  const literal = candidates[0] as string;
  return literal.length > MAX_STRUCTURAL_LITERAL_CHARS ? null : literal;
}

/** True when `literal` occurs as a bounded token anywhere in `text` (checked
 * line by line so the token-boundary rule is reused). */
function literalRecordedIn(text: string, literal: string): boolean {
  for (const line of text.split("\n")) {
    if (containsLiteralToken(line, literal)) return true;
  }
  return false;
}

/** Which trusted source a documentation obligation's target names. `pr_body`
 * (PR description/body — the author's own recording surface), `checkout_doc`
 * (a repository artifact read from the exact-head checkout: README, CHANGELOG,
 * docs), or `mixed` when the text names both — an obligation spanning two
 * sources is never confirmable from one, so it stays advisory. */
export type DocumentationProofSource = "pr_body" | "checkout_doc" | "mixed";

export function documentationProofSource(text: string): DocumentationProofSource {
  const prBody = PR_BODY_TARGET_RE.test(text);
  const checkout = CHECKOUT_DOC_TARGET_RE.test(text);
  if (prBody && checkout) return "mixed";
  return prBody ? "pr_body" : "checkout_doc";
}

/* Bounds for the checkout-documentation scan: the search is bounded work over
 * a repository checkout, not a full-tree walk. A requirement whose doc lives
 * beyond these bounds simply stays `pending` (advisory) — the scan can only
 * ever CONFIRM a `met`, never manufacture a block. */
const DOC_SCAN_MAX_ENTRIES = 500;
const DOC_SCAN_MAX_FILES = 64;
const DOC_SCAN_MAX_DEPTH = 4;
/** Unlike model-triggered citations, these reads happen automatically for
 * every documentation row, so each candidate is size-capped: a hostile
 * multi-GB README must not inflate every validation. An oversized (or
 * symlinked) candidate simply drops out and the row stays advisory. */
export const DOC_SCAN_MAX_FILE_BYTES = 512 * 1024;
const DOC_TEXT_EXT_RE = /\.(?:md|markdown|rst|txt|adoc)$/i;

/** `lstat` gate for a scan candidate: regular file (never followed through a
 * link) within the read cap. Containment itself is still enforced per-read by
 * the citation reader's own `workspaceRegularFile` guard. */
function docCandidateReadable(workspace: string, file: string): boolean {
  try {
    const stat = lstatSync(workspaceFsPath(workspace, file));
    return stat.isFile() && stat.size <= DOC_SCAN_MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

/** Deterministic, bounded candidate list of checkout documentation files a
 * requirement's target words name: root-level `README*` / `CHANGELOG*` for
 * those targets, plus root-level docs and the `docs/` tree for a generic
 * documentation/docs target. A docstring-only target has no bounded trusted
 * source (the string lives inside unnamed source), so it yields no candidates
 * and the row stays advisory. Symlinked entries are skipped — the scan never
 * reads through a link, matching the citation reader's own guards. */
function checkoutDocumentationFiles(workspace: string, text: string): string[] {
  const wantsReadme = /\bREADME\b/i.test(text);
  const wantsChangelog = /\bCHANGELOG\b/i.test(text);
  const wantsDocs = /\b(?:documentation|docs)\b/i.test(text);
  if (!wantsReadme && !wantsChangelog && !wantsDocs) return [];
  const out: string[] = [];
  let scanned = 0;
  let root: import("node:fs").Dirent<string>[];
  try {
    root = readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of root) {
    if (scanned >= DOC_SCAN_MAX_ENTRIES || out.length >= DOC_SCAN_MAX_FILES) break;
    scanned += 1;
    if (!entry.isFile()) continue;
    if (wantsReadme && /^readme(\.\w+)?$/i.test(entry.name)) {
      if (docCandidateReadable(workspace, entry.name)) out.push(entry.name);
    } else if (wantsChangelog && /^changelog(\.\w+)?$/i.test(entry.name)) {
      if (docCandidateReadable(workspace, entry.name)) out.push(entry.name);
    } else if (wantsDocs && DOC_TEXT_EXT_RE.test(entry.name)) {
      if (docCandidateReadable(workspace, entry.name)) out.push(entry.name);
    }
  }
  if (wantsDocs && scanned < DOC_SCAN_MAX_ENTRIES && out.length < DOC_SCAN_MAX_FILES
    && !workspacePathHasSymlinkComponent(workspace, "docs")) {
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (scanned >= DOC_SCAN_MAX_ENTRIES || out.length >= DOC_SCAN_MAX_FILES || depth > DOC_SCAN_MAX_DEPTH) return;
      let entries: import("node:fs").Dirent<string>[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (scanned >= DOC_SCAN_MAX_ENTRIES || out.length >= DOC_SCAN_MAX_FILES) return;
        scanned += 1;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, depth + 1);
          continue;
        }
        if (entry.isFile() && DOC_TEXT_EXT_RE.test(entry.name) && docCandidateReadable(workspace, `${prefix}${entry.name}`)) {
          out.push(`${prefix}${entry.name}`);
        }
      }
    };
    walk(`${workspace}/docs`, "docs/", 1);
  }
  return out;
}

/**
 * #1062: resolve the disposition for a requirement in a non-code proof domain.
 *
 * The model NEVER supplies the domain, and a non-code `met` is never a code
 * proof. The rules, in order:
 *
 * - A well-formed `unmet` (a non-empty reason) is the reviewer reporting a real
 *   failing external/documentation condition, so it is honored as a blocking
 *   `unmet` — the domain never launders a reported gap into an advisory.
 * - `documentation` targeting the PR description/body whose single quoted
 *   literal is positively present in the trusted PR body is `met` (the
 *   obligation is literally "record X in the description", so recording X in
 *   the body IS its fulfillment). #1062 review follow-up: a documentation
 *   obligation targeting a checkout artifact (`README must document X`) is
 *   confirmed ONLY from that artifact in the exact-head checkout — the PR body
 *   describing X is not the README containing X, and confirming across sources
 *   would grant positive proof from the wrong source. A target naming both
 *   sources, a docstring target (no bounded trusted source), a missing
 *   literal, and any failed confirmation all stay `pending`, never a
 *   cross-source or fabricated `met`.
 * - Everything else — prose-only documentation with no confirmable literal, and
 *   every external/future outcome — is `pending`: a distinct advisory condition
 *   surfaced to the author that does not fold into `required_checks=incomplete`
 *   and is never rendered as a blocking trace failure.
 *
 * Conservative by construction: nothing here can grant a code-style `met` to an
 * external/future outcome, and a genuine code obligation is vetoes out of the
 * domain upstream (`nonCodeProofDomain`), so it can only ever reach `unverifiable`.
 */
function nonCodeDisposition(
  domain: NonCodeProofDomain,
  text: string,
  modelDisposition: string | null,
  modelReason: string,
  prBody: string | null,
  cache: FileTextCache,
  workspace: string,
  notes: string[],
): string {
  // A reported failure is a real gap on ANY domain. Mirror the strict path's
  // fail-closed reason rule: an `unmet` with no reason is not silently advisory —
  // it degrades to `unverifiable`, which blocks, exactly as a bare `unmet` does
  // for a code requirement.
  if (modelDisposition === "unmet") {
    if (modelReason === "") {
      notes.push("missing-reason");
      return "unverifiable";
    }
    notes.push("non-code-reported-unmet");
    return "unmet";
  }
  if (domain === "documentation") {
    const source = documentationProofSource(text);
    if (source === "mixed") {
      // Names both a PR-metadata and a checkout-document target: one source
      // cannot prove the other's half, so the row stays advisory instead of
      // borrowing confirmation from either.
      notes.push("documentation-pending-mixed-target");
      return PENDING_DISPOSITION;
    }
    const literal = documentationLiteral(text);
    if (source === "pr_body") {
      // The PR body is the author's OWN recording surface for this obligation
      // ("record X in the description"), so its presence is genuine proof — but
      // ONLY for a documentation obligation; a code obligation cannot reach this
      // domain (`nonCodeProofDomain` requires a named doc/metadata target and vetoes
      // every code verb). With no trusted body, or no confirmable literal, it stays
      // a non-blocking `pending`, never a fabricated code `met`.
      if (literal !== null && prBody !== null && literalRecordedIn(prBody, literal)) {
        notes.push("documentation-verified-in-pr-body");
        return "met";
      }
      notes.push("documentation-pending-unconfirmed");
      return PENDING_DISPOSITION;
    }
    // checkout_doc: confirm the literal ONLY from the named artifact class in
    // the exact-head checkout. The PR body is never consulted here — a
    // description claiming "the README documents X" is exactly the wrong-source
    // self-certification this fix exists to refuse. No candidates, unreadable
    // candidates, or a missing literal all stay advisory.
    if (literal !== null) {
      for (const file of checkoutDocumentationFiles(workspace, text)) {
        const lines = cache.lines(file);
        if (lines === null) continue;
        if (literalRecordedIn(lines.join("\n"), literal)) {
          notes.push("documentation-verified-in-checkout");
          return "met";
        }
      }
      notes.push("documentation-pending-checkout-unconfirmed");
      return PENDING_DISPOSITION;
    }
    notes.push("documentation-pending-unconfirmed");
    return PENDING_DISPOSITION;
  }
  notes.push("external-state-pending");
  return PENDING_DISPOSITION;
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

/** #1000: a code span carrying `-` or `/` is ONE literal compound identifier,
 * not prose. Splitting `x-api-key` into the words "api" and "key" fabricated
 * the phrase "api key", whose joined form `apikey` then matched the generic
 * `apiKey`/`API_KEY` vocabulary of any credentials-adjacent diff — scoping
 * the unrelated credential-transport standard into #997's redaction-only
 * change and driving `required_checks: incomplete`.
 *
 * A qualifying span (at least two non-empty separator-separated segments,
 * at least five chars — a 3-char token like `a-b` would bare-substring-match
 * `a-b-c` in any diff — and within the term-size
 * bounds) is extracted as a single atomic term and replaced in the prose
 * stream by a one-letter placeholder: the placeholder occupies a raw-word
 * index, keeping the words on either side non-adjacent, and is itself
 * dropped from `kept` (length < 2). A span that does not qualify — a
 * trailing-hyphen fragment like `sk-`, an oversized span — passes through
 * unchanged, keeping the pre-#1000 prose behavior byte-for-byte. Spans
 * without a separator (`sourceSha`, `source SHA`) are never touched.
 *
 * Spans are paired by splitting on backticks rather than by a regex that
 * *requires* a separator inside the match: such a regex backtracks across a
 * span boundary and pairs the gap BETWEEN two spans ("` / `") as a span,
 * consuming the next span's opening backtick and leaving its content in the
 * prose stream. An odd backtick count (a stray or lost closing backtick —
 * common in copy-pasted issue text) leaves the final segment unterminated;
 * it is scanned the same way, so "`x-api-key header name MUST not…" cannot
 * resurrect the fabricated phrase through a missing backtick.
 *
 * Within a span body, each whitespace-delimited token is normalized (edge
 * punctuation and edge separators stripped, so `x-api-key,` and
 * `---x-api-key` both yield `x-api-key`) and atomized when it qualifies;
 * tokens that do not qualify pass through byte-identically, keeping the
 * pre-#1000 prose behavior for spans like `sk-` and `source SHA`.
 *
 * Deliberate residual: an UNBACKTICKED hyphenated mention ("the api-key
 * header") still splits into prose words and can form the joined form —
 * tokenizing prose hyphens generally would break kebab identifiers that are
 * legitimately subjects. And `extractRequirementTerms` below still splits
 * spans the old way on purpose: it matches requirement terms against cited
 * enforcement lines (where the broader spelling net is wanted), not against
 * the whole diff for scope. */
const ATOMIC_CODE_SPAN_MIN_LENGTH = 5;
const PROSE_PLACEHOLDER = "\u0000q\u0000";

/** The atomic term a span-body token contributes, or null when it does not
 * qualify: no `-`/`/` separator after edge normalization, shorter than
 * {@link ATOMIC_CODE_SPAN_MIN_LENGTH} (a 3-char token like `a-b` would
 * bare-substring-match `a-b-c` in any diff), over the term-size bound, or
 * fewer than two non-empty separator-separated segments. */
function atomicCodeSpanTerm(raw: string): string | null {
  const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (!/[-/]/.test(token)) return null;
  if (token.length < ATOMIC_CODE_SPAN_MIN_LENGTH || token.length > MAX_SUBJECT_TERM_CHARS) return null;
  if (token.split(/[-/]/).filter((segment) => segment !== "").length < 2) return null;
  return token.toLowerCase();
}

/** Split a requirement's text into its subject-overlap signals. Adjacency is
 * over the raw word stream, so a stopword between two kept words (as in
 * "compare the source SHA") breaks the phrase rather than gluing its halves
 * together. */
export function requirementSubjectSignals(text: string): RequirementSubjectSignals {
  const atomic = new Set<string>();
  const segments = text.split("`");
  let prose = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (index % 2 === 0) {
      prose += segment;
      continue;
    }
    const terminated = index < segments.length - 1;
    let rebuilt = "";
    for (const part of segment.split(/(\s+)/)) {
      if (part === "" || /^\s+$/.test(part)) {
        rebuilt += part;
        continue;
      }
      const term = atomicCodeSpanTerm(part);
      if (term === null) {
        rebuilt += part;
      } else {
        atomic.add(term);
        rebuilt += PROSE_PLACEHOLDER;
      }
    }
    prose += terminated ? `\`${rebuilt}\`` : `\`${rebuilt}`;
  }
  const rawWords = prose.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
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
  for (const term of atomic) phrases.push([term]);
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

/** #1044: caps for the bounded `requirement_trace_repair` summary. */
export const MAX_TRACE_REPAIR_SUMMARY_IDS = 48;
export const MAX_TRACE_REPAIR_SUMMARY_ID_CHARS = 80;
export const MAX_TRACE_REPAIR_SUMMARY_ERROR_CHARS = 200;

/** #1145: bounded summary of the native loop's in-conversation
 * evidence-repair continuation (the harness's own
 * `trace_repair_continuation` record), folded into the #1044 repair summary
 * so the persisted artifact shows whether the loop itself attempted the
 * gap-repair round. Defined here (not in `requirements/trace-gap-probe.ts`)
 * because that module imports from this one — an import in the other
 * direction would cycle. */
export interface TraceGapContinuationSummary {
  /** `continued` | `skipped_no_budget` | `skipped_probe_error` |
   * `skipped_refresh_failed` (harness-owned enum). */
  outcome: string;
  unresolved_ids: string[];
  verdict_refreshed: boolean;
}

/** #1044: bounded, sanitized summary of the #959 trace-repair pass, attached
 * to the persisted artifact as `requirement_trace_repair` and handed to
 * `validateRequirementTrace` so the published section can distinguish "the
 * reviewer never emitted a claim" from "the bounded repair pass ran and
 * failed". For attempted runs `missing_ids` holds the ids STILL missing after
 * the pass (recomputed from post-merge coverage), so membership there is
 * exactly "the retry did not fill this id". Diagnostics-only: nothing here
 * changes a verdict, and the `error` text never reaches the rendered
 * markdown. Defined here (not in `requirements/trace-repair.ts`) because that
 * module already imports from this one — an import in the other direction
 * would cycle. */
export interface RequirementTraceRepairOutcome {
  attempted: boolean;
  outcome: "no_missing_ids" | "skipped_by_gate" | "no_claims" | "errored" | "timeout" | "merged";
  missing_ids: string[];
  claims: number;
  status?: string;
  error_kind?: string | null;
  error?: string | null;
  diff_clipped?: boolean;
  /** #1145: present when the native loop's own continuation ran or was
   * skipped (absent for runs where no probe fired at all). */
  continuation?: TraceGapContinuationSummary;
}

/** #1044: the summary's `missing_ids` are sanitized (control characters and
 * backticks stripped, length-capped); sanitize a ledger id the same way so
 * membership matching cannot silently diverge. */
function traceRepairIdKey(id: string): string {
  return id.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, MAX_TRACE_REPAIR_SUMMARY_ID_CHARS);
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
  context: {
    ownership?: readonly RequirementOwnership[] | undefined;
    paths?: readonly string[] | undefined;
    /** #1062: the trusted PR description (title + body) at head, used ONLY as
     * the positive-confirmation source for a `documentation`-domain obligation
     * that names a single literal. `null` (the default) means no trusted body is
     * available, so a documentation row is never `met` from a body it cannot see
     * and falls to `pending`. */
    prBody?: string | null | undefined;
    /** #1062 review follow-up: the exact-head CI conclusion this run observed
     * through the CI gate, if any (e.g. `success`/`failure`/`none`). It is
     * diagnostic-only: an `external_state` advisory row reports it (or its
     * unavailability) so the author sees what the review could and could not
     * observe; it never changes a disposition. */
    ciState?: string | null | undefined;
    /** #1044: the bounded #959 repair-pass summary, when the pass was in
     * scope for this run — lets a `claim === undefined` row record that the
     * repair also ran (and still left this id unclaimed). */
    traceRepair?: RequirementTraceRepairOutcome | undefined;
  } = {},
): RequirementTraceArtifact {
  const { inScope, outOfScope } = requirementTraceScope(ledger, changed, context);
  if (inScope.length === 0 && outOfScope.length === 0) {
    return { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] };
  }

  // #1062 review follow-up: provenance lookup so a pending advisory can state
  // WHERE its requirement came from (linked issues / PR body / standards / …).
  // The scope decision itself stays owned by `requirementTraceScope`; this map
  // only labels rows that are already dispositioned.
  const sourcesById = new Map<string, string>();
  for (const { entry, sources } of ledgerTraceCandidates(ledger)) {
    if (sources !== null && sources.length > 0) sourcesById.set(entry.id, [...new Set(sources)].join("/").slice(0, 96));
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
    // #1062: a non-code proof domain only when the row is NOT a distributed
    // seam and NOT a structural-state claim — those carry their own precise
    // checkout proof and keep precedence. The classifier reads ledger text only.
    const nonCode = structural === null && !isDistributed ? nonCodeProofDomain(entry.text) : null;
    const proof: RequirementProofKind = isDistributed
      ? "distributed"
      : structural !== null
        ? "structural_state"
        : nonCode !== null
          ? nonCode
          : requiresTest
            ? "test_required"
            : "runtime_behavior";
    let disposition: string;
    let enforcement: TraceLocation[];
    let test: TraceLocation[];
    let reason: string;

    if (nonCode !== null) {
      // #1062: the row lives in a non-code proof domain. Its disposition is
      // decided by the deterministic domain rules, NOT by the code/test trace
      // path — there is no code predicate or regression test to demand. The
      // model contributes only its (optional) disposition and reason; a
      // well-formed `unmet` stays blocking, a positively-recorded documentation
      // literal in the trusted PR body is `met`, and anything not confirmable
      // from the domain's own source becomes a non-blocking `pending` advisory.
      const modelDisposition = claim !== undefined && typeof claim.disposition === "string" ? claim.disposition.toLowerCase() : null;
      const modelReason = claim !== undefined ? capReason(claim.reason) : "";
      enforcement = claim !== undefined ? parseLocations(claim.enforcement) : [];
      test = claim !== undefined ? parseLocations(claim.test) : [];
      reason = modelReason;
      disposition = nonCodeDisposition(nonCode, entry.text, modelDisposition, modelReason, context.prBody ?? null, cache, workspace, notes);
      if (claim === undefined) notes.push("non-code-not-traced");
      // #1062 review follow-up: the advisory must be explainable from the
      // artifact alone — where the requirement came from, and (for an
      // external-state row) what the review could actually observe about CI
      // at head. Diagnostic labels only; neither note can change a disposition.
      const provenance = sourcesById.get(entry.id);
      notes.push(`provenance:${provenance ?? "unknown"}`);
      if (nonCode === "external_state") {
        const ci = typeof context.ciState === "string" ? context.ciState.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32) : "";
        notes.push(ci === "" ? "external-state-ci-unavailable" : `external-state-ci:${ci}`);
      }
    } else if (claim === undefined) {
      disposition = "unverifiable";
      enforcement = [];
      test = [];
      reason = "";
      notes.push("not-traced-by-reviewer");
      // #1044: the summary's `missing_ids` are the ids the pass did NOT fill,
      // recomputed from the POST-merge coverage — an id here (on an attempted
      // run) is exactly an id the retry also left unclaimed, so the render can
      // distinguish "the reviewer never emitted a claim" from "the bounded
      // repair pass ran and failed for this id". Non-attempted summaries
      // (gate kept the pass off) never carry the note.
      if (
        context.traceRepair !== undefined
        && context.traceRepair.attempted === true
        && context.traceRepair.missing_ids.includes(traceRepairIdKey(entry.id))
      ) {
        notes.push("trace-repair-ran-no-claims");
      }
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
  // #1062: `pending` rows are advisory-only and never appear in `notable`, but
  // they still need to render, so the empty-check must consider both.
  const anyPending = trace.rows.some((row) => row.disposition === PENDING_DISPOSITION);
  if (notable.length === 0 && !anyPending) return "";
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
        // #1044: static text only — the pass's error/status text is
        // diagnostics and must never reach the rendered markdown.
        ? row.notes.includes("trace-repair-ran-no-claims")
          ? "the reviewer reported no trace for this requirement, and a bounded repair pass also returned no usable claim"
          : "the reviewer reported no trace for this requirement"
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
  // #1062: `pending` (non-code) rows are neither blockers nor code/test-verifiable,
  // so they must not inflate the "not fully traced to enforcement and a test"
  // denominator — otherwise a ledger with 9 pending criteria and 1 real gap reads
  // as "1 unresolved of 10", implying the non-code rows were trace failures.
  const codeRows = trace.rows.length - trace.rows.filter((row) => row.disposition === PENDING_DISPOSITION).length;
  const summary = `${notable.length} of ${codeRows} requirement(s) not fully traced to enforcement and a test:`;
  const blockingSection = notable.length === 0
    ? ""
    : (() => {
        const body = `${summary}\n\n${lines.join("\n")}`;
        if (codeRows <= COLLAPSE_THRESHOLD) return `### Requirement trace\n${body}`;
        return `<details>\n<summary>Requirement trace (${notable.length} unresolved of ${codeRows})</summary>\n\n${body}\n\n</details>`;
      })();

  // #1062: a `pending` row is a non-code criterion (an external/future outcome,
  // or a documentation obligation with no confirmable literal) that is surfaced
  // for the author's awareness but deliberately does NOT fold into
  // `required_checks=incomplete` and does not withhold approval. It is rendered
  // in its own advisory section so it can never be mistaken for a trace failure
  // on the published review, and each row names its proof domain so the reader
  // sees why no code/test predicate was required of it.
  const pending = trace.rows.filter((row) => row.disposition === PENDING_DISPOSITION);
  const pendingSection = pending.length === 0
    ? ""
    : (() => {
        const cleanSource = (value: string): string => value.replace(/[\x00-\x1f\x7f`*[\]()]/g, "").slice(0, 96);
        const pendingDomain = (row: RequirementTraceRow): string => {
          if (row.proof === "external_state") return "external/future outcome";
          if (row.notes.includes("documentation-pending-checkout-unconfirmed")) return "checkout documentation";
          if (row.notes.includes("documentation-pending-mixed-target")) return "documentation (PR metadata + checkout docs)";
          return "documentation / PR metadata";
        };
        const pendingLine = (row: RequirementTraceRow): string => {
          const parts: string[] = [];
          if (row.notes.includes("documentation-pending-unconfirmed")) {
            parts.push("not confirmable from the PR description");
          } else if (row.notes.includes("documentation-pending-checkout-unconfirmed")) {
            parts.push("the literal was not found in the checkout documentation at head");
          } else if (row.notes.includes("documentation-pending-mixed-target")) {
            parts.push("names both PR metadata and a checkout document; neither source alone confirms it");
          } else {
            parts.push("no code/test predicate can observe it at head");
            if (row.notes.includes("external-state-ci-unavailable")) {
              parts.push("exact-head CI state was not observed during this review");
            } else {
              const ci = row.notes.find((note) => note.startsWith("external-state-ci:"));
              if (ci !== undefined) parts.push(`known exact-head CI state: \`${cleanSource(ci.slice("external-state-ci:".length))}\``);
            }
          }
          const provenance = row.notes.find((note) => note.startsWith("provenance:"));
          if (provenance !== undefined) {
            const source = cleanSource(provenance.slice("provenance:".length));
            parts.push(source === "linked_issues" ? "from the linked issue, unconditionally in scope" : `from ${source}`);
          }
          const why = row.reason !== "" ? `: ${row.reason}` : "";
          return `- \`${cleanRequirementId(row.requirement_id)}\` — ${pendingDomain(row)} (${parts.join("; ")})${why}`;
        };
        const items = pending.slice(0, MAX_RENDERED_ROWS).map(pendingLine);
        if (pending.length > MAX_RENDERED_ROWS) items.push(`- …and ${pending.length - MAX_RENDERED_ROWS} more`);
        return `### Non-code criteria (advisory — not blocking)\nThese ${pending.length} requirement(s) are outside the code/test proof domain, so they are reported for awareness and do not withhold approval:\n\n${items.join("\n")}`;
      })();

  const combined = [blockingSection, pendingSection].filter((section) => section !== "").join("\n\n");
  if (combined === "") return "";
  return `\n\n${combined}`;
}

export interface RequirementTraceEnforcementResult {
  applied: boolean;
  trace: RequirementTraceArtifact;
}

/**
 * Apply requirement-trace enforcement to the artifact in place: validate the
 * trace and — when any in-scope requirement is unverifiable or untraced —
 * record that traceability gap separately and escalate `required_checks` to
 * `incomplete` (never relaxing an already-incomplete status from the
 * must_check pass). Run this AFTER `applyRequiredCheckValidation` (whose
 * unconditional write would otherwise clobber the escalation) and BEFORE the
 * verdict mapping (strict or findings_severity_gated) that reads
 * `required_checks`/`findings`. No-op when disabled or the ledger has no
 * in-scope requirements.
 *
 * #1095: this pass never SYNTHESIZES findings. A `unmet` row is the model's
 * own violation claim; the model's prompt contract obliges it to file the
 * matching finding itself. Fabricating a blocking major from the ledger text
 * alone promoted process/risk rows the reviewer had declined to flag into
 * CHANGES_REQUESTED on a defect-free PR (miso-gallery#543, review
 * 5549785027): three "requirement not enforced" majors, zero code defects.
 * An unmet the model substantiated with its own finding still blocks through
 * that finding; an unsubstantiated unmet keeps `required_checks=incomplete`
 * (no clean approval — #874) and is disclosed in the rendered trace section
 * instead. */
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
    /** #1062 trusted PR description (title + body) at head — the only source a
     * `documentation`-domain row may be positively confirmed against. */
    prBody?: string | null | undefined;
    /** #1062 review follow-up: the CI gate's exact-head conclusion, if this run
     * observed one — diagnostic-only text surfaced in the non-code advisory. */
    ciState?: string | null | undefined;
    /** #1044: the bounded #959 repair-pass summary for this run, when the
     * trace feature is enabled — threaded through to
     * `validateRequirementTrace`. */
    traceRepair?: RequirementTraceRepairOutcome | undefined;
  },
): RequirementTraceEnforcementResult {
  if (!options.enabled) {
    return { applied: false, trace: { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] } };
  }
  const trace = validateRequirementTrace(artifact.requirement_coverage, options.ledger, options.workspace, options.changed, {
    ownership: options.ownership,
    paths: options.paths,
    prBody: options.prBody,
    ciState: options.ciState,
    traceRepair: options.traceRepair,
  });
  if (trace.rows.length === 0) {
    return { applied: false, trace };
  }
  if (trace.incomplete) artifact.requirement_trace_incomplete = true;
  if (trace.incomplete && artifact.required_checks !== "incomplete") {
    artifact.required_checks = "incomplete";
  }
  const rendered = renderRequirementTraceMarkdown(trace);
  if (rendered !== "") {
    artifact.review_markdown = `${String(artifact.review_markdown ?? "")}${rendered}`;
  }
  return { applied: true, trace };
}

/**
 * #1145: the exact note set that marks a confirmed-unmet row. A note lands
 * here only when a DETERMINISTIC PROOF PREDICATE RAN AGAINST THE CHECKOUT AT
 * HEAD AND FAILED — the validator itself refutes the requirement, so reading
 * more code cannot change the outcome (contrast with the coverage-gap notes,
 * where the reviewer can still re-cite a valid location):
 *
 * - `enforcement-location-copies-without-comparing` (#854): the cited
 *   enforcement location exists at head and was read; it contains no
 *   comparison against any of the requirement's derived terms. Copying a
 *   value into a field is not enforcing the requirement.
 * - `structural-proof-unconfirmed` (#985): the requirement's structural-state
 *   claim was re-derived from the cited file at head and the predicate did
 *   not hold (the state the requirement demands is not the state at head).
 *
 * Deliberately EXCLUDED (repair-territory coverage gaps, never refutations):
 * `not-traced-by-reviewer` / `trace-repair-ran-no-claims` (no claim at all),
 * `disposition-invalid` / `missing-reason` (malformed claim),
 * `downgraded-no-valid-enforcement-location` /
 * `downgraded-no-valid-test-location` / `structural-citation-line-out-of-range`
 * (the citation itself failed validation — a different location may be valid),
 * `distributed-enforcement-group-uncovered:*` /
 * `distributed-test-group-uncovered:*` / `distributed-test-location-uncovered`
 * (a seam went unmapped), `distributed-topology-overflow` (config shape).
 * Rows outside `unverifiable` are excluded by the disposition filter:
 * `met`/`not_applicable` are settled, `pending` is the non-code advisory
 * (#1062), and a model-claimed `unmet` is a known gap the reviewer must
 * substantiate with its own finding (#1095) — it is never escalated from the
 * ledger text alone, even though the validator could not refute it.
 */
export const CONFIRMED_UNMET_REFUTATION_NOTES: readonly string[] = [
  "enforcement-location-copies-without-comparing",
  "structural-proof-unconfirmed",
];

export function confirmedUnmetRows(trace: RequirementTraceArtifact): RequirementTraceRow[] {
  return trace.rows.filter((row) =>
    row.disposition === "unverifiable"
    && row.notes.some((note) => CONFIRMED_UNMET_REFUTATION_NOTES.includes(note)),
  );
}

/** #1145: cap on the synthesized confirmed-unmet findings (one per refuted
 * requirement, up to this many — beyond that the markdown note carries the
 * total count). */
export const MAX_CONFIRMED_UNMET_FINDINGS = 5;

/**
 * #1145: confirmed-unmet → request_changes escalation.
 *
 * Where `applyRequirementTraceEnforcement` records the traceability gap
 * (required_checks=incomplete) WITHOUT synthesizing findings (#1095), this
 * pass escalates the one case the validator has positively refuted: a row
 * whose disposition is `unverifiable` and whose notes carry a
 * confirmed-unmet refutation note. It is allowed to synthesize findings
 * because the refutation is deterministic proof, not a model claim — the
 * #1095 prohibition (never fabricate a blocker from the ledger text alone)
 * is what this boundary enforces by construction.
 *
 * Effects on the artifact (in place):
 * - up to `MAX_CONFIRMED_UNMET_FINDINGS` new `blocker` findings
 *   (category `requirements`), each at the row's first (valid) enforcement
 *   location, whose message never borrows the model-claim wording
 *   "requirement not enforced: " — it states the deterministic refutation;
 * - a single italic one-line disclosure appended to `review_markdown`
 *   (the published body), naming the escalated count;
 * - `verdict` flipped `approve` → `request_changes` with
 *   `verdict_source: "enforcement"` (the deterministic provenance label the
 *   #811/#978 degrade gate reads; a model that already returned
 *   request_changes is left untouched).
 *
 * Ordering contract: run AFTER `applyRequirementTraceEnforcement` and
 * BEFORE the verdict mapping/relaxers and `applyAllEnforcement`. The
 * relaxers all refuse to re-approve once a trace gap exists
 * (`requirement_trace_incomplete` is true by construction here) or an open
 * non-verification blocker exists, so the flip is stable; the strict
 * mapping (#811) independently reaches request_changes through the
 * synthesized blockers, so the same call site works in both policy branches.
 * Returns the number of confirmed-unmet rows (0 = no-op).
 */
export function applyConfirmedUnmetEscalation(
  artifact: ReviewArtifact,
  trace: RequirementTraceArtifact,
  requirementTexts: ReadonlyMap<string, string>,
): number {
  const rows = confirmedUnmetRows(trace);
  if (rows.length === 0) return 0;
  const findings = Array.isArray(artifact.findings) ? artifact.findings : [];
  for (const row of rows.slice(0, MAX_CONFIRMED_UNMET_FINDINGS)) {
    const id = row.requirement_id.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, MAX_RENDERED_ID_CHARS);
    const text = (requirementTexts.get(row.requirement_id) ?? "")
      .replace(/[\x00-\x1f\x7f]/g, " ").trim()
      .slice(0, 200);
    const location = row.enforcement[0];
    const refutation = row.notes.includes("structural-proof-unconfirmed")
      ? "the cited repository state at head does not satisfy it"
      : "the cited enforcement location copies the value without comparing it — nothing in the change enforces it";
    const message = `Confirmed-unmet requirement ${id}: ${refutation}`
      + (text !== "" ? ` — “${text}”` : "")
      + ".";
    findings.push({
      severity: "blocker",
      category: "requirements",
      file: location !== undefined ? location.file : null,
      line: location !== undefined ? location.line : null,
      message,
    });
  }
  artifact.findings = findings;
  artifact.review_markdown = `${String(artifact.review_markdown ?? "")}`
    + `\n\n_${rows.length} in-scope requirement(s) are confirmed unmet by deterministic repository-state proof; the verdict is escalated to request changes._`;
  if (artifact.verdict === "approve") {
    artifact.verdict = "request_changes";
    artifact.verdict_source = "enforcement";
  }
  return rows.length;
}
