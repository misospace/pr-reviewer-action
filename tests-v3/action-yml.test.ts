import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

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
