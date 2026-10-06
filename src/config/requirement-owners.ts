/** #958: repository-owned requirement-ownership config. A small, optional
 * YAML file that declares, for a named security boundary, the production /
 * enforcement files that own it. Requirement-trace scope treats a change to a
 * declared owner path as in-scope even when the diff repeats none of the
 * requirement's prose (#958: the fork-privilege standard guards
 * `.github/workflows/fork-ai-review.yaml`, but ordinary workflow edits repeat
 * neither `fork privilege` nor `trust boundary`).
 *
 * Ownership is architectural metadata, not a language problem: the lexical
 * subject matcher cannot tell a boundary's own file from an unrelated file
 * that merely shares a generic word (`model`, `api`, `http`, `data`, …), so
 * the association is declared explicitly instead of inferred.
 *
 * File shape (top-level `requirements:` mapping; the key is a slug whose
 * tokens of 3+ characters must all appear in the requirement text as whole
 * words — exact form, no stemming, and a slug associates with *every*
 * requirement whose text contains all its tokens, so choose distinctive
 * tokens):
 *
 * ```yaml
 * requirements:
 *   fork-privilege-separation:
 *     owners:
 *       - .github/workflows/fork-ai-review.yaml
 *       - scripts/fork_review_gate.py
 * ```
 *
 * Trust model (identical to `repository-config.ts`): the file is read from
 * the PR's BASE ref via `git show <ref>:<path>`, never the PR head, so a
 * contributor cannot escape a boundary's trace by editing the owner list on
 * their own branch. Absence is fine; a resolution failure is surfaced, never
 * silently read as "no owners". Missing or invalid metadata is dropped with a
 * warning and can never broaden scope or crash the review.
 */

import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { RepositoryConfigError, verifyBaseRef } from "./repository-config.js";
import {
  MAX_DECLARED_GROUPS_PER_RULE,
  MAX_GROUP_NAME_CHARS,
  MIN_DISTRIBUTED_GROUPS,
} from "../enforcement/requirement-trace.js";
import type { RequirementGroup, RequirementOwnership } from "../enforcement/requirement-trace.js";

/** Candidate owner-config paths, in precedence order (mirrors the repository
 * config file family). */
export const REQUIREMENT_OWNERS_CANDIDATE_PATHS = [".github/pr-reviewer-owners.yml", ".pr-reviewer-owners.yml"] as const;

export const MAX_OWNER_FILE_BYTES = 32_768;
export const MAX_OWNER_RULES = 64;
export const MAX_OWNERS_PER_RULE = 32;
export const MAX_OWNER_PATH_CHARS = 256;
export const MAX_OWNER_SLUG_CHARS = 120;
const DEFAULT_GIT_TIMEOUT_SEC = 10;

export interface RequirementOwnersFile {
  readonly path: string;
  readonly text: string;
}

/** Read the owner config from a specific ref (the PR's trusted base ref) via
 * `git show <ref>:<path>`. Returns `undefined` only for genuine absence;
 * throws `RepositoryConfigError` for resolution failures (git missing,
 * timeout, unresolvable ref, not a git repository), which the caller must
 * surface rather than treat as "no owners". */
