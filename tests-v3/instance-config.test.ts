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
    "executor-profiles": [{
      name: "default",
      kind: "oci",
      "max-reviews": 4,
      oci: { image: "ghcr.io/acme/review-worker:1" },
    }],
    "default-executor-profile": "default",
  });
  assert.deepEqual(
    { ...ok.executorProfiles[0]! },
    {
      name: "default",
      kind: "oci",
      maxReviews: 4,
      local: null,
      oci: { image: "ghcr.io/acme/review-worker:1" },
      kubernetes: null,
    },
  );
  // Specs are frozen at validation.
  assert.ok(Object.isFrozen(ok.executorProfiles[0]));
  assert.ok(Object.isFrozen(ok.executorProfiles[0]!.oci));
  assert.throws(() => {
    (ok.executorProfiles[0]!.oci as unknown as { image: string }).image = "evil";
  });
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", "max-reviews": 65, oci: { image: "ghcr.io/acme/review-worker:1" } }] },
    "must be between 1 and 64",
  );
});

test("executor profiles carry exactly one kind-matching backend spec (#733)", () => {
  const localOk = validate({
    ...baseInstance(),
    "executor-profiles": [{
      name: "local-dev",
      kind: "local",
      local: { command: "/usr/local/bin/pr-reviewer-worker", args: ["--worker"] },
    }],
  });
  const profile = localOk.executorProfiles[0]!;
  assert.equal(profile.kind, "local");
  assert.deepEqual({ ...profile.local! }, { command: "/usr/local/bin/pr-reviewer-worker", args: ["--worker"] });
  assert.equal(profile.oci, null);
  assert.ok(Object.isFrozen(profile.local));
  assert.ok(Object.isFrozen(profile.local!.args));

  // A `local` kind without its spec fails closed — the executor has
  // nothing to launch.
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "local" }] },
    "is required for kind 'local'",
  );
  // ... and never carries both specs.
  expectError(
    {
      ...baseInstance(),
      "executor-profiles": [{
        name: "default",
        kind: "local",
        local: { command: "worker", args: [] },
        oci: { image: "ghcr.io/acme/worker:1" },
      }],
    },
    "must be absent for kind 'local'",
  );
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", local: { command: "worker", args: [] } }] },
    "is required for kind 'oci'",
  );
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", oci: { image: "ghcr.io/acme/worker:1" }, local: { command: "worker", args: [] } }] },
    "must be absent for kind 'oci'",
  );
  // Kubernetes carries its own versioned spec since #734 — deployment
  // facts only, never raw pod infrastructure.
  const kubernetesSpec = {
    image: "ghcr.io/acme/pr-reviewer-worker:1.2.3",
    args: ["--worker"],
    namespace: "review-workers",
    "service-account": "pr-reviewer-worker",
    "ttl-seconds-after-finished": 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{
      claim: "pr-reviewer-data",
      "controller-root": "/var/lib/pr-reviewer",
    }],
  };
  const kubernetesOk = validate({
    ...baseInstance(),
    "executor-profiles": [{ name: "k8s", kind: "kubernetes", kubernetes: kubernetesSpec }],
  });
  assert.equal(kubernetesOk.executorProfiles[0]!.local, null);
  assert.equal(kubernetesOk.executorProfiles[0]!.oci, null);
  assert.deepEqual({ ...kubernetesOk.executorProfiles[0]!.kubernetes! }, {
    image: "ghcr.io/acme/pr-reviewer-worker:1.2.3",
    args: ["--worker"],
    namespace: "review-workers",
    serviceAccount: "pr-reviewer-worker",
    ttlSecondsAfterFinished: 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{
      claim: "pr-reviewer-data",
      controllerRoot: "/var/lib/pr-reviewer",
    }],
  });
  assert.ok(Object.isFrozen(kubernetesOk.executorProfiles[0]!.kubernetes));
  assert.ok(Object.isFrozen(kubernetesOk.executorProfiles[0]!.kubernetes!.volumes));
  // A kubernetes kind without its spec fails closed — the executor has
  // nothing to build a Job from.
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "k8s", kind: "kubernetes" }] },
    "is required for kind 'kubernetes'",
  );
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "k8s", kind: "kubernetes", kubernetes: kubernetesSpec, local: { command: "worker", args: [] } }] },
    "must be absent for kind 'kubernetes'",
  );
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "k8s", kind: "kubernetes", kubernetes: kubernetesSpec, oci: { image: "ghcr.io/acme/worker:1" } }] },
    "must be absent for kind 'kubernetes'",
  );
  // The other kinds must not carry the kubernetes spec either.
  expectError(
    {
      ...baseInstance(),
      "executor-profiles": [{ name: "default", kind: "local", local: { command: "worker", args: [] }, kubernetes: kubernetesSpec }],
    },
    "must be absent for kind 'local'",
  );
  expectError(
    {
      ...baseInstance(),
      "executor-profiles": [{ name: "default", kind: "oci", oci: { image: "ghcr.io/acme/worker:1" }, kubernetes: kubernetesSpec }],
    },
    "must be absent for kind 'oci'",
  );
});

