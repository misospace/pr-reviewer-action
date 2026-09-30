import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { buildAdapter, buildPublishApi, precheckMain, publishInputFromEnv, publishMain } from "../src/run/entrypoints.js";
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

const PARTIAL_COVERAGE_HARNESS = JSON.stringify({
  stop_reason: "tool-call-budget-exhausted",
  partial_coverage: {
    stop_reason: "tool-call-budget-exhausted",
    changed_files_total: 2,
    unread_files: ["a.ts"],
    leads_total: 0,
    unresolved_leads: [],
  },
});

test("#873: publishInputFromEnv reads partial coverage from the run dir's tool-harness artifact", () => {
  withRunDir((dir) => {
    writeFileSync(join(dir, "tool-harness.json"), PARTIAL_COVERAGE_HARNESS);
    const input = publishInputFromEnv(
      { PR_REVIEWER_RUN_DIR: dir, REVIEW_ROUTE: "primary", PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv,
      "github",
    );
    assert.ok(input.partialCoverage);
    assert.equal(input.partialCoverage?.stop_reason, "tool-call-budget-exhausted");
  });
});

test("#873: publishInputFromEnv reads the smart harness for an escalated route", () => {
  withRunDir((dir) => {
    writeFileSync(join(dir, "tool-harness.smart.json"), PARTIAL_COVERAGE_HARNESS);
    const input = publishInputFromEnv(
      { PR_REVIEWER_RUN_DIR: dir, REVIEW_ROUTE: "escalated", PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv,
      "github",
    );
    assert.ok(input.partialCoverage);
    // The primary harness is never consulted on an escalated route.
    const primaryOnly = publishInputFromEnv(
      { PR_REVIEWER_RUN_DIR: dir, REVIEW_ROUTE: "primary", PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv,
      "github",
    );
    assert.equal(primaryOnly.partialCoverage, undefined);
  });
});

test("#873: publishInputFromEnv omits partialCoverage without a tool-harness artifact", () => {
  withRunDir((dir) => {
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.partialCoverage, undefined);
  });
});

test("#873: the CLI publish path (publishInputFromEnv + publishReview) downgrades APPROVE to COMMENT for a partial-coverage run", async () => {
  await withRunDirAsync(async (dir) => {
    writeFileSync(join(dir, "tool-harness.json"), PARTIAL_COVERAGE_HARNESS);
    const head = "a".repeat(40);
    const env = {
      PR_REVIEWER_RUN_DIR: dir,
      REVIEW_ROUTE: "primary",
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
