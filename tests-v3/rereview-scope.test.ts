/** #1426: re-review scope — the two-scope split (full PR authoritative,
 * prior-head delta advisory). Pins the force-push A→B→A→C regression: the
 * second review evaluates A→C while knowing B→C is the newly changed
 * portion, version/dependency extraction stays anchored to the full current
 * PR range, and a rebase-only push does not manufacture a new delta. */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReviewCorpus, type CorpusWorkspace } from "../src/corpus/index.js";
import { buildReReviewScopeMd, computeReReviewDelta, MAX_DELTA_COMMITS, runGit, type ReReviewScopeDelta } from "../src/context/rereview-scope.js";
import { runPrecheck } from "../src/precheck/decide.js";
import { FixtureAdapter, type PrecheckFixture } from "../src/precheck/fixture.js";
import { buildMarkerFingerprint, collectConfigLines, computeConfigHash, computeDiffFingerprint } from "../src/precheck/fingerprint.js";
import { runReviewEngine } from "../src/engine/review.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const dec = (data: Uint8Array | null | undefined): string =>
  data === null || data === undefined ? "" : Buffer.from(data).toString("utf8");

// ---------------------------------------------------------------------------
// Git workspace fixture: the force-push shape (A→B, then rewritten as A→C)
// ---------------------------------------------------------------------------

/** A real repository with the #1426 shape: base commit A; first push B
 * (changes base.txt to 2.2.2); force-push rewrite C (base.txt back to the
 * A content, README +version: 9.9.9, new chart.txt +appVersion: 3.3.3).
 * The FULL A→C diff carries the 9.9.9/3.3.3 hints; the B→C delta carries a
 * -version: 2.2.2 line the full range never shows. */
function forcePushRepo(): { root: string; shaA: string; shaB: string; shaC: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "v3-rereview-repo-"));
  const git = (args: string): void => {
    execSync(`git -c user.email=test@example.com -c user.name=test ${args}`, { cwd: root, stdio: "ignore" });
  };
  git("init -q -b main");
  mkdirSync(join(root, "dir"), { recursive: true });
  const write = (name: string, content: string): void => {
    writeFileSync(join(root, name), content);
  };
  write("base.txt", "version: 1.0.0\n");
  write("README.md", "hello\n");
  git("add -A");
  git(`commit -q -m "base A"`);
  const shaA = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  git("checkout -q -b feature");
  write("base.txt", "version: 2.2.2\n");
  git("commit -qam " + JSON.stringify("B: bump base"));
  const shaB = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  // Force-push shape: feature is rewritten from A (B is abandoned).
  execSync("git reset -q --hard " + shaA, { cwd: root });
  write("README.md", "hello\nversion: 9.9.9\n");
  write("chart.txt", "appVersion: 3.3.3\n");
  git("add -A");
  git(`commit -q -m "C: bump chart"`);
  const shaC = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  return { root, shaA, shaB, shaC, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}

// The full A→C diff the forge would serve for the rewritten branch.
const FULL_AC_DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " hello",
  "+version: 9.9.9",
  "diff --git a/chart.txt b/chart.txt",
  "--- /dev/null",
  "+++ b/chart.txt",
  "@@ -0,0 +1 @@",
  "+appVersion: 3.3.3",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// computeReReviewDelta
// ---------------------------------------------------------------------------

test("#1426: the force-push delta B→C is enumerated against the real checkout", async () => {
  const repo = forcePushRepo();
  try {
    const delta = await computeReReviewDelta(repo.root, repo.shaB, repo.shaC);
    assert.equal(delta.enumerated, true);
    assert.equal(delta.treeUnchanged, false);
    assert.equal(delta.priorHeadSha, repo.shaB);
    assert.equal(delta.headSha, repo.shaC);
    assert.deepEqual(delta.commits.map((commit) => commit.sha), [repo.shaC]);
    assert.match(delta.commits[0]!.subject, /C: bump chart/);
    assert.deepEqual([...delta.files].sort(), ["README.md", "base.txt", "chart.txt"]);
    assert.equal(delta.filesTruncated, false);
    assert.equal(delta.commitsTruncated, false);
  } finally { repo.cleanup(); }
});

