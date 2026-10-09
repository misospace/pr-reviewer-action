import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createForgejoWebhookHandler,
  type ForgejoWebhookHandlerOptions,
} from "../src/ingress/webhook-handler.js";
import { computeForgejoWebhookSignature } from "../src/ingress/signature.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const SECRET = "whsec_test_secret_0123456789abcdef";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

interface TestHandler {
  url: string;
  events: CanonicalForgeEvent[];
  close: () => Promise<void>;
}

async function startTestHandler(
  overrides: Partial<ForgejoWebhookHandlerOptions> = {},
): Promise<TestHandler> {
  const events: CanonicalForgeEvent[] = [];
  const server: Server = createServer(
    createForgejoWebhookHandler({
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A GitHub-compatible bare PR payload (Forgejo shape), NO `name` field. */
function makePrPayload(action: string): Record<string, unknown> {
  return {
    repository: { full_name: "org/repo" },
    number: 7,
    id: 700,
    head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
    base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
    action,
    sender: { login: "octo" },
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
  if (opts.event !== undefined) headers["x-gitea-event"] = opts.event;
  if (opts.signature !== undefined) headers["x-gitea-signature"] = opts.signature;
  const res = await fetch(url, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ?? null,
  });
  return { status: res.status, text: await res.text() };
}

function sign(body: string, secret: string = SECRET): string {
  return computeForgejoWebhookSignature(secret, body);
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
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ── 1. happy path: valid signature → 202 + canonical event ─────────────────

test("valid signature + pull_request/synchronize → 202 with the canonical event fields", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" });
  assert.equal(h.events.length, 1);
  const ev = h.events[0]!;
  assert.equal(ev.platform, "forgejo");
  assert.equal(ev.source, "webhook");
  assert.equal(ev.kind, "synchronize");
  assert.equal(ev.repoFullName, "org/repo");
  assert.equal(ev.prNumber, 7);
  assert.equal(ev.prId, 700);
  assert.equal(ev.headSha, HEAD_SHA);
  assert.equal(ev.fork, false);
});

// ── 2. lifecycle actions through the handler ────────────────────────────────

test("lifecycle: opened/reopen/closed+merged/closed/labeled map to the expected kinds", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["opened", makePrPayload("opened"), "pr_opened"],
    ["reopen", makePrPayload("reopen"), "pr_reopened"],
    ["closed merged", { ...makePrPayload("closed"), merged: true }, "pr_merged"],
    ["closed", makePrPayload("closed"), "pr_closed"],
    ["labeled", { ...makePrPayload("labeled"), label: { name: "ai-review" } }, "rereview_label"],
  ];
  for (const [label, payload, kind] of cases) {
    const body = JSON.stringify(payload);
    const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
    assert.equal(res.status, 202, label);
    assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind }, label);
  }
  assert.deepEqual(h.events.map((ev) => ev.kind), [
    "pr_opened",
    "pr_reopened",
    "pr_merged",
    "pr_closed",
    "rereview_label",
  ]);
});

// ── 3. the event header is authoritative over a hostile payload name ────────

test("header authority: payload name 'issues' cannot re-route a pull_request/synchronize delivery", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify({ ...makePrPayload("synchronize"), name: "issues" });
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "synchronize");
});

// ── 4. auth failures: 401, zero events ──────────────────────────────────────

