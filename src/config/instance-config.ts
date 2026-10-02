/** #727: the Operator-mode instance configuration schema (v1).
 *
 * One operator installs one controller for many repositories. The instance
 * config is that operator's **trusted** policy file: it defines the forge
 * integrations, the named model/executor/evidence profiles repositories may
 * select from, the adoption policy, and the global reviewer defaults that
 * form the envelope repository config may narrow.
 *
 * Trust model (the #727 layering, made structural):
 *
 * - **Hard security policy** is not a config section — it is what this
 *   validator refuses to express. There is no field anywhere in the schema
 *   for inline credentials (only opaque *credential references* resolved by
 *   the #735 credential broker), model endpoints are scheme-checked
 *   http/https with no embedded credentials, executor profiles are a closed
 *   `kind` enum with bounded scalars (there is nowhere to put an image,
 *   PodSpec, or host path), and every budget carries a hard ceiling. Unknown
 *   fields are rejected at every level, so a hostile or mistaken key has no
 *   place to land.
 * - **Operator policy** is this file — trusted input, validated strictly.
 *   A malformed or invalid instance config must fail closed (a typed error
 *   the controller refuses to start on), never partially apply: silently
 *   running with a subset of the operator's policy could only ever be
 *   *wider* than intended, never narrower.
 * - **Repository config** is untrusted and is resolved by
 *   `effective-config.ts` (which reuses `repository-config.ts`'s
 *   narrow-only precedence); it can never create authority this file did
 *   not grant.
 *
 * Profiles are **names**, not infrastructure (#727): repository config
 * references `model-profile: local-fast`, never a URL, image, PodSpec, or
 * credential. An unknown name is rejected or falls back to the operator's
 * default according to the explicit `unknown-profile-policy` knob — it can
 * never become arbitrary infrastructure.
 *
 * The YAML surface is v3 kebab-case (same convention as
 * `contracts/action-v3.yml`); TypeScript fields are camelCase. `version` is
 * required and must be exactly 1; schema evolution is additive within v1
 * and version-bumped otherwise.
 */

import { parse as parseYaml } from "yaml";
import { parseRepoRef } from "../platform/repo-ref.js";
import type { ActionContract } from "./contract.js";
import type { AdoptionPolicy } from "./adoption.js";
import { SECRET_INPUTS } from "./schema.js";
import type { ApiFormat } from "./types.js";
import { normalizeCandidate } from "./repository-config.js";

/** Hard byte cap on the instance config file itself. The file is trusted
 * operator input, but the controller still bounds what it will ever parse. */
export const MAX_INSTANCE_CONFIG_BYTES = 262_144;

/** Hard ceiling for a model profile's declared context window. */
export const MAX_MODEL_CONTEXT_TOKENS = 10_000_000;

/** Hard ceiling for an executor profile's per-worker review concurrency. */
export const MAX_EXECUTOR_MAX_REVIEWS = 64;

/** Hard ceiling for the controller's review concurrency. */
export const MAX_QUEUE_CONCURRENT_REVIEWS = 256;

/** Hard ceiling on adoption list entries (and, reusing the same generous
 * bound, on profile-list length). */
export const MAX_ADOPTION_LIST_ENTRIES = 10_000;

const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CREDENTIAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_ENDPOINT_BYTES = 2048;
const MAX_PATH_BYTES = 4_096;

export type UnknownProfilePolicy = "reject" | "fallback_default";

export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly currency: string;
}

export interface ModelProfile {
  readonly name: string;
  readonly endpoint: string;
  readonly apiFormat: ApiFormat;
  /** Opaque credential reference resolved by the credential broker (#735).
   * Never an inline secret — the schema has no field that could hold one. */
  readonly credential: string;
  readonly contextTokens: number | null;
  readonly pricing: ModelPricing | null;
}

export interface ForgeIntegration {
  readonly name: string;
  readonly kind: "github" | "forgejo";
  readonly endpoint: string;
  readonly credential: string;
}

export interface ExecutorProfile {
  readonly name: string;
  /** Closed set. OCI/Kubernetes-specific fields arrive with #733/#734 as a
   * versioned schema extension — never as free-form specs here. */
  readonly kind: "local" | "oci" | "kubernetes";
  readonly maxReviews: number | null;
}

export interface EvidenceProfile {
  readonly name: string;
  /** Operator-owned path to an evidence-providers file (the same format as
   * the Action's `evidence-providers-file` input). Provider commands are
   * operator-defined; repositories select a profile by name only. */
  readonly providersFile: string;
}

