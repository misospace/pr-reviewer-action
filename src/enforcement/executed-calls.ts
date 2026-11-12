/**
 * #1627: the executed-call identity index — the deterministic, content-free
 * surface that binds a model's `satisfied` answer to the tool calls the
 * native loop actually executed.
 *
 * The harness renders a per-call one-line index (stable short ids
 * `call-<n>` in execution order, tool name, executor status, bounded args
 * digest) into the verdict-turn corpus; this module is the enforcement-side
 * twin. The engine derives the SAME ids from the enforcement harness
 * artifact's `tool_calls` trace (`{tool, args, status}` entries in execution
 * order, written by `summarizeLoopOutcome`), so a citation the verdict
 * corpus showed is exactly a citation the folds can verify.
 *
 * Fail-closed rules:
 * - the index carries NO model prose and NO tool result bodies — ids,
 *   statuses, tool names, and the bounded identity args (the target)
 *   only. The corpus section renders the same bounded args digest from
 *   the loop's own records, never through this module;
 * - a trace that is PRESENT but malformed refuses the WHOLE index — a
 *   half-trusted id list could silently shift the positional `call-<n>`
 *   alignment — but a refusal is NOT an absence: the returned index keeps
 *   the citation gate ACTIVE with zero citable entries, so a `satisfied`
 *   must_check answer can never discharge behind a trace this runtime
 *   cannot verify (review finding on #1634: degrading a malformed trace to
 *   "no index" made the refusal indistinguishable from the no-native-loop
 *   case and silently disabled the gate — fail-open);
 * - the list is bounded by TRUNCATION to the first MAX_EXECUTED_CALL_INDEX
 *   entries (#1627 m1): ids are 1-based positional, so the bounded prefix
 *   keeps its exact alignment and the gate stays live — refusing the whole
 *   index over a long trace would be fail-open (the citation gate silently
 *   disabled), never fail-closed. The loop budget already bounds real runs
 *   far below the cap; the truncation only bounds a tampered or pathological
 *   artifact;
 * - one executed successful call backs AT MOST ONE `satisfied` must_check
 *   disposition (review finding on #1634: a single unrelated successful
 *   call must not discharge every required check). `allocateCallCitations`
 *   is the single shared allocator both folds run over the same rows, so
 *   the #1381 obligation fold and the #750 completeness fold make the SAME
 *   assignment and keep agreeing on every row.
 * - the citation is CHECK-SPECIFIC (human review on #1634, #1627
 *   acceptance): a cited call discharges a row only when the deterministic
 *   evidence identity establishes that the call actually bears on that
 *   row — the source/tool (a bounded set of repository/forge read tools),
 *   the call's bounded target (its identity args), and the exact
 *   head/version/package tokens the check text itself names, where
 *   applicable. A successful `gh_api` call (or any successful call) about
 *   an unrelated target never discharges a row; suite/test-run asks
 *   reconcile ONLY through the merged #1612 head-bound CI matcher
 *   (`reconcileObligationsWithCiEvidence` / `reconcileRequiredCheckRows`),
 *   never through a tool citation; and a security/breaking-change ABSENCE
 *   ask is never discharged by call identity at all (a successful search
 *   proves a search ran, never its result). Where the deterministic
 *   identity cannot establish that this call proves this row, the row
 *   stays unresolved — fail closed.
 */
import { isTestExecutionObligation } from "./required-check-ci.js";

/** One executed call's gate-relevant identity. `ok` mirrors the executor's
 * `status === "ok"` — a failed or errored call is never citable evidence.
 * `target` is the call's bounded evidence identity (its identity args —
 * endpoint/path/ref/url/query/command), the deterministic surface the
 * citation reconciliation matches the check text's own identity tokens
 * against. Empty when the args carry none. */
export interface ExecutedCallEvidenceEntry {
  id: string;
  ok: boolean;
  tool: string;
  target: string;
}

/** The parsed trace. `gate` is whether the citation gate applies this run:
 * TRUE whenever a `tool_calls` trace was PRESENT (valid or refused), so a
 * malformed trace keeps the gate live with `entries: []` — nothing is
 * citable and no satisfaction discharges behind it. FALSE only when no
 * trace was present or it was empty (no native-loop surface): fresh
 * standard-call and fork paths keep their pre-#1627 bytes exactly. */
export interface ExecutedCallEvidenceIndex {
  gate: boolean;
  /** True only when a trace was present but malformed: the gate is active
   * and NOTHING is citable. Distinct from `gate: false` (no surface) and
   * from a valid trace. */
  refused: boolean;
  entries: ExecutedCallEvidenceEntry[];
}

