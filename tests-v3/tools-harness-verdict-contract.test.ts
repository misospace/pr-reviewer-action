// #1678 hardening: the closing-verdict requirement-decision contract inside
// `produceNativeVerdict`. A response that SUCCEEDS on wire and parses, but
// whose `requirement_coverage` does not carry each expected requirement ID
// EXACTLY once (valid status, no extras, no malformed rows), is an invalid
// closing SERIALIZATION — the model gets ONE bounded no-tools correction turn
// inside the same completed conversation, and a still-invalid (or failed, or
// refused) correction fails closed with reason "contract". The contract
// correction state is disjoint from the #1687 transport-retry state: totals
// stay bounded (never a Cartesian product of transport retries and contract
// corrections).
import test from "node:test";
import assert from "node:assert/strict";
import { produceNativeVerdict, type HarnessDeps } from "../src/tools/harness.js";
import { TransportFailure } from "../src/transport/http.js";

// Fixture style mirrors the #1687 suite in tools-harness.test.ts (local
// helpers on purpose: this file pins a different contract).
const openAiText = (content: string) => ({ choices: [{ message: { content } }] });

// Wire-vocabulary IDs must match /^req-[0-9a-f]{12}$/.
const requirementIds = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `req-${String(i + 1).padStart(12, "0")}`);

const coverageRow = (id: string, status: "satisfied" | "violated" | "unknown" = "satisfied") => ({
  requirement_id: id,
  status,
  evidence: [{ kind: "file", ref: "src/a.ts", detail: "cited from evidence already in the conversation" }],
});

const coverageVerdictText = (rows: readonly unknown[]): string => JSON.stringify({
  verdict: "approve",
  review_markdown: "## Review\nok",
  findings: [],
  requirement_coverage: rows,
});
const coverageVerdict = (rows: readonly unknown[]) => openAiText(coverageVerdictText(rows));
const noCoverageVerdict = () => openAiText(JSON.stringify({ verdict: "approve", review_markdown: "## Review\nok", findings: [] }));

const verdictInput = (
  transport: HarnessDeps["transport"],
  overrides: Partial<Parameters<typeof produceNativeVerdict>[0]> = {},
): Parameters<typeof produceNativeVerdict>[0] => ({
  verdictPayload: {
    messages: [{ role: "user", content: "the whole tool-loop conversation" }],
    stream: false,
    model: "test-model",
    max_tokens: 512,
  },
  baseUrl: "http://model.test/v1",
  apiFormat: "openai",
  apiKey: "k",
  turnTimeout: 30,
  usageAcc: { requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 },
  deadline: 100,
  transport,
  timeFn: () => 1,
  tier: "primary",
  ...overrides,
});

// The correction turn must reuse the whole conversation and append exactly
// [assistant echo of the rejected body, user correction]. Returns the user
// correction content for further message assertions.
const assertCorrectionTurn = (
  calls: ReadonlyArray<Record<string, unknown>>,
  baseIndex: number,
  correctionIndex: number,
  baseMessageCount: number,
  rejectedText: string,
): string => {
  const base = calls[baseIndex]!.messages as unknown[];
  const correction = calls[correctionIndex]!.messages as unknown[];
  assert.equal(correction.length, base.length + 2, "the correction appends the echo plus one user turn");
  assert.equal(base.length, baseMessageCount);
  assert.deepEqual(correction.slice(0, base.length), base, "the correction reuses the complete investigation conversation");
  assert.deepEqual(correction[base.length], { role: "assistant", content: rejectedText }, "the rejected verdict is echoed as the assistant turn");
  const userTurn = correction[base.length + 1] as { role: string; content: string };
  assert.equal(userTurn.role, "user");
  return userTurn.content;
};

