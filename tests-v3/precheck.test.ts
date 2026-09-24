import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildMarkerFingerprint,
  collectConfigLines,
  computeConfigHash,
  computeDiffFingerprint,
  EMPTY_DIFF_FINGERPRINT,
  parseMarkerFingerprints,
} from "../src/precheck/fingerprint.js";
import { buildMetadataMarker, parseMetadata, pythonJsonStringify } from "../src/precheck/metadata.js";
import { extractLinkedIssueRefs, labelsOf } from "../src/precheck/linked-issues.js";
import { extractIssueIdentifiers, parsePrefixes } from "../src/precheck/linear.js";
import { buildSelectionSignature } from "../src/precheck/selection.js";
import {
  carriedVerdict,
  evaluatePrecheck,
  extractStoredFingerprint,
  lastManagedBody,
  runPrecheck,
} from "../src/precheck/decide.js";
import { FixtureAdapter, fixtureLinearCollector, type PrecheckFixture } from "../src/precheck/fixture.js";

const DIFF = "diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

// ── Fingerprinting ───────────────────────────────────────────────────────

test("diff fingerprints hash content and treat empty diffs as empty", () => {
  assert.equal(computeDiffFingerprint(""), "");
  assert.equal(computeDiffFingerprint("   \n"), "");
  assert.equal(computeDiffFingerprint(DIFF).length, 64);
});

test("config hashing sorts lines, drops comments, and honors the verbosity dial", () => {
  assert.equal(computeConfigHash(["B=2", "# comment", "A=1", ""]), computeConfigHash(["A=1", "B=2"]));
  assert.equal(computeConfigHash([]), "");
  const env = { AI_MODEL: "m", REVIEW_VERBOSITY: "CONCISE" };
  const lines = collectConfigLines(env);
  assert.ok(lines.includes("REVIEW_VERBOSITY=concise"));
  assert.ok(lines.includes("AI_MODEL=m"));
  // The dial only invalidates on a genuine switch to concise.
  const normal = collectConfigLines({ AI_MODEL: "m", REVIEW_VERBOSITY: "normal" });
  assert.ok(!normal.some((line) => line.startsWith("REVIEW_VERBOSITY")));
  // Secrets are excluded from the sweep: a rotated key never changes review
  // behavior and must not enter hash inputs.
  assert.ok(!collectConfigLines({ AI_MODEL: "m", AI_API_KEY: "sk-secret" }).some((line) => line.includes("sk-secret")));
});

test("marker fingerprints round-trip the empty-diff placeholder and first marker wins", () => {
  const marker = buildMarkerFingerprint("", "abc");
  assert.equal(marker, `${EMPTY_DIFF_FINGERPRINT}|cfg:abc`);
  const body = `intro\n<!-- ai-pr-review-fingerprint:${marker} -->\n<!-- ai-pr-review-fingerprint:second|cfg:x -->\n`;
  assert.deepEqual(parseMarkerFingerprints(body), [marker]);
  assert.equal(extractStoredFingerprint(body), marker);
  assert.equal(extractStoredFingerprint("no marker here"), "");
});

// ── The decision function ────────────────────────────────────────────────

test("evaluatePrecheck skips only on a marker match and force review bypasses", () => {
  const marker = buildMarkerFingerprint(computeDiffFingerprint(DIFF), "cfg-hash");
  const skip = evaluatePrecheck(DIFF, [marker], { configHash: "cfg-hash" });
  assert.equal(skip.decision, "skip_already_reviewed");
  const changed = evaluatePrecheck(DIFF, ["other|cfg:x"], { configHash: "cfg-hash" });
  assert.equal(changed.decision, "review_needed");
  const forced = evaluatePrecheck(DIFF, [marker], { configHash: "cfg-hash", forceReview: true });
  assert.equal(forced.decision, "review_needed");
  // An empty diff is not a skip: it fingerprints as empty-diff so the
  // marker round-trip can skip subsequent runs.
  const empty = evaluatePrecheck("", [], { configHash: "" });
  assert.equal(empty.decision, "review_needed");
  assert.equal(empty.diff_fingerprint, EMPTY_DIFF_FINGERPRINT);
});

// ── Metadata markers / carry-forward verdict ─────────────────────────────

test("metadata markers parse and drive the carried verdict", () => {
  const body = `text\n${buildMetadataMarker({ head_sha: "h", base_sha: "b", review_result: "issues" })}\n`;
  const data = parseMetadata(body);
  assert.equal(data?.review_result, "issues");
  assert.deepEqual(carriedVerdict(body), { verdict: "request_changes", verdictSource: "carry_forward" });
  assert.deepEqual(carriedVerdict(`x\n${buildMetadataMarker({ review_result: "clean" })}`), {
    verdict: "approve",
    verdictSource: "carry_forward",
  });
  assert.equal(carriedVerdict("no marker"), null);
  assert.equal(carriedVerdict("<!-- ai-pr-reviewer:not json -->"), null);
});

// ── Linked issues and Linear identification ─────────────────────────────

test("linked issue refs extract, dedupe, and cap", () => {
  const refs = extractLinkedIssueRefs("Fixes #1, closes other/repo#2, fixes #1, RESOLVES: #3", "o/r");
  assert.deepEqual(refs.map((ref) => ref.ref), ["#1", "other/repo#2", "#3"]);
  assert.equal(extractLinkedIssueRefs("Fixes #1", "o/r")[0]!.repo, "o/r");
  assert.deepEqual(labelsOf({ labels: [{ name: " b " }, "c", {}, { name: "" }] }), ["b", "c"]);
  assert.deepEqual(labelsOf({ labels: [] }), []);
});

