import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_COMMANDS, allowlistedHost, executeToolRequest, findFiles, ghApi,
  listTree, readFile, resolveWorkspacePath, runCommand, validateEndpoint,
  webFetch, webSearch, type ToolContext,
} from "../src/tools/executors.js";
import { McpToolset, isReadOnlyTool, parseServerSpecs, splitNamespaced } from "../src/tools/mcp.js";

function fixture(fn: (root: string, outside: string) => Promise<void> | void): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-")), root = path.join(base, "x"), outside = path.join(base, "xy");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  try { return Promise.resolve(fn(root, outside)).finally(() => fs.rmSync(base, { recursive: true, force: true })); }
  catch (e) { fs.rmSync(base, { recursive: true, force: true }); throw e; }
}
const deps = () => ({ env: {}, runProcess: async (options: any) => ({ status: "exited", exitCode: 0, signal: null, stdout: Buffer.from(" ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF "), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null }) as any });
const ctx = (root: string, extra: Partial<ToolContext> = {}): ToolContext => ({ workspaceRoot: root, deps: deps(), ...extra });

test("workspace path guards reject traversal, absolute paths, NUL, symlink escape, secrets, denied names and sibling prefixes", async () => fixture((root, outside) => {
  fs.writeFileSync(path.join(root, "ok.txt"), "ok"); fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "out-link")); fs.symlinkSync(path.join(root, "ok.txt"), path.join(root, "in-link"));
  for (const p of ["../etc/passwd", "/etc/passwd"]) assert.ok(resolveWorkspacePath(p, root).error);
  assert.equal(resolveWorkspacePath("bad\0path", root).error, "Null byte in path");
  assert.equal(resolveWorkspacePath("out-link", root).error, "Path escapes workspace root");
  assert.equal(resolveWorkspacePath("in-link", root).error, null);
  assert.equal(resolveWorkspacePath(path.join("..", "xy", "secret.txt"), root).error, "Path escapes workspace root");
  for (const name of [".env", "thing.pem", "id_rsa", "credentials.json", "secrets.yaml", ".npmrc", ".git-credentials", "service-account.json", "foo-key.json", ".htpasswd"]) {
    fs.writeFileSync(path.join(root, name), "secret"); assert.match(resolveWorkspacePath(name, root).error ?? "", /Sensitive file blocked/);
  }
  for (const denied of ["dispatches", "environments/x"]) {
    const dir = path.join(root, denied); fs.mkdirSync(dir, { recursive: true });
    assert.match(resolveWorkspacePath(denied, root).error ?? "", /Path denied/);
  }
}));

test("file discovery skips symlinks and tree clamps and sorts", async () => fixture((root, outside) => {
  fs.mkdirSync(path.join(root, "b")); fs.writeFileSync(path.join(root, "z.txt"), "z"); fs.writeFileSync(path.join(root, "b", "a.txt"), "a");
  fs.writeFileSync(path.join(outside, "evil.txt"), "x"); fs.symlinkSync(path.join(outside, "evil.txt"), path.join(root, "evil.txt"));
  assert.deepEqual(findFiles("*.txt", ctx(root)).files, ["b/a.txt", "z.txt"]);
  assert.deepEqual(listTree("z.txt", ctx(root)).entries, [{ path: "z.txt", type: "file" }]);
  assert.deepEqual(listTree(".", ctx(root), 0, 0).entries.length, 1);
}));

test("run_command accepts only exact catalog names and never constructs shell input", async () => fixture(async (root) => {
  let invoked: string[] = []; const context = ctx(root, { deps: { ...deps(), runProcess: (async (o: any) => { invoked = [o.file, ...o.args]; return { status: "exited", exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.from(""), termination: null }; }) as any } });
  for (const [name, argv] of Object.entries(ALLOWED_COMMANDS)) { const res = await runCommand(name, context); assert.equal(res.command, name); assert.deepEqual(invoked, argv); }
  const exact = "Command not allowlisted. Use one of: git_diff_name_only, git_diff_stat, git_status_short";
  for (const bad of ["cat /etc/passwd", "git_status_short; rm -rf /", "git status", "Git_Status_Short", ""]) assert.equal((await runCommand(bad, context)).error, exact);
}));

