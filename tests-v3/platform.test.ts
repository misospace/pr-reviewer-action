import test from "node:test";
import assert from "node:assert/strict";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { GitHubAdapter } from "../src/platform/github.js";
import { PlatformRequestError, requestText } from "../src/platform/http.js";
import { deriveIsFork } from "../src/platform/pr.js";
import { resolvePlatform } from "../src/platform/resolve.js";
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
  assert.equal(resolvePlatform(undefined, "", ""), "github");
  assert.equal(resolvePlatform("auto", "", ""), "github");
  assert.equal(resolvePlatform("auto", "", "https://github.com"), "github");
  assert.equal(resolvePlatform("auto", "", "https://github.com/"), "github");
  assert.equal(resolvePlatform("auto", "https://git.example.com", ""), "forgejo");
  assert.equal(resolvePlatform("auto", "", "https://git.example.com"), "forgejo");
  assert.equal(resolvePlatform("AUTO", "https://git.example.com", ""), "forgejo");
  assert.equal(resolvePlatform("forgejo", "", ""), "forgejo");
  assert.throws(() => resolvePlatform("gitea", "", ""), /unsupported PLATFORM/);
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

test("forgejo path translation fails closed outside the table", () => {
  assert.equal(ForgejoAdapter.translate("/repos/o/r/pulls/12", "o/r"), "/api/v1/repos/o/r/pulls/12");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/pulls/12.diff", "o/r"), "/api/v1/repos/o/r/pulls/12.diff");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/issues/12/comments", "o/r"), "/api/v1/repos/o/r/issues/12/comments");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/compare/main...head", "o/r"), "/api/v1/repos/o/r/compare/main...head");
  assert.equal(ForgejoAdapter.translate("/search/code?q=foo", ""), "/api/v1/search/code?q=foo");
  assert.equal(ForgejoAdapter.translate("/repos/o/r/actions/secrets", "o/r"), null);
  assert.equal(ForgejoAdapter.translate("/notifications", ""), null);
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
