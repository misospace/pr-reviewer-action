import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizesLiteralClaim,
  committedSourceProvenance,
  provenanceAttributes,
  sanitizedSourceProvenance,
  untrustedTextProvenance,
  verifySourceSpan,
} from "../src/context/evidence-provenance.js";
import { REDACTED_SOURCE, sourceEvidence } from "../src/context/redact.js";

test("source evidence preserves actual transform provenance", () => {
  const head = "0123456789abcdef";
  const fixture = 'const CANARY = "s3cr3t-credential";\nconst config = { token: "Bearer s3cr3t-credential" };';
  const sanitized = sourceEvidence(fixture, "src/canary.ts", "src/canary.ts", head);
  assert.ok(sanitized.text.includes(REDACTED_SOURCE));
  assert.equal(sanitized.provenance.representation, "sanitized_source");
  assert.equal(sanitized.provenance.synthesized, true);
  assert.ok(sanitized.provenance.redactionCount >= 1);
  assert.equal(authorizesLiteralClaim(sanitized.provenance, head), false);

  const committedMarker = sourceEvidence('const label = "[REDACTED]";', "src/label.ts", "src/label.ts", head);
  assert.equal(committedMarker.provenance.redactionCount, 0);
  assert.equal(committedMarker.provenance.representation, "committed_source");
  assert.equal(committedMarker.provenance.synthesized, false);
  assert.notEqual(committedMarker.provenance.representation, sanitized.provenance.representation);
});

test("source expression references survive unchanged", () => {
  const source = "apiKey: config.apiKey";
  const result = sourceEvidence(source, "src/config.ts", "src/config.ts", "head");
  assert.equal(result.text, source);
  assert.equal(result.provenance.representation, "committed_source");
});

test("hard-coded credential families are masked and marked synthesized", () => {
  for (const credential of ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "sk-abcdefghijklmnopqrstuvwxyz012345"]) {
    const result = sourceEvidence(`const key = "${credential}";`, "src/key.ts", "src/key.ts", "head");
    assert.ok(!result.text.includes(credential));
    assert.equal(result.provenance.representation, "sanitized_source");
    assert.ok(result.provenance.redactionCount >= 1);
  }
  const quoted = sourceEvidence('const token = "quoted-secret-value";', "src/key.ts", "src/key.ts", "head");
  assert.ok(quoted.text.includes(REDACTED_SOURCE));
  assert.equal(quoted.provenance.representation, "sanitized_source");
});

test("literal claims require committed evidence at the exact revision", () => {
  assert.equal(authorizesLiteralClaim(committedSourceProvenance("src/a.ts", "head"), "head"), true);
  assert.equal(authorizesLiteralClaim(sanitizedSourceProvenance(1, "src/a.ts", "head"), "head"), false);
  assert.equal(authorizesLiteralClaim(committedSourceProvenance("src/a.ts", null), "head"), false);
  assert.equal(authorizesLiteralClaim(committedSourceProvenance("src/a.ts", "head"), null), false);
  assert.equal(authorizesLiteralClaim(committedSourceProvenance("src/a.ts", "old"), "head"), false);
});

test("span verification returns only a boolean", () => {
  const needle = "sensitive-literal";
  const result = verifySourceSpan(`const x = "${needle}";`, needle);
  assert.deepEqual(result, { present: true });
  assert.deepEqual(verifySourceSpan("const x = 1;", needle), { present: false });
  assert.deepEqual(verifySourceSpan("text", "  "), { present: false });
  assert.ok(!JSON.stringify(result).includes(needle));
});

test("provenance attributes cannot inject envelope attributes", () => {
  const rendered = provenanceAttributes(committedSourceProvenance('x" onload="evil', 'abc" injected="1'));
  assert.ok(!rendered.includes("onload="));
  assert.ok(!rendered.includes("injected="));
  assert.match(rendered, /^ representation="committed_source" synthesized="false" redaction_count="0"/);
  assert.ok(!rendered.includes('" onload='));
  assert.ok(!rendered.includes('" injected='));
  assert.equal(provenanceAttributes(untrustedTextProvenance()), "");
});
