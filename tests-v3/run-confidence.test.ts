import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { publishReview } from "../src/publish/publish.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import type { NativeReviewRequest, NativeReviewSurface, PublishCommentRef, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";
import { startMockServer, type MockServer } from "./helpers.js";
import {
  MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS,
  MAX_CONFIDENCE_CONCERN_FILE_CHARS,
  MAX_CONFIDENCE_REASON_CHARS,
} from "../src/confidence/result.js";

/** #1073 end-to-end mocked-run coverage for the independent confidence
 * scorer. The run phase is exercised through the same startMockServer rig as
 * run.test.ts; the scorer lane is addressed by its own model name on the
 * shared mock server (the scorer endpoint is loopback in these fixtures, so
 * no separate credential is needed). */

const SCORER_MODEL = "confidence-m";

function mockPlatform(prBody = ""): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => {
      return Promise.resolve({
        number: 7,
        title: "Update README",
        body: prBody,
        head: { sha: "a".repeat(40), ref: "feature" },
        base: { ref: "main" },
        user: { login: "someone" },
        changed_files: 1,
        additions: 4,
        deletions: 1,
        html_url: "https://github.com/o/r/pull/7",
      });
    },
    getPrDiff: () => {
      return Promise.resolve(`diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n`);
    },
    listPrFiles: () => {
      return Promise.resolve({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] });
    },
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
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

function baseVerdict(): Record<string, unknown> {
  return {
    verdict: "approve",
    review_markdown: "Looks fine.\n",
    smart_review_requested: false,
    smart_review_reason: null,
    findings: [],
    requirement_coverage: null,
    required_check_dispositions: [],
  };
}

