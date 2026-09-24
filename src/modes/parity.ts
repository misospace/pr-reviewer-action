import { readFileSync } from "node:fs";
import { buildModelRequest } from "../model/request.js";
import { parseVerdictResponse } from "../model/verdict.js";
import { resolveToolMaxRequests } from "../tools/budget.js";
import type { ModelRequestConfig, RequestShape, ResponseFormatMode, TokensParam, ApiFormat } from "../model/types.js";

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
    const response: unknown = JSON.parse(readFileSync(responsePath, "utf8"));
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
    for (const [key, value] of Object.entries(verdict.extra)) parsed[key] = value;
    payload = { ok: true, values: { parsed: canonical(parsed) } };
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
