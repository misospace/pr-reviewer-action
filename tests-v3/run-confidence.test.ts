import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { publishReview } from "../src/publish/publish.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import type { NativeReviewRequest, PublishCommentRef, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";
import { startMockServer, type MockServer } from "./helpers.js";

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
}

async function runConfidenceRun(server: MockServer, extraInputs: Record<string, string>, prBody = ""): Promise<RunOutcome> {
  const runDir = mkdtempSync(join(tmpdir(), "v3-run-confidence-"));
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
      "ai-api-key": "primary-secret-k",
      ...extraInputs,
    },
    runDir,
    workspace: runDir,
    platformAdapter: mockPlatform(prBody),
    persistArtifacts: true,
    quiet: true,
  });
  return {
    result,
    runDir,
    output: readFileSync(outputFile, "utf8"),
    summary: readFileSync(stepSummaryFile, "utf8"),
  };
}

/** A minimal comment-mode publish API that captures the sticky body. */
class StickyCaptureApi implements PublishPlatformApi {
  readonly platform = "github" as const;
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
  // The concern evidence is hostile on purpose: the published section must
  // carry it sanitized (no live link, no raw markup) while everything else
  // stays byte-identical to the scoring-off baseline.
  const scorerAnswer = JSON.stringify({
    score: 4,
    risk: "low",
    reason: "diff is small and fully covered",
    concerns: [{ file: "README.md", line: 2, evidence: "see [x](https://github.com/o/r/pull/1) and <script>alert(1)</script>" }],
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
    const run = await runConfidenceRun(server, {
      "ai-confidence-model": SCORER_MODEL,
      "ai-confidence-base-url": "http://scorer.unreachable.invalid:9",
    });

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