function chatBody(model: string, content: string): string {
  return JSON.stringify({
    id: "s1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

type MockHandler = NonNullable<Parameters<typeof startMockServer>[0]>;

/** Route by model name: the primary lane ("m") always gets the base verdict;
 * the scorer lane gets the scenario's scripted answer. */
function routedHandler(scorer: MockHandler): MockHandler {
  return (req, body, res) => {
    let model = "";
    try {
      model = String((JSON.parse(body) as Record<string, unknown>).model ?? "");
    } catch {
      model = "";
    }
    if (model === SCORER_MODEL) return scorer(req, body, res);
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  };
}

function scorerRequests(server: MockServer): number {
  return server.requests.filter((request) => {
    try {
      return (JSON.parse(request.body) as Record<string, unknown>).model === SCORER_MODEL;
    } catch {
      return false;
    }
  }).length;
}

/** Raw bodies of every scorer-lane request the mock server captured. */
function scorerRequestBodies(server: MockServer): string[] {
  return server.requests.filter((request) => {
    try {
      return (JSON.parse(request.body) as Record<string, unknown>).model === SCORER_MODEL;
    } catch {
      return false;
    }
  }).map((request) => request.body);
}

interface RunOutcome {
  result: Awaited<ReturnType<typeof runReview>>;
  runDir: string;
  output: string;
  summary: string;
  /** The runner's own log lines, captured only when `captureLogs` is set. */
  logs: string[];
}

async function runConfidenceRun(
  server: MockServer,
  extraInputs: Record<string, string>,
  prBody = "",
  captureLogs = false,
  extra: { env?: Record<string, string>; seed?: Record<string, string> } = {},
): Promise<RunOutcome> {
  const runDir = mkdtempSync(join(tmpdir(), "v3-run-confidence-"));
  // Stale artifacts a reused run dir would carry in from an earlier run.
  for (const [name, content] of Object.entries(extra.seed ?? {})) {
    writeFileSync(join(runDir, name), content);
  }
  const outputFile = join(runDir, "gh-output.txt");
  const stepSummaryFile = join(runDir, "step-summary.md");
  const logs: string[] = [];
  const result = await runReview({
    env: {
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: stepSummaryFile,
      // The mocked PR carries no head-repo identity, so fork state would
      // derive as cross-repository (fail-closed) and the fork-gated scorer
      // would never run. Every test here but the fork one wants a trusted PR.
      IS_FORK_PR: "false",
      ...extra.env,
    },
    inputs: {
      "github-token": "tok",
      repo: "o/r",
      "pr-number": "7",
      "ai-base-url": server.url,
      "ai-model": "m",
      "ai-stream": "false",
      "ai-api-key": "primary-secret-k",
      ...extraInputs,
    },
    runDir,
    workspace: runDir,
    platformAdapter: mockPlatform(prBody),
    persistArtifacts: true,
    // `quiet` short-circuits before the log sink, so a capture turns it off.
    quiet: !captureLogs,
    ...(captureLogs ? { log: (line: string): void => { logs.push(line); } } : {}),
  });
  return {
    result,
    runDir,
    output: readFileSync(outputFile, "utf8"),
    summary: readFileSync(stepSummaryFile, "utf8"),
    logs,
  };
}

/** A minimal comment-mode publish API that captures the sticky body. */
class StickyCaptureApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  readonly bodies: string[] = [];
  readonly submitted: NativeReviewRequest[] = [];
  constructor(private readonly head: string) {}
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(_marker: string, body: string): Promise<{ ok: boolean; created: boolean }> {
    this.bodies.push(body);
    return { ok: true, created: true };
  }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean }> { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
  async requestReviewers(): ReturnType<PublishPlatformApi["requestReviewers"]> {
    return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

/** Every file under the run dir, recursively. */
function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return allFiles(path);
    if (entry.isFile()) return [path];
    return [];
  });
}

test("#1073: scoring ON publishes an unchanged review and surfaces every confidence surface", async () => {
  // The concern evidence AND its file are hostile on purpose: the published
  // section must carry both sanitized (no live link, no raw markup) while
  // everything else stays byte-identical to the scoring-off baseline.
  const scorerAnswer = JSON.stringify({
    score: 4,
    risk: "low",
    reason: "diff is small and fully covered",
    concerns: [{ file: "<script>alert(1)</script>", line: 2, evidence: "see [x](https://github.com/o/r/pull/1) and <script>alert(1)</script>" }],
  });
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, scorerAnswer));
  }));
  try {
    const on = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
    });
    const off = await runConfidenceRun(server, {});

    // The verdict-bearing publication is byte-identical with and without the
    // scorer: scoring is telemetry, never a second opinion that edits the
    // review.
    assert.equal(on.result.outputs.verdict, "approve");
    assert.equal(on.result.outputs.verdict, off.result.outputs.verdict);
    assert.equal(on.result.outputs.requiredChecks, off.result.outputs.requiredChecks);
    assert.equal(on.result.outputs.reviewResult, off.result.outputs.reviewResult);
    assert.deepEqual(
      [...readFileSync(join(on.runDir, "review-body.md"))],
      [...readFileSync(join(off.runDir, "review-body.md"))],
    );
    assert.deepEqual(
      [...readFileSync(join(on.runDir, "verdict.txt"))],
      [...readFileSync(join(off.runDir, "verdict.txt"))],
    );
    // The disabled baseline keeps the pre-#1073 marker bytes.
    assert.doesNotMatch(off.result.marker, /confidence_status/);

    // The five step outputs: scored carries the integer, never a spurious 0.
    assert.equal(on.result.outputs.confidenceStatus, "scored");
    assert.equal(on.result.outputs.confidenceScore, "4");
    assert.equal(on.result.outputs.confidenceRisk, "low");
    assert.equal(on.result.outputs.confidenceReason, "diff is small and fully covered");
    assert.equal(on.result.outputs.confidenceModel, SCORER_MODEL);
    assert.match(on.output, /^confidence-status=scored$/m);
    assert.match(on.output, /^confidence-score=4$/m);
    assert.match(on.output, /^confidence-risk=low$/m);
    assert.match(on.output, /^confidence-model=confidence-m$/m);
    // The disabled baseline writes the assignments, but all empty.
    assert.match(off.output, /^confidence-status=$/m);
    assert.doesNotMatch(off.output, /^confidence-score=[0-9]/m);

    // The additive marker keys appear only when the scorer ran.
    assert.match(on.result.marker, /"confidence_status":"scored"/);
    assert.match(on.result.marker, /"confidence_score":4/);
    assert.doesNotMatch(off.result.marker, /confidence_score/);

    // The step summary gains exactly one advisory row when the scorer ran,
    // and none when it did not.
    assert.match(on.summary, /\| Independent confidence \| scored 4\/5, risk: low \(model: confidence-m\) — diff is small and fully covered \(advisory only\) \|/);
    assert.ok(!off.summary.includes("Independent confidence"));

    // The artifacts exist with sanitized fields; the baseline has none.
    const scoreArtifact = JSON.parse(readFileSync(join(on.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.status, "scored");
    assert.equal(scoreArtifact.score, 4);
    assert.equal(scoreArtifact.risk, "low");
    assert.equal(scoreArtifact.model, SCORER_MODEL);
    assert.equal(scoreArtifact.cause, "");
    assert.ok(Array.isArray(scoreArtifact.concerns) && scoreArtifact.concerns.length === 1);
    assert.ok(existsSync(join(on.runDir, "confidence-request.json")));
    assert.ok(existsSync(join(on.runDir, "confidence-response.json")));

    // The primary lane's secret never reaches any run artifact, including
    // the scored-run request/response artifacts.
    for (const file of allFiles(on.runDir)) {
      assert.ok(!readFileSync(file).includes("primary-secret-k"), `primary secret leaked into ${file}`);
    }
    assert.ok(!existsSync(join(off.runDir, "confidence-score.json")));
    assert.ok(!existsSync(join(off.runDir, "confidence-request.json")));
    assert.ok(!existsSync(join(off.runDir, "confidence-response.json")));

    // Exactly one extra model call happened (the scorer's), on its own lane.
    assert.equal(scorerRequests(server), 1);

    // The published comment carries the advisory section, sanitized: the
    // hostile concern evidence survives without its link or markup.
    const api = new StickyCaptureApi("a".repeat(40));
    const publishResult = await publishReview({
      mode: "comment",
      reviewMarkdown: on.result.outputs.reviewMarkdown,
      verdict: on.result.outputs.verdict,
      verdictPolicy: on.result.verdictPolicy,
      analysisEngine: on.result.outputs.analysisEngine,
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      prNumber: "7",
      commentMarker: "<!-- ai-pr-review -->",
      requiredChecks: on.result.outputs.requiredChecks,
      reviewRoute: on.result.outputs.reviewRoute,
      escalationReason: on.result.outputs.escalationReason,
      cacheHitRatio: on.result.outputs.cacheHitRatio,
      inlineFindings: false,
      inlineFindingsMax: 5,
      findings: JSON.parse(on.result.outputs.findings),
      cleanupPreviousNativeReviews: "false",
      allowApprove: false,
      approveForks: false,
      isForkPr: false,
      upstreamLinkMode: "inert",
      conditionalPresence: {
        linkedIssue: false, evidenceProvider: false, standards: false,
        toolHarnessFindings: false, toolHarnessResults: false,
      },
      forgejoPositions: false,
      confidence: {
        status: on.result.outputs.confidenceStatus,
        score: on.result.outputs.confidenceScore,
        risk: on.result.outputs.confidenceRisk,
        reason: on.result.outputs.confidenceReason,
        model: on.result.outputs.confidenceModel,
        ...(on.result.confidenceConcerns !== undefined ? { concerns: on.result.confidenceConcerns } : {}),
      },
    }, api, { diffText: "" });
    assert.equal(publishResult.status, "published");
    assert.equal(api.bodies.length, 1);
    const body = api.bodies[0]!;
    assert.match(body, /## Independent Confidence/);
    assert.match(body, /Independent confidence: 4\/5, risk: low/);
    assert.match(body, /Advisory only/);
    // The whole block passed the publication sanitizer: the upstream link in
    // the hostile concern evidence was neutralized and the raw markup was
    // HTML-escaped.
    assert.ok(!body.includes("](https://github.com/"), "published section must not carry a live upstream link from concern evidence");
    assert.ok(!body.includes("<script"), "published section must not carry raw markup from concern evidence");
    assert.match(body, /upstream o\/r/);
    // The concern's FILE is model-authored too and takes the same
    // sanitization as the evidence: the raw markup never reaches the
    // published surface, and the concern itself still renders.
    assert.match(body, /&lt;script&gt;/, "the hostile concern file is published HTML-escaped");
    assert.match(body, /Advisory concern at /, "the concern bullet still renders");
    assert.match(body, /alert\(1\)/, "the concern content still renders");
  } finally {
    await server.close();
  }
});

test("#1073: scoring OFF (default) makes no scorer request and leaves no confidence surface", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  try {
    const run = await runConfidenceRun(server, {});
    // No scorer request hit the mock server: every captured request belongs
    // to the primary lane.
    assert.equal(scorerRequests(server), 0);
    assert.ok(server.requests.length >= 1);

    // All five outputs stay "" (empty, never a spurious 0).
    assert.equal(run.result.outputs.confidenceStatus, "");
    assert.equal(run.result.outputs.confidenceScore, "");
    assert.equal(run.result.outputs.confidenceRisk, "");
    assert.equal(run.result.outputs.confidenceReason, "");
    assert.equal(run.result.outputs.confidenceModel, "");
    assert.doesNotMatch(run.output, /^confidence-score=[0-9]/m);

    // No marker keys, no summary row, no artifacts.
    assert.doesNotMatch(run.result.marker, /confidence_status/);
    assert.doesNotMatch(run.result.marker, /confidence_score/);
    assert.ok(!run.summary.includes("Independent confidence"));
    assert.ok(!existsSync(join(run.runDir, "confidence-score.json")));
    assert.ok(!existsSync(join(run.runDir, "confidence-request.json")));
    assert.ok(!existsSync(join(run.runDir, "confidence-response.json")));
  } finally {
    await server.close();
  }
});

