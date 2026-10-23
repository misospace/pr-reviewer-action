import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_COMMANDS, UNTRACKED_PATH_ERROR, allowlistedHost, buildTrackedIndex, encodeEndpointSegment, executeToolRequest, findFiles, ghApi, gitBlame, gitGrep,
  listTree, readFile, resolveWorkspacePath, runCommand, validateEndpoint,
  webFetch, webSearch, type ToolContext,
} from "../src/tools/executors.js";
import { McpToolset, isReadOnlyTool, parseServerSpecs, splitNamespaced } from "../src/tools/mcp.js";
import { USER_AGENT } from "../src/platform/user-agent.js";
import { GitHubAdapter } from "../src/platform/github.js";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { REDACTED_SOURCE } from "../src/context/redact.js";

function fixture(fn: (root: string, outside: string) => Promise<void> | void): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-")), root = path.join(base, "x"), outside = path.join(base, "xy");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  try { return Promise.resolve(fn(root, outside)).finally(() => fs.rmSync(base, { recursive: true, force: true })); }
  catch (e) { fs.rmSync(base, { recursive: true, force: true }); throw e; }
}
const deps = () => ({ env: {}, runProcess: async (options: any) => ({ status: "exited", exitCode: 0, signal: null, stdout: Buffer.from(" ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF "), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null }) as any });
const ctx = (root: string, extra: Partial<ToolContext> = {}): ToolContext => ({ workspaceRoot: root, deps: deps(), ...extra });

/** Test seam for the #1015 bound read: when the executor routes a workspace
 * read through `git show <rev>:<path>` to bind the bytes to a committed
 * revision, mock that call to read the actual file content from disk. The
 * test never relies on the unverified fallback path here — every
 * `sourceRevision`-bearing assertion below installs this mock so committed
 * bytes are byte-identical to the bytes the masker sees. */
function trackingRunProcess(cwd: string) {
  const argvs: string[][] = [];
  const runProcess = async (options: any) => {
    argvs.push([options.file, ...(options.args ?? [])]);
    const file = options.file;
    const args: string[] = options.args ?? [];
    if (file === "git" && args[0] === "show") {
      const revPath = args[1] ?? "";
      const colon = revPath.indexOf(":");
      if (colon > 0) {
        const rel = revPath.slice(colon + 1);
        const full = path.resolve(cwd, rel);
        if (full.startsWith(path.resolve(cwd) + path.sep) && fs.existsSync(full)) {
          try {
            return { status: "exited", exitCode: 0, signal: null, stdout: fs.readFileSync(full), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null } as any;
          } catch (e) {
            return { status: "exited", exitCode: 1, signal: null, stdout: Buffer.from(""), stderr: Buffer.from(String(e)), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null } as any;
          }
        }
      }
      return { status: "exited", exitCode: 1, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("git show: unknown revision or path not in the working tree"), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null } as any;
    }
    return { status: "exited", exitCode: 0, signal: null, stdout: Buffer.from(" ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF "), stderr: Buffer.from(""), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null } as any;
  };
  return { argvs, deps: { env: {}, runProcess } as any };
}
const trackingCtx = (root: string, extra: Partial<ToolContext> = {}): { ctx: ToolContext; argvs: string[][] } => {
  const t = trackingRunProcess(root);
  return { ctx: { workspaceRoot: root, deps: t.deps, ...extra }, argvs: t.argvs };
};

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
  // The blob endpoint is refused on the API surface (#1215 review).
  assert.match(validateEndpoint("repos/o/r/git/blobs/abc", ["o/r"]).error!, /Path segment denied/);
  assert.match(validateEndpoint("file:///etc/passwd", []).error!, /Dot-segment not allowed/);
  const bad = await ghApi("repos/o/r/actions/secrets", ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: async () => { throw Error("must not call"); } } })); assert.match(bad.error, /Path segment denied/);
});

test("gh_api decodes Contents API file objects instead of slicing base64 (#913)", async () => {
  const call = (payload: unknown) =>
    executeToolRequest("gh_api", { endpoint: "repos/o/r/contents/action.yml" },
      ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: async () => ({ data: payload }) } }));
  const fileObj = (path: string, bytes: Buffer, shaSeed: string) => ({
    type: "file", encoding: "base64", path, sha: shaSeed.repeat(40), size: bytes.length,
    content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
  });

  // The regression: a large action.yml read through gh_api arrives readable
  // and flagged, not as an unreadable slice of base64.
  const fileText = "name: CI\non: pull_request\n" + "  run: echo verify-inputs\n".repeat(1200);
  const decoded = await call(fileObj("action.yml", Buffer.from(fileText, "utf8"), "a"));
  assert.equal(decoded.status, "ok");
  assert.equal(decoded.result.path, "action.yml");
  assert.equal(decoded.result.sha, "a".repeat(40));
  assert.equal(decoded.result.size, Buffer.byteLength(fileText));
  assert.match(decoded.result.content, /^name: CI\non: pull_request\n/);
  assert.equal(decoded.result.truncated, true);
  assert.equal(decoded.result.content, fileText.slice(0, 12000) + "\n[truncated]");
  assert.equal(decoded.result.response, undefined);

  // A small file is complete and untruncated.
  const smallText = "name: Small\njobs: {}\n";
  const small = await call(fileObj("small.yml", Buffer.from(smallText, "utf8"), "b"));
  assert.equal(small.result.content, smallText);
  assert.equal(small.result.truncated, false);

  // Decoded file text is repository source content: source-safe masking (#876).
  const secretText = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n";
  const secret = await call(fileObj("cfg.yml", Buffer.from(secretText, "utf8"), "c"));
  assert.match(secret.result.content, /redacted:credential/);
  assert.doesNotMatch(secret.result.content, /ghp_/);

  // A credential straddling the cap boundary is masked whole (#926): the
  // masker sees the full decoded text before any truncation. In a code file
  // with no secret-named key, a partial ghp_ token (27 visible chars here)
  // matches no masker pattern, so a decode-then-truncate order would leak
  // the fragment; the token starts at byte 11969 and ends at 12008.
  const straddleText = "x".repeat(11957) + "\n" + 'const v = "ghp_' + "A".repeat(36) + '";\n' + "tail();\n".repeat(10);
  const straddle = await call(fileObj("src/app.ts", Buffer.from(straddleText, "utf8"), "f"));
  assert.match(straddle.result.content, /redacted:credential/);
  assert.doesNotMatch(straddle.result.content, /ghp_/);
  assert.equal(straddle.result.truncated, true);

  // Binary and invalid-UTF-8 payloads return safe metadata without bytes.
  const binary = await call(fileObj("img.png", Buffer.from([0x89, 0x00, 0x50, 0x4e]), "d"));
  assert.deepEqual(binary.result, { path: "img.png", sha: "d".repeat(40), size: 4, binary: true, truncated: false });
  const badUtf8 = await call(fileObj("bin.dat", Buffer.from([0xff, 0x28]), "e"));
  assert.equal(badUtf8.result.binary, true);

  // Directory listings and non-file objects keep the raw compact-JSON response.
  const dir = await call([{ type: "dir", path: "src" }, { type: "file", path: "src/a.ts" }]);
  assert.equal(dir.result.content, undefined);
  assert.match(dir.result.response, /^\[\{"type":"dir","path":"src"\}/);
  const meta = await call({ number: 913, title: "x" });
  assert.equal(meta.result.response, '{"number":913,"title":"x"}');
});

