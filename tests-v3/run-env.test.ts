import test from "node:test";
import assert from "node:assert/strict";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { validateContract } from "../src/config/contract.js";
import { loadConfig } from "../src/config/load-config.js";
import { stageEnvFromConfig, buildStageEnv, validateStageEnv, type RunContext } from "../src/run/env.js";
import { resolveRepositoryConfig } from "../src/config/repository-config.js";

/**
 * The kebab→SCREAMING_SNAKE projection the orchestrator feeds the ported
 * stages (#809). The `config-default-resolution` parity boundary pins the
 * v2 side; this pins the v3 projection itself — every contract input lands
 * under the exact stage-ABI name the ported stages read, secrets arrive as
 * revealed values, and the GH_TOKEN binding follows config.sh's fallback.
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
