/** #727: the three-layer effective-config resolution and the deterministic
 * fingerprint that feeds the #728 review-job identity.
 *
 * Layers (highest authority first — a lower layer may narrow, disable, or
 * tune only where the higher layer permits):
 *
 * ```text
 * hard security policy      → what this module + instance-config.ts refuse
 *                             to express (structural, not a config section)
 *   > operator policy         → InstanceConfig (validated strictly, fails closed)
 *     > repository config     → the base-side `.github/pr-reviewer.yml`
 *                               (untrusted: total functions, warn + ignore)
 *       > engine defaults     → the action contract defaults
 * ```
 *
 * The repository config file is the SAME file, trust rules, and input-id
 * language the v3 Action adopts (`repository-config.ts`, #777). Operator
 * mode adds a small set of **extension keys** (profiles, path narrowing,
 * instructions); in Action mode those keys fall under the existing
 * unknown-key warning path and are inert. Contract-input keys are narrowed
 * through `applyRepositoryConfigValues` — the one narrow-not-widen
 * implementation shared with the Action path — over the operator's
 * `reviewerDefaults` envelope.
 *
 * Everything here is pure. The only way resolution fails loudly is the
 * operator's explicit `unknown-profile-policy: reject` on an *enabled*
 * repository selecting a profile name the instance does not define —
 * fail-closed (no review) rather than reviewing with different
 * infrastructure than the operator approved. A repository that disabled
 * itself must always be able to disable itself, so a disabled repository
 * never throws.
 *
 * The fingerprint hashes the material effective config (resolved profile
 * contents, narrowed settings, path sets, instruction list) with sorted-key
 * canonical JSON, so #728 can use it as the config component of job
 * identity: a material config change forces a new review generation; a
 * reorder of the set-like path lists does not (instruction order is
 * significant and does).
 */

import { createHash } from "node:crypto";
import { compareCodePoints } from "../platform/jq.js";
import { pythonJsonStringify } from "../precheck/metadata.js";
import type { ActionContract } from "./contract.js";
import type { EvidenceProfile, ExecutorProfile, InstanceConfig, ModelProfile } from "./instance-config.js";
import { hasControlCharacters } from "./instance-config.js";
import type { RawInputs } from "./load-config.js";
import { applyRepositoryConfigValues, parseRepositoryConfigText, type RepositoryConfigFile } from "./repository-config.js";

/** The operator-mode extension keys of the shared repository config file.
 * All of them only ever narrow, disable, or select operator-approved
 * profiles — none can introduce credentials, endpoints, network, tool, or
 * fork authority. In Action mode they hit the existing unknown-key warning
 * path (inert). */
export const REPOSITORY_CONFIG_EXTENSION_KEYS = [
  "enabled",
  "model-profile",
  "executor-profile",
  "evidence-profile",
  "ignore-paths",
  "skip-only-paths",
  "review-instructions",
  "require-suggested-fix",
] as const;

/** Maximum entries per path-glob list. */
export const MAX_PATH_GLOBS = 64;
/** Maximum bytes for one path glob. */
export const MAX_PATH_GLOB_BYTES = 256;
/** Maximum number of referenced instruction files. */
export const MAX_REVIEW_INSTRUCTION_FILES = 16;
/** Hard cap for one referenced instruction file's content — enforced by
 * whoever reads the file from the trusted base tree (#728/engine); declared
 * here so the cap lives with the contract. */
export const MAX_INSTRUCTION_FILE_BYTES = 65_536;
/** Hard cap for the total bytes of all referenced instruction files. */
export const MAX_INSTRUCTION_TOTAL_BYTES = 262_144;

const EXTENSION_KEYS = new Set<string>(REPOSITORY_CONFIG_EXTENSION_KEYS);
const MAX_ECHO_CHARS = 128;

export class EffectiveConfigError extends Error {}

