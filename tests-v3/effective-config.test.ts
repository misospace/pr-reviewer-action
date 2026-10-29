import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { validateInstanceConfig, type InstanceConfig } from "../src/config/instance-config.js";
import {
  effectiveConfigFingerprint,
  EffectiveConfigError,
  resolveEffectiveReviewConfig,
} from "../src/config/effective-config.js";
import type { RepositoryConfigFile } from "../src/config/repository-config.js";

const contract = validateContract(parse(readFileSync("contracts/action-v3.yml", "utf8")));

function instance(overrides: Record<string, unknown> = {}): InstanceConfig {
  return validateInstanceConfig(
    {
      version: 1,
      "model-profiles": [
        { name: "fast", endpoint: "http://model.internal:4000", "api-format": "openai", credential: "ref-a" },
        { name: "strong", endpoint: "http://model.internal:4001", "api-format": "anthropic", credential: "ref-b" },
      ],
      "default-model-profile": "fast",
      "executor-profiles": [{
        name: "default",
        kind: "local",
        local: { command: "node", args: ["worker.mjs"] },
      }],
      "default-executor-profile": "default",
      ...overrides,
    },
    contract,
  );
}

function file(text: string): RepositoryConfigFile {
  return { path: ".github/pr-reviewer.yml", text };
}

function resolve(config: InstanceConfig, text?: string) {
  return resolveEffectiveReviewConfig(contract, config, text === undefined ? undefined : file(text));
}

test("no repository config resolves entirely to operator defaults", () => {
  const config = resolve(instance());
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.enabled, true);
  assert.equal(config.modelProfile.name, "fast");
  assert.equal(config.modelProfile.endpoint, "http://model.internal:4000");
  assert.equal(config.executorProfile?.name, "default");
  assert.equal(config.evidenceProfile, null);
  assert.deepEqual({ ...config.reviewerSettings }, {});
  assert.deepEqual([...config.reviewerAppliedKeys], []);
  assert.deepEqual([...config.ignorePaths], []);
  assert.equal(config.requireSuggestedFix, false);
  assert.equal(config.repoConfigPath, null);
  assert.deepEqual([...config.warnings], []);
  assert.match(config.fingerprint, /^ecfg-v1-[0-9a-f]{64}$/);
});

test("repository config narrows the envelope through the shared narrow-not-widen rule", () => {
  const config = resolve(instance(), "inline-findings-max: 10\nreview-verbosity: concise\n");
  assert.equal(config.reviewerSettings["inline-findings-max"], "10");
  assert.equal(config.reviewerSettings["review-verbosity"], "concise");
  assert.deepEqual([...config.reviewerAppliedKeys], ["inline-findings-max", "review-verbosity"]);
});

test("a repository can narrow but never widen an operator-set ceiling", () => {
  const config = resolve(instance({ "reviewer-defaults": { "inline-findings-max": 5 } }), "inline-findings-max: 25\n");
  assert.equal(config.reviewerSettings["inline-findings-max"], "5");
  assert.match(config.warnings.join("\n"), /exceeds the operator ceiling of 5/);
});

test("a repository cannot widen a budget the operator left at the contract default", () => {
  const config = resolve(instance(), "inline-findings-max: 9999\n");
  // Ignored entirely: the key stays absent and the engine falls back to the
  // contract default (20). Repository config never raises it.
  assert.equal(config.reviewerSettings["inline-findings-max"], undefined);
  assert.match(config.warnings.join("\n"), /exceeds the operator ceiling/);
});

test("repo config cannot set secrets, models, tool, or fork authority keys", () => {
  const text = [
    "ai-api-key: stolen",
    "github-token: stolen",
    "ai-model: some-model",
    "evidence-providers-file: hostile.yml",
    "tool-mode: native_loop",
    "tool-enable-for-forks: true",
  ].join("\n");
  const config = resolve(instance(), text);
  assert.deepEqual({ ...config.reviewerSettings }, {});
  assert.deepEqual([...config.reviewerAppliedKeys], []);
  const joined = config.warnings.join("\n");
  for (const key of ["ai-api-key", "github-token", "ai-model", "evidence-providers-file", "tool-mode", "tool-enable-for-forks"]) {
    assert.match(joined, new RegExp(`${key}.*not repo-configurable`), key);
  }
});

