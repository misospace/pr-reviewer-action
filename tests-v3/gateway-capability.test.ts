import test from "node:test";
import assert from "node:assert/strict";
import {
  GATEWAY_TOKEN_RE,
  createGatewayCapabilityAuth,
} from "../src/gateway/capability.js";
import {
  CAPABILITY_REFUSAL_CODES,
  MAX_BUDGET_LIMIT,
  validateBudgetLimits,
  type GatewayBudgetLimits,
} from "../src/gateway/types.js";

/**
 * Gateway capability tokens (#765): HMAC over the bounded `(runId,
 * modelProfile, generation, expiry, budget limits)` identity, keyed by a
 * controller signing key; verification total over hostile input.
 */

const KEY = "controller-signing-key-0123456789";
const OTHER_KEY = "a-completely-different-signing-key";
const LIMITS = validateBudgetLimits({ maxRequests: 40, maxTokens: 200_000, maxCostMicros: 5_000_000 });

const IDENTITY = {
  runId: "run-765",
  modelProfile: "primary",
  generation: 1,
  limits: LIMITS,
};

function auth(now: () => number = () => 1_000_000) {
  return createGatewayCapabilityAuth({ key: KEY, now });
}

test("capability: mint produces a v1 gateway token that verifies for its own identity", () => {
  const gateway = auth();
  const minted = gateway.mint(IDENTITY, { ttlMs: 60_000 });
  assert.match(minted.token, GATEWAY_TOKEN_RE);
  assert.equal(minted.expiresAtMs, 1_060_000);
  assert.equal(minted.generation, 1);
  assert.deepEqual(
    gateway.verifyDetailed(minted.token, {
      runId: IDENTITY.runId,
      modelProfile: IDENTITY.modelProfile,
      expectedGeneration: 1,
      limits: LIMITS,
    }),
    { ok: true },
  );
});

test("capability: an expired token is refused even for its own identity", () => {
  const mint = auth(() => 1_000_000);
  const verify = auth(() => 1_061_000);
  const minted = mint.mint(IDENTITY, { ttlMs: 60_000 });
  const verdict = verify.verifyDetailed(minted.token, {
    runId: IDENTITY.runId,
    modelProfile: IDENTITY.modelProfile,
    expectedGeneration: 1,
    limits: LIMITS,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, "expired");
  }
});

test("capability: a token minted for an older generation is refused (cancellation = generation bump)", () => {
  const gateway = auth();
  const minted = gateway.mint(IDENTITY);
  const verdict = gateway.verifyDetailed(minted.token, {
    runId: IDENTITY.runId,
    modelProfile: IDENTITY.modelProfile,
    expectedGeneration: 2,
    limits: LIMITS,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, "cancelled");
  }
});

test("capability: a token cannot serve another run or another model profile", () => {
  const gateway = auth();
  const minted = gateway.mint(IDENTITY);
  const wrongRun = gateway.verifyDetailed(minted.token, {
    runId: "run-other",
    modelProfile: IDENTITY.modelProfile,
    expectedGeneration: 1,
    limits: LIMITS,
  });
  assert.equal(wrongRun.ok, false);
  if (!wrongRun.ok) assert.equal(wrongRun.code, "wrong_run");
  const wrongProfile = gateway.verifyDetailed(minted.token, {
    runId: IDENTITY.runId,
    modelProfile: "escalated",
    expectedGeneration: 1,
    limits: LIMITS,
  });
  assert.equal(wrongProfile.ok, false);
  if (!wrongProfile.ok) assert.equal(wrongProfile.code, "profile_mismatch");
});

