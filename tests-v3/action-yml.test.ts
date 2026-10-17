import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

interface ContractInput {
  id: string;
  v2_id?: string;
  required?: boolean;
  default?: unknown;
  "repo-configurable"?: boolean;
}
interface Contract {
  inputs: ContractInput[];
  outputs: { id: string; v2_id?: string }[];
}

function loadContract(): Contract {
  return parse(readFileSync("contracts/action-v3.yml", "utf8")) as Contract;
}

function readActionInputIds(): string[] {
  const action = parse(readFileSync("action.yml", "utf8")) as { inputs: Record<string, unknown> };
  return Object.keys(action.inputs);
}

test("action.yml is generated from the contract and is a node24 JavaScript action", () => {
  const check = spawnSync(process.execPath, ["scripts/generate-action-yml.mjs", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const action = parse(readFileSync("action.yml", "utf8")) as {
    runs: { using: string; main: string };
    inputs: Record<string, { required: boolean; default?: string }>;
  };
  assert.deepEqual(action.runs, { using: "node24", main: "dist/index.js" });
  // Drop-in setup: only the endpoint and model are required.
  const required = Object.entries(action.inputs).filter(([, spec]) => spec.required).map(([id]) => id).sort();
  assert.deepEqual(required, ["ai-base-url", "ai-model"]);
  assert.equal(action.inputs["github-token"]!.default, "${{ github.token }}");
});

// GitHub evaluates `${{ }}` expressions while loading a reusable action.yml, in a
// context where `github` is not available outside job-level input defaults: a
// literal expression in a description fails the whole run with
// "Unrecognized named-value: 'github'" (the #1037 dogfood breakage — the
// ai-extra-headers description quoted `${{ github.run_id }}` as an example).
// The only expression allowed in the generated file is the github-token default.
test("generated action.yml contains no GitHub expressions except the github-token default", () => {
  const expressionLines = readFileSync("action.yml", "utf8")
    .split("\n")
    .filter((line) => line.includes("${{"))
    .map((line) => line.trim());
  assert.deepEqual(expressionLines, ['default: "${{ github.token }}"']);
});

// #706 cutover: the live action.yml IS the v3 contract — kebab-case public ids,
// and no removed input is ever aliased back in. action.yml is generated from
// the contract (checked above), so the id sets are identical by construction;
// this pins the kebab shape and the required comment-marker input directly.
test("contract ids are unique kebab-case and cover action.yml exactly", () => {
  const contract = loadContract();
  const ids = [...contract.inputs.map((input) => input.id), ...contract.outputs.map((output) => output.id)];
  assert.equal(new Set(ids).size, ids.length, "duplicate contract ids");
  for (const id of ids) {
    assert.ok(!id.includes("_"), `contract id ${id} must not contain underscores`);
    assert.match(id, /^[a-z][a-z0-9-]*$/, `contract id ${id} must be kebab-case`);
  }
  assert.deepEqual(readActionInputIds().sort(), contract.inputs.map((input) => input.id).sort());
  assert.ok(contract.inputs.some((input) => input.id === "comment-marker"), "comment-marker input must be declared");
});

// docs/inputs.md is generated from the same contract; --check catches drift,
// and the set comparison catches a doc-only input the generator would never emit.
test("docs/inputs.md is fresh and lists every contract input", () => {
  const check = spawnSync(process.execPath, ["scripts/generate-inputs-doc.mjs", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const doc = readFileSync("docs/inputs.md", "utf8").split("## Outputs")[0]!;
  const documented = new Set([...doc.matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((match) => match[1]));
  const declared = new Set(loadContract().inputs.map((input) => input.id));
  assert.deepEqual([...documented].sort(), [...declared].sort());
});

// Credential/endpoint/operator-ceiling inputs (#777): repository config must
// never gain authority over these, so they must never be marked
// repo-configurable in the contract. Mixed v2 ids and v3-only ids, matched
// against v2_id when the entry still carries one.
const NEVER_REPO_CONFIGURABLE = new Set([
  "github_token", "ai_base_url", "ai_model", "ai_api_key",
  "ai_fallback_base_url", "ai_fallback_api_key", "ai_primary_api_key", "ai_smart_api_key",
  "ai-specialist-api-key",
  "linear_api_key", "tool_mcp_token", "forgejo_token",
  "allowed_source_hosts", "tool_mode", "tool_enable_for_forks", "tool_mcp_servers",
  "evidence_enable_for_forks", "linear_enable_for_forks", "allow_approve", "approve_forks",
  "publish_mode", "evidence_providers_file", "allow_repo_policy_overrides",
]);

test("repo-configurable inputs never include credentials or hard security policy", () => {
  for (const input of loadContract().inputs) {
    if (!input["repo-configurable"]) continue;
    assert.equal(input.required, false, input.id);
    assert.ok(!NEVER_REPO_CONFIGURABLE.has(input.v2_id ?? input.id), input.id);
  }
});

// Tier-resolved and specialist transport inputs stay operator-only workflow
// inputs; repository config must not select model endpoints or credentials.
const TIER_RESOLVED_NOT_REPO_CONFIGURABLE = ["primary_tool_max_requests", "smart_tool_max_requests"];
const TIER_RESOLVED_V3_ONLY_NOT_REPO_CONFIGURABLE = [
  "ai-specialist-model",
  "ai-specialist-base-url",
  "ai-specialist-api-format",
  // #998: the specialist reasoning effort is an operator-only input, exactly
  // like the rest of the ai-specialist-* family.
  "ai-specialist-reasoning-effort",
  // #998 (#1049 review): the specialist Anthropic effort opt-in is part of the
  // same operator-only specialist transport family.
  "ai-specialist-anthropic-effort-support",
];
const SPECIALIST_SECRET_NOT_REPO_CONFIGURABLE = ["ai-specialist-api-key"];

test("tier-resolved and specialist transport inputs stay operator-only", () => {
  const contract = loadContract();
  const byV2 = new Map(contract.inputs.filter((input) => input.v2_id).map((input) => [input.v2_id as string, input]));
  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  for (const v2Id of TIER_RESOLVED_NOT_REPO_CONFIGURABLE) {
    const entry = byV2.get(v2Id);
    assert.ok(entry, v2Id);
    assert.ok(!entry!["repo-configurable"], v2Id);
    assert.ok("default" in entry!, v2Id);
  }
  for (const id of TIER_RESOLVED_V3_ONLY_NOT_REPO_CONFIGURABLE) {
    const entry = byId.get(id);
    assert.ok(entry, id);
    assert.ok(!entry!["repo-configurable"], id);
    assert.ok("default" in entry!, id);
  }
  for (const id of SPECIALIST_SECRET_NOT_REPO_CONFIGURABLE) {
    const entry = byId.get(id);
    assert.ok(entry, id);
    assert.ok(NEVER_REPO_CONFIGURABLE.has(id), id);
    assert.ok(!entry!["repo-configurable"], id);
    assert.ok("default" in entry!, id);
  }
});

// The dogfood workflow consumes the kebab API: every input it passes must name
// a contract input, and the app token must be wired. Parsed from YAML, so
// reordering the with: block cannot break it (the old substring check did).
test("the dogfood workflow wires the action through kebab-case contract ids", () => {
  const workflow = parse(readFileSync(".github/workflows/ai-pr-review.yaml", "utf8")) as {
    jobs: Record<string, { steps: { name?: string; with?: Record<string, unknown> }[] }>;
  };
  const contractIds = new Set(loadContract().inputs.map((input) => input.id));
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === "Review PR with reusable AI reviewer");
  assert.ok(step, "dogfood review step not found");
  const withKeys = Object.keys(step!.with ?? {});
  assert.ok(withKeys.length > 0, "dogfood review step must pass inputs");
  for (const key of withKeys) {
    assert.ok(contractIds.has(key), `dogfood review step passes non-contract input ${key}`);
  }
  assert.ok(withKeys.includes("github-token"), "dogfood review step must pass github-token");
  assert.equal(
    step!.with?.["github-token"],
    "${{ steps.app-token.outputs.token }}",
    "the dogfood reviewer must post as the app bot, not the default runner token",
  );
});
