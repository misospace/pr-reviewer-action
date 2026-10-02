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
      "executor-profiles": [{ name: "default", kind: "local" }],
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

test("the fingerprint is stable across resolution and excludes non-material fields", () => {
  const withFile = resolve(instance(), "ignore-paths: [a/**]\n");
  assert.deepEqual(effectiveConfigFingerprint(withFile), withFile.fingerprint);
  // The same material reached with no file vs an empty file must agree.
  assert.equal(resolve(instance()).fingerprint, resolve(instance(), "").fingerprint);
});