test("the kubernetes executor spec is a closed set — a PodSpec fragment has nowhere to land", () => {
  const baseKubernetes = {
    image: "ghcr.io/acme/pr-reviewer-worker:1",
    namespace: "review-workers",
    "service-account": "pr-reviewer-worker",
    "ttl-seconds-after-finished": 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{
      claim: "pr-reviewer-data",
      "controller-root": "/var/lib/pr-reviewer",
    }],
  };
  for (const field of [
    "podSpec", "nodeSelector", "hostPath", "command", "tolerations", "affinity",
    "securityContext", "env", "volumeMounts", "containers", "imagePullPolicy",
  ] as const) {
    expectError(
      {
        ...baseInstance(),
        "executor-profiles": [{ name: "k8s", kind: "kubernetes", kubernetes: { ...baseKubernetes, [field]: "arbitrary" } }],
      },
      `unsupported field '${field}'`,
    );
  }
});

test("the kubernetes executor spec's fields are grammar-bounded (#734)", () => {
  const baseKubernetes = () => ({
    image: "ghcr.io/acme/pr-reviewer-worker:1",
    namespace: "review-workers",
    "service-account": "pr-reviewer-worker",
    "ttl-seconds-after-finished": 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{
      claim: "pr-reviewer-data",
      "controller-root": "/var/lib/pr-reviewer",
    }],
  });
  const broken = (label: string, mutate: (spec: ReturnType<typeof baseKubernetes>) => unknown, why: string) => {
    const spec = baseKubernetes();
    const result = mutate(spec);
    expectError(
      { ...baseInstance(), "executor-profiles": [{ name: "k8s", kind: "kubernetes", kubernetes: result }] },
      why,
    );
  };
  // image grammar (shared with oci).
  broken("image", (spec) => ({ ...spec, image: "Not An Image Ref" }), "must be an image reference");
  // namespace / service-account / claim: DNS-1123 labels.
  broken("namespace", (spec) => ({ ...spec, namespace: "Review_Workers" }), "DNS-1123");
  broken("namespace", (spec) => ({ ...spec, namespace: "-workers" }), "DNS-1123");
  broken("service-account", (spec) => ({ ...spec, "service-account": "Default" }), "DNS-1123");
  broken("volumes", (spec) => ({ ...spec, volumes: [{ ...spec.volumes[0], claim: "Bad_Claim" }] }), "DNS-1123");
  // ttl: bounded positive integer.
  broken("ttl", (spec) => ({ ...spec, "ttl-seconds-after-finished": 0 }), "must be between 1 and 604800");
  broken("ttl", (spec) => ({ ...spec, "ttl-seconds-after-finished": 604_801 }), "must be between 1 and 604800");
  // resources: required, quantity grammar.
  broken("resources", (spec) => ({ ...spec, resources: undefined }), "must be a mapping");
  broken("cpu", (spec) => ({
    ...spec,
    resources: { requests: { cpu: "fast", memory: "512Mi" }, limits: { cpu: "2", memory: "2Gi" } },
  }), "must be a resource quantity");
  broken("memory", (spec) => ({
    ...spec,
    resources: { requests: { cpu: "500m", memory: "lots" }, limits: { cpu: "2", memory: "2Gi" } },
  }), "must be a resource quantity");
  broken("limits", (spec) => ({
    ...spec,
    resources: { requests: { cpu: "500m", memory: "512Mi" } },
  }), "must be a mapping");
  // args: single argv elements only.
  broken("args", (spec) => ({ ...spec, args: ["a | b"] }), "single argv element");
  // volumes: 1..8, absolute non-root paths, no overlaps.
  broken("volumes", (spec) => ({ ...spec, volumes: [] }), "must have at least 1 entry");
  broken("volumes", (spec) => ({
    ...spec,
    volumes: [
      ...spec.volumes,
      { claim: "other", "controller-root": "/var/lib/pr-reviewer/runs" },
    ],
  }), "overlapping controller roots");
  broken("root", (spec) => ({
    ...spec,
    volumes: [{ ...spec.volumes[0], "controller-root": "var/lib" }],
  }), "must be an absolute path");
  broken("root-slash", (spec) => ({
    ...spec,
    volumes: [{ ...spec.volumes[0], "controller-root": "/" }],
  }), "must not be the filesystem root");
  broken("volumes-none", (spec) => ({ ...spec, volumes: undefined }), "must be a list of volume mappings");
});

