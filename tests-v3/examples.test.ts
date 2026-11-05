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
      assert.match(commands, /dist\/index\.js[^\n]*\btangled\b/,
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
