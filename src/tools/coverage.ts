/**
 * Deterministic partial-coverage accounting for the native tool loop (#810).
 *
 * When the loop stops on ANY budget — request ceiling, rounds, or wall clock
 * — the published review must not read as if the investigation were
 * complete. This module computes, from the loop's own call log and the
 * workspace artifacts the harness can already see (the changed-file manifest
 * and the per-role specialist lead artifacts), which changed files were
 * never read and which specialist leads were never resolved. The model is
 * never asked about its own coverage: the computation is a pure fold over
 * the executed-call records and the manifests.
 *
 * "Read" is deliberately narrow so the notice errs toward honesty: only a
 * successful workspace-content read marks a file covered (`read_file` and
 * `git_blame` by exact path, `git_grep` when the file is matched directly —
 * by a path-scoped grep at the file itself or a match line naming it).
 * Discovery calls (`find_files`, `list_tree`, `git_log`), API reads of
 * related repositories, and web fetches never mark a changed file covered.
 *
 * One second path to coverage exists (#921): a changed file whose complete,
 * untruncated diff is already in the assembled review corpus needs no tool
 * read — the reviewer has every changed line in context. The rule is
 * verified, not inferred: the file's full per-file chunk from the RAW
 * `pr.diff` must appear byte-exact inside the corpus's diff section, so a
 * diff the corpus budget truncated or omitted never earns the credit and
 * keeps the strict tool-read rule (see `corpusDiffCoveredFiles`).
 *
 * A specialist lead is resolved when its own file (if it names one) was
 * read by the rules above. A lead without a file path cannot be tied to any
 * read, so on a budget stop it always reports as unresolved — the loop has
 * no evidence showing it was investigated.
 */

import { SPECIALIST_ROLES_ORDER } from "../specialists/types.js";
import { splitChunks } from "../corpus/diff-priority.js";
import { STOP_BUDGET, STOP_MAX_ROUNDS, STOP_WALL_CLOCK, type LoopOutcome } from "./loop.js";

/** The loop stopped on one of its budgets rather than by choice or failure. */
export function isBudgetStopReason(stopReason: string): boolean {
  return stopReason === STOP_BUDGET || stopReason === STOP_MAX_ROUNDS || stopReason === STOP_WALL_CLOCK;
}

/** One specialist lead, identified by role plus its own fields. */
export interface CoverageLeadRef {
  role: string;
  file: string | null;
  /** Bounded single-line message excerpt that disambiguates same-file leads. */
  excerpt: string;
}

/** Maximum message characters kept in a lead excerpt. */
export const COVERAGE_LEAD_EXCERPT_CHARS = 120;

/**
 * Persisted partial-coverage record (snake_case: it rides the harness JSON
 * artifact and the publish input verbatim). Absent from the artifact when
 * the loop did not stop on a budget or left nothing unread.
 */
export interface PartialCoverage {
  stop_reason: string;
  changed_files_total: number;
  unread_files: string[];
  leads_total: number;
  unresolved_leads: CoverageLeadRef[];
  /** #921 audit: changed files credited as covered by the corpus-diff rule
   * (complete untruncated diff in the assembled review corpus) rather than
   * by a tool read. Every other covered file was tool-read. Absent when no
   * file was credited this way. Sorted lexicographically. */
  corpus_diff_covered_files?: string[];
}

/** Bounded notice size: beyond this many entries the section lists a count
 * instead of every path (deterministic cap, never model-chosen). */
export const COVERAGE_NOTICE_MAX_ITEMS = 20;

function normalizeRelPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function excerptOf(message: unknown): string {
  const text = typeof message === "string" ? message : "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > COVERAGE_LEAD_EXCERPT_CHARS
    ? singleLine.slice(0, COVERAGE_LEAD_EXCERPT_CHARS) + "…"
    : singleLine;
}

/**
 * Changed-file paths from the harness workspace manifest (pr-files.json —
 * the same artifact the corpus renders). Files the PR deletes are skipped:
 * they no longer exist in the reviewed checkout, so the loop can never read
 * them and listing them would be noise. Tolerant: an absent or unparsable
 * manifest yields an empty list (and with it, no file-coverage claims).
 */
