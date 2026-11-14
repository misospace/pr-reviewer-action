/**
 * #1657: bounded objective evidence receipts — the deterministic provenance
 * layer that replaces the #1627/#1634 call-ID citation gate.
 *
 * The #1627 gate treated an executed call ID plus argument-token overlap as
 * consumable proof of a `satisfied` must_check answer. That conflated three
 * things this module now separates:
 *
 * 1. WHAT THE RUN ACQUIRED — objective facts, derivable only from records the
 *    run itself wrote (the harness `tool_calls`/`tool_results` trace, the
 *    assembler-certified corpus diff payloads, the CI gate's head-bound
 *    evidence). Each acquisition becomes a bounded EVIDENCE RECEIPT carrying
 *    only objective fields: evidence kind, source/path/range or CI/upstream
 *    identity, acquisition status, complete/truncated state, freshness, and
 *    trust scope. No model prose, no tool result bodies.
 * 2. WHAT THE RUN CAN PROVE — deterministic validation of those objective
 *    fields against a requirement. A receipt supports a requirement only when
 *    its own validated identity matches (kind-appropriate exact boundaries —
 *    the hardened #1634 matchers are re-used verbatim), the acquisition
 *    actually succeeded and was not truncated, and the receipt's freshness
 *    scope reaches the requirement (an exact-head requirement is discharged
 *    only by head-bound evidence). An unrelated receipt — one that carries
 *    none of the requirement's identity — never contributes, whatever the
 *    model cites.
 * 3. WHAT ONLY THE REVIEWER CAN JUDGE — semantic conclusions. A receipt
 *    proves an acquisition happened; it never proves a semantic conclusion
 *    ("the code is correct"). A tool call ID or argument overlap is therefore
 *    never itself semantic proof, and one receipt may support several
 *    independent conclusions — there is deliberately NO allocation and NO
 *    one-call-per-row rule (#1657 removes the #1634 allocator): receipts are
 *    shareable evidence, not consumable tokens.
 *
 * Row classes are TRUSTED PRODUCER METADATA, never inferred from prose
 * (#1657 review): the classifier tags each row it emits — `attention`
 * (the P0/P1 "treat as critical/high priority — verify …
 * thoroughly/carefully" rows: attention/routing signals, never gating),
 * `objective` (rows mapping to a concrete deterministic gate, tagged WITH
 * an explicit gate kind: `ci-evidence` for test-run asks — settled ONLY by
 * the #1594/#1612 head-bound CI reconciliation; `dependency-evidence` for
 * upstream provenance/release-delta/security-advisory acquisition asks;
 * `source-identity` for rows the producer binds to exact
 * path/version/head/slug identities), and `review-prompt` (ordinary
 * semantic review questions: honored without a receipt demand, disclosed
 * with reason codes, never independently making an adequate review
 * partial or forcing a verdict). Rows the producer did not tag are
 * `legacy` and keep pre-#1657 semantics: they gate completeness, fold on
 * the presence-and-shape rule, and an `unmet` one still forces — a
 * dynamic/hand-written check can never become non-gating because its
 * wording happens to look like a review prompt. Identity extraction from
 * text runs only AFTER a row is explicitly objective, solely to validate
 * the tagged identity against receipts.
 *
 * Fail-closed rules carried over from #1627/#1634 where they still guard an
 * objective claim: a trace PRESENT but malformed refuses the whole ledger
 * (`refused` — objective satisfaction is impossible behind a trace this
 * runtime cannot verify, never silently downgraded to "no loop"); the trace
 * list is bounded by prefix truncation so the positional `call-<n>` ids keep
 * their exact alignment. Without a ledger the receipt gate is INERT —
 * satisfaction folds on the pre-#1627 presence-and-shape rule — but trusted
 * producer tags still govern which rows are merge-affecting (tagged
 * review-prompt/attention rows are non-gating; only untagged `legacy` rows
 * retain the old gating behavior). On an active ledger a claimed `satisfied`
 * objective row is credited only by VALIDATED RECEIPTS — never by a cited
 * call id, and never repaired from model prose. Malformed or stale
 * provenance stays reason-coded.
 */
import { type HeadBoundCiEvidence } from "./required-check-ci.js";
import { corpusDiffCoveredFiles } from "../tools/coverage.js";
import { dependencyEvidenceObligationsForCall, type DependencyEvidenceObligation } from "../tools/dependency-evidence.js";

export type { DependencyEvidenceObligation };

/** The single source of the stable short-id scheme: `call-<n>`, 1-based
 * execution order — the exact tokens the verdict corpus renders (#1627's
 * scheme, kept: the corpus/trace alignment must not move under #1657). */
export function executedCallId(position: number): string {
  return `call-${position}`;
}

/** Hard ceiling on the trace-derived receipts (the loop budget bounds real
 * runs far below this; the cap keeps a tampered or pathological artifact
 * bounded). Carried over from #1627 unchanged. */
export const MAX_EXECUTED_CALL_INDEX = 200;

/** Bounds on the derived (non-trace) receipt classes. */
export const MAX_CORPUS_DIFF_RECEIPTS = 50;
export const MAX_CI_RECEIPTS = 50;
export const MAX_RECEIPT_PATHS = 10;
/** Bounded subject fields (UTF-16 code units, what `String#length` measures). */
export const MAX_RECEIPT_FIELD_LENGTH = 512;

/** Objective evidence kinds a receipt can carry. `discovery` receipts prove
 * enumeration happened, never content; `command` receipts prove an
 * allowlisted command ran — neither supports any requirement. */
export type EvidenceReceiptKind =
  | "source-read"
  | "corpus-diff"
  | "ci-check"
  | "web-fetch"
  | "web-search"
  | "discovery"
  | "command";

/** What the receipt's acquisition can support: `content` receipts (real
 * workspace/forge/corpus reads of a subject) support objective requirements;
 * `acquisition` receipts (web documents) support the dependency-evidence
 * gate; `discovery`/`command` receipts support nothing (#810's narrow read
 * rule is the precedent — a listing is not a read). */
export type EvidenceCapability = "content" | "acquisition" | "discovery" | "command";

/** Trust scope: where the acquisition's bytes came from. */
export type EvidenceTrustScope = "workspace" | "corpus-certified" | "forge" | "web" | "ci-gate";

/** Freshness: `head-bound` receipts were acquired against the exact reviewed
 * head (workspace reads of the exact-head checkout, byte-exact corpus diff
 * chunks, CI evidence pinned to the reviewed head, forge reads carrying the
 * reviewed sha). `unbound` receipts observed some other state (upstream web
 * documents, forge reads at an unpinned ref) — they never satisfy an
 * exact-head requirement. */
export type EvidenceFreshness = "head-bound" | "unbound";

export interface EvidenceReceiptSubject {
  path?: string;
  paths?: string[];
  repo?: string;
  url?: string;
  query?: string;
  ref?: string;
  checkName?: string;
  /** Dependency-evidence attribution of a web receipt's target (#1379's
   * URL/query-shape rules, one shared implementation). */
  obligations?: DependencyEvidenceObligation[];
}

