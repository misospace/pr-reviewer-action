import test from "node:test";
import assert from "node:assert/strict";
import { RESULT_CHANNEL_TOKEN_RE, createResultChannelAuth } from "../src/credentials/index.js";

const KEY = "controller-signing-key-0123456789abcdef";
const RUN_A = "run-20261028-aaaa";
const RUN_B = "run-20261028-bbbb";
const JOB_A = "job-20261028-aaaa";
const JOB_B = "job-20261028-bbbb";

test("result-channel: mint produces a bounded v1 hex token", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const token = auth.mint(RUN_A, JOB_A);
  assert.equal(RESULT_CHANNEL_TOKEN_RE.test(token), true);
  assert.equal(token.length, "v1.".length + 64);
});

test("result-channel: correct pair verifies", () => {
  const auth = createResultChannelAuth({ key: KEY });
  assert.equal(auth.verify(auth.mint(RUN_A, JOB_A), RUN_A, JOB_A), true);
});

test("result-channel: a token cannot submit for another run or another job", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const tokenA = auth.mint(RUN_A, JOB_A);
  assert.equal(auth.verify(tokenA, RUN_B, JOB_A), false);
  assert.equal(auth.verify(tokenA, RUN_A, JOB_B), false);
  assert.equal(auth.verify(tokenA, RUN_B, JOB_B), false);
  // A second identity mints a genuinely different token.
  assert.notEqual(tokenA, auth.mint(RUN_B, JOB_A));
});

test("result-channel: hostile tokens fail closed without throwing", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const tokenA = auth.mint(RUN_A, JOB_A);
  assert.equal(auth.verify("", RUN_A, JOB_A), false);
  assert.equal(auth.verify("v1.", RUN_A, JOB_A), false);
  assert.equal(auth.verify(tokenA.slice(0, -2), RUN_A, JOB_A), false);
  assert.equal(auth.verify(`v1.${"0".repeat(64)}`, RUN_A, JOB_A), false);
  assert.equal(auth.verify(`${tokenA}extra-padding-${"x".repeat(200)}`, RUN_A, JOB_A), false);
  assert.equal(auth.verify(tokenA.toUpperCase(), RUN_A, JOB_A), false);
  assert.equal(auth.verify("v2." + tokenA.slice(3), RUN_A, JOB_A), false);
  // Hostile correlation identities are refused too, never digested.
  assert.equal(auth.verify(tokenA, "run/../../etc", JOB_A), false);
  assert.equal(auth.verify(tokenA, RUN_A, ""), false);
});

test("result-channel: the signing key never appears in a token or error", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const token = auth.mint(RUN_A, JOB_A);
  assert.equal(token.includes(KEY), false);
  assert.throws(() => auth.mint("bad run id!", JOB_A), RangeError);
});

test("result-channel: a short signing key is refused at construction", () => {
  assert.throws(() => createResultChannelAuth({ key: "tiny" }), RangeError);
});

test("result-channel: different keys derive different tokens", () => {
  const authA = createResultChannelAuth({ key: KEY });
  const authB = createResultChannelAuth({ key: "another-signing-key-0123456789abcdef" });
  assert.notEqual(authA.mint(RUN_A, JOB_A), authB.mint(RUN_A, JOB_A));
  assert.equal(authB.verify(authA.mint(RUN_A, JOB_A), RUN_A, JOB_A), false);
});