test("#1426: a rebase-only push (identical tree) enumerates as treeUnchanged", async () => {
  const repo = forcePushRepo();
  try {
    // Rebase-only shape: a new commit on top of B with B's exact tree.
    execSync(`git -c user.email=test@example.com -c user.name=test checkout -q -b rebased ${repo.shaB}`, { cwd: repo.root, stdio: "ignore" });
    execSync("git -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m rebase", { cwd: repo.root, stdio: "ignore" });
    const shaE = execSync("git rev-parse HEAD", { cwd: repo.root }).toString().trim();
    const delta = await computeReReviewDelta(repo.root, repo.shaB, shaE);
    assert.equal(delta.enumerated, true);
    assert.equal(delta.treeUnchanged, true);
    assert.deepEqual([...delta.files], []);
  } finally { repo.cleanup(); }
});

test("#1426: an unprovable delta fails soft with identities intact", async () => {
  const repo = forcePushRepo();
  try {
    // A force-pushed-away head the checkout no longer contains.
    const delta = await computeReReviewDelta(repo.root, "f".repeat(40), repo.shaC);
    assert.equal(delta.enumerated, false);
    assert.equal(delta.treeUnchanged, false);
    assert.deepEqual([...delta.commits], []);
    assert.deepEqual([...delta.files], []);
    // A non-git workspace cannot enumerate either.
    const outside = mkdtempSync(join(tmpdir(), "v3-rereview-nogit-"));
    try {
      assert.equal((await computeReReviewDelta(outside, repo.shaB, repo.shaC)).enumerated, false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { repo.cleanup(); }
});

test("#1426: malformed or equal SHAs never reach git", async () => {
  const repo = forcePushRepo();
  try {
    assert.equal((await computeReReviewDelta(repo.root, "not-a-sha", repo.shaC)).enumerated, false);
    assert.equal((await computeReReviewDelta(repo.root, repo.shaB, "ZZ")).enumerated, false);
    const same = await computeReReviewDelta(repo.root, repo.shaC, repo.shaC);
    assert.equal(same.enumerated, false);
  } finally { repo.cleanup(); }
});

test("#1426: delta probe caps honor the module bounds", async () => {
  const repo = forcePushRepo();
  try {
    // Drive the file cap: MAX_DELTA_FILES+1 real files between B and C.
    const writes: string[] = [];
    for (let index = 0; index <= 200; index += 1) writes.push(`f${index}.txt`);
    execSync(`git -c user.email=test@example.com -c user.name=test checkout -q -b many ${repo.shaB}`, { cwd: repo.root, stdio: "ignore" });
    const { writeFileSync } = await import("node:fs");
    for (const name of writes) writeFileSync(join(repo.root, name), "x\n");
    execSync("git add -A", { cwd: repo.root, stdio: "ignore" });
    execSync("git -c user.email=test@example.com -c user.name=test commit -qm many", { cwd: repo.root, stdio: "ignore" });
    const head = execSync("git rev-parse HEAD", { cwd: repo.root }).toString().trim();
    const delta = await computeReReviewDelta(repo.root, repo.shaB, head);
    assert.equal(delta.enumerated, true);
    assert.equal(delta.files.length, 200);
    assert.equal(delta.filesTruncated, true, "the extra file is reported as truncation, never dropped silently");
  } finally { repo.cleanup(); }
});

// ---------------------------------------------------------------------------
// buildReReviewScopeMd
// ---------------------------------------------------------------------------

const enumeratedDelta: ReReviewScopeDelta = {
  priorHeadSha: "b".repeat(40),
  headSha: "c".repeat(40),
  enumerated: true,
  treeUnchanged: false,
  commits: [{ sha: "c".repeat(40), subject: "C: bump chart" }],
  commitsTruncated: false,
  files: ["README.md", "base.txt", "chart.txt"],
  filesTruncated: false,
};

test("#1426: the section states both scopes and the full-PR authority rule", () => {
  const section = buildReReviewScopeMd(enumeratedDelta, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40), baseSha: "a".repeat(40) });
  assert.match(section, /^# Re-Review Scope\n/);
  assert.match(section, /base `a{40}` → head `c{40}`/);
  assert.match(section, /final verdict and summary must describe this full range/);
  assert.match(section, /b{40}/);
  assert.match(section, /C: bump chart/);
  assert.match(section, /chart\.txt/);
  assert.match(section, /Version and dependency evidence is anchored to the full current PR range/);
  assert.match(section, /never redefines the change being approved or rejected/);
});

test("#1426: no prior head or a same-head re-review renders no section", () => {
  assert.equal(buildReReviewScopeMd(enumeratedDelta, { priorHeadSha: "", headSha: "c".repeat(40), baseSha: "a".repeat(40) }), "");
  assert.equal(buildReReviewScopeMd(enumeratedDelta, { priorHeadSha: "not-a-sha", headSha: "c".repeat(40), baseSha: "a".repeat(40) }), "");
  assert.equal(buildReReviewScopeMd(enumeratedDelta, { priorHeadSha: "c".repeat(40), headSha: "c".repeat(40), baseSha: "a".repeat(40) }), "");
});

test("#1426: an unenumerable delta still states both identities", () => {
  const section = buildReReviewScopeMd(null, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40), baseSha: "" });
  assert.match(section, /b{40}/);
  assert.match(section, /could not be enumerated/);
  assert.match(section, /the configured base/);
});