export interface EvidenceReceipt {
  /** Stable id: `call-<n>` for trace receipts (the corpus-rendered id),
   * `corpus-diff:<path>` for corpus credit, `ci:<check name>` for CI rows. */
  id: string;
  kind: EvidenceReceiptKind;
  capability: EvidenceCapability;
  /** Acquisition status: an executor `ok` (or, for CI rows, a settled green
   * conclusion). A failed/errored acquisition is recorded, never credited. */
  acquired: boolean;
  /** Complete vs truncated: the executor's own `truncated` flag; corpus-diff
   * receipts are complete by the #921 byte-exact rule. */
  complete: boolean;
  freshness: EvidenceFreshness;
  trust: EvidenceTrustScope;
  subject: EvidenceReceiptSubject;
}

/** The ledger's own state:
 * - `unavailable` — no executed-call trace (fresh standard-call and fork
 *   paths): the receipt gate is INERT and every fold keeps its pre-#1627
 *   semantics byte-for-byte;
 * - `refused` — a trace was PRESENT but malformed: the gate is ACTIVE with
 *   nothing usable, so no objective satisfaction can discharge behind a
 *   trace this runtime cannot verify (#1634's fail-closed rule, carried
 *   over); distinct from `unavailable`, never silently conflated with it;
 * - `valid` — a parsed, bounded ledger. */
export type EvidenceLedgerState = "unavailable" | "refused" | "valid";

export interface EvidenceLedger {
  state: EvidenceLedgerState;
  receipts: EvidenceReceipt[];
}

export interface EvidenceLedgerInput {
  /** The enforcement harness artifact's `tool_calls` trace ({tool, args,
   * status} entries in execution order, written by summarizeLoopOutcome). */
  toolCalls?: unknown;
  /** The index-aligned `tool_results` executor records (status + result
   * bodies with their own `truncated` flags). Required whenever toolCalls is
   * present: acquisition/completeness are validated against the executor's
   * own records, never inferred. */
  toolResults?: unknown;
  /** Assembler-certified corpus diff payloads (pr.diff(.smart).corpus-section.txt). */
  certifiedDiffPayloads?: readonly string[];
  /** The raw `pr.diff` the corpus chunks are verified against. */
  rawDiff?: string | null;
  /** Candidate repository paths eligible for corpus-diff credit. */
  candidatePaths?: readonly string[];
  /** The CI gate's head-bound evidence (null/absent = no CI receipts). */
  ciEvidence?: HeadBoundCiEvidence | null;
  /** The exact head this review is bound to. */
  reviewedHeadSha?: string;
}

function boundedField(value: unknown, max: number = MAX_RECEIPT_FIELD_LENGTH): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normRelPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function boundedPath(value: unknown): string {
  return boundedField(normRelPath(value));
}

// ---------------------------------------------------------------------------
// Identity extraction and boundary matching (moved verbatim from the
// #1627/#1634 `executed-calls.ts` — six review rounds of hardened exact-
// identity semantics, re-used by #1657 against receipt subject fields
// instead of raw argument digests).
// ---------------------------------------------------------------------------

/** `owner/repo` slug in a check text: both segments GitHub-name-shaped,
 * neither purely numeric/version-like, neither a stopword. */
const REPO_SLUG_RE = /\b([0-9a-z][0-9a-z_-]*(?:\.[0-9a-z][0-9a-z_-]*)*)\/([0-9a-z][0-9a-z_-]*(?:\.[0-9a-z][0-9a-z_-]*)*)\b/gi;
const SLUG_STOPWORDS: ReadonlySet<string> = new Set([
  "and", "or", "not", "the", "of", "to", "in", "on", "for", "with", "at", "by", "from",
]);

/** Exact version token (x.y.z with optional pre-release/build suffix). The
 * run is the FULL dotted-numeric run, ATOMIC on its boundaries (#1634
 * re-review rounds 4–6): every interior backtrack point is boundary-dirty,
 * so a version-shaped run the extractor cannot represent exactly yields NO
 * token rather than a truncating prefix. */
const EXACT_VERSION_RE = /\bv?(?<![0-9]\.)(\d+(?:\.\d+){2,}(?:[-+][0-9a-z.-]*[0-9a-z])?)(?![0-9a-z_+-]|\.\d)/gi;

/** The version-shaped dotted-numeric runs the extractor is accountable for;
 * an uncovered run refuses the row's identity (fail closed, never an
 * approximation). */
const VERSION_SHAPED_RUN_RE = /\d+(?:\.\d+){2,}/g;

/** Exact head/commit sha: full 40- or 64-hex, word-bounded. Short shas are
 * deliberately NOT identity (a 7-hex run collides with ordinary words). */
const HEAD_SHA_RE = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gi;

/** Repository-relative path token: dot-extension-anchored, so it can only
 * be a file the check text names by name, never prose. */
const FILE_PATH_RE = /\b[a-z0-9_][a-z0-9_.-]*(?:\/[a-z0-9_.-]+)*\.(?:tsx?|mts|cts|mjs|cjs|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|md|json|ya?ml|toml|lock|txt|sh|sql|astro|vue|svelte)\b/gi;

/** URL scheme + host prefix, stripped before identity extraction so a
 * check that names a URL requires the same `owner/repo` identity a forge
 * endpoint carries — not the host. */
const URL_PREFIX_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*[a-z0-9-]+\.[a-z]{2,}\//gi;

/** The canonical identity key of a check text — the whitespace-normalized,
 * lowercased text both folds and this module derive a row's requirement
 * identity from. One function, one normalization. */
export function checkIdentityKey(check: string): string {
  return check.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The exact identity tokens (package slugs, versions, head shas, named
 * files) an explicitly-objective row's supporting receipts must carry for
 * the receipt to bear on the row (#1657 review: this extraction runs ONLY
 * after the producer has tagged the row objective — it validates an
 * objective identity against receipts, it never decides whether the row is
 * material). Lowercase; deduplicated. `null`/`[]` are not produced here
 * anymore — callers only invoke this for `source-identity` rows, and a
 * version-shaped run the extractor cannot represent exactly yields no token
 * rather than a truncating prefix (the deterministic layer never
 * approximates an identity it cannot represent).
 */
function requirementIdentityTokens(checkKey: string): string[] {
  const stripped = checkKey.replace(URL_PREFIX_RE, " ");
  const tokens = new Set<string>();
  for (const match of stripped.matchAll(REPO_SLUG_RE)) {
    const [owner, repo] = [match[1] ?? "", match[2] ?? ""];
    if (/^\d+(\.\d+)*$/.test(owner) || /^\d+(\.\d+)*$/.test(repo)) continue;
    if (SLUG_STOPWORDS.has(owner.toLowerCase()) || SLUG_STOPWORDS.has(repo.toLowerCase())) continue;
    tokens.add(`${owner}/${repo}`.toLowerCase());
  }
  const versionMatches = [...stripped.matchAll(EXACT_VERSION_RE)];
  for (const match of versionMatches) tokens.add((match[1] ?? match[0])!.toLowerCase());
  for (const run of stripped.matchAll(VERSION_SHAPED_RUN_RE)) {
    const start = run.index!;
    const end = start + run[0].length;
    if (!versionMatches.some((m) => m.index! <= start && end <= m.index! + m[0].length)) return [];
  }
  for (const match of stripped.matchAll(HEAD_SHA_RE)) tokens.add(match[0]!.toLowerCase());
  for (const match of stripped.matchAll(FILE_PATH_RE)) tokens.add(match[0]!.toLowerCase());
  return [...tokens];
}

const VERSION_TOKEN_SHAPE_RE = /^\d+(?:\.\d+){2,}(?:[-+][0-9a-z.-]+)?$/;
const HEAD_SHA_TOKEN_SHAPE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION_EXTEND_RE = /[0-9a-z_+-]/;
const SHA_EXTEND_RE = /[0-9a-z_]/;
const SEGMENT_EXTEND_RE = /[0-9a-z_.-]/;

function segmentBoundaryHolds(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1]!;
  const after = end === text.length ? "" : text[end]!;
  return !SEGMENT_EXTEND_RE.test(before) && !SEGMENT_EXTEND_RE.test(after);
}

