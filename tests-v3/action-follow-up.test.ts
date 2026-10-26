/** #1294: the conversational follow-up path through the real `actionMain()`
 * entry — a `follow_up` comment routed by the Action host, end to end,
 * against a mocked GitHub API and a mocked model.
 *
 * Asserts the issue's Action-path acceptance:
 * - an authorized question addressed to the bot's proven identity gets a
 *   marker-stamped reply posted through the publish seam (exactly one POST,
 *   body starting with `FOLLOWUP_REPLY_MARKER`), consumes no review, and
 *   exits green with `skip-reason: follow-up-answered`;
 * - an unauthorized commenter, and an unaddressed comment, produce NO model
 *   call, NO marker reply, and fall through to today's precheck skip wording
 *   (`unrelated-comment`) — the behavior-preserved path;
 * - a model failure posts nothing unrendered and skips as
 *   `follow-up-answer-failed` (fail closed, still green).
 * The planner gates themselves are covered in `followup-plan.test.ts`, the
 * host bindings in `followup-action-host.test.ts`. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMain } from "../src/run/action.js";
import { FOLLOWUP_REPLY_MARKER } from "../src/followup/classify.js";
import { startMockServer, type CapturedRequest } from "./helpers.js";

const BOT_LOGIN = "ai-bot[bot]";

function answerBody(content: string): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
}

/** One PR conversation comment as the GraphQL thread query reports it. */
interface ThreadNode {
  databaseId: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string };
}

/** Mock GitHub API: GraphQL viewer identity, the PR conversation thread (the
 * follow-up Q&A budget reads it), the collaborator-permission endpoint (the
 * commenter's permission is configurable), empty review enumerations, and a
 * capturing POST for issue comments. */
function startGithubMock(options: {
  permission: string;
  viewerLogin?: string | null;
  postStatus?: number;
  threadNodes?: ThreadNode[];
}): Promise<{
  url: string;
  postedBodies: string[];
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const postedBodies: string[] = [];
  return startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && url === "/graphql") {
      // The conversation-thread query (the Q&A budget's durable state) and
      // the viewer-identity query are different documents.
      if (body.includes("comments(last: 100)")) {
        res.end(JSON.stringify({
          data: { repository: { pullRequest: { comments: { nodes: options.threadNodes ?? [] } } } },
        }));
        return;
      }
      const viewer = options.viewerLogin === null ? null : { login: options.viewerLogin ?? BOT_LOGIN };
      res.end(JSON.stringify({ data: { viewer } }));
      return;
    }
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: options.permission, role: options.permission }));
      return;
    }
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        let text = "";
        try { text = String((JSON.parse(body) as { body?: unknown }).body ?? ""); } catch { text = ""; }
        postedBodies.push(text);
        if (options.postStatus !== undefined) {
          res.statusCode = options.postStatus;
          res.end(JSON.stringify({ message: "post refused" }));
          return;
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 200 }));
        return;
      }
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
      res.end("[]");
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  }).then((server) => ({ ...server, postedBodies }));
}

function baseEnv(options: {
  eventPath: string;
  runnerTemp: string;
  githubUrl: string;
  modelUrl: string;
}): NodeJS.ProcessEnv {
  // Deliberately NOT `{ ...process.env, ... }` (the #890 CI lesson).
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: options.eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: options.githubUrl,
    GITHUB_WORKSPACE: options.runnerTemp,
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
    "INPUT_REREVIEW-COMMAND": "/ai-review",
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

function commentEvent(body: string): string {
  return JSON.stringify({
    action: "created",
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 42, body, user: { login: "alice" } },
    repository: { full_name: "o/r" },
    sender: { login: "alice" },
    installation: { id: 5 },
  });
}

async function runCase(options: {
  body: string;
  permission?: string;
  viewerLogin?: string | null;
  modelStatus?: number;
  modelContent?: string;
  postStatus?: number;
  threadNodes?: ThreadNode[];
}): Promise<{
  exitCode: number;
  outputs: Record<string, string>;
  postedBodies: string[];
  modelRequests: number;
  summary: string;
  cleanup: () => Promise<void>;
}> {
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-follow-up-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (options.modelStatus !== undefined) {
      res.statusCode = options.modelStatus;
      res.end(JSON.stringify({ message: "model down" }));
      return;
    }
    res.end(answerBody(options.modelContent ?? "Backoff doubles per attempt; see retry.ts."));
  });
  const github = await startGithubMock({
    permission: options.permission ?? "write",
    ...(options.viewerLogin !== undefined ? { viewerLogin: options.viewerLogin } : {}),
    ...(options.postStatus !== undefined ? { postStatus: options.postStatus } : {}),
    ...(options.threadNodes !== undefined ? { threadNodes: options.threadNodes } : {}),
  });
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, commentEvent(options.body));
  const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url });
  const cleanup = async (): Promise<void> => {
    await model.close();
    await github.close();
    rmSync(runnerTemp, { recursive: true, force: true });
  };
  const originalStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const exitCode = await actionMain(env);
    process.stderr.write = originalStderr;
    return {
      exitCode,
      outputs: readOutputs(env.GITHUB_OUTPUT!),
      postedBodies: github.postedBodies,
      modelRequests: model.requests.length,
      summary: readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"),
      cleanup,
    };
  } catch (error) {
    process.stderr.write = originalStderr;
    await cleanup();
    throw error;
  }
}

