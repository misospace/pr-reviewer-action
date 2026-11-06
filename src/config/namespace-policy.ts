/** #1350: the namespace/account shared review-policy layer.
 *
 * One forge organization/account (GitHub organization, GitLab group,
 * Forgejo/Gitea owner — one normalized account scope) can define a single
 * bounded review-rule set that applies to many adopted repositories, so
 * related repositories do not have to copy/paste the same guidance or ask
 * the service operator to change global policy for every tweak.
 *
 * Where the layer sits (#1350 precedence, between #727's operator policy
 * and the repository config layer):
 *
 * ```text
 * hard security policy
 *   > operator policy            → instance config (trusted, fails closed)
 *     > namespace/account policy → THIS module's policy entries (operator-
 *                                  managed, listed in the instance config)
 *       > repository config      → base-side `.github/pr-reviewer.yml`
 *                                  (untrusted: narrow-only, warn + ignore)
 *         > engine defaults
 * ```
 *
 * Trust and authority:
 *
 * - Namespace policies are **operator-managed instance-config data**, never
 *   repository content. There is no read path from any repository tree (base
 *   or PR head) to this layer, so PR-head content can never change the
 *   shared policy governing its own review, and a member repository cannot
 *   edit policy that other repositories inherit.
 * - A policy may only narrow or add ordinary review guidance inside the
 *   operator-approved envelope: its `reviewer-defaults` keys must be
 *   `repo-configurable` contract inputs validated by the same per-type rules
 *   the repository-config layer applies, and it carries no field that could
 *   express an endpoint, credential, tool/MCP/command grant, network/host
 *   allowlist, executor, or fork-privilege change. Authority can only ever
 *   flow downward and shrink (#727's trusted ceiling is untouched).
 * - Matching is deterministic and provider-neutral: identities are
 *   case-normalized owner logins and `owner/name` pairs — the same account
 *   concept GitHub organizations, GitLab groups, and Forgejo/Gitea owners
 *   all map onto. At most one policy matches a repository; an ambiguous
 *   configuration is a config error and fails instance validation closed.
 *
 * The YAML surface is v3 kebab-case, like the rest of the config modules;
 * TypeScript fields are camelCase.
 */

import type { ActionContract } from "./contract.js";
import { isRepoSegment, parseRepoRef } from "../platform/repo-ref.js";
import { InstanceConfigError, SECRET_INPUTS, hasControlCharacters } from "./schema.js";
import { normalizeCandidate } from "./repository-config.js";

/** Hard ceiling on how many namespace policies one instance may declare. */
export const MAX_NAMESPACE_POLICIES = 64;
/** Hard ceiling on entries in one owner/repository (or exclude) list. */
export const MAX_NAMESPACE_MATCH_ENTRIES = 256;
/** Hard ceiling on inline guidance text blocks per policy. */
export const MAX_NAMESPACE_INSTRUCTION_BLOCKS = 16;
/** Hard ceiling on one inline guidance text block. */
export const MAX_NAMESPACE_INSTRUCTION_BLOCK_BYTES = 65_536;
/** Hard ceiling on the total bytes of inline guidance text across ALL
 * policies of one instance (leaving room under the aggregate
 * `MAX_INSTRUCTION_TOTAL_BYTES` budget the repository-side instruction
 * files share). */
export const MAX_NAMESPACE_INSTRUCTION_TOTAL_BYTES = 131_072;

/** Bound for one owner/login or `owner/name` identity string (matches the
 * path-cap discipline of the other operator-owned identifiers). */
const MAX_IDENTITY_BYTES = 4_096;

/** Namespace policy names use the same slug grammar as profile names. */
const NAMESPACE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export class NamespacePolicyError extends InstanceConfigError {}

export interface NamespacePolicy {
  readonly name: string;
  /** Account/organization logins this policy governs, lowercased. */
  readonly owners: readonly string[];
  /** Carve-outs: never matched by this policy even when listed above. */
  readonly excludeOwners: readonly string[];
  /** Optional refinements: specific `owner/name` repositories governed by
   * this policy (an entry whose owner is also in `owners` is a consistent
   * refinement of the same claim). */
  readonly repositories: readonly string[];
  /** Carve-outs: never matched by this policy even when listed above. */
  readonly excludeRepositories: readonly string[];
  /** The narrowed reviewer envelope this layer contributes: keys are
   * `repo-configurable` contract input ids, values normalized to the string
   * form `loadConfig` consumes (validated at `validateNamespacePolicies`). */
  readonly reviewerDefaults: Readonly<Record<string, string>>;
  /** Paths excluded from review in every governed repository. */
  readonly ignorePaths: readonly string[];
  /** When set, only paths matching are reviewed in every governed
   * repository; the repository layer may not add to this gate. */
  readonly skipOnlyPaths: readonly string[];
  /** Operator-authored inline review-guidance text blocks, in listed order
   * (order is precedence and is part of the effective-config fingerprint).
   * Text, not repo-relative paths: one definition is reused by every
   * governed repository without requiring per-repository copies, and the
   * content is operator config — it can never be supplied or edited by
   * repository/PR-head content. */
  readonly reviewInstructions: readonly string[];
  /** Stricter-only finding behavior for governed repositories. */
  readonly requireSuggestedFix: boolean;
}

