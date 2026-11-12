/** Static operations dashboard shell (#742).
 *
 * An optional, static, API-driven web dashboard served by the admin
 * listener. This module owns constants and a pure serve function only: no
 * state, no sockets. The shell carries ZERO dynamic data — no request
 * echo, no repository content, no token, no configuration. Every dynamic
 * value the operator sees is fetched by the embedded script from the
 * bearer-protected `/admin/*` routes, which stay fully authenticated: the
 * dashboard mount NEVER bypasses or relaxes that rule, and the surface
 * lives OUTSIDE the `/admin/` namespace so the every-admin-route-is-
 * authenticated invariant stays structurally intact.
 */
import { createHash } from "node:crypto";

/** The shell's inline style block (#1641).
 *
 * ONE source of truth for two things: the bytes the shell serves inside
 * the `<style>` element, and the CSP style hash that authorises exactly
 * those bytes. The block is a module constant, so the served text and the
 * hash that covers it can never drift apart. */
const DASHBOARD_CSS = `
body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #1a1a2e; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.5rem; }
table { border-collapse: collapse; margin-top: 0.5rem; }
th, td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; text-align: left; font-size: 0.85rem; }
button { margin: 0.25rem 0; }
section { margin-bottom: 1rem; }
.muted { color: #666; }
`;

/** The CSP3 style hash of `DASHBOARD_CSS` (#1641).
 *
 * A browser hashes the EXACT text content of a `<style>` element — the
 * bytes between the tags, leading and trailing newline included — so the
 * digest is computed over the very constant the shell serves. `style-src`
 * names this hash source instead of `'unsafe-inline'`: the browser applies
 * THIS style block and refuses every other inline style. */
const STYLE_HASH = `sha256-${createHash("sha256").update(DASHBOARD_CSS, "utf8").digest("base64")}`;

const CSP = `default-src 'none'; script-src 'self'; connect-src 'self'; style-src '${STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
/** Every dashboard response carries the same fixed security headers. The
 * CSP's `connect-src 'self'` is the structural guarantee that the UI can
 * only talk to the same origin (the controller API): it can never reach a
 * database, the Kubernetes API, or a forge API directly (#742).
 * `frame-ancestors 'none'` plus `X-Frame-Options: DENY` keep the shell out
 * of any framing host (clickjacking). The CSP's `style-src` names the
 * hash of the shell's own style block, so no inline style other than the
 * one the shell ships can ever be applied (#1641). */
const DASHBOARD_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
});

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pr-reviewer controller dashboard</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<h1>Controller dashboard</h1>
<section id="auth">
  <label>Admin bearer token <input type="password" id="token" autocomplete="new-password"></label>
  <button id="load">Load</button>
  <span id="auth-msg" class="muted"></span>
</section>
<section id="status-sec"><h2>Status</h2><div id="status"></div></section>
<section id="runs-sec"><h2>Runs</h2><div id="runs"></div></section>
<section id="run-detail-sec"><h2>Run detail</h2><div id="run-detail"></div></section>
<section id="diagnostics-sec"><h2>Diagnostics</h2><div id="diagnostics"></div></section>
<section id="actions-sec">
  <h2>Actions</h2>
  <div>
    <input id="rereview-key" placeholder="prKey" autocomplete="off">
    <input id="rereview-reason" placeholder="reason" autocomplete="off">
    <button id="rereview">Force rereview</button>
    <span id="rereview-msg"></span>
  </div>
</section>
<script src="/dashboard/app.js"></script>
</body>
</html>
`;

