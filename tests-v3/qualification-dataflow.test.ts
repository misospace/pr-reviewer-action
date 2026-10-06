/** #681 semantic-gate production dataflow checks, ported from the v2
 * integration tests `scripts/run_semantic_eval_ci.py` `run_dataflow_checks()`
 * used to shell out to, onto the v3 runtime seams. One test group per named
 * check; the gate runs each group with `--test-name-pattern`, so the group's
 * own name (the string literal prefixing every test in it) IS the check's
 * production contract — do not rename a group without updating
 * `scripts/run_semantic_eval_ci.py` in the same commit. */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyPr, classificationToArtifact } from "../src/classification/classify.js";
import { classificationFromArtifact, selectSpecialistRoles } from "../src/classification/role-selection.js";
import { canonicalChangedFile, normalizeLinkedIssues } from "../src/context/index.js";
import { buildLinkedIssueContext } from "../src/context/linked-issue-context.js";
import { resolveReviewRoute } from "../src/routing/tiers.js";
import { runPrecheck } from "../src/precheck/decide.js";
import type { PlatformAdapter } from "../src/platform/types.js";
import type { ReadResult } from "../src/platform/types.js";
import { CROSS_STEP_TRACE_GUIDANCE } from "../src/prompt/system-prompt.js";
import { buildReviewCorpus, truncateClean, type CorpusWorkspace } from "../src/corpus/index.js";
import { readFileSync } from "node:fs";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const dec = (data: Uint8Array | undefined): string => Buffer.from(data ?? new Uint8Array(0)).toString("utf8");
const noLinear = { apiKey: "", prefixes: "", timeoutSec: "20", enableForForks: "false" };
// ── github-label-routing (#633) ───────────────────────────────────────────
// v2 subject: tests/test_linked_issue_classification.sh. The linked-issue
// context pipeline must enrich the canonical linked-issues.json with fetched
// GitHub labels so classify.ts (which reads that value) emits the linked
// risk flags and deep_review=auto role selection sees them — never a
// helper-only echo of the right answer.

test("github-label-routing: fetched labels reach linked-issues, risk flags and role selection", async () => {
  const issues: Record<string, unknown> = {
    "12": { number: 12, labels: [{ name: "security" }] },
    "13": { number: 13, labels: [{ name: "priority/p0" }] },
    "14": { number: 14, labels: [] },
  };
  const getIssue = async (_repo: string, number: string): Promise<ReadResult<unknown>> =>
    issues[number] ? { ok: true, data: issues[number] } : { ok: false, error: `no #${number}` };
  const linked = await buildLinkedIssueContext({
    pr: { body: "Fixes #12. Closes #13. Resolves #14" },
    repo: "o/r",
    adapter: { getIssue },
    isForkPr: "false",
    linear: noLinear,
  });
  assert.deepEqual(linked.linkedIssues.map((item) => (item as { ref: string }).ref), ["#12", "#13", "#14"]);
  assert.deepEqual((linked.linkedIssues[0] as { labels: unknown }).labels, [{ name: "security" }]);
  assert.deepEqual((linked.linkedIssues[2] as { labels: unknown }).labels, []);

  const normalized = normalizeLinkedIssues(linked.linkedIssues, "o/r");
  const classification = classifyPr({ prFiles: [], linkedIssues: normalized });
  assert.ok(classification.riskFlags.includes("linked_security_issue"));
  assert.ok(classification.riskFlags.includes("linked_priority_p0"));

  const selection = selectSpecialistRoles(classification);
  assert.deepEqual(selection.selectedRoles, ["correctness", "security"]);

  const artifact = JSON.parse(JSON.stringify(classificationToArtifact(classification))) as Record<string, unknown>;
  const rebuilt = classificationFromArtifact(artifact);
  assert.ok(rebuilt !== null);
  assert.deepEqual(rebuilt.riskFlags, classification.riskFlags);
  assert.deepEqual(rebuilt.routeSignals, classification.routeSignals);
  assert.deepEqual(selectSpecialistRoles(rebuilt).selectedRoles, ["correctness", "security"]);

  // Linked metadata changes classification and specialist selection, never
  // the primary-first model route.
  assert.deepEqual(resolveReviewRoute({ routingMode: "auto" }), {
    route: "primary",
    reason: "primary-first: the primary reviews first; smart is reviewer-requested only (#721)",
  });
  const bare = normalized.map((item) => ({ ...item, labels: [] }));
  const bareClassification = classifyPr({ prFiles: [], linkedIssues: bare });
  assert.ok(!bareClassification.riskFlags.includes("linked_security_issue"));
  assert.ok(!bareClassification.riskFlags.includes("linked_priority_p0"));
  assert.deepEqual(selectSpecialistRoles(bareClassification).selectedRoles, ["correctness"]);
});