test("#1073: scorer HTTP 429 degrades to unscored with no retry and the review still publishes", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.statusCode = 429;
    res.end("rate limited");
  }));
  try {
    const on = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
    });
    const off = await runConfidenceRun(server, {});

    // Exactly one wire attempt: no 429/5xx backoff, no fallback, no retry.
    assert.equal(scorerRequests(server), 1);

    // Unscored, with the transport cause surfaced in the persisted artifact.
    assert.equal(on.result.outputs.confidenceStatus, "unscored");
    assert.equal(on.result.outputs.confidenceScore, "");
    assert.equal(on.result.outputs.confidenceRisk, "unknown");
    assert.match(on.output, /^confidence-status=unscored$/m);
    assert.doesNotMatch(on.output, /^confidence-score=[0-9]/m);
    const scoreArtifact = JSON.parse(readFileSync(join(on.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.status, "unscored");
    assert.equal(scoreArtifact.score, null);
    assert.equal(scoreArtifact.cause, "http_429");

    // The review still publishes, byte-identical to the no-scorer run's
    // verdict-bearing content.
    assert.equal(on.result.outputs.verdict, "approve");
    assert.equal(on.result.outputs.verdict, off.result.outputs.verdict);
    assert.deepEqual(
      [...readFileSync(join(on.runDir, "review-body.md"))],
      [...readFileSync(join(off.runDir, "review-body.md"))],
    );
    assert.deepEqual(
      [...readFileSync(join(on.runDir, "verdict.txt"))],
      [...readFileSync(join(off.runDir, "verdict.txt"))],
    );
    assert.match(on.summary, /\| Independent confidence \| unscored \(model: confidence-m\) \(advisory only\) \|/);
  } finally {
    await server.close();
  }
});

test("#1073: a malformed scorer answer degrades to unscored and the review still publishes", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    // Truncated JSON with no usable score: the parser must fail closed.
    res.end(chatBody(SCORER_MODEL, `Sure! Here is my assessment: {"score": 4, "risk": "lo`));
  }));
  try {
    const on = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
    });

    assert.equal(scorerRequests(server), 1);
    assert.equal(on.result.outputs.confidenceStatus, "unscored");
    assert.equal(on.result.outputs.confidenceScore, "");
    assert.equal(on.result.outputs.confidenceRisk, "unknown");
    const scoreArtifact = JSON.parse(readFileSync(join(on.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.status, "unscored");
    assert.equal(scoreArtifact.cause, "malformed_answer");

    // The review itself is untouched.
    assert.equal(on.result.outputs.verdict, "approve");
    assert.ok(existsSync(join(on.runDir, "review-body.md")));
    assert.equal(readFileSync(join(on.runDir, "verdict.txt"), "utf8"), "approve\n");
  } finally {
    await server.close();
  }
});

test("#1140 review: the scorer request never carries configured or shaped credentials", async () => {
  // The PR body itself smuggles a lane credential and a shaped secret: the
  // scorer prompt is built only from credential-redacted content, so a
  // separate scorer backend can never receive them.
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 4, risk: "low", reason: "fine", concerns: [] })));
  }));
  try {
    await runConfidenceRun(
      server,
      { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url },
      "deploy with api_key=supersecret1234567890 and the primary token primary-secret-k",
    );
    const bodies = scorerRequestBodies(server);
    assert.equal(bodies.length, 1);
    for (const body of bodies) {
      assert.ok(!body.includes("primary-secret-k"), "configured lane credential reached the scorer request");
      assert.ok(!body.includes("api_key=supersecret1234567890"), "shaped key=value secret reached the scorer request");
    }
  } finally {
    await server.close();
  }
});

test("#1140 review: a scorer answer echoing lane credentials is masked on EVERY public surface", async () => {
  // The scorer model echoes BOTH lane credentials in its reason and concern
  // evidence. Masking must happen on the canonical result, so the published
  // comment, step outputs, step summary, marker-adjacent env payload, and
  // every persisted artifact are all clean — not just the JSON artifact.
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({
      score: 4,
      risk: "low",
      reason: "primary key primary-secret-k and scorer key confidence-secret-k look fine",
      concerns: [{ file: "deploy/primary-secret-k.sh", line: 2, evidence: "rotate confidence-secret-k now" }],
    })));
  }));
  try {
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
      "ai-confidence-api-key": "confidence-secret-k",
    });
    // The score itself survives — masking is content hygiene, not a veto.
    assert.equal(run.result.outputs.confidenceStatus, "scored");
    assert.equal(run.result.outputs.confidenceScore, "4");
    const reason = run.result.outputs.confidenceReason ?? "";
    assert.ok(!reason.includes("primary-secret-k"));
    assert.ok(!reason.includes("confidence-secret-k"));
    assert.ok(reason.includes("look fine"));
    assert.ok(!run.output.includes("primary-secret-k"), "credential leaked into step outputs");
    assert.ok(!run.output.includes("confidence-secret-k"), "scorer credential leaked into step outputs");
    assert.ok(!run.summary.includes("primary-secret-k"), "credential leaked into step summary");
    assert.ok(!run.summary.includes("confidence-secret-k"), "scorer credential leaked into step summary");
    const concerns = run.result.confidenceConcerns ?? [];
    assert.equal(concerns.length, 1);
    assert.ok(!concerns[0]!.file.includes("primary-secret-k"), "credential leaked into concern file");
    assert.ok(!concerns[0]!.evidence.includes("confidence-secret-k"), "credential leaked into concern evidence");
    assert.ok(concerns[0]!.file.includes("deploy/") && concerns[0]!.evidence.includes("rotate"), "concern text survives masking");
    for (const path of allFiles(run.runDir)) {
      const bytes = readFileSync(path, "utf8");
      assert.ok(!bytes.includes("primary-secret-k"), `primary credential leaked into ${path}`);
      assert.ok(!bytes.includes("confidence-secret-k"), `scorer credential leaked into ${path}`);
    }

    // The published comment is the same sanitized canonical result.
    const api = new StickyCaptureApi("a".repeat(40));
    await publishReview({
      mode: "comment",
      reviewMarkdown: run.result.outputs.reviewMarkdown,
      verdict: run.result.outputs.verdict,
      verdictPolicy: run.result.verdictPolicy,
      analysisEngine: run.result.outputs.analysisEngine,
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      prNumber: "7",
      commentMarker: "<!-- ai-pr-review -->",
      requiredChecks: run.result.outputs.requiredChecks,
      reviewRoute: run.result.outputs.reviewRoute,
      escalationReason: run.result.outputs.escalationReason,
      cacheHitRatio: run.result.outputs.cacheHitRatio,
      inlineFindings: false,
      inlineFindingsMax: 5,
      findings: JSON.parse(run.result.outputs.findings),
      cleanupPreviousNativeReviews: "false",
      allowApprove: false,
      approveForks: false,
      isForkPr: false,
      upstreamLinkMode: "inert",
      conditionalPresence: {
        linkedIssue: false, evidenceProvider: false, standards: false,
        toolHarnessFindings: false, toolHarnessResults: false,
      },
      forgejoPositions: false,
      confidence: {
        status: run.result.outputs.confidenceStatus ?? "",
        score: run.result.outputs.confidenceScore ?? "",
        risk: run.result.outputs.confidenceRisk ?? "",
        reason: run.result.outputs.confidenceReason ?? "",
        model: run.result.outputs.confidenceModel ?? "",
        ...(run.result.confidenceConcerns !== undefined ? { concerns: run.result.confidenceConcerns } : {}),
      },
    }, api, { diffText: "" });
    assert.equal(api.bodies.length, 1);
    assert.ok(!api.bodies[0]!.includes("primary-secret-k"), "credential leaked into the published comment");
    assert.ok(!api.bodies[0]!.includes("confidence-secret-k"), "scorer credential leaked into the published comment");
    assert.match(api.bodies[0]!, /## Independent Confidence/);
  } finally {
    await server.close();
  }
});

