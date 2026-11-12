import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, rawInputsFromEnv, RunReviewError } from "../src/run/review.js";
import { runReviewEngine, createRunCancellation, claimsPrepassGate } from "../src/engine/review.js";
import { harnessGatheredNoEvidence } from "../src/tools/execution-counts.js";
import { GateLaunchError, forkGate, type ForkedGate } from "../src/gates/gates.js";
import { runEngineAdmission, admissionStageEnv } from "../src/engine/admission.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";
import { actionStageEnv } from "../src/run/action.js";
import { collectConfigLines, computeConfigHash } from "../src/precheck/fingerprint.js";
import { validateContract } from "../src/config/contract.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { engineMain } from "../src/engine/cli.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", state: "open", draft: false, head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0 }),
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

/** Minimal GitHub REST reads for the engine-CLI tests: the engine CLI cannot
 * inject an adapter, so admission's platform reads (PR object, diff, file
 * list, managed-comment/review lists) go over the wire. The PR carries an
 * explicit `draft: false` and same-repo head/base identity, so admission's
 * deterministic gates (draft, fork) admit the run. */
function engineCliGithubHandler(): NonNullable<Parameters<typeof startMockServer>[0]> {
  return (req, _body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.includes("/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]));
      return;
    }
    if (url.includes("/pulls/7")) {
      if (req.headers.accept === "application/vnd.github.v3.diff") {
        res.setHeader("Content-Type", "text/plain");
        res.end("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
        return;
      }
      res.end(JSON.stringify({
        number: 7, state: "open", draft: false, title: "Update README", body: "",
        head: { sha: "a".repeat(40), ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    if (url.includes("/issues/7/comments") || url.includes("/pulls/7/reviews")) {
      res.end("[]");
      return;
    }
    res.setHeader("Connection", "close");
    res.end(verdictBody());
  };
}

/** An admission-focused platform mock: full read surface with configurable
 * managed comments, trusted identity, diff and head. Repo identity is
 * same-repo on both sides so `is_fork_pr` derives "false". */
function admissionAdapter(options: {
  headSha?: string;
  diff?: string;
  comments?: { body: string; author?: string }[];
  identity?: string | null;
  ghApi?: (endpoint: string) => Promise<{ data?: unknown; error?: string }>;
  getPr?: () => Promise<unknown | null>;
} = {}): PlatformReadAdapter {
  const headSha = options.headSha ?? "a".repeat(40);
  return {
    platform: "github",
    getPr: options.getPr ?? (async () => ({
      number: 7, title: "Update README", body: "", state: "open", draft: false,
      head: { sha: headSha, ref: "feature", repo: { full_name: "o/r" } },
      base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
      user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0,
      html_url: "https://github.com/o/r/pull/7",
    })),
    getPrDiff: async () => options.diff ?? "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => (options.comments ?? []).map((comment, index) => ({ id: index + 1, body: comment.body, created_at: "2026-01-01T00:00:00Z", author: comment.author ?? "ci-bot" })),
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => options.identity ?? null,
    ghApi: options.ghApi ?? (async () => ({ error: "not served" })),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
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

/** Engine dependencies over the shared fixture; `overrides` supplies the one
 * seam a cancellation test needs to control (a gate branch, a sink). */
function noopSink(): void {}
function engineDeps(root: string, runDir: string, overrides: Partial<ReviewDependencies> = {}): ReviewDependencies {
  return { workspace: root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: noopSink, error: noopSink, annotate: noopSink, ...overrides };
}

test("engine runs a full review without Action-only environment", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(request(server.url, f.runDir), { workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", stepSummaryPath: join(f.root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: noopSink, error: noopSink, annotate: noopSink });
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

test("the engine writes nothing implicitly to process streams when sinks are explicit", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const seen: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const spy = (stream: "stdout" | "stderr", original: typeof process.stdout.write): typeof process.stdout.write => {
    const patched = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("latin1");
      if (!text.startsWith("\u00FF\u000F")) seen.push(`${stream}:${JSON.stringify(text)}`);
      return original.call(process[stream], chunk as string, encoding, cb);
    }) as typeof process.stdout.write;
    return patched;
  };
  try {
    process.stdout.write = spy("stdout", originalStdoutWrite);
    process.stderr.write = spy("stderr", originalStderrWrite);
    const logLines: string[] = [];
    const result = await runReviewEngine(request(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), quiet: false, log: (line) => logLines.push(line), error: noopSink, annotate: noopSink });
    assert.equal(result.outputs.verdict, "approve");
    assert.ok(logLines.length > 0, "log sink received lines");
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await server.close(); f.cleanup();
  }
  assert.deepEqual(seen, [], "no implicit process-stream writes escaped the engine");
});

test("#1380: dependency-update classification drives the claim pass dependency mode end-to-end", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const adapter: PlatformReadAdapter = {
      ...mockPlatform(),
      getPr: async () => ({
        number: 7, title: "chore(deps): bump lodash from 1.2.3 to 4.5.6",
        body: "Only one file changed. No CRDs changed and the CRD schema is unchanged.",
        state: "open", draft: false, head: { sha: "a".repeat(40), ref: "renovate/lodash-4.x" }, base: { ref: "main" },
        user: { login: "someone" }, changed_files: 1, additions: 2, deletions: 2,
      }),
      getPrDiff: async () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,4 +1,4 @@\n-  \"version\": \"1.2.3\",\n-  \"lodash\": \"1.2.3\",\n+  \"version\": \"4.5.6\",\n+  \"lodash\": \"4.5.6\",\n",
      listPrFiles: async () => ({ ok: true, data: [{ filename: "package-lock.json", status: "modified", additions: 2, deletions: 2, changes: 4 }] }),
    };
    const req = request(server.url, f.runDir);
    req.inputs = { ...req.inputs, "claim-falsification": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter }));
    // #1381's must_check obligation rows are undisposed by the scripted
    // verdict; #1505: an undisposed row is COVERAGE, not a defect — the
    // verdict stays the model's own and the publish boundary withholds the
    // approval instead. This test pins claim-pass dependency mode, not the
    // verdict.
    assert.equal(result.outputs.verdict, "approve");
    const classification = JSON.parse(readFileSync(join(f.runDir, "classification.json"), "utf8")) as { pr_kind?: string };
    assert.equal(classification.pr_kind, "dependency_upgrade");
    const claimRequests = server.requests.filter((r) => r.body.includes("You extract the claims a pull request makes"));
    assert.equal(claimRequests.length, 1);
    assert.match(claimRequests[0]!.body, /Machine-generated dependency metadata/);
    const record = JSON.parse(readFileSync(join(f.runDir, "claim-falsification.json"), "utf8")) as {
      claims: { claim: string }[];
      status: string;
    };
    const texts = record.claims.map((c) => c.claim);
    assert.ok(texts.some((t) => t.includes("CRD schema is unchanged")), JSON.stringify(texts));
    assert.ok(!texts.some((t) => t.includes("Only one file changed")), JSON.stringify(texts));
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1521: the engine result carries the obligation rows that blocked the review", async () => {
  // The same dependency-update fixture the #1380 test above uses. Under
  // #1505 its undisposed `must_check` rows are `unresolved` (an availability
  // failure — coverage, never a defect): they withhold the trusted approval
  // but never manufacture a blocking request, so the verdict is NOT forced to
  // `request_changes` and NO row rides as a blocking obligation. (The unmet
  // case that does force `request_changes` and does ride is pinned by the
  // #1380 test's unmet run below.) A controller must be able to name WHAT
  // blocked a review, not only count it.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const adapter: PlatformReadAdapter = {
      ...mockPlatform(),
      getPr: async () => ({
        number: 7, title: "chore(deps): bump lodash from 1.2.3 to 4.5.6",
        body: "Only one file changed. No CRDs changed and the CRD schema is unchanged.",
        state: "open", draft: false, head: { sha: "a".repeat(40), ref: "renovate/lodash-4.x" }, base: { ref: "main" },
        user: { login: "someone" }, changed_files: 1, additions: 2, deletions: 2,
      }),
      getPrDiff: async () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,4 +1,4 @@\n-  \"version\": \"1.2.3\",\n-  \"lodash\": \"1.2.3\",\n+  \"version\": \"4.5.6\",\n+  \"lodash\": \"4.5.6\",\n",
      listPrFiles: async () => ({ ok: true, data: [{ filename: "package-lock.json", status: "modified", additions: 2, deletions: 2, changes: 4 }] }),
    };
    const req = request(server.url, f.runDir);
    req.inputs = { ...req.inputs, "claim-falsification": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter }));
    // #1505: unresolved rows are coverage, never a block — the verdict is
    // not forced and no blocking obligation rides.
    assert.equal(result.outputs.verdict, "approve");
    const rows = result.unresolvedReviewObligations;
    assert.ok(rows !== undefined, "the engine result carries the blocking rows");
    assert.deepEqual(rows, [], "an unresolved row is coverage, never a block");
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1521: the model-unavailable notice names no obligation row, because no obligation blocked it", async () => {
  // The same dependency-update fixture, but the model never answers. The
  // notice's own `request_changes` is the whole block: no enforcement
  // overlay runs on that path, so no obligation row blocked the review.
  // Publishing the fallback `must_check` rows as "what blocked it" would
  // tell a controller the review failed checks it never performed.
  const deadServer = await startMockServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end('{"error":"down"}');
  });
  const f = fixture();
  try {
    const adapter: PlatformReadAdapter = {
      ...mockPlatform(),
      getPr: async () => ({
        number: 7, title: "chore(deps): bump lodash from 1.2.3 to 4.5.6",
        body: "Only one file changed. No CRDs changed and the CRD schema is unchanged.",
        state: "open", draft: false, head: { sha: "a".repeat(40), ref: "renovate/lodash-4.x" }, base: { ref: "main" },
        user: { login: "someone" }, changed_files: 1, additions: 2, deletions: 2,
      }),
      getPrDiff: async () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,4 +1,4 @@\n-  \"version\": \"1.2.3\",\n-  \"lodash\": \"1.2.3\",\n+  \"version\": \"4.5.6\",\n+  \"lodash\": \"4.5.6\",\n",
      listPrFiles: async () => ({ ok: true, data: [{ filename: "package-lock.json", status: "modified", additions: 2, deletions: 2, changes: 4 }] }),
    };
    const req = request(deadServer.url, f.runDir);
    req.inputs = { ...req.inputs, "on-model-failure": "notice", "ai-primary-retries": "0", "ai-primary-retry-delay-sec": "0" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter }));
    assert.equal(result.outputs.verdict, "request_changes", "the notice is the block");
    assert.deepEqual(result.unresolvedReviewObligations, [], "no obligation row blocked the review");
  } finally {
    await deadServer.close();
    f.cleanup();
  }
});

