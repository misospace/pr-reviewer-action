import test from "node:test";
import assert from "node:assert/strict";
import { gitCredentialEnv, gitEnv, gitInvocationEnv, safeCloneUrl, toFetchCredentials } from "../src/acquisition/git-env.js";
import { pullRequestHeadRef, pullHeadRefspec, type AcquisitionPlatform } from "../src/platform/head-ref.js";

test("pullRequestHeadRef: canonical head ref for both platforms", () => {
  assert.equal(pullRequestHeadRef("github", 7), "refs/pull/7/head");
  assert.equal(pullRequestHeadRef("forgejo", 7), "refs/pull/7/head");
  assert.equal(pullHeadRefspec("github"), "+refs/pull/*:refs/pull/*");
  assert.equal(pullHeadRefspec("forgejo"), "+refs/pull/*:refs/pull/*");
  assert.equal(pullHeadRefspec("gitlab" as AcquisitionPlatform), null);
});

test("pullRequestHeadRef: fails closed on invalid input", () => {
  assert.equal(pullRequestHeadRef("github", 0), null);
  assert.equal(pullRequestHeadRef("github", -3), null);
  assert.equal(pullRequestHeadRef("github", 1.5), null);
  assert.equal(pullRequestHeadRef("github", Number.NaN), null);
  assert.equal(pullRequestHeadRef("github", Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(pullRequestHeadRef("gitlab" as AcquisitionPlatform, 7), null);
  assert.equal(pullRequestHeadRef("github", "7" as unknown as number), null);
});

test("safeCloneUrl: http(s) only, no userinfo, hostname required", () => {
  assert.equal(safeCloneUrl("https://git.example.internal:3000/org/repo.git"), "https://git.example.internal:3000/org/repo.git");
  assert.equal(safeCloneUrl("http://127.0.0.1:8442/repo.git"), "http://127.0.0.1:8442/repo.git");
  assert.equal(safeCloneUrl("https://user:pass@host/repo.git"), null);
  assert.equal(safeCloneUrl("https://token@host/repo.git"), null);
  assert.equal(safeCloneUrl("ftp://host/repo.git"), null);
  assert.equal(safeCloneUrl("file:///tmp/repo.git"), null);
  assert.equal(safeCloneUrl("not a url"), null);
});

test("gitEnv: neutralizes global/system config and prompting; allowlist only", () => {
  const env = gitEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    ACQUIRER_SECRET_CANARY: "leak-me",
    GIT_CONFIG_GLOBAL: "/host/gitconfig",
    GIT_CONFIG_SYSTEM: "/host/systemconfig",
  });
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.XDG_CONFIG_HOME, "/dev/null/nonexistent-xdg-config");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/operator");
  assert.equal(env.ACQUIRER_SECRET_CANARY, undefined);
});

test("gitCredentialEnv: credential only in per-invocation config env, host-scoped", () => {
  const url = "https://git.example.internal:3000/org/repo.git";
  const env = gitCredentialEnv({ cloneUrl: url, authorization: "Basic dXNlcjpwYXNz" }, url);
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://git.example.internal:3000/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, "Basic dXNlcjpwYXNz");
});

test("gitCredentialEnv: empty without credentials or on refused URL", () => {
  assert.deepEqual(gitCredentialEnv(undefined, "https://host/repo.git"), {});
  assert.deepEqual(gitCredentialEnv({ cloneUrl: "file:///tmp/repo.git", authorization: "Basic eA==" }, "file:///tmp/repo.git"), {});
  assert.deepEqual(gitCredentialEnv({ cloneUrl: "https://user@host/repo.git", authorization: "Basic eA==" }, "https://user@host/repo.git"), {});
  // A credential bound to host A is refused for host B's invocation.
  assert.deepEqual(gitCredentialEnv({ cloneUrl: "https://a.example/repo.git", authorization: "Basic eA==" }, "https://b.example/repo.git"), {});
});

test("toFetchCredentials: binds the #730 CloneCredential to its URL; refuses bad URLs", () => {
  assert.deepEqual(
    toFetchCredentials({ cloneUrl: "https://git.example/org/repo.git", headerName: "Authorization", headerValue: "Basic eA==" }),
    { cloneUrl: "https://git.example/org/repo.git", authorization: "Basic eA==" },
  );
  assert.equal(toFetchCredentials({ cloneUrl: "file:///x", headerName: "Authorization", headerValue: "Basic eA==" }), null);
  assert.equal(toFetchCredentials({ cloneUrl: "https://u@h/r.git", headerName: "Authorization", headerValue: "Basic eA==" }), null);
});

test("gitInvocationEnv composes base and credential env", () => {
  const env = gitInvocationEnv(
    { PATH: "/bin", HOME: "/h", SECRET: "x" },
    gitCredentialEnv({ cloneUrl: "https://h/repo.git", authorization: "Basic eQ==" }, "https://h/repo.git"),
  );
  assert.equal(env.SECRET, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_VALUE_0, "Basic eQ==");
});
