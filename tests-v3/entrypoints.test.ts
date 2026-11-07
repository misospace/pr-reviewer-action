import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { buildAdapter, buildPublishApi, publishInputFromEnv, publishMain, publishWithOutcome, readEvent } from "../src/run/entrypoints.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { publishReview } from "../src/publish/publish.js";
import { buildRunMetadataMarker } from "../src/metadata/markers.js";
import { parseInlineFindingsMax } from "../src/publish/inline-findings.js";
import type { NativeReviewRequest, NativeReviewSurface, PublishCommentRef, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";

function mockAdapter(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 7,
      title: "t",
      body: "",
      head: { sha: "a".repeat(40), ref: "f" },
      base: { ref: "main" },
      user: { login: "u" },
      changed_files: 1,
      additions: 1,
      deletions: 0,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: () => Promise.resolve("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+b\n"),
    listPrFiles: () => Promise.resolve({ ok: true, data: [] }),
    getIssue: () => Promise.resolve({ ok: false, error: "n/a" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    // #970: unprovable identity — a managed body can never authorize a skip.
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "n/a" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

test("publishInputFromEnv reads internal degraded gate-bypass eligibility", () => {
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", DEGRADED_GATE_BYPASS: "true" } as NodeJS.ProcessEnv, "github").degradedGateBypass, true);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", DEGRADED_GATE_BYPASS: "false" } as NodeJS.ProcessEnv, "github").degradedGateBypass, false);
});

// #1250: the standalone `publish` CLI reads raw env — it never sees the
// merged contract default the action path exports — so its fallback for
// INLINE_FINDINGS_MAX must be the contract's own default. These assertions
// pin the two together: changing either side without the other fails here.
test("#1250: the standalone publish CLI falls back to the contract's inline-findings-max default", () => {
  const contract = parse(readFileSync("contracts/action-v3.yml", "utf8")) as {
    inputs: { id: string; default?: unknown }[];
  };
  const declared = contract.inputs.find((input) => input.id === "inline-findings-max")?.default;
  assert.equal(typeof declared, "string", "inline-findings-max must declare a string default");
  const contractDefault = Number(declared);
  assert.equal(contractDefault, 20);

  // No INLINE_FINDINGS_MAX in the environment: the CLI's fallback is the
  // contract default, never a private literal.
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").inlineFindingsMax, contractDefault);
  // The one fallback site behind it agrees with the contract.
  assert.equal(parseInlineFindingsMax(undefined), contractDefault);
  // An explicit value still wins; an unusable one falls back to the contract.
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", INLINE_FINDINGS_MAX: "7" } as NodeJS.ProcessEnv, "github").inlineFindingsMax, 7);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", INLINE_FINDINGS_MAX: "not-a-number" } as NodeJS.ProcessEnv, "github").inlineFindingsMax, contractDefault);
});

// #1003: a standalone `publish` re-publish must carry the same triage section
// the review run wrote. An empty decision means triage never ran and renders no
// section; the fail-closed `unknown` is a real answer and still renders.
test("#1003: publishInputFromEnv carries the triage answer, and omits it when triage did not run", () => {
  const ran = publishInputFromEnv({
    PUBLISH_MODE: "comment",
    REVIEW_TRIAGE_DECISION: "required",
    REVIEW_TRIAGE_REASON: "touches the auth subsystem",
  } as NodeJS.ProcessEnv, "github");
  assert.deepEqual(ran.reviewTriage, { decision: "required", reason: "touches the auth subsystem" });

  const unknown = publishInputFromEnv({ PUBLISH_MODE: "comment", REVIEW_TRIAGE_DECISION: "unknown" } as NodeJS.ProcessEnv, "github");
  assert.deepEqual(unknown.reviewTriage, { decision: "unknown", reason: "" });

  const didNotRun = publishInputFromEnv({ PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
  assert.equal(didNotRun.reviewTriage, undefined);

  // #1003 fail-closed: `not_required` is a positive claim and needs a usable
  // supporting statement. A carried-forward or hand-edited env with no usable
  // reason must not cross this boundary as a confident negative.
  const unsubstantiated = publishInputFromEnv({
    PUBLISH_MODE: "comment",
    REVIEW_TRIAGE_DECISION: "not_required",
    REVIEW_TRIAGE_REASON: "   ",
  } as NodeJS.ProcessEnv, "github");
  assert.equal(unsubstantiated.reviewTriage?.decision, "unknown");

  const substantiated = publishInputFromEnv({
    PUBLISH_MODE: "comment",
    REVIEW_TRIAGE_DECISION: "not_required",
    REVIEW_TRIAGE_REASON: "no owning team in the escalation policy",
  } as NodeJS.ProcessEnv, "github");
  assert.deepEqual(substantiated.reviewTriage, { decision: "not_required", reason: "no owning team in the escalation policy" });
});

test("#1161: publishInputFromEnv accepts the review_blockers mode", () => {
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "review_blockers" } as NodeJS.ProcessEnv, "github").mode, "review_blockers");
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "review_verdict" } as NodeJS.ProcessEnv, "github").mode, "review_verdict");
});

test("#1161: the deprecated allow-approve input is read for the warning only, and an absent input stays absent", () => {
  // The runner merges the contract default into every input it exports, so
  // a value matching the default is indistinguishable from an unset input
  // (the same limitation the repository-config narrowing has). Only a
  // non-default value is observable — and only that one warns.
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").allowApprove, undefined);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", ALLOW_APPROVE: "" } as NodeJS.ProcessEnv, "github").allowApprove, undefined);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", ALLOW_APPROVE: "false" } as NodeJS.ProcessEnv, "github").allowApprove, undefined);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", ALLOW_APPROVE: "true" } as NodeJS.ProcessEnv, "github").allowApprove, true);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", ALLOW_APPROVE: " TRUE " } as NodeJS.ProcessEnv, "github").allowApprove, true);
});

test("#1158: the deprecated publish-review-comment input is read for the warning only, and an absent input stays absent", () => {
  // The same observable-value shape as `allow-approve` above: only a value
  // that differs from the contract default ("false") reaches the publish
  // seam, and only that one warns. Setting the input never changes what the
  // publish step runs — publication is decided by PUBLISH_MODE alone.
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").publishReviewComment, undefined);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", PUBLISH_REVIEW_COMMENT: "" } as NodeJS.ProcessEnv, "github").publishReviewComment, undefined);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", PUBLISH_REVIEW_COMMENT: "false" } as NodeJS.ProcessEnv, "github").publishReviewComment, undefined);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", PUBLISH_REVIEW_COMMENT: "true" } as NodeJS.ProcessEnv, "github").publishReviewComment, true);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", PUBLISH_REVIEW_COMMENT: " TRUE " } as NodeJS.ProcessEnv, "github").publishReviewComment, true);
});

