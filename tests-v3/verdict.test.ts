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
