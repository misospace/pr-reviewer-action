import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolvePartialCoverage, runReview } from "../src/run/review.js";
import { authoritativeBodyRevision, harnessTransportAdapter, type PrBodyRevision } from "../src/run/stages.js";
import type { StageEnv } from "../src/run/env.js";
import { forkGate } from "../src/gates/gates.js";
import { startMockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { publishReview } from "../src/publish/publish.js";
import type { NativeReviewRequest, PublishCommentRef, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";

/** A minimal in-memory platform adapter: the reads a small PR needs, served
 * without network. Everything else must not be reached by the pipeline with
 * the feature flags the tests set. */
function mockPlatform(options: { diff?: string; files?: unknown[]; title?: string; body?: string; additions?: number; deletions?: number } = {}): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => {
      return Promise.resolve({
        number: 7,
        title: options.title ?? "Update README",
        body: options.body ?? "",
        head: { sha: "a".repeat(40), ref: "feature" },
        base: { ref: "main" },
        user: { login: "someone" },
        changed_files: options.files?.length ?? 1,
        additions: options.additions ?? 4,
        deletions: options.deletions ?? 1,
        html_url: "https://github.com/o/r/pull/7",
      });
    },
    getPrDiff: () => {
      return Promise.resolve(options.diff ?? `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n`);
    },
    listPrFiles: () => {
      return Promise.resolve({ ok: true, data: options.files ?? [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] });
    },
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

function verdictBody(verdict: Record<string, unknown>): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(verdict) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

function baseVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "approve",
    review_markdown: "Looks fine.\n",
    smart_review_requested: false,
    smart_review_reason: null,
    findings: [],
    requirement_coverage: null,
    required_check_dispositions: [],
    ...overrides,
  };
}

interface RunFixture {
  runDir: string;
  cleanup: () => void;
}

function withRunDir(): RunFixture {
  const runDir = mkdtempSync(join(tmpdir(), "v3-run-test-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}

test("runs the full review end to end: artifacts, outputs, marker", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const outputFile = join(runDir, "gh-output.txt");
    const stepSummaryFile = join(runDir, "step-summary.md");
    const result = await runReview({
      env: { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: stepSummaryFile },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    // Verdict surfaced through the typed outputs.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewRoute, "legacy");
    assert.equal(result.outputs.analysisEngine, "m@http://127.0.0.1:" + new URL(server.url).port + " (openai)");
    assert.match(result.outputs.analysisEngine, /^m@http/);
    // #832: the step summary (public on the Actions run page) omits the base
    // URL; the action output above keeps the full engine string for logs.
    const stepSummary = readFileSync(stepSummaryFile, "utf8");
    assert.match(stepSummary, /\| Engine \| m \(openai\) \|/);
    // Key artifacts persisted with the v2 names.
    for (const name of ["ai-output.json", "ai-request.primary.json", "ai-response.primary.json", "classification.json", "pr.json", "pr.diff", "pr.diff.truncated", "pr-files.json", "review-corpus.md", "review-corpus.truncated.md", "review-body.md", "verdict.txt"]) {
      assert.ok(existsSync(join(runDir, name)), `missing artifact ${name}`);
    }
    // The corpus embeds the diff and the classification.
    const corpus = readFileSync(join(runDir, "review-corpus.truncated.md"), "utf8");
    assert.match(corpus, /# PR Diff \(truncated\)/);
    assert.match(corpus, /# PR Classification/);
    assert.match(corpus, /# Repository Standards/);
    // GITHUB_OUTPUT got the kebab-case contract assignments.
    const output = readFileSync(outputFile, "utf8");
    assert.match(output, /verdict=approve/);
    assert.match(output, /review-route=legacy/);
    assert.match(output, /verdict-source=model/);
    assert.match(output, /cache-hit-ratio=/);
    assert.match(output, /tool-calls=\[\]/);
    // Metadata marker bound to the head.
    assert.match(result.marker, /head_sha.{0,4}a{40}/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#838: with no runDir/PR_REVIEWER_RUN_DIR, run never treats the checkout (cwd) as its own artifacts", async () => {
  // Simulates the exact vulnerability: `node dist/index.js run` invoked with
  // its cwd inside the reviewed checkout (the eval harness ran this way, and
  // any developer cd'd into a checkout would too), and neither an explicit
  // runDir nor PR_REVIEWER_RUN_DIR set — the only two seams that used to keep
  // the default run dir off of process.cwd(). A PR that committed pr.diff /
  // pr-files.seed.json at its repo root must never have those reused as
  // this run's own artifacts.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const checkout = mkdtempSync(join(tmpdir(), "v3-run-test-checkout-"));
  const originalCwd = process.cwd();
  try {
    writeFileSync(
      join(checkout, "pr.diff"),
      "diff --git a/FORGED.md b/FORGED.md\n--- a/FORGED.md\n+++ b/FORGED.md\n@@ -1 +1 @@\n-x\n+y\n",
    );
    writeFileSync(
      join(checkout, "pr-files.seed.json"),
      JSON.stringify([{ filename: "FORGED.md", status: "modified", additions: 1, deletions: 1, changes: 2 }]),
    );
    process.chdir(checkout);
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
      },
      // No runDir, no PR_REVIEWER_RUN_DIR in env, no workspace override: the
      // exact default-resolution path the vulnerability lived in.
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    // The diff came from the platform adapter (the mock's README.md diff),
    // never the checkout's forged pr.diff.
    const diffArtifact = Buffer.from(result.artifacts.get("pr.diff") ?? new Uint8Array(0)).toString("utf8");
    assert.match(diffArtifact, /README\.md/);
    assert.doesNotMatch(diffArtifact, /FORGED\.md/);
    // The file list came from the platform adapter, never the forged seed.
    const filesArtifact = Buffer.from(result.artifacts.get("pr-files.json") ?? new Uint8Array(0)).toString("utf8");
    assert.match(filesArtifact, /README\.md/);
    assert.doesNotMatch(filesArtifact, /FORGED\.md/);
    // Nothing was written into the checkout: the default run dir is a fresh
    // directory elsewhere, not cwd.
    assert.equal(existsSync(join(checkout, "ai-output.json")), false);
  } finally {
    process.chdir(originalCwd);
    await server.close();
    rmSync(checkout, { recursive: true, force: true });
  }
});

/** Blocker follow-up (maintainer review on #838): `PR_REVIEWER_RUN_DIR` set
 * to an empty or whitespace-only string must normalize to absent, not
 * survive `??` and resolve (via Node's `path` APIs) to the process cwd —
 * silently reopening the exact checkout-as-run-dir hole the run-dir default
 * was fixed to close. Runs the identical adversarial setup as the test
 * above (forged pr.diff/pr-files.seed.json sitting in cwd) with an explicit
 * but blank `PR_REVIEWER_RUN_DIR`, and asserts the platform diff/files still
 * win and cwd is still never read from or written to. */
async function assertBlankRunDirEnvDoesNotBypassTheFix(runDirEnvValue: string): Promise<void> {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const checkout = mkdtempSync(join(tmpdir(), "v3-run-test-checkout-"));
  const originalCwd = process.cwd();
  try {
    writeFileSync(
      join(checkout, "pr.diff"),
      "diff --git a/FORGED.md b/FORGED.md\n--- a/FORGED.md\n+++ b/FORGED.md\n@@ -1 +1 @@\n-x\n+y\n",
    );
    writeFileSync(
      join(checkout, "pr-files.seed.json"),
      JSON.stringify([{ filename: "FORGED.md", status: "modified", additions: 1, deletions: 1, changes: 2 }]),
    );
    process.chdir(checkout);
    const result = await runReview({
      env: { PR_REVIEWER_RUN_DIR: runDirEnvValue },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
      },
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    const diffArtifact = Buffer.from(result.artifacts.get("pr.diff") ?? new Uint8Array(0)).toString("utf8");
    assert.match(diffArtifact, /README\.md/);
    assert.doesNotMatch(diffArtifact, /FORGED\.md/);
    const filesArtifact = Buffer.from(result.artifacts.get("pr-files.json") ?? new Uint8Array(0)).toString("utf8");
    assert.match(filesArtifact, /README\.md/);
    assert.doesNotMatch(filesArtifact, /FORGED\.md/);
    assert.equal(existsSync(join(checkout, "ai-output.json")), false);
    // The blank env value never resolves to the checkout: a fresh directory
    // was created elsewhere instead.
    assert.notEqual(result.runDir, checkout);
    assert.ok(existsSync(result.runDir));
  } finally {
    process.chdir(originalCwd);
    await server.close();
    rmSync(checkout, { recursive: true, force: true });
  }
}

test("#838 follow-up: PR_REVIEWER_RUN_DIR=\"\" does not bypass the checkout-trust fix", async () => {
  await assertBlankRunDirEnvDoesNotBypassTheFix("");
});

test("#838 follow-up: a whitespace-only PR_REVIEWER_RUN_DIR does not bypass the checkout-trust fix", async () => {
  await assertBlankRunDirEnvDoesNotBypassTheFix("   \t  ");
});

test("#838 follow-up: the resolved run dir is logged, returned, and written to GITHUB_OUTPUT", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const workDir = mkdtempSync(join(tmpdir(), "v3-run-test-workdir-"));
  try {
    const outputFile = join(workDir, "gh-output.txt");
    const logLines: string[] = [];
    const result = await runReview({
      env: { GITHUB_OUTPUT: outputFile },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
      },
      workspace: workDir,
      platformAdapter: mockPlatform(),
      log: (line) => logLines.push(line),
    });
    // No explicit runDir/PR_REVIEWER_RUN_DIR: the default created a fresh,
    // real directory distinct from the workspace, and returned it.
    assert.ok(result.runDir);
    assert.notEqual(result.runDir, workDir);
    assert.ok(existsSync(result.runDir));
    // Logged once, so a caller with no other way to discover the anonymous
    // default can find it.
    assert.ok(logLines.includes(`run artifacts: ${result.runDir}`));
    // Written to GITHUB_OUTPUT as `run-dir`, for a caller chaining steps —
    // first, ahead of the review's own step outputs appended later.
    const output = readFileSync(outputFile, "utf8");
    assert.ok(output.startsWith(`run-dir=${result.runDir}\n`));
  } finally {
    await server.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("primary failure with a configured fallback publishes the fallback review", async () => {
  let dead = true;
  const deadServer = await startMockServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end('{"error":"down"}');
  });
  const fallbackServer = await startMockServer((_req, _body, res) => {
    dead = !dead;
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({ review_markdown: "Fallback review.\n" })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    void dead;
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": deadServer.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ai-fallback-model": "fb",
        "ai-fallback-base-url": fallbackServer.url,
        "ai-primary-retries": "1",
        "ai-primary-retry-delay-sec": "0",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    assert.match(result.outputs.analysisEngine, /— fallback \(primary failed\)/);
    assert.ok(existsSync(join(runDir, "ai-response.fallback.json")));
    assert.ok(existsSync(join(runDir, "review-corpus.fallback.truncated.md")));
  } finally {
    await deadServer.close();
    await fallbackServer.close();
    cleanup();
  }
});

for (const withFallback of [false, true]) {
  test(`#863: on-model-failure=notice publishes the notice when every model route fails (fallback configured: ${withFallback})`, async () => {
    const deadServer = await startMockServer((_req, _body, res) => {
      res.statusCode = 500;
      res.end('{"error":"down"}');
    });
    const { runDir, cleanup } = withRunDir();
    try {
      const result = await runReview({
        env: {},
        inputs: {
          "github-token": "tok",
          repo: "o/r",
          "pr-number": "7",
          "ai-base-url": deadServer.url,
          "ai-model": "m",
          "ai-stream": "false",
          "ai-api-key": "k",
          "ai-primary-retries": "0",
          "ai-primary-retry-delay-sec": "0",
          "on-model-failure": "notice",
          ...(withFallback ? { "ai-fallback-model": "fb", "ai-fallback-base-url": deadServer.url } : {}),
        },
        runDir,
        workspace: runDir,
        platformAdapter: mockPlatform(),
        quiet: true,
      });
      assert.equal(result.outputs.verdict, "request_changes");
      const artifact = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as { verdict: string; review_markdown: string };
      assert.equal(artifact.verdict, "request_changes");
      assert.match(artifact.review_markdown, /automated notice, not a substantive review/);
    } finally {
      await deadServer.close();
      cleanup();
    }
  });
}

test("#867: a non-2xx primary reply (ai-primary-retries: 0) is a transport failure, never a parse failure", async () => {
  let calls = 0;
  const server = await startMockServer((_req, _body, res) => {
    calls += 1;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "down" }));
  });
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  try {
    // ai-primary-retries: 0 used to skip the call entirely (`retries` is a
    // total-attempt budget: `attempt <= retries`), falling through to the
    // loop's synthetic default and misreporting the outage as
    // "parse/validate failures exhausted" instead of ever touching the dead
    // endpoint. #867: retries always allows at least one real attempt.
    await assert.rejects(() => runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ai-primary-retries": "0",
        "ai-primary-retry-delay-sec": "0",
        "on-model-failure": "fail",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      error: (line) => errors.push(line),
      quiet: true,
    }));
    assert.ok(calls >= 1, "expected the primary to actually call the dead endpoint instead of skipping it");
    const failureLine = errors.find((line) => line.includes("Primary") && line.includes("transport failures exhausted"));
    assert.ok(failureLine, `expected a primary transport-exhausted line, got: ${JSON.stringify(errors)}`);
    assert.match(failureLine!, /HTTP 500/);
    assert.ok(
      !errors.some((line) => line.includes("parse/validate failures exhausted")),
      `the parse-retry path must not be taken for a non-2xx reply, got: ${JSON.stringify(errors)}`,
    );
  } finally {
    await server.close();
    cleanup();
  }
});

test("#867: a streamed non-2xx primary reply is also a transport failure, never a parse failure", async () => {
  let calls = 0;
  const server = await startMockServer((_req, _body, res) => {
    calls += 1;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "down" }));
  });
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  try {
    await assert.rejects(() => runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "true",
        "ai-api-key": "k",
        "ai-primary-retries": "0",
        "ai-primary-retry-delay-sec": "0",
        "on-model-failure": "fail",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      error: (line) => errors.push(line),
      quiet: true,
    }));
    assert.ok(calls >= 1, "expected the primary to actually call the dead endpoint instead of skipping it");
    const failureLine = errors.find((line) => line.includes("Primary") && line.includes("transport failures exhausted"));
    assert.ok(failureLine, `expected a primary transport-exhausted line, got: ${JSON.stringify(errors)}`);
    assert.match(failureLine!, /HTTP 500/);
    assert.ok(
      !errors.some((line) => line.includes("parse/validate failures exhausted")),
      `the parse-retry path must not be taken for a non-2xx reply, got: ${JSON.stringify(errors)}`,
    );
  } finally {
    await server.close();
    cleanup();
  }
});