test("publish entrypoint rejects an invalid publish mode fail-closed", async () => {
  await assert.rejects(
    publishMain({
      REPO: "o/r",
      PR_NUMBER: "7",
      PUBLISH_MODE: "nonsense",
      HEAD_SHA: "a".repeat(40),
      BASE_SHA: "b".repeat(40),
      VERDICT: "approve",
      REVIEW_MARKDOWN: "ok",
    } as unknown as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof Error && /Invalid publish_mode/.test(error.message),
  );
});

test("precheck entrypoint output file receives the v2-compatible keys", async () => {
  // Wire the real runPrecheck by injecting a stub adapter through the
  // module seam the entrypoint uses: here we assert only the pure output
  // shape mapping, using a direct runPrecheck call as the oracle.
  const { runPrecheck } = await import("../src/precheck/decide.js");
  const dir = mkdtempSync(join(tmpdir(), "v3-precheck-shape-"));
  try {
    const output = await runPrecheck({
      env: { REPO: "o/r", PR_NUMBER: "7", PLATFORM: "github", GITHUB_SERVER_URL: "https://github.com" },
      adapter: mockAdapter(),
    });
    for (const key of ["should_review", "skip_reason", "diff_fingerprint", "head_sha", "base_sha", "is_fork_pr", "resolved_platform", "effective_forgejo_api_url"]) {
      assert.ok(typeof (output as unknown as Record<string, unknown>)[key] === "string", `missing ${key}`);
    }
    assert.equal(output.head_sha, "a".repeat(40));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tangled seam boundaries (#583/#588) ──────────────────────────────────

test("a resolved tangled platform uses the Tangled publish seam and never the GitHub/Forgejo APIs", () => {
  // Precheck-side adapter seam: `buildAdapter` in this entrypoint still
  // fails loudly — Tangled read routing goes through
  // `buildPlatformReadAdapter` (#585), and lifting this guard is later
  // series work (#589/#590).
  const env = { REPO: "o/r", PR_NUMBER: "9", PLATFORM: "tangled", TANGLED_REPO_DID: "did:plc:repo" } as NodeJS.ProcessEnv;
  assert.throws(() => buildAdapter(env), TangledNotImplementedError);
  // Publish seam (#588): the dedicated Tangled ATProto API is constructed —
  // GitHubPublishApi/ForgejoPublishApi are never built for Tangled, so no
  // GitHub/Forgejo API request can be assembled as a fallback, and no
  // Python subprocess is involved anywhere in the path.
  const seam = buildPublishApi({
    ...env,
    TANGLED_PR_SOURCE_BRANCH: "feature",
    TANGLED_PR_TARGET_BRANCH: "main",
    ATPROTO_HOST: "http://127.0.0.1:9999",
    ATPROTO_HANDLE: "bot.test",
    ATPROTO_APP_PASSWORD: "secret-app-password",
  });
  assert.equal(seam.platform, "tangled");
  assert.equal(seam.api.platform, "tangled");
});

test("explicit tangled without its identity fails with the resolver diagnostic", () => {
  const env = { REPO: "o/r", PR_NUMBER: "9", PLATFORM: "tangled" } as NodeJS.ProcessEnv;
  assert.throws(
    () => buildAdapter(env),
    (e: unknown) => e instanceof Error && /TANGLED_REPO_DID/.test(e.message),
  );
});

test("tangled publish seam fails closed when ATProto configuration is missing (#588)", () => {
  const env = {
    REPO: "o/r",
    PR_NUMBER: "9",
    PLATFORM: "tangled",
    TANGLED_REPO_DID: "did:plc:repo",
    TANGLED_PR_SOURCE_BRANCH: "feature",
    TANGLED_PR_TARGET_BRANCH: "main",
  } as NodeJS.ProcessEnv;
  assert.throws(
    () => buildPublishApi(env),
    (e: unknown) => e instanceof Error && /ATPROTO_(HANDLE|APP_PASSWORD)/.test(e.message),
  );
});

// ── #873: the standalone `publish` CLI reads the run's own coverage record ──
//
// `run` and `publish` are separate processes (the composite's two steps, or
// the standalone CLI subcommands): `publish` never holds the tool harness
// in memory, so it must read the same persisted artifact `runReview` wrote,
// from PR_REVIEWER_RUN_DIR — never the checkout — or a partial-coverage run
// could still publish APPROVE through this path.

class MinimalPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  submitted: NativeReviewRequest[] = [];
  constructor(private readonly head: string) {}
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(): Promise<{ ok: boolean; created: boolean }> { return { ok: true, created: true }; }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview(request: NativeReviewRequest): Promise<{ ok: boolean }> { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    return { ok: true, threads: [], hasNextPage: false };
  }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
  async requestReviewers(): ReturnType<PublishPlatformApi["requestReviewers"]> {
    return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

function withRunDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "v3-publish-entry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withRunDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "v3-publish-entry-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// #873 maintainer follow-up: coverage truth must come from the run being
// published, not from ambient TOOL_MODE/REVIEW_ROUTE stage env (either can
// be omitted, stale, or simply wrong for the run actually sitting in the
// run dir — trusting them let a partial run read as clean, or a clean
// run's harness never get read at all). `run` now writes its own
// authoritative `review-coverage.json`; `publish` reads only that.
// ---------------------------------------------------------------------------

const PARTIAL_COVERAGE = {
  stop_reason: "tool-call-budget-exhausted",
  changed_files_total: 2,
  unread_files: ["a.ts"],
  leads_total: 0,
  unresolved_leads: [],
};

const PARTIAL_COVERAGE_HARNESS = JSON.stringify({ stop_reason: "tool-call-budget-exhausted", partial_coverage: PARTIAL_COVERAGE });
const COMPLETE_HARNESS = JSON.stringify({ stop_reason: "model_stop" }); // no partial_coverage key

/** Writes the authoritative artifact `review.ts` produces, with sensible
 * "nothing happened" defaults an override can narrow. */
function writeCoverageArtifact(dir: string, overrides: Partial<{
  version: number;
  tool_loop_ran: boolean;
  enforcement_harness: string | null;
  route: string;
  partial_coverage: unknown;
  required_checks: string | undefined;
  required_check_fold_status: unknown;
  incomplete_reason: string;
}> = {}): void {
  const artifact = {
    version: 1,
    tool_loop_ran: false,
    enforcement_harness: null,
    route: "primary",
    partial_coverage: null,
    required_checks: "complete",
    required_check_fold_status: "complete",
    ...overrides,
  };
  writeFileSync(join(dir, "review-coverage.json"), JSON.stringify(artifact));
}

test("#954: publishInputFromEnv carries valid incomplete reasons and derives execution for legacy artifacts", () => {
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { required_checks: "incomplete", incomplete_reason: "requirement_trace" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.requiredChecks, "incomplete");
    assert.equal(input.incompleteReason, "requirement_trace");
  });
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { required_checks: "complete", incomplete_reason: "requirement_trace" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.requiredChecks, "incomplete", "trace reason fail-closes stale complete metadata");
    assert.equal(input.incompleteReason, "requirement_trace");
  });
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { required_checks: undefined, incomplete_reason: "requirement_trace" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.coverageUnknown, true, "an artifact missing required_checks remains unknown");
    assert.equal(input.requiredChecks, "incomplete");
  });
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { required_checks: "incomplete", incomplete_reason: "none" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.incompleteReason, "execution");
  });
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { required_checks: "incomplete", incomplete_reason: "not-a-reason" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.incompleteReason, "execution");
  });
});

test("#873: publishInputFromEnv reads partial coverage straight from the artifact's own partial_coverage field", () => {
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: PARTIAL_COVERAGE });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.ok(input.partialCoverage);
    assert.equal(input.partialCoverage?.stop_reason, "tool-call-budget-exhausted");
    assert.equal(input.coverageUnknown, undefined);
  });
});

test("#873: tool_loop_ran:false is not a coverage gap, even with a stray partial-coverage harness file sitting in the run dir", () => {
  withRunDir((dir) => {
    writeCoverageArtifact(dir, { tool_loop_ran: false });
    // A leftover/unrelated file from a prior run, or a red herring: must
    // never be consulted when the artifact itself says tools didn't run.
    writeFileSync(join(dir, "tool-harness.json"), PARTIAL_COVERAGE_HARNESS);
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.partialCoverage, undefined);
    assert.equal(input.coverageUnknown, undefined);
  });
});

test("#873: a missing, empty, or structurally unrecognizable review-coverage.json fails closed (coverage unknown)", () => {
  withRunDir((dir) => {
    // No artifact at all.
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").coverageUnknown, true);
  });
  withRunDir((dir) => {
    writeFileSync(join(dir, "review-coverage.json"), "not json");
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").coverageUnknown, true);
  });
  withRunDir((dir) => {
    // Right shape, wrong version — never silently upgrade a future schema.
    writeFileSync(join(dir, "review-coverage.json"), JSON.stringify({ version: 2, tool_loop_ran: false }));
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").coverageUnknown, true);
  });
  withRunDir((dir) => {
    // Missing the one field this whole decision hinges on.
    writeFileSync(join(dir, "review-coverage.json"), JSON.stringify({ version: 1 }));
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").coverageUnknown, true);
  });
});

