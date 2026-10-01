import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function loadV2Map(): Map<string, string> {
  const contract = parse(readFileSync("contracts/action-v3.yml", "utf8")) as {
    inputs: { id: string; v2_id?: string }[];
    outputs?: { id: string; v2_id?: string }[];
  };
  const map = new Map<string, string>();
  for (const entry of [...contract.inputs, ...(contract.outputs ?? [])]) {
    if (entry.v2_id && entry.v2_id.includes("_") && entry.v2_id !== entry.id) {
      map.set(entry.v2_id, entry.id);
    }
  }
  return map;
}

// Names that are v2 contract ids but are also legitimately snake_case
// elsewhere in the docs, so a bare word-boundary match cannot tell them
// apart from the contract reference. Keep this list short and justified.
const allowlist = new Map<string, string>([
  // The model's raw structured-output JSON schema key (src/model/conversation.ts,
  // src/model/request.ts) and the persisted ai-output.json artifact field
  // (src/enforcement/artifact.ts) are both literally `review_markdown` —
  // distinct from the action's own `review-markdown` output.
  ["review_markdown", "the model's raw JSON schema / ai-output.json artifact field, not the action output"],
  // Persisted ai-output.json artifact field (src/enforcement/artifact.ts,
  // src/run/review.ts), distinct from the action's own `verdict-source` output.
  ["verdict_source", "the ai-output.json artifact field, not the action output"],
  // The OpenAI/Anthropic provider API's own tool-calling field name, distinct
  // from the action's `tool-calls` output.
  ["tool_calls", "the provider API's own field name, not the action output"],
  // Literal filename the eval harness writes to disk (scripts/eval_harness.py,
  // scripts/sections/review.sh, scripts/artifact_paths.sh), not the action's
  // `analysis-engine` output.
  ["analysis_engine", "the eval harness's analysis_engine.txt filename, not the action output"],
  // The metadata marker's own raw JSON key (src/metadata/markers.ts,
  // src/precheck/decide.ts's carriedVerdict, src/enforcement/verdict-policy.ts's
  // StrictReviewResult) — literally `review_result` inside the marker's JSON
  // blob, distinct from the action's #873 `review-result` output (which
  // carries the same value under the kebab contract name).
  ["review_result", "the metadata marker's raw JSON field, not the action output"],
  // More raw marker JSON keys (src/metadata/markers.ts) that share a v2 id;
  // docs/telemetry.md documents the marker by its literal keys.
  ["required_checks", "the metadata marker's raw JSON field, not the action output"],
  ["review_route", "the metadata marker's raw JSON field, not the action output"],
  ["escalation_reason", "the metadata marker's raw JSON field, not the action output"],
  ["cache_hit_ratio", "the metadata marker's raw JSON field, not the action output"],
]);

const excludedDocs = new Set(["docs/v3-migration.md", "docs/v3-teardown-audit.md"]);

function docFiles(): string[] {
  const files = ["README.md"];
  for (const name of readdirSync("docs")) {
    if (!name.endsWith(".md")) continue;
    const path = join("docs", name);
    if (excludedDocs.has(path)) continue;
    files.push(path);
  }
  return files;
}

test("README.md and docs/*.md use kebab-case contract ids, not v2 snake_case", () => {
  const v2ToKebab = loadV2Map();
  const violations: string[] = [];

  for (const file of docFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      for (const [v2, id] of v2ToKebab) {
        if (allowlist.has(v2)) continue;
        const re = new RegExp(`\\b${v2}\\b`, "g");
        if (re.test(line)) {
          violations.push(`${file}:${idx + 1}: \`${v2}\` should be \`${id}\``);
        }
      }
    });
  }

  assert.deepEqual(violations, [], `found v2 snake_case input/output ids in docs:\n${violations.join("\n")}`);
});
