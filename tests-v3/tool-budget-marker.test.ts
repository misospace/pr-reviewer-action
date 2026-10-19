import test from "node:test";
import assert from "node:assert/strict";
import { buildMetadataMarker } from "../src/precheck/metadata.js";
import { buildRunMetadataMarker } from "../src/metadata/markers.js";
import { toolBudgetTelemetryOf } from "../src/run/review.js";

// ---------------------------------------------------------------------------
// #847 — the metadata marker records the #810/#702 tool-budget provenance
// (tool_budget, tool_budget_source, tool_calls) on every review, additively,
// so #810's size-scaled default can be measured from published reviews
// without needing the tool-harness artifact.
// ---------------------------------------------------------------------------

test("#847: buildMetadataMarker omits the tool-budget keys when unset (byte-identical to pre-#847)", () => {
  const marker = buildMetadataMarker({ head_sha: "h", base_sha: "b", review_result: "clean" });
  assert.equal(marker, '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"clean"} -->');
});

test("#847: buildMetadataMarker appends tool_budget/tool_budget_source/tool_calls last, after the #810/#812 keys", () => {
  const marker = buildMetadataMarker({
    head_sha: "h",
    base_sha: "b",
    review_result: "issues",
    coverage: "partial",
    coverage_stop_reason: "tool-call-budget-exhausted",
    ci_state: "failure",
    tool_budget: 26,
    tool_budget_source: "size-scaled",
    tool_calls: 26,
  });
  assert.equal(
    marker,
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"issues",' +
      '"coverage":"partial","coverage_stop_reason":"tool-call-budget-exhausted","ci_state":"failure",' +
      '"tool_budget":26,"tool_budget_source":"size-scaled","tool_calls":26} -->',
  );
});

test("#847: a zero tool_budget/tool_calls is recorded, not treated as absent", () => {
  const marker = buildMetadataMarker({
    head_sha: "h", base_sha: "b", review_result: "clean", tool_budget: 0, tool_calls: 0,
  });
  assert.match(marker, /"tool_budget":0/);
  assert.match(marker, /"tool_calls":0/);
});

test("#847: buildRunMetadataMarker wires toolBudget/toolBudgetSource/toolCalls through additively", () => {
  const marker = buildRunMetadataMarker({
    headSha: "h",
    baseSha: "b",
    reviewResult: "clean",
    toolBudget: 16,
    toolBudgetSource: "tier-default",
    toolCalls: 3,
  });
  assert.match(marker, /"tool_budget":16/);
  assert.match(marker, /"tool_budget_source":"tier-default"/);
  assert.match(marker, /"tool_calls":3/);
});

test("#847: buildRunMetadataMarker omits the tool-budget keys entirely when no harness ran", () => {
  const marker = buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "clean" });
  assert.doesNotMatch(marker, /tool_budget/);
  assert.doesNotMatch(marker, /tool_calls/);
});

// ---------------------------------------------------------------------------
// #895 — tool_rounds/max_rounds record the loop's round usage next to
// tool_budget/tool_calls, additively (appended last).
// ---------------------------------------------------------------------------

test("#895: buildMetadataMarker appends tool_rounds/max_rounds last, after tool_calls", () => {
  const marker = buildMetadataMarker({
    head_sha: "h",
    base_sha: "b",
    review_result: "clean",
    tool_budget: 32,
    tool_budget_source: "size-scaled",
    tool_calls: 30,
    tool_rounds: 15,
    max_rounds: 16,
  });
  assert.equal(
    marker,
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"clean",' +
      '"tool_budget":32,"tool_budget_source":"size-scaled","tool_calls":30,"tool_rounds":15,"max_rounds":16} -->',
  );
});

test("#895: a zero tool_rounds is recorded, not treated as absent", () => {
  const marker = buildMetadataMarker({ head_sha: "h", base_sha: "b", review_result: "clean", tool_rounds: 0, max_rounds: 16 });
  assert.match(marker, /"tool_rounds":0/);
  assert.match(marker, /"max_rounds":16/);
});