export const DASHBOARD_JS = `// Operations dashboard script (#742).
// HARD RENDERING RULE: every dynamic value is inserted with
// document.createTextNode / .textContent. Markup-injection DOM APIs are
// never used anywhere in this script. This is the XSS fence for
// API-rendered content.
// The token lives only in this in-memory JS variable and in the token
// input's value: never written to browser storage, never set as a cookie,
// never placed in the URL, and read from the input field only when loading.
"use strict";
let token = "";
function text(parent, value) {
  parent.appendChild(document.createTextNode(value === undefined || value === null ? "" : String(value)));
}
function cell(row, value) {
  const td = document.createElement("td");
  text(td, value);
  row.appendChild(td);
  return td;
}
function table(headers) {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    text(th, header);
    head.appendChild(th);
  }
  table.appendChild(head);
  return table;
}
function error(parent, label, status, body) {
  parent.replaceChildren();
  text(parent, label + " failed: HTTP " + status + " " + body);
}
// Same-origin relative fetch only; every target is a string literal under
// /admin/ so the CSP (connect-src 'self') and the bearer-gated namespace
// stay the only data path. A rejected fetch becomes a synthetic failed
// result so the UI always renders an error, never an unhandled rejection.
async function api(path, options) {
  let response;
  try {
    response = await fetch(path, Object.assign({
      headers: { "Authorization": "Bearer " + token },
    }, options || {}));
  } catch {
    return { ok: false, status: 0, body: "network error" };
  }
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}
async function apiJson(path, options) {
  const result = await api(path, options);
  try { return Object.assign(result, { parsed: JSON.parse(result.body) }); }
  catch { return Object.assign(result, { parsed: null }); }
}
function renderStatus(parent, data) {
  parent.replaceChildren();
  const queue = data.queue || {};
  const queueTable = table(["state", "depth"]);
  for (const [state, depth] of Object.entries(queue.depthByState || {})) {
    const row = document.createElement("tr");
    cell(row, state);
    cell(row, depth);
    queueTable.appendChild(row);
  }
  const ageRow = document.createElement("tr");
  cell(ageRow, "oldestAgeMs");
  cell(ageRow, queue.oldestAgeMs);
  queueTable.appendChild(ageRow);
  parent.appendChild(queueTable);
  const workers = document.createElement("p");
  text(workers, "Active workers: " + JSON.stringify(queue.activeWorkersByExecutor || {}));
  parent.appendChild(workers);
  const adoption = (data.adoption && data.adoption.repositories) || [];
  const adoptionTable = table(["platform", "repository", "enabled"]);
  for (const entry of adoption) {
    const row = document.createElement("tr");
    cell(row, entry.platform);
    cell(row, entry.repository);
    cell(row, entry.enabled);
    adoptionTable.appendChild(row);
  }
  parent.appendChild(adoptionTable);
  const readiness = document.createElement("p");
  const components = ((data.readiness || {}).components) || [];
  for (const component of components) {
    // Readiness detail is rendered exactly as the API returned it: the UI
    // applies no un-redaction and no additional transformation.
    text(readiness, component.name + ": ok=" + component.ok + " degraded=" + component.degraded + " detail=" + (component.detail === undefined ? "" : component.detail));
    readiness.appendChild(document.createElement("br"));
  }
  parent.appendChild(readiness);
}
// A timestamp is rendered as an ISO string only when it is a valid date;
// anything else (a hostile or malformed value) is rendered as the raw text,
// never thrown mid-render.
function timeText(ms) {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(ms === undefined || ms === null ? "" : ms);
}
function runRow(tableEl, run) {
  const row = document.createElement("tr");
  for (const value of [run.runId, run.jobId, run.kind, run.state, run.executorIdentity, run.attempt, run.headSha, run.failureReason, run.supersededByJobId, timeText(run.createdAtMs), timeText(run.updatedAtMs)]) cell(row, value);
  const actions = document.createElement("td");
  const open = document.createElement("button");
  text(open, "detail");
  open.addEventListener("click", () => loadRunDetail(run.runId));
  actions.appendChild(open);
  row.appendChild(actions);
  tableEl.appendChild(row);
}
async function loadRuns(cursor) {
  const parent = document.getElementById("runs");
  const query = cursor ? "/admin/runs?limit=50&cursor=" + encodeURIComponent(cursor) : "/admin/runs?limit=50";
  const result = await apiJson(query);
  if (!result.ok || !result.parsed) { error(parent, "runs", result.status, result.body); return; }
  parent.replaceChildren();
  const runsTable = table(["runId", "jobId", "kind", "state", "executor", "attempt", "headSha", "failureReason", "supersededBy", "createdAt", "updatedAt", ""]);
  for (const run of result.parsed.runs || []) runRow(runsTable, run);
  parent.appendChild(runsTable);
  const refresh = document.createElement("button");
  text(refresh, "Refresh");
  refresh.addEventListener("click", () => loadRuns());
  parent.appendChild(refresh);
  if (result.parsed.nextCursor) {
    const next = document.createElement("button");
    text(next, "Next");
    next.addEventListener("click", () => loadRuns(result.parsed.nextCursor));
    parent.appendChild(next);
  }
}
async function loadRunDetail(runId) {
  const parent = document.getElementById("run-detail");
  const result = await apiJson("/admin/runs/" + encodeURIComponent(runId));
  if (!result.ok || !result.parsed) { error(parent, "run detail", result.status, result.body); return; }
  const run = result.parsed;
  parent.replaceChildren();
  const heading = document.createElement("p");
  text(heading, "run " + run.runId + " lifecycle state: " + run.state);
  parent.appendChild(heading);
  const publication = run.publication || {};
  const pub = document.createElement("p");
  text(pub, "publication: state=" + publication.state + " attempt=" + publication.attempt + " lastOutcome=" + publication.lastOutcome);
  parent.appendChild(pub);
  const usageTable = table(["role", "requestCount", "tokens", "costMicros", "costProvenance"]);
  for (const usage of run.usage || []) {
    const row = document.createElement("tr");
    cell(row, usage.role);
    cell(row, usage.requestCount);
    cell(row, usage.tokens);
    cell(row, usage.costMicros);
    cell(row, usage.costProvenance);
    usageTable.appendChild(row);
  }
  parent.appendChild(usageTable);
  const terminal = ["completed", "failed", "cancelled", "superseded"].indexOf(run.state) !== -1;
  if (!terminal) {
    const cancel = document.createElement("button");
    text(cancel, "Cancel run");
    cancel.addEventListener("click", async () => {
      if (!confirm("Cancel run " + run.runId + "?")) return;
      const outcome = await api("/admin/runs/" + encodeURIComponent(run.runId) + "/cancel", {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: "{}",
      });
      parent.replaceChildren();
      if (outcome.ok) text(parent, "cancel accepted: HTTP " + outcome.status);
      else error(parent, "cancel", outcome.status, outcome.body);
    });
    parent.appendChild(cancel);
  }
}
async function loadDiagnostics() {
  const parent = document.getElementById("diagnostics");
  const result = await apiJson("/admin/diagnostics");
  if (!result.ok || !result.parsed) { error(parent, "diagnostics", result.status, result.body); return; }
  parent.replaceChildren();
  // Rendered exactly as the API returned them (already redacted server
  // side): no un-redaction, no transformation.
  const list = table(["key", "value"]);
  for (const [key, value] of Object.entries(result.parsed)) {
    const row = document.createElement("tr");
    cell(row, key);
    cell(row, value);
    list.appendChild(row);
  }
  parent.appendChild(list);
}
function loadAll() {
  token = document.getElementById("token").value;
  const authMsg = document.getElementById("auth-msg");
  authMsg.replaceChildren();
  text(authMsg, "loading");
  Promise.all([apiJson("/admin/status"), loadRuns(), loadDiagnostics()]).then(([status]) => {
    authMsg.replaceChildren();
    if (status.ok && status.parsed) { text(authMsg, "loaded"); renderStatus(document.getElementById("status"), status.parsed); }
    else error(authMsg, "status", status.status, status.body);
  }).catch(() => {
    // A render-time throw (malformed API data shape) must not strand the
    // UI on "loading" as an unhandled rejection.
    authMsg.replaceChildren();
    text(authMsg, "render failed: HTTP data shape not understood");
  });
}
document.getElementById("load").addEventListener("click", loadAll);
document.getElementById("token").addEventListener("keydown", (event) => { if (event.key === "Enter") loadAll(); });
document.getElementById("rereview").addEventListener("click", async () => {
  const message = document.getElementById("rereview-msg");
  const prKey = document.getElementById("rereview-key").value;
  const reason = document.getElementById("rereview-reason").value;
  if (!confirm("Force a rereview of " + prKey + "?")) return;
  const outcome = await api("/admin/rereview", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ prKey, reason }),
  });
  message.replaceChildren();
  text(message, "HTTP " + outcome.status + (outcome.ok ? " accepted" : " " + outcome.body));
});
`;

export interface AdminDashboardOptions {}
export interface DashboardResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
}
/** Answer the two GET-only dashboard routes, or `null` for anything else
 * (including every non-GET method and subpaths like `/dashboard/extra`) so
 * the caller can render the fixed 404. */
export function serveDashboard(pathname: string): DashboardResponse | null {
  if (pathname === "/dashboard") return { status: 200, body: DASHBOARD_HTML, contentType: "text/html; charset=utf-8", headers: DASHBOARD_HEADERS };
  if (pathname === "/dashboard/app.js") return { status: 200, body: DASHBOARD_JS, contentType: "text/javascript; charset=utf-8", headers: DASHBOARD_HEADERS };
  return null;
}
