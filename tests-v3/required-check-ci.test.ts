import test from "node:test";
import assert from "node:assert/strict";
import {
  ciCheckIdentity,
  ciDischargeForCheckText,
  isTestExecutionCheckName,
  isTestExecutionObligation,
  parseHeadBoundCiEvidence,
  parseHeadBoundCiEvidenceValue,
  reconcileObligationsWithCiEvidence,
  reconcileRequiredCheckRows,
  type CiEvidenceCheck,
  type HeadBoundCiEvidence,
} from "../src/enforcement/required-check-ci.js";
import { evaluateRequiredCheckCoverage, type RequiredCheckRow } from "../src/enforcement/required-checks.js";
import { reviewObligationsFromArtifact, reviewObligationsToArtifact, type ReviewObligation } from "../src/enforcement/review-obligations.js";
import type { NormalizedRequiredCheckDisposition } from "../src/model/types.js";
import type { TrustedCiJobs, TrustedCiTestScope } from "../src/config/ci-test-jobs.js";
import { normalizeExternalChecks } from "../src/platform/normalize.js";
import { renderCiEvidenceOutput } from "../src/gates/ci-wait.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const STALE = "aabbccddeeff00112233445566778899aabbccdd";

function evidence(finalState: HeadBoundCiEvidence["finalState"], checks: Array<Omit<CiEvidenceCheck, "conclusion"> & { conclusion?: string | null }>, headSha = HEAD): HeadBoundCiEvidence {
  return { headSha, finalState, checks: checks.map((check) => ({ ...check, conclusion: check.conclusion ?? null })) };
}

function configuredJobs(jobs: [string, TrustedCiTestScope][], workflowSurfaceTrusted = true, identitiesRefused = false): TrustedCiJobs {
  return { jobs: new Map(jobs), identitiesRefused, workflowSurfaceTrusted };
}

function actionsEvidence(finalState: HeadBoundCiEvidence["finalState"], checks: Array<Omit<CiEvidenceCheck, "conclusion" | "origin"> & { conclusion?: string | null }>, headSha = HEAD): HeadBoundCiEvidence {
  return evidence(finalState, checks.map((check) => ({ ...check, origin: "actions" })) as Array<Omit<CiEvidenceCheck, "conclusion"> & { conclusion?: string | null }>, headSha);
}

function d(check: string, status: string, rationale?: string | null): NormalizedRequiredCheckDisposition {
  return { check, status: status as NormalizedRequiredCheckDisposition["status"], rationale: rationale ?? null };
}

test("#1594 parse: strict artifact value — every deviation fails closed to null", () => {
  const good = { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "test (24)", state: "success", conclusion: "success" }] };
  assert.deepEqual(parseHeadBoundCiEvidenceValue(good), {
    headSha: HEAD,
    finalState: "success",
    checks: [{ name: "test (24)", state: "success", conclusion: "success" }],
  });
  // optional conclusion may be absent or null
  assert.deepEqual(parseHeadBoundCiEvidenceValue({ version: 1, head_sha: HEAD, final_state: "none", checks: [{ name: "t", state: "pending" }] }), {
    headSha: HEAD, finalState: "none", checks: [{ name: "t", state: "pending", conclusion: null }],
  });
  assert.notEqual(parseHeadBoundCiEvidenceValue({ version: 1, head_sha: HEAD, final_state: "none", checks: [{ name: "t", state: "success", conclusion: null }] }), null);

  const rejects: unknown[] = [
    null,
    "string",
    [],
    { ...good, version: 2 },
    { ...good, head_sha: "not-a-sha" },
    { ...good, head_sha: "abc" },
    { ...good, head_sha: "g".repeat(40) },
    { ...good, final_state: "ok" },
    { ...good, injected: "extra key" },
    { ...good, checks: Array.from({ length: 51 }, (_, i) => ({ name: `test-${i}`, state: "success" })) },
    { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "x".repeat(201), state: "success" }] },
    { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "", state: "success" }] },
    { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "t", state: "queued" }] },
    { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "t", state: "success", conclusion: "x".repeat(201) }] },
    { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "t", state: "success", smuggled: true }] },
    { version: 1, head_sha: HEAD, final_state: "success", checks: {} },
  ];
  for (const value of rejects) assert.equal(parseHeadBoundCiEvidenceValue(value), null, JSON.stringify(value));
});

test("#1594 parse: raw line parser caps bytes before JSON.parse and tolerates junk", () => {
  assert.equal(parseHeadBoundCiEvidence(null), null);
  assert.equal(parseHeadBoundCiEvidence(""), null);
  assert.equal(parseHeadBoundCiEvidence(undefined), null);
  assert.equal(parseHeadBoundCiEvidence("{not json"), null);
  assert.equal(parseHeadBoundCiEvidence("x".repeat(16385)), null, "oversized raw input is refused before parsing");
  assert.notEqual(parseHeadBoundCiEvidence('{"version":1,"head_sha":"abc1234","final_state":"none","checks":[{"name":"t","state":"success"}]}'), null);
});

test("#1594 matcher: obligation text needs a test word AND an execution verb", () => {
  const yes = [
    "run full test suite after upgrade",
    "Run the tests before approving",
    "confirm tests passed on the head commit",
    "verify the test run went green",
    "ensure regression tests are executed",
  ];
  const no = [
    "verify docs updated",
    "ensure regression test coverage is documented",
    "document the test suite",
    "test-coverage report uploaded",
    "review auth flow regression",
    "the latest settings are respected",
  ];
  for (const text of yes) assert.equal(isTestExecutionObligation(text), true, text);
  for (const text of no) assert.equal(isTestExecutionObligation(text), false, text);
});

test("#1594 matcher: check names denote test execution only as a delimited word without disqualifiers", () => {
  const yes = ["test (24)", "Unit Tests", "ci / test (node)", "integration-tests", "tests", "test", "e2e: tests"];
  const no = [
    "lint", "build", "CodeQL", "test-coverage", "codecov", "docker-image",
    "(combined)", "latest", "context", "attestations", "report tests upload",
    "docs", "test report", "publish",
  ];
  for (const name of yes) assert.equal(isTestExecutionCheckName(name), true, name);
  for (const name of no) assert.equal(isTestExecutionCheckName(name), false, name);
});

