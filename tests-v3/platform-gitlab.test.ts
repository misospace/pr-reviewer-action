import test from "node:test";
import assert from "node:assert/strict";
import {
  GitLabAdapter,
  gitlabPermissionFromAccessLevel,
  gitlabStatusState,
  prToGitlabPrShape,
} from "../src/platform/gitlab.js";
import { gitlabTokenFromEnv, GITLAB_CROSS_FAMILY_AUTH_REFUSAL } from "../src/platform/gitlab-auth.js";
import { gitlabProjectScopedUrl, parseGitLabProjectPath } from "../src/platform/repo-ref.js";
import type { FetchLike } from "../src/platform/http.js";

const BASE = "https://gitlab.example";
const TOKEN = "sekret-gitlab-token";

interface Seen {
  url: string;
  method: string;
  privateToken: string | null;
  authorization: string | null;
  body: string | undefined;
}

/** Recording fetch: routes by "METHOD url-prefix" to a JSON response and
 * captures the EXACT inputs every request presented, so the assertions can
 * prove where the credential travels (and where it never does). */
function recorder(routes: Array<[string, number, unknown]>): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    seen.push({
      url,
      method,
      privateToken: headers.get("private-token"),
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const hit = routes.find(([key]) => `${method} ${url}`.startsWith(key));
    const [, status, data] = hit ?? ["", 404, { message: "not found" }];
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, seen };
}

const adapter = (fetchImpl: FetchLike, opts: Partial<ConstructorParameters<typeof GitLabAdapter>[0]> = {}) =>
  new GitLabAdapter({ repo: "grp/sub/proj", prNumber: "7", baseUrl: BASE, token: TOKEN, fetchImpl, ...opts });

// ── Project-path grammar (#740) ──────────────────────────────────────────

test("parseGitLabProjectPath accepts nested identity and preserves case", () => {
  assert.equal(parseGitLabProjectPath("group/project"), "group/project");
  assert.equal(parseGitLabProjectPath("group/sub/proj"), "group/sub/proj");
  assert.equal(parseGitLabProjectPath("a/b/c/d/e"), "a/b/c/d/e");
  assert.equal(parseGitLabProjectPath("  Group/Sub.Proj-1_2  "), "Group/Sub.Proj-1_2");
});

// #252 adversarial-boundary rule: the hostile shape is fed to the parser
// ITSELF, not just benign paths.
test("parseGitLabProjectPath rejects traversal, dot-only, empty, and short forms", () => {
  for (const bad of [
    "", "   ", "solo", "a/..", "a/./b", "..", "a/../b", "/a/b", "a/b/", "a//b",
    "a/b/../c", "Gr@up/x", "a b/c", "a/b\nc", "a/b%2Fc",
  ]) {
    assert.equal(parseGitLabProjectPath(bad), null, `must reject: ${JSON.stringify(bad)}`);
  }
});

test("gitlabProjectScopedUrl percent-encodes nested slashes and stays scoped", () => {
  const url = gitlabProjectScopedUrl(`${BASE}/api/v4`, "grp/sub/proj", "/merge_requests/", "7");
  assert.equal(url, `${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`);
});

test("gitlabProjectScopedUrl refuses tails that normalize out of the project prefix", () => {
  // The encoded path is ONE segment, so dynamic tails resolving upward past
  // the prefix are refused, exactly like repoScopedUrl's #706 defense.
  assert.equal(gitlabProjectScopedUrl(`${BASE}/api/v4`, "a/b", "/merge_requests/", "../x"), null);
  assert.equal(gitlabProjectScopedUrl(`${BASE}/api/v4`, "a/b", "/merge_requests/", "/../../x"), null);
  assert.equal(gitlabProjectScopedUrl(`${BASE}/api/v4`, "a/..", "/notes"), null);
});

// ── Auth resolution (#740) ───────────────────────────────────────────────

test("gitlabTokenFromEnv trims GITLAB_TOKEN and stays silent for other families", () => {
  assert.equal(gitlabTokenFromEnv({ GITLAB_TOKEN: "  tok  " }), "tok");
  assert.equal(gitlabTokenFromEnv({ GITLAB_TOKEN: "  " }), undefined);
  assert.equal(gitlabTokenFromEnv({}), undefined);
  // A Forgejo run with the family auth settings is NOT a GitLab refusal.
  assert.equal(gitlabTokenFromEnv({ PLATFORM: "forgejo", FORGEJO_AUTH_METHOD: "token" }), undefined);
});

