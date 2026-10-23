/** #1073 action-level regression: the confidence scorer's eligibility gate
 * must be EXACTLY the action entry's `shouldPublish` decision. Drives the
 * real `actionMain()` entrypoint (no injected adapter) against a mocked
 * GitHub API and a mocked model, with the scorer pointed at its own mock
 * server under a distinct model name. Asserts (#1158):
 * - `comment` mode with the legacy `publish-review-comment` flag unset
 *   publishes the sticky PR comment (the publish mode alone decides) and
 *   the scorer fires and scores;
 * - the same run with the deprecated flag set keeps the identical
 *   publication and scoring and adds only the deprecation warning on
 *   stdout. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMain } from "../src/run/action.js";
import { startMockServer, type CapturedRequest } from "./helpers.js";

const SCORER_MODEL = "confidence-m";

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

function scorerBody(score: number): string {
  return JSON.stringify({
    id: "s1", object: "chat.completion", model: SCORER_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ score, risk: "low", reason: "all clear", concerns: [] }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function startGithubMock(options: { baseSha: string; headSha: string }): Promise<{
  url: string;
  requests: CapturedRequest[];
  commentPosts: string[];
  close: () => Promise<void>;
}> {
  const commentPosts: string[] = [];
  return startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
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
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: "write", role: "write" }));
      return;
    }
    if (url.startsWith("/repos/o/r/issues/comments/")) {
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2 }]));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
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
        state: "open",
        draft: false,
        title: "Some PR",
        body: "",
        head: { sha: options.headSha, ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: options.baseSha, ref: "main", repo: { full_name: "o/r" } },
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
  }).then((server) => ({ ...server, commentPosts }));
}

/** The real `issue_comment` payload for a comment on a PR. */
function commentEvent(): string {
  return JSON.stringify({
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 42, body: "/ai-review", user: { login: "alice" } },
    action: "created",
  });
}

interface CaseResult {
  exitCode: number;
  outputs: Record<string, string>;
  /** Every scorer-model request captured by the dedicated scorer mock. */
  scorerRequests: number;
  /** Bodies POSTed to /repos/o/r/issues/7/comments (the sticky comment). */
  commentPosts: string[];
  /** Confidence artifacts present in the action's real run dir. */
  confidenceArtifacts: string[];
  /** The persisted score artifact, when the run wrote one. */
  confidenceScoreArtifact: Record<string, unknown> | null;
  cleanup: () => Promise<void>;
}

async function runCase(options: { publishReviewComment: string }): Promise<CaseResult> {
  const workspace = mkdtempSync(join(tmpdir(), "action-confidence-gate-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-confidence-gate-runner-temp-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const scorer = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(scorerBody(4));
  });
  const github = await startGithubMock({ baseSha: "b".repeat(40), headSha: "a".repeat(40) });
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, commentEvent());
  // Deliberately NOT `{ ...process.env, ... }` (the #890 CI lesson): the run
  // must not inherit ambient state that could flip the gate being tested.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: github.url,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(runnerTemp, "step-summary.md"),
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_AI-BASE-URL": model.url,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_PUBLISH-MODE": "comment",
    "INPUT_PUBLISH-REVIEW-COMMENT": options.publishReviewComment,
    "INPUT_AI-CONFIDENCE-MODEL": SCORER_MODEL,
    "INPUT_AI-CONFIDENCE-BASE-URL": scorer.url,
  };
  const cleanup = async (): Promise<void> => {
    await model.close();
    await scorer.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  };
  let exitCode = -1;
  try {
    exitCode = await actionMain(env);
  } catch (error) {
    await cleanup();
    throw error;
  }
  // The action's own run dir (createRunDir under RUNNER_TEMP).
  const runDirs = readdirSync(runnerTemp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("v3-review-run-"))
    .map((entry) => join(runnerTemp, entry.name));
  assert.equal(runDirs.length, 1, "expected exactly one action run dir");
  const confidenceArtifacts = ["confidence-request.json", "confidence-response.json", "confidence-score.json"]
    .filter((name) => existsSync(join(runDirs[0]!, name)));
  const confidenceScoreArtifact = confidenceArtifacts.includes("confidence-score.json")
    ? JSON.parse(readFileSync(join(runDirs[0]!, "confidence-score.json"), "utf8")) as Record<string, unknown>
    : null;
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(env.GITHUB_OUTPUT!, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return {
    exitCode,
    outputs,
    scorerRequests: scorer.requests.length,
    commentPosts: github.commentPosts,
    confidenceArtifacts,
    confidenceScoreArtifact,
    cleanup,
  };
}

