import test from "node:test";
import assert from "node:assert/strict";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { GitHubAdapter } from "../src/platform/github.js";
import { PlatformRequestError, requestText } from "../src/platform/http.js";
import { deriveDraftState, deriveIsFork, derivePrState, derivePrStateReading } from "../src/platform/pr.js";
import { resolvePlatform, type ResolvedPlatform } from "../src/platform/resolve.js";
import type { PlatformAdapter } from "../src/platform/types.js";
import type { PublishPlatformName } from "../src/platform/publish-api.js";
import { validateEndpoint } from "../src/platform/endpoint.js";
import { parsePlatformBaseUrl, PlatformUrlError, GITHUB_API_BASE } from "../src/platform/urls.js";
import type { FetchLike } from "../src/platform/http.js";

function jsonResponse(body: unknown, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Base URL validation: the #670/#682 SSRF boundary ────────────────────

test("platform base URLs accept only http/https with no embedded credentials", () => {
  for (const bad of [
    "",
    "   ",
    "not a url",
    "ftp://git.example.com",
    "file:///etc/passwd",
    "gopher://git.example.com",
    "https://user:pass@git.example.com",
    "http://token@git.example.com",
    "https:///",
  ]) {
    assert.throws(() => parsePlatformBaseUrl(bad, "Forgejo API base URL"), PlatformUrlError, bad);
  }
  const https = parsePlatformBaseUrl("https://git.example.com/", "Forgejo API base URL");
  assert.equal(https.base, "https://git.example.com");
  assert.equal(https.origin, "https://git.example.com");
  const http = parsePlatformBaseUrl("http://gitea.lan:3000/api", "Forgejo API base URL");
  assert.equal(http.base, "http://gitea.lan:3000/api");
  const github = parsePlatformBaseUrl(GITHUB_API_BASE, "GitHub API base URL");
  assert.equal(github.origin, "https://api.github.com");
});

test("requests are bound to the validated platform origin", async () => {
  await assert.rejects(
    requestText("https://evil.example.com/repos/o/r/pulls/1", { token: "Bearer secret", allowedOrigin: "https://api.github.com" }),
    (error: unknown) => error instanceof PlatformRequestError && /origin outside the validated platform base/.test(error.message),
  );
});

test("redirects are never followed and never carry credentials", async () => {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 302, headers: { Location: "https://evil.example.com/steal" } });
  };
  await assert.rejects(
    requestText("https://api.github.com/repos/o/r/pulls/1", {
      token: "Bearer secret",
      allowedOrigin: "https://api.github.com",
      fetchImpl,
    }),
    (error: unknown) => error instanceof PlatformRequestError && error.kind === "redirect-blocked",
  );
  assert.equal(calls.length, 1, "the redirect must not be followed");
  assert.equal(calls[0]!.init!.redirect, "manual");
});

// ── Platform resolution ─────────────────────────────────────────────────

test("platform auto-detection mirrors the v2 seam", () => {
  assert.equal(resolvePlatform(undefined, "", "", ""), "github");
  assert.equal(resolvePlatform("auto", "", "", ""), "github");
  assert.equal(resolvePlatform("auto", "", "https://github.com", ""), "github");
  assert.equal(resolvePlatform("auto", "", "https://github.com/", ""), "github");
  assert.equal(resolvePlatform("auto", "https://git.example.com", "", ""), "forgejo");
  assert.equal(resolvePlatform("auto", "", "https://git.example.com", ""), "forgejo");
  assert.equal(resolvePlatform("AUTO", "https://git.example.com", "", ""), "forgejo");
  assert.equal(resolvePlatform("forgejo", "", "", ""), "forgejo");
  assert.throws(() => resolvePlatform("gitea", "", "", ""), /unsupported PLATFORM/);
});