test("#1448: the derived-obligations pre-pass runs on the primary route and its section reaches the final corpus", async () => {
  const obligationsPayload = JSON.stringify({
    obligations: [{
      obligation: "Both enqueue producers must place the integration identity before generation hashing.",
      change: "generationId() now hashes an integration field; only one producer supplies it.",
      topology: "producer_convergence",
      paths: ["src/ingress/reconcile.ts:mintFoundJob"],
      basis: "The hashed canonical tuple changed and one mint site does not pass the new field.",
    }],
  });
  const server = await startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (body.includes("You derive the architectural obligations")) {
      res.end(JSON.stringify({ id: "d1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: obligationsPayload }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } }));
      return;
    }
    res.end(verdictBody());
  });
  const f = fixture();
  try {
    const req = request(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter: mockPlatform() }));
    // #1449: the derived obligation now joins the AUTHORITATIVE enforcement
    // path — an undisposed derived row makes the review INCOMPLETE, so the
    // trusted approve is withheld (at the publish boundary) without a
    // synthesized finding and without a manufactured blocking request.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unresolved");
    const deriveRequests = server.requests.filter((r) => r.body.includes("You derive the architectural obligations"));
    assert.equal(deriveRequests.length, 1);
    assert.match(deriveRequests[0]!.body, /untrusted PR content/);
    const record = JSON.parse(readFileSync(join(f.runDir, "derived-obligations.json"), "utf8")) as {
      status: string; method: string; obligations: { topology: string }[]; section_bytes: number;
    };
    assert.equal(record.status, "ok");
    assert.equal(record.method, "model");
    assert.equal(record.obligations[0]?.topology, "producer_convergence");
    assert.ok(record.section_bytes > 0);
    const corpus = readFileSync(join(f.runDir, "review-corpus.md"), "utf8");
    assert.match(corpus, /# Derived Architectural Obligations/);
    assert.match(corpus, /mintFoundJob/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1448: a failing derivation renders a visible unavailable note in the corpus, never silence", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    // The verdict JSON carries no obligations array: malformed for this
    // pass, which must surface rather than read as "no obligations".
    res.end(verdictBody());
  });
  const f = fixture();
  try {
    const req = request(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter: mockPlatform() }));
    // #1449: a derivation that did not complete is incomplete COVERAGE, so
    // the synthetic coverage-marker row withholds the trusted approve.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unavailable");
    const record = JSON.parse(readFileSync(join(f.runDir, "derived-obligations.json"), "utf8")) as { status: string; error_kind: string | null };
    assert.equal(record.status, "error");
    assert.equal(record.error_kind, "malformed");
    const state = JSON.parse(readFileSync(join(f.runDir, "derived-obligation-state.json"), "utf8")) as {
      coverage: string; reason: string | null; obligations: Array<{ id: string; status: string; cause: string | null }>;
    };
    assert.equal(state.coverage, "incomplete");
    assert.equal(state.reason, "derivation-error");
    assert.deepEqual(state.obligations.map((row) => [row.id, row.status, row.cause]), [["derived-coverage", "unresolved", "derivation-incomplete"]]);
    const corpus = readFileSync(join(f.runDir, "review-corpus.md"), "utf8");
    assert.match(corpus, /# Derived Architectural Obligations/);
    assert.match(corpus, /did not complete for this run \(reason: malformed\)/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1448: disabled derived-obligations records no artifact and adds no corpus section", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const f = fixture();
  try {
    const result = await runReviewEngine(request(server.url, f.runDir), engineDeps(f.root, f.runDir, { adapter: mockPlatform() }));
    assert.equal(result.outputs.verdict, "approve");
    assert.ok(!existsSync(join(f.runDir, "derived-obligations.json")));
    assert.ok(!server.requests.some((r) => r.body.includes("You derive the architectural obligations")));
    assert.ok(!readFileSync(join(f.runDir, "review-corpus.md"), "utf8").includes("Derived Architectural Obligations"));
  } finally {
    await server.close();
    f.cleanup();
  }
});

// ── #1448 review: input completeness (truncated-diff blinding) ──────────

/** A source-rank chunk of roughly `lines` × 45 bytes. */
function diffChunk(path: string, tag: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+${tag} filler line ${i} ${"a".repeat(24)}`);
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,3 +1,${lines + 2} @@`, " context", ...body, " more", ""].join("\n");
}

const DERIVE_PAYLOAD = JSON.stringify({
  obligations: [{
    obligation: "Both enqueue producers must place the integration identity before generation hashing.",
    change: "generationId() now hashes an integration field; only one producer supplies it.",
    topology: "producer_convergence",
    paths: ["src/ingress/reconcile.ts:mintFoundJob"],
    basis: "The hashed canonical tuple changed and one mint site does not pass the new field.",
  }],
});
const DERIVE_EMPTY = JSON.stringify({ obligations: [] });

