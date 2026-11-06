import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEGATIVE_EVIDENCE_SCHEMA,
  deriveNegativeEvidenceRules,
  EVIDENCE_NEGATIVE_EVIDENCE_FILE,
  isCleanNegativeEvidenceRun,
  negativeEvidenceHeadSha,
  serializeNegativeEvidenceArtifact,
  type NegativeEvidenceRule,
} from "../src/evidence/negative-evidence.js";
import { parseNegativeEvidenceSpec } from "../src/evidence/providers.js";
import { PyFloat } from "../src/evidence/index.js";
import { runEvidenceProvidersPhase, type EvidenceSummary } from "../src/evidence/orchestrate.js";
import type { EvidenceProviderEntry } from "../src/evidence/providers.js";
import {
  applyNegativeEvidence,
  applyNegativeEvidenceToRecord,
  negativeEvidenceClaimMatches,
  negativeEvidencePathCovered,
  negativeEvidenceRulesFromArtifact,
} from "../src/enforcement/negative-evidence.js";
import type { ArtifactFinding } from "../src/enforcement/artifact.js";
import { startMockServer } from "./helpers.js";
import { runReviewEngine } from "../src/engine/review.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

const HEAD = "a".repeat(40);

function entry(id: string, overrides: Partial<EvidenceProviderEntry> = {}): EvidenceProviderEntry {
  return {
    id, status: "ok", command: id, duration_sec: new PyFloat(0),
    exit_code: 0, provider_severity: "info", findings: [],
    stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false, output_format: "text",
    ...overrides,
  };
}

function finding(overrides: Partial<ArtifactFinding>): ArtifactFinding {
  return { severity: "major", category: "style", file: "src/a.ts", line: 3, message: "", ...overrides };
}

function formatterRule(overrides: Partial<NegativeEvidenceRule> = {}): NegativeEvidenceRule {
  return {
    provider: "prettier", domain: "formatter", paths: ["src/"], categories: ["style"],
    max_severity: "major", identity: "prettier", rules: [], head_sha: HEAD, ...overrides,
  };
}

// ── Spec parsing (trust source) ──────────────────────────────────────────

test("#1517 spec: a valid formatter declaration parses", () => {
  const spec = parseNegativeEvidenceSpec({
    domain: "formatter", paths: ["src/", "*.md"], categories: ["style"], max_severity: "minor",
  });
  assert.ok(spec !== null);
  assert.deepEqual(spec.paths, ["src/", "*.md"]);
  assert.deepEqual(spec.categories, ["style"]);
  assert.equal(spec.max_severity, "minor");
  assert.equal(spec.identity, null);
  assert.deepEqual(spec.rules, []);
});

test("#1517 spec: malformed declarations fail closed to null", () => {
  const valid = { domain: "lint", paths: ["src/"], categories: ["style"] };
  assert.equal(parseNegativeEvidenceSpec(undefined), null);
  assert.equal(parseNegativeEvidenceSpec("clean"), null);
  assert.equal(parseNegativeEvidenceSpec([]), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, domain: "security" }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, domain: 7 }), null);
  assert.equal(parseNegativeEvidenceSpec({ domain: "lint" }), null, "paths required");
  assert.equal(parseNegativeEvidenceSpec({ ...valid, paths: [] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, paths: ["/abs/x"] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, paths: ["a/../b"] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, paths: ["a\\b"] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, paths: [""] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, categories: [] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, categories: ["security"] }), null, "security is never contradictable");
  assert.equal(parseNegativeEvidenceSpec({ ...valid, categories: ["requirements"] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, categories: ["nonsense"] }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, max_severity: "blocker" }), null, "blocker ceiling refused");
  assert.equal(parseNegativeEvidenceSpec({ ...valid, max_severity: "catastrophic" }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, identity: "" }), null);
  assert.equal(parseNegativeEvidenceSpec({ ...valid, unknown_key: true }), null, "unknown keys refused");
  assert.equal(parseNegativeEvidenceSpec({ ...valid, paths: Array.from({ length: 65 }, (_, i) => `d${i}`) }), null, "path count capped");
});

// ── Derivation (clean-run gate) ──────────────────────────────────────────

const FORMATTER_SPEC = { id: "prettier", command: ["true"], negative_evidence: { domain: "formatter", paths: ["src/"], categories: ["style"] } };