// #1702: a combined step-list name runs every listed step, so one clean test
// step denotes execution even when a sibling step is lint or docs. Only a
// name whose EVERY component is disqualified (or test-free) keeps failing.
test("#1702 matcher: combined step-list names keep their test-execution step", () => {
  const yes = [
    "Typecheck, lint, test, build", // musebridge#252 organic job name
    "lint, tests, build",
    "test & coverage",
    "build; unit tests; publish artifacts",
    "typecheck + test + package",
  ];
  const no = [
    "lint tests", // noun phrase: lint RUNS AGAINST tests, no step separator
    "upload tests",
    "lint / test", // `/` qualifies rather than enumerates — never splits
    "unit-test-lint",
    "docs, test report, upload artifacts",
    "codeql, build",
  ];
  for (const name of yes) assert.equal(isTestExecutionCheckName(name), true, name);
  for (const name of no) assert.equal(isTestExecutionCheckName(name), false, name);
});

// #1703 review verification: testScopesIn matches whole words across the
// WHOLE name, so scope tokens inside a matrix parameter suffix are detected
// (the bare-suite scope veto and these identity rows rely on it).
test("#1703 verify: scope tokens inside matrix suffixes are detected", () => {
  assert.equal(ciCheckIdentity("test (unit, 24)"), "test|unit|plain");
  assert.equal(ciCheckIdentity("test (24, smoke)"), "test|smoke|plain");
  assert.equal(ciCheckIdentity("test (24, integration)"), "test|integration|plain");
  // a bare leg with no scope token keeps exhaustive identity
  assert.equal(ciCheckIdentity("test (24)"), "test||exhaustive");
  assert.equal(ciCheckIdentity("test (18.x, ubuntu-latest)"), "test||exhaustive");
});

test("#1594 discharge: the check must prove the requested test scope", () => {
  const green = (name: string) => evidence("success", [{ name, state: "success", conclusion: "success" }]);

  // same narrow scope: proved
  assert.equal(ciDischargeForCheckText("run integration tests", green("integration-tests"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run unit tests", green("Unit Tests"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run e2e tests", green("e2e: tests"), HEAD).outcome, "satisfied");
  // a generic ask accepts a narrowly scoped run
  assert.equal(ciDischargeForCheckText("run the tests", green("Unit Tests"), HEAD).outcome, "satisfied");

  // wrong scope: never discharges
  const wrongScope = ciDischargeForCheckText("run integration tests", green("Unit Tests"), HEAD);
  assert.equal(wrongScope.outcome, "unresolved");
  assert.equal(wrongScope.reason, "no-matching-test-check");
  // a generic check name cannot PROVE a narrow integration scope
  assert.equal(ciDischargeForCheckText("run integration tests", green("test (24)"), HEAD).reason, "no-matching-test-check");

  // full-suite asks need an exhaustive identity: an explicit marker OR the
  // conventional bare-suite name (#1702) — but never one narrow leg.
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("Unit Tests"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run all tests", green("Unit Tests"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("Integration Tests"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("e2e tests"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("smoke tests"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("Unit Tests, Integration Tests"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("tests (unit)"), HEAD).outcome, "unresolved");
  // matrix-parameter suffixes carry the same scope/disqualifier vetoes
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("test (unit, 24)"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("test (24, smoke)"), HEAD).outcome, "unresolved");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("test (24, lint)"), HEAD).outcome, "unresolved");
  // #1702: the bare conventional suite identity discharges — repos must not
  // have to rename their job to `Full Test Suite` to be recognized.
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("Tests"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("test"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("tests"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("test (24)"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("Typecheck, lint, test, build"), HEAD).outcome, "satisfied");
  // a genuinely exhaustive name still discharges (the #1594 positive control)
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("test suite"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", green("full test suite"), HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run all tests", green("all tests"), HEAD).outcome, "satisfied");
  // a narrow ask stays narrow even when the prose also says "all"
  assert.equal(ciDischargeForCheckText("run all unit tests", green("Unit Tests"), HEAD).outcome, "satisfied");

  // failure-first is scoped too: an unrelated red leg neither refutes nor
  // discharges an integration ask, an in-scope red leg refutes a green sibling
  const unrelatedRed = evidence("success", [
    { name: "Unit Tests", state: "failure", conclusion: "failure" },
    { name: "integration-tests", state: "success", conclusion: "success" },
  ]);
  assert.equal(ciDischargeForCheckText("run integration tests", unrelatedRed, HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run integration tests", evidence("success", [
    { name: "Unit Tests", state: "failure", conclusion: "failure" },
  ]), HEAD).outcome, "unresolved");
  const inScopeRed = evidence("success", [
    { name: "integration-tests", state: "failure", conclusion: "failure" },
    { name: "integration-tests (retry)", state: "success", conclusion: "success" },
  ]);
  assert.equal(ciDischargeForCheckText("run integration tests", inScopeRed, HEAD).outcome, "contradicted");

  // full-suite asks need every in-scope leg settled green: a skipped leg (the
  // GitHub trap: state success) or a pending leg blocks a green sibling
  const skippedSibling = evidence("success", [
    { name: "test suite", state: "success", conclusion: "success" },
    { name: "Unit Tests", state: "success", conclusion: "skipped" },
  ]);
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", skippedSibling, HEAD).reason, "test-check-not-success");
  const pendingSibling = evidence("failure", [
    { name: "test suite", state: "success", conclusion: "success" },
    { name: "Unit Tests", state: "pending" },
  ]);
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", pendingSibling, HEAD).reason, "test-check-not-success");
  // ...but a narrow ask ignores the unrelated skipped/pending leg
  assert.equal(ciDischargeForCheckText("run integration tests", skippedSibling, HEAD).outcome, "unresolved", "no integration check is present");
  const integrationAndSkippedUnit = evidence("success", [
    { name: "integration-tests", state: "success", conclusion: "success" },
    { name: "Unit Tests", state: "success", conclusion: "skipped" },
  ]);
  assert.equal(ciDischargeForCheckText("run integration tests", integrationAndSkippedUnit, HEAD).outcome, "satisfied");

  // finalState folds the WHOLE wait, not the ask's scope: a failure caused by
  // an unrelated check does not block an in-scope green test run, while an
  // in-scope red leg still wins (failure-first)
  const unrelatedWaitFailure = evidence("failure", [
    { name: "lint", state: "failure", conclusion: "failure" },
    { name: "integration-tests", state: "success", conclusion: "success" },
  ]);
  assert.equal(ciDischargeForCheckText("run integration tests", unrelatedWaitFailure, HEAD).outcome, "satisfied");
  const inScopeWaitFailure = evidence("failure", [
    { name: "lint", state: "failure", conclusion: "failure" },
    { name: "integration-tests", state: "failure", conclusion: "failure" },
  ]);
  assert.equal(ciDischargeForCheckText("run integration tests", inScopeWaitFailure, HEAD).outcome, "contradicted");
});

