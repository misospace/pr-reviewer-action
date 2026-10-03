/** #914: the `/ai-review` comment command in the v3 Node entry.
 *
 * Drives the real `actionMain()` entrypoint (no injected adapter) against a
 * mocked GitHub API and a mocked model, with a real `GITHUB_EVENT_PATH`
 * file carrying the actual `issue_comment` shape (`issue.number` +
 * `issue.pull_request` for a comment on a PR, a top-level `comment`, and NO
 * top-level `pull_request` — the PR number comes only from the event).
 * Asserts:
 * - an authorized same-repo command runs the review and posts exactly one 👀
 *   ack reaction on the comment (no fork reply);
 * - a `read` permission, a permission lookup error, an unrelated body, a
 *   disabled command, and a comment on a plain issue each skip cleanly with
 *   the matching reason, with no reaction, no reply, and no model call (and
 *   NO forge call at all for the plain-issue case);
 * - an authorized command on a fork PR skips as `comment-fork-pr` and posts
 *   exactly one static reply comment (no reaction, no review).
 * The precheck decision layers themselves are unit-covered in
 * `tests-v3/precheck-comment-command.test.ts`. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The one substring that identifies the static fork-reply body among the
 * other POSTs to `/issues/7/comments` (the published sticky comment). */
const FORK_REPLY_MARKER = "ai-review-fork";

/** A minimal GitHub REST mock sufficient for precheck + review + the
 * #914 ack-reaction and fork-reply write calls. `permission` is the
 * commenter's repository permission (default `write`); `permissionStatus`,
 * when given, makes the permission endpoint return that HTTP status (a
 * lookup error → fail closed). `forkHeadRepo`, when given and different
 * from the base repo, makes the PR a fork. */
function startGithubMock(options: {
  baseSha: string;
  headSha: string;
  permission?: string;
  permissionStatus?: number;
  forkHeadRepo?: string;
}): Promise<{
  url: string;
  requests: CapturedRequest[];
  reactionCalls: string[];
  reactionBodies: string[];
  replyBodies: string[];
  close: () => Promise<void>;
}> {
  const reactionCalls: string[] = [];
  const reactionBodies: string[] = [];
  const replyBodies: string[] = [];
  return startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    // #914 ack reaction: POST /repos/o/r/issues/comments/<id>/reactions.
    // (Checked before the issue-comments route below: the two prefixes do
    // not overlap, but the order keeps it so.)
    if (req.method === "POST" && url.startsWith("/repos/o/r/issues/comments/")) {
      reactionCalls.push(url);
      reactionBodies.push(body);
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    // Issue comments: GET (the managed-comment list — always empty here, so
    // publish creates rather than edits) and POST (a fork reply OR the
    // published sticky comment; the test distinguishes them by body).
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        let text = "";
        try { text = String((JSON.parse(body) as { body?: unknown }).body ?? ""); } catch { text = ""; }
        replyBodies.push(text);
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 100 }));
        return;
      }
      res.end("[]");
      return;
    }
    // #914 commenter permission lookup (fail closed on any non-200).
    if (url.startsWith("/repos/o/r/collaborators/")) {
      if (options.permissionStatus !== undefined) {
        res.statusCode = options.permissionStatus;
        res.end(JSON.stringify({ message: "forbidden" }));
        return;
      }
      res.end(JSON.stringify({ permission: options.permission ?? "write", role: options.permission ?? "write" }));
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
        title: "Some PR",
        body: "",
        head: { sha: options.headSha, ref: "feature", repo: { full_name: options.forkHeadRepo ?? "o/r" } },
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
  }).then((server) => ({ ...server, reactionCalls, reactionBodies, replyBodies }));
}

function baseEnv(options: {
  eventPath: string;
  runnerTemp: string;
  githubUrl: string;
  modelUrl: string;
  workspace: string;
  eventName?: string;
  rereviewCommand?: string;
}): NodeJS.ProcessEnv {
  // Deliberately NOT `{ ...process.env, ... }` (the #890 CI lesson, same as
  // the label test). Deliberately NO `PR_NUMBER` / `INPUT_PR-NUMBER` either:
  // for `issue_comment` the PR number comes ONLY from the event payload
  // (`issue.number`, gated on `issue.pull_request` being present) — which is
  // exactly what this feature exercises, and the plain-issue case depends
  // on that absence.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: options.eventName ?? "issue_comment",
    GITHUB_EVENT_PATH: options.eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: options.githubUrl,
    GITHUB_WORKSPACE: options.workspace,
    RUNNER_TEMP: options.runnerTemp,
    GITHUB_OUTPUT: join(options.runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(options.runnerTemp, "step-summary.md"),
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_AI-BASE-URL": options.modelUrl,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_PUBLISH-MODE": "comment",
    "INPUT_PUBLISH-REVIEW-COMMENT": "true",
    ...(options.rereviewCommand !== undefined ? { "INPUT_REREVIEW-COMMAND": options.rereviewCommand } : {}),
  };
}

