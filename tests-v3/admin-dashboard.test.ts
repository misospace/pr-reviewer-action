/**
 * Pins route/auth/CSP integrity, escaping/XSS fences, exact admin-API
 * compatibility, hostile EXECUTION boundaries, and operator UI states.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import vm from "node:vm";
import { createAdminHost } from "../src/admin/server.js";
import { ADMIN_ROUTE_TABLE } from "../src/admin/routes.js";
import { DASHBOARD_HTML, DASHBOARD_JS, serveDashboard } from "../src/admin/dashboard.js";
import type { ControllerAdminDeps } from "../src/admin/types.js";

/**
 * Pins route/auth/CSP integrity, escaping/XSS fences, exact admin-API
 * compatibility, hostile EXECUTION boundaries, and operator UI states.
 */
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'sha256-2UPZoIdLr/DB0rB7iH8yqCXgjRaaF654c+JAFCZDcgM='; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const deps = {
  readiness: async () => ({ components: [{ name: "store", ok: true }] }),
  listRuns: async () => ({ runs: [] }),
  getRun: async () => null,
  adoptionStatus: async () => ({ repositories: [] }),
  queueStatus: async () => ({ depthByState: { queued: 0, starting: 0, running: 0, publishing: 0, completed: 0, failed: 0, cancelled: 0, superseded: 0 }, oldestAgeMs: 0, activeWorkersByExecutor: {} }),
  diagnostics: async () => ({ ready: true }),
  forceRereview: async () => ({ jobId: "job-1" }),
  cancelRun: async () => ({ cancelled: true as const }),
  audit: () => void 0
};
async function listening(dashboard: boolean, token?: string, overrides?: Partial<ControllerAdminDeps>) {
  const host = createAdminHost({ deps: { ...deps, ...overrides }, ...token === void 0 ? {} : { token }, ...dashboard ? { dashboard: {} } : {} });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}
