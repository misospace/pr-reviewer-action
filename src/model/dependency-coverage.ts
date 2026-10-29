/** #1337: dependency-upgrade coverage accounting.
 *
 * Closed vocabularies, fail-closed normalization and the deterministic
 * rollup for the reviewer's structured `dependency_coverage` answer on
 * dependency-upgrade PRs. The feature is coverage ACCOUNTING, not a
 * vulnerability-scan verdict: every investigation dimension carries an
 * explicit status so a completed negative check is never indistinguishable
 * from a skipped one, and a missing advisory lookup can never read as
 * "no known vulnerabilities". The rollup is informational only — it never
 * creates a finding, never gates the verdict, and never fabricates a
 * blocking defect from an evidence gap.
 */

/** The five coverage dimensions every dependency-upgrade answer reports. */
export const DEPENDENCY_COVERAGE_ASPECTS = Object.freeze([
  "source_mapping",
  "release_notes",
  "advisories",
  "signature_verification",
  "relevance",
] as const);

export type DependencyCoverageAspect = (typeof DEPENDENCY_COVERAGE_ASPECTS)[number];

/** Closed status vocabulary: `checked_no_match` = investigated, nothing
 * relevant found; `finding_present` = investigated, relevant finding;
 * `unavailable` = investigation attempted, evidence unavailable;
 * `not_checked` = never investigated; `skipped` = deliberately skipped.
 * `invalid` is parser-internal (unknown model word) and counts as
 * not-checked in the rollup — an unusable answer never upgrades a
 * dimension to checked. */
export const DEPENDENCY_COVERAGE_STATUSES = Object.freeze([
  "checked_no_match",
  "finding_present",
  "unavailable",
  "not_checked",
  "skipped",
] as const);

export type DependencyCoverageStatus =
  | (typeof DEPENDENCY_COVERAGE_STATUSES)[number]
  | "invalid";

/** Deterministic rollup over the five aspects: `complete` when every aspect
 * is checked (no match or finding present); `unavailable` when none is;
 * `partial` for anything between. An answer the model never emitted is
 * "not reported" — no coverage claim either way. */
export const DEPENDENCY_COVERAGE_ROLLUP_VALUES = Object.freeze([
  "complete",
  "partial",
  "unavailable",
] as const);

export type DependencyCoverageRollup = (typeof DEPENDENCY_COVERAGE_ROLLUP_VALUES)[number];

export interface NormalizedDependencyCoverageAspect {
  aspect: string;
  status: DependencyCoverageStatus;
  note: string | null;
}

/** Bounds on one model answer, mirroring the required-check disposition
 * caps: control chars (at or below SPACE plus DEL) collapse so values can
 * never break single-line consumers; the caps bound one answer. */
export const MAX_DEPENDENCY_COVERAGE_ASPECTS = 16;
export const MAX_DEPENDENCY_COVERAGE_ASPECT_CHARS = 64;
export const MAX_DEPENDENCY_COVERAGE_NOTE_CHARS = 500;

/** Collapse control chars to single spaces (shared posture with the
 * required-check / smart-review-reason normalization). */
export function collapseCoverageControlChars(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]+/g, " ").trim();
}

/**
 * #1337: normalize the model's structured `dependency_coverage` answer.
 * Tri-state with key presence, mirroring `required_check_dispositions`:
 * callers distinguish true absence from an explicitly emitted null/invalid
 * array. Entries with a non-string or empty/oversized aspect are dropped;
 * a known aspect echoed exactly is kept as-is, an unknown-but-usable aspect
 * string is kept bounded (the block still renders every canonical aspect,
 * filling unreported ones as `not_checked`, so a renamed aspect can never
 * read as a completed check). An unrecognized status word is preserved as
 * `invalid` — fail-closed, never coerced to a checked status.
 */
export function normalizeDependencyCoverage(
  value: unknown,
  present: boolean,
): { present: boolean; aspects: NormalizedDependencyCoverageAspect[] | null } {
  if (!present) return { present: false, aspects: null };
  if (!Array.isArray(value)) return { present: true, aspects: null };
  const aspects: NormalizedDependencyCoverageAspect[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawAspect = record.aspect;
    if (typeof rawAspect !== "string") continue;
    const aspect = collapseCoverageControlChars(rawAspect);
    if (aspect === "" || aspect.length > MAX_DEPENDENCY_COVERAGE_ASPECT_CHARS) continue;

    const rawStatus = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
    const status = (DEPENDENCY_COVERAGE_STATUSES as readonly string[]).includes(rawStatus)
      ? (rawStatus as Exclude<DependencyCoverageStatus, "invalid">)
      : "invalid";

    let note: string | null = null;
    if (typeof record.note === "string") {
      note = collapseCoverageControlChars(record.note).slice(0, MAX_DEPENDENCY_COVERAGE_NOTE_CHARS) || null;
    }

    aspects.push({ aspect, status, note });
    if (aspects.length >= MAX_DEPENDENCY_COVERAGE_ASPECTS) break;
  }
  return { present: true, aspects };
}