test("#1140 review round 9: masking a max-length answer never leaves a field past its bound (one-character secret)", async () => {
  // Masking is NOT length-preserving: a one-character configured credential
  // becomes the three-character `⟦•⟧` marker, and the generic heuristics widen
  // a match to `⟦redacted:credential⟧`. Every field below arrives at EXACTLY
  // its documented parser bound and carries the secret, so before the bounds
  // were re-applied after masking the canonical result left the parser
  // OVERSHooting: `reason` > 600, `file` > 300, `evidence` > 400 in the
  // persisted artifact, the step outputs, and the published section.
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({
      score: 4,
      risk: "low",
      reason: "q".repeat(MAX_CONFIDENCE_REASON_CHARS - 1) + "k",
      concerns: [{
        file: "a".repeat(MAX_CONFIDENCE_CONCERN_FILE_CHARS - 1) + "k",
        line: 3,
        evidence: "e".repeat(MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS - 1) + "k",
      }],
    })));
  }));
  try {
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
      "ai-confidence-api-key": "k",
    });
    assert.equal(run.result.outputs.confidenceStatus, "scored");
    const reason = run.result.outputs.confidenceReason ?? "";
    assert.ok(!reason.includes("k"), "configured credential survived masking");
    assert.ok(reason.includes("q"), "benign text must survive masking");
    assert.ok(reason.length <= MAX_CONFIDENCE_REASON_CHARS, `reason ${reason.length} exceeds ${MAX_CONFIDENCE_REASON_CHARS}`);
    const concerns = run.result.confidenceConcerns ?? [];
    assert.equal(concerns.length, 1);
    assert.ok(!concerns[0]!.file.includes("k") && !concerns[0]!.evidence.includes("k"), "credential survived concern masking");
    assert.ok(concerns[0]!.file.length <= MAX_CONFIDENCE_CONCERN_FILE_CHARS, `concern file ${concerns[0]!.file.length} exceeds ${MAX_CONFIDENCE_CONCERN_FILE_CHARS}`);
    assert.ok(concerns[0]!.evidence.length <= MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS, `concern evidence ${concerns[0]!.evidence.length} exceeds ${MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS}`);

    // The persisted canonical artifact carries the same bounded, masked fields.
    const artifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as {
      reason?: string;
      concerns?: { file?: string; evidence?: string }[];
    };
    const artifactReason = artifact.reason ?? "";
    assert.ok(artifactReason.length <= MAX_CONFIDENCE_REASON_CHARS, "artifact reason exceeds its bound");
    assert.ok(!artifactReason.includes("k"), "artifact reason carries the credential");
    const artifactConcerns = artifact.concerns ?? [];
    assert.equal(artifactConcerns.length, 1);
    assert.ok((artifactConcerns[0]!.file ?? "").length <= MAX_CONFIDENCE_CONCERN_FILE_CHARS, "artifact concern file exceeds its bound");
    assert.ok((artifactConcerns[0]!.evidence ?? "").length <= MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS, "artifact concern evidence exceeds its bound");
  } finally {
    await server.close();
  }
});

test("#1140 review: an out-of-range score (999) fails closed to unscored, never a top-score pass", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 999, risk: "low", reason: "everything is great" })));
  }));
  try {
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
    });
    assert.equal(scorerRequests(server), 1);
    assert.equal(run.result.outputs.confidenceStatus, "unscored");
    assert.equal(run.result.outputs.confidenceScore, "");
    assert.doesNotMatch(run.output, /^confidence-score=[0-9]/m);
    const scoreArtifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.status, "unscored");
    assert.equal(scoreArtifact.score, null);
    assert.equal(scoreArtifact.cause, "malformed_score");
    assert.ok(!run.summary.includes("Independent confidence: 999"));
    // The review itself is untouched.
    assert.equal(run.result.outputs.verdict, "approve");
  } finally {
    await server.close();
  }
});

test("#1073: a keyless non-loopback scorer endpoint never dials and never leaks the primary key", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  try {
    const run = await runConfidenceRun(
      server,
      { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": "http://scorer.unreachable.invalid:9" },
      "",
      true,
    );

    // The resolver refuses before any transport call: the primary lane's
    // requests are the only ones, and the failed lane left no request or
    // response artifact.
    assert.equal(scorerRequests(server), 0);
    assert.ok(server.requests.length >= 1);
    assert.ok(!existsSync(join(run.runDir, "confidence-request.json")));
    assert.ok(!existsSync(join(run.runDir, "confidence-response.json")));

    // Unscored with the missing-credential cause.
    assert.equal(run.result.outputs.confidenceStatus, "unscored");
    assert.equal(run.result.outputs.confidenceScore, "");
    const scoreArtifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.status, "unscored");
    assert.equal(scoreArtifact.cause, "missing_credential");
    // The scorer never ran, so no model identity is reported: naming the
    // configured model would claim that model graded the review.
    assert.equal(run.result.outputs.confidenceModel, "");
    assert.equal(scoreArtifact.model, "");

    // The malformed config is loud — a WARNING naming the inheritance rule and
    // the input to set — and non-fatal: the review itself still published.
    const warning = run.logs.filter((line) => line.startsWith("WARNING: confidence scorer:"));
    assert.equal(warning.length, 1, `expected exactly one configuration warning: ${JSON.stringify(run.logs)}`);
    assert.match(warning[0]!, /never inherits the primary API key/);
    assert.match(warning[0]!, /ai-confidence-api-key/);
    assert.equal(run.result.outputs.verdict, "approve");
    assert.ok(existsSync(join(run.runDir, "review-body.md")));

    // The primary lane's credential must not appear anywhere on disk for
    // this run: not in the confidence artifacts, not in the outputs, not in
    // any persisted diagnostic.
    for (const path of allFiles(run.runDir)) {
      let bytes: string;
      try {
        bytes = readFileSync(path, "utf8");
      } catch {
        // The entry vanished between the directory listing and this read;
        // nothing leaked, so nothing to assert.
        continue;
      }
      assert.ok(!bytes.includes("primary-secret-k"), `primary key leaked into ${path}`);
    }
  } finally {
    await server.close();
  }
});