test("#1517 derivation: a clean run with a declaration derives a head-stamped rule", () => {
  const rules = deriveNegativeEvidenceRules([FORMATTER_SPEC], [entry("prettier")], HEAD);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.provider, "prettier");
  assert.equal(rules[0]!.domain, "formatter");
  assert.deepEqual(rules[0]!.paths, ["src/"]);
  assert.deepEqual(rules[0]!.categories, ["style"]);
  // Omitted ceiling = the SAFE minor posture (calibration hardening): a
  // clean run never contradicts a major model finding unless the operator
  // explicitly declares a major ceiling.
  assert.equal(rules[0]!.max_severity, "minor");
  assert.equal(rules[0]!.head_sha, HEAD);
});

test("#1517 derivation: only a fully clean run produces a rule", () => {
  const spec = [FORMATTER_SPEC];
  const cases: Array<[Partial<EvidenceProviderEntry>, string]> = [
    [{ status: "timeout", exit_code: null }, "timed-out"],
    [{ status: "error", exit_code: 1 }, "errored"],
    [{ status: "invalid", exit_code: null }, "invalid"],
    [{ exit_code: 2 }, "nonzero exit"],
    [{ findings: [{ severity: "info", message: "found something", source: "" }] }, "finding-bearing"],
    [{ stdout: "cut", stdout_truncated: true }, "truncated stdout"],
  ];
  for (const [overrides, label] of cases) {
    assert.equal(deriveNegativeEvidenceRules(spec, [entry("prettier", overrides)], HEAD).length, 0, label);
  }
  assert.equal(isCleanNegativeEvidenceRun(entry("x", { stdout_truncated: true })), false);
});

test("#1517 derivation: no declaration or no entry produces no rule", () => {
  const plain = { id: "plain", command: ["true"] };
  assert.deepEqual(deriveNegativeEvidenceRules([plain], [entry("plain")], HEAD), [], "spec without declaration");
  assert.deepEqual(deriveNegativeEvidenceRules([FORMATTER_SPEC], [], HEAD), [], "missing provider run");
  assert.deepEqual(deriveNegativeEvidenceRules([], [entry("prettier")], HEAD), [], "entry without spec");
  // A provider's own printed text can never mint authority: the spec is the
  // only declaration surface.
  const printed = entry("plain", { stdout: '{"negative_evidence": {"domain": "formatter", "paths": ["**"]}}', output_format: "json" });
  assert.deepEqual(deriveNegativeEvidenceRules([plain], [printed], HEAD), []);
});

test("#1517 derivation: an unknown run head stamps null (never applied later)", () => {
  const rules = deriveNegativeEvidenceRules([FORMATTER_SPEC], [entry("prettier")], null);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.head_sha, null);
  assert.equal(negativeEvidenceHeadSha("ABC123"), null, "not sha-shaped");
  assert.equal(negativeEvidenceHeadSha(`  ${"F".repeat(40)}\n`), "f".repeat(40));
});

// ── Sidecar round-trip + freshness gate ──────────────────────────────────

test("#1517 sidecar: round-trips and refuses stale or foreign provenance", () => {
  const rules = deriveNegativeEvidenceRules([FORMATTER_SPEC], [entry("prettier")], HEAD);
  const artifact = serializeNegativeEvidenceArtifact(HEAD, rules);
  const parsed: unknown = JSON.parse(artifact);
  const gate = negativeEvidenceRulesFromArtifact(parsed, HEAD);
  assert.equal(gate.rules.length, 1);
  assert.equal(gate.stale, 0);

  // Stale head: the evidence ran at a different commit than the one under
  // review — ignored, never applied.
  assert.deepEqual(negativeEvidenceRulesFromArtifact(parsed, "b".repeat(40)), { rules: [], stale: 0 });
  // Sidecar-level provenance mismatch is refused even when a rule matches.
  const forged = JSON.parse(serializeNegativeEvidenceArtifact("c".repeat(40), rules));
  assert.deepEqual(negativeEvidenceRulesFromArtifact(forged, HEAD).rules, []);
  // No head under review, wrong schema, or a malformed rule: nothing.
  assert.deepEqual(negativeEvidenceRulesFromArtifact(parsed, null).rules, []);
  assert.deepEqual(negativeEvidenceRulesFromArtifact({ schema_version: "other/v1", rules }, HEAD).rules, []);
  assert.deepEqual(negativeEvidenceRulesFromArtifact(null, HEAD), { rules: [], stale: 0 });
  const mixed = { schema_version: NEGATIVE_EVIDENCE_SCHEMA, head_sha: HEAD, rules: [...rules, { provider: "x" }] };
  const mixedGate = negativeEvidenceRulesFromArtifact(mixed, HEAD);
  assert.equal(mixedGate.rules.length, 1);
  assert.equal(mixedGate.stale, 1, "malformed rule counted as stale");
});

