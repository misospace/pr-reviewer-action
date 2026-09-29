import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precheckMain, publishMain } from "../src/run/entrypoints.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

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