test("#1140 review: a PROVIDER-authored credential in the raw scorer response never reaches the artifacts or any downstream surface", async () => {
  // The scorer's raw response body is persisted verbatim-shaped as
  // `confidence-response.json`. The provider echoes credentials THIS RUN NEVER
  // CONFIGURED — `maskKnownSecretsDeep` masks configured values only, so these
  // survived it untouched and had only the (absent) generic layer to catch them.
  const PROVIDER_API_KEY = "provider-only-secret-123456";
  const PROVIDER_BEARER = "providerbearerabcdefghijklmnop";
  const PROVIDER_SK = "sk-providerabcdefghijklmnop";
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    // Fields the scorer ignores: only the artifact path can sanitize these.
    res.end(JSON.stringify({
      id: "s1",
      object: "chat.completion",
      model: SCORER_MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ score: 4, risk: "low", reason: "fine", concerns: [] }) }, finish_reason: "stop" }],
      provider_debug: {
        credentials: `api_key=${PROVIDER_API_KEY}`,
        headers: [`Authorization: Bearer ${PROVIDER_BEARER}`],
        upstream: PROVIDER_SK,
      },
    }));
  }));
  try {
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
    });
    assert.equal(run.result.outputs.confidenceStatus, "scored");

    // The persisted artifact keeps its shape and its non-credential content,
    // but no shaped credential — the literal, in whole or in any fragment.
    const responsePath = join(run.runDir, "confidence-response.json");
    const responseBytes = readFileSync(responsePath, "utf8");
    for (const shaped of [PROVIDER_API_KEY, PROVIDER_BEARER, PROVIDER_SK]) {
      assert.ok(!responseBytes.includes(shaped), `provider-authored credential persisted verbatim in ${responsePath}`);
      assert.ok(!responseBytes.includes(shaped.slice(0, 12)), `fragment of a provider-authored credential persisted in ${responsePath}`);
    }
    const parsed = JSON.parse(responseBytes) as Record<string, unknown>;
    assert.equal(parsed.model, SCORER_MODEL, "the artifact stays valid JSON with the same shape");
    const debug = parsed.provider_debug as Record<string, unknown>;
    assert.equal(debug.credentials, "[REDACTED]");
    assert.ok(Array.isArray(debug.headers));
    assert.equal((parsed.choices as unknown[]).length, 1, "array order survives");

    // The request artifact rides the same two layers.
    const requestBytes = readFileSync(join(run.runDir, "confidence-request.json"), "utf8");
    assert.ok(!requestBytes.includes(PROVIDER_API_KEY));
    assert.equal((JSON.parse(requestBytes) as Record<string, unknown>).model, SCORER_MODEL);

    // Every persisted file, the step outputs, the summary and the published
    // comment are clean too.
    for (const path of allFiles(run.runDir)) {
      const bytes = readFileSync(path, "utf8");
      for (const shaped of [PROVIDER_API_KEY, PROVIDER_BEARER, PROVIDER_SK]) {
        assert.ok(!bytes.includes(shaped), `provider-authored credential leaked into ${path}`);
      }
    }
    assert.ok(!run.output.includes(PROVIDER_API_KEY), "provider-authored credential leaked into step outputs");
    assert.ok(!run.summary.includes(PROVIDER_API_KEY), "provider-authored credential leaked into the step summary");

    const api = new StickyCaptureApi("a".repeat(40));
    await publishReview({
      mode: "comment",
      reviewMarkdown: run.result.outputs.reviewMarkdown,
      verdict: run.result.outputs.verdict,
      verdictPolicy: run.result.verdictPolicy,
      analysisEngine: run.result.outputs.analysisEngine,
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      prNumber: "7",
      commentMarker: "<!-- ai-pr-review -->",
      requiredChecks: run.result.outputs.requiredChecks,
      reviewRoute: run.result.outputs.reviewRoute,
      escalationReason: run.result.outputs.escalationReason,
      cacheHitRatio: run.result.outputs.cacheHitRatio,
      inlineFindings: false,
      inlineFindingsMax: 5,
      findings: JSON.parse(run.result.outputs.findings),
      cleanupPreviousNativeReviews: "false",
      allowApprove: false,
      approveForks: false,
      isForkPr: false,
      upstreamLinkMode: "inert",
      conditionalPresence: {
        linkedIssue: false, evidenceProvider: false, standards: false,
        toolHarnessFindings: false, toolHarnessResults: false,
      },
      forgejoPositions: false,
      confidence: {
        status: run.result.outputs.confidenceStatus ?? "",
        score: run.result.outputs.confidenceScore ?? "",
        risk: run.result.outputs.confidenceRisk ?? "",
        reason: run.result.outputs.confidenceReason ?? "",
        model: run.result.outputs.confidenceModel ?? "",
        ...(run.result.confidenceConcerns !== undefined ? { concerns: run.result.confidenceConcerns } : {}),
      },
    }, api, { diffText: "" });
    assert.equal(api.bodies.length, 1);
    assert.ok(!api.bodies[0]!.includes(PROVIDER_API_KEY), "provider-authored credential leaked into the published comment");
  } finally {
    await server.close();
  }
});

test("#1140 review: a lane credential straddling the diagnostic cap never reaches the artifact or the log line", async () => {
  // The scorer lane is a SEPARATE backend with its own credential set, but a
  // provider error body can echo ANY configured lane's secret. The smart lane's
  // secret is placed so it STARTS six characters before the 300-char diagnostic
  // cap: a mask-after-truncate pass leaves those six characters behind, and the
  // run's later re-masking of an already-truncated string cannot recover them.
  const SMART_LANE = "smart-lane-secret-0f9a8b7c6d5e";
  const prefix = "x".repeat(294);
  assert.ok(prefix.length < 300 && prefix.length + SMART_LANE.length > 300, "the secret must straddle the cap");
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.statusCode = 400;
    res.end(`${prefix}${SMART_LANE} rejected by the scorer backend`);
  }));
  try {
    const run = await runConfidenceRun(
      server,
      { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url, "ai-smart-api-key": SMART_LANE },
      "",
      true,
    );
    assert.equal(run.result.outputs.confidenceStatus, "unscored");

    const scoreArtifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.cause, "http_400");
    const diagnostic = String(scoreArtifact.diagnostic ?? "");
    assert.ok(diagnostic !== "", "the transport diagnostic is persisted");
    assert.ok(!diagnostic.includes(SMART_LANE), `lane credential survived in the persisted diagnostic: ${diagnostic}`);
    assert.ok(!diagnostic.includes(SMART_LANE.slice(0, 6)), `partial lane credential survived the diagnostic cap: ${diagnostic}`);

    // The same diagnostic goes to the runner console. (The scorer's
    // configuration warning also contains "confidence scorer:" — pin the line
    // this test is about.)
    const lines = run.logs.filter((line) => line.startsWith("confidence scorer:"));
    assert.equal(lines.length, 1, `expected exactly one confidence log line: ${JSON.stringify(run.logs)}`);
    assert.ok(!lines[0]!.includes(SMART_LANE), `lane credential leaked into the runner log: ${lines[0]}`);
    assert.ok(!lines[0]!.includes(SMART_LANE.slice(0, 6)), `partial lane credential leaked into the runner log: ${lines[0]}`);

    // And nowhere else on disk for this run.
    for (const path of allFiles(run.runDir)) {
      const bytes = readFileSync(path, "utf8");
      assert.ok(!bytes.includes(SMART_LANE), `lane credential leaked into ${path}`);
      assert.ok(!bytes.includes(SMART_LANE.slice(0, 6)), `partial lane credential leaked into ${path}`);
    }

    // Fail-soft: the review itself is untouched.
    assert.equal(run.result.outputs.verdict, "approve");
  } finally {
    await server.close();
  }
});

