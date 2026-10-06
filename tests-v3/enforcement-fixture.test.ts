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

    // A tool-harness failure forces request_changes after the model verdict;
    // the strict mapping never relaxes it and adds no note of its own.
    const forced = runEnforcementFixture(writeJson(dir, "forced.json", {
      ...strictBase,
      artifact: { verdict: "approve", review_markdown: "review", findings: [] },
      tool_harness: { planning_error: "plan broke" },
      config: { verdict_policy: "strict", tool_failure_enforcement: true },
    }));
    assert.equal(forced.ok, true);
    const forcedArtifact = JSON.parse(forced.values!.artifact!);
    assert.equal(forcedArtifact.verdict, "request_changes");
    // Provenance honesty (#811 review): the model said approve; the forced
    // verdict is the enforcement layer's, never the model's.
    assert.equal(forcedArtifact.verdict_source, "enforcement");
    assert.ok(forcedArtifact.review_markdown.includes("fail-closed enforcement layer forced request_changes"));
    assert.ok(forcedArtifact.review_markdown.includes("## Tool Harness Failure"));
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
