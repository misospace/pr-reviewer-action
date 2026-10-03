/**
 * Fixture-mode enforcement CLI for the #680 parity harness and tests-v3.
 *
 * `node dist/index.js enforcement-fixture <fixture.json>` runs the exact
 * production enforcement pipeline — verdict policy → completeness
 * validation → enforcement overlays — over the fixture's artifacts and
 * emits a single JSON line `{ok, values, stderr}` where `values` carries
 * the resulting artifact and completeness result canonicalized with
 * sort_keys (the canonical-artifact VALUE convention the harness compares).
 */
import { readFileSync } from "node:fs";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { ledgerToArtifact, loadLedgerFromValue } from "../requirements/ledger.js";
import { reviewArtifactFromParsed, type ReviewArtifact } from "./artifact.js";
import { applyVerdictPolicy, applyStrictVerdictPolicy, parseNonBlockingCategories, securityRiskFlagged } from "./verdict-policy.js";
import { applyRequiredCheckValidation, type RequiredCheckValidationResult } from "./completeness.js";
import { applyAllEnforcement, failClosedEnforcementFired, type EnforcementInputs } from "./enforce.js";
import type { EnforcementThread } from "./threads.js";
import type { EnforcementHumanReview } from "./human-reviews.js";
import { normalizeRequirementCoverage, extractCoveragePayload } from "./requirement-coverage.js";

interface EnforcementFixture {
  contract: string;
  /** The parsed ai-output.json artifact (snake_case persisted shape). */
  artifact: Record<string, unknown>;
  evidence?: Record<string, unknown> | null;
  tool_harness?: Record<string, unknown> | null;
  threads?: EnforcementThread[] | null;
  human_reviews?: EnforcementHumanReview[] | null;
  classification?: Record<string, unknown> | null;
  /** Deterministic must_check list from the classifier. */
  must_check?: string[];
  /** The requirement ledger artifact (for the coverage fold). */
  ledger?: Record<string, unknown> | null;
  config: {
    verdict_policy?: string;
    non_blocking_finding_categories?: string;
    validate_required_checks?: string;
    required_check_validation_mode?: string;
    evidence_blocker_enforcement?: boolean;
    tool_failure_enforcement?: boolean;
    tool_min_successful_requests?: number;
  };
}

/** Adapt a fixture artifact into the typed working shape (in-place fields). */
function asArtifact(raw: Record<string, unknown>): ReviewArtifact {
  return raw as unknown as ReviewArtifact;
}

