import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalChangedFile,
  canonicalLinkedIssue,
  canonicalPullRequest,
  normalizeLinkedIssues,
} from "../src/context/index.js";

// ── Canonical linked issues (#675 typed boundary) ─────────────────────────

test("canonicalLinkedIssue normalizes the GitHub REST shape", () => {
  const issue = canonicalLinkedIssue({
    number: 12,
    title: "Forged tokens",
    body: "audit report",
    state: "open",
    html_url: "https://github.com/owner/repo/issues/12",
    labels: [{ name: "security" }, "priority/p1"],
  }, "owner/repo");
  assert.equal(issue.source, "github");
  assert.equal(issue.repo, "owner/repo");
  assert.equal(issue.number, 12);
  assert.equal(issue.ref, "owner/repo#12");
  assert.deepEqual(issue.labels, [{ name: "security" }, { name: "priority/p1" }]);
  assert.equal(issue.priority, null);
});

test("canonicalLinkedIssue recognizes the Linear shape and keeps native priority", () => {
  const issue = canonicalLinkedIssue({
    identifier: "TEAM-77",
    title: "Handler drops payloads",
    description: "body from description",
    url: "https://linear.app/t/TEAM-77",
    priority: 2,
    labels: [{ name: "Bug" }],
  });
  assert.equal(issue.source, "linear");
  assert.equal(issue.ref, "TEAM-77");
  assert.equal(issue.priority, 2);
  assert.equal(issue.priority_label, "High");
  assert.equal(issue.body, "body from description");
});

test("canonicalLinkedIssue degrades unusable input without throwing", () => {
  for (const garbage of [null, undefined, 42, "issue", [], {}]) {
    const issue = canonicalLinkedIssue(garbage);
    assert.equal(typeof issue.ref, "string");
    assert.deepEqual(issue.labels.filter((l) => typeof l.name !== "string"), []);
  }
});

test("normalizeLinkedIssues maps a raw list positionally", () => {
  const issues = normalizeLinkedIssues([{ number: 1 }, { identifier: "TEAM-2", priority: 1 }], "o/r");
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.repo, "o/r");
  assert.equal(issues[1]?.source, "linear");
});

// ── Canonical changed files ───────────────────────────────────────────────

test("canonicalChangedFile passes the filename through and degrades counts", () => {
  const file = canonicalChangedFile({ filename: "src/a.ts", status: "modified", additions: 3, deletions: "x" });
  assert.equal(file.filename, "src/a.ts");
  assert.equal(file.additions, 3);
  assert.equal(file.deletions, null);
  assert.equal(canonicalChangedFile(null).filename, "");
});

// ── Canonical pull request metadata ───────────────────────────────────────

test("canonicalPullRequest normalizes the gh pr view shape", () => {
  const pr = canonicalPullRequest({
    number: 9,
    title: "T",
    body: "B",
    state: "OPEN",
    draft: true,
    head: { ref: "feat", sha: "abc" },
    base: { ref: "main" },
    user: { login: "someone" },
    html_url: "https://github.com/o/r/pull/9",
  });
  assert.equal(pr.head_sha, "abc");
  assert.equal(pr.head_ref, "feat");
  assert.equal(pr.base_ref, "main");
  assert.equal(pr.author, "someone");
  assert.equal(pr.draft, true);
  assert.equal(canonicalPullRequest("nope").number, 0);
});
