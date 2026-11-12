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
 * - a trace this runtime did not write (any malformed entry) refuses the
 *   WHOLE index — a half-trusted id list could silently shift the positional
 *   `call-<n>` alignment, so it degrades to "no index" (the gate is inert)
 *   rather than to a wrong one;
 * - the list is bounded by TRUNCATION to the first MAX_EXECUTED_CALL_INDEX
 *   entries (#1627 m1): ids are 1-based positional, so the bounded prefix
 *   keeps its exact alignment and the gate stays live — refusing the whole
 *   index over a long trace would be fail-open (the citation gate silently
 *   disabled), never fail-closed. The loop budget already bounds real runs
 *   far below the cap; the truncation only bounds a tampered or pathological
 *   artifact.
 */

/** One executed call's gate-relevant identity. `ok` mirrors the executor's
 * `status === "ok"` — a failed or errored call is never citable evidence. */
export interface ExecutedCallEvidenceEntry {
  id: string;
  ok: boolean;
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
 * other shape refuses the WHOLE index (empty array), never a partial list.
 * An absent or empty trace is the ordinary no-native-loop case and yields
 * the empty index too — the caller cannot distinguish "no loop ran" from
 * "nothing executed", and the citation gate is inert for both.
 */
export function executedCallEvidenceIndex(toolCalls: unknown): ExecutedCallEvidenceEntry[] {
  if (!Array.isArray(toolCalls)) return [];
  // #1627 (m1): an over-cap trace is TRUNCATED to the first
  // MAX_EXECUTED_CALL_INDEX entries, not refused — ids are 1-based
  // positional, so the prefix keeps its exact `call-<n>` alignment and the
  // citation gate stays live. Refusing the whole index here would silently
  // disable the gate (fail-open vs pre-#1627 permissiveness).
  const bounded = toolCalls.length > MAX_EXECUTED_CALL_INDEX
    ? toolCalls.slice(0, MAX_EXECUTED_CALL_INDEX)
    : toolCalls;
  const index: ExecutedCallEvidenceEntry[] = [];
  for (let position = 0; position < bounded.length; position++) {
    const entry = bounded[position];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.tool !== "string" || record.tool === "" || typeof record.status !== "string") return [];
    index.push({ id: executedCallId(position + 1), ok: record.status === "ok" });
  }
  return index;
}

/** The citation tokens a rationale may use: `call-<n>` word-bounded, so
 * `call-1` never matches inside `call-10` and prose cannot half-echo an id. */
const EXECUTED_CALL_CITATION_TOKEN = /\bcall-\d+\b/g;

/**
 * Whether a disposition rationale cites at least one executed call that
 * exists in the index AND succeeded. Content-free string matching on the
 * rendered call-id tokens (e.g. `call-7` appearing in the rationale) — the
 * matcher never judges semantics; the semantic grounding of WHAT the call
 * showed is judged elsewhere (eval corpus / review readers), exactly like
 * every other deterministic presence-and-shape rule.
 */
export function rationaleCitesSuccessfulCall(
  rationale: string,
  index: readonly ExecutedCallEvidenceEntry[],
): boolean {
  if (typeof rationale !== "string" || index.length === 0) return false;
  const successful = new Set(index.filter((entry) => entry.ok).map((entry) => entry.id));
  for (const token of rationale.match(EXECUTED_CALL_CITATION_TOKEN) ?? []) {
    if (successful.has(token)) return true;
  }
  return false;
}