test("linear prefixes and identifiers parse conservatively", () => {
  assert.deepEqual(parsePrefixes("eng, Ops, ENG"), ["ENG", "OPS"]);
  assert.throws(() => parsePrefixes("1bad"), /invalid Linear issue prefix/);
  assert.deepEqual(extractIssueIdentifiers("Fix ENG-42 and ENG-7, not GEN-42", ["ENG"]), ["ENG-42", "ENG-7"]);
  assert.deepEqual(extractIssueIdentifiers("xENG-42", ["ENG"]), [], "identifiers must be token-bounded");
});

// ── Selection signature (#633) ──────────────────────────────────────────

test("selection signature serialization matches the v2 Python hash byte for byte", async () => {
  // The expected hash below was produced by the v2 implementation
  // (scripts/build_selection_fingerprint.py) over the same inputs; the
  // parity harness re-proves it end to end via the precheck boundary.
  const fixture: PrecheckFixture = JSON.parse(
    readFileSync("tests/fixtures/parity/precheck/auto-linear-unchanged-skip.json", "utf8"),
  );
  const adapter = new FixtureAdapter("github", fixture.platform);
  const { signature, error } = await buildSelectionSignature("misospace/demo", "42", adapter, {
    linearIssuePrefixes: fixture.env.LINEAR_ISSUE_PREFIXES,
    linearApiKey: fixture.env.LINEAR_API_KEY,
    linearCollect: fixtureLinearCollector(fixture.platform),
  });
  assert.equal(error, "");
  assert.equal(
    signature,
    "sha256:c1690cdf18fbb7c8801ca35349f612a4d563106adc6c3d1892b8800a42ce066b",
  );
  assert.equal(pythonJsonStringify({ b: 1, a: [true, null, "x\"y\n"] }), '{"a": [true, null, "x\\"y\\n"], "b": 1}');
});

test("selection signature fails conservatively on unknown inputs", async () => {
  const failing: PrecheckFixture = {
    env: {},
    platform: {
      gh_api: {
        "repos/o/r/pulls/1": { title: "t", body: "Fixes #2" },
        "repos/o/r/issues/2": { error: "GitHub API error: 500" },
      },
    },
  };
  const adapter = new FixtureAdapter("github", failing.platform);
  const { signature, error } = await buildSelectionSignature("o/r", "1", adapter);
  assert.equal(signature, null);
  assert.match(error, /linked issue #2 fetch failed/);
});

// ── Managed body selection ───────────────────────────────────────────────

test("last managed body reads reviews in review_verdict mode, comments otherwise", () => {
  const comments = [
    { body: "old <!-- ai-pr-reviewer -->", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
    { body: "new <!-- ai-pr-reviewer -->", created_at: "2024-01-03T00:00:00Z", updated_at: "2024-01-03T00:00:00Z" },
  ];
  const reviews = [{ body: "review <!-- ai-pr-reviewer -->", submitted_at: "2024-01-02T00:00:00Z" }];
  assert.match(lastManagedBody(comments, reviews, "comment", "<!-- ai-pr-reviewer -->"), /^new /);
  assert.match(lastManagedBody(comments, reviews, "review_verdict", "<!-- ai-pr-reviewer -->"), /^review /);
});

// ── Orchestration through the fixture adapter ────────────────────────────

function fixture(name: string): PrecheckFixture {
  return JSON.parse(readFileSync(`tests/fixtures/parity/precheck/${name}.json`, "utf8"));
}

test("runPrecheck reproduces the label no-op and superseded guard", async () => {
  const noop = await runPrecheck({
    env: fixture("unrelated-label-noop").env,
    adapter: new FixtureAdapter("github", fixture("unrelated-label-noop").platform),
    event: fixture("unrelated-label-noop").event ?? undefined,
  });
  assert.equal(noop.should_review, "false");
  assert.equal(noop.skip_reason, "unrelated-label");
  assert.equal(noop.head_sha, "");

  const superseded = await runPrecheck({
    env: fixture("superseded-head").env,
    adapter: new FixtureAdapter("github", fixture("superseded-head").platform),
    eventHeadSha: fixture("superseded-head").event_head_sha,
  });
  assert.equal(superseded.should_review, "false");
  assert.equal(superseded.skip_reason, "superseded-head");
  assert.equal(superseded.head_sha, "head-abc");
  assert.equal(superseded.is_fork_pr, "false");
});

test("runPrecheck carries the prior verdict forward on a diff-unchanged skip", async () => {
  const fx = fixture("unchanged-diff-skip-issues");
  const output = await runPrecheck({
    env: fx.env,
    adapter: new FixtureAdapter("github", fx.platform),
  });
  assert.equal(output.should_review, "false");
  assert.equal(output.skip_reason, "diff-unchanged");
  assert.equal(output.verdict, "request_changes");
  assert.equal(output.verdict_source, "carry_forward");
});

test("runPrecheck refuses Forgejo publish paths conservatively", async () => {
  const refusing = fixture("forgejo-permission-unknown-refuses");
  await assert.rejects(
    runPrecheck({ env: refusing.env, adapter: new FixtureAdapter("forgejo", refusing.platform) }),
    /Could not determine Forgejo permission/,
  );
  const denied = fixture("forgejo-permission-denied");
  await assert.rejects(
    runPrecheck({ env: denied.env, adapter: new FixtureAdapter("forgejo", denied.platform) }),
    /lacks Forgejo write permission/,
  );
});
