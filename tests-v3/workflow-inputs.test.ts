import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_WORKFLOW_FILES,
  readWorkflowInputNamesByFile,
  resolveActionSlug,
} from "../src/enforcement/workflow-inputs.js";

const SLUG = "misospace/pr-reviewer-action";

/** A throwaway git repository the reader can pin a revision in. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: dir });
  return dir;
}

function writeFile(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** Commit everything and return the resulting revision. */
function commit(dir: string, message = "fixture"): string {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();
}

/** A workflow that invokes the action under review with the given inputs. */
function workflow(uses: string, withBlock: readonly string[]): string {
  return [
    "name: AI PR Review",
    "on: pull_request",
    "jobs:",
    "  ai-review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          fetch-depth: 0",
    `      - uses: ${uses}`,
    "        with:",
    ...withBlock.map((line) => `          ${line}`),
    "",
  ].join("\n");
}

/** The names one map entry holds, sorted. */
function namesOf(byFile: ReadonlyMap<string, ReadonlySet<string>>, path: string): string[] {
  const names = byFile.get(path);
  assert.ok(names !== undefined, `no entry for ${path}`);
  return [...names].sort();
}

test("the reader collects the `with:` keys of the step that invokes the action", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/review.yaml", workflow(`${SLUG}@v3.7.0`, [
    "ai-api-key: ${{ secrets.AI_KEY }}",
    "ai-model: review-model",
  ]));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "a workflow invoking the action is a witness");
  // The witness is PER FILE: one entry for the file that invokes the
  // action, and nothing else.
  assert.deepEqual([...result.keys()], [".github/workflows/review.yaml"]);
  // The checkout step's own input is NOT part of the mapping: only the
  // step that invokes the action under review contributes.
  assert.deepEqual(namesOf(result, ".github/workflows/review.yaml"), ["ai-api-key", "ai-model"]);
});

test("the reader matches owner/repo@ref and owner/repo, case-insensitively", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/pinned.yaml", workflow(`${SLUG}@5b1839535748f3afd1bd3ef04e8009302cba9aa6`, [
    "ai-api-key: k",
  ]));
  writeFile(dir, ".github/workflows/unpinned.yaml", workflow("MISOSPACE/PR-Reviewer-Action", [
    "ai-model: m",
  ]));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "both the pinned and the unpinned spelling match");
  // Two files, two entries: the witness never merges files.
  assert.deepEqual([...result.keys()].sort(), [
    ".github/workflows/pinned.yaml",
    ".github/workflows/unpinned.yaml",
  ]);
  assert.deepEqual(namesOf(result, ".github/workflows/pinned.yaml"), ["ai-api-key"]);
  assert.deepEqual(namesOf(result, ".github/workflows/unpinned.yaml"), ["ai-model"]);
});

test("no workflow step invokes the action is no witness", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/other.yaml", workflow("actions/checkout@v4", ["fetch-depth: 0"]));
  const head = commit(dir);

  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG }), null);
});

test("a file that invokes the action without any input is an entry with no names", async (t) => {
  // The file itself proves that the action is invoked there WITHOUT any
  // input: that is a fact about the file, so the entry exists and is
  // empty. The boundary may refute "the workflow passes `x`" against it.
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/bare.yaml", [
    "name: AI PR Review",
    "on: pull_request",
    "jobs:",
    "  ai-review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${SLUG}@v3.7.0`,
    "",
  ].join("\n"));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the invoking file is an entry");
  assert.deepEqual([...result.keys()], [".github/workflows/bare.yaml"]);
  assert.deepEqual(namesOf(result, ".github/workflows/bare.yaml"), []);
});

test("a file that does not invoke the action contributes no entry", async (t) => {
  // A workflow file that never invokes the action says nothing about the
  // workflow-to-action mapping: no entry, so the boundary decides nothing
  // about a finding filed against it.
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/other.yaml", workflow("actions/checkout@v4", ["fetch-depth: 0"]));
  writeFile(dir, ".github/workflows/review.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the invoking file is a witness");
  assert.deepEqual([...result.keys()], [".github/workflows/review.yaml"]);
});

