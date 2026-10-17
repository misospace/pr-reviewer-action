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

function makeNativePrPayload(
  action: string,
  prExtras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    repository: { full_name: "org/repo" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
      user: { login: "octo" },
      ...prExtras,
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

test("native: older pull_request_sync header + a synchronized action → 202 synchronize", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  // The hint is honored only because the SIGNED action authorizes it.
  const body = JSON.stringify(makeNativePrPayload("synchronized"));
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

// ── 21. signed-replay regressions: the event headers are unauthenticated ────
//
// The HMAC in signature.ts covers the RAW BODY ONLY, so a captured delivery can
// be replayed with IDENTICAL body bytes and an IDENTICAL signature while the
// `X-Gitea-Event` / `X-Gitea-Event-Type` headers change. The signed body's own
// action must stay authoritative: a hint may refine a projection the signed body
// already authorizes and can never rewrite one (#1024). These post the SAME
// body + signature under forged headers and assert the kind never changes into
// a scheduleable/privileged one.

const FORGED_SYNC_HEADERS: Array<{ event: string; eventType?: string }> = [
  { event: "pull_request", eventType: "pull_request_sync" },
  { event: "pull_request_sync" },
  { event: "pull_request_sync", eventType: "pull_request_sync" },
];

test("replay: a signed closed body stays pr_merged/pr_closed under forged sync headers", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const bodies: Array<{ body: string; kind: string }> = [
    { body: JSON.stringify(makeNativePrPayload("closed", { merged: true })), kind: "pr_merged" },
    { body: JSON.stringify(makeNativePrPayload("closed")), kind: "pr_closed" },
  ];
  let expected = 0;
  for (const { body, kind } of bodies) {
    const signature = sign(body);
    for (const forged of FORGED_SYNC_HEADERS) {
      const res = await postTyped(h.url, { ...forged, body, signature });
      assert.equal(res.status, 202, `${forged.event}/${kind}`);
      assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind }, `${forged.event}/${kind}`);
      expected += 1;
      // The delivery stays terminal: a terminal kind never mints a review
      // generation through dispatch (`shouldSchedule`).
      const ev = h.events[expected - 1]!;
      assert.equal(ev.kind, kind);
      assert.notEqual(ev.kind, "synchronize", "a forged sync hint must never mint synchronize");
      assert.equal(ev.prNumber, 7);
      assert.equal(ev.headSha, HEAD_SHA);
    }
  }
  assert.equal(h.events.length, expected);
});

test("replay: a signed synchronized body under the same headers is still 202 synchronize", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  const body = JSON.stringify(makeNativePrPayload("synchronized"));
  const signature = sign(body);
  for (const forged of FORGED_SYNC_HEADERS) {
    const res = await postTyped(h.url, { ...forged, body, signature });
    assert.equal(res.status, 202, forged.event);
    assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "synchronize" }, forged.event);
  }
  assert.equal(h.events.length, FORGED_SYNC_HEADERS.length);
  assert.ok(h.events.every((ev) => ev.kind === "synchronize"));
});

test("replay: a forged label hint on a signed non-label body never yields rereview_label", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  // A signed SYNC body whose PR already carries the trigger label: the forged
  // label hint must not mine `pull_request.labels` into a re-review trigger.
  // Both header shapes are forged: the grouped pair (the grouped rule keeps the
  // signed action → synchronize) and the ungrouped label group (rejected →
  // passthrough → unknown).
  const syncBody = JSON.stringify(
    makeNativePrPayload("synchronized", { labels: [{ name: "ai-review", color: "00ff00" }] }),
  );
  const forgeries: Array<{ event: string; eventType?: string; kind: string }> = [
    { event: "pull_request", eventType: "pull_request_label", kind: "synchronize" },
    { event: "pull_request_label", eventType: "pull_request_label", kind: "unknown" },
  ];
  for (const forged of forgeries) {
    const res = await postTyped(h.url, { ...forged, body: syncBody, signature: sign(syncBody) });
    assert.equal(res.status, 202, forged.event);
    assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: forged.kind }, forged.event);
  }
  assert.equal(h.events.length, forgeries.length);
  for (const [i, forged] of forgeries.entries()) {
    const ev = h.events[i]!;
    assert.equal(ev.kind, forged.kind, forged.event);
    // The trigger label on the PR is never mined into a re-review kind by a hint.
    assert.notEqual(ev.kind, "rereview_label", forged.event);
    assert.equal(ev.labelName, "", forged.event);
  }

  // A signed terminal body under the ungrouped label header degrades to the
  // passthrough: still not a re-review, and not a scheduleable kind either.
  const closedBody = JSON.stringify(makeNativePrPayload("closed", { labels: [{ name: "ai-review" }] }));
  const res = await postTyped(h.url, {
    event: "pull_request_label",
    body: closedBody,
    signature: sign(closedBody),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "unknown" });
  const ev = h.events[forgeries.length]!;
  assert.equal(ev.kind, "unknown");
  assert.equal(ev.labelName, "");
});