test("gh_api and repo_contents fail closed without a wired forge capability (#1210)", async () => {
  const unwired = ctx("/tmp", { allowedGhRepos: ["o/r"], deps: deps() });
  const api = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" }, unwired);
  assert.equal(api.status, "error");
  assert.equal(api.result.error, "platform transport not configured");
  // Without a `path` the dir read reaches the seam call directly.
  const noPath = await executeToolRequest("repo_contents", { repo: "o/r" }, unwired);
  assert.equal(noPath.status, "error");
  assert.equal(noPath.result.error, "platform transport not configured");
  // With a `path` the preflight masks any seam failure first.
  const withPath = await executeToolRequest("repo_contents", { repo: "o/r", path: "README.md" }, unwired);
  assert.equal(withPath.status, "error");
  assert.equal(withPath.result.error, "Repository contents file preflight failed");
});

test("gh_api and repo_contents route validated endpoints through the forge capability (#1210)", async () => {
  const endpoints: string[] = [];
  const timeouts: number[] = [];
  const wired = ctx("/tmp", {
    allowedGhRepos: ["o/r"],
    requestTimeout: 7,
    deps: {
      ...deps(),
      ghApi: async (endpoint: string, opts?: { timeoutMs: number }) => {
        endpoints.push(endpoint);
        timeouts.push(opts?.timeoutMs ?? -1);
        if (endpoint.startsWith("/repos/o/r/contents/src")) {
          return { data: [{ name: "app.ts", type: "file", path: "src/app.ts", sha: "f".repeat(40) }] };
        }
        if (endpoint === `/repos/o/r/git/blobs/${"f".repeat(40)}`) {
          return { data: { encoding: "base64", content: Buffer.from("const x = 1;\n", "utf8").toString("base64") } };
        }
        return { data: { number: 1 } };
      },
    },
  });
  const api = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" }, wired);
  assert.equal(api.status, "ok");
  assert.equal(api.result.response, '{"number":1}');
  const contents = await executeToolRequest("repo_contents", { repo: "o/r", path: "src/app.ts", ref: "main" }, wired);
  assert.equal(contents.status, "ok");
  assert.equal(contents.result.content, "const x = 1;\n");
  // The validated GitHub-shaped paths (allowlist, deny-substring and
  // dot-segment policy applied tool-side BEFORE the seam) and the loop's
  // configured request bound reach the capability.
  assert.deepEqual(endpoints, ["/repos/o/r/pulls/1", "/repos/o/r/contents/src?ref=main", `/repos/o/r/git/blobs/${"f".repeat(40)}`]);
  assert.deepEqual(timeouts, [7000, 7000, 7000]);
});

test("forge-capability errors surface in-band from the executors (#1210)", async () => {
  const refusal = `Endpoint not supported on PLATFORM=forgejo: /repos/o/r/contents/src`;
  const wired = ctx("/tmp", {
    allowedGhRepos: ["o/r"],
    deps: {
      ...deps(),
      ghApi: async (endpoint: string) => endpoint.startsWith("/repos/o/r/contents")
        ? { error: refusal }
        : { error: "Forgejo API error: 404" },
    },
  });
  // gh_api: the adapter's curated in-band error passes through verbatim.
  const api = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/9" }, wired);
  assert.equal(api.status, "error");
  assert.equal(api.result.error, "Forgejo API error: 404");
  // repo_contents without a path: the final read's error surfaces.
  const dir = await executeToolRequest("repo_contents", { repo: "o/r" }, wired);
  assert.equal(dir.status, "error");
  assert.equal(dir.result.error, refusal);
  // repo_contents with a path: the preflight keeps its generic masking.
  const file = await executeToolRequest("repo_contents", { repo: "o/r", path: "src/app.ts" }, wired);
  assert.equal(file.status, "error");
  assert.equal(file.result.error, "Repository contents file preflight failed");
});

