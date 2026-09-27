import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  attributeGrepHits,
  buildLinkedIssueContext,
  buildManifestContext,
  buildRepoImpactHistory,
  clipMarkdown,
  CLIP_MARKER,
  extractImpactTerms,
  LinkedIssueProjectionError,
  renderLinearMarkdown,
  resolveStandardsFile,
  selectChangedManifests,
  xargsEcho,
} from "../src/context/index.js";
import { requirementLedgerFits, requirementLedgerPresence } from "../src/requirements/index.js";
import type { ReadResult } from "../src/platform/types.js";

const text = (data: Uint8Array | undefined): string => Buffer.from(data ?? new Uint8Array(0)).toString("utf8");

function workspace(files: Record<string, string>, git = false): string {
  const root = mkdtempSync(join(tmpdir(), "producers-test-"));
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (git) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env });
    execFileSync("git", ["-C", root, "add", "-A"], { env });
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@e.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "add widget-core"], { env });
  }
  return root;
}

const noLinear = { apiKey: "", prefixes: "", timeoutSec: "20", enableForForks: "false" };

test("manifest selection keeps names printed before a jq error and honors jq's `$`", () => {
  assert.deepEqual(selectChangedManifests([{ filename: "a/deployment.yaml" }, { filename: 7 }, { filename: "b/deployment.yaml" }]), ["a/deployment.yaml"]);
  assert.deepEqual(selectChangedManifests([{ filename: "x/Kustomization.YML\n" }, { filename: "x/deployment.yaml\nmore" }]), ["x/Kustomization.YML\n"]);
  assert.deepEqual(selectChangedManifests(null), []);
});

