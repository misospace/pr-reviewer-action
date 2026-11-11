/** Operations dashboard shell tests (#742): optional mount, fail-closed
 * default, security headers, inert shell, intact auth boundary, the
 * structural XSS fence on the embedded script, and an EXECUTION fence test
 * (#252 pattern): the script is evaluated against a stubbed DOM fed the
 * hostile inputs themselves, so the boundary is proven on real renders, not
 * just by grepping the source. */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import vm from "node:vm";
import { createAdminHost } from "../src/admin/server.js";
import { DASHBOARD_HTML, DASHBOARD_JS, serveDashboard } from "../src/admin/dashboard.js";
import type { ControllerAdminDeps } from "../src/admin/types.js";

const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
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
async function listening(dashboard: boolean, token?: string, overrides?: Partial<ControllerAdminDeps>) {
  const host = createAdminHost({ deps: { ...deps, ...overrides }, ...(token === undefined ? {} : { token }), ...(dashboard ? { dashboard: {} } : {}) });
  const server = createHttpServer(host.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("dashboard is optional and off by default", async (t) => {
  const fixture = await listening(false);
  t.after(() => fixture.server.close());
  for (const path of ["/dashboard", "/dashboard/app.js"]) {
    const response = await fetch(fixture.base + path);
    assert.equal(response.status, 404, path);
    assert.match(await response.text(), /not found/);
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
  // Unconfigured admin auth fails closed identically with and without the
  // dashboard mounted: the shell adds no route and relaxes nothing.
  assert.equal((await fetch(off.base + "/admin/status")).status, 503);
  assert.equal((await fetch(on.base + "/admin/status")).status, 503);
  assert.equal((await fetch(offAuth.base + "/admin/status")).status, 401);
  assert.equal((await fetch(onAuth.base + "/admin/status")).status, 401);
  assert.equal((await fetch(onAuth.base + "/admin/status", { headers: { authorization: "Bearer admin-secret" } })).status, 200);
});

test("enabled dashboard serves the shell and script with fixed security headers", async (t) => {
  const fixture = await listening(true);
  t.after(() => fixture.server.close());
  for (const [path, contentType, body] of [
    ["/dashboard", "text/html; charset=utf-8", DASHBOARD_HTML],
    ["/dashboard/app.js", "text/javascript; charset=utf-8", DASHBOARD_JS],
  ] as const) {
    const response = await fetch(fixture.base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), contentType, path);
    assert.equal(response.headers.get("content-security-policy"), CSP, path);
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/, path);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(await response.text(), body, path);
  }
});

test("method and path discipline: only the two GET routes exist", async (t) => {
  const fixture = await listening(true);
  t.after(() => fixture.server.close());
  assert.equal((await fetch(fixture.base + "/dashboard", { method: "POST" })).status, 404);
  const extra = await fetch(fixture.base + "/dashboard/extra");
  assert.equal(extra.status, 404);
  assert.doesNotMatch(await extra.text(), /<!doctype html|app\.js/i);
});

// `fetch` normalizes `..` client-side, so a fetch-based traversal probe never
// reaches the handler with the hostile path intact. The REAL boundary test
// sends the literal bytes over a raw `node:http` request: the request path is
// delivered verbatim, no client normalization.
function rawGet(base: string, path: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = httpRequest({ host: url.hostname, port: url.port, path, method: "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("traversal paths are sent verbatim and never serve shell content", async (t) => {
  const fixture = await listening(true);
  t.after(() => fixture.server.close());
  for (const path of ["/dashboard/../admin/status", "/dashboard%2f..%2fadmin/status"]) {
    const response = await rawGet(fixture.base, path);
    // Either the fixed 404 or the admin dispatch outcome (bearer-gated 503
    // unconfigured) — NEVER the shell, in any framing.
    assert.notEqual(response.status, 200, path);
    assert.ok([401, 403, 404, 503].includes(response.status), `${path} -> ${response.status}`);
    assert.doesNotMatch(response.body, /<!doctype html|app\.js/i, path);
  }
});

test("the shell is inert and static: identical bytes, no echo, no secrets", async (t) => {
  const fixture = await listening(true, "admin-secret-token-value");
  t.after(() => fixture.server.close());
  const first = await fetch(fixture.base + "/dashboard", { headers: { host: "first.example.com" } });
  const second = await fetch(fixture.base + "/dashboard", { headers: { host: "second.example.org:9999", authorization: "Bearer admin-secret-token-value" } });
  assert.equal(await first.text(), await second.text());
  for (const secret of ["admin-secret-token-value", "first.example.com", "second.example.org", "owner/repo"]) {
    assert.ok(!DASHBOARD_HTML.includes(secret), `shell must not carry ${secret}`);
    assert.ok(!DASHBOARD_JS.includes(secret), `script must not carry ${secret}`);
  }
});

test("auth boundary intact: dashboard on does not open any data route", async (t) => {
  const fixture = await listening(true, "admin-secret");
  t.after(() => fixture.server.close());
  for (const path of ["/admin/status", "/admin/runs", "/admin/runs/x", "/admin/runs/x/cancel", "/admin/rereview", "/admin/diagnostics"]) {
    const response = await fetch(fixture.base + path);
    assert.equal(response.status, 401, path);
  }
  assert.equal((await fetch(fixture.base + "/admin/status", { headers: { authorization: "Bearer wrong" } })).status, 401);
});

test("no direct db/cluster/forge access from the dashboard surface", async (t) => {
  // Structural fence #1: the CSP pins connect-src to 'self' and forbids
  // framing/base/form targets, so the UI can only reach the controller API
  // on the same origin — never a database, the Kubernetes API, or a forge
  // API directly, and never a framed hostile host.
  assert.equal(serveDashboard("/dashboard")?.headers["Content-Security-Policy"], CSP);
  assert.match(CSP, /connect-src 'self'/);
  assert.match(CSP, /frame-ancestors 'none'/);
  // Structural fence #2: the script has exactly one fetch site (the api()
  // wrapper), and every quoted path fragment in it is same-origin relative:
  // no protocol-relative or absolute-URL literal exists anywhere (the
  // banned-scheme list below covers the absolute forms). Quote-style
  // agnostic on purpose: ', ", and ` all count.
  assert.equal([...DASHBOARD_JS.matchAll(/fetch\(/g)].length, 1);
  for (const match of DASHBOARD_JS.matchAll(/['"`](\/[^'"`]*)['"`]/g)) {
    const literal = match[1]!;
    assert.ok(!literal.startsWith("//"), `path literal must not be protocol-relative: ${literal}`);
    assert.ok(!literal.includes("://"), `path literal must not be absolute: ${literal}`);
  }
  // Structural fence #3: no markup-injection, storage, dynamic-evaluation,
  // framing, or attribute-injection surface exists in the source, in any
  // quote style.
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "innerText", "new Function", "setAttribute", "srcdoc", "localStorage", "sessionStorage", "document.cookie", "javascript:", "https://", "http://", "ws://", "wss://", "EventSource", "WebSocket"]) {
    assert.ok(!DASHBOARD_JS.includes(banned), `script must not contain ${banned}`);
    assert.ok(!DASHBOARD_HTML.includes(banned), `shell must not contain ${banned}`);
  }
});

// ── the EXECUTION fence (#252): feed the hostile payloads themselves ──────

/** Hostile API-derived payloads, ONE UNIQUE MARKER PER RENDER PATH so a
 * deleted render path fails its own assertion: markup-injection, fence-escape,
 * attribute breakout, control/format characters, a credential-shaped string,
 * and a hostile mutation error body. */
const MARKERS = ["<img src=x onerror=alert(1)>", "</script><script>", '"onmouseover="', "\u0000\u001f\u202e", "Bearer sk-fake-token-123456", "<svg onload=alert(1)>"] as const;

test("execution fence: hostile API data is inserted verbatim as text and only via text nodes", async () => {
  const textData: string[] = [];
  const attributeCalls: { readonly element: string; readonly name: string; readonly value: unknown }[] = [];
  const propertyWrites: { readonly element: string; readonly prop: string; readonly value: unknown }[] = [];
  const listeners: Record<string, Array<() => unknown>> = {};
  const fetchedPaths: string[] = [];
  /** A stub element that records every write channel the script could use.
   * Only createTextNode data and textContent assignments are legitimate
   * text-insertion paths; anything else (property writes carrying API data,
   * attribute sets) is a fence breach. */
  function makeElement(name: string): { readonly proxy: Record<string, unknown>; readonly raw: Record<string, unknown> } {
    const raw: Record<string, unknown> = {
      children: [] as unknown[],
      addEventListener: (type: string, fn: () => unknown) => {
        (listeners[`${name}:${type}`] ??= []).push(fn);
      },
      appendChild: (child: unknown) => {
        (raw.children as unknown[]).push(child);
        return child;
      },
      replaceChildren: (...kids: unknown[]) => {
        raw.children = kids;
      },
      setAttribute: (attr: string, value: unknown) => {
        attributeCalls.push({ element: name, name: attr, value });
      },
    };
    const proxy = new Proxy(raw, {
      set(target, prop, value) {
        propertyWrites.push({ element: name, prop: String(prop), value });
        (target as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    });
    return { proxy, raw };
  }
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  const document = {
    createElement: (tag: string) => makeElement(tag).proxy,
    createTextNode: (data: unknown) => {
      const text = String(data);
      textData.push(text);
      return { data: text };
    },
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, makeElement(`#${id}`));
      return elements.get(id)!.proxy;
    },
  };
  // One render path per marker: status (adoption + readiness detail), the
  // runs table, run detail, diagnostics, and the rereview ERROR body —
  // deleting any one render path fails that path's own marker assertion.
  const payloads: Record<string, unknown> = {
    "/admin/status": {
      queue: { depthByState: { running: 1 }, oldestAgeMs: 5, activeWorkersByExecutor: {} },
      adoption: { repositories: [{ platform: "github", repository: MARKERS[0], enabled: true }] },
      readiness: { components: [{ name: "probe", ok: true, degraded: false, detail: MARKERS[1] }] },
    },
    "/admin/runs?limit=50": {
      runs: [{ runId: MARKERS[2], jobId: MARKERS[2], kind: "review", state: "running", executorIdentity: MARKERS[2], attempt: 1, headSha: MARKERS[2], failureReason: MARKERS[2], supersededByJobId: "", createdAtMs: "not-a-number", updatedAtMs: 1700000000000 }],
    },
    [`/admin/runs/${encodeURIComponent(MARKERS[2])}`]: {
      runId: MARKERS[2], state: "running",
      publication: { jobId: MARKERS[3], state: "pending", attempt: 1, lastOutcome: MARKERS[3] },
      usage: [{ role: MARKERS[3], requestCount: 1, tokens: 2, costMicros: 3, costProvenance: MARKERS[3] }],
    },
    "/admin/diagnostics": { model_key: "sk-abcdefghijklmnop", leak: MARKERS[4] },
  };
  // The rereview path answers with a REFUSED mutation carrying a hostile
  // error body, so the failure-rendering path is driven too.
  const responses: Record<string, { readonly ok: boolean; readonly status: number; readonly body: string }> = {
    "/admin/rereview": { ok: false, status: 409, body: JSON.stringify({ error: MARKERS[5] }) },
  };
  /** Deterministic settle: the sandboxed chains are pure microtasks (the
   * fetch stub resolves without I/O and the script schedules no timers), so
   * setImmediate turns advance them without fixed wall-clock timeouts. */
  async function untilSettled(pred: () => boolean, what: string): Promise<void> {
    for (let turns = 0; !pred(); turns++) {
      assert.ok(turns < 1000, `promise chains never settled: ${what}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const sandbox = vm.createContext({
    document,
    confirm: () => true,
    fetch: async (path: string) => {
      fetchedPaths.push(String(path));
      const forced = responses[String(path)];
      if (forced !== undefined) return { ok: forced.ok, status: forced.status, text: async () => forced.body };
      return { ok: true, status: 200, text: async () => JSON.stringify(payloads[String(path)] ?? {}) };
    },
  });
  vm.runInContext(DASHBOARD_JS, sandbox, { filename: "dashboard-app.js" });
  // The token input's value is the operator's OWN input (pre-set on the raw
  // target, outside the recording proxy), read only by `loadAll`.
  elements.get("token")!.raw.value = MARKERS[4];
  // Top-level function declarations attach to the context global; hostile
  // values are embedded as JSON string literals (safe JS source).
  vm.runInContext("loadAll(); undefined", sandbox);
  vm.runInContext(`loadRunDetail(${JSON.stringify(MARKERS[2])}); undefined`, sandbox);
  vm.runInContext("loadDiagnostics(); undefined", sandbox);
  // The rereview handler must EXIST (registered at the top level), then be
  // invoked (confirm stubbed true) so the mutation error path is driven.
  assert.equal(listeners["#rereview:click"]?.length, 1, "the rereview click handler must be registered");
  await listeners["#rereview:click"]![0]!();
  // The cancel handler is registered by the non-terminal run-detail render
  // (after loadRuns' detail buttons); invoke every handler that appeared
  // during loadRunDetail and require one of them to fetch the cancel path.
  const buttonsBeforeDetail = (listeners["button:click"] ?? []).length;
  vm.runInContext(`loadRunDetail(${JSON.stringify(MARKERS[2])}); undefined`, sandbox);
  await untilSettled(() => (listeners["button:click"] ?? []).length > buttonsBeforeDetail, "run-detail cancel button registration");
  const detailButtons = (listeners["button:click"] ?? []).slice(buttonsBeforeDetail);
  assert.ok(detailButtons.length >= 1, "the non-terminal run detail must register its cancel button");
  for (const handler of detailButtons) await handler();
  // Let the kicked-off promise chains settle: every marker render path and
  // the cancel call must have landed.
  await untilSettled(
    () => fetchedPaths.some((path) => path.endsWith("/cancel")) && MARKERS.every((marker) => textData.some((text) => text.includes(marker))),
    "cancel call and every marker render",
  );
  assert.ok(fetchedPaths.some((path) => path.endsWith("/cancel")), "the cancel button must call the cancel API");
  // Fence assertion 1: every hostile string reached the DOM VERBATIM as text
  // data through createTextNode — escaped-out (rendered), not interpreted.
  // Each marker pins its OWN render path (see MARKERS above).
  for (const marker of MARKERS) {
    assert.ok(textData.some((text) => text.includes(marker)), `hostile payload must be rendered as text: ${JSON.stringify(marker)}`);
  }
  // Fence assertion 2: no OTHER insertion channel ever received API-derived
  // data — no property write or attribute set carries a hostile payload.
  for (const write of propertyWrites) {
    for (const marker of MARKERS) {
      assert.ok(!String(write.value).includes(marker), `property write ${write.element}.${write.prop} carried hostile data`);
    }
  }
  assert.deepEqual(attributeCalls, [], "the script must never set attributes");
});

test("auth and redaction are covered", async (t) => {
  // The diagnostics route redacts server side; the shell renders exactly
  // what the API returns and carries no redaction vocabulary of its own
  // (no un-redaction mechanism exists in the UI).
  const fixture = await listening(true, "admin-secret", {
    diagnostics: async () => ({ model_key: "sk-abcdefghijklmnop", region: "eu-central" }),
  });
  t.after(() => fixture.server.close());
  const response = await fetch(fixture.base + "/admin/diagnostics", { headers: { authorization: "Bearer admin-secret" } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /sk-abcdefghijklmnop/);
  assert.match(body, /REDACTED/);
  for (const banned of ["sk-", "unredact", "decrypt", "atob(", "eval("]) {
    assert.ok(!DASHBOARD_HTML.includes(banned), `shell must not contain ${banned}`);
    assert.ok(!DASHBOARD_JS.includes(banned), `script must not contain ${banned}`);
  }
  // The data routes stay token-gated while the shell is served unauthenticated.
  assert.equal((await fetch(fixture.base + "/admin/diagnostics")).status, 401);
  assert.equal((await fetch(fixture.base + "/dashboard")).status, 200);
});
