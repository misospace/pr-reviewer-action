/** #1005: repository-owned reviewer-routing config. A small, optional YAML
 * file that maps trusted LOGICAL routing targets (e.g. `platform`,
 * `identity`, `security`) to the concrete GitHub users/teams that capability
 * means for this repository.
 *
 * The model may decide *which configured capability is needed*; this file
 * decides *who that capability means*. The model can only ever emit a logical
 * target id (validated against this file by the deterministic resolver in
 * `src/routing/human-review-routing.ts`), never a concrete GitHub identity.
 *
 * Trust model (identical to `requirement-owners.ts` / `repository-config.ts`):
 * the file is read from the PR's BASE ref via `git show <ref>:<path>`, never
 * the PR head, so a contributor cannot point a target at a reviewer of their
 * choosing on their own branch. Absence is fine; a resolution failure is
 * surfaced, never silently read as "no targets". Missing or invalid entries
 * are dropped with a warning and can never request an unconfigured identity.
 *
 * File shape (top-level `targets:` mapping; keys are lowercase hyphenated
 * slugs; `users`/`teams` are optional lists):
 *
 * ```yaml
 * targets:
 *   platform:
 *     users:
 *       - alice
 *     teams:
 *       - platform-team
 *   security:
 *     teams:
 *       - security
 * ```
 */

import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { RepositoryConfigError, verifyBaseRef } from "./repository-config.js";

/** Candidate routing-config paths, in precedence order (mirrors the
 * repository config / requirement-owners file families). */
export const REVIEWER_ROUTING_CANDIDATE_PATHS = [".github/pr-reviewer-routing.yml", ".pr-reviewer-routing.yml"] as const;

export const MAX_REVIEWER_ROUTING_FILE_BYTES = 32_768;
export const MAX_ROUTING_TARGETS = 64;
export const MAX_ROUTING_IDENTITIES_PER_TARGET = 32;
export const MAX_ROUTING_TARGET_ID_CHARS = 120;
export const MAX_ROUTING_USER_CHARS = 39;
export const MAX_ROUTING_TEAM_CHARS = 100;

const DEFAULT_GIT_TIMEOUT_SEC = 10;

/** A configured logical target and the concrete GitHub identities it maps to. */
export interface ReviewerRoutingTarget {
  readonly users: readonly string[];
  readonly teams: readonly string[];
}

export interface ReviewerRoutingConfig {
  readonly targets: ReadonlyMap<string, ReviewerRoutingTarget>;
}

export interface ReviewerRoutingFile {
  readonly path: string;
  readonly text: string;
}

/** A logical target id is a lowercase hyphenated slug (same shape as the
 * requirement-owner rule keys). */
