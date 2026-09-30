import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import {
  applyRepositoryConfig,
  MAX_REPOSITORY_CONFIG_BYTES,
  parseRepositoryConfigText,
  readRepositoryConfigFromRef,
  REPOSITORY_CONFIG_CANDIDATE_PATHS,
  RepositoryConfigError,
  resolveRepositoryConfig,
  type RepositoryConfigFile,
} from "../src/config/repository-config.js";

const rawContract: unknown = parse(readFileSync("contracts/action-v3.yml", "utf8"));
const contract = validateContract(rawContract);

function baseOperatorRaw(): Record<string, string> {
  return Object.fromEntries(contract.inputs.map((input) => [input.id, input.default === undefined ? "operator-value" : String(input.default)]));
}

function policyOperatorRaw(): Record<string, string> {
  return { ...baseOperatorRaw(), "allow-repo-policy-overrides": "true" };
}

function fileOf(text: string, path = ".github/pr-reviewer.yml"): RepositoryConfigFile {
  return { path, text };
}

test("unknown keys warn and are ignored, never throw", () => {
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf("not-a-real-key: 5\n"));
  assert.equal(resolution.appliedKeys.length, 0);
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, /not-a-real-key.*not repo-configurable/);
  assert.equal(resolution.sourcePath, ".github/pr-reviewer.yml");
});

test("a contract input that is not marked repo-configurable is rejected the same way", () => {
  // ai-model is a required, non-repo-configurable input (a credential/endpoint).
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf("ai-model: some-other-model\n"));
  assert.equal(resolution.appliedKeys.length, 0);
  assert.match(resolution.warnings[0]!, /ai-model.*not repo-configurable/);
  assert.equal(resolution.raw["ai-model"], baseOperatorRaw()["ai-model"]);
});

test("a secret input is never repo-configurable even if named in the file", () => {
  const operatorRaw = baseOperatorRaw();
  const resolution = applyRepositoryConfig(contract, operatorRaw, fileOf("github-token: stolen\n"));
  assert.equal(resolution.appliedKeys.length, 0);
  assert.equal(resolution.raw["github-token"], operatorRaw["github-token"]);
});

test("#875: equivalent-paths-max-bytes is a positive integer — repo config zero/negative is rejected", () => {
  // Matches related-code-max-bytes: a repo-side 0 or negative must never
  // narrow the value (0 would silently become the 6000 default; a negative
  // would make the clipped hint empty) — it is rejected and the operator
  // default governs.
  for (const bad of ["0", "-1"]) {
    const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf(`equivalent-paths-max-bytes: ${bad}\n`));
    assert.equal(resolution.appliedKeys.length, 0, bad);
    assert.match(resolution.warnings[0]!, /must be at least 1/, bad);
    assert.equal(resolution.raw["equivalent-paths-max-bytes"], "6000", bad);
  }
});

test("bounded numeric input: repo may narrow below the operator's explicit ceiling, never exceed it", () => {
  const operatorRaw = baseOperatorRaw();
  operatorRaw["inline-findings-max"] = "20";
  const below = applyRepositoryConfig(contract, operatorRaw, fileOf("inline-findings-max: 5\n"));
  assert.deepEqual(below.appliedKeys, ["inline-findings-max"]);
  assert.equal(below.raw["inline-findings-max"], "5");
  assert.equal(below.warnings.length, 0);

  const above = applyRepositoryConfig(contract, operatorRaw, fileOf("inline-findings-max: 25\n"));
  assert.equal(above.appliedKeys.length, 0);
  assert.equal(above.raw["inline-findings-max"], "20");
  assert.match(above.warnings[0]!, /exceeds the operator ceiling of 20/);
});

test("bounded numeric input: with no explicit operator value, the ceiling is the contract default", () => {
  const operatorRaw = baseOperatorRaw(); // inline-findings-max left at its contract default (20)
  const atDefault = applyRepositoryConfig(contract, operatorRaw, fileOf("inline-findings-max: 20\n"));
  assert.deepEqual(atDefault.appliedKeys, ["inline-findings-max"]);
  const overDefault = applyRepositoryConfig(contract, operatorRaw, fileOf("inline-findings-max: 21\n"));
  assert.equal(overDefault.appliedKeys.length, 0);
  assert.match(overDefault.warnings[0]!, /exceeds the operator ceiling of 20/);
});

