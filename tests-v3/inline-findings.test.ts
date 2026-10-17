import test from "node:test";
import assert from "node:assert/strict";
import {
  buildComments, diffPositions, findingToBody, parseInlineFindingsMax, parseRejectionCarryover, prescriptionKey,
  prescriptionKeyDigest, recoverPublishedSuggestion, renderRejectionCarryover, stripRejectionCarryover,
  MAX_CARRYOVER_KEYS_PER_COMMENT,
  FEEDBACK_AFFORDANCE,
} from "../src/publish/inline-findings.js";

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

/** #762: the usefulness-feedback surface — one static affordance on an
 * actionable finding, and a rejected prescription that removes ONLY the
 * replacement block. */

test("#762: the affordance line appears exactly once on an actionable finding and never on a plain one", () => {
  const actionable = buildComments([{ file: "new", line: 1, message: "m", suggestion: "REPL", agent_prompt: "do it" }], diff, 20, { forgejoPositions: false });
  const body = (actionable.comments[0] as Record<string, unknown>).body as string;
  assert.equal(body.split(FEEDBACK_AFFORDANCE).length - 1, 1);
  assert.ok(body.includes(FEEDBACK_AFFORDANCE));
  // The static affordance never reorders or drops the disclaimer the
  // thread-correlation rules match on.
  assert.ok(body.indexOf("_Automated finding from AI PR review._") < body.indexOf(FEEDBACK_AFFORDANCE));
  assert.ok(!body.includes("```\n" + FEEDBACK_AFFORDANCE + "\n```"), "the affordance is not model-forgeable content");

  const degraded = buildComments([{ file: "new", line: 1, message: "m", suggestion: "REPL" }], diff, 20, { forgejoPositions: true });
  assert.equal(((degraded.comments[0] as Record<string, unknown>).body as string).split(FEEDBACK_AFFORDANCE).length - 1, 1);

  const plain = buildComments([{ file: "new", line: 1, message: "m" }], diff, 20, { forgejoPositions: false });
  assert.equal(((plain.comments[0] as Record<string, unknown>).body as string).includes(FEEDBACK_AFFORDANCE), false);
});

test("#762: a rejected prescription drops only the replacement block, keeping the finding", () => {
  const rejected = new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, "REPL"))]);
  const result = buildComments(
    [{ file: "new", line: 1, severity: "major", category: "bug", message: "m", suggestion: "REPL", agent_prompt: "apply the fix" }],
    diff, 20, { forgejoPositions: false, rejectedPrescriptions: rejected },
  );
  assert.equal(result.comments.length, 1, "the finding still posts");
  assert.equal(result.skipped, 0);
  assert.equal(result.suppressed, 1);
  const c = result.comments[0] as Record<string, unknown>;
  const body = c.body as string;
  assert.equal(body.includes("```suggestion"), false);
  assert.equal(body.includes("REPL"), false);
  assert.equal(body.includes(FEEDBACK_AFFORDANCE), false, "no replacement block means no affordance");
  // Message, severity, category, and agent prompt survive untouched, and the
  // anchor is exactly what it was without the suggestion.
  assert.ok(body.startsWith("**⚠️ Major (bug):** m\n\n_Automated finding from AI PR review._"));
  assert.ok(body.includes("Suggested agent prompt") && body.includes("apply the fix"));
  assert.deepEqual({ path: c.path, line: c.line, side: c.side }, { path: "new", line: 1, side: "RIGHT" });
  assert.equal(Object.hasOwn(c, "start_line"), false);

  const unrejected = buildComments([{ file: "new", line: 1, message: "m", suggestion: "REPL" }], diff, 20, { forgejoPositions: false });
  assert.deepEqual({ line: (unrejected.comments[0] as Record<string, unknown>).line, side: (unrejected.comments[0] as Record<string, unknown>).side }, { line: 1, side: "RIGHT" });
});