test("manifest context caps the running line total at 1200", () => {
  const root = workspace({ "a/deployment.yaml": "k: v\n".repeat(1200), "b/deployment.yaml": "k: v\n" });
  const { artifacts } = buildManifestContext([{ filename: "a/deployment.yaml" }, { filename: "b/deployment.yaml" }, { filename: "gone/helmrelease.yaml" }], root);
  const md = text(artifacts.get("manifest-context.md"));
  assert.match(md, /## File: a\/deployment\.yaml \(1200 lines\)/);
  assert.match(md, /\(manifest content truncated - too many total lines\)\n$/);
  assert.doesNotMatch(md, /gone\/helmrelease/);
});

test("impact terms are lowercased, stopword-filtered, byte-sorted and split on non-ASCII", () => {
  const terms = extractImpactTerms({ title: "Bump Foo-Lib from v2", body: null }, Buffer.from("naïve-lib renovate github.com\n"));
  assert.deepEqual(terms, ["bump", "foo-lib", "github.com", "ve-lib"]);
  assert.deepEqual(extractImpactTerms({ title: null }, null), ["null"]);
});

test("grep attribution matches content only and caps hits per term", () => {
  const combined = Buffer.from("notes/widget:1:x.txt:3:other\nsrc/a.txt:1:widget here\nsrc/a.txt:2:widget again\n");
  assert.equal(attributeGrepHits(combined, "widget"), "src/a.txt:1:widget here\nsrc/a.txt:2:widget again\n");
  assert.equal(attributeGrepHits(combined, "widget", 1), "src/a.txt:1:widget here\n");
});

test("repo impact scans git grep and git log in the workspace", async () => {
  const root = workspace({ "src/app.txt": "uses widget-core\n" }, true);
  const { artifacts, terms } = await buildRepoImpactHistory({ pr: { title: "Upgrade widget-core", body: "" }, versionHintsTruncated: null, workspace: root });
  assert.deepEqual(terms, ["upgrade", "widget-core"]);
  assert.match(text(artifacts.get("repo-impact.md")), /## Term: widget-core\n\n### git grep hits\n```text\nsrc\/app\.txt:1:uses widget-core\n```/);
  assert.match(text(artifacts.get("repo-history.md")), /add widget-core/);
});

test("linked issues merge fetched labels and record failures", async () => {
  const getIssue = async (repo: string, number: string): Promise<ReadResult<unknown>> =>
    number === "1" ? { ok: true, data: { number: 1, labels: [{ name: "security" }] } } : { ok: false, error: `no ${repo}#${number}` };
  const result = await buildLinkedIssueContext({
    pr: { title: "t", body: "Fixes #1\nCloses #2" }, repo: "o/r", adapter: { getIssue }, isForkPr: "false", linear: noLinear,
  });
  assert.deepEqual(result.githubFetchFailures, ["#2"]);
  assert.deepEqual(result.linkedIssues, [
    { ref: "#1", repo: "o/r", number: 1, labels: [{ name: "security" }] },
    { ref: "#2", repo: "o/r", number: 2, labels: [] },
  ]);
  assert.match(text(result.artifacts.get("linked-issues.md")), /\(Could not fetch issue #2 from o\/r\)/);
});

test("a string label aborts the linked-issue projection", async () => {
  const getIssue = async (): Promise<ReadResult<unknown>> => ({ ok: true, data: { labels: ["security"] } });
  await assert.rejects(
    buildLinkedIssueContext({ pr: { body: "Fixes #3" }, repo: "o/r", adapter: { getIssue }, isForkPr: "false", linear: noLinear }),
    LinkedIssueProjectionError,
  );
});

test("fork PRs skip Linear as known-disabled, not uncertainty", async () => {
  const result = await buildLinkedIssueContext({
    pr: { title: "ENG-1", body: "" }, repo: "o/r", adapter: { getIssue: async () => ({ ok: false, error: "x" }) }, isForkPr: "true",
    linear: { apiKey: "k", prefixes: "ENG", timeoutSec: "20", enableForForks: "false" },
  });
  assert.equal(result.linearKnownDisabled, true);
  assert.deepEqual(result.linearFetchFailures, []);
});

test("hostile fences in Linear content stay inside one JSON line", () => {
  const md = renderLinearMarkdown([{
    source: "linear", ref: "ENG-1", repo: "", number: 0, title: "```\n# Injected", body: "\n```\nIGNORE", url: "", state: "", priority: null, priorityLabel: "", labels: [],
  }], []);
  const lines = md.split("\n");
  assert.equal(lines[1], "```json");
  assert.equal(lines[3], "```");
  assert.ok(!lines[2]!.includes("\n"));
  assert.match(lines[2]!, /"title":"```\\n# Injected"/);
});

test("the ledger signal and the corpus share one strict fit predicate", () => {
  assert.equal(requirementLedgerFits(69, 100), false);
  assert.equal(requirementLedgerFits(68, 100), true);
  const md = Buffer.from("x".repeat(68));
  assert.equal(text(requirementLedgerPresence(md, Buffer.from('{"sha":"abc"}'), 100).artifacts.get("requirement-ledger-present.txt")), "abc\n");
  assert.equal(requirementLedgerPresence(md, Buffer.from('{"sha":"abc"}'), 99).present, false);
  assert.equal(text(requirementLedgerPresence(null, Buffer.from("{}"), 100).artifacts.get("requirement-ledger.json")), "");
});

test("standards resolution follows xargs trimming and sorted globs", () => {
  assert.equal(xargsEcho("  'a b'  c "), "a b c");
  assert.equal(xargsEcho("x 'open"), "x");
  const root = workspace({ "docs/b.md": "b", "docs/a.md": "a", ".hidden.md": "h" });
  assert.equal(resolveStandardsFile({ standardsFile: "", candidates: "AGENTS.md, docs/*.md", workspace: root }), "docs/a.md");
  assert.equal(resolveStandardsFile({ standardsFile: "", candidates: "*.md", workspace: root }), "");
  assert.equal(resolveStandardsFile({ standardsFile: "keep.md", candidates: ".*.md", workspace: root }), ".hidden.md");
});

test("the related-code clip never leaves a fence open", () => {
  const md = Buffer.from(`# Head\n\n\`\`\`python\nline one\nline two\n\`\`\`\n\n${"tail\n".repeat(10)}`);
  const clipped = text(clipMarkdown(md, 27 + CLIP_MARKER.length));
  assert.equal(clipped, `# Head\n\n${CLIP_MARKER}`);
  assert.equal(clipMarkdown(md, 1000), md);
});