test("keys the operator-mode resolver does not recognize are visible no-ops", () => {
  const config = resolve(instance(), "credentials: {token: stolen}\nendpoints: http://hostile.internal\n");
  assert.match(config.warnings.join("\n"), /does not recognize/);
  assert.deepEqual([...config.ignorePaths], []);
});

test("profiles are selected by name and resolved to operator-approved entries", () => {
  const config = resolve(instance(), "model-profile: strong\nexecutor-profile: default\n");
  assert.equal(config.modelProfile.name, "strong");
  assert.equal(config.modelProfile.endpoint, "http://model.internal:4001");
  assert.equal(config.modelProfile.apiFormat, "anthropic");
  assert.equal(config.executorProfile?.kind, "local");
});

test("an unknown profile is rejected (fail closed) under the default policy", () => {
  assert.throws(() => resolve(instance(), "model-profile: invented"), (error: unknown) => {
    const ok = error instanceof EffectiveConfigError && /unknown model profile 'invented'.*policy is reject/.test(error.message);
    return ok;
  });
  // The requested name is echoed bounded and clean in the error.
  assert.throws(
    () => resolve(instance(), `model-profile: ${"x".repeat(500)}`),
    (error: unknown) => error instanceof EffectiveConfigError && error.message.length < 300,
  );
});

test("an unknown profile falls back to the operator default under fallback_default policy", () => {
  const config = resolve(instance({ "unknown-profile-policy": "fallback_default" }), "model-profile: invented\nexecutor-profile: invented\n");
  assert.equal(config.modelProfile.name, "fast");
  assert.equal(config.executorProfile?.name, "default");
  const joined = config.warnings.join("\n");
  assert.match(joined, /unknown model profile 'invented'.*falling back/);
  assert.match(joined, /unknown executor profile 'invented'.*falling back/);
});

test("a disabled repository always resolves — it must be able to disable itself", () => {
  const text = [
    "enabled: false",
    "model-profile: invented",
    "inline-findings-max: 9999",
    "ignore-paths:",
    "  - /absolute",
    "  - ok/**",
  ].join("\n");
  const config = resolve(instance(), text);
  assert.equal(config.enabled, false);
  assert.equal(config.modelProfile.name, "fast");
  assert.deepEqual([...config.ignorePaths], ["ok/**"]);
  const joined = config.warnings.join("\n");
  assert.match(joined, /unknown model profile/);
  assert.match(joined, /exceeds the operator ceiling/);
  assert.match(joined, /outside the repository/);
});

test("enabled is narrow-only and type-checked", () => {
  assert.equal(resolve(instance(), "enabled: true\n").enabled, true);
  assert.equal(resolve(instance(), "enabled: 'false'\n").enabled, false);
  const invalid = resolve(instance(), "enabled: sometimes\n");
  assert.equal(invalid.enabled, true);
  assert.match(invalid.warnings.join("\n"), /'enabled' to an invalid value/);
});

test("malformed repository config fails conservative: operator defaults govern, one bounded warning", () => {
  const config = resolve(instance(), "{ unterminated: [1, 2");
  assert.equal(config.modelProfile.name, "fast");
  assert.deepEqual({ ...config.reviewerSettings }, {});
  assert.equal(config.repoConfigPath, null);
  assert.match(config.warnings.join("\n"), /not valid YAML/);
});

test("path globs are repo-relative, bounded, and validated per entry", () => {
  const text = [
    "ignore-paths:",
    "  - generated/**",
    "  - /absolute",
    "  - ../escape",
    "  - 'bad\u0000nul'",
  ].join("\n");
  const config = resolve(instance(), text);
  assert.deepEqual([...config.ignorePaths], ["generated/**"]);
  const joined = config.warnings.join("\n");
  assert.match(joined, /ignore-paths\[1\].*outside the repository/);
  assert.match(joined, /ignore-paths\[2\].*outside the repository/);
  assert.match(joined, /ignore-paths\[3\].*control characters/);
});