test("a numeric input that keeps a fixed contract default (tool-max-response-bytes) is still an ordinary workflow input, narrowable via repository config", () => {
  const operatorRaw = baseOperatorRaw();
  operatorRaw["tool-max-response-bytes"] = "9000"; // operator's explicit workflow ceiling
  const within = applyRepositoryConfig(contract, operatorRaw, fileOf("tool-max-response-bytes: 4000\n"));
  assert.deepEqual(within.appliedKeys, ["tool-max-response-bytes"]);
  assert.equal(within.raw["tool-max-response-bytes"], "4000");

  const exceeding = applyRepositoryConfig(contract, operatorRaw, fileOf("tool-max-response-bytes: 9001\n"));
  assert.equal(exceeding.appliedKeys.length, 0);
  assert.match(exceeding.warnings[0]!, /exceeds the operator ceiling of 9000/);
  assert.equal(exceeding.raw["tool-max-response-bytes"], "9000");
});

test("tier-resolved budgets (primary/smart-tool-max-requests) are not repo-configurable at all", () => {
  // Their contract default is "" on purpose (resolved per-route at harness
  // time); there is no config-time ceiling to narrow against, so falling
  // back to the type's hard 1..50 range would let a repository config file
  // RAISE a budget the operator's own workflow never granted. They must be
  // rejected exactly like any other non-repo-configurable input.
  const operatorRaw = baseOperatorRaw();
  const primary = applyRepositoryConfig(contract, operatorRaw, fileOf("primary-tool-max-requests: 12\n"));
  assert.equal(primary.appliedKeys.length, 0);
  assert.match(primary.warnings[0]!, /primary-tool-max-requests.*not repo-configurable/);
  assert.equal(primary.raw["primary-tool-max-requests"], operatorRaw["primary-tool-max-requests"]);

  const smart = applyRepositoryConfig(contract, operatorRaw, fileOf("smart-tool-max-requests: 12\n"));
  assert.equal(smart.appliedKeys.length, 0);
  assert.match(smart.warnings[0]!, /smart-tool-max-requests.*not repo-configurable/);
});

test("enum input: repository may set any allowed value only when the operator left it at default", () => {
  const operatorRaw = policyOperatorRaw(); // verdict-policy left at contract default "strict"
  const applied = applyRepositoryConfig(contract, operatorRaw, fileOf("verdict-policy: findings_severity_gated\n"));
  assert.deepEqual(applied.appliedKeys, ["verdict-policy"]);
  assert.equal(applied.raw["verdict-policy"], "findings_severity_gated");
  assert.equal(applied.warnings.length, 0);
});

test("enum input: an operator's explicit value always wins over the repository's", () => {
  const operatorRaw = policyOperatorRaw();
  operatorRaw["verdict-policy"] = "findings_severity_gated"; // explicit, differs from default "strict"
  const resolution = applyRepositoryConfig(contract, operatorRaw, fileOf("verdict-policy: model\n"));
  assert.equal(resolution.appliedKeys.length, 0);
  assert.equal(resolution.raw["verdict-policy"], "findings_severity_gated");
  assert.match(resolution.warnings[0]!, /operator explicitly set it/);
});

test("enum input: an invalid repository value is rejected with a warning, never crashes", () => {
  const operatorRaw = policyOperatorRaw();
  const resolution = applyRepositoryConfig(contract, operatorRaw, fileOf("verdict-policy: not_a_real_policy\n"));
  assert.equal(resolution.appliedKeys.length, 0);
  assert.match(resolution.warnings[0]!, /must be one of/);
});

test("boolean input follows the same operator-explicit rule as enums", () => {
  const operatorRaw = policyOperatorRaw(); // fail-on-request-changes defaults to "false", left unset
  const applied = applyRepositoryConfig(contract, operatorRaw, fileOf("fail-on-request-changes: true\n"));
  assert.deepEqual(applied.appliedKeys, ["fail-on-request-changes"]);
  assert.equal(applied.raw["fail-on-request-changes"], "true");

  operatorRaw["fail-on-request-changes"] = "true"; // now explicit
  const blocked = applyRepositoryConfig(contract, operatorRaw, fileOf("fail-on-request-changes: false\n"));
  assert.equal(blocked.appliedKeys.length, 0);
  assert.equal(blocked.raw["fail-on-request-changes"], "true");
});

test("policy inputs are ignored unless the operator opts in; non-policy inputs are unaffected", () => {
  const file = fileOf("verdict-policy: findings_severity_gated\nnon-blocking-finding-categories: security\nreview-verbosity: concise\n");
  const gated = applyRepositoryConfig(contract, baseOperatorRaw(), file);
  assert.deepEqual(gated.appliedKeys, ["review-verbosity"]);
  assert.equal(gated.raw["verdict-policy"], "strict");
  assert.equal(gated.warnings.filter((w) => w.includes("allow-repo-policy-overrides")).length, 2);
  const allowed = applyRepositoryConfig(contract, policyOperatorRaw(), file);
  assert.deepEqual([...allowed.appliedKeys].sort(), ["non-blocking-finding-categories", "review-verbosity", "verdict-policy"]);
});