export interface NamespaceScope {
  /** The repository's account/organization login (provider-neutral). */
  readonly owner: string;
  /** The repository's name. */
  readonly name: string;
}

function fail(path: string, why: string): never {
  throw new NamespacePolicyError(`${path}: ${why}`);
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

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "must be a non-empty string");
  if (hasControlCharacters(value)) fail(path, "must not contain control characters");
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

/** Validate + lowercase-normalize one owner/login identity. */
function ownerAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (Buffer.byteLength(text, "utf8") > MAX_IDENTITY_BYTES) fail(path, `must be at most ${MAX_IDENTITY_BYTES} bytes`);
  if (!isRepoSegment(text)) fail(path, "must be a forge account/organization name");
  return text.toLowerCase();
}

/** Validate + lowercase-normalize one `owner/name` repository identity. */
function repositoryAt(value: unknown, path: string): string {
  const text = stringAt(value, path);
  if (Buffer.byteLength(text, "utf8") > MAX_IDENTITY_BYTES) fail(path, `must be at most ${MAX_IDENTITY_BYTES} bytes`);
  const ref = parseRepoRef(text);
  if (ref === null) fail(path, "must be an 'owner/name' repository identity");
  return `${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}`;
}

function dedupedLowercaseOwners(value: unknown, path: string): readonly string[] {
  if (value === undefined) return Object.freeze([]) as readonly string[];
  if (!Array.isArray(value)) fail(path, "must be a list of forge account/organization names");
  if (value.length > MAX_NAMESPACE_MATCH_ENTRIES) fail(path, `must have at most ${MAX_NAMESPACE_MATCH_ENTRIES} entries`);
  const entries = value.map((entry, index) => ownerAt(entry, `${path}[${index}]`));
  if (new Set(entries).size !== entries.length) fail(path, "contains duplicate identities");
  return Object.freeze(entries) as readonly string[];
}

function dedupedLowercaseRepositories(value: unknown, path: string): readonly string[] {
  if (value === undefined) return Object.freeze([]) as readonly string[];
  if (!Array.isArray(value)) fail(path, "must be a list of 'owner/name' repository identities");
  if (value.length > MAX_NAMESPACE_MATCH_ENTRIES) fail(path, `must have at most ${MAX_NAMESPACE_MATCH_ENTRIES} entries`);
  const entries = value.map((entry, index) => repositoryAt(entry, `${path}[${index}]`));
  if (new Set(entries).size !== entries.length) fail(path, "contains duplicate identities");
  return Object.freeze(entries) as readonly string[];
}

/** Validate one repo-relative path glob with the same per-entry rules the
 * effective-config path lists apply (no leading `/`, no `..` segment, no
 * control characters, bounded length, bounded count; a bare scalar is
 * accepted as a one-element list). This is the trusted operator layer, so
 * any problem fails closed instead of warn-and-skip. */
function validatePathGlobsStrict(value: unknown, path: string): readonly string[] {
  if (value === undefined) return Object.freeze([]) as readonly string[];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 64) fail(path, `must have at most 64 entries`);
  return Object.freeze(entries.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "string" || entry === "") fail(entryPath, "must be a non-empty string");
    if (Buffer.byteLength(entry, "utf8") > 256) fail(entryPath, "must be at most 256 bytes");
    if (hasControlCharacters(entry)) fail(entryPath, "must not contain control characters");
    if (entry.startsWith("/") || entry.split("/").includes("..")) fail(entryPath, "must be repository-relative (no leading '/', no '..' segment)");
    return entry;
  })) as readonly string[];
}

/** Inline guidance text may legitimately contain newlines and tabs, so the
 * control-character check here is narrower than `hasControlCharacters`. */
function hasHostileControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Validate the namespace layer's reviewer defaults with the same rules the
 * instance's top-level envelope applies: only `repo-configurable` contract
 * inputs (secrets and endpoints are structurally excluded by
 * `validateContract`), values normalized by the same per-type rules the
 * repository-config layer applies. */
