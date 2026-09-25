import { readFileSync } from "node:fs";
import { buildModelRequest } from "../model/request.js";
import { parseVerdictResponse } from "../model/verdict.js";
import { evaluateRequiredCheckCoverage, requiredCheckCoverageToArtifact } from "../enforcement/required-checks.js";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { resolveToolMaxRequests } from "../tools/budget.js";
import type { ModelRequestConfig, RequestShape, ResponseFormatMode, TokensParam, ApiFormat, NormalizedRequiredCheckDisposition } from "../model/types.js";

/**
 * Parity-harness runner modes (#677), enabled only through
 * PR_REVIEWER_V3_MODE. They exist so tests/parity_harness.py can run the v3
 * model-call stage against the same fixture the v2 runner sees, and they
 * always exit 0 with a single-line JSON payload ({ok, values} / {ok, stderr})
 * the harness parses.
 */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

interface RequestFixture {
  api_format: string;
  model: string;
  system: string;
  user: string;
  corpus: string;
  stream: boolean;
  shape: string;
  max_tokens?: number | null;
  temperature?: number | "" | null;
  response_format: string;
  tokens_param: string;
}

export function runRequestBuilderMode(fixturePath: string): void {
  let payload: Record<string, unknown>;
  try {
    const wrapper = JSON.parse(readFileSync(fixturePath, "utf8")) as { request: RequestFixture };
    const fixture = wrapper.request;
    const config: ModelRequestConfig = {
      apiFormat: fixture.api_format as ApiFormat,
      model: fixture.model,
      system: fixture.system,
      user: fixture.user,
      corpus: fixture.corpus,
      stream: fixture.stream,
      shape: fixture.shape as RequestShape,
      maxTokens: fixture.max_tokens ?? 8192,
      temperature: fixture.temperature === null || fixture.temperature === undefined ? 0.1 : fixture.temperature,
      responseFormat: fixture.response_format as ResponseFormatMode,
      tokensParam: fixture.tokens_param as TokensParam,
    };
    const wire = buildModelRequest(config);
    payload = { ok: true, values: { payload: canonical(wire.body) } };
  } catch (error) {
    payload = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function runVerdictParserMode(responsePath: string): void {
  let payload: Record<string, unknown>;
  try {
    const fixture: unknown = JSON.parse(readFileSync(responsePath, "utf8"));
    // #750 fix: run the embedded model response, not the fixture wrapper —
    // feeding the wrapper made every fixture error identically on both sides
    // and the boundary matched vacuously on a shared NoneType error.
    const response = typeof fixture === "object" && fixture !== null && "response" in fixture
      ? (fixture as { response: unknown }).response
      : fixture;
    const verdict = parseVerdictResponse(response);
    // Mirror the v2 parsed-dict shape: snake_case wire keys, extras inline.
    const parsed: Record<string, unknown> = {
      verdict: verdict.verdict,
      review_markdown: verdict.reviewMarkdown,
      findings: verdict.findings.map((finding) => {
        const out: Record<string, unknown> = {
          severity: finding.severity,
          category: finding.category,
          file: finding.file,
          line: finding.line,
          message: finding.message,
        };
        if (finding.preliminaryFinding !== undefined) out.preliminary_finding = finding.preliminaryFinding;
        return out;
      }),
    };
    if (verdict.requirementCoverage !== undefined) parsed.requirement_coverage = verdict.requirementCoverage;
    // #750 structured required-check dispositions: emitted explicitly
    // (snake_case) so the parity comparison pins the normalized field, not
    // raw extras. Null when the model did not emit the field at all.
    parsed.required_check_dispositions = verdict.requiredCheckDispositions === null
      ? null
      : verdict.requiredCheckDispositions.map((disposition) => ({
        check: disposition.check,
        status: disposition.status,
        rationale: disposition.rationale,
      }));
    // #721 structured escalation request: emitted explicitly (snake_case)
    // so the parity comparison pins the normalized fields, not raw extras.
    parsed.smart_review_requested = verdict.smartReviewRequested;
    parsed.smart_review_reason = verdict.smartReviewReason;
    for (const [key, value] of Object.entries(verdict.extra)) parsed[key] = value;
    payload = { ok: true, values: { parsed: pythonJsonStringify(parsed) } };
  } catch (error) {
    payload = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * #750 required-check-coverage parity mode: fold a fixture's deterministic
 * must_check list and (parser-normalized) dispositions through the v3
 * coverage evaluator and emit the snake_case artifact for byte comparison
 * with the v2 evaluator in pr_reviewer/completeness.py.
 */
interface CoverageFixture {
  contract?: string;
  must_check: unknown;
  dispositions: unknown;
}

export function runRequiredCheckCoverageMode(fixturePath: string): void {
  let payload: Record<string, unknown>;
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as CoverageFixture;
    if (fixture.contract !== "required-check-coverage/v1") {
      throw new Error("fixture is not required-check-coverage/v1");
    }
    const checks = Array.isArray(fixture.must_check) ? fixture.must_check.filter((c): c is string => typeof c === "string") : [];
    // Pass the fixture dispositions through verbatim (list or null): the
    // evaluator re-validates every entry defensively, exactly like the v2
    // evaluator, so hostile fixture content exercises the same path on both
    // sides.
    const dispositions = Array.isArray(fixture.dispositions)
      ? (fixture.dispositions as unknown[])
      : null;
    const coverage = evaluateRequiredCheckCoverage(checks, dispositions as NormalizedRequiredCheckDisposition[] | null);
    payload = { ok: true, values: { coverage: pythonJsonStringify(requiredCheckCoverageToArtifact(coverage)) } };
  } catch (error) {
    payload = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * #701 tool-request-budget parity mode: evaluate every fixture case through
 * the v3 tier-aware resolver and check it against the case's expected
 * (route, budget, source — #702 provenance). Like the v2 runner, an
 * expectation mismatch fails closed (ok:false) so the absolute tier
 * defaults are pinned, not just v2↔v3 agreement.
 */
interface BudgetCase {
  name: string;
  tier: string;
  env: Record<string, string>;
  expected: { route: string; budget: number; source: string };
}

interface BudgetFixture {
  contract?: string;
  cases: BudgetCase[];
}

export function runToolBudgetMode(fixturePath: string): void {
  let payload: Record<string, unknown>;
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as BudgetFixture;
    if (fixture.contract !== "tool-request-budget/v1") {
      throw new Error("fixture is not tool-request-budget/v1");
    }
    if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
      throw new Error("fixture has no cases");
    }
    const values: Record<string, string> = {};
    const failures: string[] = [];
    for (const testCase of fixture.cases) {
      const resolved = resolveToolMaxRequests(testCase.tier, testCase.env);
      values[testCase.name] = `${resolved.route}/${resolved.budget}/${resolved.source}`;
      if (
        resolved.route !== testCase.expected.route ||
        resolved.budget !== testCase.expected.budget ||
        resolved.source !== testCase.expected.source
      ) {
        failures.push(
          `${testCase.name}: expected ${testCase.expected.route}/${testCase.expected.budget}/${testCase.expected.source}, got ${resolved.route}/${resolved.budget}/${resolved.source}`,
        );
      }
    }
    payload = failures.length > 0
      ? { ok: false, stderr: failures.join("; ") }
      : { ok: true, values };
  } catch (error) {
    payload = { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
