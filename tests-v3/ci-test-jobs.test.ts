import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_TEST_JOBS_CANDIDATE_PATHS,
  MAX_CI_TEST_JOB_IDENTITIES,
  MAX_CI_TEST_JOB_IDENTITY_CHARS,
  MAX_CI_TEST_JOBS_FILE_BYTES,
  parseCiTestJobsText,
  readCiTestJobsFromRef,
  resolveCiTestJobsFromRef,
} from "../src/config/ci-test-jobs.js";
import { RepositoryConfigError } from "../src/config/repository-config.js";

const PATH = CI_TEST_JOBS_CANDIDATE_PATHS[0];
const BASE = "test-jobs:\n  validate-typescript: full-suite\n";

function parsed(text: string): { jobs: ReadonlyMap<string, string>; warnings: readonly string[] } {
  const result = parseCiTestJobsText(text, PATH);
  assert.ok(!("malformed" in result));
  return result;
}

test("#1820 parses explicit job scopes and drops invalid entries", () => {
  const result = parsed([
    "test-jobs:",
    "  validate-typescript: full-suite",
    "  ' duplicate ': unit",
    "  duplicate: integration",
    `  ${"x".repeat(MAX_CI_TEST_JOB_IDENTITY_CHARS + 1)}: unit`,
    "  '   ': unit",
    "  invalid-scope: mystery",
    "  non-string: 3",
    "",
  ].join("\n"));
  assert.deepEqual([...result.jobs], [["validate-typescript", "full-suite"], ["duplicate", "unit"]]);
  assert.ok(result.warnings.length >= 5);
  assert.equal("malformed" in parseCiTestJobsText("test-jobs: []\n", PATH), true);
  assert.equal("malformed" in parseCiTestJobsText("x".repeat(MAX_CI_TEST_JOBS_FILE_BYTES + 1), PATH), true);
  assert.deepEqual(parsed("").jobs.size, 0);
  assert.equal(parsed("").warnings.length, 0);
});

test("#1820 caps identities and rejects malformed yaml or root values", () => {
  const rows = Array.from({ length: MAX_CI_TEST_JOB_IDENTITIES + 3 }, (_, index) => `  job-${index}: unit`).join("\n");
  const capped = parsed(`test-jobs:\n${rows}\n`);
  assert.equal(capped.jobs.size, MAX_CI_TEST_JOB_IDENTITIES);
  assert.ok(capped.warnings.some((warning) => /extra entries ignored/.test(warning)));
  for (const text of ["test-jobs: [", "- list", "test-jobs: 7", "other: value"]) {
    assert.ok("malformed" in parseCiTestJobsText(text, PATH), text);
  }
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}
function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-test-jobs-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: GIT_ENV });
  return root;
}
function writeConfig(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

test("#1820 resolves only the trusted base tree and handles absent/unreadable refs", () => {
  const root = initRepo();
  writeFileSync(join(root, "README"), "seed");
  commit(root, "seed");
  writeConfig(root, PATH, BASE);
  const base = commit(root, "base config");
  writeConfig(root, PATH, "test-jobs:\n  attacker: full-suite\n");
  commit(root, "head config");
  const file = readCiTestJobsFromRef(base, root);
  assert.equal(file?.text, BASE);
  const resolved = resolveCiTestJobsFromRef({ baseRef: base, workspace: root });
  assert.deepEqual([...resolved.jobs], [["validate-typescript", "full-suite"]]);
  const noConfig = initRepo();
  writeFileSync(join(noConfig, "README"), "no config");
  commit(noConfig, "no config");
  const absent = resolveCiTestJobsFromRef({ baseRef: "HEAD", workspace: noConfig });
  assert.equal(absent.jobs.size, 0);
  assert.deepEqual(absent.warnings, []);
  assert.throws(() => readCiTestJobsFromRef("", root), RepositoryConfigError);
  const bad = resolveCiTestJobsFromRef({ baseRef: "HEAD", workspace: tmpdir() });
  assert.equal(bad.jobs.size, 0);
  assert.ok(bad.warnings.length > 0);
  assert.deepEqual(resolveCiTestJobsFromRef({ baseRef: "" }).warnings, []);
});

test("#1820 resolver degrades a malformed trusted file to no jobs with a surfaced warning", () => {
  const root = initRepo();
  writeFileSync(join(root, "README"), "seed");
  commit(root, "seed");
  writeConfig(root, PATH, "test-jobs: [");
  commit(root, "malformed config");
  const resolved = resolveCiTestJobsFromRef({ baseRef: "HEAD", workspace: root });
  assert.equal(resolved.jobs.size, 0);
  assert.equal(resolved.sourcePath, null);
  assert.ok(resolved.warnings.some((warning) => /not valid YAML/.test(warning)));
});

test("#1820 engine wiring: the base-ref resolution precedes both enforcement folds that consume it", () => {
  const engine = readFileSync("src/engine/review.ts", "utf8");
  const resolution = engine.indexOf("resolveCiTestJobsFromRef({ baseRef");
  assert.ok(resolution > 0, "the engine resolves the trusted CI job config");
  assert.ok(
    engine.indexOf("resolveRepositoryConfig(contract, raw") < resolution,
    "trusted CI jobs resolve beside repository config, after the base ref is known",
  );
  const baseOptions = engine.indexOf("trustedCiJobs: ciTestJobs.jobs");
  assert.ok(baseOptions > resolution, "completenessBaseOptions consumes the resolved map");
  const obligationsCall = engine.indexOf("ciTestJobs.jobs,", baseOptions);
  assert.ok(obligationsCall > baseOptions, "resolveReviewObligations consumes the resolved map");
  assert.ok(
    engine.includes("reconcileObligationsWithCiEvidence(annotated, ciEvidence, reviewedHeadSha, trustedCiJobs)"),
    "the obligation fold receives the trusted jobs",
  );
  assert.ok(
    engine.includes("reconcileRequiredCheckRows(coverage.checks, options.ciEvidence, options.reviewedHeadSha ?? \"\", options.trustedCiJobs)")
      || readFileSync("src/enforcement/completeness.ts", "utf8").includes("options.trustedCiJobs"),
    "the coverage fold receives the trusted jobs",
  );
});
