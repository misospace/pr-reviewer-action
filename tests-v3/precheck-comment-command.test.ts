import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkerFingerprint,
  collectConfigLines,
  computeConfigHash,
  computeDiffFingerprint,
} from "../src/precheck/fingerprint.js";
import { commentBodyTriggersCommentCommand, runPrecheck } from "../src/precheck/decide.js";
import { FixtureAdapter, type PrecheckFixture } from "../src/precheck/fixture.js";

// #914: the `issue_comment` /ai-review re-review command, decided in the
// precheck. Fixtures are built inline (FixtureAdapter + inline platform
// objects) — NOT under tests/fixtures/parity/, which the parity harness
// replays against the v2 goldens.

const DIFF = "diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

type Platform = PrecheckFixture["platform"];

// ── Shared fixture helpers ───────────────────────────────────────────────

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    REPO: "o/r",
    PR_NUMBER: "7",
    PLATFORM: "github",
    PUBLISH_MODE: "comment",
    AI_MODEL: "test-model",
    // The contract default for rereview-command is applied by loadConfig
    // before precheck runs; the raw env surface needs it explicitly.
    REREVIEW_COMMAND: "/ai-review",
    ...overrides,
  };
}

/** A same-repo PR (NOT a fork): head and base full names match. */
function sameRepoPr(): unknown {
  return {
    head: { sha: "head-abc", repo: { full_name: "o/r" } },
    base: { sha: "base-abc", repo: { full_name: "o/r" } },
  };
}

/** A fork PR: the head repo differs from the base repo (deriveIsFork). */
function forkPr(): unknown {
  return {
    head: { sha: "head-abc", repo: { full_name: "someone/r" } },
    base: { sha: "base-abc", repo: { full_name: "o/r" } },
  };
}

/** A managed comment body whose stored fingerprint marker matches the
 * current diff + config — the exact state the diff-unchanged guard would
 * SKIP. Used to prove the comment command FORCES a review despite an
 * unchanged diff. */
function matchingMarkerBody(env: Record<string, string>, diff: string): string {
  const diffFp = computeDiffFingerprint(diff);
  const configHash = computeConfigHash(collectConfigLines(env));
  const marker = buildMarkerFingerprint(diffFp, configHash);
  return `<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:${marker} -->\n## Review\nPrior review body.\n`;
}

function issueCommentEvent(body: string, user: string) {
  return { name: "issue_comment", action: "created", comment: { id: 1, body, user } };
}

// ── The comment-body matcher (pure, adversarial-safe) ─────────────────────

test("commentBodyTriggersCommentCommand matches the bare command and rejects lookalikes", () => {
  const cmd = "/ai-review";
  // The command itself as the whole body.
  assert.equal(commentBodyTriggersCommentCommand("/ai-review", cmd), true);
  // The command with a trailing newline (trailing whitespace is tolerated).
  assert.equal(commentBodyTriggersCommentCommand("/ai-review\n", cmd), true);
  // The command followed by a word (v1 takes no arguments).
  assert.equal(commentBodyTriggersCommentCommand("/ai-review now", cmd), false);
  // A lookalike with no boundary (command + "x").
  assert.equal(commentBodyTriggersCommentCommand("/ai-reviewx", cmd), false);
  // Leading whitespace before the command.
  assert.equal(commentBodyTriggersCommentCommand("   /ai-review", cmd), true);
  // A multi-line body starting with the command.
  assert.equal(commentBodyTriggersCommentCommand("/ai-review\nmore text", cmd), false);
  // An empty body.
  assert.equal(commentBodyTriggersCommentCommand("", cmd), false);
  // The command embedded, not at the start.
  assert.equal(commentBodyTriggersCommentCommand("please /ai-review", cmd), false);
  // The match is case-sensitive.
  assert.equal(commentBodyTriggersCommentCommand("/AI-Review", cmd), false);
  // Regex-special characters in the command are matched literally.
  assert.equal(commentBodyTriggersCommentCommand("/ai.review(x)", "/ai.review(x)"), true);
  // ...and the same command with trailing text does not.
  assert.equal(commentBodyTriggersCommentCommand("/ai.review(x) now", "/ai.review(x)"), false);
  assert.equal(commentBodyTriggersCommentCommand("/ai.review(y)", "/ai.review(x)"), false);
  // An empty command never matches (it would match everything).
  assert.equal(commentBodyTriggersCommentCommand("/ai-review", ""), false);
});

// ── Authorization through the forge API ────────────────────────────────────

