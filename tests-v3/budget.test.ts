import test from "node:test";
import assert from "node:assert/strict";
import { resolveToolMaxRequests } from "../src/tools/budget.js";

test("primary override wins on the primary route only and reports its source", () => {
  const primary = resolveToolMaxRequests("primary", { PRIMARY_TOOL_MAX_REQUESTS: "12", TOOL_MAX_REQUESTS: "3" });
  assert.deepEqual(primary, { route: "primary", budget: 12, source: "primary-override", configured: 12 });
  const smart = resolveToolMaxRequests("smart", { PRIMARY_TOOL_MAX_REQUESTS: "12" });
  assert.deepEqual(smart, { route: "smart", budget: 16, source: "tier-default", configured: null });
  const invalid = resolveToolMaxRequests("primary", { PRIMARY_TOOL_MAX_REQUESTS: "abc", TOOL_MAX_REQUESTS: "7" });
  assert.equal(invalid.source, "explicit");
  assert.equal(invalid.budget, 7);
});
