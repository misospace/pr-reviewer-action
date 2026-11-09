/** #1576: the machine-verifiable trusted-review attestation.
 *
 * The unit half pins the decision table directly, including the #1565
 * acceptance scenarios (provider-exhausted advisory -> never `approved`;
 * true native APPROVE -> `approved`; native REQUEST_CHANGES -> `blocked`;
 * skip -> `skipped`; native API failure -> `unavailable`) and the guards
 * that make `approved` unreachable without a landed native approval on a
 * proven exact head.
 *
 * The integration half drives the real `actionMain()` entry against the
 * same mocked GitHub/model seam as `review-bundle.test.ts` and reads both
 * machine surfaces (`review-attestation` step output and the bundle's
 * `attestation` section) back, asserting they agree. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeReviewAttestation,
  parseReviewAttestation,
  serializeReviewAttestation,
  REVIEW_ATTESTATION_CONCLUSIONS,
  REVIEW_ATTESTATION_REASON_CODES,
  type ReviewAttestationSignals,
} from "../src/publish/attestation.js";
import { buildReviewBundle, parseReviewBundle, type ReviewBundleInput } from "../src/publish/bundle.js";
import { actionMain } from "../src/run/action.js";
import { startMockServer, type CapturedRequest } from "./helpers.js";

const HEAD = "a".repeat(40);

function attest(signals: ReviewAttestationSignals) {
  return computeReviewAttestation(signals);
}

const cleanApprove: ReviewAttestationSignals = {
  reviewProduced: true,
  verdict: "approve",
  requiredChecks: "none",
  reviewResult: "clean",
  incompleteReason: "none",
  headSha: HEAD,
};

test("#1576: a landed native APPROVE on a proven head is the ONLY approved attestation", () => {
  const a = attest({
    ...cleanApprove,
    publication: { status: "published", native: { event: "APPROVE", submitted: true } },
  });
  assert.deepEqual(a, { conclusion: "approved", reason_code: "native_approval_submitted", head_sha: HEAD });
  // required-check state "complete" qualifies identically to "none".
  assert.equal(attest({
    ...cleanApprove,
    requiredChecks: "complete",
    publication: { status: "published", native: { event: "APPROVE", submitted: true } },
  }).conclusion, "approved");
});

test("#1576: without a landed native APPROVE an approve verdict never reaches approved", () => {
  const neverApproved: Array<[string, ReviewAttestationSignals, string, string]> = [
    // Advisory publication (comment / review_comment modes): published, but
    // no verdict-bearing native event — the #1565 green-workflow case.
    ["advisory", { ...cleanApprove, publication: { status: "published" } }, "incomplete", "advisory_only"],
    // The publish boundary withheld the approval (#1447 abstention).
    ["withheld", {
      ...cleanApprove,
      publication: { status: "published", native: { event: "COMMENT", submitted: true } },
    }, "incomplete", "approval_withheld"],
    // A native APPROVE submission that FAILED is unavailable, not silently
    // incomplete and never approved.
    ["submit-failed", {
      ...cleanApprove,
      publication: { status: "failed", native: { event: "APPROVE", submitted: false } },
    }, "unavailable", "native_approval_failed"],
    ["other-publication-failure", {
      ...cleanApprove,
      publication: { status: "failed", native: { event: "COMMENT", submitted: false } },
    }, "unavailable", "publication_failed"],
    // A newer push landed: the conclusion binds a stale head.
    ["superseded", {
      ...cleanApprove,
      publication: { status: "superseded" },
    }, "incomplete", "superseded_head"],
    // Produced but never published certifies nothing.
    ["not-published", { ...cleanApprove }, "incomplete", "not_published"],
    // Coverage and required-check gaps outrank publication.
    ["required-checks", {
      ...cleanApprove,
      requiredChecks: "incomplete",
      publication: { status: "published", native: { event: "APPROVE", submitted: true } },
    }, "incomplete", "required_checks_incomplete"],
    ["execution", {
      ...cleanApprove,
      incompleteReason: "execution",
      publication: { status: "published", native: { event: "APPROVE", submitted: true } },
    }, "incomplete", "coverage_incomplete"],
    ["result-partial", {
      ...cleanApprove,
      reviewResult: "partial",
      publication: { status: "published", native: { event: "APPROVE", submitted: true } },
    }, "incomplete", "coverage_incomplete"],
    ["partial-coverage-artifact", {
      ...cleanApprove,
      partialCoverage: true,
      publication: { status: "published", native: { event: "APPROVE", submitted: true } },
    }, "incomplete", "coverage_incomplete"],
    // An unprovable head can never carry approved.
    ["unknown-head", {
      ...cleanApprove,
      headSha: "",
      publication: { status: "published", native: { event: "APPROVE", submitted: true } },
    }, "unavailable", "head_unknown"],
  ];
  for (const [name, signals, conclusion, reason] of neverApproved) {
    const a = attest(signals);
    assert.notEqual(a.conclusion, "approved", `${name} must never attest approved`);
    assert.deepEqual(a, { conclusion, reason_code: reason, head_sha: signals.headSha ?? "" }, name);
  }
});

test("#1576: the provider-exhausted advisory paths attest unavailable, never approved (#1565)", () => {
  // Primary HTTP 429 exhausted, fallback returned an advisory approve with
  // zero evidence: the degraded gate bypass signal names it, and the
  // attestation outranks the verdict and publication surfaces.
  const degraded = attest({
    reviewProduced: true,
    degraded: true,
    verdict: "approve",
    requiredChecks: "none",
    reviewResult: "partial",
    incompleteReason: "execution",
    headSha: HEAD,
    publication: { status: "published", native: { event: "COMMENT", submitted: true } },
  });
  assert.deepEqual(degraded, { conclusion: "unavailable", reason_code: "degraded_no_evidence", head_sha: HEAD });
  // on-model-failure=notice: the synthetic request_changes verdict is the
  // model-unavailable capability failure, not a trusted block.
  const notice = attest({
    reviewProduced: true,
    modelUnavailable: true,
    degraded: true,
    verdict: "request_changes",
    requiredChecks: "none",
    reviewResult: "issues",
    incompleteReason: "none",
    headSha: HEAD,
    publication: { status: "published", native: { event: "REQUEST_CHANGES", submitted: true } },
  });
  assert.deepEqual(notice, { conclusion: "unavailable", reason_code: "model_unavailable", head_sha: HEAD });
  // A degraded request_changes (fallback with no evidence) is not a block.
  assert.equal(attest({
    reviewProduced: true,
    degraded: true,
    verdict: "request_changes",
    headSha: HEAD,
  }).conclusion, "unavailable");
  // A run that produced no verdict at all is unavailable.
  assert.deepEqual(attest({ reviewProduced: true, verdict: "", headSha: HEAD }), {
    conclusion: "unavailable", reason_code: "no_verdict", head_sha: HEAD,
  });
});

test("#1576: crash, request_changes and skip attest unavailable, blocked and skipped", () => {
  assert.deepEqual(attest({ crashed: true }), { conclusion: "unavailable", reason_code: "run_crashed", head_sha: "" });
  assert.deepEqual(attest({ reviewProduced: true, verdict: "request_changes", headSha: HEAD }), {
    conclusion: "blocked", reason_code: "request_changes", head_sha: HEAD,
  });
  // A landed native REQUEST_CHANGES blocks even with inconsistent verdict
  // fields (defensive fail-closed).
  assert.deepEqual(attest({
    ...cleanApprove,
    publication: { status: "published", native: { event: "REQUEST_CHANGES", submitted: true } },
  }), { conclusion: "blocked", reason_code: "request_changes", head_sha: HEAD });
  // A native REQUEST_CHANGES submission the API rejected is the capability
  // failure, not a landed block — symmetric with `native_approval_failed`.
  assert.deepEqual(attest({
    reviewProduced: true,
    verdict: "request_changes",
    headSha: HEAD,
    publication: { status: "failed", native: { event: "REQUEST_CHANGES", submitted: false } },
  }), { conclusion: "unavailable", reason_code: "native_submission_failed", head_sha: HEAD });
  // A request_changes verdict whose review was superseded by a newer push
  // still blocks on the verdict (the bundle pins the exact head; consumers
  // compare it).
  assert.deepEqual(attest({
    reviewProduced: true,
    verdict: "request_changes",
    headSha: HEAD,
    publication: { status: "superseded" },
  }), { conclusion: "blocked", reason_code: "request_changes", head_sha: HEAD });
  assert.deepEqual(attest({ reviewProduced: false, headSha: HEAD }), {
    conclusion: "skipped", reason_code: "skipped", head_sha: HEAD,
  });
  // A carried verdict never promotes a skip: the earlier run owns it.
  assert.deepEqual(attest({
    reviewProduced: false,
    verdict: "approve",
    headSha: HEAD,
    publication: { status: "published", native: { event: "APPROVE", submitted: true } },
  }), { conclusion: "skipped", reason_code: "skipped", head_sha: HEAD });
});

test("#1576: serialization round-trips and the parser fails closed", () => {
  const a = attest({
    ...cleanApprove,
    publication: { status: "published", native: { event: "APPROVE", submitted: true } },
  });
  const line = serializeReviewAttestation(a);
  assert.ok(!line.includes("\n"), "the attestation output must stay one line");
  assert.deepEqual(parseReviewAttestation(JSON.parse(line)), a);
  const rejects: unknown[] = [
    null,
    "approved",
    [],
    {},
    { conclusion: "approved" },
    { conclusion: "success", reason_code: "native_approval_submitted", head_sha: HEAD },
    { conclusion: "approved", reason_code: "looks_good", head_sha: HEAD },
    { conclusion: "approved", reason_code: "native_approval_submitted", head_sha: 7 },
    { conclusion: "APPROVED", reason_code: "native_approval_submitted", head_sha: HEAD },
  ];
  for (const value of rejects) {
    assert.equal(parseReviewAttestation(value), null, `${JSON.stringify(value)} must be refused`);
  }
  // The vocabularies are closed and every unit-test conclusion/reason pair
  // above is a member.
  assert.ok(REVIEW_ATTESTATION_CONCLUSIONS.includes("approved"));
  assert.ok(REVIEW_ATTESTATION_REASON_CODES.includes("native_approval_submitted"));
});

function bundleBase(overrides: Partial<ReviewBundleInput> = {}): ReviewBundleInput {
  return {
    state: "complete",
    reviewId: "0123456789abcdef",
    generatedAt: "2026-11-09T12:00:00.000Z",
    repository: "o/r",
    prNumber: 7,
    headSha: HEAD,
    baseSha: "b".repeat(40),
    identity: { diffFingerprint: "fp", analysisEngine: "m @ https://api.example/v1 (openai)", actionVersion: "v3.0.0" },
    findings: [],
    ...overrides,
  };
}

test("#1576: the attestation rides every bundle state and the parser guards it", () => {
  const skipped = attest({ reviewProduced: false, headSha: HEAD });
  const failed = attest({ crashed: true });
  const approved = attest({
    ...cleanApprove,
    publication: { status: "published", native: { event: "APPROVE", submitted: true } },
  });
  for (const [state, attestation] of [
    ["skipped", skipped],
    ["failed", failed],
    ["complete", approved],
  ] as const) {
    const doc = parseReviewBundle(buildReviewBundle(bundleBase({ state, attestation })));
    assert.ok(doc !== null, `${state} bundle parses`);
    assert.deepEqual(doc!.attestation, attestation, `${state} bundle carries the attestation`);
  }
  // Backward compatibility: a pre-#1576 bundle (no attestation) parses
  // unchanged, and `attestation` reads as absent — never as any conclusion.
  const legacy = parseReviewBundle(buildReviewBundle(bundleBase()));
  assert.ok(legacy !== null);
  assert.equal(legacy!.attestation, undefined);
  // A malformed attestation refuses the WHOLE document: a consumer can
  // never fall back to reading `state` as an approval signal.
  for (const bogus of [
    { conclusion: "approved", reason_code: "looks_good", head_sha: HEAD },
    { conclusion: "success", reason_code: "native_approval_submitted", head_sha: HEAD },
    { conclusion: "approved", reason_code: "native_approval_submitted" },
    "approved",
  ]) {
    const doc = JSON.parse(buildReviewBundle(bundleBase({ attestation: approved })));
    doc.attestation = bogus;
    assert.equal(parseReviewBundle(JSON.stringify(doc)), null, `refuses attestation ${JSON.stringify(bogus)}`);
  }
});

// ── Integration: the real action entry writes both surfaces at every boundary ──

function readOutputs(file: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return outputs;
}

function attestationOf(outputs: Record<string, string>) {
  return parseReviewAttestation(JSON.parse(outputs["review-attestation"] ?? "null"));
}

function verdictBody(findings: unknown[] = []): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null,
      findings, requirement_coverage: null, required_check_dispositions: [],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

async function startGithubMock(overrides?: { failReviews?: boolean }): Promise<{
  url: string;
  requests: CapturedRequest[];
  reviewEvents: string[];
  flipHead: (sha: string) => void;
  close: () => Promise<void>;
}> {
  const reviewEvents: string[] = [];
  let headSha = HEAD;
  const server = await startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
      if (req.method === "POST") {
        if (overrides?.failReviews === true) {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: "review submission rejected" }));
          return;
        }
        try {
          reviewEvents.push(String((JSON.parse(body) as Record<string, unknown>).event ?? ""));
        } catch {
          reviewEvents.push("?");
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 9 }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify([]));
      return;
    }
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 100 }));
        return;
      }
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }]));
      return;
    }
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: "write", role: "write" }));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7")) {
      if (req.headers.accept === "application/vnd.github.v3.diff") {
        res.setHeader("Content-Type", "text/plain");
        res.end("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
        return;
      }
      res.end(JSON.stringify({
        number: 7, state: "open", draft: false, title: "Update README", body: "",
        head: { sha: headSha, ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    if (url.startsWith("/user")) {
      res.end(JSON.stringify({ login: "ci-bot" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
  return {
    ...server,
    reviewEvents,
    flipHead: (sha: string): void => {
      headSha = sha;
    },
  };
}

function actionEnv(paths: {
  eventPath: string;
  runnerTemp: string;
  workspace: string;
  githubUrl: string;
  modelUrl: string;
  publishMode: string;
  omitPrNumber?: boolean;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: paths.eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_SHA: "m".repeat(40),
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: paths.githubUrl,
    GITHUB_WORKSPACE: paths.workspace,
    RUNNER_TEMP: paths.runnerTemp,
    GITHUB_OUTPUT: join(paths.runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(paths.runnerTemp, "step-summary.md"),
    ...(paths.omitPrNumber ? {} : { PR_NUMBER: "7", "INPUT_PR-NUMBER": "7" }),
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_AI-BASE-URL": paths.modelUrl,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_REREVIEW-COMMAND": "/ai-review",
    "INPUT_PUBLISH-MODE": paths.publishMode,
  };
}

function writeCommentEvent(eventPath: string, body: string, withPrLink: boolean): void {
  writeFileSync(eventPath, JSON.stringify({
    issue: withPrLink
      ? { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } }
      : { number: 7 },
    comment: { id: 42, body, user: { login: "alice" } },
    action: "created",
  }));
}

test("#1576: a native APPROVE publication attests approved, and both surfaces agree", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "attestation-approve-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-approve-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review", true);
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, publishMode: "review_verdict" });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    assert.deepEqual(github.reviewEvents, ["APPROVE"], "the native APPROVE must have been submitted");
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["publish-status"], "published");
    const a = attestationOf(outputs);
    assert.deepEqual(a, { conclusion: "approved", reason_code: "native_approval_submitted", head_sha: HEAD });
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.ok(bundle !== null);
    assert.deepEqual(bundle!.attestation, a, "the bundle and the step output carry one attestation");
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1576: an advisory review_comment publication of the same approve verdict never attests approved", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "attestation-advisory-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-advisory-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review", true);
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, publishMode: "review_comment" });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0, "the advisory publication still exits green");
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["verdict"], "approve", "the verdict output is still the review conclusion");
    const a = attestationOf(outputs);
    assert.deepEqual(a, { conclusion: "incomplete", reason_code: "advisory_only", head_sha: HEAD });
    assert.notEqual(a!.conclusion, "approved");
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.deepEqual(bundle!.attestation, a);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1576: a rejected native APPROVE submission attests unavailable and the run fails", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "attestation-approvefail-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-approvefail-temp-"));
  const github = await startGithubMock({ failReviews: true });
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review", true);
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, publishMode: "review_verdict" });
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 1, "the failed publication still fails the run");
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["publish-status"], "failed");
    const a = attestationOf(outputs);
    assert.deepEqual(a, { conclusion: "unavailable", reason_code: "native_approval_failed", head_sha: HEAD });
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.deepEqual(bundle!.attestation, a);
  } finally {
    process.stdout.write = originalWrite;
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1576: a newer push at the publication boundary attests incomplete/superseded_head", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "attestation-supersede-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-supersede-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review", true);
  // The head flips as soon as the model answers: the publication boundary
  // re-check sees the newer push and withholds the review.
  let flipped = false;
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
    if (!flipped) {
      flipped = true;
      github.flipHead("c".repeat(40));
    }
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, publishMode: "review_verdict" });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0, "a superseded publication still exits 0 (#1257)");
    assert.deepEqual(github.reviewEvents, [], "nothing was submitted for the stale head");
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    assert.equal(outputs["publish-status"], "superseded");
    const a = attestationOf(outputs);
    assert.deepEqual(a, { conclusion: "incomplete", reason_code: "superseded_head", head_sha: HEAD });
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.equal(bundle!.state, "superseded");
    assert.equal(bundle!.head_sha, HEAD, "the bundle pins the exact head that was reviewed");
    assert.deepEqual(bundle!.attestation, a);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1576: an exhausted provider attests unavailable, never approved, and never blocks as a defect (#1565)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "attestation-outage-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-outage-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review", true);
  // Every model route returns HTTP 429 — the provider is exhausted.
  const model = await startMockServer((_req, _body, res) => {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: "Token Plan rate limit exhausted" } }));
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, publishMode: "review_verdict" });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0, "the notice path still exits 0 (on-model-failure default)");
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    const a = attestationOf(outputs);
    assert.equal(a!.conclusion, "unavailable");
    assert.equal(a!.reason_code, "model_unavailable");
    assert.notEqual(a!.conclusion, "approved");
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.deepEqual(bundle!.attestation, a);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1576: a skipped run attests skipped, including the plain-issue no-op boundary", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "attestation-skip-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-skip-temp-"));
  const github = await startGithubMock();
  const eventPath = join(runnerTemp, "event.json");
  writeCommentEvent(eventPath, "/ai-review", false);
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const env = actionEnv({ eventPath, runnerTemp, workspace, githubUrl: github.url, modelUrl: model.url, publishMode: "review_verdict", omitPrNumber: true });
  try {
    const exitCode = await actionMain(env);
    assert.equal(exitCode, 0);
    const outputs = readOutputs(env.GITHUB_OUTPUT!);
    const a = attestationOf(outputs);
    assert.equal(a!.conclusion, "skipped");
    assert.equal(a!.reason_code, "skipped");
    const bundle = parseReviewBundle(outputs["review-bundle"] ?? "");
    assert.equal(bundle!.state, "skipped");
    assert.deepEqual(bundle!.attestation, a);
  } finally {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("#1576: a crash before any review still leaves the attestation output (unavailable)", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "attestation-crash-temp-"));
  const outputFile = join(runnerTemp, "gh-output.txt");
  try {
    // A missing required input fails in the host setup, before any stage.
    await assert.rejects(actionMain({
      GITHUB_REPOSITORY: "o/r",
      PR_NUMBER: "7",
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: runnerTemp,
    }));
    const a = attestationOf(readOutputs(outputFile));
    assert.deepEqual(a, { conclusion: "unavailable", reason_code: "run_crashed", head_sha: "" });
    const bundle = parseReviewBundle(readOutputs(outputFile)["review-bundle"] ?? "");
    assert.deepEqual(bundle!.attestation, a);
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
