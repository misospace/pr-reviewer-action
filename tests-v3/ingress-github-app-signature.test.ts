import test from "node:test";
import assert from "node:assert/strict";

import {
  computeGitHubWebhookSignature,
  verifyGitHubWebhookSignature,
} from "../src/ingress/github-app-signature.js";

const SECRET = "github-app-webhook-secret";

function signatureOf(body: string, secret: string = SECRET): string {
  return computeGitHubWebhookSignature(secret, body);
}

// ── the accept path ─────────────────────────────────────────────────────────

test("valid prefixed signature over a string body verifies true", () => {
  const body = '{"action":"synchronize","number":7}';
  const signature = signatureOf(body);
  assert.match(signature, /^sha256=[0-9a-f]{64}$/, "the emitted form is the sha256= prefixed lowercase hex digest");
  assert.equal(verifyGitHubWebhookSignature(SECRET, signature, body), true);
});

test("Buffer body produces the same signature as the string form and verifies true", () => {
  const body = '{"action":"opened","number":7}';
  const bufferBody = Buffer.from(body, "utf8");
  assert.equal(computeGitHubWebhookSignature(SECRET, bufferBody), signatureOf(body));
  assert.equal(verifyGitHubWebhookSignature(SECRET, signatureOf(body), bufferBody), true);
});

// ── rejections ──────────────────────────────────────────────────────────────

test("wrong secret verifies false", () => {
  const body = "hello, github";
  assert.equal(verifyGitHubWebhookSignature("some-other-secret", signatureOf(body), body), false);
});

test("one flipped hex character verifies false", () => {
  const body = "hello, github";
  const signature = signatureOf(body);
  const flipped = (signature[7] === "0" ? "1" : "0") + signature.slice(8);
  assert.notEqual(flipped, signature);
  assert.equal(verifyGitHubWebhookSignature(SECRET, flipped, body), false);
});

test("the bare (unprefixed) hex digest verifies false on this seam", () => {
  const body = "hello, github";
  const bare = signatureOf(body).slice("sha256=".length);
  assert.equal(verifyGitHubWebhookSignature(SECRET, bare, body), false);
});

test("a different prefix (sha1=) verifies false", () => {
  const body = "hello, github";
  const signature = signatureOf(body);
  assert.equal(verifyGitHubWebhookSignature(SECRET, `sha1=${signature.slice(7)}`, body), false);
});

test("a padded/space-separated prefix verifies false", () => {
  const body = "hello, github";
  const signature = signatureOf(body);
  assert.equal(verifyGitHubWebhookSignature(SECRET, `SHA256=${signature.slice(7)}`, body), false);
  assert.equal(verifyGitHubWebhookSignature(SECRET, ` sha256=${signature.slice(7)}`, body), false);
  assert.equal(verifyGitHubWebhookSignature(SECRET, `sha256= ${signature.slice(7)}`, body), false);
});

test("UPPERCASE hex verifies false", () => {
  const body = "hello, github";
  const upper = signatureOf(body).toUpperCase();
  assert.ok(upper.includes("A") || upper.includes("B"), "the uppercase form must actually differ");
  assert.equal(verifyGitHubWebhookSignature(SECRET, upper, body), false);
});

test("a 63-hex digest verifies false", () => {
  const body = "hello, github";
  const short = `sha256=${signatureOf(body).slice(7, 7 + 63)}`;
  assert.equal(short.length, 70);
  assert.equal(verifyGitHubWebhookSignature(SECRET, short, body), false);
});

test("a 65-hex digest verifies false", () => {
  const body = "hello, github";
  assert.equal(verifyGitHubWebhookSignature(SECRET, `${signatureOf(body)}a`, body), false);
});

test("a 64-character non-hex digest verifies false", () => {
  const body = "hello, github";
  assert.equal(verifyGitHubWebhookSignature(SECRET, `sha256=${"g".repeat(64)}`, body), false);
});

test("an empty header, an undefined header, and a trailing-newline header all verify false", () => {
  const body = "hello, github";
  assert.equal(verifyGitHubWebhookSignature(SECRET, "", body), false);
  assert.equal(verifyGitHubWebhookSignature(SECRET, undefined, body), false);
  assert.equal(verifyGitHubWebhookSignature(SECRET, `${signatureOf(body)}\n`, body), false);
});

test("duplicate header array is refused, not picked from", () => {
  const body = "hello, github";
  const signature = signatureOf(body);
  assert.equal(verifyGitHubWebhookSignature(SECRET, [signature, signature], body), false);
  assert.equal(
    verifyGitHubWebhookSignature(SECRET, [signature, signatureOf("other", "other-secret")], body),
    false,
  );
});

test("empty configured secret verifies false even when the header matches the empty-secret computation", () => {
  const body = "hello, github";
  const emptySecretSignature = computeGitHubWebhookSignature("", body);
  assert.equal(verifyGitHubWebhookSignature("", emptySecretSignature, body), false);
});

test("a signature computed over a DIFFERENT body verifies false", () => {
  const body = '{"action":"opened","number":7}';
  assert.equal(verifyGitHubWebhookSignature(SECRET, signatureOf('{"action":"closed","number":7}'), body), false);
});

// ── hostile boundary (#252): feed the boundary token itself ──────────────────

test("a body that carries its own sha256= digest text still verifies on its true signature", () => {
  const head = '{"delivery":"sha256=';
  const embedded = computeGitHubWebhookSignature(SECRET, head).slice("sha256=".length);
  const body = `${head}${embedded}"}`;
  assert.ok(body.includes(`sha256=${embedded}`), "the body really carries the boundary token");
  assert.equal(verifyGitHubWebhookSignature(SECRET, signatureOf(body), body), true);
});

test("a body that contains a full attacker-chosen signature cannot forge acceptance", () => {
  const body = '{"action":"opened","note":"sha256=' + "a".repeat(64) + '"}';
  // The attacker picks the header value outright; the body merely quotes it.
  const forged = `sha256=${"a".repeat(64)}`;
  assert.ok(body.includes(forged), "the body embeds the forged header value");
  assert.equal(verifyGitHubWebhookSignature(SECRET, forged, body), false);
});

test("a header value embedded in the body, replayed against that same body, verifies false", () => {
  const quoted = `sha256=${"b".repeat(64)}`;
  const body = `{"note":"${quoted}"}`;
  assert.ok(body.includes(quoted), "the body embeds the replayed header value");
  assert.equal(verifyGitHubWebhookSignature(SECRET, quoted, body), false);
});

test("a body that is entirely the attacker's own signature line cannot self-accept", () => {
  const line = `sha256=${"c".repeat(64)}`;
  assert.equal(verifyGitHubWebhookSignature(SECRET, line, line), false);
});