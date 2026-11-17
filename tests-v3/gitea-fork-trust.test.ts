/**
 * #1678: the Gitea forge identity inherits the fork/trust boundary UNCHANGED.
 *
 * The requirement is not "Gitea has a fork policy" — it is that introducing
 * the `gitea` identity neither WEAKENS nor ALTERS the existing one. These
 * tests compose the REAL seams a Gitea-served review crosses:
 *
 *  1. the real Gitea read adapter (`createGiteaPlatform` — the Forgejo-family
 *     adapter carrying the Gitea identity) fetches a real Gitea-shaped pull
 *     object over `/api/v1` (mock HTTP: real request paths and headers), and
 *     the ONE fork derivation (`deriveIsFork` / its fail-closed `deriveFork`
 *     wrapper) reads that object exactly as it reads a Forgejo or GitHub one;
 *  2. the real precheck comment-command gate, driven through that same Gitea
 *     adapter, defers a fork PR (`comment-fork-pr`) instead of letting a
 *     comment force a privileged review;
 *  3. the real engine boundary: with NO host-supplied `IS_FORK_PR`, the flag
 *     the engine DERIVES from the Gitea-served object (admission → fold →
 *     `review-request.json`) lands the same deterministic fork restrictions
 *     (tool harness skipped `fork-pr`, evidence providers off) that the
 *     existing fork tests pin for the GitHub path.
 *
 * No Gitea-specific fork policy exists anywhere in src/: there is no fork
 * branch keyed on the declared identity, and these tests pin the
 * Gitea==Forgejo outcomes rather than re-asserting an implementation
 * expression.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReview } from "../src/run/review.js";
import { deriveFork } from "../src/run/stages.js";
import { deriveIsFork } from "../src/platform/pr.js";
import { createGiteaPlatform } from "../src/platform/gitea.js";
import { ForgejoAdapter } from "../src/platform/forgejo.js";
import { runPrecheck } from "../src/precheck/decide.js";
import { startMockServer, type MockServer } from "./helpers.js";

const REPO = "acme/widgets";
const DIFF = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n";

/** A pull object shaped as upstream Gitea's `GET /api/v1/repos/{owner}/{repo}/pulls/{n}`
 * answers (GitHub-compatible `head.repo.full_name` / `base.repo.full_name`). */
function giteaPr(overrides: { head?: string } = {}): Record<string, unknown> {
  return {
    id: 42,
    number: 7,
    title: "Add widget mode",
    body: "Implements widget mode.",
    state: "open",
    draft: false,
    merged: false,
    html_url: `https://gitea.example/${REPO}/pulls/7`,
    user: { id: 3, login: "dev" },
    head: {
      sha: "b".repeat(40),
      ref: "widget-mode",
      label: `${overrides.head ?? "someone/other-widgets"}:widget-mode`,
      repo: { id: 8, name: "other-widgets", full_name: overrides.head ?? "someone/other-widgets" },
    },
    base: {
      sha: "a".repeat(40),
      ref: "main",
      label: `${REPO}:main`,
      repo: { id: 9, name: "widgets", full_name: REPO },
    },
  };
}

/** A mock Gitea instance speaking the family's `/api/v1` surface: PR read,
 * diff, files, comment/review lists, and the token-mode permission pair
 * (`/user` + `/collaborators/{login}/permission`). Unmatched reads 404 —
 * every consumer downstream of a failed read already fails soft by contract. */
async function startGiteaInstance(pr: unknown): Promise<MockServer & { paths: string[] }> {
  const paths: string[] = [];
  const server = await startMockServer((req, _body, res) => {
    const url = (req.url ?? "").split("?")[0]!;
    paths.push(url);
    if (url.endsWith("/pulls/7.diff")) {
      res.setHeader("Content-Type", "text/plain");
      res.end(DIFF);
      return;
    }
    if (url.endsWith("/collaborators/dev/permission") || url.endsWith("/collaborators/alice/permission")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ permission: "write" }));
      return;
    }
    if (url === "/api/v1/user") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ login: "dev" }));
      return;
    }
    if (url.endsWith("/pulls/7/files")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }]));
      return;
    }
    if (url.endsWith("/pulls/7")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(pr));
      return;
    }
    if (url.includes("/comments") || url.includes("/reviews") || url.endsWith("/status") || url.includes("/check-runs")) {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ errors: null }));
  });
  return Object.assign(server, { paths });
}