test("capability: hostile tokens fail closed without throwing", () => {
  const gateway = auth();
  const minted = gateway.mint(IDENTITY);
  const hostile: string[] = [
    "",
    "not-a-token",
    // A #735 result-channel token is a foreign format here.
    "v1.f4240.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    minted.token.slice(0, -1),
    `${minted.token}x`,
    // Tampered identity fields (still structurally valid).
    minted.token.replace("cnVuLTc2NQ", "cnVuLTk5OQ"),
    // Tampered budget bounds.
    minted.token.replace(".40.", ".4000."),
    // Truncated and overlong inputs.
    "gw1.1.1.a.b.1.1.1.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".slice(0, 10),
    `gw1.${"0".repeat(17)}.${"0".repeat(17)}.${"a".repeat(300)}.${"b".repeat(300)}.1.1.1.${"0".repeat(64)}`,
    // Unicode / control garbage.
    "gw1.\u0000.evil.a.b.1.1.1.deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  ];
  const reasons: string[] = [];
  for (const token of hostile) {
    const verdict = gateway.verifyDetailed(token, {
      runId: IDENTITY.runId,
      modelProfile: IDENTITY.modelProfile,
      expectedGeneration: 1,
      limits: LIMITS,
    });
    assert.equal(verdict.ok, false, JSON.stringify(token));
    if (!verdict.ok) {
      assert.ok(
        (CAPABILITY_REFUSAL_CODES as readonly string[]).includes(verdict.code),
        `unexpected refusal code ${verdict.code}`,
      );
      reasons.push(verdict.reason);
    }
  }
  // A tampered budget-bounds token whose MAC no longer matches is
  // `invalid_token`, not a bounds mismatch: the bounds live inside the MAC.
  const tampered = gateway.verifyDetailed(minted.token.replace(".40.", ".4000."), {
    runId: IDENTITY.runId,
    modelProfile: IDENTITY.modelProfile,
    expectedGeneration: 1,
    limits: LIMITS,
  });
  assert.equal(tampered.ok, false);
  if (!tampered.ok) assert.equal(tampered.code, "invalid_token");
  void reasons;
});

test("capability: a structurally valid token whose bounds differ from the gateway's is refused", () => {
  const gateway = auth();
  const minted = gateway.mint({ ...IDENTITY, limits: validateBudgetLimits({ maxRequests: 1, maxTokens: 1, maxCostMicros: 0 }) });
  const verdict = gateway.verifyDetailed(minted.token, {
    runId: IDENTITY.runId,
    modelProfile: IDENTITY.modelProfile,
    expectedGeneration: 1,
    limits: LIMITS,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.equal(verdict.code, "budget_bounds_mismatch");
    assert.equal(verdict.reason, "capability token budget bounds do not match the gateway's");
  }
});

test("capability: malformed presented limits refuse without throwing", () => {
  const gateway = auth();
  const minted = gateway.mint(IDENTITY);
  for (const limits of [
    null,
    "40/200000/5000000",
    { maxRequests: -1, maxTokens: 10, maxCostMicros: 0 },
    { maxRequests: 1.5, maxTokens: 10, maxCostMicros: 0 },
    { maxRequests: 40 },
    { maxRequests: 40, maxTokens: 200_000, maxCostMicros: "many" },
  ]) {
    const verdict = gateway.verifyDetailed(minted.token, {
      runId: IDENTITY.runId,
      modelProfile: IDENTITY.modelProfile,
      expectedGeneration: 1,
      limits: limits as unknown as GatewayBudgetLimits,
    });
    assert.equal(verdict.ok, false, JSON.stringify(limits));
    if (!verdict.ok) {
      assert.equal(verdict.code, "invalid_token", JSON.stringify(limits));
      assert.equal(verdict.reason, "presented budget bounds are malformed");
    }
  }
  // A valid-but-different bound is still the dedicated mismatch code.
  const different = gateway.verifyDetailed(minted.token, {
    runId: IDENTITY.runId,
    modelProfile: IDENTITY.modelProfile,
    expectedGeneration: 1,
    limits: validateBudgetLimits({ maxRequests: 41, maxTokens: 200_000, maxCostMicros: 5_000_000 }),
  });
  assert.equal(different.ok, false);
  if (!different.ok) assert.equal(different.code, "budget_bounds_mismatch");
});

test("capability: different keys derive different tokens, and the key never appears in a token or error", () => {
  const minted = auth().mint(IDENTITY);
  const other = createGatewayCapabilityAuth({ key: OTHER_KEY, now: () => 1_000_000 }).mint(IDENTITY);
  assert.notEqual(minted.token, other.token);
  assert.ok(!minted.token.includes(KEY));
  assert.ok(!other.token.includes(OTHER_KEY));
  const verdict = auth().verifyDetailed("gw1.deadbeef.a.run.pro.1.1.1.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", {
    runId: "run",
    modelProfile: "pro",
    expectedGeneration: 1,
    limits: LIMITS,
  });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.ok(!verdict.reason.includes(KEY));
});

test("capability: mint fails closed on malformed identities and out-of-range arguments", () => {
  const gateway = auth();
  assert.throws(() => gateway.mint({ ...IDENTITY, runId: "" }));
  assert.throws(() => gateway.mint({ ...IDENTITY, runId: "bad run id with spaces" }));
  assert.throws(() => gateway.mint({ ...IDENTITY, modelProfile: "" }));
  assert.throws(() => gateway.mint({ ...IDENTITY, modelProfile: "bad profile name!" }));
  assert.throws(() => gateway.mint({ ...IDENTITY, generation: 0 }));
  assert.throws(() => gateway.mint({ ...IDENTITY, generation: 1.5 }));
  assert.throws(() => gateway.mint({ ...IDENTITY, limits: { maxRequests: 0, maxTokens: 1, maxCostMicros: 0 } }));
  assert.throws(() => gateway.mint({ ...IDENTITY, limits: { maxRequests: 1, maxTokens: 0, maxCostMicros: 0 } }));
  assert.throws(() => gateway.mint({ ...IDENTITY, limits: { maxRequests: 1, maxTokens: 1, maxCostMicros: -1 } }));
  assert.throws(() => gateway.mint({ ...IDENTITY, limits: { maxRequests: 1, maxTokens: 1, maxCostMicros: MAX_BUDGET_LIMIT + 1 } }));
  assert.throws(() => gateway.mint(IDENTITY, { ttlMs: 0 }));
  assert.throws(() => gateway.mint(IDENTITY, { ttlMs: 8 * 24 * 3_600_000 }));
});

test("capability: budget limits validate fail-closed", () => {
  assert.deepEqual(validateBudgetLimits({ maxRequests: 3, maxTokens: 10, maxCostMicros: 0 }), {
    maxRequests: 3,
    maxTokens: 10,
    maxCostMicros: 0,
  });
  assert.throws(() => validateBudgetLimits({ maxRequests: 0, maxTokens: 10, maxCostMicros: 0 }));
  assert.throws(() => validateBudgetLimits({ maxRequests: 3, maxTokens: 0, maxCostMicros: 0 }));
  assert.throws(() => validateBudgetLimits({ maxRequests: 3, maxTokens: 10, maxCostMicros: -5 }));
  assert.throws(() => validateBudgetLimits({ maxRequests: 3.5, maxTokens: 10, maxCostMicros: 0 }));
  assert.throws(() => validateBudgetLimits(null as unknown as GatewayBudgetLimits));
});