function shaBoundaryHolds(text: string, start: number, end: number): boolean {
  const before = start === 0 ? "" : text[start - 1]!;
  const after = end === text.length ? "" : text[end]!;
  return !SHA_EXTEND_RE.test(before) && !SHA_EXTEND_RE.test(after);
}

function versionBoundaryHolds(text: string, start: number, end: number): boolean {
  const after = end === text.length ? "" : text[end]!;
  if (VERSION_EXTEND_RE.test(after)) return false;
  if (after === "." && end + 1 < text.length && /\d/.test(text[end + 1]!)) return false;
  const before = start === 0 ? "" : text[start - 1]!;
  if (before === "" || !SHA_EXTEND_RE.test(before)) return true;
  return before === "v" && (start - 1 === 0 || !SHA_EXTEND_RE.test(text[start - 2]!));
}

/** Whether a receipt's identity string carries `token` as an EXACT identity:
 * boundary-delimited under the identity kind the token was extracted as
 * (version/SHA under their kind-specific boundary alone — authoritative;
 * slug/path under the segment boundary). A token that appears only inside a
 * longer identity is NOT carried. */
function identityCarriesToken(identity: string, token: string): boolean {
  if (identity === "" || token === "") return false;
  const haystack = identity.toLowerCase();
  const needle = token.toLowerCase();
  const asVersion = VERSION_TOKEN_SHAPE_RE.test(needle);
  const asSha = HEAD_SHA_TOKEN_SHAPE_RE.test(needle);
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    if (asVersion) {
      if (versionBoundaryHolds(haystack, at, end)) return true;
    } else if (asSha) {
      if (shaBoundaryHolds(haystack, at, end)) return true;
    } else if (segmentBoundaryHolds(haystack, at, end)) {
      return true;
    }
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Row evidence metadata (#1657 review): row class is TRUSTED PRODUCER
// METADATA, never inferred from prose. The classifier tags each row it
// emits (attention / objective-with-gate / review-prompt); rows without
// trustworthy metadata are `legacy` and keep pre-#1657 gating semantics.
// Identity extraction from text runs only AFTER a row is explicitly
// objective, solely to validate an objective identity against receipts —
// it never decides whether the row is material.
// ---------------------------------------------------------------------------

export type RequiredEvidenceRowClass = "attention" | "objective" | "review-prompt" | "legacy";
export type EvidenceGateKind = "ci-evidence" | "dependency-evidence" | "source-identity";

/** The trusted evidence tag a check producer declares for one row at
 * emission time. Attention rows carry no gate (they are attention signals,
 * not propositions); review-prompt rows carry no gate (semantic review
 * questions); objective rows carry an explicit gate kind, and — for
 * `dependency-evidence` — the obligation kinds the row asks to acquire. */
/** #1657 (review round 3): ONE trusted dependency update identity the
 * producer parsed into a row's scope — the exact dependency slug plus the
 * exact version tokens carried by the CHANGED dependency lines that
 * introduced it (the trustworthy old→new identity where the diff shape
 * carries one; empty where it does not). */
export interface DependencyScopeEntry {
  slug: string;
  versions: string[];
}

/** The producer's dependency-scope parse result: either the COMPLETE
 * trustworthy identity set, or unavailable — the producer could not
 * establish it completely (unattributable changed lines, cap overflow,
 * truncated scan). `available: false` is its own state, never conflated
 * with "no dependencies changed"; both fail closed at the receipt seam. */
export type DependencyScopeResult =
  | { available: true; entries: DependencyScopeEntry[] }
  | { available: false };

const DEPENDENCY_SCOPE_MAX_ENTRIES = 20;
const DEPENDENCY_SCOPE_MAX_ENTRY_VERSIONS = 16;
const DEPENDENCY_SCOPE_SLUG_RE = /^[a-z0-9@/._-]{1,214}$/;
/** Exact version tokens only — the same shape `identityCarriesToken`
 * treats as a version identity (x.y.z with optional -suffix), so a
 * recorded version is checkable against receipts and a partial numeric
 * run never stands in for one. */
const DEPENDENCY_SCOPE_VERSION_RE = /^\d+(?:\.\d+){2,}(?:[-+][0-9a-z.-]+)?$/;

/** Strict shape check for one persisted dependency-scope entry
 * (`{slug, versions}`); hostile slug shapes (traversal dots, option-like
 * leads) and non-exact version tokens are refused, never half-trusted. */
function dependencyScopeEntryFromArtifact(value: unknown): DependencyScopeEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "slug" && key !== "versions") return null;
  }
  const slug = record.slug;
  if (typeof slug !== "string" || !DEPENDENCY_SCOPE_SLUG_RE.test(slug)
    || slug.includes("..") || slug.startsWith(".") || slug.startsWith("-")) return null;
  const versions: string[] = [];
  if (record.versions !== undefined) {
    if (!Array.isArray(record.versions) || record.versions.length > DEPENDENCY_SCOPE_MAX_ENTRY_VERSIONS) return null;
    for (const version of record.versions) {
      if (typeof version !== "string" || !DEPENDENCY_SCOPE_VERSION_RE.test(version)) return null;
      versions.push(version);
    }
  }
  return { slug, versions };
}

/** Strict parser for a tag's persisted `dependency_scope` — the COMPLETE
 * trusted entry set or nothing. A row whose scope does not parse is
 * DROPPED to `legacy` (fail closed), never partially trusted. */