test("gh_api JSON responses are secret-redacted before reaching the conversation (#1210 review)", async () => {
  const res = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" },
    ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: async () => ({ data: { body: "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" } }) } }));
  assert.equal(res.status, "ok");
  assert.match(res.result.response, /\[REDACTED\]/);
  assert.doesNotMatch(res.result.response, /ghp_/);
});

test("gh_api refuses blob content endpoints: encoded source bytes never reach the model (#1215 review)", async () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const encoded = Buffer.from(`token: ${secret}\n`, "utf8").toString("base64");
  const seen: string[] = [];
  const wired = ctx("/tmp", {
    allowedGhRepos: ["o/r"],
    deps: {
      ...deps(),
      ghApi: async (endpoint: string) => {
        seen.push(endpoint);
        return { data: { content: encoded, encoding: "base64", sha: "a".repeat(40), url: "https://api.github.com/repos/o/r/git/blobs/x" } };
      },
    },
  });
  const blob = await executeToolRequest("gh_api", { endpoint: `repos/o/r/git/blobs/${"a".repeat(40)}` }, wired);
  assert.equal(blob.status, "error");
  assert.match(String(blob.result.error), /Path segment denied/);
  // The blob endpoint never reaches the forge capability at all.
  assert.deepEqual(seen, []);
  // Neither the credential nor any encoding of it is in the model-facing result.
  const surfaced = JSON.stringify(blob.result);
  assert.doesNotMatch(surfaced, /ghp_/);
  assert.doesNotMatch(surfaced, /ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/);
  assert.doesNotMatch(surfaced, new RegExp(Buffer.from(secret, "utf8").toString("base64")));
  assert.doesNotMatch(surfaced, new RegExp(encoded.slice(0, 24)));
});

test("gh_api refuses an undecoded base64 content payload (#1215 review)", async () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const encoded = Buffer.from(`token: ${secret}\n`, "utf8").toString("base64");
  const res = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" },
    ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: async () => ({ data: { content: encoded, encoding: "base64" } }) } }));
  // A base64 payload no decoder claimed is encoded source bytes: emitting it
  // verbatim would hand the model bytes the redactor cannot match.
  assert.equal(res.status, "error");
  assert.match(String(res.result.error), /base64/);
  const surfaced = JSON.stringify(res.result);
  assert.doesNotMatch(surfaced, /ghp_/);
  assert.doesNotMatch(surfaced, new RegExp(encoded.slice(0, 24)));
});

test("a nested or oddly spelled base64 payload is still refused (#1215 review)", async () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const encoded = Buffer.from(`token: ${secret}\n`, "utf8").toString("base64");
  const payloads = [
    { items: [{ content: encoded, encoding: "base64" }] },
    { blob: { content: encoded, encoding: "BASE64" } },
    [{ content: encoded, encoding: "base64" }],
  ];
  for (const data of payloads) {
    const res = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" },
      ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: async () => ({ data }) } }));
    assert.equal(res.status, "error");
    assert.match(String(res.result.error), /base64/);
    assert.doesNotMatch(JSON.stringify(res.result), /ghp_/);
  }
});

test("the blob endpoint refusal survives percent-encoding (#1215 review)", async () => {
  const seen: string[] = [];
  const wired = ctx("/tmp", {
    allowedGhRepos: ["o/r"],
    deps: { ...deps(), ghApi: async (endpoint: string) => { seen.push(endpoint); return { data: { number: 1 } }; } },
  });
  // `/git/blobs%2F<sha>` and `/%67it/blobs/<sha>` are the same request once
  // the server decodes them: the refusal must not depend on the spelling.
  for (const endpoint of [`repos/o/r/git/blobs%2F${"a".repeat(40)}`, `repos/o/r/%67it/blobs/${"a".repeat(40)}`]) {
    const res = await executeToolRequest("gh_api", { endpoint }, wired);
    assert.equal(res.status, "error");
    assert.match(String(res.result.error), /Path segment denied/);
  }
  assert.deepEqual(seen, []);
  // The same spelling outside the blob endpoint is unaffected.
  const ok = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" }, wired);
  assert.equal(ok.status, "ok");
});

test("blob bytes reach the model only through repo_contents, and masked (#1215 review)", async () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const encoded = Buffer.from(`token: ${secret}\n`, "utf8").toString("base64");
  const res = await executeToolRequest("repo_contents", { repo: "o/r", path: "src/app.ts" },
    ctx("/tmp", {
      allowedGhRepos: ["o/r"],
      deps: {
        ...deps(),
        ghApi: async (endpoint: string) => {
          if (endpoint === "/repos/o/r/contents/src") {
            return { data: [{ name: "app.ts", type: "file", path: "src/app.ts", sha: "f".repeat(40) }] };
          }
          if (endpoint === `/repos/o/r/git/blobs/${"f".repeat(40)}`) {
            return { data: { encoding: "base64", content: encoded } };
          }
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        },
      },
    }));
  // The file-read channel serves the blob's bytes, masked with the
  // path-aware source-safe policy.
  assert.equal(res.status, "ok");
  assert.match(res.result.content, /redacted:credential/);
  assert.doesNotMatch(res.result.content, /ghp_/);
  assert.doesNotMatch(res.result.content, /ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/);
});

