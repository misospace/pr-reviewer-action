/**
 * Requirement-trace enforcement (#874).
 *
 * PR #854 is the motivating failure: the linked issue required matching a
 * source SHA, the review repeated that requirement, and approved anyway —
 * no production predicate compared the value it claimed was checked. Plain
 * `requirement_coverage` (#624) lets a `satisfied` claim stand on a file/diff
 * glance; this module additionally requires, per acceptance/normative
 * ledger requirement, a bounded trace to the code that enforces it and the
 * test that would fail if that enforcement broke — deterministically
 * verified against the checkout at head, never trusted from the model's
 * say-so.
 *
 * Additive to the existing `requirement_coverage` contract (#624): the model
 * emits the same `requirement_coverage` array, and each claim MAY carry
 * `enforcement`/`test` (arrays of `{file, line}`) and `disposition`
 * (`met`|`unmet`|`not_applicable`|`unverifiable`) alongside the existing
 * `status`/`evidence` fields `normalizeRequirementCoverage` already reads.
 * This module reads those additive fields independently and never mutates
 * `requirement_coverage` normalization — the two folds are siblings over the
 * same untrusted payload.
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

export const TRACE_DISPOSITIONS: readonly string[] = ["met", "unmet", "not_applicable", "unverifiable"];

export const MAX_TRACE_LOCATIONS = 5;
export const MAX_REASON_CHARS = 300;
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
   * (missing claim, or a claim downgraded to `unverifiable`) — the signal
   * that folds into `required_checks=incomplete` (review_result=partial). */
  incomplete: boolean;
  errors: string[];
}

export const ARTIFACT_VERSION = 1;

function capReason(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > MAX_REASON_CHARS) return text.slice(0, MAX_REASON_CHARS - 1) + TRUNCATION_MARKER;
  return text;
}

/** Line-count cache so a file cited by several requirements is read once. */
class LineCountCache {
  private readonly counts = new Map<string, number | null>();
  constructor(private readonly workspace: string) {}

  lineCount(file: string): number | null {
    if (this.counts.has(file)) return this.counts.get(file) ?? null;
    let result: number | null = null;
    if (workspaceRegularFile(this.workspace, file)) {
      try {
        const text = readFileSync(workspaceFsPath(this.workspace, file), "utf8");
        // A trailing newline does not add a phantom line; an empty file has 0.
        result = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      } catch {
        result = null;
      }
    }
    this.counts.set(file, result);
    return result;
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

/** True when at least one location in the list exists at head with the
 * claimed line inside the file's line count. */
function anyLocationValid(locations: readonly TraceLocation[], cache: LineCountCache): boolean {
  return locations.some((loc) => {
    const count = cache.lineCount(loc.file);
    return count !== null && loc.line <= count;
  });
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
 * either serialization's field casing beyond `id`/`text`/`kind`. */
function ledgerEntriesInScope(ledger: unknown): TracedLedgerEntry[] {
  const raw = (ledger as { requirements?: unknown } | null | undefined)?.requirements;
  if (!Array.isArray(raw)) return [];
  const entries: TracedLedgerEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const { id, text, kind } = record;
    if (typeof id !== "string" || typeof text !== "string" || typeof kind !== "string") continue;
    if (kind === "acceptance" || kind === "normative") entries.push({ id, text, kind });
  }
  return entries;
}

interface RawClaim {
  requirement_id?: unknown;
  disposition?: unknown;
  enforcement?: unknown;
  test?: unknown;
  reason?: unknown;
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
): RequirementTraceArtifact {
  const inScope = ledgerEntriesInScope(ledger);
  if (inScope.length === 0) {
    return { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] };
  }

  const cache = new LineCountCache(workspace);
  const claimsById = new Map<string, RawClaim>();
  const errors: string[] = [];
  if (Array.isArray(coveragePayload)) {
    for (const claim of coveragePayload) {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
      const record = claim as RawClaim;
      const rid = record.requirement_id;
      if (typeof rid === "string" && !claimsById.has(rid)) claimsById.set(rid, record);
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

      if (disposition === "met") {
        if (!anyLocationValid(enforcement, cache)) {
          disposition = "unverifiable";
          notes.push("downgraded-no-valid-enforcement-location");
        }
      } else if (disposition === "not_applicable") {
        // Explicit N/A never needs enforcement/test evidence — dispositioning
        // it is the point (#874 acceptance: "N/A requirements can be
        // dispositioned explicitly without inventing work").
      }
    }

    if (disposition === "unverifiable") incomplete = true;

    rows.push({ requirement_id: entry.id, disposition, enforcement, test, reason, notes });
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
  options: { enabled: boolean; ledger: unknown; workspace: string },
): RequirementTraceEnforcementResult {
  if (!options.enabled) {
    return { applied: false, trace: { version: ARTIFACT_VERSION, rows: [], incomplete: false, errors: [] }, findingsAdded: 0 };
  }
  const trace = validateRequirementTrace(artifact.requirement_coverage, options.ledger, options.workspace);
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
