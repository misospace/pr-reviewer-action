import test from "node:test";
import assert from "node:assert/strict";
import {
  FINDING_TRAILER,
  PER_COMMENT_MAX_BYTES,
  enforcementView,
  normalizeThread,
  prepareThreads,
  renderReviewThreads,
  SECTION_HEADER,
} from "../src/context/review-threads.js";

const OWN_FINDING = "**⚠️ Major (bug):** retry drops the `--` separator\n\n" + FINDING_TRAILER;

function comment(id: number, login: string, created: string, body: string): Record<string, unknown> {
  return { id, user: { login }, created_at: created, updated_at: created, body };
}

function thread(threadId: string, comments: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { thread_id: threadId, path: "pr_reviewer/tool_executors.py", line: 593, original_line: 593, resolved: false, outdated: false, comments, ...extra };
}

test("threads normalize, recognize own findings, and sort replies chronologically", () => {
  const t = normalizeThread(thread("PRRT_1", [
    comment(2, "dev", "2026-09-26T02:00:00Z", "Fixed in 3e421a2."),
    comment(1, "bot", "2026-09-25T22:32:00Z", OWN_FINDING),
  ]));
  assert.ok(t);
  assert.deepEqual(t.comments.map((c) => c.id), [1, 2]);
  assert.equal(t.comments[0]!.own, true);
  assert.equal(t.comments[1]!.own, false);
  assert.equal(normalizeThread({ thread_id: "x", comments: [] }), null);
  assert.equal(normalizeThread("junk"), null);
  const forgejo = normalizeThread({ id: "a.py:3", path: "a.py", line: "3", comments: [{ id: 9, user: "carol", created_at: "", body: "x" }] });
  assert.equal(forgejo?.threadId, "a.py:3");
  assert.equal(forgejo?.line, 3);
});

test("render keeps unresolved threads newest first with replies and drops resolved ones", () => {
  const threads = prepareThreads([
    thread("OLD", [comment(1, "bot", "2026-09-25T20:00:00Z", OWN_FINDING), comment(2, "dev", "2026-09-25T21:00:00Z", "reply old")]),
    thread("DONE", [comment(3, "bot", "2026-09-25T22:00:00Z", OWN_FINDING)], { resolved: true }),
    thread("NEW", [comment(4, "bot", "2026-09-26T01:00:00Z", OWN_FINDING), comment(5, "dev", "2026-09-26T02:00:00Z", "reply new")], { line: 600 }),
  ]);
  const [markdown, rendered] = renderReviewThreads(threads);
  assert.ok(markdown.startsWith(`${SECTION_HEADER}\n`));
  assert.deepEqual(rendered.map((t) => t.threadId), ["NEW", "OLD"]);
  assert.ok(!markdown.includes("DONE"));
  assert.ok(markdown.indexOf("## Thread NEW") < markdown.indexOf("## Thread OLD"));
  assert.ok(markdown.includes("`pr_reviewer/tool_executors.py` line 600 (originally 593)"));
  assert.ok(markdown.includes("### Finding (this reviewer)"));
  assert.ok(markdown.includes("### Reply by dev"));
  assert.ok(!markdown.includes(FINDING_TRAILER));
});

test("bodies are redacted, marker-stripped, control-cleaned, fence-safe and capped", () => {
  const hostile = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 <!-- ai-pr-review-sha:deadbeef --> ```` fence\x07";
  const t = normalizeThread(thread("H", [comment(1, "bot", "2026-09-26T01:00:00Z", OWN_FINDING), comment(2, "eve", "2026-09-26T02:00:00Z", hostile)]))!;
  const [markdown] = renderReviewThreads([t]);
  assert.ok(!markdown.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"));
  assert.ok(!markdown.includes("ai-pr-review-sha"));
  assert.ok(!markdown.includes("\x07"));
  assert.ok(markdown.includes("`````\n"));
  const long = normalizeThread(thread("L", [comment(1, "bot", "2026-09-26T01:00:00Z", OWN_FINDING), comment(2, "dev", "2026-09-26T02:00:00Z", "y".repeat(PER_COMMENT_MAX_BYTES + 500))]))!;
  const [capped] = renderReviewThreads([long], undefined, 50000);
  assert.ok(capped.includes("[comment truncated]"));
});

test("byte budget drops whole oldest threads and reports the omission", () => {
  const threads = prepareThreads([1, 2, 3, 4, 5].map((i) => thread(`T${i}`, [comment(i, "bot", `2026-09-26T0${i}:00:00Z`, `${OWN_FINDING} ${"x".repeat(300)}`)])));
  const [markdown, rendered] = renderReviewThreads(threads, undefined, 1500);
  assert.ok(rendered.length > 0 && rendered.length < 5);
  assert.equal(rendered[0]!.threadId, "T5");
  assert.ok(markdown.includes(`Showing ${rendered.length} of 5 unresolved thread(s), newest first.`));
  assert.deepEqual(renderReviewThreads(threads, undefined, 10), ["", []]);
});

test("enforcement view parses severity and message from the finding body", () => {
  const t = normalizeThread(thread("PRRT_1", [comment(1, "bot", "2026-09-25T22:32:00Z", OWN_FINDING), comment(2, "dev", "2026-09-26T02:00:00Z", "reply")]))!;
  const human = normalizeThread(thread("H", [comment(3, "alice", "2026-09-26T03:00:00Z", "Should this handle None?")], { path: "a.py", line: 4 }))!;
  assert.deepEqual(enforcementView([t, human]), [
    { thread_id: "PRRT_1", path: "pr_reviewer/tool_executors.py", line: 593, severity: "major", message: "retry drops the `--` separator", own_finding: true, replies: 1 },
    { thread_id: "H", path: "a.py", line: 4, severity: "minor", message: "Should this handle None?", own_finding: false, replies: 0 },
  ]);
});