test("path-glob lists accept a bare scalar and cap their size", () => {
  assert.deepEqual([...resolve(instance(), "skip-only-paths: docs/**\n").skipOnlyPaths], ["docs/**"]);
  const many = resolve(instance(), `ignore-paths: [${Array.from({ length: 65 }, (_, i) => `p${i}/**`).join(", ")}]\n`);
  assert.deepEqual([...many.ignorePaths], []);
  assert.match(many.warnings.join("\n"), /more than 64 entries/);
});

test("review instructions are bounded repo-relative paths, kept in listed order", () => {
  const config = resolve(instance(), "review-instructions: [.pr-reviewer/rules.md, docs/standards.md]\n");
  assert.deepEqual([...config.reviewInstructions], [".pr-reviewer/rules.md", "docs/standards.md"]);
  const hostile = resolve(instance(), "review-instructions: [/etc/passwd, ../../etc/passwd]\n");
  assert.deepEqual([...hostile.reviewInstructions], []);
  const tooMany = resolve(instance(), `review-instructions: [${Array.from({ length: 17 }, (_, i) => `f${i}.md`).join(", ")}]\n`);
  assert.deepEqual([...tooMany.reviewInstructions], []);
  assert.match(tooMany.warnings.join("\n"), /more than 16 files/);
});

test("require-suggested-fix is stricter-only: true applies, false is ignored with a warning", () => {
  assert.equal(resolve(instance(), "require-suggested-fix: true\n").requireSuggestedFix, true);
  const relaxed = resolve(instance(), "require-suggested-fix: false\n");
  assert.equal(relaxed.requireSuggestedFix, false);
  assert.match(relaxed.warnings.join("\n"), /only make finding behavior stricter/);
});

test("the fingerprint is deterministic and normalizes set-like path order", () => {
  const a = resolve(instance(), "ignore-paths: [b/**, a/**]\nskip-only-paths: [y/**, x/**]\n");
  const b = resolve(instance(), "ignore-paths: [a/**, b/**]\nskip-only-paths: [x/**, y/**]\n");
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(resolve(instance(), "ignore-paths: [b/**, a/**]\nskip-only-paths: [y/**, x/**]\n").fingerprint, a.fingerprint);
});

test("the fingerprint changes when material behavior changes", () => {
  const base = resolve(instance(), "review-instructions: [a.md, b.md]\n");
  // Instruction order is behavior (precedence), so it changes the fingerprint.
  assert.notEqual(resolve(instance(), "review-instructions: [b.md, a.md]\n").fingerprint, base.fingerprint);
  // A narrowed envelope value changes the fingerprint.
  assert.notEqual(resolve(instance(), "inline-findings-max: 10\n").fingerprint, resolve(instance()).fingerprint);
  // A different selected profile changes the fingerprint.
  assert.notEqual(resolve(instance(), "model-profile: strong\n").fingerprint, resolve(instance()).fingerprint);
  // So does the operator changing a profile's endpoint behind the same name.
  const moved = instance({ "model-profiles": [{ name: "fast", endpoint: "http://elsewhere.internal:4000", "api-format": "openai", credential: "ref-a" }] });
  assert.notEqual(effectiveConfigFingerprint(resolve(moved)), base.fingerprint);
});

test("the fingerprint is stable across resolution paths", () => {
  const withFile = resolve(instance(), "ignore-paths: [a/**]\n");
  assert.deepEqual(effectiveConfigFingerprint(withFile), withFile.fingerprint);
  // The same material reached with no file vs an empty file must agree.
  assert.equal(resolve(instance()).fingerprint, resolve(instance(), "").fingerprint);
});

test("the fingerprint separates enabled from disabled states (current-state identity, not history)", () => {
  // #728 names this fingerprint as the config component of job identity, so
  // an enabled and a disabled configuration must not share an identity.
  // A deterministic current-state hash cannot encode history: a full
  // disable → re-enable cycle hashes back to the original fingerprint, and
  // whether resuming review on an unchanged head needs a new generation is
  // #728's to answer (an adoption/config generation dimension), not this
  // fingerprint's.
  const enabled = resolve(instance(), "ignore-paths: [a/**]\n");
  const disabled = resolve(instance(), "ignore-paths: [a/**]\nenabled: false\n");
  assert.notEqual(disabled.fingerprint, enabled.fingerprint);
  assert.equal(resolve(instance(), "ignore-paths: [a/**]\n").fingerprint, enabled.fingerprint);
});

// #1350: the namespace/account shared review-policy layer.

function scoped(config: InstanceConfig, text?: string, scope?: { owner: string; name: string }) {
  return resolveEffectiveReviewConfig(
    contract,
    config,
    text === undefined ? undefined : file(text),
    scope === undefined ? {} : { scope },
  );
}

const NAMESPACE_POLICY = {
  name: "frontend",
  owners: ["frontend-org"],
  "reviewer-defaults": { "inline-findings-max": 10, "review-verbosity": "concise" },
  "ignore-paths": ["generated/**"],
  "review-instructions": ["Shared frontend review rule one.", "Shared rule two."],
};

function instanceWithNamespace(overrides: Record<string, unknown> = {}, policy: Record<string, unknown> = NAMESPACE_POLICY) {
  return instance({ "namespace-policies": [policy], ...overrides });
}

test("no scope or no governing policy leaves the namespace layer inert", () => {
  const withPolicy = instanceWithNamespace();
  const noScope = scoped(withPolicy, "inline-findings-max: 8\n");
  assert.equal(noScope.namespacePolicy, null);
  assert.deepEqual([...noScope.namespaceReviewInstructions], []);
  assert.deepEqual({ ...noScope.provenance }, { "reviewer-settings/inline-findings-max": "repository" });
  assert.equal(noScope.reviewerSettings["inline-findings-max"], "8");
  assert.equal(resolve(withPolicy).namespacePolicy, null);
  const otherScope = scoped(withPolicy, undefined, { owner: "backend-org", name: "service" });
  assert.equal(otherScope.namespacePolicy, null);
  assert.equal(otherScope.fingerprint, resolve(instance()).fingerprint);
});

test("the namespace layer narrows the envelope and the repository narrows below it", () => {
  const config = scoped(instanceWithNamespace(), "inline-findings-max: 5\n", { owner: "frontend-org", name: "web" });
  assert.equal(config.namespacePolicy, "frontend");
  assert.equal(config.reviewerSettings["inline-findings-max"], "5");
  assert.equal(config.reviewerSettings["review-verbosity"], "concise");
  // A repository attempt above the namespace ceiling is rejected with the
  // namespace value as the ceiling; the namespace-set enum stands.
  const tooWide = scoped(instanceWithNamespace(), "inline-findings-max: 15\n", { owner: "frontend-org", name: "web" });
  assert.equal(tooWide.reviewerSettings["inline-findings-max"], "10");
  assert.match(tooWide.warnings.join("\n"), /exceeds the operator ceiling of 10/);
});

test("namespace policy sets repo-policy inputs without the repository opt-in, and the repository cannot undo it", () => {
  const policy = { name: "policy-holder", owners: ["org"], "reviewer-defaults": { "verdict-policy": "model" } };
  const config = scoped(instanceWithNamespace({}, policy), "verdict-policy: strict\n", { owner: "org", name: "repo" });
  assert.equal(config.reviewerSettings["verdict-policy"], "model");
  assert.match(config.warnings.join("\n"), /did not enable allow-repo-policy-overrides/);
});

test("an instance-explicit value beats the namespace layer, which cannot widen", () => {
  const policy = { name: "wide", owners: ["org"], "reviewer-defaults": { "review-verbosity": "normal" } };
  const config = scoped(instanceWithNamespace({ "reviewer-defaults": { "review-verbosity": "concise" } }, policy), undefined, { owner: "org", name: "repo" });
  assert.equal(config.reviewerSettings["review-verbosity"], "concise");
  assert.match(config.warnings.join("\n"), /review-verbosity.*operator explicitly set/);
  // But when the instance left the key unset, the namespace layer fills it.
  const filled = scoped(instanceWithNamespace({}, policy), undefined, { owner: "org", name: "repo" });
  assert.equal(filled.reviewerSettings["review-verbosity"], "normal");
});

test("guidance merges: ignore-paths union with namespace precedence, skip-only-paths single supplier", () => {
  const policy = { ...NAMESPACE_POLICY, "skip-only-paths": ["src/**"] };
  const config = scoped(
    instanceWithNamespace({}, policy),
    "ignore-paths: [generated/**, vendor/**]\nskip-only-paths: [app/**]\n",
    { owner: "frontend-org", name: "web" },
  );
  assert.deepEqual([...config.ignorePaths], ["generated/**", "vendor/**"]);
  assert.deepEqual([...config.skipOnlyPaths], ["src/**"]);
  const joined = config.warnings.join("\n");
  assert.match(joined, /namespace policy 'frontend' already restricts the reviewed path set/);
});

test("provenance records which layer supplied each shared rule (last writer wins)", () => {
  const policy = {
    ...NAMESPACE_POLICY,
    "skip-only-paths": ["src/**"],
    "require-suggested-fix": true,
  };
  const config = scoped(
    instanceWithNamespace({ "reviewer-defaults": { "non-blocking-finding-categories": "docs,style" } }, policy),
    "inline-findings-max: 5\nignore-paths: [generated/**, vendor/**]\nreview-instructions: [docs/rules.md]\n",
    { owner: "frontend-org", name: "web" },
  );
  assert.deepEqual({ ...config.provenance }, {
    "reviewer-settings/review-verbosity": "namespace:frontend",
    "reviewer-settings/inline-findings-max": "repository",
    "reviewer-settings/non-blocking-finding-categories": "instance",
"ignore-paths/generated/**": "namespace:frontend",
    "ignore-paths/vendor/**": "repository",
    "skip-only-paths/src/**": "namespace:frontend",
    "namespace-instructions/0": "namespace:frontend",
    "namespace-instructions/1": "namespace:frontend",
    "review-instructions/0": "repository",
    "require-suggested-fix": "namespace:frontend",
  });
});

test("require-suggested-fix is stricter-only across layers and attributed to its supplier", () => {
  const policy = { ...NAMESPACE_POLICY, "require-suggested-fix": false };
  const config = scoped(instanceWithNamespace({}, policy), "require-suggested-fix: true\n", { owner: "frontend-org", name: "web" });
  assert.equal(config.requireSuggestedFix, true);
  assert.equal(config.provenance["require-suggested-fix"], "repository");
  const relaxed = scoped(instanceWithNamespace({}, policy), "require-suggested-fix: false\n", { owner: "frontend-org", name: "web" });
  assert.equal(relaxed.requireSuggestedFix, false);
  assert.equal(relaxed.provenance["require-suggested-fix"], undefined);
});

test("shared-policy changes participate in generation identity correctly", () => {
  const scope = { owner: "frontend-org", name: "web" };
  const base = scoped(instanceWithNamespace(), undefined, scope);
  // Inline shared guidance is material, in listed order.
  assert.notEqual(
    scoped(instanceWithNamespace({}, { ...NAMESPACE_POLICY, "review-instructions": ["Different guidance."] }), undefined, scope).fingerprint,
    base.fingerprint,
  );
  assert.notEqual(
    scoped(instanceWithNamespace({}, { ...NAMESPACE_POLICY, "review-instructions": [...NAMESPACE_POLICY["review-instructions"] as string[]].reverse() }), undefined, scope).fingerprint,
    base.fingerprint,
  );
  // A changed narrowed value is material.
  assert.notEqual(
    scoped(instanceWithNamespace({}, { ...NAMESPACE_POLICY, "reviewer-defaults": { "inline-findings-max": 8, "review-verbosity": "concise" } }), undefined, scope).fingerprint,
    base.fingerprint,
  );
  // A policy rename that changes no effective value is NOT material:
  // provenance and the policy name stay out of the fingerprint.
  assert.equal(
    scoped(instanceWithNamespace({}, { ...NAMESPACE_POLICY, name: "renamed" }), undefined, scope).fingerprint,
    base.fingerprint,
  );
  // A policy that matches but adds nothing new (same ignore glob the repo
  // already supplied, no settings, no instructions) does not churn identity.
  assert.equal(
    scoped(
      instanceWithNamespace({}, { name: "frontend", owners: ["frontend-org"], "ignore-paths": ["generated/**"] }),
      "ignore-paths: [generated/**]\n",
      scope,
    ).fingerprint,
    resolve(instance(), "ignore-paths: [generated/**]\n").fingerprint,
  );
  // Namespace-less configs keep byte-identical fingerprints.
  assert.equal(scoped(instance()).fingerprint, resolve(instance()).fingerprint);
});

test("different repositories resolve different namespace policies deterministically", () => {
  const policies = [
    { name: "frontend", owners: ["frontend-org"], "reviewer-defaults": { "review-verbosity": "concise" } },
    { name: "backend", owners: ["backend-org"], "reviewer-defaults": { "inline-findings-max": 12 } },
  ];
  const config = instance({ "namespace-policies": policies });
  assert.equal(scoped(config, undefined, { owner: "frontend-org", name: "web" }).reviewerSettings["review-verbosity"], "concise");
  assert.equal(scoped(config, undefined, { owner: "backend-org", name: "api" }).reviewerSettings["inline-findings-max"], "12");
});

test("namespace inline guidance is carried as operator content with per-block provenance", () => {
  const config = scoped(instanceWithNamespace(), undefined, { owner: "frontend-org", name: "web" });
  assert.deepEqual([...config.namespaceReviewInstructions], NAMESPACE_POLICY["review-instructions"]);
  assert.equal(config.provenance["namespace-instructions/0"], "namespace:frontend");
  assert.equal(config.provenance["namespace-instructions/1"], "namespace:frontend");
});

// Review-pinned regressions (#1350 review): the namespace tier is an
// authority tier, not a default-value coincidence.

test("a namespace-set key beats the repository even when its value equals the contract default", () => {
  const policy = { name: "pin", owners: ["org"], "reviewer-defaults": { "review-verbosity": "normal" } };
  const config = scoped(instanceWithNamespace({}, policy), "review-verbosity: concise\n", { owner: "org", name: "repo" });
  assert.equal(config.reviewerSettings["review-verbosity"], "normal");
  assert.match(config.warnings.join("\n"), /review-verbosity.*operator explicitly set/);
  assert.equal(config.provenance["reviewer-settings/review-verbosity"], "namespace:pin");
});

test("the namespace layer cannot widen an instance-explicit numeric ceiling", () => {
  const policy = { name: "wide", owners: ["org"], "reviewer-defaults": { "inline-findings-max": 10 } };
  const config = scoped(instanceWithNamespace({ "reviewer-defaults": { "inline-findings-max": 5 } }, policy), undefined, { owner: "org", name: "repo" });
  assert.equal(config.reviewerSettings["inline-findings-max"], "5");
  assert.match(config.warnings.join("\n"), /Namespace policy 'wide'.*exceeds the operator ceiling of 5/);
  assert.equal(config.provenance["reviewer-settings/inline-findings-max"], "instance");
});

test("the namespace layer cannot grant the repository the policy-override gate", () => {
  // `allow-repo-policy-overrides` is not a repo-configurable input, so a
  // namespace policy naming it fails instance validation closed — the gate
  // can only ever be the operator's own instance-level decision.
  assert.throws(
    () => instanceWithNamespace({}, { name: "gate", owners: ["org"], "reviewer-defaults": { "allow-repo-policy-overrides": "true" } }),
    /allow-repo-policy-overrides.*not a repo-configurable input/,
  );
});

test("resolution stays total for a validated instance with a scope (no throw on any claimed identity)", () => {
  const policies = [
    { name: "a", owners: ["org-a"], "reviewer-defaults": { "review-verbosity": "concise" } },
    { name: "b", repositories: ["org-b/repo"] },
  ];
  const config = instance({ "namespace-policies": policies });
  for (const scope of [{ owner: "org-a", name: "web" }, { owner: "org-b", name: "repo" }, { owner: "org-c", name: "x" }]) {
    const resolved = scoped(config, undefined, scope);
    assert.match(resolved.fingerprint, /^ecfg-v1-[0-9a-f]{64}$/);
  }
});

test("an explicit namespace pin of the contract default is config state and changes the fingerprint", () => {
  const scope = { owner: "org", name: "repo" };
  const pinned = scoped(instanceWithNamespace({}, { name: "pin", owners: ["org"], "reviewer-defaults": { "review-verbosity": "normal" } }), undefined, scope);
  assert.equal(pinned.reviewerSettings["review-verbosity"], "normal");
  assert.notEqual(pinned.fingerprint, scoped(instance(), undefined, scope).fingerprint);
});

test("a malformed namespace scope fails closed with a typed error", () => {
  assert.throws(
    () => scoped(instanceWithNamespace(), undefined, { owner: "", name: "repo" }),
    (error: unknown) => error instanceof EffectiveConfigError && /namespace scope/.test(error.message),
  );
});