test("a Spindle identity resolves tangled before the Forgejo/GitHub signals (#583)", () => {
  // Explicit tangled requires the owner DID, trimmed.
  assert.equal(resolvePlatform("tangled", "", "", "did:plc:repo"), "tangled");
  assert.equal(resolvePlatform(" Tangled ", "", "", "  did:plc:repo  "), "tangled");
  const missing = "platform 'tangled' requires TANGLED_REPO_DID (Tangled repository owner DID) to be set";
  assert.throws(
    () => resolvePlatform("tangled", "", "", ""),
    (e: unknown) => e instanceof Error && e.message === missing,
  );
  assert.throws(
    () => resolvePlatform("tangled", "", "", "   "),
    (e: unknown) => e instanceof Error && e.message === missing,
  );
  // auto: the DID is checked first, so a Spindle runner is never
  // misclassified as Forgejo merely because its server URL is non-GitHub.
  assert.equal(resolvePlatform("auto", "", "", "did:plc:repo"), "tangled");
  assert.equal(resolvePlatform("auto", "https://git.example.com", "", "did:plc:repo"), "tangled");
  assert.equal(resolvePlatform("auto", "", "https://git.example.com", "did:plc:repo"), "tangled");
  assert.equal(resolvePlatform("auto", "https://git.example.com", "https://git.example.com", "did:plc:repo"), "tangled");
  // A blank DID is no signal: auto falls through unchanged.
  assert.equal(resolvePlatform("auto", "", "", "   "), "github");
  assert.equal(resolvePlatform("auto", "https://git.example.com", "", "   "), "forgejo");
  // The unsupported-value diagnostic lists every resolvable platform.
  assert.throws(
    () => resolvePlatform("gitlab", "", "", ""),
    (e: unknown) => e instanceof Error && e.message === "unsupported PLATFORM 'gitlab' (expected github|forgejo|tangled|auto)",
  );
});

test("the adapter backend union and the publish union both admit the Tangled backends", () => {
  // "tangled" is a resolved identity (#583), an implemented read-side
  // backend (#585), and — as of #588 — an implemented publish backend:
  // both seams admit it and publish routes through the dedicated
  // Tangled ATProto seam, never the GitHub/Forgejo APIs.
  const identity: ResolvedPlatform = "tangled";
  assert.equal(identity, "tangled");
  type Backend = PlatformAdapter["platform"];
  // Tangled is now a read backend: the assignment is valid (no type error).
  const backend: Backend = "tangled";
  assert.equal(backend, "tangled");
  type PublishName = PublishPlatformName;
  // Tangled is now a publish backend (#588): the assignment is valid.
  const publish: PublishName = "tangled";
  assert.equal(publish, "tangled");
});

// ── Endpoint validation (cross-backend security decisions) ──────────────

test("endpoint validation rejects hostile paths on both backends", () => {
  assert.equal("error" in validateEndpoint("repos/o/r/pulls/../secrets", "*", "o/r"), true);
  assert.equal("error" in validateEndpoint("repos/a/actions/secrets", "*", "o/r"), true);
  assert.equal("error" in validateEndpoint("repos/a/environments/prod", "*", "o/r"), true);
  assert.equal("error" in validateEndpoint("repos/other/repo/pulls/1", "", "o/r"), true);
  assert.equal("error" in validateEndpoint("", "*", "o/r"), true);
  assert.equal("error" in validateEndpoint("repos/o", "", "o/r"), true, "restricted allowlist rejects the unscoped repo");
  const ok = validateEndpoint("other/repo/pulls/1", "*", "o/r");
  assert.ok(!("error" in ok));
  if (!("error" in ok)) assert.equal(ok.full_path, "/repos/other/repo/pulls/1");
  const root = validateEndpoint("search/code?q=foo", "*", "o/r");
  assert.ok(!("error" in root));
  if (!("error" in root)) assert.equal(root.repo_key, "");
});

