import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { buildAdapter, buildPublishApi, precheckMain, publishInputFromEnv, publishMain, readEvent } from "../src/run/entrypoints.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { publishReview } from "../src/publish/publish.js";
import type { NativeReviewRequest, PublishCommentRef, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";

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

test("precheck entrypoint writes the precheck ABI outputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-precheck-entry-"));
  const outputFile = join(dir, "gh-output.txt");
  try {
    writeFileSync(join(dir, "event.json"), JSON.stringify({ number: 7 }));
    const code = await precheckMain({
      REPO: "o/r",
      PR_NUMBER: "7",
      GITHUB_OUTPUT: outputFile,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_SERVER_URL: "https://github.com",
      PR_REVIEWER_ADAPTER: "",
    } as unknown as NodeJS.ProcessEnv & Record<string, string>);
    // The entrypoint builds its own real adapter from the environment.
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishInputFromEnv reads the internal degraded stage signal", () => {
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", DEGRADED: "true" } as NodeJS.ProcessEnv, "github").degraded, true);
  assert.equal(publishInputFromEnv({ PUBLISH_MODE: "comment", DEGRADED: "false" } as NodeJS.ProcessEnv, "github").degraded, false);
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

// ── Tangled fail-loud boundaries (#583) ──────────────────────────────────

test("a resolved tangled platform fails loudly at every adapter boundary", () => {
  const env = { REPO: "o/r", PR_NUMBER: "9", PLATFORM: "tangled", TANGLED_REPO_DID: "did:plc:repo" } as NodeJS.ProcessEnv;
  // Precheck adapter: the guard throws before either adapter branch runs.
  assert.throws(() => buildAdapter(env), TangledNotImplementedError);
  // Publish seam: GitHubPublishApi is never constructed, so no GitHub API
  // request can be assembled as a fallback.
  assert.throws(() => buildPublishApi(env), TangledNotImplementedError);
});

test("explicit tangled without its identity fails with the resolver diagnostic", () => {
  const env = { REPO: "o/r", PR_NUMBER: "9", PLATFORM: "tangled" } as NodeJS.ProcessEnv;
  assert.throws(
    () => buildAdapter(env),
    (e: unknown) => e instanceof Error && /TANGLED_REPO_DID/.test(e.message),
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
  incomplete_reason: string;
}> = {}): void {
  const artifact = {
    version: 1,
    tool_loop_ran: false,
    enforcement_harness: null,
    route: "primary",
    partial_coverage: null,
    required_checks: "complete",
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

test("#873: the CLI publish path (publishInputFromEnv + publishReview) downgrades APPROVE to COMMENT for a partial-coverage run", async () => {
  await withRunDirAsync(async (dir) => {
    writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: "tool-harness.json", partial_coverage: PARTIAL_COVERAGE });
    const head = "a".repeat(40);
    const env = {
      PR_REVIEWER_RUN_DIR: dir,
      VERDICT: "approve",
      REQUIRED_CHECKS: "complete",
      PUBLISH_MODE: "review_verdict",
      ALLOW_APPROVE: "true",
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
    assert.notEqual(api.submitted[0]!.event, "APPROVE");
    assert.equal(api.submitted[0]!.event, "COMMENT");
  });
});

function publishVerdictEnv(overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    VERDICT: "approve",
    REQUIRED_CHECKS: "complete",
    PUBLISH_MODE: "review_verdict",
    ALLOW_APPROVE: "true",
    IS_FORK_PR: "false",
    HEAD_SHA: "a".repeat(40),
    PR_NUMBER: "7",
    COMMENT_MARKER: "<!-- ai-pr-review -->",
    REVIEW_MARKDOWN: "Looks fine.",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

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
      assert.notEqual(api.submitted[0]!.event, "APPROVE", JSON.stringify(toolModeOverride));
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
      assert.notEqual(api.submitted[0]!.event, "APPROVE", JSON.stringify(routeOverride));
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
      assert.notEqual(api.submitted[0]!.event, "APPROVE", JSON.stringify(requiredChecksOverride));
    });
  }
});

test("#873/#838 regression: tool_loop_ran:true with an unrecognized enforcement_harness (including null) never APPROVEs", async () => {
  for (const enforcementHarness of [null, "", "tool-harness.txt", 42]) {
    await withRunDirAsync(async (dir) => {
      writeCoverageArtifact(dir, { tool_loop_ran: true, enforcement_harness: enforcementHarness as unknown as string | null });
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
      assert.equal(input.partialCoverage, undefined, JSON.stringify(enforcementHarness));
      assert.equal(input.coverageUnknown, true, JSON.stringify(enforcementHarness));
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published", JSON.stringify(enforcementHarness));
      assert.notEqual(api.submitted[0]!.event, "APPROVE", JSON.stringify(enforcementHarness));
    });
  }
});

test("#873/#838 regression: tool_loop_ran:true naming a missing enforcement_harness file (partial_coverage null) never APPROVEs", async () => {
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
    assert.notEqual(api.submitted[0]!.event, "APPROVE");
  });
});

test("#873/#838 regression: an absent or invalid persisted required_checks is coverage-unknown and never APPROVEs", async () => {
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
      assert.notEqual(api.submitted[0]!.event, "APPROVE", JSON.stringify(artifact));
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
    assert.notEqual(api.submitted[0]!.event, "APPROVE");
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

test("#873/#838 regression: a missing review-coverage.json withholds APPROVE (COMMENT)", async () => {
  await withRunDirAsync(async (dir) => {
    const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: dir }), "github");
    assert.equal(input.partialCoverage, undefined);
    assert.equal(input.coverageUnknown, true);
    const api = new MinimalPublishApi("a".repeat(40));
    const result = await publishReview(input, api, { diffText: "" });
    assert.equal(result.status, "published");
    assert.notEqual(api.submitted[0]!.event, "APPROVE");
    assert.equal(api.submitted[0]!.event, "COMMENT");
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
    // state and never submits APPROVE.
    {
      const input = publishInputFromEnv(publishVerdictEnv({ PR_REVIEWER_RUN_DIR: runDir }), "github");
      assert.ok(input.partialCoverage);
      assert.equal(input.coverageUnknown, undefined);
      const api = new MinimalPublishApi("a".repeat(40));
      const result = await publishReview(input, api, { diffText: "" });
      assert.equal(result.status, "published");
      assert.equal(api.submitted[0]!.event, "COMMENT");
    }

    // 2. No explicit PR_REVIEWER_RUN_DIR (absent, and the empty-string
    // form): publish must fail closed — never APPROVE — regardless of
    // what the checkout contains, and never read the checkout at all.
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
        assert.notEqual(api.submitted[0]!.event, "APPROVE", variant.name);
        assert.equal(api.submitted[0]!.event, "COMMENT", variant.name);
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
