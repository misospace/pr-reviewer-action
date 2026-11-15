/** The follow-up answer executor (#1294): one bounded follow-up answer
 * through the SAME model/transport path the review uses, with the verdict
 * surface off. The lane is one-shot by contract — a cheap answer is skipped,
 * not retried — which is why it must not carry a wire surface it cannot
 * degrade away (#1655 review). */

import test from "node:test";
import assert from "node:assert/strict";

import { createFollowUpAnswerExecutor, type FollowUpAnswerProfile } from "../src/followup/executor.js";
import { TransportFailure } from "../src/transport/http.js";
import type { ApiFormat, TransportWirePayload } from "../src/model/types.js";

function profile(overrides: Partial<FollowUpAnswerProfile> = {}): FollowUpAnswerProfile {
  return {
    baseUrl: "https://api.example.com",
    model: "answer-model",
    apiFormat: "anthropic",
    apiKey: "answer-key",
    reasoningEffort: "",
    anthropicEffortSupported: false,
    requestTimeoutSec: 10,
    connectTimeoutSec: 5,
    ...overrides,
  };
}

function okOutcome(content: string) {
  return {
    status: "ok" as const,
    raw: { content: [{ type: "text", text: content }] },
    response: {
      id: "", object: "chat.completion" as const, model: "answer-model",
      content, toolCalls: [], finishReason: "stop", usage: null, error: undefined,
    },
  };
}

test("#1655 review: the answer executor's Anthropic request carries no prompt-cache checkpoint", async () => {
  // The executor is one-shot (no retry loop), so it cannot degrade a
  // gateway that rejects the cache marker: it would answer 400 and no
  // answer would be posted. The lane therefore sends the plain-string system
  // prompt it always sent.
  const payloads: TransportWirePayload[] = [];
  const answer = await createFollowUpAnswerExecutor(profile(), {
    transport: async () => okOutcome("the answer"),
    onPayload: (payload) => { payloads.push(payload); },
  })("What does this PR change?");
  assert.equal(answer, "the answer");
  assert.equal(payloads.length, 1);
  const body = payloads[0]!.body as unknown as Record<string, unknown>;
  assert.equal(body.system, "You are the AI pull-request reviewer answering one follow-up question in a PR conversation. Reply with the answer text only.");
  assert.equal(JSON.stringify(body).includes("cache_control"), false, "no cache marker on the answer lane's wire");
});

test("the answer executor sends no answer when nothing is configured", async () => {
  let called = false;
  const answer = await createFollowUpAnswerExecutor(profile({ model: "" }), {
    transport: async () => {
      called = true;
      return okOutcome("never");
    },
  })("What does this PR change?");
  assert.equal(answer, "");
  assert.equal(called, false, "an unconfigured lane never reaches the wire");
});

test("the answer executor degrades to no answer when the transport fails", async () => {
  const apiFormats: ApiFormat[] = ["anthropic", "openai"];
  for (const apiFormat of apiFormats) {
    const answer = await createFollowUpAnswerExecutor(profile({ apiFormat }), {
      transport: async () => ({
        status: "failure" as const,
        failure: new TransportFailure("http_status", "model endpoint returned HTTP 400", { status: 400 }),
      }),
    })("What does this PR change?");
    assert.equal(answer, "", `the ${apiFormat} lane degrades to no answer`);
  }
});
