// #1485 companion test: the deterministic half of the adversarial
// repository-config qualification.
//
// The Docker harness (tests/self_hosted_e2e_qualification.sh, scenario
// scenario_malicious_repository_config) proves end-to-end that a hostile
// .github/pr-reviewer.yml planted on the PR's OWN head cannot move the
// durable envelope's model selection or the published comment. What the
// harness CANNOT show cheaply is which lever of the planted file would
// survive the APPLY layer if a regression started reading the head ref:
// that is a pure question about the contract, so it is pinned here
// against the real applyRepositoryConfig / resolveRepositoryConfig.
//
// The hostile YAML is parsed from the harness script at run time (one
// source of truth), fed through applyRepositoryConfig /
// resolveRepositoryConfig: every key the file plants is refused
// under the harness's operator posture (no allow-repo-policy-overrides),
// the gate-open control proves the refusal does real work instead of
// resting on the key being inert by accident, and the git-based test
// pins the SELECTION rule the harness relies on: the engine reads the
// config from the trusted base ref, where this file does not exist.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { applyRepositoryConfig, resolveRepositoryConfig } from "../src/config/repository-config.js";

const rawContract: unknown = parse(readFileSync("contracts/action-v3.yml", "utf8"));
const contract = validateContract(rawContract);

// The harness's hostile_body, parsed out of the harness script itself:
// ONE source of truth. A byte-identical copy here would let the two
// drift silently and turn this test into a proof of a payload the
// harness no longer plants (#1617 review).
const HOSTILE_YAML = hostileBodyFromHarness();

function hostileBodyFromHarness(): string {
  const script = readFileSync("tests/self_hosted_e2e_qualification.sh", "utf8");
  // The harness assigns the payload as one single-quoted bash literal
  // (no apostrophes inside; the closing quote ends the literal). A
  // reworded or re-quoted harness literal fails here, loudly, rather
  // than silently pinning a stale payload.
  const match = /local hostile_body='([^']*)'\n/.exec(script);
  if (match === null) {
    throw new Error(
      "tests/self_hosted_e2e_qualification.sh no longer carries the hostile body as the `local hostile_body='...'` literal this test pins; update both together",
    );
  }
  return match[1] ?? "";
}

// The harness's operator posture: every contract input at its default,
// and — as on the qualification instance — no allow-repo-policy-overrides.
function operatorRaw(): Record<string, string> {
  return Object.fromEntries(
    contract.inputs.map((input) => [input.id, input.default === undefined ? "operator-value" : String(input.default)]),
  );
}

test("the harness's hostile head-only config refuses every planted key under the harness operator posture", () => {
  const before = operatorRaw();
  const resolution = applyRepositoryConfig(contract, before, {
    path: ".github/pr-reviewer.yml",
    text: HOSTILE_YAML,
  });

  // Nothing is applied: the effective verdict policy, the inline-findings
  // ceiling, the AI endpoint and the model are still exactly the
  // operator's, and no attacker infrastructure entered the raw map.
  assert.deepEqual(resolution.appliedKeys, []);
  assert.equal(resolution.raw["verdict-policy"], before["verdict-policy"]);
  assert.notEqual(resolution.raw["verdict-policy"], "model");
  assert.equal(resolution.raw["inline-findings-max"], before["inline-findings-max"]);
  assert.equal(resolution.raw["ai-base-url"], before["ai-base-url"]);
  assert.equal(resolution.raw["ai-model"], before["ai-model"]);
  assert.equal(JSON.stringify(resolution.raw).includes("attacker"), false);

  // Every planted key names itself in a visible refusal warning: the
  // policy escalation (repo-policy without the gate), the ceiling bust,
  // the operator-only infrastructure keys, the self-granted permission,
  // and the unknown key.
  const named = resolution.warnings.join("\n");
  for (const key of [
    "verdict-policy",
    "inline-findings-max",
    "allow-repo-policy-overrides",
    "ai-base-url",
    "ai-model",
    "model-profiles",
  ]) {
    assert.match(named, new RegExp(`'${key}'`), `no refusal warning names '${key}'`);
  }
  assert.match(named, /allow-repo-policy-overrides/); // the self-grant is itself refused
});

test("control: with the operator gate open the refusal is doing real work, and the ceiling and operator-only keys stay refused", () => {
  const resolution = applyRepositoryConfig(
    contract,
    { ...operatorRaw(), "allow-repo-policy-overrides": "true" },
    { path: ".github/pr-reviewer.yml", text: HOSTILE_YAML },
  );

  // The gate is the only thing that was holding verdict-policy out — so
  // the closed-gate refusal above was not an accident of the key shape.
  assert.deepEqual(resolution.appliedKeys, ["verdict-policy"]);
  assert.equal(resolution.raw["verdict-policy"], "model");

  // Even with the gate open: the numeric ceiling still refuses the
  // 999999 inline-findings bust, and the operator-only infrastructure
  // keys (endpoint, model, permission key, unknown key) stay refused.
  assert.equal(resolution.raw["inline-findings-max"], "20");
  assert.equal(resolution.raw["ai-base-url"], "operator-value");
  assert.equal(resolution.raw["ai-model"], "operator-value");
  assert.equal(JSON.stringify(resolution.raw).includes("attacker"), false);
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
  "GPG_TTY": "",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

test("selection: the config is resolved from the trusted base ref, where the PR head's hostile file does not exist", () => {
  const root = mkdtempSync(join(tmpdir(), "repo-cfg-selection-"));
  try {
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "fixture.txt"), "one\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    const baseSha = git(root, "rev-parse", "HEAD");

    git(root, "checkout", "-q", "-b", "adversarial-config");
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github", "pr-reviewer.yml"), HOSTILE_YAML);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "add hostile repository config");
    const headSha = git(root, "rev-parse", "HEAD");

    // Reading at the TRUSTED BASE ref (what the engine does): the file is
    // simply not there — no applied keys, no warnings, no config source.
    const atBase = resolveRepositoryConfig(contract, operatorRaw(), { baseRef: baseSha, workspace: root });
    assert.deepEqual(atBase.appliedKeys, []);
    assert.equal(atBase.sourcePath, null);
    assert.equal(atBase.warnings.length, 0);

    // Reading at the PR HEAD ref (what a regression would do): the file
    // IS found. The discriminating observable is the refusal warnings —
    // a harness-side regression that swapped base for head changes
    // 0 warnings into per-key refusals, and with the gate open it would
    // even apply the escalation. This is the half the harness cannot
    // observe while the base tree legitimately carries no config.
    const atHead = resolveRepositoryConfig(contract, operatorRaw(), { baseRef: headSha, workspace: root });
    assert.equal(atHead.sourcePath, ".github/pr-reviewer.yml");
    assert.ok(atHead.warnings.length >= 6);

    const gateOpenAtHead = resolveRepositoryConfig(
      contract,
      { ...operatorRaw(), "allow-repo-policy-overrides": "true" },
      { baseRef: headSha, workspace: root },
    );
    assert.deepEqual(gateOpenAtHead.appliedKeys, ["verdict-policy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