export const REVIEWER_ROUTING_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A GitHub user login (39 chars max, alphanumeric with internal hyphens). */
export const REVIEWER_ROUTING_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A GitHub team slug (lowercase hyphenated). */
export const REVIEWER_ROUTING_TEAM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the routing config from a specific ref (the PR's trusted base ref) via
 * `git show <ref>:<path>`. Returns `undefined` only for genuine absence;
 * throws `RepositoryConfigError` for resolution failures (git missing,
 * timeout, unresolvable ref, not a git repository), which the caller must
 * surface rather than treat as "no targets". */
export function readReviewerRoutingFromRef(
  ref: string,
  workspace?: string | null,
  options: { gitTimeoutSec?: number } = {},
): ReviewerRoutingFile | undefined {
  if (ref === "") throw new RepositoryConfigError("readReviewerRoutingFromRef requires a non-empty ref");
  const cwd = workspace ?? process.cwd();
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  verifyBaseRef(ref, cwd, timeoutSec);
  for (const path of REVIEWER_ROUTING_CANDIDATE_PATHS) {
    let stdout: Buffer;
    try {
      stdout = execFileSync("git", ["show", `${ref}:${path}`], {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: MAX_REVIEWER_ROUTING_FILE_BYTES * 4,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (typeof err.code === "string" && err.code === "ENOENT") throw new RepositoryConfigError("git executable not found");
      if (err.killed || err.signal) throw new RepositoryConfigError(`git show timed out after ${timeoutSec}s reading ${path} at ${ref}`);
      continue;
    }
    return { path, text: stdout.toString("utf8") };
  }
  return undefined;
}

interface ParsedReviewerRouting {
  readonly targets: Map<string, ReviewerRoutingTarget>;
  readonly warnings: readonly string[];
}

interface MalformedReviewerRouting {
  readonly malformed: true;
  readonly warning: string;
}

function collectIdentities(
  raw: unknown,
  pattern: RegExp,
  maxChars: number,
  lower: boolean,
  warnings: string[],
  path: string,
  targetId: string,
  kind: "user" | "team",
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`Reviewer routing '${path}' target '${targetId}' has a non-list '${kind}s'; ignoring it.`);
    return [];
  }
  if (raw.length > MAX_ROUTING_IDENTITIES_PER_TARGET) {
    warnings.push(`Reviewer routing '${path}' target '${targetId}' lists more than ${MAX_ROUTING_IDENTITIES_PER_TARGET} ${kind}s; extra entries ignored.`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_ROUTING_IDENTITIES_PER_TARGET) break;
    if (typeof entry !== "string") {
      warnings.push(`Reviewer routing '${path}' target '${targetId}' has an invalid ${kind}; ignoring it.`);
      continue;
    }
    const value = lower ? entry.trim().toLowerCase() : entry.trim();
    if (value === "" || value.length > maxChars || !pattern.test(value)) {
      warnings.push(`Reviewer routing '${path}' target '${targetId}' has an invalid ${kind}; ignoring it.`);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Parse reviewer-routing YAML. Never throws: invalid YAML, a non-mapping file,
 * or a non-mapping `targets:` section is reported as malformed so the caller
 * ignores the whole file. Individual invalid targets/identities are dropped
 * with a warning; a target with no valid identity is dropped entirely, so an
 * unconfigured identity can never reach a reviewer request.
 */
export function parseReviewerRouting(text: string, path: string): ParsedReviewerRouting | MalformedReviewerRouting {
  if (Buffer.byteLength(text, "utf8") > MAX_REVIEWER_ROUTING_FILE_BYTES) {
    return { malformed: true, warning: `Reviewer routing '${path}' exceeds the ${MAX_REVIEWER_ROUTING_FILE_BYTES}-byte cap; ignoring it.` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { malformed: true, warning: `Reviewer routing '${path}' is not valid YAML; ignoring it.` };
  }
  if (parsed === null || parsed === undefined) return { targets: new Map(), warnings: [] };
  if (!isPlainObject(parsed)) {
    return { malformed: true, warning: `Reviewer routing '${path}' must parse to a mapping; ignoring it.` };
  }
  const warnings: string[] = [];
  const rawTargets = parsed["targets"];
  if (rawTargets === undefined) {
    warnings.push(`Reviewer routing '${path}' has no 'targets' section; no routing targets declared.`);
    return { targets: new Map(), warnings };
  }
  if (!isPlainObject(rawTargets)) {
    return { malformed: true, warning: `Reviewer routing '${path}' has a non-mapping 'targets' section; ignoring it.` };
  }

  const targets = new Map<string, ReviewerRoutingTarget>();
  for (const [id, value] of Object.entries(rawTargets)) {
    if (targets.size >= MAX_ROUTING_TARGETS) {
      warnings.push(`Reviewer routing '${path}' exceeds ${MAX_ROUTING_TARGETS} targets; further targets ignored.`);
      break;
    }
    const targetId = id.trim().toLowerCase();
    if (targetId === "" || targetId.length > MAX_ROUTING_TARGET_ID_CHARS || !REVIEWER_ROUTING_SLUG.test(targetId)) {
      warnings.push(`Reviewer routing '${path}' has a target key that is not a lowercase hyphenated slug; ignoring it.`);
      continue;
    }
    if (!isPlainObject(value)) {
      warnings.push(`Reviewer routing '${path}' target '${targetId}' must be a mapping with 'users'/'teams'; ignoring it.`);
      continue;
    }
    const users = collectIdentities(value["users"], REVIEWER_ROUTING_USER, MAX_ROUTING_USER_CHARS, false, warnings, path, targetId, "user");
    const teams = collectIdentities(value["teams"], REVIEWER_ROUTING_TEAM, MAX_ROUTING_TEAM_CHARS, true, warnings, path, targetId, "team");
    if (users.length === 0 && teams.length === 0) {
      warnings.push(`Reviewer routing '${path}' target '${targetId}' has no valid users or teams; ignoring it.`);
      continue;
    }
    targets.set(targetId, { users, teams });
  }
  return { targets, warnings };
}

/**
 * End-to-end: read the routing config from the trusted base ref and parse it.
 * Never throws; a read failure or malformed file degrades to "no targets" with
 * a surfaced warning, so an uncertain config can never cause a mutation.
 */
export function resolveReviewerRouting(options: {
  baseRef: string;
  workspace?: string | null | undefined;
  gitTimeoutSec?: number | undefined;
}): { targets: ReadonlyMap<string, ReviewerRoutingTarget>; warnings: readonly string[]; sourcePath: string | null } {
  let file: ReviewerRoutingFile | undefined;
  try {
    file = readReviewerRoutingFromRef(options.baseRef, options.workspace, options.gitTimeoutSec === undefined ? {} : { gitTimeoutSec: options.gitTimeoutSec });
  } catch (error) {
    return {
      targets: new Map(),
      warnings: [`Reviewer routing could not be read from the base ref: ${error instanceof Error ? error.message : "unknown error"}; ignoring it.`],
      sourcePath: null,
    };
  }
  if (file === undefined) return { targets: new Map(), warnings: [], sourcePath: null };
  const parsed = parseReviewerRouting(file.text, file.path);
  if ("malformed" in parsed) return { targets: new Map(), warnings: [parsed.warning], sourcePath: null };
  return { targets: parsed.targets, warnings: parsed.warnings, sourcePath: file.path };
}