test("#914: a hostile commenter login fails closed and can never escape the repo-scoped permission endpoint (#252)", async () => {
  const { GitHubAdapter } = await import("../src/platform/github.js");
  for (const user of ["../../evil", "a/b", "x\ny", "*`(", "%2e%2e"]) {
    const requested: string[] = [];
    const adapter = new GitHubAdapter({
      repo: "o/r",
      prNumber: "7",
      token: "Bearer t",
      fetchImpl: (async (url: string | URL) => {
        requested.push(String(url));
        return new Response("{}", { status: 200 });
      }) as never,
    });
    const output = await runPrecheck({
      env: baseEnv(),
      adapter,
      event: issueCommentEvent("/ai-review", user),
    });
    assert.equal(output.should_review, "false", `user=${JSON.stringify(user)}`);
    assert.equal(output.skip_reason, "comment-permission-unknown", `user=${JSON.stringify(user)}`);
    // Either rejected by endpoint validation outright (no request) or sent
    // as ONE encoded segment inside the repo-scoped prefix — never more.
    assert.ok(requested.length <= 1, `user=${JSON.stringify(user)}: ${requested.join(", ")}`);
    for (const raw of requested) {
      const path = new URL(raw).pathname;
      assert.ok(path.startsWith("/repos/o/r/collaborators/"), path);
      assert.equal(path.split("/").length, 7, `login must stay one path segment: ${path}`);
    }
  }
});

test("#914: an authorized (write) comment command forces a review despite an unchanged diff", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    // The stored marker matches the current diff — without the forced
    // review this would skip as diff-unchanged.
    comments: [{ id: 1, body: matchingMarkerBody(env, DIFF), created_at: "2024-01-01T00:00:00Z" }],
    pr: sameRepoPr(),
    gh_api: { "repos/o/r/collaborators/alice/permission": { permission: "write" } },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "true");
  assert.equal(output.skip_reason, "");
});

test("#914: write-or-higher permissions authorize the comment command", async () => {
  // Un-collapsed `permission` values (Forgejo, and any server that still
  // returns triage/maintain directly).
  for (const permission of ["admin", "maintain", "write", "triage", "owner"]) {
    const env = baseEnv();
    const platform: Platform = {
      diff: DIFF,
      pr: sameRepoPr(),
      gh_api: { "repos/o/r/collaborators/alice/permission": { permission } },
    };
    const output = await runPrecheck({
      env,
      adapter: new FixtureAdapter("github", platform),
      event: issueCommentEvent("/ai-review", "alice"),
    });
    assert.equal(output.should_review, "true", `permission=${permission}`);
    assert.equal(output.skip_reason, "", `permission=${permission}`);
  }
});

test("#914: a GitHub triage user (collapsed to read) authorizes via role_name, but a plain read does not", async () => {
  // GitHub collapses the triage role into `permission: "read"` in this
  // endpoint's legacy field, reporting the real role only in `role_name`.
  const triage = await runPermission({ permission: "read", role_name: "triage" });
  assert.equal(triage.should_review, "true");
  assert.equal(triage.skip_reason, "");
  // A read+role_name triage_plus also authorizes.
  const triagePlus = await runPermission({ permission: "read", role_name: "triage_plus" });
  assert.equal(triagePlus.should_review, "true");
  // A plain read (or read with an unrelated custom role) is rejected —
  // an unrecognizable role cannot prove the triage bar.
  const plainRead = await runPermission({ permission: "read", role_name: "read" });
  assert.equal(plainRead.should_review, "false");
  assert.equal(plainRead.skip_reason, "comment-unauthorized");
  const customRole = await runPermission({ permission: "read", role_name: "deploy-bot" });
  assert.equal(customRole.should_review, "false");
  assert.equal(customRole.skip_reason, "comment-unauthorized");
});

async function runPermission(permission: Record<string, unknown>) {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: { "repos/o/r/collaborators/alice/permission": permission },
  };
  return runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
}

test("#914: read/none permissions are rejected as comment-unauthorized", async () => {
  for (const permission of ["read", "none"]) {
    const env = baseEnv();
    const platform: Platform = {
      diff: DIFF,
      pr: sameRepoPr(),
      gh_api: { "repos/o/r/collaborators/alice/permission": { permission } },
    };
    const output = await runPrecheck({
      env,
      adapter: new FixtureAdapter("github", platform),
      event: issueCommentEvent("/ai-review", "alice"),
    });
    assert.equal(output.should_review, "false", `permission=${permission}`);
    assert.equal(output.skip_reason, "comment-unauthorized", `permission=${permission}`);
  }
});

test("#914: a permission lookup error or a missing permission field fails closed (comment-permission-unknown)", async () => {
  const env = baseEnv();
  const errorPlatform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: { "repos/o/r/collaborators/alice/permission": { error: "GitHub API error: 403" } },
  };
  const errOutput = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", errorPlatform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(errOutput.should_review, "false");
  assert.equal(errOutput.skip_reason, "comment-permission-unknown");

  const noFieldPlatform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    // A payload with no `permission` field at all.
    gh_api: { "repos/o/r/collaborators/alice/permission": { role: "something" } },
  };
  const noFieldOutput = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", noFieldPlatform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(noFieldOutput.should_review, "false");
  assert.equal(noFieldOutput.skip_reason, "comment-permission-unknown");
});

