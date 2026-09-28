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
 * A specialist lead is resolved when its own file (if it names one) was
 * read by the rule above. A lead without a file path cannot be tied to any
 * read, so on a budget stop it always reports as unresolved — the loop has
 * no evidence showing it was investigated.
 */

import { SPECIALIST_ROLES_ORDER } from "../specialists/types.js";
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
  inputs: { changedFiles: string[]; leads: CoverageLeadRef[] },
): PartialCoverage | null {
  if (!isBudgetStopReason(outcome.stopReason)) return null;
  const touched = pathsTouchedByLoop(outcome);
  const unreadFiles = inputs.changedFiles.filter((path) => !touched.has(path));
  const unresolvedLeads = inputs.leads.filter((lead) => lead.file === null || !touched.has(lead.file));
  if (unreadFiles.length === 0 && unresolvedLeads.length === 0) return null;
  return {
    stop_reason: outcome.stopReason,
    changed_files_total: inputs.changedFiles.length,
    unread_files: unreadFiles,
    leads_total: inputs.leads.length,
    unresolved_leads: unresolvedLeads,
  };
}
