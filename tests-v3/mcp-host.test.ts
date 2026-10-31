/** Socket-level operator MCP listener tests (#1349): the full MCP client
 * flow over an ephemeral port, scoped-token separation from the admin
 * surface, fail-closed mount, bounded bodies and responses, authorization
 * isolation, and #252-style hostile inputs over the wire. */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createAdminHost } from "../src/admin/server.js";
import type { ControllerAdminDeps } from "../src/admin/types.js";
import { buildStoreBackedMcpDeps } from "../src/operator-mcp/store-deps.js";
import type { ControllerMcpDeps, McpAuditEvent } from "../src/operator-mcp/types.js";
import { InMemoryControlPlaneStore } from "../src/state/store.js";
import { newRunRecord } from "../src/state/types.js";
import { validateAdoptedRepository, validatePublication } from "../src/state/types.js";
import { newJobRecord } from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";

const adminDeps: ControllerAdminDeps = {
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

const JOB: ReviewJob = {
  jobId: "job-github-1",
  kind: "review",
  trigger: "webhook",
  reason: "synchronize",
  platform: "github",
  installationId: "1",
  repoFullName: "octo/widget",
  prNumber: 11,
  prId: 900,
  headSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
  baseSha: "",
  configFingerprint: "aaaaaaaaaaaaaaaa",
  nonce: "",
  adoptionEpoch: "epoch-1",
  eventReference: "",
  fork: false,
  deadlineAtMs: 0,
  runId: "run-1",
};

function mcpFixture(options: { mcpToken?: string; adminToken?: string; authorize?: ControllerMcpDeps["authorize"]; maxBodyBytes?: number } = {}) {
  const store = new InMemoryControlPlaneStore();
  const adopted = validateAdoptedRepository({ platform: "github", installationId: "1", repoFullName: "octo/widget", adoptionEpoch: "epoch-1", configFingerprint: "aaaaaaaaaaaaaaaa", headFingerprint: "", enabled: true, adoptedAtMs: 1000, updatedAtMs: 1000 });
  assert.ok(adopted);
  void store.apply([{ kind: "put-adopted-repository", record: adopted! }]);
  const run = newRunRecord({ runId: "run-1", jobId: "job-github-1", kind: "review", executorIdentity: "local:v1", headSha: JOB.headSha, configFingerprint: "aaaaaaaaaaaaaaaa", attempt: 1 }, 1000);
  void store.apply([{ kind: "create-run", record: run }]);
  const publication = validatePublication({
    jobId: "job-github-1",
    publicationState: "published",
    destination: "github-comment:100",
    publicationId: "100",
    attempt: 1,
    lastError: "",
    resultHeadSha: JOB.headSha,
    resultPayload: JSON.stringify({ verdict: "approve", review_result: "clean", required_checks: ["ci/build"], findings: [{ path: "src/a.ts", line: 1, severity: "minor", category: "style", message: "nit: rename" }] }),
    history: [],
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
  assert.ok(publication);
  void store.apply([{ kind: "put-publication", record: publication! }]);
  const deps = buildStoreBackedMcpDeps({
    controlPlane: store,
    queue: { load: () => ({ version: 1, records: [newJobRecord(JOB, 1000, 0)] }) },
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
  });
  const auditEvents: McpAuditEvent[] = [];
  const host = createAdminHost({
    deps: adminDeps,
    ...(options.adminToken === undefined ? {} : { token: options.adminToken }),
    mcp: {
      deps: {
        ...deps,
        audit: async (event) => {
          auditEvents.push(event);
        },
      },
      ...(options.mcpToken === undefined ? {} : { token: options.mcpToken }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    },
  });
  return { host, auditEvents };
}

async function listening(fixture: ReturnType<typeof mcpFixture>) {
  const server = createHttpServer(fixture.host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { ...fixture, server, base: `http://127.0.0.1:${address.port}` };
}

async function post(base: string, path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

test("the full MCP client flow works over the wire", async (t) => {
  const fixture = await listening(mcpFixture({ mcpToken: "mcp-capability" }));
  t.after(() => fixture.server.close());
  const auth = { authorization: "Bearer mcp-capability" };
  const initialize = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agent", version: "1" } } }), auth)).json();
  assert.equal(initialize.result.protocolVersion, "2024-11-05");
  assert.deepEqual(initialize.result.capabilities, { tools: { listChanged: false } });
  const initialized = await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), auth);
  assert.equal(initialized.status, 202);
  const listed = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }), auth)).json();
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), ["get_review", "list_findings", "get_review_policy"]);
  const call = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_review", arguments: { run_id: "run-1" } } }), auth)).json();
  assert.equal(call.result.isError, false);
  const review = JSON.parse(call.result.content[0].text).review;
  assert.equal(review.run_id, undefined); // the view uses snake_case-free field names
  assert.equal(review.runId, "run-1");
  assert.equal(review.verdict, "approve");
  assert.equal(review.findingCount, 1);
  assert.deepEqual(review.pr, { platform: "github", repository: "octo/widget", prNumber: 11 });
  const ping = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }), auth)).json();
  assert.deepEqual(ping.result, {});
});