/** The scorer lane's captured requests, by model name (the mock server keeps
 * the headers and body; the request target is captured in the handler). */
function scorerCapturedRequests(server: MockServer): Array<{ body: string; headers: Record<string, string | string[] | undefined> }> {
  return server.requests
    .filter((request) => {
      try {
        return (JSON.parse(request.body) as Record<string, unknown>).model === SCORER_MODEL;
      } catch {
        return false;
      }
    })
    .map((request) => ({ body: request.body, headers: request.headers }));
}

test("#1073: the scorer is default-off on a fork PR — no request, no artifact, no marker key", async () => {
  // The scorer's prompt is privileged review-derived output (final findings,
  // summary, coverage account, review_result, required checks) sent outward
  // over a privileged credential, so on a fork PR it must not run at all
  // unless the operator opted in.
  const SCORER_CREDENTIAL = "scorer-lane-secret-a1b2c3d4e5f6";
  const FORK_MARKER = "fork-private-review-content-marker-9911";
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 5, risk: "low", reason: "all clear", concerns: [] })));
  }));
  const scorerInputs = {
    "ai-confidence-model": SCORER_MODEL,
    "ai-confidence-base-url": server.url,
    "ai-confidence-api-key": SCORER_CREDENTIAL,
  };
  try {
    const gated = await runConfidenceRun(server, scorerInputs, `private notes: ${FORK_MARKER}`, true, { env: { IS_FORK_PR: "true" } });

    // No scorer wire attempt, and nothing crossed outward on the scorer's
    // behalf: its credential appears on no captured request at all.
    assert.equal(scorerRequests(server), 0);
    assert.ok(server.requests.length >= 1, "the primary lane still reviewed the fork PR");
    for (const request of server.requests) {
      assert.ok(!JSON.stringify(request.headers).includes(SCORER_CREDENTIAL), "the scorer credential was sent on some lane");
    }

    // No confidence surface anywhere: outputs empty, no artifacts, no marker
    // keys, no published section.
    assert.equal(gated.result.outputs.confidenceStatus, "");
    assert.equal(gated.result.outputs.confidenceScore, "");
    assert.equal(gated.result.outputs.confidenceRisk, "");
    assert.equal(gated.result.outputs.confidenceReason, "");
    assert.equal(gated.result.outputs.confidenceModel, "");
    assert.match(gated.output, /^confidence-status=$/m);
    for (const name of ["confidence-score.json", "confidence-request.json", "confidence-response.json"]) {
      assert.ok(!existsSync(join(gated.runDir, name)), `${name} was written on a gated fork run`);
    }
    assert.doesNotMatch(gated.result.marker, /confidence/);
    assert.ok(!gated.summary.includes("Independent confidence"));
    // Loud about the skip, and the reason names the override.
    const warning = gated.logs.filter((line) => line.includes("ai-confidence-enable-for-forks"));
    assert.equal(warning.length, 1, `expected one fork-gate warning: ${JSON.stringify(gated.logs)}`);
    assert.match(warning[0]!, /cross-repository pull request/);

    // The review itself is untouched by the gate.
    assert.equal(gated.result.outputs.verdict, "approve");
    assert.ok(existsSync(join(gated.runDir, "review-body.md")));

    // The operator override is the only thing that turns it on.
    const overridden = await runConfidenceRun(
      server,
      { ...scorerInputs, "ai-confidence-enable-for-forks": "true" },
      `private notes: ${FORK_MARKER}`,
      true,
      { env: { IS_FORK_PR: "true" } },
    );
    assert.equal(scorerRequests(server), 1);
    // Positive control: the very same fork-authored content DOES reach the
    // scorer once the override is set, so the gated run's silence is the gate
    // and not an inert fixture.
    assert.ok(
      scorerRequestBodies(server).some((body) => body.includes(FORK_MARKER)),
      "the ungated run sends the fork's content outward, so the gated run's silence is the gate",
    );
    assert.equal(overridden.result.outputs.confidenceStatus, "scored");
    assert.equal(overridden.result.outputs.confidenceScore, "5");
    assert.ok(existsSync(join(overridden.runDir, "confidence-score.json")));
    assert.match(overridden.result.marker, /"confidence_status":"scored"/);
    assert.ok(!overridden.logs.some((line) => line.includes("ai-confidence-enable-for-forks")), "the override must not warn");

    // Not a fork: the gate never applies.
    const trusted = await runConfidenceRun(server, scorerInputs, `private notes: ${FORK_MARKER}`);
    assert.equal(scorerRequests(server), 2);
    assert.equal(trusted.result.outputs.confidenceStatus, "scored");
  } finally {
    await server.close();
  }
});

test("#1073: the configured scorer key reaches the wire in the Authorization header and nowhere else", async () => {
  const SENTINEL = "sk-run-confidence-sentinel-4d2f8b16a7c3";
  const targets: string[] = [];
  const server = await startMockServer((req, body, res) => {
    let model = "";
    try {
      model = String((JSON.parse(body) as Record<string, unknown>).model ?? "");
    } catch {
      model = "";
    }
    if (model !== SCORER_MODEL) {
      res.setHeader("Content-Type", "application/json");
      res.end(verdictBody(baseVerdict()));
      return;
    }
    targets.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 4, risk: "low", reason: "fine", concerns: [] })));
  });
  try {
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
      "ai-confidence-api-key": SENTINEL,
    });
    assert.equal(run.result.outputs.confidenceStatus, "scored");

    // The wire: exactly one request, the credential in exactly one header.
    const captured = scorerCapturedRequests(server);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.headers.authorization, `Bearer ${SENTINEL}`);
    const nonAuth = { ...captured[0]!.headers };
    delete nonAuth.authorization;
    assert.ok(!JSON.stringify(nonAuth).includes(SENTINEL), "the credential rode a second header");
    assert.equal(targets.length, 1);
    assert.ok(!targets[0]!.includes(SENTINEL), "the credential rode the request URL");
    assert.ok(!captured[0]!.body.includes(SENTINEL), "the credential rode the request body");
    // Not in this process's argv either — the transport is the typed Node
    // HTTP seam, never a spawned curl.
    assert.ok(!readFileSync("/proc/self/cmdline", "utf8").includes(SENTINEL), "the credential reached process argv");

    // Nor in any artifact, output, or summary line the run persists.
    for (const path of allFiles(run.runDir)) {
      assert.ok(!readFileSync(path, "utf8").includes(SENTINEL), `the credential leaked into ${path}`);
    }
    assert.ok(!run.output.includes(SENTINEL));
    assert.ok(!run.summary.includes(SENTINEL));
  } finally {
    await server.close();
  }
});

