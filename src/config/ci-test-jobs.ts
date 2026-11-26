/** #1820: trusted explicit CI test-job identities. A small optional YAML file
 * maps CI check identities (the check name the forge exposes for a job) to
 * the test scope they prove. Trust model identical to `reviewer-routing.ts` /
 * `repository-config.ts`: read from the PR's BASE ref via git show, never the
 * PR head, so a contributor cannot declare their own job trusted on their own
 * branch. Absence is fine (pre-#1820 behavior); a read failure degrades to
 * "no jobs" with a surfaced warning, never silently treated as absence by the
 * caller. Individual invalid entries are dropped with a warning; malformed
 * files and mappings whose entries are all dropped report declared identities
 * as refused, keeping the workflow-surface masquerade fence armed. The configured
 * scope REPLACES job-name
 * scope heuristics for configured checks (the operator's declaration is the
 * authority). Identity matching is exact and case-sensitive after trimming:
 * only an unambiguous configured identity matches; a case/spacing mismatch
 * fails conservative to unresolved. The config-time identity scan is
 * deliberately GitHub-scoped (`.github/workflows`) because configured
 * discharge is GitHub-Actions-only; the separate workflow-surface fence is
 * broader and forge-agnostic. Discharge from configured identities is fenced:
 * a PR that changed a supported CI workflow file relative to the trusted
 * base's merge-base (or whose surface could not be verified) cannot have
 * same-named jobs discharge (#1820). This is the conservative substitute
 * where a forge does not expose workflow identity per check run. Dynamic
 * display names that interpolate `matrix.*` are accepted only when the job's
 * `strategy.matrix` is statically enumerable: a literal matrix with no
 * expression inside it, and not a reusable-workflow (`uses:`) call. Expressions
 * in `fail-fast`/`max-parallel` do not affect rendered names, and dynamic names
 * that do not interpolate `matrix.*` do not require a matrix.
 *
 * File shape (top-level `test-jobs` mapping):
 *
 * ```yaml
 * test-jobs:
 *   validate-typescript: full-suite
 *   validate-runtime-floor: full-suite
 * ```
 */

import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { RepositoryConfigError, verifyBaseRef } from "./repository-config.js";
import { isPlainObject } from "../platform/jq.js";

/** Candidate config paths, in precedence order. */
export const CI_TEST_JOBS_CANDIDATE_PATHS = [".github/pr-reviewer-ci-tests.yml", ".pr-reviewer-ci-tests.yml"] as const;
export const MAX_CI_TEST_JOBS_FILE_BYTES = 32_768;
/** Mirrors the evidence artifact's MAX_EVIDENCE_CHECKS; kept independent to avoid an enforcement dependency. */
export const MAX_CI_TEST_JOB_IDENTITIES = 50;
/** Mirrors MAX_EVIDENCE_FIELD_LENGTH; longer identities cannot match bounded evidence names. */
export const MAX_CI_TEST_JOB_IDENTITY_CHARS = 200;
/** Keep canonical scopes in sync with TEST_SCOPE_ALIASES in required-check-ci.ts. */
export const CI_TEST_SCOPES = ["full-suite", "unit", "integration", "e2e", "smoke", "acceptance", "contract", "regression", "performance", "load", "browser", "ui", "api", "functional", "mutation", "fuzz"] as const;
export type TrustedCiTestScope = (typeof CI_TEST_SCOPES)[number];

export interface TrustedCiJobs {
  readonly jobs: ReadonlyMap<string, TrustedCiTestScope>;
  /** True when config declared identities but none were honored this run
   * (surface refused them, the surface could not be read, or none validated).
   * Consumers must keep the masquerade fence armed when the surface is not
   * trusted, even though `jobs` is empty. */
  readonly identitiesRefused: boolean;
  readonly workflowSurfaceTrusted: boolean;
}

export const CI_WORKFLOW_SURFACE_PATHS = [".github/workflows", ".forgejo/workflows", ".gitea/workflows", ".gitlab-ci.yml"] as const;

const DEFAULT_GIT_TIMEOUT_SEC = 10;
export const MAX_CI_WORKFLOW_FILES = 32;
export const MAX_CI_WORKFLOW_FILE_BYTES = 262_144;
export const MAX_CI_WORKFLOW_SURFACE_BYTES = 1_048_576;

export interface CiTestJobsFile {
  readonly path: string;
  readonly text: string;
}