test("local executor specs are bounded single argv elements, not shell lines", () => {
  const spec = { command: "worker", args: ["--flag"] };
  for (const [value, why] of [
    ["sh -c 'rm -rf /' && echo pwned", "single argv element"],
    ["worker | exfiltrate", "single argv element"],
    ["worker > /etc/passwd", "single argv element"],
    ["worker; evil", "single argv element"],
    ["worker < input", "single argv element"],
    ["worker `cmd`", "single argv element"],
    ["worker $HOME", "single argv element"],
    ["", "non-empty string"],
  ] as const) {
    expectError(
      { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "local", local: { ...spec, command: value } }] },
      why,
    );
    expectError(
      { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "local", local: { ...spec, args: [value] } }] },
      why,
    );
  }
  // NUL is a control character and is refused like any other.
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "local", local: { ...spec, command: "bad\u0000cmd" } }] },
    "control characters",
  );
  expectError(
    {
      ...baseInstance(),
      "executor-profiles": [{
        name: "default",
        kind: "local",
        local: { command: "worker", args: Array.from({ length: 33 }, (_, i) => `arg-${i}`) },
      }],
    },
    "must have at most 32 entries",
  );
  // Unknown keys inside a spec are rejected like everywhere else.
  expectError(
    {
      ...baseInstance(),
      "executor-profiles": [{
        name: "default",
        kind: "local",
        local: { command: "worker", args: [], hostPath: "/etc" },
      }],
    },
    "unsupported field 'hostPath'",
  );
});

test("oci executor specs accept only bounded image references", () => {
  for (const image of [
    "ghcr.io/acme/review-worker:1",
    "review-worker",
    "team/worker@sha256:" + "a".repeat(64),
  ]) {
    const ok = validate({
      ...baseInstance(),
      "executor-profiles": [{ name: "default", kind: "oci", oci: { image } }],
    });
    assert.equal(ok.executorProfiles[0]!.oci!.image, image);
  }
  for (const [image, why] of [
    ["GHCR.io/acme/worker", "must be an image reference"],
    ["acme/worker:latest extra", "must be an image reference"],
    ["acme/worker:Bad_Tag", "must be an image reference"],
    // The bounded v1 grammar keeps registry ports out; #734 may widen it
    // as a versioned change, never by loosening in place.
    ["registry.internal:5000/team/worker", "must be an image reference"],
    ["", "non-empty string"],
  ] as const) {
    expectError(
      { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", oci: { image } }] },
      why,
    );
  }
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", oci: { image: `ghcr.io/a/${"x".repeat(600)}` } }] },
    "must be at most 512 characters",
  );
  expectError(
    { ...baseInstance(), "executor-profiles": [{ name: "default", kind: "oci", oci: { image: "acme/worker", tag: "1" } }] },
    "unsupported field 'tag'",
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
