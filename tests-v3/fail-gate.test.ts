import test from "node:test";
import assert from "node:assert/strict";
import { failOnRequestChanges } from "../src/run/action.js";
import { resolveDegradedGateBypass } from "../src/run/review.js";

test("#978: gate bypass eligibility is limited to notices and unblocked fallback no-evidence reviews", () => {
  const cases = [
    [{ notice: true, fromFallback: false, noEvidenceGathered: false, deterministicBlock: true }, true],
    [{ notice: false, fromFallback: true, noEvidenceGathered: true, deterministicBlock: false }, true],
    [{ notice: false, fromFallback: true, noEvidenceGathered: true, deterministicBlock: true }, false],
    [{ notice: false, fromFallback: false, noEvidenceGathered: true, deterministicBlock: false }, false],
    [{ notice: false, fromFallback: true, noEvidenceGathered: false, deterministicBlock: false }, false],
  ] as const;
  for (const [input, expected] of cases) assert.equal(resolveDegradedGateBypass(input), expected, JSON.stringify(input));
});

test("#978: fail-on-request-changes respects the full gate-bypass truth table", () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    for (const verdict of ["approve", "comment", "request_changes"]) {
      for (const degradedGateBypass of [false, true]) {
        for (const failOnDegraded of [false, true]) {
          assert.equal(
            failOnRequestChanges({}, verdict, degradedGateBypass, failOnDegraded),
            0,
            `unset gate: ${verdict}, degradedGateBypass=${degradedGateBypass}, failOnDegraded=${failOnDegraded}`,
          );
          assert.equal(
            failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "false" }, verdict, degradedGateBypass, failOnDegraded),
            0,
            `disabled gate: ${verdict}, degradedGateBypass=${degradedGateBypass}, failOnDegraded=${failOnDegraded}`,
          );
        }
      }
    }

    for (const verdict of ["approve", "comment"]) {
      for (const degradedGateBypass of [false, true]) {
        for (const failOnDegraded of [false, true]) {
          assert.equal(
            failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, verdict, degradedGateBypass, failOnDegraded),
            0,
            `enabled gate: ${verdict}, degradedGateBypass=${degradedGateBypass}, failOnDegraded=${failOnDegraded}`,
          );
        }
      }
    }
    assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", false, false), 1);
    assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", true, false), 0);
    assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", true, true), 1);

    assert.equal(writes.filter((line) => line.startsWith("::warning::")).length, 1);
    assert.equal(writes.filter((line) => line.startsWith("::error::")).length, 2);
    assert.ok(writes.some((line) => line.startsWith("::warning::") && line.includes("degraded")));
    assert.ok(writes.every((line) => !line.startsWith("::error::") || line.includes("request_changes")));
  } finally {
    process.stdout.write = originalWrite;
  }
});