function validateNamespaceReviewerDefaults(value: unknown, contract: ActionContract, path: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const item = objectAt(value, path);
  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(item)) {
    const input = byId.get(key);
    if (!input || !input["repo-configurable"] || SECRET_INPUTS.has(key)) {
      fail(`${path}.${key}`, "is not a repo-configurable input; namespace policy may only narrow the operator envelope");
    }
    const candidate = normalizeCandidate(input, raw);
    if (!candidate.ok) fail(`${path}.${key}`, candidate.reason);
    out[key] = candidate.text;
  }
  return Object.freeze(out);
}

/** Validate the namespace-policies list of an instance config. Trusted
 * operator input: unknown fields are rejected at every level and ANY
 * problem throws `NamespacePolicyError` — the operator layer fails closed,
 * it never partially applies. Also fails closed when the matching space is
 * ambiguous: at most one policy may govern a given account or repository
 * (exclusions carve a policy's own matches out of its claim; they never
 * resolve a conflict between two policies). */
export function validateNamespacePolicies(value: unknown, contract: ActionContract): readonly NamespacePolicy[] {
  if (value === undefined) return Object.freeze([]) as readonly NamespacePolicy[];
  if (!Array.isArray(value)) fail("instance config.namespace-policies", "must be a list of namespace policies");
  if (value.length > MAX_NAMESPACE_POLICIES) fail("instance config.namespace-policies", `must have at most ${MAX_NAMESPACE_POLICIES} entries`);
  const policies: NamespacePolicy[] = [];
  let instructionBytes = 0;
  for (const [index, entry] of value.entries()) {
    const path = `instance config.namespace-policies[${index}]`;
    const item = objectAt(entry, path);
    rejectUnknown(
      item,
      ["name", "owners", "exclude-owners", "repositories", "exclude-repositories", "reviewer-defaults", "ignore-paths", "skip-only-paths", "review-instructions", "require-suggested-fix"],
      path,
    );
    const name = stringAt(item.name, `${path}.name`);
    if (!NAMESPACE_NAME_RE.test(name)) fail(`${path}.name`, `must match ${NAMESPACE_NAME_RE.source}`);
    const owners = dedupedLowercaseOwners(item.owners, `${path}.owners`);
    const excludeOwners = dedupedLowercaseOwners(item["exclude-owners"], `${path}.exclude-owners`);
    const repositories = dedupedLowercaseRepositories(item.repositories, `${path}.repositories`);
    const excludeRepositories = dedupedLowercaseRepositories(item["exclude-repositories"], `${path}.exclude-repositories`);
    if (owners.length === 0 && repositories.length === 0) {
      fail(`${path}`, "must govern at least one account or repository ('owners' or 'repositories' must be non-empty)");
    }
    const reviewerDefaults = validateNamespaceReviewerDefaults(item["reviewer-defaults"], contract, `${path}.reviewer-defaults`);
    const ignorePaths = validatePathGlobsStrict(item["ignore-paths"], `${path}.ignore-paths`);
    const skipOnlyPaths = validatePathGlobsStrict(item["skip-only-paths"], `${path}.skip-only-paths`);
    let reviewInstructions: readonly string[] = Object.freeze([]) as readonly string[];
    if (item["review-instructions"] !== undefined) {
      const blocksRaw = Array.isArray(item["review-instructions"]) ? item["review-instructions"] : [item["review-instructions"]];
      if (blocksRaw.length > MAX_NAMESPACE_INSTRUCTION_BLOCKS) fail(`${path}.review-instructions`, `must have at most ${MAX_NAMESPACE_INSTRUCTION_BLOCKS} blocks`);
      const blocks = blocksRaw.map((block, blockIndex) => {
        const blockPath = `${path}.review-instructions[${blockIndex}]`;
        if (typeof block !== "string" || block === "") fail(blockPath, "must be a non-empty string");
        if (Buffer.byteLength(block, "utf8") > MAX_NAMESPACE_INSTRUCTION_BLOCK_BYTES) {
          fail(blockPath, `must be at most ${MAX_NAMESPACE_INSTRUCTION_BLOCK_BYTES} bytes`);
        }
        if (hasHostileControlCharacters(block)) fail(blockPath, "must not contain control characters (newlines and tabs are allowed)");
        return block;
      });
      for (const block of blocks) instructionBytes += Buffer.byteLength(block, "utf8");
      if (instructionBytes > MAX_NAMESPACE_INSTRUCTION_TOTAL_BYTES) {
        fail(path, `review-instructions exceed the ${MAX_NAMESPACE_INSTRUCTION_TOTAL_BYTES}-byte total across all namespace policies`);
      }
      reviewInstructions = Object.freeze(blocks) as readonly string[];
    }
    policies.push(Object.freeze({
      name,
      owners,
      excludeOwners,
      repositories,
      excludeRepositories,
      reviewerDefaults,
      ignorePaths,
      skipOnlyPaths,
      reviewInstructions,
      requireSuggestedFix: item["require-suggested-fix"] === undefined ? false : booleanAt(item["require-suggested-fix"], `${path}.require-suggested-fix`),
    }));
  }
  // Deterministic matching space: exactly one policy may govern an account
  // or repository. The check MIRRORS `selectNamespacePolicy`'s match model
  // (an excluded owner kills the policy wholesale; an excluded repository
  // only blocks that repository entry) and is ORDER-INDEPENDENT: claims
  // are collected first, conflicts are detected afterwards, so the same
  // policy set validates identically in any listing order.
  //
  // 1. A policy must still govern something after its own exclusions —
  //    owners minus exclude-owners, plus repository entries whose owner the
  //    policy does not exclude (an excluded owner makes the policy's
  //    repository entries under it unmatchable, mirroring the selector).
  // 2. At most one policy may claim an account at owner level (every
  //    repository under it would otherwise match two policies).
  // 3. For every claimed repository identity, at most one policy's selector
  //    may actually match it — this catches repo-vs-repo and repo-vs-owner
  //    conflicts exactly, including the case where an owner exclusion makes
  //    one contender's claim dead.
  const ownerClaims = new Map<string, string[]>();
  const repoClaims = new Map<string, string[]>();
  for (const policy of policies) {
    const effectiveOwners = policy.owners.filter((owner) => !policy.excludeOwners.includes(owner));
    const effectiveRepositories = policy.repositories.filter((repository) => {
      if (policy.excludeRepositories.includes(repository)) return false;
      const [owner] = repository.split("/");
      return !policy.excludeOwners.includes(owner ?? "");
    });
    if (effectiveOwners.length === 0 && effectiveRepositories.length === 0) {
      fail("instance config.namespace-policies", `policy '${policy.name}' governs nothing after its own exclusions ('owners' or 'repositories' must survive them)`);
    }
    for (const owner of effectiveOwners) {
      const list = ownerClaims.get(owner) ?? [];
      list.push(policy.name);
      ownerClaims.set(owner, list);
    }
    for (const repository of effectiveRepositories) {
      const list = repoClaims.get(repository) ?? [];
      list.push(policy.name);
      repoClaims.set(repository, list);
    }
  }
  for (const [owner, claimants] of ownerClaims) {
    if (claimants.length > 1) {
      fail("instance config.namespace-policies", `policies ${claimants.map((name) => `'${name}'`).join(" and ")} both govern account '${owner}'`);
    }
  }
  for (const [repository] of repoClaims) {
    const [owner] = repository.split("/");
    const matches = policies.filter((policy) =>
      !policy.excludeRepositories.includes(repository)
      && !policy.excludeOwners.includes(owner ?? "")
      && (policy.repositories.includes(repository) || policy.owners.includes(owner ?? "")));
    if (matches.length > 1) {
      fail("instance config.namespace-policies", `policies ${matches.map((policy) => `'${policy.name}'`).join(" and ")} both match repository '${repository}'`);
    }
  }
  return Object.freeze(policies) as readonly NamespacePolicy[];
}

/**
 * Select the one namespace policy governing a repository, or `null` when
 * none does. Pure and deterministic: identities are case-normalized, the
 * repository-level entry takes the same standing as the account-level one
 * (a single policy may refine its own account claim with repository
 * entries), and exclusions carve matches out of the declaring policy only.
 * More than one match cannot happen for a validated instance (the
 * validator fails closed on ambiguous claims) — if it is ever handed an
 * unvalidated list, this throws rather than picking one.
 */
export function selectNamespacePolicy(policies: readonly NamespacePolicy[], scope: NamespaceScope): NamespacePolicy | null {
  const owner = scope.owner.toLowerCase();
  const repository = `${owner}/${scope.name.toLowerCase()}`;
  const matches = policies.filter((policy) =>
    !policy.excludeRepositories.includes(repository)
    && !policy.excludeOwners.includes(owner)
    && (policy.repositories.includes(repository) || policy.owners.includes(owner)));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new NamespacePolicyError(`namespace policy selection is ambiguous for '${repository}': ${matches.map(({ name }) => name).join(", ")}`);
  }
  return matches[0] ?? null;
}