// #1702: deterministic positive replay of the three organic head-bound CI
// job shapes (musebridge#252, dispatch#1659, dispatch#1658): a green
// `Tests` / combined `Typecheck, lint, test, build` job on the exact head
// discharges the test-run row through trusted CI provenance ONLY — the row
// flips via reconcile, never via model prose.
test("#1702 replay: conventional suite shapes discharge through CI provenance", () => {
  const ask = "run full test suite after upgrade";
  for (const name of [
    "Tests",
    "tests",
    "test",
    "test (24)",
    "test [node-20]",
    "test (18.x, ubuntu-latest)", // commas inside the matrix suffix are not an enumeration
    "Typecheck, lint, test, build",
  ]) {
    const green = evidence("success", [
      { name: "build", state: "success", conclusion: "success" },
      { name, state: "success", conclusion: "success" },
    ]);
    const discharge = ciDischargeForCheckText(ask, green, HEAD);
    assert.equal(discharge.outcome, "satisfied", name);
    assert.equal(discharge.reason, "test-check-succeeded", name);
    assert.equal(discharge.check?.name, name, name);

    const coverage = evaluateRequiredCheckCoverage([ask], null);
    const reconciled = reconcileRequiredCheckRows(coverage.checks, green, HEAD);
    assert.equal(reconciled.discharged, 1, name);
    assert.equal(reconciled.rows[0]!.status, "satisfied", name);
    assert.equal(reconciled.rows[0]!.reason, "ci-evidence", name);
    assert.equal(reconciled.rows[0]!.rationale, `trusted CI check "${name}" succeeded on head ${HEAD}`, name);

    const obligations = reconcileObligationsWithCiEvidence(
      [{ id: "obligation-1", source: "must_check", text: ask, status: "unresolved", cause: "budget-exhausted" }],
      green, HEAD);
    assert.equal(obligations[0]!.status, "satisfied", name);
    assert.deepEqual(obligations[0]!.resolvedBy, { kind: "ci-evidence", check: name, headSha: HEAD }, name);
    assert.deepEqual(obligations[0]!.evidence?.receipts, [`ci:${name}`], name);

    // the widened matcher keeps its fences around the same shapes:
    assert.equal(ciDischargeForCheckText(ask, green, STALE).reason, "head-mismatch", name);
    const redSibling = evidence("success", [
      { name, state: "success", conclusion: "success" },
      { name: `${name} (node-20)`, state: "failure", conclusion: "failure" },
    ]);
    assert.equal(ciDischargeForCheckText(ask, redSibling, HEAD).outcome, "contradicted", name);
    const pendingSibling = evidence("failure", [
      { name, state: "success", conclusion: "success" },
      { name: `${name} (node-22)`, state: "pending" },
    ]);
    assert.equal(ciDischargeForCheckText(ask, pendingSibling, HEAD).reason, "test-check-not-success", name);
    const skippedSelf = evidence("success", [{ name, state: "success", conclusion: "skipped" }]);
    assert.equal(ciDischargeForCheckText(ask, skippedSelf, HEAD).reason, "test-check-not-success", name);
    // #1702/#1703: a neutral *sibling* must not be hidden behind a green
    // conventional full-suite leg; GitHub may expose neutral as state success.
    const neutralSibling = evidence("success", [
      { name, state: "success", conclusion: "success" },
      { name: `${name} (node-neutral)`, state: "success", conclusion: "neutral" },
    ]);
    assert.equal(ciDischargeForCheckText(ask, neutralSibling, HEAD).reason, "test-check-not-success", name);
  }
});

test("#1594 discharge: exact-head green test check discharges; stale head does not", () => {
  const ask = "run full test suite after upgrade";
  const green = evidence("success", [
    { name: "build", state: "success", conclusion: "success" },
    { name: "test suite", state: "success", conclusion: "success" },
  ]);
  const ok = ciDischargeForCheckText(ask, green, HEAD);
  assert.deepEqual(ok, { applies: true, outcome: "satisfied", reason: "test-check-succeeded", check: { name: "test suite", state: "success", conclusion: "success" } });

  const stale = ciDischargeForCheckText(ask, green, STALE);
  assert.equal(stale.reason, "head-mismatch");
  assert.equal(stale.outcome, "unresolved");
  assert.equal(ciDischargeForCheckText(ask, green, "").reason, "head-mismatch");
  assert.equal(ciDischargeForCheckText(ask, null, HEAD).reason, "no-ci-evidence");

  // head match is case-insensitive (the gate and the context may differ in case)
  assert.equal(ciDischargeForCheckText(ask, evidence("success", [{ name: "test suite", state: "success", conclusion: "success" }], HEAD.toUpperCase()), HEAD).outcome, "satisfied");
});

test("#1594 discharge: unrelated green checks never discharge; failing test check contradicts", () => {
  const ask = "run full test suite after upgrade";
  const unrelated = evidence("success", [
    { name: "build", state: "success", conclusion: "success" },
    { name: "test-coverage", state: "success", conclusion: "success" },
    { name: "(combined)", state: "success", conclusion: "success" },
  ]);
  const miss = ciDischargeForCheckText(ask, unrelated, HEAD);
  assert.equal(miss.reason, "no-matching-test-check");
  assert.equal(miss.outcome, "unresolved");

  const failing = evidence("failure", [
    { name: "build", state: "success", conclusion: "success" },
    { name: "Unit Tests", state: "failure", conclusion: "failure" },
  ]);
  const contra = ciDischargeForCheckText(ask, failing, HEAD);
  assert.equal(contra.outcome, "contradicted");
  assert.equal(contra.reason, "test-check-contradicted");
  assert.equal(contra.check?.name, "Unit Tests");

  // failure-first precedence: a green matrix leg never out-ranks a red one
  const siblings = evidence("success", [
    { name: "test (20)", state: "success", conclusion: "success" },
    { name: "Unit Tests", state: "failure", conclusion: "failure" },
  ]);
  const refuted = ciDischargeForCheckText(ask, siblings, HEAD);
  assert.equal(refuted.outcome, "contradicted");
  assert.equal(refuted.reason, "test-check-contradicted");
  assert.equal(refuted.check?.name, "Unit Tests");
  const siblings2 = evidence("failure", [
    { name: "Unit Tests", state: "failure", conclusion: "failure" },
    { name: "test (20)", state: "success", conclusion: "success" },
  ]);
  assert.equal(ciDischargeForCheckText(ask, siblings2, HEAD).outcome, "contradicted");

  // a non-dispositioned row with the same evidence stays unresolved (never a
  // block): the contradiction only downgrades an existing `satisfied`.
  const pending = evidence("failure", [{ name: "test", state: "pending" }]);
  assert.equal(ciDischargeForCheckText(ask, pending, HEAD).reason, "test-check-not-success");

  // non-test asks never apply
  assert.deepEqual(ciDischargeForCheckText("review auth flow regression", failing, HEAD), { applies: false, outcome: "none", reason: null, check: null });
});

