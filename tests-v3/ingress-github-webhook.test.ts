import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createGitHubWebhookHandler,
  projectGitHubWebhookPayload,
  type GitHubWebhookHandlerOptions,
} from "../src/ingress/github-webhook-handler.js";
import { computeGitHubWebhookSignature } from "../src/ingress/github-app-signature.js";
import type { OperatorEventRouter } from "../src/ingress/operator-router.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";

// The GitHub App webhook intake (#729): the daemon's GitHub-side ingress.
//
// TRUST BOUNDARY under test:
// - the `X-Hub-Signature-256` HMAC is verified over the RAW body BEFORE any
//   parse (a body whose bytes changed after signing is refused, even when it
//   is valid JSON);
// - the `X-GitHub-Event` header is an UNAUTHENTICATED VOCABULARY HINT: it
//   supplies the event name GitHub never puts in the body, and a forged one
//   can only DEGRADE a delivery to `unknown` — never schedule one;
// - every response body is FIXED: the payload, the secret, the signature and
//   any error text are never echoed.
//
// No network beyond the local loopback harness.

const SECRET = "github-app-webhook-secret";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

/** The canonical kinds that mint a review generation — a forged header must
 *  never reach one of these. */
const SCHEDULEABLE_KINDS = new Set([
  "pr_opened",
  "pr_reopened",
  "synchronize",
  "ready_for_review",
  "rereview_label",
  "check_update",
]);

// ── helpers ─────────────────────────────────────────────────────────────────

interface TestHandler {
  url: string;
  events: CanonicalForgeEvent[];
  routed: CanonicalForgeEvent[];
  close: () => Promise<void>;
}

async function startTestHandler(
  overrides: Partial<GitHubWebhookHandlerOptions> = {},
  routed: CanonicalForgeEvent[] = [],
): Promise<TestHandler> {
  const events: CanonicalForgeEvent[] = [];
  const server: Server = createServer(
    createGitHubWebhookHandler({
      secret: SECRET,
      onEvent: (ev: CanonicalForgeEvent) => {
        events.push(ev);
      },
      ...overrides,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    events,
    routed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A REAL GitHub `pull_request` webhook payload (the event name lives in
 *  the header, never in the body). */
function makePrPayload(action: string, prExtras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    number: 7,
    pull_request: {
      number: 7,
      id: 4242,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
      ...prExtras,
    },
    repository: { full_name: "org/repo" },
    sender: { login: "octo" },
  };
}

/** A REAL GitHub `issue_comment` payload on a PR issue: the PR link is
 *  `issue.pull_request` (a url-only object) and the PR number comes from
 *  `issue.number`. */
function makeCommentPayload(action = "created"): Record<string, unknown> {
  return {
    action,
    issue: {
      number: 7,
      pull_request: { url: "https://api.github.com/repos/org/repo/pulls/7" },
    },
    comment: { id: 55, user: { login: "dev" } },
    repository: { full_name: "org/repo" },
    sender: { login: "dev" },
  };
}

interface PostOptions {
  event?: string;
  body?: string;
  signature?: string;
  method?: string;
}

async function post(
  url: string,
  opts: PostOptions = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.event !== undefined) headers["x-github-event"] = opts.event;
  if (opts.signature !== undefined) headers["x-hub-signature-256"] = opts.signature;
  const res = await fetch(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ?? null,
  });
  return { status: res.status, text: await res.text() };
}

function sign(body: string, secret: string = SECRET): string {
  return computeGitHubWebhookSignature(secret, body);
}

/** Raw node:http POST that can emit repeated header LINES (array value). */
function rawPost(
  url: string,
  headers: Record<string, string | string[]>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ── 1. happy path: a valid signed delivery → 202 + the canonical event ────

test("a valid signed pull_request/synchronize delivery → 202 with the canonical event", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });

  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" });
  assert.equal(h.events.length, 1);
  const ev = h.events[0]!;
  assert.equal(ev.platform, "github", "the GitHub intake yields GitHub canonical events");
  assert.equal(ev.source, "webhook");
  assert.equal(ev.kind, "synchronize");
  assert.equal(ev.repoFullName, "org/repo");
  assert.equal(ev.prNumber, 7);
  assert.equal(ev.prId, 4242);
  assert.equal(ev.headSha, HEAD_SHA);
  assert.equal(ev.baseSha, BASE_SHA);
  assert.equal(ev.fork, false);
  assert.equal(ev.actor, "octo");
});

// ── 2. the raw body is signed: bytes changed after signing → 401 ───────────