test("github-label-routing: a failed GitHub fetch is fail-soft data but fails selection toward scrutiny", async () => {
  const linked = await buildLinkedIssueContext({
    pr: { body: "Fixes #12" },
    repo: "o/r",
    adapter: { getIssue: async () => ({ ok: false, error: "platform failure" }) },
    isForkPr: "false",
    linear: noLinear,
  });
  assert.deepEqual(linked.githubFetchFailures, ["#12"]);

  const docsOnly = [canonicalChangedFile({ filename: "docs/readme.md" })];
  const classification = classifyPr({
    prFiles: docsOnly,
    linkedIssues: normalizeLinkedIssues(linked.linkedIssues, "o/r"),
    metadataStatus: {
      github_fetch_failures: linked.githubFetchFailures,
      linear_fetch_failures: linked.linearFetchFailures,
      linear_known_disabled: linked.linearKnownDisabled,
    },
  });
  assert.equal(classification.linkedMetadataUncertain, true);
  assert.deepEqual(classification.linkedMetadataUncertainty, ["github linked issue #12 fetch failed"]);
  // A fresh review on a docs-only PR with a failed fetch runs ALL roles,
  // never zero: uncertainty defeats the trivial-path gate.
  assert.deepEqual(selectSpecialistRoles(classification).selectedRoles, ["correctness", "security", "tests"]);
});

test("github-label-routing: a failed Linear identifier lookup also forces all roles, never zero", async () => {
  const linear503: typeof noLinear & { fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response> } = {
    apiKey: "lin-key",
    prefixes: "OPS",
    timeoutSec: "20",
    enableForForks: "false",
    fetchImpl: async () => new Response("", { status: 503 }),
  };
  const linked = await buildLinkedIssueContext({
    pr: { title: "OPS-42: tidy the docs", body: "" },
    repo: "o/r",
    adapter: { getIssue: async () => ({ ok: false, error: "boom" }) },
    isForkPr: "false",
    linear: linear503,
  });
  assert.deepEqual(linked.linearFetchFailures, ["OPS-42"]);

  const docsOnly = [canonicalChangedFile({ filename: "docs/readme.md" })];
  const classification = classifyPr({
    prFiles: docsOnly,
    linkedIssues: normalizeLinkedIssues(linked.linkedIssues, "o/r"),
    metadataStatus: {
      github_fetch_failures: linked.githubFetchFailures,
      linear_fetch_failures: linked.linearFetchFailures,
      linear_known_disabled: linked.linearKnownDisabled,
    },
  });
  assert.equal(classification.linkedMetadataUncertain, true);
  assert.deepEqual(selectSpecialistRoles(classification).selectedRoles, ["correctness", "security", "tests"]);
});

test("github-label-routing: fork-gated Linear is known-disabled, not uncertainty, so the trivial gate can still fire", async () => {
  const linked = await buildLinkedIssueContext({
    pr: { title: "OPS-42", body: "Resolves #14" },
    repo: "o/r",
    adapter: { getIssue: async () => ({ ok: true, data: { number: 14, labels: [] } }) },
    isForkPr: "true",
    linear: { apiKey: "lin-key", prefixes: "OPS", timeoutSec: "20", enableForForks: "false" },
  });
  assert.equal(linked.linearKnownDisabled, true);
  assert.deepEqual(linked.linearFetchFailures, []);

  const docsOnly = [canonicalChangedFile({ filename: "docs/readme.md" })];
  const classification = classifyPr({
    prFiles: docsOnly,
    linkedIssues: normalizeLinkedIssues(linked.linkedIssues, "o/r"),
    metadataStatus: {
      github_fetch_failures: linked.githubFetchFailures,
      linear_fetch_failures: linked.linearFetchFailures,
      linear_known_disabled: linked.linearKnownDisabled,
    },
  });
  assert.equal(classification.linkedMetadataUncertain, false);
  // A docs-only PR with every fetch healthy (Linear included, even though
  // gated) still selects zero roles.
  assert.deepEqual(selectSpecialistRoles(classification).selectedRoles, []);
});