test("auth: wrong signature → 401, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body, "wrong-secret") });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

test("auth: missing x-gitea-signature → 401, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "pull_request", body });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

test("auth: body tampered after signing → 401, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const signature = sign(JSON.stringify(makePrPayload("synchronize")));
  const tampered = JSON.stringify({ ...makePrPayload("synchronize"), action: "closed", merged: true });
  const res = await post(h.url, { event: "pull_request", body: tampered, signature });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

// ── 5. duplicate signature header (repeated header LINES via node:http) ────

test("auth: a duplicate x-gitea-signature header is rejected (array path)", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const signature = sign(body);
  // undici fetch folds duplicate headers into one comma-joined value; Node's
  // http emits repeated header lines for an array value, which is the only
  // way to reach the handler's array-rejection path.
  const res = await rawPost(h.url, {
    "x-gitea-event": "pull_request",
    "x-gitea-signature": [signature, signature],
    "content-type": "application/json",
  }, body);
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

// ── 6. signature verification precedes JSON parsing ────────────────────────

test("ordering: malformed JSON with a VALID signature → 400", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = "{not json";
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 400);
  assert.equal(h.events.length, 0);
});

test("ordering: malformed JSON with an INVALID signature → 401 (verify before parse)", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const res = await post(h.url, { event: "pull_request", body: "{not json", signature: "0".repeat(64) });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

// ── 7. empty configured secret accepts nothing (boundary token itself) ──────

test("empty configured secret: a request signed with the empty secret is still 401", async (t) => {
  const h = await startTestHandler({ secret: "" });
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const res = await post(h.url, { event: "pull_request", body, signature: computeForgejoWebhookSignature("", body) });
  assert.equal(res.status, 401);
  assert.equal(h.events.length, 0);
});

// ── 8. body size cap ────────────────────────────────────────────────────────

test("size cap: oversize body with a VALID signature → 413, zero events", async (t) => {
  const h = await startTestHandler({ maxBodyBytes: 64 });
  t.after(() => h.close());
  const body = JSON.stringify({ ...makePrPayload("synchronize"), padding: "x".repeat(300) });
  assert.ok(body.length > 300);
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 413);
  assert.equal(h.events.length, 0);
});

// ── 9. method / event-header shape rejections ───────────────────────────────

test("protocol: GET → 405; missing event header → 400; spaced event header → 400; zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const signature = sign(body);

  const get = await fetch(h.url, { method: "GET" });
  assert.equal(get.status, 405);
  await get.text();

  const missing = await post(h.url, { body, signature });
  assert.equal(missing.status, 400);

  const spaced = await post(h.url, { event: "pull request", body, signature });
  assert.equal(spaced.status, 400);

  assert.equal(h.events.length, 0);
});

// ── 10. ping is acknowledged without dispatch ───────────────────────────────

test("ping with a valid signature → 200 ignored, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const res = await post(h.url, { event: "ping", body: "{}", signature: sign("{}") });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { status: "ignored" });
  assert.equal(h.events.length, 0);
});

// ── 11. permanently unroutable payload is acked, not dispatched ─────────────

test("unroutable payload under pull_request → 200 ignored, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify({ foo: 1 });
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { status: "ignored" });
  assert.equal(h.events.length, 0);
});

// ── 12. follow-up comment event ─────────────────────────────────────────────

test("issue_comment created on a PR issue → 202 follow_up with the comment id reference", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "org/repo" },
    comment: { id: 55, user: { login: "dev" } },
    issue: { number: 7, pull_request: {} },
  });
  const res = await post(h.url, { event: "issue_comment", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "follow_up");
  assert.equal(h.events[0]!.eventReference, "55");
});

// ── 13. configurable rereview label ─────────────────────────────────────────

test("rereviewLabel option: only the configured label triggers rereview_label; others map to unknown", async (t) => {
  const h = await startTestHandler({ rereviewLabel: "rerun-review" });
  t.after(() => h.close());

  const other = JSON.stringify({ ...makePrPayload("labeled"), label: { name: "ai-review" } });
  const resOther = await post(h.url, { event: "pull_request", body: other, signature: sign(other) });
  assert.equal(resOther.status, 202);
  // mapKind: `rawLabelName === rereviewLabel ? "rereview_label" : "unknown"`.
  assert.equal(resOther.text, '{"status":"accepted","kind":"unknown"}');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "unknown");

  const match = JSON.stringify({ ...makePrPayload("labeled"), label: { name: "rerun-review" } });
  const resMatch = await post(h.url, { event: "pull_request", body: match, signature: sign(match) });
  assert.equal(resMatch.status, 202);
  assert.equal(resMatch.text, '{"status":"accepted","kind":"rereview_label"}');
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1]!.kind, "rereview_label");
});

// ── 14. onEvent failure: fixed 500, no error echo, server survives ─────────

