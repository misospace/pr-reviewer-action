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

test("provenance module is forge-agnostic and cannot be weakened by fork-context (#1015 / fork privilege separation)", async () => {
  // Regression-style guard for the fork privilege separation invariant:
  // #1015's evidence-provenance primitives must not reference fork-specific
  // code paths (FORK_*, `is_fork`, fork label handling, etc.) or weaken the
  // fork trust boundary. The new module is the verification primitive for
  // verdict policy and is shared between fork and same-repo runs; a fork
  // author must not be able to influence a literal-claim authorization by
  // referencing fork-only flags. This test reads the source as text — the
  // #1015 module is small, pure, and has no I/O dependencies to substitute.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const here = path.dirname(__filename);
  // `tests-v3/evidence-provenance.test.ts` lives at the repo root; the
  // module source sits at `src/context/evidence-provenance.ts`. We resolve
  // from the test file's directory so the assertion stays correct under
  // both the source tree (`tsc -p tsconfig.test.json`) and the compiled
  // test-build mirror (`.test-build/tests-v3/...`).
  const modulePath = path.resolve(here, "../../src/context/evidence-provenance.ts");
  const source = await fs.readFile(modulePath, "utf8");
  // The module MUST stay forge-agnostic: a fork-only flag, fork label, or
  // FORK_* token would let a fork author reach into the authorization
  // primitives. The grep below is the assertion; any new line that adds
  // such a token fails the test.
  for (const token of ["FORK_PRIMARY", "FORK_SMART", "FORK_LITELLM", "ai-review-fork", "isFork", "is_fork", "pull_request_target"]) {
    assert.ok(!source.includes(token), `evidence-provenance.ts must not reference fork-specific token: ${token}`);
  }
});
