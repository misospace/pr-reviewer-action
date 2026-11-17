/**
 * #1678 review round 3: the corpus-review lanes under the closing-verdict
 * requirement-decision contract.
 *
 * Pins, end to end through `runReview`:
 *  1. a twice-invalid corpus serialization never becomes semantic authority
 *     (no `ai-output.json` from the rejected verdict, no escalation, a fixed
 *     discarded diagnostic, and a deterministic non-approving settle whose
 *     disposition names the machine reason `verdict_contract_incomplete`);
 *  2. one successful correction IS the authoritative verdict normally;
 *  3. every structured-output corpus request — initial AND the single
 *     correction, on both wire families — carries the run-specific exact-N
 *     schema (non-null coverage, minItems=maxItems=N, enum-pinned IDs);
 *  4. prompt-only corpus requests keep the same semantic contract (the
 *     closing-local required-decisions block) with no schema on the wire.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runReview } from "../src/run/review.js";
import { callModelTier, type TierProfile } from "../src/model/call.js";
import type { ChatRequestInput, ChatRequestOutcome } from "../src/transport/transport.js";
import { startMockServer } from "./helpers.js";
import {
  baseVerdict,
  coverageRows,
  ledgerRequirementIds,
  mockRunPlatform,
  reqRowsFrom,
  withRunDir,
} from "./verdict-contract-corpus-fixtures.js";

const openAiBody = (verdict: Record<string, unknown>): string => JSON.stringify({
  choices: [{ message: { role: "assistant", content: JSON.stringify(verdict) }, finish_reason: "stop" }],
});

// --- 1. twice-invalid: the rejected serialization is not authority --------

test("#1678 corpus: a twice-invalid serialization cannot drive verdict/findings/escalation", async () => {
  const server = await startMockServer((_req, body, res) => {
    const ids = ledgerRequirementIds(body);
    // BOTH the first verdict and the single correction return the organic
    // #1681 shape: an approve whose coverage carries only the FIRST row.
    // The prose/findings are deliberately loud: if any of this survived into
    // authority it would be visible.
    res.setHeader("Content-Type", "application/json");
    res.end(openAiBody(baseVerdict({
      verdict: "approve",
      review_markdown: "## Review\nAUTOMATED-AUTHORITY-LEAK everything is fine.",
      findings: [{ severity: "info", category: "style", file: "README.md", line: 1, message: "AUTOMATED-AUTHORITY-LEAK finding" }],
      requirement_coverage: coverageRows(ids.slice(0, 1)),
    })));
  });
  const { runDir, cleanup } = withRunDir();
  const logs: string[] = [];
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        "ci-status-check": "false", "requirement-trace": "true",
        "deep-review": "false", "repo-map-context": "false", "related-code-context": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockRunPlatform(),
      persistArtifacts: true,
      quiet: true,
      log: (line: string) => logs.push(line),
      error: (line: string) => logs.push(line),
    });
    const expected = reqRowsFrom(runDir);
    assert.ok(expected.length >= 2, "the fixture must put >=2 requirements in trace scope");
    // Exactly TWO model calls: the verdict and the ONE correction. No
    // second correction, no extra lane spent on a serialization failure.
    assert.equal(server.requests.length, 2, `expected verdict + one correction, got ${server.requests.length}`);
    // The rejected artifact NEVER became authoritative. `ai-output.json`
    // may exist ONLY as the fixed model-unavailable notice (the contract
    // fail-closed route) — never carrying the rejected verdict, findings,
    // or prose.
    const authorityPath = join(runDir, "ai-output.json");
    const authority = existsSync(authorityPath) ? readFileSync(authorityPath, "utf8") : "";
    assert.ok(!authority.includes("AUTOMATED-AUTHORITY-LEAK"),
      "the rejected serialization is never persisted as the authoritative review artifact");
    if (authority !== "") {
      const authoritative = JSON.parse(authority) as { verdict: string };
      assert.notEqual(authoritative.verdict, "approve", "the persisted authority is the fixed notice, never the rejected approve");
    }
    // The diagnostic IS present, explicitly marked discarded, and carries
    // only machine state — never the rejected prose.
    const diagnosticPath = join(runDir, "ai-request.primary.contract-discarded.json");
    assert.ok(existsSync(diagnosticPath), "the rejected serialization leaves a bounded diagnostic");
    const diagnostic = readFileSync(diagnosticPath, "utf8");
    assert.match(diagnostic, /"discarded": true/);
    assert.match(diagnostic, /verdict_contract_incomplete/);
    assert.ok(!diagnostic.includes("AUTOMATED-AUTHORITY-LEAK"), "the diagnostic carries no model prose");
    // No escalation: the contract-failed lane never authored a primary artifact.
    assert.equal(existsSync(join(runDir, "ai-request.smart.json")), false, "a contract-failed lane cannot escalate to smart");
    // The run settles deterministically non-approving on the fixed notice —
    // never the rejected prose.
    assert.notEqual(result.outputs.verdict, "approve", "the rejected serialization cannot approve");
    assert.ok(!result.outputs.reviewMarkdown.includes("AUTOMATED-AUTHORITY-LEAK"),
      "the rejected review prose never reaches the published body");
    // Machine reason rides the authoritative disposition: INCOMPLETE over a
    // COMMENT event, material `verdict_contract_incomplete` — the
    // serialization failure named as such, never a generic capability
    // abstention.
    const disposition = result.finalDisposition;
    assert.ok(disposition, "the run carries an authoritative final disposition");
    assert.equal(disposition.kind, "incomplete", "a contract-closed lane settles INCOMPLETE");
    assert.equal(disposition.nativeEvent, "COMMENT", "the contract-closed lane never raises or approves");
    assert.ok(disposition.materialUnknowns.some((entry) => entry.code === "verdict_contract_incomplete" && entry.materiality === "material"),
      "the disposition names the serialization failure as the material reason");
    assert.match(JSON.stringify(disposition), /"material"/);
    assert.match(logs.join("\n"), /no further correction/);
  } finally {
    await server.close();
    cleanup();
  }
});

// --- 2. one successful correction is authoritative ------------------------

test("#1678 corpus: the single successful correction is the authoritative verdict", async () => {
  let calls = 0;
  const server = await startMockServer((_req, body, res) => {
    calls += 1;
    const ids = ledgerRequirementIds(body);
    const full = calls === 2;
    res.setHeader("Content-Type", "application/json");
    res.end(openAiBody(baseVerdict({
      verdict: "approve",
      review_markdown: "## Review\nCORRECTED-BODY authoritative.",
      findings: [],
      requirement_coverage: full ? coverageRows(ids) : coverageRows(ids.slice(0, 1)),
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        "ci-status-check": "false", "requirement-trace": "true",
        "deep-review": "false", "repo-map-context": "false", "related-code-context": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockRunPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    assert.equal(server.requests.length, 2, "verdict + exactly one correction");
    const artifact = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as { review_markdown: string; requirement_coverage: unknown[] };
    assert.match(artifact.review_markdown, /CORRECTED-BODY/, "the corrected serialization is the authoritative artifact");
    assert.equal(artifact.requirement_coverage.length, reqRowsFrom(runDir).length, "the authoritative coverage is complete");
    assert.match(result.outputs.reviewMarkdown, /CORRECTED-BODY/);
    // The response artifact matches what was accepted.
    const response = readFileSync(join(runDir, "ai-response.primary.json"), "utf8");
    assert.match(response, /CORRECTED-BODY/, "the persisted response is the accepted correction body");
    // No discarded diagnostic on the recovered path; the run approves normally.
    assert.equal(existsSync(join(runDir, "ai-request.primary.contract-discarded.json")), false);
    assert.equal(result.outputs.verdict, "approve");
  } finally {
    await server.close();
    cleanup();
  }
});

// --- 3. every corpus request carries the run-specific exact-N schema ------

test("#1678 corpus: OpenAI structured-output requests pin the exact-N schema, verdict AND correction", async () => {
  const seenBodies: Record<string, unknown>[] = [];
  let calls = 0;
  const server = await startMockServer((_req, body, res) => {
    calls += 1;
    seenBodies.push(JSON.parse(body) as Record<string, unknown>);
    const ids = ledgerRequirementIds(body);
    res.setHeader("Content-Type", "application/json");
    res.end(openAiBody(baseVerdict({
      requirement_coverage: calls === 1 ? coverageRows(ids.slice(0, 1)) : coverageRows(ids),
    })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        "ai-response-format": "json_schema",
        "ci-status-check": "false", "requirement-trace": "true",
        "deep-review": "false", "repo-map-context": "false", "related-code-context": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockRunPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    const expected: string[] = reqRowsFrom(runDir);
    assert.equal(server.requests.length, 2);
    for (const [label, wire] of [["initial", seenBodies[0]!], ["correction", seenBodies[1]!]] as const) {
      const format = wire.response_format as Record<string, unknown>;
      assert.equal(format?.type, "json_schema", `${label}: json_schema mode carries a response_format`);
      const inner = (format.json_schema as { schema: { properties: Record<string, any> } }).schema;
      const coverage = inner.properties.requirement_coverage;
      assert.equal(coverage.type, "array", `${label}: coverage is non-null for a run with in-scope rows`);
      assert.equal(coverage.minItems, expected.length, `${label}: minItems pinned to N`);
      assert.equal(coverage.maxItems, expected.length, `${label}: maxItems pinned to N`);
      assert.deepEqual(coverage.items.properties.requirement_id.enum, expected, `${label}: IDs enum-pinned`);
      assert.deepEqual(coverage.items.properties.status.enum, ["satisfied", "violated", "unknown"], `${label}: canonical status enum`);
    }
    // The persisted correction request artifact agrees with the wire.
    const correctionArtifact = JSON.parse(
      readFileSync(join(runDir, "ai-request.primary.contract-correction.json"), "utf8"),
    ) as Record<string, unknown>;
    const correctionCoverage = ((correctionArtifact.response_format as Record<string, unknown>).json_schema as { schema: { properties: Record<string, any> } }).schema.properties.requirement_coverage;
    assert.equal(correctionCoverage.minItems, expected.length, "the persisted correction request carries the exact-N schema");
    // The correction user message carries the deterministic structural error
    // and forbids new work; the conversation stays system+user shaped.
    const correctionMessages = seenBodies[1]!.messages as Array<{ role: string; content: string }>;
    const userText = correctionMessages.map((m) => m.content).join("\n");
    assert.match(userText, /did not satisfy the required output contract/);
    assert.match(userText, /Do not perform additional investigation/);
    assert.equal(result.outputs.verdict, "approve", "the recovered correction approves normally");
  } finally {
    await server.close();
    cleanup();
  }
});

test("#1678 corpus: Anthropic structured-output requests pin the exact-N schema in output_config.format", async () => {
  const seenBodies: Record<string, unknown>[] = [];
  const server = await startMockServer((_req, body, res) => {
    seenBodies.push(JSON.parse(body) as Record<string, unknown>);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "msg_ok", model: "m", role: "assistant",
      content: [{ type: "text", text: JSON.stringify(baseVerdict({ requirement_coverage: coverageRows(ledgerRequirementIds(body)) })) }],
      stop_reason: "end_turn",
    }));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-api-format": "anthropic",
        "ai-stream": "false", "ai-api-key": "k",
        "ai-response-format": "json_schema",
        "ai-anthropic-structured-output-support": "true",
        "ci-status-check": "false", "requirement-trace": "true",
        "deep-review": "false", "repo-map-context": "false", "related-code-context": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockRunPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    const expected: string[] = reqRowsFrom(runDir);
    assert.equal(server.requests.length, 1, "a complete first verdict never spends the correction");
    const outputConfig = seenBodies[0]!.output_config as { format: { type: string; schema: { properties: Record<string, any> } } };
    assert.equal(outputConfig.format.type, "json_schema");
    const coverage = outputConfig.format.schema.properties.requirement_coverage;
    assert.equal(coverage.type, "array");
    assert.equal(coverage.minItems, expected.length, "Anthropic corpus request pins minItems=N");
    assert.equal(coverage.maxItems, expected.length);
    assert.deepEqual(coverage.items.properties.requirement_id.enum, expected);
    assert.equal(result.outputs.verdict, "approve", "the complete run still approves normally");
  } finally {
    await server.close();
    cleanup();
  }
});

// --- 4. prompt-only lanes keep the contract WITHOUT a schema ---------------

test("#1678 corpus: a prompt-only lane sends no schema but the request still carries the required-decisions block", async () => {
  const seenBodies: Record<string, unknown>[] = [];
  const server = await startMockServer((_req, body, res) => {
    seenBodies.push(JSON.parse(body) as Record<string, unknown>);
    res.setHeader("Content-Type", "application/json");
    res.end(openAiBody(baseVerdict({ requirement_coverage: coverageRows(ledgerRequirementIds(body)) })));
  });
  const { runDir, cleanup } = withRunDir();
  try {
    const result = await runReview({
      env: {},
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7",
        "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false", "ai-api-key": "k",
        "ci-status-check": "false", "requirement-trace": "true",
        "deep-review": "false", "repo-map-context": "false", "related-code-context": "false",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockRunPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    const expected: string[] = reqRowsFrom(runDir);
    assert.equal("response_format" in seenBodies[0]!, false, "prompt-only sends no response_format");
    const userText = (seenBodies[0]!.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "user").map((m) => m.content).join("\n");
    for (const id of expected) assert.ok(userText.includes(id), `closing block lists ${id}`);
    assert.match(userText, /Required requirement decisions/);
    assert.equal(result.outputs.verdict, "approve");
  } finally {
    await server.close();
    cleanup();
  }
});

// --- 5. the exact-N schema is lane-independent (fallback/smart ride it too)

/*
 * Primary, fallback and smart corpus calls ALL build their wire request
 * through the ONE `callModelTier` → `buildModelRequest` path — the tier only
 * selects the resolved profile. Pinning the shared construction with a
 * fallback-shaped profile therefore deterministically covers every corpus
 * lane's request, without orchestration nondeterminism.
 */