test("onEvent throw → 500 fixed body without 'boom' or the secret; next request still 202", async (t) => {
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
  const resFail = await post(h.url, { event: "pull_request", body: failing, signature: sign(failing) });
  assert.equal(resFail.status, 500);
  assert.deepEqual(JSON.parse(resFail.text), { status: "internal error" });
  assert.ok(!resFail.text.includes("boom"), "error text must not be echoed");
  assert.ok(!resFail.text.includes(SECRET), "secret must not be echoed");
  assert.equal(h.events.length, 0);

  const ok = JSON.stringify(makePrPayload("opened"));
  const resOk = await post(h.url, { event: "pull_request", body: ok, signature: sign(ok) });
  assert.equal(resOk.status, 202);
  assert.equal(h.events.length, 1);
});

// ── 15. no-leak: neither the secret nor the signature appears in responses ─

test("no-leak: 202 and 401 response bodies contain neither the secret nor the signature", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  const signature = sign(body);

  const ok = await post(h.url, { event: "pull_request", body, signature });
  assert.equal(ok.status, 202);
  assert.ok(!ok.text.includes(SECRET), "202 body must not contain the secret");
  assert.ok(!ok.text.includes(signature), "202 body must not contain the signature");

  const bad = await post(h.url, { event: "pull_request", body, signature: "f".repeat(64) });
  assert.equal(bad.status, 401);
  assert.ok(!bad.text.includes(SECRET), "401 body must not contain the secret");
  assert.ok(!bad.text.includes(signature), "401 body must not contain the signature");
});

// ── 16. non-object payloads with a valid signature → 400 invalid payload ────

test("payload shape: 'null' and '[]' with a valid signature → 400 invalid payload, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  for (const body of ["null", "[]"]) {
    const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });
    assert.equal(res.status, 400, body);
    assert.deepEqual(JSON.parse(res.text), { status: "invalid payload" }, body);
  }
  assert.equal(h.events.length, 0);
});

// ── 17. prototype-pollution payload: the define-semantics spread is the fence ─

test("prototype pollution: '__proto__' payload cannot touch Object.prototype and normalizes cleanly", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body =
    '{"__proto__":{"polluted":true},"repository":{"full_name":"org/repo"},"number":7,"id":700,' +
    `"head":{"sha":"${HEAD_SHA}","repo":{"full_name":"org/repo"}},` +
    `"base":{"sha":"${BASE_SHA}","repo":{"full_name":"org/repo"}},"action":"synchronize"}`;
  const res = await post(h.url, { event: "pull_request", body, signature: sign(body) });

  // The payload is a valid pull_request/synchronize shape, so the normalizer
  // accepts it: the fence is that the spread ({ ...parsed, name }) defines
  // `__proto__` as an own data property instead of invoking the setter.
  assert.equal(res.status, 202);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype must stay unpolluted");
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);

  assert.equal(h.events.length, 1);
  const ev = h.events[0]!;
  assert.equal(ev.kind, "synchronize");
  assert.equal(Object.getPrototypeOf(ev), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(ev, "__proto__"), false);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" });
});

// ── 18. duplicate x-gitea-event header lines ────────────────────────────────

test("protocol: duplicate x-gitea-event header lines → 400, zero events", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makePrPayload("synchronize"));
  // Only raw node:http can emit repeated header LINES (array value); the
  // handler must reject the array form rather than coerce it to a string.
  const res = await rawPost(h.url, {
    "x-gitea-event": ["pull_request", "pull_request"],
    "x-gitea-signature": sign(body),
    "content-type": "application/json",
  }, body);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.text), { status: "invalid event header" });
  assert.equal(h.events.length, 0);
});

// ── 19. the server survives a 413 (destroyed inbound stream) ────────────────

test("size cap: after a 413 the same server still answers a valid request with 202", async (t) => {
  const h = await startTestHandler({ maxBodyBytes: 512 });
  t.after(() => h.close());
  const oversize = JSON.stringify({ ...makePrPayload("synchronize"), padding: "x".repeat(600) });
  const big = await post(h.url, { event: "pull_request", body: oversize, signature: sign(oversize) });
  assert.equal(big.status, 413);
  assert.equal(h.events.length, 0);

  const ok = JSON.stringify(makePrPayload("opened"));
  const res = await post(h.url, { event: "pull_request", body: ok, signature: sign(ok) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "pr_opened" });
  assert.equal(h.events.length, 1);
});

