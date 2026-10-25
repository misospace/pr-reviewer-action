import test from "node:test";
import assert from "node:assert/strict";
import {
  FINDINGS_SUMMARY_MAX_ROWS,
  REVIEW_STEP_OUTPUT_IDS,
  buildCacheHitRatioOutput,
  buildToolCallsOutput,
  formatOutputAssignment,
  formatReviewStepOutputs,
  renderFindingsSummary,
  renderStepSummary,
} from "../src/publish/outputs.js";
import type { StepSummaryTelemetry } from "../src/publish/outputs.js";

test("review step output IDs exactly match the kebab-case contract", () => {
  assert.deepEqual(REVIEW_STEP_OUTPUT_IDS, [
    "verdict", "verdict-source", "required-checks", "review-result", "incomplete-reason", "review-route", "escalation-reason",
    "review-triage-decision", "review-triage-reason", "review-triage-routing",
    "confidence-status", "confidence-score", "confidence-risk", "confidence-reason", "confidence-model",
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
    escalationReason: "", reviewTriageDecision: "", reviewTriageReason: "", reviewTriageRouting: "",
    findings: "[]", reviewMarkdown: "a\nb", analysisEngine: "engine",
    toolCalls: "[]", cacheHitRatio: "0.5",
  }, () => new Uint8Array(16).fill(0xab));
  // Parse assignment headers independent of whether their values are single or multiline.
  const headers = [...result.matchAll(/^([a-z][a-z-]*)(?:=|<<)/gm)].map((match) => match[1]);
  assert.deepEqual(headers, [
    "verdict", "verdict-source", "required-checks", "review-result", "incomplete-reason", "review-route", "escalation-reason",
    "review-triage-decision", "review-triage-reason", "review-triage-routing",
    "confidence-status", "confidence-score", "confidence-risk", "confidence-reason", "confidence-model",
    "review-markdown", "findings", "tool-calls", "cache-hit-ratio", "analysis-engine",
  ]);
  assert.ok(result.includes("review-result=clean\n"));
  assert.ok(result.includes("incomplete-reason=none\n"));
  assert.ok(result.includes("verdict-source=model\n"));
  assert.ok(result.includes("review-markdown<<EOF_"));
  assert.ok(!result.includes("verdict_source"));
  assert.ok(!result.includes("review_markdown"));
});

// #1003: the formatter is itself a public output boundary — it must not write
// an unsubstantiated `not_required` even if a caller hands it one. "" (triage
// did not run) stays "".
test("#1003: formatReviewStepOutputs fails an unsubstantiated not_required closed to unknown", () => {
  const base = {
    verdict: "approve", verdictSource: "model", requiredChecks: "complete", reviewResult: "clean", incompleteReason: "none", reviewRoute: "primary",
    escalationReason: "", findings: "[]", reviewMarkdown: "a", analysisEngine: "engine", toolCalls: "[]", cacheHitRatio: "-",
    reviewTriageRouting: "",
  };
  const bytes = (): Uint8Array => new Uint8Array(16).fill(0xab);

  const unsubstantiated = formatReviewStepOutputs({ ...base, reviewTriageDecision: "not_required", reviewTriageReason: "\u200B" }, bytes);
  assert.ok(unsubstantiated.includes("review-triage-decision=unknown\n"), unsubstantiated);
  assert.ok(!unsubstantiated.includes("review-triage-decision=not_required"));

  const substantiated = formatReviewStepOutputs({ ...base, reviewTriageDecision: "not_required", reviewTriageReason: "policy evidence" }, bytes);
  assert.ok(substantiated.includes("review-triage-decision=not_required\n"), substantiated);

  const didNotRun = formatReviewStepOutputs({ ...base, reviewTriageDecision: "", reviewTriageReason: "" }, bytes);
  assert.ok(didNotRun.includes("review-triage-decision=\n"), didNotRun);
});

