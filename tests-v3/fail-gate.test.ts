import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
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

test("#518: the fail-on-request-changes gate is opt-in and runs after publishing", () => {
  // Both gate inputs default off: failing the step is a deliberate choice
  // (docs/verdicts-and-publishing.md).
  const action = parse(readFileSync("action.yml", "utf8")) as { inputs: Record<string, { default?: string }> };
  assert.equal(action.inputs["fail-on-request-changes"]?.default, "false");
  assert.equal(action.inputs["fail-on-degraded-review"]?.default, "false");

  // "Runs after publishing — the review comment and inline findings still land
  // on the PR either way." actionMain has no injectable publish/gate seam, so
  // guard the orchestration order at the source (the same pattern as
  // qualification-dataflow.test.ts): a future reorder that gated before
  // publishing would fail a review that never posted.
  const source = readFileSync("src/run/action.ts", "utf8");
  const publishAt = source.indexOf("await publishWith(");
  const gateAt = source.indexOf("const gate = failOnRequestChanges(");
  assert.ok(publishAt !== -1, "actionMain must call publishWith");
  assert.ok(gateAt !== -1, "actionMain must call failOnRequestChanges");
  assert.ok(publishAt < gateAt, "publication must precede the fail-on-request-changes gate");
});

test("#1140: the confidence scorer's internal-crash diagnostic masks BEFORE capping, and both confidence artifacts go through redactTextDeep", () => {
  // `runReview`'s `catch (cause)` around `runConfidenceScorer` cannot be reached
  // through the public API — `runConfidenceScorer` catches transport throws
  // internally and its remaining paths are throw-proof against provider input —
  // so no behavioral test gets there, and reverting the diagnostic line to the
  // old mask-after-`.slice(0, 300)` form leaves every confidence and redact test
  // green. Pin the contract at the source instead (the same pattern as the #518
  // ordering guard above). Every slice below is bounded by two anchors inside
  // this one confidence region, so an unrelated edit elsewhere in this ~2100-line
  // file cannot trip it.
  const source = readFileSync("src/run/review.ts", "utf8");
  const callStart = source.indexOf("confidenceOutcome = await runConfidenceScorer({");
  const callEnd = source.indexOf("const maskConfidenceText =");
  assert.ok(callStart !== -1, "review.ts must await runConfidenceScorer");
  assert.ok(callEnd > callStart, "review.ts must sanitize the canonical confidence result after the scorer call");
  const scorerCall = source.slice(callStart, callEnd);
  // Masking runs on the FULL untruncated message and only then applies the
  // 300-char cap, so a credential straddling the boundary cannot leave a
  // partial prefix in the artifact or the log line. Masking AFTER truncation did.
  assert.ok(scorerCall.includes("diagnostic: maskDiagnostic("), "the internal scorer-crash diagnostic must be built by maskDiagnostic");
  assert.equal(/\.slice\(\s*0\s*,/.test(scorerCall), false, "a mask-after-truncate form must not reappear inside the confidence scorer call");

  // Raw provider JSON reaches disk through `redactTextDeep`: configured-value
  // masking alone left a PROVIDER-authored credential (`api_key=…`, `Bearer …`,
  // `sk-…`) this run never configured persisted verbatim.
  for (const artifact of ["confidence-request.json", "confidence-response.json"]) {
    const at = source.indexOf(`ws.write("${artifact}"`);
    assert.ok(at !== -1, `review.ts must write ${artifact}`);
    const write = source.slice(at, source.indexOf(");", at));
    assert.ok(write.includes("redactTextDeep("), `${artifact} must be written through redactTextDeep`);
    assert.equal(write.includes("maskKnownSecretsDeep("), false, `${artifact} must not fall back to configured-value masking alone`);
  }
});
