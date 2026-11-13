import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveToolMaxRequests,
  sizeScaledToolBudget,
  toolBudgetSizeFromArtifacts,
  lowRiskToolBudgetCap,
  LOW_RISK_BUDGET_MIN_REQUESTS,
  LOW_RISK_BUDGET_MAX_REQUESTS,
  TOOL_REQUEST_HARD_MAX,
  TOOL_REQUEST_TIER_DEFAULTS,
} from "../src/tools/budget.js";

test("primary override wins on the primary route only and reports its source", () => {
  const primary = resolveToolMaxRequests("primary", { PRIMARY_TOOL_MAX_REQUESTS: "12", TOOL_MAX_REQUESTS: "3" });
  assert.deepEqual(primary, { route: "primary", budget: 12, source: "primary-override", configured: 12 });
  const smart = resolveToolMaxRequests("smart", { PRIMARY_TOOL_MAX_REQUESTS: "12" });
  assert.deepEqual(smart, { route: "smart", budget: 45, source: "tier-default", configured: null });
  const invalid = resolveToolMaxRequests("primary", { PRIMARY_TOOL_MAX_REQUESTS: "abc", TOOL_MAX_REQUESTS: "7" });
  assert.equal(invalid.source, "explicit");
  assert.equal(invalid.budget, 7);
});

test("without a size signal the resolver keeps the pre-#810 tier defaults", () => {
  // No third argument: exercise the no-size-signal call shape.
  assert.deepEqual(resolveToolMaxRequests("primary", {}), { route: "primary", budget: 40, source: "tier-default", configured: null });
  assert.deepEqual(resolveToolMaxRequests("smart", {}), { route: "smart", budget: 45, source: "tier-default", configured: null });
  assert.deepEqual(resolveToolMaxRequests("smart", { TOOL_ESCALATION: "true" }), { route: "escalated", budget: 50, source: "tier-default", configured: null });
  // #1253: the tier is the only route signal — a stray REVIEW_CONTEXT_PROFILE
  // env value (the removed ambient override) never widens the primary budget.
  assert.deepEqual(
    resolveToolMaxRequests("primary", { REVIEW_CONTEXT_PROFILE: "smart" }),
    { route: "primary", budget: 40, source: "tier-default", configured: null },
  );
  // An explicit null size (no artifacts seen) behaves identically.
  assert.equal(resolveToolMaxRequests("smart", {}, null).source, "tier-default");
});

test("#810: a large PR scales the budget above the smart tier default but under the ceiling", () => {
  // The #806 shape from the issue: 54 files, +4346/-181, several leads.
  const size = { changedFiles: 54, changedLines: 4346 + 181, specialistLeads: 10 };
  const smart = resolveToolMaxRequests("smart", {}, size);
  assert.equal(smart.budget, 14 + 12 + 20); // ceil(54/4) + ceil(4527/400) + 10*2
  assert.equal(smart.source, "size-scaled");
  assert.equal(smart.configured, null);
  assert.ok(smart.budget > 45, "scaled budget must exceed the smart tier default");
  assert.ok(smart.budget < TOOL_REQUEST_HARD_MAX, "scaled budget must stay under the hard ceiling");
  // The floor is per-route: the same PR on the primary route also scales above 40.
  const primary = resolveToolMaxRequests("primary", {}, size);
  assert.equal(primary.budget, 46);
  assert.equal(primary.source, "size-scaled");
  // Escalated route floors at 50; the derivation does not shrink it.
  assert.equal(resolveToolMaxRequests("smart", { TOOL_ESCALATION: "true" }, size).budget, 50);
});

test("#810: a huge PR clamps at the hard ceiling", () => {
  const size = { changedFiles: 400, changedLines: 40000, specialistLeads: 50 };
  assert.equal(sizeScaledToolBudget(size, "escalated"), TOOL_REQUEST_HARD_MAX);
  assert.equal(resolveToolMaxRequests("primary", {}, size).budget, TOOL_REQUEST_HARD_MAX);
  assert.equal(resolveToolMaxRequests("primary", {}, size).source, "size-scaled");
});

