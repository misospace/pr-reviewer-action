import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_TEST_JOBS_CANDIDATE_PATHS,
  ciJobIdentitiesFromRef,
  ciWorkflowSurfaceChangedFromBase,
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

function resolverFixture(workflows: Record<string, string>, identities: string[] = ["validate-typescript"]): { root: string; base: string } {
  const root = initRepo();
  writeFileSync(join(root, "README"), "seed");
  writeConfig(root, PATH, `test-jobs:\n${identities.map((identity) => `  '${identity}': full-suite`).join("\n")}\n`);
  for (const [path, text] of Object.entries(workflows)) writeConfig(root, `.github/workflows/${path}`, text);
  return { root, base: commit(root, "base config and workflows") };
}

test("#1820 resolves only the trusted base tree and handles absent/unreadable refs", () => {
  const root = initRepo();
  writeFileSync(join(root, "README"), "seed");
  commit(root, "seed");
  writeConfig(root, PATH, BASE);
  writeConfig(root, ".github/workflows/test.yml", "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n");
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
  assert.equal(bad.workflowSurfaceTrusted, false);
  assert.ok(bad.warnings.length > 0);
  assert.deepEqual(resolveCiTestJobsFromRef({ baseRef: "" }).warnings, []);
});

test("#1820 resolver validates configured identities against the complete base workflow surface", () => {
  const absent = resolverFixture({});
  const absentResult = resolveCiTestJobsFromRef({ baseRef: absent.base, headRef: absent.base, workspace: absent.root });
  assert.equal(absentResult.jobs.size, 0);
  assert.ok(absentResult.warnings.some((warning) => /does not name a static job/.test(warning)));
  assert.equal(absentResult.sourcePath, PATH);

  const byKey = resolverFixture({ "key.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n" });
  assert.equal(resolveCiTestJobsFromRef({ baseRef: byKey.base, headRef: byKey.base, workspace: byKey.root }).jobs.has("validate-typescript"), true);

  const byName = resolverFixture({ "name.yml": "jobs:\n  test-job:\n    name: validate-typescript\n    uses: owner/repo/.github/workflows/test.yml@main\n" });
  assert.equal(resolveCiTestJobsFromRef({ baseRef: byName.base, headRef: byName.base, workspace: byName.root }).jobs.has("validate-typescript"), true);

  for (const workflows of [
    { "one.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n", "two.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n" },
    { "duplicate.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n  validate-typescript-copy:\n    name: validate-typescript\n    runs-on: ubuntu-latest\n" },
  ]) {
    const duplicate = resolverFixture(workflows);
    const result = resolveCiTestJobsFromRef({ baseRef: duplicate.base, headRef: duplicate.base, workspace: duplicate.root });
    assert.equal(result.jobs.size, 0);
    assert.ok(result.warnings.some((warning) => /more than one job/.test(warning)));
  }

  const matrix = resolverFixture({ "matrix.yml": "jobs:\n  matrix:\n    name: 'Test (\${{ matrix.node }})'\n    runs-on: ubuntu-latest\n  validate-typescript:\n    runs-on: ubuntu-latest\n" });
  assert.equal(resolveCiTestJobsFromRef({ baseRef: matrix.base, headRef: matrix.base, workspace: matrix.root }).jobs.has("validate-typescript"), true);

  for (const workflow of [
    "jobs:\n  dynamic:\n    name: ${{ github.event.pull_request.title }}\n    runs-on: ubuntu-latest\n  validate-typescript:\n    runs-on: ubuntu-latest\n",
    "jobs: [\n",
  ]) {
    const unsafe = resolverFixture({ "unsafe.yml": workflow });
    const result = resolveCiTestJobsFromRef({ baseRef: unsafe.base, headRef: unsafe.base, workspace: unsafe.root });
    assert.equal(result.jobs.size, 0);
    assert.ok(result.warnings.some((warning) => /PR-author-controlled|unsafe.yml/.test(warning)));
  }

  const unreadable = resolverFixture({});
  const failed = ciJobIdentitiesFromRef(unreadable.base, tmpdir());
  assert.equal(failed.staticNames.size, 0);
  assert.equal(failed.prMintable, true);
  assert.ok(failed.warning?.includes("could not be read"));
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

test("#1820 workflow surface fence tracks only changes introduced by the PR", () => {
  const root = initRepo();
  writeFileSync(join(root, "README"), "seed");
  writeConfig(root, PATH, BASE);
  writeConfig(root, ".github/workflows/test.yml", "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n");
  const base = commit(root, "base config");
  writeFileSync(join(root, "ordinary.txt"), "unchanged workflow surface\n");
  const unchangedHead = commit(root, "unchanged head");
  assert.deepEqual(ciWorkflowSurfaceChangedFromBase({ baseRef: base, headRef: unchangedHead, workspace: root }), { changed: false, warning: null });
  const subdirectory = join(root, "nested", "workspace");
  mkdirSync(subdirectory, { recursive: true });
  assert.deepEqual(ciWorkflowSurfaceChangedFromBase({ baseRef: base, headRef: unchangedHead, workspace: subdirectory }), { changed: false, warning: null });
  const unchanged = resolveCiTestJobsFromRef({ baseRef: base, headRef: unchangedHead, workspace: root });
  assert.equal(unchanged.workflowSurfaceTrusted, true);

  writeConfig(root, ".github/workflows/evil.yml", "name: evil\n");
  const workflowHead = commit(root, "add workflow");
  assert.deepEqual(ciWorkflowSurfaceChangedFromBase({ baseRef: base, headRef: workflowHead, workspace: root }), { changed: true, warning: null });
  assert.deepEqual(ciWorkflowSurfaceChangedFromBase({ baseRef: base, headRef: workflowHead, workspace: subdirectory }), { changed: true, warning: null });
  const changed = resolveCiTestJobsFromRef({ baseRef: base, headRef: workflowHead, workspace: root });
  assert.equal(changed.workflowSurfaceTrusted, false);
  assert.equal(changed.warnings.length, 0);

  const branchRoot = initRepo();
  writeFileSync(join(branchRoot, "README"), "seed");
  writeConfig(branchRoot, PATH, BASE);
  const forkPoint = commit(branchRoot, "base config");
  execFileSync("git", ["-C", branchRoot, "checkout", "-q", "-b", "pr"], { env: GIT_ENV });
  writeFileSync(join(branchRoot, "pr.txt"), "pr");
  const prHead = commit(branchRoot, "pr change");
  execFileSync("git", ["-C", branchRoot, "checkout", "-q", "main"], { env: GIT_ENV });
  writeConfig(branchRoot, ".github/workflows/base-only.yml", "name: base\n");
  commit(branchRoot, "base workflow advances");
  assert.deepEqual(ciWorkflowSurfaceChangedFromBase({ baseRef: "main", headRef: prHead, workspace: branchRoot }), { changed: false, warning: null });
  assert.equal(forkPoint.length > 0, true);

  const gitlabRoot = initRepo();
  writeFileSync(join(gitlabRoot, "README"), "seed");
  const gitlabBase = commit(gitlabRoot, "seed");
  writeFileSync(join(gitlabRoot, ".gitlab-ci.yml"), "stages: [test]\n");
  const gitlabHead = commit(gitlabRoot, "edit gitlab workflow");
  assert.equal(ciWorkflowSurfaceChangedFromBase({ baseRef: gitlabBase, headRef: gitlabHead, workspace: gitlabRoot }).changed, true);
});

test("#1820 workflow surface verification fails closed and resolver reports missing refs", () => {
  const root = initRepo();
  writeFileSync(join(root, "README"), "seed");
  writeConfig(root, PATH, BASE);
  writeConfig(root, ".github/workflows/test.yml", "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n");
  const base = commit(root, "base config");
  const unknownHead = "0000000000000000000000000000000000000000";
  const failed = ciWorkflowSurfaceChangedFromBase({ baseRef: base, headRef: unknownHead, workspace: root });
  assert.equal(failed.changed, true);
  assert.ok(failed.warning?.includes("could not be verified"));
  const resolvedFailed = resolveCiTestJobsFromRef({ baseRef: base, headRef: unknownHead, workspace: root });
  assert.equal(resolvedFailed.workflowSurfaceTrusted, false);
  assert.ok(resolvedFailed.warnings.some((warning) => warning.includes("could not be verified")));

  const noHead = resolveCiTestJobsFromRef({ baseRef: base, workspace: root });
  assert.equal(noHead.workflowSurfaceTrusted, false);
  assert.ok(noHead.warnings.some((warning) => warning.includes("could not be verified")));
  const emptyHead = resolveCiTestJobsFromRef({ baseRef: base, headRef: "", workspace: root });
  assert.equal(emptyHead.workflowSurfaceTrusted, false);
  assert.ok(emptyHead.warnings.some((warning) => warning.includes("could not be verified")));
  const nulHead = resolveCiTestJobsFromRef({ baseRef: base, headRef: "bad\u0000ref", workspace: root });
  assert.equal(nulHead.workflowSurfaceTrusted, false);
  assert.ok(nulHead.warnings.some((warning) => warning.includes("could not be verified")));

  const noConfigRoot = initRepo();
  writeFileSync(join(noConfigRoot, "README"), "seed");
  const noConfigBase = commit(noConfigRoot, "no config");
  const noConfig = resolveCiTestJobsFromRef({ baseRef: noConfigBase, workspace: noConfigRoot });
  assert.equal(noConfig.workflowSurfaceTrusted, true);
  assert.deepEqual(noConfig.warnings, []);
});

test("#1820 engine wiring: the base-ref resolution precedes both enforcement folds that consume it", () => {
  const engine = readFileSync("src/engine/review.ts", "utf8");
  const resolution = engine.indexOf("resolveCiTestJobsFromRef({ baseRef");
  assert.ok(resolution > 0, "the engine resolves the trusted CI job config");
  assert.ok(
    engine.indexOf("resolveRepositoryConfig(contract, raw") < resolution,
    "trusted CI jobs resolve beside repository config, after the base ref is known",
  );
  const baseOptions = engine.indexOf("trustedCiJobs: { jobs: ciTestJobs.jobs");
  assert.ok(baseOptions > resolution, "completenessBaseOptions consumes the resolved jobs and fence");
  const obligationsCall = engine.indexOf("{ jobs: ciTestJobs.jobs", baseOptions + 1);
  assert.ok(obligationsCall > baseOptions, "resolveReviewObligations consumes the resolved jobs and fence");
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