test("#867: primary and fallback both classify a non-2xx reply as transport, and on-model-failure=notice still publishes", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const primaryServer = await startMockServer((_req, _body, res) => {
    primaryCalls += 1;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "down" }));
  });
  const fallbackServer = await startMockServer((_req, _body, res) => {
    fallbackCalls += 1;
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "down" }));
  });
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": primaryServer.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ai-primary-retries": "0",
        "ai-primary-retry-delay-sec": "0",
        "ai-fallback-model": "fb",
        "ai-fallback-base-url": fallbackServer.url,
        "on-model-failure": "notice",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      error: (line) => errors.push(line),
      quiet: true,
    });
    assert.ok(primaryCalls >= 1, "expected the primary to actually call its dead endpoint");
    assert.ok(fallbackCalls >= 1, "expected the fallback to actually call its dead endpoint");
    const primaryLine = errors.find((line) => line.includes("Primary") && line.includes("transport failures exhausted"));
    const fallbackLine = errors.find((line) => line.includes("Fallback") && line.includes("transport failures exhausted"));
    assert.ok(primaryLine, `expected a primary transport-exhausted line, got: ${JSON.stringify(errors)}`);
    assert.ok(fallbackLine, `expected a fallback transport-exhausted line, got: ${JSON.stringify(errors)}`);
    assert.match(primaryLine!, /HTTP 500/);
    assert.match(fallbackLine!, /HTTP 500/);
    assert.ok(
      !errors.some((line) => line.includes("parse/validate failures exhausted")),
      `the parse-retry path must not be taken on either route, got: ${JSON.stringify(errors)}`,
    );
    assert.equal(result.outputs.verdict, "request_changes");
    const artifact = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as { verdict: string; review_markdown: string };
    assert.equal(artifact.verdict, "request_changes");
    assert.match(artifact.review_markdown, /automated notice, not a substantive review/);
  } finally {
    await primaryServer.close();
    await fallbackServer.close();
    cleanup();
  }
});

test("reviewer-requested escalation publishes the smart review", async () => {
  let call = 0;
  const server = await startMockServer((_req, body, res) => {
    call += 1;
    const model = (JSON.parse(body) as { model: string }).model;
    res.setHeader("Content-Type", "application/json");
    if (model === "primary-m") {
      res.end(verdictBody(baseVerdict({
        smart_review_requested: true,
        smart_review_reason: "tool coverage gap",
      })));
    } else {
      res.end(verdictBody(baseVerdict({ review_markdown: "Escalated review.\n" })));
    }
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "primary-m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "review-routing-mode": "auto",
        "ai-smart-model": "smart-m",
        "ai-smart-base-url": server.url,
        "ai-smart-api-key": "k",
        "ai-primary-retries": "1",
        "ai-primary-retry-delay-sec": "0",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewRoute, "escalated");
    assert.equal(result.outputs.escalationReason, "primary_requested");
    assert.match(result.outputs.analysisEngine, /— escalated \(primary_requested\)/);
    assert.match(result.outputs.reviewMarkdown, /Escalated review\./);
    // The published verdict can no longer request another escalation.
    const published = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as Record<string, unknown>;
    assert.equal(published.smart_review_requested, false);
    assert.ok(call >= 2, "expected at least a primary and a smart call");
  } finally {
    await server.close();
    cleanup();
  }
});

test("fork PR without overrides writes the gated skip artifacts and still reviews", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { IS_FORK_PR: "true" },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "tool-mode": "native_loop",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(harness.skip_reason, "fork-pr");
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence-providers.json"), "utf8")) as Record<string, unknown>;
    assert.equal(evidence.configured, false);
  } finally {
    await server.close();
    cleanup();
  }
});

test("forkGate joins in-process workloads fail-soft and marks failures", async () => {
  const okGate = await forkGate("specialists", {
    file: "",
    envAllowlist: [],
    workload: async () => 0,
  });
  const ok = await okGate.join();
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);

  const failingGate = await forkGate("specialists", {
    file: "",
    envAllowlist: [],
    workload: async () => {
      throw new Error("model endpoint unreachable");
    },
  });
  const failed = await failingGate.join();
  assert.equal(failed.ok, false);
  assert.equal(failed.gate, "specialists");
  assert.match(failed.error ?? "", /model endpoint unreachable/);

  const codeGate = await forkGate("specialists", {
    file: "",
    envAllowlist: [],
    workload: async () => 3,
  });
  const code = await codeGate.join();
  assert.equal(code.ok, false);
  assert.equal(code.exitCode, 3);
});

test("missing required inputs fail closed with the v2 message", async () => {
  const { runDir, cleanup } = withRunDir();
  try {
    await assert.rejects(
      runReview({ env: {}, inputs: { "github-token": "", repo: "", "pr-number": "", "ai-base-url": "", "ai-model": "" }, runDir, quiet: true }),
      (error: unknown) => error instanceof Error && /Required input/.test(error.message),
    );
  } finally {
    cleanup();
  }
});

test("contract inputs resolve from the literal kebab INPUT_ names the runner exports", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    // Only the literal hyphenated form is set — the underscore fallback and
    // the SCREAMING_SNAKE v2 names are absent.
    const result = await runReview({
      env: {
        "INPUT_GITHUB-TOKEN": "tok",
        "INPUT_AI-BASE-URL": server.url,
        "INPUT_AI-MODEL": "m",
        "INPUT_AI-STREAM": "false",
        "INPUT_AI-API-KEY": "k",
        "INPUT_PR-NUMBER": "7",
        "INPUT_REPO": "o/r",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.reviewArtifact.verdict, "approve");
  } finally {
    await server.close();
    cleanup();
  }
});

test("github-token resolves from the shared GH_TOKEN binding when no INPUT_ form is exported", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: {
        GH_TOKEN: "shared-token",
        REPO: "o/r",
        PR_NUMBER: "7",
        "INPUT_AI-BASE-URL": server.url,
        "INPUT_AI-MODEL": "m",
        "INPUT_AI-STREAM": "false",
        "INPUT_AI-API-KEY": "k",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
  } finally {
    await server.close();
    cleanup();
  }
});

