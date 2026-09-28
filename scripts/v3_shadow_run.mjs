#!/usr/bin/env node
// v3 shadow review runner + v2/v3 comparison (#809).
//
// Dogfood-only diagnostics: NOT part of the shipped runtime. The shadow job
// in .github/workflows/ai-pr-review.yaml runs the v3 `run` entry beside the
// production v2 review on every PR in this repository. It never publishes —
// the run entry has no publish path, and its GITHUB_OUTPUT lands in a scratch
// file the job uploads as an artifact next to the diff report.
//
// Modes:
//   node scripts/v3_shadow_run.mjs run       — map v2 snake_case env keys to
//       the v3 kebab-case INPUT_* contract (via contracts/action-v3.yml),
//       then exec `node dist/index.js run` with a scratch run directory.
//   node scripts/v3_shadow_run.mjs compare   — read the v2 review step's
//       outputs (passed as SHADOW_V2_* env) and the v3 run's artifacts, and
//       write a line-by-line diff report to $SHADOW_REPORT.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function contractInputMap() {
  const { parse } = require("yaml");
  const contract = parse(readFileSync(join(repoRoot, "contracts", "action-v3.yml"), "utf8"));
  const map = new Map();
  for (const input of contract.inputs) {
    if (input.v2_id) map.set(input.v2_id, input.id);
  }
  return map;
}

function mappedEnv(env) {
  const mapped = {};
  const map = contractInputMap();
  for (const [v2Key, v3Id] of map) {
    // The workflow binds SCREAMING_SNAKE names (AI_MODEL); accept the
    // contract's snake_case v2 id too.
    const value = env[v2Key] ?? env[v2Key.toUpperCase()];
    // Forward empty bindings too: the composite's env blocks bind empty
    // strings and the contract loader applies defaults for "" — the shadow
    // must see exactly what production sees.
    if (value !== undefined) {
      mapped[`INPUT_${v3Id.toUpperCase()}`] = value;
      mapped[`INPUT_${v3Id.toUpperCase().replaceAll("-", "_")}`] = value;
    }
  }
  // Ambient runner context the run entry reads as plain env.
  for (const key of ["REPO", "PR_NUMBER", "PR_HEAD_SHA", "IS_FORK_PR", "PLATFORM", "FORGEJO_API_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_VERSION"]) {
    if (env[key] !== undefined) mapped[key] = env[key];
  }
  // The composite passes the token to its steps as GH_TOKEN; bind it to the
  // required `github-token` contract input when no explicit value exists.
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token && !mapped["INPUT_GITHUB-TOKEN"]) {
    mapped["INPUT_GITHUB-TOKEN"] = token;
    mapped.INPUT_GITHUB_TOKEN = token;
  }
  // Inputs the composite resolves outside the shared env file (review-step
  // env block): forward the raw v2 names; the contract map above covers the
  // retained inputs and the removed ones simply never match.
  for (const key of ["AI_BASE_URL", "AI_API_KEY", "AI_MAX_TOKENS", "AI_FALLBACK_BASE_URL", "AI_FALLBACK_API_FORMAT", "AI_FALLBACK_API_KEY", "AI_PRIMARY_BASE_URL", "AI_PRIMARY_API_FORMAT", "AI_PRIMARY_API_KEY", "AI_SMART_BASE_URL", "AI_SMART_API_FORMAT", "AI_SMART_API_KEY", "AI_STREAM", "AI_FALLBACK_STREAM", "ON_MODEL_FAILURE", "VERDICT_POLICY", "NON_BLOCKING_FINDING_CATEGORIES", "VALIDATE_REQUIRED_CHECKS", "REQUIRED_CHECK_VALIDATION_MODE", "AI_PRIMARY_RETRIES", "AI_PRIMARY_RETRY_DELAY_SEC", "CI_STATUS_CHECK", "CI_TIMEOUT_SEC", "CI_INTERVAL_SEC", "CI_SKIP_ON_TIMEOUT", "ENRICHMENT_BUDGET_SEC", "IMAGE_DIGEST_BUDGET_SEC", "EVIDENCE_PROVIDER_PARALLELISM", "ALLOWED_SOURCE_HOSTS", "LINEAR_API_KEY"]) {
    if (env[key] !== undefined) mapped[key] = env[key];
    const v3Id = map.get(key.toLowerCase());
    if (v3Id !== undefined && env[key] !== undefined && env[key] !== "") {
      mapped[`INPUT_${v3Id.toUpperCase().replaceAll("-", "_")}`] = env[key];
    }
  }
  return mapped;
}