export interface InstanceQueue {
  readonly maxConcurrentReviews: number | null;
}

export interface InstanceStorage {
  readonly statePath: string | null;
  readonly workspaceCachePath: string | null;
}

export interface InstanceConfig {
  readonly version: 1;
  /** What happens when repository config selects a profile name the
   * instance does not define: `reject` (default) fails the review closed
   * with a bounded diagnostic; `fallback_default` falls back to the
   * operator's default profile with a warning. Explicit either way (#727:
   * "rejected/falls back according to explicit operator policy"). */
  readonly unknownProfilePolicy: UnknownProfilePolicy;
  readonly forges: readonly ForgeIntegration[];
  readonly modelProfiles: readonly ModelProfile[];
  readonly defaultModelProfile: string;
  readonly executorProfiles: readonly ExecutorProfile[];
  readonly defaultExecutorProfile: string | null;
  readonly evidenceProfiles: readonly EvidenceProfile[];
  readonly defaultEvidenceProfile: string | null;
  readonly adoption: AdoptionPolicy;
  /** Global reviewer defaults — the envelope repository config may narrow.
   * Keys are `repo-configurable` contract input ids, normalized to the
   * string form `loadConfig` consumes (validated at `validateInstanceConfig`). */
  readonly reviewerDefaults: Readonly<Record<string, string>>;
  /** Whether repository config may override `repo-policy` inputs (the
   * operator-mode equivalent of the Action's `allow-repo-policy-overrides`). */
  readonly allowRepoPolicyOverrides: boolean;
  readonly queue: InstanceQueue;
  readonly storage: InstanceStorage;
}

export class InstanceConfigError extends Error {}