test("#1678: 7-of-9 missing rows get exactly ONE correction turn, replay accepted", async () => {
  const ids = requirementIds(9);
  const firstText = coverageVerdictText([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
  const calls: Array<Record<string, unknown>> = [];
  const outcome = await produceNativeVerdict(verdictInput(async (_baseUrl, _apiFormat, payload) => {
    calls.push(structuredClone(payload));
    if (calls.length === 1) return openAiText(firstText);
    return coverageVerdict(ids.map((id) => coverageRow(id)));
  }, { requirementContractIds: ids }));

  assert.equal(outcome.ok, true, "the corrected re-emit is the authoritative verdict");
  assert.equal(outcome.reason, "accepted");
  assert.equal(outcome.transport, "non-streamed-contract-correction");
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.retried, false, "a contract correction is not a retry of a failed wire attempt");
  assert.equal(outcome.retryKind, "");
  assert.equal(outcome.transportRetry, undefined, "the #1687 transport surface stays unclaimed");
  assert.equal(calls.length, 2, "exactly one transport call per state — first verdict plus ONE correction");
  assert.deepEqual(outcome.contractCorrection, {
    attempted: true,
    recovered: true,
    expected_count: 9,
    missing_ids: ids.slice(2),
    missing_count: 7,
    duplicated_ids: [],
    unexpected_ids: [],
  });

  const correctionUser = assertCorrectionTurn(calls, 0, 1, 1, firstText);
  for (const missing of ids.slice(2)) {
    assert.ok(correctionUser.includes(missing), `the correction names missing ${missing}`);
  }
  assert.match(correctionUser, /Do not call any tools/, "the correction never reopens investigation");
  assert.equal(calls[1]!.stream, false, "the correction is non-streamed");
  assert.equal("stream_options" in calls[1]!, false);
  assert.equal(calls[1]!.model, "test-model", "the correction changes the messages, never the decoding identity");
  assert.equal(calls[1]!.max_tokens, 512, "no completion-budget change rides the correction");
});

test("#1678: a still-invalid correction fails closed — NEVER a third contract attempt", async () => {
  const ids = requirementIds(9);
  let calls = 0;
  const outcome = await produceNativeVerdict(verdictInput(async () => {
    calls += 1;
    return coverageVerdict([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
  }, { requirementContractIds: ids }));

  assert.equal(calls, 2, "one verdict + one correction — never a second correction");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "contract");
  assert.equal(outcome.response, null, "the first verdict stays discarded; the failed correction never replaces it");
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.transport, "");
  assert.equal(outcome.contractCorrection!.recovered, false);
  assert.equal(outcome.contractCorrection!.expected_count, 9);
  assert.equal(outcome.contractCorrection!.missing_count, 7);
  assert.match(outcome.detail, /one correction allowed/);
  assert.match(outcome.detail, /still 7\/9 rows short/, "the still-invalid correction reports how many rows stayed short");
});

test("#1678: transport failure on the correction turn fails closed reason contract", async () => {
  const ids = requirementIds(9);
  let calls = 0;
  const outcome = await produceNativeVerdict(verdictInput(async () => {
    calls += 1;
    if (calls === 1) return coverageVerdict([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
    throw new TransportFailure("network", "ECONNRESET");
  }, { requirementContractIds: ids }));

  assert.equal(calls, 2, "the correction turn reached wire once — no contract re-correction after wire death");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "contract", "the turn's terminal failure is the contract, not transport recovery");
  assert.equal(outcome.response, null);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.contractCorrection!.recovered, false);
  assert.match(outcome.detail, /correction turn transport failure/);
  assert.equal(outcome.transportRetry, undefined, "the #1687 retry surface stays unclaimed for a correction-turn death");
});

test("#1678: exhausted deadline refuses the correction WITHOUT a wire call", async () => {
  const ids = requirementIds(9);
  let calls = 0;
  let clockCalls = 0;
  const outcome = await produceNativeVerdict(verdictInput(async () => {
    calls += 1;
    return coverageVerdict([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
  }, {
    requirementContractIds: ids,
    // First reading (the attempt's own clamp) is inside the deadline; every
    // later reading is past it — the correction's pre-flight check sees 200 > 100.
    timeFn: () => (clockCalls++ === 0 ? 1 : 200),
  }));

  assert.equal(calls, 1, "a correction past the deadline is never put on the wire");
  assert.equal(outcome.attempts, 1, "the refused correction counts no attempt");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "contract");
  assert.equal(outcome.response, null);
  assert.equal(outcome.contractCorrection!.recovered, false);
  assert.match(outcome.detail, /refused/);
  assert.match(outcome.detail, /deadline exhausted/);
});

test("#1678: payload that lost its messages fails closed without a second call", async () => {
  const ids = requirementIds(9);
  let calls = 0;
  const outcome = await produceNativeVerdict(verdictInput(async () => {
    calls += 1;
    return coverageVerdict([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
  }, {
    requirementContractIds: ids,
    verdictPayload: { stream: false, model: "test-model", max_tokens: 512 },
  }));

  assert.equal(calls, 1, "the #1464 boundary mirrored: a conversation-less correction request is never sent");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "contract");
  assert.equal(outcome.response, null);
  assert.match(outcome.detail, /refused/);
  assert.match(outcome.detail, /payload lost its messages/);
});

test("#1678: contract stays inert when absent or empty — byte-identical legacy path", async () => {
  for (const label of ["omitted", "empty"] as const) {
    let calls = 0;
    const outcome = await produceNativeVerdict(verdictInput(async (_baseUrl, _apiFormat, payload) => {
      calls += 1;
      assert.equal((payload.messages as unknown[]).length, 1, "no correction machinery ever appends turns");
      return noCoverageVerdict();
    }, {
      ...(label === "omitted" ? {} : { requirementContractIds: [] }),
    }));
    assert.equal(calls, 1, `${label} contract: single wire call`);
    assert.equal(outcome.ok, true, `${label} contract: acceptance unchanged`);
    assert.equal(outcome.reason, "accepted");
    assert.equal(outcome.transport, "non-streamed");
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.contractCorrection, undefined, `${label} contract: no correction record at all`);
  }
});

test("#1687 x #1678: one transport retry THEN one correction — bounded at three calls, never more", async () => {
  const ids = requirementIds(9);
  const secondText = coverageVerdictText([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
  const calls: Array<Record<string, unknown>> = [];
  const outcome = await produceNativeVerdict(verdictInput(async (_baseUrl, _apiFormat, payload) => {
    calls.push(structuredClone(payload));
    if (calls.length === 1) throw new TransportFailure("network", "model request failed (ECONNRESET)");
    if (calls.length === 2) return openAiText(secondText);
    return coverageVerdict(ids.map((id) => coverageRow(id)));
  }, { requirementContractIds: ids }));

  assert.equal(calls.length, 3, "one transport retry plus one contract correction — never a third of either");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "accepted");
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.retried, true);
  assert.equal(outcome.retryKind, "transport", "the spent retry turn stays labelled #1687");
  assert.equal(outcome.transportRetry!.reason, "connection_closed");
  assert.equal(outcome.transport, "non-streamed-contract-correction", "the ACCEPTED attempt is the correction");
  assert.equal(outcome.contractCorrection!.recovered, true);
  assert.equal(outcome.contractCorrection!.missing_count, 7);
  assert.deepEqual(outcome.contractCorrection!.missing_ids, ids.slice(2));
  assert.ok(outcome.response !== null && outcome.response !== undefined, "the corrected re-emit is authoritative");
  assert.deepEqual(calls[1]!.messages, calls[0]!.messages, "the #1687 transport retry stays payload-identical — the correction never leaked into it");

  const correctionUser = assertCorrectionTurn(calls, 1, 2, 1, secondText);
  for (const missing of ids.slice(2)) {
    assert.ok(correctionUser.includes(missing), `the correction names missing ${missing}`);
  }
  assert.match(correctionUser, /Do not call any tools/);
});

test("#1678: exact 9/9 first response is accepted with no correction call", async () => {
  const ids = requirementIds(9);
  let calls = 0;
  const outcome = await produceNativeVerdict(verdictInput(async () => {
    calls += 1;
    return coverageVerdict(ids.map((id) => coverageRow(id)));
  }, { requirementContractIds: ids }));

  assert.equal(calls, 1, "a contract-satisfying verdict never spends a correction turn");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "accepted");
  assert.equal(outcome.transport, "non-streamed");
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.contractCorrection, undefined, "nothing to record when the contract was met");
});

