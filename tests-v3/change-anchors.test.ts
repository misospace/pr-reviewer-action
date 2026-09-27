import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  changeAnchorsCli,
  extractChangeAnchors,
  readChangeAnchorHeadLines,
  renderChangeAnchorsJson,
} from "../src/context/index.js";
import { pyLen, pyRe } from "../src/context/change-anchors.js";

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "change-anchors-test-"));
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const BODY_EDIT = [
  "diff --git a/src/app.py b/src/app.py",
  "--- a/src/app.py",
  "+++ b/src/app.py",
  "@@ -1,2 +1,3 @@",
  " def handle(event):",
  "+    event = dict(event)",
  "     return event",
  "",
].join("\n");

test("added declarations produce symbols and anchors without a workspace", () => {
  const diff = "diff --git a/src/a.py b/src/a.py\n@@ -0,0 +1,2 @@\n+def build_report():\n+import json\n";
  const artifact = extractChangeAnchors(diff, null, { sourceRoot: null });
  assert.deepEqual(artifact.files[0]?.symbols, [{ name: "build_report", kind: "function", confidence: "high", line: 1 }]);
  assert.deepEqual(artifact.files[0]?.imports, ["json"]);
  assert.equal(artifact.files[0]?.changed_lines, undefined);
  assert.deepEqual(artifact.anchors.map((anchor) => anchor.kind), ["file", "symbol", "import"]);
});

test("a body-only edit resolves its enclosing declaration from the head checkout", () => {
  const root = workspace({ "src/app.py": "def handle(event):\n    event = dict(event)\n    return event\n" });
  const file = extractChangeAnchors(BODY_EDIT, null, { sourceRoot: root }).files[0];
  assert.deepEqual(file?.symbols, [{ name: "handle", kind: "enclosing", confidence: "high", line: 1 }]);
  assert.deepEqual(file?.changed_lines, [[2, 2]]);
});

test("a head file that does not match the diff contributes nothing head-derived", () => {
  const root = workspace({ "src/app.py": "def handle(event):\n    return None\n" });
  const file = extractChangeAnchors(BODY_EDIT, null, { sourceRoot: root }).files[0];
  assert.deepEqual(file?.symbols, []);
  assert.equal(file?.changed_lines, undefined);
});

test("head reads refuse symlinks, traversal and .git components", () => {
  const root = workspace({ "real.py": "x\n", ".git/config.py": "x\n" });
  symlinkSync("real.py", join(root, "link.py"));
  assert.deepEqual(readChangeAnchorHeadLines(root, "real.py"), ["x", ""]);
  assert.equal(readChangeAnchorHeadLines(root, "link.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, "../real.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, ".git/config.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, "/etc/hosts"), null);
});

test("lengths and regexes follow Python semantics", () => {
  assert.equal(pyLen("a\u{1F600}b"), 3);
  assert.equal(pyRe(String.raw`^[^"]{1,2}$`).test("\u{1F600}\u{1F600}"), true);
  assert.equal(pyRe(String.raw`^\s+x`).test("\x1fx"), true);
  assert.equal(pyRe(String.raw`^\s+x`).test("﻿x"), false);
  assert.equal(pyRe(String.raw`go$`).test("a.go\n"), true);
});

test("the persisted document is json.dumps(indent=2) with ensure_ascii escapes", () => {
  const diff = "diff --git a/src/café.py b/src/café.py\n@@ -0,0 +1 @@\n+def x_y():\n";
  const text = renderChangeAnchorsJson(extractChangeAnchors(diff, null, { sourceRoot: null }));
  assert.ok(text.startsWith('{\n  "version": 1,\n  "files": [\n    {\n      "path": "src/caf\\u00e9.py",'));
  assert.ok(text.endsWith('  "truncated": false\n}\n'));
});

test("the CLI refuses an output that escapes the workspace root", () => {
  const root = workspace({ "pr.diff": BODY_EDIT });
  const previous = process.cwd();
  process.chdir(root);
  try {
    const refused = changeAnchorsCli(["--output", "../it's.json", "--workspace-root", root], {});
    assert.equal(refused.exitCode, 1);
    assert.ok(refused.stderr.startsWith(`Refusing to write "../it's.json": escapes workspace root '`));
    const written = changeAnchorsCli(["--out=nested/anchors.json", "--work", root], {});
    assert.equal(written.exitCode, 0);
    assert.ok(existsSync(join(root, "nested", "anchors.json")));
    assert.match(readFileSync(join(root, "nested", "anchors.json"), "utf8"), /"path": "src\/app.py"/);
  } finally {
    process.chdir(previous);
  }
});
