import test from "node:test";
import assert from "node:assert/strict";

import {
  computeForgejoWebhookSignature,
  verifyForgejoWebhookSignature,
} from "../src/ingress/signature.js";

const SECRET = "forgejo-webhook-secret";

function signatureOf(body: string): string {
  return computeForgejoWebhookSignature(SECRET, body);
}

test("valid string body verifies true", () => {
  const body = '{"ref":"refs/heads/main","action":"push"}';
  assert.equal(verifyForgejoWebhookSignature(SECRET, signatureOf(body), body), true);
});

test("Buffer body produces the same signature as the string form and verifies true", () => {
  const body = '{"ref":"refs/heads/main","action":"push"}';
  const bufferBody = Buffer.from(body, "utf8");
  assert.equal(computeForgejoWebhookSignature(SECRET, bufferBody), signatureOf(body));
  assert.equal(verifyForgejoWebhookSignature(SECRET, signatureOf(body), bufferBody), true);
});

test("wrong secret verifies false", () => {
  const body = "hello, forgejo";
  assert.equal(verifyForgejoWebhookSignature("some-other-secret", signatureOf(body), body), false);
});

test("one flipped hex character verifies false", () => {
  const body = "hello, forgejo";
  const sig = signatureOf(body);
  const flipped = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  assert.notEqual(flipped, sig);
  assert.equal(verifyForgejoWebhookSignature(SECRET, flipped, body), false);
});

test('GitHub "sha256=" prefixed header verifies false', () => {
  const body = "hello, forgejo";
  assert.equal(verifyForgejoWebhookSignature(SECRET, `sha256=${signatureOf(body)}`, body), false);
});

test("63-character hex header verifies false", () => {
  const body = "hello, forgejo";
  const short = signatureOf(body).slice(0, 63);
  assert.equal(short.length, 63);
  assert.equal(verifyForgejoWebhookSignature(SECRET, short, body), false);
});

test("64-character non-hex header verifies false", () => {
  const body = "hello, forgejo";
  const notHex = "g".repeat(64);
  assert.equal(verifyForgejoWebhookSignature(SECRET, notHex, body), false);
});

test("empty header string verifies false", () => {
  const body = "hello, forgejo";
  assert.equal(verifyForgejoWebhookSignature(SECRET, "", body), false);
});

test("undefined header verifies false", () => {
  const body = "hello, forgejo";
  assert.equal(verifyForgejoWebhookSignature(SECRET, undefined, body), false);
});

test("duplicate header array verifies false", () => {
  const body = "hello, forgejo";
  const sig = signatureOf(body);
  assert.equal(verifyForgejoWebhookSignature(SECRET, [sig, sig], body), false);
});

test("empty configured secret verifies false even when header matches the empty-secret computation", () => {
  const body = "hello, forgejo";
  const emptySecretSig = computeForgejoWebhookSignature("", body);
  assert.equal(verifyForgejoWebhookSignature("", emptySecretSig, body), false);
});

test("UPPERCASE 64-character hex header verifies false", () => {
  const body = "hello, forgejo";
  const upper = signatureOf(body).toUpperCase();
  assert.equal(verifyForgejoWebhookSignature(SECRET, upper, body), false);
});

test("body containing its own signature hex still verifies true", () => {
  const head = "forgejo-webhook-payload:";
  const embedded = computeForgejoWebhookSignature(SECRET, head);
  const body = `${head}${embedded}:trailing`;
  assert.ok(body.includes(embedded));
  assert.equal(verifyForgejoWebhookSignature(SECRET, signatureOf(body), body), true);
});