// ── Application ──────────────────────────────────────────────────────────

test("#1517 apply: formatter-clean demotes only the formatting claim in its covered file", () => {
  const rules = [formatterRule()];
  const formatting = finding({ message: "Trailing whitespace on line 3" });
  const outcome = applyNegativeEvidence([formatting], rules);
  assert.equal(outcome.demoted, 1);
  assert.equal(formatting.severity, "minor");
  assert.equal(formatting.capped_from, "major");
  assert.deepEqual(formatting.negative_evidence, {
    provider: "prettier", domain: "formatter", decision: "demoted",
    reason: `negative evidence: formatter provider 'prettier' ran clean at head ${HEAD.slice(0, 12)} covering 'src/'; major demoted to minor`,
  });
  assert.equal(outcome.decisions.length, 1);
  assert.equal(outcome.decisions[0]!.decision, "demoted");
  assert.match(outcome.decisions[0]!.reason, /ran clean at head/);
  // Idempotent: a second pass never re-demotes.
  const again = applyNegativeEvidence([formatting], rules);
  assert.equal(again.demoted, 0);
  assert.equal(formatting.severity, "minor");
});

test("#1517 apply: the same clean signal cannot touch semantic or security findings", () => {
  const rules = [formatterRule()];
  const semantic = finding({ category: "bug", file: "src/a.ts", message: "Trailing whitespace handling will crash the parser on empty input" });
  const security = finding({ category: "security", file: "src/a.ts", message: "Trailing whitespace exposes a secret in the log" });
  const outcome = applyNegativeEvidence([semantic, security], rules);
  assert.equal(outcome.demoted, 0);
  assert.deepEqual(outcome.decisions, []);
  assert.equal(semantic.severity, "major");
  assert.equal(semantic.negative_evidence, undefined);
  assert.equal(security.severity, "major");
  assert.equal(security.negative_evidence, undefined);
});

test("#1517 apply: blocker findings are never demoted but the refusal is recorded", () => {
  const rules = [formatterRule()];
  const blocker = finding({ severity: "blocker", message: "Trailing whitespace violates the style guide" });
  const outcome = applyNegativeEvidence([blocker], rules);
  assert.equal(outcome.demoted, 0);
  assert.equal(blocker.severity, "blocker");
  assert.equal(blocker.negative_evidence, undefined);
  assert.equal(outcome.decisions.length, 1);
  assert.match(outcome.decisions[0]!.reason, /never contradicted/);
});

test("#1517 apply: stale-head clean evidence is ignored", () => {
  const rules = deriveNegativeEvidenceRules([FORMATTER_SPEC], [entry("prettier")], HEAD);
  const staleGate = negativeEvidenceRulesFromArtifact(
    JSON.parse(serializeNegativeEvidenceArtifact(HEAD, rules)),
    "b".repeat(40),
  );
  assert.equal(staleGate.rules.length, 0);
  const target = finding({ message: "Trailing whitespace on line 3" });
  const outcome = applyNegativeEvidence([target], staleGate.rules);
  assert.equal(outcome.demoted, 0);
  assert.equal(target.severity, "major");
});

test("#1517 apply: partial file coverage affects only covered paths", () => {
  const rules = [formatterRule({ paths: ["src/sub/", "one.ts"] })];
  const covered = finding({ file: "src/sub/a.ts", message: "Indentation is inconsistent" });
  const sibling = finding({ file: "src/a.ts", message: "Indentation is inconsistent" });
  const otherTree = finding({ file: "docs/guide.md", message: "Indentation is inconsistent" });
  const outside = finding({ file: "../escape.ts", message: "Indentation is inconsistent" });
  const outcome = applyNegativeEvidence([covered, sibling, otherTree, outside], rules);
  assert.equal(outcome.demoted, 1);
  assert.equal(covered.severity, "minor");
  assert.equal(sibling.severity, "major");
  assert.equal(otherTree.severity, "major");
  assert.equal(outside.severity, "major", "unsafe path never covered");
});

