/**
 * The closing-verdict requirement-decision contract (#1678 review hardening).
 *
 * ONE owner for the four views of the same contract, so the prompt, the
 * run-specific structured schema, the closing-local restatement, and the
 * deterministic pre-acceptance validator can never again be three
 * independently maintained interpretations:
 *
 *  - {@link REQUIREMENT_DECISION_ROW_RULE} — the single model-facing row
 *    vocabulary (trusted prompt fragments quote this constant; the strict
 *    decoder only ever accepts the shape it describes).
 *  - {@link renderRequiredRequirementDecisionsBlock} — the deterministic
 *    closing-local restatement of the exact expected requirement IDs,
 *    injected beside the final verdict request instead of asking the model
 *    to recover opaque IDs from 100k+ tokens of earlier context.
 *  - {@link buildRunVerdictSchema} — the run-specific structured-output
 *    schema (coverage non-null, exactly N items, enum-pinned IDs) where the
 *    provider's schema subset supports it.
 *  - {@link validateVerdictRequirementContract} — the deterministic
 *    exact-set validator that gates EVERY authoritative closing verdict.
 *    Provider/schema capability varies; this validator does not.
 *
 * The distinction the whole module is built on:
 *
 *     unknown      = a valid semantic answer the reviewer may give
 *     missing row  = an INVALID verdict serialization, never a synthesized unknown
 *
 * The organic #1681 failure this hardens against: the semantic review
 * converged and suggested `approve`, but the structured verdict carried 2
 * of 9 expected rows; the runtime accepted it as authoritative and the
 * downstream trace reported seven `not-traced-by-reviewer` rows, forcing
 * INCOMPLETE. A partial table is a contract violation caught BEFORE
 * acceptance, followed by at most ONE no-tools correction turn.
 *
 * Expected IDs come from the SAME deterministic trace scope the validator
 * uses (`requirementTraceScope().inScope`), never a separately reconstructed
 * list. Zero expected rows keeps the existing `requirement_coverage: null`
 * behavior valid and this module inert.
 */

import { OPENAI_VERDICT_JSON_SCHEMA } from "../model/request.js";

/** The one model-facing requirement-decision status enum. The strict schema,
 * the prompts, and the validator all take it from here — if they ever drift,
 * the vocabulary-agreement test fails. */
export const REQUIREMENT_DECISION_STATUSES = ["satisfied", "violated", "unknown"] as const;
export type RequirementDecisionStatus = (typeof REQUIREMENT_DECISION_STATUSES)[number];

/**
 * The canonical model-facing row contract, as ONE sentence pair used by
 * every trusted closing instruction (the corpus user message, the native
 * closing turn, and the trace system fragment). It describes EXACTLY the
 * shape the strict decoder permits: `{requirement_id, status, evidence[]}`
 * with evidence items `{kind, ref, detail}`. The internal additive fields
 * the #1660 fold tolerates (`disposition`/`enforcement`/`test`/`reason`) are
 * deliberately NOT taught here — they are unemittable under
 * `additionalProperties: false`, and teaching them was the dual-vocabulary
 * defect this hardening removes. The explanation a `violated`/`unknown` row
 * owes rides in the evidence `detail` text, which the trace fold already
 * synthesizes into `reason`.
 */
export const REQUIREMENT_DECISION_ROW_RULE =
  "Emit 'requirement_coverage' as null unless a Requirement Ledger section appears in the context; "
  + "otherwise emit EXACTLY ONE row per required requirement ID, and no others. "
  + "Each row is {requirement_id, status, evidence}: requirement_id echoes the listed ID exactly; "
  + "status is satisfied, violated, or unknown; "
  + "evidence is concrete entries (kind file, test, tool, ci, or diff, with ref and detail). "
  + "Answer satisfied only when your assessment of the relevant current-head evidence supports that the required behavior actually holds — a file or test citation identifies the evidence you relied on, but it does not establish semantic correctness by itself; "
  + "answer violated when you have a supported counterexample or evidence that the requirement is not met; "
  + "answer unknown when you cannot establish whether the requirement holds, including when you located a likely implementation or test but cannot establish its adequacy. "
  + "One genuine observation may support several requirements; cite it for each. "
  + "Never omit a required requirement ID — unknown is always preferable to omission.";

/** Artifact carrying the run's deterministic closing contract, written by the
 * engine beside the trace plan and read by BOTH authoritative verdict lanes
 * (native tool loop and corpus review) plus the disposition feed. */
