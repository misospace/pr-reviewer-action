import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRelatedContext,
  relatedContextToArtifact,
  renderRelatedContextJson,
  renderRelatedContextMarkdown,
} from "../src/context/index.js";

function gitRepo(repoFiles: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "related-test-"));
  for (const [file, content] of Object.entries(repoFiles)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}

test("high-confidence symbols are searched; hits exclude changed paths and are redacted", async () => {
  const workspace = gitRepo({
    "src/app.py": "from src.other import run_pipeline\nrun_pipeline(1)\n",
    "src/other.py": "def run_pipeline(items):\n    return run_pipeline(items)\n",
    "tests/test_app.py": "run_pipeline('ghp_0123456789abcdefghij0123456789abcd')\n",
    "pyproject.toml": "[project]\n",
    "src/pyproject.toml": "[project]\n",
  });
  const related = await buildRelatedContext(
    {
      files: [
        { path: "src/app.py", symbols: [
          { name: "run_pipeline", confidence: "high" },
          { name: "noisy", confidence: "low" },
        ] },
        { path: "src/gone.py", deleted: true, symbols: [{ name: "run_pipeline", confidence: "high" }] },
      ],
    },
    workspace,
    [{ filename: "src/app.py", status: "modified" }],
  );
  assert.equal(related.version, 1);
  assert.deepEqual(related.files.map((f) => f.path), ["src/app.py"]);
  const file = related.files[0] as { symbols: Array<{ name: string; references: Array<{ path: string; snippet: string }> }> };
  assert.deepEqual(file.symbols.map((s) => s.name), ["run_pipeline"]);
  const refs = file.symbols[0]?.references ?? [];
  // src/app.py itself is a changed path; untouched files hit, both lines of
  // src/other.py carry the symbol.
  assert.deepEqual(refs.map((r) => r.path), ["src/other.py", "src/other.py", "tests/test_app.py"]);
  // The secret inside a hit line is redacted in the stored snippet.
  assert.ok((refs[2]?.snippet ?? "").includes("[REDACTED]"));
  assert.ok(!((refs[2]?.snippet ?? "").includes("ghp_")));
  assert.equal(related.truncated, false);
  // Tests: scored stem match (test_app.py ↔ app) plus same-parent sibling.
  assert.deepEqual((related.files[0] as { tests: string[] }).tests, ["tests/test_app.py"]);
  // Manifests: nearest first (inside src/ before the root).
  assert.deepEqual((related.files[0] as { manifests: string[] }).manifests, ["src/pyproject.toml", "pyproject.toml"]);
});

test("invalid anchor artifacts degrade to the explicit invalid_input error", async () => {
  const workspace = gitRepo({ "a.py": "x = 1\n" });
  const related = await buildRelatedContext("not-an-object", workspace, []);
  assert.deepEqual(related.errors, ["change-anchor artifact is not a JSON object"]);
  assert.equal(related.truncated, true);
  assert.deepEqual(related.truncation.reasons, ["invalid_input"]);
});

test("git failures land in artifact errors with the git_error reason", async () => {
  const bare = mkdtempSync(join(tmpdir(), "related-nogit-"));
  const related = await buildRelatedContext({ files: [{ path: "a.py", symbols: [{ name: "x", confidence: "high" }] }] }, bare, []);
  assert.equal(related.errors.length, 1);
  assert.ok((related.errors[0] as string).startsWith("git ls-files exited"));
  assert.deepEqual(related.truncation.reasons, ["git_error"]);
  assert.equal(related.truncated, true);
});

test("artifact serializer emits the v2 snake_case schema in v2 key order", async () => {
  const workspace = gitRepo({ "a.py": "x = 1\n" });
  const related = await buildRelatedContext({ files: [{ path: "a.py", symbols: [] }] }, workspace, []);
  const artifact = relatedContextToArtifact(related);
  assert.deepEqual(Object.keys(artifact), ["version", "files", "truncated", "errors", "truncation"]);
  assert.deepEqual(
    Object.keys(artifact.truncation as Record<string, unknown>),
    ["truncated", "reasons", "omitted_symbols", "omitted_references", "omitted_tests", "omitted_manifests", "omitted_output_bytes"],
  );
  const document = renderRelatedContextJson(artifact);
  assert.ok(document.startsWith('{\n  "version": 1,'));
  assert.ok(document.endsWith("\n"));
  // Markdown bounds section appears only when truncated.
  assert.ok(!renderRelatedContextMarkdown(artifact).includes("## Bounds"));
  const truncated = relatedContextToArtifact({ ...related, truncated: true, truncation: { ...related.truncation, truncated: true } });
  assert.ok(renderRelatedContextMarkdown(truncated).includes("## Bounds"));
});
