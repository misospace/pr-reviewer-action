#!/usr/bin/env node
// Regenerate action.yml from contracts/action-v3.yml (the canonical v3
// contract). `--check` exits 1 when action.yml is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = parse(readFileSync(join(root, "contracts", "action-v3.yml"), "utf8"));

const inputs = {};
for (const input of contract.inputs) {
  const entry = { description: input.description, required: Boolean(input.required) };
  if (input.default !== undefined) entry.default = String(input.default);
  inputs[input.id] = entry;
}
const outputs = {};
for (const output of contract.outputs) outputs[output.id] = { description: output.description };

const action = {
  name: "Miso PR Review",
  description: "Review pull requests with OpenAI- or Anthropic-compatible models and post an optional sticky comment.",
  inputs,
  outputs,
  runs: { using: "node24", main: "dist/index.js" },
};

const header = "# Generated from contracts/action-v3.yml by scripts/generate-action-yml.mjs.\n# Edit the contract, then regenerate.\n";
const text = header + stringify(action, { lineWidth: 0 });
const target = join(root, "action.yml");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) {
    console.error("action.yml is out of date; run: node scripts/generate-action-yml.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
}