const laneUnitIds = ["req-0123456789ab", "req-abcdef012345"];

function laneProfile(overrides: Partial<TierProfile> = {}): TierProfile {
  return {
    label: "fallback",
    baseUrl: "http://mock",
    apiFormat: "openai",
    model: "fallback-m",
    apiKey: "",
    anthropicVersion: "2023-06-01",
    stream: false,
    requestTimeoutSec: 5,
    connectTimeoutSec: 5,
    retries: 0,
    retryDelaySec: 0,
    shape: "default",
    maxTokens: 8192,
    temperature: 0.1,
    responseFormat: "json_schema",
    tokensParam: "max_tokens",
    reasoningEffort: "",
    anthropicEffortSupported: false,
    anthropicStructuredOutputSupported: false,
    ...overrides,
  };
}

async function captureTierPayload(profile: TierProfile, verdict: string): Promise<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  const outcome: ChatRequestOutcome = {
    status: "ok",
    raw: { choices: [{ message: { content: JSON.stringify({ verdict, review_markdown: "## ok" }) }, finish_reason: "stop" }] },
    response: { id: "", object: "chat.completion", model: "m", content: "", toolCalls: [], finishReason: "stop", usage: null, error: undefined },
  };
  const result = await callModelTier(profile, {
    system: "S",
    user: "U",
    corpus: "C",
    verdictRequirementIds: laneUnitIds,
  }, {
    call: async (input: ChatRequestInput) => {
      captured.push(input.payload.body as unknown as Record<string, unknown>);
      return outcome;
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(captured.length, 1);
  return captured[0]!;
}

test("#1678 corpus: a recovery-tier json_schema request carries the run-specific exact-N schema (OpenAI arm)", async () => {
  const payload = await captureTierPayload(laneProfile(), "approve");
  const format = payload.response_format as Record<string, unknown>;
  assert.equal(format.type, "json_schema");
  const coverage = (format.json_schema as { schema: { properties: Record<string, any> } }).schema.properties.requirement_coverage;
  assert.equal(coverage.type, "array");
  assert.equal(coverage.minItems, laneUnitIds.length);
  assert.equal(coverage.maxItems, laneUnitIds.length);
  assert.deepEqual(coverage.items.properties.requirement_id.enum, laneUnitIds);
  assert.deepEqual(coverage.items.properties.status.enum, ["satisfied", "violated", "unknown"]);
});

test("#1678 corpus: a recovery-tier json_schema request pins output_config.format (Anthropic arm)", async () => {
  const payload = await captureTierPayload(laneProfile({
    apiFormat: "anthropic",
    label: "smart",
    anthropicStructuredOutputSupported: true,
  }), "approve");
  const outputConfig = payload.output_config as { format: { type: string; schema: { properties: Record<string, any> } } };
  assert.equal(outputConfig.format.type, "json_schema");
  const coverage = outputConfig.format.schema.properties.requirement_coverage;
  assert.equal(coverage.type, "array");
  assert.equal(coverage.minItems, laneUnitIds.length);
  assert.equal(coverage.maxItems, laneUnitIds.length);
  assert.deepEqual(coverage.items.properties.requirement_id.enum, laneUnitIds);
});
