/** #904: a repository-relative system-prompt-file resolves against the
 * trusted base ref, not the run's artifact directory (which made every repo
 * path fail) and not the PR head. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { startMockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

function mockPlatform(options: { diff?: string; files?: unknown[] } = {}): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 7,
      title: "Loosen the rules",
      body: "",
      head: { sha: "a".repeat(40), ref: "feature" },
      base: { ref: "main" },
      user: { login: "someone" },
      changed_files: options.files?.length ?? 1,
      additions: 4,
      deletions: 1,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: () => Promise.resolve(options.diff ?? "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n"),
    listPrFiles: () => Promise.resolve({ ok: true, data: options.files ?? [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] }),
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

function verdictBody(): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null,
      findings: [], requirement_coverage: null, required_check_dispositions: [],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}

interface RunFixture { runDir: string; cleanup: () => void }
function withRunDir(): RunFixture {
  const runDir = mkdtempSync(join(tmpdir(), "v3-run-test-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}


function repo(): { workspace: string; runDir: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), "v3-prompt-ws-"));
  const runDir = mkdtempSync(join(tmpdir(), "v3-prompt-run-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", workspace], { env: GIT_ENV });
  return { workspace, runDir, cleanup: (): void => { rmSync(workspace, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); } };
}

async function reviewWithPrompt(workspace: string, runDir: string, env: Record<string, string>): Promise<string[]> {
  const bodies: string[] = [];
  const server = await startMockServer((_req, reqBody, res) => {
    bodies.push(String(reqBody));
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  try {
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false", ...env },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        "system-prompt-file": ".agents/review.md", "system-prompt-mode": "append",
      },
      runDir, workspace, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true,
    });
  } finally {
    await server.close();
  }
  return bodies;
}

test("#904: a relative system-prompt-file is read from the base ref, not the run dir or the PR head", async () => {
  const { workspace, runDir, cleanup } = repo();
  try {
    write(workspace, ".agents/review.md", "BASE PROMPT RULE\n");
    const baseSha = commit(workspace, "base prompt");
    write(workspace, ".agents/review.md", "HEAD PROMPT RULE\n");
    commit(workspace, "head rewrites the prompt");

    const bodies = await reviewWithPrompt(workspace, runDir, { PR_REVIEWER_BASE_REF: baseSha });
    assert.ok(bodies.length > 0, "the review must reach the model instead of failing on the prompt file");
    assert.ok(bodies.some((b) => b.includes("BASE PROMPT RULE")));
    assert.ok(!bodies.some((b) => b.includes("HEAD PROMPT RULE")));
  } finally {
    cleanup();
  }
});

test("#904: with no base ref the prompt file is read from the checkout", async () => {
  const { workspace, runDir, cleanup } = repo();
  try {
    write(workspace, ".agents/review.md", "CHECKOUT PROMPT RULE\n");
    commit(workspace, "prompt");

    const bodies = await reviewWithPrompt(workspace, runDir, {});
    assert.ok(bodies.some((b) => b.includes("CHECKOUT PROMPT RULE")));
  } finally {
    cleanup();
  }
});
