/** Pure route dispatch, authorization, validation, and effect boundaries. */
import test from "node:test";
import assert from "node:assert/strict";
import { AdminAuthenticator } from "../src/admin/auth.js";
import { AdminMetricsRegistry } from "../src/admin/metrics.js";
import { dispatchAdminRoute, type AdminRouteContext } from "../src/admin/routes.js";
import type { AdminAuditEvent, AdminRunDetail, ControllerAdminDeps, JobLifecycleState, ReadinessComponent } from "../src/admin/types.js";

const zeroDepth = { queued: 0, starting: 0, running: 0, publishing: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 } satisfies Record<JobLifecycleState, number>;
const run = (state: JobLifecycleState): AdminRunDetail => ({ runId: "run-1", jobId: "job-1", kind: "review", state, executorIdentity: "local", attempt: 1, headSha: "abcdef1234567", failureReason: "", supersededByJobId: "", createdAtMs: 1, updatedAtMs: 2, startedAtMs: 1, finishedAtMs: state === "completed" ? 2 : 0, publication: { jobId: "job-1", state: "none", attempt: 0, lastOutcome: "" }, usage: [] });
function fixture(state: JobLifecycleState = "running", nowMs?: () => number) {
  const calls: string[] = [];
  const events: AdminAuditEvent[] = [];
  const deps: ControllerAdminDeps = {
    readiness: async () => ({ components: [{ name: "db", ok: true }] }),
    listRuns: async () => ({ runs: [run(state)] }),
    getRun: async () => run(state),
    adoptionStatus: async () => ({ repositories: [] }),
    queueStatus: async () => ({ depthByState: zeroDepth, oldestAgeMs: 0, activeWorkersByExecutor: {} }),
    diagnostics: async () => ({ endpoint: "https://user:password@example.test/path", message: "api_key=sk-12345678901234567890", token: "secret-value", ok: true }),
    forceRereview: async () => { calls.push("rereview"); return { jobId: "job-new" }; },
    cancelRun: async () => { calls.push("cancel"); return { cancelled: true }; },
    audit: async (event) => { calls.push("audit"); events.push(event); },
  };
  const context: AdminRouteContext = { deps, auth: new AdminAuthenticator("secret-value"), metrics: new AdminMetricsRegistry(), ...(nowMs === undefined ? {} : { nowMs }) };
  return { calls, events, context };
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
  const { context } = fixture();
  const unconfigured: AdminRouteContext = { ...context, auth: new AdminAuthenticator(undefined) };
  assert.equal((await dispatchAdminRoute(unconfigured, req("GET", "/admin/runs"))).status, 503);
});

test("readiness returns degraded components and status", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({ components: [{ name: "database", ok: false, degraded: true }] });
  const response = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(response.status, 503);
  assert.match(JSON.stringify(response.body), /database/);
});

test("public readiness exposes only bounded synthetic component fields", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({
    components: [
      { name: "database", ok: false, degraded: true, detail: "FATAL: could not connect to postgres://user:hunter2@db.internal:5432/prod (password authentication failed)" },
      { name: `exec${String.fromCharCode(0)}utor\n${"x".repeat(200)}`, ok: true },
    ],
  });
  const response = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(response.status, 503);
  const body = response.body as { status: string; components: { name: string; ok: boolean; degraded: boolean }[] };
  assert.equal(body.status, "not ready");
  assert.equal(body.components.length, 2);
  for (const component of body.components) assert.deepEqual(Object.keys(component).sort(), ["degraded", "name", "ok"]);
  assert.equal(body.components[0]!.name, "database");
  assert.equal(body.components[0]!.ok, false);
  assert.equal(body.components[0]!.degraded, true);
  assert.equal(body.components[1]!.ok, true);
  assert.equal(body.components[1]!.degraded, false);
  // A name that is not a plain identifier is refused outright on the public
  // surface — it is not sanitized into something echoable.
  assert.equal(body.components[1]!.name, "unknown");
  assert.ok(body.components[1]!.name.length <= 64);
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /hunter2|password|postgres:\/\/|detail|FATAL/);
});

test("public readiness redacts credential-shaped component names", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({
    components: [
      { name: "sk-12345678901234567890", ok: true },
      { name: "postgres://user:hunter2@db.internal", ok: true },
      { name: "Bearer admin-secret-token", ok: true },
      { name: "github_pat_11ABCDEFG0abcdefghijklmnop", ok: true },
      { name: "data\u202Ebase", ok: true },
      { name: "postgres://user:pa/ss@db.internal", ok: true },
      { name: "postgres://user:p@ss@db.internal", ok: true },
    ],
  });
  const response = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(response.status, 200);
  const body = response.body as { components: { name: string }[] };
  assert.doesNotMatch(JSON.stringify(response.body), /sk-12345678901234567890|hunter2|admin-secret-token|github_pat_11ABCDEFG0abcdefghijklmnop|pa\/ss|p@ss/);
  assert.match(JSON.stringify(response.body), /REDACTED/);
  assert.doesNotMatch(body.components[4]!.name, /\u202E/);
  // DSN-shaped names are refused as identifiers, not echoed.
  for (const index of [1, 2, 4, 5, 6]) assert.equal(body.components[index]!.name, "unknown");
});

