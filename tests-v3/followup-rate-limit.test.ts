import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRateLimitStore,
  consumeFollowUpBudget,
  type RateLimitRule,
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
