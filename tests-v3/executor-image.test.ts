/** Worker-image contract module (#733): strict fail-closed parsing of the
 * portable OCI worker-image contract, the profile → contract builder
 * (`oci` builds, other kinds decline), and the contract-derived argv
 * prefix (container-runtime binding is #734+ and is not faked here). */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { validateInstanceConfig } from "../src/config/instance-config.js";
import {
  EXECUTION_REQUEST_ENV_KEY,
  EXECUTION_RESULT_ENV_KEY,
  WORKER_IMAGE_CONTRACT_VERSION,
  WorkerImageContractError,
  parseWorkerImageContract,
  resolveExecutionImageCommand,
  validateImageContractForProfile,
} from "../src/executor/index.js";

const VALID = Object.freeze({
  contractVersion: 1,
  image: "ghcr.io/acme/pr-reviewer-worker:v1",
  args: ["--verbose"],
  requestVar: EXECUTION_REQUEST_ENV_KEY,
  resultVar: EXECUTION_RESULT_ENV_KEY,
});

// ── happy path ──────────────────────────────────────────────────────────

test("a well-formed contract parses into a frozen contract with the executor's coordinates", () => {
  const contract = parseWorkerImageContract(VALID);
  assert.deepEqual(
    { ...contract },
    {
      contractVersion: 1,
      image: "ghcr.io/acme/pr-reviewer-worker:v1",
      args: ["--verbose"],
      requestVar: EXECUTION_REQUEST_ENV_KEY,
      resultVar: EXECUTION_RESULT_ENV_KEY,
    },
  );
  assert.equal(contract.contractVersion, WORKER_IMAGE_CONTRACT_VERSION);
  assert.ok(Object.isFrozen(contract));
});

test("a digest-pinned image reference is accepted", () => {
  const digest = "sha256:" + "0a1b2c3d".repeat(8);
  const contract = parseWorkerImageContract({ ...VALID, image: `ghcr.io/acme/worker@${digest}` });
  assert.equal(contract.image, `ghcr.io/acme/worker@${digest}`);
});

test("non-mapping input is rejected", () => {
  assert.throws(() => parseWorkerImageContract(null), WorkerImageContractError);
  assert.throws(() => parseWorkerImageContract("contract"), /must be a mapping/);
  assert.throws(() => parseWorkerImageContract([VALID]), /must be a mapping/);
});

// ── fail-closed fields ──────────────────────────────────────────────────

test("unknown fields are rejected", () => {
  assert.throws(
    () => parseWorkerImageContract({ ...VALID, extra: 1 }),
    /unsupported field 'extra'/,
  );
});

test("a non-v1 contractVersion is rejected", () => {
  assert.throws(() => parseWorkerImageContract({ ...VALID, contractVersion: 2 }), /contractVersion must be 1/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, contractVersion: "1" }), /contractVersion must be 1/);
});

test("the image must satisfy the instance-config oci.image grammar", () => {
  assert.throws(() => parseWorkerImageContract({ ...VALID, image: "GHCR.io/acme/worker" }), /must be an image reference/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, image: "ghcr.io/acme/worker:latest extra" }), /must be an image reference/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, image: "ghcr.io/acme/worker|evil" }), /must be an image reference/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, image: "" }), /must be a non-empty string/);
});

test("an oversized image reference is rejected", () => {
  assert.throws(
    () => parseWorkerImageContract({ ...VALID, image: `a${"b".repeat(512)}` }),
    /must be at most 512 characters/,
  );
});

test("args obey the local-executor argv hygiene rules", () => {
  assert.throws(() => parseWorkerImageContract({ ...VALID, args: ["a|b"] }), /no shell metacharacters/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, args: ["$(touch /tmp/pwned)"] }), /no shell metacharacters/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, args: ["a\u0000b"] }), /must not contain control characters/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, args: [""] }), /must be a non-empty string/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, args: [42] }), /must be a non-empty string/);
  assert.throws(() => parseWorkerImageContract({ ...VALID, args: "verbose" }), /must be a list of argv strings/);
});

