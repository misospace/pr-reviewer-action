import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, RunReviewError } from "../src/run/review.js";
import { runReviewEngine } from "../src/engine/review.js";
import type { ReviewRequest } from "../src/engine/types.js";
import { engineMain } from "../src/engine/cli.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0 }),
    getPrDiff: async () => "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => [],
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => null,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

function verdictBody(): string {
  return JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}

const inputs = { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": "", "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v3-engine-test-"));
  const runDir = join(root, "run");
  mkdirSync(runDir);
  return { root, runDir, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}
function request(aiBaseUrl: string, runDir: string): ReviewRequest {
  return { repository: "o/r", prNumber: "7", headSha: "a".repeat(40), baseRef: "", isForkPr: "false", platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"), inputs: { ...inputs, "ai-base-url": aiBaseUrl }, ambient: {}, triggerReason: "manual", forceRereview: false };
}

test("engine runs a full review without Action-only environment", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(request(server.url, f.runDir), { workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", stepSummaryPath: join(f.root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true });
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewRoute, "legacy");
    assert.match(result.marker, new RegExp("a".repeat(40)));
    for (const name of ["ai-output.json", "ai-request.primary.json", "ai-response.primary.json", "classification.json", "pr.json", "pr.diff", "pr-files.json", "review-corpus.md", "review-body.md", "verdict.txt"]) assert.ok(existsSync(join(f.runDir, name)), name);
    const provenance = readFileSync(join(f.runDir, "review-request.json"), "utf8");
    assert.match(provenance, /"trigger_reason": "manual"/);
    assert.match(provenance, /"force_rereview": false/);
    assert.doesNotMatch(provenance, /tok|\bk\b|token/i);
  } finally { await server.close(); f.cleanup(); }
});

test("the env adapter and engine produce identical structured results", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const engineRunDir = join(f.root, "engine-run");
  mkdirSync(engineRunDir);
  try {
    const adapterResult = await runReview({ env: { GITHUB_OUTPUT: "/dev/null", GITHUB_STEP_SUMMARY: "" }, inputs: { ...inputs, "ai-base-url": server.url }, runDir: f.runDir, workspace: f.root, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true });
    const engineResult = await runReviewEngine(request(server.url, engineRunDir), { workspace: f.root, runDir: engineRunDir, outputsSink: "/dev/null", stepSummaryPath: "", adapter: mockPlatform(), persistArtifacts: true, quiet: true });
    for (const key of ["outputs", "route", "routeReason", "analysisEngine", "classification", "verdictPolicy"] as const) assert.deepEqual(engineResult[key], adapterResult[key], key);
    assert.deepEqual([...engineResult.artifacts.keys()].sort(), [...adapterResult.artifacts.keys()].sort());
    for (const name of ["review-body.md", "verdict.txt", "ai-output.json"]) assert.equal(readFileSync(join(engineRunDir, name), "utf8"), readFileSync(join(f.runDir, name), "utf8"), name);
  } finally { await server.close(); f.cleanup(); }
});

test("pre-aborted engine request refuses to start", async () => {
  const f = fixture();
  try {
    await assert.rejects(runReviewEngine({ ...request("", f.runDir), signal: AbortSignal.abort() }, { workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", adapter: mockPlatform() }), (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
  } finally { f.cleanup(); }
});

test("engineMain accepts an explicit request file and reports usage errors", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const data = { ...request(server.url, f.runDir), workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", stepSummaryPath: "", persistArtifacts: true, ambient: { GITHUB_API_URL: server.url } };
    const file = join(f.root, "request.json");
    writeFileSync(file, JSON.stringify(data));
    assert.equal(await engineMain(["--request", file]), 0);
    assert.ok(existsSync(join(f.runDir, "review-request.json")));
    assert.equal(await engineMain(["--nope"]), 2);
  } finally { await server.close(); f.cleanup(); }
});
