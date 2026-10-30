/** Socket-level admin listener tests using an ephemeral local port. */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createAdminHost } from "../src/admin/server.js";
import type { AdminAuditEvent, ControllerAdminDeps } from "../src/admin/types.js";
import { createForgejoWebhookHandler } from "../src/ingress/webhook-handler.js";

const deps: ControllerAdminDeps = {
  readiness: async () => ({ components: [{ name: "store", ok: true }] }),
  listRuns: async () => ({ runs: [] }),
  getRun: async () => null,
  adoptionStatus: async () => ({ repositories: [] }),
  queueStatus: async () => ({ depthByState: { queued: 0, starting: 0, running: 0, publishing: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 }, oldestAgeMs: 0, activeWorkersByExecutor: {} }),
  diagnostics: async () => ({ ready: true }),
  forceRereview: async () => ({ jobId: "job-1" }),
  cancelRun: async () => ({ cancelled: true }),
  audit: () => undefined,
};
async function listening(token?: string, cap?: number) {
  const host = createAdminHost({ deps, ...(token === undefined ? {} : { token }), ...(cap === undefined ? {} : { maxBodyBytes: cap }) });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}`, host };
}

test("health, readiness, and metrics are public while all admin endpoints fail closed", async (t) => {
  const fixture = await listening(undefined);
  t.after(() => fixture.server.close());
  for (const path of ["/healthz", "/readyz", "/metrics"]) assert.equal((await fetch(fixture.base + path)).status, 200);
  for (const path of ["/admin/status", "/admin/runs", "/admin/runs/x", "/admin/runs/x/cancel", "/admin/rereview", "/admin/diagnostics"]) {
    const response = await fetch(fixture.base + path);
    assert.equal(response.status, 503, path);
  }
});

test("wrong token is unauthorized and valid token can read admin status", async (t) => {
  const fixture = await listening("admin-secret");
  t.after(() => fixture.server.close());
  assert.equal((await fetch(fixture.base + "/admin/status", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(fixture.base + "/admin/status", { headers: { authorization: "Bearer admin-secret" } })).status, 200);
});

test("body cap is hard and unknown method/path are fixed 404s", async (t) => {
  const fixture = await listening("admin-secret", 8);
  t.after(() => fixture.server.close());
  const oversized = await fetch(fixture.base + "/admin/rereview", { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ prKey: "too-long", reason: "x" }) });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(fixture.base + "/absent")).status, 404);
  assert.equal((await fetch(fixture.base + "/healthz", { method: "PUT" })).status, 404);
});

test("admin auth configuration does not change webhook handler behavior", async (t) => {
  const webhook = createHttpServer(createForgejoWebhookHandler({ secret: "webhook-secret", onEvent: () => undefined }));
  await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  t.after(() => webhook.close());
  const address = webhook.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: "GET" });
  assert.equal(response.status, 405);
});

test("a broken host clock never breaks the request path", async (t) => {
  const events: AdminAuditEvent[] = [];
  const host = createAdminHost({
    deps: { ...deps, audit: (event) => { events.push(event); } },
    token: "admin-secret",
    nowMs: () => { throw new Error("clock failure"); },
  });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status, 200);
  const mutation = await fetch(`http://127.0.0.1:${address.port}/admin/rereview`, { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ prKey: "github/1/repo#1/review", reason: "manual" }) });
  assert.equal(mutation.status, 202);
  assert.equal(events.length, 1);
  assert.ok(Number.isSafeInteger(events[0]!.atMs));
});

test("an unusable host clock keeps the request identity bounded", async (t) => {
  const events: AdminAuditEvent[] = [];
  const host = createAdminHost({
    deps: { ...deps, audit: (event) => { events.push(event); } },
    token: "admin-secret",
    nowMs: () => 1e300,
  });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const mutation = await fetch(`http://127.0.0.1:${address.port}/admin/rereview`, { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ prKey: "github/2/repo#2/review", reason: "manual" }) });
  assert.equal(mutation.status, 202);
  assert.equal(events.length, 1);
  assert.ok(events[0]!.requestId.length <= 64);
  assert.ok(Number.isSafeInteger(events[0]!.atMs));
});

test("public readiness over the wire never carries the seam's detail or a credential-shaped name", async (t) => {
  const hostile: ControllerAdminDeps = {
    ...deps,
    readiness: async () => ({
      components: [{ name: "sk-12345678901234567890", ok: false, degraded: true, detail: "postgres://user:hunter2@db.internal:5432/prod" }],
    }),
  };
  const host = createAdminHost({ deps: hostile });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.doesNotMatch(text, /hunter2|postgres:\/\/|detail|sk-12345678901234567890/);
  assert.match(text, /REDACTED/);
});
