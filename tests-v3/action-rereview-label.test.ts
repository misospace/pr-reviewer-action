/** #892: the `ai-review` re-review label never forced a fresh review in the
 * v3 Node entry, and the label was left stranded on the PR either way.
 * Root cause (see the issue): `readEvent()` never populated `event.name`
 * (the real payload has no top-level `name` — it lives only in
 * `GITHUB_EVENT_NAME`) and never normalized `event.label` from the real
 * `{ name, color, ... }` object GitHub/Forgejo actually send, so
 * `decide.ts`'s label gate (`event.name === "pull_request" && event.label
 * === rereviewLabel`) could never match, and the early-return skip branch
 * in `action.ts` bypassed the label-cleanup call entirely.
 *
 * This drives the real `actionMain()` entrypoint (no injected adapter)
 * against a mocked GitHub API and a mocked model, with a real
 * `GITHUB_EVENT_PATH` file carrying the actual `labeled` event shape, and
 * asserts both that a fresh review runs and that the label-removal DELETE
 * call is made — including on the skip branch, where a stale label event
 * (event head SHA no longer the PR's current head) makes the run skip as
 * superseded but must still clear the label it was triggered by. The
 * diff-unchanged bypass itself (`forceReview`) is proven precisely at the
 * `runPrecheck` unit level in `tests-v3/precheck.test.ts`, against the
 * exact-fingerprint `rereview-label-forces` parity fixture. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionMain } from "../src/run/action.js";
import { startMockServer } from "./helpers.js";

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

/** A minimal GitHub REST mock sufficient for precheck + review + the label
 * cleanup DELETE call. `priorCommentBody`, when given, is returned as the
 * PR's one prior managed comment — used to simulate a diff-unchanged marker
 * the label must bypass. */
