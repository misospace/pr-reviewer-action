import test from "node:test";
import assert from "node:assert/strict";
import { parseVerdictResponse } from "../src/model/verdict.js";
import { VerdictParseFailure } from "../src/model/types.js";

function openaiResponse(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { completion_tokens: 10 },
    ...extra,
  };
}

test("strict JSON verdict parses and canonicalizes the verdict", () => {
  const verdict = parseVerdictResponse(openaiResponse('{"verdict": "approve", "review_markdown": "## OK"}'));
  assert.equal(verdict.verdict, "approve");
  assert.equal(verdict.reviewMarkdown, "## OK");
  assert.deepEqual(verdict.findings, []);
});

test("verdict aliases normalize (case, whitespace, hyphens)", () => {
  for (const [raw, expected] of [
    ["Approve", "approve"], ["LGTM", "approve"], ["approved", "approve"],
    ["Request Changes", "request_changes"], ["REQUEST-CHANGES", "request_changes"],
    ["changes_requested", "request_changes"], ["reject", "request_changes"],
  ] as const) {
    const verdict = parseVerdictResponse(openaiResponse(`{"verdict": "${raw}", "review_markdown": "x"}`));
    assert.equal(verdict.verdict, expected, raw);
  }
});

test("fenced JSON with language tag parses; prose around JSON parses", () => {
  const fenced = parseVerdictResponse(openaiResponse("```json\n{\"verdict\": \"approve\", \"review_markdown\": \"ok\"}\n```"));
  assert.equal(fenced.verdict, "approve");
  const prose = parseVerdictResponse(openaiResponse("Here is my review:\n{\"verdict\": \"request_changes\", \"review_markdown\": \"fix it\"}\nThanks!"));
  assert.equal(prose.verdict, "request_changes");
});

test("a later complete verdict beats an earlier partial draft; last complete wins", () => {
  const draft = parseVerdictResponse(openaiResponse(
    'thinking: {"verdict": "approve"} then {"verdict": "request_changes", "review_markdown": "real"}',
  ));
  assert.equal(draft.verdict, "request_changes");
  const lastWins = parseVerdictResponse(openaiResponse(
    '{"verdict": "approve", "review_markdown": "first"}\n{"verdict": "request_changes", "review_markdown": "second"}',
  ));
  assert.equal(lastWins.verdict, "request_changes");
  assert.equal(lastWins.reviewMarkdown, "second");
});

test("a nested verdict dict inside an array never masquerades as top-level", () => {
  const verdict = parseVerdictResponse(openaiResponse(
    '[{"verdict": "approve", "review_markdown": "decoy"}] then {"verdict": "request_changes", "review_markdown": "real"}',
  ));
  assert.equal(verdict.verdict, "request_changes");
});

test("single-item list wrapper unwraps", () => {
  const verdict = parseVerdictResponse(openaiResponse('[{"verdict": "approve", "review_markdown": "ok"}]'));
  assert.equal(verdict.verdict, "approve");
});

test("raw newlines inside JSON string values are repaired on the second pass", () => {
  const verdict = parseVerdictResponse(openaiResponse('{\n"verdict": "approve",\n"review_markdown": "line1\nline2"\n}'));
  assert.equal(verdict.verdict, "approve");
  assert.equal(verdict.reviewMarkdown, "line1\nline2");
});

test("findings normalization: severity/category aliases, junk dropped, defaults applied", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "request_changes",
    review_markdown: "## Findings",
    findings: [
      { severity: "CRITICAL", category: "security", file: "./src/a.py", line: "12", message: "boom", preliminary_finding: 3 },
      { severity: "high", category: "weird", file: "src/b.py", line: 7.0, message: "hi" },
      { severity: 5, category: "bug", file: "c.py", line: true, message: "line-bool-dropped" },
      { severity: "minor", category: "style", file: "d.py", line: 7.5, message: "half-line" },
      { message: "" },
      "junk",
      { severity: "minor", path: "e.py", line: 0, message: "path-key, zero-line" },
      { summary: "summary-key message" },
    ],
  })));
  assert.deepEqual(verdict.findings, [
    { severity: "blocker", category: "security", file: "src/a.py", line: 12, message: "boom", preliminaryFinding: 3 },
    { severity: "major", category: "other", file: "src/b.py", line: 7, message: "hi" },
    { severity: "info", category: "bug", file: "c.py", line: null, message: "line-bool-dropped" },
    { severity: "minor", category: "style", file: "d.py", line: null, message: "half-line" },
    { severity: "minor", category: "other", file: "e.py", line: null, message: "path-key, zero-line" },
    { severity: "info", category: "other", file: null, line: null, message: "summary-key message" },
  ]);
});

