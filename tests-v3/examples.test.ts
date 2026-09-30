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
  jobs: Record<string, { steps: JobStep[] }>;
}

function loadContractInputIds(): Set<string> {
  const contract = parse(readFileSync("contracts/action-v3.yml", "utf8")) as {
    inputs: { id: string }[];
  };
  return new Set(contract.inputs.map((input) => input.id));
}

const examplesDir = "examples";
const exampleFiles = readdirSync(examplesDir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

test("examples/*.yml pin @v3 and use only current kebab-case contract inputs", () => {
  assert.ok(exampleFiles.length > 0, "expected at least one example workflow file");
  const contractInputIds = loadContractInputIds();

  for (const file of exampleFiles) {
    const workflow = parse(readFileSync(join(examplesDir, file), "utf8")) as Workflow;
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