test("the raw body is signed: valid JSON whose bytes changed after signing → 401", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const signed = JSON.stringify(makePrPayload("synchronize"));
  // Same JSON meaning, different BYTES: the signature covers the raw body,
  // so this is refused even though the payload still parses.
  const tampered = JSON.stringify(makePrPayload("closed"));
  assert.notEqual(tampered, signed);
  const res = await post(h.url, {
    event: "pull_request",
    body: tampered,
    signature: sign(signed),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.text), { status: "invalid signature" });
  assert.equal(h.events.length, 0, "the tampered delivery never reaches the normalizer");
});

test("a whitespace-only change after signing → 401 (the HMAC covers the exact bytes)", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const padded = ` ${body}`;
  const res = await post(h.url, {
    event: "pull_request",
    body: padded,
    signature: sign(body),
  });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

// ── 3. auth failures: 401, zero events, nothing echoed ─────────────────────

test("an invalid signature → 401, onEvent never called, nothing echoed", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, {
    event: "pull_request",
    body,
    signature: sign(body, "the-wrong-secret"),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.text), { status: "invalid signature" });
  assert.equal(h.events.length, 0, "onEvent is never called for an unauthenticated delivery");
  assert.ok(!res.text.includes(SECRET), "the secret must never be echoed");
  assert.ok(!res.text.includes(body), "the payload must never be echoed");
  assert.ok(!res.text.includes("synchronize"), "the payload's content must never be echoed");
});

test("a missing x-hub-signature-256 → 401, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "pull_request", body });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

test("a Forgejo-style signature (bare hex, no sha256= prefix) → 401", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, {
    event: "pull_request",
    body,
    signature: sign(body).replace("sha256=", ""),
  });
  assert.equal(res.status, 401, "the two seams accept exactly what the other refuses");
  assert.equal(h.events.length, 0);
});

test("an empty configured secret accepts nothing", async (t) => {
  const h = await startTestHandler({ secret: "" });
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, {
    event: "pull_request",
    body,
    signature: computeGitHubWebhookSignature("", body),
  });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

// ── 4. the event header is required, single and shape-guarded ──────────────

test("a missing / duplicate / non-conforming x-github-event header → 400", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const signature = sign(body);

  const missing = await post(h.url, { body, signature });
  assert.equal(missing.status, 400);
  assert.deepEqual(JSON.parse(missing.text), { status: "invalid event header" });

  const spaced = await post(h.url, { event: "pull request", body, signature });
  assert.equal(spaced.status, 400);

  const tooLong = await post(h.url, { event: "a".repeat(65), body, signature });
  assert.equal(tooLong.status, 400);

  // Only raw node:http can emit repeated header LINES (an array value);
  // the handler must reject the array form rather than coerce it.
  const duplicate = await rawPost(
    h.url,
    {
      "x-github-event": ["pull_request", "pull_request"],
      "x-hub-signature-256": signature,
      "content-type": "application/json",
    },
    body,
  );
  assert.equal(duplicate.status, 400);
  assert.deepEqual(JSON.parse(duplicate.text), { status: "invalid event header" });

  assert.equal(h.events.length, 0, "no delivery without a well-formed event header is routed");
});

// ── 5. protocol rejections ─────────────────────────────────────────────────

test("a non-POST method → 405 with the fixed body", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const res = await post(h.url, { method: "GET" });
  assert.equal(res.status, 405);
  assert.deepEqual(JSON.parse(res.text), { status: "method not allowed" });
  assert.equal(h.events.length, 0);
});

test("malformed JSON with a VALID signature → 400 invalid json", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = "{not json";
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.text), { status: "invalid json" });
  assert.equal(h.events.length, 0);
});

test("malformed JSON with an INVALID signature → 401 (verify before parse)", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const res = await post(h.url, {
    event: "pull_request",
    body: "{not json",
    signature: "sha256=" + "0".repeat(64),
  });
  assert.equal(res.status, 401, "the signature is verified before the parser runs");
  assert.equal(h.events.length, 0);
});

test("a non-object payload with a valid signature → 400 invalid payload", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  for (const body of ["null", "[]"]) {
    const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
    assert.equal(res.status, 400, body);
    assert.deepEqual(JSON.parse(res.text), { status: "invalid payload" }, body);
  }
  assert.equal(h.events.length, 0);
});

// ── 6. the body size cap ───────────────────────────────────────────────────

test("an oversize body → 413 and the request stream is dropped", async (t) => {
  const h = await startTestHandler({ maxBodyBytes: 64 });
  t.after(() => h.close());
  const body = JSON.stringify({ ...makePrPayload("synchronize"), padding: "x".repeat(300) });
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.text), { status: "body too large" });
  assert.equal(h.events.length, 0);
});