test("endpoint deny lists survive percent-encoding (#1215 review)", () => {
  // The deny list is a substring check, so a smuggled escape would walk a
  // denied segment past it: `%2F` and `%61` are decoded by the server before
  // it routes the request.
  assert.equal("error" in validateEndpoint("repos/o/r/actions%2Fsecrets", "*", "o/r"), true);
  assert.equal("error" in validateEndpoint("repos/o/r/%61ctions/secrets", "*", "o/r"), true);
  assert.equal("error" in validateEndpoint("repos/o/r/actions/variables", "*", "o/r"), true);
  // A malformed escape is left as it is rather than failing the whole path,
  // and the denied segment beside it is still caught.
  assert.equal("error" in validateEndpoint("repos/o/r/actions%2Fsecrets%zz", "*", "o/r"), true);
  // Blob endpoints stay available on the platform seam: `repo_contents` reads
  // file bytes through it (the tool-side validator refuses them).
  assert.equal("error" in validateEndpoint("repos/o/r/git/blobs/abc", "*", "o/r"), false);
});

test("forgejo path translation fails closed outside the table", () => {
  assert.equal(ForgejoAdapter.translate("/repos/o/r/pulls/12", "o/r"), "/api/v1/repos/o/r/pulls/12");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/pulls/12.diff", "o/r"), "/api/v1/repos/o/r/pulls/12.diff");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/issues/12/comments", "o/r"), "/api/v1/repos/o/r/issues/12/comments");
  // #914: the commenter-permission lookup maps through unchanged (the
  // GitHub-shaped path is identical on Forgejo's API v1).
  assert.equal(
    ForgejoAdapter.translate("/repos/o/r/collaborators/alice/permission", "o/r"),
    "/api/v1/repos/o/r/collaborators/alice/permission",
  );
  assert.equal(ForgejoAdapter.translate("/repos/o/r/compare/main...head", "o/r"), "/api/v1/repos/o/r/compare/main...head");
  assert.equal(ForgejoAdapter.translate("/search/code?q=foo", ""), "/api/v1/search/code?q=foo");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/actions/secrets", "o/r"), null);
  assert.equal(ForgejoAdapter.translate("/notifications", ""), null);
});

test("#1225: forgejo translation splits the query string before segment matching", () => {
  // A GitHub-shaped endpoint carrying a query is served on GitHub; segment
  // matching must see `issues`, not `issues?state=open`.
  assert.equal(
    ForgejoAdapter.translate("/repos/o/r/issues?state=open", "o/r"),
    "/api/v1/repos/o/r/issues?state=open",
  );
  // Multiple parameters survive intact.
  assert.equal(
    ForgejoAdapter.translate("/repos/o/r/pulls?state=closed&sort=updated", "o/r"),
    "/api/v1/repos/o/r/pulls?state=closed&sort=updated",
  );
  // Regression: endpoints without a query translate exactly as before.
  assert.equal(ForgejoAdapter.translate("/repos/o/r/issues", "o/r"), "/api/v1/repos/o/r/issues");
  // The re-attached query composes with the `.diff` suffix mapping and the
  // root-level search branch.
  assert.equal(
    ForgejoAdapter.translate("/repos/o/r/pulls/12/diff?whitespace=ignore-all", "o/r"),
    "/api/v1/repos/o/r/pulls/12.diff?whitespace=ignore-all",
  );
  assert.equal(ForgejoAdapter.translate("/search/issues?q=foo+bar", ""), "/api/v1/search/issues?q=foo+bar");
  // Stripping the query never smuggles an unmapped segment into the table.
  assert.equal(ForgejoAdapter.translate("/repos/o/r/contents/src?ref=main", "o/r"), null);
});

test("#1225: forgejo ghApi serves a query-carrying endpoint through the seam", async () => {
  const requested: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    requested.push(String(url));
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const adapter = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "tok",
    fetchImpl,
  });
  const result = await adapter.ghApi("repos/o/r/issues?state=open");
  assert.equal(result.error, undefined, "no longer fails closed as an unsupported endpoint");
  assert.deepEqual(requested, ["https://git.example.com/api/v1/repos/o/r/issues?state=open"]);
});

// ── Fork detection fails closed ─────────────────────────────────────────