test("args are bounded in count and element length", () => {
  assert.throws(
    () => parseWorkerImageContract({ ...VALID, args: Array.from({ length: 33 }, () => "x") }),
    /must have at most 32 entries/,
  );
  assert.throws(
    () => parseWorkerImageContract({ ...VALID, args: ["x".repeat(4097)] }),
    /must be at most 4096 bytes/,
  );
});

test("the env coordinates must be exactly the executor's coordination variables", () => {
  assert.throws(
    () => parseWorkerImageContract({ ...VALID, requestVar: "PR_REVIEWER_REQUEST" }),
    /requestVar must be 'PR_REVIEWER_EXECUTION_REQUEST'/,
  );
  assert.throws(
    () => parseWorkerImageContract({ ...VALID, resultVar: "WORKER_RESULT" }),
    /resultVar must be 'PR_REVIEWER_EXECUTION_RESULT'/,
  );
});

// ── profile → contract ──────────────────────────────────────────────────

test("validateImageContractForProfile builds a contract for an oci profile", () => {
  const contract = validateImageContractForProfile({
    kind: "oci",
    oci: { image: "ghcr.io/acme/pr-reviewer-worker:1.2.3" },
  });
  assert.ok(contract !== null);
  assert.equal(contract.image, "ghcr.io/acme/pr-reviewer-worker:1.2.3");
  assert.deepEqual([...contract.args], []);
  assert.equal(contract.requestVar, EXECUTION_REQUEST_ENV_KEY);
  assert.equal(contract.resultVar, EXECUTION_RESULT_ENV_KEY);
});

test("validateImageContractForProfile returns null for non-oci kinds", () => {
  assert.equal(validateImageContractForProfile({ kind: "local", oci: null }), null);
  assert.equal(validateImageContractForProfile({ kind: "kubernetes", oci: null }), null);
});

test("validateImageContractForProfile fails closed on a malformed oci profile", () => {
  assert.throws(
    () => validateImageContractForProfile({ kind: "oci", oci: null }),
    /must carry an image reference/,
  );
  assert.throws(
    () => validateImageContractForProfile({ kind: "oci", oci: { image: "Not An Image Ref" } }),
    /must be an image reference/,
  );
});

// ── grammar drift pin ───────────────────────────────────────────────────

test("the contract image grammar behaves identically to instance-config's oci.image grammar", () => {
  const contract = validateContract(parseYaml(readFileSync("contracts/action-v3.yml", "utf8")));
  const configWithImage = (image: string) => validateInstanceConfig({
    version: 1,
    "model-profiles": [{ name: "fast", endpoint: "http://127.0.0.1:4000", "api-format": "openai", credential: "litellm-ref" }],
    "default-model-profile": "fast",
    "executor-profiles": [{ name: "w", kind: "oci", oci: { image } }],
  }, contract);

  for (const accepted of [
    "ghcr.io/acme/pr-reviewer-worker:v1",
    `ghcr.io/acme/worker@${"sha256:" + "0a1b2c3d".repeat(8)}`,
  ]) {
    assert.equal(parseWorkerImageContract({ ...VALID, image: accepted }).image, accepted);
    assert.equal(configWithImage(accepted).executorProfiles[0]!.oci!.image, accepted);
  }
  for (const rejected of ["GHCR.io/acme/worker", "ghcr.io/acme/worker:latest extra", "not an image"]) {
    assert.throws(() => parseWorkerImageContract({ ...VALID, image: rejected }), WorkerImageContractError);
    assert.throws(() => configWithImage(rejected));
  }
});

// ── the launch prefix ───────────────────────────────────────────────────

test("resolveExecutionImageCommand returns the contract-derived argv prefix", () => {
  const contract = parseWorkerImageContract(VALID);
  const command = resolveExecutionImageCommand(contract);
  assert.deepEqual({ file: command.file, args: [...command.args] }, {
    file: "ghcr.io/acme/pr-reviewer-worker:v1",
    args: ["--verbose"],
  });
});