test("replay: a forged comment hint on a signed non-created body never yields follow_up", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  // A signed terminal body carrying a top-level `pull_request` and a comment
  // object: re-nesting it into `issue.pull_request` would make it follow_up-
  // shaped, so the forged hint must leave the envelope alone. Two fences cover
  // this: the projection now refuses to re-nest without a signed `created` (the
  // discriminating regression, see the projection unit test) and the normalizer
  // independently requires `action === "created"` for `follow_up` — this
  // end-to-end check pins that both hold for a real forged delivery.
  const body = JSON.stringify({
    action: "closed",
    repository: { full_name: "org/repo" },
    comment: { id: 55, user: { login: "dev" } },
    issue: { number: 7, title: "a PR" },
    pull_request: {
      number: 7,
      id: 700,
      head: { sha: HEAD_SHA, repo: { full_name: "org/repo" } },
      base: { sha: BASE_SHA, repo: { full_name: "org/repo" } },
      merged: true,
    },
    sender: { login: "dev" },
  });
  const signature = sign(body);
  for (const forged of [
    { event: "issue_comment", eventType: "pull_request_comment" },
    { event: "pull_request_comment" },
  ]) {
    const res = await postTyped(h.url, { ...forged, body, signature });
    assert.equal(res.status, 202, forged.event);
    assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "unknown" }, forged.event);
  }
  assert.equal(h.events.length, 2);
  for (const ev of h.events) {
    assert.notEqual(ev.kind, "follow_up");
    assert.equal(ev.kind, "unknown");
  }
});

// ── 22. signed-replay: a forged check/status header never mints a generation ─
//
// The residual the header-driven reclassification left open: the same signed PR
// bytes replayed under `x-gitea-event: status` / `check_run` used to normalize
// to the SCHEDULEABLE `check_update` kind, because the family names alone were
// enough and the group header is unauthenticated. The kind is now shape-anchored
// (#1102): a body with no check/status shape degrades to `unknown`.

test("replay: a signed PR body under forged check/status headers is unknown, never check_update", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  // ONE real PR body, signed ONCE, posted byte-for-byte under each forged
  // family header.
  const body = JSON.stringify(makeNativePrPayload("closed", { merged: true }));
  const signature = sign(body);
  for (const forged of [
    { event: "status" },
    { event: "status", eventType: "status" },
    { event: "check_run" },
    { event: "check_run", eventType: "check_run" },
    { event: "check_suite" },
  ]) {
    const res = await postTyped(h.url, { ...forged, body, signature });
    assert.equal(res.status, 202, forged.event);
    assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "unknown" }, forged.event);
  }
  assert.equal(h.events.length, 5);
  for (const ev of h.events) {
    assert.notEqual(ev.kind, "check_update", "a forged check/status header must never mint check_update");
    assert.equal(ev.kind, "unknown");
    // The signed body is untouched: the delivery keeps its own identity.
    assert.equal(ev.prNumber, 7);
    assert.equal(ev.headSha, HEAD_SHA);
  }
});

test("a genuine signed Forgejo status delivery is accepted as check_update", async (t) => {
  const h = await startTestHandler();
  t.after(() => h.close());
  // Forgejo's native commit-status webhook: the top-level sha/state/context
  // triple, no `pull_requests`, no `installation`, no `check_run` object. A REAL
  // delivery must still reach the scheduleable kind.
  const body = JSON.stringify({
    sha: HEAD_SHA,
    state: "success",
    context: "ci/jenkins",
    repository: { full_name: "org/repo" },
  });
  const res = await postTyped(h.url, { event: "status", body, signature: sign(body) });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.text), { status: "accepted", kind: "check_update" });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.kind, "check_update");
  assert.equal(h.events[0]!.repoFullName, "org/repo");
});