function startGithubMock(options: {
  baseSha: string;
  headSha: string;
  priorCommentBody?: string;
}): Promise<{ url: string; deleteCalls: string[]; close: () => Promise<void> }> {
  const deleteCalls: string[] = [];
  return startMockServer((req, _body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (req.method === "DELETE" && url.startsWith("/repos/o/r/issues/7/labels/")) {
      deleteCalls.push(url);
      res.statusCode = 200;
      res.end("{}");
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
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      res.end(JSON.stringify(options.priorCommentBody === undefined ? [] : [
        { id: 1, body: options.priorCommentBody, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z" },
      ]));
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
  }).then((server) => ({ ...server, deleteCalls }));
}

function baseEnv(options: {
  eventPath: string;
  runnerTemp: string;
  githubUrl: string;
  modelUrl: string;
  workspace: string;
  eventName?: string;
}): NodeJS.ProcessEnv {
  // Deliberately NOT `{ ...process.env, ... }` (the #890 CI lesson: this
  // repo's own CI runs these tests inside a real GitHub Actions job, so
  // spreading process.env would leak THIS repo's own PR event/SHAs into
  // actionMain instead of the mocked #7 fixture). Every GITHUB_*/runner
  // field actionMain or its precheck path consults is set explicitly here,
  // from a minimal PATH/HOME base.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: options.eventName ?? "pull_request",
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
    PR_NUMBER: "7",
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": options.modelUrl,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_PUBLISH-MODE": "comment",
    "INPUT_PUBLISH-REVIEW-COMMENT": "true",
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

/** Swallows and records stderr while an expected skip log line is asserted
 * (same pattern as transport.test.ts). */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: (): void => { process.stderr.write = original; } };
}

test("#892: the ai-review label (real object shape) forces a fresh review and clears the label on the review branch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-rereview-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-rereview-runner-temp-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);

    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    // The real `labeled` payload shape: label is an OBJECT, and there is no
    // top-level `name` (GITHUB_EVENT_NAME carries it).
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 9, name: "ai-review", color: "00ff00" },
      pull_request: { number: 7, head: { sha: headSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace });
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "true");
    assert.equal(outputs["skip-reason"], "");

    assert.equal(github.deleteCalls.length, 1, "the label is cleared exactly once, by the event-gated cleanup");
    for (const call of github.deleteCalls) assert.match(call, /\/repos\/o\/r\/issues\/7\/labels\/ai-review$/);
  } finally {
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#892: a stale ai-review label event (event head SHA no longer current) still skips, but the label is still cleared", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-rereview-workspace-stale-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-rereview-runner-temp-stale-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    // The label event's recorded head SHA does not match the PR's real
    // current head below — a stale label-triggered run superseded by a
    // later push. This must still skip (superseded-head), but the early
    // return in action.ts must not strand the label.
    const staleEventHeadSha = "c".repeat(40);

    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 9, name: "ai-review", color: "00ff00" },
      pull_request: { number: 7, head: { sha: staleEventHeadSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace });
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "false");
    assert.equal(outputs["skip-reason"], "superseded-head");

    assert.equal(github.deleteCalls.length, 1, "the label must be cleared even though the run skipped on the early-return branch");
    assert.match(github.deleteCalls[0]!, /\/repos\/o\/r\/issues\/7\/labels\/ai-review$/);
  } finally {
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#892: an unrelated label never forces a review and never clears the ai-review label", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-rereview-workspace-unrelated-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-rereview-runner-temp-unrelated-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 2, name: "bug", color: "ff0000" },
      pull_request: { number: 7, head: { sha: headSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace });
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "false");
    assert.equal(outputs["skip-reason"], "unrelated-label");
    assert.equal(github.deleteCalls.length, 0, "an unrelated label must never be cleared");
  } finally {
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#903: an unrelated-label skip logs its reason and label and writes a one-line step summary", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-skip-observability-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-skip-observability-runner-temp-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  const stderr = captureStderr();
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 2, name: "bug", color: "ff0000" },
      pull_request: { number: 7, head: { sha: headSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace });
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    // The skip is announced in the same log stream the review path uses.
    assert.ok(
      stderr.lines.includes(`[v3] Review skipped: unrelated-label (label: "bug")\n`),
      `expected the skip log line, got: ${JSON.stringify(stderr.lines)}`,
    );
    // ...and lands as exactly one line in the step summary, so a skipped
    // run is distinguishable from a crash in the job summary. The label is
    // a fence-safe code span there, not the JSON form.
    assert.equal(
      readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"),
      `**AI PR Review skipped:** \`unrelated-label\` (label: \`bug\`)\n`,
    );
  } finally {
    stderr.restore();
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#903: a hostile label with boundary/interior backticks and Markdown link syntax renders inert in both surfaces", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-skip-observability-workspace-hostile-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-skip-observability-runner-temp-hostile-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  const stderr = captureStderr();
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    // A label name is untrusted payload: an interior backtick run would
    // break a naive single-backtick span, a boundary backtick merges into a
    // generated delimiter (a leading backtick plus the fence forms a longer
    // opening run, leaving the span unterminated), and the link syntax
    // would render a live Markdown link if the label were only JSON-quoted.
    const hostileLabel = "`x` [click](https://example.invalid)`";
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 4, name: hostileLabel, color: "ff0000" },
      pull_request: { number: 7, head: { sha: headSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace });
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    // stderr: JSON quoting is the control-character fence (backticks are
    // inert in a log stream, so they stay literal inside the JSON quotes).
    assert.ok(
      stderr.lines.includes('[v3] Review skipped: unrelated-label (label: "`x` [click](https://example.invalid)`")\n'),
      `expected the skip log line, got: ${JSON.stringify(stderr.lines)}`,
    );
    // Summary: fence-safe inline code — the delimiter grows one past the
    // label's longest backtick run AND is padded on both sides, so neither
    // the leading nor the trailing boundary backtick can merge into it and
    // the link syntax renders as literal text.
    assert.equal(
      readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"),
      "**AI PR Review skipped:** `unrelated-label` (label: `` `x` [click](https://example.invalid)` ``)\n",
    );
  } finally {
    stderr.restore();
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#903: a superseded-head skip logs no label detail and tolerates a missing step summary", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-skip-observability-workspace-stale-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-skip-observability-runner-temp-stale-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  const stderr = captureStderr();
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    // Stale label event (as in the #892 superseded test): the event carries
    // a label, but the skip reason is not unrelated-label, so no label
    // detail may appear in the skip line.
    const staleEventHeadSha = "c".repeat(40);
    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 9, name: "ai-review", color: "00ff00" },
      pull_request: { number: 7, head: { sha: staleEventHeadSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace });
    // No runner summary file: the skip must still complete cleanly.
    delete env.GITHUB_STEP_SUMMARY;
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["skip-reason"], "superseded-head");
    assert.ok(
      stderr.lines.includes("[v3] Review skipped: superseded-head\n"),
      `expected the skip log line, got: ${JSON.stringify(stderr.lines)}`,
    );
  } finally {
    stderr.restore();
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#892: the fork workflow's pull_request_target ai-review-fork label reviews and keeps the authorization label", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "action-rereview-workspace-fork-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "action-rereview-runner-temp-fork-"));
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  let github: Awaited<ReturnType<typeof startGithubMock>> | undefined;
  try {
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    github = await startGithubMock({ baseSha, headSha });

    const eventPath = join(runnerTemp, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 3, name: "ai-review-fork", color: "0000ff" },
      pull_request: { number: 7, head: { sha: headSha } },
    }));

    const env = baseEnv({ eventPath, runnerTemp, githubUrl: github.url, modelUrl: model.url, workspace, eventName: "pull_request_target" });
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);

    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["should-review"], "true");
    assert.equal(outputs["skip-reason"], "");
    // ai-review-fork authorizes every later push (docs/fork-review.md); the
    // reviewer must never strip it, and a non-label-triggered publish must
    // not DELETE the rereview label either.
    assert.equal(github.deleteCalls.length, 0, "no label may be removed on the fork path");
  } finally {
    await model.close();
    await github?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