test("#1448 review: the derivation is fed the complete diff, not the prioritized slice", async () => {
  // The obligation-triggering hunk lives in a generated-rank chunk
  // (`*.min.js`), which `prioritizeDiff` drops whole from
  // `pr.diff.truncated` under a tight budget. The mock model reports the
  // obligation only when the request body actually contains the hunk, so a
  // derivation fed the prioritized slice comes back `empty` — exactly the
  // silent blind spot the complete-diff feed pins out (#1449 consumes this).
  const sentinel = "+const IDENTITY_HUNK_SENTINEL = \"reconciliation-must-place-integration-id-before-hash\";";
  const fullDiff = [
    diffChunk("src/one.ts", "one", 55),
    diffChunk("src/two.ts", "two", 55),
    diffChunk("src/three.ts", "three", 55),
    ["diff --git a/dist/app.min.js b/dist/app.min.js", "--- a/dist/app.min.js", "+++ b/dist/app.min.js", "@@ -1,3 +1,5 @@", " generated bundle", sentinel, " more bundle", ""].join("\n"),
  ].join("\n");
  const adapter = {
    ...mockPlatform(),
    getPrDiff: async () => fullDiff,
    listPrFiles: async () => ({ ok: true, data: ["src/one.ts", "src/two.ts", "src/three.ts", "dist/app.min.js"].map((filename) => ({ filename, status: "modified", additions: 50, deletions: 1, changes: 51 })) }),
  } as unknown as PlatformReadAdapter;
  const server = await startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (body.includes("You derive the architectural obligations")) {
      res.end(JSON.stringify({ id: "d1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: body.includes("IDENTITY_HUNK_SENTINEL") ? DERIVE_PAYLOAD : DERIVE_EMPTY }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } }));
      return;
    }
    res.end(verdictBody());
  });
  const f = fixture();
  try {
    const req = request(server.url, f.runDir);
    req.inputs = {
      ...req.inputs,
      "derived-obligations": "true",
      // Corpus budgets derive independently of the loop fit (AI_MAX_TOKENS +
      // 2,000 headroom): this window floors maxDiff at ~7.4 KB, so the
      // ~8.7 KB diff cannot fit the prioritized slice whole and the
      // generated-rank sentinel chunk is dropped from it entirely. The small
      // explicit per-turn completion keeps the loop's own preflight (which
      // also reserves framing and the advertised tool schemas, #1635)
      // satisfiable at this window.
      "primary-model-context-tokens": "22500",
      "tool-max-tokens-per-turn": "400",
    };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter }));
    // #1449: the derivation is a review target AND an enforcement input —
    // an undisposed derived obligation withholds the trusted approve.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unresolved");
    // The trap is real at this budget: the prioritized slice omitted the hunk…
    const truncated = readFileSync(join(f.runDir, "pr.diff.truncated"), "utf8");
    assert.ok(!truncated.includes("IDENTITY_HUNK_SENTINEL"), "fixture precondition: the sentinel must be outside pr.diff.truncated");
    // …but the derivation saw it through the complete diff.
    const deriveRequests = server.requests.filter((r) => r.body.includes("You derive the architectural obligations"));
    assert.equal(deriveRequests.length, 1);
    assert.ok(deriveRequests[0]!.body.includes("IDENTITY_HUNK_SENTINEL"), "the derivation must receive the complete diff");
    const record = JSON.parse(readFileSync(join(f.runDir, "derived-obligations.json"), "utf8")) as {
      status: string; diff_source: string; diff_clipped: boolean; input_complete: boolean; obligations: { topology: string }[];
    };
    assert.equal(record.status, "ok");
    assert.equal(record.diff_source, "full");
    assert.equal(record.diff_clipped, false);
    assert.equal(record.input_complete, true);
    assert.equal(record.obligations[0]?.topology, "producer_convergence");
    const corpus = readFileSync(join(f.runDir, "review-corpus.md"), "utf8");
    assert.match(corpus, /# Derived Architectural Obligations/);
    assert.match(corpus, /mintFoundJob/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1448 review: a clipped derivation input renders incomplete coverage, never a silent empty", async () => {
  // The obligation-triggering hunk sits beyond the pass's own 48 KB input
  // clip, so the model can only return an empty derivation. The run must
  // surface that as unavailable coverage (reason: input-clipped) and record
  // input_complete=false: an `empty` over an unseen tail is not "no
  // obligations", and #1449 must be able to fail toward partial.
  const sentinel = "+const IDENTITY_HUNK_SENTINEL = \"reconciliation-must-place-integration-id-before-hash\";";
  const fullDiff = [
    diffChunk("src/generated-filler.ts", "filler", 1150),
    ["diff --git a/src/mint-site.ts b/src/mint-site.ts", "--- a/src/mint-site.ts", "+++ b/src/mint-site.ts", "@@ -1,3 +1,5 @@", " context", sentinel, " more", ""].join("\n"),
  ].join("\n");
  const adapter = {
    ...mockPlatform(),
    getPrDiff: async () => fullDiff,
    listPrFiles: async () => ({ ok: true, data: [{ filename: "src/generated-filler.ts", status: "modified", additions: 1150, deletions: 1, changes: 1151 }, { filename: "src/mint-site.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }] }),
  } as unknown as PlatformReadAdapter;
  const server = await startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (body.includes("You derive the architectural obligations")) {
      res.end(JSON.stringify({ id: "d1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: body.includes("IDENTITY_HUNK_SENTINEL") ? DERIVE_PAYLOAD : DERIVE_EMPTY }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } }));
      return;
    }
    res.end(verdictBody());
  });
  const f = fixture();
  try {
    const req = request(server.url, f.runDir);
    req.inputs = { ...req.inputs, "derived-obligations": "true" };
    const result = await runReviewEngine(req, engineDeps(f.root, f.runDir, { adapter }));
    // #1449: the clipped input is incomplete COVERAGE, so the synthetic
    // coverage-marker row withholds the trusted approve.
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.outputs.reviewResult, "partial");
    assert.equal(result.derivedObligationState, "unavailable");
    // The pass clipped its input: the hunk never reached the model.
    const deriveRequests = server.requests.filter((r) => r.body.includes("You derive the architectural obligations"));
    assert.equal(deriveRequests.length, 1);
    assert.ok(!deriveRequests[0]!.body.includes("IDENTITY_HUNK_SENTINEL"));
    assert.ok(deriveRequests[0]!.body.includes("[diff truncated]"));
    const record = JSON.parse(readFileSync(join(f.runDir, "derived-obligations.json"), "utf8")) as {
      status: string; diff_source: string; diff_clipped: boolean; input_complete: boolean; obligations: unknown[];
    };
    assert.equal(record.status, "empty");
    assert.equal(record.diff_source, "full");
    assert.equal(record.diff_clipped, true);
    assert.equal(record.input_complete, false);
    assert.equal(record.obligations.length, 0);
    // …and the corpus says coverage is unavailable instead of reading clean.
    const corpus = readFileSync(join(f.runDir, "review-corpus.md"), "utf8");
    assert.match(corpus, /did not complete for this run \(reason: input-clipped\)/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1380: the claim pre-pass gate is a pass-through outside dependency mode", async () => {
  const neverSettles: Promise<never> = new Promise(() => {});
  await claimsPrepassGate(false, neverSettles);
  // An unsettled evidence phase must not delay a non-dependency launch.
});

test("#1388: resolveReviewObligations stamps a cause on unresolved rows only — an unmet row is resolved negatively", async () => {
  // dependency_upgrade classifies with five must_check rows — the two
  // family checks plus the three #1379 dependency-evidence obligations; the
  // scripted verdict dispositions one `unmet` (exact text echo, grounded
  // rationale) and leaves the other four undisposed.
  const unmetCheck = "check for breaking API changes in updated dependencies";
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null,
      // #1627: one junk entry rides along — unattributable, dropped by the
      // parser, receipted end to end without touching any row's fold.
      required_check_dispositions: ["bare string", { check: unmetCheck, status: "unmet", rationale: "the dependency removed a exported symbol; breaking change confirmed" }],
    }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
  });
  const f = fixture();
  try {
    const adapter: PlatformReadAdapter = {
      ...mockPlatform(),
      getPr: async () => ({
        number: 7, title: "chore(deps): bump lodash from 1.2.3 to 4.5.6",
        body: "Only one file changed. No CRDs changed and the CRD schema is unchanged.",
        state: "open", draft: false, head: { sha: "a".repeat(40), ref: "renovate/lodash-4.x" }, base: { ref: "main" },
        user: { login: "someone" }, changed_files: 1, additions: 2, deletions: 2,
      }),
      getPrDiff: async () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,4 +1,4 @@\n-  \"version\": \"1.2.3\",\n-  \"lodash\": \"1.2.3\",\n+  \"version\": \"4.5.6\",\n+  \"lodash\": \"4.5.6\",\n",
      listPrFiles: async () => ({ ok: true, data: [{ filename: "package-lock.json", status: "modified", additions: 2, deletions: 2, changes: 4 }] }),
    };
    const logLines: string[] = [];
    const result = await runReviewEngine(request(server.url, f.runDir), { ...engineDeps(f.root, f.runDir, { adapter }), quiet: false, log: (line) => logLines.push(line) });
    // The unmet row forces request_changes (a confirmed negative); the
    // undisposed rows are unresolved COVERAGE (#1505) — they withhold the
    // trusted approve but do not force the block themselves.
    assert.equal(result.outputs.verdict, "request_changes");
    const persisted = JSON.parse(readFileSync(join(f.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ id: string; source: string; text: string; status: string; cause: string | null; reason?: string }>;
      required_check_disposition_receipt?: { dropped: Array<{ reason: string }>; cap_reached: boolean };
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.text, row.status, row.cause]), [
      [unmetCheck, "unmet", null],
      ["run full test suite after upgrade", "unresolved", "tool-capability"],
      ["establish upstream provenance for the updated dependency: publisher and canonical source repository", "unresolved", "tool-capability"],
      ["inspect the exact old→new upstream release delta for the updated dependency", "unresolved", "tool-capability"],
      ["check upstream security advisories for the updated dependency version range, or report the advisory check as not performed", "unresolved", "tool-capability"],
    ]);
    // #1627: every folded row carries its content-free reason — the unmet
    // row resolved (ok), the four undisposed rows never matched an answer.
    assert.deepEqual(persisted.obligations.map((row) => row.reason), ["ok", "no-disposition", "no-disposition", "no-disposition", "no-disposition"]);
    // #1627: the parser's drop receipt rides the fold artifact — the junk
    // entry is unattributable, so it can never be a per-row reason.
    assert.deepEqual(persisted.required_check_disposition_receipt, { dropped: [{ reason: "non-object-entry" }], cap_reached: false });
    // The one-line log is honest about the three states, and the #1627
    // reason summary (content-free counts, replacing the per-id detail —
    // the ids are persisted in review-obligations.json) says WHY the four
    // rows stayed unresolved: no disposition ever matched their identity.
    const obligationLog = logLines.find((line) => line.includes("Review obligations:"));
    assert.ok(obligationLog);
    assert.match(obligationLog!, /Review obligations: 5 total, 0 satisfied, 1 unmet, 4 unresolved \(no-disposition=4\)/);
    // #1627: the drop counts ride the same single line.
    assert.match(obligationLog!, /\| disposition-drops: non-object-entry=1$/);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1606: the evidence-cause consumer reads the successful count, so a run whose every tool call failed reads as gathering no evidence", () => {
  // The harness-written artifact shapes (#1597 partitions): the attempted
  // count and the successful count carry their own meanings.
  const allFailed = {
    planned_request_count: 2,
    executed_request_count: 2,
    successful_request_count: 0,
    tool_calls: [
      { tool: "read_file", args: { path: "missing.md" }, status: "error" },
      { tool: "list_dir", args: { path: "missing/" }, status: "error" },
    ],
    tool_results: [
      { tool: "read_file", status: "error", result: { error: "no such file" } },
      { tool: "list_dir", status: "error", result: { error: "no such directory" } },
    ],
  };
  assert.equal(harnessGatheredNoEvidence(allFailed), true, "a run whose every call failed gathered no evidence");
  const oneOk = {
    ...allFailed,
    successful_request_count: 1,
    tool_calls: [
      { tool: "read_file", args: { path: "src/a.ts" }, status: "ok" },
      { tool: "list_dir", args: { path: "missing/" }, status: "error" },
    ],
    tool_results: [
      { tool: "read_file", status: "ok", result: { content: "code" } },
      { tool: "list_dir", status: "error", result: { error: "no such directory" } },
    ],
  };
  assert.equal(harnessGatheredNoEvidence(oneOk), false, "one successful call is evidence");
  // An artifact that reports no successful count at all says nothing.
  assert.equal(harnessGatheredNoEvidence({}), false);
  assert.equal(harnessGatheredNoEvidence(null), false);
});

test("#1380: the claim pre-pass launches only after the evidence phase settles on a dependency update", async () => {
  let settleEvidence!: () => void;
  const evidencePhase = new Promise<void>((resolve) => { settleEvidence = () => resolve(); });
  let launched = false;
  const gate = claimsPrepassGate(true, evidencePhase).then(() => { launched = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(launched, false, "the pre-pass must not start while the evidence phase is still running");
  settleEvidence();
  await gate;
  assert.equal(launched, true, "the pre-pass must launch once the evidence phase has settled");
});

test("#1380: an evidence-phase rejection never blocks the claim pre-pass launch", async () => {
  const rejected: Promise<never> = Promise.reject(new Error("evidence phase failed"));
  rejected.catch(() => {});
  await claimsPrepassGate(true, rejected);
});

test("the env adapter and engine produce identical structured results", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const engineRunDir = join(f.root, "engine-run");
  mkdirSync(engineRunDir);
  try {
    const adapterResult = await runReview({ env: { GITHUB_OUTPUT: "/dev/null", GITHUB_STEP_SUMMARY: "" }, inputs: { ...inputs, "ai-base-url": server.url }, runDir: f.runDir, workspace: f.root, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true });
    const engineResult = await runReviewEngine(request(server.url, engineRunDir), { workspace: f.root, runDir: engineRunDir, outputsSink: "/dev/null", stepSummaryPath: "", adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: noopSink, error: noopSink, annotate: noopSink });
    for (const key of ["outputs", "route", "routeReason", "analysisEngine", "classification", "verdictPolicy"] as const) assert.deepEqual(engineResult[key], adapterResult[key], key);
    // #1381: the candidates artifact is HARNESS-authored, and the two paths
    // legitimately differ on it — the adapter path derives fork-ness
    // fail-closed from the PR object (no head-repo identity in this mock), so
    // the fork gate substitutes its own tool-harness artifacts and skips the
    // native loop. Everything else, including the ENGINE-authored
    // review-obligations.json, must stay symmetric.
    // #1506: the requirement-trace plan candidates artifact is
    // HARNESS-authored on the same seam (the harness writes the rows the
    // planner was shown), so it is absent on the fork-gated adapter path for
    // the same reason. The ENGINE-authored requirement-trace-plan.json stays
    // symmetric.
    const harnessAuthored = (name: string): boolean =>
      name === "review-obligations-candidates.json" || name === "requirement-trace-plan-candidates.json";
    const engineNames = [...engineResult.artifacts.keys()].filter((name) => !harnessAuthored(name)).sort();
    const adapterNames = [...adapterResult.artifacts.keys()].filter((name) => !harnessAuthored(name)).sort();
    assert.deepEqual(engineNames, adapterNames);
    const obligationsCount = (names: string[]): number => names.filter((name) => name === "review-obligations.json").length;
    assert.equal(obligationsCount([...engineResult.artifacts.keys()]), obligationsCount([...adapterResult.artifacts.keys()]));
    for (const name of ["review-body.md", "verdict.txt", "ai-output.json"]) assert.equal(readFileSync(join(engineRunDir, name), "utf8"), readFileSync(join(f.runDir, name), "utf8"), name);
  } finally { await server.close(); f.cleanup(); }
});

test("pre-aborted engine request refuses to start", async () => {
  const f = fixture();
  try {
    await assert.rejects(runReviewEngine({ ...request("", f.runDir), signal: AbortSignal.abort() }, { workspace: f.root, runDir: f.runDir, outputsSink: "/dev/null", adapter: mockPlatform(), log: noopSink, error: noopSink, annotate: noopSink }), (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
  } finally { f.cleanup(); }
});

test("cancelling mid-flight rejects the run instead of returning the in-flight model verdict", async () => {
  // Deterministic seam: the provider answers only AFTER the cancellation
  // landed, so the engine is handed a complete, approving verdict it must
  // still refuse — no sleeps, no wall-clock race.
  const controller = new AbortController();
  let answered!: () => void;
  const modelAnswered = new Promise<void>((resolve) => { answered = resolve; });
  const server = await startMockServer((_req, _body, res) => {
    controller.abort(); // cancellation lands while the primary model request is in flight
    // The answer goes out on the next macrotask, strictly after the abort.
    setImmediate(() => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Connection", "close");
      res.end(verdictBody());
      answered();
    });
  });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine({ ...request(server.url, f.runDir), signal: controller.signal }, engineDeps(f.root, f.runDir)),
      (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message),
    );
    // The cancelled run produced no publishable verdict surface.
    assert.ok(!existsSync(join(f.runDir, "verdict.txt")), "verdict.txt");
    assert.ok(!existsSync(join(f.runDir, "review-body.md")), "review-body.md");
    // The caller's abort listener is detached: a long-lived worker signal
    // must not retain a finished run.
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    // The cancelled request was answered anyway — the verdict arrived too
    // late to be accepted, and the run never handed one out.
    await modelAnswered;
  } finally { await server.close(); f.cleanup(); }
});

test("cancelling mid-flight tears the in-flight provider request down", async () => {
  // #726 (round-3 review): racing the pipeline is not enough — the active
  // model request must receive the cancellation and physically stop.
  const controller = new AbortController();
  let tornDown!: () => void;
  const closed = new Promise<void>((resolve) => { tornDown = resolve; });
  const live: { res: { destroy(): void } | null } = { res: null };
  const server = await startMockServer((_req, _body, res) => {
    live.res = res;
    res.on("close", () => tornDown());
    // The cancellation lands while the primary model request is in flight;
    // the server never answers, so only the client-side teardown closes it.
    controller.abort();
  });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine({ ...request(server.url, f.runDir), signal: controller.signal }, engineDeps(f.root, f.runDir)),
      (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message),
    );
    // Hang guard (same pattern as the gate test): a regression that abandons
    // the provider request fails the assertion instead of hanging the suite.
    const torn = await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000))]);
    assert.equal(torn, true, "the in-flight provider request was physically torn down");
  } finally {
    try { live.res?.destroy(); } catch { /* already closed */ }
    await server.close(); f.cleanup();
  }
});