// ── 20. native Gitea/Forgejo event vocabulary projection ────────────────────
//
// The native forge does not use GitHub's event vocabulary: a delivery carries
// a GROUPED `X-Gitea-Event` header plus a specific `X-Gitea-Event-Type` header
// and a payload whose shape differs from GitHub's (e.g. a PR on a TOP-LEVEL
// `pull_request` object instead of `issue.pull_request`). The handler projects
// the delivery onto the GitHub-shaped envelope before normalizeForgejoEvent
// runs. These drive that projection end-to-end.

function makeNativePrPayload(action: string): Record<string, unknown> {
  return {
    action,
    repository: { full_name: "org/repo" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
      user: { login: "octo" },
    },
    sender: { login: "octo" },
  };
}

function makeNativeLabelPayload(labels: unknown): Record<string, unknown> {
  return {
    action: "label_updated",
    repository: { full_name: "org/repo" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
      labels,
    },
    sender: { login: "octo" },
  };
}

interface PostTypedOptions {
  event: string;
  eventType?: string;
  body: string;
  signature: string;
}

// A `post` variant that can also set the `X-Gitea-Event-Type` header (the
// specific-type header the native forge sends alongside the grouped
// `X-Gitea-Event` header).
async function postTyped(
  url: string,
  opts: PostTypedOptions,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "x-gitea-event": opts.event };
  if (opts.eventType !== undefined) headers["x-gitea-event-type"] = opts.eventType;
  headers["x-gitea-signature"] = opts.signature;
  const res = await fetch(url, { method: "POST", headers, body: opts.body });
  return { status: res.status, text: await res.text() };
}

test("native: pull_request + action 'synchronized' (full PR object) → 202 synchronize", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makeNativePrPayload("synchronized"));
  const res = await postTyped(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "synchronize");
  assert.equal(h.events[0]!.prNumber, 7);
  assert.equal(h.events[0]!.headSha, HEAD_SHA);
  assert.equal(h.events[0]!.baseSha, BASE_SHA);
});

test("native: older pull_request_sync header forces synchronize regardless of the payload action → 202 synchronize", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  // The payload says "opened", but the ungrouped header forces the kind.
  const body = JSON.stringify(makeNativePrPayload("opened"));
  const res = await postTyped(h.url, { event: "pull_request_sync", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" });
  assert.equal(h.events[0]!.kind, "synchronize");
});

test("native: pull_request + action 'reopened' → 202 pr_reopened", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makeNativePrPayload("reopened"));
  const res = await postTyped(h.url, { event: "pull_request", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "pr_reopened" });
  assert.equal(h.events[0]!.kind, "pr_reopened");
});

test("native: label_updated with the rereview label in pull_request.labels → 202 rereview_label; without → 202 unknown", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());

  const withTrigger = JSON.stringify(makeNativeLabelPayload([{ name: "ai-review", color: "00ff00" }]));
  const resWith = await postTyped(h.url, {
    event: "pull_request",
    eventType: "pull_request_label",
    body: withTrigger,
    signature: sign(withTrigger),
  });
  assert.equal(resWith.status, 202);
  assert.deepEqual(JSON.parse(resWith.text), { status: "accepted", kind: "rereview_label" });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "rereview_label");
  assert.equal(h.events[0]!.labelName, "ai-review");

  const withoutTrigger = JSON.stringify(makeNativeLabelPayload([{ name: "docs", color: "00ff00" }]));
  const resWithout = await postTyped(h.url, {
    event: "pull_request",
    eventType: "pull_request_label",
    body: withoutTrigger,
    signature: sign(withoutTrigger),
  });
  // No trigger in labels → synthesized label "" → kind unknown. The handler
  // still forwards the non-null event to onEvent (it acks rather than 200s).
  assert.equal(resWithout.status, 202);
  assert.deepEqual(JSON.parse(resWithout.text), { status: "accepted", kind: "unknown" });
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1]!.kind, "unknown");
});

test("native: issue_comment + pull_request_comment type, top-level pull_request + comment.id → 202 follow_up", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "org/repo" },
    comment: { id: 55, user: { login: "dev" } },
    issue: { number: 7, title: "a PR" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
    },
    sender: { login: "dev" },
  });
  const res = await postTyped(h.url, {
    event: "issue_comment",
    eventType: "pull_request_comment",
    body,
    signature: sign(body),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "follow_up" });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "follow_up");
  assert.equal(h.events[0]!.prNumber, 7);
  assert.equal(h.events[0]!.eventReference, "55");
});