test("gh endpoint guard applies repo and denied-path policy on repo and root routes", async () => {
  assert.match(validateEndpoint("users/o/r", []).error!, /Repo not allowed/);
  assert.match(validateEndpoint("repos/nope/repo/pulls", [], "o/r").error!, /Repo not allowed/);
  assert.equal(validateEndpoint("repos/o/r/pulls", [], "o/r").repo_key, "o/r");
  assert.equal(validateEndpoint("o/r/pulls", ["o/r"]).full_path, "/repos/o/r/pulls");
  assert.equal(validateEndpoint("repos/other/r/pulls", ["*"]).repo_key, "other/r");
  assert.equal(validateEndpoint("search/code?q=foo", []).repo_key, "");
  for (const route of ["repos/o/r/actions/secrets", "issues/actions/secrets", "search/actions/secrets"]) assert.match(validateEndpoint(route, ["o/r"]).error!, /Path segment denied/);
  assert.match(validateEndpoint("file:///etc/passwd", []).error!, /Dot-segment not allowed/);
  const bad = await ghApi("repos/o/r/actions/secrets", ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghGet: async () => { throw Error("must not call"); } } })); assert.match(bad.error, /Path segment denied/);
});

test("web fetch checks exact hosts and every redirect; search sanitizes result schemes", async () => {
  assert.equal(allowlistedHost("github.com.evil.example", ["github.com"]), false);
  assert.equal(allowlistedHost("evil.example", ["*"]), true);
  assert.equal(allowlistedHost(new URL("https://github.com@evil.example/").hostname, ["github.com"]), false);
  const context = ctx("/tmp", { allowedHosts: ["github.com"], deps: { ...deps(), fetch: async () => ({ status: 302, headers: { location: "https://evil.example/" }, body: "" }) } });
  assert.match((await webFetch("https://github.com/", context)).error!, /Redirect to disallowed host/);
  assert.match((await webFetch("file:///etc/passwd", context)).error!, /scheme/);
  let called = "";
  const search = ctx("/tmp", { searchUrl: "https://search.test/search", deps: { ...deps(), fetch: async (url: string) => { called = url; return { status: 200, body: JSON.stringify({ results: [{ title: "x", url: "javascript:alert(1)", content: "y" }, { url: "file:///etc/passwd" }] }) }; } } });
  const res = await webSearch("x&host=evil", search); assert.equal(new URL(called).hostname, "search.test"); assert.deepEqual(res.results.map((x: any) => x.url), ["", ""]);
});

test("tool wrapper applies byte truncation and redaction", async () => fixture(async (root) => {
  const p = path.join(root, "sample.txt"); fs.writeFileSync(p, "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF");
  const result = await executeToolRequest("read_file", { path: "sample.txt" }, ctx(root, { maxResponseBytes: 12000 }));
  assert.equal(result.status, "ok"); assert.match(result.result.content, /\[REDACTED\]/); assert.doesNotMatch(result.result.content, /ghp_|AKIA/);
  const clipped = await executeToolRequest("web_fetch", { url: "https://github.com/" }, ctx(root, { maxResponseBytes: 5, allowedHosts: ["github.com"], deps: { ...deps(), fetch: async () => ({ status: 200, body: "abcdefgh" }) } }));
  assert.match(clipped.result.content, /\[truncated\]/);
}));

