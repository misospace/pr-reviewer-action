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
import { TangledAdapter } from "../src/platform/tangled-adapter.js";
import { buildPlatformReadAdapter } from "../src/run/platform.js";
import { resolveLoopLimits } from "../src/tools/harness.js";
import { adaptiveLoopBudgets } from "../src/tools/loop.js";
import { stageEnvFromConfig, buildStageEnv, validateStageEnv, type RunContext } from "../src/run/env.js";
import { buildHumanReviewsSection } from "../src/run/stages.js";
import { RunWorkspace } from "../src/run/workspace.js";
import { rawInputsFromEnv } from "../src/run/review.js";
import { collectConfigLines, computeConfigHash } from "../src/precheck/fingerprint.js";

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
  assert.equal(env.FAIL_ON_DEGRADED_REVIEW, "false");
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
  // auto to the Tangled read adapter (#585) instead of the GitHub fallback.
  assert.ok(buildPlatformReadAdapter(env) instanceof TangledAdapter);
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

test("#1020: smart-tier round and wall-clock inputs reach resolveLoopLimits from the runner's INPUT_ channel", async (t) => {
  const base: RunContext = {
    workspace: "/ws", runDir: "/run", repo: "o/r", prNumber: "9", headSha: "",
    isForkPr: "false", platform: "auto", forgejoApiUrl: "", ciChecksFile: "",
    outputFilePath: "/dev/null", stepSummaryPath: "", baseRef: "",
  };
  // The runner exports composite inputs as INPUT_<ID> with kebab IDs kept.
  const runnerEnv = (inputs: Record<string, string>, ambient: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...ambient };
    for (const input of contract.inputs.filter((entry) => entry.required)) {
      env[`INPUT_${input.id.toUpperCase()}`] = `required-${input.id}`;
    }
    for (const [id, value] of Object.entries(inputs)) env[`INPUT_${id.toUpperCase()}`] = value;
    return env;
  };
  const stageFor = (env: NodeJS.ProcessEnv): Record<string, string> =>
    buildStageEnv(loadConfig(contract, rawInputsFromEnv(contract, env)), base, env);
  const caps = (stage: Record<string, string>, tier: "smart" | "primary", budget: number): number => {
    const [maxRounds, wallClock, explicit] = resolveLoopLimits(stage, tier);
    return adaptiveLoopBudgets(maxRounds, budget, wallClock, explicit).maxRounds;
  };
  const cases: {
    name: string;
    inputs: Record<string, string>;
    ambient?: Record<string, string>;
    smart: [number, number, boolean];
    smartCap: number;
    primary: [number, number, boolean];
    primaryCap: number;
  }[] = [
    {
      name: "runner default: smart inputs exported empty",
      inputs: { "smart-tool-max-rounds": "", "smart-tool-loop-wall-clock-sec": "" },
      smart: [4, 600, false], smartCap: 32, primary: [4, 600, false], primaryCap: 24,
    },
    {
      name: "smart inherits an explicit primary pair",
      inputs: { "tool-max-rounds": "3", "tool-loop-wall-clock-sec": "300" },
      smart: [3, 300, true], smartCap: 6, primary: [3, 300, true], primaryCap: 6,
    },
    {
      name: "smart override with the primary pair unset",
      inputs: { "smart-tool-max-rounds": "5", "smart-tool-loop-wall-clock-sec": "120" },
      smart: [5, 120, true], smartCap: 10, primary: [4, 600, false], primaryCap: 24,
    },
    {
      name: "smart override beats an explicit primary pair",
      inputs: {
        "tool-max-rounds": "2", "smart-tool-max-rounds": "6",
        "tool-loop-wall-clock-sec": "300", "smart-tool-loop-wall-clock-sec": "900",
      },
      smart: [6, 900, true], smartCap: 12, primary: [2, 300, true], primaryCap: 4,
    },
    {
      name: "ambient SCREAMING_SNAKE env is not a route",
      inputs: {},
      ambient: { SMART_TOOL_MAX_ROUNDS: "6", SMART_TOOL_LOOP_WALL_CLOCK_SEC: "120" },
      smart: [4, 600, false], smartCap: 32, primary: [4, 600, false], primaryCap: 24,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const stage = stageFor(runnerEnv(entry.inputs, entry.ambient));
      assert.deepEqual(resolveLoopLimits(stage, "smart"), entry.smart, "smart limits");
      assert.equal(caps(stage, "smart", 32), entry.smartCap, "smart rounds cap");
      assert.deepEqual(resolveLoopLimits(stage, "primary"), entry.primary, "primary limits");
      assert.equal(caps(stage, "primary", 24), entry.primaryCap, "primary rounds cap");
    });
  }
  await t.test("the smart round cap is part of the config fingerprint", () => {
    const stage = stageFor(runnerEnv({ "smart-tool-max-rounds": "5", "smart-tool-loop-wall-clock-sec": "120" }));
    assert.ok(collectConfigLines(stage).includes("SMART_TOOL_MAX_ROUNDS=5"));
  });
  // A longer loop can finish more rounds, so a wall-clock change on an
  // unchanged diff has to re-review rather than skip as already reviewed.
  for (const id of ["tool-loop-wall-clock-sec", "smart-tool-loop-wall-clock-sec"]) {
    await t.test(`changing ${id} changes the config hash`, () => {
      const hashOf = (value: string) => computeConfigHash(collectConfigLines(stageFor(runnerEnv({ [id]: value }))));
      assert.notEqual(hashOf("120"), hashOf("900"));
    });
  }
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