// ---------------------------------------------------------------------------
// #1455: the standalone `publish` CLI must publish the verifier's telemetry
// too. The values ride the run dir's own `confidence-score.json` artifact,
// so both publish paths publish ONE record.
// ---------------------------------------------------------------------------

/** Writes the verifier artifact the review stage produces. */
function writeConfidenceArtifact(dir: string, overrides: Partial<{
  version: number;
  status: string;
  cause: string;
  latency_ms: number;
  usage: Record<string, number>;
}> = {}): void {
  const artifact = {
    version: 2,
    rubric: "merge-safety-v1",
    status: "unscored",
    score: null,
    risk: "unknown",
    reason: "",
    concerns: [],
    model: "scorer-model",
    cause: "http_429",
    caps: [],
    parser_notes: [],
    latency_ms: 250,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
  writeFileSync(join(dir, "confidence-score.json"), JSON.stringify(artifact));
}

test("#1455: the standalone publish path reads the verifier's telemetry from the run dir artifact", () => {
  withRunDir((dir) => {
    writeConfidenceArtifact(dir);
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.deepEqual(input.confidenceTelemetry, {
      status: "unscored",
      cause: "http_429",
      latencyMs: 250,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });
});

test("#1455: the standalone publish path publishes the telemetry even when no confidence status reached the environment", () => {
  // The telemetry carries the status it was measured under, so the marker
  // does not depend on an ambient CONFIDENCE_STATUS that may be absent or
  // stale: the standalone CLI publishes what the composite action publishes
  // for the same run.
  withRunDir((dir) => {
    writeConfidenceArtifact(dir);
    for (const env of [
      { PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" },
      { PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment", CONFIDENCE_STATUS: "unscored" },
      // A stale status that contradicts the record: the marker must not
      // carry a cause beside a "scored" claim.
      { PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment", CONFIDENCE_STATUS: "scored" },
    ]) {
      const input = publishInputFromEnv(env as NodeJS.ProcessEnv, "github");
      // The publish seam builds the marker from the confidence block and the
      // telemetry exactly as the composite path does.
      const marker = buildRunMetadataMarker({
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        reviewResult: "clean",
        ...(input.confidence && input.confidence.status !== ""
          ? { confidenceStatus: input.confidence.status === "scored" || input.confidence.status === "unscored" ? input.confidence.status : "" }
          : {}),
        ...(input.confidenceTelemetry !== undefined ? { confidenceTelemetry: input.confidenceTelemetry } : {}),
      });
      assert.match(marker, /"confidence_latency_ms":250/, `marker: ${marker}`);
      assert.match(marker, /"confidence_prompt_tokens":10/, `marker: ${marker}`);
      assert.match(marker, /"confidence_total_tokens":15/, `marker: ${marker}`);
      if (env.CONFIDENCE_STATUS === "scored") {
        assert.doesNotMatch(marker, /confidence_cause/, "a scored marker carries no cause");
      } else {
        assert.match(marker, /"confidence_cause":"http_429"/, `marker: ${marker}`);
      }
    }
  });
});

test("#1455: a missing, unreadable, or version-mismatched confidence artifact publishes no telemetry", () => {
  withRunDir((dir) => {
    // No artifact at all.
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").confidenceTelemetry, undefined);
  });
  withRunDir((dir) => {
    writeFileSync(join(dir, "confidence-score.json"), "not json");
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").confidenceTelemetry, undefined);
  });
  withRunDir((dir) => {
    // A version-1 artifact is a pre-#1369 prose-quality confidence grade:
    // its semantics are not comparable, so it is trusted for nothing.
    writeConfidenceArtifact(dir, { version: 1 });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").confidenceTelemetry, undefined);
  });
  withRunDir((dir) => {
    // A run whose verifier measured no latency and no usage still carries
    // its unscored cause — that is the fact the collector needs most.
    writeConfidenceArtifact(dir, { latency_ms: undefined as unknown as number, usage: undefined as unknown as Record<string, number> });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.confidenceTelemetry?.status, "unscored");
    assert.equal(input.confidenceTelemetry?.cause, "http_429");
    assert.equal(input.confidenceTelemetry?.latencyMs, null);
    assert.equal(input.confidenceTelemetry?.usage, null);
  });
  withRunDir((dir) => {
    // A record the verifier never ran for publishes nothing.
    writeConfidenceArtifact(dir, { status: "disabled" });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").confidenceTelemetry, undefined);
  });
});

test("#1455: a cause that is not a conservative machine token never leaves the artifact", () => {
  withRunDir((dir) => {
    writeConfidenceArtifact(dir, { cause: "provider said: rate limited" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.confidenceTelemetry?.cause, "");
  });
});

test("#873/#838: no explicit PR_REVIEWER_RUN_DIR (absent or empty) fails closed, never falling back to cwd/GITHUB_WORKSPACE", () => {
  for (const env of [
    { PUBLISH_MODE: "comment" },
    { PUBLISH_MODE: "comment", PR_REVIEWER_RUN_DIR: "" },
    { PUBLISH_MODE: "comment", PR_REVIEWER_RUN_DIR: "   " },
  ]) {
    const input = publishInputFromEnv(env as NodeJS.ProcessEnv, "github");
    assert.equal(input.partialCoverage, undefined, JSON.stringify(env));
    assert.equal(input.coverageUnknown, true, JSON.stringify(env));
  }
});

test("#873/#1447: the CLI publish path (publishInputFromEnv + publishReview) withholds the approve when partial coverage is persisted", async () => {
  await withRunDirAsync(async (dir) => {
    writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: PARTIAL_COVERAGE });
    const head = "a".repeat(40);
    const env = {
      PR_REVIEWER_RUN_DIR: dir,
      VERDICT: "approve",
      REQUIRED_CHECKS: "complete",
      PUBLISH_MODE: "review_verdict",
      ALLOW_APPROVE: "true",
      IS_FORK_PR: "false",
      HEAD_SHA: head,
      PR_NUMBER: "7",
      COMMENT_MARKER: "<!-- ai-pr-review -->",
      REVIEW_MARKDOWN: "Looks fine.",
    } as NodeJS.ProcessEnv;
    const input = publishInputFromEnv(env, "github");
    assert.ok(input.partialCoverage);

    const api = new MinimalPublishApi(head);
    const result = await publishReview(input, api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.equal(api.submitted.length, 1);
    // #1447: the persisted fail-closed state is authoritative; incomplete
    // coverage withholds the native approval.
    assert.equal(api.submitted[0]!.event, "COMMENT");
    assert.match(api.submitted[0]!.body, /Approval withheld by incomplete review coverage/);
  });
});

function publishVerdictEnv(overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    VERDICT: "approve",
    REQUIRED_CHECKS: "complete",
    PUBLISH_MODE: "review_verdict",
    // #1161: the deprecated input is still accepted here on purpose — the
    // coverage gates below must hold whether it is set, unset, or false.
    ALLOW_APPROVE: "true",
    IS_FORK_PR: "false",
    HEAD_SHA: "a".repeat(40),
    PR_NUMBER: "7",
    COMMENT_MARKER: "<!-- ai-pr-review -->",
    REVIEW_MARKDOWN: "Looks fine.",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

test("#1161: the CLI publish path publishes the verdict natively, whatever the deprecated allow-approve input says", async () => {
  await withRunDirAsync(async (dir) => {
    writeCoverageArtifact(dir, { tool_loop_ran: false });
    const events: string[] = [];
    for (const allowApprove of [null, "false", "true"]) {
      const env = publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir });
      if (allowApprove === null) delete env.ALLOW_APPROVE;
      else env.ALLOW_APPROVE = allowApprove;
      const input = publishInputFromEnv(env, "github");
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", String(allowApprove));
      assert.equal(api.submitted.length, 1, String(allowApprove));
      events.push(api.submitted[0]!.event);
    }
    assert.deepEqual(events, ["APPROVE", "APPROVE", "APPROVE"]);
  });
});

// ── #1520: the publish step is handed the REVIEWED diff on every platform ──
//
// `publishWithOutcome` used to give `publishReview` a diff only for Forgejo
// (and only a FRESH forge read, which races a push). The engine writes the
// reviewed diff to the run dir as `pr.diff`; the publish boundary now reads
// that artifact the same way it reads `review-coverage.json`, so GitHub
// publishes the contract's inline findings and the #762 usefulness-feedback
// read can see publishable prescriptions there too.

const ANCHORED_DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";

function inlineFindingsEnv(overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    PUBLISH_MODE: "review_comment",
    REVIEW_MARKDOWN: "# review",
    VERDICT: "request_changes",
    HEAD_SHA: "a".repeat(40),
    BASE_SHA: "b".repeat(40),
    PR_NUMBER: "7",
    COMMENT_MARKER: "<!-- ai-pr-review -->",
    INLINE_FINDINGS: "true",
    INLINE_FINDINGS_MAX: "5",
    FINDINGS: JSON.stringify([{ file: "a.ts", line: 2, severity: "major", category: "bug", message: "unchecked null deref" }]),
    IS_FORK_PR: "false",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

test("#1520: publishWithOutcome hands the run-dir reviewed diff to publishReview on GitHub (no fresh forge read)", async () => {
  await withRunDirAsync(async (dir) => {
    writeFileSync(join(dir, "pr.diff"), ANCHORED_DIFF);
    const input = publishInputFromEnv(inlineFindingsEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
    const api = new MinimalPublishApi("a".repeat(40));
    // The historical fresh-read source must never run when the run dir
    // carries the reviewed diff — a fresh read of the CURRENT head races a
    // push and would anchor on content the review never covered.
    const seam = {
      api,
      platform: "github",
      diffProvider: async (): Promise<string> => {
        throw new Error("fresh diff read must not run when the run dir carries the reviewed diff");
      },
    };
    const outcome = await publishWithOutcome(input as never, seam as never, dir);
    assert.equal(outcome.status, "published");
    assert.equal(api.submitted.length, 1);
    const comments = api.submitted[0]!.comments ?? [];
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.path, "a.ts");
    assert.equal(comments[0]!.line, 2);
    assert.equal(comments[0]!.side, "RIGHT");
  });
});

test("#1520: a present-but-empty pr.diff IS the reviewed diff — no fallback read, empty anchor map", async () => {
  await withRunDirAsync(async (dir) => {
    writeFileSync(join(dir, "pr.diff"), "");
    const input = publishInputFromEnv(inlineFindingsEnv({ PR_REVIEWER_RUN_DIR: dir }), "forgejo");
    const api = new MinimalPublishApi("a".repeat(40));
    const seam = {
      api,
      platform: "forgejo",
      diffProvider: async (): Promise<string> => {
        throw new Error("an empty reviewed diff must not fall back to a fresh forge read");
      },
    };
    const outcome = await publishWithOutcome(input as never, seam as never, dir);
    assert.equal(outcome.status, "published");
    // Nothing can anchor on an empty anchor map, so no findings review is
    // emitted at all (#1093: never an empty native review); the findings stay
    // in the sticky body instead.
    assert.equal(api.submitted.length, 0);
  });
});

test("#1520: without a run-dir pr.diff the historical per-platform sources still apply", async () => {
  // GitHub (empty-diff path): the finding can never anchor, no fresh read
  // exists for it, and the review still publishes body-only.
  {
    const input = publishInputFromEnv(inlineFindingsEnv(), "github");
    const api = new MinimalPublishApi("a".repeat(40));
    const outcome = await publishWithOutcome(input as never, { api, platform: "github", diffProvider: async () => "" } as never);
    assert.equal(outcome.status, "published");
    // The empty diff cannot anchor anything, so no findings review is emitted.
    assert.equal(api.submitted.length, 0);
  }
  // Forgejo (fresh-read fallback): the historical diffProvider is consulted,
  // and the built comment carries the Forgejo position.
  await withRunDirAsync(async (dir) => {
    const input = publishInputFromEnv(inlineFindingsEnv({ PR_REVIEWER_RUN_DIR: dir }), "forgejo");
    const api = new MinimalPublishApi("a".repeat(40));
    const seam = { api, platform: "forgejo", diffProvider: async (): Promise<string> => ANCHORED_DIFF };
    const outcome = await publishWithOutcome(input as never, seam as never, dir);
    assert.equal(outcome.status, "published");
    const comments = api.submitted[0]!.comments ?? [];
    assert.equal(comments.length, 1);
    assert.equal(typeof (comments[0] as { new_position?: unknown }).new_position, "number");
  });
});

test("#1520: the forgejo publish seam's diff provider takes the run dir from the caller, never ambient env", async (t) => {
  // The mocked fresh read renders as an empty diff, so a regression that
  // consults ambient env (or reads the wrong run dir) resolves "" here
  // instead of silently reusing the artifact from another run dir.
  t.mock.method(globalThis, "fetch", async () => new Response(""));
  await withRunDirAsync(async (ambientDir) => {
    writeFileSync(join(ambientDir, "pr.diff"), ANCHORED_DIFF);
    const env = {
      REPO: "o/r",
      PR_NUMBER: "9",
      PLATFORM: "forgejo",
      FORGEJO_API_URL: "https://forge.example",
      PR_REVIEWER_RUN_DIR: ambientDir,
    } as NodeJS.ProcessEnv;
    // Single source of truth: ambient `PR_REVIEWER_RUN_DIR` is never
    // consulted by the diff provider — an omitted run dir falls straight
    // through to the fresh forge read, even though the ambient env points
    // at a run dir that carries the reviewed diff.
    assert.equal(await buildPublishApi(env).diffProvider(), "");
    // The caller's run dir hits, and the fresh forge read is never reached.
    await withRunDirAsync(async (callerDir) => {
      writeFileSync(join(callerDir, "pr.diff"), ANCHORED_DIFF);
      const seam = buildPublishApi(env, callerDir);
      assert.equal(seam.platform, "forgejo");
      assert.equal(await seam.diffProvider(), ANCHORED_DIFF);
    });
  });
});

// #1520 edge-case paths (the AI review's obligation-2): the run-dir `pr.diff`
// read must fail CLOSED on hostile or malformed path state — a NUL byte in
// the run-dir path, a symlink planted at the artifact coordinate, a
// directory at that coordinate — never crash the publish step and never
// follow a link out of the (trusted, private) run dir.

test("#1520: a NUL byte in the run-dir path fails closed to the historical fallback", async () => {
  // Every fs call rejects paths containing NUL; the read must be "no
  // reviewed diff available", not a thrown ERR_INVALID_ARG_VALUE escaping
  // the publish step.
  const nullDir = "/run/pr-7\x00";
  {
    // GitHub: the fallback is "" and the (never-existing here) fresh read
    // stays untouched; the review still publishes body-only.
    const input = publishInputFromEnv(inlineFindingsEnv(), "github");
    const api = new MinimalPublishApi("a".repeat(40));
    const outcome = await publishWithOutcome(input as never, { api, platform: "github", diffProvider: async () => "" } as never, nullDir);
    assert.equal(outcome.status, "published");
    assert.equal(api.submitted.length, 0);
  }
  // Forgejo: the historical fresh-read fallback IS consulted and anchors.
  const input = publishInputFromEnv(inlineFindingsEnv(), "forgejo");
  const api = new MinimalPublishApi("a".repeat(40));
  const seam = { api, platform: "forgejo", diffProvider: async (): Promise<string> => ANCHORED_DIFF };
  const outcome = await publishWithOutcome(input as never, seam as never, nullDir);
  assert.equal(outcome.status, "published");
  const comments = api.submitted[0]!.comments ?? [];
  assert.equal(comments.length, 1);
  assert.equal(typeof (comments[0] as { new_position?: unknown }).new_position, "number");
});

test("#1520: a symlink at the pr.diff coordinate is refused, never followed", async () => {
  // Same no-follow guarantee as every other security-sensitive artifact
  // read in this repo (change-anchors head reads, mirror bookkeeping,
  // controller publication): a link planted at the artifact coordinate is
  // unproven content and falls back; its target bytes NEVER become the
  // anchor map.
  await withRunDirAsync(async (dir) => {
    const targetDir = mkdtempSync(join(tmpdir(), "v3-publish-entry-outside-"));
    try {
      const target = join(targetDir, "reviewed.diff");
      writeFileSync(target, ANCHORED_DIFF);
      symlinkSync(target, join(dir, "pr.diff"));
      const input = publishInputFromEnv(inlineFindingsEnv(), "github");
      const api = new MinimalPublishApi("a".repeat(40));
      const outcome = await publishWithOutcome(input as never, { api, platform: "github", diffProvider: async () => "" } as never, dir);
      assert.equal(outcome.status, "published");
      // The link target was refused, so the anchor map is empty and nothing
      // anchors — the same outcome as "no reviewed diff", never the target.
      assert.equal(api.submitted.length, 0);
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

test("#1520: a directory at the pr.diff coordinate falls back like a missing artifact", async () => {
  // Non-regular files are not the reviewed-diff artifact; the read must
  // resolve to "unavailable" (fallback), never an EISDIR crash.
  await withRunDirAsync(async (dir) => {
    mkdirSync(join(dir, "pr.diff"));
    const input = publishInputFromEnv(inlineFindingsEnv(), "github");
    const api = new MinimalPublishApi("a".repeat(40));
    const outcome = await publishWithOutcome(input as never, { api, platform: "github", diffProvider: async () => "" } as never, dir);
    assert.equal(outcome.status, "published");
    assert.equal(api.submitted.length, 0);
  });
});

test("#873/#838 regression: a partial primary harness is never hidden by an omitted or stale-'off' ambient TOOL_MODE", async () => {
  // The exact maintainer-flagged bug: the artifact itself records the real
  // partial run; ambient TOOL_MODE — which `publish` no longer consults at
  // all for this decision — is omitted in one case and actively lies
  // ("off") in the other.
  for (const toolModeOverride of [{}, { TOOL_MODE: "off" }]) {
    await withRunDirAsync(async (dir) => {
      writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: PARTIAL_COVERAGE });
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir, ...toolModeOverride }), "github");
      assert.ok(input.partialCoverage, JSON.stringify(toolModeOverride));
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", JSON.stringify(toolModeOverride));
      assert.equal(api.submitted[0]!.event, "COMMENT", JSON.stringify(toolModeOverride));  // #1447: incomplete/unknown coverage withholds trusted approval
      assert.match(api.submitted[0]!.body, /Approval withheld by incomplete review coverage/, JSON.stringify(toolModeOverride));
    });
  }
});

test("#873/#838 regression: a complete primary harness never hides a partial smart harness behind an omitted or stale ambient REVIEW_ROUTE", async () => {
  // The other maintainer-flagged bug: the escalated run's artifact names
  // the SMART harness as its enforcement_harness (and, belt-and-braces,
  // the smart file on disk reports the real gap); a stray complete
  // PRIMARY harness sits alongside it, and ambient REVIEW_ROUTE — no
  // longer consulted at all — is omitted in one case and actively lies
  // ("primary") in the other.
  for (const routeOverride of [{}, { REVIEW_ROUTE: "primary" }]) {
    await withRunDirAsync(async (dir) => {
      writeFileSync(join(dir, "tool-harness.json"), COMPLETE_HARNESS);
      writeFileSync(join(dir, "tool-harness.smart.json"), PARTIAL_COVERAGE_HARNESS);
      // The artifact's own partial_coverage field is left null here on
      // purpose, to prove the belt-and-braces re-derivation from the
      // named harness — not just the artifact's own field — closes the gap.
      writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.smart.json", route: "escalated" });
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir, ...routeOverride }), "github");
      assert.ok(input.partialCoverage, JSON.stringify(routeOverride));
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", JSON.stringify(routeOverride));
      assert.equal(api.submitted[0]!.event, "COMMENT", JSON.stringify(routeOverride));  // #1447: incomplete/unknown coverage withholds trusted approval
      assert.match(api.submitted[0]!.body, /Approval withheld by incomplete review coverage/, JSON.stringify(routeOverride));
    });
  }
});

test("#873/#838 regression: an incomplete required_checks is never hidden by an omitted or stale ambient REQUIRED_CHECKS", async () => {
  // Same class of bug as TOOL_MODE/REVIEW_ROUTE above, for the third field
  // publish used to read from ambient env: the artifact says incomplete;
  // REQUIRED_CHECKS is omitted in one case and actively lies ("complete")
  // in the other. publishVerdictEnv's own REQUIRED_CHECKS: "complete"
  // default covers the "stale" half; the override covers "omitted".
  for (const requiredChecksOverride of [{}, { REQUIRED_CHECKS: "complete" }]) {
    await withRunDirAsync(async (dir) => {
      // tool_loop_ran:false here on purpose: proves this is REQUIRED_CHECKS
      // alone closing the gap, independent of any tool-loop coverage state.
      writeCoverageArtifact(dir, { tool_loop_ran: false, required_checks: "incomplete" });
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir, ...requiredChecksOverride }), "github");
      assert.equal(input.requiredChecks, "incomplete", JSON.stringify(requiredChecksOverride));
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", JSON.stringify(requiredChecksOverride));
      assert.equal(api.submitted[0]!.event, "COMMENT", JSON.stringify(requiredChecksOverride));  // #1447: incomplete/unknown coverage withholds trusted approval
      assert.match(api.submitted[0]!.body, /Approval withheld by incomplete review coverage/, JSON.stringify(requiredChecksOverride));
    });
  }
});

