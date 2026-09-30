/** #885 follow-up: `actionMain()` — the real `node dist/index.js` action
 * entry (`firstArg === ""` in src/index.ts) — computes the trusted base SHA
 * in precheck (`pre.base_sha`) but, before this fix, never forwarded it into
 * `stage.PR_REVIEWER_BASE_REF` before calling `runReview()`. Every review
 * driven through the actual GitHub Action therefore ran with an empty base
 * ref and silently dropped standards (and repository config) — only tests
 * and the standalone `run` CLI subcommand, which set `PR_REVIEWER_BASE_REF`
 * themselves, ever exercised the base-ref path. This test drives the real
 * `actionMain()` entrypoint (precheck → review, no injected adapter) against
 * a git fixture repo and a mocked GitHub API, without setting
 * `PR_REVIEWER_BASE_REF` itself, and asserts the base ref's AGENTS.md rule
 * — not the PR head's edit of it — reached the review corpus. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMain } from "../src/run/action.js";
import { startMockServer } from "./helpers.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}

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

/** A minimal GitHub REST mock sufficient for precheck + review: PR object
 * (JSON or the v3.diff media type, branched on Accept), empty comment/review
 * lists (no prior managed review to skip against), and a one-file diff. Any
 * GraphQL call (PR body revision, conversation comments, review threads)
 * gets a 404, which every caller treats as an empty/failed optional read. */
function startGithubMock(baseSha: string, headSha: string): ReturnType<typeof startMockServer> {
  return startMockServer((req, _body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/o/r/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2 }]));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      res.end("[]");
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
        title: "Loosen the rules",
        body: "",
        head: { sha: headSha, ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: baseSha, ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" },
        changed_files: 1,
        additions: 1,
        deletions: 1,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
}

test("#885: actionMain wires precheck's base SHA into the review stage — standards come from the base ref with no PR_REVIEWER_BASE_REF set by the caller", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-standards-base-ref-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-standards-runner-temp-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", workspace], { env: GIT_ENV });
    write(workspace, "AGENTS.md", "# Rules\n- Never use eval()\n");
    const baseSha = commit(workspace, "base standards");
    // The PR's own head: it edits AGENTS.md to remove the rule.
    write(workspace, "AGENTS.md", "# Rules\n(rule removed by this PR)\n");
    const headSha = commit(workspace, "head drops the rule");

    github = await startGithubMock(baseSha, headSha);

    const exitCode = await actionMain({
      ...process.env,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_API_URL: github.url,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      // No GITHUB_EVENT_PATH and no PR_REVIEWER_BASE_REF: this test asserts
      // actionMain derives the base ref itself from precheck, the way the
      // real composite action runs — never set by the caller/test.
      "INPUT_GITHUB-TOKEN": "tok",
      "INPUT_PR-NUMBER": "7",
      "INPUT_AI-BASE-URL": model.url,
      "INPUT_AI-MODEL": "m",
      "INPUT_AI-STREAM": "false",
      "INPUT_AI-API-KEY": "k",
      "INPUT_TOOL-MODE": "off",
      "INPUT_DEEP-REVIEW": "false",
      "INPUT_CI-STATUS-CHECK": "false",
      // Keep this test to precheck+review only: "comment" mode with
      // publish-review-comment left at its default "false" never publishes.
      "INPUT_PUBLISH-MODE": "comment",
    });
    assert.equal(exitCode, 0);

    const runDirs = readdirSync(runnerTemp).filter((name) => name.startsWith("v3-review-run-"));
    assert.equal(runDirs.length, 1, `expected exactly one run dir, got: ${runDirs.join(", ")}`);
    const standardsContext = readFileSync(join(runnerTemp, runDirs[0]!, "standards-context.md"), "utf8");
    assert.match(standardsContext, /Never use eval\(\)/);
    assert.doesNotMatch(standardsContext, /rule removed by this PR/);
  } finally {
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
