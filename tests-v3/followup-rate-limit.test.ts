import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRateLimitStore,
  consumeFollowUpBudget,
  type RateLimitRule,
  type RateLimitScope,
} from "../src/followup/rate-limit.js";

// #763: the deterministic follow-up rate limiter. Clock-injected, so every
// decision is a pure function of the recorded instants and the supplied `now`.

const WINDOW = 1000;
const rule = (limit: number, windowMs = WINDOW): RateLimitRule => ({ limit, windowMs });

test("a scope allows up to its limit then denies within the window", () => {
  const store = new InMemoryRateLimitStore();
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], 100).allowed, true);
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], 200).allowed, true);
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], 300).allowed, true);
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], 400).allowed, false);
});

test("events age out: a denied scope frees once the window passes", () => {
  const store = new InMemoryRateLimitStore();
  for (const t of [100, 200, 300]) assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], t).allowed, true);
  // Still full inside the trailing window of the oldest event.
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], 1000).allowed, false);
  // Once `now - window` passes the oldest recorded instant, one slot frees.
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(3) }], 1101).allowed, true);
});

test("window boundary is (now-window, now]: an event at exactly now-window is excluded", () => {
  // Two independent stores: counting at a now that ages an event OUT prunes it,
  // so the two boundary instants must be observed on fresh state.
  const inside = new InMemoryRateLimitStore();
  inside.record("k", 1000);
  // now=1999 → the event at 1000 is strictly inside (1000 > 999) → counted.
  assert.equal(inside.countInWindow("k", WINDOW, 1999), 1);

  const atEdge = new InMemoryRateLimitStore();
  atEdge.record("k", 1000);
  // now=2000 → the event at 1000 is at exactly now-window (not > 1000) → excluded.
  assert.equal(atEdge.countInWindow("k", WINDOW, 2000), 0);
});

test("multi-scope budget is atomic: a denied scope records nothing anywhere", () => {
  const store = new InMemoryRateLimitStore();
  const scopes = [{ key: "pr", rule: rule(2) }, { key: "actor", rule: rule(1) }];
  // First: both under limit → allowed, both recorded.
  assert.equal(consumeFollowUpBudget(store, scopes, 100).allowed, true);
  assert.equal(store.countInWindow("pr", WINDOW, 100), 1);
  assert.equal(store.countInWindow("actor", WINDOW, 100), 1);
  // Second: actor at its limit (1) → denied; pr must NOT be charged.
  assert.equal(consumeFollowUpBudget(store, scopes, 200).allowed, false);
  assert.equal(store.countInWindow("pr", WINDOW, 200), 1, "a denied request must not consume the per-PR budget");
  assert.equal(store.countInWindow("actor", WINDOW, 200), 1);
});

test("distinct keys are independent", () => {
  const store = new InMemoryRateLimitStore();
  assert.equal(consumeFollowUpBudget(store, [{ key: "a", rule: rule(1) }], 100).allowed, true);
  assert.equal(consumeFollowUpBudget(store, [{ key: "b", rule: rule(1) }], 100).allowed, true);
  assert.equal(consumeFollowUpBudget(store, [{ key: "a", rule: rule(1) }], 100).allowed, false);
});

test("a limit <= 0 always denies", () => {
  const store = new InMemoryRateLimitStore();
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(0) }], 100).allowed, false);
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: rule(-3) }], 100).allowed, false);
});

test("a windowMs <= 0 fails closed (a zero window must NOT silently allow unlimited traffic)", () => {
  const store = new InMemoryRateLimitStore();
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: { limit: 5, windowMs: 0 } }], 100).allowed, false);
  assert.equal(consumeFollowUpBudget(store, [{ key: "k", rule: { limit: 5, windowMs: -1 } }], 100).allowed, false);
});

test("the store bounds distinct keys by evicting the oldest on overflow", () => {
  const store = new InMemoryRateLimitStore(3);
  store.record("k1", 100);
  store.record("k2", 100);
  store.record("k3", 100);
  store.record("k4", 100); // evicts k1
  assert.equal(store.countInWindow("k1", WINDOW, 150), 0);
  assert.equal(store.countInWindow("k4", WINDOW, 150), 1);
});

// #1295: the OPTIONAL stable request identity. Only a store with the atomic
// multi-scope capability consumes it (it uses it to make a redelivery
// idempotent); a store WITHOUT the capability takes the byte-identical
// per-scope loop and ignores the extra argument entirely.

test("the stable request identity is forwarded to a store with the atomic capability", () => {
  const captured: { scopes: readonly RateLimitScope[]; nowMs: number; requestId: string | undefined }[] = [];
  const store = {
    countInWindow: (): number => 0,
    record: (): void => {
      throw new Error("the atomic path must own the commit, never the per-scope record");
    },
    consumeScopesAtomically: (
      scopes: readonly RateLimitScope[],
      nowMs: number,
      requestId?: string,
    ): boolean => {
      captured.push({ scopes, nowMs, requestId });
      return true;
    },
  };
  const scopes: RateLimitScope[] = [{ key: "pr", rule: rule(2) }, { key: "actor", rule: rule(1) }];
  assert.equal(consumeFollowUpBudget(store, scopes, 1_000, "req-1").allowed, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.nowMs, 1_000);
  assert.equal(captured[0]!.requestId, "req-1");
  assert.deepEqual(captured[0]!.scopes, scopes);
});

test("a store without the atomic capability ignores the request identity and keeps the per-scope loop", () => {
  const calls: string[] = [];
  const store = {
    countInWindow: (key: string, _windowMs: number, nowMs: number): number => {
      calls.push(`count:${key}:${nowMs}`);
      return 0;
    },
    record: (key: string, nowMs: number): void => {
      calls.push(`record:${key}:${nowMs}`);
    },
  };
  const scopes: RateLimitScope[] = [{ key: "pr", rule: rule(2) }, { key: "actor", rule: rule(1) }];
  // The identity-less call first: it is the baseline the seam behaved like
  // before the identity existed.
  assert.equal(consumeFollowUpBudget(store, scopes, 1_000).allowed, true);
  const baseline = calls.slice();
  calls.length = 0;
  // The same call WITH the identity: byte-identical behaviour.
  assert.equal(consumeFollowUpBudget(store, scopes, 1_000, "req-1").allowed, true);
  assert.deepEqual(calls, baseline,
    "the extra argument must not change a store without the atomic capability");
  assert.deepEqual(calls, ["count:pr:1000", "count:actor:1000", "record:pr:1000", "record:actor:1000"]);
});
