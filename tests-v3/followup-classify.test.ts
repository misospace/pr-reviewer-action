import test from "node:test";
import assert from "node:assert/strict";
import { classifyFollowUpComment, mentionsHandle, FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";

// #763: the deterministic follow-up classifier. Pure, forge-agnostic, and
// loop-safe: the reviewer's own comments are dropped before anything else, an
// explicit re-review command outranks a mention, and a question must be
// addressed to the reviewer (never fired by an arbitrary PR comment).

const BOT = "reviewer-bot";
const HANDLES = [BOT];

function classify(overrides: Partial<Parameters<typeof classifyFollowUpComment>[0]>) {
  return classifyFollowUpComment({
    body: "",
    authorLogin: "alice",
    botLogin: BOT,
    rereviewCommand: "/ai-review",
    mentionHandles: HANDLES,
    ...overrides,
  });
}

test("the reviewer's own comment is dropped (loop guard), even when it looks like work", () => {
  // A bot-authored question, command, or anything → ignored as bot-author.
  assert.deepEqual(classify({ body: `@${BOT} why this?`, authorLogin: "reviewer-bot" }), { intent: "ignored", reason: "bot-author" });
  assert.deepEqual(classify({ body: "/ai-review", authorLogin: "Reviewer-Bot" }), { intent: "ignored", reason: "bot-author" });
});

test("a managed review body is the reviewer's own, caught even with an unproven identity", () => {
  const managed = "<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:abcd -->\n## Review\n...";
  // Identity unproven (botLogin null), a "foreign" author — marker still wins.
  assert.deepEqual(classify({ body: managed, authorLogin: "someone", botLogin: null }), { intent: "ignored", reason: "managed-body" });
});

test("a follow-up reply the reviewer itself posted is caught even with an unproven identity (loop closure, #763)", () => {
  // The host stamps FOLLOWUP_REPLY_MARKER on its replies; a follow_up event on
  // the reviewer's OWN reply (identity not yet proven) must not classify as a
  // question and ping itself.
  const reply = `${FOLLOWUP_REPLY_MARKER}\n@alice the null check guards it — @reviewer-bot anything else?`;
  assert.deepEqual(classify({ body: reply, authorLogin: "some-author", botLogin: null }), { intent: "ignored", reason: "managed-body" });
});

test("the marker guard tolerates zero-width/whitespace obfuscation (not weaker than the renderer)", () => {
  const obfuscated = "text \u200b<!--\u200bai-pr-reviewer--> trailing";
  assert.deepEqual(classify({ body: obfuscated, authorLogin: "someone", botLogin: null }), { intent: "ignored", reason: "managed-body" });
});

test("an empty or whitespace body is not-addressed", () => {
  assert.deepEqual(classify({ body: "" }), { intent: "ignored", reason: "not-addressed" });
  assert.deepEqual(classify({ body: "   \n\t " }), { intent: "ignored", reason: "not-addressed" });
});

test("an explicit re-review command needs no mention; trailing text is not the command (#914 parity)", () => {
  assert.deepEqual(classify({ body: "/ai-review" }), { intent: "rereview" });
  assert.deepEqual(classify({ body: "/ai-review\n" }), { intent: "rereview" });
  // The command must be the WHOLE body (the shipped #914 v1 rule: arguments are
  // not parsed). With trailing text it is no longer the command, so a line that
  // also mentions the reviewer is classified as a question, not a re-review.
  assert.deepEqual(classify({ body: "/ai-review @reviewer-bot" }), { intent: "question", question: "/ai-review @reviewer-bot" });
  // A disabled command ("" ) does not match a command body.
  assert.deepEqual(classify({ body: "/ai-review", rereviewCommand: "" }), { intent: "ignored", reason: "not-addressed" });
  // A lookalike command with trailing text is not a command; no mention → ignored.
  assert.deepEqual(classify({ body: "/ai-review now" }), { intent: "ignored", reason: "not-addressed" });
});

test("a question must address the bot by handle", () => {
  const r = classify({ body: `@${BOT}, why did you flag line 42?` });
  assert.equal(r.intent, "question");
  assert.match(r.intent === "question" ? r.question : "", /why did you flag line 42/);
  // No mention → not-addressed (never fires model work on an arbitrary comment).
  assert.deepEqual(classify({ body: "I think this looks fine." }), { intent: "ignored", reason: "not-addressed" });
});

test("with no configured handle and an unproven identity, a question cannot fire", () => {
  assert.deepEqual(classify({ body: "@someone-else hello", mentionHandles: [] }), { intent: "ignored", reason: "bot-identity-unknown" });
  assert.deepEqual(classify({ body: "@reviewer-bot hi", mentionHandles: ["   "] }), { intent: "ignored", reason: "bot-identity-unknown" });
});

// ── mentionsHandle: adversarial boundaries ─────────────────────────────────

test("mentionsHandle matches a bounded @token, not a substring or an email", () => {
  assert.equal(mentionsHandle(`hey @${BOT} look`, HANDLES), true);
  assert.equal(mentionsHandle(`@${BOT}`, HANDLES), true);
  assert.equal(mentionsHandle(`@${BOT}, ping`, HANDLES), true); // punctuation ends the token
  assert.equal(mentionsHandle(`@${BOT}\nnew line`, HANDLES), true);
  // Case-insensitive.
  assert.equal(mentionsHandle(`@REVIEWER-BOT`, HANDLES), true);
  // A configured leading @ in the handle still matches.
  assert.equal(mentionsHandle(`@${BOT}`, ["@" + BOT]), true);
  // Substring / longer token is NOT a match.
  assert.equal(mentionsHandle("@reviewer-botxyz", HANDLES), false);
  // An email address must never read as a mention (the @ is not at a word start).
  assert.equal(mentionsHandle("email me at alice@reviewer-bot.com", HANDLES), false);
  assert.equal(mentionsHandle("see foo@reviewer-bot.example/docs", HANDLES), false);
  // A domain/path token (whitespace-preceded) is not a mention of the handle —
  // the token is terminated by `.` / `/`, so it cannot wrongly trigger work.
  assert.equal(mentionsHandle("ping @reviewer-bot.example now", HANDLES), false);
  assert.equal(mentionsHandle("@reviewer-bot.example", HANDLES), false);
  assert.equal(mentionsHandle("see @reviewer-bot/docs", HANDLES), false);
  // Real prose punctuation still terminates a valid mention.
  assert.equal(mentionsHandle("ping @reviewer-bot, thanks", HANDLES), true);
  assert.equal(mentionsHandle("@reviewer-bot (help)", HANDLES), true);
  // Multiple @ tokens, one matching.
  assert.equal(mentionsHandle("@carol and @reviewer-bot please", HANDLES), true);
  // A GitHub App bot login's bracket suffix.
  assert.equal(mentionsHandle("@my-app[bot] help", ["my-app[bot]"]), true);
  // Empty body.
  assert.equal(mentionsHandle("", HANDLES), false);
});