test("token separation is structural: neither capability serves the other namespace", async (t) => {
  const fixture = await listening(mcpFixture({ mcpToken: "mcp-capability", adminToken: "admin-secret" }));
  t.after(() => fixture.server.close());
  // The admin token does NOT open /mcp.
  assert.equal((await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { authorization: "Bearer admin-secret" })).status, 401);
  // The MCP token does NOT open /admin/*.
  assert.equal((await fetch(fixture.base + "/admin/runs", { headers: { authorization: "Bearer mcp-capability" } })).status, 401);
  assert.equal((await fetch(fixture.base + "/admin/runs", { headers: { authorization: "Bearer admin-secret" } })).status, 200);
  assert.equal((await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { authorization: "Bearer mcp-capability" })).status, 200);
});

test("an unconfigured MCP token fail-closes the mount to the fixed 404", async (t) => {
  const fixture = await listening(mcpFixture({}));
  t.after(() => fixture.server.close());
  const response = await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.equal(response.status, 404);
  assert.equal((await fetch(fixture.base + "/mcp")).status, 404);
});

test("GET is refused, wrong content type is 415, oversized body is 413", async (t) => {
  const fixture = await listening(mcpFixture({ mcpToken: "mcp-capability" }));
  t.after(() => fixture.server.close());
  const auth = { authorization: "Bearer mcp-capability" };
  assert.equal((await fetch(fixture.base + "/mcp", { headers: auth })).status, 405);
  assert.equal((await fetch(fixture.base + "/nope", { headers: auth })).status, 404);
  const wrongType = await fetch(fixture.base + "/mcp", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "x" });
  assert.equal(wrongType.status, 415);
  const cappedHost = mcpFixture({ mcpToken: "mcp-capability", maxBodyBytes: 16 });
  const server = createHttpServer(cappedHost.host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const oversized = await post(`http://127.0.0.1:${address.port}`, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(64) } }), auth);
  assert.equal(oversized.status, 413);
});

test("protocol errors: garbage body, batch refusal, unknown method and tool", async (t) => {
  const fixture = await listening(mcpFixture({ mcpToken: "mcp-capability" }));
  t.after(() => fixture.server.close());
  const auth = { authorization: "Bearer mcp-capability" };
  const parseError = await (await post(fixture.base, "/mcp", "{not json", auth)).json();
  assert.equal(parseError.error.code, -32700);
  const batch = await (await post(fixture.base, "/mcp", JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]), auth)).json();
  assert.equal(batch.error.code, -32600);
  const unknownMethod = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list" }), auth)).json();
  assert.equal(unknownMethod.error.code, -32601);
  const unknownTool = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cancel_run", arguments: {} } }), auth)).json();
  assert.equal(unknownTool.error.code, -32602);
  const invalidArgs = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_review", arguments: { run_id: 5 } } }), auth)).json();
  assert.equal(invalidArgs.result.isError, true);
  assert.equal(invalidArgs.result.content[0].text, "invalid tool arguments");
});