test("embedded specialist prompts equal the committed fragment files", async () => {
  // Guards the #809 switch from disk reads to the build-time asset map.
  const { loadSpecialistPrompt } = await import("../src/specialists/prompts.js");
  for (const role of ["correctness", "security", "tests"]) {
    const disk = readFileSync(join(process.cwd(), "scripts", "prompt_fragments", `specialist_${role}.txt`), "utf8");
    assert.equal(loadSpecialistPrompt(role), disk);
  }
  assert.equal(loadSpecialistPrompt("correctness", "adversarial"), readFileSync(join(process.cwd(), "scripts", "prompt_fragments", "specialist_correctness_adversarial.txt"), "utf8"));
});

test("the run entry never writes to a repo checkout other than the run dir", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  const workspace = mkdtempSync(join(tmpdir(), "v3-run-ws-"));
  writeFileSync(join(workspace, "README.md"), "hello\n");
  try {
    await runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
      },
      runDir,
      workspace,
      platformAdapter: mockPlatform(),
      quiet: true,
    });
    const entries = [...require("node:fs").readdirSync(workspace)] as string[];
    assert.deepEqual(entries, ["README.md"], `checkout polluted: ${entries.join(", ")}`);
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
    cleanup();
  }
});

/** Drives a scripted model verdict through the full run and returns the
 * published outputs plus the marker (#809 review: the enforcement stage). */
async function runWithVerdict(verdict: Record<string, unknown>, inputs: Record<string, string> = {}): Promise<Awaited<ReturnType<typeof runReview>>> {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict(verdict)));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    return await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        ...inputs,
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: false,
      quiet: true,
    });
  } finally {
    await server.close();
    cleanup();
  }
}

const finding = (severity: string): Record<string, unknown> => ({
  severity, category: "bug", title: `${severity} finding`, detail: "d", file: "README.md", line: 2,
});

test("strict (default) policy: minor/info-only findings cannot request changes", async () => {
  const result = await runWithVerdict({ verdict: "request_changes", findings: [finding("minor"), finding("info")] });
  assert.equal(result.outputs.verdict, "approve");
  assert.equal(result.outputs.verdictSource, "findings");
  assert.match(result.outputs.reviewMarkdown, /no blocker or major finding out of 2 open/);
  assert.match(result.marker, /review_result.{0,4}findings/);
});

test("strict (default) policy: a major finding requests changes over a model approve", async () => {
  const result = await runWithVerdict({ verdict: "approve", findings: [finding("major")] });
  assert.equal(result.outputs.verdict, "request_changes");
  assert.equal(result.outputs.verdictSource, "findings");
  assert.match(result.marker, /review_result.{0,4}issues/);
});

test("strict (default) policy: no findings and a model approve publishes clean", async () => {
  const result = await runWithVerdict({ verdict: "approve", findings: [] });
  assert.equal(result.outputs.verdict, "approve");
  assert.equal(result.outputs.verdictSource, "model");
  assert.match(result.marker, /review_result.{0,4}clean/);
});

test("findings_severity_gated policy: a blocker escalates a model approve", async () => {
  const result = await runWithVerdict(
    { verdict: "approve", findings: [finding("blocker")] },
    { "verdict-policy": "findings_severity_gated" },
  );
  assert.equal(result.outputs.verdict, "request_changes");
  assert.equal(result.outputs.verdictSource, "findings");
  assert.match(result.outputs.reviewMarkdown, /Verdict escalated from structured findings/);
});

test("model policy: the model verdict passes through minor findings", async () => {
  const result = await runWithVerdict(
    { verdict: "request_changes", findings: [finding("minor")] },
    { "verdict-policy": "model" },
  );
  assert.equal(result.outputs.verdict, "request_changes");
  assert.equal(result.outputs.verdictSource, "model");
  assert.match(result.marker, /review_result.{0,4}issues/);
});

test("findings_severity_gated policy: CSV non-blocking categories are split, not matched as characters", async () => {
  const result = await runWithVerdict(
    { verdict: "request_changes", findings: [{ ...finding("major"), category: "tests" }] },
    { "verdict-policy": "findings_severity_gated", "non-blocking-finding-categories": "docs, tests,style" },
  );
  assert.equal(result.outputs.verdict, "approve");
  assert.equal(result.outputs.verdictSource, "findings");
  assert.match(result.outputs.reviewMarkdown, /Verdict relaxed from structured findings/);
});

/** A minimal review_verdict-mode publish API: only what submitNativeReview
 * and the publication-boundary head re-check touch. */
class MinimalPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  submitted: NativeReviewRequest[] = [];
  constructor(private readonly head: string) {}
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(): Promise<{ ok: boolean; created: boolean }> { return { ok: true, created: true }; }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean }> { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    return { ok: true, threads: [], hasNextPage: false };
  }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
}

test("#873: required-check coverage incomplete + a model approve never publishes APPROVE (PR #854 regression)", async () => {
  // src/auth.ts deterministically classifies as an auth change (#750/#680
  // classification), which mandates must_check items; the model — exactly
  // like PR #854's published marker (review_result: partial, required_
  // checks: incomplete) — emits no required_check_dispositions at all, so
  // coverage stays conservatively unresolved (#750 key-absence semantics).
  const platform = mockPlatform({
    files: [{ filename: "src/auth.ts", status: "modified", additions: 4, deletions: 1, changes: 5 }],
    diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n old\n+new line\n",
  });
  const result = await runWithVerdictOn(platform, { verdict: "approve", findings: [] });

  // The reproduction: exactly PR #854's shape.
  assert.equal(result.outputs.verdict, "approve");
  assert.equal(result.outputs.requiredChecks, "incomplete");
  assert.match(result.marker, /"review_result":"partial"/);
  assert.match(result.marker, /"required_checks":"incomplete"/);

  // The invariant: piping that exact shape through publish (review_verdict
  // mode, allow_approve on) must never yield a native APPROVE event.
  const api = new MinimalPublishApi("a".repeat(40));
  const publishResult = await publishReview({
    mode: "review_verdict",
    reviewMarkdown: result.outputs.reviewMarkdown,
    verdict: result.outputs.verdict,
    verdictPolicy: result.verdictPolicy,
    analysisEngine: result.outputs.analysisEngine,
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    prNumber: "7",
    commentMarker: "<!-- ai-pr-review -->",
    requiredChecks: result.outputs.requiredChecks,
    reviewRoute: result.outputs.reviewRoute,
    escalationReason: result.outputs.escalationReason,
    cacheHitRatio: result.outputs.cacheHitRatio,
    inlineFindings: false,
    inlineFindingsMax: 5,
    findings: JSON.parse(result.outputs.findings),
    cleanupPreviousNativeReviews: "false",
    allowApprove: true,
    approveForks: false,
    isForkPr: false,
    upstreamLinkMode: "inert",
    conditionalPresence: {
      linkedIssue: false, evidenceProvider: false, standards: false,
      toolHarnessFindings: false, toolHarnessResults: false,
    },
    forgejoPositions: false,
  }, api, { diffText: "" });

  assert.equal(publishResult.status, "published");
  assert.equal(api.submitted.length, 1);
  assert.notEqual(api.submitted[0]!.event, "APPROVE");
  assert.equal(api.submitted[0]!.event, "COMMENT");
  assert.match(api.submitted[0]!.body, /Approval withheld/);
});

/** The native loop only reads tracked files: make the run dir a checkout. */
function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: dir });
}

