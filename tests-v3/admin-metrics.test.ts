/** Bounded-cardinality admin metrics. */
import test from "node:test";
import assert from "node:assert/strict";
import { AdminMetricsRegistry } from "../src/admin/metrics.js";

test("fixed enums reject arbitrary labels and allowlists collapse overflow", () => {
  const metrics = new AdminMetricsRegistry({ allowedModels: ["route-a"], allowlistCap: 1 });
  metrics.recordVerdict("head-sha-abcdef1234567");
  metrics.recordModelRequest("route-a");
  metrics.recordModelRequest("private-route");
  const text = metrics.renderPrometheus();
  assert.match(text, /verdict="other"/);
  assert.match(text, /model="route-a"/);
  assert.match(text, /model="other"/);
  assert.doesNotMatch(text, /private-route|abcdef1234567/);
});

test("series cap uses one overflow counter without creating more series", () => {
  // The registry pre-creates THREE fixed zero-label counters (overflow,
  // audit failures, and the #1349 MCP auth-failure counter), so the cap
  // must leave room for them plus the series under test; the assertion is
  // that the cap itself creates no new series.
  const metrics = new AdminMetricsRegistry({ maxSeries: 6, allowedModels: ["a", "b", "c"] });
  metrics.recordModelRequest("a");
  metrics.recordModelRequest("b");
  metrics.recordModelRequest("c");
  assert.equal(metrics.seriesCount, 6);
  metrics.recordModelRequest("a");
  metrics.recordFailure("provider");
  const text = metrics.renderPrometheus();
  assert.match(text, /pr_reviewer_admin_metrics_overflow_total 1/);
});
test("audit-failure counter stays recordable when the series cap is full", () => {
  // The cap is already entirely consumed by the pre-created fixed
  // counters, so this is the exact shape the review flagged: an audit-sink
  // failure must still be recorded, not only as an overflow bump.
  const metrics = new AdminMetricsRegistry({ maxSeries: 3 });
  metrics.bumpAuditFailure();
  metrics.bumpAuditFailure();
  const text = metrics.renderPrometheus();
  assert.match(text, /pr_reviewer_admin_audit_failures_total 2/);
  assert.doesNotMatch(text, /pr_reviewer_admin_metrics_overflow_total [1-9]/);
});
test("mcp auth-failure counter stays recordable when the series cap is full (#1349)", () => {
  // Same shape as the audit-failure counter: a flood of denied MCP
  // requests is exactly when the counter matters most, so it is
  // pre-created and recordable even when every series slot is taken.
  const metrics = new AdminMetricsRegistry({ maxSeries: 3 });
  metrics.recordMcpAuthFailure();
  metrics.recordMcpAuthFailure();
  const text = metrics.renderPrometheus();
  assert.match(text, /pr_reviewer_admin_mcp_auth_failures_total 2/);
  assert.doesNotMatch(text, /pr_reviewer_admin_metrics_overflow_total [1-9]/);
});
test("mcp request outcomes render through the fixed enum (#1349)", () => {
  const metrics = new AdminMetricsRegistry();
  metrics.recordMcpRequest("ok");
  metrics.recordMcpRequest("denied");
  metrics.recordMcpRequest("ok");
  const text = metrics.renderPrometheus();
  assert.match(text, /pr_reviewer_admin_mcp_requests_total\{outcome="ok"\} 2/);
  assert.match(text, /pr_reviewer_admin_mcp_requests_total\{outcome="denied"\} 1/);
});
test("a cap of 1 holds only the overflow counter and never bumps it at construction", () => {
  const metrics = new AdminMetricsRegistry({ maxSeries: 1 });
  assert.equal(metrics.seriesCount, 1);
  assert.match(metrics.renderPrometheus(), /pr_reviewer_admin_metrics_overflow_total 0/);
});

test("tool-loop budget observability: requests, rounds, and stop reasons", () => {
  const metrics = new AdminMetricsRegistry();
  metrics.recordToolLoopRequests(24);
  metrics.recordToolLoopRounds(10);
  metrics.recordToolLoopRequests();
  metrics.recordToolStop("budget");
  const text = metrics.renderPrometheus();
  assert.match(text, /pr_reviewer_admin_tool_loop_requests_total 25/);
  assert.match(text, /pr_reviewer_admin_tool_loop_rounds_total 10/);
  assert.match(text, /pr_reviewer_admin_tool_stops_total\{stop_reason="budget"\} 1/);
  // Zero-label counters: no setter can attach an identifier to them.
  assert.doesNotMatch(text, /pr_reviewer_admin_tool_loop_(?:requests|rounds)_total\{/);
});

test("tool-loop counters refuse malformed amounts", () => {
  const metrics = new AdminMetricsRegistry();
  metrics.recordToolLoopRequests(-5);
  metrics.recordToolLoopRounds(Number.NaN);
  metrics.recordToolLoopRounds(Number.POSITIVE_INFINITY);
  // A refused update creates no series at all (only HELP/TYPE headers remain).
  const samples = metrics.renderPrometheus().split("\n").filter((line) => line !== "" && !line.startsWith("#"));
  assert.ok(!samples.some((line) => line.startsWith("pr_reviewer_admin_tool_loop_requests_total")));
  assert.ok(!samples.some((line) => line.startsWith("pr_reviewer_admin_tool_loop_rounds_total")));
});

test("all rendered samples have parseable name/value syntax", () => {
  const metrics = new AdminMetricsRegistry();
  metrics.recordUsage("primary", 10, 2, 1, 3);
  metrics.recordWebhook("accepted");
  metrics.observeReviewLatency("approve", 200);
  for (const line of metrics.renderPrometheus().split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?\s+-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/);
  }
});