export interface EffectiveReviewConfig {
  readonly schemaVersion: 1;
  /** Repository config may turn review off for itself (`enabled: false`);
   * it can never force it on. */
  readonly enabled: boolean;
  /** The resolved model profile (name selection over operator-approved
   * entries — never repo-supplied infrastructure). */
  readonly modelProfile: ModelProfile;
  readonly executorProfile: ExecutorProfile | null;
  readonly evidenceProfile: EvidenceProfile | null;
  /** The narrowed reviewer envelope: the operator's `reviewerDefaults` with
   * accepted repository-config narrowing applied, keyed by contract input
   * id in the string form `loadConfig` consumes. */
  readonly reviewerSettings: Readonly<Record<string, string>>;
  /** Contract ids the repository config actually overrode. */
  readonly reviewerAppliedKeys: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly skipOnlyPaths: readonly string[];
  /** Referenced standards/rules files, in the order the repository listed
   * them (order is significant and part of the fingerprint). Paths only —
   * content is read from the trusted base tree by the review engine. */
  readonly reviewInstructions: readonly string[];
  /** Repository config may only make finding behavior stricter, never
   * looser, so only `true` is accepted. */
  readonly requireSuggestedFix: boolean;
  /** Which repository config file was used, or `null` when none was found
   * or the found file was malformed and ignored. */
  readonly repoConfigPath: string | null;
  /** `ecfg-v1-<sha256>` over the material effective config. */
  readonly fingerprint: string;
  /** Visible, non-fatal notices from repository-config handling. */
  readonly warnings: readonly string[];
}

/** Echo a repository-controlled string inside a diagnostic: control
 * characters stripped, length bounded, so hostile config content cannot
 * forge log lines or bloat warnings. */
function boundedEcho(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += char;
    if (out.length >= MAX_ECHO_CHARS) break;
  }
  return out.slice(0, MAX_ECHO_CHARS);
}

function isYamlBoolean(value: unknown): value is boolean | "true" | "false" {
  return value === true || value === false || value === "true" || value === "false";
}

function yamlBoolean(value: Exclude<unknown, undefined>): boolean {
  return value === true || value === "true";
}

/** Validate a list of repository-relative path globs (`ignore-paths` /
 * `skip-only-paths`). A bare scalar is accepted as a one-element list.
 * Per-entry problems warn and skip that entry; a structural problem (wrong
 * shape, over the count cap) warns and ignores the whole key. Globs are
 * repo-relative patterns: no leading `/`, no `..` segment, no control
 * characters, bounded length. */