test("#810: a budget-exhausted tool loop publishes partial coverage in the run marker", async () => {
  let calls = 0;
  const server = await startMockServer((_req, _body, res) => {
    calls += 1;
    res.setHeader("Content-Type", "application/json");
    if (calls === 1) {
      // One read of a file the PR did not change, then the budget (1) is spent.
      res.end(JSON.stringify({
        id: "c0", object: "chat.completion", model: "m",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"OTHER.md"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      return;
    }
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "hello\nworld\n");
    writeFileSync(join(runDir, "OTHER.md"), "unrelated\n");
    gitInit(runDir);
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "tool-mode": "native_loop",
        "tool-max-requests": "1",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(harness.stop_reason, "tool-call-budget-exhausted");
    assert.deepEqual((harness.partial_coverage as { unread_files: string[] }).unread_files, ["README.md"]);
    // The strict default reports the gap instead of a plain clean approve.
    assert.equal(result.outputs.verdict, "approve");
    assert.match(result.marker, /review_result.{0,4}partial/);
    assert.match(result.marker, /coverage.{0,4}partial/);
    assert.match(result.marker, /coverage_stop_reason.{0,4}tool-call-budget-exhausted/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#810: a large PR gets a size-scaled tool budget through the run entry", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "hello\nworld\n");
    gitInit(runDir);
    // 54 files, +4346/-181: the #806 shape.
    const files = Array.from({ length: 54 }, (_, i) => ({
      filename: `src/f${i}.ts`, status: "modified", additions: i === 0 ? 4346 - 53 * 80 : 80, deletions: i === 0 ? 181 - 53 * 3 : 3, changes: 0,
    }));
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "tool-mode": "native_loop",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform({ files, additions: 4346, deletions: 181 }),
      persistArtifacts: true,
      quiet: true,
    });
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(harness.tool_budget_size, { changed_files: 54, changed_lines: 4527, specialist_leads: 0 });
    // ceil(54/4) + ceil(4527/400) = 14 + 12 = 26, above the primary floor of 16.
    assert.equal(harness.tool_request_budget, 26);
    assert.equal(harness.tool_budget_source, "size-scaled");
    // #847: the same provenance reaches the published metadata marker, so the
    // size-scaled default is measurable from real reviews without artifacts.
    assert.match(result.marker, /"tool_budget":26/);
    assert.match(result.marker, /"tool_budget_source":"size-scaled"/);
    assert.match(result.marker, /"tool_calls":\d+/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812: PR body edited while CI runs reaches the model (post-CI metadata refresh)", async () => {
  const requests: string[] = [];
  const server = await startMockServer((_req, body, res) => {
    requests.push(String(body));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  let prBody = "Original description.";
  const platform = mockPlatform();
  const base = platform.getPr.bind(platform);
  platform.getPr = async () => ({ ...(await base() as Record<string, unknown>), body: prBody }) as never;
  const { runDir, cleanup } = withRunDir();
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      // The author pushes, then edits the PR body while CI is still running.
      ciGate: { file: "", envAllowlist: [], workload: async () => { prBody = "EDITED-DURING-CI description."; return 0; } },
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(readFileSync(join(runDir, "pr-body.txt"), "utf8"), "EDITED-DURING-CI description.");
    const reviewRequest = requests.at(-1) ?? "";
    assert.match(reviewRequest, /EDITED-DURING-CI/);
    assert.doesNotMatch(reviewRequest, /Original description\./);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812: a request_changes marker records the CI conclusion it was reached against", async () => {
  let checksCalls = 0;
  const platform = mockPlatform();
  platform.externalChecks = async () => { checksCalls += 1; return [{ name: "build", state: "FAILURE" }]; };
  const changes = await runWithVerdictOn(platform, { verdict: "request_changes", findings: [finding("major")] });
  assert.equal(changes.outputs.verdict, "request_changes");
  assert.match(changes.marker, /"ci_state":"failure"/);
  assert.equal(checksCalls, 1);

  // An approve is never re-checked by the precheck, so it pays no read.
  checksCalls = 0;
  const approve = await runWithVerdictOn(platform, { verdict: "approve", findings: [] });
  assert.doesNotMatch(approve.marker, /ci_state/);
  assert.equal(checksCalls, 0);

  // A failed read omits the field (the precheck then fails closed).
  platform.externalChecks = async () => null;
  const unknown = await runWithVerdictOn(platform, { verdict: "request_changes", findings: [finding("major")] });
  assert.doesNotMatch(unknown.marker, /ci_state/);
});

async function runWithVerdictOn(platform: PlatformReadAdapter, verdict: Record<string, unknown>): Promise<Awaited<ReturnType<typeof runReview>>> {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict(verdict)));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    return await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: false,
      quiet: true,
    });
  } finally {
    await server.close();
    cleanup();
  }
}

test("#812: a head that moved during the CI wait skips the metadata refresh", async () => {
  const requests: string[] = [];
  const server = await startMockServer((_req, body, res) => {
    requests.push(String(body));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  let prBody = "Original description.";
  let headSha = "a".repeat(40);
  const platform = mockPlatform();
  const base = platform.getPr.bind(platform);
  platform.getPr = async () => {
    const pr = await base() as Record<string, unknown>;
    return { ...pr, body: prBody, head: { ...(pr.head as Record<string, unknown>), sha: headSha } } as never;
  };
  const { runDir, cleanup } = withRunDir();
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      // A new push lands while CI runs: this review is superseded, so it must
      // not mix the new head's metadata into the old head's review.
      ciGate: { file: "", envAllowlist: [], workload: async () => { prBody = "NEW-HEAD description."; headSha = "b".repeat(40); return 0; } },
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(readFileSync(join(runDir, "pr-body.txt"), "utf8"), "Original description.");
    assert.doesNotMatch(requests.at(-1) ?? "", /NEW-HEAD/);
  } finally {
    await server.close();
    cleanup();
  }
});

async function obligationRun(extraInputs: Record<string, string>): Promise<{ harness: Array<{ text: string }>; lastRequest: string }> {
  const requests: string[] = [];
  const server = await startMockServer((_req, body, res) => {
    requests.push(String(body));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    mkdirSync(join(runDir, "pkg"), { recursive: true });
    writeFileSync(join(runDir, "pkg", "auth.py"), "def get_session_token(user):\n    return sign(user, ttl=60)\n");
    writeFileSync(join(runDir, "pkg", "client.py"), "from pkg.auth import get_session_token\n\ndef call(user):\n    return get_session_token(user)\n");
    gitInit(runDir);
    const diff = [
      "diff --git a/pkg/auth.py b/pkg/auth.py",
      "--- a/pkg/auth.py",
      "+++ b/pkg/auth.py",
      "@@ -1,2 +1,2 @@",
      " def get_session_token(user):",
      "-    return sign(user)",
      "+    return sign(user, ttl=60)",
      "",
    ].join("\n");
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" },
      inputs: { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k", ...extraInputs },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform({ diff, files: [{ filename: "pkg/auth.py", status: "modified", additions: 1, deletions: 1, changes: 2 }] }),
      persistArtifacts: true,
      quiet: true,
    });
    const ledger = JSON.parse(readFileSync(join(runDir, "requirement-ledger.json"), "utf8")) as { requirements: Array<{ text: string; provenance: Array<{ source: string; ref: string }> }> };
    const harness = ledger.requirements.filter((entry) => entry.provenance.some((p) => p.source === "harness" && p.ref === "pkg/auth.py"));
    return { harness, lastRequest: requests.at(-1) ?? "" };
  } finally {
    await server.close();
    cleanup();
  }
}

test("#796: with harness-obligations on, an edited function with a caller becomes a harness obligation in the run's ledger", async () => {
  const { harness, lastRequest } = await obligationRun({ "harness-obligations": "true" });
  assert.ok(harness.length > 0, "no harness obligation in the ledger");
  assert.match(harness[0]!.text, /get_session_token/);
  assert.match(harness[0]!.text, /client\.py/);
  assert.match(lastRequest, /get_session_token/);
});

test("#796: harness obligations are off by default", async () => {
  const { harness } = await obligationRun({});
  assert.deepEqual(harness, []);
});

async function equivalentPathsRun(extraInputs: Record<string, string>): Promise<string> {
  const { md } = await equivalentPathsRunWithResult(extraInputs);
  return md;
}

async function equivalentPathsRunWithResult(
  extraInputs: Record<string, string>,
): Promise<{ md: string; result: Awaited<ReturnType<typeof runReview>> }> {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    mkdirSync(join(runDir, "src"), { recursive: true });
    const sourceTs = [
      "export function resolveExplicit(uri: string, ctxRepoDid: string): PullIdentity {", // 1
      "  const targetRepo = fetchTarget(uri); // touched", // 2
      "  if (targetRepo !== ctxRepoDid) {", // 3
      "    throw new Error('mismatch');", // 4
      "  }", // 5
      "  return { repoDid: targetRepo };", // 6
      "}", // 7
      "", // 8
      "export function resolveFromList(ctxRepoDid: string): PullIdentity {", // 9
      "  const targetRepo = fetchFirst(ctxRepoDid); // touched", // 10
      "  return { repoDid: targetRepo };", // 11
      "}", // 12
      "",
    ].join("\n");
    writeFileSync(join(runDir, "src", "resolve.ts"), sourceTs);
    gitInit(runDir);
    // Both functions must be touched by the diff (change-anchor extraction
    // only surfaces a function untouched by any hunk as an "enclosing"
    // symbol for the hunk that changed *inside* it, not for the whole file).
    const diff = [
      "diff --git a/src/resolve.ts b/src/resolve.ts",
      "--- a/src/resolve.ts",
      "+++ b/src/resolve.ts",
      "@@ -1,7 +1,7 @@",
      " export function resolveExplicit(uri: string, ctxRepoDid: string): PullIdentity {",
      "-  const targetRepo = fetchTarget(uri);",
      "+  const targetRepo = fetchTarget(uri); // touched",
      "   if (targetRepo !== ctxRepoDid) {",
      "     throw new Error('mismatch');",
      "   }",
      "   return { repoDid: targetRepo };",
      " }",
      "@@ -9,4 +9,4 @@",
      " export function resolveFromList(ctxRepoDid: string): PullIdentity {",
      "-  const targetRepo = fetchFirst(ctxRepoDid);",
      "+  const targetRepo = fetchFirst(ctxRepoDid); // touched",
      "   return { repoDid: targetRepo };",
      " }",
      "",
    ].join("\n");
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" },
      inputs: { "github-token": "tok", repo: "o/r", "pr-number": "9", "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k", ...extraInputs },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform({ diff, files: [{ filename: "src/resolve.ts", status: "modified", additions: 2, deletions: 2, changes: 4 }] }),
      persistArtifacts: true,
      quiet: true,
    });
    const md = existsSync(join(runDir, "equivalent-paths.md")) ? readFileSync(join(runDir, "equivalent-paths.md"), "utf8") : "";
    return { md, result };
  } finally {
    await server.close();
    cleanup();
  }
}