test("cancelling mid-flight finalizes the gate fork the run still owns", async () => {
  // The model is never reached: the run is cancelled while the CI gate is
  // still in flight. The server only supplies a resolvable `ai-base-url`.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  const controller = new AbortController();
  let gateStarted!: () => void;
  const gateInFlight = new Promise<void>((resolve) => { gateStarted = resolve; });
  let releaseGate!: () => void;
  const gateReleased = new Promise<number>((resolve) => { releaseGate = () => resolve(1); });
  let gateTerminated = false;
  try {
    const running = runReviewEngine(
      { ...request(server.url, f.runDir), signal: controller.signal, inputs: { ...inputs, "ai-base-url": server.url, "ci-status-check": "true" } },
      engineDeps(f.root, f.runDir, {
        ciGate: {
          file: "",
          envAllowlist: [],
          // Stands in for the CI-gate child: it runs until the engine cuts it,
          // so the run is cancelled with an owned fork still outstanding.
          workload: async (signal: AbortSignal) => {
            signal.addEventListener("abort", () => { gateTerminated = true; releaseGate(); }, { once: true });
            // Report the gate in flight only once the fork's own promise chain
            // settled, so the engine has already taken ownership of it.
            await new Promise<void>((resolve) => { setImmediate(resolve); });
            gateStarted();
            return gateReleased;
          },
        },
      }),
    );
    await gateInFlight;
    controller.abort();
    // Hang guard: a regression that never finalizes the fork unblocks it on
    // the next macrotask and fails the assertion below instead of hanging.
    const escape = setImmediate(releaseGate);
    try {
      await assert.rejects(running, (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
      // finalize() is awaited before the rejection is observable: no owned
      // gate child outlives the cancelled run.
      assert.equal(gateTerminated, true, "the outstanding owned gate fork was aborted");
      assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    } finally { clearImmediate(escape); }
  } finally { releaseGate(); await server.close(); f.cleanup(); }
});

test("cancelling while a gate fork is launching still awaits its termination", async () => {
  // #726 review: a fork whose launch races the abort must not be cut and
  // forgotten un-awaited. The abort lands inside the gate workload, i.e.
  // while the engine is still awaiting forkGate(), so the fork's registration
  // (own()) races the cancellation rejection — finalize() drains that cut, so
  // the rejection never becomes observable while the child is winding down.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  const controller = new AbortController();
  let gateTerminated = false;
  let releaseGate!: () => void;
  const gateGone = new Promise<void>((resolve) => { releaseGate = resolve; });
  try {
    const running = runReviewEngine(
      { ...request(server.url, f.runDir), signal: controller.signal, inputs: { ...inputs, "ai-base-url": server.url, "ci-status-check": "true" } },
      engineDeps(f.root, f.runDir, {
        ciGate: {
          file: "",
          envAllowlist: [],
          workload: async (signal: AbortSignal) => {
            signal.addEventListener("abort", () => {
              setImmediate(() => { gateTerminated = true; releaseGate(); });
            }, { once: true });
            controller.abort();
            await gateGone;
            return 1;
          },
        },
      }),
    );
    await assert.rejects(running, (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
    // Deterministic in both directions: with the fix, finalize() awaits the
    // registered cut (the macrotask above has run); a regression that abandons
    // the fork observes false here instead of hanging.
    assert.equal(gateTerminated, true, "the launch-raced fork's termination was awaited before the rejection");
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  } finally { releaseGate(); await server.close(); f.cleanup(); }
});

test("#1183: a claimed fork whose launch lands after the abort is cut and awaited before finalize returns", async () => {
  // The launch-suspension seam for the PROCESS path: a controlled launch
  // handed to claimFork stands in for the forkGate launch that suspends on
  // its preflight/launch probes. The window the old own()-after-await left:
  // finalize used to be able to close its final empty pass before the fork
  // landed, making the cancellation rejection observable while the child's
  // termination was not yet awaited.
  const controller = new AbortController();
  const cancellation = createRunCancellation({ ...request("", "/run-dir"), signal: controller.signal });
  let settleLaunch!: (fork: ForkedGate) => void;
  const launch = new Promise<ForkedGate>((resolve) => { settleLaunch = resolve; });
  let cutStarted = false;
  let settleCut!: () => void;
  const cut = new Promise<void>((resolve) => { settleCut = resolve; });
  const fork: ForkedGate = {
    gate: "ci",
    join: async () => { throw new Error("a cut fork is never joined"); },
    abort: async () => { cutStarted = true; await cut; },
  };
  const claimed = cancellation.claimFork(launch);
  controller.abort();
  // The rejection is observable now; the drain must still be open.
  await assert.rejects(cancellation.cancelled, (error: unknown) => error instanceof RunReviewError && /cancelled/.test(error.message));
  let finalized = false;
  const draining = cancellation.finalize().then(() => { finalized = true; });
  // A regression to own()-after-await closes finalize on its first (empty)
  // pass immediately: give it every macrotask chance to do exactly that.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(finalized, false, "finalize must stay pending while a claimed launch has not landed");
  settleLaunch(fork);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(finalized, false, "finalize must stay pending while the landed fork's cut is outstanding");
  settleCut();
  // Hang guard: a drain that never completes fails here instead of hanging
  // the suite (same pattern as the gate tests above).
  const escaped = await Promise.race([
    draining.then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 2000); }),
  ]);
  assert.equal(escaped, true, "finalize completes once the landed fork's termination has");
  assert.equal(cutStarted, true, "the landed fork was cut");
  assert.equal(await claimed, fork, "the claim hands the landed fork to the caller");
});

test("#1183: a claimed launch that is refused drains finalize and surfaces the refusal to the claimer", async () => {
  const controller = new AbortController();
  const cancellation = createRunCancellation({ ...request("", "/run-dir"), signal: controller.signal });
  let refuseLaunch!: (error: Error) => void;
  const launch = new Promise<ForkedGate>((_resolve, reject) => { refuseLaunch = reject; });
  const claimed = cancellation.claimFork(launch);
  controller.abort();
  // The unsettled claim keeps the drain open exactly like a landing one…
  let finalized = false;
  const draining = cancellation.finalize().then(() => { finalized = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(finalized, false, "finalize must stay pending while a claimed launch has not settled");
  // …and once the launch is refused, nothing was ever launched, so the drain
  // completes rather than hanging or waiting on a fork that never lands.
  refuseLaunch(new GateLaunchError("ci", "launch refused"));
  const escaped = await Promise.race([
    draining.then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 2000); }),
  ]);
  assert.equal(escaped, true, "finalize drains a refused claimed launch");
  await assert.rejects(claimed, (error: unknown) => error instanceof GateLaunchError && /launch refused/.test(error.message));
});

