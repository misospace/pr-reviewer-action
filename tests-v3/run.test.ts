import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { forkGate } from "../src/gates/gates.js";
import { startMockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

/** A minimal in-memory platform adapter: the reads a small PR needs, served
 * without network. Everything else must not be reached by the pipeline with
 * the feature flags the tests set. */
function mockPlatform(options: { diff?: string; files?: unknown[]; title?: string; body?: string } = {}): PlatformReadAdapter {
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
        additions: 4,
        deletions: 1,
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
