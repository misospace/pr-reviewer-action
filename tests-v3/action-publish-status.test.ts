/** #1257: the `publish-status` output disambiguates the review verdict
 * outputs from what was actually published.
 *
 * The review-stage outputs (`verdict`, `verdict-source`, `review-result`,
 * ...) are written before publication, and a publication withheld by the
 * publication-boundary head re-check (`superseded`) exits successfully — so
 * without this output a consumer could not tell "verdict published" from
 * "verdict produced but never posted on any head".
 *
 * Drives the real `actionMain()` entrypoint (no injected adapter) against a
 * mocked GitHub API whose PR head FLIPS after the model call completes —
 * exactly the "new push lands while the review is running" race — plus the
 * standalone `publishMain` CLI against the same seam. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMain } from "../src/run/action.js";
import { publishMain } from "../src/run/entrypoints.js";
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

/** Parses a written `GITHUB_OUTPUT` file into a map (heredoc delimiters
 * never appear in these single-line values). */
function readOutputs(file: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

/** GitHub mock for PR 7 whose current head is mutable: `flipHead` changes
 * what every subsequent `GET /repos/o/r/pulls/7` reports, which is how the
 * tests model "a newer push landed after the review stage read the head". */
async function startGithubMock(): Promise<{
  url: string;
  requests: CapturedRequest[];
  reviewPosts: string[];
  commentPosts: string[];
  flipHead: (sha: string) => void;
  close: () => Promise<void>;
}> {
  let headSha = "a".repeat(40);
  const reviewPosts: string[] = [];
  const commentPosts: string[] = [];
  const server = await startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
      if (req.method === "POST") reviewPosts.push(body);
      res.statusCode = 200;
      res.end(JSON.stringify({ id: 9 }));
      return;
    }
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        commentPosts.push(body);
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 100 }));
        return;
      }
      res.end("[]");
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
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: "write", role: "write" }));
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
        head: { sha: headSha, ref: "feature", repo: { full_name: "o/r" } },
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
  });
  return {
    ...server,
    reviewPosts,
    commentPosts,
    flipHead: (sha: string): void => {
      headSha = sha;
    },
  };
}

/** Minimal env for the action entry: never `{ ...process.env, ... }` (the
 * #890 CI lesson — the run must not inherit ambient state that could flip
 * the path under test). */
function actionEnv(paths: {
  eventPath: string;
  runnerTemp: string;
  workspace: string;
  githubUrl: string;
  modelUrl: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: paths.eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_SHA: "m".repeat(40),
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: paths.githubUrl,
    GITHUB_WORKSPACE: paths.workspace,
    RUNNER_TEMP: paths.runnerTemp,
    GITHUB_OUTPUT: join(paths.runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(paths.runnerTemp, "step-summary.md"),
    PR_NUMBER: "7",
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": paths.modelUrl,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_REREVIEW-COMMAND": "/ai-review",
    "INPUT_PUBLISH-MODE": "review_comment",
  };
}

function writeCommentEvent(eventPath: string, body: string): void {
  writeFileSync(eventPath, JSON.stringify({
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 42, body, user: { login: "alice" } },
    action: "created",
  }));
}

async function captureStdout(): Promise<{ lines: string[]; restore: () => void }> {
  const original = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => { process.stdout.write = original; } };
}

test("#1257: a head change after the review stage publishes nothing and reports publish-status=superseded (exit stays 0)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "publish-status-superseded-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "publish-status-superseded-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review");
  // The push lands exactly when the model answers: admission and the review
  // stage saw head aaaa…, the publication boundary sees cccc….
  let modelAnswered = false;
  const model = await startMockServer((_req, _body, res) => {
    modelAnswered = true;
    github.flipHead("c".repeat(40));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  const stdout = await captureStdout();
  try {
    const exitCode = await actionMain(env);
    assert.equal(modelAnswered, true, "the review must have run for the boundary race to be exercised");
    // Fail-soft semantics are unchanged: a superseded run is not a failure.
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "true");
    // The review outputs still describe the review this run PRODUCED...
    assert.equal(outputs["verdict"], "approve");
    // ...and this output is what says none of it was posted.
    assert.equal(outputs["publish-status"], "superseded");
    assert.equal(github.reviewPosts.length, 0, "a superseded run must submit no native review");
    assert.equal(github.commentPosts.length, 0, "a superseded run must post no comment");
    assert.ok(
      stdout.lines.some((line) => line.includes("A newer push superseded reviewed commit")),
      "the superseded step message still reaches stdout",
    );
  } finally {
    stdout.restore();
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1257: a published review reports publish-status=published", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "publish-status-published-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "publish-status-published-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review");
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["verdict"], "approve");
    assert.equal(outputs["publish-status"], "published");
    // `review_comment` mode with no inline findings publishes the sticky
    // summary comment — the point is that SOMETHING was posted, unlike the
    // superseded run above.
    assert.equal(github.commentPosts.length, 1, "the control path posts exactly one published review surface");
    assert.equal(github.reviewPosts.length, 0);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1257: a skipped run never attempted publication — publish-status stays absent", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "publish-status-skip-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "publish-status-skip-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "unrelated conversation");
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "false");
    assert.notEqual(outputs["skip-reason"], "");
    // Absent (reads as "") is the documented "publication was not attempted"
    // value — it must not be written as a fabricated status.
    assert.ok(!("publish-status" in outputs), `publish-status must not be written on a skipped run, got: ${outputs["publish-status"]}`);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1257: the standalone publish CLI writes publish-status=superseded and exits 0 on a newer head", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "publish-status-cli-temp-"));
  const github = await startGithubMock();
  github.flipHead("c".repeat(40));
  const outputFile = join(runnerTemp, "gh-output.txt");
  try {
    const exitCode = await publishMain({
      REPO: "o/r",
      PR_NUMBER: "7",
      PUBLISH_MODE: "comment",
      HEAD_SHA: "a".repeat(40),
      BASE_SHA: "b".repeat(40),
      VERDICT: "approve",
      REVIEW_MARKDOWN: "ok",
      GH_TOKEN: "tok",
      GITHUB_API_URL: github.url,
      GITHUB_OUTPUT: outputFile,
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(exitCode, 0, "superseded publication stays fail-soft");
    assert.equal(readOutputs(outputFile)["publish-status"], "superseded");
    assert.equal(github.commentPosts.length, 0);
  } finally {
    await github.close();
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1257: the standalone publish CLI writes publish-status=failed and exits 1 when the current head is unprovable", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "publish-status-cli-fail-temp-"));
  // No usable PR endpoint at all: getHeadSha fails → the #451 boundary refuses.
  const github = await startMockServer((_req, _body, res) => { res.statusCode = 500; res.end("boom"); });
  const outputFile = join(runnerTemp, "gh-output.txt");
  try {
    const exitCode = await publishMain({
      REPO: "o/r",
      PR_NUMBER: "7",
      PUBLISH_MODE: "comment",
      HEAD_SHA: "a".repeat(40),
      BASE_SHA: "b".repeat(40),
      VERDICT: "approve",
      REVIEW_MARKDOWN: "ok",
      GH_TOKEN: "tok",
      GITHUB_API_URL: github.url,
      GITHUB_OUTPUT: outputFile,
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(exitCode, 1);
    assert.equal(readOutputs(outputFile)["publish-status"], "failed");
  } finally {
    await github.close();
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