function readOutputs(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Swallows and records stderr while an expected log line is asserted (same
 * pattern as the label test). */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: (): void => { process.stderr.write = original; } };
}

/** The real `issue_comment` payload: the PR number lives on `issue.number`
 * and `issue.pull_request` is present ONLY for a comment on a PR. */
function commentEvent(options: { body: string; onPr: boolean; commentId?: number | string }): string {
  return JSON.stringify({
    issue: {
      number: 7,
      ...(options.onPr ? { pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } } : {}),
    },
    comment: {
      id: options.commentId ?? 42,
      body: options.body,
      user: { login: "alice" },
    },
    action: "created",
  });
}

interface CaseResult {
  exitCode: number;
  outputs: Record<string, string>;
  reactionCalls: string[];
  reactionBodies: string[];
  /** The `body` field of every POST to /repos/o/r/issues/7/comments. */
  replyBodies: string[];
  forgeRequests: number;
  modelRequests: number;
  stderrLines: string[];
  stepSummary: string;
  cleanup: () => Promise<void>;
}

async function runCase(options: {
  body: string;
  onPr: boolean;
  permission?: string;
  permissionStatus?: number;
  forkHeadRepo?: string;
  rereviewCommand?: string;
  commentId?: number | string;
}): Promise<CaseResult> {
  const workspace = mkdtempSync(join(tmpdir(), "action-rereview-comment-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-rereview-comment-runner-temp-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const github = await startGithubMock({
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    permission: options.permission ?? "write",
    ...(options.permissionStatus !== undefined ? { permissionStatus: options.permissionStatus } : {}),
    ...(options.forkHeadRepo !== undefined ? { forkHeadRepo: options.forkHeadRepo } : {}),
  });
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, commentEvent({
    body: options.body,
    onPr: options.onPr,
    ...(options.commentId !== undefined ? { commentId: options.commentId } : {}),
  }));
  const env = baseEnv({
    eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace,
    ...(options.rereviewCommand !== undefined ? { rereviewCommand: options.rereviewCommand } : {}),
  });
  const cleanup = async (): Promise<void> => {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  };
  const stderr = captureStderr();
  let exitCode = -1;
  try {
    exitCode = await actionMain(env);
  } catch (error) {
    stderr.restore();
    await cleanup();
    throw error;
  }
  stderr.restore();
  return {
    exitCode,
    outputs: readOutputs(env.GITHUB_OUTPUT!),
    reactionCalls: github.reactionCalls,
    reactionBodies: github.reactionBodies,
    replyBodies: github.replyBodies,
    forgeRequests: github.requests.length,
    modelRequests: model.requests.length,
    stderrLines: stderr.lines,
    stepSummary: readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"),
    cleanup,
  };
}

test("#914: an authorized same-repo /ai-review comment runs the review and posts exactly one ack reaction", async () => {
  const result = await runCase({ body: "/ai-review", onPr: true, permission: "write" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "true");
    assert.equal(result.outputs["skip-reason"], "");
    assert.equal(result.modelRequests, 1, "the review ran");
    assert.equal(result.reactionCalls.length, 1, "exactly one ack reaction");
    assert.match(result.reactionCalls[0]!, /\/repos\/o\/r\/issues\/comments\/42\/reactions$/);
    assert.equal(result.reactionBodies.length, 1);
    assert.ok(result.reactionBodies[0]!.includes('"content":"eyes"'), "the reaction is the 👀 (eyes) content");
    const forkReplies = result.replyBodies.filter((b) => b.includes(FORK_REPLY_MARKER));
    assert.equal(forkReplies.length, 0, "no fork reply on an authorized same-repo run");
  } finally {
    await result.cleanup();
  }
});

test("#914: an unusable comment id skips the ack but still runs the review", async () => {
  const result = await runCase({ body: "/ai-review", onPr: true, permission: "write", commentId: "42;rm -rf" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "true");
    assert.equal(result.reactionCalls.length, 0, "no POST for an id that is not all digits");
    assert.ok(result.stderrLines.some((l) => l.includes("re-review ack skipped")), "the skip is logged");
    assert.equal(result.modelRequests, 1, "the review itself proceeds");
  } finally {
    await result.cleanup();
  }
});