export function loadChangedFilePaths(read: (name: string) => string | null): string[] {
  const body = read("pr-files.json");
  if (body === null || body.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).files)
      ? (parsed as Record<string, unknown>).files as unknown[]
      : [];
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const path = normalizeRelPath(record.filename);
    if (path === "" || record.note !== undefined) continue;
    if (typeof record.status === "string" && record.status === "removed") continue;
    paths.push(path);
  }
  return paths;
}

/**
 * Specialist leads from the per-role artifacts (the same artifacts the
 * planning context renders leads from). Roles without an artifact (or with
 * an unparsable one) contribute nothing.
 */
export function loadSpecialistLeadRefs(read: (name: string) => string | null): CoverageLeadRef[] {
  const leads: CoverageLeadRef[] = [];
  for (const role of SPECIALIST_ROLES_ORDER) {
    const body = read(`specialist-${role}.json`);
    if (body === null || body.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const list = (parsed as Record<string, unknown>).leads;
    if (!Array.isArray(list)) continue;
    for (const lead of list) {
      if (lead === null || typeof lead !== "object" || Array.isArray(lead)) continue;
      const record = lead as Record<string, unknown>;
      const file = typeof record.file === "string" && record.file.trim() !== "" ? normalizeRelPath(record.file) : null;
      leads.push({ role, file, excerpt: excerptOf(record.message) });
    }
  }
  return leads;
}

// ---------------------------------------------------------------------------
// #921: the corpus-diff coverage rule
// ---------------------------------------------------------------------------

/** The level-1 heading the corpus renderer gives the diff section
 * (corpus/assemble.ts `pushSection("# PR Diff (truncated)", …)`) and the
 * body-truncation marker line that ends the surviving corpus body. The
 * credit only counts bytes between that heading and whichever comes first:
 * the next level-1 heading (the section closed intact) or the truncation
 * marker (the corpus body was cut). */
const DIFF_SECTION_HEADING = "# PR Diff (truncated)";
const BODY_TRUNCATION_MARKER = "…[review corpus truncated to fit the model context budget]";

/** The corpus's diff-section bytes, or null when the corpus carries no diff
 * section at all (no credit is possible without one). */
function corpusDiffSection(corpusText: string): string | null {
  let start = corpusText.indexOf(`\n${DIFF_SECTION_HEADING}\n`) + 1;
  if (start === 0 && !corpusText.startsWith(`${DIFF_SECTION_HEADING}\n`)) return null;
  const afterHeading = start + DIFF_SECTION_HEADING.length + 1;
  const body = corpusText.slice(afterHeading);
  let end = body.length;
  const nextHeading = body.indexOf("\n# ");
  if (nextHeading >= 0 && nextHeading < end) end = nextHeading;
  const truncated = body.indexOf(`\n${BODY_TRUNCATION_MARKER}`);
  if (truncated >= 0 && truncated < end) end = truncated;
  return body.slice(0, end);
}

/** Per-file diff chunks keyed by their b/-side path, straight from the RAW
 * `pr.diff` (the authoritative source the corpus prioritizer slices). The
 * last chunk wins for a repeated path, matching git's one-chunk-per-file
 * output. */
function rawDiffChunks(rawDiff: string): Map<string, string> {
  const chunks = new Map<string, string>();
  if (rawDiff === "") return chunks;
  const [, list] = splitChunks(Buffer.from(rawDiff, "utf8"));
  for (const [pathBytes, data] of list) {
    const path = normalizeRelPath(Buffer.from(pathBytes).toString("utf8"));
    if (path !== "") chunks.set(path, Buffer.from(data).toString("utf8"));
  }
  return chunks;
}

/**
 * Changed files whose complete, untruncated diff is in the assembled review
 * corpus (#921). A file qualifies only when its full per-file chunk from the
 * RAW `pr.diff` appears byte-exact inside the corpus's diff section: the
 * prioritizer emits whole chunks verbatim and marks clipped chunks with an
 * inline note and dropped chunks in an omitted-file manifest, so any
 * truncation or omission inside the chunk breaks the exact match and the
 * file keeps the strict tool-read rule. New files, deleted files, renames,
 * and mode-only changes all ride the same byte-exact rule.
 *
 * Deliberately narrow so the credit errs toward honesty: nothing outside the
 * diff section counts (a diff quoted in tool results or related-code
 * sections is not the corpus diff), a missing `pr.diff`, missing corpus, or
 * missing diff section credits nothing, and an added line that quotes a
 * diff header cannot forge a chunk because chunk boundaries are anchored at
 * real `diff --git` line starts in both the raw diff and the corpus.
 */
export function corpusDiffCoveredFiles(
  corpusText: string,
  rawDiff: string | null,
  changedFiles: readonly string[],
): Set<string> {
  const covered = new Set<string>();
  if (rawDiff === null || rawDiff === "" || corpusText === "") return covered;
  const area = corpusDiffSection(corpusText);
  if (area === null || area === "") return covered;
  const chunks = rawDiffChunks(rawDiff);
  for (const path of changedFiles) {
    const chunk = chunks.get(path);
    if (chunk !== undefined && chunk !== "" && area.includes(chunk)) covered.add(path);
  }
  return covered;
}

/** The path arg of the workspace-content tools that address one file. */
const FILE_READ_TOOLS = new Set(["read_file", "git_blame"]);

/** git_grep match lines are `path:lineno:content`; a path may itself
 * contain a colon, so the line number anchor is matched instead. */
const GREP_MATCH_LINE = /^(.+?):[0-9]+:/;

function pathsTouchedByLoop(outcome: LoopOutcome): Set<string> {
  const touched = new Set<string>();
  for (const call of outcome.executed) {
    if (call.result.status !== "ok") continue;
    const path = normalizeRelPath(call.args.path);
    if (FILE_READ_TOOLS.has(call.tool) && path !== "") {
      touched.add(path);
      continue;
    }
    if (call.tool === "git_grep") {
      // A grep scoped to the file itself reads its matching lines; a
      // directory-scoped grep does not mark its subtree covered.
      if (path !== "") touched.add(path);
      const inner = call.result.result;
      const matches = inner !== null && typeof inner === "object"
        ? (inner as Record<string, unknown>).matches
        : undefined;
      if (Array.isArray(matches)) {
        for (const line of matches) {
          if (typeof line !== "string") continue;
          const match = GREP_MATCH_LINE.exec(line);
          if (match) {
            const matched = normalizeRelPath(match[1]);
            if (matched !== "") touched.add(matched);
          }
        }
      }
    }
  }
  return touched;
}

/**
 * Fold the loop's call log against the changed-file manifest and the
 * specialist leads. Returns null unless the loop stopped on a budget AND
 * something was left unread/unresolved — a budget stop that left no
 * observable gap is complete coverage, and claiming otherwise would be its
 * own dishonesty.
 */
export function computePartialCoverage(
  outcome: LoopOutcome,
  inputs: {
    changedFiles: string[];
    leads: CoverageLeadRef[];
    /** #921: files whose complete diff is already in the assembled review
     * corpus (see corpusDiffCoveredFiles). Covered without a tool read; an
     * absent set means no corpus credit, which errs toward listing files. */
    corpusDiffCoveredFiles?: ReadonlySet<string>;
  },
): PartialCoverage | null {
  if (!isBudgetStopReason(outcome.stopReason)) return null;
  const touched = pathsTouchedByLoop(outcome);
  const corpus = inputs.corpusDiffCoveredFiles ?? new Set<string>();
  const coveredByCorpus = inputs.changedFiles.filter((path) => !touched.has(path) && corpus.has(path));
  const unreadFiles = inputs.changedFiles.filter((path) => !touched.has(path) && !corpus.has(path));
  const unresolvedLeads = inputs.leads.filter(
    (lead) => lead.file === null || (!touched.has(lead.file) && !corpus.has(lead.file)),
  );
  if (unreadFiles.length === 0 && unresolvedLeads.length === 0) return null;
  return {
    stop_reason: outcome.stopReason,
    changed_files_total: inputs.changedFiles.length,
    unread_files: unreadFiles,
    leads_total: inputs.leads.length,
    unresolved_leads: unresolvedLeads,
    ...(coveredByCorpus.length > 0
      ? { corpus_diff_covered_files: [...coveredByCorpus].sort() }
      : {}),
  };
}
