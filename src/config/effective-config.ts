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
 *     > namespace/account     → the operator-managed shared review policies
 *       shared review policy    of #1350 (`namespace-policy.ts`, listed in
 *                               the instance config; one definition reused
 *                               by many repositories)
 *       > repository config     → the base-side `.github/pr-reviewer.yml`
 *                                 (untrusted: total functions, warn + ignore)
 *         > engine defaults     → the action contract defaults
 * ```
 *
 * The namespace layer (#1350) is operator-managed instance-config data,
 * never repository content: a repository's PR head cannot touch it. It is
 * resolved by deterministic owner/repository matching and applies the same
 * narrow-not-widen rules, chaining the envelope so numeric ceilings and
 * enum/boolean explicit-wins cascade instance → namespace → repository.
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
import type { NamespacePolicy, NamespaceScope } from "./namespace-policy.js";
import { selectNamespacePolicy } from "./namespace-policy.js";
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

/** Which config layer supplied a shared rule, as recorded in the
 * provenance map (#1350): the instance's operator envelope, a repository's
 * base-side config, or a matched namespace/account policy
 * (`namespace:<policy-name>`). */
export type ConfigSourceLayer = "instance" | "repository" | `namespace:${string}`;

/** Provider-neutral identity of the repository being resolved: the forge
 * account/organization login and repository name, lowercased for matching
 * by `selectNamespacePolicy`. GitHub organizations, GitLab groups, and
 * Forgejo/Gitea owners all map onto this one account-scope concept; no
 * forge-specific field exists here. */
export interface EffectiveScope extends NamespaceScope {}

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
  /** The matched namespace/account shared review policy (#1350), or `null`
   * when no policy governs this repository or no scope was supplied. */
  readonly namespacePolicy: string | null;
  /** Inline shared review-guidance text blocks from the matched namespace
   * policy, in listed order (order is precedence and part of the
   * fingerprint). Content is operator config, never repository-supplied. */
  readonly namespaceReviewInstructions: readonly string[];
  /** Which layer supplied each shared rule (#1350), keyed by rule identity
   * (`reviewer-settings/<input-id>`, `ignore-paths/<glob>`,
   * `skip-only-paths/<glob>`, `review-instructions/<index>`,
   * `namespace-instructions/<index>`, `require-suggested-fix`). Scalar
   * settings record the LAST WRITER of the effective value (a repository
   * narrowing a namespace-set ceiling is attributed to the repository);
   * list-valued rules record the FIRST supplier in merge order (the
   * namespace layer merges first, so a glob both layers supplied is
   * attributed to the namespace — the list entry is identical either way).
   * Descriptive metadata about sources — derived from the same material the
   * fingerprint hashes — and deliberately excluded from it, like the
   * warnings and `repoConfigPath`: a policy rename that changes no
   * effective value is not a material change. */
  readonly provenance: Readonly<Record<string, ConfigSourceLayer>>;
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
  sourceLabel: string,
  sourcePath: string,
  warnings: string[],
): readonly string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_PATH_GLOBS) {
    warnings.push(`${sourceLabel} '${sourcePath}' sets '${key}' with more than ${MAX_PATH_GLOBS} entries; ignoring the key.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `${sourceLabel} '${sourcePath}' sets '${key}[${index}]'`;
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
  sourceLabel: string,
  sourcePath: string,
  warnings: string[],
): readonly string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_REVIEW_INSTRUCTION_FILES) {
    warnings.push(`${sourceLabel} '${sourcePath}' sets 'review-instructions' with more than ${MAX_REVIEW_INSTRUCTION_FILES} files; ignoring the key.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `${sourceLabel} '${sourcePath}' sets 'review-instructions[${index}]'`;
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
  options: { readonly scope?: EffectiveScope } = {},
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

  // Layer 2 → 3 → 4 narrowing: the operator envelope (reviewerDefaults,
  // plus the explicit policy-override opt-in), narrowed by the matched
  // #1350 namespace policy's reviewer-defaults (operator-authored, so it
  // may set repo-policy inputs without the repository opt-in — applied
  // over a gate-forced copy), then by the repository's contract-input keys with
  // the operator's own gate value restored. Chaining through
  // `applyRepositoryConfigValues` gives the cascade for free: numeric
  // ceilings chain (instance ceiling → namespace narrows below it →
  // repository narrows below the namespace ceiling) and enum/boolean
  // explicit-wins chains (instance-explicit beats namespace; a
  // namespace-set key beats the repository).
  const operatorRaw: RawInputs = instance.allowRepoPolicyOverrides
    ? { ...instance.reviewerDefaults, "allow-repo-policy-overrides": "true" }
    : instance.reviewerDefaults;
  // #1350: deterministic owner/repository matching picks the one
  // operator-managed namespace policy governing this repository (null when
  // none does, or when no scope was supplied — the Action mode never passes
  // one, so the namespace layer is inert there). The scope is trusted
  // caller input (the repository's resolved identity), but it still fails
  // closed rather than match on a malformed identity. A defensive guard
  // keeps an unvalidated instance from crashing the resolver.
  if (options.scope !== undefined) {
    const { owner, name } = options.scope;
    if (typeof owner !== "string" || typeof name !== "string" || owner === "" || name === "" || hasControlCharacters(owner) || hasControlCharacters(name)) {
      throw new EffectiveConfigError("namespace scope must carry non-empty, control-free owner and repository-name strings");
    }
  }
  const scopePolicies = Array.isArray(instance.namespacePolicies) ? instance.namespacePolicies : [];
  const policy = options.scope === undefined ? null : selectNamespacePolicy(scopePolicies, options.scope);
  const gateRaw = operatorRaw["allow-repo-policy-overrides"];
  const nsBase: RawInputs = { ...operatorRaw, "allow-repo-policy-overrides": "true" };
  const nsResult = policy
    ? applyRepositoryConfigValues(contract, nsBase, policy.reviewerDefaults, policy.name, { sourceLabel: "Namespace policy" })
    : null;
  let midRaw: RawInputs = nsResult ? { ...nsResult.raw } : { ...operatorRaw };
  if (gateRaw === undefined) {
    const { "allow-repo-policy-overrides": _gate, ...rest } = midRaw;
    void _gate;
    midRaw = rest;
  } else {
    midRaw = { ...midRaw, "allow-repo-policy-overrides": gateRaw };
  }
  // Keys the namespace layer actually applied are upper-layer ceilings for
  // the repository tier — even when a namespace value happens to equal the
  // contract default, which the default-equality heuristic alone could not
  // distinguish from "unset".
  const nsExplicit = new Set(nsResult?.appliedKeys ?? []);
  const envelope = applyRepositoryConfigValues(contract, midRaw, envelopeValues, sourcePath ?? "", { explicitKeys: nsExplicit });
  warnings.push(...(nsResult?.warnings ?? []), ...envelope.warnings);
  const reviewerSettings: Record<string, string> = {};
  for (const [key, value] of Object.entries(envelope.raw)) {
    if (value !== undefined && key !== "allow-repo-policy-overrides") reviewerSettings[key] = value;
  }

  // Path guidance merges across the namespace and repository layers:
  // `ignore-paths` unions (additive narrowing, namespace entries first);
  // `skip-only-paths` cannot union (that would widen) and its globs do not
  // compose textually, so when the namespace layer sets the gate the
  // repository's list is ignored with a warning — the conservative,
  // deterministic single-supplier rule.
  const namespaceSource: ConfigSourceLayer | null = policy === null ? null : `namespace:${policy.name}`;
  const repoIgnorePaths = validatePathGlobs(extensionValues.get("ignore-paths"), "ignore-paths", "Repository config", sourcePath ?? "", warnings);
  const ignorePaths: string[] = [];
  for (const glob of [...(policy?.ignorePaths ?? []), ...repoIgnorePaths]) {
    if (!ignorePaths.includes(glob)) ignorePaths.push(glob);
  }
  const repoSkipOnlyPaths = validatePathGlobs(extensionValues.get("skip-only-paths"), "skip-only-paths", "Repository config", sourcePath ?? "", warnings);
  let skipOnlyPaths: readonly string[] = repoSkipOnlyPaths;
  if ((policy?.skipOnlyPaths.length ?? 0) > 0) {
    if (repoSkipOnlyPaths.length > 0) {
      warnings.push(`Repository config '${sourcePath}' sets 'skip-only-paths', but namespace policy '${policy!.name}' already restricts the reviewed path set; the repository value is ignored.`);
    }
    skipOnlyPaths = policy!.skipOnlyPaths;
  }
  const reviewInstructions = validateInstructionPaths(extensionValues.get("review-instructions"), "Repository config", sourcePath ?? "", warnings);

  // Stricter-only: `false` would relax finding behavior, so it is ignored
  // with a warning (narrow-only, like every other repository key). Either
  // layer's `true` makes finding behavior stricter.
  const suggestedRaw = extensionValues.get("require-suggested-fix");
  let repoSuggestedFix = false;
  if (suggestedRaw !== undefined) {
    if (isYamlBoolean(suggestedRaw) && yamlBoolean(suggestedRaw)) repoSuggestedFix = true;
    else warnings.push(`Repository config '${sourcePath}' sets 'require-suggested-fix' to a value other than true; repository config may only make finding behavior stricter, so it is ignored.`);
  }
  const requireSuggestedFix = repoSuggestedFix || policy?.requireSuggestedFix === true;
  // Scalar attribution is last-writer: when both layers set true the
  // repository wrote the effective value last.
  const requireSuggestedFixSource: ConfigSourceLayer | null = repoSuggestedFix
    ? "repository"
    : policy?.requireSuggestedFix === true
      ? namespaceSource!
      : null;
  const namespaceReviewInstructions: readonly string[] = policy?.reviewInstructions ?? [];

  // #1350 provenance: which layer supplied each shared rule's effective
  // value — scalar settings record the last writer (a repository narrowing
  // a namespace-set ceiling value is attributed to the repository);
  // list-valued rules record the first supplier in merge order.
  const provenance: Record<string, ConfigSourceLayer> = {};
  const nsApplied = new Set(nsResult?.appliedKeys ?? []);
  const repoApplied = new Set(envelope.appliedKeys);
  for (const key of Object.keys(reviewerSettings)) {
    if (repoApplied.has(key)) provenance[`reviewer-settings/${key}`] = "repository";
    else if (nsApplied.has(key) && namespaceSource !== null) provenance[`reviewer-settings/${key}`] = namespaceSource;
    else if (key in instance.reviewerDefaults) provenance[`reviewer-settings/${key}`] = "instance";
  }
  for (const glob of ignorePaths) {
    provenance[`ignore-paths/${glob}`] = namespaceSource !== null && policy!.ignorePaths.includes(glob)
      ? namespaceSource
      : "repository";
  }
  const skipOnlySource: ConfigSourceLayer = (policy?.skipOnlyPaths.length ?? 0) > 0 && namespaceSource !== null
    ? namespaceSource
    : "repository";
  for (const glob of skipOnlyPaths) {
    provenance[`skip-only-paths/${glob}`] = skipOnlySource;
  }
  for (const [index] of reviewInstructions.entries()) {
    provenance[`review-instructions/${index}`] = "repository";
  }
  for (const [index] of namespaceReviewInstructions.entries()) {
    provenance[`namespace-instructions/${index}`] = namespaceSource!;
  }
  if (requireSuggestedFixSource !== null) provenance["require-suggested-fix"] = requireSuggestedFixSource;

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
    namespacePolicy: policy?.name ?? null,
    namespaceReviewInstructions,
    provenance,
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
 * instruction precedence is behavior. `enabled` is included because it is
 * config state: #728 names this fingerprint as the config component of job
 * identity, so an enabled and a disabled configuration must not share an
 * identity. The limit is stated plainly: this is a deterministic
 * CURRENT-state hash, not history — a full disable → re-enable cycle hashes
 * back to the original fingerprint, so whether resuming review on an
 * unchanged head needs a new generation is #728's to answer with an
 * adoption/config generation dimension layered on this fingerprint.
 * Warnings and the config file path remain excluded: they describe the
 * run; they are not config state. The namespace layer's shared inline
 * instruction blocks (#1350) ARE material — instruction precedence is
 * behavior — and are hashed in listed order when present; the key is
 * included only when non-empty so deployments without namespace policies
 * keep byte-identical fingerprints across the upgrade. The matched
 * policy's NAME and the provenance map stay excluded: they describe where
 * each rule came from, not the rule — a policy rename that changes no
 * effective value is not a material change. */
export function effectiveConfigFingerprint(
  config: Omit<EffectiveReviewConfig, "fingerprint"> | EffectiveReviewConfig,
): string {
  const material: Record<string, unknown> = {
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
  if (config.namespaceReviewInstructions.length > 0) {
    material.namespaceReviewInstructions = [...config.namespaceReviewInstructions];
  }
  const digest = createHash("sha256").update(pythonJsonStringify(material), "utf8").digest("hex");
  return `ecfg-v1-${digest}`;
}