test("authorization denial over the wire is a fixed tool error with an audit record", async (t) => {
  const fixture = await listening(mcpFixture({
    mcpToken: "mcp-capability",
    authorize: () => {
      throw new Error("denied");
    },
  }));
  t.after(() => fixture.server.close());
  const auth = { authorization: "Bearer mcp-capability" };
  const denied = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_findings", arguments: { platform: "github", repository: "octo/widget" } } }), auth)).json();
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.content[0].text, "repository access denied");
  assert.equal(fixture.auditEvents.length, 1);
  assert.equal(fixture.auditEvents[0]!.target.id, "octo/widget");
  assert.equal(fixture.auditEvents[0]!.outcome, "refused");
  // Cross-repository isolation: the denied caller sees no rows from the
  // adopted repository, and the refusal names nothing about it.
  assert.ok(!JSON.stringify(denied).includes("src/a.ts"));
});

test("auth failures are counted on the metrics surface", async (t) => {
  const fixture = await listening(mcpFixture({ mcpToken: "mcp-capability" }));
  t.after(() => fixture.server.close());
  await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { authorization: "Bearer wrong" });
  await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
  const metrics = await (await fetch(fixture.base + "/metrics")).text();
  assert.match(metrics, /pr_reviewer_admin_mcp_auth_failures_total 2/);
  const ok = await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_review", arguments: { run_id: "run-1" } } }), { authorization: "Bearer mcp-capability" });
  assert.equal(ok.status, 200);
  const metricsAfter = await (await fetch(fixture.base + "/metrics")).text();
  assert.match(metricsAfter, /pr_reviewer_admin_mcp_requests_total\{outcome="ok"\} 1/);
});

test("the response-byte cap refuses oversized tool output as a fixed error", async (t) => {
  // A seam that legitimately produces a huge view: the dispatcher's hard
  // response ceiling is what refuses it — never a truncated partial
  // document, and no per-record store validation involved.
  const hugeDeps: ControllerMcpDeps = {
    authorize: () => undefined,
    getReview: async () => ({
      runId: "run-1",
      jobId: "job-github-1",
      kind: "review",
      state: "completed",
      executorIdentity: "local",
      attempt: 1,
      headSha: JOB.headSha,
      configFingerprint: "aaaaaaaaaaaaaaaa",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      startedAtMs: 1000,
      finishedAtMs: 1000,
      pr: null,
      verdict: "comment",
      reviewResult: "issues",
      requiredChecks: [],
      findings: Array.from({ length: 400 }, (_, index) => ({ path: `src/f${index}.ts`, line: index, severity: "minor", category: "style", message: "y".repeat(4000) })),
      findingCount: 400,
      publication: null,
    }),
    listFindings: async () => ({ findings: [] }),
    getReviewPolicy: async () => null,
  };
  const host = createAdminHost({
    deps: adminDeps,
    mcp: {
      deps: hugeDeps,
      token: "mcp-capability",
      maxResponseBytes: 4096,
    },
  });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const response = await post(`http://127.0.0.1:${address.port}`, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_review", arguments: { run_id: "run-1" } } }), { authorization: "Bearer mcp-capability" });
  const body = await response.json();
  assert.equal(body.error.code, -32003);
  assert.equal(body.error.message, "response too large");
  // A bounded read still works under the same cap.
  const ok = await (await post(`http://127.0.0.1:${address.port}`, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_review_policy", arguments: { platform: "github", repository: "octo/widget" } } }), { authorization: "Bearer mcp-capability" })).json();
  assert.equal(ok.result.isError, true); // the seam has no policy: a tool-level not-found
});

test("hostile request content never echoes into responses", async (t) => {
  const fixture = await listening(mcpFixture({ mcpToken: "mcp-capability" }));
  t.after(() => fixture.server.close());
  const auth = { authorization: "Bearer mcp-capability" };
  // A hostile, deeply nested argument payload is refused with a fixed error.
  const hostile = await (await post(fixture.base, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_findings", arguments: { platform: "github", repository: "octo/../../etc", path: "\u202esecret" } } }), auth)).json();
  assert.equal(hostile.result.isError, true);
  assert.equal(hostile.result.content[0].text, "invalid tool arguments");
  // A hostile id shape is nulled, never echoed as a structured object.
  const hostileId = await (await post(fixture.base, "/mcp", '{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}', auth)).json();
  assert.equal(hostileId.id, null);
});
