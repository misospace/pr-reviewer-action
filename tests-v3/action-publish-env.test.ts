/** #726: the publish env fold in `actionMain()` — the engine's verified
 * reviewed head (`reviewedHeadSha`) and final fork flag (`isForkPr`) must
 * reach the publish stage as HEAD_SHA/IS_FORK_PR. IS_FORK_PR matters
 * concretely: publish's native-approval guardrail treats a missing value as
 * "unknown fork state" and withholds the approval for a same-repository PR.
 * Drives the real `actionMain()` entrypoint (no injected adapter) against a
 * mocked GitHub API and model, in `review_verdict` mode so the verdict maps
 * to a native review whose `event` and `commit_id` are observable: the
 * submitted review must be an APPROVE bound to the PR's head. The comment
 * event carries no head SHA, no `PR_HEAD_SHA` pin is set, and `GITHUB_SHA`
 * holds a merge-ref-shaped value — so a run that still consulted `GITHUB_SHA`
 * as the reviewed head would activate the pin with a wrong value and skip
 * `superseded-head` instead of publishing. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMain } from "../src/run/action.js";
import { startMockServer, type CapturedRequest } from "./helpers.js";

function verdictBody(): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null,
      findings: [], requirement_coverage: null, required_check_dispositions: [],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

/** Minimal GitHub REST mock sufficient for precheck + review + a
 * review_verdict publish: PR object (JSON or the v3.diff media type), empty
 * comment/review lists, comment-command authorization, and capture of the
 * native review submission. Unmodeled reads 404 and degrade gracefully. */
function startGithubMock(): Promise<{
  url: string;
  requests: CapturedRequest[];
  reviewPosts: string[];
  close: () => Promise<void>;
}> {
  const reviewPosts: string[] = [];
  return startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
      if (req.method === "POST") {
        reviewPosts.push(body);
        res.statusCode = 200;
        res.end(JSON.stringify({ id: 9 }));
        return;
      }
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 100 }));
        return;
      }
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: "write", role: "write" }));
      return;
    }
    if (url.startsWith("/repos/o/r/issues/comments/")) {
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7")) {
      if (req.headers.accept === "application/vnd.github.v3.diff") {
        res.setHeader("Content-Type", "text/plain");
        res.end("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
        return;
      }
      res.end(JSON.stringify({
        number: 7,
        state: "open",
        draft: false,
        title: "Update README",
        body: "",
        head: { sha: "a".repeat(40), ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" },
        changed_files: 1,
        additions: 1,
        deletions: 0,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    if (url.startsWith("/user")) {
      res.end(JSON.stringify({ login: "ci-bot" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  }).then((server) => ({ ...server, reviewPosts }));
}

test("#726: the publish env folds the reviewed head pin and the fork flag — the native approval is bound to the pin", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-publish-env-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-publish-env-runner-temp-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const github = await startGithubMock();
  // The `issue_comment` payload has NO head SHA; the pin travels only
  // through PR_HEAD_SHA.
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 42, body: "/ai-review", user: { login: "alice" } },
    action: "created",
  }));
  // Deliberately NOT `{ ...process.env, ... }` (the #890 CI lesson): the run
  // must not inherit ambient state that could flip the path being tested.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    // The merge-ref-shaped value the runner exports on synchronize events —
    // the adapter must NOT consult it as the reviewed head (no PR_HEAD_SHA
    // pin is set here: "" means unset, admission resolves from the event).
    GITHUB_SHA: "m".repeat(40),
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: github.url,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(runnerTemp, "step-summary.md"),
    PR_NUMBER: "7",
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": model.url,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_REREVIEW-COMMAND": "/ai-review",
    "INPUT_PUBLISH-MODE": "review_verdict",
  };
  let exitCode = -1;
  try {
    exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(env.GITHUB_OUTPUT!, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    assert.equal(outputs["should-review"], "true", "the comment-triggered run was not skipped by a GITHUB_SHA-derived pin");
    assert.equal(outputs["skip-reason"], "");
    assert.equal(github.reviewPosts.length, 1, `expected one native review submission, got: ${github.reviewPosts.join(" | ")}`);
    const submitted = JSON.parse(github.reviewPosts[0]!) as { event?: string; commit_id?: string };
    assert.equal(submitted.event, "APPROVE", "the fold must carry IS_FORK_PR so the approval guardrail does not treat a same-repo PR as an unknown fork");
    assert.equal(submitted.commit_id, "a".repeat(40), "the native review is bound to the reviewed head (the engine's verified head, never GITHUB_SHA)");
    const runDirs = readdirSync(runnerTemp, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("v3-review-run-"))
      .map((entry) => join(runnerTemp, entry.name));
    assert.equal(runDirs.length, 1, "expected exactly one action run dir");
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