export function runEnforcementFixture(fixturePath: string): {
  ok: boolean;
  values?: Record<string, string>;
  stderr?: string;
} {
  let fixture: EnforcementFixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as EnforcementFixture;
  } catch (error) {
    return { ok: false, stderr: `fixture unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (fixture.contract !== "enforcement-pipeline/v1") {
    return { ok: false, stderr: "fixture is not enforcement-pipeline/v1" };
  }
  try {
    const artifact = asArtifact(structuredClone(fixture.artifact));
    const config = fixture.config;
    // The fixture contract's default mirrors the v2 runtime default
    // (VERDICT_POLICY:-model), NOT the v3 contract default ("strict" since
    // #811): this CLI mirrors the v2 runtime default, and every fixture
    // states its policy explicitly.
    const policy = config.verdict_policy ?? "model";
    const categories = parseNonBlockingCategories(config.non_blocking_finding_categories);
    const securityFlagged = securityRiskFlagged(fixture.classification ?? null);
    // The model's own verdict, captured before the pipeline can mutate it —
    // the strict mapping needs it as an input, not as the final answer.
    const modelVerdict = String(fixture.artifact.verdict ?? "");

    let completeness: RequiredCheckValidationResult;
    let applied: number;
    if (policy === "strict") {
      // #811 strict composition: coverage first (the mapping reads
      // `required_checks`), then the enforcement overlays (fail-closed; they
      // may force request_changes), then the strict mapping over the final
      // still-open findings set — thread settlement's re-emitted findings
      // included. The model verdict is captured before anything mutates it.
      completeness = applyRequiredCheckValidation(artifact, {
        enabled: config.validate_required_checks ?? "auto",
        mode: config.required_check_validation_mode ?? "warn",
        mustCheck: fixture.must_check ?? [],
      });
      const inputs: EnforcementInputs = {
        evidenceBlockerEnabled: config.evidence_blocker_enforcement === true,
        toolFailureEnabled: config.tool_failure_enforcement === true,
        toolMinSuccessful: config.tool_min_successful_requests ?? 0,
        evidence: (fixture.evidence ?? null) as EnforcementInputs["evidence"],
        toolHarness: (fixture.tool_harness ?? null) as EnforcementInputs["toolHarness"],
        threads: fixture.threads ?? null,
        humanReviews: fixture.human_reviews ?? null,
        verdictPolicy: policy,
      };
      applied = applyAllEnforcement(artifact, inputs);
      // The fail-closed signal: a forcing layer fired, or the fail-mode
      // completeness pass forced request_changes. The mapping never relaxes
      // a verdict these forced.
      const forced = failClosedEnforcementFired(inputs)
        || (completeness.status === "incomplete" && completeness.mode === "fail");
      applyStrictVerdictPolicy(artifact, { modelVerdict, forced });
    } else {
      // Order mirrors apply_all_enforcement_wrapper: verdict policy, then
      // completeness validation, then enforcement overlays.
      applyVerdictPolicy(artifact, policy, { nonBlockingCategories: categories, securityFlagged });
      completeness = applyRequiredCheckValidation(artifact, {
        enabled: config.validate_required_checks ?? "auto",
        mode: config.required_check_validation_mode ?? "warn",
        mustCheck: fixture.must_check ?? [],
      });
      const inputs: EnforcementInputs = {
        evidenceBlockerEnabled: config.evidence_blocker_enforcement === true,
        toolFailureEnabled: config.tool_failure_enforcement === true,
        toolMinSuccessful: config.tool_min_successful_requests ?? 0,
        evidence: (fixture.evidence ?? null) as EnforcementInputs["evidence"],
        toolHarness: (fixture.tool_harness ?? null) as EnforcementInputs["toolHarness"],
        threads: fixture.threads ?? null,
        humanReviews: fixture.human_reviews ?? null,
        verdictPolicy: policy,
      };
      applied = applyAllEnforcement(artifact, inputs);
    }

    // Requirement-coverage fold (#624): advisory, never a verdict.
    let requirementCoverage: Record<string, unknown> | null = null;
    if (fixture.ledger !== undefined && fixture.ledger !== null) {
      // Mirror the v2 call path: load_ledger tolerantly validates the
      // artifact first (dropping/rebuilding malformed entries), then the
      // fold consumes the artifact shape.
      const loaded = ledgerToArtifact(loadLedgerFromValue(fixture.ledger));
      requirementCoverage = normalizeRequirementCoverage(
        extractCoveragePayload(artifact.requirement_coverage),
        loaded,
      ) as unknown as Record<string, unknown>;
    }

    return {
      ok: true,
      values: {
        artifact: pythonJsonStringify(artifact as unknown as Record<string, unknown>),
        completeness_result: pythonJsonStringify(completeness.result),
        required_checks: completeness.status,
        applied: String(applied),
        ...(requirementCoverage === null
          ? {}
          : { requirement_coverage: pythonJsonStringify(requirementCoverage) }),
      },
    };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** Convenience re-export for tests that start from a parsed verdict. */
export { reviewArtifactFromParsed };

interface RequirementCoverageFixture {
  contract: string;
  cases: Array<{
    name: string;
    /** The coverage payload (object with the coverage key, or bare array). */
    coverage: unknown;
    /** The requirement-ledger artifact (missing/bad degrades). */
    ledger: unknown;
    coverage_key?: string;
  }>;
}

/** `requirement-coverage-fixture` mode: the #624 fold, case per fixture. */
export function runRequirementCoverageFixture(fixturePath: string): {
  ok: boolean;
  values?: Record<string, string>;
  stderr?: string;
} {
  let fixture: RequirementCoverageFixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RequirementCoverageFixture;
  } catch (error) {
    return { ok: false, stderr: `fixture unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (fixture.contract !== "requirement-coverage/v1") {
    return { ok: false, stderr: "fixture is not requirement-coverage/v1" };
  }
  const values: Record<string, string> = {};
  try {
    for (const testCase of fixture.cases) {
      // Mirror the v2 call path: load_ledger tolerantly validates the
      // artifact first (dropping/rebuilding malformed entries, recomputing
      // the sha), then the fold consumes the artifact shape.
      const loaded = ledgerToArtifact(loadLedgerFromValue(testCase.ledger));
      const artifact = normalizeRequirementCoverage(
        extractCoveragePayload(testCase.coverage, testCase.coverage_key ?? "requirement_coverage"),
        loaded,
      );
      values[testCase.name] = pythonJsonStringify(artifact as unknown as Record<string, unknown>);
    }
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, values };
}