test("#1517 apply: positive tool findings leave the model finding untouched (both visible)", () => {
  // The provider reported a finding, so no rule was derived: the
  // contradictory model finding stays exactly as the model wrote it.
  const rules = deriveNegativeEvidenceRules(
    [FORMATTER_SPEC],
    [entry("prettier", { findings: [{ severity: "minor", message: "line too long", source: "" }] })],
    HEAD,
  );
  assert.equal(rules.length, 0);
  const model = finding({ message: "Trailing whitespace on line 3" });
  const outcome = applyNegativeEvidence([model], rules);
  assert.equal(outcome.demoted, 0);
  assert.equal(model.severity, "major");
});

test("#1517 apply: lint rules speak only for their own linter/rule family", () => {
  const lint = formatterRule({ domain: "lint", provider: "eslint", identity: "eslint", rules: ["no-unused-vars"] });
  assert.equal(negativeEvidenceClaimMatches("eslint reports an unused variable here", lint), true);
  assert.equal(negativeEvidenceClaimMatches("violates no-unused-vars", lint), true);
  assert.equal(negativeEvidenceClaimMatches("an unused variable in the handler", lint), false, "unattributed claim untouched");
  assert.equal(negativeEvidenceClaimMatches("ruff found an unused variable", lint), false);
  // Schema domain: cue OR identity.
  const schema = formatterRule({ domain: "schema", provider: "terraform", identity: "terraform" });
  assert.equal(negativeEvidenceClaimMatches("this configuration is schema-invalid", schema), true);
  assert.equal(negativeEvidenceClaimMatches("terraform would reject this block", schema), true);
  assert.equal(negativeEvidenceClaimMatches("the retry logic is wrong", schema), false);
  // Formatter domain: pure formatting claims only.
  assert.equal(negativeEvidenceClaimMatches("bad formatting: mixed tabs and spaces", formatterRule()), true);
  assert.equal(negativeEvidenceClaimMatches("the format string is user-controlled", formatterRule()), false);
});

// ── Calibration regressions (2026-11-06 corpus eval) ─────────────────────

const ALL_CATEGORIES = ["bug", "performance", "style", "docs", "tests", "question", "other", "verification"];

/** The parse-legal maximum an aggressive operator can declare. */
function broadRule(overrides: Partial<NegativeEvidenceRule> = {}): NegativeEvidenceRule {
  return {
    provider: "yamllint", domain: "lint", paths: ["**"], categories: ALL_CATEGORIES,
    max_severity: "major", identity: "yamllint", rules: [], head_sha: HEAD, ...overrides,
  };
}

test("#1517 calibration: an omitted ceiling defaults to the safe minor posture", () => {
  // The corpus eval measured every adjudicated human finding at major or
  // blocker: a default of `major` admitted the whole corpus to the
  // wrong-demotion surface. The default is `minor`; `major` must be
  // declared explicitly.
  const spec = parseNegativeEvidenceSpec({ domain: "formatter", paths: ["src/"], categories: ["style"] });
  assert.ok(spec !== null);
  assert.equal(spec.max_severity, "minor");
  assert.equal(parseNegativeEvidenceSpec({ domain: "formatter", paths: ["src/"], categories: ["style"], max_severity: "major" })?.max_severity, "major", "explicit major still declarable");
  // Behavior: the derived minor-ceiling rule cannot reach a major finding…
  const rules = deriveNegativeEvidenceRules([FORMATTER_SPEC], [entry("prettier")], HEAD);
  const majorClaim = finding({ message: "Trailing whitespace on line 3" });
  assert.equal(applyNegativeEvidence([majorClaim], rules).demoted, 0);
  assert.equal(majorClaim.severity, "major");
  // …but still governs the minor tier it is authoritative for.
  const minorClaim = finding({ severity: "minor", message: "Trailing whitespace on line 3" });
  assert.equal(applyNegativeEvidence([minorClaim], rules).demoted, 1);
  assert.equal(minorClaim.severity, "info");
});