test("#873/#838 regression: tool_loop_ran:true with an unrecognized enforcement_harness (including null) always resolves coverage-unknown", async () => {
  for (const enforcementHarness of [null, "", "tool-harness.txt", 42]) {
    await withRunDirAsync(async (dir) => {
      writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: enforcementHarness as unknown as string | null });
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
      assert.equal(input.partialCoverage, undefined, JSON.stringify(enforcementHarness));
      assert.equal(input.coverageUnknown, true, JSON.stringify(enforcementHarness));
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", JSON.stringify(enforcementHarness));
      assert.equal(api.submitted[0]!.event, "COMMENT", JSON.stringify(enforcementHarness));  // #1447: incomplete/unknown coverage withholds trusted approval
      assert.match(api.submitted[0]!.body, /could not be verified/, JSON.stringify(enforcementHarness));
    });
  }
});

test("#873/#838 regression: tool_loop_ran:true naming a missing enforcement_harness file (partial_coverage null) resolves coverage-unknown", async () => {
  await withRunDirAsync(async (dir) => {
    // No tool-harness.json actually written — the artifact's own
    // partial_coverage is null (no confirmed gap recorded), so the only
    // way to confirm completeness would be reading the named harness.
    writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: null });
    const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
    assert.equal(input.partialCoverage, undefined);
    assert.equal(input.coverageUnknown, true);
    const api = new MinimalPublishApi("a".repeat(40));
    const result = await publishReview(input, api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.equal(api.submitted[0]!.event, "COMMENT");  // #1447: incomplete/unknown coverage withholds trusted approval
    assert.match(api.submitted[0]!.body, /could not be verified/);
  });
});