test("#1294: an authorized @mention question gets a marker-stamped reply, no review", async () => {
  const result = await runCase({ body: `@${BOT_LOGIN} does the retry back off?` });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "follow-up-answered");
    assert.equal(result.outputs["verdict"], "");
    assert.equal(result.modelRequests, 1, "the answer ran through the model path");
    assert.equal(result.postedBodies.length, 1, "exactly one comment POST");
    assert.ok(
      result.postedBodies[0]!.startsWith(FOLLOWUP_REPLY_MARKER),
      "the reply is rendered by the ONE authoritative renderer (loop-guard marker on top)",
    );
    assert.ok(result.postedBodies[0]!.includes("Backoff doubles per attempt"));
    assert.match(result.summary, /follow-up/i, "the step summary names the follow-up path");
  } finally {
    await result.cleanup();
  }
});

test("#1294: an unauthorized commenter gets no reply and no model call (fall-through skip)", async () => {
  const result = await runCase({ body: `@${BOT_LOGIN} does the retry back off?`, permission: "read" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["should-review"], "false");
    assert.equal(result.outputs["skip-reason"], "unrelated-comment", "today's precheck skip wording is behavior-preserved");
    assert.equal(result.modelRequests, 0, "no model work below the authority gate");
    assert.equal(result.postedBodies.length, 0, "no reply write");
  } finally {
    await result.cleanup();
  }
});

test("#1294: an unaddressed comment never reaches the model (no mention, no command)", async () => {
  const result = await runCase({ body: "just thinking out loud here" });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["skip-reason"], "unrelated-comment");
    assert.equal(result.modelRequests, 0);
    assert.equal(result.postedBodies.length, 0);
  } finally {
    await result.cleanup();
  }
});

test("#1294: a model failure posts nothing unrendered and skips green as follow-up-answer-failed", async () => {
  const result = await runCase({ body: `@${BOT_LOGIN} does the retry back off?`, modelStatus: 500 });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["skip-reason"], "follow-up-answer-failed");
    assert.equal(result.postedBodies.length, 0, "an answer-less reply is never posted (fail closed)");
  } finally {
    await result.cleanup();
  }
});

test("#1294: an unproven bot identity means no question fires (fail closed, fall-through skip)", async () => {
  const result = await runCase({ body: `@${BOT_LOGIN} does the retry back off?`, viewerLogin: null });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["skip-reason"], "unrelated-comment");
    assert.equal(result.modelRequests, 0, "nothing can be addressed to an unproven identity");
    assert.equal(result.postedBodies.length, 0);
  } finally {
    await result.cleanup();
  }
});

test("#1294: the Q&A budget survives a delivery — a thread already holding the per-PR budget denies the question", async () => {
  // The Action runs ONE PROCESS PER DELIVERY: the budget state must live in
  // the forge's thread, or every delivery would start with a fresh budget.
  const publishedAt = new Date(Date.now() - 60_000).toISOString();
  const threadNodes: ThreadNode[] = Array.from({ length: 6 }, (_unused, index) => ({
    databaseId: 900 + index,
    body: `${FOLLOWUP_REPLY_MARKER}\n\nan answer from an earlier delivery`,
    createdAt: publishedAt,
    updatedAt: publishedAt,
    author: { login: BOT_LOGIN },
  }));
  const result = await runCase({
    body: `@${BOT_LOGIN} and what about the retry loop?`,
    threadNodes,
  });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.modelRequests, 0, "the exhausted budget stops the model work");
    assert.equal(result.postedBodies.length, 0, "and stops the write");
    assert.equal(result.outputs["should-review"], "false");
  } finally {
    await result.cleanup();
  }
});

test("#1294: a refused comment POST skips green as follow-up-answer-failed (posted: false)", async () => {
  const result = await runCase({ body: `@${BOT_LOGIN} does the retry back off?`, postStatus: 403 });
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs["skip-reason"], "follow-up-answer-failed");
    assert.equal(result.modelRequests, 1, "the model ran; only the write failed");
    assert.equal(result.postedBodies.length, 1, "one attempt, and it was the rendered body");
    assert.ok(result.postedBodies[0]!.startsWith(FOLLOWUP_REPLY_MARKER));
  } finally {
    await result.cleanup();
  }
});