test("github-label-routing: Linear merging composes with the GitHub-enriched labels in the same canonical value", async () => {
  const linearOk = {
    apiKey: "lin-key",
    prefixes: "OPS",
    timeoutSec: "20",
    enableForForks: "false",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: { issue: { identifier: "OPS-42", priority: 2, labels: { nodes: [{ name: "priority/p1" }] }, state: { name: "open" } } },
        }),
        { status: 200 },
      ),
  };
  const linked = await buildLinkedIssueContext({
    pr: { title: "OPS-42: fix the thing", body: "Fixes #12" },
    repo: "o/r",
    adapter: { getIssue: async () => ({ ok: true, data: { number: 12, labels: [{ name: "security" }] } }) },
    isForkPr: "false",
    linear: linearOk,
  });
  const normalized = normalizeLinkedIssues(linked.linkedIssues, "o/r");
  const github = normalized.find((item) => item.ref === "#12");
  const linear = normalized.find((item) => item.ref === "OPS-42");
  assert.deepEqual(github?.labels, [{ name: "security" }]);
  assert.deepEqual(linear?.labels, [{ name: "priority/p1" }]);
  const classification = classifyPr({ prFiles: [], linkedIssues: normalized });
  assert.ok(classification.riskFlags.includes("linked_security_issue"));
  assert.ok(classification.riskFlags.includes("linked_priority_p1"));
});

// ── linear-composite-precheck (#633) ──────────────────────────────────────
// v2 subject: tests/test_precheck_linear_fingerprint.sh. The REAL precheck
// path (runPrecheck, the same entry the action's stage-env projection binds
// LINEAR_API_KEY onto — src/run/action.ts) must be able to fetch the Linear
// state that drives auto role selection, folding it into the broad
// fingerprint: a Linear priority/label change re-reviews, an unavailable
// Linear lookup forces a fresh review, fork PRs never query Linear unless
// opted in, and non-auto modes never invoke the builder at all.

interface LinearState { priority: number; label: string; fail: boolean; calls: string[] }

function fakeLinearCollect(state: LinearState) {
  return async (title: string, prefixes: string[], apiKey: string) => {
    const { extractIssueIdentifiers } = await import("../src/precheck/linear.js");
    const identifiers = extractIssueIdentifiers(title, prefixes);
    state.calls.push(apiKey);
    if (state.fail) {
      return { issues: [], errors: identifiers.map((id) => [id, "Linear HTTP error 503"] as [string, string]) };
    }
    return {
      issues: identifiers.map((id) => ({
        source: "linear" as const,
        ref: id,
        repo: "",
        number: 0,
        title: "t",
        body: "",
        url: "",
        state: "open",
        priority: state.priority,
        priorityLabel: "",
        labels: [{ name: state.label }],
      })),
      errors: [],
    };
  };
}

function precheckAdapter(opts: {
  headRepo: string;
  baseRepo: string;
  title?: string;
  body?: string;
  comments: { body: string; created_at: string; updated_at: string }[];
}): PlatformAdapter {
  const prObject = {
    state: "open",
    draft: false,
    title: opts.title ?? "OPS-42: fix the thing",
    body: opts.body ?? "Fixes #12",
    head: { sha: "a".repeat(40), repo: { full_name: opts.headRepo } },
    base: { sha: "b".repeat(40), repo: { full_name: opts.baseRepo } },
  };
  return {
    platform: "github",
    getPr: async () => prObject,
    getPrDiff: async () => "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n+new\n",
    listIssueComments: async () => opts.comments,
    listPrReviews: async () => [],
    repoPermission: async () => "write",
    ghApi: async (endpoint: string) => {
      if (endpoint.endsWith("/pulls/7")) return { data: prObject };
      if (endpoint.endsWith("/issues/12")) return { data: { number: 12, labels: [{ name: "security" }] } };
      return { error: `unexpected fixture path: ${endpoint}` };
    },
  };
}