test("gitlabTokenFromEnv refuses cross-family auth with the specific reason", () => {
  for (const env of [
    { PLATFORM: "GitLab", FORGEJO_AUTH_METHOD: "authorized_integration" },
    { PLATFORM: "gitlab", FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE: "u:1:abc" },
    { PLATFORM: "gitlab", GITLAB_TOKEN: "tok", FORGEJO_AUTH_METHOD: "token" },
  ]) {
    assert.throws(() => gitlabTokenFromEnv(env), (error: unknown) =>
      error instanceof Error && error.message === GITLAB_CROSS_FAMILY_AUTH_REFUSAL);
  }
});

test("the constructor refuses an empty base URL and an invalid project path", () => {
  assert.throws(() => new GitLabAdapter({ repo: "a/b", prNumber: "1", baseUrl: "" }), /must not be empty/);
  assert.throws(() => new GitLabAdapter({ repo: "a/..", prNumber: "1", baseUrl: BASE }), /Invalid GitLab project path/);
  assert.throws(() => new GitLabAdapter({ repo: "solo", prNumber: "1", baseUrl: BASE }), /Invalid GitLab project path/);
});

// ── MR → GitHub-PR shape ─────────────────────────────────────────────────

const MR_INTERNAL = {
  iid: 7, id: 300, title: "T", description: "D", state: "opened",
  draft: false, work_in_progress: false,
  author: { id: 2, username: "alice" },
  diff_refs: { base_sha: "b1", head_sha: "h1", start_sha: "s1" },
  source_project_id: 42, target_project_id: 42,
  source_branch: "feat", target_branch: "main",
  merged_at: null, merge_commit_sha: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
  web_url: "https://gitlab.example/grp/sub/proj/-/merge_requests/7",
  labels: ["bug"],
};

interface GitHubPrShape {
  number: number | string;
  state?: string;
  draft?: unknown;
  merged?: boolean;
  merge_commit_sha?: unknown;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } };
  base: { sha: string; repo: { full_name: string } };
  labels: Array<{ name: string }>;
}

test("getPr projects an internal MR onto the GitHub-PR shape", async () => {
  const { fetchImpl, seen } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`, 200, MR_INTERNAL]]);
  const pr = await adapter(fetchImpl).getPr() as GitHubPrShape | null;
  assert.ok(pr);
  assert.equal(pr.number, 7);
  assert.equal(pr.state, "opened");
  assert.equal(pr.draft, false);
  assert.deepEqual(pr.user, { login: "alice" });
  assert.equal(pr.head.sha, "h1");
  assert.equal(pr.head.repo.full_name, "grp/sub/proj");
  assert.equal(pr.base.sha, "b1");
  assert.equal(pr.base.repo.full_name, "grp/sub/proj");
  assert.equal(pr.labels[0]?.name, "bug");
  // No second read was needed for an internal MR.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.privateToken, TOKEN);
  assert.equal(seen[0]!.authorization, null);
});

test("getPr proves the fork picture with one source-project read", async () => {
  const fork = { ...MR_INTERNAL, source_project_id: 99 };
  const { fetchImpl, seen } = recorder([
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`, 200, fork],
    [`GET ${BASE}/api/v4/projects/99`, 200, { id: 99, path_with_namespace: "Fork/Proj" }],
  ]);
  const pr = await adapter(fetchImpl).getPr() as GitHubPrShape | null;
  assert.ok(pr);
  assert.equal(pr.head.repo.full_name, "Fork/Proj");
  assert.equal(pr.base.repo.full_name, "grp/sub/proj");
  assert.deepEqual(seen.map((s) => s.url), [
    `${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`,
    `${BASE}/api/v4/projects/99`,
  ]);
});

test("getPr fails cleanly when the MR cannot answer the fork question", async () => {
  const { fetchImpl, seen } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`, 200, { ...MR_INTERNAL, source_project_id: undefined }]]);
  const a = adapter(fetchImpl);
  assert.equal(await a.getPr(), null);
  assert.equal(a.prReadFailure()?.kind, "invalid-payload");
  assert.equal(seen.length, 1, "no guess is made on an unanswerable payload");
});

test("getPr records the HTTP-status cause on a failed MR read", async () => {
  const { fetchImpl } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`, 404, { message: "not found" }]]);
  const a = adapter(fetchImpl);
  assert.equal(await a.getPr(), null);
  const cause = a.prReadFailure();
  assert.equal(cause?.kind, "http-status");
  assert.equal(cause?.status, 404);
});

