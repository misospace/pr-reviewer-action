import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
  GrepAttribution,
  LineSplitter,
  pyInt,
  pyParseInt,
  workspaceRegularFile,
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
  assert.match(text(artifacts.get("repo-impact.truncated.md")), /## Term: widget-core\n\n### git grep hits\n```text\nsrc\/app\.txt:1:uses widget-core\n```/);
  assert.match(text(artifacts.get("repo-history.truncated.md")), /add widget-core/);
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

test("a title-only (#N) reference links the issue (#872)", async () => {
  const getIssue = async (repo: string, number: string): Promise<ReadResult<unknown>> =>
    number === "584" ? { ok: true, data: { number: 584, labels: [{ name: "acceptance" }] } } : { ok: false, error: `no ${repo}#${number}` };
  const result = await buildLinkedIssueContext({
    pr: { title: "feat(v3): add Tangled Bobbin read client and canonical pull resolver (#584)", body: "no closing keyword here" },
    repo: "o/r", adapter: { getIssue }, isForkPr: "false", linear: noLinear,
  });
  assert.deepEqual(result.linkedIssues, [
    { ref: "#584", repo: "o/r", number: 584, labels: [{ name: "acceptance" }] },
  ]);
  assert.match(text(result.artifacts.get("linked-issues.md")), /## #584/);
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

test("containment guard refuses every symlink component and '..' (#805)", () => {
  const root = mkdtempSync(join(tmpdir(), "producers-contain-"));
  const ws = join(root, "ws");
  mkdirSync(join(ws, "real"), { recursive: true });
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "secret.yaml"), "RUNNER-SECRET\n");
  writeFileSync(join(ws, "real", "deployment.yaml"), "kind: Deployment\n");
  symlinkSync(join(root, "outside", "secret.yaml"), join(ws, "deployment.yaml"));
  symlinkSync(join(root, "outside"), join(ws, "linked"));
  assert.equal(workspaceRegularFile(ws, "real/deployment.yaml"), true);
  assert.equal(workspaceRegularFile(ws, `${ws}/real/deployment.yaml`), true);
  assert.equal(workspaceRegularFile(ws, "deployment.yaml"), false);
  assert.equal(workspaceRegularFile(ws, "linked/secret.yaml"), false);
  assert.equal(workspaceRegularFile(ws, "real/../real/deployment.yaml"), false);
  assert.equal(workspaceRegularFile(ws, `${root}/outside/secret.yaml`), false);
  assert.equal(workspaceRegularFile(ws, `${root}/outside/secret.yaml`, { allowExternal: true }), true);
  const { artifacts } = buildManifestContext([{ filename: "deployment.yaml" }, { filename: "linked/secret.yaml" }], ws);
  assert.doesNotMatch(text(artifacts.get("manifest-context.md")), /RUNNER-SECRET/);
  writeFileSync(join(ws, "CLAUDE.md"), "rules\n");
  symlinkSync(join(root, "outside", "secret.yaml"), join(ws, "AGENTS.md"));
  assert.equal(resolveStandardsFile({ standardsFile: "AGENTS.md", candidates: "AGENTS.md,linked/*.yaml,CLAUDE.md", workspace: ws }), "CLAUDE.md");
  assert.equal(resolveStandardsFile({ standardsFile: "AGENTS.md", candidates: "linked/*.yaml", workspace: ws }), "");
});

test("grep attribution stays bounded when grep output far exceeds the caps (#805)", () => {
  const terms = ["alpha-term", "beta-term"];
  const attribution = new GrepAttribution(terms, 60, 24000);
  const splitter = new LineSplitter();
  const filler = Buffer.from(`src/noise.txt:1:${"x".repeat(200)} unrelated\n`.repeat(4096));
  const hits = Buffer.from(`src/hit.txt:1:alpha-term ${"y".repeat(500)}\n`.repeat(64));
  const before = process.memoryUsage().heapUsed;
  let fed = 0;
  let open = true;
  // ~1 GiB of non-matching rows interleaved with matching ones.
  while (fed < 1024 * 1024 * 1024) {
    open = splitter.push(filler, (line) => attribution.push(line)) && open;
    splitter.push(hits, (line) => attribution.push(line));
    fed += filler.length + hits.length;
  }
  const retained = attribution.section(0).length + attribution.section(1).length;
  // The byte budget binds first here: rows stop once the section passes
  // 24000 bytes (at most one row over), well under the 60-row cap.
  assert.ok(retained > 24000 && retained <= 24000 + 600, `retained ${retained} bytes`);
  assert.ok(attribution.section(0).toString().split("\n").length - 1 < 60);
  assert.equal(attribution.section(1).length, 0);
  assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024, "heap grew beyond the caps");
  const saturated = new GrepAttribution(["alpha-term"], 60, 24000);
  let calls = 0;
  const shortHits = Buffer.from("src/hit.txt:1:alpha-term\n".repeat(64));
  new LineSplitter().push(shortHits, (line) => {
    calls += 1;
    return saturated.push(line);
  });
  assert.equal(calls, 60, "the stream stops once every term is full");
});

test("repo impact output stays capped when the combined grep is huge (#805)", async () => {
  const big = "widget-core ".repeat(40);
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i += 1) files[`src/f${i}.txt`] = `${big}\n`.repeat(2000);
  const root = workspace(files, true);
  const { artifacts } = await buildRepoImpactHistory({ pr: { title: "widget-core", body: "" }, versionHintsTruncated: null, workspace: root });
  const impact = artifacts.get("repo-impact.truncated.md") ?? new Uint8Array(0);
  assert.ok(impact.length <= 24000);
  assert.match(text(impact), /…\[impact scan truncated\]\n$/);
  assert.equal(artifacts.has("repo-impact.md"), false);
});

test("pyInt and pyParseInt follow CPython 3.14 int() and argparse", () => {
  const cases: [string, number | null][] = [
    ["20", 20], [" 7 ", 7], ["1_0", 10], ["٣", 3], ["\u{1D7D7}", 9], ["٣_٣", 33], [" 5 ", 5],
    ["0", 0], ["-3", -3], ["+4", 4], ["1__0", null], ["_1", null], ["", null], [" ", null], ["-5_0", -50], ["๑๒", 12], ["１２", 12],
  ];
  for (const [input, expected] of cases) assert.equal(pyInt(input), expected, JSON.stringify(input));
  assert.equal(pyParseInt("-3"), -3);
  assert.equal(pyParseInt("-x"), null);
  assert.equal(pyParseInt("-"), null);
});

test("hostile fence delimiters inside a longer fence never pose as its closer", () => {
  const md = Buffer.from(`# Head\n\n[related-code context truncated]\n\n\`\`\`\`md\n\`\`\`\n~~~\n${"body\n".repeat(20)}\`\`\`\`\ntail\n`);
  const clipped = text(clipMarkdown(md, md.length - 10));
  assert.equal(clipped, `# Head\n\n[related-code context truncated]\n\n${CLIP_MARKER}`);
});