test("#1183: an abort inside the real fork launch window refuses the spawn with no child un-awaited", async () => {
  // Same race against the REAL process path: the claim registers before
  // forkGate suspends on its pgrep preflight, and the abort is delivered
  // synchronously right after the claim — spawn can only ever happen a
  // macrotask later, so this deterministically lands inside the launch
  // suspension. runProcess then refuses the pre-aborted launch, forkGate
  // surfaces the refusal, and the claim drain completes cleanly: no child
  // exists to outlive the run un-awaited.
  const controller = new AbortController();
  const cancellation = createRunCancellation({ ...request("", "/run-dir"), signal: controller.signal });
  const claimed = cancellation.claimFork(forkGate("ci", {
    file: "bash",
    args: ["-c", "sleep 60"],
    envAllowlist: ["PATH", "HOME"],
  }, {
    ambientEnv: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    scope: cancellation.scope,
  }));
  controller.abort();
  const escaped = await Promise.race([
    cancellation.finalize().then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 5000); }),
  ]);
  assert.equal(escaped, true, "finalize drains the real refused launch");
  await assert.rejects(claimed, (error: unknown) => error instanceof GateLaunchError && /cancelled before launch/.test(error.message));
});

test("a completed run detaches from the caller's signal", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  const controller = new AbortController();
  try {
    const result = await runReviewEngine({ ...request(server.url, f.runDir), signal: controller.signal }, engineDeps(f.root, f.runDir));
    assert.equal(result.outputs.verdict, "approve");
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  } finally { await server.close(); f.cleanup(); }
});

test("a symlinked artifact name in the run dir cannot escape the engine's write boundary", async () => {
  // Required-check pin (edge-case paths): a full engine run whose run dir
  // carries a planted symlink must refuse the mirrored write outside it.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close"); res.end(verdictBody()); });
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const outsideFile = join(outside, "verdict.txt");
  writeFileSync(outsideFile, "SENTINEL");
  symlinkSync(outsideFile, join(f.runDir, "verdict.txt"));
  try {
    const result = await runReviewEngine(request(server.url, f.runDir), engineDeps(f.root, f.runDir));
    // The in-memory artifact bus is authoritative, so the review completes…
    assert.equal(result.outputs.verdict, "approve");
    // …but the guarded disk mirror refused to follow the symlink out.
    assert.equal(readFileSync(outsideFile, "utf8"), "SENTINEL", "nothing was written through the symlink");
  } finally { await server.close(); f.cleanup(); }
});

test("a null byte in the CLI request's runDir fails clean without writing outside", async () => {
  // Required-check pin (edge-case paths): the engine CLI boundary never
  // throws an unsurfaced error and never writes through a poisoned path.
  const server = await startMockServer(engineCliGithubHandler());
  const f = fixture();
  try {
    const poisoned = `${f.runDir}\u0000escape`;
    const data = { ...request(server.url, poisoned), workspace: f.root, runDir: poisoned, outputsSink: "/dev/null", stepSummaryPath: "", persistArtifacts: true, ambient: { GITHUB_API_URL: server.url } };
    const file = join(f.root, "nul-request.json");
    writeFileSync(file, JSON.stringify(data));
    const code = await engineMain(["--request", file]);
    assert.ok(code === 0 || code === 1, `clean exit code, got ${code}`);
    // The review really ran (platform reads and the model call reached the
    // mock endpoint) while every disk mirror was refused: the untouched real
    // run dir holds nothing.
    assert.ok(server.requests.length > 0, "the pipeline executed against the mocked endpoints");
    assert.ok(!existsSync(join(f.runDir, "review-request.json")), "no artifacts in the real run dir");
    assert.deepEqual(readdirSync(f.runDir), [], "the real run dir stayed empty");
  } finally { await server.close(); f.cleanup(); }
});