test("findings cap at 50 and message cap at 2000 chars", () => {
  const many = Array.from({ length: 60 }, (_unused, i) => ({ message: `m${i}` }));
  const capped = parseVerdictResponse(openaiResponse(JSON.stringify({ verdict: "approve", review_markdown: "x", findings: many })));
  assert.equal(capped.findings.length, 50);
  const long = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve", review_markdown: "x",
    findings: [{ message: "a".repeat(3000) }],
  })));
  assert.equal(long.findings[0]!.message.length, 2000);
});

test("extra model keys pass through untouched", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve", review_markdown: "x", confidence: 0.9, custom_field: "keep",
  })));
  assert.equal(verdict.extra.confidence, 0.9);
  assert.equal(verdict.extra.custom_field, "keep");
});

test("#721: absent smart-review fields normalize to no request", () => {
  const verdict = parseVerdictResponse(openaiResponse('{"verdict": "approve", "review_markdown": "x"}'));
  assert.equal(verdict.smartReviewRequested, false);
  assert.equal(verdict.smartReviewReason, null);
  assert.equal("smart_review_requested" in verdict.extra, false);
  assert.equal("smart_review_reason" in verdict.extra, false);
});

test("#721: the JSON boolean true requests a smart review; reason is bounded", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    smart_review_requested: true,
    smart_review_reason: "uncertain\tabout\nthe\rstate machine\u001b[31m and " + "x".repeat(600),
  })));
  assert.equal(verdict.smartReviewRequested, true);
  const reason = verdict.smartReviewReason!;
  assert.ok(!reason.includes("\n") && !reason.includes("\t") && !reason.includes("\u001b"));
  assert.ok(reason.length <= 400);
});

test("#721: a request without a usable reason still parses as a request", () => {
  for (const reason of [undefined, null, "", "   ", 42]) {
    const payload: Record<string, unknown> = {
      verdict: "approve", review_markdown: "x", smart_review_requested: true,
    };
    if (reason !== undefined) payload.smart_review_reason = reason;
    const verdict = parseVerdictResponse(openaiResponse(JSON.stringify(payload)));
    assert.equal(verdict.smartReviewRequested, true);
    assert.equal(verdict.smartReviewReason, null);
  }
});

test("#721: malformed values never forge a request (type confusion is coerced to false)", () => {
  for (const raw of ["true", 1, null, [], {}]) {
    const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
      verdict: "approve", review_markdown: "x", smart_review_requested: raw,
    })));
    assert.equal(verdict.smartReviewRequested, false, JSON.stringify(raw));
    assert.equal(verdict.smartReviewReason, null);
  }
});

test("#721: prose inside review_markdown cannot forge the request", () => {
  const verdict = parseVerdictResponse(openaiResponse(
    '{"verdict": "approve", "review_markdown": "review body\\n\\n```json\\n{\\"smart_review_requested\\": true}\\n```"}',
  ));
  assert.equal(verdict.smartReviewRequested, false);
  assert.equal(verdict.smartReviewReason, null);
});

test("#721: a reason without a request is dropped", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve", review_markdown: "x",
    smart_review_requested: false, smart_review_reason: "orphan",
  })));
  assert.equal(verdict.smartReviewRequested, false);
  assert.equal(verdict.smartReviewReason, null);
});

test("invalid verdict fails with the v2 message", () => {
  assert.throws(() => parseVerdictResponse(openaiResponse('{"verdict": "maybe", "review_markdown": "x"}')), (error: unknown) => {
    assert.ok(error instanceof VerdictParseFailure);
    assert.equal(error.kind, "invalid_verdict");
    assert.equal(error.message, "Expected verdict to be 'approve' or 'request_changes', got 'maybe'");
    return true;
  });
});

test("missing keys fail with v2 messages", () => {
  assert.throws(() => parseVerdictResponse(openaiResponse('{"review_markdown": "x"}')), /missing required key 'verdict'/);
  assert.throws(() => parseVerdictResponse(openaiResponse('{"verdict": "approve"}')), /missing required key 'review_markdown'/);
});

test("empty review_markdown and flattened markdown fail validation", () => {
  assert.throws(() => parseVerdictResponse(openaiResponse('{"verdict": "approve", "review_markdown": "  "}')), /empty or missing 'review_markdown'/);
  assert.throws(() => parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve", review_markdown: "## A ## B",
  }))), (error: unknown) => {
    assert.ok(error instanceof VerdictParseFailure);
    assert.equal(error.kind, "flattened_markdown");
    return true;
  });
  // A single heading with no newlines is accepted; newlines defuse the guard.
  assert.doesNotThrow(() => parseVerdictResponse(openaiResponse(JSON.stringify({ verdict: "approve", review_markdown: "## One" }))));
  assert.doesNotThrow(() => parseVerdictResponse(openaiResponse(JSON.stringify({ verdict: "approve", review_markdown: "## A\n## B" }))));
});

