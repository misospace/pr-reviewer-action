/** Pure route dispatch, authorization, validation, and effect boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { AdminAuthenticator } from "../src/admin/auth.js";
import { AdminMetricsRegistry } from "../src/admin/metrics.js";
import { dispatchAdminRoute } from "../src/admin/routes.js";
import type { AdminRunDetail, ControllerAdminDeps, JobLifecycleState } from "../src/admin/types.js";

const zeroDepth = { queued: 0, starting: 0, running: 0, publishing: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 } satisfies Record<JobLifecycleState, number>;
const run = (state: JobLifecycleState): AdminRunDetail => ({ runId: "run-1", jobId: "job-1", kind: "review", state, executorIdentity: "local", attempt: 1, headSha: "abcdef1234567", failureReason: "", supersededByJobId: "", createdAtMs: 1, updatedAtMs: 2, startedAtMs: 1, finishedAtMs: state === "completed" ? 2 : 0, publication: { jobId: "job-1", state: "none", attempt: 0, lastOutcome: "" }, usage: [] });
function fixture(state: JobLifecycleState = "running") {
  const calls: string[] = [];
  const deps: ControllerAdminDeps = {
    readiness: async () => ({ components: [{ name: "db", ok: true }] }),
    listRuns: async () => ({ runs: [run(state)] }),
    getRun: async () => run(state),
    adoptionStatus: async () => ({ repositories: [] }),
    queueStatus: async () => ({ depthByState: zeroDepth, oldestAgeMs: 0, activeWorkersByExecutor: {} }),
    diagnostics: async () => ({ endpoint: "https://user:password@example.test/path", message: "api_key=sk-12345678901234567890", token: "secret-value", ok: true }),
    forceRereview: async () => { calls.push("rereview"); return { jobId: "job-new" }; },
    cancelRun: async () => { calls.push("cancel"); return { cancelled: true }; },
    audit: async () => { calls.push("audit"); },
  };
  return { calls, context: { deps, auth: new AdminAuthenticator("secret-value"), metrics: new AdminMetricsRegistry() } };
}
const req = (method: string, pathname: string, extra: Record<string, unknown> = {}) => ({ method, pathname, search: "", requestId: "req-1", ...extra });

test("all admin reads and writes require auth; public endpoints do not", async () => {
  const { context } = fixture();
  for (const [method, path] of [["GET", "/admin/status"], ["GET", "/admin/runs"], ["GET", "/admin/runs/run-1"], ["POST", "/admin/runs/run-1/cancel"], ["POST", "/admin/rereview"], ["GET", "/admin/diagnostics"]] as const) {
    const response = await dispatchAdminRoute(context, req(method, path));
    assert.equal(response.status, 401, path);
  }
  assert.equal((await dispatchAdminRoute(context, req("GET", "/healthz"))).status, 200);
  assert.equal((await dispatchAdminRoute(context, req("GET", "/readyz"))).status, 200);
  assert.equal((await dispatchAdminRoute(context, req("GET", "/metrics"))).status, 200);
});

test("unconfigured admin token returns 503 throughout admin namespace", async () => {
  const { context } = fixture(); context.auth = new AdminAuthenticator(undefined);
  assert.equal((await dispatchAdminRoute(context, req("GET", "/admin/runs"))).status, 503);
});

test("readiness returns degraded components and status", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({ components: [{ name: "database", ok: false, degraded: true }] });
  const response = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(response.status, 503);
  assert.match(JSON.stringify(response.body), /database/);
});

test("rereview validates first, invokes effect once, and audits after it settles", async () => {
  const { context, calls } = fixture();
  const headers = { authorization: "Bearer secret-value", contentType: "application/json" };
  const invalid = await dispatchAdminRoute(context, req("POST", "/admin/rereview", { ...headers, body: { prKey: "bad key", reason: "manual" } }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(calls, []);
  const valid = await dispatchAdminRoute(context, req("POST", "/admin/rereview", { ...headers, body: { prKey: "github/123/repo#1/review", reason: "manual" } }));
  assert.equal(valid.status, 202);
  assert.deepEqual(calls, ["rereview", "audit"]);
});

test("diagnostics redact credential keys, secret shapes, and URL userinfo", async () => {
  const { context } = fixture();
  context.deps.diagnostics = async () => ({
    endpoint: "https://user:password@example.test/path",
    message: "api_key=sk-12345678901234567890",
    token: "secret-value",
    nested: { leak: "value" } as unknown as string,
    ok: true,
  });
  const response = await dispatchAdminRoute(context, req("GET", "/admin/diagnostics", { authorization: "Bearer secret-value" }));
  const body = JSON.stringify(response.body);
  assert.doesNotMatch(body, /secret-value|sk-12345678901234567890|user:password|nested|leak/);
  assert.match(body, /REDACTED/);
  assert.match(body, /"ok":true/);
});

test("unknown run reads 404 and refused rereview audits a 409", async () => {
  const { context, calls } = fixture();
  context.deps.getRun = async () => null;
  assert.equal((await dispatchAdminRoute(context, req("GET", "/admin/runs/absent", { authorization: "Bearer secret-value" }))).status, 404);
  context.deps.forceRereview = async () => { calls.push("rereview"); return { refused: "terminal" }; };
  const refused = await dispatchAdminRoute(context, req("POST", "/admin/rereview", { authorization: "Bearer secret-value", contentType: "application/json", body: { prKey: "github/123/repo#1/review", reason: "manual" } }));
  assert.equal(refused.status, 409);
  assert.deepEqual(calls, ["rereview", "audit"]);
});

test("cancellation refuses unknown and terminal runs, accepts active once", async () => {
  const { context, calls } = fixture("running");
  const headers = { authorization: "Bearer secret-value", contentType: "application/json" };
  assert.equal((await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", headers))).status, 202);
  assert.deepEqual(calls, ["cancel", "audit"]);
  context.deps.getRun = async () => run("completed");
  assert.equal((await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", headers))).status, 409);
  context.deps.getRun = async () => null;
  assert.equal((await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", headers))).status, 404);
});

test("query and unknown routes fail closed", async () => {
  const { context } = fixture();
  const authorization = "Bearer secret-value";
  assert.equal((await dispatchAdminRoute(context, req("GET", "/admin/runs", { authorization, search: "?limit=999" }))).status, 400);
  assert.equal((await dispatchAdminRoute(context, req("GET", "/missing", { authorization }))).status, 404);
});
