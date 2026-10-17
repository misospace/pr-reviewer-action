import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import {
  MAX_INSTANCE_CONFIG_BYTES,
  parseInstanceConfigText,
  validateInstanceConfig,
  type InstanceConfig,
} from "../src/config/instance-config.js";

const contract = validateContract(parse(readFileSync("contracts/action-v3.yml", "utf8")));

function baseInstance(): Record<string, unknown> {
  return {
    version: 1,
    "model-profiles": [
      { name: "fast", endpoint: "http://127.0.0.1:4000", "api-format": "openai", credential: "litellm-ref" },
    ],
    "default-model-profile": "fast",
  };
}

function validate(values: unknown): InstanceConfig {
  return validateInstanceConfig(values, contract);
}

function expectError(values: unknown, fragment: string): void {
  assert.throws(() => validate(values), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(fragment) && message.startsWith("instance config");
  }, `expected an error containing '${fragment}'`);
}

test("a minimal instance config validates and is deeply frozen", () => {
  const instance = validate(baseInstance());
  assert.equal(instance.version, 1);
  assert.equal(instance.unknownProfilePolicy, "reject");
  assert.equal(instance.modelProfiles.length, 1);
  assert.equal(instance.modelProfiles[0]!.name, "fast");
  assert.equal(instance.modelProfiles[0]!.endpoint, "http://127.0.0.1:4000");
  assert.equal(instance.defaultModelProfile, "fast");
  assert.equal(instance.executorProfiles.length, 0);
  assert.equal(instance.defaultExecutorProfile, null);
  // Conservative adoption defaults: nothing reviews until the operator says so.
  assert.equal(instance.adoption.mode, "allowlist");
  assert.deepEqual([...instance.adoption.allowlist], []);
  assert.equal(instance.adoption.discoveredDefault, "skip");
  assert.deepEqual({ ...instance.reviewerDefaults }, {});
  assert.equal(instance.allowRepoPolicyOverrides, false);
  assert.throws(() => {
    (instance as unknown as { modelProfiles: unknown[] }).modelProfiles.push({});
  });
});

test("parseInstanceConfigText parses YAML and rejects invalid syntax", () => {
  const text = [
    "version: 1",
    "model-profiles:",
    "  - name: fast",
    "    endpoint: http://127.0.0.1:4000",
    "    api-format: openai",
    "    credential: litellm-ref",
    "default-model-profile: fast",
  ].join("\n");
  const instance = parseInstanceConfigText(text, contract);
  assert.equal(instance.defaultModelProfile, "fast");
  assert.throws(() => parseInstanceConfigText("version: 1\n\tbad: [", contract), /not valid YAML/);
  assert.throws(() => parseInstanceConfigText("- just\n- a list\n", contract), /must be a mapping/);
});

test("the instance file is byte-capped", () => {
  assert.throws(
    () => parseInstanceConfigText(`# ${"x".repeat(MAX_INSTANCE_CONFIG_BYTES)}\n`, contract),
    /byte cap/,
  );
});

test("unknown fields are rejected at every level, including hostile inline credentials", () => {
  expectError({ ...baseInstance(), "api-key": "sk-hostile" }, "unsupported field 'api-key'");
  expectError(
    {
      ...baseInstance(),
      "model-profiles": [{ name: "fast", endpoint: "http://127.0.0.1:4000", "api-format": "openai", credential: "ref", podSpec: { containers: [] } }],
    },
    "unsupported field 'podSpec'",
  );
  expectError({ ...baseInstance(), queue: { "max-concurrent-reviews": 2, burst: 9 } }, "unsupported field 'burst'");
  // There is nowhere in the schema an inline secret can land: every field is
  // enumerated, so an injection attempt hits the unknown-field rejection.
  expectError({ ...baseInstance(), credential: "sk-hostile" }, "unsupported field 'credential'");
});

test("version must be exactly 1", () => {
  expectError({ ...baseInstance(), version: 2 }, "must be exactly 1");
  const { version: _version, ...withoutVersion } = baseInstance() as Record<string, unknown>;
  expectError(withoutVersion, "must be exactly 1");
});

test("model profiles are required and names must be unique and referenced by the default", () => {
  const { "model-profiles": _profiles, ...withoutProfiles } = baseInstance() as Record<string, unknown>;
  expectError(withoutProfiles, "must be a non-empty list");
  expectError({ ...baseInstance(), "default-model-profile": "nope" }, "does not name a profile");
  expectError(
    {
      version: 1,
      "model-profiles": [
        { name: "fast", endpoint: "http://127.0.0.1:4000", "api-format": "openai", credential: "a" },
        { name: "fast", endpoint: "http://127.0.0.1:4001", "api-format": "anthropic", credential: "b" },
      ],
      "default-model-profile": "fast",
    },
    "duplicate names",
  );
  const firstProfile = (baseInstance()["model-profiles"] as readonly Record<string, unknown>[])[0]!;
  expectError({ ...baseInstance(), "model-profiles": [{ ...firstProfile, name: "Bad_Name" }] }, "must match");
});

