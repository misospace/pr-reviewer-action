import test from "node:test";
import assert from "node:assert/strict";
import { applyOutsideDiffTagging, isOutsideDiff, sortOutsideDiffLast } from "../src/enforcement/outside-diff.js";
import { renderOutsideDiffSection } from "../src/publish/publish.js";
import { diffPositions } from "../src/publish/inline-findings.js";
import type { ArtifactFinding, ReviewArtifact } from "../src/enforcement/artifact.js";

// a.ts: in-diff lines 1 (context), 2 (added, replacing a removed line), 3 (added).
// old.ts -> new.ts: a rename; only the new path anchors (line 1 context, line 2 added).
// gone.ts: deleted entirely (+++ /dev/null); no positions are ever recorded for it.
const DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,3 @@",
  " context",
  "-old",
  "+new1",
  "+new2",
  "diff --git a/old.ts b/new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1,1 +1,2 @@",
  " ctx",
  "+added",
  "diff --git a/gone.ts b/gone.ts",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-line1",
  "-line2",
].join("\n");

function finding(overrides: Partial<ArtifactFinding> = {}): ArtifactFinding {
  return { severity: "info", category: "other", file: null, line: null, message: "m", ...overrides };
}

function artifact(findings: ArtifactFinding[], overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return { verdict: "approve", review_markdown: "review", findings, ...overrides };
}

test("isOutsideDiff: file never touched by the diff", () => {
  const positions = diffPositions(DIFF);
  assert.equal(isOutsideDiff("unrelated.ts", 5, positions), true);
});

test("isOutsideDiff: line outside every hunk's new-side range", () => {
  const positions = diffPositions(DIFF);
  assert.equal(isOutsideDiff("a.ts", 10, positions), true);
});

test("isOutsideDiff: line inside a hunk anchors in-diff", () => {
  const positions = diffPositions(DIFF);
  assert.equal(isOutsideDiff("a.ts", 1, positions), false);
  assert.equal(isOutsideDiff("a.ts", 2, positions), false);
  assert.equal(isOutsideDiff("a.ts", 3, positions), false);
});

test("isOutsideDiff: deleted file has no positions at all", () => {
  const positions = diffPositions(DIFF);
  assert.equal(isOutsideDiff("gone.ts", 1, positions), true);
});

test("isOutsideDiff: renamed-away path doesn't inherit the new path's anchors", () => {
  const positions = diffPositions(DIFF);
  assert.equal(isOutsideDiff("old.ts", 1, positions), true);
  assert.equal(isOutsideDiff("new.ts", 1, positions), false);
  assert.equal(isOutsideDiff("new.ts", 2, positions), false);
});

test("isOutsideDiff: null file or null line is never outside-diff (left untagged)", () => {
  const positions = diffPositions(DIFF);
  assert.equal(isOutsideDiff(null, 5, positions), false);
  assert.equal(isOutsideDiff("a.ts", null, positions), false);
  assert.equal(isOutsideDiff(null, null, positions), false);
});

test("applyOutsideDiffTagging: tags each case and leaves null file/line untagged", () => {
  const inDiff = finding({ file: "a.ts", line: 2, message: "in diff" });
  const outsideFile = finding({ file: "unrelated.ts", line: 5, message: "wrong file" });
  const outsideLine = finding({ file: "a.ts", line: 10, message: "wrong line" });
  const deleted = finding({ file: "gone.ts", line: 1, message: "deleted file" });
  const renamedAway = finding({ file: "old.ts", line: 1, message: "pre-rename path" });
  const renamedInto = finding({ file: "new.ts", line: 2, message: "post-rename path" });
  const noFile = finding({ file: null, line: 5, message: "no file" });
  const noLine = finding({ file: "a.ts", line: null, message: "no line" });

  const a = artifact([inDiff, outsideFile, outsideLine, deleted, renamedAway, renamedInto, noFile, noLine]);
  const tagged = applyOutsideDiffTagging(a, DIFF);

  assert.equal(tagged, 4);
  const byMessage = Object.fromEntries(a.findings.map((f) => [f.message, f.outside_diff]));
  assert.equal(byMessage["in diff"], undefined);
  assert.equal(byMessage["wrong file"], true);
  assert.equal(byMessage["wrong line"], true);
  assert.equal(byMessage["deleted file"], true);
  assert.equal(byMessage["pre-rename path"], true);
  assert.equal(byMessage["post-rename path"], undefined);
  assert.equal(byMessage["no file"], undefined);
  assert.equal(byMessage["no line"], undefined);
});

