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
  // #1107: the opener is reserved in the model text before the wrap, so the
  // prompt cannot carry a prescription opener into the body at all — the
  // guarantee is now stronger than "a fence GitHub cannot read past": the
  // opener is absent and only the bare word survives as inert prose.
  assert.equal(body.includes("```suggestion"), false);
  assert.ok(body.includes("\nsuggestion\n") && body.includes("INJECTED"));
  // The prompt's remaining run of 3 backticks is still wrapped in a strictly
  // longer (4+) fence that opens BEFORE the injected text, so GitHub cannot
  // read the prompt as a one-click suggestion.
  const fourFence = body.indexOf("````");
  const injected = body.indexOf("INJECTED");
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

test("#1101: a marker-bearing suggestion digests the same text it publishes, so recovery round-trips", () => {
  const foreign = prescriptionKeyDigest(prescriptionKey("new", 1, 1, "OTHER"));
  const smuggled = `<!-- pr-reviewer:rejected-prescriptions:v1:${foreign} -->`;
  const suggestion = `ok\n${smuggled}\nkeep`;
  const published = (buildComments([{ file: "new", line: 1, message: "m", suggestion }], diff, 20, { forgejoPositions: false })
    .comments[0] as Record<string, unknown>).body as string;

  // The reserved grammar never reaches our own comment, in any form.
  assert.equal(published.includes("pr-reviewer:rejected-prescriptions"), false, "the marker line is gone from the published body");
  assert.deepEqual(parseRejectionCarryover(published), []);
  assert.ok(published.includes("```suggestion") && published.includes("ok") && published.includes("keep"));

  // What publish.ts computes from the body that was actually published.
  const recovered = recoverPublishedSuggestion(published)!;
  assert.equal(recovered, "ok\nkeep");
  const fromPublished = prescriptionKeyDigest(prescriptionKey("new", 1, 1, recovered));
  const rerun = buildComments([{ file: "new", line: 1, message: "m", suggestion }], diff, 20, {
    forgejoPositions: false, rejectedPrescriptions: new Set([fromPublished]),
  });
  assert.equal(rerun.suppressed, 1, "the recovered digest suppresses the prescription it describes");
  const rerunBody = (rerun.comments[0] as Record<string, unknown>).body as string;
  assert.equal(rerunBody.includes("```suggestion"), false, "no replacement block, no affordance");
  assert.equal(rerunBody.includes(FEEDBACK_AFFORDANCE), false);
  assert.ok(rerunBody.includes("**Info:** m"), "the finding still posts");
  assert.deepEqual(parseRejectionCarryover(rerunBody), [fromPublished]);

  // The pre-fix bug pinned: the digest of the UNSTRIPPED suggestion text (what
  // the fence never carried) suppresses nothing, because the reviewer's 👎 can
  // only ever name the published replacement.
  const unstripped = buildComments([{ file: "new", line: 1, message: "m", suggestion }], diff, 20, {
    forgejoPositions: false,
    rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, suggestion))]),
  });
  assert.equal(unstripped.suppressed, 0);
  assert.ok(((unstripped.comments[0] as Record<string, unknown>).body as string).includes("```suggestion"));
});

test("#1101: a suggestion that is nothing but a marker line drops the prescription, not the finding", () => {
  const smuggled = `<!-- pr-reviewer:rejected-prescriptions:v1:${prescriptionKeyDigest(prescriptionKey("new", 1, 1, "OTHER"))} -->`;
  for (const suggestion of [smuggled, `${smuggled}\n`]) {
    const result = buildComments([{ file: "new", line: 1, message: "m", suggestion }], diff, 20, { forgejoPositions: false });
    assert.equal(result.comments.length, 1, "the finding still posts");
    assert.equal(result.suppressed, 0, "no prescription exists to suppress or carry");
    const body = (result.comments[0] as Record<string, unknown>).body as string;
    assert.equal(body.includes("```suggestion"), false, "no replacement block");
    assert.equal(body.includes(FEEDBACK_AFFORDANCE), false, "no affordance without a replacement block");
    assert.deepEqual(parseRejectionCarryover(body), [], "the reserved grammar never reaches the comment");
    assert.equal(body, "**Info:** m\n\n_Automated finding from AI PR review._");
  }
  // Same shape as the round-trip test above, but with no surrounding text: the
  // marker line is what a digest would have described, so there is nothing left
  // to publish and nothing a later run could recover.
  const sole = buildComments([{ file: "new", line: 1, message: "m", suggestion: smuggled }], diff, 20, { forgejoPositions: false });
  assert.equal(recoverPublishedSuggestion((sole.comments[0] as Record<string, unknown>).body as string), null);
});

