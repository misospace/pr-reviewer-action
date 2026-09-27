import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCallers } from "../src/context/syntax/callers.js";

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "syntax-callers-test-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

test("findCallers finds call-shaped sites and ignores a plain import/mention", () => {
  const root = fixtureRepo({
    "a.py": "def get_jwt():\n    return 1\n",
    "b.py": "from a import get_jwt\n\ndef caller():\n    return get_jwt()\n",
    "c.py": "# unrelated helper, different identifier\nx = get_jwt_v2()\n",
  });
  const { hits, truncated } = findCallers("get_jwt", root, {});
  assert.equal(truncated, false);
  const paths = [...new Set(hits.map((h) => h.path))].sort();
  // "a.py" matches its own `def get_jwt():` line (call-shaped, `name(`) —
  // a def line is not filtered out by findCallers itself; callers that
  // care about "not my own declaration" filter that at the orchestrator
  // layer (see buildSyntaxContext, which knows the declaration's range).
  assert.deepEqual(paths, ["a.py", "b.py"]);
  // "from a import get_jwt" is not call-shaped and must not match.
  assert.equal(hits.filter((h) => h.path === "b.py").length, 1, "only the real call site matches, not the bare import");
  const callSite = hits.find((h) => h.path === "b.py" && h.line === 4);
  assert.ok(callSite);
});

test("findCallers excludes the changed file itself when asked", () => {
  const root = fixtureRepo({
    "a.py": "def get_jwt():\n    return get_jwt()\n",
    "b.py": "y = get_jwt()\n",
  });
  const { hits } = findCallers("get_jwt", root, { excludePaths: new Set(["a.py"]) });
  assert.deepEqual(hits.map((h) => h.path), ["b.py"]);
});

test("findCallers skips vendor/generated directories and non-text extensions", () => {
  const root = fixtureRepo({
    "node_modules/pkg/index.js": "get_jwt();\n",
    "dist/index.js": "get_jwt();\n",
    ".git/hooks/pre-commit": "get_jwt\n",
    "data.bin": "get_jwt\n",
    "real.py": "get_jwt()\n",
  });
  const { hits } = findCallers("get_jwt", root, {});
  assert.deepEqual(hits.map((h) => h.path), ["real.py"]);
});

test("findCallers respects maxMatches and reports truncation", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`f${i}.py`] = "call_target()\n";
  const root = fixtureRepo(files);
  const { hits, truncated } = findCallers("call_target", root, { maxMatches: 3 });
  assert.equal(hits.length, 3);
  assert.equal(truncated, true);
});
