import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { validateContract } from "../src/config/contract.js";
import { loadConfig } from "../src/config/load-config.js";
import { GitHubAdapter } from "../src/platform/github.js";
import { SemanticFixtureAdapter } from "../src/platform/semantic-fixture.js";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { buildPlatformReadAdapter } from "../src/run/platform.js";
import { resolveLoopLimits } from "../src/tools/harness.js";
import { adaptiveLoopBudgets } from "../src/tools/loop.js";
import { stageEnvFromConfig, buildStageEnv, validateStageEnv, type RunContext } from "../src/run/env.js";
import { buildHumanReviewsSection } from "../src/run/stages.js";
import { RunWorkspace } from "../src/run/workspace.js";

/**
 * The kebab→SCREAMING_SNAKE projection the orchestrator feeds the ported
 * stages (#809): every contract input lands under the exact stage-ABI name
 * the ported stages read, secrets arrive as revealed values, and the
 * GH_TOKEN binding follows config.sh's fallback.
 */

const contract = validateContract(V3_CONTRACT);

test("stageEnvFromConfig covers every contract input under its SCREAMING_SNAKE name", () => {
  const raw: Record<string, string> = {};
  for (const input of contract.inputs) {
    raw[input.id] = String(input.default ?? "x");
  }
  const config = loadConfig(contract, raw);
  const env = stageEnvFromConfig(config);
  for (const input of contract.inputs) {
    const name = input.id.toUpperCase().replaceAll("-", "_");
    assert.ok(Object.hasOwn(env, name), `missing stage-ABI key ${name} for ${input.id}`);
  }
  // Hyphenated IDs keep the hyphen in the INPUT_ channel (the runner's
  // literal export) but lose it on the stage ABI.
  assert.ok(!Object.keys(env).some((key) => key.includes("-")), "stage ABI is SCREAMING_SNAKE only");
});

test("projection values: defaults, numbers, booleans, and revealed secrets", () => {
  const config = loadConfig(contract, {
    "repo": "o/r",
    "pr-number": "7",
    "ai-base-url": "http://m/v1",
    "ai-model": "m",
    "ai-api-format": "anthropic",
    "ai-max-tokens": "4096",
    "github-token": "tok",
    "ci-status-check": "true",
  });
  const env = stageEnvFromConfig(config);
  assert.equal(env.REPO, "o/r");
  assert.equal(env.PR_NUMBER, "7");
  assert.equal(env.AI_BASE_URL, "http://m/v1");
  assert.equal(env.AI_MODEL, "m");
  assert.equal(env.AI_API_FORMAT, "anthropic");
  assert.equal(env.AI_MAX_TOKENS, "4096");
  assert.equal(env.CI_STATUS_CHECK, "true");
  assert.equal(env.GITHUB_TOKEN, "tok", "secrets are revealed on the stage ABI, never redacted");
  assert.equal(env.AI_TEMPERATURE, "0.1", "contract default applies when the input is unset");
});

test("GH_TOKEN follows config.sh's binding: GH_TOKEN || GITHUB_TOKEN, then the token input", () => {
  const base: RunContext = {
    workspace: "/ws", runDir: "/run", repo: "o/r", prNumber: "7", headSha: "",
    isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: "",
    outputFilePath: "/dev/null", stepSummaryPath: "", baseRef: "",
  };
  const config = loadConfig(contract, {
    "repo": "o/r", "pr-number": "7",
    "ai-base-url": "http://m/v1", "ai-model": "m", "github-token": "tok",
  });
  const fromInput = buildStageEnv(config, base, {});
  assert.equal(fromInput.GH_TOKEN, "tok", "config.githubToken feeds GH_TOKEN when ambient has none");
  const fromAmbient = buildStageEnv(config, base, { GH_TOKEN: "ambient" });
  assert.equal(fromAmbient.GH_TOKEN, "ambient");
});