test("#1517 calibration: generic identity/rule-id tokens are refused at parse and at the persistence gate", () => {
  // The eval's identity-hole probe: a generic token word-boundedly matched
  // 71/74 real corpus findings. The declaration seam refuses them outright.
  const valid = { domain: "lint", paths: ["src/"], categories: ["style"] };
  for (const junk of ["the", "The", "code", "lint", "linter", "style", "check", "error", "rule", "a", "e", "go", "of", "is", "  the  ", "  ci  "]) {
    assert.equal(parseNegativeEvidenceSpec({ ...valid, identity: junk }), null, `identity '${junk}' refused`);
  }
  assert.equal(parseNegativeEvidenceSpec({ ...valid, rules: ["the"] }), null, "generic rule id refused");
  assert.equal(parseNegativeEvidenceSpec({ ...valid, rules: ["e"] }), null, "too-short rule id refused");
  assert.equal(parseNegativeEvidenceSpec({ ...valid, rules: ["no-unused-vars", "the"] }), null);
  // Distinctive tokens still parse: hyphenated, multiword, ≥3 chars.
  assert.ok(parseNegativeEvidenceSpec({ ...valid, identity: "yamllint" }) !== null);
  assert.ok(parseNegativeEvidenceSpec({ ...valid, identity: "golangci-lint" }) !== null);
  assert.ok(parseNegativeEvidenceSpec({ ...valid, identity: "go vet" }) !== null);
  assert.ok(parseNegativeEvidenceSpec({ ...valid, rules: ["key-duplicates", "no-unused-vars"] }) !== null);
  // A refused declaration mints no rule at derivation…
  assert.deepEqual(
    deriveNegativeEvidenceRules(
      [{ id: "yamllint", command: ["true"], negative_evidence: { domain: "lint", paths: ["**"], categories: ["style"], identity: "the" } }],
      [entry("yamllint")],
      HEAD,
    ),
    [],
  );
  // …and a tampered/legacy sidecar cannot smuggle one past the persistence
  // gate either.
  const tampered = { schema_version: NEGATIVE_EVIDENCE_SCHEMA, head_sha: HEAD, rules: [broadRule({ identity: "the" })] };
  const gate = negativeEvidenceRulesFromArtifact(tampered, HEAD);
  assert.equal(gate.rules.length, 0);
  assert.equal(gate.stale, 1);
});

test("#1517 calibration: a finding about removing the tool's coverage is never demoted (pr-reviewer-action#467)", () => {
  // Real calibration failure: the "test suite deleted under the guise of
  // add-shellcheck-to-CI" finding names yamllint because the regression
  // REMOVES its coverage — and yamllint verified clean at that head, so the
  // rule derived and the identity gate read the mention as a violation
  // claim. Coverage-alteration claims are refused for every domain.
  const aboutCoverage = "The diff removes the yamllint duplicate-key detection from the validate job, so duplicate keys slip through again.";
  const fullShape = "The PR deletes the entire test suite under the guise of \"add shellcheck to CI.\" The diff removes the entire validate job: 215 pytest cases with coverage gate, smoke_test.sh, 31 bash test suites, py_compile checks, yamllint duplicate-key detection, and action.yml/example YAML validation. The replacement YAML validation does not catch duplicate keys — it silently keeps the last value. SHA-pinned actions were downgraded to a floating tag.";
  assert.equal(negativeEvidenceClaimMatches(aboutCoverage, broadRule()), false);
  assert.equal(negativeEvidenceClaimMatches(fullShape, broadRule()), false);
  const target = finding({ category: "bug", file: ".github/workflows/ci.yaml", message: aboutCoverage });
  const outcome = applyNegativeEvidence([target], [broadRule()]);
  assert.equal(outcome.demoted, 0);
  assert.deepEqual(outcome.decisions, []);
  assert.equal(target.severity, "major");
  // Blocker findings stay forbidden under the same broad declaration.
  const blocker = finding({ severity: "blocker", category: "bug", file: ".github/workflows/ci.yaml", message: fullShape });
  const blockerOutcome = applyNegativeEvidence([blocker], [broadRule()]);
  assert.equal(blockerOutcome.demoted, 0);
  assert.equal(blocker.severity, "blocker");
  // A genuine violation claim naming the same tool still demotes.
  const violation = finding({ category: "bug", file: "deploy/charts/values.yaml", message: "yamllint reports duplicate keys in deploy/charts/values.yaml" });
  assert.equal(negativeEvidenceClaimMatches(violation.message, broadRule()), true);
  assert.equal(applyNegativeEvidence([violation], [broadRule()]).demoted, 1);
  // Word-boundedness is preserved: a tool-name substring is not a mention.
  assert.equal(negativeEvidenceClaimMatches("yamllintplus reports nothing", broadRule()), false);
});