test("truncated finish reasons append the v2 hint", () => {
  for (const reason of ["length", "max_tokens", "max_output_tokens"]) {
    assert.throws(() => parseVerdictResponse({
      choices: [{ message: { content: "{}" }, finish_reason: reason }],
      usage: { completion_tokens: 5 },
    }), (error: unknown) => {
      assert.ok(error instanceof VerdictParseFailure);
      assert.equal(error.truncated, true);
      assert.equal(error.message.endsWith("(model output appears truncated at the token limit; increase ai_max_tokens)"), true);
      return true;
    });
  }
});

test("empty content with zero completion tokens is the distinct empty-completion failure", () => {
  assert.throws(() => parseVerdictResponse(openaiResponse("", { usage: { completion_tokens: 0 } })), (error: unknown) => {
    assert.ok(error instanceof VerdictParseFailure);
    assert.equal(error.kind, "empty_completion");
    assert.equal(error.emptyCompletion, true);
    assert.equal(error.message, "Model returned an empty completion (0 completion tokens, finish_reason='stop'). Nothing to parse.");
    return true;
  });
  // No usage at all is NOT an empty completion (v2: usage must be present with 0).
  assert.throws(() => parseVerdictResponse(openaiResponse("")), /Expected JSON object but got NoneType/);
  // Anthropic output_tokens spelling is read too.
  assert.throws(() => parseVerdictResponse({ content: [], usage: { output_tokens: 0 }, stop_reason: "end_turn" }), (error: unknown) => {
    assert.ok(error instanceof VerdictParseFailure);
    assert.equal(error.kind, "empty_completion");
    return true;
  });
});

test("stream/endpoint errors are surfaced with the v2 message", () => {
  assert.throws(() => parseVerdictResponse({ error: { message: "overloaded" } }), (error: unknown) => {
    assert.ok(error instanceof VerdictParseFailure);
    assert.equal(error.kind, "endpoint_error");
    assert.equal(error.message, "Model endpoint returned an error: overloaded");
    return true;
  });
  assert.throws(() => parseVerdictResponse({ error: "boom" }), /Model endpoint returned an error: boom/);
});

test("non-object payloads fail with the v2 message", () => {
  assert.throws(() => parseVerdictResponse(openaiResponse("[1,2,3]")), (error: unknown) => {
    assert.ok(error instanceof VerdictParseFailure);
    assert.equal(error.message, "Expected JSON object but got list");
    return true;
  });
  assert.throws(() => parseVerdictResponse({ choices: [{ message: { content: 42 } }] }), /Expected JSON object but got NoneType/);
});

test("anthropic content blocks feed the parser (thinking blocks ignored)", () => {
  const verdict = parseVerdictResponse({
    content: [
      { type: "thinking", thinking: "{\"verdict\": \"approve\"}" },
      { type: "text", text: "{\"verdict\": \"request_changes\", \"review_markdown\": \"fix\"}" },
    ],
    usage: { output_tokens: 10 },
    stop_reason: "end_turn",
  });
  assert.equal(verdict.verdict, "request_changes");
});

test("#750: structured required-check dispositions normalize onto the parsed verdict", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    required_check_dispositions: [
      { check: "review for path traversal vulnerabilities", status: "not_applicable", rationale: "no untrusted path surface" },
      { check: "verify file path sanitization", status: "satisfied", rationale: "bounded to data root" },
      { check: "check secret rotation impact", status: "unresolved" },
      { check: "review auth flow for regression", status: "Satisfied", rationale: "case-normalized status" },
    ],
  })));
  assert.deepEqual(verdict.requiredCheckDispositions, [
    { check: "review for path traversal vulnerabilities", status: "not_applicable", rationale: "no untrusted path surface" },
    { check: "verify file path sanitization", status: "satisfied", rationale: "bounded to data root" },
    { check: "check secret rotation impact", status: "unresolved", rationale: null },
    { check: "review auth flow for regression", status: "satisfied", rationale: "case-normalized status" },
  ]);
  assert.equal("required_check_dispositions" in verdict.extra, false);
});