test("#1594 discharge trap: GitHub `skipped`/`neutral` collapse to state success — they do NOT discharge", () => {
  const ask = "run full test suite after upgrade";
  const skipped = evidence("success", [{ name: "test suite", state: "success", conclusion: "skipped" }]);
  const discharged = ciDischargeForCheckText(ask, skipped, HEAD);
  assert.equal(discharged.outcome, "unresolved");
  assert.equal(discharged.reason, "test-check-not-success");
  const neutral = evidence("success", [{ name: "test suite", state: "success", conclusion: "neutral" }]);
  assert.equal(ciDischargeForCheckText(ask, neutral, HEAD).reason, "test-check-not-success");
  // a state-only row (no recorded conclusion) keeps the state-only rule
  assert.equal(ciDischargeForCheckText(ask, evidence("success", [{ name: "test suite", state: "success", conclusion: null }]), HEAD).outcome, "satisfied");
});

test("#1594 reconcile rows: discharge, reason refinement, contradiction downgrade, coverage recompute", () => {
  const coverage = evaluateRequiredCheckCoverage(
    ["run full test suite after upgrade", "review docs updated", "check secret rotation impact"],
    [d("check secret rotation impact", "satisfied", "no secrets touched")],
  );
  assert.equal(coverage.status, "incomplete");
  const inputRows = coverage.checks;
  const greenOnly = evidence("success", [{ name: "test suite", state: "success", conclusion: "success" }], HEAD);
  const result = reconcileRequiredCheckRows(inputRows, greenOnly, HEAD);
  assert.notEqual(result.rows, inputRows, "returns a new array");
  assert.equal(inputRows[0]!.status, "unresolved", "input rows are never mutated");
  assert.equal(result.discharged, 1);
  assert.equal(result.contradicted, 0);
  assert.deepEqual(
    result.rows.map((row) => [row.status, row.reason]),
    [["satisfied", "ci-evidence"], ["unresolved", "no-disposition"], ["satisfied", "ok"]],
  );
  assert.equal(result.rows[0]!.rationale, `trusted CI check "test suite" succeeded on head ${HEAD}`);

  // a RED sibling refutes discharge: the never-dispositioned test-run row is
  // annotated with the contradicted code (status stays unresolved — coverage,
  // never a manufactured defect) and nothing discharges
  const mixed = evidence("success", [
    { name: "test suite", state: "success", conclusion: "success" },
    { name: "Unit Tests", state: "failure", conclusion: "failure" },
  ], HEAD);
  const annotated = reconcileRequiredCheckRows(inputRows, mixed, HEAD);
  assert.equal(annotated.discharged, 0);
  assert.equal(annotated.contradicted, 0);
  assert.equal(annotated.rows[0]!.status, "unresolved");
  assert.equal(annotated.rows[0]!.reason, "ci-evidence-test-check-contradicted");
  assert.equal(annotated.rows[1]!.reason, "no-disposition");

  // stale evidence only refines the reason of never-dispositioned rows
  const stale = reconcileRequiredCheckRows(inputRows, greenOnly, STALE);
  assert.equal(stale.discharged, 0);
  assert.equal(stale.rows[0]!.status, "unresolved");
  assert.equal(stale.rows[0]!.reason, "ci-evidence-head-mismatch");
  assert.equal(stale.rows[1]!.reason, "no-disposition", "non-test asks keep their reason");

  // model-satisfied rows are downgraded ONLY by a validated contradiction
  const modelFold = evaluateRequiredCheckCoverage(
    ["run full test suite after upgrade"],
    [d("run full test suite after upgrade", "satisfied")],
  );
  const failing = evidence("failure", [{ name: "test suite", state: "failure", conclusion: "failure" }]);
  const contradicted = reconcileRequiredCheckRows(modelFold.checks, failing, HEAD);
  assert.equal(contradicted.contradicted, 1);
  assert.deepEqual(
    [contradicted.rows[0]!.status, contradicted.rows[0]!.reason, contradicted.rows[0]!.rationale],
    ["unresolved", "ci-evidence-contradiction", null],
  );
  // no validated contradiction: the model-satisfied row stands
  const unrelatedEvidence = evidence("success", [{ name: "build", state: "success", conclusion: "success" }]);
  const keptSatisfied = reconcileRequiredCheckRows(modelFold.checks, unrelatedEvidence, HEAD);
  assert.equal(keptSatisfied.rows[0]!.status, "satisfied");

  // duplicate-dispositions reason is NOT refined by a non-discharge evidence
  const duplicated = evaluateRequiredCheckCoverage(
    ["run full test suite after upgrade"],
    [d("run full test suite after upgrade", "satisfied"), d("run full test suite after upgrade", "satisfied")],
  );
  assert.equal(duplicated.checks[0]!.reason, "duplicate-dispositions");
  const refined = reconcileRequiredCheckRows(duplicated.checks, greenOnly, STALE);
  assert.equal(refined.rows[0]!.reason, "duplicate-dispositions");
  assert.equal(refined.rows[0]!.status, "unresolved");

  // a grounded not_applicable completes coverage, so the obligation fold
  // (#1381) folds it to a satisfied row — the coverage fold must downgrade
  // it on a validated contradiction too, or the two artifacts disagree
  const naFold = evaluateRequiredCheckCoverage(
    ["run full test suite after upgrade"],
    [d("run full test suite after upgrade", "not_applicable", "tests are irrelevant here")],
  );
  assert.equal(naFold.status, "complete");
  const naDown = reconcileRequiredCheckRows(naFold.checks, failing, HEAD);
  assert.equal(naDown.contradicted, 1);
  assert.deepEqual(
    [naDown.rows[0]!.status, naDown.rows[0]!.reason, naDown.rows[0]!.rationale],
    ["unresolved", "ci-evidence-contradiction", null],
  );

  // a discharge re-presents coverage as complete over the reconciled rows
  const single = evaluateRequiredCheckCoverage(["run full test suite after upgrade"], null);
  const dischargedOnce = reconcileRequiredCheckRows(single.checks, evidence("success", [{ name: "test suite", state: "success", conclusion: "success" }]), HEAD);
  assert.equal(dischargedOnce.rows.every((row) => (row.status === "satisfied" || row.status === "not_applicable") && (row.reason === "ok" || row.reason === "ci-evidence")), true);
});

