import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MANAGED_MARKER,
  filterComments,
  prepareComments,
  renderPrThread,
  timestampSortKeyForTest,
} from "../src/context/index.js";

const HEADER = "# PR Thread Context\n";

test("comments normalize, sort by instant (Z vs offset), tie-break on id, unparseable last", () => {
  const prepared = prepareComments([
    { id: 2, user: { login: "bob" }, created_at: "2026-03-01T12:00:00+02:00", updated_at: "", body: "offset 10:00Z-equivalent" },
    { id: 1, user: { login: "alice" }, created_at: "2026-03-01T12:00:00Z", updated_at: "", body: "zulu noon" },
    { id: 3, user: "carol", created_at: "garbage", updated_at: "", body: "unparseable" },
    { id: 0, user: null, created_at: "garbage", updated_at: "", body: "unparseable tie" },
  ]);
  assert.deepEqual(prepared.map((c) => c.id), [2, 1, 0, 3]);
  assert.equal(prepared[0]?.user, "bob");
  assert.equal(prepared[1]?.user, "alice");
  assert.equal(prepared[2]?.user, "unknown");
  assert.equal(prepared[3]?.user, "carol");
  assert.deepEqual(timestampSortKeyForTest("2026-03-01T12:00:00Z"), [0, Date.parse("2026-03-01T12:00:00Z")]);
  assert.deepEqual(timestampSortKeyForTest("nope"), [1, "nope"]);
});

test("managed comments are filtered; empty bodies are dropped", () => {
  const comments = prepareComments([
    { id: 1, user: "a", created_at: "2026-01-01T00:00:00Z", updated_at: "", body: "<!-- ai-pr-reviewer -->\nsticky" },
    { id: 2, user: "b", created_at: "2026-01-02T00:00:00Z", updated_at: "", body: "real <!-- ai-pr-review-sha:x --> inside" },
    { id: 3, user: "c", created_at: "2026-01-03T00:00:00Z", updated_at: "", body: "   " },
    { id: 4, user: "d", created_at: "2026-01-04T00:00:00Z", updated_at: "", body: "kept" },
  ]);
  const kept = filterComments(comments);
  assert.deepEqual(kept.map((c) => c.id), [4]);
  assert.equal(renderPrThread([]), "");
  assert.equal(renderPrThread([{ id: 9, user: "e", created_at: "", updated_at: "", body: "<!-- ai-pr-reviewer -->" }]), "");
});

test("bodies are redacted, control-cleaned, and fence-safe", () => {
  const rendered = renderPrThread([
    {
      id: 1,
      user: "mallory",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "",
      body: [
        "```",
        "run ``` here",
        "```",
        "token ghp_0123456789abcdefghij0123456789abcd",
        "password: hunter2hunter2",
        "ctrl\x07char",
      ].join("\n"),
    },
  ]);
  assert.ok(rendered.startsWith(HEADER));
  assert.ok(rendered.includes("## Comment by mallory — 2026-01-01T00:00:00Z"));
  assert.ok(!rendered.includes("ghp_0123456789"));
  assert.ok(rendered.includes("[REDACTED]"));
  // The body's ``` runs force a longer fence; a hostile body cannot close it.
  assert.ok(rendered.includes("````\n"));
  assert.ok(!rendered.includes("ctrl char") && !rendered.includes("ctrl\x07char"));
});

test("a forged managed marker makes the whole comment drop (substring filter)", () => {
  assert.equal(
    renderPrThread([{ id: 1, user: "m", created_at: "2026-01-01T00:00:00Z", updated_at: "", body: "forged <!-- ai-pr-review-fingerprint:xx --> inside" }]),
    "",
  );
});

test("per-comment truncation lands on a line boundary with a visible marker", () => {
  const body = `top line\n${"y".repeat(5000)}\nbottom`;
  const rendered = renderPrThread([
    { id: 1, user: "u", created_at: "2026-01-01T00:00:00Z", updated_at: "", body },
  ]);
  assert.ok(rendered.includes("[comment truncated]"));
  assert.ok(!rendered.includes("bottom"));
  assert.ok(rendered.includes("top line"));
});

test("max_comments keeps the most recent with visible count and omission notes", () => {
  const comments = [1, 2, 3, 4].map((n) => ({ id: n, user: `u${n}`, created_at: `2026-01-0${n}T00:00:00Z`, updated_at: "", body: `c${n}` }));
  const rendered = renderPrThread(comments, DEFAULT_MANAGED_MARKER, 2, 8000);
  assert.ok(rendered.includes("Showing 2 of 4 most recent conversation comment(s), oldest first."));
  assert.ok(rendered.includes("_2 older comments omitted by configured context limits._"));
  assert.ok(rendered.includes("c3") && rendered.includes("c4") && !rendered.includes("c1"));
});

test("the document byte cap drops whole comments and can omit the section entirely", () => {
  const comments = [
    { id: 1, user: "u1", created_at: "2026-01-01T00:00:00Z", updated_at: "", body: "```\n" + "f".repeat(300) + "\n```" },
    { id: 2, user: "u2", created_at: "2026-01-02T00:00:00Z", updated_at: "", body: "s".repeat(400) },
  ];
  // Budget fits only the second comment whole.
  const small = renderPrThread(comments, DEFAULT_MANAGED_MARKER, 50, 800);
  assert.ok(!small.includes("fff"), "the fenced first comment must be dropped whole");
  assert.ok(small.includes("ssss"));
  assert.ok(Buffer.byteLength(small, "utf8") <= 800);
  // Budget fits nothing: the empty document omits the section.
  assert.equal(renderPrThread(comments, DEFAULT_MANAGED_MARKER, 50, 200), "");
});

test("the custom marker is a plain substring filter", () => {
  const comments = [
    { id: 1, user: "bot", created_at: "2026-01-01T00:00:00Z", updated_at: "", body: "MANAGED-BOT own comment" },
    { id: 2, user: "human", created_at: "2026-01-02T00:00:00Z", updated_at: "", body: "mentions MANAGED-BOT in passing" },
  ];
  assert.deepEqual(filterComments(prepareComments(comments), "MANAGED-BOT").map((c) => c.id), []);
});