export function readRequirementOwnersFromRef(
  ref: string,
  workspace?: string | null,
  options: { gitTimeoutSec?: number } = {},
): RequirementOwnersFile | undefined {
  if (ref === "") throw new RepositoryConfigError("readRequirementOwnersFromRef requires a non-empty ref");
  const cwd = workspace ?? process.cwd();
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  verifyBaseRef(ref, cwd, timeoutSec);
  for (const path of REQUIREMENT_OWNERS_CANDIDATE_PATHS) {
    let stdout: Buffer;
    try {
      stdout = execFileSync("git", ["show", `${ref}:${path}`], {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: MAX_OWNER_FILE_BYTES * 4,
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

interface ParsedRequirementOwners {
  readonly rules: RequirementOwnership[];
  readonly warnings: readonly string[];
}

interface MalformedRequirementOwners {
  readonly malformed: true;
  readonly warning: string;
}

/** A narrow owner glob: relative, under at least one directory, with `*`/`?`
 * segment wildcards only. `**`, absolute paths, `..`, whitespace, empty
 * segments, segments that are nothing but wildcard characters (a lone `*`
 * directory level), and a segment with more than one `*` (which backtracks
 * super-linearly) are rejected so a config typo cannot stand in for a
 * full-tree glob or stall the match. */
export function isValidOwnerPattern(pattern: string): boolean {
  if (pattern === "" || pattern.length > MAX_OWNER_PATH_CHARS) return false;
  if (/\s/.test(pattern)) return false;
  if (pattern.startsWith("/") || pattern.includes("\\") || pattern.includes("**")) return false;
  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (segments.length < 2) return false;
  if (segments.some((segment) => /^[*?]+$/.test(segment))) return false;
  if (segments.some((segment) => (segment.match(/\*/g) ?? []).length > 1)) return false;
  return true;
}

function slugTokens(slug: string): string[] {
  return slug
    .toLowerCase()
    .split("-")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse owner-config YAML. Never throws: invalid YAML, a non-mapping file, or
 * a non-mapping `requirements:` section is reported as malformed so the caller
 * ignores the whole file. Individual invalid rules/owners are dropped with a
 * warning; a rule with no valid owner is dropped entirely.
 */
export function parseRequirementOwners(text: string, path: string): ParsedRequirementOwners | MalformedRequirementOwners {
  if (Buffer.byteLength(text, "utf8") > MAX_OWNER_FILE_BYTES) {
    return { malformed: true, warning: `Requirement owners '${path}' exceeds the ${MAX_OWNER_FILE_BYTES}-byte cap; ignoring it.` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { malformed: true, warning: `Requirement owners '${path}' is not valid YAML; ignoring it.` };
  }
  if (parsed === null || parsed === undefined) return { rules: [], warnings: [] };
  if (!isPlainObject(parsed)) {
    return { malformed: true, warning: `Requirement owners '${path}' must parse to a mapping; ignoring it.` };
  }
  const warnings: string[] = [];
  const requirements = parsed["requirements"];
  if (requirements === undefined) {
    warnings.push(`Requirement owners '${path}' has no 'requirements' section; no owners declared.`);
    return { rules: [], warnings };
  }
  if (!isPlainObject(requirements)) {
    return { malformed: true, warning: `Requirement owners '${path}' has a non-mapping 'requirements' section; ignoring it.` };
  }

  const rules: RequirementOwnership[] = [];
  for (const [slug, value] of Object.entries(requirements)) {
    if (rules.length >= MAX_OWNER_RULES) {
      warnings.push(`Requirement owners '${path}' exceeds ${MAX_OWNER_RULES} rules; further rules ignored.`);
      break;
    }
    if (slug.length === 0 || slug.length > MAX_OWNER_SLUG_CHARS || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)) {
      warnings.push(`Requirement owners '${path}' has a rule key that is not a lowercase hyphenated slug; ignoring it.`);
      continue;
    }
    const match = slugTokens(slug);
    if (match.length === 0) {
      warnings.push(`Requirement owners '${path}' rule '${slug}' has no usable match tokens; ignoring it.`);
      continue;
    }
    if (!isPlainObject(value) || !Array.isArray(value["owners"])) {
      warnings.push(`Requirement owners '${path}' rule '${slug}' must have an 'owners' list; ignoring it.`);
      continue;
    }
    const rawOwners = value["owners"];
    if (rawOwners.length > MAX_OWNERS_PER_RULE) {
      warnings.push(`Requirement owners '${path}' rule '${slug}' lists more than ${MAX_OWNERS_PER_RULE} owners; extra owners ignored.`);
    }
    const owners: string[] = [];
    for (const owner of rawOwners) {
      if (owners.length >= MAX_OWNERS_PER_RULE) break;
      if (typeof owner !== "string" || !isValidOwnerPattern(owner)) {
        warnings.push(`Requirement owners '${path}' rule '${slug}' has an invalid owner path; ignoring it.`);
        continue;
      }
      owners.push(owner.toLowerCase());
    }
    if (owners.length === 0) {
      warnings.push(`Requirement owners '${path}' rule '${slug}' has no valid owner paths; ignoring it.`);
      continue;
    }

    let groups: RequirementGroup[] | undefined;
    if (Object.hasOwn(value, "groups")) {
      const rawGroups = value["groups"];
      const parsedGroups: RequirementGroup[] = [];
      if (Array.isArray(rawGroups)) {
        for (const rawGroup of rawGroups) {
          if (!isPlainObject(rawGroup)) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' has an invalid group; ignoring it.`);
            continue;
          }
          const name = rawGroup["name"];
          if (typeof name !== "string" || name.length === 0 || name.length > MAX_GROUP_NAME_CHARS || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' has an invalid group name; ignoring the group.`);
            continue;
          }
          const rawGroupOwners = rawGroup["owners"];
          if (!Array.isArray(rawGroupOwners)) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' must have an 'owners' list; ignoring it.`);
            continue;
          }
          if (rawGroupOwners.length > MAX_OWNERS_PER_RULE) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' lists more than ${MAX_OWNERS_PER_RULE} owners; extra owners ignored.`);
          }
          const groupOwners: string[] = [];
          for (const owner of rawGroupOwners) {
            if (groupOwners.length >= MAX_OWNERS_PER_RULE) break;
            if (typeof owner !== "string" || !isValidOwnerPattern(owner)) {
              warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' has an invalid owner path; ignoring it.`);
              continue;
            }
            groupOwners.push(owner.toLowerCase());
          }
          if (groupOwners.length === 0) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' has no valid owner paths; ignoring it.`);
            continue;
          }

          const rawTests = rawGroup["tests"];
          const groupTests: string[] = [];
          if (Array.isArray(rawTests)) {
            if (rawTests.length > MAX_OWNERS_PER_RULE) {
              warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' lists more than ${MAX_OWNERS_PER_RULE} test paths; extra paths ignored.`);
            }
            for (const test of rawTests) {
              if (groupTests.length >= MAX_OWNERS_PER_RULE) break;
              if (typeof test !== "string" || !isValidOwnerPattern(test)) {
                warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' has an invalid test path; ignoring it.`);
                continue;
              }
              groupTests.push(test.toLowerCase());
            }
          }
          if (groupTests.length === 0) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' group '${name}' has no valid test globs.`);
          }

          const existing = parsedGroups.find((group) => group.name === name);
          if (existing) {
            parsedGroups.splice(parsedGroups.indexOf(existing), 1, {
              name,
              owners: [...new Set([...existing.owners, ...groupOwners])],
              tests: [...new Set([...existing.tests, ...groupTests])],
            });
          } else {
            parsedGroups.push({ name, owners: groupOwners, tests: groupTests });
          }
        }
      } else {
        warnings.push(`Requirement owners '${path}' rule '${slug}' has a 'groups' key that is not a list; ignoring it.`);
      }
      const sortedGroups = parsedGroups.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (sortedGroups.length > MAX_DECLARED_GROUPS_PER_RULE) {
        const dropped = sortedGroups.slice(MAX_DECLARED_GROUPS_PER_RULE).map((group) => group.name);
        warnings.push(`Requirement owners '${path}' rule '${slug}' exceeds ${MAX_DECLARED_GROUPS_PER_RULE} declared groups; dropped: ${dropped.join(", ")}.`);
      }
      const cappedGroups = sortedGroups.slice(0, MAX_DECLARED_GROUPS_PER_RULE);
      const ownerSets = new Set<string>();
      const warnedOwnerPairs = new Set<string>();
      for (const group of cappedGroups) {
        for (const owner of new Set(group.owners)) {
          if (ownerSets.has(owner) && !warnedOwnerPairs.has(owner)) {
            warnings.push(`Requirement owners '${path}' rule '${slug}' has groups sharing owner glob '${owner}'.`);
            warnedOwnerPairs.add(owner);
          }
          ownerSets.add(owner);
        }
      }
      if (cappedGroups.length < MIN_DISTRIBUTED_GROUPS) {
        warnings.push(`Requirement owners '${path}' rule '${slug}' has fewer than ${MIN_DISTRIBUTED_GROUPS} valid groups; keeping it as a plain ownership rule.`);
      } else {
        groups = cappedGroups;
      }
    }
    rules.push(groups ? { match, owners, groups } : { match, owners });
  }
  return { rules, warnings };
}

/**
 * End-to-end: read the owner config from the trusted base ref and parse it.
 * Never throws; a read failure or malformed file degrades to "no owners" with
 * a surfaced warning.
 */
export function resolveRequirementOwners(options: {
  baseRef: string;
  workspace?: string | null | undefined;
  gitTimeoutSec?: number | undefined;
}): { rules: readonly RequirementOwnership[]; warnings: readonly string[]; sourcePath: string | null } {
  let file: RequirementOwnersFile | undefined;
  try {
    file = readRequirementOwnersFromRef(options.baseRef, options.workspace, options.gitTimeoutSec === undefined ? {} : { gitTimeoutSec: options.gitTimeoutSec });
  } catch (error) {
    return { rules: [], warnings: [`Requirement owners could not be read from the base ref: ${error instanceof Error ? error.message : "unknown error"}; ignoring them.`], sourcePath: null };
  }
  if (file === undefined) return { rules: [], warnings: [], sourcePath: null };
  const parsed = parseRequirementOwners(file.text, file.path);
  if ("malformed" in parsed) return { rules: [], warnings: [parsed.warning], sourcePath: null };
  return { rules: parsed.rules, warnings: parsed.warnings, sourcePath: file.path };
}