test("#1678: all-unknown coverage is a valid semantic answer — accepted as-is", async () => {
  const ids = requirementIds(9);
  let calls = 0;
  const outcome = await produceNativeVerdict(verdictInput(async () => {
    calls += 1;
    return coverageVerdict(ids.map((id) => coverageRow(id, "unknown")));
  }, { requirementContractIds: ids }));

  assert.equal(calls, 1, "unknown is preferable to omission — serialization corrections never tutor semantics");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "accepted");
  assert.equal(outcome.transport, "non-streamed");
  assert.equal(outcome.contractCorrection, undefined);
});

test("#1678: duplicated plus missing rows both trigger the ONE correction", async () => {
  const ids = requirementIds(3);
  const firstText = coverageVerdictText([coverageRow(ids[0]!), coverageRow(ids[0]!), coverageRow(ids[1]!)]);
  const calls: Array<Record<string, unknown>> = [];
  const outcome = await produceNativeVerdict(verdictInput(async (_baseUrl, _apiFormat, payload) => {
    calls.push(structuredClone(payload));
    if (calls.length === 1) return openAiText(firstText);
    return coverageVerdict(ids.map((id) => coverageRow(id)));
  }, { requirementContractIds: ids }));

  assert.equal(calls.length, 2, "duplicates are contract violations too — one correction, then accepted");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.transport, "non-streamed-contract-correction");
  assert.equal(outcome.contractCorrection!.expected_count, 3);
  assert.deepEqual(outcome.contractCorrection!.duplicated_ids, [ids[0]]);
  assert.deepEqual(outcome.contractCorrection!.missing_ids, [ids[2]]);
  assert.equal(outcome.contractCorrection!.missing_count, 1);
  assert.equal(outcome.contractCorrection!.recovered, true);

  const correctionUser = assertCorrectionTurn(calls, 0, 1, 1, firstText);
  assert.ok(correctionUser.includes(ids[2]!), "the correction names the missing ID");
  assert.ok(correctionUser.includes(ids[0]!), "the correction names the duplicated ID");
  assert.match(correctionUser, /Duplicate/);
  assert.match(correctionUser, /Do not call any tools/);
});

