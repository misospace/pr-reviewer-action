/** #885: end-to-end proof that the standards file is resolved from the PR's
 * trusted base ref, never the checked-out working tree (the PR head) — a PR
 * must not be able to rewrite the rules its own review enforces. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "standards-base-ref-test-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: GIT_ENV });
  return root;
}

interface RunFixture { runDir: string; cleanup: () => void }
function withRunDir(): RunFixture {
  const runDir = mkdtempSync(join(tmpdir(), "v3-run-test-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}

test("#885: a PR that drops a rule from AGENTS.md on its head is still reviewed against the base rule", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const { runDir, cleanup } = withRunDir();
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", runDir], { env: GIT_ENV });
    write(runDir, "AGENTS.md", "# Rules\n- Never use eval()\n");
    const baseSha = commit(runDir, "base standards");
    // The PR's own head: it edits AGENTS.md to remove the rule.
    write(runDir, "AGENTS.md", "# Rules\n(rule removed by this PR)\n");
    commit(runDir, "head drops the rule");

    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false", PR_REVIEWER_BASE_REF: baseSha },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
      },
      runDir, workspace: runDir, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true,
    });

    const standardsContext = readFileSync(join(runDir, "standards-context.md"), "utf8");
    assert.match(standardsContext, /Never use eval\(\)/);
    assert.doesNotMatch(standardsContext, /rule removed by this PR/);
    const present = readFileSync(join(runDir, "standards-present.txt"), "utf8");
    assert.equal(present.trim(), "AGENTS.md");
  } finally {
    await server.close();
    cleanup();
  }
});

test("#885: a higher-priority candidate the PR head adds is invisible — the base ref's lower-priority match wins", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const { runDir, cleanup } = withRunDir();
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", runDir], { env: GIT_ENV });
    // Base only has CLAUDE.md (later in the default candidate order).
    write(runDir, "CLAUDE.md", "base rules via CLAUDE.md\n");
    const baseSha = commit(runDir, "base standards");
    // The PR's head adds AGENTS.md, which sorts earlier in the default
    // candidate order — an attempt to have its own (favorable) copy win.
    write(runDir, "AGENTS.md", "head rules via AGENTS.md (should never be used)\n");
    commit(runDir, "head adds a higher-priority candidate");

    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false", PR_REVIEWER_BASE_REF: baseSha },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
      },
      runDir, workspace: runDir, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true,
    });

    const standardsContext = readFileSync(join(runDir, "standards-context.md"), "utf8");
    assert.match(standardsContext, /base rules via CLAUDE\.md/);
    assert.doesNotMatch(standardsContext, /AGENTS\.md \(should never be used\)/);
    const present = readFileSync(join(runDir, "standards-present.txt"), "utf8");
    assert.equal(present.trim(), "CLAUDE.md");
  } finally {
    await server.close();
    cleanup();
  }
});

test("#885: a base-ref read failure yields no standards and a warning, never a fallback to the PR head", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const { runDir, cleanup } = withRunDir();
  const warnings: string[] = [];
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", runDir], { env: GIT_ENV });
    write(runDir, "AGENTS.md", "head-only rules (must never be read)\n");
    commit(runDir, "head only, no distinct base ref");

    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false" }, // PR_REVIEWER_BASE_REF unset
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
      },
      runDir, workspace: runDir, platformAdapter: mockPlatform(), persistArtifacts: true, quiet: true,
      error: (line) => warnings.push(line),
    });

    const standardsContext = readFileSync(join(runDir, "standards-context.md"), "utf8");
    assert.doesNotMatch(standardsContext, /head-only rules/);
    assert.match(standardsContext, /standards context unavailable/);
    const present = readFileSync(join(runDir, "standards-present.txt"), "utf8");
    assert.equal(present, "");
    assert.ok(warnings.some((line) => /standards file could not be read from the base ref/.test(line)), warnings.join("\n"));
  } finally {
    await server.close();
    cleanup();
  }
});

test("#885: the corpus notes when the PR's diff modifies the (base-ref-resolved) standards file", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody());
  });
  const { runDir, cleanup } = withRunDir();
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", runDir], { env: GIT_ENV });
    write(runDir, "AGENTS.md", "# Rules\n- Never use eval()\n");
    const baseSha = commit(runDir, "base standards");
    write(runDir, "AGENTS.md", "# Rules\n(rule removed by this PR)\n");
    commit(runDir, "head drops the rule");

    const diff = "diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,2 +1,2 @@\n # Rules\n-- Never use eval()\n+(rule removed by this PR)\n";
    await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "gh-output.txt"), IS_FORK_PR: "false", PR_REVIEWER_BASE_REF: baseSha },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
      },
      runDir, workspace: runDir,
      platformAdapter: mockPlatform({ diff, files: [{ filename: "AGENTS.md", status: "modified", additions: 1, deletions: 1, changes: 2 }] }),
      persistArtifacts: true, quiet: true,
    });

    const standardsContext = readFileSync(join(runDir, "standards-context.md"), "utf8");
    assert.match(standardsContext, /this PR modifies AGENTS\.md; the base-ref version above was used/);
    assert.match(standardsContext, /Never use eval\(\)/);
  } finally {
    await server.close();
    cleanup();
  }
});
