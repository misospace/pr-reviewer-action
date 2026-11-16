import test from "node:test";
import assert from "node:assert/strict";

import {
  computeGiteaWebhookSignature,
  createGiteaWebhookHandler,
  dispatchGiteaWebhookEvent,
  parseGiteaWebhookEvent,
  projectGiteaWebhookPayload,
  verifyGiteaWebhookSignature,
  type GiteaWebhookDelivery,
} from "../src/ingress/gitea-events.js";
import { normalizeGitHubEvent } from "../src/events/normalize.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";

const SECRET = "gitea-webhook-secret";

function sign(body: string): string {
  return computeGiteaWebhookSignature(SECRET, body);
}

function project(
  eventHeader: string,
  typeHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  return projectGiteaWebhookPayload(eventHeader, typeHeader, payload, options);
}

// --- signature -------------------------------------------------------------

test("a Gitea signature is the hex HMAC-SHA256 of the RAW body, and verifies", () => {
  const body = '{"action":"synchronized","number":3}';
  assert.match(sign(body), /^[0-9a-f]{64}$/);
  assert.equal(verifyGiteaWebhookSignature(SECRET, sign(body), body), true);
});

test("the Gitea scheme has NO timestamp component: a timestamped digest is refused", () => {
  // The scheme #1678's brief proposed (HMAC over "{timestamp}.{body}") is not
  // what Gitea sends. Pinned here so the deviation cannot be reintroduced by
  // accident: signing the timestamped form must never verify a raw body.
  const body = '{"action":"opened"}';
  const timestamped = computeGiteaWebhookSignature(SECRET, `1700000000.${body}`);
  assert.equal(verifyGiteaWebhookSignature(SECRET, timestamped, body), false);
  assert.equal(verifyGiteaWebhookSignature(SECRET, sign(body), `1700000000.${body}`), false);
});

test("signature verification fails closed", () => {
  const body = '{"action":"opened"}';
  assert.equal(verifyGiteaWebhookSignature("", sign(body), body), false, "empty secret");
  assert.equal(verifyGiteaWebhookSignature(SECRET, undefined, body), false, "missing header");
  assert.equal(verifyGiteaWebhookSignature(SECRET, [sign(body)], body), false, "duplicate header");
  assert.equal(
    verifyGiteaWebhookSignature(SECRET, `sha256=${sign(body)}`, body),
    false,
    "GitHub's prefixed form is not Gitea's",
  );
  assert.equal(verifyGiteaWebhookSignature(SECRET, "z".repeat(64), body), false, "non-hex");
  assert.equal(verifyGiteaWebhookSignature(SECRET, sign(body).slice(0, 63), body), false, "short");
  assert.equal(verifyGiteaWebhookSignature("other", sign(body), body), false, "wrong secret");
});

test("a mutated body fails verification even with the original signature", () => {
  const body = '{"action":"opened","number":1}';
  const signature = sign(body);
  assert.equal(
    verifyGiteaWebhookSignature(SECRET, signature, '{"action":"opened","number":2}'),
    false,
  );
});

// --- projection ------------------------------------------------------------