test("the endpoint builders residue-encode every segment and share one repo prefix (#1215 review)", async () => {
  // `encodeURIComponent` leaves `!'()*` unencoded and the platform endpoint
  // validator rejects them, so every segment this module builds is
  // residue-encoded — through ONE encoder, so the two builders cannot drift.
  assert.equal(encodeEndpointSegment("o'!r(x)*"), "o%27%21r%28x%29%2A");
  assert.equal(encodeEndpointSegment("plain-path"), "plain-path");
  const endpoints: string[] = [];
  const wired = ctx("/tmp", {
    allowedGhRepos: ["o/r"],
    deps: {
      ...deps(),
      ghApi: async (endpoint: string) => {
        endpoints.push(endpoint);
        if (endpoint.includes("/contents/")) {
          return { data: [{ name: "app.ts", type: "file", path: "src/app.ts", sha: "f".repeat(40) }] };
        }
        return { data: { encoding: "base64", content: Buffer.from("const x = 1;\n", "utf8").toString("base64") } };
      },
    },
  });
  // A path carrying the residue characters reaches the seam percent-encoded —
  // the reachable case the platform endpoint validator would reject raw.
  const res = await executeToolRequest("repo_contents", { repo: "o/r", path: "dir'!(1)/app.ts" }, wired);
  assert.equal(res.status, "ok");
  const contents = endpoints.find((e) => e.includes("/contents/"))!;
  assert.match(contents, /%27%21%281%29/);
  assert.doesNotMatch(contents, /[!'()*]/);
  // The preflight (contents) endpoint and the blob endpoint share the same
  // repo-scoped prefix — one builder, one encoding.
  const blob = endpoints.find((e) => e.includes("/git/blobs/"))!;
  assert.equal(contents.split("/contents/")[0], blob.split("/git/blobs/")[0]);
});

test("the blob endpoint refusal does not touch workspace paths (#1215 review)", async () => {
  // The refusal is an API-surface decision: a file the PR adds under a
  // `git/blobs/` directory is still readable in the workspace.
  await fixture(async (root) => {
    fs.mkdirSync(path.join(root, "git", "blobs"), { recursive: true });
    const file = path.join(root, "git", "blobs", "note.txt");
    fs.writeFileSync(file, "hello\n");
    const guarded = resolveWorkspacePath("git/blobs/note.txt", root);
    assert.equal(guarded.error, null);
    assert.equal(guarded.path, fs.realpathSync(file));
  });
});

test("the tool-level gates run before the real adapter bound as the seam (#1210)", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const adapter = new GitHubAdapter({
    repo: "o/r",
    prNumber: "1",
    token: "Bearer t",
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null });
      return new Response(JSON.stringify({ number: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as never,
  });
  const wired = ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: adapter.ghApi.bind(adapter) } });
  const ok = await executeToolRequest("gh_api", { endpoint: "repos/o/r/pulls/1" }, wired);
  assert.equal(ok.status, "ok");
  // The validated endpoint path joins the adapter's own validated base, and
  // the adapter's credential — not the tool context env — rides the request.
  assert.equal(seen[0]!.url, "https://api.github.com/repos/o/r/pulls/1");
  assert.equal(seen[0]!.auth, "Bearer t");

  // A query-string endpoint passes through the validator unchanged.
  seen.length = 0;
  const q = await executeToolRequest("gh_api", { endpoint: "repos/o/r/issues?state=open" }, wired);
  assert.equal(q.status, "ok");
  assert.equal(seen[0]!.url, "https://api.github.com/repos/o/r/issues?state=open");

  // A repo outside the tool allowlist never reaches the adapter's fetch.
  seen.length = 0;
  const notAllowed = await executeToolRequest("gh_api", { endpoint: "repos/other/r/pulls/1" }, wired);
  assert.match(String(notAllowed.result.error), /Repo not allowed/);
  assert.deepEqual(seen, []);

  // Secret variables are deny-listed, not merely "read-only".
  const denied = await executeToolRequest("gh_api", { endpoint: "repos/o/r/actions/variables/TOKEN" }, wired);
  assert.match(String(denied.result.error), /Path segment denied/);
  assert.deepEqual(seen, []);
});