test("validateStageEnv fails closed with the v2 messages on missing bindings", () => {
  const config = loadConfig(contract, { "github-token": "t", "ai-base-url": "u", "ai-model": "m" });
  const empty = stageEnvFromConfig(config);
  const message = validateStageEnv({ ...empty, GH_TOKEN: "" } as never);
  assert.match(message ?? "", /Missing required environment variables: REPO/);
  assert.match(
    validateStageEnv({ ...empty, REPO: "o/r", PR_NUMBER: "1", AI_BASE_URL: "u", AI_MODEL: "m", GH_TOKEN: "" } as never) ?? "",
    /Missing GitHub token/,
  );
  assert.equal(validateStageEnv({ ...empty, REPO: "o/r", PR_NUMBER: "1", AI_BASE_URL: "u", AI_MODEL: "m", GH_TOKEN: "t" } as never), null);
});

test("eval fixture keys survive the stage-env projection and yield the offline adapter", async () => {
  // The real run path is buildStageEnv -> buildPlatformReadAdapter, so the
  // projection must carry the eval harness's SEMANTIC_FIXTURE_* keys —
  // they are not contract inputs or RunContext fields (#706 wave 0).
  const dir = mkdtempSync(join(tmpdir(), "semantic-"));
  try {
    mkdirSync(join(dir, ".semantic-fixture"));
    writeFileSync(join(dir, ".semantic-fixture", "pr.json"), JSON.stringify({ number: 9 }));
    const config = loadConfig(contract, {
      "repo": "o/r", "pr-number": "9",
      "ai-base-url": "http://m/v1", "ai-model": "m", "github-token": "tok",
    });
    const base: RunContext = {
      workspace: "/ws", runDir: "/run", repo: "o/r", prNumber: "9", headSha: "",
      isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: "",
      outputFilePath: "/dev/null", stepSummaryPath: "", baseRef: "",
    };
    const env = buildStageEnv(config, base, {
      REPO: "o/r", PR_NUMBER: "9", GITHUB_TOKEN: "tok",
      SEMANTIC_FIXTURE_MODE: "true", SEMANTIC_FIXTURE_DIR: dir,
    });
    assert.equal(env.SEMANTIC_FIXTURE_MODE, "true");
    assert.equal(env.SEMANTIC_FIXTURE_DIR, dir);
    const adapter = buildPlatformReadAdapter(env);
    assert.ok(adapter instanceof SemanticFixtureAdapter);
    // Offline by construction: the read is served from the fixture file,
    // never from a forge.
    assert.deepEqual(await adapter.getPr(), { number: 9 });
    // Without the keys the projection strips nothing and a real adapter
    // is built.
    const plain = buildPlatformReadAdapter(buildStageEnv(config, base, { REPO: "o/r", PR_NUMBER: "9", GITHUB_TOKEN: "tok" }));
    assert.ok(!(plain instanceof SemanticFixtureAdapter));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Tangled identity signal survives the stage-env projection (#583)", () => {
  // The real run path is buildStageEnv -> buildPlatformReadAdapter; if the
  // projection dropped TANGLED_REPO_DID, auto resolution would silently
  // fall through to a GitHub adapter instead of a tangled identity.
  const config = loadConfig(contract, {
    "repo": "o/r", "pr-number": "9",
    "ai-base-url": "http://m/v1", "ai-model": "m", "github-token": "tok",
  });
  const base: RunContext = {
    workspace: "/ws", runDir: "/run", repo: "o/r", prNumber: "9", headSha: "",
    isForkPr: "false", platform: "auto", forgejoApiUrl: "", ciChecksFile: "",
    outputFilePath: "/dev/null", stepSummaryPath: "", baseRef: "",
  };
  const env = buildStageEnv(config, base, {
    REPO: "o/r", PR_NUMBER: "9", GITHUB_TOKEN: "tok",
    TANGLED_REPO_DID: "did:plc:repo",
  });
  assert.equal(env.TANGLED_REPO_DID, "did:plc:repo");
  // End to end through the real adapter boundary: the projected DID flips
  // auto to tangled, which fails loudly instead of constructing an adapter.
  assert.throws(() => buildPlatformReadAdapter(env), TangledNotImplementedError);
  // Without the signal the same projection builds the GitHub adapter.
  const plain = buildPlatformReadAdapter(
    buildStageEnv(config, base, { REPO: "o/r", PR_NUMBER: "9", GITHUB_TOKEN: "tok" }),
  );
  assert.ok(plain instanceof GitHubAdapter);
});

test("#895: an omitted tool-max-rounds scales the round cap through the real config path; an explicit one does not", () => {
  const required = Object.fromEntries(contract.inputs.filter((input) => input.required).map((input) => [input.id, `required-${input.id}`]));
  const rounds = (raw: Record<string, string>): number => {
    const [maxRounds, wallClock, explicit] = resolveLoopLimits(stageEnvFromConfig(loadConfig(contract, raw)), "smart");
    return adaptiveLoopBudgets(maxRounds, 32, wallClock, explicit).maxRounds;
  };
  assert.ok(rounds(required) >= 16, "the contract default must leave the round cap free to scale with a 32-call budget");
  assert.equal(rounds({ ...required, "tool-max-rounds": "4" }), 8);
});

test("#928: env-only stage knobs survive buildStageEnv, so blind replays really skip human reviews", async () => {
  const base: RunContext = {
    workspace: "/ws", runDir: "/run", repo: "o/r", prNumber: "7", headSha: "",
    isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: "",
    outputFilePath: "/dev/null", stepSummaryPath: "", baseRef: "",
  };
  const config = loadConfig(contract, { "repo": "o/r", "pr-number": "7", "ai-base-url": "http://m/v1", "ai-model": "m" });
  const env = buildStageEnv(config, base, {
    HUMAN_REVIEWS_CONTEXT: "false", DEEP_REVIEW_EXECUTION: "prime_then_fanout", AI_FALLBACK_RETRIES: "2", AI_SMART_RETRIES: "1",
  });
  assert.equal(env.HUMAN_REVIEWS_CONTEXT, "false");
  assert.equal(env.DEEP_REVIEW_EXECUTION, "prime_then_fanout");
  assert.equal(env.AI_FALLBACK_RETRIES, "2");
  assert.equal(env.AI_SMART_RETRIES, "1");

  const review = { id: 1, state: "CHANGES_REQUESTED", user: { login: "maintainer", type: "User" }, body: "Blocker: the resolver ignores ctx.sourceSha.", commit_id: "a".repeat(40), submitted_at: "2026-09-30T00:00:00Z" };
  const adapter = { listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [review] }) } as never;
  const blind = new RunWorkspace(mkdtempSync(join(tmpdir(), "v3-hr-blind-")), false);
  await buildHumanReviewsSection(blind, adapter, "a".repeat(40), env as never);
  assert.equal(blind.readText("human-reviews.md") ?? "", "");
  const seeing = new RunWorkspace(mkdtempSync(join(tmpdir(), "v3-hr-open-")), false);
  await buildHumanReviewsSection(seeing, adapter, "a".repeat(40), buildStageEnv(config, base, {}) as never);
  assert.match(seeing.readText("human-reviews.md") ?? "", /ctx\.sourceSha/);
});

test("#914: the pr-gate's pinned head sha is projected from the ambient env into the stage env", () => {
  const base: RunContext = {
    workspace: "/ws", runDir: "/run", repo: "o/r", prNumber: "7", headSha: "",
    isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: "",
    outputFilePath: "/dev/null", stepSummaryPath: "", baseRef: "",
  };
  const config = loadConfig(contract, { "repo": "o/r", "pr-number": "7", "ai-base-url": "http://m/v1", "ai-model": "m" });
  const pinned = buildStageEnv(config, base, { PR_REVIEWER_GATE_HEAD_SHA: "a".repeat(40) });
  assert.equal(pinned.PR_REVIEWER_GATE_HEAD_SHA, "a".repeat(40));
  const unpinned = buildStageEnv(config, base, {});
  assert.equal(unpinned.PR_REVIEWER_GATE_HEAD_SHA, undefined);
});