test("#1517 calibration: comparative constructions describe code, they do not claim formatting violations (courier#108)", () => {
  // Real calibration failure: the OpenCode parser-mismatch finding used
  // "whitespace" and "indented" as protocol DESCRIPTIONS — "continuation
  // lines start with a box-drawing character rather than whitespace", "the
  // reason line isn't treated as indented" — and a broad gofmt rule demoted
  // it. A cue that only occurs inside a comparative/treatment construction
  // is refused; a cue occurring as a claim still demotes.
  const gofmt = broadRule({ provider: "gofmt", domain: "formatter", identity: "gofmt" });
  const descriptive = "continuation lines start with a box-drawing character rather than whitespace, so the reason line isn't treated as indented, and it contains the word 'error', so it gets classified as its own failed server";
  assert.equal(negativeEvidenceClaimMatches(descriptive, gofmt), false);
  assert.equal(negativeEvidenceClaimMatches("the parser reads the block instead of whitespace", gofmt), false);
  assert.equal(negativeEvidenceClaimMatches("it gets classified as whitespace by the lexer", gofmt), false);
  const target = finding({ category: "bug", file: "internal/executor/mcp_status.go", message: descriptive });
  const outcome = applyNegativeEvidence([target], [gofmt]);
  assert.equal(outcome.demoted, 0);
  assert.deepEqual(outcome.decisions, []);
  assert.equal(target.severity, "major");
  // Positive controls: real claims still match and still demote.
  assert.equal(negativeEvidenceClaimMatches("Trailing whitespace on line 40", gofmt), true);
  assert.equal(negativeEvidenceClaimMatches("the file is not formatted", gofmt), true);
  // A message mixing a construction with a real claim still claims.
  assert.equal(negativeEvidenceClaimMatches("rather than whitespace, line 3 has trailing whitespace", gofmt), true);
  const realClaim = finding({ category: "bug", file: "internal/executor/mcp_status.go", message: "rather than whitespace, line 3 has trailing whitespace" });
  assert.equal(applyNegativeEvidence([realClaim], [gofmt]).demoted, 1);
});

test("#1517 apply: severity ladder and deterministic findings", () => {
  const rules = [formatterRule()];
  const minor = finding({ severity: "minor", message: "Indentation is off" });
  const info = finding({ severity: "info", message: "Indentation is off" });
  const outcome = applyNegativeEvidence([minor, info], rules);
  assert.equal(outcome.demoted, 1);
  assert.equal(minor.severity, "info");
  assert.equal(minor.capped_from, "minor");
  assert.equal(info.severity, "info");
  assert.equal(info.negative_evidence?.decision, "unchanged");
  // Deterministic enforcement findings are not model claims.
  const requirement = finding({ category: "requirements", message: "Trailing whitespace requirement" });
  assert.equal(applyNegativeEvidence([requirement], rules).decisions.length, 0);
  // A minor ceiling cannot reach a major finding.
  const narrow = applyNegativeEvidence(
    [finding({ message: "Indentation is off" })],
    [formatterRule({ max_severity: "minor" })],
  );
  assert.equal(narrow.demoted, 0);
});

test("#1517 apply: path matching semantics", () => {
  assert.equal(negativeEvidencePathCovered("src/a.ts", ["src"]), "src");
  assert.equal(negativeEvidencePathCovered("src/x/b.ts", ["src/"]), "src/");
  assert.equal(negativeEvidencePathCovered("src/a.ts", ["src/*.ts"]), "src/*.ts");
  assert.equal(negativeEvidencePathCovered("src/x/a.ts", ["src/**/*.ts"]), "src/**/*.ts");
  assert.equal(negativeEvidencePathCovered("src/a.ts", ["src/**/*.ts"]), "src/**/*.ts", "** matches zero segments");
  assert.equal(negativeEvidencePathCovered("docs/readme.md", ["src"]), null);
  assert.equal(negativeEvidencePathCovered("srcx.ts", ["src"]), null);
  // canonicalTreePath normalization mirrors the verifier's path handling.
  assert.equal(negativeEvidencePathCovered("./src//a.ts", ["src/a.ts"]), "src/a.ts");
});