test("#1073: a provider error echoing the scorer credential is masked in the artifact, the log, and on disk", async () => {
  const SENTINEL = "sk-run-confidence-sentinel-4d2f8b16a7c3";
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: `invalid api key: ${SENTINEL}` } }));
  }));
  try {
    const run = await runConfidenceRun(
      server,
      { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url, "ai-confidence-api-key": SENTINEL },
      "",
      true,
    );
    assert.equal(run.result.outputs.confidenceStatus, "unscored");
    const scoreArtifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.cause, "http_401");
    assert.ok(String(scoreArtifact.diagnostic ?? "").length > 0, "the failure is still surfaced");
    for (const path of allFiles(run.runDir)) {
      assert.ok(!readFileSync(path, "utf8").includes(SENTINEL), `the credential leaked into ${path}`);
    }
    assert.ok(!run.output.includes(SENTINEL));
    assert.ok(!run.summary.includes(SENTINEL));
    assert.ok(!run.logs.join("\n").includes(SENTINEL), "the credential leaked into the runner log");
    // Fail-soft: the review itself still published.
    assert.equal(run.result.outputs.verdict, "approve");
  } finally {
    await server.close();
  }
});

test("#1073: comment mode with the legacy publish-review-comment flag unset does NOT score", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 5, risk: "low", reason: "all clear", concerns: [] })));
  }));
  const scorerInputs = { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url };
  try {
    // The scorer call is privileged and must not fire when the action entry's
    // publish step is skipped: `comment` mode with the legacy
    // `publish-review-comment` flag false never publishes, so scoring it
    // would make an outbound model call for a review that lands nowhere.
    const commentMode = await runConfidenceRun(server, {
      ...scorerInputs,
      "publish-mode": "comment",
      "publish-review-comment": "false",
    }, "", true);
    assert.equal(scorerRequests(server), 0, "the scorer fired for a run whose publish step is skipped");
    assert.equal(commentMode.result.outputs.confidenceStatus, "unscored");
    // No wire artifacts: the model was never called.
    for (const name of ["confidence-request.json", "confidence-response.json"]) {
      assert.ok(!existsSync(join(commentMode.runDir, name)), `${name} was written for a run that never called the scorer`);
    }
    // The cause is observable: the score artifact records WHY there is no
    // score, so `unscored` is never an unexplained status.
    const skippedArtifact = JSON.parse(readFileSync(join(commentMode.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(skippedArtifact.status, "unscored");
    assert.equal(skippedArtifact.cause, "not_published");
    assert.equal(skippedArtifact.score, null);
    assert.equal(skippedArtifact.model, "");
    // The cause reaches the log too, not only the persisted artifact.
    assert.ok(
      commentMode.logs.some((line) => line.includes("confidence scorer: unscored (not_published)")),
      `expected the not_published cause in the log: ${JSON.stringify(commentMode.logs)}`,
    );
    // The review itself still completed; only the entry-level publish step
    // (and with it the scorer) is skipped.
    assert.equal(commentMode.result.outputs.verdict, "approve");
    assert.ok(commentMode.result.outputs.reviewMarkdown.length > 0);
  } finally {
    await server.close();
  }
});

test("#1073: the risk band is the scorer's own, not a function of the score", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 5, risk: "critical", reason: "wide blast radius", concerns: [] })));
  }));
  try {
    // The band is the model's own assessment and travels through untouched:
    // `critical` next to a 5/5 score is a legal answer, not a contradiction
    // for the action to silently rewrite into a score-derived band.
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": server.url,
    });
    assert.equal(run.result.outputs.confidenceStatus, "scored");
    assert.equal(run.result.outputs.confidenceScore, "5");
    assert.equal(run.result.outputs.confidenceRisk, "critical");
    const scoreArtifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.risk, "critical");
    assert.deepEqual(scoreArtifact.caps, []);
  } finally {
    await server.close();
  }
});

test("#1073: comment mode with the legacy publish-review-comment flag set does score", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 5, risk: "low", reason: "all clear", concerns: [] })));
  }));
  const scorerInputs = { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url };
  try {
    // With the legacy flag set, the action entry's publish step runs for
    // `comment` mode, so the scorer grades the review.
    const commentMode = await runConfidenceRun(server, {
      ...scorerInputs,
      "publish-mode": "comment",
      "publish-review-comment": "true",
    });
    assert.ok(scorerRequests(server) > 0, "the scorer skipped a publishing comment-mode run");
    assert.equal(commentMode.result.outputs.confidenceStatus, "scored");
    assert.equal(commentMode.result.outputs.confidenceScore, "5");
    for (const name of ["confidence-request.json", "confidence-response.json", "confidence-score.json"]) {
      assert.ok(existsSync(join(commentMode.runDir, name)), `${name} is missing for a scored comment-mode run`);
    }
    assert.match(commentMode.result.marker, /"confidence_status":"scored"/);
    assert.match(commentMode.result.marker, /"confidence_score":5/);
  } finally {
    await server.close();
  }
});

test("#1073: review_blockers mode publishes a native review, so the scorer grades it", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 4, risk: "low", reason: "clean", concerns: [] })));
  }));
  const scorerInputs = { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url };
  try {
    // #1161: `review_blockers` publishes a native review like the other
    // native modes, so its runs are scorer-eligible.
    const blockersMode = await runConfidenceRun(server, {
      ...scorerInputs,
      "publish-mode": "review_blockers",
    });
    assert.ok(scorerRequests(server) > 0, "the scorer skipped a review_blockers-mode run");
    assert.equal(blockersMode.result.outputs.confidenceStatus, "scored");
    assert.equal(blockersMode.result.outputs.confidenceScore, "4");
    for (const name of ["confidence-request.json", "confidence-response.json", "confidence-score.json"]) {
      assert.ok(existsSync(join(blockersMode.runDir, name)), `${name} is missing for a scored review_blockers-mode run`);
    }
    assert.match(blockersMode.result.marker, /"confidence_status":"scored"/);
    assert.match(blockersMode.result.marker, /"confidence_score":4/);
  } finally {
    await server.close();
  }
});