test("endpoints are scheme-checked absolute URLs without embedded credentials", () => {
  // Local/self-hosted http endpoints stay first-class.
  const ok = validate({ ...baseInstance(), "model-profiles": [{ name: "fast", endpoint: "http://model.internal:8080/v1", "api-format": "openai", credential: "ref" }] });
  assert.equal(ok.modelProfiles[0]!.endpoint, "http://model.internal:8080/v1");
  for (const [endpoint, why] of [
    ["ftp://model.internal", "http or https"],
    ["https://user:secret@model.internal", "must not embed credentials"],
    ["not a url", "absolute URL"],
  ] as const) {
    assert.throws(
      () => validate({ ...baseInstance(), "model-profiles": [{ name: "fast", endpoint, "api-format": "openai", credential: "ref" }] }),
      new RegExp(why),
      endpoint,
    );
  }
});

test("executor profiles are a closed set — an arbitrary image/PodSpec/host path has nowhere to land", () => {
  for (const field of ["image", "podSpec", "nodeSelector", "hostPath", "command"] as const) {
    expectError(
      {
        ...baseInstance(),
        "executor-profiles": [{ name: "default", kind: "kubernetes", [field]: "arbitrary" }],
      },
      `unsupported field '${field}'`,
    );
  }
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "vm" }] },
    "must be 'local', 'oci', or 'kubernetes'",
  );
  const ok = validate({
    ...baseInstance(),
    "executor-profiles": [{ name: "default", kind: "oci", "max-reviews": 4 }],
    "default-executor-profile": "default",
  });
  assert.deepEqual({ ...ok.executorProfiles[0]! }, { name: "default", kind: "oci", maxReviews: 4 });
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", "max-reviews": 65 }] },
    "must be between 1 and 64",
  );
});

test("unknown-profile-policy is explicit and bounded", () => {
  assert.equal(validate(baseInstance()).unknownProfilePolicy, "reject");
  assert.equal(validate({ ...baseInstance(), "unknown-profile-policy": "fallback_default" }).unknownProfilePolicy, "fallback_default");
  expectError({ ...baseInstance(), "unknown-profile-policy": "invent" }, "must be 'reject' or 'fallback_default'");
});

test("reviewer defaults may only set the repo-configurable envelope, with contract-valid values", () => {
  const ok = validate({ ...baseInstance(), "reviewer-defaults": { "inline-findings-max": 5, "review-verbosity": "concise" } });
  assert.deepEqual({ ...ok.reviewerDefaults }, { "inline-findings-max": "5", "review-verbosity": "concise" });
  // Endpoints/models are operator profile territory, never reviewer defaults.
  expectError({ ...baseInstance(), "reviewer-defaults": { "ai-model": "other" } }, "not a repo-configurable input");
  // Secrets are structurally excluded from repo-configurable inputs.
  expectError({ ...baseInstance(), "reviewer-defaults": { "github-token": "stolen" } }, "not a repo-configurable input");
  expectError({ ...baseInstance(), "reviewer-defaults": { "inline-findings-max": "nope" } }, "must be an integer");
});

test("adoption policy validates modes, identities, and bounds", () => {
  const ok = validate({
    ...baseInstance(),
    adoption: { mode: "allowlist", allowlist: ["owner/repo"], denylist: ["other/repo"], "discovered-default": "adopt" },
  });
  assert.deepEqual([...ok.adoption.allowlist], ["owner/repo"]);
  assert.equal(ok.adoption.discoveredDefault, "adopt");
  expectError({ ...baseInstance(), adoption: { mode: "everything" } }, "must be 'all_allowed'");
  expectError({ ...baseInstance(), adoption: { mode: "allowlist", allowlist: ["a/.."] } }, "repository identity");
  expectError({ ...baseInstance(), adoption: { mode: "allowlist", allowlist: ["./repo"] } }, "repository identity");
  expectError({ ...baseInstance(), adoption: { mode: "allowlist", allowlist: ["owner/repo", "owner/repo"] } }, "duplicate identities");
  expectError({ ...baseInstance(), adoption: { mode: "allowlist", "discovered-default": "maybe" } }, "must be 'adopt' or 'skip'");
});

test("queue and storage are bounded", () => {
  expectError({ ...baseInstance(), queue: { "max-concurrent-reviews": 0 } }, "must be between 1 and 256");
  expectError({ ...baseInstance(), queue: { "max-concurrent-reviews": 257 } }, "must be between 1 and 256");
  const ok = validate({ ...baseInstance(), storage: { "state-path": "/var/lib/pr-reviewer", "workspace-cache-path": "/var/cache/pr-reviewer" } });
  assert.equal(ok.storage.statePath, "/var/lib/pr-reviewer");
  assert.throws(() => validate({ ...baseInstance(), storage: { "state-path": "bad\u0000path" } }), /control characters/);
});
