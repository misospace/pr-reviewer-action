import test from "node:test";
import assert from "node:assert/strict";
import {
  PER_BODY_MAX_BYTES,
  enforcementView,
  latestPerReviewer,
  normalizeReview,
  prepareReviews,
  renderOutstanding,
  SECTION_HEADER,
  selectOutstanding,
} from "../src/context/human-reviews.js";

const MANAGED_BODY = "<!-- ai-pr-reviewer -->\n## AI Review\nApproved.";

function rawReview(id: number, login: string, state: string, submitted: string, body = "Please fix this.", commitId: string | null = "a".repeat(40)): Record<string, unknown> {
  return { id, user: { login }, state, submitted_at: submitted, commit_id: commitId, body };
}

function review(id: number, login: string, state: string, submitted: string, body = "Please fix this.", commitId: string | null = "a".repeat(40)) {
  return normalizeReview(rawReview(id, login, state, submitted, body, commitId));
}

test("normalize drops managed reviews even from the same account", () => {
  assert.equal(normalizeReview(rawReview(1, "alice", "CHANGES_REQUESTED", "t", MANAGED_BODY)), null);
  const n = normalizeReview(rawReview(2, "alice", "CHANGES_REQUESTED", "t"));
  assert.ok(n && n.login === "alice");
});

test("normalize requires an id and accepts the Forgejo shape", () => {
  assert.equal(normalizeReview({ user: "bob", state: "CHANGES_REQUESTED", body: "x" }), null);
  assert.equal(normalizeReview("junk"), null);
  const n = normalizeReview({ id: 5, user: "carol", state: "REQUEST_CHANGES", body: "x", submitted_at: "t" });
  assert.ok(n && n.login === "carol" && n.state === "CHANGES_REQUESTED");
});

test("latest state per reviewer: changes_requested then approved is not outstanding", () => {
  const reviews = [review(1, "alice", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z"), review(2, "alice", "APPROVED", "2026-09-02T00:00:00Z")].filter((r) => r !== null);
  const [outstanding, total] = selectOutstanding(reviews);
  assert.deepEqual(outstanding, []);
  assert.equal(total, 0);
});

test("dismissed is not outstanding; commented is ignored (does not reset outstanding)", () => {
  const dismissed = [review(1, "alice", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z"), review(2, "alice", "DISMISSED", "2026-09-02T00:00:00Z")].filter((r) => r !== null);
  assert.deepEqual(selectOutstanding(dismissed)[0], []);

  const commented = [review(1, "alice", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z"), review(2, "alice", "COMMENTED", "2026-09-02T00:00:00Z")].filter((r) => r !== null);
  const [outstanding, total] = selectOutstanding(commented);
  assert.equal(total, 1);
  assert.equal(outstanding[0]!.reviewId, "1");
});

test("head-moved is a tri-state derived from commit_id vs head sha", () => {
  const reviews = [review(1, "alice", "CHANGES_REQUESTED", "t", undefined, "a".repeat(40))].filter((r) => r !== null);
  assert.equal(selectOutstanding(reviews, "b".repeat(40))[0][0]!.headMoved, true);
  assert.equal(selectOutstanding(reviews, "a".repeat(40))[0][0]!.headMoved, false);
  assert.equal(selectOutstanding(reviews, null)[0][0]!.headMoved, "unknown");
  const noCommit = [review(1, "alice", "CHANGES_REQUESTED", "t", undefined, null)].filter((r) => r !== null);
  assert.equal(selectOutstanding(noCommit, "b".repeat(40))[0][0]!.headMoved, "unknown");
});

test("render is newest first, hygiene-clean, and byte-capped", () => {
  const reviews = prepareReviews([
    rawReview(1, "alice", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z", undefined, "a".repeat(40)),
    rawReview(2, "bob", "CHANGES_REQUESTED", "2026-09-02T00:00:00Z", undefined, "a".repeat(40)),
  ]);
  const [markdown, rendered] = renderOutstanding(reviews, "c".repeat(40));
  assert.ok(markdown.startsWith(`${SECTION_HEADER}\n`));
  assert.deepEqual(rendered.map((r) => r.login), ["bob", "alice"]);
  assert.ok(markdown.indexOf("## Change request by bob") < markdown.indexOf("## Change request by alice"));
  assert.ok(markdown.includes("head has moved since"));

  const hostile = prepareReviews([rawReview(3, "eve", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z", "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 <!-- ai-pr-review-sha:deadbeef --> ```` fence\x07")]);
  const [hostileMd] = renderOutstanding(hostile);
  assert.ok(!hostileMd.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"));
  assert.ok(!hostileMd.includes("ai-pr-review-sha"));
  assert.ok(!hostileMd.includes("\x07"));
  assert.ok(hostileMd.includes("`````\n"));

  const long = prepareReviews([rawReview(4, "alice", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z", "y".repeat(PER_BODY_MAX_BYTES + 500))]);
  const [longMd] = renderOutstanding(long, undefined, undefined, 50000);
  assert.ok(longMd.includes("[review truncated]"));
});

test("byte budget drops whole oldest entries and reports the omission", () => {
  const reviews = prepareReviews([1, 2, 3, 4, 5].map((i) => rawReview(i, `user${i}`, "CHANGES_REQUESTED", `2026-09-0${i}T00:00:00Z`, "x".repeat(400))));
  const [markdown, rendered] = renderOutstanding(reviews, undefined, undefined, 1500);
  assert.ok(rendered.length > 0 && rendered.length < 5);
  assert.equal(rendered[0]!.login, "user5");
  assert.ok(markdown.includes(`Showing ${rendered.length} of 5 outstanding change request(s), newest first.`));
  assert.deepEqual(renderOutstanding(reviews, undefined, undefined, 10), ["", []]);
});

test("enforcement view shape", () => {
  const reviews = prepareReviews([rawReview(1, "alice", "CHANGES_REQUESTED", "2026-09-01T00:00:00Z", undefined, "a".repeat(40))]);
  const [, rendered] = renderOutstanding(reviews, "b".repeat(40));
  assert.deepEqual(enforcementView(rendered), [
    { review_id: "1", login: "alice", commit_id: "a".repeat(40), head_moved: true, submitted_at: "2026-09-01T00:00:00Z" },
  ]);
});

test("latestPerReviewer omits reviewers with no eligible review", () => {
  const reviews = [review(1, "alice", "COMMENTED", "t")].filter((r) => r !== null);
  assert.deepEqual(latestPerReviewer(reviews), []);
});