export function dependencyScopeEntriesFromArtifact(value: unknown): DependencyScopeEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DEPENDENCY_SCOPE_MAX_ENTRIES) return null;
  const entries: DependencyScopeEntry[] = [];
  for (const raw of value) {
    const entry = dependencyScopeEntryFromArtifact(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

export interface CheckEvidenceTag {
  rowClass: "attention" | "objective" | "review-prompt";
  gate: EvidenceGateKind | null;
  /** The dependency-evidence obligation kinds an objective
   * `dependency-evidence` row asks to acquire (validated per kind against
   * the ledger's attributed acquisition receipts). */
  obligations: DependencyEvidenceObligation[];
  /** #1657 (review round 3): the TRUSTED dependency update identity scope
   * the producer parsed for this row — the COMPLETE set of dependency
   * updates the PR's diff actually changes (exact slugs, plus the exact
   * old→new version identity where the diff shape carries one), extracted
   * ONLY from producer-recognized dependency surfaces. A receipt backs the
   * row only when, for every obligation kind the row demands, the
   * validated receipts JOINTLY cover EVERY entry — slug as an EXACT
   * identity (never a substring), and the changed version identity for the
   * kinds that assert the update itself. An acquisition about dependency B
   * can never back dependency A's row, and evidence for one package can
   * never satisfy an aggregate row naming several. ABSENT/EMPTY means the
   * producer could not establish the identity set completely: the row
   * FAILS CLOSED — no kind-only or partial-scope evidence ever credits
   * it. */
  dependencyScope: DependencyScopeEntry[];
}

export interface CheckEvidenceTagWithText extends CheckEvidenceTag {
  /** The exact deterministic check text the tag belongs to (matched by the
   * same identity normalization the folds use). */
  text: string;
}

/** Build the tag index both folds resolve row classes through: exact
 * normalized check text → tag. Rows the producer did not tag are ABSENT
 * from the index — absence means `legacy`, never a prose guess. */
export function evidenceTagIndex(tags: readonly CheckEvidenceTagWithText[] | undefined): Map<string, CheckEvidenceTag> {
  const index = new Map<string, CheckEvidenceTag>();
  for (const tag of tags ?? []) {
    if (typeof tag?.text !== "string") continue;
    index.set(checkIdentityKey(tag.text), { rowClass: tag.rowClass, gate: tag.gate, obligations: tag.obligations, dependencyScope: tag.dependencyScope });
  }
  return index;
}

/** The tag for one check text, or `null` when the producer did not tag it
 * (the row is `legacy`). */
export function evidenceTagFor(check: string, index: Map<string, CheckEvidenceTag> | undefined): CheckEvidenceTag | null {
  return index?.get(checkIdentityKey(check)) ?? null;
}

// ---------------------------------------------------------------------------
// Ledger construction — receipts only from the run's own records.
// ---------------------------------------------------------------------------

/** The validated executor result envelope of one trace call (index-aligned
 * `tool_results`). */
interface TraceResultRecord {
  ok: boolean;
  truncated: boolean;
  result: Record<string, unknown> | null;
}

/** The executor's closed acquisition-status vocabulary: every result
 * envelope carries its own `status` and these are the only two outcomes the
 * executor produces (`executeToolRequest`). */
const TRACE_RESULT_STATUSES: ReadonlySet<string> = new Set(["ok", "error"]);

/**
 * Validate the aligned executor result for one trace call BEFORE any receipt
 * is constructed. The result envelope is the acquisition authority: a record
 * this runtime cannot read must REFUSE the whole ledger (`null`), never
 * manufacture acquisition state from the call trace. `tool_calls.status` is
 * only a display mirror the harness derives from this envelope with a silent
 * error fallback; trusting it for a malformed result would let the call
 * trace alone stand in as an `acquired: true` receipt. Refusals: a missing
 * entry, null/primitive/array, a missing or non-string `status`, a status
 * outside the closed vocabulary, or a present-but-malformed `truncated` flag
 * (only an actual boolean states completeness — an object or string never
 * silently counts as false).
 */
function traceResultAt(results: readonly unknown[], index: number): TraceResultRecord | null {
  const raw = results[index];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.status !== "string" || !TRACE_RESULT_STATUSES.has(record.status)) return null;
  if (record.truncated !== undefined && typeof record.truncated !== "boolean") return null;
  return { ok: record.status === "ok", truncated: record.truncated === true, result: record };
}

/** `owner/repo` from a forge API endpoint path: the two segments after
 * `repos/`, or the first two path segments when the endpoint addresses a
 * repository root. A shallower or deeper shape binds no repo identity. */
function forgeRepoFromEndpoint(endpoint: string): string {
  const path = endpoint.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment !== "");
  const reposAt = segments.indexOf("repos");
  if (reposAt !== -1 && segments.length >= reposAt + 3) {
    return `${segments[reposAt + 1]}/${segments[reposAt + 2]}`.toLowerCase();
  }
  if (segments.length === 2) return `${segments[0]}/${segments[1]}`.toLowerCase();
  return "";
}

/** Forge endpoints whose success proves something about repository CONTENT
 * at an identity; other endpoints (issues, workflows, metadata) carry
 * `metadata` capability and support nothing. */
const FORGE_CONTENT_ENDPOINT_RE = /\/(?:contents|commits|compare|tags|releases|blame)\b|\/contents(?:\/|$)/;

function receiptForTraceCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result: TraceResultRecord,
  reviewedHeadSha: string,
): EvidenceReceipt | null {
  const path = boundedPath(args.path);
  switch (tool) {
    case "read_file":
    case "git_blame": {
      if (path === "") return null;
      return {
        id, kind: "source-read", capability: "content", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "head-bound", trust: "workspace",
        subject: { path },
      };
    }
    case "git_grep": {
      const paths = new Set<string>();
      if (path !== "") paths.add(path);
      const inner = result.result?.result;
      const matches = inner !== null && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>).matches
        : undefined;
      if (Array.isArray(matches)) {
        for (const line of matches.slice(0, 200)) {
          if (typeof line !== "string") continue;
          const match = /^(.+?):[0-9]+:/.exec(line);
          if (match) {
            const matched = boundedPath(match[1]);
            if (matched !== "") paths.add(matched);
          }
        }
      }
      if (paths.size === 0) return null;
      return {
        id, kind: "source-read", capability: "content", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "head-bound", trust: "workspace",
        subject: { paths: [...paths].slice(0, MAX_RECEIPT_PATHS) },
      };
    }
    case "repo_contents": {
      if (path === "") return null;
      const isFile = result.result?.type === "file";
      return {
        id, kind: isFile ? "source-read" : "discovery", capability: isFile ? "content" : "discovery",
        acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "head-bound", trust: "workspace",
        subject: { path },
      };
    }
    case "find_files":
    case "list_tree":
    case "git_log": {
      const target = boundedField(args.pattern) || path || boundedField(args.endpoint);
      return {
        id, kind: "discovery", capability: "discovery", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "head-bound", trust: "workspace",
        subject: target !== "" ? { path: target } : {},
      };
    }
    case "read_skill": {
      if (path === "") return null;
      return {
        id, kind: "source-read", capability: "content", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "head-bound", trust: "workspace",
        subject: { path },
      };
    }
    case "gh_api": {
      const endpoint = boundedField(args.endpoint);
      if (endpoint === "") return null;
      const repo = boundedField(forgeRepoFromEndpoint(endpoint), 256);
      const ref = boundedField(args.ref, 128);
      const identity = [endpoint, ref].join(" ");
      const headBound = reviewedHeadSha !== ""
        && identityCarriesToken(identity, reviewedHeadSha.toLowerCase());
      return {
        id, kind: "source-read",
        capability: FORGE_CONTENT_ENDPOINT_RE.test(endpoint) ? "content" : "discovery",
        acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: headBound ? "head-bound" : "unbound",
        trust: "forge",
        subject: { ...(repo !== "" ? { repo } : {}), ...(ref !== "" ? { ref } : {}), url: endpoint.slice(0, MAX_RECEIPT_FIELD_LENGTH) },
      };
    }
    case "web_fetch": {
      const url = boundedField(args.url, 1024);
      if (url === "") return null;
      return {
        id, kind: "web-fetch", capability: "acquisition", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "unbound", trust: "web",
        subject: { url, obligations: dependencyEvidenceObligationsForCall(tool, args) },
      };
    }
    case "web_search": {
      const query = boundedField(args.query, 1024);
      if (query === "") return null;
      return {
        id, kind: "web-search", capability: "acquisition", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "unbound", trust: "web",
        subject: { query, obligations: dependencyEvidenceObligationsForCall(tool, args) },
      };
    }
    case "run_command": {
      return {
        id, kind: "command", capability: "command", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "head-bound", trust: "workspace",
        subject: {},
      };
    }
    default:
      // An unknown tool proves nothing this layer can name: recorded as
      // metadata-capability discovery, never credited.
      return {
        id, kind: "discovery", capability: "discovery", acquired: result.ok, complete: result.ok && !result.truncated,
        freshness: "unbound", trust: "workspace",
        subject: {},
      };
  }
}

/**
 * Build the evidence ledger from the run's own records (see the module
 * docstring). Strict: a PRESENT `tool_calls` trace whose shape this runtime
 * cannot parse — or whose aligned `tool_results` are missing or misaligned —
 * REFUSES the whole ledger (gate active, nothing usable); an absent or empty
 * trace is the ordinary no-native-loop case (`unavailable`). An over-cap
 * trace is bounded by PREFIX truncation so the 1-based positional ids keep
 * their exact alignment (#1627 m1, carried over). Never throws.
 */
export function buildEvidenceLedger(input: EvidenceLedgerInput): EvidenceLedger {
  const toolCalls = input.toolCalls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { state: "unavailable", receipts: [] };
  }
  const boundedCalls = toolCalls.length > MAX_EXECUTED_CALL_INDEX
    ? toolCalls.slice(0, MAX_EXECUTED_CALL_INDEX)
    : toolCalls;
  const toolResults = input.toolResults;
  if (!Array.isArray(toolResults) || toolResults.length < boundedCalls.length) {
    // The executor writes an index-aligned result per executed call; a
    // present trace without its aligned results cannot be validated —
    // refuse (fail closed), never infer acquisition state.
    return { state: "refused", receipts: [] };
  }
  const reviewedHeadSha = (input.reviewedHeadSha ?? "").toLowerCase();
  const receipts: EvidenceReceipt[] = [];
  for (let position = 0; position < boundedCalls.length; position++) {
    const entry = boundedCalls[position];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { state: "refused", receipts: [] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.tool !== "string" || record.tool === "" || typeof record.status !== "string") {
      return { state: "refused", receipts: [] };
    }
    const args = record.args !== null && typeof record.args === "object" && !Array.isArray(record.args)
      ? record.args as Record<string, unknown>
      : {};
    const result = traceResultAt(toolResults, position);
    if (result === null) {
      // An aligned result the runtime cannot read is evidence of nothing —
      // refuse the whole ledger before constructing any receipt.
      return { state: "refused", receipts: [] };
    }
    const receipt = receiptForTraceCall(executedCallId(position + 1), record.tool, args, result, reviewedHeadSha);
    if (receipt !== null) receipts.push(receipt);
  }
  // Corpus-diff credit receipts (#921's byte-exact rule): a path whose
  // complete head diff rode a certified corpus payload was IN the reviewer's
  // context — head-bound, complete by construction.
  const payloads = (input.certifiedDiffPayloads ?? []).filter((payload) => typeof payload === "string" && payload !== "");
  const rawDiff = typeof input.rawDiff === "string" ? input.rawDiff : null;
  const candidatePaths = (input.candidatePaths ?? []).filter((path) => typeof path === "string" && path !== "");
  if (payloads.length > 0 && rawDiff !== null && rawDiff !== "") {
    for (const payload of payloads) {
      for (const path of corpusDiffCoveredFiles(payload, rawDiff, candidatePaths)) {
        if (receipts.some((receipt) => receipt.id === `corpus-diff:${path}`)) continue;
        if (receipts.length >= MAX_EXECUTED_CALL_INDEX + MAX_CORPUS_DIFF_RECEIPTS + MAX_CI_RECEIPTS) break;
        receipts.push({
          id: `corpus-diff:${path}`, kind: "corpus-diff", capability: "content",
          acquired: true, complete: true, freshness: "head-bound", trust: "corpus-certified",
          subject: { path },
        });
      }
    }
  }
  // CI receipts: the gate's head-bound check rows, as objective acquisition
  // records. Satisfaction still flows ONLY through the #1612 reconciliation
  // (scope/identity rules live there); the receipts make the acquisition
  // state machine-readable for the #1656 disposition surface.
  const ci = input.ciEvidence ?? null;
  if (ci !== null) {
    for (const check of ci.checks.slice(0, MAX_CI_RECEIPTS)) {
      receipts.push({
        id: `ci:${check.name.slice(0, 100)}`, kind: "ci-check", capability: "acquisition",
        acquired: check.state === "success" && (check.conclusion === null || check.conclusion === "success"),
        complete: true,
        freshness: reviewedHeadSha !== "" && ci.headSha.toLowerCase() === reviewedHeadSha ? "head-bound" : "unbound",
        trust: "ci-gate",
        subject: { checkName: check.name },
      });
    }
  }
  return { state: "valid", receipts };
}

// ---------------------------------------------------------------------------
// Requirement evaluation (#1657): deterministic validation of a row's
// evidence state against the ledger. A receipt supports a requirement only
// when its validated objective fields match; receipts are shareable (no
// allocation); unrelated receipts never contribute.
// ---------------------------------------------------------------------------

/** Reason-coded provenance state of one row against the ledger (disclosed
 * on the coverage and obligation artifacts for the #1656 disposition
 * surface; never model text). */