test("#1594 reconcile obligations: discharge with provenance, contradiction downgrade, derived untouched", () => {
  const obligations: ReviewObligation[] = [
    { id: "obligation-1", source: "must_check", text: "run full test suite after upgrade", status: "unresolved", cause: "budget-exhausted" },
    { id: "prereq-1", source: "trusted_base_guidance", text: "confirm the tests passed on the head commit", status: "unresolved", cause: "tool-capability" },
    { id: "derived-1", source: "derived", text: "the test runner must load the updated matrix", status: "unresolved", cause: "derivation-incomplete", anchors: ["src/a.ts:run"] },
    { id: "obligation-2", source: "must_check", text: "review docs updated", status: "satisfied", cause: null },
  ];
  const green = evidence("success", [{ name: "test suite", state: "success", conclusion: "success" }]);
  const discharged = reconcileObligationsWithCiEvidence(obligations, green, HEAD);
  assert.notEqual(discharged, obligations);
  assert.equal(discharged[0]!.status, "satisfied");
  assert.equal(discharged[0]!.cause, null);
  assert.deepEqual(discharged[0]!.resolvedBy, { kind: "ci-evidence", check: "test suite", headSha: HEAD });
  assert.equal(discharged[1]!.status, "satisfied");
  assert.deepEqual(discharged[1]!.resolvedBy, { kind: "ci-evidence", check: "test suite", headSha: HEAD });
  assert.equal(discharged[2]!.status, "unresolved", "derived rows never reconcile");
  assert.equal(discharged[2]!.cause, "derivation-incomplete");
  assert.equal(discharged[3], obligations[3], "unchanged rows keep identity");

  // contradiction: model-satisfied required row downgraded; provenance dropped
  const satisfiedRow: ReviewObligation = { id: "obligation-1", source: "must_check", text: "run full test suite after upgrade", status: "satisfied", cause: null, resolvedBy: { kind: "ci-evidence", check: "old", headSha: HEAD } };
  const failing = evidence("failure", [{ name: "test suite", state: "failure", conclusion: "failure" }]);
  const downgraded = reconcileObligationsWithCiEvidence([satisfiedRow], failing, HEAD);
  assert.equal(downgraded[0]!.status, "unresolved");
  assert.equal(downgraded[0]!.cause, null);
  assert.equal(downgraded[0]!.resolvedBy, undefined);

  // no validated contradiction: a satisfied model row stays satisfied
  const kept = reconcileObligationsWithCiEvidence([satisfiedRow], green, HEAD);
  assert.equal(kept[0]!.status, "satisfied");
  assert.equal(kept[0], satisfiedRow, "no-change rows keep identity");

  // unmet forcing rows are never touched by either outcome
  const unmet: ReviewObligation = { id: "obligation-3", source: "must_check", text: "run full test suite after upgrade", status: "unmet", cause: null };
  assert.equal(reconcileObligationsWithCiEvidence([unmet], green, HEAD)[0], unmet);
  assert.equal(reconcileObligationsWithCiEvidence([unmet], failing, HEAD)[0], unmet);

  // evidence null changes nothing for obligations
  const same = reconcileObligationsWithCiEvidence(obligations, null, HEAD);
  assert.deepEqual(same, obligations);
});

test("#1594 artifact round-trip: resolved_by survives serialization; malformed resolved_by refuses the whole artifact", () => {
  const obligations: ReviewObligation[] = [
    { id: "obligation-1", source: "must_check", text: "run full test suite after upgrade", status: "satisfied", cause: null, resolvedBy: { kind: "ci-evidence", check: "test (24)", headSha: HEAD } },
    { id: "obligation-2", source: "must_check", text: "review docs updated", status: "satisfied", cause: null },
  ];
  const artifact = reviewObligationsToArtifact(obligations);
  const rows = (artifact.obligations as Record<string, unknown>[]);
  assert.deepEqual(rows[0]!.resolved_by, { kind: "ci-evidence", check: "test (24)", head_sha: HEAD });
  assert.equal("resolved_by" in rows[1]!, false, "absent provenance stays absent (byte-identical shape)");
  const back = reviewObligationsFromArtifact(artifact);
  assert.notEqual(back, null);
  assert.deepEqual(back, obligations);

  for (const bad of [
    { kind: "ci-evidence", check: "", head_sha: HEAD },
    { kind: "model", check: "test", head_sha: HEAD },
    { kind: "ci-evidence", check: "test", head_sha: "nope" },
    { kind: "ci-evidence", check: "test", head_sha: HEAD, smuggled: 1 },
    "resolved by prose",
    null,
  ]) {
    const polluted = reviewObligationsToArtifact(obligations);
    (polluted.obligations as Record<string, unknown>[])[0]!.resolved_by = bad;
    assert.equal(reviewObligationsFromArtifact(polluted), null, JSON.stringify(bad));
  }
});