/** Hard ceiling on the parsed index (the loop budget bounds real runs far
 * below this; the cap keeps a tampered or pathological artifact bounded). */
export const MAX_EXECUTED_CALL_INDEX = 200;

/** The single source of the stable short-id scheme: `call-<n>`, 1-based
 * execution order — the exact tokens the verdict corpus renders and a
 * `satisfied` rationale must cite. */
export function executedCallId(position: number): string {
  return `call-${position}`;
}

/** The identity args each tool carries, extracted in this priority order
 * and joined into the bounded target. These are the argument names the
 * executors actually read (`src/tools/executors.ts`); an unknown extra arg
 * binds nothing — the target stays the identity the executor itself
 * dispatched on. */
const TARGET_ARG_KEYS: readonly string[] = ["endpoint", "path", "ref", "repo", "pattern", "url", "query", "command"];

/** The target digest bound — the same bound the verdict corpus's proof
 * index applies to the rendered args (`PROOF_INDEX_MAX_ARGS_CHARS`), so the
 * enforcement side never matches an identity the model could not see. */
const MAX_CALL_TARGET_CHARS = 300;

/**
 * The bounded evidence identity of one executed call: the tool's identity
 * args (endpoint/path/ref/repo/pattern/url/query/command), joined and
 * bounded. Empty when the args carry no identity values or are not an
 * object — a targetless call is a valid entry that matches no row
 * requiring identity, never a parser refusal (the strict refusal contract
 * covers the trace's own shape: string `tool` and `status` per entry).
 */
export function executedCallTarget(args: unknown): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of TARGET_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") parts.push(value);
  }
  if (parts.length === 0) return "";
  const joined = parts.join(" ");
  return joined.length > MAX_CALL_TARGET_CHARS ? joined.slice(0, MAX_CALL_TARGET_CHARS) : joined;
}

/**
 * Parse the enforcement harness artifact's `tool_calls` trace into the
 * evidence index. Strict: every entry must be an object carrying string
 * `tool` and `status` fields (the shape `summarizeLoopOutcome` writes); any
 * other shape REFUSES the index — gate active, zero citable entries —
 * never a partial list and never a silently inert gate. An absent or empty
 * trace is the ordinary no-native-loop case (`gate: false`).
 */
export function executedCallEvidenceIndex(toolCalls: unknown): ExecutedCallEvidenceIndex {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { gate: false, refused: false, entries: [] };
  }
  // #1627 (m1): an over-cap trace is TRUNCATED to the first
  // MAX_EXECUTED_CALL_INDEX entries, not refused — ids are 1-based
  // positional, so the prefix keeps its exact `call-<n>` alignment and the
  // citation gate stays live. Refusing the whole index here would silently
  // disable the gate (fail-open vs pre-#1627 permissiveness).
  const bounded = toolCalls.length > MAX_EXECUTED_CALL_INDEX
    ? toolCalls.slice(0, MAX_EXECUTED_CALL_INDEX)
    : toolCalls;
  const entries: ExecutedCallEvidenceEntry[] = [];
  for (let position = 0; position < bounded.length; position++) {
    const entry = bounded[position];
    // #1634 (review): a present-but-malformed trace keeps the gate ACTIVE
    // with nothing citable — uncited satisfiations fail closed instead of
    // discharging behind a "no index" the caller could not distinguish from
    // the no-loop case.
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { gate: true, refused: true, entries: [] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.tool !== "string" || record.tool === "" || typeof record.status !== "string") {
      return { gate: true, refused: true, entries: [] };
    }
    // #1627/#1634: the entry carries the call's evidence identity (tool +
    // bounded target) so the citation reconciliation can bind a cited id to
    // the check it actually bears on. The identity is content-free: arg
    // values the executor dispatched on, never tool RESULT bodies.
    entries.push({
      id: executedCallId(position + 1),
      ok: record.status === "ok",
      tool: record.tool,
      target: executedCallTarget(record.args),
    });
  }
  return { gate: true, refused: false, entries };
}

/** Canonical identity for citation allocation. Both folds key their rows
 * through this ONE function so the shared allocator sees byte-identical
 * keys for the same must_check text (each fold's own disposition-matching
 * normalization stays where it is; this is only the allocation key). The
 * whitespace class matches the obligation fold's row matching (`\s` covers
 * NBSP) plus DEL, so one check text yields one key on both sides. */
export function citationKey(check: string): string {
  return check.replace(/[\s\u007f]+/g, " ").trim().toLowerCase();
}

/** The citation tokens a rationale may use: `call-<n>` word-bounded, so
 * `call-1` never matches inside `call-10` and prose cannot half-echo an id. */