export type RowEvidenceStateValue =
  | "not-required"      // review-prompt/attention row: no receipt demand.
  | "no-ledger"         // no executed-call trace: the gate is inert (pre-#1627 semantics).
  | "trace-refused"     // trace present but unparseable: nothing is verifiable (fail closed).
  | "receipt-backed"    // validated receipts jointly cover the requirement.
  | "receipt-absent"    // no receipt carries any of the requirement's identity/kind.
  | "receipt-mismatch"  // relevant receipts exist but none covers the requirement exactly.
  | "receipt-unverified"; // relevant receipts exist but are unacquired/incomplete/unbound.

export interface RowEvidenceState {
  rowClass: RequiredEvidenceRowClass;
  gate: EvidenceGateKind | null;
  state: RowEvidenceStateValue;
  /** The ids of the receipts that jointly support the requirement (bounded,
   * deterministic order). Empty unless `receipt-backed`. */
  receipts: string[];
}

const MAX_ROW_RECEIPT_IDS = 20;

/** #1657: the reason code a refused objective satisfaction carries, from
 * the row's validated evidence state. ONE mapping — the #750 completeness
 * fold and the #1381 obligation fold share it, so the same refused claim
 * carries the same reason code in both artifacts. */
export type ReceiptRefusalReason =
  | "trace-refused"
  | "receipt-unverified"
  | "receipt-mismatch"
  | "receipt-absent";

export function receiptRefusalReason(state: RowEvidenceState): ReceiptRefusalReason {
  switch (state.state) {
    case "trace-refused": return "trace-refused";
    case "receipt-unverified": return "receipt-unverified";
    case "receipt-mismatch": return "receipt-mismatch";
    default: return "receipt-absent";
  }
}

function receiptIdentityString(receipt: EvidenceReceipt): string {
  const subject = receipt.subject;
  return [
    subject.path,
    ...(subject.paths ?? []),
    subject.repo,
    subject.ref,
    subject.url,
    subject.query,
  ].filter((value): value is string => typeof value === "string" && value !== "").join(" ");
}

/** Whether the given receipts cover one trusted scope entry under one
 * obligation kind. Every candidate receipt must carry the dependency slug
 * as an EXACT identity (kind-appropriate boundaries, never a substring);
 * beyond that the kind decides:
 * - `provenance` asserts WHO publishes the dependency — identity of the
 *   dependency itself is the whole binding;
 * - `release_delta` asserts the old→new pair — the candidates must JOINTLY
 *   carry EVERY captured changed version, so one side alone (e.g. the old
 *   end of a wrong-range compare link) never covers;
 * - `security_advisory` binds the version RANGE the changed update actually
 *   covers — the candidates must JOINTLY carry EVERY captured changed
 *   version too: an advisory check naming only the old version proves
 *   nothing about the updated one. This binds ACQUISITION provenance to the
 *   captured range only; it is never semantic vulnerability proof.
 * A VERSIONLESS entry (no captured changed-version identity — the parser
 * emits one for re-resolution-only changes) backs `provenance` alone: the
 * slug proves WHO the dependency is, never an exact old→new delta nor an
 * updated version range, so the version-asserting kinds stay uncovered
 * rather than crediting a kind-matched acquisition of the right slug. A
 * ONE-SIDED entry likewise certifies no `release_delta` (a delta needs
 * both endpoints); an advisory range may legitimately be one-endpoint
 * (an added package's updated version IS the captured range). */
function dependencyCellCovered(
  receipts: readonly EvidenceReceipt[],
  kind: DependencyEvidenceObligation,
  entry: DependencyScopeEntry,
): boolean {
  const candidates = receipts.filter((receipt) => (receipt.subject.obligations ?? []).includes(kind)
    && identityCarriesToken(receiptIdentityString(receipt), entry.slug));
  if (candidates.length === 0) return false;
  if (kind === "provenance") return true;
  // #1657 (round 9): a version-asserting kind needs captured version
  // identity to assert at all. A versionless entry (re-resolution-only
  // change) can certify NEITHER kind; a one-sided entry certifies no
  // exact old→new `release_delta` (a delta needs both endpoints — one
  // side alone, e.g. an added block, is not a delta), while an advisory
  // range can legitimately be one-endpoint (an added package's updated
  // version IS the captured range). Slug identity alone never stands in
  // for any of this: the row stays material-unresolved through the
  // existing disposition path — never a manufactured blocker, never
  // versions inferred from prose, URLs, or receipt text.
  if (kind === "release_delta" ? entry.versions.length < 2 : entry.versions.length === 0) return false;
  // `release_delta` and `security_advisory` both bind the COMPLETE captured
  // changed-version identity: the candidate set covers a versioned entry
  // only when every captured version appears in it (one receipt may carry
  // several; several receipts may jointly cover). Advisory provenance names
  // the range the changed update actually covers — never one arbitrary
  // endpoint.
  return entry.versions.every((version) => candidates.some((receipt) => identityCarriesToken(receiptIdentityString(receipt), version)));
}

/** Settle a dependency-evidence row: for EVERY obligation kind the row
 * demands, the validated receipts must JOINTLY cover EVERY trusted scope
 * entry. Any combination of receipts may share the cover (no allocation;
 * one receipt may support several legitimate conclusions), but evidence
 * for one package can never satisfy an aggregate row that names several,
 * and a receipt about the wrong old→new version identity never covers a
 * versioned entry. */
function dependencyReceiptCoverage(
  ledger: EvidenceLedger,
  kinds: readonly DependencyEvidenceObligation[],
  scope: readonly DependencyScopeEntry[],
): { state: "receipt-backed" | "receipt-absent" | "receipt-mismatch" | "receipt-unverified"; receipts: EvidenceReceipt[] } {
  const verified: EvidenceReceipt[] = [];
  const unverified: EvidenceReceipt[] = [];
  for (const receipt of ledger.receipts) {
    const attribution = receipt.subject.obligations ?? [];
    if (!kinds.some((kind) => attribution.includes(kind))) continue;
    const identity = receiptIdentityString(receipt);
    if (!scope.some((entry) => identityCarriesToken(identity, entry.slug))) continue;
    if (receipt.acquired && receipt.complete && receipt.trust === "web") {
      verified.push(receipt);
    } else {
      unverified.push(receipt);
    }
  }
  if (verified.length === 0) {
    return { state: unverified.length > 0 ? "receipt-unverified" : "receipt-absent", receipts: [] };
  }
  const uncovered: Array<{ kind: DependencyEvidenceObligation; entry: DependencyScopeEntry }> = [];
  for (const kind of kinds) {
    for (const entry of scope) {
      if (!dependencyCellCovered(verified, kind, entry)) uncovered.push({ kind, entry });
    }
  }
  if (uncovered.length === 0) return { state: "receipt-backed", receipts: verified };
  // An uncovered cell that the verified receipts plus an unverified
  // acquisition WOULD cover keeps `receipt-unverified`; verified-but-
  // partial coverage is a mismatch.
  const pool = [...verified, ...unverified];
  const unverifiedFill = uncovered.some((cell) => dependencyCellCovered(pool, cell.kind, cell.entry)
    && !dependencyCellCovered(verified, cell.kind, cell.entry));
  return { state: unverifiedFill ? "receipt-unverified" : "receipt-mismatch", receipts: [] };
}