test("dashboard is optional and off by default", async (t) => {
  const f = await listening(false);
  t.after(() => f.server.close());
  for (const path of ["/dashboard", "/dashboard/app.js"]) {
    const r = await fetch(f.base + path);
    assert.equal(r.status, 404, path);
    assert.match(await r.text(), /not found/);
  }
});
test("service without the dashboard keeps every route unchanged", async (t) => {
  const off = await listening(false);
  t.after(() => off.server.close());
  const on = await listening(true);
  t.after(() => on.server.close());
  const offAuth = await listening(false, "admin-secret");
  t.after(() => offAuth.server.close());
  const onAuth = await listening(true, "admin-secret");
  t.after(() => onAuth.server.close());
  assert.equal((await fetch(off.base + "/healthz")).status, 200);
  assert.equal((await fetch(on.base + "/healthz")).status, 200);
  assert.equal((await fetch(off.base + "/admin/status")).status, 503);
  assert.equal((await fetch(on.base + "/admin/status")).status, 503);
  assert.equal((await fetch(offAuth.base + "/admin/status")).status, 401);
  assert.equal((await fetch(onAuth.base + "/admin/status")).status, 401);
  assert.equal((await fetch(onAuth.base + "/admin/status", { headers: { authorization: "Bearer admin-secret" } })).status, 200);
});
test("enabled dashboard serves shell and script with fixed security headers", async (t) => {
  const f = await listening(true);
  t.after(() => f.server.close());
  for (const [path, type, body] of [["/dashboard", "text/html; charset=utf-8", DASHBOARD_HTML], ["/dashboard/app.js", "text/javascript; charset=utf-8", DASHBOARD_JS]]) {
    const r = await fetch(f.base + path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), type);
    assert.equal(r.headers.get("content-security-policy"), CSP);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(await r.text(), body);
  }
});
function servedStyleBlock() {
  const from = DASHBOARD_HTML.indexOf("<style>") + 7;
  assert.ok(from > 6);
  const close = DASHBOARD_HTML.indexOf("</style>", from);
  assert.ok(close > from);
  return DASHBOARD_HTML.slice(from, close);
}
test("style-src pins exact served CSS and denies every other inline style", () => {
  const digest = createHash("sha256").update(servedStyleBlock(), "utf8").digest("base64");
  assert.equal(CSP, `default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'sha256-${digest}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  assert.doesNotMatch(CSP, /unsafe-inline/);
  assert.equal(CSP.match(/style-src/g)?.length, 1);
  assert.match(CSP, /style-src 'sha256-[A-Za-z0-9+/=]+'; frame-ancestors 'none'/);
  const authorised = [...CSP.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(authorised, [digest]);
  const hostileStyle = "body { display: none; }";
  const hostileDigest = createHash("sha256").update(hostileStyle, "utf8").digest("base64");
  assert.ok(!authorised.includes(hostileDigest), "served CSP must not authorize a hostile style block");
  assert.equal(DASHBOARD_HTML.match(/<style\b/gi)?.length, 1);
  assert.doesNotMatch(DASHBOARD_HTML, /\sstyle\s*=/i);
  assert.doesNotMatch(DASHBOARD_HTML, /<link\b/i);
  assert.doesNotMatch(DASHBOARD_JS, /\.style\b/);
  assert.equal(serveDashboard("/dashboard")?.headers["Content-Security-Policy"], CSP);
  assert.equal(serveDashboard("/dashboard/app.js")?.headers["Content-Security-Policy"], CSP);
});
test("dashboard doc pins the served CSP", () => {
  const doc = readFileSync("docs/architecture/operations-dashboard.md", "utf8");
  const line = doc.split("\n").find((x) => x.startsWith("Content-Security-Policy:"));
  assert.ok(line);
  assert.equal(line.slice("Content-Security-Policy:".length).trim(), CSP);
});
test("method and path discipline: only two GET routes", async (t) => {
  const f = await listening(true);
  t.after(() => f.server.close());
  assert.equal((await fetch(f.base + "/dashboard", { method: "POST" })).status, 404);
  const extra = await fetch(f.base + "/dashboard/extra");
  assert.equal(extra.status, 404);
  assert.doesNotMatch(await extra.text(), /<!doctype html|app\.js/i);
});
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = httpRequest({ host: u.hostname, port: Number(u.port), path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk.toString("utf8"));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
test("traversal paths are delivered verbatim and never serve shell content", async (t) => {
  const f = await listening(true);
  t.after(() => f.server.close());
  for (const path of ["/dashboard/../admin/status", "/dashboard%2f..%2fadmin/status"]) {
    const r = await rawGet(f.base, path);
    assert.notEqual(r.status, 200);
    assert.ok([401, 403, 404, 503].includes(r.status));
    assert.doesNotMatch(r.body, /<!doctype html|app\.js/i);
  }
});
test("shell is inert, byte-identical, and carries no host or token", async (t) => {
  const f = await listening(true, "admin-secret-token-value");
  t.after(() => f.server.close());
  const a = await fetch(f.base + "/dashboard", { headers: { host: "first.example.com" } });
  const b = await fetch(f.base + "/dashboard", { headers: { host: "second.example.org:9999", authorization: "Bearer admin-secret-token-value" } });
  assert.equal(await a.text(), await b.text());
  for (const secret of ["admin-secret-token-value", "first.example.com", "second.example.org", "owner/repo"]) {
    assert.ok(!DASHBOARD_HTML.includes(secret));
    assert.ok(!DASHBOARD_JS.includes(secret));
  }
});
test("auth boundary intact: dashboard does not open admin data routes", async (t) => {
  const f = await listening(true, "admin-secret");
  t.after(() => f.server.close());
  for (const path of ["/admin/status", "/admin/runs", "/admin/runs/x", "/admin/runs/x/cancel", "/admin/rereview", "/admin/diagnostics"]) assert.equal((await fetch(f.base + path)).status, 401, path);
  assert.equal((await fetch(f.base + "/admin/status", { headers: { authorization: "Bearer wrong" } })).status, 401);
});
test("no direct db, cluster, or forge access from dashboard", () => {
  assert.equal(serveDashboard("/dashboard")?.headers["Content-Security-Policy"], CSP);
  assert.match(CSP, /connect-src 'self'/);
  assert.match(CSP, /frame-ancestors 'none'/);
  assert.equal([...DASHBOARD_JS.matchAll(/fetch\(/g)].length, 1);
  for (const m of DASHBOARD_JS.matchAll(/[\"'](\/[^\"']*)[\"']/g)) {
    assert.ok(!m[1]!.startsWith("//"));
    assert.ok(!m[1]!.includes("://"));
  }
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "innerText", "new Function", "setAttribute", "srcdoc", "localStorage", "sessionStorage", "document.cookie", "javascript:", "https://", "http://", "ws://", "wss://", "EventSource", "WebSocket", "sk-", "unredact", "decrypt", "atob(", "eval(", "owner/repo"]) {
    assert.ok(!DASHBOARD_JS.includes(banned), banned);
    assert.ok(!DASHBOARD_HTML.includes(banned), banned);
  }
  assert.match(DASHBOARD_JS, /^"use strict";/);
  // These constants are embedded in TypeScript template literals.
  assert.doesNotMatch(DASHBOARD_JS, /`|\$\{/);
});
test("admin-API-compatibility pin", () => {
  const entries = ADMIN_ROUTE_TABLE.filter((entry) => entry.includes("/admin/")).map((entry) => entry.split(" ")[1]!);
  const fixedPaths = new Set(["/admin/status", "/admin/runs", "/admin/rereview", "/admin/diagnostics"]);
  const referenced = new Set<string>();
  if (/"\/admin\/runs\/"\s*\+\s*encodeURIComponent\([^)]*\)\s*\+\s*"\/cancel"/.test(DASHBOARD_JS)) {
    referenced.add("/admin/runs/{runId}/cancel");
  }
  for (const match of DASHBOARD_JS.matchAll(/[\"'](\/admin[^\"']*)[\"']/g)) {
    const literal = match[1]!;
    const path = literal.split("?", 1)[0]!;
    if (literal === path && fixedPaths.has(path)) {
      referenced.add(path);
      continue;
    }
    if (/^\/admin\/runs\/[^/]+\/cancel$/.test(path)) {
      referenced.add("/admin/runs/{runId}/cancel");
      continue;
    }
    if (literal.startsWith("/admin/runs?")) {
      referenced.add("/admin/runs");
      continue;
    }
    assert.equal(literal, "/admin/runs/", `unsupported admin API literal: ${literal}`);
    referenced.add("/admin/runs/{runId}");
  }
  for (const entry of entries) {
    assert.ok(referenced.has(entry), `dashboard must exercise ${entry}`);
  }
});
const MARKERS = [
  "<img src=x onerror=alert(1)>",
  "</script><readiness-marker>",
  '"executor-onmouseover"',
  "not-a-number-created-marker",
  "publication-marker",
  "<svg onload=alert(1)>",
  "Bearer sk-fake-token-123456",
  "<rereview-refusal-marker>",
  "hostile-run-state",
  "hostile-detail-state",
  "\u0000\u001f\u202e",
  "<failure-reason-marker>"
] as const;
interface HarnessOptions {
  payloads?: Record<string, unknown>;
  responses?: Record<string, { status: number; body: string }>;
  reject?: string;
  confirm?: () => boolean;
  /** The rereview form's field values: the client's own gate reads them
   *  before it decides to POST. The default is a VALID pair, so a test that
   *  exercises the API path does not have to restate it. */
  form?: { readonly prKey?: string; readonly reason?: string };
}
function harness(options: HarnessOptions = {}) {
  const textData: string[] = [];
  const attributeCalls: Array<{ element: string; name: string; value: unknown }> = [];
  const propertyWrites: Array<{ prop: string; value: unknown }> = [];
  const listeners: Record<string, Array<(event?: any) => unknown>> = {};
  const paths: string[] = [];
  const elements = new Map<string, { proxy: any; raw: any }>();
  function make(name: string) {
    const raw: any = { children: [] as unknown[], dataset: {}, addEventListener(type: string, fn: (event?: any) => unknown) {
      (listeners[name + ":" + type] ??= []).push(fn);
    }, appendChild(child: unknown) {
      raw.children.push(child);
      return child;
    }, replaceChildren(...kids: unknown[]) {
      raw.children = kids;
    }, setAttribute: (name: string, value: unknown) => {
      attributeCalls.push({ element: name, name, value });
    }, className: "", disabled: false };
    const proxy = new Proxy(raw, { set(target: any, prop: string | symbol, value: unknown) {
      propertyWrites.push({ prop: String(prop), value });
      target[prop] = value;
      return true;
    } });
    return { proxy, raw };
  }
  const document: any = { documentElement: { dataset: {} }, createElement: (tag: string) => make(tag).proxy, createTextNode: (v: unknown) => {
    const s = String(v);
    textData.push(s);
    return { data: s };
  }, getElementById: (id: string) => {
    if (!elements.has(id)) elements.set(id, make("#" + id));
    return elements.get(id)!.proxy;
  } };
  async function untilSettled(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; !pred(); i++) {
      assert.ok(i < 1e3, "never settled: " + what);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const responseMap = options.responses ?? {};
  const sandbox = vm.createContext({
    document,
    confirm: options.confirm ?? (() => true),
    Date,
    fetch: async (path: string) => {
    paths.push(String(path));
    if (options.reject === path) throw new Error("offline");
    const forced = responseMap[path];
    const body = forced?.body ?? JSON.stringify(options.payloads?.[path] ?? {});
    const status = forced?.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  } });
  vm.runInContext(DASHBOARD_JS, sandbox);
  elements.get("token")!.raw.value = "token-user-input";
  // The rereview form's field values: the client's own gate reads them.
  const formValue = (id: string, value: string): void => {
    document.getElementById(id);
    elements.get(id)!.raw.value = value;
  };
  formValue("rereview-key", options.form?.prKey ?? "owner/repo#7");
  formValue("rereview-reason", options.form?.reason ?? "manual");
  function containerText(id: string): string {
    let out = "";
    const walk = (node: any) => {
      if (!node) return;
      if (typeof node.data === "string") out += node.data;
      for (const child of node.children ?? []) walk(child);
    };
    walk(elements.get(id)?.raw);
    return out;
  }
  return { textData, attributeCalls, propertyWrites, listeners, paths, elements, containerText, documentElement: document.documentElement, sandbox, responses: options.responses ?? {}, untilSettled };
}
test("execution fence: hostile API values appear verbatim in text nodes only", async () => {
  const h = harness({
    payloads: {
      "/admin/status": {
        queue: { depthByState: { running: 1 }, oldestAgeMs: 5, activeWorkersByExecutor: { [MARKERS[10]]: 1 } },
        adoption: { repositories: [{ platform: "github", repository: MARKERS[0], enabled: true }] },
        readiness: { components: [{ name: "probe", ok: true, detail: MARKERS[1] }] },
      },
      "/admin/runs?limit=50": {
        runs: [
          { runId: MARKERS[2], jobId: MARKERS[2], kind: "review", state: MARKERS[8], executorIdentity: MARKERS[2], attempt: 1, headSha: MARKERS[2], failureReason: MARKERS[2], createdAtMs: MARKERS[3], updatedAtMs: 1700000000000 },
          { runId: "failed-run", jobId: "failed-job", state: "failed", failureReason: MARKERS[11] },
          null
        ],
      },
      [`/admin/runs/${encodeURIComponent(MARKERS[2])}`]: {
        runId: MARKERS[2],
        state: "hostile-detail-state",
        publication: { state: "pending", attempt: 1, lastOutcome: MARKERS[4] },
        usage: [{ role: MARKERS[5], requestCount: 1, tokens: 2, costMicros: 3, costProvenance: MARKERS[5] }],
      },
      "/admin/diagnostics": { region: MARKERS[6] },
      "/admin/runs/undefined/cancel": { cancelled: true },
    },
    responses: { "/admin/rereview": { status: 409, body: JSON.stringify({ error: MARKERS[7] }) } },
  });
  vm.runInContext("loadAll(); undefined", h.sandbox);
  vm.runInContext(`loadRunDetail(${JSON.stringify(MARKERS[2])}); undefined`, h.sandbox);
  vm.runInContext("loadDiagnostics(); undefined", h.sandbox);
  assert.equal(h.listeners["#rereview:click"]?.length, 1);
  await h.listeners["#rereview:click"]![0]!();
  await h.untilSettled(() => MARKERS.every((x) => h.textData.some((t) => t.includes(x))), "marker renders");
  const detailHandlers = h.listeners["button:click"] ?? [];
  for (const handler of detailHandlers) await handler();
  await h.untilSettled(() => h.paths.some((path) => path.endsWith("/cancel")), "hostile detail cancel request");
  for (const marker of MARKERS) assert.ok(h.textData.some((x) => x.includes(marker)), marker);
  for (const write of h.propertyWrites) {
    for (const marker of MARKERS) assert.ok(!String(write.value).includes(marker));
  }
  assert.ok(h.textData.includes("hostile-run-state"));
  assert.ok(h.textData.includes("hostile-detail-state"));
  assert.ok(h.containerText("overview-failures").includes(MARKERS[11]), "actionable-failures list must render the failure marker");
  assert.ok(h.containerText("runs").includes(MARKERS[11]), "runs-row failure column must render the failure marker");
  assert.ok(h.paths.some((path) => path.endsWith("/cancel")), "cancel button must call the cancel API");
  assert.ok(h.propertyWrites.some((write) => write.prop === "className" && write.value === "chip"));
  assert.ok(!h.propertyWrites.some((write) => String(write.value).includes("hostile-run-state")), "API run state must never enter a property write");
  assert.ok(!h.propertyWrites.some((write) => String(write.value).includes("hostile-detail-state")), "API detail state must never enter a property write");
  assert.deepEqual(h.attributeCalls, []);
});
test("ui states: empty, auth, offline, pagination, and mutation feedback", async () => {
  const h = harness({
    payloads: {
      "/admin/status": { readiness: { components: [] }, queue: { depthByState: {}, activeWorkersByExecutor: {} }, adoption: { repositories: [] } },
      "/admin/runs?limit=50": { runs: [], nextCursor: "c2" },
      "/admin/runs?limit=50&cursor=c2": { runs: [] },
      "/admin/runs/active": { runId: "active", state: "running", usage: [], publication: { state: "none" } },
    },
    responses: {
      "/admin/rereview": { status: 202, body: '{"jobId":"accepted-rereview-sentinel"}' },
      "/admin/runs/active/cancel": { status: 200, body: '{"cancelled":true}' },
    },
  });
  vm.runInContext("loadAll(); undefined", h.sandbox);
  await h.untilSettled(() => h.textData.includes("No runs yet."), "empty runs");
  assert.ok(h.textData.includes("No runs yet."));
  await h.listeners["#runs-next:click"]![0]!();
  await h.untilSettled(() => h.paths.includes("/admin/runs?limit=50&cursor=c2"), "next page");
  await h.listeners["#runs-prev:click"]![0]!();
  await h.untilSettled(() => h.paths.filter((x) => x === "/admin/runs?limit=50").length > 1, "previous page");
  assert.ok(h.paths.includes("/admin/runs?limit=50"));
  const unauthorized = harness({ responses: { "/admin/status": { status: 401, body: '{"error":"no"}' }, "/admin/runs?limit=50": { status: 401, body: '{"error":"no"}' }, "/admin/diagnostics": { status: 401, body: '{"error":"no"}' } } });
  vm.runInContext("loadAll(); undefined", unauthorized.sandbox);
  await unauthorized.untilSettled(() => unauthorized.textData.includes("Authorization required"), "unauthorized");
  assert.ok(unauthorized.textData.includes("unauthorized"));
  assert.ok(!unauthorized.textData.includes("ready"));
  const offline = harness({ reject: "/admin/status" });
  vm.runInContext("loadAll(); undefined", offline.sandbox);
  await offline.untilSettled(() => offline.textData.includes("Can't reach the controller"), "offline");
  assert.ok(offline.textData.includes("Can't reach the controller"));
  vm.runInContext("loadRunDetail('active'); undefined", h.sandbox);
  await h.untilSettled(() => Boolean(h.listeners["button:click"]?.length), "cancel registration");
  const cancelHandlers = h.listeners["button:click"]!;
  await cancelHandlers[cancelHandlers.length - 1]!();
  await h.untilSettled(() => h.textData.includes("Cancellation accepted."), "cancel success");
  assert.ok(h.textData.includes("Cancellation accepted."));
  const rereview = h.listeners["#rereview:click"]![0]!;
  await rereview();
  await h.untilSettled(() => h.textData.includes("Rereview accepted."), "rereview accepted");
  assert.ok(h.textData.includes("Rereview accepted."));
  const refused = harness({ responses: { "/admin/rereview": { status: 409, body: '{"error":"refused-rereview-sentinel"}' } } });
  vm.runInContext("document.getElementById('token').value='token'; undefined", refused.sandbox);
  await refused.listeners["#rereview:click"]![0]!();
  await refused.untilSettled(() => refused.textData.includes("Rereview was refused."), "rereview refusal");
  assert.ok(refused.paths.includes("/admin/rereview"));
  assert.ok(refused.textData.some((x) => x.includes("HTTP 409")));
  // The controller's own reason reaches the operator, not a bare status.
  assert.ok(refused.textData.some((x) => x.includes("refused-rereview-sentinel")));
  const cancelRefused = harness({ payloads: { "/admin/runs/refused": { runId: "refused", state: "running", usage: [], publication: {} } }, responses: { "/admin/runs/refused/cancel": { status: 409, body: '{"error":"cancel-refusal-sentinel"}' } } });
  vm.runInContext("loadRunDetail('refused'); undefined", cancelRefused.sandbox);
  await cancelRefused.untilSettled(() => Boolean(cancelRefused.listeners["button:click"]?.length), "cancel refusal button");
  const refusalButton = cancelRefused.listeners["button:click"]!;
  await refusalButton[refusalButton.length - 1]!();
  await cancelRefused.untilSettled(() => cancelRefused.paths.includes("/admin/runs/refused/cancel"), "cancel refusal request");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(cancelRefused.textData.some((x) => x.includes("HTTP 409")));
  assert.ok(!cancelRefused.propertyWrites.some((write) => String(write.value).includes("cancel-refusal-sentinel")));
  assert.ok(cancelRefused.textData.includes("Cancellation was refused."));
  assert.ok(cancelRefused.textData.some((x) => x.includes("cancel-refusal-sentinel")));
  const theme = h.listeners["#theme:click"]![0]!;
  await theme({ currentTarget: h.elements.get("theme")!.proxy });
  assert.equal(h.documentElement?.dataset.theme, "dark");
  const back = h.listeners["button:click"]!;
  await back[back.length - 2]!();
  assert.equal(h.elements.get("view-runs")!.raw.className, "view view-active", "back must re-activate the runs view");
  assert.equal(h.elements.get("view-run")!.raw.className, "view", "back must deactivate the run view");
  const beforeRefresh = h.paths.filter((path) => path === "/admin/runs?limit=50").length;
  await h.listeners["#runs-refresh:click"]![0]!();
  await h.untilSettled(() => h.paths.filter((path) => path === "/admin/runs?limit=50").length > beforeRefresh, "refresh runs");
  const denied = harness({ confirm: () => false, payloads: { "/admin/runs/active": { runId: "active", state: "running", usage: [], publication: {} } } });
  vm.runInContext("loadRunDetail('active'); undefined", denied.sandbox);
  await denied.untilSettled(() => Boolean(denied.listeners["button:click"]?.length), "confirm-refused cancel button");
  await denied.listeners["button:click"]![denied.listeners["button:click"]!.length - 1]!();
  await denied.listeners["#rereview:click"]![0]!();
  assert.ok(!denied.paths.some((path) => path.endsWith("/cancel") || path === "/admin/rereview"));
  assert.ok(!denied.textData.some((text) => ["Cancellation accepted.", "Rereview accepted.", "was not accepted", "was refused"].some((value) => text.includes(value))));
});
test("the controller's refusal reason reaches the operator (409)", async () => {
  const h = harness({
    responses: { "/admin/rereview": { status: 409, body: JSON.stringify({ error: "request refused", detail: "the repository is not adopted for review" }) } },
  });
  await h.listeners["#rereview:click"]![0]!();
  await h.untilSettled(() => h.textData.includes("Rereview was refused."), "rereview refusal");
  assert.ok(h.paths.includes("/admin/rereview"), "a well-formed request reaches the controller");
  const feedback = h.containerText("rereview-msg");
  assert.ok(feedback.includes("Rereview was refused."), feedback);
  assert.ok(feedback.includes("the repository is not adopted for review"), feedback);
});

test("a refused cancellation shows the controller's reason (409)", async () => {
  const h = harness({
    payloads: { "/admin/runs/refused": { runId: "refused", state: "running", usage: [], publication: {} } },
    responses: { "/admin/runs/refused/cancel": { status: 409, body: JSON.stringify({ error: "cancellation refused", detail: "the run has no queued generation" }) } },
  });
  vm.runInContext("loadRunDetail('refused'); undefined", h.sandbox);
  await h.untilSettled(() => Boolean(h.listeners["button:click"]?.length), "cancel refusal button");
  const buttons = h.listeners["button:click"]!;
  await buttons[buttons.length - 1]!();
  await h.untilSettled(() => h.paths.includes("/admin/runs/refused/cancel"), "cancel refusal request");
  await h.untilSettled(() => h.textData.includes("Cancellation was refused."), "cancel refusal headline");
  assert.ok(h.textData.some((x) => x.includes("the run has no queued generation")));
  assert.ok(!h.propertyWrites.some((write) => String(write.value).includes("the run has no queued generation")));
});

test("an invalid rereview form never reaches the controller", async () => {
  const noReason = harness({ form: { reason: "   " } });
  await noReason.listeners["#rereview:click"]![0]!();
  assert.ok(!noReason.paths.includes("/admin/rereview"), "an empty reason never POSTs");
  assert.ok(noReason.containerText("rereview-msg").includes("The reason is required."), noReason.containerText("rereview-msg"));
  const badKey = harness({ form: { prKey: "owner/repo" } });
  await badKey.listeners["#rereview:click"]![0]!();
  assert.ok(!badKey.paths.includes("/admin/rereview"), "a malformed PR key never POSTs");
  assert.ok(badKey.containerText("rereview-msg").includes("The PR key must look like owner/repo#123."), badKey.containerText("rereview-msg"));
  const paddedKey = harness({ form: { prKey: "owner/repo#007" } });
  await paddedKey.listeners["#rereview:click"]![0]!();
  assert.ok(!paddedKey.paths.includes("/admin/rereview"), "a padded PR number never POSTs");
  assert.ok(paddedKey.containerText("rereview-msg").includes("The PR key must look like owner/repo#123."), paddedKey.containerText("rereview-msg"));
});

test("state chip whitelist covers every lifecycle state", () => {
  const actual = vm.runInContext("({ queued: stateChipClass('queued'), starting: stateChipClass('starting'), running: stateChipClass('running'), publishing: stateChipClass('publishing'), completed: stateChipClass('completed'), failed: stateChipClass('failed'), cancelled: stateChipClass('cancelled'), superseded: stateChipClass('superseded'), unknown: stateChipClass('unrecognized') })", harness().sandbox);
  for (const state of ["queued", "starting", "running", "publishing", "completed", "failed", "cancelled", "superseded"]) {
    assert.ok(actual[state].includes("chip") && actual[state].includes(state), state);
  }
  assert.equal(actual.unknown, "chip");
});
test("auth and redaction are covered", async (t) => {
  const f = await listening(true, "admin-secret", { diagnostics: async () => ({ model_key: "sk-abcdefghijklmnop", region: "eu-central" }) });
  t.after(() => f.server.close());
  const r = await fetch(f.base + "/admin/diagnostics", { headers: { authorization: "Bearer admin-secret" } });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.doesNotMatch(body, /sk-abcdefghijklmnop/);
  assert.match(body, /REDACTED/);
  for (const banned of ["sk-", "unredact", "decrypt", "atob(", "eval("]) {
    assert.ok(!DASHBOARD_HTML.includes(banned));
    assert.ok(!DASHBOARD_JS.includes(banned));
  }
  assert.equal((await fetch(f.base + "/admin/diagnostics")).status, 401);
  assert.equal((await fetch(f.base + "/dashboard")).status, 200);
});