/** Aspect status exactly as the model reported it (absent = not reported). */
export type AspectStatusLookup = ReadonlyMap<string, DependencyCoverageStatus>;

/** Index the normalized answer by aspect (last answer wins for duplicates —
 * one bounded model answer, mirrors the required-check disposition pass
 * keeping every entry while the rollup reads the settled set). */
export function aspectStatusLookup(aspects: readonly NormalizedDependencyCoverageAspect[] | null): AspectStatusLookup {
  const lookup = new Map<string, DependencyCoverageStatus>();
  for (const entry of aspects ?? []) lookup.set(entry.aspect, entry.status);
  return lookup;
}

/** True when a status counts as an actually-checked investigation in the
 * rollup: only the two completed-investigation statuses qualify. `invalid`,
 * `not_checked`, `unavailable` and `skipped` never do, and an aspect the
 * answer never mentioned counts as not-checked. */
export function isAspectChecked(status: DependencyCoverageStatus | undefined): boolean {
  return status === "checked_no_match" || status === "finding_present";
}

/**
 * Deterministic rollup over the closed aspect set. Every canonical aspect
 * must be checked for `complete`; none for `unavailable`; anything between
 * is `partial`. The lookup (not the raw record list) is the input, so
 * duplicate answers collapse deterministically and an absent aspect reads
 * as not-checked — answering only some aspects can never yield `complete`.
 */
export function rollupDependencyCoverage(lookup: AspectStatusLookup): DependencyCoverageRollup {
  let checked = 0;
  for (const aspect of DEPENDENCY_COVERAGE_ASPECTS) {
    if (isAspectChecked(lookup.get(aspect))) checked += 1;
  }
  if (checked === DEPENDENCY_COVERAGE_ASPECTS.length) return "complete";
  if (checked === 0) return "unavailable";
  return "partial";
}

/** Human-readable rollup detail for the step-summary row and metadata. */
export function describeDependencyCoverageRollup(rollup: DependencyCoverageRollup, lookup: AspectStatusLookup): string {
  const checked = DEPENDENCY_COVERAGE_ASPECTS.filter((aspect) => isAspectChecked(lookup.get(aspect))).length;
  return `${rollup} (${checked}/${DEPENDENCY_COVERAGE_ASPECTS.length} aspects checked)`;
}

/** Reviewer-reported coverage block appended to the review markdown when
 * the deterministic detection fired AND the model emitted a
 * `dependency_coverage` answer. Statuses are the REVIEWER'S OWN REPORT,
 * not harness receipts — the harness-established state lives in the
 * deterministic corpus section. Every canonical aspect is listed — an
 * aspect the answer never mentioned renders as `not_checked`, so silence
 * can never read as a completed negative check. Notes are model-authored
 * single-line text (already control-collapsed and capped by the parser);
 * the publish boundary's own sanitization still runs over the whole
 * markdown afterwards. Purely informational: the block states so. */
export function renderDependencyCoverageBlock(aspects: readonly NormalizedDependencyCoverageAspect[] | null | undefined): string {
  // `undefined` is the artifact-key-absent case (never emitted) — same
  // "not reported" state as null, never an iterable error.
  if (aspects === null || aspects === undefined) return "";
  // Last answer per aspect wins — the same dedup rule the rollup reads.
  const byAspect = new Map<string, NormalizedDependencyCoverageAspect>();
  for (const entry of aspects) byAspect.set(entry.aspect, entry);
  const lookup = aspectStatusLookup(aspects);
  const lines: string[] = [];
  lines.push("## Dependency Upgrade Coverage Accounting (reviewer-reported)");
  lines.push("");
  lines.push(`- Coverage rollup: ${describeDependencyCoverageRollup(rollupDependencyCoverage(lookup), lookup)}`);
  for (const aspect of DEPENDENCY_COVERAGE_ASPECTS) {
    const entry = byAspect.get(aspect);
    const status = entry === undefined ? "not_checked" : entry.status;
    lines.push(`- ${aspect}: ${status}${entry?.note ? ` — ${entry.note}` : ""}`);
  }
  lines.push("");
  lines.push(
    "_Statuses are the reviewer's answer, not harness receipts. Advisory coverage accounting: gaps are informational, not findings. `not_checked` means never investigated — not \"no known vulnerabilities\"._",
  );
  return lines.join("\n");
}
