import test from "node:test";
import assert from "node:assert/strict";
import { REDACTED_SOURCE, maskAndTruncateSource, redactSourceText, redactText } from "../src/context/redact.js";

// #876: repository SOURCE content (tool reads, grep matches, blame, related-code
// snippets) must survive structurally under redaction — only a literal
// credential VALUE is masked, never identifier/property/assignment syntax. The
// heuristic `redactText` policy (untrusted prose/log/web payloads) is
// unchanged and still over-redacts these code shapes, which is exactly the
// #862/#876 false-positive this module fixes for source evidence.

test("#876: code-expression secret-named assignments survive redactSourceText byte-for-byte", () => {
  const lines = [
    "apiKey: config.apiKey,",
    "      apiKey: profile.apiKey,",
    "token: opts.token",
    "password=self.password",
    "secret = getSecret()",
    "accessKey: creds.accessKey,",
  ];
  for (const line of lines) {
    assert.equal(redactSourceText(line), line, `expected ${JSON.stringify(line)} to survive unchanged`);
  }
});

test("#876: redactText (the heuristic prose/log policy) still over-redacts the same code shapes", () => {
  // Documents the bug this module fixes: the ORIGINAL heuristic masker is
  // still appropriate for untrusted prose/logs, but it is not source-safe —
  // callers reading repository source must use redactSourceText instead.
  assert.equal(redactText("apiKey: config.apiKey,"), "[REDACTED]");
  assert.equal(redactText("token: opts.token"), "[REDACTED]");
});

test("#876: real credential literals are still masked by redactSourceText", () => {
  assert.equal(redactSourceText("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), REDACTED_SOURCE);
  assert.equal(redactSourceText("github_pat_abcdefghijklmnopqrstuvwxyz0123456789"), REDACTED_SOURCE);
  assert.equal(redactSourceText("AKIAABCDEFGHIJKLMNOP"), REDACTED_SOURCE);
  assert.equal(redactSourceText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"), `Authorization: ${REDACTED_SOURCE}`);
  // The whole `key: "value"` match is replaced (key name and value both), the
  // same shape the original heuristic masker used — only the QUOTED-LITERAL
  // requirement is new, so a code expression never matches (see above).
  assert.equal(redactSourceText('apiKey: "sk_live_abcdefgh12345678"'), REDACTED_SOURCE);
  assert.equal(redactSourceText("password: 'hunter2hunter2hunter2'"), REDACTED_SOURCE);
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactSourceText(pem), REDACTED_SOURCE);
});

test("#876: the source-safe marker is distinct from the heuristic [REDACTED] marker", () => {
  assert.notEqual(REDACTED_SOURCE, "[REDACTED]");
  assert.doesNotMatch(REDACTED_SOURCE, /\[REDACTED\]/);
});

test("#876: maskAndTruncateSource masks then truncates, same contract as maskAndTruncate", () => {
  const result = maskAndTruncateSource("apiKey: config.apiKey, ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", 12);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "apiKey: conf\n[truncated]");
});

test("#876: PR #862 regression shape — a full property block survives", () => {
  const snippet = [
    "  const config = {",
    "    apiKey: profile.apiKey,",
    "    baseUrl: profile.baseUrl,",
    "  };",
  ].join("\n");
  assert.equal(redactSourceText(snippet), snippet);
});