test("#1238 adversarial: a workflow that reaches the action through a LOCAL COMPOSITE action has no entry", async (t) => {
  // The reviewed repository hides the invocation in a local composite
  // action: the workflow calls the composite, and the composite calls the
  // action under review with an input name. The workflow file has NO
  // direct action step, so it contributes NO entry — the witness can never
  // say "the workflow passes no such name" about it.
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/actions/review/action.yml", [
    "name: Local review composite",
    "description: Runs the AI reviewer",
    "runs:",
    "  using: composite",
    "  steps:",
    `    - uses: ${SLUG}@v3.7.0`,
    "      with:",
    "        ai-api-key: ${{ secrets.AI_KEY }}",
    "",
  ].join("\n"));
  writeFile(dir, ".github/workflows/ci.yaml", [
    "name: CI",
    "on: pull_request",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: ./.github/actions/review",
    "        with:",
    "          ai-api-key: ${{ secrets.AI_KEY }}",
    "",
  ].join("\n"));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  // No workflow file invokes the action directly, so there is no witness
  // at all — and certainly no entry for the composite-calling workflow.
  assert.equal(result, null);
});

test("no slug or no exact revision is no witness", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/review.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  const head = commit(dir);

  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: null }), null);
  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: undefined }), null);
  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: "" }), null);
  // A revision that is not an exact 40/64-hex SHA is not a revision this
  // reader may pin: "main", a short sha and a branch name are all refused.
  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: "main", actionSlug: SLUG }), null);
  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: head.slice(0, 12), actionSlug: SLUG }), null);
  assert.equal(await readWorkflowInputNamesByFile({ workspace: dir, revision: null, actionSlug: SLUG }), null);
});

test("a revision the workspace does not hold is no witness", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/review.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  commit(dir);

  assert.equal(
    await readWorkflowInputNamesByFile({ workspace: dir, revision: "b".repeat(40), actionSlug: SLUG }),
    null,
  );
});

test("a workflow that does not parse contributes no entry, never a partial view", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/broken.yaml", "jobs:\n  a: [unclosed\n");
  writeFile(dir, ".github/workflows/good.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the parsable workflow still witnesses");
  // The unparsable file contributes NO entry — not an empty one.
  assert.deepEqual([...result.keys()], [".github/workflows/good.yaml"]);
  assert.deepEqual(namesOf(result, ".github/workflows/good.yaml"), ["ai-api-key"]);
});

test("the reader is revision-pinned: a workflow added after the pinned revision is not seen", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/first.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  const pinned = commit(dir, "first");
  writeFile(dir, ".github/workflows/second.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-model: m"]));
  commit(dir, "second");

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: pinned, actionSlug: SLUG });
  assert.ok(result, "the pinned revision is a witness");
  assert.deepEqual([...result.keys()], [".github/workflows/first.yaml"]);
  assert.deepEqual(namesOf(result, ".github/workflows/first.yaml"), ["ai-api-key"]);
});

test("the file-count and byte bounds are enforced", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/a-first.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  writeFile(dir, ".github/workflows/b-second.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-model: m"]));
  const head = commit(dir);

  // The file-count bound keeps the first files in git's (sorted) listing.
  const bounded = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG, maxFiles: 1 });
  assert.ok(bounded, "the first workflow is still read");
  assert.deepEqual([...bounded.keys()], [".github/workflows/a-first.yaml"]);

  // The byte bound skips an oversized workflow instead of reading it: the
  // skipped file contributes NO entry, never a partial view of itself.
  const oversized = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG, maxBytes: 32 });
  assert.equal(oversized, null, "an unreadable workflow is skipped, not fatal");
});

test("#252 adversarial: hostile `with:` content is data, never a step and never a crash", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/hostile.yaml", [
    "name: AI PR Review",
    "on: pull_request",
    "jobs:",
    "  ai-review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${SLUG}@v3.7.0`,
    "        with:",
    "          ai-api-key: ${{ secrets.AI_KEY }}",
    "          injected: |",
    "            - uses: evil/action@v1",
    "              with:",
    "                fake-input: pwned",
    "          tagged: !!js/function \"function(){ return 'x' }\"",
    "",
  ].join("\n"));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the hostile workflow is still read");
  // The injected text is a VALUE: it never becomes a step, so it never
  // contributes an input name, and the tag never becomes code.
  assert.ok(!namesOf(result, ".github/workflows/hostile.yaml").includes("fake-input"), "the injected step never contributes a name");
  assert.ok(namesOf(result, ".github/workflows/hostile.yaml").includes("ai-api-key"), "the real input name is still collected");
});