test("deriveIsFork treats unknown origins as forks", () => {
  const pr = { head: { sha: "h", repo: { full_name: "someone/demo" } }, base: { sha: "b", repo: { full_name: "misospace/demo" } } };
  assert.equal(deriveIsFork(pr), true);
  assert.equal(deriveIsFork({ head: { sha: "h", repo: { full_name: "misospace/demo" } }, base: { sha: "b", repo: { full_name: "misospace/demo" } } }), false);
  assert.equal(deriveIsFork({}), true);
  assert.equal(deriveIsFork(null), true);
  assert.equal(deriveIsFork({ head: { sha: "h" } }), true, "missing head repo must fail closed");
});

// ── PR-state derivation (#1298) ──────────────────────────────────────────

test("derivePrStateReading fails closed on an unprovable state (#1310) and on non-objects", () => {
  // A merged PR reports `closed` on both forges; casing must not dodge it.
  assert.deepEqual(derivePrStateReading({ state: "closed", draft: false }), { state: "closed", draft: "not-draft" });
  assert.equal(derivePrStateReading({ state: "CLOSED", draft: false }).state, "closed");
  assert.deepEqual(derivePrStateReading({ state: "open", draft: true }), { state: "open", draft: "draft" });
  assert.equal(derivePrStateReading({ state: "Open", draft: false }).state, "open");
  // #1310: only an explicit `open`/`closed` string is authoritative — a
  // missing, non-string, or unrecognized `state` proves NOTHING and reads
  // `unknown` (the #1301 admission doctrine: `draft: false` alone must not
  // carry a PR through). Draft stays strict too: only an explicit boolean
  // is authoritative.
  assert.deepEqual(derivePrStateReading({}), { state: "unknown", draft: "unknown" });
  assert.deepEqual(derivePrStateReading({ draft: false }), { state: "unknown", draft: "not-draft" });
  assert.equal(derivePrStateReading({ state: 7, draft: false }).state, "unknown");
  assert.equal(derivePrStateReading({ state: "merged", draft: false }).state, "unknown", "an unrecognized state string is not open");
  assert.equal(derivePrStateReading({ state: " open ", draft: false }).state, "unknown", "a padded state string is not silently trimmed to open");
  assert.equal(derivePrStateReading({ state: "open", draft: "true" }).draft, "unknown", "a string draft is not authoritative");
  // A failed lookup (null) or a hostile non-object proves NOTHING.
  assert.deepEqual(derivePrStateReading(null), { state: "unknown", draft: "unknown" });
  assert.deepEqual(derivePrStateReading("closed"), { state: "unknown", draft: "unknown" });
  assert.deepEqual(derivePrStateReading([{ state: "closed" }]), { state: "unknown", draft: "unknown" });
});

// ── Forgejo adapter behaviors ────────────────────────────────────────────

test("forgejo adapter requires a validated base URL", () => {
  assert.throws(() => new ForgejoAdapter({ repo: "o/r", prNumber: "1", baseUrl: "ftp://git.example.com" }), PlatformUrlError);
  assert.throws(() => new ForgejoAdapter({ repo: "o/r", prNumber: "1", baseUrl: "" }), PlatformUrlError);
});

test("forgejo PR normalization never defaults the head repo to the base", async () => {
  const adapter = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "tok",
    fetchImpl: jsonResponse({ number: 1, title: "t", body: "b", state: "open", head: { sha: "h1", ref: "f" }, base: { sha: "b1", ref: "m" } }),
  });
  const pr = await adapter.getPr() as Record<string, unknown>;
  const head = pr.head as Record<string, unknown>;
  const base = pr.base as Record<string, unknown>;
  assert.equal((head.repo as Record<string, unknown>).full_name, "", "deleted fork repo normalizes to empty → fork");
  assert.equal((base.repo as Record<string, unknown>).full_name, "o/r");
});

