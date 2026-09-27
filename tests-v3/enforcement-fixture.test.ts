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