// #1073: the confidence risk band is a closed enum, and `unknown` is one of
// its documented members — a SCORED answer whose risk band was not
// recognized reports `unknown`, never the empty value (which is reserved for
// a disabled scorer). A scored status with no risk at all still writes the
// empty value.
test("#1073: a scored confidence risk outside the closed enum writes unknown; an empty risk stays empty", () => {
  const base = {
    verdict: "approve", verdictSource: "model", requiredChecks: "complete", reviewResult: "clean", incompleteReason: "none", reviewRoute: "primary",
    escalationReason: "", reviewTriageDecision: "", reviewTriageReason: "", reviewTriageRouting: "",
    confidenceStatus: "scored", confidenceScore: "4", confidenceReason: "looks fine", confidenceModel: "scorer-model",
    findings: "[]", reviewMarkdown: "a", analysisEngine: "engine", toolCalls: "[]", cacheHitRatio: "-",
  };
  const bytes = (): Uint8Array => new Uint8Array(16).fill(0xab);

  const unknownRisk = formatReviewStepOutputs({ ...base, confidenceRisk: "unknown" }, bytes);
  assert.ok(unknownRisk.includes("confidence-status=scored\n"), unknownRisk);
  assert.ok(unknownRisk.includes("confidence-risk=unknown\n"), unknownRisk);

  const emptyRisk = formatReviewStepOutputs({ ...base, confidenceRisk: "" }, bytes);
  assert.ok(emptyRisk.includes("confidence-status=scored\n"), emptyRisk);
  assert.ok(emptyRisk.includes("confidence-risk=\n"), emptyRisk);
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

// ---------------------------------------------------------------------------
// Findings summary (#975) — the per-finding table shared by the strict
// publish body and the step summary.
// ---------------------------------------------------------------------------

test("findings summary renders the per-severity table with location and message", () => {
  const summary = renderFindingsSummary(
    [
      { severity: "blocker", file: "prom/x.yml", line: 12, message: "rule drops alerts" },
      { severity: "minor", file: "README.md", message: "typo" },
      { severity: "info", message: "no location" },
    ],
    "inert",
  );
  assert.ok(summary.includes("### Findings (1 blocker, 1 minor, 1 info)"));
  assert.ok(summary.includes("| Severity | Location | Finding |"));
  assert.ok(summary.includes("prom/x.yml:12"));
  assert.ok(summary.includes("README.md"));
  assert.ok(summary.includes("rule drops alerts"));
});

test("step summary is byte-identical with no findings key and with an empty findings array", () => {
  assert.equal(renderStepSummary(telemetry()), renderStepSummary(telemetry({ findings: [] })));
});

test("findings summary caps the table at the row limit and announces the remainder", () => {
  const findings = Array.from({ length: FINDINGS_SUMMARY_MAX_ROWS + 3 }, (_unused, i) => ({
    severity: "minor",
    message: `finding ${i}`,
  }));
  const summary = renderFindingsSummary(findings, "inert");
  const dataRows = summary.split("\n").filter((line) => line.startsWith("| Minor |"));
  assert.equal(dataRows.length, FINDINGS_SUMMARY_MAX_ROWS);
  assert.ok(summary.includes("_…and 3 more finding(s) not listed._"));
});

// #988: the findings-table message cell is the last column of a finding row.
// Every pipe inside it is escaped to a backslash-pipe by `escapeTableCell`, so
// a raw " | " (the column separator) never appears within the cell: it is
// everything after the final " | " separator, before the trailing " |".
function findingMessageCell(row: string): string {
  return row.slice(row.lastIndexOf(" | ") + 3, -2);
}

// #988: pin a cell is a well-formed, fence-safe inline-code span — equal
// opening/closing backtick runs, the delimiter one longer than any backtick
// run inside the body, so an embedded Markdown link or backtick payload cannot
// close the span early and render clickable. Same code-span-safety assertion
// style as equivalent-paths.test.ts (#252 "never break a code span").
function assertFencedCodeSpan(cell: string, payload: string): void {
  const openLen = cell.match(/^`+/)![0].length;
  const closeLen = /`+$/.exec(cell)![0].length;
  assert.equal(openLen, closeLen, "equal opening/closing backtick run lengths");
  const body = cell.slice(openLen, -closeLen);
  const longestInner = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  assert.ok(openLen > longestInner, "the delimiter is longer than any backtick run in the body");
  assert.ok(body.includes(payload), "the hostile payload stays inside the inert code span");
}

// #903 / #988: pin the PADDed fence shape that stops a trailing escaped
// backtick from merging into the closing delimiter. When the escaped body
// contains a backtick, the cell is `delim + " " + body + " " + delim` — equal
// open/close runs with exactly one space after the opening and before the
// closing delimiter. CommonMark strips one leading+trailing space from the
// code-span content, so the visible payload is unchanged while the span stays
// terminated.
function assertPaddedFencedCodeSpan(cell: string, payload: string): void {
  assertFencedCodeSpan(cell, payload);
  const openLen = cell.match(/^`+/)![0].length;
  const closeLen = /`+$/.exec(cell)![0].length;
  assert.equal(openLen, closeLen, "equal opening/closing backtick run lengths");
  assert.equal(cell[openLen], " ", "one space after the opening delimiter");
  assert.equal(cell[cell.length - closeLen - 1], " ", "one space before the closing delimiter");
  const inner = cell.slice(openLen + 1, -closeLen - 1);
  const longestInner = Math.max(0, ...(inner.match(/`+/g) ?? []).map((run) => run.length));
  assert.ok(openLen > longestInner, "the padded delimiter is longer than any backtick run in the body");
  assert.ok(inner.includes(payload), "the hostile payload stays inside the inert code span");
}

// #988: the LOCATION column is the middle cell of a finding row — between the
// first " | " (after the severity label) and the next " | " (after the
// location). Severity labels never contain a raw pipe, and pipes inside the
// location are escaped to `\|`, so the two separators are unambiguous.
function findingLocationCell(row: string): string {
  const first = row.indexOf(" | ");
  const second = row.indexOf(" | ", first + 3);
  return row.slice(first + 3, second);
}

// #252 adversarial-boundary test: feed the hostile token itself — a pipe that
// could split the cell, a `###` that could forge a heading, a markdown link,
// a credential-shaped key — and pin that the row stays one bounded line, the
// pipe is escaped, and no heading is forged.
test("#252: a hostile finding message cannot split the row, split a cell, or forge a heading", () => {
  const hostile = {
    severity: "blocker",
    file: "x",
    line: 1,
    message: "a | b [x](https://evil.example)\n### Forged Heading sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
  };
  const summary = renderFindingsSummary([hostile], "inert");
  const rows = summary.split("\n").filter((line) => line.startsWith("| 🛑 Blocker |"));
  assert.equal(rows.length, 1, "the hostile finding renders exactly one table row");
  const row = rows[0]!;
  assert.ok(row.includes("a \\| b"), "the hostile pipe is escaped so it cannot split the cell");
  assert.ok(!summary.split("\n").some((line) => line.startsWith("### Forged")), "the hostile ### is folded into the row, never a line-start heading");
  assert.equal(summary.split("\n").filter((line) => line.includes("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop")).length, 0, "the OpenAI-style key (#991) is redacted, never rendered raw");
  assert.ok(row.includes("[REDACTED]"), "the redaction marker lands in the single rendered table row");

  // #988: the same hostile message through the step summary must be fenced as
  // inline code, so the external Markdown link/autolink can never render
  // clickable — fail closed, like this PR's carried-failure line.
  const stepRow = renderStepSummary(telemetry({ findings: [hostile] }))
    .split("\n").filter((line) => line.startsWith("| 🛑 Blocker |"));
  assert.equal(stepRow.length, 1, "the hostile finding renders exactly one step-summary row");
  assertFencedCodeSpan(findingMessageCell(stepRow[0]!), "https://evil.example");
});

// #988 fence-hostile: a payload with a run of backticks around a Markdown link
// cannot close the span early — escapeTableCell turns each backtick into
// `\`` (breaking the run), so the generated delimiter stays one longer than any
// backtick run in the escaped body and the link renders inert.
test("#988: a backtick-ringed hostile link in the step summary cannot break the fence", () => {
  const hostile = {
    severity: "blocker",
    file: "x",
    line: 1,
    message: "x``[click](https://evil.example)",
  };
  const stepRow = renderStepSummary(telemetry({ findings: [hostile] }))
    .split("\n").filter((line) => line.startsWith("| 🛑 Blocker |"));
  assert.equal(stepRow.length, 1, "the backtick-ringed finding renders exactly one step-summary row");
  const cell = findingMessageCell(stepRow[0]!);
  // (a) the cell is fenced; (b) the opening delimiter is longer than the
  // longest backtick run in the cell body, so the payload cannot close the
  // span early and render https://evil.example as a clickable link.
  assertFencedCodeSpan(cell, "https://evil.example");
});

// #988 / #903: a message whose escaped body both STARTS and ENDS with a
// backtick (a backtick-ringed Markdown link) is the exact failure the no-
// padding fence had — the trailing escaped backtick merged into the closing
// delimiter, leaving the span unterminated and the link live. The space
// padding keeps the delimiter an equal, maximal run, so the span terminates
// and the payload renders inert.
test("#988: a backtick-ringed link (backticks at both ends) stays a terminated, inert span", () => {
  const hostile = {
    severity: "blocker",
    file: "x",
    line: 1,
    message: "`[click](https://evil.example)`",
  };
  const stepRow = renderStepSummary(telemetry({ findings: [hostile] }))
    .split("\n").filter((line) => line.startsWith("| 🛑 Blocker |"));
  assert.equal(stepRow.length, 1, "the both-ends-backtick finding renders exactly one step-summary row");
  const cell = findingMessageCell(stepRow[0]!);
  assertFencedCodeSpan(cell, "https://evil.example");
  assertPaddedFencedCodeSpan(cell, "https://evil.example");
});

// #988 / #903: a trailing backtick immediately after a bare autolink. The
// autolink is a bare URL (no brackets), but the trailing escaped backtick still
// merged into the closing delimiter without the padding, leaving the URL live.
test("#988: a trailing backtick after a bare autolink stays a terminated, inert span", () => {
  const hostile = {
    severity: "blocker",
    file: "x",
    line: 1,
    message: "see https://evil.example`",
  };
  const stepRow = renderStepSummary(telemetry({ findings: [hostile] }))
    .split("\n").filter((line) => line.startsWith("| 🛑 Blocker |"));
  assert.equal(stepRow.length, 1, "the trailing-backtick autolink renders exactly one step-summary row");
  const cell = findingMessageCell(stepRow[0]!);
  assertFencedCodeSpan(cell, "https://evil.example");
  assertPaddedFencedCodeSpan(cell, "https://evil.example");
});

// #988 / #903: the same trailing-backtick boundary in the LOCATION column, not
// just the message column — the file value is model-controlled, and a backtick
// at the end of the path would merge into the closing delimiter the same way.
test("#988: a backtick-bearing location path stays a terminated, inert span", () => {
  const hostile = {
    severity: "blocker",
    file: "[x](https://evil.example)`",
  };
  const stepRow = renderStepSummary(telemetry({ findings: [hostile] }))
    .split("\n").filter((line) => line.startsWith("| 🛑 Blocker |"));
  assert.equal(stepRow.length, 1, "the backtick-bearing location renders exactly one step-summary row");
  const cell = findingLocationCell(stepRow[0]!);
  assertFencedCodeSpan(cell, "https://evil.example");
  assertPaddedFencedCodeSpan(cell, "https://evil.example");
});

// ---------------------------------------------------------------------------
// #1230: the publish-side cut of the confidence reason must never leave a
// MODEL-AUTHORED cap-note look-alike at the published trailing edge.
// ---------------------------------------------------------------------------

// The REAL note template and a REAL cap token — the adversarial payload is
// the vocabulary itself, not a paraphrase of it.
const CONF_CAP_TOKEN = "blocker_cap_2";
const CONF_CAP_LOOKALIKE = ` [deterministic cap: ${CONF_CAP_TOKEN}]`;
/** The publish-side cap both public surfaces cut the confidence reason at. */
const CONF_PUBLISH_CAP = 300;

function confidenceSummaryRow(reason: string): string {
  const summary = renderStepSummary(telemetry({
    confidence: { status: "scored", score: "4", risk: "low", reason, model: "scorer-model" },
  }));
  const rows = summary.split("\n").filter((line) => line.startsWith("| Independent confidence |"));
  assert.equal(rows.length, 1, `the confidence row renders exactly once: ${summary}`);
  return rows[0]!;
}

/** The published reason inside the compact confidence row. */
function confidenceRowReason(row: string): string {
  const match = /— (.*) \(advisory only\) \|$/.exec(row);
  assert.ok(match, row);
  return match[1]!;
}

// #1230: the step-summary confidence row is a PUBLIC surface, and its 300-char
// cut is TIGHTER than the confidence module's own 600-char bound — so the cut
// can drag an INTERIOR look-alike onto the trailing edge. The published
// trailing edge must never read as the action-owned note.
test("#1230: the step summary confidence row never ends in a model-authored cap-note look-alike", () => {
  // (a) the cut lands exactly on the look-alike's closing "]": the whole
  // look-alike is revealed COMPLETE at the trailing edge.
  const completeHead = "x".repeat(CONF_PUBLISH_CAP - CONF_CAP_LOOKALIKE.length);
  const complete = `${completeHead}${CONF_CAP_LOOKALIKE} and the model kept talking after it`;
  assert.equal(complete.slice(0, CONF_PUBLISH_CAP), `${completeHead}${CONF_CAP_LOOKALIKE}`);
  const completeRow = confidenceSummaryRow(complete);
  assert.ok(!completeRow.includes("[deterministic cap:"), completeRow);
  assert.ok(!completeRow.includes(CONF_CAP_TOKEN), completeRow);
  assert.ok(completeRow.includes(`— ${completeHead} (advisory only) |`), completeRow);

  // (b) the look-alike STRADDLES the cut: the template opens before the
  // 300-char boundary and closes after it, so the cut leaves an unterminated
  // fragment at the trailing edge.
  const fragment = " [deterministic cap: yyy";
  const straddleHead = "x".repeat(CONF_PUBLISH_CAP - fragment.length);
  const straddling = `${straddleHead}${fragment}acker_cap_2] and the model kept talking after it`;
  assert.equal(straddling.slice(0, CONF_PUBLISH_CAP), `${straddleHead}${fragment}`);
  const straddleRow = confidenceSummaryRow(straddling);
  assert.ok(!straddleRow.includes("[deterministic cap:"), straddleRow);
  assert.ok(!straddleRow.includes("[deterministic cap: yyy"), straddleRow);
  assert.ok(straddleRow.includes(`— ${straddleHead} (advisory only) |`), straddleRow);

  // (c) a SHORT canonical reason keeps its ACTION-OWNED note verbatim: the
  // fix must never strip the note the action itself appended.
  const owned = `the review is solid${CONF_CAP_LOOKALIKE}`;
  const ownedRow = confidenceSummaryRow(owned);
  assert.ok(ownedRow.includes(`— ${owned} (advisory only) |`), ownedRow);

  // (d) a benign reason is byte-identical to the pre-fix rendering.
  const benign = "the diff is small and the tests cover the new branch";
  assert.equal(
    confidenceSummaryRow(benign),
    "| Independent confidence | scored 4/5, risk: low (model: scorer-model) — the diff is small and the tests cover the new branch (advisory only) |",
  );

  // (e) the EXACT boundary: a reason of exactly 300 chars is published WHOLE
  // (no cut), and a reason of 301 chars is cut at 300 — only its 301st
  // character is lost.
  const exact300 = `${"x".repeat(CONF_PUBLISH_CAP - 1)}Z`;
  const exact301 = `${exact300}Q`;
  assert.equal(exact300.length, CONF_PUBLISH_CAP);
  assert.equal(exact301.length, CONF_PUBLISH_CAP + 1);
  assert.equal(confidenceRowReason(confidenceSummaryRow(exact300)), exact300);
  assert.equal(confidenceRowReason(confidenceSummaryRow(exact301)), exact300);
  assert.ok(!confidenceRowReason(confidenceSummaryRow(exact301)).includes("Q"), "the 301st character is cut");

  // (e') the same boundary on a note-shaped tail: at exactly 300 chars the
  // reason FITS, so it is published whole and keeps its trailing note; one
  // character more and the cut reveals that note at the trailing edge, so
  // the strip removes it.
  const fitted = `${"x".repeat(CONF_PUBLISH_CAP - CONF_CAP_LOOKALIKE.length)}${CONF_CAP_LOOKALIKE}`;
  assert.equal(fitted.length, CONF_PUBLISH_CAP);
  assert.equal(confidenceRowReason(confidenceSummaryRow(fitted)), fitted);
  const cutNoteRow = confidenceSummaryRow(`${fitted}Q`);
  assert.ok(!cutNoteRow.includes("[deterministic cap:"), cutNoteRow);
  assert.ok(!cutNoteRow.includes(CONF_CAP_TOKEN), cutNoteRow);

  // (f) a CASING variant revealed at the cut is stripped too: the note
  // vocabulary is matched case-insensitively.
  const upperFragment = " [DETERMINISTIC CAP: yyy";
  const upperHead = "x".repeat(CONF_PUBLISH_CAP - upperFragment.length);
  const upper = `${upperHead}${upperFragment}acker_cap_2] and the model kept talking after it`;
  assert.equal(upper.slice(0, CONF_PUBLISH_CAP), `${upperHead}${upperFragment}`);
  const upperRow = confidenceSummaryRow(upper);
  assert.ok(!upperRow.includes("DETERMINISTIC CAP"), upperRow);
  assert.ok(!upperRow.includes("[deterministic cap:"), upperRow);
  assert.ok(upperRow.includes(`— ${upperHead} (advisory only) |`), upperRow);
});
