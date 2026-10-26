import test from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOWUP_REPLY_MARKER,
  classifyFollowUpComment,
  renderFollowUpReply,
} from "../src/followup/index.js";
import { renderPrThread } from "../src/context/pr-thread.js";
import { GitHubPublishApi } from "../src/platform/publish-api.js";
import type { FetchLike } from "../src/platform/http.js";

// #763 review round: the reply-marker contract has ONE authoritative
// renderer. `renderFollowUpReply` stamps FOLLOWUP_REPLY_MARKER;
// `postIssueComment` writes the body VERBATIM (adds/strips nothing). These
// tests pin the complete producer → write → classifier/consumer path so the
// seam and the loop guard can never drift apart again.

function recorder(): { fetchImpl: FetchLike; postedBodies: string[] } {
  const postedBodies: string[] = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const raw = typeof init?.body === "string" ? init.body : null;
    postedBodies.push(String((JSON.parse(raw ?? "{}") as { body?: unknown }).body ?? ""));
    return new Response(JSON.stringify({ id: 500 }), { status: 201, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, postedBodies };
}

test("renderFollowUpReply stamps the loop-guard marker above the trimmed answer", () => {
  const body = renderFollowUpReply("  The null check on line 42 guards it. \n");
  assert.ok(body !== null);
  assert.ok(body.startsWith(FOLLOWUP_REPLY_MARKER));
  assert.equal(body.slice(FOLLOWUP_REPLY_MARKER.length).trim(), "The null check on line 42 guards it.");
});

test("renderFollowUpReply fails closed on an empty or whitespace-only answer", () => {
  assert.equal(renderFollowUpReply(""), null);
  assert.equal(renderFollowUpReply("   \n\t "), null);
  assert.equal(renderFollowUpReply(undefined as unknown as string), null);
});

test("full path: rendered reply posts verbatim and the classifier ignores it with an unproven identity", async () => {
  const answer = "The retry only fires on 5xx; see `transport.ts:88`.";
  const body = renderFollowUpReply(answer);
  assert.ok(body !== null);

  // Producer → write: the seam posts exactly the rendered body — it neither
  // adds a marker of its own nor strips the loop-guard marker.
  const { fetchImpl, postedBodies } = recorder();
  const api = new GitHubPublishApi({ repo: "o/r", prNumber: "9", token: "Bearer t", fetchImpl });
  const result = await api.postIssueComment!(body);
  assert.equal(result.ok, true);
  assert.equal(postedBodies.length, 1);
  assert.equal(postedBodies[0], body);

  // Write → classifier: the posted body is recognized as the reviewer's own
  // even when the bot identity CANNOT be proven (botLogin null), and even
  // when it embeds a command or a mention — the loop guard outranks both.
  const hostileQuote = `${body}\n\n/ai-review @reviewer-bot do it again`;
  assert.deepEqual(
    classifyFollowUpComment({
      body: postedBodies[0],
      authorLogin: "some-user",
      botLogin: null,
      rereviewCommand: "/ai-review",
      mentionHandles: ["reviewer-bot"],
    }),
    { intent: "ignored", reason: "managed-body" },
  );
  assert.deepEqual(
    classifyFollowUpComment({
      body: hostileQuote,
      authorLogin: "some-user",
      botLogin: null,
      rereviewCommand: "/ai-review",
      mentionHandles: ["reviewer-bot"],
    }),
    { intent: "ignored", reason: "managed-body" },
  );

  // Write → consumer: the posted reply is excluded from the thread context a
  // later answer is built from, while human discussion survives.
  const rendered = renderPrThread([
    { id: 1, user: { login: "human" }, created_at: "2026-10-01T00:00:00Z", body: "why does it retry here?" },
    { id: 2, user: { login: "some-user" }, created_at: "2026-10-01T00:01:00Z", body: postedBodies[0] },
  ]);
  assert.ok(rendered.includes("why does it retry here?"));
  assert.ok(!rendered.includes(FOLLOWUP_REPLY_MARKER));
  assert.ok(!rendered.includes("retry only fires on 5xx"));
});