function runMode() {
  const distEntry = join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error("dist/index.js is missing; build first (npm run build)");
    process.exit(2);
  }
  const runDir = process.env.PR_REVIEWER_RUN_DIR ?? execFileSync("mktemp", ["-d"]).toString().trim();
  mkdirSync(runDir, { recursive: true });
  const mapped = mappedEnv(process.env);
  const child = spawnSync("node", [distEntry, "run"], {
    cwd: runDir,
    env: {
      ...process.env,
      ...mapped,
      PR_REVIEWER_RUN_DIR: runDir,
      // The shadow run never publishes and never touches the real outputs:
      // a scratch file the compare step uploads.
      GITHUB_OUTPUT: join(runDir, "shadow-outputs.txt"),
      GITHUB_STEP_SUMMARY: "",
      CI_CHECKS_FILE: process.env.CI_CHECKS_FILE ?? join(runDir, "ci-checks-context.md"),
    },
    stdio: "inherit",
    timeout: 55 * 60 * 1000,
  });
  writeFileSync(join(runDir, "shadow-exit-code.txt"), String(child.status ?? 1));
  // The v2 review must not fail because its shadow failed.
  process.exit(0);
}

function readArtifact(name) {
  const path = join(process.env.PR_REVIEWER_RUN_DIR ?? "", name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function compareMode() {
  const report = [];
  const line = (text) => report.push(text);
  const v2 = (key, fallback = "") => process.env[`SHADOW_V2_${key}`] ?? fallback;
  const v3 = readArtifact("ai-output.json");
  const v3Artifact = v3 === null ? null : (JSON.parse(v3) ?? {});
  const v3Outputs = readArtifact("shadow-outputs.txt") ?? "";
  const outputValue = (id) => {
    // formatOutputAssignment: `id=<first line>` plus delimited multiline
    // blocks; a tolerant line parse is enough for the scalar outputs.
    const match = v3Outputs.match(new RegExp(`^${id}=(.*)$`, "m"));
    return match === null ? null : match[1];
  };

  line("# v3 shadow comparison");
  line("");
  line(`- run started: ${new Date().toISOString()}`);
  for (const [label, value] of Object.entries({
    verdict: outputValue("verdict"),
    "verdict-source": outputValue("verdict-source"),
    "review-route": outputValue("review-route"),
    "escalation-reason": outputValue("escalation-reason"),
    "required-checks": outputValue("required-checks"),
    "analysis-engine": outputValue("analysis-engine"),
    "cache-hit-ratio": outputValue("cache-hit-ratio"),
  })) {
    const v2Value = v2(label.toUpperCase().replaceAll("-", "_"));
    const match = v2Value === value;
    line(`- ${match ? "==" : "!="} ${label}: v2=${JSON.stringify(v2Value)} v3=${JSON.stringify(value)}`);
  }
  const v2Findings = v2("FINDINGS", "[]");
  let v2Count = 0;
  try {
    v2Count = (JSON.parse(v2Findings) ?? []).length;
  } catch {
    v2Count = -1;
  }
  const v3Findings = v3Artifact === null ? [] : (v3Artifact.findings ?? []);
  line(`- ${v2Count === v3Findings.length ? "==" : "!="} findings count: v2=${v2Count} v3=${v3Findings.length}`);
  for (const name of ["classification.json", "tool-harness.json", "specialists.json", "requirement-ledger.json", "requirement-coverage.json", "evidence-providers.json"]) {
    const present = readArtifact(name) !== null;
    line(`- artifact ${name}: ${present ? "present" : "absent"}`);
  }
  const corpus = readArtifact("review-corpus.truncated.md");
  line(`- v3 corpus bytes: ${corpus === null ? "absent" : Buffer.byteLength(corpus)}`);
  line(`- v3 run exit: ${readArtifact("shadow-exit-code.txt") ?? "unknown"}`);
  const reportPath = process.env.SHADOW_REPORT ?? join(process.env.PR_REVIEWER_RUN_DIR ?? ".", "shadow-comparison.md");
  writeFileSync(reportPath, `${report.join("\n")}\n`);
  console.log(report.join("\n"));
}

export { mappedEnv };

// Importing the module (tests) must not run a mode.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] ?? "run";
  if (mode === "run") runMode();
  else if (mode === "compare") compareMode();
  else {
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
  }
}