function fail(path: string, why: string): never {
  throw new InstanceConfigError(`${path}: ${why}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be a mapping");
  return value as Record<string, unknown>;
}

function rejectUnknown(item: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) fail(path, `unsupported field '${key}'`);
  }
}

/** Hygiene check shared by the config modules: true when `value` contains
 * any ASCII control character. Not a security guard — the config file is
 * trusted operator input — but a control character in a name/path/URL is
 * never what the operator meant and would only corrupt downstream
 * diagnostics. Spelled as codepoint comparisons rather than a regex class
 * so no literal control byte can ever land in this source file. */
export function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "must be a non-empty string");
  if (hasControlCharacters(value)) fail(path, "must not contain control characters");
  return value;
}

function integerAt(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "must be an integer");
  if (value < min || value > max) fail(path, `must be between ${min} and ${max}`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

/** Validate a profile/forge name: lowercase kebab-case, bounded length. */
function profileNameAt(value: unknown, path: string): string {
  const name = stringAt(value, path);
  if (!PROFILE_NAME_RE.test(name)) fail(path, `must match ${PROFILE_NAME_RE.source}`);
  return name;
}

/** Validate an endpoint URL: absolute http/https (self-hosted local models
 * stay first-class), no embedded credentials, bounded length. This is the
 * operator layer, so no host allowlisting happens here — that is the hard
 * network policy's job at execution time; the config layer enforces scheme
 * and credential hygiene so nothing secret ever lands in a URL. */
function endpointAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (Buffer.byteLength(text, "utf8") > MAX_ENDPOINT_BYTES) fail(path, `must be at most ${MAX_ENDPOINT_BYTES} bytes`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(path, "must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(path, "must be an http or https URL");
  if (url.username !== "" || url.password !== "") fail(path, "must not embed credentials in the URL");
  if (url.hostname === "") fail(path, "must have a hostname");
  return text;
}

/** Validate an opaque credential reference. Any string matching the token
 * grammar is acceptable — the reference is *resolved* by the credential
 * broker (#735); the config file never sees the secret itself. */
function credentialRefAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (!CREDENTIAL_REF_RE.test(text)) fail(path, "must be a credential reference (letters, digits, '.', '_', ':', '-')");
  return text;
}

function operatorPathAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (Buffer.byteLength(text, "utf8") > MAX_PATH_BYTES) fail(path, `must be at most ${MAX_PATH_BYTES} bytes`);
  return text;
}

function validateDuplicateNames(names: readonly string[], label: string): void {
  if (new Set(names).size !== names.length) fail(label, "contains duplicate names");
}

function validateProfilePricing(value: unknown, path: string): ModelPricing {
  const item = objectAt(value, path);
  rejectUnknown(item, ["input-per-million", "output-per-million", "currency"], path);
  const input = item["input-per-million"];
  const output = item["output-per-million"];
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) fail(`${path}.input-per-million`, "must be a non-negative finite number");
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) fail(`${path}.output-per-million`, "must be a non-negative finite number");
  let currency = "USD";
  if (item.currency !== undefined) {
    const text = stringAt(item.currency, `${path}.currency`);
    if (!CURRENCY_RE.test(text)) fail(`${path}.currency`, "must be a 3-letter uppercase currency code");
    currency = text;
  }
  return Object.freeze({ inputPerMillion: input, outputPerMillion: output, currency });
}

function validateModelProfile(value: unknown, path: string): ModelProfile {
  const item = objectAt(value, path);
  rejectUnknown(item, ["name", "endpoint", "api-format", "credential", "context-tokens", "pricing"], path);
  const name = profileNameAt(item.name, `${path}.name`);
  const apiFormat = item["api-format"];
  if (apiFormat !== "openai" && apiFormat !== "anthropic") fail(`${path}.api-format`, "must be 'openai' or 'anthropic'");
  return Object.freeze({
    name,
    endpoint: endpointAt(item.endpoint, `${path}.endpoint`),
    apiFormat,
    credential: credentialRefAt(item.credential, `${path}.credential`),
    contextTokens: item["context-tokens"] === undefined ? null : integerAt(item["context-tokens"], `${path}.context-tokens`, 1, MAX_MODEL_CONTEXT_TOKENS),
    pricing: item.pricing === undefined ? null : validateProfilePricing(item.pricing, `${path}.pricing`),
  });
}

function validateForgeIntegration(value: unknown, path: string): ForgeIntegration {
  const item = objectAt(value, path);
  rejectUnknown(item, ["name", "kind", "endpoint", "credential"], path);
  const kind = item.kind;
  if (kind !== "github" && kind !== "forgejo") fail(`${path}.kind`, "must be 'github' or 'forgejo'");
  return Object.freeze({
    name: profileNameAt(item.name, `${path}.name`),
    kind,
    endpoint: endpointAt(item.endpoint, `${path}.endpoint`),
    credential: credentialRefAt(item.credential, `${path}.credential`),
  });
}

function validateExecutorProfile(value: unknown, path: string): ExecutorProfile {
  const item = objectAt(value, path);
  // No image/podSpec/host-path field exists anywhere in this closed set —
  // that absence IS the #727 hard rule ("never becomes an arbitrary
  // container image/PodSpec/host path"), and rejectUnknown proves it for
  // any key an operator (or an injection) might try.
  rejectUnknown(item, ["name", "kind", "max-reviews"], path);
  const kind = item.kind;
  if (kind !== "local" && kind !== "oci" && kind !== "kubernetes") fail(`${path}.kind`, "must be 'local', 'oci', or 'kubernetes'");
  return Object.freeze({
    name: profileNameAt(item.name, `${path}.name`),
    kind,
    maxReviews: item["max-reviews"] === undefined ? null : integerAt(item["max-reviews"], `${path}.max-reviews`, 1, MAX_EXECUTOR_MAX_REVIEWS),
  });
}

function validateEvidenceProfile(value: unknown, path: string): EvidenceProfile {
  const item = objectAt(value, path);
  rejectUnknown(item, ["name", "providers-file"], path);
  return Object.freeze({
    name: profileNameAt(item.name, `${path}.name`),
    providersFile: operatorPathAt(item["providers-file"], `${path}.providers-file`),
  });
}

function validateAdoption(value: unknown, path: string): AdoptionPolicy {
  const item = objectAt(value, path);
  rejectUnknown(item, ["mode", "allowlist", "denylist", "discovered-default"], path);
  const mode = item.mode;
  if (mode !== "all_allowed" && mode !== "allowlist" && mode !== "opt_in" && mode !== "opt_out") {
    fail(`${path}.mode`, "must be 'all_allowed', 'allowlist', 'opt_in', or 'opt_out'");
  }
  const discoveredDefault = item["discovered-default"] ?? "skip";
  if (discoveredDefault !== "adopt" && discoveredDefault !== "skip") {
    fail(`${path}.discovered-default`, "must be 'adopt' or 'skip'");
  }
  const validateList = (listValue: unknown, label: string): readonly string[] => {
    if (listValue === undefined) return Object.freeze([]) as readonly string[];
    if (!Array.isArray(listValue)) fail(`${path}.${label}`, "must be a list of 'owner/name' strings");
    if (listValue.length > MAX_ADOPTION_LIST_ENTRIES) fail(`${path}.${label}`, `must have at most ${MAX_ADOPTION_LIST_ENTRIES} entries`);
    const entries = listValue.map((entry, index) => {
      const text = stringAt(entry, `${path}.${label}[${index}]`);
      if (parseRepoRef(text) === null) fail(`${path}.${label}[${index}]`, "must be an 'owner/name' repository identity");
      return text;
    });
    if (new Set(entries).size !== entries.length) fail(`${path}.${label}`, "contains duplicate identities");
    return Object.freeze(entries) as readonly string[];
  };
  return Object.freeze({
    mode,
    allowlist: validateList(item.allowlist, "allowlist"),
    denylist: validateList(item.denylist, "denylist"),
    discoveredDefault,
  });
}

/** Validate the reviewer-defaults envelope against the action contract:
 * every key must be a `repo-configurable` contract input (secrets and
 * endpoints are structurally excluded by `validateContract`), and every
 * value must pass the same per-type validation the repository-config layer
 * applies — normalized to the string form `loadConfig` consumes. */
function validateReviewerDefaults(value: unknown, contract: ActionContract, path: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const item = objectAt(value, path);
  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(item)) {
    const input = byId.get(key);
    if (!input || !input["repo-configurable"] || SECRET_INPUTS.has(key)) {
      fail(`${path}.${key}`, "is not a repo-configurable input; reviewer defaults may only set the envelope repository config may narrow");
    }
    const candidate = normalizeCandidate(input, raw);
    if (!candidate.ok) fail(`${path}.${key}`, candidate.reason);
    out[key] = candidate.text;
  }
  return Object.freeze(out);
}

/** Validate an instance-config object (already parsed from YAML or handed
 * over as a plain object) into the frozen typed shape. Strict: unknown
 * fields are rejected at every level and any problem throws
 * `InstanceConfigError` — the operator layer fails closed, it never
 * partially applies. `contract` supplies the repo-configurable input set
 * that `reviewer-defaults` may reference. */
export function validateInstanceConfig(value: unknown, contract: ActionContract): InstanceConfig {
  const root = objectAt(value, "instance config");
  rejectUnknown(
    root,
    [
      "version", "unknown-profile-policy", "forges", "model-profiles", "default-model-profile",
      "executor-profiles", "default-executor-profile", "evidence-profiles", "default-evidence-profile",
      "adoption", "reviewer-defaults", "allow-repo-policy-overrides", "queue", "storage",
    ],
    "instance config",
  );
  if (root.version !== 1) fail("instance config.version", "must be exactly 1 (the only supported schema version)");
  const unknownProfilePolicy = root["unknown-profile-policy"] ?? "reject";
  if (unknownProfilePolicy !== "reject" && unknownProfilePolicy !== "fallback_default") {
    fail("instance config.unknown-profile-policy", "must be 'reject' or 'fallback_default'");
  }
  const modelProfilesRaw = root["model-profiles"] === undefined ? undefined : root["model-profiles"];
  if (!Array.isArray(modelProfilesRaw) || modelProfilesRaw.length === 0) {
    fail("instance config.model-profiles", "must be a non-empty list — operator mode always needs at least one model profile");
  }
  if (modelProfilesRaw.length > MAX_ADOPTION_LIST_ENTRIES) {
    fail("instance config.model-profiles", `must have at most ${MAX_ADOPTION_LIST_ENTRIES} entries`);
  }
  const models = Object.freeze(modelProfilesRaw.map((entry, index) => validateModelProfile(entry, `instance config.model-profiles[${index}]`))) as readonly ModelProfile[];
  validateDuplicateNames(models.map(({ name }) => name), "instance config.model-profiles");
  const defaultModelProfile = profileNameAt(root["default-model-profile"], "instance config.default-model-profile");
  if (!models.some(({ name }) => name === defaultModelProfile)) {
    fail("instance config.default-model-profile", `does not name a profile in model-profiles ('${defaultModelProfile}')`);
  }
  const forgesRaw = root.forges ?? [];
  if (!Array.isArray(forgesRaw)) fail("instance config.forges", "must be a list");
  const forges = Object.freeze(forgesRaw.map((entry, index) => validateForgeIntegration(entry, `instance config.forges[${index}]`)));
  validateDuplicateNames(forges.map(({ name }) => name), "instance config.forges");
  const executorsRaw = root["executor-profiles"] ?? [];
  if (!Array.isArray(executorsRaw)) fail("instance config.executor-profiles", "must be a list");
  const executors = Object.freeze(executorsRaw.map((entry, index) => validateExecutorProfile(entry, `instance config.executor-profiles[${index}]`)));
  validateDuplicateNames(executors.map(({ name }) => name), "instance config.executor-profiles");
  const defaultExecutorProfile = root["default-executor-profile"] === undefined
    ? null
    : profileNameAt(root["default-executor-profile"], "instance config.default-executor-profile");
  if (defaultExecutorProfile !== null && !executors.some(({ name }) => name === defaultExecutorProfile)) {
    fail("instance config.default-executor-profile", `does not name a profile in executor-profiles ('${defaultExecutorProfile}')`);
  }
  const evidenceRaw = root["evidence-profiles"] ?? [];
  if (!Array.isArray(evidenceRaw)) fail("instance config.evidence-profiles", "must be a list");
  const evidence = Object.freeze(evidenceRaw.map((entry, index) => validateEvidenceProfile(entry, `instance config.evidence-profiles[${index}]`)));
  validateDuplicateNames(evidence.map(({ name }) => name), "instance config.evidence-profiles");
  const defaultEvidenceProfile = root["default-evidence-profile"] === undefined
    ? null
    : profileNameAt(root["default-evidence-profile"], "instance config.default-evidence-profile");
  if (defaultEvidenceProfile !== null && !evidence.some(({ name }) => name === defaultEvidenceProfile)) {
    fail("instance config.default-evidence-profile", `does not name a profile in evidence-profiles ('${defaultEvidenceProfile}')`);
  }
  let queue: InstanceQueue = Object.freeze({ maxConcurrentReviews: null });
  if (root.queue !== undefined) {
    const item = objectAt(root.queue, "instance config.queue");
    rejectUnknown(item, ["max-concurrent-reviews"], "instance config.queue");
    queue = Object.freeze({
      maxConcurrentReviews: item["max-concurrent-reviews"] === undefined
        ? null
        : integerAt(item["max-concurrent-reviews"], "instance config.queue.max-concurrent-reviews", 1, MAX_QUEUE_CONCURRENT_REVIEWS),
    });
  }
  let storage: InstanceStorage = Object.freeze({ statePath: null, workspaceCachePath: null });
  if (root.storage !== undefined) {
    const item = objectAt(root.storage, "instance config.storage");
    rejectUnknown(item, ["state-path", "workspace-cache-path"], "instance config.storage");
    storage = Object.freeze({
      statePath: item["state-path"] === undefined ? null : operatorPathAt(item["state-path"], "instance config.storage.state-path"),
      workspaceCachePath: item["workspace-cache-path"] === undefined ? null : operatorPathAt(item["workspace-cache-path"], "instance config.storage.workspace-cache-path"),
    });
  }
  return Object.freeze({
    version: 1 as const,
    unknownProfilePolicy,
    forges,
    modelProfiles: models,
    defaultModelProfile,
    executorProfiles: executors,
    defaultExecutorProfile,
    evidenceProfiles: evidence,
    defaultEvidenceProfile,
    adoption: root.adoption === undefined
      ? Object.freeze({ mode: "allowlist" as const, allowlist: Object.freeze([]) as readonly string[], denylist: Object.freeze([]) as readonly string[], discoveredDefault: "skip" as const })
      : validateAdoption(root.adoption, "instance config.adoption"),
    reviewerDefaults: validateReviewerDefaults(root["reviewer-defaults"], contract, "instance config.reviewer-defaults"),
    allowRepoPolicyOverrides: root["allow-repo-policy-overrides"] === undefined ? false : booleanAt(root["allow-repo-policy-overrides"], "instance config.allow-repo-policy-overrides"),
    queue,
    storage,
  });
}

/** Parse instance-config YAML text (the controller's trusted config file)
 * and validate it. Any problem — size, syntax, shape, policy — throws a
 * typed `InstanceConfigError`; the caller must fail closed, never run with
 * a partial policy. */
export function parseInstanceConfigText(text: string, contract: ActionContract): InstanceConfig {
  if (Buffer.byteLength(text, "utf8") > MAX_INSTANCE_CONFIG_BYTES) {
    throw new InstanceConfigError(`instance config exceeds the ${MAX_INSTANCE_CONFIG_BYTES}-byte cap`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    throw new InstanceConfigError("instance config is not valid YAML");
  }
  return validateInstanceConfig(parsed, contract);
}