function validatePathGlobs(
  value: unknown,
  key: string,
  sourcePath: string,
  warnings: string[],
): readonly string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_PATH_GLOBS) {
    warnings.push(`Repository config '${sourcePath}' sets '${key}' with more than ${MAX_PATH_GLOBS} entries; ignoring the key.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `Repository config '${sourcePath}' sets '${key}[${index}]'`;
    if (typeof entry !== "string" || entry === "") {
      warnings.push(`${label} to an invalid value (must be a non-empty string); ignoring the entry.`);
      continue;
    }
    if (Buffer.byteLength(entry, "utf8") > MAX_PATH_GLOB_BYTES) {
      warnings.push(`${label} over ${MAX_PATH_GLOB_BYTES} bytes; ignoring the entry.`);
      continue;
    }
    if (hasControlCharacters(entry)) {
      warnings.push(`${label} with control characters; ignoring the entry.`);
      continue;
    }
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      warnings.push(`${label} outside the repository (absolute or '..' segment); ignoring the entry.`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Validate the `review-instructions` list: repository-relative file paths
 * (a bare scalar is accepted as a one-element list), same per-entry rules
 * as path globs, bounded count. Referenced files are later read from the
 * trusted base tree under the MAX_INSTRUCTION_FILE_BYTES /
 * MAX_INSTRUCTION_TOTAL_BYTES caps — never from the PR head. */
function validateInstructionPaths(
  value: unknown,
  sourcePath: string,
  warnings: string[],
): readonly string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_REVIEW_INSTRUCTION_FILES) {
    warnings.push(`Repository config '${sourcePath}' sets 'review-instructions' with more than ${MAX_REVIEW_INSTRUCTION_FILES} files; ignoring the key.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `Repository config '${sourcePath}' sets 'review-instructions[${index}]'`;
    if (typeof entry !== "string" || entry === "") {
      warnings.push(`${label} to an invalid value (must be a non-empty string); ignoring the entry.`);
      continue;
    }
    if (Buffer.byteLength(entry, "utf8") > 4_096) {
      warnings.push(`${label} over 4096 bytes; ignoring the entry.`);
      continue;
    }
    if (hasControlCharacters(entry)) {
      warnings.push(`${label} with control characters; ignoring the entry.`);
      continue;
    }
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      warnings.push(`${label} outside the repository (absolute or '..' segment); ignoring the entry.`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Resolve one profile selection: the repository config may name any of the
 * operator's profiles; the default applies when it names none. An unknown
 * name follows the instance's explicit `unknownProfilePolicy` — reject
 * (throw, enabled repos only) or fall back to the operator default with a
 * warning. It never becomes infrastructure the operator did not define. */
function resolveProfile<T extends { readonly name: string }>(
  instance: InstanceConfig,
  requested: unknown,
  profiles: readonly T[],
  defaultName: string | null,
  kind: string,
  sourcePath: string,
  strict: boolean,
  warnings: string[],
): T | null {
  if (requested !== undefined) {
    if (typeof requested !== "string" || requested === "" || hasControlCharacters(requested)) {
      warnings.push(`Repository config '${sourcePath}' sets '${kind}-profile' to an invalid value; ignoring it.`);
    } else {
      const found = profiles.find(({ name }) => name === requested);
      if (found !== undefined) return found;
      const detail = `Repository config '${sourcePath}' selects unknown ${kind} profile '${boundedEcho(requested)}'`;
      if (instance.unknownProfilePolicy === "fallback_default") {
        warnings.push(`${detail}; falling back to the operator default.`);
      } else if (!strict) {
        warnings.push(`${detail}; the repository is disabled, so the selection is ignored.`);
      } else {
        throw new EffectiveConfigError(`${detail} and the operator policy is reject`);
      }
    }
  }
  if (defaultName === null) return null;
  return profiles.find(({ name }) => name === defaultName) ?? null;
}

/**
 * Resolve the effective review configuration for one repository: the
 * operator's instance policy narrowed by the repository's base-side config
 * file, with profiles resolved to operator-approved entries and a
 * deterministic fingerprint for #728 job identity.
 *
 * Fails closed (throws `EffectiveConfigError`) only for the operator's
 * explicit `unknown-profile-policy: reject` on an enabled repository.
 * Repository-side problems are always visible warnings, never exceptions,
 * and never widen the operator's policy.
 */
export function resolveEffectiveReviewConfig(
  contract: ActionContract,
  instance: InstanceConfig,
  file: RepositoryConfigFile | undefined,
): EffectiveReviewConfig {
  const warnings: string[] = [];
  let values: Readonly<Record<string, unknown>> = {};
  let sourcePath: string | null = null;
  if (file !== undefined) {
    const parsed = parseRepositoryConfigText(file.text, file.path);
    if ("malformed" in parsed) {
      warnings.push(parsed.warning);
    } else {
      values = parsed.values;
      sourcePath = file.path;
    }
  }

  // Split the shared file: contract-input keys narrow the envelope through
  // the one narrow-not-widen implementation (including its warnings for
  // non-repo-configurable/secret keys); extension keys are resolved below;
  // anything else is a visible no-op.
  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  const envelopeValues: Record<string, unknown> = {};
  const extensionValues = new Map<string, unknown>();
  for (const [key, value] of Object.entries(values)) {
    if (byId.has(key)) envelopeValues[key] = value;
    else if (EXTENSION_KEYS.has(key)) extensionValues.set(key, value);
    else warnings.push(`Repository config '${sourcePath}' sets '${key}', which the operator-mode resolver does not recognize; ignoring it.`);
  }

  // `enabled` first: a repository must always be able to disable itself,
  // even when the rest of its config is broken, so profile resolution below
  // runs non-strict for a disabled repository.
  const enabledRaw = extensionValues.get("enabled");
  let enabled = true;
  if (enabledRaw !== undefined) {
    if (isYamlBoolean(enabledRaw)) enabled = yamlBoolean(enabledRaw);
    else warnings.push(`Repository config '${sourcePath}' sets 'enabled' to an invalid value (must be a boolean); ignoring it.`);
  }

  // Layer 2 → layer 3 narrowing: the operator envelope (reviewerDefaults,
  // plus the explicit policy-override opt-in) narrowed by the repository's
  // contract-input keys, byte-identical to the Action-mode precedence.
  const operatorRaw: RawInputs = instance.allowRepoPolicyOverrides
    ? { ...instance.reviewerDefaults, "allow-repo-policy-overrides": "true" }
    : instance.reviewerDefaults;
  const envelope = applyRepositoryConfigValues(contract, operatorRaw, envelopeValues, sourcePath ?? "");
  warnings.push(...envelope.warnings);
  const reviewerSettings: Record<string, string> = {};
  for (const [key, value] of Object.entries(envelope.raw)) {
    if (value !== undefined && key !== "allow-repo-policy-overrides") reviewerSettings[key] = value;
  }

  const ignorePaths = validatePathGlobs(extensionValues.get("ignore-paths"), "ignore-paths", sourcePath ?? "", warnings);
  const skipOnlyPaths = validatePathGlobs(extensionValues.get("skip-only-paths"), "skip-only-paths", sourcePath ?? "", warnings);
  const reviewInstructions = validateInstructionPaths(extensionValues.get("review-instructions"), sourcePath ?? "", warnings);

  // Stricter-only: `false` would relax finding behavior, so it is ignored
  // with a warning (narrow-only, like every other repository key).
  let requireSuggestedFix = false;
  const suggestedRaw = extensionValues.get("require-suggested-fix");
  if (suggestedRaw !== undefined) {
    if (isYamlBoolean(suggestedRaw) && yamlBoolean(suggestedRaw)) requireSuggestedFix = true;
    else warnings.push(`Repository config '${sourcePath}' sets 'require-suggested-fix' to a value other than true; repository config may only make finding behavior stricter, so it is ignored.`);
  }

  const modelProfile = resolveProfile(instance, extensionValues.get("model-profile"), instance.modelProfiles, instance.defaultModelProfile, "model", sourcePath ?? "", enabled, warnings);
  // The instance validator guarantees a resolvable default model profile;
  // the assert keeps the resolver fail-closed if it is ever handed an
  // unvalidated instance, and narrows the type for the output contract.
  if (modelProfile === null) throw new EffectiveConfigError("instance configuration defines no default model profile");
  const executorProfile = resolveProfile(instance, extensionValues.get("executor-profile"), instance.executorProfiles, instance.defaultExecutorProfile, "executor", sourcePath ?? "", enabled, warnings);
  const evidenceProfile = resolveProfile(instance, extensionValues.get("evidence-profile"), instance.evidenceProfiles, instance.defaultEvidenceProfile, "evidence", sourcePath ?? "", enabled, warnings);

  const partial: Omit<EffectiveReviewConfig, "fingerprint"> = {
    schemaVersion: 1,
    enabled,
    modelProfile,
    executorProfile,
    evidenceProfile,
    reviewerSettings,
    reviewerAppliedKeys: envelope.appliedKeys,
    ignorePaths,
    skipOnlyPaths,
    reviewInstructions,
    requireSuggestedFix,
    repoConfigPath: sourcePath,
    warnings,
  };
  return Object.freeze({ ...partial, fingerprint: effectiveConfigFingerprint(partial) });
}

/** The deterministic `ecfg-v1-<sha256>` fingerprint over the material
 * effective config (#728 feeds this into review-job identity, so a material
 * config change starts a new review generation). Canonical serialization is
 * `pythonJsonStringify` (sorted keys at every level, byte-exact); set-like
 * path lists are sorted first so reordering them does not churn job
 * identity, while `reviewInstructions` keeps its listed order because
 * instruction precedence is behavior. `enabled` is included: #728 names
 * this fingerprint as the config component of job identity, so a
 * disable/enable transition on an unchanged PR head must not collide with
 * an already-consumed generation. Warnings and the config file path remain
 * excluded: they describe the run; they are not config state. */
export function effectiveConfigFingerprint(
  config: Omit<EffectiveReviewConfig, "fingerprint"> | EffectiveReviewConfig,
): string {
  const material = {
    version: 1,
    enabled: config.enabled,
    model: config.modelProfile,
    executor: config.executorProfile,
    evidence: config.evidenceProfile,
    reviewer: config.reviewerSettings,
    ignorePaths: [...config.ignorePaths].sort(compareCodePoints),
    skipOnlyPaths: [...config.skipOnlyPaths].sort(compareCodePoints),
    reviewInstructions: [...config.reviewInstructions],
    requireSuggestedFix: config.requireSuggestedFix,
  };
  const digest = createHash("sha256").update(pythonJsonStringify(material), "utf8").digest("hex");
  return `ecfg-v1-${digest}`;
}