test("forgejo PR projection never fabricates an open state or a not-draft flag (#1301/#1307)", async () => {
  const partial = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "tok",
    fetchImpl: jsonResponse({ number: 1, title: "t", body: "b", head: { sha: "h1", ref: "f" }, base: { sha: "b1", ref: "m" } }),
  });
  const pr = await partial.getPr() as Record<string, unknown>;
  // A partial Forgejo read proves NOTHING about reviewability: `state` and
  // `draft` are carried through verbatim, so the shared admission gate fails
  // closed (`pr-state-unknown` / `pr-draft-unknown`, #1312) instead of being
  // handed a fabricated "open"/"not-draft".
  assert.equal(pr.state, undefined, "a missing state must not be defaulted to open");
  assert.equal(pr.draft, undefined, "a missing draft must not be defaulted to not-draft");
  assert.equal(derivePrState(pr), "unknown");
  assert.equal(deriveDraftState(pr), "unknown");
  // An explicit state/draft round-trips unchanged — a real Forgejo payload
  // always carries both.
  const explicit = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "tok",
    fetchImpl: jsonResponse({ number: 1, title: "t", body: "b", state: "open", draft: false, head: { sha: "h1", ref: "f" }, base: { sha: "b1", ref: "m" } }),
  });
  const open = await explicit.getPr() as Record<string, unknown>;
  assert.equal(open.state, "open");
  assert.equal(open.draft, false);
  assert.equal(derivePrState(open), "open");
  assert.equal(deriveDraftState(open), "not-draft");
  // A malformed draft bit is carried through verbatim too — #1312 reads it
  // as unproven (`pr-draft-unknown`), never as a proven draft or not-draft.
  const malformed = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "tok",
    fetchImpl: jsonResponse({ number: 1, title: "t", body: "b", state: "open", draft: "yes", head: { sha: "h1", ref: "f" }, base: { sha: "b1", ref: "m" } }),
  });
  const unproven = await malformed.getPr() as Record<string, unknown>;
  assert.equal(unproven.draft, "yes");
  assert.equal(deriveDraftState(unproven), "unknown");
});

test("forgejo permission preflight resolves collaborator, owner, and unknown paths", async () => {
  const build = (responses: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>) => {
    const fetchImpl: FetchLike = async (url) => {
      const hit = responses.find((response) => response.match(String(url)));
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
    };
    return fetchImpl;
  };
  const adapter = (fetchImpl: FetchLike) =>
    new ForgejoAdapter({ repo: "o/r", prNumber: "1", baseUrl: "https://git.example.com", token: "tok", fetchImpl });

  const collaborator = adapter(build([
    { match: (url) => url.endsWith("/api/v1/user"), body: { login: "u" } },
    { match: (url) => url.includes("/collaborators/u/permission"), body: { permission: "owner" } },
  ]));
  assert.equal(await collaborator.repoPermission(), "admin", "owner normalizes to admin");

  const fallback = adapter(build([
    { match: (url) => url.endsWith("/api/v1/user"), body: { login: "u" } },
    { match: (url) => url.includes("/collaborators/"), body: {}, status: 404 },
    { match: (url) => url.endsWith("/api/v1/repos/o/r"), body: { permissions: { admin: false, write: true, read: true } } },
  ]));
  assert.equal(await fallback.repoPermission(), "write", "404 falls back to the repo permissions payload");

  const ambiguous = adapter(build([
    { match: (url) => url.endsWith("/api/v1/user"), body: { login: "u" } },
    { match: (url) => url.includes("/collaborators/"), body: { permission: "maintain" } },
  ]));
  assert.equal(await ambiguous.repoPermission(), "unknown", "out-of-whitelist value is unknown, never collapsed");

  const transport = adapter(async () => {
    throw new Error("down");
  });
  assert.equal(await transport.repoPermission(), null, "transport failure is null, not a permission");
});

// ── GitHub adapter ───────────────────────────────────────────────────────

test("github adapter surfaces API errors through the ghApi envelope", async () => {
  const fetchImpl: FetchLike = async () => new Response("nope", { status: 403 });
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl });
  const result = await adapter.ghApi("repos/o/r/pulls/1");
  assert.match(String(result.error), /403/);
  assert.equal(await adapter.repoPermission(), "unknown");
});

