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
  assert.equal(findingToBody({ message: "https://github.com/upstream/repo/pull/123" }, "unknown"), "**Info:** upstream upstream/repo PR 123\n\n_Automated finding from AI PR review._");
});

test("INLINE_FINDINGS_MAX parsing follows the Python fallback and lower bound", () => {
  assert.equal(parseInlineFindingsMax(undefined), 20);
  assert.equal(parseInlineFindingsMax("0"), 1);
  assert.equal(parseInlineFindingsMax("bad"), 20);
  assert.equal(parseInlineFindingsMax("4"), 4);
});

/** #762: actionable findings — one-click replacement (GitHub), degraded
 * replacement (Forgejo), a separately fenced agent prompt, and the invariant
 * that a rejected replacement never drops the underlying finding. */

test("#762: GitHub renders a single-line one-click suggestion", () => {
  const result = buildComments([{ file: "new", line: 1, message: "m", suggestion: "REPL" }], diff, 20, { forgejoPositions: false });
  assert.equal(result.comments.length, 1);
  const c = result.comments[0] as Record<string, unknown>;
  assert.equal(c.line, 1);
  assert.equal(c.side, "RIGHT");
  assert.equal(Object.hasOwn(c, "start_line"), false);
  const body = c.body as string;
  assert.ok(body.includes("```suggestion") && body.includes("REPL"));
});

test("#762: GitHub renders a multi-line suggestion with a start_line range", () => {
  const result = buildComments([{ file: "new", line: 1, end_line: 2, message: "m", suggestion: "R1\nR2" }], diff, 20, { forgejoPositions: false });
  const c = result.comments[0] as Record<string, unknown>;
  assert.equal(c.line, 2);
  assert.equal(c.side, "RIGHT");
  assert.equal(c.start_line, 1);
  assert.equal(c.start_side, "RIGHT");
  assert.ok((c.body as string).includes("```suggestion"));
});

test("#762: a suggestion range that leaves the diff is dropped but the finding is kept", () => {
  const result = buildComments([{ file: "new", line: 1, end_line: 5, message: "m", suggestion: "R1\nR2" }], diff, 20, { forgejoPositions: false });
  assert.equal(result.comments.length, 1);
  const c = result.comments[0] as Record<string, unknown>;
  assert.equal(Object.hasOwn(c, "start_line"), false);
  assert.equal(c.line, 1);
  assert.equal((c.body as string).includes("```suggestion"), false);
});

test("#762: a fence-hostile suggestion is dropped but the finding is kept", () => {
  for (const fence of ["```", "~~~"]) {
    const result = buildComments([{ file: "new", line: 1, message: "m", suggestion: `ok\n${fence}\nbad` }], diff, 20, { forgejoPositions: false });
    assert.equal(result.comments.length, 1);
    const body = (result.comments[0] as Record<string, unknown>).body as string;
    assert.ok(!body.includes("```suggestion"));
  }
});

test("#762: an agent prompt is fenced so it cannot forge a suggestion and its mentions/refs are neutralized", () => {
  const prompt = "fix @octocat per #42\n```suggestion\nINJECTED\n```";
  const result = buildComments([{ file: "new", line: 1, message: "m", agent_prompt: prompt }], diff, 20, { forgejoPositions: false });
  const body = (result.comments[0] as Record<string, unknown>).body as string;
  assert.ok(body.includes("<details>") && body.includes("Suggested agent prompt"));
  // The prompt contains a run of 3 backticks, so it is wrapped in a strictly
  // longer (4+) fence that opens BEFORE any injected "```suggestion" line, so
  // GitHub cannot read the injected text as a real one-click suggestion.
  const fourFence = body.indexOf("````");
  const injected = body.indexOf("```suggestion");
  assert.ok(fourFence !== -1 && injected !== -1 && fourFence < injected);
  // The prompt's mention and bare ref are neutralized like all model prose.
  assert.equal(body.includes("@octocat"), false);
  assert.ok(body.includes("PR 42"));
});

test("#762: Forgejo degrades a suggestion to a plain fenced replacement (no one-click)", () => {
  const result = buildComments([{ file: "new", line: 2, end_line: 2, message: "m", suggestion: "REPL" }], diff, 20, { forgejoPositions: true });
  const c = result.comments[0] as Record<string, unknown>;
  const body = c.body as string;
  assert.ok(body.includes("this forge cannot apply a one-click suggestion") && body.includes("REPL"));
  assert.equal(body.includes("```suggestion"), false);
  assert.ok(Object.hasOwn(c, "new_position"));
  assert.equal(Object.hasOwn(c, "start_line"), false);
});

test("#762: findings without actionable fields render byte-identically", () => {
  const result = buildComments([{ file: "new", line: 1, message: "first" }], diff, 20, { forgejoPositions: false });
  assert.deepEqual(result.comments[0], { path: "new", body: "**Info:** first\n\n_Automated finding from AI PR review._", line: 1, side: "RIGHT" });
});