// --- 1. the ONE derivation reads a Gitea-fetched PR object like any family input --

test("#1678: a fork PR served by the real Gitea adapter derives fork=true through the shared derivation", async () => {
  const server = await startGiteaInstance(giteaPr());
  try {
    const adapter = createGiteaPlatform({ repo: REPO, prNumber: "7", baseUrl: server.url, token: "gitea-token" });
    const fetched = await adapter.getPr();
    assert.ok(fetched && typeof fetched === "object", "the adapter fetched the PR object over /api/v1");
    assert.ok(server.paths.includes(`/api/v1/repos/${REPO}/pulls/7`), "the request crossed the shared family endpoint");
    assert.equal(deriveIsFork(fetched), true);
    assert.equal(deriveFork(fetched), "true");

    // Same-repository head: not a fork.
    const sameRepo = await startGiteaInstance(giteaPr({ head: REPO }));
    try {
      const fetchedSameRepo = await createGiteaPlatform({ repo: REPO, prNumber: "7", baseUrl: sameRepo.url, token: "t" }).getPr();
      assert.equal(deriveIsFork(fetchedSameRepo), false);
      assert.equal(deriveFork(fetchedSameRepo), "false");
    } finally {
      await sameRepo.close();
    }

    // Fail-closed shapes on the SAME derivation: a Gitea answer whose head
    // repository identity is missing, or an unusable object, conservatively
    // derives a fork — the reading every other family input already gets.
    const headless = structuredClone(giteaPr());
    delete (headless.head as Record<string, unknown>).repo;
    assert.equal(deriveFork(headless), "true");
    assert.equal(deriveFork({}), "true");
  } finally {
    await server.close();
  }
});

test("#1678: Gitea and Forgejo adapters yield identical fork derivations for identical payloads", async () => {
  const payloads = [giteaPr(), giteaPr({ head: REPO }), { state: "open" }, {}];
  for (const payload of payloads) {
    const instance = await startGiteaInstance(payload);
    try {
      const viaGitea = deriveFork(await createGiteaPlatform({ repo: REPO, prNumber: "7", baseUrl: instance.url, token: "gt" }).getPr());
      const viaForgejo = deriveFork(await new ForgejoAdapter({ repo: REPO, prNumber: "7", baseUrl: instance.url, token: "ft" }).getPr());
      assert.equal(viaGitea, viaForgejo, "one payload, both identities, one verdict — no Gitea-specific fork reading");
    } finally {
      await instance.close();
    }
  }
});

// --- 2. the precheck seam: a Gitea fork cannot force a privileged review --------

const commentEnv = (instanceUrl: string): Record<string, string> => ({
  REPO,
  PR_NUMBER: "7",
  PLATFORM: "gitea",
  FORGEJO_API_URL: instanceUrl,
  GITEA_TOKEN: "gitea-token",
  PUBLISH_MODE: "comment",
  AI_MODEL: "test-model",
  REREVIEW_COMMAND: "/ai-review",
});