test("public readiness bounds the component list but decides readiness over all of them", async () => {
  const { context } = fixture();
  const components = Array.from({ length: 200 }, (_, index) => ({ name: `component-${index}`, ok: true }));
  context.deps.readiness = async () => ({ components: [...components, { name: "database", ok: false, degraded: true }] });
  const response = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(response.status, 503);
  const body = response.body as { components: { name: string; ok: boolean; degraded: boolean }[] };
  assert.equal(body.components.length, 64);
  // The failing component is listed FIRST, so the cap cannot hide it.
  assert.equal(body.components[0]!.name, "database");
  assert.equal(body.components[0]!.ok, false);
});

test("readiness flags fail closed on non-boolean seam values", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({ components: [{ name: "database", ok: true, degraded: "yes" }] } as unknown as { readonly components: readonly ReadinessComponent[] });
  const degraded = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(degraded.status, 503);
  assert.equal((degraded.body as { components: { degraded: boolean }[] }).components[0]!.degraded, true);
  context.deps.readiness = async () => ({ components: [{ name: "database", ok: 1 }] } as unknown as { readonly components: readonly ReadinessComponent[] });
  const notOk = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(notOk.status, 503);
  assert.equal((notOk.body as { components: { ok: boolean }[] }).components[0]!.ok, false);
  // An ABSENT flag is absent, not a failure: a JSON seam yields null for an
  // unset boolean and a healthy component must stay in rotation.
  context.deps.readiness = async () => ({ components: [{ name: "database", ok: true, degraded: null }] } as unknown as { readonly components: readonly ReadinessComponent[] });
  const absent = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(absent.status, 200);
  assert.equal((absent.body as { components: { degraded: boolean }[] }).components[0]!.degraded, false);
});

test("a hostile readiness seam cannot make the public route do unbounded work", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({ components: [{ name: "a".repeat(100_000), ok: true }] });
  const started = Date.now();
  const response = await dispatchAdminRoute(context, req("GET", "/readyz"));
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 2000, "hostile readiness name must be bounded");
});

test("authenticated admin status keeps a bounded, redacted readiness detail", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({
    components: [{ name: "database", ok: false, degraded: true, detail: `dsn=postgres://user:hunter2@db.internal/prod token=sk-12345678901234567890 password=s3cret github_pat_11ABCDEFG0abcdefghijklmnop ${"y".repeat(1000)}` }],
  });
  const response = await dispatchAdminRoute(context, req("GET", "/admin/status", { authorization: "Bearer secret-value" }));
  assert.equal(response.status, 200);
  const body = response.body as { readiness: { components: { name: string; ok: boolean; degraded: boolean; detail?: string }[] } };
  const component = body.readiness.components[0]!;
  assert.equal(component.name, "database");
  assert.ok((component.detail ?? "").length <= 512);
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /hunter2|sk-12345678901234567890|s3cret|github_pat_11ABCDEFG0abcdefghijklmnop/);
  assert.match(serialized, /REDACTED/);
});

