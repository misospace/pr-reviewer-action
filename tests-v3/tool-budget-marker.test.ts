import test from "node:test";
import assert from "node:assert/strict";
import { buildMetadataMarker } from "../src/precheck/metadata.js";
import { buildRunMetadataMarker } from "../src/metadata/markers.js";

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