test("#1820 trusted configured CI identities define full-suite proof and required legs", () => {
  const ask = "run full test suite after upgrade";
  const integrationAsk = "run integration tests after upgrade";
  const configured = configuredJobs([["validate-typescript", "full-suite"], ["validate-runtime-floor", "full-suite"]]);
  const green = actionsEvidence("success", [
    { name: "validate-typescript", state: "success", conclusion: "success" },
    { name: "validate-runtime-floor", state: "success", conclusion: "success" },
    { name: "validate-static", state: "success", conclusion: "success" },
  ], "8f819a82486df059e75d4c17b3e50f74d9c017d9");
  const head = green.headSha;
  assert.equal(ciDischargeForCheckText(ask, green, head, configured).outcome, "satisfied");
  const coverage = evaluateRequiredCheckCoverage([ask], null);
  const rows = reconcileRequiredCheckRows(coverage.checks, green, head, configured);
  assert.equal(rows.rows[0]!.status, "satisfied");
  assert.equal(rows.rows[0]!.reason, "ci-evidence");
  const obligations = reconcileObligationsWithCiEvidence([
    { id: "obligation-1", source: "must_check", text: ask, status: "unresolved", cause: null },
  ], green, head, configured);
  assert.equal(obligations[0]!.status, "satisfied");
  assert.deepEqual(obligations[0]!.resolvedBy, { kind: "ci-evidence", check: "validate-typescript", headSha: head });

  assert.equal(ciDischargeForCheckText(ask, green, head).reason, "no-matching-test-check");
  assert.equal(ciDischargeForCheckText(ask, green, head, configuredJobs([])).reason, "no-matching-test-check");
  const unrelated = evidence("success", [{ name: "validate-static", state: "success", conclusion: "success" }], head);
  assert.equal(ciDischargeForCheckText(ask, unrelated, head, configured).reason, "configured-test-job-missing");
  assert.equal(ciDischargeForCheckText(ask, green, STALE, configured).reason, "head-mismatch");
  const failed = actionsEvidence("failure", [
    { name: "validate-typescript", state: "failure", conclusion: "failure" },
    { name: "validate-runtime-floor", state: "success", conclusion: "success" },
  ], head);
  assert.equal(ciDischargeForCheckText(ask, failed, head, configured).reason, "test-check-contradicted");
  for (const check of [
    { name: "validate-typescript", state: "pending" },
    { name: "validate-typescript", state: "success", conclusion: "skipped" },
  ]) {
    const pending = actionsEvidence("success", [check, { name: "validate-runtime-floor", state: "success", conclusion: "success" }], head);
    assert.equal(ciDischargeForCheckText(ask, pending, head, configured).reason, "test-check-not-success");
  }
  const oneLeg = actionsEvidence("success", [{ name: "validate-typescript", state: "success", conclusion: "success" }], head);
  assert.equal(ciDischargeForCheckText(ask, oneLeg, head, configured).reason, "configured-test-job-missing");
  const heuristicAndMissing = evidence("success", [
    { name: "Tests", state: "success", conclusion: "success" },
    { name: "validate-typescript", state: "success", conclusion: "success" },
  ], head);
  assert.equal(ciDischargeForCheckText(ask, heuristicAndMissing, head, configured).reason, "configured-test-job-missing");
  assert.equal(ciDischargeForCheckText(integrationAsk, green, head, configured).reason, "no-matching-test-check");
  assert.equal(ciDischargeForCheckText("run the tests", green, head, configured).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText(ask, evidence("success", [
    { name: "Validate-Typescript", state: "success", conclusion: "success" },
    { name: "validate-runtime-floor", state: "success", conclusion: "success" },
  ], head), head, configured).reason, "configured-test-job-missing");
  assert.equal(reconcileRequiredCheckRows(coverage.checks, null, head, configured).discharged, 0);
  assert.deepEqual(reconcileObligationsWithCiEvidence(obligations, null, head, configured), obligations);
});

test("#1820 provenance chain: configured identities require one exact Actions run row", () => {
  const head = HEAD;
  const configured = configuredJobs([["validate-typescript", "full-suite"], ["Unit Tests", "unit"], ["x".repeat(200), "full-suite"]]);
  const chain = (runs: unknown[], statuses: unknown[] = []) => {
    const normalized = normalizeExternalChecks(JSON.stringify({ check_runs: runs }), JSON.stringify({ statuses }), "", "") ?? [];
    const line = renderCiEvidenceOutput(head, "success", normalized);
    return parseHeadBoundCiEvidence(line.replace(/^ci_checks_evidence=/, ""));
  };
  const run = (name: string, id: number, conclusion = "success", app = "github-actions") => ({
    id: id * 10, name, app: { slug: app }, details_url: `https://github.test/actions/runs/${id}/job/${id * 10}`,
    check_suite: { id: id },
    status: "completed", conclusion, started_at: `2026-01-0${id % 9 + 1}T00:00:00Z`,
  });
  const decide = (ask: string, parsed: HeadBoundCiEvidence | null) => ciDischargeForCheckText(ask, parsed, head, configured);

  const redThenGreen = chain([run("validate-typescript", 1, "failure"), run("validate-typescript", 2)]);
  assert.deepEqual(redThenGreen?.checks.map((check) => check.state), ["failure", "success"]);
  assert.equal(decide("run full test suite", redThenGreen).outcome, "contradicted");

  // Distinct same-run check-run ids are distinct legs; filter=latest does not
  // prove retry semantics, so a newer green cannot discard the red leg.
  const retry = run("validate-typescript", 11, "failure");
  retry.details_url = "https://github.test/actions/runs/11/job/111";
  const retryGreen = { ...retry, id: 112, conclusion: "success", started_at: "2026-02-01T00:00:00Z", details_url: "https://github.test/actions/runs/11/job/112" };
  const retried = chain([retry, retryGreen]);
  assert.deepEqual(retried?.checks.map((check) => check.state), ["failure", "success"]);
  assert.equal(decide("run full test suite", retried).outcome, "contradicted");
  const overlapping = chain([run("validate-typescript", 12, "failure"), run("validate-typescript", 13)]);
  assert.deepEqual(overlapping?.checks.map((check) => check.state), ["failure", "success"]);
  assert.equal(decide("run full test suite", overlapping).outcome, "contradicted");
  assert.equal(ciDischargeForCheckText("run full test suite", chain([run("validate-typescript", 13)]), head, configuredJobs([
    ["validate-typescript", "full-suite"],
    ["validate-runtime-floor", "full-suite"],
  ])).reason, "configured-test-job-missing");

  const statusOnly = chain([], [{ context: "validate-typescript", state: "success" }]);
  assert.equal(ciDischargeForCheckText("run full test suite", statusOnly, head, configuredJobs([["validate-typescript", "full-suite"]])).reason, "configured-test-job-missing");

  const full = chain([run("validate-typescript", 3)]);
  assert.equal(ciDischargeForCheckText("run full test suite", full, head, configuredJobs([["validate-typescript", "full-suite"]])).outcome, "satisfied");
  const narrow = chain([run("Unit Tests", 4)]);
  assert.equal(ciDischargeForCheckText("run unit tests", narrow, head, configuredJobs([["Unit Tests", "unit"]])).outcome, "satisfied");

  const clippedCollision = chain([run("x".repeat(200) + "y", 5)]);
  assert.equal(clippedCollision?.checks[0]?.clipped, true);
  assert.equal(ciDischargeForCheckText("run full test suite", clippedCollision, head, configuredJobs([["x".repeat(200), "full-suite"]])).reason, "configured-test-job-missing");
  const exactLongName = chain([run("x".repeat(200), 6)]);
  assert.equal(ciDischargeForCheckText("run full test suite", exactLongName, head, configuredJobs([["x".repeat(200), "full-suite"]])).outcome, "satisfied");

  const controlCollision = chain([run("Unit\u0000Tests", 7)]);
  // The NUL byte is not a name separator in the pre-collapse matcher, so the
  // source name classifies as non-test while the collapsed one is a test row:
  // identity drift refuses the whole artifact (stronger than clip marking),
  // and null evidence keeps the ask unresolved.
  assert.equal(controlCollision, null);
  assert.equal(ciDischargeForCheckText("run unit tests", controlCollision, head, configuredJobs([["Unit Tests", "unit"]])).reason, "no-ci-evidence");

  const ambiguous = chain([run("validate-typescript", 8), run("validate-typescript", 9)]);
  assert.equal(ciDischargeForCheckText("run full test suite", ambiguous, head, configuredJobs([["validate-typescript", "full-suite"]])).reason, "configured-identity-ambiguous");
  const sameRunFirstGreenLeg = run("validate-typescript", 14);
  const sameRunSecondGreenLeg = { ...sameRunFirstGreenLeg, id: 141, details_url: "https://github.test/actions/runs/14/job/141" };
  const sameRunGreenLegs = chain([sameRunFirstGreenLeg, sameRunSecondGreenLeg]);
  assert.equal(ciDischargeForCheckText("run full test suite", sameRunGreenLegs, head, configuredJobs([["validate-typescript", "full-suite"]])).reason, "configured-identity-ambiguous");

  const thirdParty = chain([run("validate-typescript", 10, "success", "other-app")]);
  assert.equal(thirdParty?.checks[0]?.origin, "check");
  assert.equal(ciDischargeForCheckText("run full test suite", thirdParty, head, configuredJobs([["validate-typescript", "full-suite"]])).reason, "configured-test-job-missing");
});

