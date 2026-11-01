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
 *   node <bundle> live-scorer    <request.json>   (#1370 canary)
 *
 * `live-scorer` (#1370) input: {row: {head_sha, base_sha, diff, pr_title,
 * pr_body, findings, review_summary, required_checks, coverage, verdict,
 * verdict_policy, partial_coverage}, confidence_env: {<AI_CONFIDENCE_* name>:
 * "<declared value>", ...}, confidence_key_env?: "<ENV_NAME>",
 * secret_env_names: ["NAME", ...]}. Unlike `live-request` — which pins the
 * pilot's documented request shape and deliberately does NOT exercise the
 * shipped lane's budget/capability handling — this subcommand runs the
 * PRODUCTION verifier path end to end, so a canary call cannot drift from
 * what the action would send:
 *
 *   resolveConfidenceProfile (src/routing/tiers.ts) over a stage env built
 *   from the inherited process env with every ambient AI_CONFIDENCE_* var
 *   stripped and only the plan-declared `confidence_env` values applied
 *   (the declared config is the whole config — ambient shell state can
 *   never silently shape the request), the verifier's own key resolved from
 *   `confidence_key_env`'s env NAME when declared;
 *
 *   the engine's eligibility gates in production order (publish step,
 *   approve/request_changes verdict, `unresolvedConfidencePins` proof
 *   pins) — each refusal recorded `unscored` with the production cause and
 *   ZERO wire attempts;
 *
 *   buildConfidencePrompt at the RESOLVED profile's promptTokens budget,
 *   then runConfidenceScorer (src/confidence/scorer.ts) itself: the
 *   prompt_over_budget pre-wire refusal, the resolved effort/structured-
 *   output/temperature/tokens-param shape, the one-shot transport, the
 *   tolerant parse and deterministic ceilings;
 *
 *   the engine's credential-masking pass over the canonical result (the
 *   exact `apply-score` composition, shared here so the two cannot drift).
 *
 * Result: {enabled, warnings, review_result, unresolved_pins, profile,
 * prompt_bytes, result, wire_effort, usage, latency_ms, diagnostic,
 * request_payload_masked, raw_response_masked}. `profile` carries the
 * RESOLVED configuration (budgets, effort, capability assertions, endpoint
 * host, inherited-transport provenance) so the canary record is observable;
 * the credential value appears NOWHERE. The masked request-payload and
 * raw-response copies are JSON strings (null when no call was attempted)
 * produced with the same `redactTextDeep` pass the runtime applies before
 * persisting `confidence-request.json` / `confidence-response.json`. Usage
 * is the provider-reported token counts read back from the RAW response
 * (pilot cost accounting only — the production scorer never consumes them).
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
 * (`src/engine/review.ts`): reason and every concern field are
 * masked against the resolved lane secrets (`maskKnownSecrets` then
 * `redactText`) and re-bounded to the parser's documented limits, with the
 * deterministic cap note surviving the reason re-bound (#1268: the note is
 * split off the model share before masking, masked on its own, then
 * re-appended from `caps`, and one exact-value `maskKnownSecrets` pass over the composed reason closes a boundary-spanning-secret tear).
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
 * Result: {answer, masked_answer, usage, cause, diagnostic} — on success
 * `answer` is the normalized response text and `usage` the prompt/completion
 * token counts (null when the provider sent none), with `cause` null; on a
 * failure `answer` and `usage` are null, `cause` is the production scorer's
 * action-owned token (`transportCause`: `http_<code>`, `timeout`,
 * `response_too_large`, `transport_error`) and `diagnostic` is the
 * secret-masked `describeTransportFailure` detail (mask set = every named
 * lane secret plus the resolved key). `masked_answer` is the answer's
 * CREDENTIAL-MASKED COPY — the same production redaction the runtime
 * applies before persisting a raw provider response (`redactTextDeep`,
 * `src/engine/review.ts`) — so the driver can persist a copy that can never
 * carry the credential, while the raw `answer` stays in memory for
 * scoring; it is null on the failure path. Success and typed failure both
 * exit 0; only malformed input or a missing/empty `key_env` exits 1.
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
import { maskDiagnostic, maskKnownSecrets, redactText, redactTextDeep } from "../src/context/redact.js";
import { strictReviewResult } from "../src/enforcement/verdict-policy.js";
import { buildConfidencePrompt, unresolvedConfidencePins, type ConfidencePromptInputs } from "../src/confidence/prompt.js";
import { CONFIDENCE_MAX_TOKENS, runConfidenceScorer, transportCause } from "../src/confidence/scorer.js";
import { resolveConfidenceProfile } from "../src/routing/tiers.js";
import { buildModelRequest } from "../src/model/request.js";
import { wireEffortOf } from "../src/model/request.js";
import { describeTransportFailure } from "../src/transport/http.js";
import { runChatRequestOnce } from "../src/transport/transport.js";
import {
  applyConfidenceCeilings,
  boundConfidenceField,
  boundConfidenceReason,
  CONFIDENCE_DISABLED,
  CONFIDENCE_RUBRIC_VERSION,
  confidenceCapNote,
  confidenceReasonWithoutCapNote,
  maskComposedConfidenceReason,
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

/**
 * The production credential-masking pass the runtime applies between the
 * scorer's raw outcome and every consumer (src/engine/review.ts): model
 * fields masked against EVERY lane credential, then re-bounded to the
 * parser's documented limits. Shared by `apply-score` and `live-scorer` so
 * the two pilot paths cannot drift from each other or from production.
 *
 * #1268: the deterministic cap note is split off the model share BEFORE
 * masking, masked on its own, and re-appended by `boundConfidenceReason`
 * from `caps` — masking a combined text could let `redactText` complete a
 * half-written note look-alike, and a configured credential may be a single
 * character occurring inside the note template.
 */
function canonicalMaskedConfidence(base: ConfidenceResult, secrets: (string | null | undefined)[]): ConfidenceResult {
  const maskText = (text: string): string => redactText(maskKnownSecrets(text, secrets));
  return {
    ...base,
    reason: maskComposedConfidenceReason(
      boundConfidenceReason(
        maskText(confidenceReasonWithoutCapNote(base.reason, base.caps)),
        maskText(confidenceCapNote(base.caps)),
      ),
      secrets,
    ),
    concerns: base.concerns.map((concern) => ({
      // Closed-vocabulary enum tokens (parser-validated), not model free
      // text — carried through unmasked, like `line` (#1369).
      type: concern.type,
      severity: concern.severity,
      file: boundConfidenceField(maskText(concern.file), MAX_CONFIDENCE_CONCERN_FILE_CHARS),
      line: concern.line,
      evidence: boundConfidenceField(maskText(concern.evidence), MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS),
    })),
  };
}

function applyScore(argv: string[]): void {
  const input = readInputObject(argv);
  const answer = typeof input.answer === "string" ? input.answer : "";
  const model = typeof input.model === "string" ? input.model : "";
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const coverage = isRecord(input.coverage) ? input.coverage : {};
  const secrets = resolveSecrets(input);
  // Mirror of the production success path (`src/confidence/scorer.ts` +
  // the masking pass in `src/engine/review.ts`): tolerant parse, deterministic
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
      parserNotes: parsed.answer.notes,
    });
  } catch {
    fail("apply-score", "result_build_failed");
  }
  // Production masking layer (src/engine/review.ts): every model-authored
  // field is masked against EVERY lane credential BEFORE the canonical result
  // exists, then re-bounded to the parser's documented limits (exact-value
  // masking is not length-preserving, so the bound is re-applied after
  // masking). The composition lives in `canonicalMaskedConfidence` (shared
  // with `live-scorer`); see it for the #1268 note-split rationale.
  let canonical: ConfidenceResult;
  try {
    canonical = canonicalMaskedConfidence(base, secrets);
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

/** The credential-masked COPY of the provider answer. Production persists a
 * raw provider response through `redactTextDeep` (`src/engine/review.ts`),
 * not through value masking alone: configured-value masking left a
 * PROVIDER-authored credential (`api_key=…`, `Bearer …`, `sk-…`) in
 * cleartext on disk. The pilot persists THIS copy, so a provider that
 * echoes the credential cannot leave it behind in the audit tree. */
function maskAnswer(answer: string, secrets: (string | null | undefined)[]): string {
  const masked = redactTextDeep(answer, secrets);
  return typeof masked === "string" ? masked : "";
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
  // The production scorer's REQUEST SHAPE (`buildModelRequest` +
  // `runChatRequestOnce` in src/confidence/scorer.ts), pinned to the pilot's
  // documented defaults: one call, no retry, no effort, no structured-output
  // schema, and the DEFAULT #1368 budgets. The pilot therefore does NOT
  // exercise the shipped lane's budget handling — the declared-context clamps
  // or the `prompt_over_budget` refusal — and `build-prompt` above builds at
  // the default prompt budget for the same reason.
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
      masked_answer: null,
      usage: null,
      cause: "transport_error",
      diagnostic: maskDiagnostic(message, diagnosticSecrets),
    });
    return;
  }
  if (outcome.status === "ok") {
    emit({
      answer: outcome.response.content,
      masked_answer: maskAnswer(outcome.response.content, diagnosticSecrets),
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
    masked_answer: null,
    usage: null,
    cause: transportCause(outcome.failure.kind, outcome.failure.status),
    diagnostic: describeTransportFailure(outcome.failure, { secrets: diagnosticSecrets }),
  });
}