export const VERDICT_CONTRACT_ARTIFACT = "verdict-contract.json";
export const VERDICT_CONTRACT_ARTIFACT_VERSION = 1;

/** Bounds on the artifact/blocks: the ledger already caps requirements (48)
 * and per-requirement text (400); the closing block truncates each row's
 * text further so the restatement stays a compact, closing-local block. */
export const MAX_CONTRACT_ROWS = 48;
export const MAX_CONTRACT_REQUIREMENT_CHARS = 160;
const MAX_DIAGNOSTIC_IDS = 24;

export interface VerdictContractRow {
  readonly id: string;
  readonly text: string;
}

export interface VerdictContract {
  readonly expectedIds: readonly string[];
  readonly rows: readonly VerdictContractRow[];
}

const REQUIREMENT_ID_RE = /^req-[0-9a-f]{12}$/;

const asPlainObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Bounded single-line rendering of a ledger requirement's text. */
function contractText(text: string): string {
  const flat = text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return flat.length > MAX_CONTRACT_REQUIREMENT_CHARS
    ? `${flat.slice(0, MAX_CONTRACT_REQUIREMENT_CHARS - 1)}\u2026`
    : flat;
}

/**
 * Derive the run's closing contract from the ledger VALUE and the exact
 * in-scope IDs the trace validator will use. Order follows the expected-id
 * order (trace scope order); rows for ids the ledger cannot back are still
 * expected (the id list is authoritative), just rendered without text.
 */
export function buildVerdictContract(
  ledgerValue: unknown,
  expectedIds: readonly string[],
): VerdictContract {
  const ids: string[] = [];
  for (const id of expectedIds) {
    if (REQUIREMENT_ID_RE.test(id) && !ids.includes(id) && ids.length < MAX_CONTRACT_ROWS) ids.push(id);
  }
  const textById = new Map<string, string>();
  const requirements = (asPlainObject(ledgerValue) ?? {}).requirements;
  if (Array.isArray(requirements)) {
    for (const entry of requirements) {
      const row = asPlainObject(entry);
      if (row === null) continue;
      const id = row.id;
      const text = row.text;
      if (typeof id === "string" && typeof text === "string" && !textById.has(id)) {
        textById.set(id, contractText(text));
      }
    }
  }
  return {
    expectedIds: ids,
    rows: ids.map((id) => ({ id, text: textById.get(id) ?? "" })),
  };
}

export function renderVerdictContractArtifact(contract: VerdictContract): string {
  return `${JSON.stringify({
    version: VERDICT_CONTRACT_ARTIFACT_VERSION,
    expected_ids: [...contract.expectedIds],
    rows: contract.rows.map((row) => ({ id: row.id, text: row.text })),
  })}\n`;
}

/** Fail-soft artifact reader: malformed or foreign content reads as NO
 * contract (validator inert, closing block absent), never as a partial one.
 * IDs that fail the shape check drop the WHOLE artifact — a half-expected
 * set is exactly the state this module exists to prevent. */
