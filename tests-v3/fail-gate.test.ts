import test from "node:test";
import assert from "node:assert/strict";
import { failOnRequestChanges } from "../src/run/action.js";

test("#978: fail-on-request-changes respects the full degraded-review truth table", () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    for (const verdict of ["approve", "comment", "request_changes"]) {
      for (const degraded of [false, true]) {
        for (const failOnDegraded of [false, true]) {
          assert.equal(
            failOnRequestChanges({}, verdict, degraded, failOnDegraded),
            0,
            `unset gate: ${verdict}, degraded=${degraded}, failOnDegraded=${failOnDegraded}`,
          );
          assert.equal(
            failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "false" }, verdict, degraded, failOnDegraded),
            0,
            `disabled gate: ${verdict}, degraded=${degraded}, failOnDegraded=${failOnDegraded}`,
          );
        }
      }
    }

    for (const verdict of ["approve", "comment"]) {
      for (const degraded of [false, true]) {
        for (const failOnDegraded of [false, true]) {
          assert.equal(
            failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, verdict, degraded, failOnDegraded),
            0,
            `enabled gate: ${verdict}, degraded=${degraded}, failOnDegraded=${failOnDegraded}`,
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