test("repo_contents through the real Forgejo adapter fails closed in-band (#1210)", async () => {
  const adapter = new ForgejoAdapter({
    repo: "o/r",
    prNumber: "1",
    baseUrl: "https://git.example",
    token: "t",
    fetchImpl: (async () => { throw new Error("must not fetch"); }) as never,
  });
  const wired = ctx("/tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: adapter.ghApi.bind(adapter) } });
  const dir = await executeToolRequest("repo_contents", { repo: "o/r" }, wired);
  assert.equal(dir.status, "error");
  assert.match(String(dir.result.error), /Endpoint not supported on PLATFORM=forgejo/);
});

test("repo_contents masks credentials before truncating decoded files (#927)", async () => {
  const call = (bytes: Buffer | string) => executeToolRequest("repo_contents", { repo: "o/r", path: "src/app.ts" },
    ctx("tmp", { allowedGhRepos: ["o/r"], deps: { ...deps(), ghApi: async (endpoint: string) => {
      if (endpoint === "/repos/o/r/contents/src") {
        return { data: [{ name: "app.ts", type: "file", path: "src/app.ts", sha: "f".repeat(40) }] };
      }
      if (endpoint === `/repos/o/r/git/blobs/${"f".repeat(40)}`) {
        const encoded = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
        return { data: { encoding: "base64", content: encoded.toString("base64") } };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    } } }));

  const straddleText = "x".repeat(11957) + "\n" + 'const v = "ghp_' + "A".repeat(36) + '";\n' + "tail();\n".repeat(10);
  const straddle = await call(straddleText);
  assert.match(straddle.result.content, /redacted:credential/);
  assert.doesNotMatch(straddle.result.content, /ghp_/);
  assert.equal(straddle.result.truncated, true);

  const smallText = "const x = 1;\n";
  const small = await call(smallText);
  assert.equal(small.result.content, smallText);
  assert.equal(small.result.truncated, false);

  // Binary and invalid-UTF-8 files still return metadata without bytes, so no
  // content key reaches the masker (same guardrails as the gh_api test).
  const binary = await call(Buffer.from([0x89, 0x00, 0x50, 0x4e]));
  assert.deepEqual(binary.result, { repo: "o/r", path: "src/app.ts", type: "file", binary: true, truncated: false });
  const badUtf8 = await call(Buffer.from([0xff, 0x28]));
  assert.equal(badUtf8.result.binary, true);
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

test("outbound tool fetches carry the non-default reviewer User-Agent (#221/#252)", async () => {
  // Cloudflare bot-fight fronting self-hosted forges blocks the default
  // fetch/curl agents: every outbound tool request must identify itself.
  const seen: Array<Record<string, unknown> | undefined> = [];
  const fetchDep = async (_url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(init?.headers);
    return { status: 200, body: JSON.stringify({ results: [] }) };
  };
  const fetched = await webFetch("https://github.com/", ctx("/tmp", { allowedHosts: ["github.com"], deps: { ...deps(), fetch: fetchDep } }));
  assert.equal(fetched.error, undefined);
  const searched = await webSearch("q", ctx("/tmp", { searchUrl: "https://search.test/search", deps: { ...deps(), fetch: fetchDep } }));
  assert.equal(searched.error, undefined);
  assert.ok(seen.length >= 2, "both tool fetches must have issued a request");
  for (const headers of seen) {
    assert.equal(headers?.["User-Agent"], USER_AGENT);
    assert.notEqual(headers?.["User-Agent"], "undici");
  }
});

test("tool wrapper applies byte truncation and redaction", async () => fixture(async (root) => {
  const p = path.join(root, "sample.txt"); fs.writeFileSync(p, "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 AKIA1234567890ABCDEF");
  const result = await executeToolRequest("read_file", { path: "sample.txt" }, ctx(root, { maxResponseBytes: 12000 }));
  assert.equal(result.status, "ok"); assert.match(result.result.content, /redacted:credential/); assert.doesNotMatch(result.result.content, /ghp_|AKIA/);
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

function scriptedProcess(exitCodes: number[], stdout = "") {
  const argvs: string[][] = [];
  const runProcess = async (options: any) => {
    argvs.push([options.file, ...options.args]);
    const exitCode = exitCodes[Math.min(argvs.length, exitCodes.length) - 1]!;
    return { status: "exited", exitCode, signal: null, stdout: Buffer.from(exitCode === 0 ? stdout : ""), stderr: Buffer.from(exitCode > 1 ? "fatal: Unmatched (" : ""), stdoutTruncated: false, stderrTruncated: false, durationMs: 1, termination: null } as any;
  };
  return { argvs, deps: { env: {}, runProcess } as any };
}

test("git grep uses extended regex and retries an invalid pattern as a fixed string", async () => fixture(async (root) => {
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "a.sh"), "apply() {\n"); fs.writeFileSync(path.join(root, "a.py"), "x = foo(1)\n");
  const ok = scriptedProcess([0], "a.sh\0" + "1\0" + "apply() {\n");
  const res = await gitGrep("A|B", { workspaceRoot: root, deps: ok.deps });
  assert.deepEqual(res, { matches: ["a.sh:1:apply() {"] });
  assert.deepEqual(ok.argvs, [["git", "grep", "-n", "-z", "-E", "--", "A|B", "."]]);
  const retry = scriptedProcess([128, 0], "a.py\0" + "1\0" + "x = foo(1)\n");
  const scoped = await gitGrep("foo(", { workspaceRoot: root, deps: retry.deps }, "sub");
  assert.equal(retry.argvs.length, 2);
  assert.deepEqual(retry.argvs[0]!.slice(0, 7), ["git", "grep", "-n", "-z", "-E", "--", "foo("]);
  assert.deepEqual(retry.argvs[1], retry.argvs[0]!.map((a) => (a === "-E" ? "-F" : a)));
  assert.equal(retry.argvs[1]![7], "--");
  assert.deepEqual(scoped, { matches: ["a.py:1:x = foo(1)"], note: "pattern is not a valid extended regex; searched as a fixed string" });
  const dispatched = await executeToolRequest("git_grep", { pattern: "foo(" }, { workspaceRoot: root, deps: scriptedProcess([128, 0], "a.py\0" + "1\0" + "x = foo(1)\n").deps });
  assert.equal(dispatched.result.note, "pattern is not a valid extended regex; searched as a fixed string");
  const failed = await gitGrep("foo(", { workspaceRoot: root, deps: scriptedProcess([128, 128]).deps });
  assert.match(failed.error, /git grep failed: fatal: Unmatched/);
}));

test("workspace tools expose only the committed tree when a tracked index is present", async () => fixture(async (root) => {
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "scratch"));
  fs.writeFileSync(path.join(root, "src", "app.py"), "x = 1\n");
  fs.writeFileSync(path.join(root, "pr.json"), "{}\n");
  fs.writeFileSync(path.join(root, "scratch", "review-corpus.md"), "x\n");
  const trackedIndex = buildTrackedIndex("src/app.py\0");
  assert.deepEqual([...trackedIndex.dirs], ["src"]);
  const tracked = ctx(root, { trackedIndex });
  assert.deepEqual(listTree(".", tracked).entries, [{ path: "src", type: "dir" }, { path: "src/app.py", type: "file" }]);
  assert.deepEqual(findFiles("*", tracked).files, ["src/app.py"]);
  assert.equal(listTree("pr.json", tracked).error, UNTRACKED_PATH_ERROR);
  assert.equal((await readFile("pr.json", tracked)).error, UNTRACKED_PATH_ERROR);
  assert.equal((await readFile("src/app.py", tracked)).content, "x = 1\n");
  const unfiltered = ctx(root);
  assert.deepEqual(findFiles("*.json", unfiltered).files, ["pr.json"]);
  assert.equal((await readFile("pr.json", unfiltered)).content, "{}\n");
}));

test("source-derived tools attach evidence provenance (#1015)", async () => fixture(async (root) => {
  const revision = "a".repeat(40);

  // A real credential in committed source is sanitized; provenance says so.
  fs.writeFileSync(path.join(root, "creds.ts"), 'const k = "ghp_' + "A".repeat(36) + '";\n');
  const sanitizedCtx = trackingCtx(root, { sourceRevision: revision });
  const sanitized = await executeToolRequest("read_file", { path: "creds.ts" }, sanitizedCtx.ctx);
  assert.equal(sanitized.status, "ok");
  assert.doesNotMatch(sanitized.result.content, /ghp_/);
  assert.ok(sanitized.result.content.includes(REDACTED_SOURCE));
  assert.equal(sanitized.provenance.representation, "sanitized_source");
  assert.equal(sanitized.provenance.synthesized, true);
  assert.ok(sanitized.provenance.redactionCount >= 1);
  assert.equal(sanitized.provenance.file, "creds.ts");
  assert.equal(sanitized.provenance.revision, revision);
  // The bound read routes through `git show <rev>:<path>` — committed bytes
  // are byte-identical to the disk content the masker saw.
  assert.ok(sanitizedCtx.argvs.some((argv) => argv[0] === "git" && argv[1] === "show"));

  // A secret-named key assigned a code expression is NOT a credential (#876):
  // committed source, zero redactions.
  fs.writeFileSync(path.join(root, "config.ts"), "apiKey: config.apiKey\n");
  const committedCtx = trackingCtx(root, { sourceRevision: revision });
  const committed = await executeToolRequest("read_file", { path: "config.ts" }, committedCtx.ctx);
  assert.equal(committed.result.content, "apiKey: config.apiKey\n");
  assert.equal(committed.provenance.representation, "committed_source");
  assert.equal(committed.provenance.redactionCount, 0);
  assert.equal(committed.provenance.synthesized, false);

  // A literal `[REDACTED]` in committed source is distinguishable from a
  // sanitizer-inserted marker: it stays committed source with count 0.
  fs.writeFileSync(path.join(root, "literal.ts"), 'const m = "[REDACTED]";\n');
  const literalCtx = trackingCtx(root, { sourceRevision: revision });
  const literal = await executeToolRequest("read_file", { path: "literal.ts" }, literalCtx.ctx);
  assert.equal(literal.result.content, 'const m = "[REDACTED]";\n');
  assert.equal(literal.provenance.representation, "committed_source");
  assert.equal(literal.provenance.redactionCount, 0);
}));

test("gh_api Contents provenance records the blob sha as the revision (#1015)", async () => {
  const sha = "b".repeat(40);
  const secretText = "token: ghp_" + "A".repeat(36) + "\n";
  const payload = {
    type: "file", encoding: "base64", path: "cfg.yml", sha, size: Buffer.byteLength(secretText),
    content: Buffer.from(secretText, "utf8").toString("base64"),
  };
  const res = await executeToolRequest("gh_api", { endpoint: "repos/o/r/contents/cfg.yml" },
    ctx("/tmp", {
      allowedGhRepos: ["o/r"],
      sourceRevision: "c".repeat(40),
      deps: { ...deps(), ghApi: async () => ({ data: payload }) },
    }));
  assert.equal(res.status, "ok");
  assert.match(res.result.content, /redacted:credential/);
  assert.equal(res.provenance.representation, "sanitized_source");
  assert.equal(res.provenance.file, "cfg.yml");
  assert.equal(res.provenance.revision, sha);
});

test("non-source tools carry no provenance (#1015)", async () => fixture(async (root) => {
  fs.writeFileSync(path.join(root, "a.txt"), "x");
  const res = await executeToolRequest("find_files", { pattern: "*" }, ctx(root, { sourceRevision: "a".repeat(40) }));
  assert.equal(res.status, "ok");
  assert.equal(res.provenance, undefined);
}));

test("source reads bind to the committed tree, never the working tree (#1015 regression)", async () => {
  // The blocker this test exists to keep fixed: a checkout at HEAD may have
  // tracked files modified on disk during build/test/preparation. The
  // provenance the model sees MUST be byte-true to the revision it claims;
  // otherwise `authorizesLiteralClaim(provenance, HEAD)` could succeed for a
  // literal that does not exist at HEAD. This regression test stands up a
  // real git repo, commits a tracked file, mutates the file on disk, and
  // asserts that the returned bytes equal the committed blob and that the
  // provenance is `committed_source` for the bound revision. It is the only
  // regression test that does not mock `git show` — the assertion is that
  // `git show <rev>:<path>` is what reaches the masker.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bound-read-"));
  const root = path.join(base, "r");
  fs.mkdirSync(root);
  const cp = require("node:child_process") as typeof import("node:child_process");
  const runGit = (args: string[]): { status: number; out: string; err: string } => {
    const r = cp.spawnSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" },
      encoding: "buffer",
    });
    return { status: r.status ?? 0, out: r.stdout?.toString("utf8") ?? "", err: r.stderr?.toString("utf8") ?? "" };
  };
  // Direct subprocess wrapper that bypasses the pgrep preflight (which
  // refuses to launch under test sandboxes) so the regression test runs the
  // same `git show <rev>:<path>` / `git grep <rev>` the production code path
  // calls. The wrapper is byte-exact in args/cwd, so the bytes the masker
  // sees are the literal bytes of the committed tree.
  const directRunProcess = async (options: any): Promise<any> => {
    // The caller's env is the tool env (empty in these fixtures), not the
    // process environment. Production never merges process.env at spawn —
    // PATH arrives via the buildChildEnv allowlist — so this fixture merge
    // stands in for "the allowlisted env would have contained PATH".
    const r = cp.spawnSync(options.file, options.args ?? [], { cwd: options.cwd, env: { ...process.env, ...options.env }, encoding: "buffer" });
    return {
      status: r.error ? "spawn_error" : "exited",
      exitCode: r.status ?? null,
      signal: r.signal ?? null,
      stdout: r.stdout ?? Buffer.from(""),
      stderr: r.stderr ?? Buffer.from(""),
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      termination: null,
      launchError: r.error?.message,
    };
  };
  try {
    runGit(["init", "-q"]);
    runGit(["config", "user.email", "x@x"]);
    runGit(["config", "user.name", "x"]);
    const committed = "const COMMITTED = 'alpha';\n";
    fs.writeFileSync(path.join(root, "src.ts"), committed);
    fs.writeFileSync(path.join(root, ".gitignore"), "");
    runGit(["add", "src.ts"]);
    runGit(["commit", "-q", "-m", "init"]);
    const head = runGit(["rev-parse", "HEAD"]).out.trim();
    assert.match(head, /^[0-9a-f]{40}$/, "git rev-parse HEAD must return a full SHA");

    // Working-tree mutation that is NOT in HEAD's tree. The review pipeline
    // must never see these bytes stamped as committed_source @ HEAD.
    const mutated = "const WORKING_TREE_LITERAL = 'phantom';\nconst COMMITTED = 'alpha';\n";
    fs.writeFileSync(path.join(root, "src.ts"), mutated);

    const tracked = buildTrackedIndex("src.ts\0");
    const context: ToolContext = { workspaceRoot: root, trackedIndex: tracked, sourceRevision: head, deps: { env: {}, runProcess: directRunProcess } };
    const res = await readFile("src.ts", context);
    assert.equal(res.error, undefined);
    assert.equal(res.committed, true, "bound read must route through git show");
    assert.equal(res.content, committed, "read_file must return the committed blob, not the working-tree mutation");
    const toolRes = await executeToolRequest("read_file", { path: "src.ts" }, context);
    assert.equal(toolRes.status, "ok");
    assert.equal(toolRes.provenance.representation, "committed_source");
    assert.equal(toolRes.provenance.file, "src.ts");
    assert.equal(toolRes.provenance.revision, head);
    assert.equal(toolRes.provenance.synthesized, false);

    // The downstream verifier contract: a literal that exists ONLY in the
    // working tree (the mutation) must NOT authorize against the bound
    // provenance, because the bytes the masker saw are the committed bytes
    // — the mutation was never seen. A literal that DOES exist at HEAD must
    // authorize. (We mirror the policy primitives here; the contract is
    // what matters, not the specific helper.)
    const committedLiteral = "alpha";
    const phantomLiteral = "phantom";
    assert.ok(res.content.includes(committedLiteral));
    assert.ok(!res.content.includes(phantomLiteral), "the working-tree mutation must not reach the model");
    assert.equal(
      toolRes.provenance.representation === "committed_source"
        && !toolRes.provenance.synthesized
        && toolRes.provenance.revision === head,
      true,
      "provenance must satisfy the literal-claim contract",
    );

    // Untouched tracked file still binds correctly.
    fs.writeFileSync(path.join(root, "untouched.ts"), "untouched bytes\n");
    runGit(["add", "untouched.ts"]);
    runGit(["commit", "-q", "-m", "untouched"]);
    const head2 = runGit(["rev-parse", "HEAD"]).out.trim();
    const tracked2 = buildTrackedIndex("src.ts\0untouched.ts\0");
    const ctx2: ToolContext = { workspaceRoot: root, trackedIndex: tracked2, sourceRevision: head2, deps: { env: {}, runProcess: directRunProcess } };
    const unt = await readFile("untouched.ts", ctx2);
    assert.equal(unt.error, undefined);
    assert.equal(unt.content, "untouched bytes\n");
    assert.equal(unt.committed, true);

    // Untracked file: the existing UNTRACKED_PATH_ERROR check fires before
    // the bound read runs (the trackedIndex membership is the gate); the
    // bound read must not relax that.
    fs.writeFileSync(path.join(root, "loose.ts"), "loose");
    const looseRes = await executeToolRequest("read_file", { path: "loose.ts" }, ctx2);
    assert.equal(looseRes.result.error, UNTRACKED_PATH_ERROR);

    // File removed in a later revision: a read against the new HEAD where
    // the file no longer exists in the tree must NOT silently read working-
    // tree bytes and stamp them committed_source. The fallback returns the
    // working-tree content so the model still sees something, but the
    // provenance is `untrusted_text` and `authorizesLiteralClaim` cannot
    // succeed against it.
    fs.writeFileSync(path.join(root, "outdated.ts"), "canonical\n");
    runGit(["add", "outdated.ts"]);
    runGit(["commit", "-q", "-m", "add outdated"]);
    fs.rmSync(path.join(root, "outdated.ts"));
    runGit(["add", "-A"]);
    runGit(["commit", "-q", "-m", "remove outdated"]);
    const head3 = runGit(["rev-parse", "HEAD"]).out.trim();
    fs.writeFileSync(path.join(root, "outdated.ts"), "phantom-literal\n");
    const tracked3 = buildTrackedIndex("src.ts\0untouched.ts\0outdated.ts\0");
    const ctx3: ToolContext = { workspaceRoot: root, trackedIndex: tracked3, sourceRevision: head3, deps: { env: {}, runProcess: directRunProcess } };
    const outdatedRes = await readFile("outdated.ts", ctx3);
    assert.equal(outdatedRes.error, undefined);
    assert.equal(outdatedRes.committed, false, "missing-from-tree reads must NOT claim committed bytes");
    assert.equal(outdatedRes.content, "phantom-literal\n", "fallback reads the working tree so the model still sees content");
    const outdatedTool = await executeToolRequest("read_file", { path: "outdated.ts" }, ctx3);
    assert.equal(outdatedTool.provenance.representation, "untrusted_text");
    assert.equal(outdatedTool.provenance.revision, null);

    // git_grep routes through `<rev>` when bound: a literal that exists
    // ONLY in the working tree must not surface.
    fs.writeFileSync(path.join(root, "grep-target.ts"), "const CANARY = 'committed-grep-literal';\n");
    runGit(["add", "grep-target.ts"]);
    runGit(["commit", "-q", "-m", "add grep target"]);
    const head4 = runGit(["rev-parse", "HEAD"]).out.trim();
    fs.writeFileSync(path.join(root, "grep-target.ts"), "const PHANTOM = 'working-tree-grep-literal';\n");
    const tracked4 = buildTrackedIndex("src.ts\0untouched.ts\0outdated.ts\0grep-target.ts\0");
    const ctx4: ToolContext = { workspaceRoot: root, trackedIndex: tracked4, sourceRevision: head4, deps: { env: {}, runProcess: directRunProcess } };
    const grepRes = await gitGrep("CANARY", ctx4);
    assert.ok(!grepRes.error);
    assert.deepEqual(grepRes.matches, ["grep-target.ts:1:const CANARY = 'committed-grep-literal';"]);
    const phantom = await gitGrep("PHANTOM", ctx4);
    assert.deepEqual(phantom.matches, [], "a literal that exists ONLY in the working tree must not surface from a bound grep");

    // git_blame routes through `<rev>` when bound: blame against the
    // committed revision shows lines from that tree, not the working tree.
    const blameRes = await gitBlame("grep-target.ts", ctx4);
    assert.ok(!blameRes.error);
    assert.ok(blameRes.blame.includes("committed-grep-literal"), "blame must show committed bytes, not the working-tree mutation");
    assert.ok(!blameRes.blame.includes("working-tree-grep-literal"), "blame must not leak working-tree mutation");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("source-bound tool executors stay forge-agnostic (#1015 / fork privilege separation)", async () => {
  // Regression-style guard for the fork privilege separation invariant:
  // #1015's bound source-read plumbing lives in src/tools/executors.ts. The
  // module is shared by fork and same-repo runs and must NOT branch on fork
  // context — a fork author must not be able to influence a literal-claim
  // authorization by reaching for fork-only flags. Reading the source as
  // text keeps the assertion deterministic and side-effect free.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const here = path.dirname(__filename);
  const modulePath = path.resolve(here, "../../src/tools/executors.ts");
  const source = await fs.readFile(modulePath, "utf8");
  for (const token of ["FORK_PRIMARY", "FORK_SMART", "FORK_LITELLM", "ai-review-fork", "isFork", "is_fork", "pull_request_target"]) {
    assert.ok(!source.includes(token), `executors.ts must not reference fork-specific token: ${token}`);
  }
});

test("#726: a caller cancellation reaches the tool subprocess and fetch seams", () => fixture(async (root) => {
  // (a) processOutput carries the context signal into the process options.
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const seamCtx = ctx(root, {
    signal: controller.signal,
    deps: { env: {}, runProcess: (async (o: any) => { seenSignal = o.signal; return { status: "exited", exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.from(""), termination: null }; }) as any },
  });
  await runCommand("git_status_short", seamCtx);
  assert.equal(seenSignal, controller.signal, "the subprocess options carry the caller's cancellation signal");

  // (b) Real seam: a pre-aborted signal refuses the launch (fail-closed) and
  // degrades to an ordinary tool error, never a hang.
  const abortedCtx = ctx(root, { signal: AbortSignal.abort(), deps: { env: {} } as any });
  const res = await runCommand("git_status_short", abortedCtx);
  assert.equal(typeof res.error, "string");
  assert.notEqual(res.error, "", "a cancelled tool call surfaces as a tool error");

  // (c) The tool fetch seam receives the signal for web_fetch.
  let fetchSignal: AbortSignal | undefined;
  const webCtx = ctx(root, {
    allowedHosts: ["example.com"],
    signal: controller.signal,
    deps: { env: {}, fetch: (async (_url: string, init: any) => { fetchSignal = init.signal; return { status: 200, body: "ok" }; }) as any },
  });
  const web = await webFetch("http://example.com/x", webCtx);
  assert.equal(web.content, "ok");
  assert.equal(fetchSignal, controller.signal, "the web fetch init carries the caller's signal");

  // (d) defaultFetch composes the caller abort with the per-request timeout:
  // the abort REASON the fetch's signal carries must be the caller's, and it
  // must arrive without waiting for the per-call timeout (guarded, so a
  // reverted composition fails the assertion instead of hanging the suite).
  const caller = new AbortController();
  const marker = "caller-cancel-marker";
  const originalFetch = globalThis.fetch;
  let initSignal: AbortSignal | undefined;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    initSignal = init.signal;
    await new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(`aborted reason=${String((init.signal as AbortSignal).reason?.message ?? "none")}`)), { once: true });
    });
    throw new Error("unreachable");
  };
  try {
    const depsOnly = ctx(root, { allowedHosts: ["example.com"], signal: caller.signal, deps: { env: {} } as any });
    const pending = webFetch("http://example.com/x", depsOnly);
    caller.abort(new Error(marker));
    const outcome = await Promise.race([pending, new Promise<{ error: string }>((resolve) => setTimeout(() => resolve({ error: "__guard__" }), 2000))]);
    assert.match(String(outcome.error), new RegExp(marker), "the default fetch carries the caller's cancellation, not just its own timeout");
    assert.ok(initSignal !== undefined && initSignal.aborted);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
}));