test("#1101: marker lines around blank ones strip to nothing — the prescription drops, the finding does not", () => {
  const smuggled = `<!-- pr-reviewer:rejected-prescriptions:v1:${prescriptionKeyDigest(prescriptionKey("new", 1, 1, "OTHER"))} -->`;
  // The strip leaves a bare "\n" here, which is NOT "" — so the emptiness
  // predicate must be re-normalized after the strip, or a content-free
  // ```suggestion block publishes with an affordance no recovery can find.
  const finding = {
    file: "new", line: 1, severity: "major", category: "security", message: "m",
    suggestion: `${smuggled}\n\n\n${smuggled}`, agent_prompt: "apply the fix",
  };
  const result = buildComments([finding], diff, 20, { forgejoPositions: false });
  const body = (result.comments[0] as Record<string, unknown>).body as string;
  assert.equal(result.suppressed, 0, "no prescription exists to digest, suppress or carry");
  assert.equal(body.includes("```suggestion"), false, "no content-free replacement block");
  assert.equal(body.includes(FEEDBACK_AFFORDANCE), false, "no affordance without a replacement block");
  assert.deepEqual(parseRejectionCarryover(body), [], "the reserved grammar never reaches the comment");
  assert.ok(body.includes("**⚠️ Major (security):** m"), "severity and category survive");
  assert.ok(body.includes("Suggested agent prompt"), "the agent prompt survives");
  assert.equal(recoverPublishedSuggestion(body), null, "nothing a later run could recover");
});

test("#1101: the strip never shifts a multi-line range, and only the recovered range digest suppresses", () => {
  const foreign = prescriptionKeyDigest(prescriptionKey("new", 9, 9, "OTHER"));
  const finding = { file: "new", line: 1, end_line: 2, message: "m", suggestion: `R1\n<!-- pr-reviewer:rejected-prescriptions:v1:${foreign} -->\nR3` };
  const c = buildComments([finding], diff, 20, { forgejoPositions: false }).comments[0] as Record<string, unknown>;
  assert.deepEqual([c.line, c.side, c.start_line, c.start_side], [2, "RIGHT", 1, "RIGHT"], "the range is derived, never shifted or collapsed by the strip");

  const recovered = recoverPublishedSuggestion(c.body as string)!;
  assert.equal(recovered, "R1\nR3", "the published fence carries the stripped text only");
  const exact = prescriptionKeyDigest(prescriptionKey("new", 1, 2, recovered));
  const rerun = buildComments([finding], diff, 20, { forgejoPositions: false, rejectedPrescriptions: new Set([exact]) });
  assert.equal(rerun.suppressed, 1, "the recovered text over the same range is the suppressing digest");
  assert.equal(((rerun.comments[0] as Record<string, unknown>).body as string).includes("```suggestion"), false);

  // A collapsed range names a DIFFERENT prescription and must not suppress.
  for (const [start, end] of [[1, 1], [2, 2]] as const) {
    const other = buildComments([finding], diff, 20, {
      forgejoPositions: false, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", start, end, recovered))]),
    });
    assert.equal(other.suppressed, 0, `a ${start}-${end} digest does not suppress a 1-2 prescription`);
    assert.ok(((other.comments[0] as Record<string, unknown>).body as string).includes("```suggestion"));
  }
});

test("#1101: a near-miss marker line stays verbatim content — strip and parse are one predicate", () => {
  const d = prescriptionKeyDigest(prescriptionKey("new", 1, 1, "OTHER"));
  const canonical = `<!-- pr-reviewer:rejected-prescriptions:v1:${d} -->`;
  for (const nearMiss of [
    `<!-- pr-reviewer:rejected-prescriptions:v1:${d.toUpperCase()} -->`,
    `<!-- pr-reviewer:rejected-prescriptions:v1:${d.slice(0, 63)} -->`,
    `${canonical} trailing`,
  ]) {
    const finding = { file: "new", line: 1, message: "m", suggestion: `ok\n${nearMiss}\nkeep` };
    const published = (buildComments([finding], diff, 20, { forgejoPositions: false }).comments[0] as Record<string, unknown>).body as string;
    assert.ok(published.includes(nearMiss), "a line the parser would refuse is retained, not silently deleted");
    assert.equal(published.split("\n").some((line) => line === canonical), false, "no line of our own comment is the canonical grammar");
    assert.deepEqual(parseRejectionCarryover(published), [], "and it parses as nothing");
    assert.equal(stripRejectionCarryover(published), published, "the published body is strip-stable");

    const recovered = recoverPublishedSuggestion(published)!;
    assert.equal(recovered, `ok\n${nearMiss}\nkeep`);
    const fromPublished = prescriptionKeyDigest(prescriptionKey("new", 1, 1, recovered));
    const rerun = buildComments([finding], diff, 20, { forgejoPositions: false, rejectedPrescriptions: new Set([fromPublished]) });
    assert.equal(rerun.suppressed, 1, "publish, recover, digest, re-run suppresses");
  }
});