const REPO = "misospace/pr-reviewer-action";

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    REPO,
    PR_NUMBER: "7",
    PLATFORM: "github",
    GITHUB_SERVER_URL: "https://github.com",
    DEEP_REVIEW: "auto",
    LINEAR_API_KEY: "lin-secret-key",
    LINEAR_ISSUE_PREFIXES: "OPS",
    LINEAR_ISSUE_TIMEOUT_SEC: "5",
    LINEAR_ENABLE_FOR_FORKS: "false",
    ...overrides,
  };
}

test("linear-composite-precheck: healthy Linear fetches with the step-bound key and folds into the fingerprint", async () => {
  const state: LinearState = { priority: 2, label: "bug", fail: false, calls: [] };
  const output = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: [] }),
    linearCollect: fakeLinearCollect(state),
  });
  assert.equal(output.should_review, "true");
  assert.ok(output.diff_fingerprint.length > 0);
  assert.deepEqual(state.calls, ["lin-secret-key"]);
});

test("linear-composite-precheck: identical inputs with the stored marker skip (baseline)", async () => {
  const state: LinearState = { priority: 2, label: "bug", fail: false, calls: [] };
  const run1 = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: [] }),
    linearCollect: fakeLinearCollect(state),
  });
  const marker = [{
    body: `<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:${run1.diff_fingerprint} -->`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }];
  const run2 = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: marker }),
    linearCollect: fakeLinearCollect({ ...state, calls: [] }),
  });
  assert.equal(run2.should_review, "false");

  // A Linear priority OR label change alone changes the fingerprint and
  // forces a fresh review, exactly like the diff fingerprint would.
  const priorityChanged = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: marker }),
    linearCollect: fakeLinearCollect({ priority: 1, label: "bug", fail: false, calls: [] }),
  });
  assert.equal(priorityChanged.should_review, "true");
  const labelChanged = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: marker }),
    linearCollect: fakeLinearCollect({ priority: 2, label: "security", fail: false, calls: [] }),
  });
  assert.equal(labelChanged.should_review, "true");
});

test("linear-composite-precheck: an unavailable Linear lookup forces a fresh review even against a matching marker", async () => {
  const state: LinearState = { priority: 2, label: "bug", fail: false, calls: [] };
  const run1 = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: [] }),
    linearCollect: fakeLinearCollect(state),
  });
  const marker = [{
    body: `<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:${run1.diff_fingerprint} -->`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let warned = "";
  process.stderr.write = ((chunk: unknown) => { warned += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const failed = await runPrecheck({
      env: baseEnv(),
      adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: marker }),
      linearCollect: fakeLinearCollect({ priority: 2, label: "bug", fail: true, calls: [] }),
    });
    assert.equal(failed.should_review, "true");
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.match(warned, /could not determine every selection input/);
});

test("linear-composite-precheck: a fork PR never queries Linear unless opted in, and still reviews", async () => {
  const state: LinearState = { priority: 2, label: "bug", fail: false, calls: [] };
  const output = await runPrecheck({
    env: baseEnv(),
    adapter: precheckAdapter({ headRepo: "someone/other", baseRepo: REPO, comments: [] }),
    linearCollect: fakeLinearCollect(state),
  });
  assert.deepEqual(state.calls, []);
  assert.equal(output.should_review, "true");
});

test("linear-composite-precheck: non-auto modes never invoke the Linear builder, and marker round-trips unchanged", async () => {
  const state: LinearState = { priority: 2, label: "bug", fail: false, calls: [] };
  const run1 = await runPrecheck({
    env: baseEnv({ DEEP_REVIEW: "false" }),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: [] }),
    linearCollect: fakeLinearCollect(state),
  });
  assert.equal(run1.should_review, "true");
  const marker = [{
    body: `<!-- ai-pr-reviewer -->\n<!-- ai-pr-review-fingerprint:${run1.diff_fingerprint} -->`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }];
  const run2 = await runPrecheck({
    env: baseEnv({ DEEP_REVIEW: "false" }),
    adapter: precheckAdapter({ headRepo: REPO, baseRepo: REPO, comments: marker }),
    linearCollect: fakeLinearCollect({ priority: 2, label: "bug", fail: false, calls: [] }),
  });
  assert.equal(run2.should_review, "false");
  assert.deepEqual(state.calls, []);
});