function supportedIdentityReceipts(
  ledger: EvidenceLedger,
  tokens: readonly string[],
): { verified: EvidenceReceipt[]; relevant: EvidenceReceipt[] } {
  const verified: EvidenceReceipt[] = [];
  const relevant: EvidenceReceipt[] = [];
  for (const receipt of ledger.receipts) {
    if (receipt.capability !== "content") continue;
    const identity = receiptIdentityString(receipt);
    if (!tokens.some((token) => identityCarriesToken(identity, token))) continue;
    relevant.push(receipt);
    const headBound = receipt.freshness === "head-bound";
    if (receipt.acquired && receipt.complete && headBound) verified.push(receipt);
  }
  return { verified, relevant };
}

/** Validate one row's requirement against the ledger, from the row's TRUSTED
 * tag (producer metadata — `null` means the row is `legacy`, i.e. the
 * producer did not tag it, and it keeps pre-#1657 gating semantics with no
 * receipt demand). For an explicitly-objective row a `receipt-backed`
 * outcome is the ONLY crediting path for a claimed `satisfied`; every other
 * outcome keeps the row unresolved with its reason code. `ci-evidence` rows
 * return `receipt-absent` here by design: their settlement is owned by the
 * #1594/#1612 head-bound CI reconciliation, which runs after the fold and
 * writes its own `resolvedBy` provenance. (Exact-head freshness is validated
 * at receipt-build time — workspace reads and corpus chunks are head-bound
 * by construction, forge reads only when they carry the reviewed sha — so
 * the row evaluation needs no head parameter.) Identity extraction from the
 * check text happens ONLY here, for an explicitly-objective
 * `source-identity` row: it validates the tagged objective identity against
 * receipts and never decides whether the row is material. */
export function evaluateRowEvidence(
  tag: CheckEvidenceTag | null,
  check: string,
  ledger: EvidenceLedger | undefined,
): RowEvidenceState {
  const base: RowEvidenceState = {
    rowClass: tag?.rowClass ?? "legacy",
    gate: tag?.gate ?? null,
    state: "not-required",
    receipts: [],
  };
  // Only an explicitly-objective row has a receipt gate at all: attention
  // rows, review prompts, and legacy rows fold on the presence-and-shape
  // rule with no provenance demand.
  if (tag?.rowClass !== "objective") return base;
  if (ledger === undefined || ledger.state === "unavailable") return { ...base, state: "no-ledger" };
  if (ledger.state === "refused") return { ...base, state: "trace-refused" };
  if (tag.gate === "ci-evidence") return { ...base, state: "receipt-absent" };
  if (tag.gate === "dependency-evidence") {
    // #1657 (review rounds 2–3): without a COMPLETE trusted update identity
    // the producer could not establish WHAT this row's acquisition must be
    // about — fail closed: kind-only evidence never credits it, and
    // neither does evidence for a partial dependency set.
    if (tag.dependencyScope.length === 0 || tag.obligations.length === 0) return { ...base, state: "receipt-absent" };
    const coverage = dependencyReceiptCoverage(ledger, tag.obligations, tag.dependencyScope);
    return {
      ...base,
      state: coverage.state,
      receipts: coverage.state === "receipt-backed"
        ? coverage.receipts.slice(0, MAX_ROW_RECEIPT_IDS).map((receipt) => receipt.id)
        : [],
    };
  }
  // source-identity: every exact identity token the row names must be
  // covered JOINTLY by validated head-bound content receipts — one receipt
  // may carry several tokens, several receipts may share the cover, and a
  // receipt that carries none of the row's identity never contributes.
  const tokens = requirementIdentityTokens(checkIdentityKey(check));
  const { verified, relevant } = supportedIdentityReceipts(ledger, tokens);
  if (verified.length > 0) {
    const covered = tokens.every((token) => verified.some((receipt) => identityCarriesToken(receiptIdentityString(receipt), token)));
    if (covered) {
      const supporting = verified.filter((receipt) => verified.length === 1
        || tokens.some((token) => identityCarriesToken(receiptIdentityString(receipt), token)));
      return { ...base, state: "receipt-backed", receipts: supporting.slice(0, MAX_ROW_RECEIPT_IDS).map((receipt) => receipt.id) };
    }
    return { ...base, state: "receipt-mismatch" };
  }
  return { ...base, state: relevant.length > 0 ? "receipt-unverified" : "receipt-absent" };
}

// ---------------------------------------------------------------------------
// Artifact surface for the #1656 disposition layer: the bounded ledger file
// (strict round-trip) and the per-row evidence projection.
// ---------------------------------------------------------------------------

/** The closed row-class vocabulary (`legacy` = the producer did not tag the
 * row; it keeps pre-#1657 gating semantics). */
export const REQUIRED_EVIDENCE_ROW_CLASSES: ReadonlySet<string> = new Set([
  "attention", "objective", "review-prompt", "legacy",
]);

/**
 * Strict parser for the producer's `must_check_evidence` rows
 * (classification artifact) and the candidate-row tag fields: an
 * unparseable ROW is DROPPED (that check falls back to `legacy` — gating,
 * pre-#1657 semantics — which is the fail-safe direction for coverage),
 * never guessed and never promoted to objective by its wording.
 */
export function checkEvidenceTagsFromArtifact(value: unknown): CheckEvidenceTagWithText[] {
  const tags: CheckEvidenceTagWithText[] = [];
  if (!Array.isArray(value)) return tags;
  for (const raw of value.slice(0, 100)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "text" && key !== "row_class" && key !== "gate" && key !== "obligations" && key !== "dependency_scope") continue;
    }
    if (typeof record.text !== "string" || record.text.trim() === "" || record.text.length > 1000) continue;
    if (typeof record.row_class !== "string" || !REQUIRED_EVIDENCE_ROW_CLASSES.has(record.row_class) || record.row_class === "legacy") continue;
    if (record.gate !== undefined && record.gate !== null
      && !(typeof record.gate === "string" && ["ci-evidence", "dependency-evidence", "source-identity"].includes(record.gate))) continue;
    const obligations: DependencyEvidenceObligation[] = [];
    if (record.obligations !== undefined) {
      if (!Array.isArray(record.obligations)) continue;
      let ok = true;
      for (const kind of record.obligations) {
        if (typeof kind !== "string" || !["provenance", "release_delta", "security_advisory"].includes(kind)) { ok = false; break; }
        obligations.push(kind as DependencyEvidenceObligation);
      }
      if (!ok) continue;
    }
    // #1657 (review round 3): the trusted dependency update identity —
    // strict `{slug, versions}` entries; an unparseable scope DROPS the
    // row (fail closed to `legacy`), never half-trusted.
    let dependencyScope: DependencyScopeEntry[] = [];
    if (record.dependency_scope !== undefined) {
      const parsedScope = dependencyScopeEntriesFromArtifact(record.dependency_scope);
      if (parsedScope === null) continue;
      dependencyScope = parsedScope;
    }
    const rowClass = record.row_class as Exclude<RequiredEvidenceRowClass, "legacy">;
    // A tag claiming objective MUST carry its explicit gate kind; other
    // classes carry none.
    const gate = (record.gate ?? null) as EvidenceGateKind | null;
    if (rowClass === "objective" && gate === null) continue;
    if (rowClass !== "objective" && gate !== null) continue;
    tags.push({ text: record.text, rowClass, gate, obligations, dependencyScope });
  }
  return tags;
}