test("readiness detail redacts quoted and keyed credential assignments", async () => {
  const { context } = fixture();
  context.deps.readiness = async () => ({
    components: [{ name: "database", ok: false, degraded: true, detail: `{"password": "quoted-secret", "private_key": "pk-live-1234", "client_secret": 'single-quoted', "dsn": "postgres://db.internal:5432/prod?password=query-secret", "escaped": "a\\"b"}` }],
  });
  const response = await dispatchAdminRoute(context, req("GET", "/admin/status", { authorization: "Bearer secret-value" }));
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /quoted-secret|pk-live-1234|single-quoted|query-secret/);
  assert.match(serialized, /REDACTED/);
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
  const { context, calls, events } = fixture("running");
  const headers = { authorization: "Bearer secret-value", contentType: "application/json" };
  assert.equal((await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", headers))).status, 202);
  assert.deepEqual(calls, ["cancel", "audit"]);
  context.deps.getRun = async () => run("completed");
  assert.equal((await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", headers))).status, 409);
  context.deps.getRun = async () => null;
  assert.equal((await dispatchAdminRoute(context, req("POST", "/admin/runs/run-9/cancel", headers))).status, 404);
  assert.deepEqual(events.map((event) => ({ action: event.action, target: event.target, outcome: event.outcome })), [
    { action: "cancel", target: { kind: "run", id: "run-1" }, outcome: "accepted" },
    { action: "cancel", target: { kind: "run", id: "run-1" }, outcome: "refused" },
    { action: "cancel", target: { kind: "run", id: "run-9" }, outcome: "refused" },
  ]);
});

test("query and unknown routes fail closed", async () => {
  const { context } = fixture();
  const authorization = "Bearer secret-value";
  assert.equal((await dispatchAdminRoute(context, req("GET", "/admin/runs", { authorization, search: "?limit=999" }))).status, 400);
  assert.equal((await dispatchAdminRoute(context, req("GET", "/missing", { authorization }))).status, 404);
});

test("audit records identify the mutation target and carry the settlement timestamp", async () => {
  const { context, events } = fixture("running", () => 1_700_000_000_000);
  const headers = { authorization: "Bearer secret-value", contentType: "application/json" };
  await dispatchAdminRoute(context, req("POST", "/admin/rereview", { ...headers, body: { prKey: "github/123/repo#1/review", reason: "manual" } }));
  await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", headers));
  assert.deepEqual(events.map((event) => ({ action: event.action, requestId: event.requestId, target: event.target, outcome: event.outcome, atMs: event.atMs })), [
    { action: "rereview", requestId: "req-1", target: { kind: "pr", id: "github/123/repo#1/review" }, outcome: "accepted", atMs: 1_700_000_000_000 },
    { action: "cancel", requestId: "req-1", target: { kind: "run", id: "run-1" }, outcome: "accepted", atMs: 1_700_000_000_000 },
  ]);
});

test("refused and failed mutations still audit the target identity", async () => {
  const { context, events } = fixture("running", () => 42);
  context.deps.forceRereview = async () => ({ refused: "terminal" });
  const refused = await dispatchAdminRoute(context, req("POST", "/admin/rereview", { authorization: "Bearer secret-value", contentType: "application/json", body: { prKey: "github/9/repo#2/review", reason: "manual" } }));
  assert.equal(refused.status, 409);
  context.deps.cancelRun = async () => { throw new Error("seam failure"); };
  const failed = await dispatchAdminRoute(context, req("POST", "/admin/runs/run-7/cancel", { authorization: "Bearer secret-value", contentType: "application/json" }));
  assert.equal(failed.status, 500);
  assert.deepEqual(events.map((event) => ({ action: event.action, target: event.target, outcome: event.outcome, atMs: event.atMs })), [
    { action: "rereview", target: { kind: "pr", id: "github/9/repo#2/review" }, outcome: "refused", atMs: 42 },
    { action: "cancel", target: { kind: "run", id: "run-7" }, outcome: "error", atMs: 42 },
  ]);
});

test("audit events fall back to a wall-clock timestamp when no clock is injected", async () => {
  const { context, events } = fixture();
  const before = Date.now();
  await dispatchAdminRoute(context, req("POST", "/admin/rereview", { authorization: "Bearer secret-value", contentType: "application/json", body: { prKey: "github/5/repo#3/review", reason: "manual" } }));
  const after = Date.now();
  assert.equal(events.length, 1);
  assert.ok(Number.isInteger(events[0]!.atMs));
  assert.ok(events[0]!.atMs >= before && events[0]!.atMs <= after);
});

test("a broken audit clock falls back to wall-clock time", async () => {
  const { context, events } = fixture("running", () => Number.NaN);
  const before = Date.now();
  await dispatchAdminRoute(context, req("POST", "/admin/rereview", { authorization: "Bearer secret-value", contentType: "application/json", body: { prKey: "github/6/repo#4/review", reason: "manual" } }));
  const after = Date.now();
  assert.ok(events[0]!.atMs >= before && events[0]!.atMs <= after);
});

test("an unusable audit clock never breaks the mutation path", async () => {
  const { context, events } = fixture("running", () => { throw new Error("clock failure"); });
  const before = Date.now();
  const response = await dispatchAdminRoute(context, req("POST", "/admin/rereview", { authorization: "Bearer secret-value", contentType: "application/json", body: { prKey: "github/7/repo#5/review", reason: "manual" } }));
  const after = Date.now();
  assert.equal(response.status, 202);
  assert.equal(events.length, 1);
  assert.ok(events[0]!.atMs >= before && events[0]!.atMs <= after);
  const absurd = fixture("running", () => 1e300);
  await dispatchAdminRoute(absurd.context, req("POST", "/admin/rereview", { authorization: "Bearer secret-value", contentType: "application/json", body: { prKey: "github/8/repo#6/review", reason: "manual" } }));
  assert.ok(Number.isSafeInteger(absurd.events[0]!.atMs));
});

test("a throwing run-lookup seam still audits the failed mutation", async () => {
  const { context, events } = fixture("running", () => 5);
  context.deps.getRun = async () => { throw new Error("store failure"); };
  const response = await dispatchAdminRoute(context, req("POST", "/admin/runs/run-1/cancel", { authorization: "Bearer secret-value", contentType: "application/json" }));
  assert.equal(response.status, 500);
  assert.deepEqual(events.map((event) => ({ action: event.action, target: event.target, outcome: event.outcome, atMs: event.atMs })), [
    { action: "cancel", target: { kind: "run", id: "run-1" }, outcome: "error", atMs: 5 },
  ]);
});