test("linear-composite-precheck: the action entry binds the Linear key onto the precheck stage before running it", () => {
  const source = readFileSync("src/run/action.ts", "utf8");
  assert.ok(source.includes("const stage: Env = { ...env, ...stageEnvFromConfig(config) };"));
  assert.ok(source.includes('stage.LINEAR_API_KEY_CONFIGURED = stage.LINEAR_API_KEY ? "true" : "false";'));
  assert.ok(source.indexOf("actionStageEnv(env)") < source.indexOf("await runPrecheck("));
  assert.ok(source.includes("env: stage as Record<string, string>"));
});

// ── corpus-evidence-and-broken-arrow (#662) ───────────────────────────────
// v2 subject: tests/test_issue_662_dataflow.py's corpus-assembly-wiring
// tests, which read scripts/sections/{corpus,config,gating}.sh text — no v3
// meaning, since that assembly is now buildReviewCorpus/truncateClean and
// the CI-checks binding lives in src/run/{action,review}.ts. The
// scenario-family assertions in that file (6551/6552/6553/6891/6892 via
// pr_reviewer.semantic_eval) stay Python: they qualify the semantic judge
// against the historical corpus, not v2/v3 production wiring, and
// scripts/run_semantic_eval_ci.py's own DETERMINISTIC_SCENARIOS loop already
// evaluates them every gate run.

function baseWorkspace(): CorpusWorkspace {
  return {
    manifestContextMd: null,
    prJson: enc(JSON.stringify({ number: 689, title: "Node 24" })),
    classificationJson: enc(JSON.stringify({ pr_kind: "app_code", risk_flags: [], changed_files_summary: [], linked_issue_labels: [], must_check: [] })),
    relatedCodeTruncatedMd: null,
    repoMapMd: null,
    prThreadMd: null,
    reviewThreadsMd: null,
    humanReviewsMd: null,
    linkedIssuesMd: null,
    ciChecksContent: enc("Node 24 typecheck, tests, build and freshness: success on 9c7a5f8cc2bacefa13f38e00056d84f04db054b4\n"),
    versionHintsTruncatedTxt: null,
    toolHarnessMd: null,
    toolHarnessSmartMd: null,
    evidenceProvidersMd: null,
    imageDigestContextMd: null,
    linkedSourcesMd: null,
    repoImpactTruncatedMd: null,
    repoHistoryTruncatedMd: null,
    prDiff: enc("X".repeat(12000)),
    prFilesJson: enc("[]"),
    prDiffTruncated: enc("X".repeat(12000)),
    prFilesTruncatedJson: enc("[]"),
    standardsContextMd: enc("Standards available\n"),
    requirementLedgerMd: enc("- Node 24 and malformed versions checked by tests-v3/config.test.ts\n"),
    specialistsMd: null,
    requirementLedgerPresent: enc("1\n"),
    specialistLeadsPresent: null,
    standardsFileContent: null,
  };
}