test("#1073: a run that reviewed nothing never calls the scorer", async () => {
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(chatBody(SCORER_MODEL, JSON.stringify({ score: 5, risk: "low", reason: "all clear", concerns: [] })));
  }));
  try {
    // No real model review happened (primary unavailable): the scorer is
    // not asked to grade a failure notice.
    const primaryDown = await startMockServer((_req, _body, res) => {
      res.statusCode = 500;
      res.end("primary unavailable");
    });
    try {
      const incompleteRunDir = mkdtempSync(join(tmpdir(), "v3-run-confidence-"));
      const incomplete = await runReview({
        env: {
          GITHUB_OUTPUT: join(incompleteRunDir, "gh-output.txt"),
          GITHUB_STEP_SUMMARY: join(incompleteRunDir, "step.md"),
          IS_FORK_PR: "false",
        },
        inputs: {
          "github-token": "tok", repo: "o/r", "pr-number": "7",
          "ai-base-url": primaryDown.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "primary-secret-k",
          "ai-primary-retries": "0", "ai-primary-retry-delay-sec": "0",
          "ai-connect-timeout-sec": "2", "ai-request-timeout-sec": "2", "deep-review": "false",
          "tool-mode": "off", "review-routing-mode": "off",
          "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url,
        },
        runDir: incompleteRunDir,
        workspace: incompleteRunDir,
        platformAdapter: mockPlatform(),
        persistArtifacts: true,
        quiet: true,
      });
      assert.equal(scorerRequests(server), 0, "the scorer graded a run that produced no review");
      assert.equal(incomplete.outputs.confidenceStatus, "unscored");
      assert.equal(incomplete.outputs.confidenceScore, "");
      assert.doesNotMatch(incomplete.marker, /"confidence_score":/);
      assert.ok(!existsSync(join(incompleteRunDir, "confidence-request.json")), "a wire artifact was written for a review that never happened");
    } finally {
      await primaryDown.close();
    }
  } finally {
    await server.close();
  }
});

test("#1073: a disabled run clears stale confidence artifacts and leaves the marker byte-identical", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const STALE = JSON.stringify({ version: 1, status: "scored", score: 5, risk: "low", reason: "from an earlier run", concerns: [], model: SCORER_MODEL, cause: "", caps: [] });
  try {
    const seeded = await runConfidenceRun(server, {}, "", false, {
      seed: { "confidence-score.json": STALE, "confidence-request.json": STALE, "confidence-response.json": STALE },
    });
    const clean = await runConfidenceRun(server, {});
    for (const name of ["confidence-score.json", "confidence-request.json", "confidence-response.json"]) {
      assert.ok(!existsSync(join(seeded.runDir, name)), `${name} survived a disabled run`);
      assert.ok(!existsSync(join(clean.runDir, name)));
    }
    // The disabled marker is exactly the pre-#1073 shape, and it is a pure
    // function of the run: nothing about the stale files reaches it.
    assert.equal(seeded.result.marker, clean.result.marker);
    assert.doesNotMatch(seeded.result.marker, /confidence/);
    for (const [field, value] of Object.entries({
      confidenceStatus: "", confidenceScore: "", confidenceRisk: "", confidenceReason: "", confidenceModel: "",
    })) {
      assert.equal((seeded.result.outputs as unknown as Record<string, unknown>)[field], value, `${field} must stay empty when disabled`);
    }
    assert.equal(scorerRequests(server), 0);
  } finally {
    await server.close();
  }
});

test("#1073: a run that ends unscored clears stale confidence artifacts too", async () => {
  const STALE = JSON.stringify({ version: 1, status: "scored", score: 5, risk: "low", reason: "from an earlier run", concerns: [], model: SCORER_MODEL, cause: "", caps: [] });
  const names = ["confidence-score.json", "confidence-request.json", "confidence-response.json"];
  // Enabled and publishing, but the review model itself failed, so there
  // is no real verdict: `incomplete_review` is the same "no score this run"
  // case and must not leave an earlier run's score in the run dir either.
  const failing = await startMockServer((_req, _body, res) => {
    // A well-formed HTTP answer carrying no verdict, so the review has no
    // usable result without entering any transport-failure retry path.
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "no verdict here" } }));
  });
  try {
    const incomplete = await runConfidenceRun(
      failing,
      { "ai-confidence-model": SCORER_MODEL },
      "",
      false,
      { seed: Object.fromEntries(names.map((name) => [name, STALE])) },
    );
    assert.equal(incomplete.result.outputs.confidenceStatus, "unscored");
    assert.equal(scorerRequests(failing), 0);
    // The stale wire artifacts are gone, and the stale score is replaced by
    // THIS run's own unscored score, which carries the cause.
    for (const name of ["confidence-request.json", "confidence-response.json"]) {
      assert.ok(!existsSync(join(incomplete.runDir, name)), `${name} survived an incomplete-review run`);
    }
    const incompleteArtifact = JSON.parse(readFileSync(join(incomplete.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(incompleteArtifact.status, "unscored");
    assert.equal(incompleteArtifact.cause, "incomplete_review");
    assert.equal(incompleteArtifact.score, null);
    assert.notEqual(incompleteArtifact.reason, "from an earlier run");
    // `unscored` still records that the scorer ran and produced nothing —
    // status without a score. It is the *disabled* run that has no marker key.
    assert.match(incomplete.result.marker, /"confidence_status":"unscored"/);
    assert.doesNotMatch(incomplete.result.marker, /confidence_score/);
  } finally {
    await failing.close();
  }
});

test("#1073: a failed scorer call leaves no wire artifacts beside the fresh unscored score", async () => {
  // A reused run dir (`PR_REVIEWER_RUN_DIR`) carries the previous run's wire
  // artifacts. A transport failure produces NO request/response payload, so
  // the stale files must be REMOVED — never left sitting next to the fresh
  // `unscored` score, where a later reader could pair an earlier run's wire
  // artifact with this run's result.
  const STALE = JSON.stringify({ version: 1, status: "scored", score: 5, risk: "low", reason: "from an earlier run", concerns: [], model: SCORER_MODEL, cause: "", caps: [] });
  // The scorer lane answers 429; the primary lane still gets its verdict, so
  // the review itself completes and the run reaches the artifact-write block.
  const server = await startMockServer(routedHandler((_req, _body, res) => {
    res.statusCode = 429;
    res.end("rate limited");
  }));
  try {
    const run = await runConfidenceRun(
      server,
      { "ai-confidence-model": SCORER_MODEL, "ai-confidence-base-url": server.url },
      "",
      false,
      { seed: { "confidence-request.json": STALE, "confidence-response.json": STALE } },
    );

    // The scorer call was really attempted, and really failed.
    assert.equal(scorerRequests(server), 1);
    assert.equal(run.result.outputs.confidenceStatus, "unscored");

    // The fresh score is written; the stale wire artifacts are gone.
    assert.ok(existsSync(join(run.runDir, "confidence-score.json")), "the fresh score artifact is missing");
    assert.ok(!existsSync(join(run.runDir, "confidence-request.json")), "a stale request artifact survived a failed scorer call");
    assert.ok(!existsSync(join(run.runDir, "confidence-response.json")), "a stale response artifact survived a failed scorer call");
    const scoreArtifact = JSON.parse(readFileSync(join(run.runDir, "confidence-score.json"), "utf8")) as Record<string, unknown>;
    assert.equal(scoreArtifact.status, "unscored");
    assert.equal(scoreArtifact.cause, "http_429");

    // The review itself is untouched by the failed scorer call.
    assert.equal(run.result.outputs.verdict, "approve");
  } finally {
    await server.close();
  }
});