test("#750: tri-state — true absence is distinguishable from an explicit null", () => {
  const absent = parseVerdictResponse(openaiResponse('{"verdict": "approve", "review_markdown": "x"}'));
  assert.equal(absent.requiredCheckDispositionsEmitted, false);
  assert.equal(absent.requiredCheckDispositions, null);
  assert.equal("required_check_dispositions" in absent.extra, false);

  for (const raw of [null, "not a list", 42, {}]) {
    const payload: Record<string, unknown> = { verdict: "approve", review_markdown: "x", required_check_dispositions: raw };
    const present = parseVerdictResponse(openaiResponse(JSON.stringify(payload)));
    // Present-but-unusable is NOT absence: emitted stays true with a null
    // array so the coverage layer fails conservatively instead of falling
    // back to the legacy keyword path.
    assert.equal(present.requiredCheckDispositionsEmitted, true, JSON.stringify(raw));
    assert.equal(present.requiredCheckDispositions, null, JSON.stringify(raw));
  }
});

test("#750: unattributable junk entries are dropped; attributable malformed ones are preserved as invalid", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    required_check_dispositions: [
      "bare string", 42, null,
      { check: "", status: "satisfied", rationale: "empty identity" },
      { check: 7, status: "satisfied", rationale: "wrong type" },
      { check: "check a", status: "N/A", rationale: "prose alias" },
      { check: "check b", status: "not applicable", rationale: "prose alias" },
      { check: "check c", status: "not_applicable", rationale: null },
      { check: "check d", status: "not_applicable", rationale: "   " },
      { check: "check e", status: "satisfied", rationale: 7 },
      { check: "check f", status: "unresolved", rationale: "explicitly unresolved stays" },
    ],
  })));
  assert.deepEqual(verdict.requiredCheckDispositions, [
    { check: "check a", status: "invalid", rationale: null },
    { check: "check b", status: "invalid", rationale: null },
    { check: "check c", status: "invalid", rationale: null },
    { check: "check d", status: "invalid", rationale: null },
    { check: "check e", status: "satisfied", rationale: null },
    { check: "check f", status: "unresolved", rationale: "explicitly unresolved stays" },
  ]);
});

test("#750: a malformed duplicate cannot collapse a valid answer into complete coverage", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    required_check_dispositions: [
      { check: "review for path traversal vulnerabilities", status: "satisfied", rationale: "bounded" },
      { check: "review for path traversal vulnerabilities", status: "N/A", rationale: "second answer retracts it" },
    ],
  })));
  assert.equal(verdict.requiredCheckDispositions!.length, 2);
  assert.equal(verdict.requiredCheckDispositions![1]!.status, "invalid");
});

test("#750: check identities and rationales are sanitized and bounded", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    required_check_dispositions: [
      { check: `review auth flow\u0000\u001b[31m${" for regression".repeat(20)}`, status: "satisfied", rationale: `ok\twith\ncontrol\u001b chars ${"y".repeat(600)}` },
      { check: "check a", status: "satisfied", rationale: "keep" },
    ],
  })));
  const first = verdict.requiredCheckDispositions![0]!;
  assert.ok(first.check.length <= 400);
  assert.ok(!first.check.includes("\u0000") && !first.check.includes("\u001b"));
  assert.ok(first.rationale !== null && first.rationale.length <= 500);
  assert.ok(!first.rationale!.includes("\n") && !first.rationale!.includes("\t"));
  assert.deepEqual(verdict.requiredCheckDispositions![1], { check: "check a", status: "satisfied", rationale: "keep" });
});

test("#750: a >400-char check echo is dropped, not truncated into a forged identity", () => {
  const longEcho = "review for path traversal vulnerabilities " + "z".repeat(400);
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    required_check_dispositions: [
      { check: longEcho, status: "satisfied", rationale: "too long to be a faithful echo" },
    ],
  })));
  assert.deepEqual(verdict.requiredCheckDispositions, []);
});

test("#750: dispositions never forge or alter the smart-review request (#721 authority)", () => {
  const verdict = parseVerdictResponse(openaiResponse(JSON.stringify({
    verdict: "approve",
    review_markdown: "x",
    required_check_dispositions: [
      { check: "review for path traversal vulnerabilities", status: "not_applicable", rationale: "grounded" },
    ],
    smart_review_requested: "true",
  })));
  assert.equal(verdict.smartReviewRequested, false);
  assert.equal(verdict.smartReviewReason, null);
  assert.equal(verdict.requiredCheckDispositions!.length, 1);
});

test("an invalid escape inside review_markdown does not let a nested finding pose as the verdict", () => {
  const body = "```json\n{\n  \"verdict\": \"approve\",\n  \"review_markdown\": \"## Recommendation\\nApprove. Uses `snake\\_case` names.\",\n  \"findings\": [{\"severity\": \"minor\", \"file\": \"a.py\", \"line\": 3, \"message\": \"x\"}]\n}\n```";
  const verdict = parseVerdictResponse(openaiResponse(body, { usage: { completion_tokens: 50 } }));
  assert.equal(verdict.verdict, "approve");
  assert.match(verdict.reviewMarkdown, /snake\\_case/);
});