test("#1517 record: decisions are persisted on the review record for eval calibration", () => {
  const rules = [formatterRule()];
  const record: Record<string, unknown> = {
    findings: [finding({ message: "Trailing whitespace on line 3" }), finding({ category: "bug", message: "Null dereference" })],
  };
  applyNegativeEvidenceToRecord(record, rules, 0);
  const persisted = record.negative_evidence as { rules: number; decisions: Array<{ decision: string; reason: string }>; stale_rules: number };
  assert.equal(persisted.rules, 1);
  assert.equal(persisted.decisions.length, 1);
  assert.match(persisted.decisions[0]!.reason, /prettier/);
  assert.equal(persisted.stale_rules, 0);
  // No rules → no artifact key (bytes unchanged for unconfigured runs).
  const plain: Record<string, unknown> = { findings: [finding({})] };
  applyNegativeEvidenceToRecord(plain, [], 2);
  assert.equal("negative_evidence" in plain, false);
});

// ── Evidence-phase integration ───────────────────────────────────────────

function phaseDir(): string {
  return mkdtempSync(join(tmpdir(), "v3-neg-evidence-"));
}

test("#1517 phase: a clean declared provider writes its rule to the sidecar", async () => {
  const dir = phaseDir();
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify([FORMATTER_SPEC]));
    const outcome = await runEvidenceProvidersPhase({
      env: { PATH: process.env.PATH ?? "", HOME: dir, EVIDENCE_PROVIDERS_FILE: "providers.json", PR_HEAD_SHA: HEAD },
      cwd: dir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async () => entry("prettier"),
    });
    assert.equal(outcome, "ran");
    const sidecar = JSON.parse(readFileSync(join(dir, EVIDENCE_NEGATIVE_EVIDENCE_FILE), "utf8")) as { schema_version: string; head_sha: string; rules: Array<{ provider: string; head_sha: string }> };
    assert.equal(sidecar.schema_version, NEGATIVE_EVIDENCE_SCHEMA);
    assert.equal(sidecar.head_sha, HEAD);
    assert.equal(sidecar.rules.length, 1);
    assert.equal(sidecar.rules[0]!.provider, "prettier");
    assert.equal(sidecar.rules[0]!.head_sha, HEAD);
    // The evidence-providers.json contract keeps its v2 byte shape.
    const summary = JSON.parse(readFileSync(join(dir, "evidence-providers.json"), "utf8")) as EvidenceSummary;
    assert.deepEqual(Object.keys(summary).includes("negative_evidence_rules"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1517 phase: skip and failure outcomes write zero rules — no stale leakage", async () => {
  const forked = phaseDir();
  try {
    const outcome = await runEvidenceProvidersPhase({
      env: { PATH: process.env.PATH ?? "", HOME: forked, EVIDENCE_PROVIDERS_FILE: "providers.json" },
      cwd: forked,
      isForkPr: "true",
      enableForForks: "false",
      log: () => undefined,
    });
    assert.equal(outcome, "skipped");
    const sidecar = JSON.parse(readFileSync(join(forked, EVIDENCE_NEGATIVE_EVIDENCE_FILE), "utf8")) as { head_sha: unknown; rules: unknown[] };
    assert.deepEqual(sidecar.rules, []);
    assert.equal(sidecar.head_sha, null);
  } finally {
    rmSync(forked, { recursive: true, force: true });
  }

  const failed = phaseDir();
  try {
    writeFileSync(join(failed, "providers.json"), JSON.stringify([FORMATTER_SPEC]));
    const outcome = await runEvidenceProvidersPhase({
      env: { PATH: process.env.PATH ?? "", HOME: failed, EVIDENCE_PROVIDERS_FILE: "providers.json", PR_HEAD_SHA: HEAD },
      cwd: failed,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async () => { throw new Error("boom"); },
    });
    assert.equal(outcome, "failed");
    const sidecar = JSON.parse(readFileSync(join(failed, EVIDENCE_NEGATIVE_EVIDENCE_FILE), "utf8")) as { rules: unknown[] };
    assert.deepEqual(sidecar.rules, []);
  } finally {
    rmSync(failed, { recursive: true, force: true });
  }
});

test("#1517 phase: a run head that is not a sha stamps null provenance", async () => {
  const dir = phaseDir();
  try {
    writeFileSync(join(dir, "providers.json"), JSON.stringify([FORMATTER_SPEC]));
    await runEvidenceProvidersPhase({
      env: { PATH: process.env.PATH ?? "", HOME: dir, EVIDENCE_PROVIDERS_FILE: "providers.json", PR_HEAD_SHA: "not-a-sha" },
      cwd: dir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async () => entry("prettier"),
    });
    const sidecar = JSON.parse(readFileSync(join(dir, EVIDENCE_NEGATIVE_EVIDENCE_FILE), "utf8")) as { head_sha: unknown; rules: Array<{ head_sha: unknown }> };
    assert.equal(sidecar.head_sha, null);
    assert.equal(sidecar.rules[0]!.head_sha, null);
    // …and the application gate refuses such a rule.
    const gate = negativeEvidenceRulesFromArtifact(sidecar, HEAD);
    assert.equal(gate.rules.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Engine integration ───────────────────────────────────────────────────

function enginePlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", state: "open", draft: false, head: { sha: HEAD, ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 2, additions: 4, deletions: 0 }),
    getPrDiff: async () => "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => [],
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => null,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

function findingsVerdict(): string {
  const content = JSON.stringify({
    verdict: "approve",
    review_markdown: "Two concerns.\n",
    smart_review_requested: false,
    smart_review_reason: null,
    requirement_coverage: null,
    required_check_dispositions: [],
    findings: [
      { severity: "minor", category: "style", file: "src/a.ts", line: 2, message: "Trailing whitespace on the added line" },
      { severity: "major", category: "bug", file: "src/a.ts", line: 2, message: "Unchecked null dereference will crash the handler on empty input" },
    ],
  });
  return JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}

test("#1517 engine: formatter-clean demotes the formatting claim and persists the decision", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(findingsVerdict());
  });
  const root = mkdtempSync(join(tmpdir(), "v3-neg-engine-"));
  const runDir = join(root, "run");
  mkdirSync(runDir);
  writeFileSync(join(runDir, "providers.json"), JSON.stringify([
    { id: "prettier", command: ["/usr/bin/true"], negative_evidence: { domain: "formatter", paths: ["src/"], categories: ["style"] } },
  ]));
  try {
    const request: ReviewRequest = {
      repository: "o/r", prNumber: "7", headSha: HEAD, baseRef: "", isForkPr: "false", platform: "github", forgejoApiUrl: "",
      ciChecksFile: join(runDir, "ci-checks-context.md"),
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": server.url, "ai-model": "m", "ai-stream": "false",
        "ai-api-key": "k", "evidence-providers-file": "providers.json",
      },
      ambient: { PATH: process.env.PATH ?? "" },
      triggerReason: "manual", forceRereview: false,
    };
    const deps: ReviewDependencies = {
      workspace: root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(root, "summary.md"),
      adapter: enginePlatform(), persistArtifacts: true, quiet: true,
      log: () => undefined, error: () => undefined, annotate: () => undefined,
    };
    const result = await runReviewEngine(request, deps);
    assert.equal(existsSync(join(runDir, EVIDENCE_NEGATIVE_EVIDENCE_FILE)), true);
    const artifact = JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as {
      verdict: string;
      findings: Array<Partial<ArtifactFinding>>;
      negative_evidence?: { rules: number; decisions: Array<{ decision: string; provider: string; reason: string }> };
    };
    // The formatting claim was demoted by the deterministic clean run
    // (the declaration omits max_severity, so the default minor ceiling
    // governs: minor → info)…
    const formatting = artifact.findings.find((f) => f.category === "style")!;
    assert.equal(formatting.severity, "info");
    assert.equal(formatting.capped_from, "minor");
    assert.equal(formatting.negative_evidence?.decision, "demoted");
    assert.equal(formatting.negative_evidence?.provider, "prettier");
    // …while the semantic claim is untouched, so the review still blocks.
    const semantic = artifact.findings.find((f) => f.category === "bug")!;
    assert.equal(semantic.severity, "major");
    assert.equal(semantic.negative_evidence, undefined);
    assert.equal(artifact.verdict, "request_changes");
    // Decision + reason persisted for eval calibration.
    assert.equal(artifact.negative_evidence?.rules, 1);
    assert.equal(artifact.negative_evidence?.decisions.length, 1);
    assert.match(artifact.negative_evidence?.decisions[0]!.reason ?? "", /prettier/);
    assert.equal(result.outputs.verdict, "request_changes");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