test("#1101: a CRLF suggestion recovers verbatim — the \\r stays in the digest", () => {
  const finding = { file: "new", line: 1, message: "m", suggestion: "R1\r\nR2" };
  const published = (buildComments([finding], diff, 20, { forgejoPositions: false }).comments[0] as Record<string, unknown>).body as string;
  const recovered = recoverPublishedSuggestion(published)!;
  assert.equal(recovered, finding.suggestion, "recovery is verbatim; stripping the \\r here would desync digest and body");
  const rerun = buildComments([finding], diff, 20, {
    forgejoPositions: false, rejectedPrescriptions: new Set([prescriptionKeyDigest(prescriptionKey("new", 1, 1, recovered))]),
  });
  assert.equal(rerun.suppressed, 1, "a verbatim body echo still suppresses");
});

test("#1101: Forgejo degraded mode publishes no grammar and carries exactly one authentic marker", () => {
  const foreign = prescriptionKeyDigest(prescriptionKey("new", 2, 2, "OTHER"));
  const finding = { file: "new", line: 2, message: "m", suggestion: `REPL\n<!-- pr-reviewer:rejected-prescriptions:v1:${foreign} -->` };
  const published = (buildComments([finding], diff, 20, { forgejoPositions: true }).comments[0] as Record<string, unknown>).body as string;
  assert.ok(published.includes("this forge cannot apply a one-click suggestion") && published.includes("REPL"));
  assert.deepEqual(parseRejectionCarryover(published), [], "the degraded block carries no grammar");

  const digest = prescriptionKeyDigest(prescriptionKey("new", 2, 2, "REPL"));
  const rerun = buildComments([finding], diff, 20, { forgejoPositions: true, rejectedPrescriptions: new Set([digest]) });
  const body = (rerun.comments[0] as Record<string, unknown>).body as string;
  assert.equal(rerun.suppressed, 1, "the same range and replacement text suppresses");
  assert.equal(body.includes("this forge cannot apply a one-click suggestion"), false, "the replacement block is dropped");
  assert.equal(body.includes(FEEDBACK_AFFORDANCE), false);
  assert.ok(body.includes("**Info:** m"), "the finding still posts");
  assert.deepEqual(parseRejectionCarryover(body), [digest], "exactly one marker, and it is ours");
  assert.equal(body.split("pr-reviewer:rejected-prescriptions:v1:").length - 1, 1);
});

// ---------------------------------------------------------------------------
// #1107: the reserved prescription opener on the model-authored surfaces.
// ---------------------------------------------------------------------------

/** The boundary token ITSELF, in the exact spelling a model would emit: an
 * opener line, replacement-looking content, and a closing fence. A paraphrase
 * ("a suggestion fence") would prove nothing about the real byte sequence. */
const HOSTILE_OPENER = "```suggestion\nINJECTED\n```";

