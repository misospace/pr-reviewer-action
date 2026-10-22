/**
 * #1074: CLI bridge so the confidence-calibration pilot driver
 * (`scripts/confidence_calibration.py`) exercises the PRODUCTION confidence
 * scorer's prompt builder, parser, and deterministic ceilings — never a
 * Python reimplementation that could drift from `src/confidence/`.
 *
 * Four subcommands, one JSON file argument each, result JSON on stdout as a
 * single line, exit 0:
 *
 *   node <bundle> build-prompt   <inputs.json>
 *   node <bundle> apply-score    <request.json>
 *   node <bundle> review-result  <request.json>
 *   node <bundle> live-request   <request.json>
 *
 * `build-prompt` input: {head_sha, base_sha, diff, pr_title, pr_body,
 * findings, review_summary, review_result, required_checks, coverage,
 * secret_env_names: ["NAME", ...]}. Each name is resolved from process.env
 * and the resolved VALUES (in order) are passed as the production `secrets`
 * input so prompt masking matches the runtime's credential set.
 *
 * `apply-score` input: {answer, findings, coverage, model,
 * secret_env_names: ["NAME", ...]}. The pipeline mirrors the production
 * success path exactly: tolerant parse, deterministic ceilings, then the
 * canonical ConfidenceResult, then the credential-masking/re-bound pass the
 * runtime applies before any consumer reads the result
 * (`src/run/review.ts` ~1636-1660): reason and every concern field are
 * masked against the resolved lane secrets (`maskKnownSecrets` then
 * `redactText`) and re-bounded to the parser's documented limits, with the
 * deterministic cap note surviving the reason re-bound (the note itself is
 * masked first, then re-appended).
 *
 * `review-result` input: {verdict, verdict_policy, findings,
 * required_checks, partial_coverage, coverage_unknown} -> the metadata
 * marker's `review_result` string. This mirrors `markerReviewResult`
 * (`src/publish/publish.ts:247`) on top of the PRODUCTION
 * `strictReviewResult` (`src/enforcement/verdict-policy.ts`) — the 8-line
 * composition is local because importing `src/publish/publish.ts` would
 * drag the whole publish/prompt/platform surface into the bundle; the
 * parity tests pin its behavior against the production semantics.
 *
 * `live-request` (#1074, #1182 review) input: {base_url, api_format,
 * model, key_env, system, user, request_timeout_sec, connect_timeout_sec,
 * secret_env_names: ["NAME", ...]}. The pilot's live scorer call, routed
 * through the PRODUCTION typed transport: `buildModelRequest`
 * (`src/model/request.ts`) with the exact production scorer parameters
 * (no temperature, no structured output, no effort, single bounded
 * payload), sent by `runChatRequestOnce` (`src/transport/transport.ts`) —
 * exactly ONE wire attempt, no retry loop, non-2xx (including 3xx) is a
 * typed failure that is never followed. The credential crosses the seam
 * only as the NAME of the env var holding it (`key_env`); the value is
 * resolved in this process and rides only the provider's auth header.
 * Result: {answer, usage, cause, diagnostic} — on success `answer` is the
 * normalized response text and `usage` the prompt/completion token counts
 * (null when the provider sent none), with `cause` null; on a failure
 * `answer` and `usage` are null, `cause` is the production scorer's
 * action-owned token (`transportCause`: `http_<code>`, `timeout`,
 * `response_too_large`, `transport_error`) and `diagnostic` is the
 * secret-masked `describeTransportFailure` detail (mask set = every named
 * lane secret plus the resolved key). Success and typed failure both exit
 * 0; only malformed input or a missing/empty `key_env` exits 1.
 *
 * On any error a REDACTED message goes to stderr (never a secret value,
 * never input content — a JSON parse error message could echo file bytes)
 * and the process exits 1. Credentials travel only via process.env (the
 * live-request key value is resolved from its env name inside this process
 * and leaves it only inside the provider's auth header); they never appear
 * in argv, URLs, or diagnostics.
 *
 * This file sits outside the tsconfig production graph by design: it is a
 * pilot tooling seam, bundled on demand by `scripts/confidence_bridge.mjs`
 * and typechecked by `scripts/tsconfig.json` (wired into `npm run
 * typecheck`).
 */
