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
  const metrics = new AdminMetricsRegistry({ maxSeries: 2, allowedModels: ["a", "b", "c"] });
  metrics.recordModelRequest("a");
  metrics.recordModelRequest("b");
  metrics.recordModelRequest("c");
  assert.equal(metrics.seriesCount, 2);
  metrics.recordModelRequest("a");
  metrics.recordFailure("provider");
  const text = metrics.renderPrometheus();
  assert.match(text, /pr_reviewer_admin_metrics_overflow_total 3/);
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