const EXECUTED_CALL_CITATION_TOKEN = /\bcall-\d+\b/g;

/** Outcome of allocating citable calls to one row. */
export type CitationOutcome = "assigned" | "uncited" | "shared" | "unrelated";

export interface CitationRow {
  /** The canonical `citationKey` of the row's check text — the
   * whitespace-normalized, lowercased check text. It carries the row's
   * evidence identity (the exact head/version/package/path tokens the
   * check names) verbatim, which is what the check-specific reconciliation
   * below matches cited calls against. */
  key: string;
  /** The model's rationale for a `satisfied` answer (never judged for
   * semantics — only scanned for citable call-id tokens). */
  rationale: string;
}

/** The tools whose SUCCESS deterministically establishes something about
 * their bounded target: repository and forge reads dispatched at an
 * identity the trace carries. `web_fetch`/`web_search` prove only that a
 * URL/query was sent — never the subject's state — and `run_command`
 * proves only that an allowlisted command ran, so a cited call outside
 * this set is never probative (#1627: a release-note URL fetch or a
 * generic search must never satisfy an obligation). */
const SOURCE_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  "read_skill", "read_file", "find_files", "list_tree",
  "git_log", "git_blame", "git_grep", "repo_contents", "gh_api",
]);

/** #1627: security/breaking-change ABSENCE asks are never discharged by
 * call identity. A successful search/grep/fetch proves the search ran,
 * never its result, so no call can establish "no vulnerability / no
 * advisory / no breaking change". Closed, documented vocabulary; matching
 * errs toward NOT discharging (a missed discharge costs a revision cycle;
 * a false discharge would certify an untested claim). */
const ABSENCE_EVIDENCE_RE = /\b(?:security|advisories|advisory|vulnerabilit\w*|cves?|breaking|exploit\w*|malware|backdoor|malicious|traversal|ssrf|xss|csrf|inject\w*)\b/i;

/** `owner/repo` slug in a check text: both segments GitHub-name-shaped,
 * neither purely numeric/version-like (so `1.2.3/4.5.6` or `old/new`
 * never read as a package identity), and neither a stopword (so the prose
 * pair `and/or` is not mistaken for one). */
const REPO_SLUG_RE = /\b([0-9a-z][0-9a-z_-]*(?:\.[0-9a-z][0-9a-z_-]*)*)\/([0-9a-z][0-9a-z_-]*(?:\.[0-9a-z][0-9a-z_-]*)*)\b/gi;
const SLUG_STOPWORDS: ReadonlySet<string> = new Set([
  "and", "or", "not", "the", "of", "to", "in", "on", "for", "with", "at", "by", "from",
]);

/** Exact version token (x.y.z with optional pre-release/build suffix).
 * Two-segment versions (`7.4`) are deliberately NOT identity: too
 * collidable with ordinary numbers. */
const EXACT_VERSION_RE = /\b\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?\b/gi;

/** Exact head/commit sha: full 40- or 64-hex, word-bounded. Short shas are
 * deliberately NOT identity (a 7-hex run collides with ordinary words). */
const HEAD_SHA_RE = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/gi;

/** Repository-relative path token: dot-extension-anchored, so it can only
 * be a file the check text names by name (`src/auth.ts`,
 * `package-lock.json`), never prose. */
const FILE_PATH_RE = /\b[a-z0-9_][a-z0-9_.-]*(?:\/[a-z0-9_.-]+)*\.(?:tsx?|mts|cts|mjs|cjs|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|md|json|ya?ml|toml|lock|txt|sh|sql|astro|vue|svelte)\b/gi;

/** URL scheme + host prefix, stripped before identity extraction so a
 * check that names `https://github.com/owner/repo` requires the same
 * `owner/repo` identity a forge endpoint carries — not the host. */
const URL_PREFIX_RE = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*[a-z0-9-]+\.[a-z]{2,}\//gi;

/**
 * The deterministic evidence identity a check text requires: the exact
 * tokens (package slugs, versions, head shas, named files) every cited
 * call's bounded target must carry for the citation to bear on the row.
 * Lowercase; deduplicated. `null` means the row is of a class citations
 * can NEVER prove (suite/CI asks — the merged #1612 head-bound CI
 * matcher reconciles those; security/breaking-change absence asks — no
 * call establishes a negative). An empty token list means the check names
 * no identity the layer can bind — also never citable: the deterministic
 * evidence cannot establish that ANY call proves this row.
 */