/** Snake_case artifact projection of one receipt (the persisted
 * `evidence-receipts.json` shape; subject fields omit empties). */
export function evidenceReceiptToArtifact(receipt: EvidenceReceipt): Record<string, unknown> {
  const subject: Record<string, unknown> = {};
  if (receipt.subject.path !== undefined) subject.path = receipt.subject.path;
  if (receipt.subject.paths !== undefined) subject.paths = receipt.subject.paths;
  if (receipt.subject.repo !== undefined) subject.repo = receipt.subject.repo;
  if (receipt.subject.url !== undefined) subject.url = receipt.subject.url;
  if (receipt.subject.query !== undefined) subject.query = receipt.subject.query;
  if (receipt.subject.ref !== undefined) subject.ref = receipt.subject.ref;
  if (receipt.subject.checkName !== undefined) subject.check_name = receipt.subject.checkName;
  if (receipt.subject.obligations !== undefined && receipt.subject.obligations.length > 0) {
    subject.obligations = receipt.subject.obligations;
  }
  return {
    id: receipt.id, kind: receipt.kind, capability: receipt.capability,
    acquired: receipt.acquired, complete: receipt.complete,
    freshness: receipt.freshness, trust: receipt.trust, subject,
  };
}

/** The bounded persisted ledger artifact (`evidence-receipts.json`). */
export function evidenceLedgerToArtifact(ledger: EvidenceLedger): Record<string, unknown> {
  return {
    version: 1,
    state: ledger.state,
    receipts: ledger.receipts.map(evidenceReceiptToArtifact),
  };
}

const LEDGER_STATES: ReadonlySet<string> = new Set(["unavailable", "refused", "valid"]);
const RECEIPT_KINDS: ReadonlySet<string> = new Set([
  "source-read", "corpus-diff", "ci-check", "web-fetch", "web-search", "discovery", "command",
]);
const RECEIPT_CAPABILITIES: ReadonlySet<string> = new Set(["content", "acquisition", "discovery", "command"]);
const RECEIPT_FRESHNESS: ReadonlySet<string> = new Set(["head-bound", "unbound"]);
const RECEIPT_TRUST: ReadonlySet<string> = new Set(["workspace", "corpus-certified", "forge", "web", "ci-gate"]);
const RECEIPT_OBLIGATIONS: ReadonlySet<string> = new Set(["provenance", "release_delta", "security_advisory"]);

/** Strict round-trip reader for `evidence-receipts.json`: anything this
 * runtime did not write is `null` (absent, never a guess) — the same rule
 * the other run-dir artifacts' readers apply. */
export function evidenceLedgerFromArtifact(value: unknown): EvidenceLedger | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "state" && key !== "receipts") return null;
  }
  if (record.version !== 1) return null;
  if (typeof record.state !== "string" || !LEDGER_STATES.has(record.state)) return null;
  if (!Array.isArray(record.receipts)) return null;
  const receipts: EvidenceReceipt[] = [];
  for (const raw of record.receipts) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "kind" && key !== "capability" && key !== "acquired"
        && key !== "complete" && key !== "freshness" && key !== "trust" && key !== "subject") return null;
    }
    if (typeof entry.id !== "string" || entry.id === "" || entry.id.length > MAX_RECEIPT_FIELD_LENGTH) return null;
    if (typeof entry.kind !== "string" || !RECEIPT_KINDS.has(entry.kind)) return null;
    if (typeof entry.capability !== "string" || !RECEIPT_CAPABILITIES.has(entry.capability)) return null;
    if (typeof entry.acquired !== "boolean" || typeof entry.complete !== "boolean") return null;
    if (typeof entry.freshness !== "string" || !RECEIPT_FRESHNESS.has(entry.freshness)) return null;
    if (typeof entry.trust !== "string" || !RECEIPT_TRUST.has(entry.trust)) return null;
    const rawSubject = entry.subject;
    if (rawSubject === null || typeof rawSubject !== "object" || Array.isArray(rawSubject)) return null;
    const subjectRecord = rawSubject as Record<string, unknown>;
    for (const key of Object.keys(subjectRecord)) {
      if (key !== "path" && key !== "paths" && key !== "repo" && key !== "url" && key !== "query"
        && key !== "ref" && key !== "check_name" && key !== "obligations") return null;
    }
    const subject: EvidenceReceiptSubject = {};
    if (subjectRecord.path !== undefined) {
      if (typeof subjectRecord.path !== "string" || subjectRecord.path === "") return null;
      subject.path = subjectRecord.path;
    }
    if (subjectRecord.paths !== undefined) {
      if (!Array.isArray(subjectRecord.paths) || subjectRecord.paths.length === 0
        || subjectRecord.paths.length > MAX_RECEIPT_PATHS
        || !subjectRecord.paths.every((path) => typeof path === "string" && path !== "")) return null;
      subject.paths = subjectRecord.paths as string[];
    }
    for (const [key, target] of [["repo", "repo"], ["url", "url"], ["query", "query"], ["ref", "ref"], ["check_name", "checkName"]] as const) {
      const raw = subjectRecord[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string" || raw === "") return null;
      (subject as Record<string, unknown>)[target] = raw;
    }
    if (subjectRecord.obligations !== undefined) {
      if (!Array.isArray(subjectRecord.obligations) || subjectRecord.obligations.length === 0
        || !subjectRecord.obligations.every((kind) => typeof kind === "string" && RECEIPT_OBLIGATIONS.has(kind))) return null;
      subject.obligations = subjectRecord.obligations as DependencyEvidenceObligation[];
    }
    receipts.push({
      id: entry.id,
      kind: entry.kind as EvidenceReceipt["kind"],
      capability: entry.capability as EvidenceReceipt["capability"],
      acquired: entry.acquired,
      complete: entry.complete,
      freshness: entry.freshness as EvidenceReceipt["freshness"],
      trust: entry.trust as EvidenceReceipt["trust"],
      subject,
    });
  }
  return { state: record.state as EvidenceLedger["state"], receipts };
}

/** The per-row evidence projection serialized onto the coverage and
 * obligation artifact rows (snake_case; `receipts` → `receipt_ids`). */
export function rowEvidenceStateToArtifact(state: RowEvidenceState | undefined): Record<string, unknown> | undefined {
  if (state === undefined) return undefined;
  return {
    gate: state.gate,
    state: state.state,
    ...(state.receipts.length > 0 ? { receipt_ids: state.receipts } : {}),
  };
}