test("#873/#838 regression: an absent or invalid persisted required_checks is coverage-unknown (fail-closed state) and the verdict publishes with the gap noted", async () => {
  // "none" is a legitimate recorded status (no required checks configured)
  // and therefore approve-eligible — it must never be the normalization of
  // an absent or invalid field. The real run writer always emits
  // required_checks, so its absence (or a value outside the known set —
  // e.g. a future schema's) means this artifact is not one this runtime
  // wrote: fail closed on both dimensions, exactly like the
  // harness-pointer cases below.
  for (const artifact of [
    { version: 1, tool_loop_ran: false },
    { version: 1, tool_loop_ran: false, required_checks: "garbage" },
    { version: 1, tool_loop_ran: false, required_checks: 7 },
    { version: 1, tool_loop_ran: false, required_checks: null },
  ]) {
    await withRunDirAsync(async (dir) => {
      writeFileSync(join(dir, "review-coverage.json"), JSON.stringify(artifact));
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
      assert.equal(input.coverageUnknown, true, JSON.stringify(artifact));
      assert.equal(input.requiredChecks, "incomplete", JSON.stringify(artifact));
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", JSON.stringify(artifact));
      assert.equal(api.submitted[0]!.event, "COMMENT", JSON.stringify(artifact));  // #1447: incomplete/unknown coverage withholds trusted approval
      assert.match(api.submitted[0]!.body, /could not be verified/, JSON.stringify(artifact));
    });
  }
});