test("MCP verb gate, safe URL parsing, connect advertisement and call-time denial", async () => {
  for (const name of ["list_items", "get_pr", "read_file", "search-x", "diff", "status"]) assert.equal(isReadOnlyTool(name), true);
  for (const name of ["set_status", "create_view", "update_diff", "refresh_status", "delete_query", "run_search", "set_y", "exec_z", "delete_pr", "update_config", "", "github-mcpology_list"]) assert.equal(isReadOnlyTool(name, ["github-mcp"]), false);
  assert.deepEqual(parseServerSpecs("x=https://h/a\0b, bad=file:///x, ok=https://h/a%00b"), [["ok", "https://h/a%00b"]]);
  assert.deepEqual(splitNamespaced("mcp__s__read_x"), ["s", "read_x"]);
  const calls: any[] = [], server = new McpToolset("s", "http://mcp", "tok", { postFn: async (_url, payload, _session, _token) => { const req = payload; calls.push({ req }); if (req.method === "initialize") return { result: JSON.parse('{"result":{}}'), sessionId: "sid", error: null }; if (req.method === "tools/list") return { result: JSON.parse(JSON.stringify({ result: { tools: [{ name: "get_item" }, { name: "delete_item" }] } })), sessionId: "sid", error: null }; if (req.method === "tools/call") return { result: JSON.parse(JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } })), sessionId: "sid", error: null }; return { result: null, sessionId: "sid", error: null }; } });
  assert.equal(await server.connect(), null); assert.deepEqual(server.schemas.map((s) => s.name), ["mcp__s__get_item"]); assert.deepEqual(await server.call("delete_item"), { error: "MCP tool not allowed: delete_item" }); assert.deepEqual(await server.call("get_item"), { content: "ok" }); assert.equal(calls[0].req.id, 1); assert.equal(calls[1].req.method, "notifications/initialized"); assert.equal(calls[1].req.id, undefined); assert.equal(calls.at(-1).req.method, "tools/call");
});

test("web_fetch treats non-2xx final responses as errors, never evidence", async () => {
  const context = (status: number, body: string) => ctx("/tmp", {
    allowedHosts: ["github.com"],
    deps: { ...deps(), fetch: async () => ({ status, body }) },
  });
  const notFound = await webFetch("https://github.com/missing", context(404, '{"message":"Not Found"}'));
  assert.equal(notFound.error, "HTTP Error 404: Not Found");
  assert.equal(notFound.content, undefined);
  const serverError = await webFetch("https://github.com/boom", context(500, "explode"));
  assert.equal(serverError.error, "HTTP Error 500: Internal Server Error");
  // A JSON error body must not leak through as content.
  assert.equal(serverError.content, undefined);
  // A 200 body is still evidence.
  const ok = await webFetch("https://github.com/ok", context(200, "release notes"));
  assert.deepEqual(ok, { content: "release notes" });
  // 3xx that is not a redirect (e.g. 304 Not Modified) fails like urllib.
  const notModified = await webFetch("https://github.com/etag", context(304, ""));
  assert.equal(notModified.error, "HTTP Error 304: Not Modified");
});

test("web_fetch preserves success across an allowed redirect and fail-closes on a disallowed one", async () => {
  let called = 0;
  const allowed = ctx("/tmp", {
    allowedHosts: ["github.com", "api.github.com"],
    deps: {
      ...deps(),
      fetch: async (url: string) => {
        called++;
        if (called === 1) return { status: 302, headers: { location: "https://api.github.com/real" }, body: "" };
        assert.equal(url, "https://api.github.com/real");
        return { status: 200, body: "final body" };
      },
    },
  });
  assert.deepEqual(await webFetch("https://github.com/start", allowed), { content: "final body" });
  const disallowed = ctx("/tmp", {
    allowedHosts: ["github.com"],
    deps: { ...deps(), fetch: async () => ({ status: 302, headers: { location: "https://evil.example/" }, body: "" }) },
  });
  assert.match((await webFetch("https://github.com/pivot", disallowed)).error!, /Redirect to disallowed host: evil\.example/);
});

test("web_search treats non-2xx as errors even when the body is a valid JSON error object", async () => {
  const context = (status: number, body: string) => ctx("/tmp", {
    searchUrl: "https://search.test/search",
    deps: { ...deps(), fetch: async () => ({ status, body }) },
  });
  const notFound = await webSearch("x", context(404, JSON.stringify({ error: "not found" })));
  assert.equal(notFound.error, "HTTP Error 404: Not Found");
  assert.equal(notFound.results, undefined);
  const serverError = await webSearch("x", context(500, JSON.stringify({ results: [{ title: "poison" }] })));
  assert.equal(serverError.error, "HTTP Error 500: Internal Server Error");
  assert.equal(serverError.results, undefined);
  // 2xx JSON results still parse and sanitize.
  const ok = await webSearch("x", context(200, JSON.stringify({ results: [{ title: "t", url: "https://a.test/x", content: "s" }] })));
  assert.deepEqual(ok, { results: [{ title: "t", url: "https://a.test/x", snippet: "s" }] });
});