test("prToGitlabPrShape: draft precedence and unusable payload rejection", () => {
  const base = { iid: 1, id: 1, diff_refs: { base_sha: "b", head_sha: "h" }, source_project_id: 1, target_project_id: 1 };
  const p1 = prToGitlabPrShape({ ...base, draft: true }, "a/b", "a/b", "1") as GitHubPrShape;
  assert.equal(p1.draft, true);
  const p2 = prToGitlabPrShape({ ...base, work_in_progress: true }, "a/b", "a/b", "1") as GitHubPrShape;
  assert.equal(p2.draft, true);
  const p3 = prToGitlabPrShape({ ...base }, "a/b", "a/b", "1") as GitHubPrShape;
  assert.equal(p3.draft, undefined, "neither flag → unknown, never defaulted to not-draft");
  assert.equal(prToGitlabPrShape({ ...base }, "a/b", null, "1"), null, "unproven source path refuses the projection");
  const merged = prToGitlabPrShape({ ...base, state: "merged", merge_commit_sha: "m1" }, "a/b", "a/b", "1") as GitHubPrShape;
  assert.equal(merged.merged, true);
  assert.equal(merged.merge_commit_sha, "m1");
});

// ── Notes, identity, permissions ─────────────────────────────────────────

const NOTES = [
  { id: 10, body: "first", system: false, author: { id: 3, username: "carol" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 11, body: "", system: true, author: { id: 9, username: "gitlab-system" }, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
  { id: 12, body: "second", system: false, author: { id: 4, username: "dave" }, created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" },
];

test("listIssueComments excludes system notes and maps the author", async () => {
  const { fetchImpl } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/notes`, 200, NOTES]]);
  const comments = await adapter(fetchImpl).listIssueComments();
  assert.deepEqual(comments.map((c) => c.id), [10, 12]);
  assert.equal(comments[0]?.author, "carol");
  assert.equal(comments[1]?.authorId, 4);
});

test("authenticatedIdentity resolves the token's username from /user", async () => {
  const { fetchImpl, seen } = recorder([[`GET ${BASE}/api/v4/user`, 200, { id: 3, username: "carol" }]]);
  assert.equal(await adapter(fetchImpl).authenticatedIdentity(), "carol");
  assert.equal(seen[0]!.url, `${BASE}/api/v4/user`);
});

test("repoPermission maps access levels and reports 404 as none", async () => {
  const cases: Array<[number, string]> = [[50, "admin"], [40, "write"], [30, "write"], [20, "read"], [10, "read"], [5, "none"]];
  for (const [level, expected] of cases) {
    const { fetchImpl } = recorder([
      [`GET ${BASE}/api/v4/user`, 200, { id: 3, username: "carol" }],
      [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/members/all/3`, 200, { id: 3, access_level: level }],
    ]);
    assert.equal(await adapter(fetchImpl).repoPermission(), expected, `access_level ${level}`);
  }
  const missing = recorder([
    [`GET ${BASE}/api/v4/user`, 200, { id: 3, username: "carol" }],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/members/all/3`, 404, { message: "not found" }],
  ]);
  assert.equal(await adapter(missing.fetchImpl).repoPermission(), "none");
  assert.equal(gitlabPermissionFromAccessLevel(undefined), null);
});

// ── Threads, files, diff, CI ─────────────────────────────────────────────

const positioned = (id: number) => ({ id, body: `n${id}`, position: { base_sha: "b", head_sha: "h", new_path: "a.py" } });

test("listReviewThreads projects positioned discussions and declares the window honestly", async () => {
  const one = (id: number) => ({ id, individual_note: true, resolved: id === 2, notes: [positioned(id)] });
  const page1 = [one(1), one(2), one(3), { id: 999, individual_note: true, notes: [{ id: 9990, body: "plain comment" }] }];
  const { fetchImpl } = recorder([
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/discussions`, 200, page1],
  ]);
  const result = await adapter(fetchImpl).listReviewThreads();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.complete, undefined, "a short page proves the end");
    assert.equal(result.data.length, 3);
    assert.deepEqual(result.data[1], { threadId: "2", resolved: true, firstCommentId: "2" });
  }
  // A second page beyond the 100-thread window: incomplete (fail closed).
  const full = Array.from({ length: 100 }, (_, i) => one(i + 1));
  const over = recorder([
    ["GET https://gitlab.example/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/discussions?per_page=100&page=1", 200, full],
    ["GET https://gitlab.example/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/discussions?per_page=100&page=2", 200, [one(101)]],
  ]);
  const capped = await adapter(over.fetchImpl).listReviewThreads();
  assert.equal(capped.ok, true);
  if (capped.ok) {
    assert.equal(capped.complete, false);
    assert.equal(capped.data.length, 100);
  }
});

