/** Fixture-driven CLI entry points for the #776 parity boundaries
 * (`specialist-corpus`, `specialist-payload`, `specialist-normalize`) and
 * tests-v3, following the established `node dist/index.js <mode>-fixture
 * <fixture.json>` convention (see `src/routing/fixture.ts`,
 * `src/context/fixture.ts`). Each prints one JSON line: `{ok, values}` (or
 * `{ok:false, stderr}`), where `values.result` is compared as canonical JSON
 * by the parity harness (`canonical_json_keys: {"result"}`). */

import { readFileSync } from "node:fs";
import { buildSpecialistCorpus, type CorpusMode, type SpecialistCorpusWorkspace } from "./corpus.js";
import { normalizeSpecialistOutput, parseSpecialistResponse } from "./normalize.js";
import { buildSpecialistPayload, overrunRetryPayload, type SpecialistPayload } from "./payload.js";
import { completionOverran } from "./wire.js";

type FixtureResult = { ok: boolean; values?: { result: unknown }; stderr?: string };

function loadFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// --- specialist-corpus -------------------------------------------------------------------

interface SpecialistCorpusFixture {
  mode?: CorpusMode;
  max_bytes?: number;
  files?: Record<string, string>;
  ci_checks_file_content?: string;
}

export function runSpecialistCorpusFixture(fixturePath: string): FixtureResult {
  const fixture = loadFixture(fixturePath) as SpecialistCorpusFixture;
  const ws: SpecialistCorpusWorkspace = {};
  for (const [name, text] of Object.entries(fixture.files ?? {})) {
    ws[name] = Buffer.from(text, "utf8");
  }
  if (typeof fixture.ci_checks_file_content === "string") {
    ws.__ci_checks_file__ = Buffer.from(fixture.ci_checks_file_content, "utf8");
  }
  const [text, metadata] = buildSpecialistCorpus(ws, fixture.max_bytes ?? undefined, fixture.mode ?? "standard");
  return { ok: true, values: { result: { text, ...metadata } } };
}

// --- specialist-payload -------------------------------------------------------------------

interface SpecialistPayloadFixture {
  api_format?: string;
  model?: string;
  system?: string;
  user?: string;
  max_tokens?: number;
  temperature?: number | null;
  response_format?: string;
  tokens_param?: string;
  stream?: boolean;
  /** Overrun-retry mode: when present, the fixture instead exercises
   * `overrunRetryPayload` over an already-built payload. */
  overrun?: { payload: SpecialistPayload; max_tokens: number };
}

export function runSpecialistPayloadFixture(fixturePath: string): FixtureResult {
  const fixture = loadFixture(fixturePath) as SpecialistPayloadFixture;
  if (fixture.overrun) {
    const retry = overrunRetryPayload(fixture.overrun.payload, fixture.overrun.max_tokens);
    return { ok: true, values: { result: { retry_payload: retry } } };
  }
  const payload = buildSpecialistPayload({
    apiFormat: fixture.api_format ?? "openai",
    model: fixture.model ?? "",
    system: fixture.system ?? "",
    user: fixture.user ?? "",
    maxTokens: fixture.max_tokens ?? 4096,
    temperature: fixture.temperature ?? null,
    responseFormat: fixture.response_format ?? "off",
    tokensParam: fixture.tokens_param ?? "max_tokens",
    stream: fixture.stream ?? true,
  });
  return { ok: true, values: { result: payload } };
}

// --- specialist-normalize -----------------------------------------------------------------

interface SpecialistNormalizeFixture {
  mode?: "normalize" | "parse" | "overrun";
  role?: string;
  payload?: unknown;
  text?: string | null;
  max_leads?: number;
  max_message_chars?: number;
  response?: unknown;
  orig_payload?: SpecialistPayload;
  max_tokens?: number;
}

export function runSpecialistNormalizeFixture(fixturePath: string): FixtureResult {
  const fixture = loadFixture(fixturePath) as SpecialistNormalizeFixture;
  const mode = fixture.mode ?? "normalize";
  const role = fixture.role ?? "correctness";
  if (mode === "overrun") {
    const overran = completionOverran(fixture.response);
    const retry = overran ? overrunRetryPayload(fixture.orig_payload ?? {}, fixture.max_tokens ?? 4096) : null;
    return { ok: true, values: { result: { overran, retry_payload: retry } } };
  }
  const result =
    mode === "parse"
      ? parseSpecialistResponse(fixture.text ?? null, role, fixture.max_leads, fixture.max_message_chars)
      : normalizeSpecialistOutput(fixture.payload, role, fixture.max_leads, fixture.max_message_chars);
  return { ok: true, values: { result } };
}