import * as fs from "node:fs";
import { maskDiagnostic, maskKnownSecrets, redactText } from "../src/context/redact.js";
import { strictReviewResult } from "../src/enforcement/verdict-policy.js";
import { buildConfidencePrompt, type ConfidencePromptInputs } from "../src/confidence/prompt.js";
import { CONFIDENCE_MAX_TOKENS, transportCause } from "../src/confidence/scorer.js";
import { buildModelRequest } from "../src/model/request.js";
import { describeTransportFailure } from "../src/transport/http.js";
import { runChatRequestOnce } from "../src/transport/transport.js";
import {
  applyConfidenceCeilings,
  boundConfidenceField,
  boundConfidenceReason,
  confidenceCapNote,
  MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS,
  MAX_CONFIDENCE_CONCERN_FILE_CHARS,
  parseConfidenceAnswer,
  scoredConfidenceResult,
  unscoredConfidenceResult,
  type ConfidenceResult,
} from "../src/confidence/result.js";

function fail(subcommand: string, stage: string): never {
  // Redacted by construction: stage names are action-owned tokens; neither
  // input content nor exception text (which can echo file bytes or values)
  // is ever printed.
  process.stderr.write(
    `confidence_bridge: ${subcommand} failed at ${stage}; input rejected or bridge error (details redacted)\n`,
  );
  process.exit(1);
}