test("listPrFiles maps GitLab file rows onto the GitHub file shape", async () => {
  const files = [
    { new_path: "a.py", old_path: "a.py", new_file: true, deleted_file: false, renamed_file: false, diff: "@@ +a @@", generated_file: false },
    { new_path: "b.py", old_path: "old/b.py", new_file: false, deleted_file: false, renamed_file: true, diff: "@@ ren @@", generated_file: false },
  ];
  const { fetchImpl } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/files`, 200, files]]);
  const result = await adapter(fetchImpl).listPrFiles();
  assert.ok(result.ok);
  const rows = result.data as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => [r["filename"], r["status"], r["previous_filename"]]), [
    ["a.py", "added", null],
    ["b.py", "renamed", "old/b.py"],
  ]);
  assert.equal(rows[0]?.["patch"], "@@ +a @@");
});

test("getPrDiff concatenates the paged diffs document", async () => {
  const { fetchImpl, seen } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/diffs`, 200, { diffs: [{ diff: "d1" }, { diff: "d2" }], pagination: { next_page: null } }]]);
  assert.equal(await adapter(fetchImpl).getPrDiff(), "d1d2");
  assert.match(seen[0]!.url, /diffs\?per_page=100&page=1$/);
});

test("externalChecks collapses GitLab statuses onto the gate vocabulary", async () => {
  const statuses = [
    { name: "ci/build", status: "success" },
    { name: "ci/lint", status: "failed" },
    { name: "ci/e2e", status: "running" },
    { name: "pr-reviewer-action", status: "success" },
  ];
  const { fetchImpl } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/repository/commits/abc123/statuses`, 200, statuses]]);
  const checks = await adapter(fetchImpl).externalChecks("abc123", { statusContext: "pr-reviewer-action" });
  assert.deepEqual(checks?.map((c) => [c.name, c.state, c.conclusion]), [
    ["ci/build", "success", "success"],
    ["ci/lint", "failure", "failed"],
    ["ci/e2e", "pending", "running"],
  ]);
  assert.equal(await adapter(fetchImpl).externalChecks("../evil"), null);
  assert.deepEqual(gitlabStatusState("skipped"), { state: "success", conclusion: "skipped" });
});

test("listPrConversationComments excludes system notes and snapshots newest-first", async () => {
  const { fetchImpl } = recorder([[`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/notes`, 200, NOTES]]);
  const result = await adapter(fetchImpl).listPrConversationComments();
  assert.ok(result.ok);
  const items = result.data as Array<Record<string, unknown>>;
  assert.deepEqual(items.map((i) => i["id"]), [12, 10], "newest-first snapshot, system note dropped");
  assert.equal(items[0]?.["user"], "dave");
});

test("ghApi refuses every endpoint rather than guessing a translation", async () => {
  const { fetchImpl, seen } = recorder([]);
  const result = await adapter(fetchImpl).ghApi("/repos/grp/sub/proj/pulls/7");
  assert.ok(result.error?.includes("not supported"));
  assert.equal(seen.length, 0);
});

// ── Credential placement (the AGENTS invariant, pinned adversarially) ───

test("the token travels ONLY in the PRIVATE-TOKEN header — never in a URL", async () => {
  const { fetchImpl, seen } = recorder([
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7`, 200, MR_INTERNAL],
    [`GET ${BASE}/api/v4/user`, 200, { id: 3, username: "carol" }],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/members/all/3`, 200, { id: 3, access_level: 40 }],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/notes`, 200, NOTES],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/discussions`, 200, []],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/files`, 200, []],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/merge_requests/7/diffs`, 200, { diffs: [], pagination: { next_page: null } }],
    [`GET ${BASE}/api/v4/projects/grp%2Fsub%2Fproj/repository/commits/abc/statuses`, 200, []],
  ]);
  const a = adapter(fetchImpl);
  await a.getPr();
  await a.authenticatedIdentity();
  await a.repoPermission();
  await a.listIssueComments();
  await a.listReviewThreads();
  await a.listPrFiles();
  await a.getPrDiff();
  await a.externalChecks("abc");
  assert.ok(seen.length >= 8, "every read actually ran");
  for (const call of seen) {
    assert.equal(call.privateToken, TOKEN, `${call.url} carries the PRIVATE-TOKEN header`);
    assert.equal(call.authorization, null, "GitLab never uses the Authorization header here");
    assert.ok(!call.url.includes(TOKEN), "the token never appears in a request URL");
    assert.ok(call.body === undefined || !call.body.includes(TOKEN), "the token never appears in a request body");
  }
});