test("#810: a small PR's budget matches today's tier default via the floor", () => {
  const small = { changedFiles: 3, changedLines: 120, specialistLeads: 0 };
  assert.equal(resolveToolMaxRequests("primary", {}, small).budget, TOOL_REQUEST_TIER_DEFAULTS.primary);
  assert.equal(resolveToolMaxRequests("primary", {}, small).source, "tier-default");
  assert.equal(resolveToolMaxRequests("smart", {}, small).budget, TOOL_REQUEST_TIER_DEFAULTS.smart);
  // Exactly at a tier default: the floor binds, the source stays tier-default.
  const exact = { changedFiles: 0, changedLines: 0, specialistLeads: 20 };
  assert.equal(resolveToolMaxRequests("primary", {}, exact).budget, 40);
  assert.equal(resolveToolMaxRequests("primary", {}, exact).source, "tier-default");
});

test("#810: explicit overrides and tier overrides still beat the scaled default", () => {
  const size = { changedFiles: 54, changedLines: 4527, specialistLeads: 6 };
  assert.deepEqual(resolveToolMaxRequests("smart", { TOOL_MAX_REQUESTS: "5" }, size), { route: "smart", budget: 5, source: "explicit", configured: 5 });
  assert.deepEqual(resolveToolMaxRequests("smart", { SMART_TOOL_MAX_REQUESTS: "10", TOOL_MAX_REQUESTS: "3" }, size), { route: "smart", budget: 10, source: "smart-override", configured: 10 });
  assert.deepEqual(resolveToolMaxRequests("primary", { PRIMARY_TOOL_MAX_REQUESTS: "12" }, size), { route: "primary", budget: 12, source: "primary-override", configured: 12 });
});

test("#810: junk size components degrade to zero, never widen the budget", () => {
  const junk = { changedFiles: Number.NaN, changedLines: -5, specialistLeads: 1.9 };
  assert.equal(resolveToolMaxRequests("primary", {}, junk).budget, TOOL_REQUEST_TIER_DEFAULTS.primary);
  assert.equal(resolveToolMaxRequests("primary", {}, junk).source, "tier-default");
});

test("#810: the size signal loads from the artifacts the harness can see", () => {
  const artifacts: Record<string, string> = {
    "pr.json": JSON.stringify({ number: 806, changedFiles: 54, additions: 4346, deletions: 181 }),
    "specialist-correctness.json": JSON.stringify({ version: 1, leads: [{ file: "a.ts" }], errors: [] }),
    "specialist-security.json": JSON.stringify({ version: 1, leads: [{ file: "b.ts" }, { file: null }], errors: [] }),
    // tests role artifact absent → contributes zero
  };
  const size = toolBudgetSizeFromArtifacts((name) => artifacts[name] ?? null);
  assert.deepEqual(size, { changedFiles: 54, changedLines: 4527, specialistLeads: 3 });

  // pr.json absent: the manifest carries count and lines.
  const manifestOnly = toolBudgetSizeFromArtifacts((name) =>
    name === "pr-files.json"
      ? JSON.stringify([
        { filename: "a.ts", additions: 10, deletions: 2 },
        { filename: "b.ts", additions: 5, deletions: 0, changes: 5 },
        { note: "file list truncated" },
      ])
      : null);
  assert.deepEqual(manifestOnly, { changedFiles: 2, changedLines: 17, specialistLeads: 0 });

  // Nothing readable: zeros → the resolver floors at the tier default.
  const empty = toolBudgetSizeFromArtifacts(() => null);
  assert.deepEqual(empty, { changedFiles: 0, changedLines: 0, specialistLeads: 0 });
  const broken = toolBudgetSizeFromArtifacts(() => "{not json");
  assert.deepEqual(broken, { changedFiles: 0, changedLines: 0, specialistLeads: 0 });
});