test("corpus-evidence-and-broken-arrow: the real corpus assembler keeps exact-head evidence, never a second budget implementation", () => {
  const result = buildReviewCorpus(baseWorkspace(), {
    tier: "primary",
    slot: "primary",
    maxCorpus: 4500,
    diffBudget: 4500,
    filesBudget: 4500,
    repoMapMaxBytes: 4500,
    standardsFile: "AGENTS.md",
    ciChecksFile: "ci.md",
    budgetGuard: true,
  });
  assert.equal(result.overBudget, false);
  const assembled = dec(result.artifacts.get(result.outputName));
  assert.ok(Buffer.byteLength(assembled) <= 4500);
  assert.match(assembled, /# CI Check Results/);
  assert.match(assembled, /Node 24 typecheck, tests, build and freshness: success/);
  assert.match(assembled, /# Explicit Requirement Ledger/);
  assert.equal(dec(result.artifacts.get("requirement-ledger.section.md")).length > 0, true);
  assert.ok(assembled.includes(dec(result.artifacts.get("requirement-ledger.section.md"))));
});

test("corpus-evidence-and-broken-arrow: truncateClean degrades to a measured marker, never an oversized suffix", () => {
  const oversized = enc("many bytes\n".repeat(10));
  const out = truncateClean(oversized, 3, "oversized marker");
  assert.deepEqual(out, enc("..."));
  // The pre-fix branch this regresses: writing a full marker regardless of
  // budget produces an output larger than the requested cap.
  const vulnerable = (src: Uint8Array, maxBytes: number, marker: string): Uint8Array => enc(marker).length <= maxBytes
    ? enc(marker)
    : enc(marker); // the pre-fix implementation ignored the budget entirely
  const brokenOutput = vulnerable(oversized, 3, "oversized marker");
  assert.ok(brokenOutput.length > 3, "the counterexample must actually violate the budget to be a real regression guard");
  assert.ok(out.length <= 3);
});

test("corpus-evidence-and-broken-arrow: missing CI evidence is not proof of failure, but a reproduced violation still fires", () => {
  assert.match(CROSS_STEP_TRACE_GUIDANCE, /A test or CI result absent from a truncated corpus is not evidence/);
  assert.match(CROSS_STEP_TRACE_GUIDANCE, /Trace producer -> persisted representation -> transport\/environment -> consumer -> decision/);

  // The action step feeds the assembler the same CI_CHECKS_FILE it binds in
  // stage env (a green-looking scratch file under another name is the
  // broken-arrow class this check exists to catch).
  const actionEntry = readFileSync("src/run/action.ts", "utf8");
  assert.ok(actionEntry.includes("const temp = env.RUNNER_TEMP"));
  assert.ok(actionEntry.includes('stage.CI_CHECKS_FILE = join(temp, "ci-checks-context.md");'));

  const assembleSource = readFileSync("src/corpus/assemble.ts", "utf8");
  assert.ok(assembleSource.includes('pushSection("# CI Check Results", bytes(ws.ciChecksContent));'));

  // A run with no CI content at all omits the section rather than fabricate
  // one — the assembler's absence-is-not-evidence contract.
  const noCi = buildReviewCorpus({ ...baseWorkspace(), ciChecksContent: null }, {
    tier: "primary", slot: "primary", maxCorpus: 220000, diffBudget: 140000, filesBudget: 70000,
    repoMapMaxBytes: 12000, standardsFile: "AGENTS.md", ciChecksFile: "ci.md", budgetGuard: false,
  });
  assert.doesNotMatch(dec(noCi.artifacts.get(noCi.outputName)), /# CI Check Results/);
});

// ── path-classification-untrusted-surface (#749) ─────────────────────────
// v2 subject: tests/test_issue_749_path_classification.py, which pinned the
// PR #748 false-positive class against classify_from_files' on-disk
// classification.json. tests-v3/classification.test.ts already carries the
// full #749 signal-model suite (in-memory classifyPr) — this group instead
// covers the two things that suite does not: the persisted-artifact round
// trip (the disk artifact must carry the identical verdict as the in-memory
// result) and the downstream role-selection wiring the dataflow gate exists
// to protect.

test("path-classification-untrusted-surface: trusted repo-root scaffolding never reaches the persisted artifact or role selection", () => {
  const prFiles = [
    canonicalChangedFile({ filename: "scripts/fork_review_gate.py" }),
    canonicalChangedFile({ filename: "tests/test_fork_review_gate.py" }),
  ];
  const diff = [
    "+from pathlib import Path",
    "+",
    "+_ROOT = Path(__file__).resolve().parent.parent",
    "+REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))",
    "+sys.path.insert(0, str(_ROOT))",
  ].join("\n");
  const result = classifyPr({ prFiles, diffText: diff, linkedIssues: [] });
  assert.notEqual(result.prKind, "path_handling_changes");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
  assert.ok(!result.mustCheck.some((c) => c.includes("path traversal")));
  assert.ok(!result.mustCheck.some((c) => c.includes("edge-case paths")));
  assert.equal(result.pathHandlingProvenance.fired, false);

  const artifact = JSON.parse(JSON.stringify(classificationToArtifact(result))) as Record<string, unknown>;
  assert.equal(artifact.pr_kind, result.prKind);
  assert.deepEqual(artifact.path_handling_provenance, result.pathHandlingProvenance);
  const rebuilt = classificationFromArtifact(artifact);
  assert.ok(rebuilt !== null);
  assert.equal(rebuilt.prKind, result.prKind);
  // The zero-selection gate is not defeated by an untouched, non-code diff.
  const docsOnly = classifyPr({ prFiles: [canonicalChangedFile({ filename: "docs/guide.md" })], linkedIssues: [] });
  assert.deepEqual(selectSpecialistRoles(docsOnly).selectedRoles, []);
});

test("path-classification-untrusted-surface: genuine attacker-controlled path flow still fires the artifact and the security lane", () => {
  const result = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "src/upload.py" })],
    diffText: "+dest = os.path.join(UPLOAD_DIR, request.args['name'])\n",
    linkedIssues: [],
  });
  assert.equal(result.prKind, "path_handling_changes");
  assert.ok(result.riskFlags.includes("path_handling_changes"));
  assert.ok(result.mustCheck.some((c) => c.includes("path traversal")));
  assert.equal(result.pathHandlingProvenance.fired, true);
  assert.ok(result.pathHandlingProvenance.signals.some((s) => s.signal === "untrusted_source_join"));

  const artifact = JSON.parse(JSON.stringify(classificationToArtifact(result))) as Record<string, unknown>;
  assert.equal(artifact.pr_kind, "path_handling_changes");
  const rebuilt = classificationFromArtifact(artifact);
  assert.ok(rebuilt !== null);
  assert.deepEqual(selectSpecialistRoles(rebuilt).selectedRoles, selectSpecialistRoles(result).selectedRoles);
  assert.ok(selectSpecialistRoles(result).selectedRoles.includes("security"));
});