test("after a 413 the same server still answers a valid delivery with 202", async (t) => {
  const h = await startTestHandler({ maxBodyBytes: 512 });
  t.after(() => h.close());
  const oversize = JSON.stringify({ ...makePrPayload("synchronize"), padding: "x".repeat(600) });
  const big = await post(h.url, {
    event: "pull_request",
    body: oversize,
    signature: sign(oversize),
  });
  assert.equal(big.status, 413);

  const body = JSON.stringify(makePrPayload("opened"));
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "pr_opened" });
  assert.equal(h.events.length, 1);
});

// ── 7. ping is acknowledged without dispatch ───────────────────────────────

test("a ping delivery with a valid signature → 200 ignored, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = "{}";
  const res = await post(h.url, { event: "ping", body, signature: sign(body) });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { status: "ignored" });
  assert.equal(h.events.length, 0);
  assert.equal(h.routed.length, 0);
});

// ── 8. the follow-up routing seam ──────────────────────────────────────────

test("an issue_comment/created delivery on a PR → follow_up routed to the router, not to onEvent", async (t) => {
  const routed: CanonicalForgeEvent[] = [];
  const h = await startTestHandler({ router: fakeRouter(routed) }, routed);
  t.after(() => h.close());
  const body = JSON.stringify(makeCommentPayload("created"));
  const res = await post(h.url, { event: "issue_comment", body, signature: sign(body) });

  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(h.events.length, 0, "a follow_up never reaches onEvent when a router is bound");
  assert.equal(h.routed.length, 1, "the router consumes the canonical follow-up");
  const ev = h.routed[0]!;
  assert.equal(ev.kind, "follow_up");
  assert.equal(ev.platform, "github");
  assert.equal(ev.prNumber, 7);
  assert.equal(ev.repoFullName, "org/repo");
  assert.equal(ev.eventReference, "55");
  assert.equal(ev.actor, "dev");
});

test("without a router a follow_up delivery goes to onEvent", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makeCommentPayload("created"));
  const res = await post(h.url, { event: "issue_comment", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "follow_up");
});

// ── 9. the header is an unauthenticated VOCABULARY hint ────────────────────
//
// The HMAC covers the body ONLY, so a captured delivery can be replayed
// byte-for-byte with a CHANGED event header. The signed action and the
// signed payload shape stay authoritative: a forged header can only
// DEGRADE a delivery to `unknown`, never schedule one.

test("a forged header degrades a signed delivery to unknown, never to a scheduleable kind", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());

  // A signed PR-shaped body whose action is NOT a PR action.
  const nonPrAction = JSON.stringify(makePrPayload("created"));
  // A signed PR-sync body (a scheduleable delivery on its own).
  const sync = JSON.stringify(makePrPayload("synchronize"));

  const forgeries: Array<{ header: string; body: string }> = [
    { header: "pull_request", body: nonPrAction },
    { header: "issue_comment", body: nonPrAction },
    { header: "issue_comment", body: sync },
    { header: "check_run", body: sync },
    { header: "status", body: sync },
  ];
  for (const forgery of forgeries) {
    const res = await post(h.url, {
      event: forgery.header,
      body: forgery.body,
      signature: sign(forgery.body),
    });
    assert.equal(res.status, 202, forgery.header);
    assert.deepEqual(
      JSON.parse(res.text),
      { status: "accepted", kind: "unknown" },
      `a forged "${forgery.header}" header must degrade to unknown`,
    );
  }
  assert.equal(h.events.length, forgeries.length);
  for (const ev of h.events) {
    assert.equal(ev.kind, "unknown");
    assert.equal(
      SCHEDULEABLE_KINDS.has(ev.kind),
      false,
      "a forged header must never reach a scheduleable kind",
    );
  }
});

test("a forged header never turns a signed non-comment body into a follow_up", async (t) => {
  const routed: CanonicalForgeEvent[] = [];
  const h = await startTestHandler({ router: fakeRouter(routed) }, routed);
  t.after(() => h.close());
  // The signed body is a PR-sync delivery; the header claims a comment.
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "issue_comment", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "unknown" });
  assert.equal(h.routed.length, 0, "the follow-up branch is never entered");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "unknown");
});

// ── 10. the projection itself ──────────────────────────────────────────────

test("the projection sets the name from the header only when the signed body carries none", () => {
  // No name/event in the body: the header supplies the vocabulary.
  const projected = projectGitHubWebhookPayload("pull_request", { action: "synchronize" });
  assert.equal(projected.name, "pull_request");
  assert.equal(projected.action, "synchronize", "the signed action is never rewritten");

  // The body states its own vocabulary: it wins (it is signed).
  const own = projectGitHubWebhookPayload("issue_comment", { name: "pull_request", action: "opened" });
  assert.equal(own.name, "pull_request", "the signed name is never overwritten by the header");
  assert.equal(own.action, "opened");

  // The `event` spelling counts as the body's own vocabulary too.
  const viaEvent = projectGitHubWebhookPayload("issue_comment", { event: "pull_request" });
  assert.equal(viaEvent.name, undefined);
  assert.equal(viaEvent.event, "pull_request");
});

