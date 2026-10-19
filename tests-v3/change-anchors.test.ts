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
import { redactDiffText } from "../src/context/redact.js";

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

// #1154: the persisted diff is credential-redacted at ingestion, so a masked
// added line must still reconcile with the unredacted head checkout —
// otherwise the whole file silently loses `changed_lines`, enclosing symbols,
// keys and counterparts.
test("#1154: a credential-masked added line keeps its head-derived anchors", () => {
  const secret = "hunter2hunter2hunter2";
  const root = workspace({ "src/app.py": `def handle(event):\n    token = "${secret}"\n    return event\n` });
  const raw = [
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -1,2 +1,3 @@",
    " def handle(event):",
    `+    token = "${secret}"`,
    "     return event",
    "",
  ].join("\n");
  const redacted = redactDiffText(raw);
  assert.ok(redacted.includes("[REDACTED]") && !redacted.includes(secret), "the added line really is masked");
  const file = extractChangeAnchors(redacted, null, { sourceRoot: root }).files[0];
  assert.deepEqual(file?.symbols, [{ name: "handle", kind: "enclosing", confidence: "high", line: 1 }]);
  assert.deepEqual(file?.changed_lines, [[2, 2]]);
});

// #1154 (B1 fix): the split-line credential — a bare `password:` key line with
// its value on the indented line below — is masked on BOTH sides of the
// comparison now. This is the regression the anchor seam must not reintroduce:
// if the two sides were normalized by different rule sets, this file would
// silently lose `changed_lines` and its enclosing symbol.
test("#1154: a SPLIT-line masked pair keeps its head-derived anchors", () => {
  const secret = "hunter2hunter2hunter2";
  // The changed run sits inside the declaration, so the enclosing-symbol
  // enrichment (which walks up for a less-indented declaration) is on the
  // seam under test rather than skipped for a top-level line.
  const head = `def handle(event):\n    password:\n      ${secret}\n    return event\n`;
  const root = workspace({ "src/app.py": head });
  const raw = [
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -1,2 +1,4 @@",
    " def handle(event):",
    "+    password:",
    `+      ${secret}`,
    "     return event",
    "",
  ].join("\n");
  const redacted = redactDiffText(raw);
  assert.ok(redacted.includes("+    password:\n+      [REDACTED]") && !redacted.includes(secret), "the split pair really is masked");
  assert.equal(redacted.split("\n").length, raw.split("\n").length, "the mask costs no line");
  // Raw and redacted inputs agree: entry normalization is idempotent.
  assert.deepEqual(
    extractChangeAnchors(raw, null, { sourceRoot: root }).files[0],
    extractChangeAnchors(redacted, null, { sourceRoot: root }).files[0],
  );
  const file = extractChangeAnchors(redacted, null, { sourceRoot: root }).files[0];
  assert.deepEqual(file?.changed_lines, [[2, 3]]);
  assert.deepEqual(file?.symbols, [{ name: "handle", kind: "enclosing", confidence: "high", line: 1 }]);
  // The artifact itself never carries the raw value.
  assert.ok(!renderChangeAnchorsJson(extractChangeAnchors(redacted, null, { sourceRoot: root })).includes(secret));
});

test("#1154: normalization forgives only the masked span — split-line path included", () => {
  const head = (value: string): string => `def handle(event):\n    password:\n      ${value}\n    return event\n`;
  const diff = redactDiffText([
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -1,2 +1,4 @@",
    " def handle(event):",
    "+    password:",
    "+      hunter2hunter2hunter2",
    "     return event",
    "",
  ].join("\n"));
  // Documented residual, now covering the split-line span too: a checkout
  // differing ONLY inside the masked run normalizes to the same marker.
  const maskedOnly = extractChangeAnchors(diff, null, { sourceRoot: workspace({ "src/app.py": head("different-value-xyz") }) }).files[0];
  assert.deepEqual(maskedOnly?.changed_lines, [[2, 3]]);
  assert.deepEqual(maskedOnly?.symbols, [{ name: "handle", kind: "enclosing", confidence: "high", line: 1 }]);
  // An unmasked line elsewhere in the file still fails the exact comparison.
  const drifted = extractChangeAnchors(diff, null, {
    sourceRoot: workspace({ "src/app.py": head("hunter2hunter2hunter2").replace("def handle(event):", "def handle(other):") }),
  }).files[0];
  assert.deepEqual(drifted?.symbols, [], "an unmasked mismatch still fails the whole file");
  assert.equal(drifted?.changed_lines, undefined);
});