test("path-classification-untrusted-surface: #871 a content-only file_serving/path_handling match on a substantial new module does not skip correctness", () => {
  // Reproduces #854's shape: a new network client (src/platform/*.ts, no
  // filesystem access) whose content mentions URL paths/URIs — content-only
  // FILE_SERVING_PATTERNS and path_reference_identifier (`.pathname`)
  // matches, no changed filename backing either. On #854 this became
  // pr_kind=file_serving_changes, filled must_check with path-traversal
  // items, and the correctness specialist was skipped (only security ran).
  const prFiles = [
    canonicalChangedFile({
      filename: "src/platform/tangled-bobbin.ts",
      status: "added",
      additions: 409,
      deletions: 0,
    }),
    canonicalChangedFile({
      filename: "tests-v3/tangled-bobbin.test.ts",
      status: "added",
      additions: 462,
      deletions: 0,
    }),
  ];
  const diff = [
    "diff --git a/src/platform/tangled-bobbin.ts b/src/platform/tangled-bobbin.ts",
    "+++ b/src/platform/tangled-bobbin.ts",
    "+    const pathname = base.pathname.replace(/\\/+$/, \"\") + \"/xrpc/\" + nsid;",
    "+    const url = new URL(pathname, base);",
  ].join("\n");
  const result = classifyPr({ prFiles, diffText: diff, linkedIssues: [] });

  // The content-only match is too weak to route on (#159/#749) and, as of
  // #871, too weak to set pr_kind or inject its must_check items too.
  assert.notEqual(result.prKind, "file_serving_changes");
  assert.equal(result.riskFlagsWithFiles["file_serving_changes"]?.length ?? 0, 0);
  assert.ok(!result.mustCheck.some((c) => c.includes("directory traversal")));
  assert.ok(!result.mustCheck.some((c) => c.includes("file path sanitization")));

  // #871 follow-up: `.pathname` is a WHATWG URL component here (the file
  // never touches a filesystem/path-construction API), not a real
  // untrusted-path surface — path_handling_changes must not fire either.
  assert.notEqual(result.prKind, "path_handling_changes");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
  assert.equal(result.pathHandlingProvenance.fired, false);
  assert.equal(result.prKind, "app_code");

  // The correctness specialist is not skipped on a substantial PR just
  // because a weak content-only signal happened to pick a non-correctness
  // pr_kind.
  const selection = selectSpecialistRoles(result);
  assert.ok(selection.selectedRoles.includes("correctness"));
});
