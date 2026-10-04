import test from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_STEP_OUTPUT_IDS,
  buildCacheHitRatioOutput,
  buildToolCallsOutput,
  formatOutputAssignment,
  formatReviewStepOutputs,
  renderStepSummary,
} from "../src/publish/outputs.js";
import type { StepSummaryTelemetry } from "../src/publish/outputs.js";

test("review step output IDs exactly match the kebab-case contract", () => {
  assert.deepEqual(REVIEW_STEP_OUTPUT_IDS, [
    "verdict", "verdict-source", "required-checks", "review-result", "incomplete-reason", "review-route", "escalation-reason",
    "findings", "review-markdown", "analysis-engine", "tool-calls", "cache-hit-ratio",
  ]);
  for (const id of REVIEW_STEP_OUTPUT_IDS) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(!id.includes("_"));
  }
});

test("output assignment keeps single lines direct and multiline values collision-safe", () => {
  const bytes = [
    new Uint8Array(16).fill(0x11),
    new Uint8Array(16).fill(0x22),
  ];
  const randomBytes = () => bytes.shift()!;
  assert.equal(formatOutputAssignment("verdict", "approve", randomBytes), "verdict=approve\n");
  const value = "line one\nlooks like EOF_1234 text\nline three";
  const first = formatOutputAssignment("review-markdown", value, randomBytes);
  const second = formatOutputAssignment("findings", "one\ntwo", randomBytes);
  const delimiterOf = (assignment: string, key: string): string => {
    const match = new RegExp(`^${key}<<([^\\n]+)$`, "m").exec(assignment);
    assert.ok(match);
    return match[1]!;
  };
  const delimiter1 = delimiterOf(first, "review-markdown");
  const delimiter2 = delimiterOf(second, "findings");
  assert.notEqual(delimiter1, delimiter2);
  assert.ok(!value.split("\n").includes(delimiter1));
  const lines = first.split("\n");
  assert.equal(lines[0], `review-markdown<<${delimiter1}`);
  assert.deepEqual(lines.slice(1, -2), value.split("\n"));
  assert.equal(lines.at(-2), delimiter1);
  assert.equal(lines.at(-1), "");
});

test("review output formatting serializes all keys in contract order with kebab-case names", () => {
  const result = formatReviewStepOutputs({
    verdict: "approve", verdictSource: "model", requiredChecks: "complete", reviewResult: "clean", incompleteReason: "none", reviewRoute: "primary",
    escalationReason: "", findings: "[]", reviewMarkdown: "a\nb", analysisEngine: "engine",
    toolCalls: "[]", cacheHitRatio: "0.5",
  }, () => new Uint8Array(16).fill(0xab));
  // Parse assignment headers independent of whether their values are single or multiline.
  const headers = [...result.matchAll(/^([a-z][a-z-]*)(?:=|<<)/gm)].map((match) => match[1]);
  assert.deepEqual(headers, [
    "verdict", "verdict-source", "required-checks", "review-result", "incomplete-reason", "review-route", "escalation-reason",
    "review-markdown", "findings", "tool-calls", "cache-hit-ratio", "analysis-engine",
  ]);
  assert.ok(result.includes("review-result=clean\n"));
  assert.ok(result.includes("incomplete-reason=none\n"));
  assert.ok(result.includes("verdict-source=model\n"));
  assert.ok(result.includes("review-markdown<<EOF_"));
  assert.ok(!result.includes("verdict_source"));
  assert.ok(!result.includes("review_markdown"));
});

test("tool calls compact primary and smart harness traces; missing traces are empty", () => {
  assert.equal(buildToolCallsOutput(
    { tool_calls: [{ tool: "git_status_short", status: "ok", args: "omit" }, { tool: "git_diff_stat", status: "error" }, { status: "ignored" }] },
    { tool_calls: [{ tool: "git_diff_name_only", status: "ok" }] },
  ), JSON.stringify([
    { tier: "primary", tool: "git_status_short", status: "ok" },
    { tier: "primary", tool: "git_diff_stat", status: "error" },
    { tier: "smart", tool: "git_diff_name_only", status: "ok" },
  ]));
  assert.equal(buildToolCallsOutput(undefined, null), "[]");
  assert.equal(buildToolCallsOutput({ tool_calls: [] }, {}), "[]");
});