test("#1107: #252 discipline — a message carrying the opener itself publishes no prescription and recovers nothing", () => {
  // #252: feed the boundary token, not a paraphrase of it. The message arrives
  // with a live-looking ```suggestion region already inside it; publication
  // never validated one, so none may reach the comment.
  const hostile = buildComments(
    [{ file: "new", line: 1, message: `review note\n${HOSTILE_OPENER}\ntrailing prose` }],
    diff, 20, { forgejoPositions: false },
  );
  assert.equal(hostile.comments.length, 1, "the finding still posts");
  const body = (hostile.comments[0] as Record<string, unknown>).body as string;
  assert.equal(body.includes("```suggestion"), false, "the body carries no live prescription region");
  assert.equal(body.split("\n").some((line) => line === "```suggestion"), false, "no line of our comment IS the opener");
  // The author's prose survives; only the fence is gone, so they still read the
  // word they wrote.
  assert.ok(body.includes("review note") && body.includes("INJECTED") && body.includes("trailing prose"));
  assert.ok(body.includes("\nsuggestion\n"), "the bare word survives, unfenced");
  // No prescription this run validated => nothing to recover: the hostile
  // opener can no longer make recovery bail (the "several openers" arm) or
  // mis-read a region we never published.
  assert.equal(recoverPublishedSuggestion(body), null, "a body with no validated prescription recovers nothing");

  // Paired control 1: a message with no token renders byte-identically to the
  // pre-#1107 renderer — the reservation is a no-op, not a rewrite.
  assert.deepEqual(
    buildComments([{ file: "new", line: 1, message: "first" }], diff, 20, { forgejoPositions: false }).comments[0],
    { path: "new", body: "**Info:** first\n\n_Automated finding from AI PR review._", line: 1, side: "RIGHT" },
  );

  // Paired control 2: a benign message on a finding that DOES carry a valid
  // suggestion still publishes and recovers it verbatim.
  const valid = (buildComments(
    [{ file: "new", line: 1, message: "first", suggestion: "R1\nR2\n" }], diff, 20, { forgejoPositions: false },
  ).comments[0] as Record<string, unknown>).body as string;
  assert.ok(valid.includes("```suggestion"), "the validated prescription still renders");
  assert.equal(recoverPublishedSuggestion(valid), "R1\nR2", "recovery is unchanged for the region we published");

  // Paired control 3: a hostile message cannot poison the validated region on
  // the SAME comment — the body's own opener is the only one, and the stray
  // fence the message left behind precedes it, so recovery still reads exactly
  // the replacement we published.
  const mixed = (buildComments(
    [{ file: "new", line: 1, message: HOSTILE_OPENER, suggestion: "REPL" }], diff, 20, { forgejoPositions: false },
  ).comments[0] as Record<string, unknown>).body as string;
  assert.equal(mixed.split("```suggestion").length - 1, 1, "exactly one opener line exists in the body");
  assert.equal(recoverPublishedSuggestion(mixed), "REPL", "the validated replacement is recovered verbatim");
  assertRenderedPrescription(mixed, "REPL", "the hostile block's dissolved closer cannot capture the region we published");

  // #252: the opener is not reserved by accident of where the template happens
  // to put its text. Severity and category are model-authored too and are
  // spliced into the label; a token behind our own `:**` reads as an info
  // string, not a suggestion, so what is pinned here is the invariant — no line
  // of our comment IS an opener, and nothing is recoverable.
  const spliced = (buildComments(
    [{ file: "new", line: 1, severity: "major\n```suggestion", category: "cat\n```suggestion", message: "m" }],
    diff, 20, { forgejoPositions: false },
  ).comments[0] as Record<string, unknown>).body as string;
  assert.equal(spliced.split("\n").some((line) => line.trim() === "```suggestion"), false, "no opener line survives a label/category splice");
  // Discriminator: the severity field's own opener is reserved BEFORE assembly,
  // so it does not survive as a fence sitting mid-label. (Without that pass the
  // body starts "**major\n```suggestion (cat" and nothing else here fails.)
  assert.ok(spliced.includes("\nsuggestion (cat"), `severity opener reserved before assembly: ${JSON.stringify(spliced)}`);
  assert.ok(spliced.includes("major") && spliced.includes("cat") && spliced.includes("_Automated finding from AI PR review._"));
  assert.equal(recoverPublishedSuggestion(spliced), null, "and nothing a later run could recover");
});

test("#1107: every spelling of the opener is reserved — indent, longer fence, tilde, uppercase, CRLF", () => {
  for (const opener of [
    "```suggestion",
    "  ```suggestion",
    "\t```suggestion",
    "````suggestion",
    "~~~suggestion",
    "~~~SUGGESTION  ",
    "```suggestion\r",
  ]) {
    const label = JSON.stringify(opener);
    const finding = { file: "new", line: 1, message: `head\n${opener}\nINJECTED\n\`\`\`` };
    const result = buildComments([finding], diff, 20, { forgejoPositions: false });
    assert.equal(result.comments.length, 1, `${label}: the finding still posts`);
    const body = (result.comments[0] as Record<string, unknown>).body as string;
    assert.equal(body.includes("```suggestion"), false, `${label}: no live prescription region`);
    assert.equal(body.split("\n").some((line) => line.trim() === "```suggestion"), false, `${label}: no opener line survives`);
    assert.ok(body.includes("INJECTED"), `${label}: the author's prose survives`);
    assert.equal(recoverPublishedSuggestion(body), null, `${label}: nothing a later run could recover`);
  }
});

