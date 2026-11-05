import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface JobStep {
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  jobs?: Record<string, { steps: JobStep[] }>;
  /** Spindle workflows (Tangled CI) carry a top-level `when:` and `steps:`
   * instead of GitHub Actions `jobs:`. See examples/tangled-workflow.yml. */
  when?: unknown;
  steps?: { command?: string }[];
  environment?: Record<string, unknown>;
}

function spindleInvokesNodeRunner(workflow: Workflow): boolean {
  // Shell comments inside a step command must not satisfy the guard, and
  // the match must stay inside a single command (no crossing `;`, `|`, or
  // `&&`), so `echo dist/index.js tangled` or a commented-out runner fails.
  const commandLines = (workflow.steps ?? [])
    .flatMap((step) => (step.command ?? "").split("\n"))
    .filter((line) => !line.trimStart().startsWith("#"));
  return commandLines.some((line) => /\bnode\b[^|;&]*\bdist\/index\.js\b[^|;&]*\btangled\b/.test(line));
}

function loadContractInputIds(): Set<string> {
  const contract = parse(readFileSync("contracts/action-v3.yml", "utf8")) as {
    inputs: { id: string }[];
  };
  return new Set(contract.inputs.map((input) => input.id));
}

const examplesDir = "examples";
const exampleFiles = readdirSync(examplesDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

test("examples/*.yml pin @v3 (Actions) or the host-neutral Node entry (Spindle) and use current inputs", () => {
  assert.ok(exampleFiles.length > 0, "expected at least one example workflow file");
  const contractInputIds = loadContractInputIds();

  for (const file of exampleFiles) {
    const workflow = parse(readFileSync(join(examplesDir, file), "utf8")) as Workflow;

    if (workflow.jobs === undefined) {
      // Spindle shape: the Tangled example must invoke the host-neutral
      // Node runner (#590), never `action.yml` or a GitHub Action step.
      assert.ok(Array.isArray(workflow.when), `${file}: neither GitHub Actions jobs nor a Spindle when:`);
      const commands = (workflow.steps ?? []).map((step) => step.command ?? "").join("\n");
      assert.ok(spindleInvokesNodeRunner(workflow),
        `${file}: Spindle example must run the host-neutral "node dist/index.js tangled" entrypoint`);
      assert.doesNotMatch(commands, /action\.yml/, `${file}: Spindle example must not invoke action.yml`);
      continue;
    }

    let sawActionStep = false;

    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses?.startsWith("misospace/pr-reviewer-action@")) continue;
        sawActionStep = true;

        const [, ref] = step.uses.split("@");
        assert.equal(ref, "v3", `${file}: expected misospace/pr-reviewer-action@v3, got @${ref}`);

        for (const key of Object.keys(step.with ?? {})) {
          assert.ok(
            contractInputIds.has(key),
            `${file}: with key "${key}" is not a current contract input id`,
          );
        }
      }
    }

    assert.ok(sawActionStep, `${file}: expected a misospace/pr-reviewer-action step`);
  }
});

test("the Spindle Node-runner guard rejects look-alike commands", () => {
  const spindle = (command: string): Workflow => ({ when: [], steps: [{ command }] });

  assert.equal(spindleInvokesNodeRunner(spindle('node "$HOME/pr-reviewer/dist/index.js" tangled')), true,
    "the shipped example form must pass");
  assert.equal(spindleInvokesNodeRunner(spindle("echo dist/index.js tangled")), false,
    "a non-Node command must not satisfy the guard");
  assert.equal(spindleInvokesNodeRunner(spindle("echo node dist/index.js tangled")), false,
    "mentioning node as echo data must not satisfy the guard");
  assert.equal(spindleInvokesNodeRunner(spindle("# node dist/index.js tangled")), false,
    "a commented-out invocation must not satisfy the guard");
  assert.equal(spindleInvokesNodeRunner(spindle("node dist/index.js github")), false,
    "invoking another platform subcommand must not satisfy the guard");
  assert.equal(spindleInvokesNodeRunner(spindle("node -e 'console.log(1)' && echo dist/index.js tangled")), false,
    "an unrelated node command chained to an echo must not satisfy the guard");
});

test("the Spindle example keeps private values out of the file and skips before privileged work when they are unavailable", () => {
  const workflow = parse(readFileSync(join(examplesDir, "tangled-workflow.yml"), "utf8")) as Workflow;
  const environment = workflow.environment ?? {};
  for (const key of ["INPUT_AI-API-KEY", "ATPROTO_HANDLE", "ATPROTO_APP_PASSWORD"]) {
    assert.equal(key in environment, false, `${key} must come from Spindle private configuration, not the workflow file`);
  }

  const commands = (workflow.steps ?? []).map((step) => step.command ?? "").join("\n");
  const guard = commands.indexOf("printenv INPUT_AI-API-KEY");
  const appPasswordGuard = commands.indexOf("printenv ATPROTO_APP_PASSWORD");
  const clone = commands.indexOf("git clone");
  const reviewer = commands.search(/^\s*node\b.*dist\/index\.js.*\btangled\b/m);

  assert.ok(guard >= 0 && appPasswordGuard >= 0, "the fork/private-config guard checks the model key and bot password");
  assert.ok(clone > guard && clone > appPasswordGuard, "private-config refusal happens before cloning the reviewer");
  assert.ok(reviewer > clone, "the reviewer runs only after the private-config guard");
});