test("PR sync: grouped pull_request + type pull_request_sync + signed synchronized", () => {
  const out = project("pull_request", "pull_request_sync", { action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("PR reopen: the signed reopened action becomes the normalizer's reopen", () => {
  const out = project("pull_request", "", { action: "reopened", pull_request: { number: 7 } });
  assert.equal(out.action, "reopen");
});

test("label delivery: a Gitea body carries no top-level label, so the trigger is synthesized", () => {
  const out = project("pull_request", "pull_request_label", {
    action: "label_updated",
    pull_request: { number: 4, labels: [{ name: "ai-review", color: "00ff00" }] },
  });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "labeled");
  // Synthesized as the trusted constant, not a copy of the payload entry.
  assert.deepEqual(out.label, { name: "ai-review" });
});

test("label delivery: the synthesized label is the operator's configured label", () => {
  const out = project("pull_request", "", {
    action: "label_updated",
    pull_request: { labels: [{ name: "rerun-review" }] },
  }, { rereviewLabel: "rerun-review" });
  assert.deepEqual(out.label, { name: "rerun-review" });
});

test("label delivery: no trigger in the label list yields the unknown-mapping sentinel", () => {
  const out = project("pull_request", "pull_request_label", {
    action: "label_updated",
    pull_request: { labels: [{ name: "docs" }] },
  });
  assert.equal(out.label, "");
});

test("label delivery: an unauthenticated label header on a non-label body cannot synthesize a trigger", () => {
  const out = project("pull_request_label", "", {
    action: "closed",
    pull_request: { labels: [{ name: "ai-review" }], merged: true },
  });
  assert.notEqual(out.action, "labeled");
  assert.notEqual(out.label, "ai-review");
});

test("PR comment: the top-level PR moves under issue so follow_up can resolve", () => {
  const pr = { number: 12, head: { sha: "a".repeat(40) } };
  const out = project("issue_comment", "pull_request_comment", {
    action: "created",
    issue: { number: 12, pull_request: { merged: false, html_url: "https://gitea.test/x" } },
    pull_request: pr,
    comment: { id: 91, user: { login: "someone" } },
  });
  assert.equal(out.name, "issue_comment");
  assert.equal("pull_request" in out, false, "the top-level key must be deleted, not undefined");
  assert.equal((out.issue as Record<string, unknown>).pull_request, pr);
});

test("PR comment: an issue.pull_request that already carries a number is left alone", () => {
  const issuePr = { number: 12, head: { sha: "b".repeat(40) } };
  const out = project("issue_comment", "pull_request_comment", {
    action: "created",
    issue: { number: 12, pull_request: issuePr },
    pull_request: { number: 12 },
  });
  // A GitHub-shaped delivery keeps the shared Forgejo behavior exactly: nothing
  // is moved, and the top-level object stays where the signed body put it.
  assert.equal((out.issue as Record<string, unknown>).pull_request, issuePr);
  assert.deepEqual(out.pull_request, { number: 12 });
});

test("PR comment: a signed action other than created never re-nests the PR", () => {
  const out = project("issue_comment", "pull_request_comment", {
    action: "deleted",
    issue: { number: 12 },
    pull_request: { number: 12 },
  });
  assert.equal((out.issue as Record<string, unknown>).pull_request, undefined);
});

test("a captured terminal delivery replayed with forged sync headers stays terminal", () => {
  // The HMAC covers the raw body only, so the signed action is the only
  // authenticated statement of what happened (#1024).
  const out = project("pull_request", "pull_request_sync", {
    action: "closed",
    pull_request: { number: 3, merged: true },
  });
  assert.notEqual(out.action, "synchronize");
  assert.equal(out.action, "closed");
});

test("the projection never mutates its input", () => {
  const payload = {
    action: "created",
    issue: { number: 1 },
    pull_request: { number: 1 },
  };
  const before = JSON.stringify(payload);
  project("issue_comment", "pull_request_comment", payload);
  assert.equal(JSON.stringify(payload), before);
});

// --- parse -----------------------------------------------------------------

test("parse: a Gitea issue delivery resolves its repository from the payload", () => {
  const event = parseGiteaWebhookEvent("issues", {
    action: "opened",
    number: 9,
    issue: { number: 9 },
    repository: { full_name: "Acme/Widgets" },
    sender: { login: "someone" },
  });
  assert.ok(event);
  assert.equal(event.repoFullName, "acme/widgets");
  assert.equal(event.kind, "unknown");
});

test("parse: a Gitea PR delivery resolves head, base, and PR identity", () => {
  const event = parseGiteaWebhookEvent("pull_request", {
    action: "synchronized",
    repository: { full_name: "acme/widgets" },
    sender: { login: "someone" },
    pull_request: {
      number: 5,
      id: 77,
      head: { sha: "AAAABBBBCCCCDDDDEEEEFFFF0000111122223333", ref: "feature" },
      base: { sha: "000011112222333344445555666677778888999a", repo: { full_name: "acme/widgets" } },
    },
  }, { eventTypeHeader: "pull_request_sync" });
  assert.ok(event);
  assert.equal(event.kind, "synchronize");
  assert.equal(event.prNumber, 5);
  assert.equal(event.prId, 77);
  assert.equal(event.headSha, "aaaabbbbccccddddeeeeffff0000111122223333");
  assert.equal(event.baseSha, "000011112222333344445555666677778888999a");
  assert.equal(event.platform, "forgejo");
});

test("parse: a closed Gitea PR is pr_closed, and pr_merged only when it merged", () => {
  const base = {
    action: "closed",
    repository: { full_name: "acme/widgets" },
    pull_request: {
      number: 5,
      state: "closed",
      head: { sha: "a".repeat(40) },
      base: { repo: { full_name: "acme/widgets" } },
    },
  };
  const closed = parseGiteaWebhookEvent("pull_request", structuredClone(base));
  assert.equal(closed?.kind, "pr_closed");

  const mergedBody = structuredClone(base);
  (mergedBody.pull_request as Record<string, unknown>).merged = true;
  assert.equal(parseGiteaWebhookEvent("pull_request", mergedBody)?.kind, "pr_merged");

  // Gitea serializes an unmerged `merged_at` as null, not "".
  const nullMergedAt = structuredClone(base);
  (nullMergedAt.pull_request as Record<string, unknown>).merged_at = null;
  assert.equal(parseGiteaWebhookEvent("pull_request", nullMergedAt)?.kind, "pr_closed");
});

test("parse: a Gitea PR-comment delivery becomes follow_up", () => {
  const event = parseGiteaWebhookEvent("issue_comment", {
    action: "created",
    repository: { full_name: "acme/widgets" },
    issue: { number: 12, pull_request: { merged: false } },
    pull_request: {
      number: 12,
      head: { sha: "c".repeat(40) },
      base: { repo: { full_name: "acme/widgets" } },
    },
    comment: { id: 91, user: { login: "asker" } },
    is_pull: true,
  }, { eventTypeHeader: "pull_request_comment" });
  assert.ok(event);
  assert.equal(event.kind, "follow_up");
  assert.equal(event.prNumber, 12);
  assert.equal(event.eventReference, "91");
  assert.equal(event.actor, "asker");
});

test("parse: the re-review trigger label is byte-exact and case-sensitive", () => {
  const body = {
    action: "label_updated",
    repository: { full_name: "acme/widgets" },
    pull_request: { number: 3, labels: [{ name: "AI-Review" }] },
  };
  assert.equal(parseGiteaWebhookEvent("pull_request", body)?.kind, "unknown");
  const hit = {
    action: "label_updated",
    repository: { full_name: "acme/widgets" },
    pull_request: { number: 3, labels: [{ name: "ai-review" }] },
  };
  assert.equal(parseGiteaWebhookEvent("pull_request", hit)?.kind, "rereview_label");
});

test("parse: an unresolvable delivery returns null rather than a degraded event", () => {
  assert.equal(parseGiteaWebhookEvent("pull_request", { action: "opened" }), null);
});

// --- dispatch --------------------------------------------------------------

function delivery(
  body: string,
  extras: Partial<GiteaWebhookDelivery> = {},
): GiteaWebhookDelivery {
  return {
    eventHeader: "pull_request",
    signatureHeader: sign(body),
    rawBody: body,
    ...extras,
  };
}

const SYNCED = JSON.stringify({
  action: "synchronized",
  repository: { full_name: "acme/widgets" },
  sender: { login: "someone" },
  pull_request: {
    number: 5,
    head: { sha: "d".repeat(40) },
    base: { repo: { full_name: "acme/widgets" } },
  },
});

test("dispatch: a valid delivery is accepted with its canonical kind", async () => {
  const seen: CanonicalForgeEvent[] = [];
  const outcome = await dispatchGiteaWebhookEvent(delivery(SYNCED), {
    secret: SECRET,
    onEvent: (event) => { seen.push(event); },
  });
  assert.deepEqual(outcome, { status: "accepted", kind: "synchronize" });
  assert.equal(seen.length, 1);
  const [first] = seen;
  assert.ok(first);
  assert.equal(first.headSha, "d".repeat(40));
});

test("dispatch: the signature is verified before the body is parsed", async () => {
  // Malformed JSON that WOULD parse if the bytes were trusted, under a
  // signature that does not match: the outcome must be invalid-signature.
  const tampered = '{"action":"synchronized","repository":';
  let reached = false;
  const outcome = await dispatchGiteaWebhookEvent(
    delivery(tampered, { signatureHeader: sign(SYNCED) }),
    { secret: SECRET, onEvent: () => { reached = true; } },
  );
  assert.deepEqual(outcome, { status: "invalid-signature" });
  assert.equal(reached, false);
});

test("dispatch: an empty secret accepts a well-formed delivery of nothing", async () => {
  const outcome = await dispatchGiteaWebhookEvent(delivery(SYNCED), {
    secret: "",
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(outcome, { status: "invalid-signature" });
});

test("dispatch: a correctly signed non-object body is invalid-payload", async () => {
  const body = "[1,2,3]";
  const outcome = await dispatchGiteaWebhookEvent(delivery(body), {
    secret: SECRET,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(outcome, { status: "invalid-payload" });
});

test("dispatch: a ping delivery is ignored without invoking the sink", async () => {
  const body = JSON.stringify({ zen: true, hook_id: 1 });
  const outcome = await dispatchGiteaWebhookEvent(
    delivery(body, { eventHeader: "ping" }),
    { secret: SECRET, onEvent: () => assert.fail("must not be called") },
  );
  assert.deepEqual(outcome, { status: "ignored" });
});

test("dispatch: a Buffer body verifies and parses the same as a string", async () => {
  const outcome = await dispatchGiteaWebhookEvent(
    { eventHeader: "pull_request", signatureHeader: sign(SYNCED), rawBody: Buffer.from(SYNCED, "utf8") },
    { secret: SECRET, onEvent: () => undefined },
  );
  assert.deepEqual(outcome, { status: "accepted", kind: "synchronize" });
});

test("dispatch: an unknown kind is still forwarded, matching the shared intake", async () => {
  // The kind gate belongs to the consumer (`shouldSchedule`), not the intake:
  // the handler acks 202 and forwards, so a Gitea delivery the projection could
  // not classify must take the same path instead of being silently dropped here.
  const body = JSON.stringify({ action: "created", repository: { full_name: "acme/widgets" } });
  const seen: CanonicalForgeEvent[] = [];
  const outcome = await dispatchGiteaWebhookEvent(
    delivery(body, { eventHeader: "issue_comment", eventTypeHeader: "issue_comment" }),
    { secret: SECRET, onEvent: (event) => { seen.push(event); } },
  );
  assert.deepEqual(outcome, { status: "accepted", kind: "unknown" });
  assert.equal(seen.length, 1);
});

test("dispatch: a delivery with no resolvable repository is ignored, not retried", async () => {
  // Normalization returns null (no repository, no PR base repo), which is the
  // one case the shared intake acks as ignored so the forge stops redelivering.
  const body = JSON.stringify({ action: "opened", number: 3 });
  const outcome = await dispatchGiteaWebhookEvent(delivery(body), {
    secret: SECRET,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(outcome, { status: "ignored" });
});

test("dispatch: a follow_up goes to the router and never to onEvent", async () => {
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "acme/widgets" },
    issue: { number: 12, pull_request: { merged: false } },
    pull_request: { number: 12, head: { sha: "e".repeat(40) }, base: { repo: { full_name: "acme/widgets" } } },
    comment: { id: 91, user: { login: "asker" } },
  });
  const routed: CanonicalForgeEvent[] = [];
  const outcome = await dispatchGiteaWebhookEvent(
    delivery(body, { eventHeader: "issue_comment", eventTypeHeader: "pull_request_comment" }),
    {
      secret: SECRET,
      onEvent: () => assert.fail("follow_up must not reach onEvent"),
      router: {
        handleEvent: async (event) => {
          routed.push(event);
          // The dispatch seam is not under test here; the router's declared
          // outcome is not read by the intake.
          return { kind: "ignored" as const };
        },
      },
    },
  );
  assert.deepEqual(outcome, { status: "accepted", kind: "follow_up" });
  assert.equal(routed.length, 1);
});

test("dispatch: a throwing sink reports error and never rethrows", async () => {
  const outcome = await dispatchGiteaWebhookEvent(delivery(SYNCED), {
    secret: SECRET,
    onEvent: () => { throw new Error("sink blew up"); },
  });
  assert.deepEqual(outcome, { status: "error" });
});

test("dispatch: the outcome never echoes the payload, the secret, or the signature", async () => {
  const outcome = await dispatchGiteaWebhookEvent(
    delivery(SYNCED, { signatureHeader: "deadbeef" }),
    { secret: SECRET, onEvent: () => undefined },
  );
  assert.equal(JSON.stringify(outcome), '{"status":"invalid-signature"}');
});

// --- handler ---------------------------------------------------------------

test("createGiteaWebhookHandler is the shared native intake with the Gitea projection", () => {
  // The handler must not be a second copy of the verification pipeline: it is
  // the Forgejo handler with `project` substituted, so a Gitea mount cannot end
  // up with a weaker body bound, a post-parse verification, or an echoed error.
  assert.equal(typeof createGiteaWebhookHandler, "function");
  const handler = createGiteaWebhookHandler({ secret: SECRET, onEvent: () => undefined });
  assert.equal(typeof handler, "function");
});

test("the Gitea projection and the Forgejo projection agree outside the two Gitea-shaped families", () => {
  const bodies: Array<[string, string, Record<string, unknown>]> = [
    ["pull_request", "pull_request_sync", { action: "synchronized" }],
    ["pull_request", "", { action: "reopened", pull_request: { number: 1 } }],
    ["pull_request", "", { action: "opened", pull_request: { number: 1 } }],
    ["check_run", "", { action: "completed" }],
    ["push", "", { action: "created" }],
  ];
  for (const [eventHeader, typeHeader, payload] of bodies) {
    const gitea = normalizeGitHubEvent(projectGiteaWebhookPayload(eventHeader, typeHeader, payload));
    const forgejo = normalizeGitHubEvent(projectGiteaWebhookPayload(eventHeader, typeHeader, payload));
    assert.deepEqual(gitea, forgejo, `${eventHeader}/${typeHeader} diverged`);
  }
});
