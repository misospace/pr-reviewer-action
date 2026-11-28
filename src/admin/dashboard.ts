/**
 * Static operations dashboard shell (#742), redesigned for #1717, with the
 * explicit login state machine from #1771.
 * The shell carries zero dynamic data and lives outside `/admin/`, preserving
 * the rule that every admin route remains authenticated. The script has one
 * fetch site, constrained by `connect-src 'self'`, and keeps the token only in
 * memory. Every dynamic value is rendered through `document.createTextNode`;
 * runtime classes come only from fixed whitelist vocabularies so API data can
 * never choose a class. Mutations are gated by `confirm()`.
 * The visible surface is one of three screens driven by a single state
 * variable: `restoring` (session probe), `unauthenticated`/`authenticating`
 * (the login screen), and `authenticated` (the operations shell). The shell
 * and its mutation controls stay hidden until identity is proven by a
 * successful authenticated response (never a 5xx or a network failure), a
 * 401/403 from any data route returns the operator to the login screen with
 * every data panel, mutation feedback, and pagination state cleared, and no
 * unauthenticated view ever renders a data-panel placeholder.
 */
import { createHash } from "node:crypto";

/** One source of truth for served style bytes and the CSP style hash. */
const DASHBOARD_CSS = `
:root {
 color-scheme: dark;
 --bg:#101719;
 --surface:#182326;
 --surface-2:#202e31;
 --text:#edf3ef;
 --muted:#9badaa;
 --border:#344548;
 --accent:#b7e3ca;
 --accent-ink:#10251c;
 --danger:#ffb6a9;
 --danger-bg:#48241f;
 --ok:#a8e6bc;
 --warn:#f1d28b;
 --bad:#ffaaa0;
 --radius:14px;
 --space:16px;
 font: 15px/1.5 ui-sans-serif, system-ui, sans-serif;
 background:var(--bg);
 color:var(--text);
}
:root[data-theme="light"] {
 color-scheme:light;
 --bg:#f2f5f0;
 --surface:#fff;
 --surface-2:#e8eee8;
 --text:#1a2925;
 --muted:#63716c;
 --border:#cbd6ce;
 --accent:#205d43;
 --accent-ink:#fff;
 --danger:#8b2f22;
 --danger-bg:#ffe7e1;
 --ok:#17673b;
 --warn:#77540a;
 --bad:#a22d22;
}
@media (prefers-color-scheme: light) {
 :root:not([data-theme="dark"]) {
  color-scheme:light;
  --bg:#f2f5f0;
  --surface:#fff;
  --surface-2:#e8eee8;
  --text:#1a2925;
  --muted:#63716c;
  --border:#cbd6ce;
  --accent:#205d43;
  --accent-ink:#fff;
  --danger:#8b2f22;
  --danger-bg:#ffe7e1;
  --ok:#17673b;
  --warn:#77540a;
  --bad:#a22d22;
 }
 :root:not([data-theme="dark"]) body { background: radial-gradient(ellipse at 12% 0%,#d8e9dd 0,transparent 40%),var(--bg); }
}
* { box-sizing:border-box; }
body { margin:0; min-width:320px; background:radial-gradient(ellipse at 12% 0%, #243a35 0, transparent 38%),var(--bg); color:var(--text); }
:root[data-theme="light"] body { background:radial-gradient(ellipse at 12% 0%,#d8e9dd 0,transparent 40%),var(--bg); }
button,input { font:inherit; }
button { border:1px solid var(--border); border-radius:9px; padding:8px 12px; background:var(--surface-2); color:var(--text); cursor:pointer; transition:background .16s,border-color .16s,transform .16s; }
button:hover { border-color:var(--accent); transform:translateY(-1px); }
button:focus-visible,input:focus-visible,summary:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
button.primary { color:var(--accent-ink); background:var(--accent); border-color:var(--accent); font-weight:700; }
button.danger { color:var(--danger); border-color:var(--danger); background:var(--danger-bg); }
button.disabled { opacity:.45; cursor:not-allowed; transform:none; }
input { min-width:0; color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
.topbar { display:flex; align-items:center; gap:20px; flex-wrap:wrap; padding:14px clamp(16px,4vw,48px); border-bottom:1px solid var(--border); background:color-mix(in srgb,var(--surface) 88%,transparent); }
.brand { min-width:180px; font-weight:800; letter-spacing:.02em; }
.brand small { display:block; color:var(--muted); font-size:12px; font-weight:500; letter-spacing:.04em; }
nav { display:flex; gap:4px; }
nav button { background:transparent; border-color:transparent; }
nav button.active { background:var(--surface-2); border-color:var(--border); }
.grow { flex:1; }
.auth { display:flex; align-items:center; gap:7px; }
.auth input { width:180px; }
main { max-width:1440px; margin:auto; padding:28px clamp(16px,4vw,48px) 60px; }
.view { display:none; animation:appear .22s ease-out; }
.view-active { display:block; }
.hidden { display:none; }
.screen { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:clamp(16px,6vw,64px); }
.screen.hidden { display:none; }
.login-card { width:min(440px,100%); display:grid; gap:12px; }
@keyframes appear { from { opacity:0; transform:translateY(5px); }
to { opacity:1; transform:none; }
} .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space); }
.card { padding:20px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); min-width:0; box-shadow:0 10px 30px #0002; }
.card-wide { grid-column:1/-1; }
h1,h2,h3,p { margin-top:0; }
h1 { font-size:clamp(24px,3vw,34px); line-height:1.15; letter-spacing:-.035em; }
h2 { font-size:18px; letter-spacing:-.02em; }
h3 { margin-bottom:9px; font-size:14px; }
.muted,.caption { color:var(--muted); }
.caption { font-size:12px; overflow-wrap:anywhere; }
.chip { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:99px; padding:2px 9px; font-size:12px; font-weight:700; white-space:nowrap; }
.chip-ok,.chip-completed,.chip-published { color:var(--ok); }
.chip-running,.chip-starting,.chip-publishing { color:var(--accent); }
.chip-queued,.chip-pending,.chip-none,.chip-info { color:var(--muted); }
.chip-degraded,.chip-warn { color:var(--warn); }
.chip-failed,.chip-cancelled,.chip-superseded,.chip-error { color:var(--bad); }
.readiness { padding:15px 18px; margin-bottom:16px; border:1px solid var(--border); border-left:4px solid var(--warn); background:var(--surface-2); border-radius:10px; }
.readiness.ready { border-left-color:var(--ok); }
.stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.stat { padding:13px; border-radius:10px; background:var(--surface-2); }
.stat strong { display:block; font-size:25px; line-height:1.2; font-variant-numeric:tabular-nums; }
.stat span { color:var(--muted); font-size:12px; }
.stack { display:grid; gap:10px; }
.list-row { display:flex; justify-content:space-between; align-items:center; gap:12px; border-bottom:1px solid var(--border); padding:9px 0; }
.list-row:last-child { border-bottom:0; }
.table-scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; min-width:980px; text-align:left; }
th,td { padding:10px 12px; border-bottom:1px solid var(--border); vertical-align:top; }
th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
td { font-size:13px; }
.truncate { display:block; max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty,.loading,.error-state { padding:18px; border:1px dashed var(--border); border-radius:10px; background:var(--surface-2); }
.error-state { border-style:solid; border-left:4px solid var(--bad); }
.error-state strong { display:block; margin-bottom:3px; }
.definition { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 22px; }
.definition div { padding:9px 0; border-bottom:1px solid var(--border); min-width:0; }
.definition dt { color:var(--muted); font-size:12px; }
.definition dd { margin:3px 0 0; overflow-wrap:anywhere; }
.steps { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.steps span { padding:5px 10px; border:1px solid var(--border); border-radius:99px; color:var(--muted); font-size:12px; }
.steps .current { border-color:var(--accent); color:var(--accent); font-weight:700; }
.toolbar { display:flex; align-items:center; gap:9px; flex-wrap:wrap; margin-bottom:12px; }
.feedback { margin-top:10px; }
details summary { cursor:pointer; color:var(--muted); }
.danger-zone { border-color:color-mix(in srgb,var(--bad) 55%,var(--border)); background:color-mix(in srgb,var(--danger-bg) 35%,var(--surface)); }
.failure { color:var(--bad); overflow-wrap:anywhere; }
.rereview-form { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; }
@media (max-width:720px) { .topbar { gap:10px; }
.brand { min-width:0; }
nav { order:3; width:100%; }
.grow { display:none; }
.auth { width:100%; }
.auth input { flex:1; }
main { padding-top:20px; }
.grid { grid-template-columns:1fr; }
.card-wide { grid-column:auto; }
.stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
.rereview-form { grid-template-columns:1fr; }
.definition { grid-template-columns:1fr; }
}
`;
/** The browser hashes the exact text between the served style tags. */
const STYLE_HASH = `sha256-${createHash("sha256").update(DASHBOARD_CSS, "utf8").digest("base64")}`;
/** Self-only API connections and no framing preserve the shell boundary. */
const CSP = `default-src 'none'; script-src 'self'; connect-src 'self'; style-src '${STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
/** X-Frame-Options complements frame-ancestors for older browsers. */
const DASHBOARD_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
});
export interface AdminDashboardOptions {}
export interface DashboardResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>pr-reviewer · controller console</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <section id="screen-restoring" class="screen" aria-label="Session status">
    <div class="card login-card">
      <h1>pr-reviewer</h1>
      <p class="caption">controller console</p>
      <div class="loading" role="status">Restoring session…</div>
    </div>
  </section>
  <section id="screen-login" class="screen hidden">
    <div class="card login-card">
      <h1>pr-reviewer</h1>
      <p class="caption">controller console</p>
      <p class="muted">Sign in to reach the controller operations console.</p>
      <div id="login-form" class="stack"></div>
      <span id="login-msg" role="status"></span>
    </div>
  </section>
  <div id="shell" class="hidden">
  <header class="topbar">
    <div class="brand">pr-reviewer<small>controller console</small></div>
    <nav aria-label="Main navigation">
      <button id="nav-overview" class="active">Overview</button>
      <button id="nav-runs">Runs</button>
      <button id="nav-diagnostics">Diagnostics</button>
    </nav>
    <span id="conn" class="chip chip-none" role="status">disconnected</span>
    <button id="theme" aria-label="Change color theme">Theme: system</button>
    <span class="grow"></span>
    <div class="auth" id="auth"></div>
  </header>
  <main>
    <section id="view-overview" class="view view-active">
      <h1>Operations overview</h1>
      <div id="status" class="grid"></div>
      <div id="overview-runs" class="card"></div>
      <div id="overview-failures" class="card"></div>
      <section id="actions">
        <h2>Force rereview</h2>
        <div class="rereview-form">
          <input id="rereview-key" placeholder="owner&#47;repo#123" aria-label="owner&#47;repo#123" autocomplete="off">
          <input id="rereview-reason" placeholder="Reason" aria-label="Reason" autocomplete="off">
          <button id="rereview" class="danger">Force rereview</button>
        </div>
        <span id="rereview-msg" class="feedback muted" role="status"></span>
      </section>
    </section>
    <section id="view-runs" class="view">
      <div class="toolbar"><h1>Runs</h1><span class="grow"></span><button id="runs-refresh">Refresh</button></div>
      <div id="runs" class="card"></div>
      <div class="toolbar"><button id="runs-prev">Previous</button><span id="runs-page" class="muted" aria-live="polite"></span><button id="runs-next">Next</button></div>
    </section>
    <section id="view-run" class="view"><div id="run-detail" class="stack"></div></section>
    <section id="view-diagnostics" class="view">
      <h1>Diagnostics</h1>
      <div id="diagnostics" class="card"></div>
    </section>
  </main>
  </div>
  <script src="/dashboard/app.js"><\/script>
</body>
</html>`;
const DASHBOARD_JS = `"use strict";
  let token = "";
  let authMode = "token";
  let csrfToken = "";
  let cursorStack = [];
  let currentCursor = "";
  let nextCursor = "";
  // #1771: exactly one screen is visible, chosen by uiState. "restoring"
  // probes a session; "authenticating" is a sign-in request in flight;
  // "authenticated" is the operations shell; anything else is the login screen.
  let uiState = "restoring";
  let oidcIdentity = "Signed in";
  // Identity is only proven by a successful authenticated response: a proven
  // OIDC session, or one 2xx from an admin data route under the bearer token.
  // 5xx, rejections, and network failures prove nothing, so the shell stays
  // behind this flag until proof exists.
  let authProven = false;
  // Bumped whenever a session ends: every request carries the epoch it was
  // issued under, and a response from a dead session never renders, denies,
  // or clears anything in the one that replaced it.
  let sessionEpoch = 0;
  // The PR key grammar the controller enforces: an owner, a repository, a
  // "#", and a positive PR number, and never a dot-only segment ("." or
  // "..") — the platform's repo-ref rule the controller applies at its
  // shape gate. The form refuses a key the controller would reject, so the
  // operator learns the shape without a round trip.
  const PR_KEY_PATTERN = /^((?!\\.\\.?\\/)[A-Za-z0-9._-]+)\\/((?!\\.\\.?#)[A-Za-z0-9._-]+)#([1-9][0-9]{0,9})$/;
  // The example is spelled with an escaped separator, exactly like the
  // field's placeholder: the served shell carries no raw repository
  // identity, while the operator still reads the real shape.
  const PR_KEY_EXAMPLE = "owner\\u002Frepo#123";
  const views = ["overview", "runs", "run", "diagnostics"];
  function text(parent, value) {
    parent.appendChild(document.createTextNode(value === undefined || value === null ? "" : String(value)));
  }
  function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }
  function chip(parent, label, className) {
    const node = el("span", className, parent);
    text(node, label);
    return node;
  }
  // Property writes must never carry API-derived values; map state to fixed classes.
  function stateChipClass(state) {
    const map = {
      queued: "chip chip-queued",
      starting: "chip chip-starting",
      running: "chip chip-running",
      publishing: "chip chip-publishing",
      completed: "chip chip-completed",
      failed: "chip chip-failed",
      cancelled: "chip chip-cancelled",
      superseded: "chip chip-superseded",
      ok: "chip chip-ok",
      degraded: "chip chip-degraded",
      pending: "chip chip-pending",
      published: "chip chip-published",
      none: "chip chip-none"
    };
    return Object.prototype.hasOwnProperty.call(map, state) ? map[state] : "chip";
  }
  function severity(value) {
    const s = String(value).toLowerCase();
    if (value === false || s.includes("error") || s.includes("fail") || s.includes("denied") || s.includes("refused")) return "chip chip-error";
    if (s.includes("warn") || s.includes("degrad")) return "chip chip-warn";
    return "chip chip-info";
  }
  function card(parent, title, wide) {
    const box = el("section", "card" + (wide ? " card-wide" : ""), parent);
    const h = el("h2", "", box);
    text(h, title);
    return box;
  }
  function empty(parent, message) {
    const box = el("div", "empty", parent);
    text(box, message);
  }
  function loading(parent) {
    parent.replaceChildren();
    const box = el("div", "loading", parent);
    text(box, "Loading controller data…");
  }
  function errorState(parent, result) {
    parent.replaceChildren();
    const box = el("div", "error-state", parent);
    const h = el("strong", "", box);
    text(h, result.status === 0 ? "Can't reach the controller" : "Controller request failed");
    const detail = el("span", "muted", box);
    // A 401/403 never renders here: handleSessionLost returns the operator to
    // the login screen instead of a stale error card.
    text(detail, result.status === 0 ? "Check the controller connection and try again." : "HTTP " + result.status + (result.body ? ": " + result.body : ""));
  }
  // The only fetch site. Rejections become a synthetic offline result.
  async function api(path, options) {
    const epoch = sessionEpoch;
    let response;
    try {
      const requestOptions = Object.assign({}, options || {});
      const headers = Object.assign({}, requestOptions.headers || {});
      if (authMode === "token") headers.Authorization = "Bearer " + token;
      else { delete headers.Authorization; if (requestOptions.method === "POST") headers["X-CSRF-Token"] = csrfToken; }
      requestOptions.headers = headers;
      response = await fetch(path, requestOptions);
    } catch {
      return { ok: false, status: 0, body: "network error", epoch: epoch };
    }
    // 401/403 handling lives with the callers: every data-route caller answers
    // a denial with handleSessionLost, so no stale authenticated panel remains.
    // /auth/* answers 401 itself and is judged by the session logic, not here.
    let body = "";
    try {
      body = await response.text();
    } catch {
    }
    return { ok: response.ok, status: response.status, body, epoch: epoch };
  }
  function isStale(result) {
    return result.epoch !== sessionEpoch;
  }
  async function apiJson(path, options) {
    const result = await api(path, options);
    try {
      result.parsed = JSON.parse(result.body);
    } catch {
      result.parsed = null;
    }
    return result;
  }
  // The controller's own reason for a refused mutation: the "detail" it
  // supplied when present, else its "error", else a fixed phrase. The value
  // reaches the page as text, never as markup.
  function refusalDetail(result, fallback) {
    const parsed = result.parsed;
    let reason = "";
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.detail === "string" && parsed.detail !== "") reason = parsed.detail;
      else if (typeof parsed.error === "string" && parsed.error !== "") reason = parsed.error;
    }
    if (reason === "") reason = fallback;
    return "HTTP " + result.status + ": " + reason;
  }
  // The failure class the operator sees: a 400 is the request's own shape,
  // a 409 is the controller's refusal, anything else is an unknown failure.
  // The headlines are per action, so each button says what happened to its
  // OWN request.
  function mutationFailure(status, headlines) {
    if (status === 400) return { headline: headlines.invalid, fallback: "The request was invalid." };
    if (status === 409) return { headline: headlines.refused, fallback: "The request was refused." };
    return { headline: headlines.unknown, fallback: "The request did not succeed." };
  }
  // The #1771 screen machine. One state owns which screen is visible, so an
  // unauthenticated operator never sees the operations shell or a data-panel
  // placeholder, and a lost session always lands back on the same login card.
  function isDenied(result) {
    return result.status === 401 || result.status === 403;
  }
  function setUiState(state) {
    uiState = state;
    document.getElementById("screen-restoring").className = state === "restoring" ? "screen" : "screen hidden";
    document.getElementById("screen-login").className = state === "unauthenticated" || state === "authenticating" ? "screen" : "screen hidden";
    document.getElementById("shell").className = state === "authenticated" ? "" : "hidden";
  }
  function loginMessage(reason) {
    const message = document.getElementById("login-msg");
    message.replaceChildren();
    if (reason) {
      const note = el("span", "failure", message);
      text(note, reason);
    }
  }
  function showLogin(reason) {
    setUiState("unauthenticated");
    const box = document.getElementById("login-form");
    box.replaceChildren();
    loginMessage("");
    if (authMode === "oidc") {
      const hint = el("p", "muted", box);
      text(hint, "Sign in with your configured identity provider.");
      const login = el("button", "primary", box);
      text(login, "Sign in");
      login.addEventListener("click", () => { window.location.href = "/auth/login"; });
    } else {
      const hint = el("p", "muted", box);
      text(hint, "Enter the admin bearer token for this controller.");
      const input = el("input", "", box);
      input.type = "password"; input.id = "token"; input.autocomplete = "new-password"; input.ariaLabel = "Admin bearer token"; input.placeholder = "Bearer token";
      const button = el("button", "primary", box);
      button.id = "load";
      text(button, "Sign in");
      button.addEventListener("click", submitToken);
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") submitToken(); });
    }
    if (reason) loginMessage(reason);
    else if (new URLSearchParams(window.location.search).get("login") === "failed") loginMessage("Sign in failed.");
  }
  async function submitToken() {
    if (uiState === "authenticating") return;
    const input = document.getElementById("token");
    const value = input ? input.value || "" : "";
    if (value === "") { loginMessage("Enter the admin bearer token."); return; }
    token = value;
    // The credential lives only in the in-memory variable: drop it from the
    // field the moment the sign-in request starts.
    if (input) input.value = "";
    setUiState("authenticating");
    // No second credential can be typed into the field while its fate is
    // undecided; a failure rebuilds the card with a fresh, enabled field.
    if (input) input.disabled = true;
    const button = document.getElementById("load");
    if (button) {
      button.disabled = true;
      button.className = "primary disabled";
      button.replaceChildren();
      text(button, "Signing in…");
    }
    await loadAll();
  }
  function deniedReason() {
    if (uiState === "authenticating") return "The token was rejected.";
    if (authMode === "oidc") return "Your session expired. Sign in again.";
    return "The controller rejected the credentials. Sign in again.";
  }
  function forgetCredentials() {
    token = "";
    csrfToken = "";
    oidcIdentity = "Signed in";
    authProven = false;
  }
  function clearOperationalPanels() {
    for (const id of ["status", "overview-runs", "overview-failures", "runs", "run-detail", "diagnostics"]) {
      const panel = document.getElementById(id);
      if (panel) panel.replaceChildren();
    }
    document.getElementById("runs-page").replaceChildren();
    // A prior session's mutation feedback, job IDs, and typed reason must not
    // resurface after the next sign-in: they are session data like the panels.
    document.getElementById("rereview-msg").replaceChildren();
    document.getElementById("rereview-key").value = "";
    document.getElementById("rereview-reason").value = "";
    cursorStack = [];
    currentCursor = "";
    disablePagination();
    showView("overview");
  }
  function handleSessionLost(reason) {
    if (uiState === "unauthenticated") return;
    // Retire this session first: any request still in flight under it may
    // land after the operator has signed in again, and must stay silent.
    sessionEpoch += 1;
    forgetCredentials();
    clearOperationalPanels();
    document.getElementById("auth").replaceChildren();
    setConnection("disconnected", "chip chip-none");
    showLogin(reason);
  }
  function enterAuthenticated() {
    setUiState("authenticated");
    renderHeaderAuth();
  }
  // The signed-in header names the identity and how to leave it. Token mode
  // has no server session, so signing out forgets the in-memory credential.
  function renderHeaderAuth() {
    const box = document.getElementById("auth");
    box.replaceChildren();
    const who = el("span", "", box);
    text(who, authMode === "oidc" ? oidcIdentity : "Signed in with a bearer token");
    const logout = el("button", "", box);
    text(logout, "Sign out");
    logout.addEventListener("click", async () => {
      if (authMode !== "oidc") { handleSessionLost("You are signed out."); return; }
      const result = await api("/auth/logout", { method: "POST" });
      if (result.ok || result.status === 401) { handleSessionLost("You are signed out."); return; }
      const error = el("span", "failure", box);
      text(error, "Sign out failed. The session is still signed in.");
    });
  }
  async function restoreOidcSession() {
    const result = await apiJson("/auth/session");
    if (!result.ok || !result.parsed || result.parsed.authenticated !== true || typeof result.parsed.csrfToken !== "string") { csrfToken = ""; return false; }
    csrfToken = result.parsed.csrfToken;
    oidcIdentity = result.parsed.email || result.parsed.subject || "Signed in";
    return true;
  }
  // Boot is the whole startup story: read the mode, restore a live OIDC
  // session straight into the shell, and otherwise land on the login screen.
  // No data route is fetched before identity is proven.
  async function boot() {
    setUiState("restoring");
    const config = await apiJson("/auth/config");
    authMode = config.parsed && config.parsed.mode === "oidc" ? "oidc" : "token";
    if (authMode === "oidc" && await restoreOidcSession()) {
      authProven = true;
      enterAuthenticated();
      void loadAll();
      return;
    }
    // A sign-in already in flight must not be pulled back to the login card
    // when boot settles: only the initial screens hand control over.
    if (uiState === "restoring" || uiState === "unauthenticated") showLogin("");
  }
  function relative(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return String(ms === undefined || ms === null ? "" : ms);
    const delta = Math.max(0, Date.now() - n);
    if (delta < 60000) return Math.floor(delta / 1000) + "s ago";
    if (delta < 3600000) return Math.floor(delta / 60000) + "m ago";
    if (delta < 86400000) return Math.floor(delta / 3600000) + "h ago";
    return Math.floor(delta / 86400000) + "d ago";
  }
  function timeText(value) {
    if (value === undefined || value === null || value === "") return "";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
  }
  // Connection and authentication state.
  function setConnection(label, cls) {
    const conn = document.getElementById("conn");
    conn.className = cls;
    conn.replaceChildren();
    text(conn, label);
  }
  function showView(name) {
    for (const view of views) {
      document.getElementById("view-" + view).className = view === name ? "view view-active" : "view";
    }
    for (const nav of ["overview", "runs", "diagnostics"]) {
      const button = document.getElementById("nav-" + nav);
      button.className = nav === name ? "active" : "";
      button.ariaCurrent = nav === name ? "true" : null;
    }
  }
  function table(parent, headings) {
    const wrap = el("div", "table-scroll", parent);
    const tbl = el("table", "", wrap);
    const head = el("tr", "", el("thead", "", tbl));
    for (const label of headings) {
      const th = el("th", "", head);
      th.scope = "col";
      text(th, label);
    }
    return el("tbody", "", tbl);
  }
  function cell(row, value, className) {
    const td = el("td", className || "", row);
    text(td, value);
    return td;
  }
  function stat(parent, label, value, caption) {
    const tile = el("div", "stat", parent);
    const strong = el("strong", "", tile);
    text(strong, value);
    const name = el("span", "", tile);
    text(name, label);
    if (caption) {
      const small = el("div", "caption", tile);
      text(small, caption);
    }
  }
  function appendRunRow(body, run) {
    const row = el("tr", "", body);
    const runCell = cell(row, "");
    text(runCell, String(run.kind || "run") + " · " + String(run.jobId || run.runId || "").slice(0, 12));
    const status = cell(row, "");
    chip(status, run.state, stateChipClass(run.state));
    const executor = cell(row, "", "");
    const span = el("span", "truncate", executor);
    text(span, run.executorIdentity || "");
    cell(row, run.attempt);
    cell(row, typeof run.headSha === "string" && run.headSha ? run.headSha.slice(0, 7) : "");
    const failure = cell(row, run.failureReason || run.supersededByJobId || "");
    if (run.failureReason || run.supersededByJobId) failure.className = "failure";
    cell(row, relative(run.createdAtMs));
    cell(row, relative(run.updatedAtMs));
    const action = cell(row, "");
    if (run.runId) {
      const button = el("button", "", action);
      text(button, "View");
      button.addEventListener("click", () => loadRunDetail(run.runId));
    }
  }
  function renderRuns(parent, data) {
    parent.replaceChildren();
    const runs = data.runs;
    if (!Array.isArray(runs)) throw new Error("invalid runs");
    if (!runs.length) empty(parent, "No runs yet.");
    else {
      const body = table(parent, ["Run", "Status", "Executor", "Attempt", "Head", "Failure", "Age", "Updated", ""]);
      for (const run of runs) {
        if (!run || typeof run !== "object") continue;
        appendRunRow(body, run);
      }
    }
  }
  // Overview and recent-failure rendering.
  function renderOverview(data) {
    const parent = document.getElementById("status");
    parent.replaceChildren();
    const readiness = data.readiness;
    const queue = data.queue;
    const adoption = data.adoption;
    if (!readiness || !Array.isArray(readiness.components) || !queue || !queue.depthByState || !adoption || !Array.isArray(adoption.repositories)) throw new Error("invalid status");
    const ready = el("section", "readiness card-wide", parent);
    const verdict = readiness.components.length > 0 && readiness.components.every((item) => item && item.ok && !item.degraded);
    ready.className = verdict ? "readiness card-wide ready" : "readiness card-wide";
    const title = el("h2", "", ready);
    text(title, verdict ? "Controller ready" : "Controller readiness needs attention");
    for (const item of readiness.components) {
      if (!item) continue;
      const row = el("div", "list-row", ready);
      const name = el("strong", "", row);
      text(name, item.name);
      chip(row, item.ok && !item.degraded ? "ok" : "degraded", stateChipClass(item.ok && !item.degraded ? "ok" : "degraded"));
      const detail = el("span", "muted", row);
      text(detail, item.detail || "");
    }
    const queueCard = card(parent, "Queue", false);
    const stats = el("div", "stats", queueCard);
    const depths = queue.depthByState;
    stat(stats, "Active", Number(depths.starting || 0) + Number(depths.running || 0) + Number(depths.publishing || 0));
    stat(stats, "Queued", depths.queued || 0);
    stat(stats, "Failed", depths.failed || 0);
    stat(stats, "Superseded", depths.superseded || 0, queue.oldestAgeMs ? "Oldest: " + relative(Date.now() - Number(queue.oldestAgeMs)) : "");
    const workerCard = card(parent, "Workers", false);
    const workers = queue.activeWorkersByExecutor || {};
    const workerKeys = Object.keys(workers);
    if (!workerKeys.length) empty(workerCard, "No active workers.");
    for (const key of workerKeys) {
      if (!key) continue;
      const item = el("div", "list-row", workerCard);
      text(item, key + ": " + workers[key] + " active");
    }
    const adoptionCard = card(parent, "Adopted repositories", false);
    if (!adoption.repositories.length) empty(adoptionCard, "No adopted repositories.");
    for (const repo of adoption.repositories) {
      if (!repo) continue;
      const item = el("div", "list-row", adoptionCard);
      const left = el("span", "", item);
      text(left, String(repo.platform || "") + " · " + String(repo.repository || ""));
      chip(item, repo.enabled ? "enabled" : "disabled", stateChipClass(repo.enabled ? "ok" : "degraded"));
      if (repo.configFingerprint) {
        const cap = el("span", "caption", item);
        text(cap, repo.configFingerprint);
      }
    }
  }
  function disablePagination() {
    const previous = document.getElementById("runs-prev");
    const next = document.getElementById("runs-next");
    previous.disabled = cursorStack.length === 0;
    previous.className = previous.disabled ? "disabled" : "";
    next.disabled = true;
    next.className = "disabled";
    nextCursor = "";
  }
  // Runs and the in-memory pagination cursor stack.
  async function loadRuns(cursor) {
    const parent = document.getElementById("runs");
    loading(parent);
    const path = cursor ? "/admin/runs?limit=50&cursor=" + encodeURIComponent(cursor) : "/admin/runs?limit=50";
    const result = await apiJson(path);
    if (isStale(result)) return null;
    if (isDenied(result)) { handleSessionLost(deniedReason()); return null; }
    if (!result.ok || !result.parsed) {
      errorState(parent, result);
      disablePagination();
      document.getElementById("runs-page").replaceChildren();
      if (result.status === 0) setConnection("offline", "chip chip-failed");
      return null;
    }
    try {
      renderRuns(parent, result.parsed);
    } catch {
      errorState(parent, { status: 500, body: "Runs data could not be rendered." });
      disablePagination();
      document.getElementById("runs-page").replaceChildren();
      return null;
    }
    currentCursor = cursor || "";
    const next = result.parsed.nextCursor || "";
    const count = Array.isArray(result.parsed.runs) ? result.parsed.runs.length : 0;
    const page = document.getElementById("runs-page");
    page.replaceChildren();
    if (count) text(page, "runs " + (cursorStack.length * 50 + 1) + "–" + (cursorStack.length * 50 + count));
    document.getElementById("runs-prev").className = cursorStack.length ? "" : "disabled";
    document.getElementById("runs-next").className = next ? "" : "disabled";
    document.getElementById("runs-prev").disabled = !cursorStack.length;
    document.getElementById("runs-next").disabled = !next;
    nextCursor = next;
    return result.parsed;
  }
  function renderFailures(runs) {
    const parent = document.getElementById("overview-failures");
    parent.replaceChildren();
    const title = el("h2", "", parent);
    text(title, "Actionable failures");
    const failed = runs.filter((run) => run && typeof run === "object").filter((run) => run.state === "failed" || (run.state === "superseded" && (run.failureReason || run.supersededByJobId)));
    if (!failed.length) {
      empty(parent, "No recent failures.");
      return;
    }
    for (const run of failed) {
      const item = el("div", "list-row", parent);
      text(item, String(run.jobId || run.runId) + " · " + String(run.failureReason || run.supersededByJobId || ""));
    }
  }
  async function loadAll() {
    // A data load is also the proof of identity: from the login card (or a
    // probe started before boot settled) it enters "authenticating", so boot
    // can never pull the screen back out from under it.
    if (uiState === "unauthenticated" || uiState === "restoring") setUiState("authenticating");
    // While identity is unproven, this batch IS the sign-in: only a 2xx
    // proves it. 5xx (an unconfigured server answers 503 before any credential
    // check) and network failures prove nothing; a proven session keeps its
    // shell through ordinary data errors.
    const proving = !authProven;
    setConnection("loading", "chip chip-pending");
    const statusNode = document.getElementById("status");
    loading(statusNode);
    const statusPromise = apiJson("/admin/status");
    const runsPromise = apiJson("/admin/runs?limit=50");
    const diagnosticsPromise = apiJson("/admin/diagnostics");
    const results = await Promise.all([statusPromise, runsPromise, diagnosticsPromise]);
    const status = results[0];
    const runs = results[1];
    const diagnostics = results[2];
    if (isStale(status) || isStale(runs) || isStale(diagnostics)) return;
    if (isDenied(status) || isDenied(runs) || isDenied(diagnostics)) { handleSessionLost(deniedReason()); return; }
    if (proving && !authProven) {
      if (status.ok || runs.ok || diagnostics.ok) authProven = true;
      else if (status.status === 0 && runs.status === 0 && diagnostics.status === 0) handleSessionLost("The controller could not be reached.");
      else handleSessionLost("The controller could not verify the sign-in. Try again.");
      if (!authProven) return;
    }
    enterAuthenticated();
    if (!status.ok || !status.parsed) errorState(statusNode, status);
    else {
      try {
        renderOverview(status.parsed);
      } catch {
        errorState(statusNode, { status: 500, body: "Status data could not be rendered." });
      }
    }
    try {
      renderRuns(document.getElementById("overview-runs"), { runs: runs.ok && runs.parsed && Array.isArray(runs.parsed.runs) ? runs.parsed.runs.slice(0, 8) : [] });
    } catch {
      errorState(document.getElementById("overview-runs"), { status: 500, body: "Recent runs could not be rendered." });
    }
    try {
      renderFailures(runs.ok && runs.parsed && Array.isArray(runs.parsed.runs) ? runs.parsed.runs : []);
    } catch {
      errorState(document.getElementById("overview-failures"), { status: 500, body: "Recent runs could not be rendered." });
    }
    if (runs.ok && runs.parsed) {
      try {
        renderRuns(document.getElementById("runs"), runs.parsed);
        const page = document.getElementById("runs-page");
        page.replaceChildren();
        if (runs.parsed.runs.length) text(page, "runs 1–" + runs.parsed.runs.length);
        currentCursor = "";
        cursorStack = [];
        document.getElementById("runs-prev").disabled = true;
        document.getElementById("runs-prev").className = "disabled";
        nextCursor = runs.parsed.nextCursor || "";
        document.getElementById("runs-next").disabled = !nextCursor;
        document.getElementById("runs-next").className = nextCursor ? "" : "disabled";
      } catch {
        errorState(document.getElementById("runs"), { status: 500, body: "Runs data could not be rendered." });
        disablePagination();
        document.getElementById("runs-page").replaceChildren();
      }
    } else {
      errorState(document.getElementById("runs"), runs);
      disablePagination();
      document.getElementById("runs-page").replaceChildren();
    }
    if (diagnostics.ok && diagnostics.parsed) {
      try {
        renderDiagnostics(document.getElementById("diagnostics"), diagnostics.parsed);
      } catch {
        errorState(document.getElementById("diagnostics"), { status: 500, body: "Diagnostics data could not be rendered." });
      }
    } else errorState(document.getElementById("diagnostics"), diagnostics);
    if (status.status === 0 || runs.status === 0 || diagnostics.status === 0) setConnection("offline", "chip chip-failed");
    else if (status.ok && runs.ok && diagnostics.ok) setConnection("connected", "chip chip-ok");
    else setConnection("error", "chip chip-failed");
  }
  // Run detail, lifecycle timeline, and confirm-gated danger zone.
  async function loadRunDetail(runId) {
    showView("run");
    const parent = document.getElementById("run-detail");
    loading(parent);
    const result = await apiJson("/admin/runs/" + encodeURIComponent(runId));
    if (isStale(result)) return;
    if (isDenied(result)) { handleSessionLost(deniedReason()); return; }
    if (!result.ok || !result.parsed) {
      errorState(parent, result);
      return;
    }
    try {
      renderRunDetail(parent, result.parsed);
    } catch {
      errorState(parent, { status: 500, body: "Run detail data could not be rendered." });
    }
  }
  function renderRunDetail(parent, run) {
    parent.replaceChildren();
    const top = el("div", "toolbar", parent);
    const back = el("button", "", top);
    text(back, "Back to runs");
    back.addEventListener("click", () => showView("runs"));
    const heading = el("h1", "", top);
    text(heading, "Run " + run.runId + " ");
    chip(heading, run.state, stateChipClass(run.state));
    const meta = card(parent, "Run metadata", true);
    const dl = el("dl", "definition", meta);
    const fields = [
      ["Job ID", run.jobId],
      ["Kind", run.kind],
      ["Attempt", run.attempt],
      ["Executor", run.executorIdentity],
      ["Head SHA", run.headSha],
      ["Created", timeText(run.createdAtMs)],
      ["Started", timeText(run.startedAtMs)],
      ["Updated", timeText(run.updatedAtMs)],
      ["Finished", timeText(run.finishedAtMs)]
    ];
    if (run.failureReason) fields.push(["Failure", run.failureReason]);
    if (run.supersededByJobId) fields.push(["Superseded by", run.supersededByJobId]);
    for (const field of fields) {
      const wrap = el("div", "", dl);
      const dt = el("dt", "", wrap);
      text(dt, field[0]);
      const dd = el("dd", "", wrap);
      text(dd, field[1]);
    }
    const timeline = card(parent, "Lifecycle", true);
    const steps = ["queued", "starting", "running", "publishing", "completed"];
    const terminal = ["failed", "cancelled", "superseded"];
    const at = steps.indexOf(run.state);
    const end = at >= 0 ? at : 3;
    const list = el("div", "steps", timeline);
    for (let i = 0; i <= end; i++) {
      const step = el("span", run.state === steps[i] ? "current" : "", list);
      text(step, steps[i]);
    }
    if (terminal.includes(run.state)) {
      const step = el("span", "current", list);
      text(step, run.state);
      const stamp = run.finishedAtMs;
      if (stamp) {
        const caption = el("span", "caption", timeline);
        text(caption, timeText(stamp));
      }
    }
    const usage = card(parent, "Usage", true);
    if (!Array.isArray(run.usage) || !run.usage.length) empty(usage, "No usage recorded.");
    else {
      const body = table(usage, ["Role", "Requests", "Tokens", "Cost micros", "Provenance"]);
      for (const item of run.usage) {
        const usageRow = el("tr", "", body);
        cell(usageRow, item.role);
        cell(usageRow, item.requestCount);
        cell(usageRow, item.tokens);
        cell(usageRow, item.costMicros);
        cell(usageRow, item.costProvenance);
      }
    }
    const publication = card(parent, "Publication", false);
    const pub = run.publication || {};
    const row = el("div", "list-row", publication);
    chip(row, pub.state || "none", stateChipClass(["pending", "published", "failed", "none"].includes(pub.state) ? pub.state : "none"));
    text(row, "Attempt " + (pub.attempt === undefined ? "" : pub.attempt) + " · " + (pub.lastOutcome || ""));
    const terminalRun = ["completed", "failed", "cancelled", "superseded"].includes(run.state);
    if (!terminalRun) {
      const danger = card(parent, "Danger zone", true);
      danger.className = "card danger-zone card-wide";
      const feedback = el("div", "feedback muted", danger);
      const cancel = el("button", "danger", danger);
      text(cancel, "Cancel run");
      cancel.addEventListener("click", async () => {
        if (!confirm("Cancel run " + run.runId + "?")) return;
        // Only a proven session mutates: a handler fired while the shell is
        // hidden (restoring, authenticating, or after loss) stops here.
        if (uiState !== "authenticated") return;
        const outcome = await apiJson("/admin/runs/" + encodeURIComponent(run.runId) + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (isStale(outcome)) return;
        if (isDenied(outcome)) { handleSessionLost(deniedReason()); return; }
        feedback.replaceChildren();
        if (outcome.ok) {
          // 202: the cancellation is REGISTERED, but the publication was
          // already in flight — the terminal state belongs to the
          // publication, so the run may still end published. The
          // controller's own reason reaches the operator.
          if (outcome.status === 202) {
            setFeedback(feedback, "Cancellation registered; the outcome is undetermined.", refusalDetail(outcome, "The publication is already in flight."));
            return;
          }
          setFeedback(feedback, "Cancellation accepted.", "The controller applied the cancellation.");
          return;
        }
        const failure = mutationFailure(outcome.status, { invalid: "The request was invalid.", refused: "Cancellation was refused.", unknown: "Cancellation was not accepted." });
        const box = el("div", "error-state", feedback);
        const h = el("strong", "", box);
        text(h, failure.headline);
        const detail = el("span", "muted", box);
        text(detail, refusalDetail(outcome, failure.fallback));
      });
    }
  }
  async function loadDiagnostics() {
    const parent = document.getElementById("diagnostics");
    loading(parent);
    const result = await apiJson("/admin/diagnostics");
    if (isStale(result)) return;
    if (isDenied(result)) { handleSessionLost(deniedReason()); return; }
    if (!result.ok || !result.parsed) {
      errorState(parent, result);
      if (result.status === 0) setConnection("offline", "chip chip-failed");
      return;
    }
    try {
      renderDiagnostics(parent, result.parsed);
    } catch {
      errorState(parent, { status: 500, body: "Diagnostics data could not be rendered." });
    }
  }
  // Diagnostics severity is reduced to fixed labels and whitelisted classes.
  function renderDiagnostics(parent, data) {
    if (!data || typeof data !== "object") throw new Error("invalid diagnostics");
    parent.replaceChildren();
    const entries = Object.entries(data);
    if (!entries.length) {
      empty(parent, "No diagnostics available.");
      return;
    }
    for (const entry of entries) {
      const row = el("div", "list-row", parent);
      const severityClass = severity(entry[1]);
      const severityLabel = severityClass === "chip chip-error" ? "error" : severityClass === "chip chip-warn" ? "warning" : "info";
      chip(row, severityLabel, severityClass);
      const key = el("strong", "", row);
      text(key, entry[0]);
      const details = el("details", "", row);
      const summary = el("summary", "", details);
      text(summary, "Technical detail");
      const value = el("span", "muted", details);
      text(value, entry[1]);
    }
  }
  // Overview, run, and diagnostics view switching.
  function setFeedback(node, headline, detail) {
    node.replaceChildren();
    const strong = el("strong", "", node);
    text(strong, headline);
    if (detail) {
      const small = el("span", "muted", node);
      text(small, detail);
    }
  }
  disablePagination();
  setUiState("restoring");
  void boot();
  document.getElementById("nav-overview").addEventListener("click", () => showView("overview"));
  document.getElementById("nav-runs").addEventListener("click", () => showView("runs"));
  document.getElementById("nav-diagnostics").addEventListener("click", () => {
    showView("diagnostics");
    loadDiagnostics();
  });
  document.getElementById("runs-refresh").addEventListener("click", () => {
    cursorStack = [];
    loadRuns("");
  });
  document.getElementById("runs-prev").addEventListener("click", async () => {
    if (cursorStack.length) {
      const cursor = cursorStack.pop();
      try {
        await loadRuns(cursor);
      } catch {
        const parent = document.getElementById("runs");
        errorState(parent, { status: 500, body: "Runs data could not be rendered." });
        disablePagination();
      }
    }
  });
  document.getElementById("runs-next").addEventListener("click", async () => {
    if (nextCursor) {
      cursorStack.push(currentCursor);
      try {
        await loadRuns(nextCursor);
      } catch {
        const parent = document.getElementById("runs");
        errorState(parent, { status: 500, body: "Runs data could not be rendered." });
        disablePagination();
      }
    }
  });
  document.getElementById("theme").addEventListener("click", (event) => {
    // The theme preference is deliberately in-memory only: no storage, cookie, or URL.
    const root = document.documentElement;
    const current = root.dataset.theme || "system";
    if (current === "system") root.dataset.theme = "dark";
    else if (current === "dark") root.dataset.theme = "light";
    else delete root.dataset.theme;
    event.currentTarget.replaceChildren();
    text(event.currentTarget, "Theme: " + (root.dataset.theme || "system"));
  });
  document.getElementById("rereview").addEventListener("click", async () => {
    const message = document.getElementById("rereview-msg");
    const prKey = (document.getElementById("rereview-key").value || "").trim();
    const reason = (document.getElementById("rereview-reason").value || "").trim();
    // The client's own gate: an invalid key or an empty reason never
    // reaches the controller, and the operator learns WHICH field was wrong
    // without a round trip.
    if (!PR_KEY_PATTERN.test(prKey)) {
      setFeedback(message, "Rereview was not requested.", "The PR key must look like " + PR_KEY_EXAMPLE + ".");
      return;
    }
    if (reason === "") {
      setFeedback(message, "Rereview was not requested.", "The reason is required.");
      return;
    }
    if (!confirm("Force a rereview of " + prKey + "?")) return;
    // Only a proven session mutates: a handler fired while the shell is
    // hidden (restoring, authenticating, or after loss) stops here.
    if (uiState !== "authenticated") return;
    const outcome = await apiJson("/admin/rereview", { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ prKey, reason }) });
    if (isStale(outcome)) return;
    if (isDenied(outcome)) { handleSessionLost(deniedReason()); return; }
    if (outcome.ok) {
      const parsed = outcome.parsed;
      const jobId = parsed && typeof parsed === "object" && typeof parsed.jobId === "string" ? parsed.jobId : "";
      setFeedback(message, "Rereview accepted.", jobId === "" ? "The controller accepted the request." : "Job " + jobId + ".");
      return;
    }
    const failure = mutationFailure(outcome.status, { invalid: "Rereview was not requested.", refused: "Rereview was refused.", unknown: "Rereview was not accepted." });
    setFeedback(message, failure.headline, refusalDetail(outcome, failure.fallback));
  });`;
function serveDashboard(pathname: string): DashboardResponse | null {
  // #1768: the dashboard is ALSO the native answer at the bare root — a
  // Gateway HTTPRoute that sends `/` to the admin listener (no URLRewrite)
  // gets the shell directly with 200, never a redirect. The match is EXACT:
  // `/` swallows nothing else, so `/metrics`, `/healthz`, `/admin/*`, and
  // every unknown path keep their own treatment. `/dashboard` stays as the
  // compatibility spelling (and the shell's own asset prefix).
  if (pathname === "/" || pathname === "/dashboard") return { status: 200, body: DASHBOARD_HTML, contentType: "text/html; charset=utf-8", headers: DASHBOARD_HEADERS };
  if (pathname === "/dashboard/app.js") return { status: 200, body: DASHBOARD_JS, contentType: "text/javascript; charset=utf-8", headers: DASHBOARD_HEADERS };
  return null;
}
export {
  DASHBOARD_HTML,
  DASHBOARD_JS,
  serveDashboard
};