test("#1426: a tree-unchanged rebase is named as such", () => {
  const section = buildReReviewScopeMd(
    { ...enumeratedDelta, treeUnchanged: true, files: [], commits: [{ sha: "c".repeat(40), subject: "rebase" }] },
    { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40), baseSha: "a".repeat(40) },
  );
  assert.match(section, /No file-level changes since the previous reviewed head/);
});

test("#1426: commit subjects and file paths cannot close their fence", () => {
  const hostile: ReReviewScopeDelta = {
    ...enumeratedDelta,
    commits: [{ sha: "c".repeat(40), subject: "fix ```evil``` payload" }],
    files: ["```backticked```path.txt"],
  };
  const section = buildReReviewScopeMd(hostile, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40), baseSha: "a".repeat(40) });
  assert.ok(section.includes("fix ```evil``` payload"), "the subject survives verbatim inside the fence");
  assert.ok(section.includes("```backticked```path.txt"), "the path survives verbatim inside the fence");
  // Every fenced block's payload must be inert: between the opener and the
  // FIRST line that could close it (its own closer), no interior line is a
  // pure backtick run long enough to terminate the fence early.
  const lines = section.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(`{3,})$/.exec(lines[index] ?? "");
    if (!opener) continue;
    const openerLength = opener[1]!.length;
    let closerAt = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = /^(`{3,})$/.exec(lines[scan] ?? "");
      if (candidate && candidate[1]!.length >= openerLength) {
        closerAt = scan;
        break;
      }
    }
    assert.ok(closerAt > index, "each fence opens with a matching closer");
    for (let interior = index + 1; interior < closerAt; interior += 1) {
      const interiorRun = /^(`+)$/.exec(lines[interior] ?? "");
      assert.ok(!interiorRun || interiorRun[1]!.length < openerLength, "no interior run can close the fence early");
    }
    index = closerAt;
  }
});

test("#1426: the section is hard-capped without ever leaving a fence unclosed", () => {
  const manyFiles = Array.from({ length: 200 }, (_, index) => `very-long-descriptive-path-${index}-padding-padding-padding.txt`);
  const section = buildReReviewScopeMd(
    { ...enumeratedDelta, files: manyFiles, filesTruncated: true },
    { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40), baseSha: "a".repeat(40) },
  );
  assert.ok(Buffer.byteLength(section, "utf8") <= 4096, "the cap holds exactly");
  assert.match(section, /(truncated|omitted for size)/, "an oversized delta shrinks with a visible note");
  // Even the capped variant must close every fence it opens.
  const lines = section.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(`{3,})$/.exec(lines[index] ?? "");
    if (!opener) continue;
    const openerLength = opener[1]!.length;
    let closerAt = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = /^(`{3,})$/.exec(lines[scan] ?? "");
      if (candidate && candidate[1]!.length >= openerLength) {
        closerAt = scan;
        break;
      }
    }
    assert.ok(closerAt > index, "each fence in the capped section still closes");
    index = closerAt;
  }
});

// ---------------------------------------------------------------------------
// Precheck: the prior reviewed head travels only from the authenticated body
// ---------------------------------------------------------------------------

const PRECHECK_DIFF = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n a\n+b\n";
const PRECHECK_SHA = /^[0-9a-f]{7,64}$/i;

function precheckBody(headSha: string): string {
  return [
    "<!-- ai-pr-reviewer -->",
    `<!-- ai-pr-review-fingerprint:stale-not-matching|cfg:old -->`,
    "## Review",
    "Body.",
    `<!-- ai-pr-reviewer:{"version":1,"head_sha":"${headSha}","base_sha":"base-old","review_result":"issues"} -->`,
    "",
  ].join("\n");
}

function precheckEnv(): Record<string, string> {
  return { REPO: "misospace/demo", PR_NUMBER: "42", PUBLISH_MODE: "comment", AI_MODEL: "test-model" };
}

function precheckPlatform(
  comments: { id: number; body: string; created_at: string; author: string }[],
  identity?: string,
): PrecheckFixture["platform"] {
  return {
    diff: PRECHECK_DIFF,
    ...(identity === undefined ? {} : { identity }),
    comments,
    pr: {
      number: 42,
      state: "open",
      draft: false,
      head: { sha: "c".repeat(40), ref: "feature", repo: { full_name: "misospace/demo" } },
      base: { sha: "a".repeat(40), ref: "main", repo: { full_name: "misospace/demo" } },
    },
  };
}

test("#1426: the review path carries the authenticated marker's prior head", async () => {
  const output = await runPrecheck({
    env: precheckEnv(),
    adapter: new FixtureAdapter("github", precheckPlatform(
      [{ id: 1, body: precheckBody("b".repeat(40)), created_at: "2024-01-01T00:00:00Z", author: "pr-reviewer[bot]" }],
      "pr-reviewer[bot]",
    )),
  });
  assert.equal(output.should_review, "true");
  assert.equal(output.prior_head_sha, "b".repeat(40));
});

test("#1426: an unauthenticated marker body never supplies the prior head", async () => {
  const output = await runPrecheck({
    env: precheckEnv(),
    adapter: new FixtureAdapter("github", precheckPlatform(
      [{ id: 1, body: precheckBody("b".repeat(40)), created_at: "2024-01-01T00:00:00Z", author: "attacker" }],
      "pr-reviewer[bot]",
    )),
  });
  assert.equal(output.should_review, "true");
  assert.equal(output.prior_head_sha, "");
});

test("#1426: a malformed marker head is refused as a delta identity", async () => {
  const output = await runPrecheck({
    env: precheckEnv(),
    adapter: new FixtureAdapter("github", precheckPlatform(
      [{ id: 1, body: precheckBody("head-old"), created_at: "2024-01-01T00:00:00Z", author: "pr-reviewer[bot]" }],
      "pr-reviewer[bot]",
    )),
  });
  assert.equal(output.should_review, "true");
  assert.equal(output.prior_head_sha, "");
});

test("#1426: the diff-unchanged skip keeps its own head semantics and carries no prior", async () => {
  const env = precheckEnv();
  const fingerprint = buildMarkerFingerprint(
    computeDiffFingerprint(PRECHECK_DIFF) || "empty-diff",
    computeConfigHash(collectConfigLines(env)),
  );
  const body = precheckBody("b".repeat(40)).replace(
    "stale-not-matching|cfg:old",
    fingerprint,
  );
  const output = await runPrecheck({
    env,
    adapter: new FixtureAdapter("github", precheckPlatform(
      [{ id: 1, body, created_at: "2024-01-01T00:00:00Z", author: "pr-reviewer[bot]" }],
      "pr-reviewer[bot]",
    )),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "diff-unchanged");
  assert.equal(output.prior_head_sha, "");
  assert.ok(PRECHECK_SHA.test(output.head_sha), "the skip's own head semantics are untouched");
});

// ---------------------------------------------------------------------------
// Engine regression: the second review evaluates A→C while knowing B→C
// ---------------------------------------------------------------------------

function engineAdapter(options: { shaC: string; shaA: string; comments: { body: string; author: string }[]; identity: string | null }): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({
      number: 7, title: "Bump chart", body: "", state: "open", draft: false,
      head: { sha: options.shaC, ref: "feature", repo: { full_name: "o/r" } },
      base: { sha: options.shaA, ref: "main", repo: { full_name: "o/r" } },
      user: { login: "someone" }, changed_files: 2, additions: 2, deletions: 0,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: async () => FULL_AC_DIFF,
    listPrFiles: async () => ({ ok: true, data: [
      { filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 },
      { filename: "chart.txt", status: "added", additions: 1, deletions: 0, changes: 1 },
    ] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => options.comments.map((comment, index) => ({ id: index + 1, body: comment.body, created_at: "2024-01-01T00:00:00Z", author: comment.author })),
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => options.identity,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

function verdictBody(): string {
  return JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}

const inputs = { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": "", "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" };

function managedBody(headSha: string): string {
  return [
    "<!-- ai-pr-reviewer -->",
    `<!-- ai-pr-reviewer:{"version":1,"head_sha":"${headSha}","base_sha":"base","review_result":"issues"} -->`,
    "",
  ].join("\n");
}

test("#1426 engine: force-push A→B then A→C reviews the full A→C range with the B→C delta named", async () => {
  const repo = forcePushRepo();
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const runDir = mkdtempSync(join(tmpdir(), "v3-rereview-run-"));
  try {
    const result = await runReviewEngine(
      {
        repository: "o/r", prNumber: "7", headSha: repo.shaC, baseRef: "", isForkPr: "false",
        platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"),
        inputs: { ...inputs, "ai-base-url": server.url }, ambient: {}, triggerReason: "manual", forceRereview: false,
      },
      {
        workspace: repo.root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(runDir, "summary.md"),
        adapter: engineAdapter({
          shaC: repo.shaC, shaA: repo.shaA,
          comments: [{ body: managedBody(repo.shaB), author: "pr-reviewer[bot]" }],
          identity: "pr-reviewer[bot]",
        }),
        persistArtifacts: true, quiet: true,
        log: () => {}, error: () => {}, annotate: () => {},
      },
    );
    assert.equal(result.outputs.verdict, "approve");
    const scope = readFileSync(join(runDir, "re-review-scope.md"), "utf8");
    assert.match(scope, /^# Re-Review Scope\n/);
    assert.ok(scope.includes(repo.shaB), "the prior reviewed head is named");
    assert.ok(scope.includes(repo.shaC), "the current head is named");
    assert.ok(scope.includes("chart.txt"), "the B→C delta files are named");
    assert.ok(scope.includes("C: bump chart"), "the B→C delta commits are named");
    // Full-PR scope authority: the corpus carries the section AND the full
    // A→C diff, and version extraction consumed the FULL range.
    const corpus = readFileSync(join(runDir, "review-corpus.md"), "utf8");
    const scopeAt = corpus.indexOf("# Re-Review Scope");
    const filesAt = corpus.indexOf("# PR Files");
    assert.ok(scopeAt >= 0 && filesAt >= 0 && scopeAt < filesAt, "the scope section precedes the file list and diff");
    assert.ok(corpus.includes("+version: 9.9.9"), "the full A→C diff is the review's diff");
    const hints = readFileSync(join(runDir, "version-hints.txt"), "utf8");
    assert.ok(hints.includes("9.9.9"), "version hints come from the full A→C range");
    assert.ok(!hints.includes("2.2.2"), "a delta-only extraction would carry the B-only 2.2.2 hint; the full range does not");
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("#1426 engine: a first review (no managed body) carries no scope section", async () => {
  const repo = forcePushRepo();
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const runDir = mkdtempSync(join(tmpdir(), "v3-rereview-run-"));
  try {
    await runReviewEngine(
      {
        repository: "o/r", prNumber: "7", headSha: repo.shaC, baseRef: "", isForkPr: "false",
        platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"),
        inputs: { ...inputs, "ai-base-url": server.url }, ambient: {}, triggerReason: "manual", forceRereview: false,
      },
      {
        workspace: repo.root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(runDir, "summary.md"),
        adapter: engineAdapter({ shaC: repo.shaC, shaA: repo.shaA, comments: [], identity: null }),
        persistArtifacts: true, quiet: true,
        log: () => {}, error: () => {}, annotate: () => {},
      },
    );
    const scopePath = join(runDir, "re-review-scope.md");
    const scope = readFileSync(scopePath, "utf8");
    assert.equal(scope, "", "the artifact is cleared, never stale");
    const corpus = readFileSync(join(runDir, "review-corpus.md"), "utf8");
    assert.ok(!corpus.includes("# Re-Review Scope"), "a fresh review's corpus is unchanged");
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Corpus assembly placement
// ---------------------------------------------------------------------------

function baseWorkspace(): CorpusWorkspace {
  return {
    manifestContextMd: enc("manifests\n"),
    prJson: enc(JSON.stringify({ number: 1, title: "t", author: { login: "a" } })),
    classificationJson: enc(JSON.stringify({ pr_kind: "app_code", risk_flags: [] })),
    relatedCodeTruncatedMd: null,
    repoMapMd: null,
    prThreadMd: null,
    reviewThreadsMd: null,
    humanReviewsMd: null,
    linkedIssuesMd: null,
    ciChecksContent: null,
    versionHintsTruncatedTxt: null,
    toolHarnessMd: null,
    toolHarnessSmartMd: null,
    evidenceProvidersMd: null,
    imageDigestContextMd: enc("no digests\n"),
    linkedSourcesMd: enc("no sources\n"),
    repoImpactTruncatedMd: enc("no impact\n"),
    repoHistoryTruncatedMd: enc("no history\n"),
    prDiff: enc("diff\n"),
    prFilesJson: enc("[]"),
    prDiffTruncated: enc("diff\n"),
    prFilesTruncatedJson: enc("[]"),
    standardsContextMd: enc("# Standards\ntext\n"),
    requirementLedgerMd: null,
    specialistsMd: null,
    requirementLedgerPresent: null,
    specialistLeadsPresent: null,
    standardsFileContent: enc("standards body\n"),
  };
}

const baseOptions = {
  tier: "primary" as const,
  slot: "primary" as const,
  maxCorpus: 220000,
  diffBudget: 140000,
  filesBudget: 70000,
  repoMapMaxBytes: 12000,
  standardsFile: "AGENTS.md",
  ciChecksFile: "",
  budgetGuard: false,
};

test("#1426 corpus: the scope section lands before the file list and diff", () => {
  const result = buildReviewCorpus(
    { ...baseWorkspace(), reReviewScopeMd: enc("# Re-Review Scope\nscope body\n") },
    baseOptions,
  );
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  const scopeAt = corpus.indexOf("# Re-Review Scope");
  const filesAt = corpus.indexOf("# PR Files");
  assert.ok(scopeAt >= 0 && filesAt >= 0 && scopeAt < filesAt);
});

test("#1426 corpus: an absent or empty scope section leaves the corpus byte-identical", () => {
  const absent = buildReviewCorpus(baseWorkspace(), baseOptions);
  const empty = buildReviewCorpus({ ...baseWorkspace(), reReviewScopeMd: new Uint8Array(0) }, baseOptions);
  const explicitNull = buildReviewCorpus({ ...baseWorkspace(), reReviewScopeMd: null }, baseOptions);
  assert.deepEqual(
    absent.artifacts.get("review-corpus.md"),
    empty.artifacts.get("review-corpus.md"),
  );
  assert.deepEqual(
    absent.artifacts.get("review-corpus.md"),
    explicitNull.artifacts.get("review-corpus.md"),
  );
});

test("#1426 corpus: the scope section survives a body truncation that eats tail sections", () => {
  const result = buildReviewCorpus(
    {
      ...baseWorkspace(),
      reReviewScopeMd: enc("# Re-Review Scope\nscope body\n"),
      prDiffTruncated: enc("diff --git a/b b/b\n" + "+payload\n".repeat(5000)),
      prDiff: enc("diff --git a/b b/b\n" + "+payload\n".repeat(5000)),
    },
    { ...baseOptions, maxCorpus: 8000, budgetGuard: true },
  );
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  assert.ok(corpus.includes("# Re-Review Scope"), "the scope framing cannot be truncated away");
  assert.ok(!corpus.includes("# Repository History"), "low-value tail sections are still dropped first");
});

test("#1426/#1516 shared probe: a non-positive caller cap degrades to the module default", async () => {
  const repo = forcePushRepo();
  try {
    for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = await runGit(repo.root, ["rev-parse", "HEAD"], cap);
      assert.equal(outcome.ok, true, `cap ${cap} must not fail the probe`);
      assert.equal(outcome.truncated, false, `cap ${cap} must not make every capture read as truncated`);
      assert.match(outcome.stdout, /^[0-9a-f]{40,64}\n$/);
    }
    // A valid positive cap still reports truncation honestly.
    const capped = await runGit(repo.root, ["rev-parse", "HEAD"], 1);
    assert.equal(capped.ok, true);
    assert.equal(capped.truncated, true);
    // A non-finite cap must engage the fallback bound, not disable capping:
    // output beyond 64 KiB reads as truncated (pre-change, NaN reached the
    // subprocess unvalidated and reported a full uncapped capture as
    // complete).
    writeFileSync(join(repo.root, "big.txt"), `${"x".repeat(70_000)}\n`);
    execSync("git -c user.email=test@example.com -c user.name=test add -A", { cwd: repo.root, stdio: "ignore" });
    execSync("git -c user.email=test@example.com -c user.name=test commit -qm big", { cwd: repo.root, stdio: "ignore" });
    const unbounded = await runGit(repo.root, ["cat-file", "blob", "HEAD:big.txt"], Number.NaN);
    assert.equal(unbounded.ok, true);
    assert.equal(unbounded.truncated, true);
    assert.equal(Buffer.byteLength(unbounded.stdout, "utf8"), 65_536);
  } finally {
    repo.cleanup();
  }
});

// Keep the commit-cap constant honest: the probe reads one past it so an
// overflow is reportable.
assert.ok(MAX_DELTA_COMMITS >= 1);