test("github adapter ghApi honors the per-call timeout override (#1210)", async () => {
  // The native tool loop passes its configured request bound per call; the
  // adapter must apply THAT bound, not its constructor default, so a hung
  // forge read aborts on the loop's clock. A fetch that never resolves
  // except through its abort signal proves the override reaches requestText.
  const adapter = new GitHubAdapter({
    repo: "o/r",
    prNumber: "1",
    token: "Bearer t",
    timeoutMs: 90_000,
    fetchImpl: ((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as FetchLike,
  });
  // A 20 ms override must abort long before the 90 s constructor default —
  // elapsed time discriminates the two bounds.
  const startedAt = Date.now();
  const result = await adapter.ghApi("repos/o/r/pulls/1", { timeoutMs: 20 });
  assert.match(String(result.error), /Platform request failed/);
  assert.ok(Date.now() - startedAt < 10_000, "the per-call override bound fired, not the adapter default");
});

// ── #1341: a failed PR read records its cause class ──────────────────────

test("#1341: a non-2xx PR read records the HTTP status as the cause on both forges", async () => {
  const github = new GitHubAdapter({
    repo: "o/r",
    prNumber: "1340",
    token: "Bearer tok_secret",
    fetchImpl: jsonResponse({ message: "hostile body ghp_AAAAtoken123" }, 422),
  });
  assert.equal(await github.getPr(), null);
  const githubCause = github.prReadFailure();
  assert.ok(githubCause instanceof PlatformRequestError);
  assert.equal(githubCause.status, 422);
  assert.match(githubCause.message, /HTTP status 422/);
  // The cause is status-only: never the response body, never the token.
  assert.doesNotMatch(githubCause.message, /hostile body|ghp_AAAAtoken123|tok_secret/);

  const forgejo = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1340",
    baseUrl: "https://git.example.com",
    token: "tok_secret",
    fetchImpl: jsonResponse({ message: "hostile body ghp_AAAAtoken123" }, 422),
  });
  assert.equal(await forgejo.getPr(), null);
  const forgejoCause = forgejo.prReadFailure();
  assert.ok(forgejoCause instanceof PlatformRequestError);
  assert.equal(forgejoCause.status, 422);
  assert.doesNotMatch(forgejoCause.message, /hostile body|ghp_AAAAtoken123|tok_secret/);
});

test("#1341: a PR read with no response records the transport kind as the cause on both forges", async () => {
  // The rejected fetch's message carries a credential-shaped URL on
  // purpose: the recorded cause must be rebuilt from the kind alone, so
  // neither the message nor any leaked text reaches the cause object.
  const transport: FetchLike = async () => {
    throw new Error("fetch failed https://evil.example.com/?token=tok_secret");
  };
  const github = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl: transport });
  assert.equal(await github.getPr(), null);
  assert.equal(github.prReadFailure()?.status, null);
  assert.equal(github.prReadFailure()?.kind, "transport");
  // Object-level pin for the re-wrap: the original error text (which here
  // carries a credential-shaped URL) never reaches the cause object.
  assert.doesNotMatch(github.prReadFailure()?.message ?? "", /evil|secret|credential/);

  const forgejo = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "t",
    fetchImpl: transport,
  });
  assert.equal(await forgejo.getPr(), null);
  assert.equal(forgejo.prReadFailure()?.status, null);
  assert.equal(forgejo.prReadFailure()?.kind, "transport");

  // A blocked redirect is a distinct no-response cause class, and the
  // redirect target is never reported.
  const redirect: FetchLike = async () => new Response(null, { status: 302, headers: { Location: "https://evil.example.com/steal?token=secret" } });
  const redirected = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl: redirect });
  assert.equal(await redirected.getPr(), null);
  assert.equal(redirected.prReadFailure()?.kind, "redirect-blocked");
  assert.doesNotMatch(String(redirected.prReadFailure()?.message), /evil\.example\.com|secret/);
});