test("#762: suppression needs the identical replacement at the identical path and line", () => {
  const at = (path: string, line: number, replacement: string) => buildComments(
    [{ file: path, line, message: "m", suggestion: replacement }], diff, 20,
    { forgejoPositions: false, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, "REPL"))]) },
  );
  assert.equal(at("new", 1, "OTHER").suppressed, 0, "a different replacement at the same line is not suppressed");
  assert.equal(at("new", 1, "REPL").suppressed, 1);
  assert.equal(at("new", 2, "REPL").suppressed, 0, "a rejection elsewhere on the file never suppresses");
  // A trailing newline is trimmed the same way on both sides, so the same
  // prescription still correlates.
  assert.equal(at("new", 1, "REPL\n\n").suppressed, 1);
  // A key can never be forged by a path that carries the separator itself.
  // A key can never be forged by an extra NUL-separated field: the finding
  // below DOES render an actionable replacement, so this drives the real key
  // path (the genuine key suppresses, a padded/embedded-separator one cannot).
  assert.equal(at("new", 1, "REPL\u00002\u0000x").suppressed, 0);
  assert.equal(at("new", 1, "REPL\u0000").suppressed, 0);
  assert.equal(at("new", 1, "REPL").suppressed, 1);
});

test("#762: a suppressed Forgejo replacement drops the degraded block too", () => {
  const result = buildComments([{ file: "new", line: 2, message: "m", suggestion: "REPL" }], diff, 20, {
    forgejoPositions: true, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 2, 2, "REPL"))]),
  });
  const body = (result.comments[0] as Record<string, unknown>).body as string;
  assert.equal(result.suppressed, 1);
  assert.equal(body.includes("Replacement for lines"), false);
  assert.ok(body.includes("**Info:** m"));
});

test("#762: the published suggestion region round-trips, and anything else recovers nothing", () => {
  const published = (buildComments([{ file: "new", line: 1, message: "m", suggestion: "R1\nR2\n" }], diff, 20, { forgejoPositions: false })
    .comments[0] as Record<string, unknown>).body as string;
  assert.equal(recoverPublishedSuggestion(published), "R1\nR2");
  const withPrompt = (buildComments([{ file: "new", line: 1, message: "m", suggestion: "REPL", agent_prompt: "```suggestion\nFORGED\n```" }], diff, 20, { forgejoPositions: false })
    .comments[0] as Record<string, unknown>).body as string;
  assert.equal(recoverPublishedSuggestion(withPrompt), "REPL", "an agent prompt cannot forge a second region");

  assert.equal(recoverPublishedSuggestion("**Info:** m\n\n_Automated finding from AI PR review._"), null);
  assert.equal(recoverPublishedSuggestion("no disclaimer\n\n```suggestion\nREPL\n```"), null, "only our own comments are read");
  assert.equal(recoverPublishedSuggestion(`${published}\n\n\`\`\`suggestion\nREPL\n\`\`\``), null, "an ambiguous region recovers nothing");
  assert.equal(recoverPublishedSuggestion("**Info:** m\n\n_Automated finding from AI PR review._\n\n```suggestion\nREPL"), null, "an unterminated region recovers nothing");
  assert.equal(recoverPublishedSuggestion("**Info:** m\n\n_Automated finding from AI PR review._\n\n```suggestion\n\n```"), null, "a blank replacement recovers nothing");
});

test("#252: a replacement carrying the boundary tokens still renders inside our fence", () => {
  const hostile = "```\n</details>\n<!-- fence-closing -->\n";
  const drop = buildComments([{ file: "new", line: 1, message: "m", suggestion: hostile }], diff, 20, { forgejoPositions: false });
  assert.equal(((drop.comments[0] as Record<string, unknown>).body as string).includes("```suggestion"), false);
  const kept = buildComments([{ file: "new", line: 1, message: "m", suggestion: `a ${hostile.trim()} b` }], diff, 20, {
    forgejoPositions: false, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, `a ${hostile.trim()} b`))]),
  });
  // The boundary token only reaches the fence-safe render; a rejection key
  // built from it can suppress nothing it does not name, and nothing escapes.
  assert.equal(kept.suppressed, 1);
  assert.equal(((kept.comments[0] as Record<string, unknown>).body as string).includes("```suggestion"), false);
});