test("#1820 a refused matrix identity leaves only the pre-#1820 heuristics for its name", () => {
  const head = HEAD;
  // Config-time refusal of a matrix-shaped identity (missing-leg): no
  // configured scope remains, so the name falls back to the heuristics —
  // a non-test-named identity can neither discharge nor contradict.
  const refusedMatrix = configuredJobs([], true, true);
  const oneGreenLeg = actionsEvidence("success", [
    { name: "validate-typescript", state: "success", conclusion: "success" },
  ], head);
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", oneGreenLeg, head, refusedMatrix).reason, "no-matching-test-check");
  assert.equal(reconcileRequiredCheckRows(evaluateRequiredCheckCoverage(["run full test suite after upgrade"], null).checks, oneGreenLeg, head, refusedMatrix).rows[0]?.reason, "ci-evidence-no-matching-test-check");
  // The heuristic residual is unchanged: a bare-suite name still discharges
  // from one green leg when no configured identity applies (#1703).
  const bareSuite = actionsEvidence("success", [
    { name: "test", state: "success", conclusion: "success" },
  ], head);
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", bareSuite, head, refusedMatrix).outcome, "satisfied");
});

test("#1820 evidence parser validates provenance while retaining old heuristic artifacts", () => {
  const base = { version: 1, head_sha: HEAD, final_state: "success", checks: [{ name: "Tests", state: "success" }] };
  assert.equal(parseHeadBoundCiEvidenceValue({ ...base, checks: [{ ...base.checks[0], origin: "unknown" }] }), null);
  assert.equal(parseHeadBoundCiEvidenceValue({ ...base, checks: [{ ...base.checks[0], clipped: false }] }), null);
  assert.deepEqual(parseHeadBoundCiEvidenceValue({ ...base, checks: [{ name: "x", state: "success", origin: "actions", clipped: true }] })?.checks[0], {
    name: "x", state: "success", conclusion: null, origin: "actions", clipped: true,
  });
  const oldShape = parseHeadBoundCiEvidenceValue(base);
  assert.equal(ciDischargeForCheckText("run full test suite", oldShape, HEAD).outcome, "satisfied");
  assert.equal(ciDischargeForCheckText("run full test suite", oldShape, HEAD, configuredJobs([["Tests", "full-suite"]])).reason, "configured-test-job-missing");
});

test("#1820 a closed workflow fence refuses every CI-evidence settlement of a test-run ask", () => {
  const head = "8f819a82486df059e75d4c17b3e50f74d9c017d9";
  const ask = "run full test suite after upgrade";
  const configured = configuredJobs([["validate-typescript", "full-suite"]], false);
  const sameName = evidence("success", [{ name: "validate-typescript", state: "success", conclusion: "success" }], head);
  const fenced = ciDischargeForCheckText(ask, sameName, head, configured);
  assert.equal(fenced.outcome, "unresolved");
  assert.equal(fenced.reason, "ci-workflow-surface-untrusted");
  const withLegacySuite = evidence("success", [
    { name: "validate-typescript", state: "success", conclusion: "success" },
    { name: "Tests", state: "success", conclusion: "success" },
  ], head);
  const heuristic = ciDischargeForCheckText(ask, withLegacySuite, head, configured);
  assert.equal(heuristic.outcome, "unresolved");
  assert.equal(heuristic.reason, "ci-workflow-surface-untrusted");

  const red = actionsEvidence("failure", [{ name: "validate-typescript", state: "failure", conclusion: "failure" }], head);
  assert.equal(ciDischargeForCheckText(ask, red, head, configured).reason, "test-check-contradicted");
  const emptyConfigured = ciDischargeForCheckText(ask, evidence("success", [
    { name: "Tests", state: "success", conclusion: "success" },
  ], head), head, configuredJobs([], false));
  assert.equal(emptyConfigured.outcome, "satisfied");
  const refused = ciDischargeForCheckText(ask, evidence("success", [
    { name: "Tests", state: "success", conclusion: "success" },
  ], head), head, configuredJobs([], false, true));
  assert.equal(refused.reason, "ci-workflow-surface-untrusted");
  assert.equal(ciDischargeForCheckText(ask, evidence("success", [
    { name: "Tests", state: "success", conclusion: "success" },
  ], head), head).outcome, "satisfied");

  const coverage = evaluateRequiredCheckCoverage([ask], null);
  const fencedCoverage = reconcileRequiredCheckRows(coverage.checks, sameName, head, configured);
  assert.equal(fencedCoverage.rows[0]!.reason, "ci-evidence-ci-workflow-surface-untrusted");
  const fencedObligation = reconcileObligationsWithCiEvidence([
    { id: "obligation-1", source: "must_check", text: ask, status: "unresolved", cause: null, reason: "no-disposition" },
  ], sameName, head, configured);
  assert.equal(fencedObligation[0]!.reason, "ci-evidence-ci-workflow-surface-untrusted");
});