test("#1341: a successful PR read clears the recorded cause", async () => {
  let status = 500;
  const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ number: 1, state: "open" }), { status, headers: { "Content-Type": "application/json" } });
  const adapter = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl });
  assert.equal(await adapter.getPr(), null);
  assert.equal(adapter.prReadFailure()?.status, 500);
  status = 200;
  assert.deepEqual(await adapter.getPr(), { number: 1, state: "open" });
  assert.equal(adapter.prReadFailure(), null);
});

test("#1341: a 2xx response with an unusable payload records the payload cause on both forges", async () => {
  // A 200 whose body is not a PR object is a failed read, not a fact about
  // the PR: the cause must be named (invalid-json / invalid-payload), and
  // a status that is not the failure (200) must not be reported as one.
  // A PR record is a non-array object carrying a numeric `number`, so
  // `{}` and `[]` are unusable payloads on BOTH forges — a PR-less object
  // must never pass through (GitHub) or be synthesized into a PR shape
  // (Forgejo).
  const githubInvalidJson = new GitHubAdapter({
    repo: "o/r",
    prNumber: "1",
    token: "Bearer tok_secret",
    fetchImpl: async () => new Response("<html>hostile body ghp_AAAAtoken123</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  });
  assert.equal(await githubInvalidJson.getPr(), null);
  const jsonCause = githubInvalidJson.prReadFailure();
  assert.equal(jsonCause?.kind, "invalid-json");
  assert.doesNotMatch(jsonCause?.message ?? "", /hostile body|ghp_AAAAtoken123|tok_secret/);

  const githubNullPayload = new GitHubAdapter({
    repo: "o/r",
    prNumber: "1",
    token: "Bearer t",
    fetchImpl: async () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  assert.equal(await githubNullPayload.getPr(), null);
  assert.equal(githubNullPayload.prReadFailure()?.kind, "invalid-payload");

  const githubEmptyObject = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl: jsonResponse({}) });
  assert.equal(await githubEmptyObject.getPr(), null);
  assert.equal(githubEmptyObject.prReadFailure()?.kind, "invalid-payload");

  const githubArrayPayload = new GitHubAdapter({ repo: "o/r", prNumber: "1", token: "Bearer t", fetchImpl: jsonResponse([]) });
  assert.equal(await githubArrayPayload.getPr(), null);
  assert.equal(githubArrayPayload.prReadFailure()?.kind, "invalid-payload");

  const forgejoArrayPayload = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example.com",
    token: "t",
    fetchImpl: jsonResponse([]),
  });
  assert.equal(await forgejoArrayPayload.getPr(), null);
  assert.equal(forgejoArrayPayload.prReadFailure()?.kind, "invalid-payload");

  const forgejoEmptyObject = new ForgejoAdapter({ repo: "o/r", prNumber: "1", baseUrl: "https://git.example.com", token: "t", fetchImpl: jsonResponse({}) });
  assert.equal(await forgejoEmptyObject.getPr(), null);
  assert.equal(forgejoEmptyObject.prReadFailure()?.kind, "invalid-payload");
});

test("#1341: an invalid repository reference is its own cause class", async () => {
  const github = new GitHubAdapter({ repo: "bad repo name", prNumber: "1", token: "Bearer t", fetchImpl: jsonResponse({}) });
  assert.equal(await github.getPr(), null);
  assert.equal(github.prReadFailure()?.kind, "invalid-repo");
  assert.equal(github.prReadFailure()?.status, null);
  // Forgejo keeps its pinned fail-closed refusal for an invalid repo ref
  // (it throws "Invalid repo full name" before any request,
  // platform-reads.test.ts) — that thrown error already names the
  // problem, so no cause latch is involved.
  const forgejo = new ForgejoAdapter({ repo: "bad repo name", prNumber: "1", baseUrl: "https://git.example.com", token: "t", fetchImpl: jsonResponse({}) });
  await assert.rejects(forgejo.getPr(), /Invalid repo full name/);
});