test("#873/#838 regression: a confirmed partial_coverage in the artifact is authoritative even when the harness file is also missing", async () => {
  await withRunDirAsync(async (dir) => {
    // The artifact's OWN partial_coverage is already a confirmed gap: no
    // harness read is needed (or attempted) to settle this one.
    writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: PARTIAL_COVERAGE });
    const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
    assert.ok(input.partialCoverage);
    assert.equal(input.coverageUnknown, undefined);
  });
});

test("#873/#838 regression: a traversal-looking enforcement_harness value is never read — resolves unknown even if a forged file sits at that path", async () => {
  const parentDir = mkdtempSync(join(tmpdir(), "v3-run-parent-"));
  const runDir = join(parentDir, "run");
  try {
    mkdirSync(runDir);
    // If the traversal were ever honored, join(runDir, "../x.json")
    // resolves to parentDir/x.json — plant a "clean" (no partial_coverage)
    // harness there so a buggy read would wrongly allow APPROVE.
    writeFileSync(join(parentDir, "x.json"), COMPLETE_HARNESS);
    writeCoverageArtifact(runDir, { tool_loop_ran: true, enforcement_harness: "../x.json", partial_coverage: null });
    const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: runDir }), "github");
    assert.equal(input.partialCoverage, undefined);
    assert.equal(input.coverageUnknown, true);
    const api = new MinimalPublishApi("a".repeat(40));
    const result = await publishReview(input, api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.equal(api.submitted[0]!.event, "COMMENT");  // #1447: incomplete/unknown coverage withholds trusted approval
    assert.match(api.submitted[0]!.body, /could not be verified/);
  } finally {
    rmSync(parentDir, { recursive: true, force: true });
  }
});