test("#1238 a `with:` block that inherits its names through a YAML merge key reports the REAL names", async (t) => {
  // The merge key is RESOLVED by the parser, so the entry carries the
  // input names the runner really passes — never the literal `<<`.
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/merged.yaml", [
    "name: AI PR Review",
    "on: pull_request",
    "defaults: &defaults",
    "  ai-api-key: ${{ secrets.AI_KEY }}",
    "  ai-model: review-model",
    "jobs:",
    "  ai-review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${SLUG}@v3.7.0`,
    "        with:",
    "          <<: *defaults",
    "          ai-base-url: ${{ secrets.AI_ENDPOINT }}",
    "",
  ].join("\n"));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the merged workflow is a witness");
  assert.deepEqual(
    namesOf(result, ".github/workflows/merged.yaml"),
    ["ai-api-key", "ai-base-url", "ai-model"],
  );
});

test("#1238 a `with:` block that STILL carries a merge key yields no entry for that file", async (t) => {
  // A `<<` that survives parsing (here a QUOTED key, which YAML 1.1 does
  // not treat as a merge key) means the block's names are only PART of
  // what the runner passes: a partial view of the file. The witness must
  // never carry a partial view, so the file contributes NO entry.
  //
  // The second file pins the neighbouring case: a plain merge key whose
  // source is not a map makes the document unparsable, so that file is
  // skipped too.
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFile(dir, ".github/workflows/partial.yaml", [
    "name: AI PR Review",
    "on: pull_request",
    "jobs:",
    "  ai-review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${SLUG}@v3.7.0`,
    "        with:",
    '          "<<": unresolved',
    "          ai-api-key: k",
    "",
  ].join("\n"));
  writeFile(dir, ".github/workflows/unresolvable.yaml", [
    "name: AI PR Review",
    "on: pull_request",
    "not-a-map: &scalar 5",
    "jobs:",
    "  ai-review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - uses: ${SLUG}@v3.7.0`,
    "        with:",
    "          <<: *scalar",
    "",
  ].join("\n"));
  writeFile(dir, ".github/workflows/good.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the parsable workflow still witnesses");
  // Neither file contributes an entry — not an empty one.
  assert.deepEqual([...result.keys()], [".github/workflows/good.yaml"]);
  assert.deepEqual(namesOf(result, ".github/workflows/good.yaml"), ["ai-api-key"]);
});

test("#252 adversarial: an alias-expansion bomb is skipped, never fatal", async (t) => {
  const dir = initRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bomb = ["a: &a [x,x,x,x,x,x,x,x,x,x]", ...Array.from({ length: 12 }, (_, index) => `b${index}: &b${index} [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]`)];
  writeFile(dir, ".github/workflows/bomb.yaml", `${bomb.join("\n")}\n`);
  writeFile(dir, ".github/workflows/good.yaml", workflow(`${SLUG}@v3.7.0`, ["ai-api-key: k"]));
  const head = commit(dir);

  const result = await readWorkflowInputNamesByFile({ workspace: dir, revision: head, actionSlug: SLUG });
  assert.ok(result, "the bomb is skipped, the rest still witnesses");
  assert.deepEqual([...result.keys()], [".github/workflows/good.yaml"]);
  assert.deepEqual(namesOf(result, ".github/workflows/good.yaml"), ["ai-api-key"]);
});

test("the exported file bound is a real cap", () => {
  assert.ok(MAX_WORKFLOW_FILES > 0, "the workflow-file bound is exported and positive");
});

test("resolveActionSlug reads the runner's action repository", () => {
  assert.equal(resolveActionSlug({}), null);
  assert.equal(resolveActionSlug({ GITHUB_ACTION_REPOSITORY: "   " }), null);
  assert.equal(resolveActionSlug({ GITHUB_ACTION_REPOSITORY: "owner" }), null);
  assert.equal(resolveActionSlug({ GITHUB_ACTION_REPOSITORY: "owner/repo/extra" }), null);
  assert.equal(resolveActionSlug({ GITHUB_ACTION_REPOSITORY: "Owner/Repo" }), "owner/repo");
  assert.equal(resolveActionSlug({ GITHUB_ACTION_REPOSITORY: " misospace/pr-reviewer-action " }), SLUG);
});
