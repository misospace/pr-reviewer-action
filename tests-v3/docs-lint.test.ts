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

test("README.md and docs/*.md use kebab-case contract ids, not v2 snake_case, in copy-paste key:/key= form", () => {
  const v2ToKebab = loadV2Map();
  const codeTokenRe = /`([a-zA-Z0-9_.\-]+)\s*[:=][^`]*`/g;
  const violations: string[] = [];

  for (const file of docFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      let match: RegExpExecArray | null;
      codeTokenRe.lastIndex = 0;
      while ((match = codeTokenRe.exec(line))) {
        const token = match[1]!;
        const kebab = v2ToKebab.get(token);
        if (kebab) {
          violations.push(`${file}:${idx + 1}: \`${token}\` should be \`${kebab}\``);
        }
      }
    });
  }

  assert.deepEqual(violations, [], `found v2 snake_case input/output ids in docs:\n${violations.join("\n")}`);
});