test("#873/#838 regression: a tools-off run (artifact says tool_loop_ran:false) still APPROVEs", async () => {
  await withRunDirAsync(async (dir) => {
    writeCoverageArtifact(dir, { tool_loop_ran: false });
    const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
    assert.equal(input.partialCoverage, undefined);
    assert.equal(input.coverageUnknown, undefined);
    const api = new MinimalPublishApi("a".repeat(40));
    const result = await publishReview(input, api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.equal(api.submitted[0]!.event, "APPROVE");
  });
});

test("#873/#838 regression: a missing review-coverage.json resolves fail-closed unknown; the verdict still publishes with the note (#1145)", async () => {
  await withRunDirAsync(async (dir) => {
    const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
    assert.equal(input.partialCoverage, undefined);
    assert.equal(input.coverageUnknown, true);
    const api = new MinimalPublishApi("a".repeat(40));
    const result = await publishReview(input, api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.equal(api.submitted[0]!.event, "COMMENT");  // #1447: incomplete/unknown coverage withholds trusted approval
    assert.match(api.submitted[0]!.body, /could not be verified/);
  });
});

test("#873/#838 cross-process regression: publish reads the real state from an explicit run dir, and fails closed without one — the checkout is never consulted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "v3-run-private-"));
  const checkoutDir = mkdtempSync(join(tmpdir(), "v3-checkout-"));
  const originalCwd = process.cwd();
  try {
    // `run`'s own private artifact: a real partial-coverage record.
    writeCoverageArtifact(runDir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: PARTIAL_COVERAGE });

    // The checkout has no artifact at all in one scenario, and a forged
    // "complete" one in the other — the shape a malicious PR could commit
    // at its repository root to fake a clean run.
    const checkoutVariants: Array<{ name: string; seed: () => void }> = [
      { name: "no artifact in checkout", seed: () => {} },
      { name: "forged complete artifact in checkout", seed: () => writeCoverageArtifact(checkoutDir, { tool_loop_ran: false }) },
    ];

    // cwd is the checkout for the whole test: proves any accidental
    // fallback to process.cwd() would read the forged artifact, not the
    // real one in runDir.
    process.chdir(checkoutDir);

    // 1. Explicit PR_REVIEWER_RUN_DIR: publish reads the REAL (partial)
    // state (#1447: persisted partial coverage withholds trusted approval).
    {
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: runDir }), "github");
      assert.ok(input.partialCoverage);
      assert.equal(input.coverageUnknown, undefined);
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published");
      assert.equal(api.submitted[0]!.event, "COMMENT");  // #1447: incomplete/unknown coverage withholds trusted approval
      assert.match(api.submitted[0]!.body, /Approval withheld by incomplete review coverage/);
    }

    // 2. No explicit PR_REVIEWER_RUN_DIR (absent, and the empty-string
    // form): publish must fail closed on STATE (coverageUnknown, never read
    // from the checkout) regardless of what the checkout contains.
    for (const variant of checkoutVariants) {
      variant.seed();
      for (const runDirValue of [undefined, ""]) {
        const env = publishVerdictEnv(runDirValue === undefined ? {} : { PR_REVIEWER_RUN_DIR: runDirValue });
        const input = publishInputFromEnv(env, "github");
        assert.equal(input.partialCoverage, undefined, variant.name);
        assert.equal(input.coverageUnknown, true, variant.name);
        const api = new MinimalPublishApi("a".repeat(40));
        const result = await publishReview(input, api, { diffText: "" });
        assert.equal(result.status, "published", variant.name);
        assert.equal(api.submitted[0]!.event, "COMMENT", variant.name);  // #1447: incomplete/unknown coverage withholds trusted approval
        assert.match(api.submitted[0]!.body, /could not be verified/, variant.name);
      }
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── #892: readEvent's event.name / event.label normalization ─────────────

test("readEvent populates event.name from GITHUB_EVENT_NAME — the real GitHub payload has no top-level name", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-"));
  try {
    const eventPath = join(dir, "event.json");
    // The real GitHub `labeled` payload shape: no top-level `name`, and
    // `label` is an object, not a string.
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 1, name: "ai-review", color: "00ff00" },
      pull_request: { number: 7, head: { sha: "a".repeat(40) } },
    }));
    const { event } = readEvent({
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.name, "pull_request");
    assert.equal(event?.action, "labeled");
    assert.equal(event?.label, "ai-review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvent normalizes a Forgejo-shaped labeled event (act_runner also sets GITHUB_EVENT_NAME)", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-forgejo-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "labeled",
      label: { id: 3, name: "ai-review", color: "ededed" },
      pull_request: { number: 12, head: { sha: "b".repeat(40) } },
      number: 12,
    }));
    const { event } = readEvent({
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      FORGEJO_API_URL: "https://forge.example.invalid",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.name, "pull_request");
    assert.equal(event?.label, "ai-review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvent normalizes a bare-string label too (never regress the existing string path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-string-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ action: "labeled", label: "ai-review" }));
    const { event } = readEvent({ GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "pull_request" } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.label, "ai-review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvent never sets event.label for a non-labeled event (no stray empty label)", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-nolabel-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ action: "synchronize", pull_request: { number: 7, head: { sha: "a".repeat(40) } } }));
    const { event } = readEvent({ GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "pull_request" } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.name, "pull_request");
    assert.equal(event?.action, "synchronize");
    assert.equal("label" in (event ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #914: readEvent's issue_comment payload (the /ai-review re-review) ─────
//
// A real GitHub `issue_comment` payload has NO top-level `name` and NO
// top-level `pull_request`. The PR number, when the comment is on a PR,
// lives on `issue.number` — and `issue.pull_request` is present ONLY for
// comments on a PR (absent for comments on a plain issue). That presence is
// the honest signal the action's workflow/PR check uses to tell a real PR
// re-review from a no-op: a plain-issue comment must yield NO prNumber.
// The payload also carries a top-level `comment` (`{ id, body, user: {
// login } }`) which we parse defensively into `event.comment`.

test("readEvent parses an issue_comment ON A PR: prNumber from issue.number, comment populated, NO headSha", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-issue-comment-pr-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "created",
      // `issue.pull_request` present → this comment is on a PR.
      issue: { number: 42, pull_request: { url: "https://api.github.com/repos/o/r/pulls/42" } },
      comment: { id: 123, body: "please re-review", user: { login: "alice" } },
    }));
    const { event, prNumber, headSha } = readEvent({
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "issue_comment",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.name, "issue_comment");
    assert.equal(event?.action, "created");
    assert.deepEqual(event?.comment, { id: 123, body: "please re-review", user: "alice" });
    assert.equal(prNumber, "42");
    // issue_comment payloads genuinely have no head SHA — never fabricated.
    assert.equal(headSha, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvent parses an issue_comment ON A PLAIN ISSUE: comment present, prNumber stays undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-issue-comment-issue-"));
  try {
    const eventPath = join(dir, "event.json");
    // No `issue.pull_request` → this is a comment on a plain issue, not a PR.
    writeFileSync(eventPath, JSON.stringify({
      action: "created",
      issue: { number: 99 },
      comment: { id: 555, body: "a question", user: { login: "bob" } },
    }));
    const { event, prNumber } = readEvent({
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "issue_comment",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.name, "issue_comment");
    assert.equal(event?.action, "created");
    assert.deepEqual(event?.comment, { id: 555, body: "a question", user: "bob" });
    // The honest no-op signal: NO prNumber for a plain-issue comment.
    assert.equal(prNumber, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEvent degrades a junky issue_comment payload gracefully (never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-readevent-issue-comment-junk-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      action: "created",
      issue: { number: 42, pull_request: { url: "https://api.github.com/repos/o/r/pulls/42" } },
      // id is a valid number (kept); body is a non-string (dropped); user
      // has no login (dropped). A malformed / hostile comment degrades —
      // it never throws.
      comment: { id: 123, body: 456, user: {} },
    }));
    const { event, prNumber } = readEvent({
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "issue_comment",
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(event?.name, "issue_comment");
    assert.equal(event?.action, "created");
    assert.ok(event?.comment);
    assert.equal(event?.comment?.id, 123);
    assert.equal(event?.comment?.body, undefined);
    assert.equal(event?.comment?.user, undefined);
    // prNumber still resolved from the PR-shaped issue.
    assert.equal(prNumber, "42");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #1537: the standalone `publish` path must carry the merge-gating members
// the Action path derives in memory — the blocking obligation rows, the open
// requirement ids, and the unresolved required-check ids — read back from the
// run's own artifacts. A run the obligation gate blocked with request_changes
// must never publish a handoff whose empty lists read as "nothing blocked the
// review", and an unreadable member stays absent rather than becoming a guess.
// ---------------------------------------------------------------------------

const ENGINE_OK = "openai:review-model (primary)";

/** Writes the run-dir engine record every reviewed run writes at its tail;
 * without it `mergeGatingFieldsFromRunDir` reads "no reviewed run here". */
function writeEngineRecord(dir: string, engine: string = ENGINE_OK): void {
  writeFileSync(join(dir, "analysis_engine.txt"), `${engine}\n`);
}

test("#1537: publishInputFromEnv names the blocking obligation rows from the run dir", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    writeFileSync(join(dir, "review-obligations.json"), JSON.stringify({
      version: 1,
      obligations: [
        { id: "mc-1", source: "must_check", text: "Verify the auth path", status: "unmet", cause: null },
        { id: "tb-2", source: "must_check", text: "Unfinished availability gap", status: "unresolved", cause: "tool-capability" },
        { id: "tb-1", source: "trusted_base_guidance", text: "Confirm the migration plan", status: "satisfied", cause: null },
        { id: "dv-1", source: "derived", text: "Cross-path relationship", status: "unresolved", cause: null, anchors: ["src/a.ts:1"] },
      ],
    }));
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    // #1505: only the forcing `unmet` row blocks. The `unresolved` row is an
    // availability failure (coverage, never a defect); the satisfied row and
    // the derived coverage row (#1447/#1521) never reach the handoff either.
    assert.deepEqual(input.unresolvedReviewObligations, [
      { id: "mc-1", source: "must_check", text: "Verify the auth path", status: "unmet", cause: null },
    ]);
  });
});

test("#1537: an all-satisfied or absent obligations artifact publishes no blocking rows", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.unresolvedReviewObligations, undefined);
    writeFileSync(join(dir, "review-obligations.json"), JSON.stringify({
      version: 1,
      obligations: [{ id: "mc-1", source: "must_check", text: "Verify the auth path", status: "satisfied", cause: null }],
    }));
    const clean = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.deepEqual(clean.unresolvedReviewObligations, []);
  });
});

test("#1537: a malformed obligations artifact is never half-trusted", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    // A row outside the closed source vocabulary refuses the WHOLE artifact —
    // the #1521 parser rule: a half-trusted row must not reach the handoff.
    writeFileSync(join(dir, "review-obligations.json"), JSON.stringify({
      version: 1,
      obligations: [
        { id: "mc-1", source: "must_check", text: "fine", status: "unresolved", cause: null },
        { id: "x-1", source: "model_claim", text: "forged", status: "unmet", cause: null },
      ],
    }));
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedReviewObligations, undefined);
    // A non-object row, an empty file, and a foreign version likewise.
    for (const body of [
      JSON.stringify({ version: 1, obligations: [null] }),
      "",
      JSON.stringify({ version: 2, obligations: [] }),
    ]) {
      writeFileSync(join(dir, "review-obligations.json"), body);
      assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedReviewObligations, undefined);
    }
  });
});

test("#1537: publishInputFromEnv reads the open requirement ids back from the trace artifact", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    writeFileSync(join(dir, "requirement-trace.json"), JSON.stringify({
      version: 1,
      rows: [
        { requirement_id: "req-a", disposition: "unmet", proof: "", enforcement: [], test: [], reason: "no proof", notes: [] },
        { requirement_id: "req-b", disposition: "met", proof: "src/a.ts", enforcement: [], test: [], reason: "", notes: [] },
        { requirement_id: "req-c", disposition: "unverifiable", proof: "", enforcement: [], test: [], reason: "unreadable", notes: [] },
      ],
      incomplete: true,
      errors: [],
    }));
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.deepEqual(input.unresolvedRequirementIds, ["req-a", "req-c"]);
  });
});