// ── #1629: the deterministic low-risk evidence envelope ──────────────────

test("#1629: a digest-only kind with no risk flags caps the envelope at the mandatory-row floor", () => {
  // The #12074 shape: one local verification row, no risk flags.
  const cap = lowRiskToolBudgetCap({ prKind: "image_digest_only", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 1 });
  assert.deepEqual(cap, { cap: LOW_RISK_BUDGET_MIN_REQUESTS, basis: "digest-only", mandatoryRows: 1 });
  assert.equal(cap!.cap, 6);
  const renovate = lowRiskToolBudgetCap({ prKind: "renovate_digest_only", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 0 });
  assert.deepEqual(renovate, { cap: 6, basis: "digest-only", mandatoryRows: 0 });
});

test("#1629: the envelope scales with enforced mandatory rows and clamps at the ceiling", () => {
  // The #1595/#1618 low-risk lockfile shape: three scoped rows.
  const lockfile = lowRiskToolBudgetCap({ prKind: "dependency_upgrade", riskFlagCount: 0, lockfileOnlyMaterial: 0, lockfileOnlyParseable: true, mandatoryRows: 3 });
  assert.deepEqual(lockfile, { cap: 10, basis: "low-risk-lockfile", mandatoryRows: 3 });
  // Many rows never exceed the ceiling — no per-package archaeology rides
  // under a low-risk classification.
  const many = lowRiskToolBudgetCap({ prKind: "image_digest_only", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 40 });
  assert.equal(many!.cap, LOW_RISK_BUDGET_MAX_REQUESTS);
});

test("#1629: any risk flag retains the full envelope — risk escalation outranks proportionality", () => {
  for (const flags of [1, 2, 5]) {
    assert.equal(lowRiskToolBudgetCap({ prKind: "image_digest_only", riskFlagCount: flags, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 1 }), null);
    assert.equal(lowRiskToolBudgetCap({ prKind: "dependency_upgrade", riskFlagCount: flags, lockfileOnlyMaterial: 0, lockfileOnlyParseable: true, mandatoryRows: 3 }), null);
  }
});

test("#1629: the lockfile envelope opens only on the #1595 positive proof", () => {
  // Material bump: full envelope.
  assert.equal(lowRiskToolBudgetCap({ prKind: "dependency_upgrade", riskFlagCount: 0, lockfileOnlyMaterial: 1, lockfileOnlyParseable: true, mandatoryRows: 3 }), null);
  // Unparseable triage fails closed to material.
  assert.equal(lowRiskToolBudgetCap({ prKind: "dependency_upgrade", riskFlagCount: 0, lockfileOnlyMaterial: 0, lockfileOnlyParseable: false, mandatoryRows: 3 }), null);
  // No triage at all: the digest kinds are the only class left, and an
  // app_code/dependency kind without proof retains everything.
  assert.equal(lowRiskToolBudgetCap({ prKind: "dependency_upgrade", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 3 }), null);
  assert.equal(lowRiskToolBudgetCap({ prKind: "app_code", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 2 }), null);
  // The obligation-bearing image/chart families deliberately stay outside
  // the envelope: their #1379 upstream-evidence rows need real budget.
  assert.equal(lowRiskToolBudgetCap({ prKind: "renovate_image_update", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 4 }), null);
  assert.equal(lowRiskToolBudgetCap({ prKind: "image_update", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 3 }), null);
});

test("#1629: unshaped signals fail open — the envelope narrows only on positive proof", () => {
  assert.equal(lowRiskToolBudgetCap({ prKind: "", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 1 }), null);
  assert.equal(lowRiskToolBudgetCap({ prKind: "image_digest_only", riskFlagCount: -1, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: 1 }), null);
  assert.equal(lowRiskToolBudgetCap({ prKind: "image_digest_only", riskFlagCount: 0, lockfileOnlyMaterial: null, lockfileOnlyParseable: false, mandatoryRows: -3 }), null);
});