test("evidence-providers-file is operator-only: repository config cannot enable command execution", () => {
  const input = contract.inputs.find((entry) => entry.id === "evidence-providers-file");
  assert.ok(input && !input["repo-configurable"]);
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf("evidence-providers-file: .github/providers.json\n"));
  assert.deepEqual(resolution.appliedKeys, []);
  assert.equal(resolution.raw["evidence-providers-file"], "");
});

test("the policy opt-in itself can never come from repository config", () => {
  const file = fileOf("allow-repo-policy-overrides: true\nverdict-policy: findings_severity_gated\n");
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), file);
  assert.deepEqual(resolution.appliedKeys, []);
  assert.equal(resolution.raw["allow-repo-policy-overrides"], "false");
});

test("free-form string input (standards-file) follows the operator-explicit rule and enforces a length cap", () => {
  const operatorRaw = baseOperatorRaw();
  const applied = applyRepositoryConfig(contract, operatorRaw, fileOf('standards-file: ".github/STANDARDS.md"\n'));
  assert.deepEqual(applied.appliedKeys, ["standards-file"]);
  assert.equal(applied.raw["standards-file"], ".github/STANDARDS.md");

  const tooLong = "x".repeat(5000);
  const rejected = applyRepositoryConfig(contract, operatorRaw, fileOf(`standards-file: "${tooLong}"\n`));
  assert.equal(rejected.appliedKeys.length, 0);
  assert.match(rejected.warnings[0]!, /must be at most/);
});

test("malformed YAML is ignored in its entirety with a warning, not a crash", () => {
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf("verdict-policy: [unterminated\n"));
  assert.equal(resolution.sourcePath, null);
  assert.equal(resolution.appliedKeys.length, 0);
  assert.match(resolution.warnings[0]!, /not valid YAML/);
});

test("a file that parses to a non-mapping (list/scalar) is malformed and ignored", () => {
  const asList = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf("- verdict-policy\n- model\n"));
  assert.match(asList.warnings[0]!, /must parse to a mapping/);
  const asScalar = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf("just-a-string\n"));
  assert.match(asScalar.warnings[0]!, /must parse to a mapping/);
});

test("an oversized file is treated as malformed and ignored", () => {
  const big = `verdict-policy: model\n# ${"x".repeat(MAX_REPOSITORY_CONFIG_BYTES + 10)}\n`;
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf(big));
  assert.equal(resolution.sourcePath, null);
  assert.match(resolution.warnings[0]!, /exceeds the/);
});

test("an empty file yields no overrides and no warnings", () => {
  const resolution = applyRepositoryConfig(contract, baseOperatorRaw(), fileOf(""));
  assert.equal(resolution.appliedKeys.length, 0);
  assert.equal(resolution.warnings.length, 0);
  assert.equal(resolution.sourcePath, ".github/pr-reviewer.yml");
});

test("no file present at all leaves the operator's inputs untouched", () => {
  const operatorRaw = baseOperatorRaw();
  const resolution = applyRepositoryConfig(contract, operatorRaw, undefined);
  assert.deepEqual(resolution.raw, operatorRaw);
  assert.equal(resolution.warnings.length, 0);
  assert.equal(resolution.sourcePath, null);
});

test("parseRepositoryConfigText treats null/empty documents as an empty (not malformed) config", () => {
  const result = parseRepositoryConfigText("", ".github/pr-reviewer.yml");
  assert.deepEqual(result, { values: {} });
});

// ---------------------------------------------------------------------------
// Base-side trust: read from the base ref via git, never the working tree.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "repo-config-test-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: GIT_ENV });
  return root;
}

