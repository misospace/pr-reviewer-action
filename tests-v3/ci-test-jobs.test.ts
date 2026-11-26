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
  MAX_CI_WORKFLOW_FILES,
  MAX_CI_WORKFLOW_FILE_BYTES,
  MAX_CI_WORKFLOW_SURFACE_BYTES,
  parseCiTestJobsText,
  readCiTestJobsFromRef,
  resolveCiTestJobsFromRef,
} from "../src/config/ci-test-jobs.js";
import { RepositoryConfigError } from "../src/config/repository-config.js";

const PATH = CI_TEST_JOBS_CANDIDATE_PATHS[0];
const BASE = "test-jobs:\n  validate-typescript: full-suite\n";

function parsed(text: string): { jobs: ReadonlyMap<string, string>; warnings: readonly string[]; declaredCount: number } {
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
  assert.equal(result.declaredCount, 7);
  assert.ok(result.warnings.length >= 5);
  assert.equal("malformed" in parseCiTestJobsText("test-jobs: []\n", PATH), true);
  assert.equal("malformed" in parseCiTestJobsText("x".repeat(MAX_CI_TEST_JOBS_FILE_BYTES + 1), PATH), true);
  assert.deepEqual(parsed("").jobs.size, 0);
  assert.equal(parsed("").warnings.length, 0);
  assert.equal(parsed("test-jobs:\n").declaredCount, 0);
  assert.equal(parsed("test-jobs:\n  valid: unit\n").declaredCount, 1);
  assert.equal(parsed("test-jobs:\n  valid: unit\n  invalid: nope\n").declaredCount, 2);
});