test("#914: a matching comment with no commenter fails closed (comment-permission-unknown)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {},
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: { name: "issue_comment", action: "created", comment: { id: 1, body: "/ai-review" } },
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-permission-unknown");
});

// ── The command gate (before any permission lookup) ───────────────────────

test("#914 v1 scope (bare command only, no arguments): an argument like /ai-review smart from an authorized user is skipped as unrelated-comment without a permission lookup", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    // An EMPTY gh_api map: any accidental permission lookup would return an
    // error and flip the skip reason to comment-permission-unknown. Getting
    // unrelated-comment back proves the adapter was never consulted — the
    // argument never reaches the authorization step.
    gh_api: {},
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review smart", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "unrelated-comment");
});

test("#914: a non-matching comment body is skipped as unrelated-comment without a permission lookup", async () => {
  const env = baseEnv();
  for (const body of ["/ai-reviewx", "please /ai-review", "/AI-Review", "/ai-review now", "/ai-review\nmore text"]) {
    // An EMPTY gh_api map: any accidental permission lookup would return an
    // error and flip the skip reason to comment-permission-unknown. Getting
    // unrelated-comment back proves the adapter was never consulted.
    const platform: Platform = {
      diff: DIFF,
      pr: sameRepoPr(),
      gh_api: {},
    };
    const output = await runPrecheck({
      env,
      adapter: new FixtureAdapter("github", platform),
      event: issueCommentEvent(body, "alice"),
    });
    assert.equal(output.should_review, "false", `body=${body}`);
    assert.equal(output.skip_reason, "unrelated-comment", `body=${body}`);
  }
});

test("#914: an empty REREVIEW_COMMAND disables the comment command (comment-disabled) even for a matching body", async () => {
  const env = baseEnv({ REREVIEW_COMMAND: "" });
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    // A write permission is present — it must never be consulted because the
    // command is disabled before any lookup.
    gh_api: { "repos/o/r/collaborators/alice/permission": { permission: "write" } },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-disabled");
});

// ── The fork / PR-lookup gates (after authorization) ──────────────────────

test("#914: an authorized comment on a fork PR is skipped as comment-fork-pr (action.ts owns the reply)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: forkPr(),
    gh_api: { "repos/o/r/collaborators/alice/permission": { permission: "write" } },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-fork-pr");
});

test("#914: an authorized comment whose PR lookup fails is skipped as comment-pr-lookup-failed (fail closed)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr_error: true,
    gh_api: { "repos/o/r/collaborators/alice/permission": { permission: "write" } },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-pr-lookup-failed");
});

test("#914: a permission response naming a different subject than the commenter is rejected (fail closed)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {
      "repos/o/r/collaborators/alice/permission": { permission: "admin", user: { login: "ci-bot" } },
    },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-permission-unknown");
});

test("#914: a permission response whose subject has a non-string login fails closed (comment-permission-unknown)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {
      "repos/o/r/collaborators/alice/permission": { permission: "admin", user: { login: 123 } },
    },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-permission-unknown");
});

test("#914: a permission response whose subject has no login at all fails closed (comment-permission-unknown)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {
      "repos/o/r/collaborators/alice/permission": { permission: "admin", user: {} },
    },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-permission-unknown");
});

test("#914: a permission response whose subject is a bare string fails closed (comment-permission-unknown)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {
      "repos/o/r/collaborators/alice/permission": { permission: "admin", user: "alice" },
    },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-permission-unknown");
});

test("#914: a permission response whose subject is an array fails closed (comment-permission-unknown)", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {
      "repos/o/r/collaborators/alice/permission": { permission: "admin", user: [{ login: "alice" }] },
    },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-permission-unknown");
});

test("#914: a permission response naming the commenter herself authorizes normally", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: sameRepoPr(),
    gh_api: {
      "repos/o/r/collaborators/alice/permission": { permission: "admin", user: { login: "Alice" } },
    },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "true");
});

test("#914: an authorized comment on a closed PR is skipped as comment-pr-closed", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    pr: { ...sameRepoPr() as object, state: "closed" },
    gh_api: { "repos/o/r/collaborators/alice/permission": { permission: "write" } },
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: issueCommentEvent("/ai-review", "alice"),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "comment-pr-closed");
});

// ── Regression: the label path is untouched ───────────────────────────────

test("#914 regression: a pull_request labeled event still forces a review via the label path", async () => {
  const env = baseEnv();
  const platform: Platform = {
    diff: DIFF,
    comments: [{ id: 1, body: matchingMarkerBody(env, DIFF), created_at: "2024-01-01T00:00:00Z" }],
    pr: sameRepoPr(),
    gh_api: {},
  };
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", platform),
    event: { name: "pull_request", action: "labeled", label: { name: "ai-review" } },
  });
  assert.equal(output.should_review, "true");
  assert.equal(output.skip_reason, "");
});