test("#1537: an absent, empty, or malformed trace artifact publishes no requirement ids", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    const absent = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(absent.unresolvedRequirementIds, undefined);
    // The engine writes the file zero bytes when the trace never applied.
    writeFileSync(join(dir, "requirement-trace.json"), "");
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequirementIds, undefined);
    // A non-object row would make `unresolvedTraceRequirementIds` throw on a
    // property read: the read-back shape-checks rows and yields nothing.
    writeFileSync(join(dir, "requirement-trace.json"), JSON.stringify({ version: 1, rows: [null], incomplete: false, errors: [] }));
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequirementIds, undefined);
  });
});

test("#1537: required-check ids are recomputed from the run's own fold inputs", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    writeCoverageArtifact(dir, { required_checks: "incomplete", required_check_fold_status: "incomplete" });
    writeFileSync(join(dir, "classification.json"), JSON.stringify({ must_check: ["Check the auth path", "Check the rollback story"] }));
    // No dispositions at all: the fold conservatively leaves every check
    // unresolved (the same #750 the engine ran).
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({ verdict: "request_changes" }));
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.deepEqual(input.unresolvedRequiredChecks, ["Check the auth path", "Check the rollback story"]);
    // One satisfied, one unmet: only the unmet row is not clean.
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({
      verdict: "request_changes",
      required_check_dispositions: [
        { check: "Check the auth path", status: "satisfied", rationale: "covered by tests" },
        { check: "Check the rollback story", status: "unmet", rationale: "none exists" },
      ],
    }));
    const folded = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.deepEqual(folded.unresolvedRequiredChecks, ["Check the rollback story"]);
  });
});

test("#1537: required-check ids are recomputed only when the fold itself was incomplete", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    writeFileSync(join(dir, "classification.json"), JSON.stringify({ must_check: ["Check the auth path"] }));
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({ verdict: "approve" }));
    // A clean fold: nothing open, nothing to name, nothing recomputed.
    writeCoverageArtifact(dir, { required_checks: "complete" });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    // A required_checks flip whose ONLY reason is the requirement trace means
    // the completeness fold itself was clean: the fold ids stay absent too.
    writeCoverageArtifact(dir, { required_checks: "incomplete", incomplete_reason: "requirement_trace" });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    // An unreadable fold input cannot be recomputed: absent, never guessed.
    writeCoverageArtifact(dir, { required_checks: "incomplete", required_check_fold_status: "incomplete" });
    rmSync(join(dir, "classification.json"));
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    writeFileSync(join(dir, "classification.json"), JSON.stringify({ must_check: ["Check the auth path"] }));
    // An unrecognizable recorded fold status is never half-trusted and never
    // read as the pre-#1543 absence: the field is PRESENT, so the artifact
    // declares a fold status this runtime cannot interpret and the recompute
    // fails closed — even when the published dimension alone (a valid
    // `incomplete` with a non-trace reason) would have triggered the
    // inference fallback the absent field earns.
    writeCoverageArtifact(dir, { required_checks: "incomplete", required_check_fold_status: "yes-very-incomplete", incomplete_reason: "execution" });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    writeCoverageArtifact(dir, { required_checks: "incomplete", required_check_fold_status: true, incomplete_reason: "execution" });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    // The same holds with the published dimension itself unrecognizable (a
    // pre-#1543 artifact would fail its own heuristic too): nothing recomputes.
    writeCoverageArtifact(dir, { required_checks: "yes-very-incomplete", required_check_fold_status: "yes-very-incomplete" });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    // A run dir predating #1543 carries no fold-status field: the recorded-
    // dimension inference still decides (incomplete names, trace-only does
    // not), so the pre-existing artifacts keep their #1537 behavior.
    writeCoverageArtifact(dir, { required_checks: "incomplete", required_check_fold_status: undefined });
    assert.deepEqual(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, ["Check the auth path"]);
    writeCoverageArtifact(dir, { required_checks: "incomplete", incomplete_reason: "requirement_trace", required_check_fold_status: undefined });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
  });
});

test("#1537: a model-unavailable notice run names no merge-gating members", () => {
  withRunDir((dir) => {
    // The notice path runs none of the folds but still persists its FALLBACK
    // must_check rows (#1521). Reading them back would name checks a review
    // that never reached the model never performed.
    writeEngineRecord(dir, "(model unavailable)");
    writeCoverageArtifact(dir, { required_checks: "incomplete" });
    writeFileSync(join(dir, "review-obligations.json"), JSON.stringify({
      version: 1,
      obligations: [{ id: "obligation-1", source: "must_check", text: "Check the auth path", status: "unresolved", cause: null }],
    }));
    writeFileSync(join(dir, "classification.json"), JSON.stringify({ must_check: ["Check the auth path"] }));
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({ verdict: "request_changes" }));
    writeFileSync(join(dir, "requirement-trace.json"), JSON.stringify({ version: 1, rows: [{ requirement_id: "req-a", disposition: "unmet" }], incomplete: true, errors: [] }));
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.unresolvedReviewObligations, undefined);
    assert.equal(input.unresolvedRequirementIds, undefined);
    assert.equal(input.unresolvedRequiredChecks, undefined);
  });
});

test("#1537: no run dir (or no engine record) means no merge-gating state", () => {
  const noRunDir = publishInputFromEnv({ PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
  assert.equal(noRunDir.unresolvedReviewObligations, undefined);
  assert.equal(noRunDir.unresolvedRequirementIds, undefined);
  assert.equal(noRunDir.unresolvedRequiredChecks, undefined);
  withRunDir((dir) => {
    // Every artifact is present and readable, but a run dir without the
    // engine's own tail record cannot prove which path produced them.
    writeCoverageArtifact(dir, { required_checks: "incomplete" });
    writeFileSync(join(dir, "review-obligations.json"), JSON.stringify({
      version: 1,
      obligations: [{ id: "mc-1", source: "must_check", text: "x", status: "unresolved", cause: null }],
    }));
    writeFileSync(join(dir, "requirement-trace.json"), JSON.stringify({ version: 1, rows: [{ requirement_id: "req-a", disposition: "unmet" }], incomplete: true, errors: [] }));
    writeFileSync(join(dir, "classification.json"), JSON.stringify({ must_check: ["x"] }));
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({ verdict: "request_changes" }));
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.unresolvedReviewObligations, undefined);
    assert.equal(input.unresolvedRequirementIds, undefined);
    assert.equal(input.unresolvedRequiredChecks, undefined);
  });
});

test("#1543: the recorded fold status stops the recompute for a fold that never gated", () => {
  withRunDir((dir) => {
    writeEngineRecord(dir);
    // The review finding's exact state: an operator's
    // `validate-required-checks: false` (fold status `none`), a #874 trace
    // flip that made the published dimension `incomplete`, and a tool-loop
    // gap that made the recorded reason `both`. The fold named nothing in
    // memory, so the standalone handoff names nothing either — the recorded
    // fold status, not the published dimension, decides.
    writeCoverageArtifact(dir, {
      required_checks: "incomplete",
      required_check_fold_status: "none",
      incomplete_reason: "both",
      partial_coverage: PARTIAL_COVERAGE,
    });
    writeFileSync(join(dir, "classification.json"), JSON.stringify({ must_check: ["Check the auth path"] }));
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({ verdict: "request_changes" }));
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.unresolvedRequiredChecks, undefined);
    // A recorded `complete` likewise outranks an ambiguous published
    // dimension: the fold ran clean, so no ids existed to name.
    writeCoverageArtifact(dir, {
      required_checks: "incomplete",
      required_check_fold_status: "complete",
      incomplete_reason: "execution",
      partial_coverage: PARTIAL_COVERAGE,
    });
    assert.equal(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, undefined);
    // A recorded `incomplete` is the ONE status that recomputes.
    writeCoverageArtifact(dir, {
      required_checks: "incomplete",
      required_check_fold_status: "incomplete",
      incomplete_reason: "both",
      partial_coverage: PARTIAL_COVERAGE,
    });
    assert.deepEqual(publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").unresolvedRequiredChecks, ["Check the auth path"]);
  });
});
