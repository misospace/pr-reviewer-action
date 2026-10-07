import test from "node:test";
import assert from "node:assert/strict";
import { buildComments, diffPositions, findingToBody, parseInlineFindingsMax } from "../src/publish/inline-findings.js";

const diff = [
  "diff --git a/old b/new", "--- a/old", "+++ b/new", "@@ -1,2 +1,3 @@",
  " context", "-removed", "\\ No newline at end of file", "+added", "@@ -8 +9 @@", " later",
].join("\n");

test("#680: diff anchors track context, added lines, deleted slots and multiple hunks", () => {
  const positions = diffPositions(diff);
  assert.deepEqual([...positions.get("new")!.entries()], [[1, 1], [2, 3], [9, 4]]);
  const deletedOnly = diffPositions("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4 +3,0 @@\n-old\n");
  assert.equal(deletedOnly.get("x"), undefined);
});

test("#680: validates paths and integer anchors, deduplicates threads, caps comments", () => {
  const findings: unknown[] = [
    null,
    ...[0, -1, 3.5].map((line) => ({ file: "new", line, message: "invalid" })),
    { file: "/abs", line: 1 }, { file: "../traversal", line: 1 },
    { file: "new", line: 1, thread_id: "existing" },
    { file: "new", line: 100 },
    { file: "new", line: 1, message: "first" }, { file: "new", line: 2, message: "second" },
  ];
  const result = buildComments(findings, diff, 1, { forgejoPositions: false });
  assert.equal(result.comments.length, 1);
  assert.equal(result.skipped, 8);
  assert.deepEqual(result.comments[0], { path: "new", body: "**Info:** first\n\n_Automated finding from AI PR review._", line: 1, side: "RIGHT" });
});

test("#680: Forgejo uses diff-relative positions and ignores metadata slots", () => {
  const result = buildComments([{ file: "new", line: 2, message: "x" }], diff, 20, { forgejoPositions: true });
  assert.deepEqual(result.comments[0], { path: "new", body: "**Info:** x\n\n_Automated finding from AI PR review._", new_position: 3 });
});

test("#561: labels, categories, backticks, secret redaction and inert upstream links", () => {
  assert.equal(findingToBody({ severity: "mystery", category: "other", message: " `#42`" }, "inert"), "**mystery:** `#42`\n\n_Automated finding from AI PR review._");
  assert.equal(findingToBody({ severity: "major", category: "security", message: "Bearer abcdefghijklmnopqrstuvwxyz https://github.com/upstream/repo/pull/123" }, "inert"), "**⚠️ Major (security):** [REDACTED] upstream upstream/repo PR 123\n\n_Automated finding from AI PR review._");
  assert.equal(findingToBody({ message: "credential sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" }, "inert"), "**Info:** credential [REDACTED]\n\n_Automated finding from AI PR review._");
  assert.equal(findingToBody({ message: "https://github.com/upstream/repo/pull/123" }, "unknown"), "**Info:** upstream upstream/repo PR 123\n\n_Automated finding from AI PR review._");
});

test("INLINE_FINDINGS_MAX parsing follows the Python fallback and lower bound", () => {
  assert.equal(parseInlineFindingsMax(undefined), 20);
  assert.equal(parseInlineFindingsMax("0"), 1);
  assert.equal(parseInlineFindingsMax("bad"), 20);
  assert.equal(parseInlineFindingsMax("4"), 4);
});