test("cache-hit ratio is stringified or absent as dash", () => {
  assert.equal(buildCacheHitRatioOutput({ usage: { cache_hit_ratio: 0.75 } }), "0.75");
  assert.equal(buildCacheHitRatioOutput({}), "-");
});

function telemetry(overrides: Partial<StepSummaryTelemetry> = {}): StepSummaryTelemetry {
  return {
    analysisEngine: "engine-x", verdict: "approve", verdictSource: "model", findingsCount: 3,
    blockersCount: 1, requiredChecksStatus: "complete", requirementCoverage: { total: 2, unknown: 1 },
    primaryTools: {
      executedRequestCount: 4, successfulToolCalls: 3, rounds: 2, stopReason: "complete",
      budget: { route: "primary", used: 4, effectiveMaxRequests: "6", source: "policy", stopReason: "limit", remainingAtStop: "2" },
    },
    smartTools: {
      issuedToolCalls: 2, rounds: 1, requests: 3, stopReason: "complete", verdictStatus: "clean", fallback: "none",
      budget: { route: "smart", used: 2, effectiveMaxRequests: "3", source: "default", stopReason: "done", remainingAtStop: "1" },
    },
    nativeVerdict: { status: "submitted", transport: "github", attempts: 2, retried: true, reason: "retry" },
    route: "deep", routeReason: "escalated", deepReview: { leads: "3", errors: true, autoSelection: { selected: 2, skipped: 1 } },
    budget: "large", finalContext: "20k", primaryContext: "12k", diffBytes: { actual: "100", truncated: "80" },
    corpusBytes: { actual: "200", truncated: "180" }, promptTokens: "400", cacheHitRatio: "0.25", completionTokens: "50",
    ...overrides,
  };
}

test("step summary renders every supplied row in v2 order", () => {
  const summary = renderStepSummary(telemetry());
  const rows = [
    "| Engine |", "| Verdict |", "| Findings |", "| Required checks |", "| Requirement coverage |",
    "| Primary tools |", "| Smart tools |", "| Native verdict |", "| Route |", "| Tool budget |",
    "| Deep review |", "| Budget |", "| Final context |", "| Primary context |", "| Diff bytes |",
    "| Corpus bytes |", "| Prompt tokens |", "| Cache hit ratio |", "| Completion tokens |",
  ];
  let lastIndex = -1;
  for (const row of rows) {
    const index = summary.indexOf(row);
    assert.ok(index > lastIndex, `${row} should appear after the previous row`);
    lastIndex = index;
  }
  assert.ok(summary.includes("| Tool budget | primary: 4/6 requests (policy), stop: limit, left 2; smart: 2/3 requests (default), stop: done, left 1 |"));
});

test("step summary omits only conditional rows when telemetry is absent", () => {
  const sparse = telemetry({
    requirementCoverage: { total: 0, unknown: 0 }, cacheHitRatio: "-",
    primaryTools: { executedRequestCount: 1 },
  });
  delete sparse.smartTools;
  delete sparse.nativeVerdict;
  delete sparse.deepReview;
  delete sparse.primaryContext;
  const summary = renderStepSummary(sparse);
  for (const absent of ["| Requirement coverage |", "| Smart tools |", "| Native verdict |", "| Deep review |", "| Primary context |", "| Tool budget |", "| Cache hit ratio |"]) {
    assert.ok(!summary.includes(absent), `${absent} should be omitted`);
  }
  assert.ok(summary.includes("| Primary tools | 1 executed (0 successful); rounds: 0; stop: disabled |"));
});
