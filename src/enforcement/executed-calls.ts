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
 * - the index carries NO model prose, NO tool result bodies, and NO
 *   arguments — ids and statuses only (the corpus section renders a bounded
 *   args digest from the loop's own records, never through this module);
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
 *   assignment and keep agreeing on every row. Which call PROVES which
 *   check is a semantic judgment the deterministic layer never makes —
 *   check-specific evidence reconciliation is #1594.
 */

/** One executed call's gate-relevant identity. `ok` mirrors the executor's
 * `status === "ok"` — a failed or errored call is never citable evidence. */
export interface ExecutedCallEvidenceEntry {
  id: string;
  ok: boolean;
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
    entries.push({ id: executedCallId(position + 1), ok: record.status === "ok" });
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
export type CitationOutcome = "assigned" | "uncited" | "shared";

export interface CitationRow {
  /** The canonical `citationKey` of the row's check text. */
  key: string;
  /** The model's rationale for a `satisfied` answer (never judged for
   * semantics — only scanned for citable call-id tokens). */
  rationale: string;
}

/**
 * Deterministic one-to-one citation allocation (the review fix on #1634):
 * one executed successful call backs at most ONE `satisfied` must_check
 * disposition. Rows are processed in canonical key order and each takes the
 * LOWEST-numbered cited successful call no other row has taken — so the
 * assignment depends only on the row set (check texts + rationales) and the
 * index, never on fold iteration order. The #1381 obligation fold and the
 * #750 completeness fold call THIS function with the same rows and the same
 * index, which is what keeps the two folds in exact agreement; a row whose
 * only cited calls another row already took is `shared`, and a row citing
 * no successful call at all is `uncited`. Neither discharges.
 *
 * EVERY input row consumes its own outcome (equal keys are NOT collapsed):
 * two same-key rows never share one call — the allocation is per row, and
 * ties resolve in the stable sort's order. The result is aligned to the
 * input row order.
 *
 * Content-free by construction: token matching only; what a cited call
 * actually PROVES is judged elsewhere (eval corpus / review readers, and
 * check-specific reconciliation is #1594).
 */
export function allocateCallCitations(
  rows: readonly CitationRow[],
  index: readonly ExecutedCallEvidenceEntry[],
): CitationOutcome[] {
  const successful = new Set(index.filter((entry) => entry.ok).map((entry) => entry.id));
  const used = new Set<string>();
  const outcomes: CitationOutcome[] = [];
  const ordered = rows
    .map((row, position) => ({ row, position }))
    .sort((a, b) => (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : a.position - b.position));
  for (const { row, position } of ordered) {
    const tokens = typeof row.rationale === "string"
      ? row.rationale.match(EXECUTED_CALL_CITATION_TOKEN) ?? []
      : [];
    const cited = [...new Set(tokens.filter((token) => successful.has(token)))];
    if (cited.length === 0) {
      outcomes[position] = "uncited";
      continue;
    }
    cited.sort((a, b) => Number(a.slice("call-".length)) - Number(b.slice("call-".length)));
    const free = cited.find((token) => !used.has(token));
    if (free === undefined) {
      outcomes[position] = "shared";
      continue;
    }
    used.add(free);
    outcomes[position] = "assigned";
  }
  return outcomes;
}