test("#914: the command with trailing text still runs the review and acks (recognition must not require the bare command)", async () => {
  const result = await runCase({ body: "/ai-review please re-run", onPr: true, permission: "write" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "true");
    assert.equal(result.reactionCalls.length, 1, "the ack fires for a command followed by more text");
    assert.equal(result.modelRequests, 1);
  } finally {
    await result.cleanup();
  }
});

test("#914: a read-permission commenter is skipped as comment-unauthorized, with no reaction, reply, or model call", async () => {
  const result = await runCase({ body: "/ai-review", onPr: true, permission: "read" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "comment-unauthorized");
    assert.equal(result.reactionCalls.length, 0, "no ack reaction for an unauthorized commenter");
    assert.equal(result.replyBodies.length, 0, "no fork reply");
    assert.equal(result.modelRequests, 0, "the model is never called");
  } finally {
    await result.cleanup();
  }
});

test("#914: a permission lookup error fails closed as comment-permission-unknown, with no reaction or review", async () => {
  const result = await runCase({ body: "/ai-review", onPr: true, permissionStatus: 403 });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "comment-permission-unknown");
    assert.equal(result.reactionCalls.length, 0);
    assert.equal(result.replyBodies.length, 0);
    assert.equal(result.modelRequests, 0, "the model is never called");
  } finally {
    await result.cleanup();
  }
});

test("#914: a comment on a plain issue (no issue.pull_request) is a clean no-op with no forge calls at all", async () => {
  const result = await runCase({ body: "/ai-review", onPr: false });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "comment-not-on-pr");
    assert.equal(result.forgeRequests, 0, "no forge calls at all (no permission lookup, no reaction)");
    assert.equal(result.reactionCalls.length, 0);
    assert.equal(result.replyBodies.length, 0);
    assert.equal(result.modelRequests, 0);
  } finally {
    await result.cleanup();
  }
});

test("#914: an authorized /ai-review comment on a fork PR skips as comment-fork-pr and posts exactly one static reply", async () => {
  const result = await runCase({ body: "/ai-review", onPr: true, permission: "write", forkHeadRepo: "forker/r" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "comment-fork-pr");
    const forkReplies = result.replyBodies.filter((b) => b.includes(FORK_REPLY_MARKER));
    assert.equal(forkReplies.length, 1, "exactly one fork reply to /issues/7/comments");
    assert.ok(forkReplies[0]!.includes("does not run on fork PRs"), "the reply is the static fork guidance");
    assert.equal(result.reactionCalls.length, 0, "no ack reaction on the fork path");
    assert.equal(result.modelRequests, 0, "no review on the fork path");
  } finally {
    await result.cleanup();
  }
});

test("#914: the fork reply also fires when the command has trailing text", async () => {
  const result = await runCase({ body: "/ai-review now\n(second comment line)", onPr: true, permission: "write", forkHeadRepo: "forker/r" });
  try {
    assert.equal(result.outputs["skip-reason"], "comment-fork-pr");
    const forkReplies = result.replyBodies.filter((b) => b.includes(FORK_REPLY_MARKER));
    assert.equal(forkReplies.length, 1, "the fork reply fires for a command followed by more text");
  } finally {
    await result.cleanup();
  }
});

test("#914: an unrelated comment body is skipped as unrelated-comment, with no reaction and no model call", async () => {
  const result = await runCase({ body: "just thinking", onPr: true, permission: "write" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "unrelated-comment");
    assert.equal(result.reactionCalls.length, 0);
    assert.equal(result.replyBodies.length, 0);
    assert.equal(result.modelRequests, 0, "the model is never called");
  } finally {
    await result.cleanup();
  }
});

test("#914: an empty rereview-command input disables the command (comment-disabled) through actionMain's real config path", async () => {
  // `INPUT_REREVIEW-COMMAND: ""` is the empty-carve-out: loadConfig keeps
  // the explicit empty string (instead of the contract default /ai-review)
  // for rereview-command, so actionMain's stage env — not just a unit-level
  // runPrecheck call — sees the disabled command.
  const result = await runCase({ body: "/ai-review", onPr: true, permission: "write", rereviewCommand: "" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "comment-disabled");
    assert.equal(result.reactionCalls.length, 0);
    assert.equal(result.replyBodies.length, 0);
    assert.equal(result.modelRequests, 0, "the model is never called");
  } finally {
    await result.cleanup();
  }
});