/** Rendering-sensitive check the #1107 review round asked for: walk the body
 * the way a Markdown renderer tracks fence state instead of counting raw
 * opener lines. Exactly one live ```` ```suggestion ```` opener may occur
 * outside any fence, it must carry exactly the validated replacement, and the
 * body must end fence-closed — no model-authored fence may still be open where
 * the action's own region (or anything else) is appended. */
function assertRenderedPrescription(body: string, replacement: string, message?: string): void {
  const lines = body.split(/\r\n|\n|\r/);
  let open: { ch: string; len: number } | null = null;
  let inPrescription: string[] | null = null;
  const prescriptions: string[] = [];
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
    const realFence = match !== null && !(match[1]![0] === "`" && match[2]!.includes("`"));
    if (open !== null) {
      if (realFence && match![1]![0] === open.ch && match![1]!.length >= open.len && line.trim() === match![1]) {
        if (inPrescription !== null) prescriptions.push(inPrescription.join("\n"));
        inPrescription = null;
        open = null;
      } else if (inPrescription !== null) {
        inPrescription.push(line);
      }
      continue;
    }
    if (realFence) {
      open = { ch: match![1]![0]!, len: match![1]!.length };
      inPrescription = line === "```suggestion" ? [] : null;
    }
  }
  assert.deepEqual(prescriptions, [replacement], message ?? "exactly one live prescription renders, carrying the validated replacement");
  assert.equal(open, null, `${message ?? "body"}: ends fence-closed, so nothing the model wrote captures appended content`);
}

test("#1107 review round: the dissolved hostile block cannot capture the validated prescription", () => {
  // The adversarial shape behind the request-changes review: reserving only
  // the opener left the hostile block's closing fence as a live plain-fence
  // opener, and the action-authored suggestion region appended after it was
  // swallowed as that fence's content — a validated prescription rendered
  // inert. Each arm pairs a hostile message with a REAL suggestion and checks
  // the rendered fence state, not raw line counts.
  const arms: Array<[string, string]> = [
    ["paired hostile block", `note\n${HOSTILE_OPENER}\ntail`],
    ["unclosed hostile opener", "head\n```suggestion"],
    ["fences nested inside the hostile block", "````suggestion\n```\n~~~\nINJECTED\n````"],
    ["tilde block after the opener", "```suggestion\n~~~\nINJECTED\n```"],
    ["lone-CR line endings (GitHub renders CR as a break)", "```suggestion\rINJECTED\r```"],
    // The review round's over-indented/tab shapes, WITH the closing fence the
    // reviewer flagged: the rewrite keeps the original indentation
    // (`indent + "suggestion"`), so the line is an indented code block (or, as
    // embedded here, a paragraph continuation) both before and after the
    // rewrite — its matching closer is inert in both renderings, and the
    // appended validated prescription stays live.
    ["over-indented opener with its own closer", "head\n    ```suggestion\nINJECTED\n    ```"],
    ["tab-indented opener with its own closer", "head\n\t```suggestion\nINJECTED\n\t```"],
    ["over-indented opener after a blank line (indented code block)", "head\n\n    ```suggestion\nINJECTED\n    ```"],
  ];
  for (const [label, message] of arms) {
    const result = buildComments(
      [{ file: "new", line: 1, message, suggestion: "REPL" }], diff, 20, { forgejoPositions: false },
    );
    assert.equal(result.comments.length, 1, `${label}: the finding still posts`);
    const body = (result.comments[0] as Record<string, unknown>).body as string;
    assertRenderedPrescription(body, "REPL", label);
    assert.ok(body.includes("INJECTED") || !message.includes("INJECTED"), `${label}: the author's prose survives`);
    assert.equal(recoverPublishedSuggestion(body), "REPL", `${label}: recovery still reads exactly what rendered`);
  }

  // Dissolution must not over-reach: fences OUTSIDE the reserved block survive
  // byte-for-byte, and only the dissolved region's fences are neutralized.
  const benign = buildComments(
    [{
      file: "new", line: 1,
      message: "see:\n```ts\nconst x = 1;\n```\nand a ```suggestion``` mention",
      suggestion: "REPL",
    }],
    diff, 20, { forgejoPositions: false },
  );
  const benignBody = (benign.comments[0] as Record<string, unknown>).body as string;
  assert.ok(benignBody.includes("```ts\nconst x = 1;\n```"), "a benign code block in the same message is untouched");
  assertRenderedPrescription(benignBody, "REPL", "benign fences keep the region live");
});
