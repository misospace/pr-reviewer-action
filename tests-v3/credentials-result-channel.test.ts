import test from "node:test";
import assert from "node:assert/strict";
import {
  RESULT_CHANNEL_DEFAULT_TTL_MS,
  RESULT_CHANNEL_TOKEN_RE,
  createResultChannelAuth,
  type ResultChannelIdentity,
} from "../src/credentials/index.js";

const KEY = "controller-signing-key-0123456789abcdef";
const ID_A: ResultChannelIdentity = {
  runId: "run-20261028-aaaa",
  jobId: "job-20261028-aaaa",
  installationId: "1001",
  repoFullName: "owner/repo-a",
};
const ID_B: ResultChannelIdentity = {
  runId: "run-20261028-bbbb",
  jobId: "job-20261028-aaaa",
  installationId: "1001",
  repoFullName: "owner/repo-a",
};
const OTHER_REPO: ResultChannelIdentity = {
  runId: "run-20261028-aaaa",
  jobId: "job-20261028-aaaa",
  installationId: "1001",
  repoFullName: "owner/repo-b",
};
const OTHER_INSTALLATION: ResultChannelIdentity = {
  runId: "run-20261028-aaaa",
  jobId: "job-20261028-aaaa",
  installationId: "2002",
  repoFullName: "owner/repo-a",
};

test("result-channel: mint produces a bounded v1 token with expiry and default TTL", () => {
  let now = 1_000_000;
  const auth = createResultChannelAuth({ key: KEY, now: () => now });
  const minted = auth.mint(ID_A);
  assert.equal(RESULT_CHANNEL_TOKEN_RE.test(minted.token), true);
  assert.equal(minted.expiresAtMs, now + RESULT_CHANNEL_DEFAULT_TTL_MS);
  const custom = auth.mint(ID_A, { ttlMs: 60_000 });
  assert.equal(custom.expiresAtMs, now + 60_000);
  assert.notEqual(custom.token, minted.token);
});

test("result-channel: correct identity verifies", () => {
  const auth = createResultChannelAuth({ key: KEY });
  assert.equal(auth.verify(auth.mint(ID_A).token, ID_A), true);
});

test("result-channel: a token cannot submit for another run or another job", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const tokenA = auth.mint(ID_A).token;
  assert.equal(auth.verify(tokenA, ID_B), false);
  assert.equal(auth.verify(tokenA, OTHER_REPO), false);
  assert.equal(auth.verify(tokenA, OTHER_INSTALLATION), false);
  const tokenB = auth.mint({ ...ID_A, jobId: "job-20261028-bbbb" }).token;
  assert.notEqual(tokenA, tokenB);
  assert.equal(auth.verify(tokenA, { ...ID_A, jobId: "job-20261028-bbbb" }), false);
});

test("result-channel: an expired token is refused even for its own identity", () => {
  let now = 1_000_000;
  const auth = createResultChannelAuth({ key: KEY, now: () => now });
  const minted = auth.mint(ID_A, { ttlMs: 5_000 });
  assert.equal(auth.verify(minted.token, ID_A), true);
  now = minted.expiresAtMs;
  assert.equal(auth.verify(minted.token, ID_A), false);
  // The expiry cannot be forged: swapping in a far-future expiry changes
  // the MAC the verifier computes.
  const farFuture = (minted.expiresAtMs + 10 * RESULT_CHANNEL_DEFAULT_TTL_MS).toString(16);
  const spliced = minted.token.replace(
    minted.token.slice(3, minted.token.indexOf(".", 3)),
    farFuture,
  );
  assert.equal(auth.verify(spliced, ID_A), false);
});

test("result-channel: hostile tokens fail closed without throwing", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const tokenA = auth.mint(ID_A).token;
  assert.equal(auth.verify("", ID_A), false);
  assert.equal(auth.verify("v1.", ID_A), false);
  assert.equal(auth.verify(tokenA.slice(0, -2), ID_A), false);
  assert.equal(auth.verify(`v1.1.${"0".repeat(64)}`, ID_A), false);
  assert.equal(auth.verify(`${tokenA}extra-padding-${"x".repeat(200)}`, ID_A), false);
  assert.equal(auth.verify(tokenA.toUpperCase(), ID_A), false);
  assert.equal(auth.verify("v2." + tokenA.slice(tokenA.indexOf(".", 3) + 1), ID_A), false);
  assert.equal(auth.verify(null as never, ID_A), false);
  assert.equal(auth.verify(tokenA, 42 as never), false);
  // Hostile identity fields are refused too, never digested.
  assert.equal(auth.verify(tokenA, { ...ID_A, runId: "run/../../etc" }), false);
  assert.equal(auth.verify(tokenA, { ...ID_A, repoFullName: "" }), false);
});

test("result-channel: the signing key never appears in a token or error", () => {
  const auth = createResultChannelAuth({ key: KEY });
  const minted = auth.mint(ID_A);
  assert.equal(minted.token.includes(KEY), false);
  assert.throws(() => auth.mint({ ...ID_A, runId: "bad run id!" }), RangeError);
});

test("result-channel: a short signing key and an out-of-range TTL are refused", () => {
  assert.throws(() => createResultChannelAuth({ key: "tiny" }), RangeError);
  const auth = createResultChannelAuth({ key: KEY });
  assert.throws(() => auth.mint(ID_A, { ttlMs: 0 }), RangeError);
  assert.throws(() => auth.mint(ID_A, { ttlMs: 8 * 24 * 3_600_000 }), RangeError);
});

test("result-channel: different keys derive different tokens", () => {
  const authA = createResultChannelAuth({ key: KEY });
  const authB = createResultChannelAuth({ key: "another-signing-key-0123456789abcdef" });
  assert.notEqual(authA.mint(ID_A).token, authB.mint(ID_A).token);
  assert.equal(authB.verify(authA.mint(ID_A).token, ID_A), false);
});