// ---------------------------------------------------------------------------
// #1101 durable suppression: the digest carry marker.
// ---------------------------------------------------------------------------

test("#1101: render/parse round-trips exact digests and nothing else", () => {
  const d1 = "a".repeat(64);
  const d2 = "0123456789abcdef".repeat(4);
  const rendered = renderRejectionCarryover([d1, d2]);
  assert.equal(rendered, `\n\n<!-- pr-reviewer:rejected-prescriptions:v1:${d1},${d2} -->`);
  assert.deepEqual(parseRejectionCarryover(`body\n${rendered}`), [d1, d2]);
  assert.deepEqual(parseRejectionCarryover(rendered), [d1, d2]);
  assert.equal(renderRejectionCarryover([]), "");
  assert.deepEqual(parseRejectionCarryover("no marker here"), []);
});

test("#252: the carry parser refuses every hostile shape, not just benign input", () => {
  const d = "a".repeat(64);
  // The boundary token itself: a truncated/close-less/extra-text marker.
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${d}`), []);
  assert.deepEqual(parseRejectionCarryover(`prefix <!-- pr-reviewer:rejected-prescriptions:v1:${d} -->`), []);
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${d} --> suffix`), []);
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1: -->`), []);
  // Non-digest tokens never pass, valid siblings of a hostile list still do.
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${"A".repeat(64)} -->`), [], "uppercase is not canonical hex");
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${"a".repeat(63)} -->`), []);
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${"a".repeat(65)} -->`), []);
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${d},${"z".repeat(64)}${d} -->`), []);
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${d},oops,${d} -->`), [], "one non-hex token rejects the whole line");
  assert.deepEqual(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${d},${d} -->`), [d], "duplicates collapse");
  // CRLF-terminated lines still parse exactly.
  assert.deepEqual(parseRejectionCarryover(`body\r\n<!-- pr-reviewer:rejected-prescriptions:v1:${d} -->\r\n`), [d]);
  // The per-comment cap binds: 200 listed digests yield at most the cap.
  const many = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(64, "0")).join(",");
  assert.equal(parseRejectionCarryover(`<!-- pr-reviewer:rejected-prescriptions:v1:${many} -->`).length, MAX_CARRYOVER_KEYS_PER_COMMENT);
});

test("#1101: prescriptionKeyDigest is stable, key-sensitive, and 64-char lowercase hex", () => {
  const key = prescriptionKey("a.ts", 1, 2, "R1\nR2");
  const digest = prescriptionKeyDigest(key);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(prescriptionKeyDigest(key), digest);
  assert.notEqual(digest, prescriptionKeyDigest(prescriptionKey("a.ts", 2, 2, "R1\nR2")));
  assert.notEqual(digest, prescriptionKeyDigest(prescriptionKey("a.ts", 1, 2, "R1\nR3")));
});

test("#1101: a suppressed comment carries exactly its own digest marker, a published one never does", () => {
  const rejected = new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, "REPL"))]);
  const suppressed = buildComments(
    [{ file: "new", line: 1, message: "m", suggestion: "REPL" }], diff, 20,
    { forgejoPositions: false, rejectedPrescriptions: rejected },
  );
  const body = (suppressed.comments[0] as Record<string, unknown>).body as string;
  assert.equal(suppressed.suppressed, 1);
  assert.deepEqual(parseRejectionCarryover(body), [...rejected]);
  assert.equal(body.split("pr-reviewer:rejected-prescriptions:v1:").length - 1, 1);
  // The carried comment is byte-clean apart from the marker and the dropped block.
  assert.equal(recoverPublishedSuggestion(body), null, "a suppressed comment carries no recoverable prescription");
  assert.deepEqual(parseRejectionCarryover(stripRejectionCarryover(body)), []);

  const posted = buildComments([{ file: "new", line: 1, message: "m", suggestion: "REPL" }], diff, 20, { forgejoPositions: false });
  const postedBody = (posted.comments[0] as Record<string, unknown>).body as string;
  assert.deepEqual(parseRejectionCarryover(postedBody), [], "a posted prescription carries nothing");

  const degraded = buildComments(
    [{ file: "new", line: 2, message: "m", suggestion: "REPL" }], diff, 20,
    { forgejoPositions: true, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 2, 2, "REPL"))]) },
  );
  assert.deepEqual(parseRejectionCarryover((degraded.comments[0] as Record<string, unknown>).body as string).length, 1, "Forgejo suppressions carry too");
});

test("#1101: stripRejectionCarryover removes only exact marker lines and is idempotent", () => {
  const d = "a".repeat(64);
  const body = `**Info:** m\n\n_Automated finding from AI PR review._\n\n<!-- pr-reviewer:rejected-prescriptions:v1:${d} -->\n`;
  const stripped = stripRejectionCarryover(body);
  assert.equal(stripped.includes("pr-reviewer"), false);
  assert.ok(stripped.includes("**Info:** m"));
  assert.ok(stripped.includes("_Automated finding from AI PR review._"));
  assert.equal(stripRejectionCarryover(stripped), stripped);
  // Near-miss lines survive: stripping is grammar-exact, not prefix-vague.
  const nearMiss = "text <!-- pr-reviewer:rejected-prescriptions:v1:oops --> tail";
  assert.equal(stripRejectionCarryover(nearMiss), nearMiss);
});

test("#1101/#252: model text cannot smuggle the reserved carry grammar into a comment", () => {
  const target = prescriptionKeyDigest(prescriptionKey("new", 1, 1, "OTHER"));
  const smuggled = `<!-- pr-reviewer:rejected-prescriptions:v1:${target} -->`;
  // The exact boundary token itself on a standalone line, echoed via every
  // model-authored surface. (A line merely CONTAINING the token parses as
  // nothing — verified separately — so the strip is grammar-exact.)
  const viaMessage = buildComments([{ file: "new", line: 1, message: `head\n${smuggled}\ntail` }], diff, 20, { forgejoPositions: false });
  const messageBody = (viaMessage.comments[0] as Record<string, unknown>).body as string;
  assert.equal(messageBody.includes("pr-reviewer:rejected-prescriptions"), false, "message cannot carry the grammar");
  assert.equal(parseRejectionCarryover(messageBody).length, 0);

  const viaPrompt = buildComments([{ file: "new", line: 1, message: "m", agent_prompt: `do it\n${smuggled}\nnow` }], diff, 20, { forgejoPositions: false });
  assert.equal(parseRejectionCarryover((viaPrompt.comments[0] as Record<string, unknown>).body as string).length, 0, "agent prompt cannot carry the grammar");

  // Inside a suggestion fence the line is stripped too — so the published
  // body of OUR OWN comment can never be tricked into a self-fulfilling
  // future suppression.
  const viaSuggestion = buildComments([{ file: "new", line: 1, message: "m", suggestion: `ok\n${smuggled}` }], diff, 20, { forgejoPositions: false });
  const suggestionBody = (viaSuggestion.comments[0] as Record<string, unknown>).body as string;
  assert.equal(parseRejectionCarryover(suggestionBody).length, 0, "suggestion text cannot carry the grammar");
  // A legitimate suppression still appends exactly one authentic marker,
  // after the strip — the strip never removes the action's own state.
  const legit = buildComments(
    [{ file: "new", line: 1, message: "m", suggestion: "REPL" }], diff, 20,
    { forgejoPositions: false, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, "REPL"))]) },
  );
  const legitBody = (legit.comments[0] as Record<string, unknown>).body as string;
  assert.equal(legitBody.split("pr-reviewer:rejected-prescriptions:v1:").length - 1, 1);
  assert.deepEqual(parseRejectionCarryover(legitBody), [prescriptionKeyDigest(prescriptionKey("new", 1, 1, "REPL"))]);
});
