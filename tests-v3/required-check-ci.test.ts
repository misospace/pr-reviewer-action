import test from "node:test";
import assert from "node:assert/strict";
import {
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

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const STALE = "aabbccddeeff00112233445566778899aabbccdd";

function evidence(finalState: HeadBoundCiEvidence["finalState"], checks: Array<Omit<CiEvidenceCheck, "conclusion"> & { conclusion?: string | null }>, headSha = HEAD): HeadBoundCiEvidence {
  return { headSha, finalState, checks: checks.map((check) => ({ name: check.name, state: check.state, conclusion: check.conclusion ?? null })) };
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

test("#1594 discharge: exact-head green test check discharges; stale head does not", () => {
  const ask = "run full test suite after upgrade";
  const green = evidence("success", [
    { name: "build", state: "success", conclusion: "success" },
    { name: "test (24)", state: "success", conclusion: "success" },
  ]);
  const ok = ciDischargeForCheckText(ask, green, HEAD);
  assert.deepEqual(ok, { applies: true, outcome: "satisfied", reason: "test-check-succeeded", check: { name: "test (24)", state: "success", conclusion: "success" } });

  const stale = ciDischargeForCheckText(ask, green, STALE);
  assert.equal(stale.reason, "head-mismatch");
  assert.equal(stale.outcome, "unresolved");
  assert.equal(ciDischargeForCheckText(ask, green, "").reason, "head-mismatch");
  assert.equal(ciDischargeForCheckText(ask, null, HEAD).reason, "no-ci-evidence");

  // head match is case-insensitive (the gate and the context may differ in case)
  assert.equal(ciDischargeForCheckText(ask, evidence("success", [{ name: "test", state: "success", conclusion: "success" }], HEAD.toUpperCase()), HEAD).outcome, "satisfied");
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
  const skipped = evidence("success", [{ name: "test", state: "success", conclusion: "skipped" }]);
  const discharged = ciDischargeForCheckText(ask, skipped, HEAD);
  assert.equal(discharged.outcome, "unresolved");
  assert.equal(discharged.reason, "test-check-not-success");
  const neutral = evidence("success", [{ name: "test", state: "success", conclusion: "neutral" }]);
  assert.equal(ciDischargeForCheckText(ask, neutral, HEAD).reason, "test-check-not-success");
  // a state-only row (no recorded conclusion) keeps the state-only rule
  assert.equal(ciDischargeForCheckText(ask, evidence("success", [{ name: "test", state: "success", conclusion: null }]), HEAD).outcome, "satisfied");
});

test("#1594 reconcile rows: discharge, reason refinement, contradiction downgrade, coverage recompute", () => {
  const coverage = evaluateRequiredCheckCoverage(
    ["run full test suite after upgrade", "review docs updated", "check secret rotation impact"],
    [d("check secret rotation impact", "satisfied", "no secrets touched")],
  );
  assert.equal(coverage.status, "incomplete");
  const inputRows = coverage.checks;
  const greenOnly = evidence("success", [{ name: "test", state: "success", conclusion: "success" }], HEAD);
  const result = reconcileRequiredCheckRows(inputRows, greenOnly, HEAD);
  assert.notEqual(result.rows, inputRows, "returns a new array");
  assert.equal(inputRows[0]!.status, "unresolved", "input rows are never mutated");
  assert.equal(result.discharged, 1);
  assert.equal(result.contradicted, 0);
  assert.deepEqual(
    result.rows.map((row) => [row.status, row.reason]),
    [["satisfied", "ci-evidence"], ["unresolved", "no-disposition"], ["satisfied", "ok"]],
  );
  assert.equal(result.rows[0]!.rationale, `trusted CI check "test" succeeded on head ${HEAD}`);

  // a RED sibling refutes discharge: the never-dispositioned test-run row is
  // annotated with the contradicted code (status stays unresolved — coverage,
  // never a manufactured defect) and nothing discharges
  const mixed = evidence("success", [
    { name: "test", state: "success", conclusion: "success" },
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
  const failing = evidence("failure", [{ name: "test", state: "failure", conclusion: "failure" }]);
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
  const dischargedOnce = reconcileRequiredCheckRows(single.checks, evidence("success", [{ name: "tests", state: "success", conclusion: "success" }]), HEAD);
  assert.equal(dischargedOnce.rows.every((row) => (row.status === "satisfied" || row.status === "not_applicable") && (row.reason === "ok" || row.reason === "ci-evidence")), true);
});

test("#1594 reconcile obligations: discharge with provenance, contradiction downgrade, derived untouched", () => {
  const obligations: ReviewObligation[] = [
    { id: "obligation-1", source: "must_check", text: "run full test suite after upgrade", status: "unresolved", cause: "budget-exhausted" },
    { id: "prereq-1", source: "trusted_base_guidance", text: "confirm the tests passed on the head commit", status: "unresolved", cause: "tool-capability" },
    { id: "derived-1", source: "derived", text: "the test runner must load the updated matrix", status: "unresolved", cause: "derivation-incomplete", anchors: ["src/a.ts:run"] },
    { id: "obligation-2", source: "must_check", text: "review docs updated", status: "satisfied", cause: null },
  ];
  const green = evidence("success", [{ name: "test", state: "success", conclusion: "success" }]);
  const discharged = reconcileObligationsWithCiEvidence(obligations, green, HEAD);
  assert.notEqual(discharged, obligations);
  assert.equal(discharged[0]!.status, "satisfied");
  assert.equal(discharged[0]!.cause, null);
  assert.deepEqual(discharged[0]!.resolvedBy, { kind: "ci-evidence", check: "test", headSha: HEAD });
  assert.equal(discharged[1]!.status, "satisfied");
  assert.deepEqual(discharged[1]!.resolvedBy, { kind: "ci-evidence", check: "test", headSha: HEAD });
  assert.equal(discharged[2]!.status, "unresolved", "derived rows never reconcile");
  assert.equal(discharged[2]!.cause, "derivation-incomplete");
  assert.equal(discharged[3], obligations[3], "unchanged rows keep identity");

  // contradiction: model-satisfied required row downgraded; provenance dropped
  const satisfiedRow: ReviewObligation = { id: "obligation-1", source: "must_check", text: "run full test suite after upgrade", status: "satisfied", cause: null, resolvedBy: { kind: "ci-evidence", check: "old", headSha: HEAD } };
  const failing = evidence("failure", [{ name: "test", state: "failure", conclusion: "failure" }]);
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

test("#1594 rows helper: reconcile leaves no-evidence coverage rows byte-shape-identical", () => {
  const coverage = evaluateRequiredCheckCoverage(["run full test suite after upgrade"], null);
  const result = reconcileRequiredCheckRows(coverage.checks, null, HEAD);
  assert.deepEqual(result.rows, coverage.checks);
  assert.equal(result.discharged, 0);
  assert.equal(result.contradicted, 0);
  const row: RequiredCheckRow = coverage.checks[0]!;
  assert.equal(row.reason, "no-structured-dispositions");
});