test("#895: buildRunMetadataMarker wires toolRounds/maxRounds through additively", () => {
  const marker = buildRunMetadataMarker({
    headSha: "h",
    baseSha: "b",
    reviewResult: "clean",
    toolRounds: 12,
    maxRounds: 16,
  });
  assert.match(marker, /"tool_rounds":12/);
  assert.match(marker, /"max_rounds":16/);
});

test("#895: buildRunMetadataMarker omits tool_rounds/max_rounds when unset", () => {
  const marker = buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "clean" });
  assert.doesNotMatch(marker, /tool_rounds/);
  assert.doesNotMatch(marker, /max_rounds/);
});

// ---------------------------------------------------------------------------
// #847 (measurement follow-up) — tool_stop_reason records the loop's stop
// reason on EVERY harness run, so a budget stop with complete coverage
// (no `coverage`/`coverage_stop_reason` gap) is still measurable.
// ---------------------------------------------------------------------------

test("#847: buildMetadataMarker appends tool_stop_reason last, after the #978 key", () => {
  const marker = buildMetadataMarker({
    head_sha: "h",
    base_sha: "b",
    review_result: "clean",
    tool_budget: 26,
    tool_budget_source: "size-scaled",
    tool_calls: 26,
    degradedGateBypass: true,
    tool_stop_reason: "tool-call-budget-exhausted",
  });
  assert.equal(
    marker,
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"clean",' +
      '"tool_budget":26,"tool_budget_source":"size-scaled","tool_calls":26,' +
      '"degraded_gate_bypass":true,"tool_stop_reason":"tool-call-budget-exhausted"} -->',
  );
});

test("#847: buildMetadataMarker omits tool_stop_reason when unset (byte-identical)", () => {
  const marker = buildMetadataMarker({
    head_sha: "h", base_sha: "b", review_result: "clean", tool_budget: 26, tool_calls: 26,
  });
  assert.doesNotMatch(marker, /tool_stop_reason/);
});

test("#847: buildRunMetadataMarker wires toolStopReason through additively", () => {
  const marker = buildRunMetadataMarker({
    headSha: "h",
    baseSha: "b",
    reviewResult: "clean",
    toolBudget: 16,
    toolBudgetSource: "tier-default",
    toolCalls: 16,
    toolStopReason: "max-rounds",
  });
  assert.match(marker, /"tool_stop_reason":"max-rounds"/);
});

test("#847: buildRunMetadataMarker omits tool_stop_reason when no harness reported one", () => {
  const marker = buildRunMetadataMarker({ headSha: "h", baseSha: "b", reviewResult: "clean" });
  assert.doesNotMatch(marker, /tool_stop_reason/);
});

test("#847: toolBudgetTelemetryOf lifts the top-level stop_reason", () => {
  const lifted = toolBudgetTelemetryOf({ stop_reason: "tool-call-budget-exhausted" });
  assert.equal(lifted.stopReason, "tool-call-budget-exhausted");
});

test("#847: toolBudgetTelemetryOf falls back to the #702 telemetry stop_reason (pre-loop harness-abort)", () => {
  // A pre-loop abort artifact carries no top-level stop_reason; its
  // "harness-abort" lives only in the buildToolLoopTelemetry pre-loop shape.
  const lifted = toolBudgetTelemetryOf({
    tool_request_budget: 16,
    tool_loop_telemetry: { phase: "pre-loop", stop_reason: "harness-abort" },
  });
  assert.equal(lifted.stopReason, "harness-abort");
});

test("#847: the top-level stop_reason wins over the nested telemetry value", () => {
  const lifted = toolBudgetTelemetryOf({
    stop_reason: "max-rounds",
    tool_loop_telemetry: { phase: "loop", stop_reason: "max-rounds" },
  });
  assert.equal(lifted.stopReason, "max-rounds");
});