/** Env-NAME shape for `confidence_key_env` (a credential's env-var NAME,
 * never a value): uppercase convention like the driver's own validation. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** The AI_CONFIDENCE_* env names the canary's declared config may set. The
 * verifier's own KEY is deliberately absent — a credential value never
 * travels in the request JSON; it is resolved from `confidence_key_env`'s
 * env NAME inside this process. */
const CONFIDENCE_ENV_KEYS: ReadonlySet<string> = new Set([
  "AI_CONFIDENCE_MODEL",
  "AI_CONFIDENCE_BASE_URL",
  "AI_CONFIDENCE_API_FORMAT",
  "AI_CONFIDENCE_REASONING_EFFORT",
  "AI_CONFIDENCE_MAX_TOKENS",
  "AI_CONFIDENCE_PROMPT_TOKENS",
  "AI_CONFIDENCE_MODEL_CONTEXT_TOKENS",
  "AI_CONFIDENCE_ANTHROPIC_EFFORT_SUPPORT",
  "AI_CONFIDENCE_STRUCTURED_OUTPUT_SUPPORT",
  "AI_CONFIDENCE_TIMEOUT_SEC",
  "AI_CONFIDENCE_ENABLE_FOR_FORKS",
]);

/** Local mirror of `publishStepRuns` (src/publish/publish.ts:52) — the
 * engine's confidence eligibility gate. The composition is three literals
 * and pinned by parity tests; importing publish.ts would drag the whole
 * publish surface into the bundle (see `markerReviewResultLocal`). */