test("engineMain accepts an explicit request file and reports usage errors", async () => {
  const server = await startMockServer(engineCliGithubHandler());
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

// ── #726: engine-owned admission (precheck/fingerprint decision) ─────────

/** Admission fixtures pin deterministic fingerprints, so deep_review=auto
 * (the contract default, whose failed selection injects a per-run unique
 * sentinel into the config hash) is explicitly off. */
const admissionInputs = { ...inputs, "deep-review": "false" };

function admissionRequest(
  aiBaseUrl: string,
  runDir: string,
  overrides: Partial<ReviewRequest> & { inputsOverrides?: Record<string, string> } = {},
): ReviewRequest {
  const { inputsOverrides, ...rest } = overrides;
  return {
    ...request(aiBaseUrl, runDir),
    inputs: { ...admissionInputs, "ai-base-url": aiBaseUrl, ...inputsOverrides },
    ...rest,
  };
}

test("engine admission: a fresh event is admitted and the review runs", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, { event: { name: "pull_request", action: "synchronize" }, eventHeadSha: "a".repeat(40) }),
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, true);
    assert.equal(result.skipReason, "");
    assert.equal(result.outputs.verdict, "approve");
    assert.equal(result.admission.should_review, "true");
    assert.equal(result.admission.head_sha, "a".repeat(40));
    assert.equal(result.admission.base_sha, "b".repeat(40));
    assert.equal(result.admission.is_fork_pr, "false");
    assert.equal(result.admissionBaseSha, "b".repeat(40));
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a failed PR lookup fails the run, never a green skip (#1312)", async () => {
  // Pins the host-level half of the #1312 doctrine: the null lookup rejects
  // through the engine, so no host adapter can turn a forge/API outage into
  // a successful no-review result without tripping this test.
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine(
        admissionRequest(server.url, f.runDir, { event: { name: "pull_request", action: "synchronize" }, eventHeadSha: "a".repeat(40) }),
        { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter({ getPr: async () => null }) },
      ),
      /Could not read pull request .*refusing to treat a forge\/API lookup failure as a successful review skip/,
    );
    assert.equal(server.requests.length, 0, "a failed admission lookup must never reach the model");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: an unchanged diff with a stored fingerprint skips with no model spend", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    assert.equal(first.shouldReview, true);
    const fingerprint = first.diffFingerprint;
    assert.match(fingerprint, /\|cfg:/);
    const requestsAfterFirst = server.requests.length;
    assert.ok(requestsAfterFirst > 0, "the first run reached the model");
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const second = await runReviewEngine(
      admissionRequest(server.url, runDir2),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
          identity: "ci-bot",
        }),
      },
    );
    assert.equal(second.shouldReview, false);
    assert.equal(second.skipReason, "diff-unchanged");
    assert.equal(second.diffFingerprint, fingerprint);
    // A plain fingerprint skip carries no resolved SHAs (the precheck skip
    // surface leaves head/base empty); the review path resolves them.
    assert.equal(second.admissionBaseSha, "");
    assert.equal(second.outputs.verdict, "");
    assert.equal(server.requests.length, requestsAfterFirst, "the skip made no model call");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a diff-unchanged skip carries the previous verdict on the result", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const requestsAfterFirst = server.requests.length;
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const second = await runReviewEngine(
      admissionRequest(server.url, runDir2),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{
            body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
<!-- ai-pr-reviewer: {"review_result":"clean","head_sha":"${"a".repeat(40)}"} -->
`,
            author: "ci-bot",
          }],
          identity: "ci-bot",
        }),
      },
    );
    assert.equal(second.shouldReview, false);
    assert.equal(second.skipReason, "diff-unchanged");
    assert.equal(second.admission.verdict, "approve");
    assert.equal(second.admission.verdict_source, "carry_forward");
    assert.equal(second.admission.review_result, "clean");
    assert.equal(second.admission.head_sha, "a".repeat(40));
    assert.equal(server.requests.length, requestsAfterFirst, "the carried skip made no model call at all");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a stale gate head sha skips superseded-head with no model spend", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, {
        event: { name: "issue_comment", action: "created", comment: { id: 5, body: "/ai-review", user: "maintainer" } },
        ambient: { PR_REVIEWER_GATE_HEAD_SHA: "c".repeat(40) },
        inputsOverrides: { "rereview-command": "/ai-review" },
      }),
      {
        ...engineDeps(f.root, f.runDir),
        adapter: admissionAdapter({
          ghApi: async (endpoint) => endpoint.includes("/collaborators/") ? { data: { permission: "write" } } : { error: "not served" },
        }),
      },
    );
    assert.equal(result.shouldReview, false);
    assert.equal(result.skipReason, "superseded-head");
    assert.equal(server.requests.length, 0, "the superseded skip made no model call");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: force rereview intent reviews despite a stored fingerprint", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const requestsAfterFirst = server.requests.length;
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const second = await runReviewEngine(
      admissionRequest(server.url, runDir2, { event: { name: "pull_request", action: "labeled", label: { name: "ai-review" } } }),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
          identity: "ci-bot",
        }),
      },
    );
    assert.equal(second.shouldReview, true);
    assert.ok(server.requests.length > requestsAfterFirst, "the forced re-review reached the model");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: forceRereview projects to precheck's FORCE_REVIEW gate", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const stored = {
      comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
      identity: "ci-bot",
    };
    // Without the intent the stored fingerprint still skips…
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    const skipped = await runReviewEngine(
      admissionRequest(server.url, runDir2, { forceRereview: false }),
      { ...engineDeps(f.root, runDir2), adapter: admissionAdapter(stored) },
    );
    assert.equal(skipped.shouldReview, false);
    assert.equal(skipped.skipReason, "diff-unchanged");
    const requestsAfterSkip = server.requests.length;
    // …and with it the same request reviews afresh.
    const runDir3 = join(f.root, "run-3");
    mkdirSync(runDir3);
    const forced = await runReviewEngine(
      admissionRequest(server.url, runDir3, { forceRereview: true }),
      { ...engineDeps(f.root, runDir3), adapter: admissionAdapter(stored) },
    );
    assert.equal(forced.shouldReview, true);
    assert.ok(server.requests.length > requestsAfterSkip, "the forced re-review reached the model");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: an explicit head pin that no longer matches skips superseded-head with no model spend", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, { headSha: "c".repeat(40) }),
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, false);
    assert.equal(result.skipReason, "superseded-head");
    assert.equal(result.reviewedHeadSha, "a".repeat(40), "the skip carries admission's resolved head");
    assert.equal(server.requests.length, 0, "the superseded skip made no model call");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a matching head pin is the verified reviewed head on the result", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const result = await runReviewEngine(
      admissionRequest(server.url, f.runDir, { headSha: "a".repeat(40) }),
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, true);
    assert.equal(result.reviewedHeadSha, "a".repeat(40));
    assert.equal(result.isForkPr, "false");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: contradictory event and head pins reject before any adapter or model call", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine(
        admissionRequest(server.url, f.runDir, { headSha: "c".repeat(40), eventHeadSha: "a".repeat(40) }),
        engineDeps(f.root, f.runDir),
      ),
      (error: unknown) => error instanceof RunReviewError && /contradictory request: eventHeadSha/.test(error.message),
    );
    assert.equal(server.requests.length, 0, "nothing reached the model");
  } finally { await server.close(); f.cleanup(); }
});

test("the Action env adapter and the engine produce identical admission decisions", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    // One engine run to learn the deterministic broad fingerprint…
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    // …then the SAME fixture (same inputs, same event, same stored marker)
    // through both paths, with a fresh adapter per path.
    const stored = { comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }], identity: "ci-bot" };
    const event = { name: "pull_request", action: "synchronize" } as const;
    const eventHeadSha = "a".repeat(40);
    const adapterResult = await runReview({
      env: { GITHUB_OUTPUT: "/dev/null" },
      inputs: { ...admissionInputs, "ai-base-url": server.url },
      runDir: join(f.root, "adapter-run"),
      workspace: f.root,
      platformAdapter: admissionAdapter(stored),
      event,
      eventHeadSha,
      quiet: true,
    });
    const engineRunDir = join(f.root, "engine-run");
    mkdirSync(engineRunDir);
    const engineResult = await runReviewEngine(
      admissionRequest(server.url, engineRunDir, { event, eventHeadSha }),
      { ...engineDeps(f.root, engineRunDir), adapter: admissionAdapter(stored) },
    );
    assert.equal(engineResult.shouldReview, adapterResult.shouldReview);
    assert.equal(engineResult.skipReason, adapterResult.skipReason);
    assert.equal(engineResult.diffFingerprint, adapterResult.diffFingerprint);
    assert.equal(engineResult.admissionBaseSha, adapterResult.admissionBaseSha);
    for (const key of ["should_review", "skip_reason", "diff_fingerprint", "head_sha", "base_sha", "is_fork_pr", "resolved_platform", "effective_forgejo_api_url"] as const) {
      assert.equal(engineResult.admission[key], adapterResult.admission[key], key);
    }
    // And a fresh-diff run through both paths must also agree (review case).
    const adapterFresh = await runReview({
      env: { GITHUB_OUTPUT: "/dev/null" },
      inputs: { ...admissionInputs, "ai-base-url": server.url },
      runDir: join(f.root, "adapter-fresh"),
      workspace: f.root,
      platformAdapter: admissionAdapter(),
      event,
      eventHeadSha,
      quiet: true,
    });
    const engineFreshRunDir = join(f.root, "engine-fresh");
    mkdirSync(engineFreshRunDir);
    const engineFresh = await runReviewEngine(
      admissionRequest(server.url, engineFreshRunDir, { event, eventHeadSha }),
      { ...engineDeps(f.root, engineFreshRunDir), adapter: admissionAdapter() },
    );
    assert.equal(engineFresh.shouldReview, true);
    assert.equal(adapterFresh.shouldReview, true);
    assert.equal(engineFresh.diffFingerprint, adapterFresh.diffFingerprint);
    assert.equal(engineFresh.admissionBaseSha, adapterFresh.admissionBaseSha);
  } finally { await server.close(); f.cleanup(); }
});

// ── #726 review: admission seams pinned ──────────────────────────────────

test("engine admission: onAdmission is not invoked when admission skips", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    const first = await runReviewEngine(admissionRequest(server.url, f.runDir), { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() });
    const fingerprint = first.diffFingerprint;
    const runDir2 = join(f.root, "run-2");
    mkdirSync(runDir2);
    let calls = 0;
        const second = await runReviewEngine(
          admissionRequest(server.url, runDir2),
      {
        ...engineDeps(f.root, runDir2),
        adapter: admissionAdapter({
          comments: [{ body: `<!-- ai-pr-reviewer -->
<!-- ai-pr-review-fingerprint:${fingerprint} -->
`, author: "ci-bot" }],
          identity: "ci-bot",
        }),
        onAdmission: () => { calls += 1; },
      },
    );
    assert.equal(second.shouldReview, false);
    assert.equal(second.skipReason, "diff-unchanged");
    assert.equal(calls, 0, "onAdmission never fired on a skipped admission");
    assert.ok(!existsSync(join(runDir2, "verdict.txt")), "no review ran past the skip");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission: a throwing onAdmission fails the run before any review stage", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    await assert.rejects(
      runReviewEngine(
        admissionRequest(server.url, f.runDir),
        {
          ...engineDeps(f.root, f.runDir),
          adapter: admissionAdapter(),
          onAdmission: () => { throw new Error("ack reaction exploded"); },
        },
      ),
      /ack reaction exploded/,
    );
    assert.ok(!existsSync(join(f.runDir, "verdict.txt")), "no verdict was produced");
    assert.equal(server.requests.length, 0, "the model was never reached");
  } finally { await server.close(); f.cleanup(); }
});

test("admission stage env keeps the Action fingerprint config byte-identical", () => {
  const contract = validateContract(V3_CONTRACT);
  const workspace = "/checkouts/pr";
  // A representative fully-populated Action env: contract inputs as the
  // runner exports them (INPUT_<ID>), runner ambient context, and the
  // derived bindings actionMain computes. Everything is a defined string —
  // collectConfigLines skips nothing on either side.
  const env: NodeJS.ProcessEnv = {
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_REPO": "o/r",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": "https://model.invalid",
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_TOOL-MODE": "off",
    "INPUT_COMMENT-MARKER": "<!-- ai-pr-reviewer -->",
    "INPUT_PUBLISH-MODE": "comment",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_ACTION_REF: "v3",
    GITHUB_WORKSPACE: workspace,
    GITHUB_API_URL: "https://api.github.com",
    PLATFORM: "github",
    PR_NUMBER: "7",
    EVENT_HEAD_SHA: "a".repeat(40),
  };
  const request: ReviewRequest = {
    repository: env.GITHUB_REPOSITORY ?? "",
    prNumber: env.PR_NUMBER ?? "",
    headSha: "",
    baseRef: "",
    isForkPr: "",
    platform: env.PLATFORM ?? "",
    forgejoApiUrl: env.FORGEJO_API_URL ?? "",
    ciChecksFile: "",
    inputs: rawInputsFromEnv(contract, env),
    ambient: env,
    triggerReason: "push",
    forceRereview: false,
    ...(env.EVENT_HEAD_SHA !== undefined ? { eventHeadSha: env.EVENT_HEAD_SHA } : {}),
  };
  const admissionLines = collectConfigLines(admissionStageEnv(contract, request, workspace));
  const actionLines = collectConfigLines(actionStageEnv(env) as Record<string, string>);
  assert.deepEqual(admissionLines, actionLines, "the fingerprint config hash inputs are byte-identical");
});

// #1635 (PR #1638 review): the compaction watermark reaches the precheck
// fingerprint through the WORKFLOW INPUT — the admission env is what
// `collectConfigLines` hashes, and the input is projected into it. A changed
// watermark therefore invalidates a cached review instead of skipping it.
// The repository-config file cannot set the input at all (it is not
// repo-configurable), so there is no second source that could miss the
// fingerprint — see tests-v3/repository-config.test.ts.
test("a configured compaction watermark reaches the admission fingerprint", () => {
  const contract = validateContract(V3_CONTRACT);
  const workspace = "/checkouts/pr";
  const env: NodeJS.ProcessEnv = {
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_REPO": "o/r",
    "INPUT_PR-NUMBER": "7",
    "INPUT_AI-BASE-URL": "https://model.invalid",
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MAX-CONVERSATION-TOKENS": "60000",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_WORKSPACE: workspace,
  };
  const request: ReviewRequest = {
    repository: env.GITHUB_REPOSITORY ?? "",
    prNumber: env.PR_NUMBER ?? "",
    headSha: "",
    baseRef: "",
    isForkPr: "",
    platform: "github",
    forgejoApiUrl: "",
    ciChecksFile: "",
    inputs: rawInputsFromEnv(contract, env),
    ambient: env,
    triggerReason: "push",
    forceRereview: false,
  };
  const lines = collectConfigLines(admissionStageEnv(contract, request, workspace));
  assert.ok(lines.includes("TOOL_MAX_CONVERSATION_TOKENS=60000"), "the watermark is part of the admission config hash");
  // The property the line exists for: a DIFFERENT watermark must produce a
  // different config hash, so a cached review is invalidated instead of
  // skipped.
  const hashOf = (value: string) => computeConfigHash(collectConfigLines(admissionStageEnv(contract, {
    ...request,
    inputs: rawInputsFromEnv(contract, { ...env, "INPUT_TOOL-MAX-CONVERSATION-TOKENS": value }),
  }, workspace)));
  assert.notEqual(hashOf("60000"), hashOf("40000"));
  // The unset shape (the contract default) contributes nothing — an existing
  // installation's cached reviews stay valid across the upgrade.
  assert.notEqual(hashOf(""), hashOf("60000"));
});

test("review-request.json records the folded admission identity on an Action-path request", async () => {
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const f = fixture();
  try {
    // Action-path shape: the raw request carries no head/base/fork/platform
    // (the adapter path fills them from the event); admission resolves them.
    const result = await runReviewEngine(
      {
        ...admissionRequest(server.url, f.runDir, { eventHeadSha: "a".repeat(40) }),
        headSha: "",
        baseRef: "",
        isForkPr: "",
        platform: "",
      },
      { ...engineDeps(f.root, f.runDir), adapter: admissionAdapter() },
    );
    assert.equal(result.shouldReview, true);
    const provenance = JSON.parse(readFileSync(join(f.runDir, "review-request.json"), "utf8")) as Record<string, unknown>;
    assert.equal(provenance.head_sha, "a".repeat(40), "the reviewed head is the folded event/admission head, not the empty request value");
    assert.equal(provenance.base_ref, "b".repeat(40), "the base ref is the admission-resolved base, not the empty request value");
    assert.equal(provenance.is_fork_pr, "false", "the fork flag is the admission-derived one, not the empty request value");
    assert.equal(provenance.platform, "github", "the platform is the admission-resolved one, not the empty request value");
    assert.equal(provenance.forgejo_api_url, "", "the Forgejo URL is admission's effective value");
  } finally { await server.close(); f.cleanup(); }
});

test("engine admission routes precheck diagnostics to the injected error sink only", async () => {
  const f = fixture();
  const stderrChunks: string[] = [];
  const errorLines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(encoding ?? "utf8"));
    if (cb) cb(null);
    return true;
  }) as typeof process.stderr.write;
  try {
    const output = await runEngineAdmission(
      validateContract(V3_CONTRACT),
      admissionRequest("https://model.invalid", f.runDir),
      f.root,
      // A marker-bearing managed comment with an unproven identity fires
      // precheck's fail-closed diagnostic (no skip, no carry).
      admissionAdapter({
        comments: [{ body: "<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:stale -->\n", author: "someone" }],
        identity: null,
      }),
      (line) => errorLines.push(line),
    );
    assert.equal(output.should_review, "true", "the unproven identity forced a fresh review instead of a skip");
  } finally {
    process.stderr.write = originalWrite;
    f.cleanup();
  }
  assert.ok(
    errorLines.some((line) => line.includes("could not authenticate the action's own forge identity")),
    "the precheck diagnostic reached the injected error sink",
  );
  assert.deepEqual(stderrChunks, [], "nothing reached process.stderr during admission");
});


// ---------------------------------------------------------------------------
// #1627: the executed-call citation gate, end to end — on the REAL
// native-loop run path (`runReview` with `tool-mode: native_loop`), because
// the corpus stage deliberately clobbers any stale tool-harness.json on the
// off path (a stale JSON must never escalate a review that ran no tools).
// The loop's `tool_calls` trace is the executed-call identity surface the
// engine folds from; a must_check `satisfied` discharges only by citing an
// executed successful call id from it — in BOTH folds.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";

const CITATION_CHECKS = [
  "check for breaking API changes in updated dependencies",
  "run full test suite after upgrade",
  "establish upstream provenance for the updated dependency: publisher and canonical source repository",
  "inspect the exact old→new upstream release delta for the updated dependency",
  "check upstream security advisories for the updated dependency version range, or report the advisory check as not performed",
];

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd: dir });
}

/** Scripted native-loop model endpoint: loop turn 1 executes a read (the
 * scoped dependency plan's lead-claim window admits the lockfile-targeted
 * read and refuses further untargeted reads — one executed call is the
 * surface this fixture needs), loop turn 2 stops, then the verdict turn
 * carries the dispositions. */
function citationLoopHandler(dispositions: unknown[]) {
  let loopTurns = 0;
  return (_req: unknown, body: string, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }) => {
    res.setHeader("Content-Type", "application/json");
    const req = JSON.parse(body) as { tools?: unknown[] };
    const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
    if (hasTools) {
      const turn = loopTurns++;
      if (turn === 0) {
        res.end(JSON.stringify({ id: "c0", object: "chat.completion", model: "x", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"package-lock.json"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      res.end(JSON.stringify({ id: "c2", object: "chat.completion", model: "x", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "evidence gathered" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      return;
    }
    res.end(JSON.stringify({ id: "c3", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Recommendation: Approve\n5/5 verified with evidence — all checks pass.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null,
      required_check_dispositions: dispositions,
    }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
  };
}
async function citationRun(dispositions: unknown[]): Promise<{
  result: Awaited<ReturnType<typeof runReview>>;
  runDir: string;
  serverRequests: Array<{ body?: string }>;
  cleanup: () => void;
  close: () => Promise<void>;
}> {
  const server = await startMockServer(citationLoopHandler(dispositions));
  const root = mkdtempSync(join(tmpdir(), "v3-engine-citation-"));
  writeFileSync(join(root, "package-lock.json"), '{\n  "lodash": "4.5.6"\n}\n');
  gitInit(root);
  const result = await runReview({
    env: { IS_FORK_PR: "false" },
    inputs: {
      "github-token": "tok", repo: "o/r", "pr-number": "7",
      "ai-base-url": server.url, "ai-model": "primary-m", "ai-api-key": "primary-key",
      "ai-stream": "false", "review-routing-mode": "auto", "deep-review": "false",
      "tool-mode": "native_loop", "tool-max-requests": "5",
    },
    runDir: root, workspace: root,
    platformAdapter: {
      ...mockPlatform(),
      getPr: async () => ({
        number: 7, title: "chore(deps): bump lodash from 1.2.3 to 4.5.6",
        body: "Only one file changed. No CRDs changed and the CRD schema is unchanged.",
        state: "open", draft: false, head: { sha: "a".repeat(40), ref: "renovate/lodash-4.x" }, base: { ref: "main" },
        user: { login: "someone" }, changed_files: 1, additions: 2, deletions: 2,
      }),
      getPrDiff: async () => "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,4 +1,4 @@\n-  \"version\": \"1.2.3\",\n-  \"lodash\": \"1.2.3\",\n+  \"version\": \"4.5.6\",\n+  \"lodash\": \"4.5.6\",\n",
      listPrFiles: async () => ({ ok: true, data: [{ filename: "package-lock.json", status: "modified", additions: 2, deletions: 2, changes: 4 }] }),
    } as unknown as PlatformReadAdapter,
    quiet: true,
  });
  return { result, runDir: root, serverRequests: server.requests, cleanup: (): void => rmSync(root, { recursive: true, force: true }), close: (): Promise<void> => server.close() };
}

test("#1627: the engine withholds the native approval when must_check satisfactions cite no executed successful call — both folds agree (the #1623 shape)", async () => {
  const run = await citationRun([
    // (a) satisfied + cited to the SUCCESSFUL call → discharges.
    { check: CITATION_CHECKS[0], status: "satisfied", rationale: "the lockfile read at head shows no breaking API change — call-1" },
    // (b) satisfied with prose-only credit, NO citation.
    { check: CITATION_CHECKS[1], status: "satisfied", rationale: "I read the diff carefully — 5/5 verified with evidence." },
    // (c) satisfied citing an id the executed-call index does not carry
    //     (the loop executed exactly one call).
    { check: CITATION_CHECKS[2], status: "satisfied", rationale: "the provenance read ran as call-2 and confirmed the publisher" },
    // (d) satisfied citing another NONEXISTENT call id.
    { check: CITATION_CHECKS[3], status: "satisfied", rationale: "the release delta was inspected as call-99" },
    // (e) no disposition for the fifth check.
  ]);
  try {
    // The loop executed exactly the one scripted read — the trace the gate
    // folds from (the scoped dependency plan's enforced window refused the
    // untargeted follow-up reads, which is exactly why no call-2 exists).
    const harness = JSON.parse(readFileSync(join(run.runDir, "tool-harness.json"), "utf8")) as { tool_calls?: Array<{ status?: string }> };
    assert.deepEqual((harness.tool_calls ?? []).map((call) => call.status), ["ok"]);
    // (a) discharged; (b)-(d) unresolved with the #1627 reason; (e) the
    // pre-#1627 no-disposition reason — every receipt content-free.
    const persisted = JSON.parse(readFileSync(join(run.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ status: string; reason?: string }>;
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.status, row.reason]), [
      ["satisfied", "ok"],
      ["unresolved", "uncited-satisfaction"],
      ["unresolved", "uncited-satisfaction"],
      ["unresolved", "uncited-satisfaction"],
      ["unresolved", "no-disposition"],
    ]);
    // #750 parity: the completeness fold, over the SAME trace and
    // dispositions, reports the same set — required_checks incomplete.
    const output = JSON.parse(readFileSync(join(run.runDir, "ai-output.json"), "utf8")) as { required_checks?: string };
    assert.equal(output.required_checks, "incomplete");
    // Native approval withheld: the model's approve survives (unresolved
    // rows are coverage, never a manufactured block) but the review
    // publishes partial — an abstention, never a native APPROVE event. The
    // "5/5 verified" PROSE in review_markdown earned nothing.
    assert.equal(run.result.outputs.verdict, "approve");
    assert.equal(run.result.outputs.reviewResult, "partial");
  } finally {
    await run.close();
    run.cleanup();
  }
});

test("#1627: paired positive — the cited satisfaction and the non-gated rows discharge; both folds agree, the run is natively eligible, and the verdict turn carried the proof index", async () => {
  // #1634 (review): one executed call backs at most ONE satisfied
  // disposition, so the clean shape behind a single executed call cites it
  // on exactly one check and answers the rest `not_applicable` (an
  // applicability answer, never citation-gated). The all-cited clean shape
  // with distinct calls is pinned at the fold level in
  // `tests-v3/review-obligations.test.ts`; the shared-call failure shape has
  // its own end-to-end test below.
  const dispositions = [
    { check: CITATION_CHECKS[0], status: "satisfied", rationale: "the lockfile read at head shows no breaking API change — call-1" },
    ...CITATION_CHECKS.slice(1).map((check) => ({ check, status: "not_applicable", rationale: "no test-suite change, single-version lockfile bump with no upstream network surface in scope" })),
  ];
  const run = await citationRun(dispositions);
  try {
    const persisted = JSON.parse(readFileSync(join(run.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ status: string; reason?: string }>;
    };
    assert.deepEqual(persisted.obligations.map((row) => [row.status, row.reason]), Array.from({ length: 5 }, () => ["satisfied", "ok"]));
    const output = JSON.parse(readFileSync(join(run.runDir, "ai-output.json"), "utf8")) as { required_checks?: string };
    assert.equal(output.required_checks, "complete");
    // Native eligibility affirmative.
    assert.equal(run.result.outputs.verdict, "approve");
    assert.equal(run.result.outputs.reviewResult, "clean");
    // The closing verdict turn is the FIRST path's one model verdict: its
    // request body carried the proof index (must_check rows + executed-call
    // ids + the citation instruction) so the citations were checkable.
    const verdictRequest = run.serverRequests.find((request) => !((request as { body?: string }).body ?? "").includes("\"tools\":["));
    assert.ok(verdictRequest, "the verdict turn request is present");
    const body = (verdictRequest as { body?: string }).body ?? "";
    assert.match(body, /# Required-Check Proof Index/);
    assert.match(body, /- call-1 — `read_file` \(ok\)/);
    assert.match(body, /Verify the exact must_check check text|must_check/);
  } finally {
    await run.close();
    run.cleanup();
  }
});

test("#1634 (review): one executed successful call cannot discharge five satisfactions — the shared allocation keeps exactly one row clean and the approval withheld", async () => {
  const dispositions = CITATION_CHECKS.map((check) => ({
    check,
    status: "satisfied",
    rationale: "verified against the repository state at head — call-1",
  }));
  const run = await citationRun(dispositions);
  try {
    const persisted = JSON.parse(readFileSync(join(run.runDir, "review-obligations.json"), "utf8")) as {
      obligations: Array<{ status: string; reason?: string }>;
    };
    // Canonical-key allocation: exactly one row wins call-1; the rest fail
    // closed as already-claimed. Both folds agree (required_checks
    // incomplete), and the native approval is withheld.
    const rows = persisted.obligations.map((row) => [row.status, row.reason]);
    assert.equal(rows.filter((row) => row[0] === "satisfied").length, 1, JSON.stringify(rows));
    assert.equal(rows.filter((row) => row[1] === "citation-already-used").length, 4, JSON.stringify(rows));
    const output = JSON.parse(readFileSync(join(run.runDir, "ai-output.json"), "utf8")) as { required_checks?: string };
    assert.equal(output.required_checks, "incomplete");
    assert.equal(run.result.outputs.reviewResult, "partial");
  } finally {
    await run.close();
    run.cleanup();
  }
});