test("applyOutsideDiffTagging: verdict and verdict_source are untouched", () => {
  const a = artifact([finding({ file: "unrelated.ts", line: 1, severity: "blocker" })], {
    verdict: "request_changes",
    verdict_source: "model",
  });
  applyOutsideDiffTagging(a, DIFF);
  assert.equal(a.verdict, "request_changes");
  assert.equal(a.verdict_source, "model");
});

test("ordering: outside-diff findings sort after every in-diff finding, most-decisive-first within each group", () => {
  const inInfo = finding({ file: "a.ts", line: 1, severity: "info", message: "in-info" });
  const outBlocker = finding({ file: "unrelated.ts", line: 5, severity: "blocker", message: "out-blocker" });
  const inMajor = finding({ file: "a.ts", line: 2, severity: "major", message: "in-major" });
  const outMinor = finding({ file: "gone.ts", line: 1, severity: "minor", message: "out-minor" });
  const inBlocker = finding({ file: "a.ts", line: 3, severity: "blocker", message: "in-blocker" });

  const a = artifact([inInfo, outBlocker, inMajor, outMinor, inBlocker]);
  applyOutsideDiffTagging(a, DIFF);

  assert.deepEqual(a.findings.map((f) => f.message), ["in-blocker", "in-major", "in-info", "out-blocker", "out-minor"]);
});

test("ordering: sortOutsideDiffLast is stable within a severity group and forward-compatible with a model-set pre_existing flag", () => {
  const first = finding({ severity: "minor", message: "first", file: "a.ts", line: 1 });
  const second = finding({ severity: "minor", message: "second", file: "a.ts", line: 2 });
  // Not yet on main at write time: a companion, model-set `pre_existing` flag.
  // Read defensively by key so this pass groups it the same way once it lands.
  const preExisting = { ...finding({ severity: "blocker", message: "pre-existing" }), pre_existing: true } as unknown as ArtifactFinding;

  const sorted = sortOutsideDiffLast([preExisting, first, second]);
  assert.deepEqual(sorted.map((f) => f.message), ["first", "second", "pre-existing"]);
});

test("rendering: outside-diff findings get the neutral label and are not dropped from the summary", () => {
  const findings = [
    { severity: "blocker", category: "security", message: "Uses eval() on user input", outside_diff: true },
    { severity: "info", category: "other", message: "in-diff, not rendered here" },
  ];
  const section = renderOutsideDiffSection(findings, "inert");
  assert.ok(section.includes("## Findings Outside This Diff"));
  assert.ok(section.includes("(pre-existing, outside this diff)"));
  assert.ok(section.includes("Uses eval() on user input"));
  assert.ok(!section.includes("in-diff, not rendered here"));
});

test("rendering: a model-set pre_existing flag also renders (forward compatibility)", () => {
  const section = renderOutsideDiffSection([{ severity: "minor", message: "legacy helper", pre_existing: true }], "inert");
  assert.ok(section.includes("legacy helper"));
  assert.ok(section.includes("(pre-existing, outside this diff)"));
});

test("rendering: no section at all when nothing is flagged", () => {
  assert.equal(renderOutsideDiffSection([{ severity: "major", message: "ordinary" }], "inert"), "");
  assert.equal(renderOutsideDiffSection([], "inert"), "");
  assert.equal(renderOutsideDiffSection(null, "inert"), "");
  assert.equal(renderOutsideDiffSection(undefined, "inert"), "");
});