function readInputObject(argv: string[]): Record<string, unknown> {
  const file = argv[0];
  if (typeof file !== "string" || file === "") fail("input", "missing_input_path");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail("input", "unreadable_input_file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("input", "unparseable_input_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("input", "input_not_an_object");
  }
  return parsed as Record<string, unknown>;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve env-var NAMES to their VALUES inside the bridge process: the
 * driver only ever handles names, and values never touch argv, files, or
 * stdout. A missing name resolves to undefined — production passes the
 * full lane set including empty slots. */
function resolveSecrets(input: Record<string, unknown>): (string | null | undefined)[] {
  const names = Array.isArray(input.secret_env_names) ? input.secret_env_names : [];
  const secrets: (string | null | undefined)[] = [];
  for (const name of names) {
    if (typeof name !== "string" || name === "") fail("input", "bad_secret_env_name");
    secrets.push(process.env[name]);
  }
  return secrets;
}

function buildPrompt(argv: string[]): void {
  const input = readInputObject(argv);
  const secrets = resolveSecrets(input);
  const promptInputs: ConfidencePromptInputs = {
    headSha: typeof input.head_sha === "string" ? input.head_sha : "",
    baseSha: typeof input.base_sha === "string" ? input.base_sha : "",
    diff: typeof input.diff === "string" ? input.diff : "",
    prTitle: typeof input.pr_title === "string" ? input.pr_title : "",
    prBody: typeof input.pr_body === "string" ? input.pr_body : "",
    findings: input.findings ?? [],
    reviewSummary: typeof input.review_summary === "string" ? input.review_summary : "",
    reviewResult: typeof input.review_result === "string" ? input.review_result : "",
    requiredChecks: typeof input.required_checks === "string" ? input.required_checks : "",
    coverage: isRecord(input.coverage) ? input.coverage : {},
    secrets,
  };
  try {
    emit(buildConfidencePrompt(promptInputs));
  } catch {
    fail("build-prompt", "prompt_build_failed");
  }
}

function applyScore(argv: string[]): void {
  const input = readInputObject(argv);
  const answer = typeof input.answer === "string" ? input.answer : "";
  const model = typeof input.model === "string" ? input.model : "";
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const coverage = isRecord(input.coverage) ? input.coverage : {};
  const secrets = resolveSecrets(input);
  // Mirror of the production success path (`src/confidence/scorer.ts` +
  // the masking pass in `src/run/review.ts`): tolerant parse, deterministic
  // ceilings, canonical result, then credential masking/re-bound. A
  // malformed answer fails closed to `unscored` with the parser's cause —
  // exactly as in production.
  let parsed: ReturnType<typeof parseConfidenceAnswer>;
  try {
    parsed = parseConfidenceAnswer(answer);
  } catch {
    fail("apply-score", "parse_crashed");
  }
  if (!parsed.ok) {
    emit(unscoredConfidenceResult(parsed.cause, model));
    return;
  }
  let ceilings: ReturnType<typeof applyConfidenceCeilings>;
  try {
    ceilings = applyConfidenceCeilings(parsed.answer, { findings, coverage });
  } catch {
    fail("apply-score", "ceilings_crashed");
  }
  let base: ConfidenceResult;
  try {
    base = scoredConfidenceResult({
      score: ceilings.score,
      risk: ceilings.risk,
      reason: ceilings.reason,
      concerns: parsed.answer.concerns,
      model,
      caps: ceilings.caps,
    });
  } catch {
    fail("apply-score", "result_build_failed");
  }
  // Production masking layer (src/run/review.ts ~1636-1660): every
  // model-authored field is masked against EVERY lane credential BEFORE the
  // canonical result exists, then re-bounded to the parser's documented
  // limits (exact-value masking is not length-preserving, so the bound is
  // re-applied after masking). The deterministic cap note is masked too and
  // re-appended by `boundConfidenceReason` — a configured credential may be
  // a single character occurring inside the note template.
  const maskText = (text: string): string => redactText(maskKnownSecrets(text, secrets));
  let canonical: ConfidenceResult;
  try {
    canonical = {
      ...base,
      reason: boundConfidenceReason(maskText(base.reason), maskText(confidenceCapNote(base.caps))),
      concerns: base.concerns.map((concern) => ({
        file: boundConfidenceField(maskText(concern.file), MAX_CONFIDENCE_CONCERN_FILE_CHARS),
        line: concern.line,
        evidence: boundConfidenceField(maskText(concern.evidence), MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS),
      })),
    };
  } catch {
    fail("apply-score", "masking_failed");
  }
  emit(canonical);
}

/**
 * Local mirror of `markerReviewResult` (src/publish/publish.ts:247) over
 * the PRODUCTION `strictReviewResult` — the composition is eight lines and
 * pinned by parity tests; see the file docstring for why the import is
 * local.
 */
function markerReviewResultLocal(input: {
  verdictPolicy?: string | undefined;
  verdict: string;
  findings?: unknown;
  requiredChecks: string;
  partialCoverage?: boolean | undefined;
  coverageUnknown?: boolean | undefined;
}): string {
  const coverageGap = Boolean(input.partialCoverage) || Boolean(input.coverageUnknown);
  const coverageIncomplete = input.requiredChecks === "incomplete" || coverageGap;
  if (input.verdictPolicy !== "strict") {
    if (input.verdict === "request_changes") return "issues";
    return coverageIncomplete ? "partial" : "clean";
  }
  const result = strictReviewResult(input.verdict, input.findings, input.requiredChecks);
  return coverageGap && result !== "issues" ? "partial" : result;
}

function reviewResult(argv: string[]): void {
  const input = readInputObject(argv);
  const verdict = typeof input.verdict === "string" ? input.verdict : "";
  const verdictPolicy = typeof input.verdict_policy === "string" ? input.verdict_policy : "strict";
  const requiredChecks = typeof input.required_checks === "string" ? input.required_checks : "none";
  const partialCoverage = input.partial_coverage === true;
  const coverageUnknown = input.coverage_unknown === true;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  try {
    emit({
      review_result: markerReviewResultLocal({
        verdictPolicy,
        verdict,
        findings,
        requiredChecks,
        partialCoverage,
        coverageUnknown,
      }),
    });
  } catch {
    fail("review-result", "review_result_failed");
  }
}

/** Positive, finite seconds; the transport deadlines must bound the wire
 * attempt, so zero/negative/non-numeric input is rejected fail-closed. */
function positiveTimeout(value: unknown, subcommand: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(subcommand, `bad_${field}`);
  return value;
}

/** The pilot's live scorer call on the production single-shot transport
 * (#1182): one wire attempt, no retries, non-2xx never followed. The
 * credential value is resolved here from its env name and rides only the
 * auth header; the diagnostic is masked against every named lane secret
 * plus the resolved key, so the result JSON can never carry a credential. */
async function liveRequest(argv: string[]): Promise<void> {
  const sub = "live-request";
  const input = readInputObject(argv);
  const base_url = input.base_url;
  const model = input.model;
  const system = input.system;
  const user = input.user;
  const keyName = input.key_env;
  if (typeof base_url !== "string" || base_url === "") fail(sub, "bad_base_url");
  const apiFormat = input.api_format === "anthropic" ? "anthropic"
    : input.api_format === "openai" ? "openai"
      : fail(sub, "bad_api_format");
  if (typeof model !== "string") fail(sub, "bad_model");
  if (typeof system !== "string" || typeof user !== "string") fail(sub, "bad_prompt");
  if (typeof keyName !== "string" || keyName === "") fail(sub, "missing_key_env_name");
  const requestTimeoutSec = positiveTimeout(input.request_timeout_sec, sub, "request_timeout_sec");
  const connectTimeoutSec = positiveTimeout(input.connect_timeout_sec, sub, "connect_timeout_sec");
  const laneSecrets = resolveSecrets(input);
  // Empty value passes through: the production transport sends no auth
  // header for an empty key (http.ts) — never an invented credential.
  const apiKey = process.env[keyName] ?? "";
  const diagnosticSecrets: (string | null | undefined)[] = [...laneSecrets, apiKey];
  // The exact production scorer call shape (src/confidence/scorer.ts:139-172).
  const payload = buildModelRequest({
    apiFormat,
    model,
    system,
    user,
    corpus: "",
    stream: false,
    shape: "default",
    maxTokens: CONFIDENCE_MAX_TOKENS,
    temperature: "",
    responseFormat: "off",
    tokensParam: "max_tokens",
    reasoningEffort: "",
    anthropicEffortSupported: false,
    anthropicStructuredOutputSupported: false,
  });
  let outcome;
  try {
    outcome = await runChatRequestOnce({
      baseUrl: base_url,
      apiFormat,
      payload,
      apiKey,
      anthropicVersion: "2023-06-01",
      requestTimeoutSec,
      connectTimeoutSec,
    });
  } catch (error: unknown) {
    // A thrown (non-typed) transport error degrades exactly like the
    // production scorer's thrown path: bounded, secret-masked diagnostic,
    // action-owned cause, still exit 0 — the pilot records unscored.
    const message = error instanceof Error ? error.message : String(error);
    emit({
      answer: null,
      usage: null,
      cause: "transport_error",
      diagnostic: maskDiagnostic(message, diagnosticSecrets),
    });
    return;
  }
  if (outcome.status === "ok") {
    emit({
      answer: outcome.response.content,
      usage: outcome.response.usage !== null
        ? {
            prompt_tokens: outcome.response.usage.promptTokens,
            completion_tokens: outcome.response.usage.completionTokens,
          }
        : null,
      cause: null,
      diagnostic: "",
    });
    return;
  }
  emit({
    answer: null,
    usage: null,
    cause: transportCause(outcome.failure.kind, outcome.failure.status),
    diagnostic: describeTransportFailure(outcome.failure, { secrets: diagnosticSecrets }),
  });
}

function main(): void {
  const subcommand = process.argv[2];
  const argv = process.argv.slice(3);
  if (subcommand === "build-prompt") buildPrompt(argv);
  else if (subcommand === "apply-score") applyScore(argv);
  else if (subcommand === "review-result") reviewResult(argv);
  else if (subcommand === "live-request") {
    liveRequest(argv).catch(() => fail(subcommand, "unhandled_error"));
  }
  else fail("dispatch", "unknown_subcommand");
}

main();