// ---------------------------------------------------------------------------
// #1678 review round 3: the correction inherits the EFFECTIVE successful
// payload — a token-cap raise spent on the #637 retry must carry into the
// correction, or the "complete" re-emit truncates again under the old budget
// and the run falsely lands on verdict_contract_incomplete.
// ---------------------------------------------------------------------------

test("#1678: a streamed token-cap truncation's raised budget carries into the contract correction", async () => {
  const ids = requirementIds(9);
  const calls: Array<Record<string, unknown>> = [];
  const outcome = await produceNativeVerdict(verdictInput(async (_baseUrl, _apiFormat, payload) => {
    calls.push(structuredClone(payload) as Record<string, unknown>);
    if (calls.length === 1) {
      // The raise's exact evidence shape: token-cap-truncated streamed body.
      return { choices: [{ message: { content: "not a verdict body" }, finish_reason: "length" }] };
    }
    if (calls.length === 2) {
      // The raised non-streamed retry parses fine but returns the organic
      // #1681 partial table (2 of 9).
      return coverageVerdict([coverageRow(ids[0]!), coverageRow(ids[1]!)]);
    }
    return coverageVerdict(ids.map((id) => coverageRow(id)));
  }, {
    requirementContractIds: ids,
    verdictPayload: {
      messages: [{ role: "user", content: "the whole tool-loop conversation" }],
      stream: true,
      model: "test-model",
      max_tokens: 512,
    },
  }));

  assert.equal(outcome.ok, true, "the correction recovers the complete table");
  assert.equal(outcome.retried, true);
  assert.equal(outcome.retryKind, "stream");
  assert.equal(outcome.transport, "non-streamed-contract-correction");
  assert.equal(outcome.attempts, 3, "streamed + raised retry + exactly one correction");
  assert.equal(calls.length, 3);
  assert.equal(outcome.budgetRaisedTo, 2048);
  const retry = calls[1]!;
  const correction = calls[2]!;
  assert.equal(retry.max_tokens, 2048, "the retry carries the raise");
  assert.equal(correction.max_tokens, 2048, "the correction INHERITS the raised budget — rebuilding from the original 512 would truncate the complete table again");
  assert.equal(correction.model, "test-model", "the correction keeps the model/format shape");
  assert.equal(correction.stream, false);
  assert.equal("stream_options" in correction, false);
  // The conversation base is the RETRY payload's messages (the effective
  // successful attempt), plus exactly the echo and the correction turn.
  assertCorrectionTurn(calls, 1, 2, 1, coverageVerdictText([coverageRow(ids[0]!), coverageRow(ids[1]!)]));
  assert.equal(outcome.contractCorrection?.recovered, true);
});

test("#1678: the correction inherits response_format and other request-shape fields from the effective payload", async () => {
  const ids = requirementIds(2);
  const calls: Array<Record<string, unknown>> = [];
  const outcome = await produceNativeVerdict(verdictInput(async (_baseUrl, _apiFormat, payload) => {
    calls.push(structuredClone(payload) as Record<string, unknown>);
    if (calls.length === 1) return coverageVerdict([coverageRow(ids[0]!)]);
    return coverageVerdict(ids.map((id) => coverageRow(id)));
  }, {
    requirementContractIds: ids,
    verdictPayload: {
      messages: [{ role: "user", content: "the whole tool-loop conversation" }],
      stream: false,
      model: "test-model",
      max_tokens: 512,
      response_format: { type: "json_schema", json_schema: { name: "pr_review", strict: true } },
    },
  }));
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[1]!.response_format,
    { type: "json_schema", json_schema: { name: "pr_review", strict: true } },
    "the run-pinned schema rides the correction — the corrected answer is shaped by the same exact-N contract",
  );
});