test("#1678: an authorized /ai-review on a Gitea-served fork PR is deferred (comment-fork-pr), not reviewed", async () => {
  const server = await startGiteaInstance(giteaPr());
  try {
    const output = await runPrecheck({
      env: commentEnv(server.url),
      adapter: createGiteaPlatform({ repo: REPO, prNumber: "7", baseUrl: server.url, token: "gitea-token" }),
      event: { name: "issue_comment", action: "created", comment: { id: 1, body: "/ai-review", user: "alice" } },
    });
    assert.equal(output.should_review, "false");
    assert.equal(output.skip_reason, "comment-fork-pr");
    // The commenter authorization itself crossed the same shared family
    // endpoint — the skip is the fork gate firing, not an earlier
    // authorization failure dressed up as one.
    assert.ok(server.paths.some((p) => p.includes("/collaborators/alice/permission")));
  } finally {
    await server.close();
  }

  // Same-repository twin: the fork gate does NOT fire — the authorized
  // command proceeds to a review. So the deferral above is the fork
  // boundary, not a blanket refusal of Gitea comment commands.
  const sameRepo = await startGiteaInstance(giteaPr({ head: REPO }));
  try {
    const output = await runPrecheck({
      env: commentEnv(sameRepo.url),
      adapter: createGiteaPlatform({ repo: REPO, prNumber: "7", baseUrl: sameRepo.url, token: "gitea-token" }),
      event: { name: "issue_comment", action: "created", comment: { id: 1, body: "/ai-review", user: "alice" } },
    });
    assert.equal(output.should_review, "true");
  } finally {
    await sameRepo.close();
  }
});

// --- 3. the engine boundary: the DERIVED flag lands the exact fork restrictions --

function verdictBody(verdict: Record<string, unknown>): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(verdict) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

const baseVerdict = (): Record<string, unknown> => ({
  verdict: "approve",
  review_markdown: "Looks fine.\n",
  smart_review_requested: false,
  smart_review_reason: null,
  findings: [],
  requirement_coverage: null,
  required_check_dispositions: [],
});

test("#1678: with no host-supplied IS_FORK_PR, the engine derives the flag from the Gitea-served pull and gates forks identically", async () => {
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(baseVerdict()));
  });
  const runOne = async (pr: unknown): Promise<{ forkFlag: unknown; runDir: string }> => {
    const instance = await startGiteaInstance(pr);
    const runDir = mkdtempSync(join(tmpdir(), "v3-gitea-fork-"));
    try {
      const result = await runReview({
        // NO IS_FORK_PR anywhere: the engine must derive the flag from the
        // object this Gitea instance serves, exactly as the family path does.
        env: {
          PLATFORM: "gitea",
          FORGEJO_API_URL: instance.url,
          GITHUB_REPOSITORY: REPO,
          PR_NUMBER: "7",
        },
        inputs: {
          "github-token": "tok",
          repo: REPO,
          "pr-number": "7",
          platform: "gitea",
          "forgejo-api-url": instance.url,
          "ai-base-url": model.url,
          "ai-model": "m",
          "ai-stream": "false",
          "ai-api-key": "k",
          "tool-mode": "native_loop",
        },
        runDir,
        workspace: runDir,
        platformAdapter: createGiteaPlatform({ repo: REPO, prNumber: "7", baseUrl: instance.url, token: "gitea-token" }),
        quiet: true,
      });
      assert.equal(result.outputs.verdict, "approve");
      const request = JSON.parse(readFileSync(join(runDir, "review-request.json"), "utf8")) as Record<string, unknown>;
      return { forkFlag: request.is_fork_pr, runDir };
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      throw error;
    } finally {
      await instance.close();
    }
  };

  const fork = await runOne(giteaPr());
  try {
    assert.equal(fork.forkFlag, "true", "the flag the engine recorded was DERIVED from the Gitea-served pull object");
    // The same deterministic restrictions the GitHub-path fork tests pin:
    // the tool harness refuses to run against the privileged checkout…
    const harness = JSON.parse(readFileSync(join(fork.runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>;
    assert.equal(harness.skip_reason, "fork-pr");
    // …and evidence providers stay off.
    const evidence = JSON.parse(readFileSync(join(fork.runDir, "evidence-providers.json"), "utf8")) as Record<string, unknown>;
    assert.equal(evidence.configured, false);
  } finally {
    rmSync(fork.runDir, { recursive: true, force: true });
  }

  const control = await runOne(giteaPr({ head: REPO }));
  try {
    assert.equal(control.forkFlag, "false", "a same-repository Gitea pull is not a fork — the identity grants no extra trust either");
  } finally {
    rmSync(control.runDir, { recursive: true, force: true });
  }

  await model.close();
});