function writeConfigFile(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

test("readRepositoryConfigFromRef reads the file's content at the given ref, ignoring the working tree", () => {
  const root = initRepo();
  writeFileSync(join(root, "README.md"), "seed\n");
  commit(root, "seed");
  writeConfigFile(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[0], "verdict-policy: model\n");
  const baseSha = commit(root, "base config");

  // Head "PR" commit rewrites the file to something weaker; a real PR could
  // try this on its own branch.
  writeConfigFile(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[0], "verdict-policy: anything-goes\n");
  commit(root, "head tries to weaken review config");

  const file = readRepositoryConfigFromRef(baseSha, root);
  assert.ok(file);
  assert.equal(file.path, REPOSITORY_CONFIG_CANDIDATE_PATHS[0]);
  assert.equal(file.text, "verdict-policy: model\n");

  // The working tree (HEAD) now holds the weaker text; reading from base
  // must not reflect it.
  assert.equal(readFileSync(join(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[0]), "utf8"), "verdict-policy: anything-goes\n");
});

test("readRepositoryConfigFromRef falls back to the second candidate path", () => {
  const root = initRepo();
  writeConfigFile(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[1], "review-verbosity: concise\n");
  const sha = commit(root, "root dotfile only");

  const file = readRepositoryConfigFromRef(sha, root);
  assert.ok(file);
  assert.equal(file.path, REPOSITORY_CONFIG_CANDIDATE_PATHS[1]);
});

test("readRepositoryConfigFromRef prefers .github/pr-reviewer.yml over the root dotfile", () => {
  const root = initRepo();
  writeConfigFile(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[1], "review-verbosity: concise\n");
  writeConfigFile(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[0], "review-verbosity: normal\n");
  const sha = commit(root, "both candidates present");

  const file = readRepositoryConfigFromRef(sha, root);
  assert.ok(file);
  assert.equal(file.path, REPOSITORY_CONFIG_CANDIDATE_PATHS[0]);
});

test("readRepositoryConfigFromRef returns undefined when no candidate exists at the ref (not an error)", () => {
  const root = initRepo();
  writeFileSync(join(root, "README.md"), "no config here\n");
  const sha = commit(root, "no repository config");
  assert.equal(readRepositoryConfigFromRef(sha, root), undefined);
});

test("readRepositoryConfigFromRef requires a non-empty ref and rejects a workspace with no git repository", () => {
  assert.throws(() => readRepositoryConfigFromRef("", "/tmp"), RepositoryConfigError);
  const root = mkdtempSync(join(tmpdir(), "repo-config-nogit-"));
  assert.equal(readRepositoryConfigFromRef("HEAD", root), undefined);
});

test("resolveRepositoryConfig ties the git read and the precedence merge together", () => {
  const root = initRepo();
  writeConfigFile(root, REPOSITORY_CONFIG_CANDIDATE_PATHS[0], "verdict-policy: findings_severity_gated\n");
  const sha = commit(root, "base config");

  const operatorRaw = policyOperatorRaw();
  const resolution = resolveRepositoryConfig(contract, operatorRaw, { baseRef: sha, workspace: root });
  assert.deepEqual(resolution.appliedKeys, ["verdict-policy"]);
  assert.equal(resolution.raw["verdict-policy"], "findings_severity_gated");
});

test("resolveRepositoryConfig degrades to the operator's inputs, with a warning, on a git infrastructure error", () => {
  const operatorRaw = baseOperatorRaw();
  const resolution = resolveRepositoryConfig(contract, operatorRaw, { baseRef: "", workspace: "/tmp" });
  assert.deepEqual(resolution.raw, operatorRaw);
  assert.equal(resolution.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Contract-level invariants for the repo-configurable marker.
// ---------------------------------------------------------------------------

test("the canonical contract marks a non-empty, sane repo-configurable set", () => {
  const configurable = contract.inputs.filter((input) => input["repo-configurable"]);
  assert.ok(configurable.length > 0);
  for (const input of configurable) {
    assert.equal(input.required, false, input.id);
  }
});

test("tier-resolved budgets are excluded from the repo-configurable set", () => {
  const byId = new Map(contract.inputs.map((input) => [input.id, input]));
  assert.equal(byId.get("primary-tool-max-requests")?.["repo-configurable"], undefined);
  assert.equal(byId.get("smart-tool-max-requests")?.["repo-configurable"], undefined);
});

test("validateContract rejects a required input marked repo-configurable", () => {
  const mutated = structuredClone(rawContract) as { inputs: Record<string, unknown>[] };
  const target = mutated.inputs.find((i) => i.id === "ai-model")!;
  target["repo-configurable"] = true;
  assert.throws(() => validateContract(mutated), /cannot be both required and repo-configurable/);
});

test("validateContract rejects a secret input marked repo-configurable", () => {
  const mutated = structuredClone(rawContract) as { inputs: Record<string, unknown>[] };
  const target = mutated.inputs.find((i) => i.id === "linear-api-key")!;
  target["required"] = false;
  target["repo-configurable"] = true;
  assert.throws(() => validateContract(mutated), /must never be repo-configurable/);
});
