import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNativeVerdict, produceNativeVerdict, type UsageAccumulator } from "../src/tools/harness.js";

// #868: a 200 reply whose body carries an error object (the native tool-loop
// path's own in-body-error check, independent of `parseVerdictResponse`)
// must mask the configured key the same way `surfaceStreamError` does.

function newUsageAcc(): UsageAccumulator {
  return { requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_prompt_tokens: 0 };
}

test("#868: evaluateNativeVerdict masks the configured key from a 200 in-body error", () => {
  const apiKey = "native-verdict-secret-key";
  const patShaped = "ghp_" + "d".repeat(36);
  const evaluation = evaluateNativeVerdict(
    { error: { message: `invalid key ${apiKey} (also ${patShaped})` } },
    [apiKey],
  );
  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.reason, "transport");
  assert.ok(!evaluation.detail.includes(apiKey), `expected the configured key to be masked, got: ${evaluation.detail}`);
  assert.ok(!evaluation.detail.includes(patShaped), `expected the PAT-shaped secret to be masked, got: ${evaluation.detail}`);
});

test("#868: produceNativeVerdict masks the configured key end to end (mock transport, streamed SSE-style error)", async () => {
  const apiKey = "produce-native-verdict-secret";
  const outcome = await produceNativeVerdict({
    verdictPayload: { stream: true },
    baseUrl: "http://mock",
    apiFormat: "openai",
    apiKey,
    turnTimeout: 5,
    usageAcc: newUsageAcc(),
    deadline: null,
    transport: async () => ({ error: { message: `stream error: bad credential ${apiKey}` } }),
    timeFn: () => 0,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "transport");
  assert.ok(!outcome.detail.includes(apiKey), `expected the configured key to be masked, got: ${outcome.detail}`);
  // The raw response is intentionally handed back unmasked here (it is a
  // diagnostic passthrough, not a log/artifact sink) — the caller
  // (`produceLoopTurn` in src/tools/harness.ts) persists `verdict.detail`
  // instead of this raw body on failure; see the tools-harness.test.ts
  // end-to-end case that asserts the persisted artifact is clean.
});