/** Captures everything the entry writes to stdout while `run()` executes,
 * without suppressing the stream (each chunk is echoed) — used to observe
 * the publisher's messages: `publishWith` mirrors its step messages to
 * stdout, so the deprecated-input WARN the publish seam pushes lands here. */
async function withCapturedStdout<T>(run: () => Promise<T>): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: Uint8Array | string, ...rest: never[]) => {
    lines.push(String(chunk));
    return original(chunk, ...(rest as []));
  }) as unknown as typeof process.stdout.write;
  try {
    return { lines, result: await run() };
  } finally {
    process.stdout.write = original;
  }
}

test("#1073/#1158 action: comment mode publishes the sticky comment and the scorer fires with the legacy flag unset", async () => {
  const result = await runCase({ publishReviewComment: "false" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "true");
    assert.equal(result.scorerRequests, 1, "the scorer did not grade a publishing comment-mode run");
    assert.equal(result.outputs["confidence-status"], "scored");
    assert.equal(result.outputs["confidence-score"], "4");
    assert.equal(result.outputs["confidence-model"], SCORER_MODEL);
    for (const name of ["confidence-request.json", "confidence-response.json", "confidence-score.json"]) {
      assert.ok(result.confidenceArtifacts.includes(name), `${name} is missing for a scored comment-mode run`);
    }
    assert.equal(result.confidenceScoreArtifact?.status, "scored");
    assert.equal(result.confidenceScoreArtifact?.score, 4);
    // #1158: the publish step ran from the publish mode alone — the sticky
    // comment (with its confidence section) was published.
    assert.equal(result.commentPosts.length, 1, "the sticky comment did not publish");
    assert.match(result.commentPosts[0]!, /## Independent Confidence/);
  } finally {
    await result.cleanup();
  }
});

test("#1073/#1158 action: comment mode with publish-review-comment set warns, publishes, and scores identically", async () => {
  // Positional control: the identical run with the flag unset proves any
  // difference in the flagged case is the flag's, not the mock wiring's.
  const unflagged = await runCase({ publishReviewComment: "false" });
  try {
    assert.equal(unflagged.exitCode, 0);
    assert.equal(unflagged.scorerRequests, 1);
    assert.equal(unflagged.commentPosts.length, 1);
    const flagged = await withCapturedStdout(() => runCase({ publishReviewComment: "true" }));
    try {
      assert.equal(flagged.result.exitCode, 0);
      assert.equal(flagged.result.scorerRequests, 1);
      assert.equal(flagged.result.outputs["confidence-status"], "scored");
      assert.equal(flagged.result.commentPosts.length, 1, "the sticky comment published");
      assert.match(flagged.result.commentPosts[0]!, /## Independent Confidence/);
      // The deprecated input is observed on this run and warns; the same run
      // keeps publishing and scoring identically.
      assert.ok(
        flagged.lines.some((line) => line.includes("WARN: 'publish-review-comment' is deprecated") && line.includes("no longer affects publication")),
        `expected the publish-review-comment deprecation warning on stdout:\n${flagged.lines.join("")}`,
      );
    } finally {
      await flagged.result.cleanup();
    }
  } finally {
    await unflagged.cleanup();
  }
});