test("#847: an empty nested stop_reason is treated as absent", () => {
  const lifted = toolBudgetTelemetryOf({ tool_loop_telemetry: { phase: "loop", stop_reason: "" } });
  assert.equal(lifted.stopReason, undefined);
});

// ---------------------------------------------------------------------------
// #1073 — the confidence scorer's marker keys are strictly additive. A
// disabled (or skipped) run must serialize byte-identically to the pre-#1073
// marker: neither `confidence_status` nor `confidence_score` may appear.
// Direct unit coverage — `tests-v3/run-confidence.test.ts` pins the same
// invariant end-to-end through a real run.
// ---------------------------------------------------------------------------
const CONF_BASE = {
  headSha: "h",
  baseSha: "b",
  reviewResult: "issues",
  requiredChecks: "build",
  reviewRoute: "primary",
  cacheHitRatio: "0.5",
  coverage: "complete",
  ciState: "pending",
  actionVersion: "v3.6.0",
} as const;

test("#1073: a disabled confidence run omits both marker keys (byte-identical pre-#1073)", () => {
  const disabled = buildRunMetadataMarker({ ...CONF_BASE });
  assert.equal(disabled, buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus: "" }));
  assert.equal(
    disabled,
    '<!-- ai-pr-reviewer:{"version":1,"head_sha":"h","base_sha":"b","review_result":"issues","required_checks":"build","review_route":"primary","cache_hit_ratio":0.5,"coverage":"complete","ci_state":"pending","action_version":"v3.6.0"} -->',
  );
  assert.ok(!disabled.includes("confidence_status"));
  assert.ok(!disabled.includes("confidence_score"));
});

test("#1073: an empty or unrecognized confidence status is omitted, never serialized as \"\"", () => {
  // The omission must be decided by the call site (null), not by the builder's
  // empty-string clause — otherwise a tightened builder guard would silently
  // add `"confidence_status":""` to every disabled run's public marker.
  for (const confidenceStatus of ["", "  ", "disabled", "unknown", "SCORED"]) {
    const marker = buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus });
    assert.ok(!marker.includes("confidence"), `status ${JSON.stringify(confidenceStatus)} leaked into the marker`);
  }
});

test("#1073: a score with no scored status is dropped rather than emitted alone", () => {
  // A stray score must not make it into the marker without its status.
  const marker = buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus: "unscored", confidenceScore: 5 });
  assert.ok(marker.includes('"confidence_status":"unscored"'));
  assert.ok(!marker.includes("confidence_score"));
});

test("#1073: unscored keeps the status key and adds no score key", () => {
  const marker = buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus: "unscored" });
  assert.ok(marker.endsWith('"confidence_status":"unscored"} -->'));
});

test("#1073: scored appends status then score, last, after every pre-#1073 key", () => {
  const marker = buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus: "scored", confidenceScore: 4 });
  assert.ok(
    marker.endsWith('"action_version":"v3.6.0","confidence_status":"scored","confidence_score":4} -->'),
  );
});

test("#1073: an out-of-range or non-integer score fails closed to no score key", () => {
  for (const confidenceScore of [999, -1, 6, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const marker = buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus: "scored", confidenceScore });
    assert.ok(
      marker.includes('"confidence_status":"scored"') && !marker.includes("confidence_score"),
      `score ${String(confidenceScore)} was not dropped`,
    );
  }
});

test("#1073: enabling the scorer never moves a pre-#1073 key's position", () => {
  const off = buildRunMetadataMarker({ ...CONF_BASE });
  const on = buildRunMetadataMarker({ ...CONF_BASE, confidenceStatus: "scored", confidenceScore: 0 });
  const strip = (m: string) => m.replace(/,"confidence_status":"scored","confidence_score":0/, "");
  assert.equal(strip(on), off);
});