function rowEvidenceTokens(checkKey: string): string[] | null {
  if (isTestExecutionObligation(checkKey)) return null;
  if (ABSENCE_EVIDENCE_RE.test(checkKey)) return null;
  const stripped = checkKey.replace(URL_PREFIX_RE, " ");
  const tokens = new Set<string>();
  for (const match of stripped.matchAll(REPO_SLUG_RE)) {
    const [owner, repo] = [match[1] ?? "", match[2] ?? ""];
    if (/^\d+(\.\d+)*$/.test(owner) || /^\d+(\.\d+)*$/.test(repo)) continue;
    if (SLUG_STOPWORDS.has(owner.toLowerCase()) || SLUG_STOPWORDS.has(repo.toLowerCase())) continue;
    tokens.add(`${owner}/${repo}`.toLowerCase());
  }
  for (const match of stripped.matchAll(EXACT_VERSION_RE)) tokens.add(match[0]!.toLowerCase());
  for (const match of stripped.matchAll(HEAD_SHA_RE)) tokens.add(match[0]!.toLowerCase());
  for (const match of stripped.matchAll(FILE_PATH_RE)) tokens.add(match[0]!.toLowerCase());
  return [...tokens];
}

/**
 * Deterministic CHECK-SPECIFIC one-to-one citation allocation (the review
 * fix on #1634, tightened per the human review of #1634/#1627):
 *
 * 1. one executed successful call backs at most ONE `satisfied` must_check
 *    disposition — rows are processed in canonical key order and each
 *    takes the LOWEST-numbered cited successful call no other row has
 *    taken, so the assignment depends only on the row set and the index,
 *    never on fold iteration order. The #1381 obligation fold and the
 *    #750 completeness fold call THIS function with the same rows and the
 *    same index, which is what keeps the two folds in exact agreement.
 * 2. the citation must be CHECK-SPECIFIC: a cited call is only a
 *    candidate when it is a repository/forge read (`SOURCE_EVIDENCE_TOOLS`)
 *    whose bounded target carries EVERY identity token the check text
 *    names (package slug, exact version, head sha, named file). A
 *    successful call about an unrelated target never discharges — the row
 *    is `unrelated` (reason `unrelated-executed-call` in both folds).
 *    Suite/CI asks (`null` identity) reconcile only through the merged
 *    #1612 head-bound CI matcher, and absence asks are never citable; a
 *    check naming no identity at all is also `unrelated` — the
 *    deterministic layer cannot establish that any call proves it.
 *
 * A row citing no successful call at all is still `uncited`; a row whose
 * matching calls another row already took is `shared`. Neither discharges.
 *
 * EVERY input row consumes its own outcome (equal keys are NOT collapsed):
 * two same-key rows never share one call — the allocation is per row, and
 * ties resolve in the stable sort's order. The result is aligned to the
 * input row order.
 */
export function allocateCallCitations(
  rows: readonly CitationRow[],
  index: readonly ExecutedCallEvidenceEntry[],
): CitationOutcome[] {
  const successful = index.filter((entry) => entry.ok);
  const used = new Set<string>();
  const outcomes: CitationOutcome[] = [];
  const ordered = rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : a.position - b.position));
  for (const { row, position } of ordered) {
    const tokens = typeof row.rationale === "string"
      ? row.rationale.match(EXECUTED_CALL_CITATION_TOKEN) ?? []
      : [];
    const cited = [...new Set(tokens.filter((token) => successful.some((entry) => entry.id === token)))];
    if (cited.length === 0) {
      outcomes[position] = "uncited";
      continue;
    }
    // The check-specific reconciliation: which cited successful calls does
    // the deterministic evidence identity admit as PROBATIVE for THIS row?
    // A row with NO bindable identity (`null` class or zero tokens) admits
    // NOTHING — an empty requirement must never vacuously match every call.
    const required = rowEvidenceTokens(row.key);
    const matching = required === null || required.length === 0 ? [] : cited
      .map((id) => successful.find((entry) => entry.id === id)!)
      .filter((entry) => SOURCE_EVIDENCE_TOOLS.has(entry.tool)
        && required.every((token) => entry.target.toLowerCase().includes(token)))
      .map((entry) => entry.id)
      .sort((a, b) => Number(a.slice("call-".length)) - Number(b.slice("call-".length)));
    if (matching.length === 0) {
      // Cited, successful — but not check-specific evidence for this row
      // (wrong tool, wrong target identity, suite/CI ask, absence ask, or
      // no bindable identity). Fail closed with its own receipt.
      outcomes[position] = "unrelated";
      continue;
    }
    const free = matching.find((id) => !used.has(id));
    if (free === undefined) {
      outcomes[position] = "shared";
      continue;
    }
    used.add(free);
    outcomes[position] = "assigned";
  }
  return outcomes;
}