test("#1820 caps identities and rejects malformed yaml or root values", () => {
  const rows = Array.from({ length: MAX_CI_TEST_JOB_IDENTITIES + 3 }, (_, index) => `  job-${index}: unit`).join("\n");
  const capped = parsed(`test-jobs:\n${rows}\n`);
  assert.equal(capped.jobs.size, MAX_CI_TEST_JOB_IDENTITIES);
  assert.equal(capped.declaredCount, MAX_CI_TEST_JOB_IDENTITIES + 3);
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

  const dynamicDisplay = resolverFixture({ "dynamic.yml": "jobs:\n  validate-typescript:\n    name: 'Test (\${{ matrix.os }})'\n    runs-on: ubuntu-latest\n" });
  const dynamicResult = resolveCiTestJobsFromRef({ baseRef: dynamicDisplay.base, headRef: dynamicDisplay.base, workspace: dynamicDisplay.root });
  assert.equal(dynamicResult.jobs.size, 0);
  assert.ok(dynamicResult.warnings.some((warning) => /PR-author-controlled job display name/.test(warning)));
  assert.equal(ciJobIdentitiesFromRef(dynamicDisplay.base, dynamicDisplay.root).prMintable, true);

  const staticName = resolverFixture({ "static.yml": "jobs:\n  validate-typescript:\n    name: TypeScript Suite\n    runs-on: ubuntu-latest\n" }, ["TypeScript Suite"]);
  assert.equal(resolveCiTestJobsFromRef({ baseRef: staticName.base, headRef: staticName.base, workspace: staticName.root }).jobs.has("TypeScript Suite"), true);
  const hiddenKey = resolverFixture({ "static.yml": "jobs:\n  validate-typescript:\n    name: TypeScript Suite\n    runs-on: ubuntu-latest\n" });
  const hiddenResult = resolveCiTestJobsFromRef({ baseRef: hiddenKey.base, headRef: hiddenKey.base, workspace: hiddenKey.root });
  assert.equal(hiddenResult.jobs.size, 0);
  assert.ok(hiddenResult.warnings.some((warning) => /does not name a static job/.test(warning)));

  const duplicateStaticNames = resolverFixture({
    "one.yml": "jobs:\n  first:\n    name: TypeScript Suite\n    runs-on: ubuntu-latest\n",
    "two.yml": "jobs:\n  second:\n    name: TypeScript Suite\n    runs-on: ubuntu-latest\n",
  }, ["TypeScript Suite"]);
  const duplicateStaticResult = resolveCiTestJobsFromRef({ baseRef: duplicateStaticNames.base, headRef: duplicateStaticNames.base, workspace: duplicateStaticNames.root });
  assert.equal(duplicateStaticResult.jobs.size, 0);
  assert.ok(duplicateStaticResult.warnings.some((warning) => /more than one job/.test(warning)));

  for (const workflows of [
    { "one.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n", "two.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n" },
    { "duplicate.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n  validate-typescript-copy:\n    name: validate-typescript\n    runs-on: ubuntu-latest\n" },
  ]) {
    const duplicate = resolverFixture(workflows);
    const result = resolveCiTestJobsFromRef({ baseRef: duplicate.base, headRef: duplicate.base, workspace: duplicate.root });
    assert.equal(result.jobs.size, 0);
    assert.ok(result.warnings.some((warning) => /more than one job/.test(warning)));
  }

  const matrix = resolverFixture({ "matrix.yml": "jobs:\n  matrix:\n    name: 'Test (\${{ matrix.node }})'\n    strategy:\n      matrix:\n        node: [18, 20]\n    runs-on: ubuntu-latest\n  validate-typescript:\n    runs-on: ubuntu-latest\n" });
  assert.equal(resolveCiTestJobsFromRef({ baseRef: matrix.base, headRef: matrix.base, workspace: matrix.root }).jobs.has("validate-typescript"), true);

  const expressionMatrix = resolverFixture({ "expression-matrix.yml": "jobs:\n  plan:\n    runs-on: ubuntu-latest\n  dynamic:\n    name: \${{ matrix.label }}\n    strategy:\n      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}\n    runs-on: ubuntu-latest\n" });
  assert.equal(ciJobIdentitiesFromRef(expressionMatrix.base, expressionMatrix.root).prMintable, true);
  const expressionMatrixResult = resolveCiTestJobsFromRef({ baseRef: expressionMatrix.base, headRef: expressionMatrix.base, workspace: expressionMatrix.root });
  assert.equal(expressionMatrixResult.jobs.size, 0);
  assert.ok(expressionMatrixResult.warnings.some((warning) => /PR-author-controlled job display name/.test(warning)));

  const expressionValueMatrix = resolverFixture({ "expression-value-matrix.yml": "jobs:\n  dynamic:\n    name: \${{ matrix.label }}\n    strategy:\n      matrix:\n        label: [\"\${{ env.X }}\"]\n    runs-on: ubuntu-latest\n" });
  assert.equal(ciJobIdentitiesFromRef(expressionValueMatrix.base, expressionValueMatrix.root).prMintable, true);

  const reusableMatrix = resolverFixture({ "reusable-matrix.yml": "jobs:\n  dynamic:\n    name: \${{ matrix.label }}\n    uses: owner/repo/.github/workflows/x.yml@main\n    strategy:\n      matrix:\n        label: [one, two]\n" });
  assert.equal(ciJobIdentitiesFromRef(reusableMatrix.base, reusableMatrix.root).prMintable, true);

  const literalMatrixDynamic = resolverFixture({ "literal-matrix-dynamic.yml": "jobs:\n  dynamic:\n    name: 'Test (\${{ matrix.node }})'\n    strategy:\n      matrix:\n        node: [18, 20]\n    runs-on: ubuntu-latest\n" });
  const literalMatrixIdentities = ciJobIdentitiesFromRef(literalMatrixDynamic.base, literalMatrixDynamic.root);
  assert.equal(literalMatrixIdentities.prMintable, false);
  assert.equal(literalMatrixIdentities.staticNames.size, 0);

  const unsafeExpressions = [
    "${{ github['event'].pull_request.title }}",
    "${{ format('{0}', github.event.pull_request.title) }}",
    "${{ env.JOB_NAME }}",
    "${{ needs.build.outputs.name }}",
    "${{ steps.meta.outputs.name }}",
    "${{ inputs.job_name }}",
    "${{ github.actor }}",
  ];
  for (const [index, expression] of unsafeExpressions.entries()) {
    const unsafe = resolverFixture({ [`unsafe-${index}.yml`]: `jobs:\n  dynamic:\n    name: ${JSON.stringify(expression)}\n    runs-on: ubuntu-latest\n` });
    const identities = ciJobIdentitiesFromRef(unsafe.base, unsafe.root);
    assert.equal(identities.prMintable, true, expression);
    assert.equal(resolveCiTestJobsFromRef({ baseRef: unsafe.base, headRef: unsafe.base, workspace: unsafe.root }).jobs.size, 0);
  }
  const varsName = resolverFixture({ "vars-name.yml": "jobs:\n  dynamic:\n    name: '\${{ vars.CI_NAME }}'\n    runs-on: ubuntu-latest\n" });
  const varsIdentity = ciJobIdentitiesFromRef(varsName.base, varsName.root);
  assert.equal(varsIdentity.prMintable, false);
  assert.equal(varsIdentity.staticNames.size, 0);

  const strategyFlags = resolverFixture({ "strategy-flags.yml": "jobs:\n  dynamic:\n    name: 'Test (\${{ matrix.os }})'\n    strategy:\n      fail-fast: \${{ inputs.f }}\n      max-parallel: \${{ inputs.p }}\n      matrix:\n        os: [ubuntu, windows]\n    runs-on: ubuntu-latest\n" });
  assert.equal(ciJobIdentitiesFromRef(strategyFlags.base, strategyFlags.root).prMintable, false);

  for (const name of ["${{ format('{0}', matrix.os) }}", "Static suite"]) {
    const safe = resolverFixture({ "safe.yml": `jobs:\n  configured:\n    name: ${JSON.stringify(name)}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    runs-on: ubuntu-latest\n` }, [name]);
    assert.equal(ciJobIdentitiesFromRef(safe.base, safe.root).prMintable, false, name);
  }

  const padded = resolverFixture({ "large.yml": `jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n${"# padded workflow data\n".repeat(3_500)}` });
  const paddedBytes = Buffer.byteLength(readFileSync(join(padded.root, ".github/workflows/large.yml")));
  assert.ok(paddedBytes > 65_536 && paddedBytes < MAX_CI_WORKFLOW_FILE_BYTES);
  assert.equal(ciJobIdentitiesFromRef(padded.base, padded.root).staticNames.get("validate-typescript"), 1);
  const oversized = resolverFixture({ "large.yml": `jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n${"# padded workflow data\n".repeat(14_000)}` });
  assert.ok(Buffer.byteLength(readFileSync(join(oversized.root, ".github/workflows/large.yml"))) > MAX_CI_WORKFLOW_FILE_BYTES);
  assert.ok(ciJobIdentitiesFromRef(oversized.base, oversized.root).warning?.includes(`${MAX_CI_WORKFLOW_FILE_BYTES}-byte cap`));

  const skippedNonYaml = resolverFixture({ "test.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n", "README.md": "not a workflow\n" });
  assert.equal(ciJobIdentitiesFromRef(skippedNonYaml.base, skippedNonYaml.root).staticNames.get("validate-typescript"), 1);

  // Extension matching is case-insensitive: the scanner must never be
  // stricter than the platform about which files can define workflows.
  const upperCase = resolverFixture({ "test.YML": "jobs:\n  dynamic:\n    name: ${{ github.event.pull_request.title }}\n" }, ["validate-typescript"]);
  assert.equal(ciJobIdentitiesFromRef(upperCase.base, upperCase.root).prMintable, true);
  assert.equal(resolveCiTestJobsFromRef({ baseRef: upperCase.base, headRef: upperCase.base, workspace: upperCase.root }).jobs.size, 0);

  // Case-variant context spelling is still PR-controlled.
  const mixedCase = resolverFixture({ "mixed.yml": "jobs:\n  dynamic:\n    name: ${{ GitHub.EVENT.pull_request.title }}\n" }, ["validate-typescript"]);
  assert.equal(ciJobIdentitiesFromRef(mixedCase.base, mixedCase.root).prMintable, true);

  // GitHub's workflow parser rejects YAML anchors and merge keys; a merge-key
  // job's shape is unknowable here, so the file fails closed. An empty or
  // whitespace `name:` falls back to the job key, like the platform does.
  const mergeKey = resolverFixture({ "merge.yml": "defaults: &d\n  runs-on: ubuntu-latest\njobs:\n  validate-typescript:\n    <<: *d\n" }, ["validate-typescript"]);
  assert.ok(/merge key/.test(ciJobIdentitiesFromRef(mergeKey.base, mergeKey.root).warning ?? ""));
  const emptyName = resolverFixture({ "empty.yml": "jobs:\n  validate-typescript:\n    name: \"\"\n    runs-on: ubuntu-latest\n" });
  assert.equal(ciJobIdentitiesFromRef(emptyName.base, emptyName.root).staticNames.get("validate-typescript"), 1);
  assert.equal(MAX_CI_WORKFLOW_FILES, 32);
  assert.equal(MAX_CI_WORKFLOW_SURFACE_BYTES, 1_048_576);
  const aggregateWorkflows = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `large-${index}.yml`, `jobs:\n  job-${index}:\n    runs-on: ubuntu-latest\n${"# padded workflow data\n".repeat(11_000)}`,
  ]));
  const aggregate = resolverFixture(aggregateWorkflows);
  const aggregateBytes = Object.values(aggregateWorkflows).reduce((total, text) => total + Buffer.byteLength(text), 0);
  assert.ok(aggregateBytes > MAX_CI_WORKFLOW_SURFACE_BYTES);
  const aggregateResult = ciJobIdentitiesFromRef(aggregate.base, aggregate.root);
  assert.ok(aggregateResult.warning?.includes(`${MAX_CI_WORKFLOW_SURFACE_BYTES}-byte cap`), aggregateResult.warning ?? "no warning");

  const timeoutOption = resolverFixture({ "test.yml": "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n" });
  assert.equal(ciJobIdentitiesFromRef(timeoutOption.base, timeoutOption.root, { gitTimeoutSec: 1 }).staticNames.get("validate-typescript"), 1);

  const malformedYaml = resolverFixture({ "README.md": "ignored", "bad.yml": "jobs: [\n" });
  const malformedResult = ciJobIdentitiesFromRef(malformedYaml.base, malformedYaml.root);
  assert.equal(malformedResult.staticNames.size, 0);
  assert.ok(malformedResult.warning?.includes("bad.yml"));

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