test("#1820 every declared leg is required for generic and narrow asks, with failure-first precedence", () => {
  const head = "8f819a82486df059e75d4c17b3e50f74d9c017d9";
  const fullSuiteJobs = configuredJobs([["validate-typescript", "full-suite"], ["validate-runtime-floor", "full-suite"]]);
  const onlyTypeScript = actionsEvidence("success", [{ name: "validate-typescript", state: "success", conclusion: "success" }], head);
  assert.equal(ciDischargeForCheckText("run the tests", onlyTypeScript, head, fullSuiteJobs).reason, "configured-test-job-missing");
  const fullSuiteGreen = actionsEvidence("success", [
    { name: "validate-typescript", state: "success", conclusion: "success" },
    { name: "validate-runtime-floor", state: "success", conclusion: "success" },
  ], head);
  assert.equal(ciDischargeForCheckText("run the tests", fullSuiteGreen, head, fullSuiteJobs).outcome, "satisfied");

  const unitJobs = configuredJobs([["unit-one", "unit"], ["unit-two", "unit"]]);
  const oneUnit = actionsEvidence("success", [{ name: "unit-one", state: "success", conclusion: "success" }], head);
  assert.equal(ciDischargeForCheckText("run unit tests after upgrade", oneUnit, head, unitJobs).reason, "configured-test-job-missing");
  const bothUnits = actionsEvidence("success", [
    { name: "unit-one", state: "success", conclusion: "success" },
    { name: "unit-two", state: "success", conclusion: "success" },
  ], head);
  assert.equal(ciDischargeForCheckText("run unit tests after upgrade", bothUnits, head, unitJobs).outcome, "satisfied");

  const redAndMissing = actionsEvidence("success", [{ name: "validate-typescript", state: "failure", conclusion: "failure" }], head);
  assert.equal(ciDischargeForCheckText("run the tests", redAndMissing, head, fullSuiteJobs).reason, "test-check-contradicted");

  const mixedJobs = configuredJobs([
    ["unit-tests", "unit"],
    ["validate-typescript", "full-suite"],
    ["validate-runtime-floor", "full-suite"],
  ]);
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", fullSuiteGreen, head, mixedJobs).outcome, "satisfied");
});

test("#1820 a narrow-declared scope proves exactly its own ask, never a generic or full-suite ask", () => {
  const head = "8f819a82486df059e75d4c17b3e50f74d9c017d9";
  const narrow = configuredJobs([["unit-tests", "unit"]]);
  const unitGreen = actionsEvidence("success", [{ name: "unit-tests", state: "success", conclusion: "success" }], head);
  assert.equal(ciDischargeForCheckText("run unit tests after upgrade", unitGreen, head, narrow).outcome, "satisfied");
  // M1 #1820 review: the operator's declared scope is authoritative — a
  // unit-declared job must not widen itself into a generic discharge.
  assert.equal(ciDischargeForCheckText("run the tests", unitGreen, head, narrow).reason, "no-matching-test-check");
  assert.equal(ciDischargeForCheckText("run full test suite after upgrade", unitGreen, head, narrow).reason, "no-matching-test-check");
  // Legacy name-derived behavior is untouched: a heuristic unit-named check
  // still discharges a generic ask.
  const heuristicUnit = evidence("success", [{ name: "Unit Tests", state: "success", conclusion: "success" }], head);
  assert.equal(ciDischargeForCheckText("run the tests", heuristicUnit, head, narrow).outcome, "satisfied");
});

test("#1820 the missing-leg reason refines unresolved obligation rows on both folds", () => {
  const head = "8f819a82486df059e75d4c17b3e50f74d9c017d9";
  const configured = configuredJobs([["validate-typescript", "full-suite"]]);
  const ask = "run full test suite after upgrade";
  const unrelated = evidence("success", [{ name: "validate-static", state: "success", conclusion: "success" }], head);
  const coverage = evaluateRequiredCheckCoverage([ask], null);
  const rows = reconcileRequiredCheckRows(coverage.checks, unrelated, head, configured);
  assert.equal(rows.rows[0]!.status, "unresolved");
  assert.equal(rows.rows[0]!.reason, "ci-evidence-configured-test-job-missing");
  const obligations = reconcileObligationsWithCiEvidence([
    { id: "obligation-1", source: "must_check", text: ask, status: "unresolved", cause: null, reason: "no-disposition" },
  ], unrelated, head, configured);
  assert.equal(obligations[0]!.status, "unresolved");
  assert.equal(obligations[0]!.reason, "ci-evidence-configured-test-job-missing");
});

test("#1594 rows helper: reconcile leaves no-evidence coverage rows byte-shape-identical", () => {
  const coverage = evaluateRequiredCheckCoverage(["run full test suite after upgrade"], null);
  const result = reconcileRequiredCheckRows(coverage.checks, null, HEAD);
  assert.deepEqual(result.rows, coverage.checks);
  assert.equal(result.discharged, 0);
  assert.equal(result.contradicted, 0);
  const row: RequiredCheckRow = coverage.checks[0]!;
  assert.equal(row.reason, "no-structured-dispositions");
});
