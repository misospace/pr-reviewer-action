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
import { workspaceRegularFile, workspaceFsPath } from "../context/workspace-path.js";
import { isTestPath } from "../context/change-anchors.js";

export const TRACE_DISPOSITIONS: readonly string[] = ["met", "unmet", "not_applicable", "unverifiable"];

export const MAX_TRACE_LOCATIONS = 5;
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

/** #935: the text a change touches: changed file paths plus the added and
 * removed diff lines, lowercased, for the subject test below. */
export function changedSubjectText(diff: string, files: readonly string[]): string {
  const lines = diff.split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => line.slice(1));
  return [...files, ...lines].join("\n").toLowerCase();
}

/** A requirement's subject is touched when the changed text contains one of
 * its multi-word terms, or at least two of its single-word terms (joined
 * forms like `sourceSha` / `source_sha` count). Bounded heuristic, like
 * `enforcementPredicateFound`. */
function subjectTouched(text: string, changed: string): boolean {
  const variants = (term: string): string[] => [term, term.replace(/ /g, ""), term.replace(/ /g, "_"), term.replace(/ /g, "-")];
  const hits = extractRequirementTerms(text).filter((term) => variants(term).some((v) => changed.includes(v)));
  if (hits.some((term) => term.includes(" "))) return true;
  return new Set(hits).size >= 2;
}

export interface RequirementTraceScope {
  inScope: TracedLedgerEntry[];
  outOfScope: { entry: TracedLedgerEntry; reason: string }[];
}

/** #935: which requirements the trace demands. A linked-issue requirement
 * (what the PR was asked to deliver, #874), an entry without provenance, and
 * any requirement whose subject the change touches are in scope; a
 * standards / PR-body / harness requirement the change never touches is out
 * of scope and is dispositioned `not_applicable` with a reason. Without
 * changed text every entry stays in scope (fail closed). */
export function requirementTraceScope(ledger: unknown, changed?: string): RequirementTraceScope {
  const scope: RequirementTraceScope = { inScope: [], outOfScope: [] };
  for (const { entry, sources } of ledgerTraceCandidates(ledger)) {
    if (changed === undefined || sources === null || sources.includes("linked_issues") || subjectTouched(entry.text, changed)) {
      scope.inScope.push(entry);
    } else {
      scope.outOfScope.push({
        entry,
        reason: `out of scope: from ${[...new Set(sources)].join("/")}, and none of its subject terms appear in the changed files or lines`,
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
): RequirementTraceArtifact {
  const { inScope, outOfScope } = requirementTraceScope(ledger, changed);
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
        // Full trace required: a valid enforcement location AND a valid
        // test location (one in a real test/fixture file, per isTestPath) —
        // either missing downgrades on its own, and both notes can apply.
        if (!anyLocationValid(enforcement, cache)) {
          disposition = "unverifiable";
          notes.push("downgraded-no-valid-enforcement-location");
        }
        if (!anyTestLocationValid(test, cache)) {
          disposition = "unverifiable";
          notes.push("downgraded-no-valid-test-location");
        }
        if (disposition === "met") {
          // Location existence is not enforcement proof (#854: the cited
          // line existed and even named the field, but only copied it).
          // Require a predicate — comparison/guard/assertion/match — near
          // one of the requirement's key terms at one of the valid
          // enforcement locations.
          const terms = extractRequirementTerms(entry.text, symbol);
          const validEnforcementLocations = enforcement.filter((loc) => locationValid(loc, cache));
          if (!enforcementPredicateFound(validEnforcementLocations, terms, cache)) {
            disposition = "unverifiable";
            notes.push("enforcement-location-copies-without-comparing");
          }
        }
      }
    }

    // #874 maintainer follow-up: a well-formed `unmet` is a KNOWN gap, not
    // an untraceable one — it must stop coverage too (`required_checks=
    // incomplete`), so #878's publication guard withholds approval under
    // every verdict policy. The synthesized major finding alone reaches the
    // non-strict verdict mapping too late to matter (strict maps after this
    // pass; findings_severity_gated/model map before it).
    if (disposition === "unverifiable" || disposition === "unmet") incomplete = true;

    rows.push({ requirement_id: entry.id, disposition, enforcement, test, reason, notes });
  }

  // #935: an out-of-scope requirement is grounded not_applicable and never
  // makes coverage incomplete, unless the reviewer itself reports it unmet.
  for (const { entry, reason } of outOfScope) {
    const claim = claimsById.get(entry.id);
    const claimedUnmet = typeof claim?.disposition === "string" && claim.disposition.toLowerCase() === "unmet" && capReason(claim.reason) !== "";
    if (claimedUnmet) {
      incomplete = true;
      rows.push({ requirement_id: entry.id, disposition: "unmet", enforcement: parseLocations(claim!.enforcement), test: parseLocations(claim!.test), reason: capReason(claim!.reason), notes: ["out-of-scope-reported-unmet"] });
    } else {
      rows.push({ requirement_id: entry.id, disposition: "not_applicable", enforcement: [], test: [], reason, notes: ["out-of-scope"] });
    }
  }

  return { version: ARTIFACT_VERSION, rows, incomplete, errors };
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
 */
export function renderRequirementTraceMarkdown(trace: RequirementTraceArtifact): string {
  const notable = trace.rows.filter((row) => row.disposition === "unmet" || row.disposition === "unverifiable");
  if (notable.length === 0) return "";
  const lines = notable.slice(0, MAX_RENDERED_ROWS).map((row) => {
    const loc = row.enforcement[0] ? `\`${row.enforcement[0].file}:${row.enforcement[0].line}\`` : "no valid enforcement location";
    const reason = row.reason !== "" ? `: ${row.reason}` : "";
    return `- \`${row.requirement_id}\` — **${row.disposition}** (${loc})${reason}`;
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
 * untraced — escalate `required_checks` to `incomplete` (never relaxing an
 * already-incomplete status from the must_check pass). Run this AFTER
 * `applyRequiredCheckValidation` (whose unconditional write would otherwise
 * clobber the escalation) and BEFORE the verdict mapping (strict or
 * findings_severity_gated) that reads `required_checks`/`findings`. No-op
 * when disabled or the ledger has no in-scope requirements.
 */
export function applyRequirementTraceEnforcement(
  artifact: ReviewArtifact,
  options: { enabled: boolean; ledger: unknown; workspace: string; changed?: string | undefined },
): RequirementTraceEnforcementResult {
  if (!options.enabled) {
    return { applied: false, trace: { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] }, findingsAdded: 0 };
  }
  const trace = validateRequirementTrace(artifact.requirement_coverage, options.ledger, options.workspace, options.changed);
  if (trace.rows.length === 0) {
    return { applied: false, trace, findingsAdded: 0 };
  }
  const findingsAdded = ensureUnmetRequirementFindings(artifact, trace, options.ledger);
  if (trace.incomplete && artifact.required_checks !== "incomplete") {
    artifact.required_checks = "incomplete";
  }
  const rendered = renderRequirementTraceMarkdown(trace);
  if (rendered !== "") {
    artifact.review_markdown = `${String(artifact.review_markdown ?? "")}${rendered}`;
  }
  return { applied: true, trace, findingsAdded };
}