/** Read the optional config from the trusted base ref via `git show`. */
export function readCiTestJobsFromRef(
  ref: string,
  workspace?: string | null,
  options: { gitTimeoutSec?: number } = {},
): CiTestJobsFile | undefined {
  if (ref === "") throw new RepositoryConfigError("readCiTestJobsFromRef requires a non-empty ref");
  const cwd = workspace ?? process.cwd();
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  verifyBaseRef(ref, cwd, timeoutSec);
  for (const path of CI_TEST_JOBS_CANDIDATE_PATHS) {
    let stdout: Buffer;
    try {
      stdout = execFileSync("git", ["show", `${ref}:${path}`], {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: MAX_CI_TEST_JOBS_FILE_BYTES * 4,
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

/** Parse trusted CI job identities and count mapping entries before validation or cap drops; malformed YAML is rejected as a whole. */
export function parseCiTestJobsText(
  text: string,
  path: string,
): { jobs: ReadonlyMap<string, TrustedCiTestScope>; warnings: readonly string[]; declaredCount: number } | { malformed: true; warning: string; declaredCount: number } {
  const malformedMapping = text.match(/^["']?test-jobs["']?\s*:[ \t]*(.*)$/m);
  const malformedDeclaredCount = malformedMapping === null ? 0
    : malformedMapping[1]!.trim() !== "" && !malformedMapping[1]!.trimStart().startsWith("#") ? 1
      : text.slice((malformedMapping.index ?? 0) + malformedMapping[0].length)
        .split(/\r?\n/)
        // Best-effort block count for a file that will not parse: the
        // `test-jobs` block ends at the first line that starts at column
        // zero (a later top-level key). Quoted and unquoted key spellings
        // both count — the parser honors either.
        .reduce<{ lines: string[]; done: boolean }>((state, line) => {
          if (state.done || (line.length > 0 && !/^\s/.test(line))) return { lines: state.lines, done: true };
          return { lines: [...state.lines, line], done: false };
        }, { lines: [], done: false })
        .lines.filter((line) => /^[ \t]+[^\s#]/.test(line)).length;
  if (Buffer.byteLength(text, "utf8") > MAX_CI_TEST_JOBS_FILE_BYTES) {
    return { malformed: true, warning: `CI test jobs '${path}' exceeds the ${MAX_CI_TEST_JOBS_FILE_BYTES}-byte cap; ignoring it.`, declaredCount: malformedDeclaredCount };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { malformed: true, warning: `CI test jobs '${path}' is not valid YAML; ignoring it.`, declaredCount: malformedDeclaredCount };
  }
  if (parsed === null || parsed === undefined) return { jobs: new Map(), warnings: [], declaredCount: 0 };
  if (!isPlainObject(parsed)) return { malformed: true, warning: `CI test jobs '${path}' must parse to a mapping; ignoring it.`, declaredCount: malformedDeclaredCount };
  const rawJobs = parsed["test-jobs"];
  if (rawJobs === null && Object.hasOwn(parsed, "test-jobs")) {
    // A present-but-null `test-jobs` key declares nothing, so this is not a
    // refusal — but it is never a healthy config, so the operator still
    // hears about it instead of it reading as an absent file.
    return { jobs: new Map(), warnings: [`CI test jobs '${path}' declares a null 'test-jobs' key; treating it as no identities.`], declaredCount: 0 };
  }
  if (!isPlainObject(rawJobs)) return { malformed: true, warning: `CI test jobs '${path}' has no 'test-jobs' mapping; ignoring it.`, declaredCount: malformedDeclaredCount };
  const jobs = new Map<string, TrustedCiTestScope>();
  const warnings: string[] = [];
  const scopes: ReadonlySet<string> = new Set(CI_TEST_SCOPES);
  let entries = 0;
  for (const [rawIdentity, rawScope] of Object.entries(rawJobs)) {
    entries += 1;
    if (entries > MAX_CI_TEST_JOB_IDENTITIES) {
      if (entries === MAX_CI_TEST_JOB_IDENTITIES + 1) warnings.push(`CI test jobs '${path}' exceeds ${MAX_CI_TEST_JOB_IDENTITIES} identities; extra entries ignored.`);
      continue;
    }
    const identity = rawIdentity.trim();
    if (identity === "" || identity.length > MAX_CI_TEST_JOB_IDENTITY_CHARS) {
      warnings.push(`CI test jobs '${path}' has an empty or overlong identity; ignoring it.`);
      continue;
    }
    if (jobs.has(identity)) {
      warnings.push(`CI test jobs '${path}' has duplicate identity '${identity}' after trimming; ignoring the later entry.`);
      continue;
    }
    if (typeof rawScope !== "string" || !scopes.has(rawScope)) {
      warnings.push(`CI test jobs '${path}' identity '${identity}' has an invalid scope; ignoring it.`);
      continue;
    }
    jobs.set(identity, rawScope as TrustedCiTestScope);
  }
  return { jobs, warnings, declaredCount: entries };
}

/** Compare workflow paths from the repository root, regardless of workspace cwd. */
export function ciWorkflowSurfaceChangedFromBase(options: {
  baseRef: string;
  headRef: string;
  workspace?: string | null;
  gitTimeoutSec?: number;
}): { changed: boolean; warning: string | null } {
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  if (options.baseRef === "" || options.headRef === "") {
    return { changed: true, warning: "CI workflow surface could not be verified against the base ref: base or head ref is empty." };
  }
  try {
    const stdout = execFileSync("git", ["diff", "--name-only", `${options.baseRef}...${options.headRef}`, "--", ...CI_WORKFLOW_SURFACE_PATHS.map((path) => `:(top)${path}`)], {
      cwd: options.workspace ?? process.cwd(),
      timeout: timeoutSec * 1000,
      maxBuffer: MAX_CI_TEST_JOBS_FILE_BYTES * 4,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { changed: stdout.toString("utf8").trim() !== "", warning: null };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    const detail = typeof err.code === "string" && err.code === "ENOENT"
      ? "git executable not found"
      : err.killed || err.signal
        ? `git diff timed out after ${timeoutSec}s`
        : error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    return { changed: true, warning: `CI workflow surface could not be verified against the base ref: ${detail}.` };
  }
}

/** A job's matrix origin is statically enumerable only when the strategy is
 * a literal mapping with no expression anywhere inside it. A display name
 * that interpolates `matrix.*` on a job whose matrix is expression-derived
 * (e.g. `strategy.matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}`, where
 * the producing job may run a script checked out from the PR head) is not
 * enumerable: a PR that edits only that script can launder any name through
 * the matrix (#1820 re-review). A reusable-workflow call (`uses:`) renders
 * its name inside the callee, so the caller's matrix says nothing about the
 * name it mints. */
function matrixOriginIsStaticallyEnumerable(job: Record<string, unknown>): boolean {
  if (typeof job.uses === "string" || !isPlainObject(job.strategy) || !isPlainObject(job.strategy.matrix)) return false;
  return !strategyContainsExpression(job.strategy.matrix);
}

function strategyContainsExpression(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${{");
  if (Array.isArray(value)) return value.some(strategyContainsExpression);
  if (isPlainObject(value)) return Object.values(value).some(strategyContainsExpression);
  return false;
}

function isPrMintableDisplayName(name: string): boolean {
  let remaining = name;
  while (remaining.includes("${{")) {
    const start = remaining.indexOf("${{");
    const end = remaining.indexOf("}}", start + 3);
    if (end < 0) return true;
    const span = remaining.slice(start + 3, end);
    if (!/\b(?:matrix|strategy|vars)\s*\./i.test(span) || /\b(?:github|env|needs|steps|secrets|inputs)\b/i.test(span)) return true;
    remaining = remaining.slice(end + 2);
  }
  return false;
}

/**
 * Configured discharge binds a display name to a check run with no workflow
 * identity in the payload. The base-ref surface is the only trusted statement
 * of which names repository CI can mint, so undeclared or ambiguous names must
 * never discharge.
 */
export function ciJobIdentitiesFromRef(
  ref: string,
  workspace?: string | null,
  options: { gitTimeoutSec?: number } = {},
): { staticNames: ReadonlyMap<string, number>; prMintable: boolean; warning: string | null } {
  const empty = new Map<string, number>();
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  const cwd = workspace ?? process.cwd();
  const failure = (detail: string, file?: string) => ({
    staticNames: empty,
    prMintable: true,
    warning: `CI workflow surface could not be read from the base ref: ${file === undefined ? detail : `${file}: ${detail}`}; configured test-job identities are refused.`,
  });
  const deadline = Date.now() + timeoutSec * 1000;
  const remainingTimeout = (): number => Math.max(1_000, deadline - Date.now());
  const exhausted = (): boolean => Date.now() >= deadline;
  let listing: string;
  try {
    if (exhausted()) return failure(`surface scan exceeded ${timeoutSec}s`);
    listing = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", ":(top).github/workflows"], {
      cwd,
      timeout: remainingTimeout(),
      maxBuffer: MAX_CI_WORKFLOW_FILE_BYTES * 4,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).toString("utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    const detail = exhausted() ? `surface scan exceeded ${timeoutSec}s`
      : err.code === "ENOENT" ? "git executable not found"
        : err.killed || err.signal ? `git ls-tree timed out after ${timeoutSec}s`
          : error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    return failure(detail);
  }
  const files = listing.split("\n")
    // Extension matched case-insensitively: the scanner must never be
    // stricter than the platform about which files can define workflows.
    .filter((path) => path.startsWith(".github/workflows/") && /\.ya?ml$/i.test(path))
    .sort();
  if (files.length > MAX_CI_WORKFLOW_FILES) {
    return failure(`more than ${MAX_CI_WORKFLOW_FILES} workflow files were found (additional files omitted)`);
  }
  const staticNames = new Map<string, number>();
  let prMintable = false;
  let totalBytes = 0;
  for (const path of files) {
    let text: string;
    try {
      if (exhausted()) return failure(`surface scan exceeded ${timeoutSec}s`);
      const bytes = execFileSync("git", ["show", `${ref}:${path}`], {
        cwd,
        timeout: remainingTimeout(),
        maxBuffer: MAX_CI_WORKFLOW_FILE_BYTES + 1,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      if (bytes.byteLength > MAX_CI_WORKFLOW_FILE_BYTES) return failure(`file exceeds ${MAX_CI_WORKFLOW_FILE_BYTES}-byte cap`, path);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_CI_WORKFLOW_SURFACE_BYTES) return failure(`aggregate surface exceeds ${MAX_CI_WORKFLOW_SURFACE_BYTES}-byte cap`, path);
      text = bytes.toString("utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      const detail = exhausted() ? `surface scan exceeded ${timeoutSec}s`
        : err.code === "ENOENT" ? "git executable not found"
          : err.code === "ENOBUFS" ? `file exceeds ${MAX_CI_WORKFLOW_FILE_BYTES}-byte cap`
            : err.killed || err.signal ? `git show timed out after ${timeoutSec}s`
              : error instanceof Error ? error.message.slice(0, 300) : "unknown error";
      return failure(detail, path);
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch {
      return failure("workflow YAML is not valid", path);
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.jobs)) return failure("workflow has no jobs mapping", path);
    for (const [key, rawJob] of Object.entries(parsed.jobs)) {
      // GitHub's workflow parser rejects YAML anchors and merge keys; the
      // `yaml` package does not resolve `<<`, so a merge-key job's shape is
      // unknowable here — fail closed on the whole file rather than credit a
      // display name the platform would refuse to build anyway.
      if (isPlainObject(rawJob) && Object.keys(rawJob).some((field) => field.trim() === "<<")) {
        return failure("workflow job uses a YAML merge key (anchors are not supported)", path);
      }
      const displayName = isPlainObject(rawJob) && typeof rawJob.name === "string" && rawJob.name.trim() !== "" ? rawJob.name : undefined;
      if (displayName === undefined) {
        staticNames.set(key, (staticNames.get(key) ?? 0) + 1);
      } else if (displayName.includes("${{")) {
        const interpolatesMatrix = [...displayName.matchAll(/\$\{\{([\s\S]*?)\}\}/g)]
          .some((match) => /\bmatrix\s*\./i.test(match[1] ?? ""));
        const enumerable = !interpolatesMatrix
          || (isPlainObject(rawJob) && matrixOriginIsStaticallyEnumerable(rawJob));
        if (isPrMintableDisplayName(displayName) || (isPlainObject(rawJob) && typeof rawJob.uses === "string") || !enumerable) prMintable = true;
      } else {
        staticNames.set(displayName, (staticNames.get(displayName) ?? 0) + 1);
      }
    }
  }
  return { staticNames, prMintable, warning: prMintable
    ? "CI workflow surface contains a PR-author-controlled job display name; configured test-job identities are refused."
    : null };
}

/** Read and parse base-ref config; failures are surfaced by the resolver. */
export function resolveCiTestJobsFromRef(options: {
  baseRef: string;
  headRef?: string | undefined;
  workspace?: string | null | undefined;
  gitTimeoutSec?: number | undefined;
}): { jobs: ReadonlyMap<string, TrustedCiTestScope>; warnings: readonly string[]; sourcePath: string | null; identitiesRefused: boolean; workflowSurfaceTrusted: boolean } {
  // No trusted ref is a normal no-config state; avoid an unnecessary git call.
  if (options.baseRef === "") return { jobs: new Map(), warnings: [], sourcePath: null, identitiesRefused: false, workflowSurfaceTrusted: true };
  const surfaceState = (): { trusted: boolean; warning: string | null } => {
    if (options.headRef === undefined || options.headRef === "") {
      return { trusted: false, warning: "CI workflow surface could not be verified against the base ref: head ref is missing." };
    }
    const surface = ciWorkflowSurfaceChangedFromBase({
      baseRef: options.baseRef,
      headRef: options.headRef,
      ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
      ...(options.gitTimeoutSec !== undefined ? { gitTimeoutSec: options.gitTimeoutSec } : {}),
    });
    return { trusted: !surface.changed, warning: surface.warning };
  };
  let file: CiTestJobsFile | undefined;
  try {
    file = readCiTestJobsFromRef(options.baseRef, options.workspace, options.gitTimeoutSec === undefined ? {} : { gitTimeoutSec: options.gitTimeoutSec });
  } catch (error) {
    const warnings = [`CI test jobs could not be read from the base ref: ${error instanceof Error ? error.message : "unknown error"}; ignoring it.`];
    const surface = surfaceState();
    if (surface.warning !== null) warnings.push(surface.warning);
    return { jobs: new Map(), warnings, sourcePath: null, identitiesRefused: true, workflowSurfaceTrusted: surface.trusted };
  }
  if (file === undefined) return { jobs: new Map(), warnings: [], sourcePath: null, identitiesRefused: false, workflowSurfaceTrusted: true };
  const parsed = parseCiTestJobsText(file.text, file.path);
  if ("malformed" in parsed) {
    const warnings = [parsed.warning];
    const surface = parsed.declaredCount > 0 ? surfaceState() : { trusted: true, warning: null };
    if (surface.warning !== null) warnings.push(surface.warning);
    return { jobs: new Map(), warnings, sourcePath: null, identitiesRefused: parsed.declaredCount > 0, workflowSurfaceTrusted: surface.trusted };
  }
  const warnings = [...parsed.warnings];
  if (parsed.jobs.size === 0) {
    const surface = parsed.declaredCount > 0 ? surfaceState() : { trusted: true, warning: null };
    if (surface.warning !== null) warnings.push(surface.warning);
    return { jobs: parsed.jobs, warnings, sourcePath: file.path, identitiesRefused: parsed.declaredCount > 0, workflowSurfaceTrusted: surface.trusted };
  }
  const identities = ciJobIdentitiesFromRef(options.baseRef, options.workspace, options.gitTimeoutSec === undefined ? {} : { gitTimeoutSec: options.gitTimeoutSec });
  if (identities.prMintable) {
    warnings.push(identities.warning ?? "CI workflow surface contains a PR-author-controlled job display name; configured test-job identities are refused.");
    const surface = surfaceState();
    if (surface.warning !== null) warnings.push(surface.warning);
    return { jobs: new Map(), warnings, sourcePath: file.path, identitiesRefused: true, workflowSurfaceTrusted: surface.trusted };
  }
  if (identities.warning !== null) {
    warnings.push(identities.warning);
    const surface = surfaceState();
    if (surface.warning !== null) warnings.push(surface.warning);
    return { jobs: new Map(), warnings, sourcePath: file.path, identitiesRefused: true, workflowSurfaceTrusted: surface.trusted };
  }
  const validatedJobs = new Map<string, TrustedCiTestScope>();
  for (const [identity, scope] of parsed.jobs) {
    const occurrences = identities.staticNames.get(identity) ?? 0;
    if (occurrences === 0) {
      warnings.push(`CI test jobs '${file.path}' identity '${identity}' does not name a static job in the base ref's GitHub workflows; ignoring it.`);
    } else if (occurrences > 1) {
      warnings.push(`CI test jobs '${file.path}' identity '${identity}' names more than one job in the base ref's GitHub workflows; refusing the ambiguous identity.`);
    } else {
      validatedJobs.set(identity, scope);
    }
  }
  if (validatedJobs.size === 0) {
    const surface = surfaceState();
    if (surface.warning !== null) warnings.push(surface.warning);
    return { jobs: validatedJobs, warnings, sourcePath: file.path, identitiesRefused: true, workflowSurfaceTrusted: surface.trusted };
  }
  const surface = surfaceState();
  if (surface.warning !== null) warnings.push(surface.warning);
  return { jobs: validatedJobs, warnings, sourcePath: file.path, identitiesRefused: false, workflowSurfaceTrusted: surface.trusted };
}