test("#875: with equivalent-paths on, a return-type-sharing pair produces the 'Equivalent Paths to Compare' section", async () => {
  const md = await equivalentPathsRun({ "equivalent-paths": "true" });
  assert.match(md, /# Equivalent Paths to Compare/);
  assert.match(md, /resolveExplicit/);
  assert.match(md, /resolveFromList/);
});

test("#875: the section instructs the reviewer to weigh documented differences rather than report them as missing checks", async () => {
  const md = await equivalentPathsRun({ "equivalent-paths": "true" });
  assert.match(md, /documents as deliberate/);
  assert.match(md, /not a missing check/);
});

test("#875 negative: with equivalent-paths on, grouped equivalent paths never manufacture findings — a clean review stays clean", async () => {
  const { result } = await equivalentPathsRunWithResult({ "equivalent-paths": "true" });
  // The hint is advisory input to the correctness specialist only: the
  // detector and its section can never add findings, escalate the verdict,
  // or touch required-check coverage on their own. A model that (as here)
  // returns approve with no findings must produce exactly that — the
  // #875 acceptance property that a deliberately documented semantic
  // difference between grouped paths cannot become a false finding.
  assert.equal(result.outputs.verdict, "approve");
  assert.deepEqual(JSON.parse(result.outputs.findings) as unknown[], []);
  // No required checks are configured in this fixture, so the honest
  // output is "none" — the point is that the hint introduced no gap.
  assert.equal(result.outputs.requiredChecks, "none");
  assert.match(result.marker, /"review_result":"clean"/);
  assert.ok(!result.marker.includes('"review_result":"partial"'));
  assert.ok(!result.marker.includes('"review_result":"issues"'));
});

test("#875: equivalent-paths is off by default (no section written)", async () => {
  const md = await equivalentPathsRun({});
  assert.equal(md, "");
});

/** SSE bodies for a streamed tool-call turn and a streamed text turn. */
function sseToolCall(apiFormat: "openai" | "anthropic", path: string): string {
  const args = JSON.stringify({ path });
  if (apiFormat === "anthropic") {
    return [
      { type: "message_start", message: { id: "m1", model: "m", usage: { input_tokens: 50, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  }
  return [
    { id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "tc1", type: "function", function: { name: "read_file", arguments: args } }] } }] },
    { id: "c1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

function sseText(apiFormat: "openai" | "anthropic", text: string): string {
  if (apiFormat === "anthropic") {
    return [
      { type: "message_start", message: { id: "m2", model: "m", usage: { input_tokens: 60, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  }
  return [
    { id: "c2", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    { id: "c2", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

for (const apiFormat of ["openai", "anthropic"] as const) {
  test(`streamed ${apiFormat} tool calls reach the loop and read the checkout, not the run dir`, async () => {
    let toolTurns = 0;
    const server = await startMockServer((_req, body, res) => {
      const payload = JSON.parse(body) as { tools?: unknown[] };
      res.setHeader("Content-Type", "text/event-stream");
      if (Array.isArray(payload.tools) && payload.tools.length > 0 && toolTurns === 0) {
        toolTurns += 1;
        res.end(sseToolCall(apiFormat, "README.md"));
        return;
      }
      res.end(sseText(apiFormat, JSON.stringify(baseVerdict())));
    });
    const checkout = mkdtempSync(join(tmpdir(), "v3-checkout-"));
    const { runDir, cleanup } = withRunDir();
    try {
      writeFileSync(join(checkout, "README.md"), "hello\nworld-from-the-checkout\n");
      gitInit(checkout);
      await runReview({
        env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" },
        inputs: {
          "github-token": "tok", repo: "o/r", "pr-number": "7",
          "ai-base-url": server.url, "ai-model": "m", "ai-api-format": apiFormat, "ai-stream": "true", "ai-api-key": "k",
          "tool-mode": "native_loop",
        },
        runDir,
        workspace: checkout,
        platformAdapter: mockPlatform(),
        persistArtifacts: true,
        quiet: true,
      });
      const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as {
        executed_request_count: number;
        stop_reason: string;
        native_loop_degraded?: string;
        tool_results: Array<{ tool: string; status: string; result: { content?: string } }>;
        usage?: { prompt_tokens: number };
      };
      assert.equal(harness.native_loop_degraded, undefined, `loop degraded: ${harness.stop_reason}`);
      assert.equal(harness.executed_request_count, 1);
      assert.equal(harness.tool_results[0]!.tool, "read_file");
      assert.equal(harness.tool_results[0]!.status, "ok");
      assert.match(harness.tool_results[0]!.result.content ?? "", /world-from-the-checkout/);
      assert.ok((harness.usage?.prompt_tokens ?? 0) > 0, `streamed usage must be counted: ${JSON.stringify(harness.usage)}`);
    } finally {
      await server.close();
      cleanup();
      rmSync(checkout, { recursive: true, force: true });
    }
  });
}

test("deep review writes its artifacts where the run reads them when the run dir is not the checkout", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const checkout = mkdtempSync(join(tmpdir(), "v3-checkout-"));
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(checkout, "README.md"), "hello\nworld\n");
    gitInit(checkout);
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false", GITHUB_WORKSPACE: checkout },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        "deep-review": "true",
      },
      runDir,
      workspace: checkout,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    assert.ok(existsSync(join(runDir, "specialists.json")), "specialists.json must land in the run dir");
    assert.ok(!existsSync(join(checkout, "specialists.json")), "the checkout must not receive run artifacts");
  } finally {
    await server.close();
    cleanup();
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("recursion guard: a gate child process never starts a review", async () => {
  await assert.rejects(
    runReview({ env: { PR_REVIEWER_GATE_CHILD: "1" }, inputs: {}, quiet: true }),
    /inside a gate child/,
  );
});

test("the CI gate only launches from a real bundle entry, never the test runner file", async () => {
  const { runtimeBundleEntry } = await import("../src/run/review.js");
  // This process's argv[1] is a test file, not dist/index.js.
  assert.equal(runtimeBundleEntry({}), null);
  assert.equal(runtimeBundleEntry({ PR_REVIEWER_ENTRY: "/x/dist/index.js" }), "/x/dist/index.js");
  // CI gating on with no override: skipped with a log line, no child spawned.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  const lines: string[] = [];
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k", "ci-status-check": "true" },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: false,
      log: (line) => lines.push(line),
    });
    assert.equal(result.ciGate.ran, false);
    assert.ok(lines.some((line) => /CI status gating skipped/.test(line)));
  } finally {
    await server.close();
    cleanup();
  }
});

test("the CI gate's v2 step outputs are republished under the contract's kebab names", async () => {
  const { ciGateOutputs } = await import("../src/run/review.js");
  const { runDir, cleanup } = withRunDir();
  try {
    const file = join(runDir, "ci-gate-outputs.txt");
    writeFileSync(file, "ci_status_final=success\nci_status_skipped=false\nunrelated=1\n");
    assert.equal(ciGateOutputs(file), "ci-status-final=success\nci-status-skipped=false\n");
    assert.equal(ciGateOutputs(join(runDir, "missing.txt")), "");
  } finally {
    cleanup();
  }
});

// ── #824: transport max_tokens clamp-and-retry, end to end ──────────────────
// A provider that refuses an oversized max_tokens with an HTTP 400 stating
// the real cap must not fail the review: the transport retries the same
// request once at the stated cap, for the final review and for every tool
// loop turn.

const CAP_MESSAGE = (requested: number | undefined): string =>
  `max_tokens: ${requested} > 8192, which is the maximum allowed number of output tokens for <model>`;

/** Refuses every request whose max_tokens exceeds 8192 with the Anthropic-
 * style 400; records the token field and value of every request. */
async function startClampServer(handleAllowed: (sent: Record<string, unknown>, served: { toolTurnServed: boolean }) => string): Promise<{
  server: Awaited<ReturnType<typeof startMockServer>>;
  requested: Array<number | undefined>;
}> {
  const requested: Array<number | undefined> = [];
  const served = { toolTurnServed: false };
  const server = await startMockServer((_req, body, res) => {
    const sent = JSON.parse(body) as Record<string, unknown>;
    requested.push(sent.max_tokens as number | undefined);
    if ((sent.max_tokens as number | undefined ?? 0) > 8192) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: CAP_MESSAGE(sent.max_tokens as number) } }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(handleAllowed(sent, served));
  });
  return { server, requested };
}

test("#824: a run against a provider that 400s oversized max_tokens completes at the stated cap", async () => {
  const { server, requested } = await startClampServer(() => verdictBody(baseVerdict()));
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ai-max-tokens": "16384",
        "ai-primary-retries": "1",
        "ai-primary-retry-delay-sec": "0",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: false,
      quiet: true,
    });
    // The review completes on the clamped retry, not despite the 400.
    assert.equal(result.outputs.verdict, "approve");
    assert.deepEqual(requested, [16384, 8192]);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#824: every tool loop turn clamps the same way and the review still publishes", async () => {
  const { server, requested } = await startClampServer((sent, served) => {
    if (!served.toolTurnServed && Array.isArray(sent.tools) && sent.tools.length > 0) {
      served.toolTurnServed = true;
      return JSON.stringify({
        id: "c0", object: "chat.completion", model: "m",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    return verdictBody(baseVerdict());
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "README.md"), "hello\nworld\n");
    gitInit(runDir);
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "tool-mode": "native_loop",
        "tool-max-tokens-per-turn": "16384",
        "tool-max-requests": "1",
        "ai-primary-retries": "1",
        "ai-primary-retry-delay-sec": "0",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    // Each loop turn was refused once at 16384 and re-sent at 8192: the tool
    // turn and the verdict turn alike.
    assert.deepEqual(requested, [16384, 8192, 16384, 8192]);
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as { stop_reason: string; tool_results: Array<{ tool: string; status: string }> };
    assert.equal(harness.stop_reason, "tool-call-budget-exhausted");
    assert.equal(harness.tool_results[0]!.tool, "read_file");
    assert.equal(harness.tool_results[0]!.status, "ok");
  } finally {
    await server.close();
    cleanup();
  }
});

test("a PR whose body keyword-links a fetched issue classifies without crashing", async () => {
  // Regression for the dogfood crash (#825 CI): buildLinkedIssueContext's
  // GitHub refs carry labels but never `source`. The run seam normalizes
  // the raw collection through normalizeLinkedIssues before classifyPr, so
  // the canonical classifier never sees the raw shape.
  const platform = mockPlatform({ body: "Closes #824.\n\nA clamp fix.\n" });
  platform.getIssue = async () => ({
    ok: true,
    data: {
      number: 824,
      title: "clamp max_tokens",
      state: "open",
      html_url: "https://forge.example/o/r/issues/824",
      labels: [{ name: "enhancement" }, { name: "priority/p1" }],
      body: "Clamp the transport token field.",
    },
  }) as never;
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    const classification = JSON.parse(readFileSync(join(runDir, "classification.json"), "utf8")) as { risk_flags: string[]; linked_issue_labels: string[] };
    assert.deepEqual(classification.linked_issue_labels, ["enhancement", "priority/p1"]);
    assert.deepEqual(classification.risk_flags, ["linked_priority_p1"]);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#872: a title-only (#N) reference feeds the fetched issue's acceptance criteria into the requirement ledger", async () => {
  // Reproduces the #854/#584 gap: the PR title trails "(#584)" and the body
  // has no closing keyword, so only the title convention can surface #584.
  const platform = mockPlatform({
    title: "feat(v3): add Tangled Bobbin read client and canonical pull resolver (#584)",
    body: "No closing keyword mentions #584 here.",
  });
  platform.getIssue = async () => ({
    ok: true,
    data: {
      number: 584,
      title: "Tangled Bobbin canonical pull resolver",
      state: "open",
      html_url: "https://forge.example/o/r/issues/584",
      labels: [],
      body: "- The resolver MUST resolve from repository identity plus source SHA/branch and target branch",
    },
  }) as never;
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    const ledger = JSON.parse(readFileSync(join(runDir, "requirement-ledger.json"), "utf8")) as {
      requirements: Array<{ text: string; provenance: Array<{ source: string; ref: string }> }>;
    };
    const linked = ledger.requirements.filter((entry) => entry.provenance.some((p) => p.source === "linked_issues" && p.ref === "#584"));
    assert.ok(
      linked.some((entry) => entry.text.includes("resolve from repository identity plus source SHA/branch")),
      "the title-only linked issue's acceptance criterion must reach the ledger",
    );
  } finally {
    await server.close();
    cleanup();
  }
});

test("#872: a title-only (#N) reference that actually names a pull request never reaches the requirement ledger", async () => {
  // A trailing "(#N)" on a squash-merge/automation title very often names
  // the PR that produced it, not an issue. If getIssue's payload is a PR
  // (GitHub/Forgejo mark this with a `pull_request` object on the same
  // issues endpoint), it must be rejected before its body can masquerade as
  // issue guidance in the ledger.
  const platform = mockPlatform({
    title: "feat: thing (#12)",
    body: "No closing keyword mentions #12 here.",
  });
  platform.getIssue = async () => ({
    ok: true,
    data: {
      number: 12,
      pull_request: { url: "https://forge.example/o/r/pulls/12" },
      labels: [],
      body: "The resolver MUST do the thing that PR #12 itself implements",
    },
  }) as never;
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    const linkedMd = readFileSync(join(runDir, "linked-issues.md"), "utf8");
    assert.doesNotMatch(linkedMd, /MUST do the thing/, "the PR's body must not land in linked-issues.md");
    assert.match(linkedMd, /\(Skipped issue #12 from o\/r: linked object is a pull request\)/);
    const ledger = JSON.parse(readFileSync(join(runDir, "requirement-ledger.json"), "utf8")) as {
      requirements: Array<{ text: string; provenance: Array<{ source: string; ref: string }> }>;
    };
    const linked = ledger.requirements.filter((entry) => entry.provenance.some((p) => p.source === "linked_issues" && p.ref === "#12"));
    assert.deepEqual(linked, [], "the rejected pull request must never reach the requirement ledger");
    const status = JSON.parse(readFileSync(join(runDir, "linked-metadata-status.json"), "utf8")) as { github_pull_request_skips?: string[] };
    assert.deepEqual(status.github_pull_request_skips, ["#12"], "the skip must be visible in linked-metadata status");
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812: unresolved bot threads re-emit with their original severity and Minor/Info alone approves", async () => {
  // The #814 shape: 10 unresolved bot-managed threads, 9 Minor/Info + 1 Major
  // the model resolved with code-citing evidence. The re-emitted findings must
  // carry the severity parsed from each managed finding comment, and the strict
  // verdict over the still-open set (Minor/Info only) must stay an approve.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({
      thread_dispositions: [
        { thread_id: "PRRT_major", disposition: "fixed", evidence: "added tests/fixtures/parity/corpus/v1.json:1" },
      ],
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const platform = mockPlatform();
    const botThread = (id: string, label: string, message: string) => ({
      thread_id: id,
      path: "src/a.ts",
      line: 1,
      original_line: null,
      resolved: false,
      outdated: false,
      comments: [{
        id, user: "reviewer-bot", created_at: "2026-09-28T10:00:00Z", updated_at: "",
        body: `**${label}:** ${message}\n\n_Automated finding from AI PR review._`,
      }],
    });
    platform.listReviewThreads = () => Promise.resolve({
      ok: true,
      data: [
        ...[1, 2, 3, 4].map((n) => botThread(`PRRT_t${n}`, "Minor (tests)", `nit ${n}`)),
        ...[5, 6, 7, 8, 9].map((n) => botThread(`PRRT_t${n}`, "Info (security)", `note ${n}`)),
        botThread("PRRT_major", "⚠️ Major (tests)", "parity fixture missing"),
      ],
    }) as never;
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    assert.match(result.marker, /review_result.{0,4}findings/);
    const out = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as Record<string, unknown>;
    const reemitted = (out.findings as Array<Record<string, unknown>>).filter((f) => f.thread_id);
    assert.equal(reemitted.length, 9, "every unresolved thread re-emits exactly once");
    assert.deepEqual(
      reemitted.map((f) => f.severity).sort(),
      ["info", "info", "info", "info", "info", "minor", "minor", "minor", "minor"],
      "each re-emitted finding carries its thread's original severity",
    );
    const rows = out.thread_dispositions as Array<Record<string, unknown>>;
    assert.equal(rows.length, 10);
    assert.equal(rows.filter((r) => r.disposition === "fixed").length, 1, "the evidenced major resolution is honored");
    assert.equal(rows.filter((r) => r.enforced === "no disposition given").length, 9);
    assert.match(String(out.review_markdown), /## Unresolved Review Threads/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812: a superseded thread claim is labeled and the authoritative sections come first", async () => {
  // The #814 shape: an old thread comment says "do not merge until X" while
  // the current PR body and the linked issue say X happens after merge. The
  // corpus must order the authoritative sections (PR body, linked issues)
  // ahead of the discussion, label the pre-edit comment as superseded, and
  // the system prompt must carry the matching rule.
  const staleRestBody = "STALE-A: the body the ordinary PR read returned.";
  const platform = mockPlatform({ body: staleRestBody });
  const base = platform.getPr.bind(platform);
  // `updated_at` moved to 12:00 (generic activity); the label must follow the
  // atomic body snapshot, whose edit at 10:00 postdates the 08:00 comment.
  // The snapshot's body B differs from the REST body A: whichever body the
  // cutoff describes is the one the corpus must present.
  platform.getPr = async () => ({ ...(await base() as Record<string, unknown>), updated_at: "2026-09-28T12:00:00Z" }) as never;
  const revisionBody = "Closes #12.\n\nShadow qualification happens after merge.";
  platform.getPrBodyRevision = () => Promise.resolve({ body: revisionBody, editedAt: "2026-09-28T10:00:00Z" });
  platform.listPrConversationComments = () => Promise.resolve({
    ok: true,
    data: [{
      id: 1,
      user: { login: "author" },
      created_at: "2026-09-28T08:00:00Z",
      updated_at: "",
      body: "Do not merge until shadow qualification completes.",
    }],
  }) as never;
  platform.getIssue = async () => ({
    ok: true,
    data: {
      number: 12,
      title: "sequencing",
      state: "open",
      html_url: "https://forge.example/o/r/issues/12",
      labels: [],
      body: "The qualification runs after merge.",
    },
  }) as never;
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(result.outputs.verdict, "approve");
    // The pre-edit comment is labeled superseded; the section carries the
    // authoritative-context note.
    const prThread = readFileSync(join(runDir, "pr-thread.md"), "utf8");
    assert.match(prThread, /## Comment by author — 2026-09-28T08:00:00Z — earlier discussion \(may be superseded by the current description\)/);
    assert.match(prThread, /The current PR description and any linked issues are authoritative/);
    // The corpus presents the authoritative sections before the discussion.
    const corpus = readFileSync(join(runDir, "review-corpus.truncated.md"), "utf8");
    const linkedAt = corpus.indexOf("# Linked Issue Context");
    const threadAt = corpus.indexOf("# PR Thread Context");
    assert.ok(linkedAt >= 0, "the linked issue reached the corpus");
    assert.ok(linkedAt < threadAt, "linked issues precede the PR conversation");
    const metadataAt = corpus.indexOf("# PR Metadata");
    assert.ok(metadataAt >= 0 && metadataAt < linkedAt);
    // Atomicity: the presented body is the revision the cutoff describes.
    assert.ok(corpus.includes("Shadow qualification happens after merge."), "the snapshot body is the authoritative description");
    assert.ok(!corpus.includes("STALE-A"), "the stale REST body is never presented beside the snapshot cutoff");
    // The system prompt carries the superseded-discussion rule.
    const request = readFileSync(join(runDir, "ai-request.primary.json"), "utf8");
    assert.match(request, /authoritative context and outrank the discussion sections/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812 review: generic PR activity without a description edit never softens a comment", async () => {
  // A blocking comment at 08:00; a push moved updated_at to 12:00. Without a
  // body-edit instant (no seam method, as on backends without one) — or with
  // a body edit that OLDER than the claim — the cutoff must stay null/older
  // and the comment must NOT be labeled superseded.
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    for (const shape of ["no-revision-seam", "edit-older-than-comment"] as const) {
      const platform = mockPlatform({ body: "No description edit after the comment." });
      const base = platform.getPr.bind(platform);
      platform.getPr = async () => ({ ...(await base() as Record<string, unknown>), updated_at: "2026-09-28T12:00:00Z" }) as never;
      if (shape === "edit-older-than-comment") {
        platform.getPrBodyRevision = () => Promise.resolve({ body: "No description edit after the comment.", editedAt: "2026-09-28T07:00:00Z" });
      }
      platform.listPrConversationComments = () => Promise.resolve({
        ok: true,
        data: [{
          id: 1,
          user: { login: "reviewer" },
          created_at: "2026-09-28T08:00:00Z",
          updated_at: "",
          body: "Do not merge until X is fixed.",
        }],
      }) as never;
      await runReview({
        env: { GITHUB_OUTPUT: join(runDir, `gh-output-${shape}.txt`) },
        inputs: {
          "github-token": "tok",
          repo: "o/r",
          "pr-number": "7",
          "ai-base-url": server.url,
          "ai-model": "m",
          "ai-stream": "false",
          "ai-api-key": "k",
          "ci-status-check": "false",
        },
        runDir,
        workspace: runDir,
        platformAdapter: platform,
        persistArtifacts: true,
        quiet: true,
      });
      const prThread = readFileSync(join(runDir, "pr-thread.md"), "utf8");
      assert.ok(prThread.includes("Do not merge until X is fixed."), shape);
      assert.ok(!prThread.includes("earlier discussion"), `comment must not be softened (${shape})`);
      assert.ok(!prThread.includes("authoritative"), `no label, no authoritative note (${shape})`);
      rmSync(join(runDir, "pr-thread.md"));
    }
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812 review: discussion appearing during the CI wait reapplies the superseded-discussion rule", async () => {
  const requests: string[] = [];
  const server = await startMockServer((_req, body, res) => {
    requests.push(String(body));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  // Deterministic timing: the FIRST fetch (initial context stage) sees no
  // comments; every later fetch (the post-CI rebuild) sees the one that
  // landed while CI ran — independent of when the gate workload runs.
  let commentsFetch = 0;
  const platform = mockPlatform();
  platform.listPrConversationComments = () => {
    commentsFetch += 1;
    return Promise.resolve({
      ok: true,
      data: commentsFetch >= 2
        ? [{ id: 1, user: { login: "reviewer" }, created_at: "2026-09-28T08:00:00Z", updated_at: "", body: "A blocking claim appears while CI runs." }]
        : [],
    }) as never;
  };
  const { runDir, cleanup } = withRunDir();
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      // The gate runs to completion, so the post-CI metadata refresh fires.
      ciGate: { file: "", envAllowlist: [], workload: async () => 0 },
      persistArtifacts: true,
      quiet: true,
    });
    // The rebuilt pr-thread section carries the late comment...
    const prThread = readFileSync(join(runDir, "pr-thread.md"), "utf8");
    assert.match(prThread, /A blocking claim appears while CI runs\./);
    // ...and the system prompt sent to the model carries the rule.
    const request = readFileSync(join(runDir, "ai-request.primary.json"), "utf8");
    assert.match(request, /authoritative context and outrank the discussion sections/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#812 review: authoritativeBodyRevision normalizes the snapshot and fails safe", async () => {
  const adapter = (revision: unknown, method = true): PlatformReadAdapter =>
    ({ ...(method ? { getPrBodyRevision: () => Promise.resolve(revision as PrBodyRevision | null) } : {}) } as unknown as PlatformReadAdapter);
  // A usable snapshot passes through with a normalized editedAt.
  assert.deepEqual(await authoritativeBodyRevision(adapter({ body: "B", editedAt: "2026-09-28T10:00:00Z" })), { body: "B", editedAt: "2026-09-28T10:00:00Z" });
  assert.deepEqual(await authoritativeBodyRevision(adapter({ body: "B", editedAt: "" })), { body: "B", editedAt: null });
  // No seam (backend without it), an explicit null, a malformed payload, a
  // body that is not a string, and a throwing read all yield null: the REST
  // body is presented and nothing is softened.
  assert.equal(await authoritativeBodyRevision(adapter(null, false)), null);
  assert.equal(await authoritativeBodyRevision(adapter(null)), null);
  assert.equal(await authoritativeBodyRevision(adapter("nope")), null);
  assert.equal(await authoritativeBodyRevision(adapter({ editedAt: "2026-09-28T10:00:00Z" })), null);
  const throwing: PlatformReadAdapter = { getPrBodyRevision: () => Promise.reject(new Error("down")) } as unknown as PlatformReadAdapter;
  assert.equal(await authoritativeBodyRevision(throwing), null);
});

test("#833: a seeded pr-files.seed.json overrides the live file list and size totals", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(
      join(runDir, "pr-files.seed.json"),
      JSON.stringify([
        { filename: "a.py", status: "modified", additions: 3, deletions: 1, changes: 4, previous_filename: null },
      ]),
    );
    const platform = mockPlatform({
      files: [
        { filename: "a.py", status: "modified", additions: 3, deletions: 1, changes: 4 },
        { filename: "phantom.py", status: "added", additions: 50, deletions: 0, changes: 50 },
      ],
      additions: 53,
      deletions: 1,
    });
    let listPrFilesCalls = 0;
    const originalListPrFiles = platform.listPrFiles;
    platform.listPrFiles = (...args: Parameters<typeof originalListPrFiles>) => {
      listPrFilesCalls += 1;
      return originalListPrFiles(...args);
    };
    await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(listPrFilesCalls, 0);
    const files = JSON.parse(readFileSync(join(runDir, "pr-files.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.deepEqual(files.map((f) => f.filename), ["a.py"]);
    const pr = JSON.parse(readFileSync(join(runDir, "pr.json"), "utf8")) as Record<string, unknown>;
    assert.equal(pr.changedFiles, 1);
    assert.equal(pr.additions, 3);
    assert.equal(pr.deletions, 1);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#833: a malformed seed file throws and never falls back to the live list", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    writeFileSync(join(runDir, "pr-files.seed.json"), "");
    const platform = mockPlatform();
    let listPrFilesCalls = 0;
    const originalListPrFiles = platform.listPrFiles;
    platform.listPrFiles = (...args: Parameters<typeof originalListPrFiles>) => {
      listPrFilesCalls += 1;
      return originalListPrFiles(...args);
    };
    await assert.rejects(
      runReview({
        env: {},
        inputs: {
          "github-token": "tok", repo: "o/r", "pr-number": "7",
          "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        },
        runDir,
        workspace: runDir,
        platformAdapter: platform,
        persistArtifacts: true,
        quiet: true,
      }),
      /pr-files\.seed\.json/,
    );
    assert.equal(listPrFilesCalls, 0);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#833: no seed file falls back to the live PR file list and totals", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const platform = mockPlatform({
      files: [{ filename: "a.py", status: "modified", additions: 3, deletions: 1, changes: 4 }],
      additions: 3,
      deletions: 1,
    });
    let listPrFilesCalls = 0;
    const originalListPrFiles = platform.listPrFiles;
    platform.listPrFiles = (...args: Parameters<typeof originalListPrFiles>) => {
      listPrFilesCalls += 1;
      return originalListPrFiles(...args);
    };
    await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
      },
      runDir,
      workspace: runDir,
      platformAdapter: platform,
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(listPrFilesCalls, 1);
    const files = JSON.parse(readFileSync(join(runDir, "pr-files.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.deepEqual(files.map((f) => f.filename), ["a.py"]);
    const pr = JSON.parse(readFileSync(join(runDir, "pr.json"), "utf8")) as Record<string, unknown>;
    assert.equal(pr.changedFiles, 1);
    assert.equal(pr.additions, 3);
    assert.equal(pr.deletions, 1);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#846: primary HTTP errors carry status, a redacted body excerpt, and the 404 hint into the error log", async () => {
  const planted = "ghp_" + "a".repeat(36); // matches redactText's GitHub PAT pattern
  const apiKey = "primary-secret-key-value";
  let call = 0;
  const server = await startMockServer((_req, _body, res) => {
    call += 1;
    if (call === 1) {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "rate limited, back off" } }));
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    // The provider echoes both a PAT-shaped planted secret AND the literal
    // configured API key bare (no "key="/"Bearer " framing that redactText's
    // heuristics look for) — only explicit known-secret masking (#846
    // security review) catches the latter.
    res.end(JSON.stringify({ error: { message: `no route for this model; leaked token ${planted}; credential ${apiKey} rejected` } }));
  });
  const { runDir, cleanup } = withRunDir();
  const errors: string[] = [];
  try {
    // on-model-failure=fail (explicit, since the action default is now
    // "notice" per #863/#866): runReview rejects once the primary (no
    // fallback configured) exhausts its retries, but the transport error
    // line is logged synchronously before that throw.
    await assert.rejects(() => runReview({
      env: {},
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": apiKey,
        "ai-primary-retries": "2",
        "ai-primary-retry-delay-sec": "0",
        "on-model-failure": "fail",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      sleep: async () => {},
      error: (line) => errors.push(line),
      quiet: true,
    }));
    assert.ok(call >= 2, `expected at least one retry, got ${call} call(s)`);
    const failureLine = errors.find((line) => line.includes("transport failures exhausted"));
    assert.ok(failureLine, `expected a transport-exhausted error line, got: ${JSON.stringify(errors)}`);
    assert.match(failureLine!, /HTTP 404/);
    assert.match(failureLine!, /no route for this model/);
    assert.match(failureLine!, /check ai-api-format for this model \(openai vs anthropic\)/);
    assert.ok(!failureLine!.includes(planted), "the planted secret must not appear in the error log");
    assert.ok(!failureLine!.includes(apiKey), "the configured API key must not appear in the error log");

    const responseArtifact = JSON.parse(readFileSync(join(runDir, "ai-response.primary.json"), "utf8")) as Record<string, unknown>;
    assert.match(String(responseArtifact.error), /HTTP 404/);
    assert.ok(!String(responseArtifact.error).includes(planted));
    assert.ok(!String(responseArtifact.error).includes(apiKey), "the configured API key must not appear in the persisted response artifact");

    for (const line of errors) {
      assert.ok(!line.includes(apiKey), "the configured API key must never appear anywhere in logs");
    }
  } finally {
    await server.close();
    cleanup();
  }
});

test("#846 security review: harnessTransportAdapter masks the configured API key out of its thrown transport-failure message", async () => {
  const apiKey = "harness-secret-key-value";
  const server = await startMockServer((_req, _body, res) => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: `no route for this model; credential ${apiKey} rejected` } }));
  });
  try {
    const transport = harnessTransportAdapter({} as StageEnv);
    await assert.rejects(
      () => transport(server.url, "openai", { model: "m", stream: false, messages: [] }, apiKey, 5),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 404/);
        assert.match(error.message, /check ai-api-format for this model \(openai vs anthropic\)/);
        assert.ok(!error.message.includes(apiKey), `expected the configured API key to be masked, got: ${error.message}`);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("#846 security review: a one-character or three-character configured API key is masked in the primary error log and artifact", async () => {
  for (const apiKey of ["k", "abc"]) {
    const server = await startMockServer((_req, _body, res) => {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: `no route for this model; credential ${apiKey} rejected` } }));
    });
    const { runDir, cleanup } = withRunDir();
    const errors: string[] = [];
    try {
      await assert.rejects(() => runReview({
        env: {},
        inputs: {
          "github-token": "tok",
          repo: "o/r",
          "pr-number": "7",
          "ai-base-url": server.url,
          "ai-model": "m",
          "ai-stream": "false",
          "ai-api-key": apiKey,
          "ai-primary-retries": "1",
          "ai-primary-retry-delay-sec": "0",
          "on-model-failure": "fail",
        },
        runDir,
        workspace: runDir,
        platformAdapter: mockPlatform(),
        sleep: async () => {},
        error: (line) => errors.push(line),
        quiet: true,
      }));
      const failureLine = errors.find((line) => line.includes("transport failures exhausted"));
      assert.ok(failureLine, `apiKey=${JSON.stringify(apiKey)}: expected a transport-exhausted error line, got: ${JSON.stringify(errors)}`);
      for (const line of errors) {
        assert.ok(!line.includes(apiKey), `apiKey=${JSON.stringify(apiKey)} must not appear in error log line: ${line}`);
      }
      const responseArtifact = JSON.parse(readFileSync(join(runDir, "ai-response.primary.json"), "utf8")) as Record<string, unknown>;
      assert.ok(!String(responseArtifact.error).includes(apiKey), `apiKey=${JSON.stringify(apiKey)} must not appear in the persisted response artifact`);
    } finally {
      await server.close();
      cleanup();
    }
  }
});

// ── #874: requirement-trace end-to-end ──────────────────────────────────

/** The distinctive substring of the linked issue's MUST line — used to find
 * that requirement's content-derived id inside the rendered ledger the
 * request body carries, without hardcoding the sha256-derived id. */
const REQUIREMENT_TRACE_MARKER = "the source SHA and the target branch";

/** A PR that keyword-links issue #824 (a closing keyword, not a title
 * reference — independent of #872/#879), whose body carries one MUST
 * acceptance line: the #584/#854 shape. */
function requirementTracePlatform(): PlatformReadAdapter {
  const platform = mockPlatform({ body: "Closes #824.\n\nResolve review context from the right identity.\n" });
  platform.getIssue = async () => ({
    ok: true,
    data: {
      number: 824,
      title: "resolve review context from repository identity",
      state: "open",
      html_url: "https://github.com/o/r/issues/824",
      labels: [],
      body: `Context resolution MUST bind to the repository identity plus ${REQUIREMENT_TRACE_MARKER}.`,
    },
  }) as never;
  return platform;
}

/** Find the requirement id the ledger rendered for its `- (req-...) `text``
 * list item containing `marker` — anchored to that exact rendered shape
 * (`renderRequirementLedgerMarkdown`), not just "an id appears somewhere
 * near the marker text": the issue body containing the same MUST line is
 * also quoted verbatim, earlier, inside the linked-issues section of the
 * same request body. */
function ledgerRequirementId(requestBody: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(String.raw`\(req-([0-9a-f]{12})\)\s*` + "`[^`]*" + escaped + "[^`]*`");
  const match = re.exec(requestBody);
  assert.ok(match, `no requirement-ledger entry rendered for marker ${JSON.stringify(marker)}`);
  return `req-${match[1]}`;
}

test("#874 malformed-location regression: a 'met' claim citing a non-existent enforcement location is downgraded, coverage goes partial", async () => {
  const server = await startMockServer((_req, body, res) => {
    const reqId = ledgerRequirementId(body, REQUIREMENT_TRACE_MARKER);
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({
      requirement_coverage: [{
        requirement_id: reqId,
        // No file at this path exists in the checkout at all — the
        // malformed-location case, distinct from the real #854 shape below
        // (where the cited line exists but only copies the value).
        disposition: "met",
        enforcement: [{ file: "src/context-resolution.ts", line: 42 }],
        test: [],
        reason: "resolveContext compares ctx.sourceSha against the pull's head",
      }],
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
        "requirement-trace": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: requirementTracePlatform(),
      persistArtifacts: true,
      quiet: true,
    });

    const trace = JSON.parse(readFileSync(join(runDir, "requirement-trace.json"), "utf8")) as {
      rows: Array<{ disposition: string; notes: string[] }>;
      incomplete: boolean;
    };
    assert.equal(trace.rows.length, 1);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.ok(trace.rows[0]!.notes.includes("downgraded-no-valid-enforcement-location"));
    assert.equal(trace.incomplete, true);

    // required_checks escalated to incomplete, feeding review_result=partial
    // (verdict_policy defaults to strict) — #873/#878 is what will later
    // make that non-approving; this only guarantees the signal is correct.
    assert.equal(result.outputs.requiredChecks, "incomplete");
    assert.equal(result.outputs.verdict, "approve");
    const output = readFileSync(join(runDir, "gh-output.txt"), "utf8");
    assert.match(output, /required-checks=incomplete/);
    assert.match(result.marker, /"required_checks":"incomplete"/);
    assert.match(result.marker, /"review_result":"partial"/);

    assert.match(result.outputs.reviewMarkdown, /Requirement trace/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#874 #854-reproduction: a 'met' claim citing a real line that only copies the value (never compares it) is downgraded, coverage goes partial", async () => {
  const server = await startMockServer((_req, body, res) => {
    const reqId = ledgerRequirementId(body, REQUIREMENT_TRACE_MARKER);
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({
      requirement_coverage: [{
        requirement_id: reqId,
        // The real #854 defect: the cited line EXISTS and even names the
        // right field, but only copies ctx.sourceSha onto the output —
        // nothing ever compares it. Location existence must not pass this.
        disposition: "met",
        enforcement: [{ file: "src/context-resolution.ts", line: 5 }],
        test: [{ file: "tests/context-resolution.test.ts", line: 1 }],
        reason: "sourceSha is present on the resolved context object",
      }],
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    mkdirSync(join(runDir, "src"), { recursive: true });
    mkdirSync(join(runDir, "tests"), { recursive: true });
    writeFileSync(
      join(runDir, "src", "context-resolution.ts"),
      [
        "export function resolveContext(ctx) {",
        "  const record = lookupPull(ctx);",
        "  return {",
        "    repo: record.repo,",
        "    sourceSha: ctx.sourceSha,",
        "    targetBranch: ctx.targetBranch,",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(runDir, "tests", "context-resolution.test.ts"), "test('placeholder', () => {});\n");
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
        "requirement-trace": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: requirementTracePlatform(),
      persistArtifacts: true,
      quiet: true,
    });

    const trace = JSON.parse(readFileSync(join(runDir, "requirement-trace.json"), "utf8")) as {
      rows: Array<{ disposition: string; notes: string[] }>;
      incomplete: boolean;
    };
    assert.equal(trace.rows.length, 1);
    assert.equal(trace.rows[0]!.disposition, "unverifiable");
    assert.ok(trace.rows[0]!.notes.includes("enforcement-location-copies-without-comparing"), JSON.stringify(trace.rows[0]));
    assert.equal(trace.incomplete, true);

    assert.equal(result.outputs.requiredChecks, "incomplete");
    assert.match(result.marker, /"required_checks":"incomplete"/);
    assert.match(result.marker, /"review_result":"partial"/);
  } finally {
    await server.close();
    cleanup();
  }
});

test("#874: an 'unmet' requirement with no finding gets a synthesized one and forces request_changes", async () => {
  const server = await startMockServer((_req, body, res) => {
    const reqId = ledgerRequirementId(body, REQUIREMENT_TRACE_MARKER);
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({
      requirement_coverage: [{
        requirement_id: reqId,
        disposition: "unmet",
        enforcement: [],
        test: [],
        reason: "no code path compares source SHA or target branch at all",
      }],
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
        "requirement-trace": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: requirementTracePlatform(),
      persistArtifacts: true,
      quiet: true,
    });

    const findings = JSON.parse(result.outputs.findings) as Array<{ severity: string; message: string }>;
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "major");
    assert.match(findings[0]!.message, /^requirement not enforced: /);
    assert.match(findings[0]!.message, /source SHA/);

    assert.equal(result.outputs.verdict, "request_changes");
    assert.match(result.marker, /"review_result":"issues"/);
  } finally {
    await server.close();
    cleanup();
  }
});
test("#874: verdict-policy=model — an unmet trace stops coverage and the marker never reads clean", async () => {
  const server = await startMockServer((_req, body, res) => {
    const reqId = ledgerRequirementId(body, REQUIREMENT_TRACE_MARKER);
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({
      requirement_coverage: [{
        requirement_id: reqId,
        disposition: "unmet",
        enforcement: [],
        test: [],
        reason: "no code path compares source SHA or target branch at all",
      }],
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
        "requirement-trace": "true",
        "verdict-policy": "model",
      },
      runDir,
      workspace: runDir,
      platformAdapter: requirementTracePlatform(),
      persistArtifacts: true,
      quiet: true,
    });

    const findings = JSON.parse(result.outputs.findings) as Array<{ severity: string; message: string }>;
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "major");
    assert.match(findings[0]!.message, /^requirement not enforced: /);
    assert.match(findings[0]!.message, /source SHA/);

    // The synthesized major finding is present, but the non-strict verdict
    // mapping runs before trace enforcement and leaves the model's approve
    // in place — which is exactly why the trace is ALSO a coverage stop:
    // required_checks=incomplete is what withholds approval (#878 guard)
    // and keeps the marker from reading clean under this policy.
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "major");
    assert.match(findings[0]!.message, /^requirement not enforced: /);
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.requiredChecks, "incomplete");
    assert.match(result.marker, /"required_checks":"incomplete"/);
    assert.match(result.marker, /"review_result":"partial"/);
    assert.ok(!result.marker.includes('"review_result":"clean"'));
  } finally {
    await server.close();
    cleanup();
  }
});
test("#874: verdict-policy=findings_severity_gated — an unmet trace stops coverage and the marker never reads clean", async () => {
  const server = await startMockServer((_req, body, res) => {
    const reqId = ledgerRequirementId(body, REQUIREMENT_TRACE_MARKER);
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict({
      requirement_coverage: [{
        requirement_id: reqId,
        disposition: "unmet",
        enforcement: [],
        test: [],
        reason: "no code path compares source SHA or target branch at all",
      }],
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        "ci-status-check": "false",
        "requirement-trace": "true",
        "verdict-policy": "findings_severity_gated",
      },
      runDir,
      workspace: runDir,
      platformAdapter: requirementTracePlatform(),
      persistArtifacts: true,
      quiet: true,
    });

    const findings = JSON.parse(result.outputs.findings) as Array<{ severity: string; message: string }>;
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "major");
    assert.match(findings[0]!.message, /^requirement not enforced: /);
    assert.match(findings[0]!.message, /source SHA/);

    // The synthesized major finding is present, but the non-strict verdict
    // mapping runs before trace enforcement and leaves the model's approve
    // in place — which is exactly why the trace is ALSO a coverage stop:
    // required_checks=incomplete is what withholds approval (#878 guard)
    // and keeps the marker from reading clean under this policy.
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "major");
    assert.match(findings[0]!.message, /^requirement not enforced: /);
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.requiredChecks, "incomplete");
    assert.match(result.marker, /"required_checks":"incomplete"/);
    assert.match(result.marker, /"review_result":"partial"/);
    assert.ok(!result.marker.includes('"review_result":"clean"'));
  } finally {
    await server.close();
    cleanup();
  }
});

test("#899: a native loop whose harness artifact is unreadable records partial coverage, never complete", () => {
  assert.equal(resolvePartialCoverage(null, true, true)?.stop_reason, "harness-unreadable");
  assert.equal(resolvePartialCoverage(null, false, true), undefined);
  assert.equal(resolvePartialCoverage(null, true, false), undefined);
  assert.equal(resolvePartialCoverage({ mode: "native_loop" }, true, true), undefined);
  const recorded = { stop_reason: "max-rounds", changed_files_total: 3, unread_files: ["a.ts"], leads_total: 0, unresolved_leads: [] };
  assert.deepEqual(resolvePartialCoverage({ partial_coverage: recorded }, true, true), recorded);
});

for (const direction of ["added", "removed"] as const) {
  test(`#935: a same-head refresh that ${direction === "added" ? "adds" : "removes"} a linked-issue requirement re-scopes the trace prompt`, async () => {
    const requests: string[] = [];
    const server = await startMockServer((_req, body, res) => {
      requests.push(String(body));
      res.setHeader("Content-Type", "application/json");
      res.end(verdictBody(baseVerdict()));
    });
    let prBody = direction === "added" ? "Original description." : "Fixes #40";
    const platform = mockPlatform();
    const base = platform.getPr.bind(platform);
    platform.getPr = async () => ({ ...(await base() as Record<string, unknown>), body: prBody }) as never;
    platform.getIssue = (async () => ({
      ok: true,
      data: { number: 40, title: "Resolver", state: "open", labels: [], body: "## Acceptance criteria\n- [ ] Resolution MUST compare the source SHA.\n" },
    })) as never;
    const { runDir, cleanup } = withRunDir();
    try {
      await runReview({
        env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt") },
        inputs: {
          "github-token": "tok", repo: "o/r", "pr-number": "7",
          "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
          "ci-status-check": "true", "requirement-trace": "true",
        },
        runDir, workspace: runDir, platformAdapter: platform,
        ciGate: { file: "", envAllowlist: [], workload: async () => { prBody = direction === "added" ? "Fixes #40" : "No linked issue."; return 0; } },
        persistArtifacts: true, quiet: true,
      });
      const ledger = JSON.parse(readFileSync(join(runDir, "requirement-ledger.json"), "utf8")) as { requirements: { id: string; text: string }[] };
      const reviewRequest = requests.at(-1) ?? "";
      if (direction === "added") {
        const req = ledger.requirements.find((r) => /source SHA/.test(r.text));
        assert.ok(req, "the refreshed ledger carries the linked-issue requirement");
        assert.match(reviewRequest, new RegExp(`trace scope \\(${req.id}\\)`));
      } else {
        assert.equal(ledger.requirements.some((r) => /source SHA/.test(r.text)), false);
        assert.doesNotMatch(reviewRequest, /trace scope \(/);
      }
    } finally {
      await server.close();
      cleanup();
    }
  });
}
