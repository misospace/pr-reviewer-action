/** Repository config (#727 design, adopted for the v3 Action by #777): an
 * optional repository-owned YAML file that may narrow — never widen — the
 * operator's workflow inputs.
 *
 * Trust model (mirrors #727 exactly, scoped to this Action):
 *   - The file is read from the PR's BASE ref (the trusted tree), never from
 *     the PR head. A PR can therefore never weaken the review of itself by
 *     editing or deleting the file on its own branch.
 *   - Only inputs the contract marks `repo-configurable` may be set at all;
 *     every other key is a no-op with a visible warning, never a crash.
 *   - For bounded numeric/budget inputs, the repository may only set a value
 *     that does not exceed the operator's effective ceiling (the operator's
 *     explicit value, or the contract default when the operator left it
 *     unset) — narrowing only, in both directions of "unset".
 *   - For enum/boolean/free-form inputs, the repository may set any
 *     contractually valid value, but only when the operator did not
 *     explicitly set that input themselves; an explicit operator value is
 *     always the ceiling and is never overridden.
 *   - A malformed file, or a file that cannot be parsed into a plain object,
 *     is ignored in its entirety (with a warning) rather than failing the
 *     review or falling back to some partial state.
 *
 * This module never fetches anything itself over the network and never
 * executes model-generated or PR-supplied text; `readRepositoryConfigFromRef`
 * shells out to `git show <ref>:<path>` (argv-only, bounded, timeout) exactly
 * like `src/context/repo-map.ts`'s `listTrackedFiles`.
 */

import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { ActionContract, ContractInput } from "./contract.js";
import { BOOLEAN_INPUTS, ENUM_INPUTS, FLOAT_INPUTS, INTEGER_INPUTS, POSITIVE_INTEGER_INPUTS, SECRET_INPUTS } from "./schema.js";
import { INTEGER_BOUNDS } from "./load-config.js";
import type { RawInputs } from "./load-config.js";

/** Candidate repository config paths, in precedence order: the first one
 * present at the base ref wins. `.github/pr-reviewer.yml` is preferred
 * because it groups with the rest of the repository's GitHub-owned config;
 * `.pr-reviewer.yml` is accepted at the repository root for parity with
 * tools that expect a dotfile there. */
export const REPOSITORY_CONFIG_CANDIDATE_PATHS = [".github/pr-reviewer.yml", ".pr-reviewer.yml"] as const;

/** Hard cap on the repository config file's byte size. Bounds the amount of
 * repository-controlled content this module will ever parse (#727 "cap
 * referenced file sizes"); an oversized file is treated as malformed. */
export const MAX_REPOSITORY_CONFIG_BYTES = 65_536;

/** Free-form string values (paths, comma lists, prompt fragments) are capped
 * independently of the whole-file cap so one enormous scalar cannot stand in
 * for the file-size guard. */
export const MAX_REPOSITORY_CONFIG_STRING_LENGTH = 4_096;

const DEFAULT_GIT_TIMEOUT_SEC = 10;

export class RepositoryConfigError extends Error {}

export interface RepositoryConfigFile {
  readonly path: string;
  readonly text: string;
}

/** Whether `ref` resolves to a real commit in this repository. Throws
 * `RepositoryConfigError` when it does not (unknown/garbage ref, or `cwd`
 * is not a git repository at all) — that is a base-ref *read failure*, a
 * categorically different situation from "a candidate path is absent at a
 * valid ref": silently proceeding as "no repository config" would leave the
 * review governed by whatever the caller's environment happens to be
 * instead of the maintainer-approved base tree (#727 "fail conservatively;
 * surface a bounded diagnostic"; the same rule `standards-file-ref.ts`
 * established per #885). `git cat-file -e <ref>^{commit}` is a silent
 * existence check (no stdout) — cheaper than `ls-tree` and unambiguous
 * about what is being tested. Exported for the shared use of
 * `src/config/instructions.ts`, which reads from the same trusted base
 * ref. */
export function verifyBaseRef(ref: string, cwd: string, timeoutSec: number): void {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
      cwd,
      timeout: timeoutSec * 1000,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean; signal?: string | null };
    if (typeof err.code === "string" && err.code === "ENOENT") throw new RepositoryConfigError("git executable not found");
    if (err.killed || err.signal) throw new RepositoryConfigError(`git cat-file timed out after ${timeoutSec}s verifying ref ${ref}`);
    throw new RepositoryConfigError(`base ref '${ref}' could not be resolved to a commit in ${cwd}`);
  }
}

