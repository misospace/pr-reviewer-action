import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { forkGate } from "../src/gates/gates.js";
import { startMockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

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
    await runReview({
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

test("#796: an edited function with a caller becomes a harness obligation in the run's ledger", async () => {
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
      inputs: { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform({ diff, files: [{ filename: "pkg/auth.py", status: "modified", additions: 1, deletions: 1, changes: 2 }] }),
      persistArtifacts: true,
      quiet: true,
    });
    const ledger = JSON.parse(readFileSync(join(runDir, "requirement-ledger.json"), "utf8")) as { requirements: Array<{ text: string; provenance: Array<{ source: string; ref: string }> }> };
    const harness = ledger.requirements.filter((entry) => entry.provenance.some((p) => p.source === "harness" && p.ref === "pkg/auth.py"));
    assert.ok(harness.length > 0, `no harness obligation in ${JSON.stringify(ledger.requirements)}`);
    assert.match(harness[0]!.text, /get_session_token/);
    assert.match(harness[0]!.text, /client\.py/);
    assert.match(requests.at(-1) ?? "", /get_session_token/);
  } finally {
    await server.close();
    cleanup();
  }
});