test("#1820 refused config entries keep the surface fence armed only when workflows changed", () => {
  for (const [configText, label] of [["test-jobs: [", "malformed"], ["test-jobs:\n  validate-typescript: mystery\n", "dropped"]] as const) {
    const root = initRepo();
    writeFileSync(join(root, "README"), "seed");
    writeConfig(root, PATH, configText);
    writeConfig(root, ".github/workflows/test.yml", "jobs:\n  validate-typescript:\n    runs-on: ubuntu-latest\n");
    const base = commit(root, `${label} config`);
    writeConfig(root, ".github/workflows/changed.yml", "name: changed\\n");
    const changedHead = commit(root, "changed workflow");
    const resolved = resolveCiTestJobsFromRef({ baseRef: base, headRef: changedHead, workspace: root });
    assert.equal(resolved.identitiesRefused, true);
    assert.equal(resolved.workflowSurfaceTrusted, false);
  }

  const empty = resolverFixture({}, []);
  writeConfig(empty.root, PATH, "test-jobs:\n");
  const emptyHead = commit(empty.root, "empty config");
  const emptyResult = resolveCiTestJobsFromRef({ baseRef: emptyHead, headRef: emptyHead, workspace: empty.root });
  assert.equal(emptyResult.identitiesRefused, false);

  const unreadable = resolveCiTestJobsFromRef({ baseRef: "missing-ref", headRef: "missing-ref", workspace: tmpdir() });
  assert.equal(unreadable.identitiesRefused, true);
  assert.equal(unreadable.workflowSurfaceTrusted, false);
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

  const refused = resolverFixture({ "matrix.yml": "jobs:\n  dynamic:\n    name: 'Test (\${{ matrix.label }})'\n    strategy:\n      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}\n" });
  writeConfig(refused.root, ".github/workflows/pr-added.yml", "name: pr-added\n");
  const refusedHead = commit(refused.root, "add PR workflow");
  const refusedChanged = resolveCiTestJobsFromRef({ baseRef: refused.base, headRef: refusedHead, workspace: refused.root });
  assert.equal(refusedChanged.jobs.size, 0);
  assert.equal(refusedChanged.identitiesRefused, true);
  assert.equal(refusedChanged.workflowSurfaceTrusted, false);
  assert.equal(refusedChanged.warnings.some((warning) => /PR-author-controlled/.test(warning)), true);
  assert.equal(refusedChanged.warnings.some((warning) => /could not be verified/.test(warning)), false);

  const refusedUnchanged = resolveCiTestJobsFromRef({ baseRef: refused.base, headRef: refused.base, workspace: refused.root });
  assert.equal(refusedUnchanged.identitiesRefused, true);
  assert.equal(refusedUnchanged.workflowSurfaceTrusted, true);
  const refusedMissingHead = resolveCiTestJobsFromRef({ baseRef: refused.base, workspace: refused.root });
  assert.equal(refusedMissingHead.identitiesRefused, true);
  assert.equal(refusedMissingHead.workflowSurfaceTrusted, false);

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