test("the projection never mutates its input and always returns a copy", () => {
  const payload: Record<string, unknown> = { action: "synchronize", repository: { full_name: "org/repo" } };
  const projected = projectGitHubWebhookPayload("pull_request", payload);
  assert.notEqual(projected, payload, "a copy is returned");
  assert.equal(payload.name, undefined, "the input is never mutated");
  assert.equal(projected.name, "pull_request");
  // The nested object is shared, but the projection never writes into it.
  assert.equal(projected.repository, payload.repository);
});

// ── 11. error posture: a throwing seam yields the fixed 500 ────────────────

test("a throwing onEvent → 500 with no error text echoed; the server survives", async (t) => {
  let failNext = true;
  const h = await startTestHandler({
    onEvent: (ev: CanonicalForgeEvent) => {
      if (failNext) {
        failNext = false;
        throw new Error("boom");
      }
      h.events.push(ev);
    },
  });
  t.after(() => h.close());

  const failing = JSON.stringify(makePrPayload("synchronize"));
  const resFail = await post(h.url, {
    event: "pull_request",
    body: failing,
    signature: sign(failing),
  });
  assert.equal(resFail.status, 500);
  assert.deepEqual(JSON.parse(resFail.text), { status: "internal error" });
  assert.ok(!resFail.text.includes("boom"), "error text must never be echoed");
  assert.ok(!resFail.text.includes(SECRET), "the secret must never be echoed");

  const ok = JSON.stringify(makePrPayload("opened"));
  const resOk = await post(h.url, { event: "pull_request", body: ok, signature: sign(ok) });
  assert.equal(resOk.status, 202);
  assert.equal(h.events.length, 1);
});

test("a throwing router → 500 with no error text echoed", async (t) => {
  const h = await startTestHandler({
    router: {
      async handleEvent() {
        throw new Error("router boom");
      },
    },
  });
  t.after(() => h.close());
  const body = JSON.stringify(makeCommentPayload("created"));
  const res = await post(h.url, { event: "issue_comment", body, signature: sign(body) });
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.text), { status: "internal error" });
  assert.ok(!res.text.includes("router boom"));
});

// ── 12. the re-review trigger label ────────────────────────────────────────

test("rereviewLabel: only the configured label triggers rereview_label", async (t) => {
  const h = await startTestHandler({ rereviewLabel: "rerun-review" });
  t.after(() => h.close());

  const other = JSON.stringify({
    ...makePrPayload("labeled"),
    label: { name: "ai-review" },
  });
  const resOther = await post(h.url, {
    event: "pull_request",
    body: other,
    signature: sign(other),
  });
  assert.equal(resOther.status, 202);
  assert.deepEqual(JSON.parse(resOther.text), { status: "accepted", kind: "unknown" });

  const match = JSON.stringify({
    ...makePrPayload("labeled"),
    label: { name: "rerun-review" },
  });
  const resMatch = await post(h.url, {
    event: "pull_request",
    body: match,
    signature: sign(match),
  });
  assert.equal(resMatch.status, 202);
  assert.deepEqual(JSON.parse(resMatch.text), { status: "accepted", kind: "rereview_label" });
});

// ── 13. no-leak: the secret and the signature never appear in a response ───

test("no-leak: no response body contains the secret or the signature", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const signature = sign(body);

  const ok = await post(h.url, { event: "pull_request", body, signature });
  assert.equal(ok.status, 202);
  assert.ok(!ok.text.includes(SECRET));
  assert.ok(!ok.text.includes(signature));

  const bad = await post(h.url, {
    event: "pull_request",
    body,
    signature: "sha256=" + "f".repeat(64),
  });
  assert.equal(bad.status, 401);
  assert.ok(!bad.text.includes(SECRET));
  assert.ok(!bad.text.includes("f".repeat(64)));
});

// ── 14. the prototype-pollution fence ──────────────────────────────────────

test("prototype pollution: a '__proto__' payload cannot touch Object.prototype", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body =
    '{"__proto__":{"polluted":true},"action":"synchronize","number":7,' +
    `"pull_request":{"number":7,"id":4242,"head":{"sha":"${HEAD_SHA}","repo":{"full_name":"org/repo"}},` +
    `"base":{"sha":"${BASE_SHA}","repo":{"full_name":"org/repo"}}},"repository":{"full_name":"org/repo"}}`;
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype must stay unpolluted");
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "synchronize");
});

/** A recording router fake for the tests that bind one explicitly. */
function fakeRouter(sink: CanonicalForgeEvent[]): OperatorEventRouter {
  return {
    async handleEvent(event) {
      sink.push(event);
      return { kind: "ignored" };
    },
  };
}