function publishStepRunsLocal(mode: string | undefined): boolean {
  const value = mode ?? "";
  return value === "review_comment" || value === "review_verdict" || value === "review_blockers" || value === "comment";
}

/** The provider-reported token counts, read back from the RAW response body
 * (pilot cost accounting only — the production scorer outcome carries no
 * usage field). Mirrors the transport's own mapping: OpenAI
 * `usage.prompt_tokens`/`completion_tokens`, Anthropic
 * `usage.input_tokens`/`output_tokens`. Null when the provider sent none. */
function usageFromRaw(apiFormat: string, raw: unknown): { prompt_tokens: number; completion_tokens: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = (raw as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const prompt = apiFormat === "anthropic" ? record.input_tokens : record.prompt_tokens;
  const completion = apiFormat === "anthropic" ? record.output_tokens : record.completion_tokens;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const promptTokens = count(prompt);
  const completionTokens = count(completion);
  return promptTokens !== null && completionTokens !== null
    ? { prompt_tokens: promptTokens, completion_tokens: completionTokens }
    : null;
}

/**
 * #1370 canary: the PRODUCTION verifier path end to end — profile
 * resolution, eligibility gates, prompt build at the resolved budget, the
 * scorer's own dispatch, and the engine's masking pass. See the file
 * docstring for the full contract. Exit 0 on every row-shaped outcome
 * (scored, unscored, refused); only malformed input exits 1.
 */
async function liveScorer(argv: string[]): Promise<void> {
  const sub = "live-scorer";
  const input = readInputObject(argv);
  const row = isRecord(input.row) ? input.row : fail(sub, "bad_row");
  const confidenceEnv = isRecord(input.confidence_env) ? input.confidence_env : fail(sub, "bad_confidence_env");
  for (const key of Object.keys(confidenceEnv)) {
    if (!CONFIDENCE_ENV_KEYS.has(key) || typeof confidenceEnv[key] !== "string") fail(sub, "bad_confidence_env_key");
  }
  // The declared config is the WHOLE config: every ambient AI_CONFIDENCE_*
  // var is stripped from the stage env first, so shell state can never
  // shape the request the plan did not declare. The primary lane's env
  // (AI_BASE_URL/AI_MODEL/AI_API_FORMAT/AI_API_KEY and their AI_PRIMARY_*
  // overrides) is inherited from process.env exactly as the runtime reads
  // it — endpoint/credential inheritance and the isolation rules are the
  // production resolver's own decisions.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AI_CONFIDENCE_")) delete env[key];
  }
  for (const [key, value] of Object.entries(confidenceEnv)) {
    env[key] = value as string;
  }
  if (typeof input.confidence_key_env === "string" && input.confidence_key_env !== "") {
    const keyName = input.confidence_key_env;
    if (!ENV_NAME_RE.test(keyName)) fail(sub, "bad_confidence_key_env");
    env.AI_CONFIDENCE_API_KEY = process.env[keyName] ?? "";
  }
  // The canary replays same-repo (privileged) rows; the fork flag is run
  // state the canary fixes explicitly rather than inherits.
  env.IS_FORK_PR = "false";
  const laneSecrets = resolveSecrets(input);
  const resolution = resolveConfidenceProfile(env);
  const profile = resolution.profile;
  // The primary credential, read the way the resolver's `primaryLane` does —
  // it feeds ONLY the scorer's diagnostic mask set and its defensive
  // isolation check, never a request header on a distinct endpoint.
  const primaryApiKey = ((env.AI_PRIMARY_API_KEY ?? "") || (env.AI_API_KEY ?? "")).trim();
  // Timeouts are production reads, not driver inputs: the resolved profile's
  // request timeout (AI_CONFIDENCE_TIMEOUT_SEC) and the primary lane's
  // connect timeout (AI_CONNECT_TIMEOUT_SEC), exactly as the engine passes
  // them. The driver's ceiling only bounds the bridge SUBPROCESS.
  const connectTimeoutSec = Number(env.AI_CONNECT_TIMEOUT_SEC ?? "30") || 30;
  const tokensParamRaw = (env.AI_TOKENS_PARAM ?? "max_tokens").trim();
  const tokensParam = tokensParamRaw === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
  const reviewResult = markerReviewResultLocal({
    verdictPolicy: typeof row.verdict_policy === "string" ? row.verdict_policy : "strict",
    verdict: typeof row.verdict === "string" ? row.verdict : "",
    findings: Array.isArray(row.findings) ? row.findings : [],
    requiredChecks: typeof row.required_checks === "string" ? row.required_checks : "none",
    partialCoverage: row.partial_coverage === true,
    coverageUnknown: false,
  });
  const pins = {
    headSha: typeof row.head_sha === "string" ? row.head_sha : "",
    baseSha: typeof row.base_sha === "string" ? row.base_sha : "",
    reviewResult,
  };
  const unresolvedPins = unresolvedConfidencePins(pins);
  const profileSummary = {
    model: profile.model,
    base_url: profile.baseUrl,
    api_format: profile.apiFormat,
    inherited_transport: profile.inheritedTransport,
    credential_source: profile.credentialSource,
    request_timeout_sec: profile.requestTimeoutSec,
    reasoning_effort: profile.reasoningEffort,
    max_tokens: profile.maxTokens,
    prompt_tokens: profile.promptTokens,
    model_context_tokens: profile.modelContextTokens,
    anthropic_effort_supported: profile.anthropicEffortSupported,
    structured_output_supported: profile.structuredOutputSupported,
  };
  const baseEmit = {
    enabled: profile.enabled,
    rubric_version: CONFIDENCE_RUBRIC_VERSION,
    warnings: resolution.warnings,
    review_result: reviewResult,
    unresolved_pins: unresolvedPins,
    profile: profileSummary,
    prompt_bytes: null as number | null,
    result: CONFIDENCE_DISABLED as ConfidenceResult,
    wire_effort: "",
    usage: null as { prompt_tokens: number; completion_tokens: number } | null,
    latency_ms: null as number | null,
    diagnostic: "",
    request_payload_masked: null as string | null,
    raw_response_masked: null as string | null,
  };
  // The engine's eligibility gates, in production order (src/engine/review.ts):
  // publish step → real review verdict → proof pins. Each refusal is the
  // production unscored shape with its own cause and ZERO wire attempts.
  if (!profile.enabled) {
    emit({ ...baseEmit, result: CONFIDENCE_DISABLED });
    return;
  }
  if (!publishStepRunsLocal(env.PUBLISH_MODE ?? "comment")) {
    emit({ ...baseEmit, result: unscoredConfidenceResult("not_published") });
    return;
  }
  const verdict = typeof row.verdict === "string" ? row.verdict : "";
  if (verdict !== "approve" && verdict !== "request_changes") {
    emit({ ...baseEmit, result: unscoredConfidenceResult("incomplete_review") });
    return;
  }
  if (unresolvedPins.length > 0) {
    emit({ ...baseEmit, result: unscoredConfidenceResult("incomplete_proof_context") });
    return;
  }
  const promptInputs: ConfidencePromptInputs = {
    headSha: pins.headSha,
    baseSha: pins.baseSha,
    reviewResult: pins.reviewResult,
    diff: typeof row.diff === "string" ? row.diff : "",
    prTitle: typeof row.pr_title === "string" ? row.pr_title : "",
    prBody: typeof row.pr_body === "string" ? row.pr_body : "",
    findings: Array.isArray(row.findings) ? row.findings : [],
    reviewSummary: typeof row.review_summary === "string" ? row.review_summary : "",
    requiredChecks: typeof row.required_checks === "string" ? row.required_checks : "none",
    coverage: isRecord(row.coverage) ? row.coverage : {},
    secrets: laneSecrets,
    // #1368: the RESOLVED profile's budget bounds the assembled prompt —
    // the same clamp the runtime's scorer call site passes.
    promptTokens: profile.promptTokens,
  };
  let prompt: { system: string; user: string };
  try {
    prompt = buildConfidencePrompt(promptInputs);
  } catch {
    fail(sub, "prompt_build_failed");
  }
  const promptBytes = Buffer.byteLength(prompt.system, "utf8") + Buffer.byteLength(prompt.user, "utf8");
  const started = Date.now();
  // Fail-soft boundary exactly as the engine wraps it: a scorer crash is an
  // unscored row with a masked diagnostic, never a crashed canary run.
  let outcome: Awaited<ReturnType<typeof runConfidenceScorer>>;
  try {
    outcome = await runConfidenceScorer({
      profile,
      primaryApiKey,
      prompt,
      connectTimeoutSec,
      tokensParam,
      laneSecrets,
      findings: Array.isArray(row.findings) ? row.findings : [],
      coverage: isRecord(row.coverage) ? row.coverage : {},
    });
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    emit({
      ...baseEmit,
      prompt_bytes: promptBytes,
      result: unscoredConfidenceResult("internal_error", profile.model),
      diagnostic: maskDiagnostic(message, laneSecrets),
      latency_ms: Date.now() - started,
    });
    return;
  }
  const latencyMs = Date.now() - started;
  const usage = outcome.rawResponse !== null ? usageFromRaw(profile.apiFormat, outcome.rawResponse) : null;
  emit({
    ...baseEmit,
    prompt_bytes: promptBytes,
    result: canonicalMaskedConfidence(outcome.result, laneSecrets),
    wire_effort: outcome.wireEffort,
    usage,
    latency_ms: latencyMs,
    diagnostic: outcome.diagnostic,
    request_payload_masked: outcome.requestPayload !== null
      ? JSON.stringify(redactTextDeep(outcome.requestPayload, laneSecrets))
      : null,
    raw_response_masked: outcome.rawResponse !== null
      ? JSON.stringify(redactTextDeep(outcome.rawResponse, laneSecrets))
      : null,
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
  else if (subcommand === "live-scorer") {
    liveScorer(argv).catch(() => fail(subcommand, "unhandled_error"));
  }
  else fail("dispatch", "unknown_subcommand");
}

main();