/**
 * Read the repository config file from a specific ref (intended to be the
 * PR's base/merge-base ref) via `git show <ref>:<path>`, never from the
 * working tree. Tries each candidate path in order and returns the first one
 * that exists at that ref. Returns `undefined` only for genuine absence
 * (the ref resolves, neither candidate exists there — repository config is
 * optional) and throws `RepositoryConfigError` for resolution failures
 * (git missing, timeout, unresolvable ref, not a git repository) that must
 * never be silently read as "no config" (#727).
 */
export function readRepositoryConfigFromRef(
  ref: string,
  workspace?: string | null,
  options: { gitTimeoutSec?: number } = {},
): RepositoryConfigFile | undefined {
  if (ref === "") throw new RepositoryConfigError("readRepositoryConfigFromRef requires a non-empty ref");
  const cwd = workspace ?? process.cwd();
  const timeoutSec = options.gitTimeoutSec ?? DEFAULT_GIT_TIMEOUT_SEC;
  verifyBaseRef(ref, cwd, timeoutSec);
  for (const path of REPOSITORY_CONFIG_CANDIDATE_PATHS) {
    let stdout: Buffer;
    try {
      stdout = execFileSync("git", ["show", `${ref}:${path}`], {
        cwd,
        timeout: timeoutSec * 1000,
        maxBuffer: MAX_REPOSITORY_CONFIG_BYTES * 4,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean; signal?: string | null };
      if (typeof err.code === "string" && err.code === "ENOENT") throw new RepositoryConfigError("git executable not found");
      if (err.killed || err.signal) throw new RepositoryConfigError(`git show timed out after ${timeoutSec}s reading ${path} at ${ref}`);
      // Any other non-zero exit (path missing at ref, ref unknown, not a git
      // repository) means "not found here" for our purposes — try the next
      // candidate and, if none match, report no repository config at all.
      continue;
    }
    return { path, text: stdout.toString("utf8") };
  }
  return undefined;
}

interface ParsedRepositoryConfig {
  readonly values: Readonly<Record<string, unknown>>;
}

interface MalformedRepositoryConfig {
  readonly malformed: true;
  readonly warning: string;
}

/**
 * Parse repository config YAML text into a plain key/value map. Never
 * throws: invalid YAML, or YAML that does not parse to a plain object
 * (a bare scalar, a list, `null`), is reported as malformed so the caller
 * ignores the whole file rather than guessing at partial structure.
 */
export function parseRepositoryConfigText(text: string, path: string): ParsedRepositoryConfig | MalformedRepositoryConfig {
  if (Buffer.byteLength(text, "utf8") > MAX_REPOSITORY_CONFIG_BYTES) {
    return { malformed: true, warning: `Repository config '${path}' exceeds the ${MAX_REPOSITORY_CONFIG_BYTES}-byte cap; ignoring it.` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { malformed: true, warning: `Repository config '${path}' is not valid YAML; ignoring it.` };
  }
  if (parsed === null || parsed === undefined) return { values: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { malformed: true, warning: `Repository config '${path}' must parse to a mapping of keys to values; ignoring it.` };
  }
  return { values: parsed as Record<string, unknown> };
}

export interface RepositoryConfigResolution {
  /** The final raw input map, ready to pass to `loadConfig`: the operator's
   * inputs with any accepted repository-config narrowing applied. */
  readonly raw: RawInputs;
  /** Visible, non-fatal notices: unknown/non-configurable keys, rejected
   * values, malformed-file/oversized-file notices, and (when repository
   * config narrowed an operator default) which keys were applied. */
  readonly warnings: readonly string[];
  /** Which repository config file was used, or `null` when none was found
   * or the found file was malformed and ignored. */
  readonly sourcePath: string | null;
  /** Contract ids the repository config actually overrode. */
  readonly appliedKeys: readonly string[];
}

function stringifyDefault(input: ContractInput): string {
  return input.default === undefined ? "" : String(input.default);
}

/** True when the operator's own raw input differs from the contract
 * default — the closest signal this Action can observe for "the workflow
 * author explicitly set this input" (GitHub Actions gives composite actions
 * no way to distinguish an input explicitly set to its own default from one
 * left unset; see docs/repository-config.md). */
function isOperatorExplicit(input: ContractInput, operatorRaw: RawInputs): boolean {
  const value = operatorRaw[input.id];
  if (value === undefined) return false;
  return value !== stringifyDefault(input);
}

/** The operator's effective ceiling for a bounded numeric input: their
 * explicit value if set, else the contract default. The operator's
 * workflow-level value (explicit or default) is always the ceiling —
 * repository config narrows below it, never above it. A handful of inputs
 * (`primary-tool-max-requests`, `smart-tool-max-requests`) default to an
 * empty string on purpose — "resolve a tier-aware budget at harness time"
 * rather than a fixed number — and are deliberately NOT marked
 * repo-configurable in the contract, because their real ceiling cannot be
 * resolved at config time; falling back to the type's hard range here would
 * let a repository RAISE a budget the operator never actually granted. If a
 * numeric ceiling can't be determined, this fails closed (0) rather than
 * permissively. */
function numericCeiling(input: ContractInput, operatorRaw: RawInputs): number {
  const explicit = operatorRaw[input.id];
  const fallback = stringifyDefault(input);
  const text = explicit !== undefined && explicit !== "" ? explicit : fallback;
  const parsed = Number(text);
  return text !== "" && Number.isFinite(parsed) ? parsed : 0;
}

/** Validate and normalize one candidate repository-config value into the
 * string form `loadConfig` expects, or reject it. Mirrors `loadConfig`'s own
 * per-type rules so a value accepted here can never later make `loadConfig`
 * throw. Exported for the #727 operator layer: `instance-config.ts`
 * validates its `reviewer-defaults` envelope with the exact same per-type
 * rules, so an operator-set ceiling and a repository-narrowed value can
 * never disagree about what a valid value is. */
export function normalizeCandidate(input: ContractInput, raw: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (BOOLEAN_INPUTS.has(input.id)) {
    if (typeof raw === "boolean") return { ok: true, text: raw ? "true" : "false" };
    if (raw === "true" || raw === "false") return { ok: true, text: raw };
    return { ok: false, reason: "must be a boolean" };
  }
  if (INTEGER_INPUTS.has(input.id)) {
    const number = typeof raw === "number" ? raw : typeof raw === "string" && /^-?(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(number)) return { ok: false, reason: "must be an integer" };
    const bounds = INTEGER_BOUNDS[input.id];
    if (bounds && (number < bounds[0] || number > bounds[1])) return { ok: false, reason: `must be between ${bounds[0]} and ${bounds[1]}` };
    if (POSITIVE_INTEGER_INPUTS.has(input.id) && number < 1) return { ok: false, reason: "must be at least 1" };
    return { ok: true, text: String(number) };
  }
  if (FLOAT_INPUTS.has(input.id)) {
    const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(number)) return { ok: false, reason: "must be a finite number" };
    return { ok: true, text: String(number) };
  }
  const allowed = ENUM_INPUTS[input.id];
  if (allowed) {
    if (typeof raw !== "string" || !allowed.includes(raw)) return { ok: false, reason: `must be one of: ${allowed.join(", ")}` };
    return { ok: true, text: raw };
  }
  // Free-form string (paths, comma-separated lists, prompt fragments).
  if (typeof raw !== "string") return { ok: false, reason: "must be a string" };
  if (Buffer.byteLength(raw, "utf8") > MAX_REPOSITORY_CONFIG_STRING_LENGTH) {
    return { ok: false, reason: `must be at most ${MAX_REPOSITORY_CONFIG_STRING_LENGTH} bytes` };
  }
  return { ok: true, text: raw };
}

/**
 * Apply repository config narrowing on top of the operator's raw inputs.
 * Pure and total: never throws, always returns a usable `raw` map (falling
 * back to the operator's inputs untouched when there is nothing to apply).
 */
export function applyRepositoryConfig(
  contract: ActionContract,
  operatorRaw: RawInputs,
  file: RepositoryConfigFile | undefined,
): RepositoryConfigResolution {
  if (file === undefined) {
    return { raw: { ...operatorRaw }, warnings: [], sourcePath: null, appliedKeys: [] };
  }
  const parsed = parseRepositoryConfigText(file.text, file.path);
  if ("malformed" in parsed) {
    return { raw: { ...operatorRaw }, warnings: [parsed.warning], sourcePath: null, appliedKeys: [] };
  }
  return applyRepositoryConfigValues(contract, operatorRaw, parsed.values, file.path);
}

/**
 * The precedence merge over an already-parsed repository-config key/value
 * map (the parse and malformed-file handling live in
 * `parseRepositoryConfigText`). Exported for the #727 operator layer:
 * `effective-config.ts` splits a shared repository config file into its
 * contract-input keys (narrowed here, byte-identical to the Action path)
 * and its operator-extension keys (resolved separately), so both modes run
 * ONE narrow-not-widen implementation. Same contract as
 * `applyRepositoryConfig`: pure and total, never throws.
 */
export function applyRepositoryConfigValues(
  contract: ActionContract,
  operatorRaw: RawInputs,
  values: Readonly<Record<string, unknown>>,
  sourcePath: string,
): RepositoryConfigResolution {
  const raw: Record<string, string | undefined> = { ...operatorRaw };
  const warnings: string[] = [];
  const appliedKeys: string[] = [];

  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  const policyAllowed = operatorRaw["allow-repo-policy-overrides"] === "true";
  for (const [key, value] of Object.entries(values)) {
    const input = byId.get(key);
    if (!input || !input["repo-configurable"] || SECRET_INPUTS.has(key)) {
      warnings.push(`Repository config '${sourcePath}' sets '${key}', which is not repo-configurable; ignoring it.`);
      continue;
    }
    if (input["repo-policy"] && !policyAllowed) {
      warnings.push(`Repository config '${sourcePath}' sets policy input '${key}', but the operator did not enable allow-repo-policy-overrides; ignoring it.`);
      continue;
    }
    const isNumeric = INTEGER_INPUTS.has(key) || FLOAT_INPUTS.has(key);
    if (isNumeric) {
      const candidate = normalizeCandidate(input, value);
      if (!candidate.ok) {
        warnings.push(`Repository config '${sourcePath}' sets '${key}' to an invalid value (${candidate.reason}); ignoring it.`);
        continue;
      }
      const ceiling = numericCeiling(input, operatorRaw);
      const number = Number(candidate.text);
      if (number > ceiling) {
        warnings.push(`Repository config '${sourcePath}' sets '${key}' to ${number}, which exceeds the operator ceiling of ${ceiling}; ignoring it.`);
        continue;
      }
      raw[key] = candidate.text;
      appliedKeys.push(key);
      continue;
    }
    if (isOperatorExplicit(input, operatorRaw)) {
      warnings.push(`Repository config '${sourcePath}' sets '${key}', but the operator explicitly set it; repository value ignored.`);
      continue;
    }
    const candidate = normalizeCandidate(input, value);
    if (!candidate.ok) {
      warnings.push(`Repository config '${sourcePath}' sets '${key}' to an invalid value (${candidate.reason}); ignoring it.`);
      continue;
    }
    raw[key] = candidate.text;
    appliedKeys.push(key);
  }

  return { raw, warnings, sourcePath, appliedKeys };
}

/**
 * End-to-end resolution: read the repository config from the given base
 * ref (never the PR head), then apply it on top of the operator's raw
 * inputs. `baseRef` is expected to be the trusted base/merge-base commit-ish
 * resolved by the caller (for example from the PR's `base.sha`, per
 * `src/platform/pr.ts`'s `PrIdentity`) — this function never resolves a ref
 * itself and never reads from the checked-out working tree.
 */
export function resolveRepositoryConfig(
  contract: ActionContract,
  operatorRaw: RawInputs,
  options: { baseRef: string; workspace?: string | null | undefined; gitTimeoutSec?: number | undefined },
): RepositoryConfigResolution {
  let file: RepositoryConfigFile | undefined;
  try {
    file = readRepositoryConfigFromRef(options.baseRef, options.workspace, options.gitTimeoutSec === undefined ? {} : { gitTimeoutSec: options.gitTimeoutSec });
  } catch (error) {
    return {
      raw: { ...operatorRaw },
      warnings: [`Repository config could not be read from the base ref: ${error instanceof Error ? error.message : "unknown error"}; ignoring it.`],
      sourcePath: null,
      appliedKeys: [],
    };
  }
  return applyRepositoryConfig(contract, operatorRaw, file);
}
