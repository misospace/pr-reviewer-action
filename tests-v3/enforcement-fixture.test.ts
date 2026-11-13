import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnforcementFixture, runRequirementCoverageFixture } from "../src/enforcement/fixture.js";

function withFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "enforcement-fixture-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
test("enforcement fixture runs model no-op and blocker escalation pipelines", () => {
  withFixtures((dir) => {
    const base = { contract: "enforcement-pipeline/v1", artifact: { verdict: "approve", review_markdown: "review", findings: [] }, config: { verdict_policy: "model" } };
    const noOp = runEnforcementFixture(writeJson(dir, "model.json", base));
    assert.equal(noOp.ok, true);
    const noOpArtifact = JSON.parse(noOp.values!.artifact!);
    assert.equal(noOpArtifact.verdict, "approve");
    assert.equal(noOpArtifact.verdict_source, "model");
    assert.equal(noOp.values!.applied!, "0");

    const escalation = runEnforcementFixture(writeJson(dir, "blocker.json", {
      ...base,
      artifact: { verdict: "approve", review_markdown: "review", findings: [{ severity: "blocker", category: "bug", file: "a.ts", line: 1, message: "blocked" }] },
      config: { verdict_policy: "findings_severity_gated" },
    }));
    assert.equal(escalation.ok, true);
    const escalated = JSON.parse(escalation.values!.artifact!);
    assert.equal(escalated.verdict, "request_changes");
    assert.equal(escalated.verdict_source, "findings");
    assert.ok(escalated.review_markdown.includes("Verdict escalated from structured findings"));

    const evidenceBlocker = runEnforcementFixture(writeJson(dir, "evidence-blocker.json", {
      contract: "enforcement-pipeline/v1",
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      evidence: { has_blocker: true, providers: [{ id: "scanner", provider_severity: "blocker" }] },
      threads: [{
        thread_id: "t",
        path: "src/a.ts",
        line: 4,
        severity: "major",
        message: "confirm the metric exists",
        category: "verification",
        own_finding: true,
        replies: 0,
      }],
      config: { verdict_policy: "model", evidence_blocker_enforcement: true },
    }));
    assert.equal(evidenceBlocker.ok, true);
    const evidenceArtifact = JSON.parse(evidenceBlocker.values!.artifact!);
    assert.equal(evidenceArtifact.verdict, "request_changes");
    assert.match(evidenceArtifact.review_markdown, /## Final Recommendation/);
    assert.match(evidenceArtifact.review_markdown, /- Evidence provider blocker detected: scanner\./);
  });
});

test("enforcement fixture runs the #811 strict pipeline: relax, coverage gap, and forced-keep", () => {
  withFixtures((dir) => {
    const strictBase = { contract: "enforcement-pipeline/v1" };
    // Model request_changes backed only by minors: relaxed to approve, one
    // override line, and the strict mapping runs AFTER overlays.
    const relaxed = runEnforcementFixture(writeJson(dir, "relax.json", {
      ...strictBase,
      artifact: { verdict: "request_changes", review_markdown: "review", findings: [{ severity: "minor", category: "bug", file: null, line: null, message: "nit" }] },
      config: { verdict_policy: "strict" },
    }));
    assert.equal(relaxed.ok, true);
    const relaxedArtifact = JSON.parse(relaxed.values!.artifact!);
    assert.equal(relaxedArtifact.verdict, "approve");
    assert.equal(relaxedArtifact.verdict_source, "findings");
    assert.ok(relaxedArtifact.review_markdown.includes("_Verdict set from open findings (verdict_policy=strict): no blocker or major finding out of 1 open; model verdict was 'request_changes'._"));

    // Incomplete coverage: the completeness pass runs first, the mapping
    // publishes the non-blocking state (approve), never request_changes.
    const partial = runEnforcementFixture(writeJson(dir, "partial.json", {
      ...strictBase,
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      must_check: ["run the test suite"],
      config: { verdict_policy: "strict" },
    }));
    assert.equal(partial.ok, true);
    const partialArtifact = JSON.parse(partial.values!.artifact!);
    assert.equal(partialArtifact.verdict, "approve");
    assert.equal(partialArtifact.required_checks, "incomplete");

    // A tool-harness CAPABILITY failure is disclosed and never forces the
    // verdict (#1656): the review's verdict stands and the authoritative
    // disposition answers the failure with `investigation_unavailable`
    // MATERIAL evidence (an abstention), so no code blocker is fabricated
    // and no approval is certified either.
    const forced = runEnforcementFixture(writeJson(dir, "forced.json", {
      ...strictBase,
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      tool_harness: { planning_error: "plan broke" },
      config: { verdict_policy: "strict", tool_failure_enforcement: true },
    }));
    assert.equal(forced.ok, true);
    const forcedArtifact = JSON.parse(forced.values!.artifact!);
    assert.equal(forcedArtifact.verdict, "approve");
    assert.equal(forcedArtifact.verdict_source, "model");
    assert.ok(forcedArtifact.review_markdown.includes("## Tool Harness Failure"));
    assert.ok(!forcedArtifact.review_markdown.includes("fail-closed enforcement layer forced request_changes"));
  });
});

test("enforcement fixture requires a CI-only conclusion restatement to relax request_changes", () => {
  withFixtures((dir) => {
    const ciOnly = runEnforcementFixture(writeJson(dir, "ci-only.json", {
      contract: "enforcement-pipeline/v1",
      artifact: {
        verdict: "request_changes",
        review_markdown: "review",
        findings: [{ severity: "major", category: "bug", file: null, line: null, message: "validate-toml has a terminal failure" }],
      },
      ci_checks_content: "_Other checks shown for context only._\n\n| Check | State |\n| --- | --- |\n| validate-toml | cancelled |\n",
      config: { verdict_policy: "model" },
    }));
    assert.equal(ciOnly.ok, true);
    const cappedArtifact = JSON.parse(ciOnly.values!.artifact!);
    assert.equal(cappedArtifact.verdict, "approve");
    assert.equal(cappedArtifact.findings[0].severity, "info");
    assert.equal(cappedArtifact.findings[0].ci_capped, true);
    assert.equal(cappedArtifact.findings[0].capped_from, "major");
    assert.match(cappedArtifact.review_markdown, /Verdict relaxed from CI-only findings/);

    const repoWide = runEnforcementFixture(writeJson(dir, "repo-wide.json", {
      contract: "enforcement-pipeline/v1",
      artifact: {
        verdict: "request_changes",
        review_markdown: "review",
        findings: [{ severity: "blocker", category: "bug", file: null, line: null, message: "the build script mishandles env vars repo-wide" }],
      },
      ci_checks_content: "| Check | State |\n| --- | --- |\n| build | failure |\n",
      config: { verdict_policy: "model" },
    }));
    assert.equal(repoWide.ok, true);
    const uncappedArtifact = JSON.parse(repoWide.values!.artifact!);
    assert.equal(uncappedArtifact.verdict, "request_changes");
    assert.equal(uncappedArtifact.findings[0].severity, "blocker");
    assert.equal(uncappedArtifact.findings[0].ci_capped, undefined);
  });
});

test("enforcement fixture reconciles the banner after verification-only relaxation", () => {
  withFixtures((dir) => {
    const result = runEnforcementFixture(writeJson(dir, "verification.json", {
      contract: "enforcement-pipeline/v1",
      artifact: {
        verdict: "request_changes",
        review_markdown: "review",
        findings: [{ severity: "major", category: "verification", file: null, line: null, message: "confirm the metric" }],
      },
      threads: [{
        thread_id: "t",
        path: "src/a.ts",
        line: 4,
        severity: "major",
        message: "confirm the metric exists",
        category: "verification",
        own_finding: true,
        replies: 0,
      }],
      config: { verdict_policy: "model" },
    }));
    assert.equal(result.ok, true);
    const artifact = JSON.parse(result.values!.artifact!);
    assert.equal(artifact.verdict, "approve");
    assert.doesNotMatch(artifact.review_markdown, /Final Recommendation/);
  });
});

test("requirement-coverage fixture credits grounded evidence and exposes bad ledgers", () => {
  withFixtures((dir) => {
    const result = runRequirementCoverageFixture(writeJson(dir, "coverage.json", {
      contract: "requirement-coverage/v1",
      cases: [
        { name: "credited", ledger: { requirements: [{ id: "req-aaaabbbbcccc", text: "A", kind: "acceptance", verification_required: false }] }, coverage: [{ requirement_id: "req-aaaabbbbcccc", status: "satisfied", evidence: [{ kind: "test", ref: "test/a", detail: "passed" }] }] },
        { name: "bad-ledger", ledger: null, coverage: [] },
      ],
    }));
    assert.equal(result.ok, true);
    const credited = JSON.parse(result.values!.credited!);
    assert.equal(credited.coverage[0].credited, true);
    const badLedger = JSON.parse(result.values!["bad-ledger"]!);
    assert.ok(badLedger.errors.includes("ledger-unavailable"));
  });
});

test("fixture contract mismatch fails closed", () => {
  withFixtures((dir) => {
    const path = writeJson(dir, "wrong.json", { contract: "wrong/v1", artifact: {}, config: {} });
    const result = runEnforcementFixture(path);
    assert.deepEqual(result, { ok: false, stderr: "fixture is not enforcement-pipeline/v1" });
    assert.equal(readFileSync(path, "utf8").length > 0, true);
  });
});

test("enforcement fixture keeps relax-then-force provenance and body honest end to end (#1248)", () => {
  withFixtures((dir) => {
    const relaxThenForce = runEnforcementFixture(writeJson(dir, "relax-then-force.json", {
      contract: "enforcement-pipeline/v1",
      artifact: {
        verdict: "request_changes",
        review_markdown: "review",
        findings: [{ severity: "blocker", category: "tests", file: "a.ts", line: 1, message: "untested change" }],
      },
      tool_harness: { planning_error: "plan broke" },
      config: {
        verdict_policy: "findings_severity_gated",
        non_blocking_finding_categories: "tests",
        tool_failure_enforcement: true,
      },
    }));
    assert.equal(relaxThenForce.ok, true);
    const artifact = JSON.parse(relaxThenForce.values!.artifact!);
    // Policy relaxes to approve (verdict_source=findings). #1656: the
    // tool-failure overlay no longer forces the verdict back — the
    // relaxation stands and the failure rides the disposition's
    // `investigation_unavailable` material unknown, so the provenance and
    // the body stay honest without a fabricated block.
    assert.equal(artifact.verdict, "approve");
    assert.equal(artifact.verdict_source, "findings");
    assert.doesNotMatch(artifact.review_markdown, /_Verdict relaxation superseded by enforcement/);
    assert.ok(artifact.review_markdown.includes("## Tool Harness Failure"));
  });
});

const CI_HEAD = "0123456789abcdef0123456789abcdef01234567";
const CI_STALE = "aabbccddeeff00112233445566778899aabbccdd";

test("#1594 fixture: exact-head green test check discharges the test-run ask (strict, no dispositions)", () => {
  withFixtures((dir) => {
    const result = runEnforcementFixture(writeJson(dir, "ci-discharge.json", {
      contract: "enforcement-pipeline/v1",
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      must_check: ["run full test suite after upgrade"],
      ci_evidence: {
        version: 1, head_sha: CI_HEAD, final_state: "success",
        checks: [{ name: "test suite", state: "success", conclusion: "success" }],
      },
      reviewed_head_sha: CI_HEAD,
      config: { verdict_policy: "strict" },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.values!.required_checks!, "complete");
    const completeness = JSON.parse(result.values!.completeness_result!);
    assert.equal(completeness.status, "complete");
    assert.deepEqual(completeness.missing, []);
    assert.equal(completeness.checks[0].status, "satisfied");
    assert.equal(completeness.checks[0].reason, "ci-evidence");
    assert.equal(completeness.checks[0].rationale, `trusted CI check "test suite" succeeded on head ${CI_HEAD}`);
    const artifact = JSON.parse(result.values!.artifact!);
    assert.equal(artifact.required_checks, "complete");
    assert.equal(artifact.verdict, "approve", "coverage never demotes the strict verdict here, it only completes it");
    assert.doesNotMatch(artifact.review_markdown, /Unaddressed required checks/);
  });
});

test("#1594 fixture: stale-head evidence keeps coverage incomplete with the bounded reason code", () => {
  withFixtures((dir) => {
    const result = runEnforcementFixture(writeJson(dir, "ci-stale.json", {
      contract: "enforcement-pipeline/v1",
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      must_check: ["run full test suite after upgrade"],
      ci_evidence: {
        version: 1, head_sha: CI_STALE, final_state: "success",
        checks: [{ name: "test suite", state: "success", conclusion: "success" }],
      },
      reviewed_head_sha: CI_HEAD,
      config: { verdict_policy: "strict" },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.values!.required_checks!, "incomplete");
    const completeness = JSON.parse(result.values!.completeness_result!);
    assert.deepEqual(completeness.missing, ["run full test suite after upgrade"]);
    assert.equal(completeness.checks[0].status, "unresolved");
    assert.equal(completeness.checks[0].reason, "ci-evidence-head-mismatch");
  });
});

test("#1594 fixture: a failed head-bound test check contradicts the model satisfied claim", () => {
  withFixtures((dir) => {
    const result = runEnforcementFixture(writeJson(dir, "ci-contradiction.json", {
      contract: "enforcement-pipeline/v1",
      artifact: {
        verdict: "approve",
        review_markdown: "review",
        findings: [],
        required_check_dispositions: [{ check: "run full test suite after upgrade", status: "satisfied", rationale: null }],
      },
      must_check: ["run full test suite after upgrade"],
      ci_evidence: {
        version: 1, head_sha: CI_HEAD, final_state: "failure",
        checks: [{ name: "Unit Tests", state: "failure", conclusion: "failure" }],
      },
      reviewed_head_sha: CI_HEAD,
      config: { verdict_policy: "strict", required_check_validation_mode: "warn" },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.values!.required_checks!, "incomplete");
    const completeness = JSON.parse(result.values!.completeness_result!);
    assert.equal(completeness.checks[0].status, "unresolved");
    assert.equal(completeness.checks[0].reason, "ci-evidence-contradiction");
    const artifact = JSON.parse(result.values!.artifact!);
    assert.match(artifact.review_markdown, /### Unaddressed required checks/);
    assert.match(artifact.review_markdown, /At least one of these rows had a reviewer disposition claiming satisfaction; validated head-bound CI evidence contradicts that claim \(#1594\)\./);

    // failure-first precedence: a green matrix leg never out-ranks a red one
    // — a never-dispositioned row stays unresolved, annotated with the
    // contradicted reason code, and never discharges.
    const refuted = runEnforcementFixture(writeJson(dir, "ci-red-sibling.json", {
      contract: "enforcement-pipeline/v1",
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      must_check: ["run full test suite after upgrade"],
      ci_evidence: {
        version: 1, head_sha: CI_HEAD, final_state: "success",
        checks: [
          { name: "test (20)", state: "success", conclusion: "success" },
          { name: "Unit Tests", state: "failure", conclusion: "failure" },
        ],
      },
      reviewed_head_sha: CI_HEAD,
      config: { verdict_policy: "strict" },
    }));
    assert.equal(refuted.ok, true);
    assert.equal(refuted.values!.required_checks!, "incomplete");
    const refutedCompleteness = JSON.parse(refuted.values!.completeness_result!);
    assert.equal(refutedCompleteness.checks[0].status, "unresolved");
    assert.equal(refutedCompleteness.checks[0].reason, "ci-evidence-test-check-contradicted");
  });
});

test("#1594 fixture: absent or invalid ci_evidence keeps the pipeline byte-identical", () => {
  withFixtures((dir) => {
    const base = {
      contract: "enforcement-pipeline/v1",
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      must_check: ["run full test suite after upgrade"],
      config: { verdict_policy: "strict" },
    };
    const plain = runEnforcementFixture(writeJson(dir, "no-evidence.json", base));
    assert.equal(plain.ok, true);
    for (const ciEvidence of [null, { version: 2, head_sha: CI_HEAD, final_state: "success", checks: [] }, "prose", { version: 1, head_sha: "nope", final_state: "success", checks: [] }]) {
      const polluted = runEnforcementFixture(writeJson(dir, `polluted-${JSON.stringify(ciEvidence)}.json`, { ...base, ci_evidence: ciEvidence, reviewed_head_sha: CI_HEAD }));
      assert.equal(polluted.ok, true);
      assert.deepEqual(polluted.values, plain.values, "an unusable evidence value behaves as absent");
    }
    assert.equal(JSON.parse(plain.values!.completeness_result!).checks[0].reason, "no-structured-dispositions");
  });
});