export function parseVerdictContractArtifact(raw: string | null): VerdictContract | null {
  if (raw === null || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const doc = asPlainObject(parsed);
  if (doc === null || doc.version !== VERDICT_CONTRACT_ARTIFACT_VERSION) return null;
  if (!Array.isArray(doc.expected_ids)) return null;
  const expectedIds: string[] = [];
  for (const id of doc.expected_ids) {
    if (typeof id !== "string" || !REQUIREMENT_ID_RE.test(id)) return null;
    if (!expectedIds.includes(id)) expectedIds.push(id);
    if (expectedIds.length > MAX_CONTRACT_ROWS) return null;
  }
  const rows: VerdictContractRow[] = [];
  if (Array.isArray(doc.rows)) {
    const byId = new Map<string, string>();
    for (const entry of doc.rows) {
      const row = asPlainObject(entry);
      if (row === null || typeof row.id !== "string" || typeof row.text !== "string") continue;
      if (!byId.has(row.id)) byId.set(row.id, contractText(row.text));
    }
    for (const id of expectedIds) rows.push({ id, text: byId.get(id) ?? "" });
  }
  return { expectedIds, rows };
}

/**
 * The closing-local restatement (deterministic, trusted). Empty string for
 * an empty contract so every run without in-scope requirements stays
 * byte-identical.
 */
export function renderRequiredRequirementDecisionsBlock(contract: VerdictContract | null): string {
  if (contract === null || contract.rows.length === 0) return "";
  const lines = contract.rows.map((row) => (row.text === "" ? `- ${row.id}` : `- ${row.id}: ${row.text}`));
  return [
    "Required requirement decisions",
    "",
    "Your final requirement_coverage must contain exactly one row for each",
    "of these requirement IDs and no others:",
    "",
    ...lines,
    "",
    "satisfied = current-head evidence establishes the requirement",
    "violated  = current-head evidence establishes it is not met",
    "unknown   = you cannot establish either conclusion",
    "",
    "Never omit an ID.",
    "Unknown is preferable to omission.",
  ].join("\n");
}

export interface VerdictContractDiagnostics {
  readonly ok: boolean;
  readonly expectedCount: number;
  /** false when coverage was null/absent/non-array while rows were expected. */
  readonly present: boolean;
  readonly missing: readonly string[];
  readonly duplicated: readonly string[];
  readonly unexpected: readonly string[];
  /** expected-id rows whose `status` is not one of the decision statuses. */
  readonly invalidStatus: readonly string[];
  /** rows that were not objects carrying a requirement_id at all. */
  readonly malformedRows: number;
  /** true when any diagnostic list hit its bound (the full set was larger). */
  readonly truncated: boolean;
  /** Uncapped count of missing expected IDs (the `missing` list itself is
   * bounded, so the totals ride separately for the bounded correction
   * record). */
  readonly missingTotal: number;
}

const capList = (values: readonly string[]): { list: string[]; truncated: boolean } => ({
  list: values.slice(0, MAX_DIAGNOSTIC_IDS),
  truncated: values.length > MAX_DIAGNOSTIC_IDS,
});

/**
 * The deterministic pre-acceptance validator: for N expected requirement
 * IDs, a valid closing `requirement_coverage` is an array carrying EXACTLY
 * those N IDs — each once, each with a valid status, and nothing else.
 * N === 0 is always valid (the existing `null` behavior is preserved and
 * the contract stays inert). This never synthesizes missing rows and never
 * judges semantics: a well-formed `unknown` row passes; a missing row does
 * not.
 */
export function validateVerdictRequirementContract(
  coverage: unknown,
  expectedIds: readonly string[],
): VerdictContractDiagnostics {
  const expected = [...new Set(expectedIds.filter((id) => typeof id === "string" && REQUIREMENT_ID_RE.test(id)))];
  const base = {
    ok: true,
    expectedCount: expected.length,
    present: true,
    missing: [] as string[],
    duplicated: [] as string[],
    unexpected: [] as string[],
    invalidStatus: [] as string[],
    malformedRows: 0,
    truncated: false,
    missingTotal: 0,
  };
  if (expected.length === 0) return base;
  if (coverage === null || coverage === undefined) {
    const capped = capList(expected);
    return { ...base, ok: false, present: false, missing: capped.list, truncated: capped.truncated, missingTotal: expected.length };
  }
  if (!Array.isArray(coverage)) {
    const capped = capList(expected);
    return { ...base, ok: false, present: false, missing: capped.list, truncated: capped.truncated, missingTotal: expected.length };
  }
  const seen = new Set<string>();
  const duplicated: string[] = [];
  const unexpected: string[] = [];
  const invalidStatus: string[] = [];
  let malformedRows = 0;
  for (const item of coverage) {
    const row = asPlainObject(item);
    const id = row === null ? undefined : row.requirement_id;
    if (row === null || typeof id !== "string" || !REQUIREMENT_ID_RE.test(id)) {
      malformedRows += 1;
      continue;
    }
    if (!expected.includes(id)) {
      if (!unexpected.includes(id)) unexpected.push(id);
      continue;
    }
    if (seen.has(id)) {
      if (!duplicated.includes(id)) duplicated.push(id);
      continue;
    }
    seen.add(id);
    const status = row.status;
    if (typeof status !== "string" || !(REQUIREMENT_DECISION_STATUSES as readonly string[]).includes(status)) {
      invalidStatus.push(id);
    }
  }
  const missing = expected.filter((id) => !seen.has(id));
  const cappedMissing = capList(missing);
  const cappedDupes = capList(duplicated);
  const cappedUnexpected = capList(unexpected);
  const cappedInvalid = capList(invalidStatus);
  const truncated = cappedMissing.truncated
    || cappedDupes.truncated
    || cappedUnexpected.truncated
    || cappedInvalid.truncated
    || malformedRows > MAX_DIAGNOSTIC_IDS;
  const ok = missing.length === 0
    && duplicated.length === 0
    && unexpected.length === 0
    && invalidStatus.length === 0
    && malformedRows === 0;
  return {
    ok,
    expectedCount: expected.length,
    present: true,
    missing: cappedMissing.list,
    duplicated: cappedDupes.list,
    unexpected: cappedUnexpected.list,
    invalidStatus: cappedInvalid.list,
    malformedRows,
    truncated,
    missingTotal: missing.length,
  };
}

/** One bounded log line describing a contract failure: counts and capped
 * ID lists only (the IDs are content hashes), never response text. */
export function describeVerdictContractDiagnostics(diagnostics: VerdictContractDiagnostics): string {
  if (diagnostics.ok) return "valid";
  const parts: string[] = [];
  if (!diagnostics.present) parts.push(`coverage absent (all ${diagnostics.expectedCount} rows required)`);
  else if (diagnostics.missing.length > 0) {
    parts.push(`missing ${diagnostics.missingTotal}/${diagnostics.expectedCount}: ${diagnostics.missing.join(", ")}`);
  }
  if (diagnostics.duplicated.length > 0) parts.push(`duplicated: ${diagnostics.duplicated.join(", ")}`);
  if (diagnostics.unexpected.length > 0) parts.push(`unexpected: ${diagnostics.unexpected.join(", ")}`);
  if (diagnostics.invalidStatus.length > 0) parts.push(`invalid status: ${diagnostics.invalidStatus.join(", ")}`);
  if (diagnostics.malformedRows > 0) parts.push(`malformed rows: ${diagnostics.malformedRows}`);
  if (diagnostics.truncated) parts.push("(lists capped)");
  return parts.join("; ");
}

const diagnosticSection = (heading: string, ids: readonly string[], truncated: boolean): string[] =>
  ids.length === 0
    ? []
    : [`${heading}:`, ...ids.map((id) => `- ${id}`), ...(truncated ? ["- (list capped; re-derive the full set from the Required requirement decisions block)"] : [])];

/**
 * The deterministic correction message for the single bounded
 * serialization-correction turn. Structural only: it names the expected,
 * missing, duplicate and unexpected IDs and demands a re-emit from evidence
 * ALREADY in the conversation — no new investigation, no tools, no semantic
 * tutoring.
 */
export function renderVerdictContractCorrectionMessage(diagnostics: VerdictContractDiagnostics): string {
  const lines: string[] = [
    "The previous final verdict did not satisfy the required output contract.",
    "",
  ];
  if (!diagnostics.present) {
    lines.push(
      `requirement_coverage was ${diagnostics.missing.length > 0 ? "absent or not an array" : "absent"}, but ${diagnostics.expectedCount} requirement decision row(s) are required:`,
      "",
      ...diagnosticSection("Expected requirement IDs", diagnostics.missing, diagnostics.truncated),
      "",
    );
  } else {
    lines.push(
      `requirement_coverage must contain exactly ${diagnostics.expectedCount} row(s) — one per expected ID and no others.`,
      "",
      ...diagnosticSection("Missing", diagnostics.missing, diagnostics.truncated),
      ...diagnosticSection("Duplicate", diagnostics.duplicated, diagnostics.truncated),
      ...diagnosticSection("Unexpected", diagnostics.unexpected, diagnostics.truncated),
      ...diagnosticSection("Invalid status (must be satisfied, violated, or unknown)", diagnostics.invalidStatus, diagnostics.truncated),
    );
    if (diagnostics.malformedRows > 0) {
      lines.push("", `Malformed rows (not objects carrying a requirement_id): ${diagnostics.malformedRows}`);
    }
    lines.push("");
  }
  lines.push(
    "Re-emit the complete final verdict using only evidence already present in this conversation.",
    "Do not perform additional investigation. Do not call any tools.",
    "Every required requirement ID needs exactly one row; unknown is preferable to omission.",
  );
  return lines.join("\n");
}

/**
 * The run-specific strict verdict schema lives with the wire layer that
 * owns the frozen base schema ({@link ../model/request.ts}
 * {@link buildRunVerdictSchema}), so both the native
 * verdict turn and every corpus review call pin the SAME builder output —
 * and the pinning code can never import-cycle against the schema it pins.
 * Re-exported here so every consumer keeps importing the contract from this
 * single owner module.
 */
export { buildRunVerdictOutputFormat, buildRunVerdictSchema } from "../model/request.js";