test("#1154: normalization forgives only the masked span, never the rest of the file", () => {
  const secret = "hunter2hunter2hunter2";
  const head = (second: string, third = "return event"): string => `def handle(event):\n    token = "${second}"\n    ${third}\n`;
  const diff = redactDiffText([
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -1,2 +1,3 @@",
    " def handle(event):",
    `+    token = "${secret}"`,
    "     return event",
    "",
  ].join("\n"));
  // Documented residual: a checkout differing ONLY inside the masked span
  // normalizes to the same marker and still matches.
  const maskedOnly = extractChangeAnchors(diff, null, { sourceRoot: workspace({ "src/app.py": head("different-value-xyz") }) }).files[0];
  assert.deepEqual(maskedOnly?.changed_lines, [[2, 2]]);
  // An unmasked line elsewhere in the file still fails the comparison.
  const drifted = extractChangeAnchors(diff, null, { sourceRoot: workspace({ "src/app.py": head(secret, "return None") }) }).files[0];
  assert.deepEqual(drifted?.symbols, [], "an unmasked mismatch still fails the whole file");
  assert.equal(drifted?.changed_lines, undefined);
});

test("head reads refuse null bytes, symlinks, traversal and .git components", () => {
  const root = workspace({ "real.py": "x\n", ".git/config.py": "x\n", "bad": "LEAKED\n" });
  symlinkSync("real.py", join(root, "link.py"));
  assert.deepEqual(readChangeAnchorHeadLines(root, "real.py"), ["x", ""]);
  assert.equal(readChangeAnchorHeadLines(root, "link.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, "../real.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, ".git/config.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, "/etc/hosts"), null);
// A NUL byte in a PR-supplied path is refused before any content is read;
  // the `bad` fixture exists so a regression that returned file CONTENT would
  // fail here rather than pass on the path simply not existing. The refusal is
  // end-to-end, not a unique pin of the explicit `includes("\0")` guard: Node's
  // own `openSync`/`realpathSync` bindings reject null bytes with
  // ERR_INVALID_ARG_VALUE, so on current Node either layer refuses. The explicit
  // guard stays because it makes the refusal a property of this function rather
  // than of the Node version under it.
  assert.equal(readChangeAnchorHeadLines(root, "bad\0path.py"), null);
  assert.equal(readChangeAnchorHeadLines(root, "real.py\0suffix"), null);
});

test("#1154: a literal [REDACTED] diff line cannot forge agreement with the checkout", () => {
  // #252 boundary rule: feed the boundary token ITSELF, not benign input.
  const diff = [
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -1,2 +1,3 @@",
    " def handle(event):",
    "+    [REDACTED]",
    "     return None",
    "",
  ].join("\n");
  const root = workspace({ "src/app.py": "def handle(event):\n    [REDACTED]\n    return None\n" });
  // Same marker on both sides → still a match (the marker is a real, equal
  // line of content), but the checkout MUST agree everywhere else.
  const matching = extractChangeAnchors(diff, null, { sourceRoot: root }).files[0];
  assert.deepEqual(matching?.changed_lines, [[2, 2]]);
  const drifted = extractChangeAnchors(diff, null, {
    sourceRoot: workspace({ "src/app.py": "def handle(event):\n    [REDACTED]\n    return event\n" }),
  }).files[0];
  assert.deepEqual(drifted?.symbols, [], "a forged marker line cannot carry an otherwise-mismatched file");
  assert.equal(drifted?.changed_lines, undefined);
});

test("#1154: a raw (unredacted) diff keeps its anchors — the entry normalizes, the caller need not", () => {
  const secret = "hunter2hunter2hunter2";
  const root = workspace({ "src/app.py": `def handle(event):\n    token = "${secret}"\n    return event\n` });
  const raw = [
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -1,2 +1,3 @@",
    " def handle(event):",
    `+    token = "${secret}"`,
    "     return event",
    "",
  ].join("\n");
  // The pre-#1154 shape (raw diff straight from a forge) must not silently
  // lose every head-derived anchor, and normalizing twice is a no-op.
  const once = extractChangeAnchors(raw, null, { sourceRoot: root }).files[0];
  const twice = extractChangeAnchors(redactDiffText(raw), null, { sourceRoot: root }).files[0];
  assert.deepEqual(once?.changed_lines, [[2, 2]]);
  assert.deepEqual(once?.symbols, [{ name: "handle", kind: "enclosing", confidence: "high", line: 1 }]);
  assert.deepEqual(twice, once, "entry normalization is idempotent on an already-redacted diff");
  // The artifact never carries the raw value.
  assert.ok(!renderChangeAnchorsJson(extractChangeAnchors(raw, null, { sourceRoot: root })).includes(secret));
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

// #1154 review round 2 (F2): the checkout's own `password:` block sits BEFORE
// the hunk, so the diff's new side never sees that key line. Normalizing the
// whole checkout over its own stream would mask a compared line the diff
// leaves raw, fail the exact comparison, and silently drop every head-derived
// anchor for a file that contains no secret in its change at all.
test("#1154 r2: a checkout key line OUTSIDE the hunk keeps the file's anchors", () => {
  const head = [
    "password:",
    "  fallback:",
    "    untouched-value",
    "  mode:",
    "    strict",
    "def handle(event):",
    "    event = dict(event, strict=True)",
    "    return event",
    "",
  ].join("\n");
  const root = workspace({ "src/app.py": head });
  const raw = [
    "diff --git a/src/app.py b/src/app.py",
    "--- a/src/app.py",
    "+++ b/src/app.py",
    "@@ -3,5 +3,5 @@",
    "     untouched-value",
    "   mode:",
    "     strict",
    " def handle(event):",
    "-    event = dict(event)",
    "+    event = dict(event, strict=True)",
    "",
  ].join("\n");
  const file = extractChangeAnchors(raw, null, { sourceRoot: root }).files[0];
  assert.deepEqual(file?.changed_lines, [[7, 7]], "the added line still reconciles with the checkout");
  assert.deepEqual(file?.symbols, [{ name: "handle", kind: "enclosing", confidence: "high", line: 6 }]);
  // Entry normalization must not change the outcome.
  assert.deepEqual(extractChangeAnchors(redactDiffText(raw), null, { sourceRoot: root }).files[0], file);
  // Control: an UNMASKED drift elsewhere in the same hunk still fails the whole
  // file — the mirroring grants no tolerance.
  const drifted = extractChangeAnchors(raw, null, {
    sourceRoot: workspace({ "src/app.py": head.replace("    strict\n", "    loose\n") }),
  }).files[0];
  assert.deepEqual(drifted?.symbols, []);
  assert.equal(drifted?.changed_lines, undefined);
});

// #1154 round 3 (N1): `redactDiffText` ends a continuation run at EVERY line
// that is not diff content — `@@`, `diff --git`, `--- `/`+++ `, `\ No
// newline`, file-mode metadata, malformed junk — and `parseDiff` records none
// of those as a new-side line. The mirror is fed only new-side lines, so
// without the reset replay a run left open at the end of a hunk survives in the
// mirror but is closed in the diff: the mirror then masks a line the diff left
// raw, the exact-byte comparison fails, and the file silently loses
// `changed_lines`, enclosing symbols, keys and counterparts. Every fixture
// before this one was single-hunk, which is exactly why it passed.
test("#1154 r3: a run open at a hunk boundary still reconciles across the boundary", () => {
  // Hunk 1 ends on a bare `password:` key line; hunk 2's first compared line
  // is indented deeper than it. The diff closed the run at the `@@`; the
  // mirror must too.
  const head = [
    "def handle(event):",
    "    settings = {",
    "    password:",
    "    return event",
    "",
    "",
    "def other(arg):",
    "        key = arg",
    "    }",
    "    trailing = 1",
    "",
  ].join("\n");
  const root = workspace({ "src/app.py": head });
  const header = ["diff --git a/src/app.py b/src/app.py", "--- a/src/app.py", "+++ b/src/app.py"];
  const hunk1 = ["@@ -1,3 +1,4 @@", " def handle(event):", "     settings = {", "+    password:"];
  const hunk2 = ["@@ -8,2 +8,3 @@", "         key = arg", "     }", "+    trailing = 1"];
  const expected = {
    changed_lines: [[3, 3], [10, 10]],
    symbols: [
      { name: "handle", kind: "enclosing", confidence: "high", line: 1 },
      { name: "other", kind: "enclosing", confidence: "high", line: 7 },
    ],
  };
  const anchors = (lines: string[]) => extractChangeAnchors(lines.join("\n") + "\n", null, { sourceRoot: root }).files[0];

  const twoHunk = anchors([...header, ...hunk1, ...hunk2]);
  assert.deepEqual(twoHunk?.changed_lines, expected.changed_lines);
  assert.deepEqual(twoHunk?.symbols, expected.symbols);

  // Same file repeated as two `diff --git` blocks: the merge site must carry
  // the reset flags too, or the boundary between the blocks desynchronizes.
  const repeated = anchors([...header, ...hunk1, ...header, ...hunk2]);
  assert.deepEqual(repeated?.changed_lines, expected.changed_lines);
  assert.deepEqual(repeated?.symbols, expected.symbols);

  // A `\ No newline` marker between the hunks is a reset too.
  const noNewline = anchors([...header, ...hunk1, "\\ No newline at end of file", ...hunk2]);
  assert.deepEqual(noNewline?.changed_lines, expected.changed_lines);
  assert.deepEqual(noNewline?.symbols, expected.symbols);

  // Control: the second hunk ALONE reconciles identically (no state carried in
  // from a boundary), so the multi-boundary cases match a single-hunk file.
  const control = anchors([...header, ...hunk2]);
  assert.deepEqual(control?.changed_lines, [[10, 10]]);
  assert.deepEqual(control?.symbols, [{ name: "other", kind: "enclosing", confidence: "high", line: 7 }]);
  assert.deepEqual(twoHunk?.symbols?.at(-1), control?.symbols?.[0], "the boundary adds no drift");
});
