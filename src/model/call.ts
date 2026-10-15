import type {
  ApiFormat,
  ModelRequestConfig,
  ParsedReviewVerdict,
  RequestShape,
  ResponseFormatMode,
  TokensParam,
} from "./types.js";
import { VerdictParseFailure } from "./types.js";
import { buildModelRequest } from "./request.js";
import { parseVerdictResponse } from "./verdict.js";
import {
  describeUnusableResponse,
  formatResponseDiagnosticsLine,
  shouldRaiseCompletionBudget,
  type ResponseDiagnostics,
} from "./response-diagnostics.js";
import { runChatRequest, type ChatRequestOutcome } from "../transport/transport.js";
import { describeTransportFailure, TransportFailure } from "../transport/http.js";

/**
 * Port of the v2 `call_model_tier` retry loop (scripts/model_call.sh): one
 * tier, one retry budget, typed failures. Semantics preserved exactly:
 * - the tier's permanent HTTP set (400/401/403/404) fails fast to fallback;
 *   all other statuses, including 5xx such as 524, consume the retry budget;
 * - transport/HTTP failures consume the retry budget with doubling backoff
 *   capped at 120 s;
 * - parse/validate failures cap at 2 attempts total regardless of budget
 *   (deterministic failures must not burn 8 tries) and do not grow the
 *   backoff;
 * - an empty completion (0 completion tokens, v2 exit 3) stops the tier
 *   immediately — the same input cannot produce different output;
 * - streaming is fixed per tier: the tier loop has no stream→non-streamed
 *   fallback. The one-shot non-streamed verdict retry is a separate entry
 *   point (`produceVerdict`) mirroring the native-loop verdict path
 *   (`produce_native_verdict` in run_tool_harness.py), the only v2 place
 *   that does it;
 * - every tier always makes at least one attempt (#867), regardless of a
 *   configured `retries` of 0: `retries` is the total-attempt budget, and
 *   skipping the call entirely for a degenerate 0 would misreport a real
 *   transport outage as the loop's synthetic default parse failure below.
 */

export const EMPTY_COMPLETION_EXIT = 3;
export const PARSE_FAIL_CAP = 2;
export const MAX_RETRY_DELAY_SEC = 120;

/**
 * #1047: the bounded completion-budget raise for an evidence-gated verdict
 * retry. Same multiplier and ceiling as the specialist overrun retry
 * (`OVERRUN_RETRY_*` in `src/specialists/payload.ts`): at most 4x the
 * configured cap, never above 32768, applied at most once per tier call and
 * only when the response's own shape shows the cap destroyed the verdict (a
 * token-cap stop reason, or the whole budget spent on reasoning before any
 * text). No additional attempt is spent — the raise upgrades a retry that
 * was already going to run.
 */
export const VERDICT_BUDGET_RAISE_MULTIPLIER = 4;
export const VERDICT_BUDGET_RAISE_CEILING = 32768;

export function raisedCompletionBudget(maxTokens: number): number {
  return Math.max(maxTokens, Math.min(maxTokens * VERDICT_BUDGET_RAISE_MULTIPLIER, VERDICT_BUDGET_RAISE_CEILING));
}

/** #1006: Tier-level permanent HTTP statuses, distinct from the transport's
 * same-request retry allowlist. #987 borrowed that transport set as the tier's
 * permanence rule, so statuses it does not retry (including transient 524)
 * bypassed the configured tier retry budget. These four are the #978 set: an
 * authentication/model/configuration error a later attempt cannot fix. Every
 * other status (all 5xx, 429, other 4xx, unknown status) keeps the tier budget. */
const TIER_PERMANENT_HTTP_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

export interface TierProfile {
  label: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  model: string;
  apiKey: string;
  anthropicVersion: string;
  stream: boolean;
  requestTimeoutSec: number;
  connectTimeoutSec: number;
  retries: number;
  retryDelaySec: number;
  shape: RequestShape;
  maxTokens: number;
  temperature: number | "";
  responseFormat: ResponseFormatMode;
  tokensParam: TokensParam;
  /** #998: the lane's resolved reasoning effort ("" = omit the field). */
  reasoningEffort: string;
  /** #998: the Anthropic endpoint opt-in for `output_config.effort`. */
  anthropicEffortSupported: boolean;
  /** #1047: the Anthropic endpoint opt-in for `output_config.format`
   * (verdict JSON schema). */
  anthropicStructuredOutputSupported: boolean;
}

export interface ModelCallContext {
  system: string;
  user: string;
  corpus: string;
}

export interface ModelCallDeps {
  /** Injectable sleep for deterministic tests (seconds). */
  sleep?: (seconds: number) => Promise<void>;
  /** Injectable transport for deterministic tests. */
  call?: typeof runChatRequest;
}

export type ModelCallOutcome =
  | { status: "ok"; verdict: ParsedReviewVerdict; rawResponse: unknown; attempts: number; budgetRaisedTo?: number }
  | { status: "empty_completion"; attempts: number; failure: VerdictParseFailure; diagnostics?: ResponseDiagnostics | undefined }
  | { status: "parse_exhausted"; attempts: number; failure: VerdictParseFailure; diagnostics?: ResponseDiagnostics | undefined }
  | { status: "transport_exhausted"; attempts: number; failure: TransportFailure; nonRetryable?: boolean; diagnostics?: ResponseDiagnostics | undefined };

function requestConfig(profile: TierProfile, context: ModelCallContext, stream: boolean, maxTokensOverride?: number): ModelRequestConfig {
  return {
    apiFormat: profile.apiFormat,
    model: profile.model,
    system: context.system,
    user: context.user,
    corpus: context.corpus,
    stream,
    shape: profile.shape,
    maxTokens: maxTokensOverride ?? profile.maxTokens,
    temperature: profile.temperature,
    responseFormat: profile.responseFormat,
    tokensParam: profile.tokensParam,
    // #998: forwarded verbatim; "" keeps the request byte-identical.
    reasoningEffort: profile.reasoningEffort,
    anthropicEffortSupported: profile.anthropicEffortSupported,
    // #1047: forwarded so the Anthropic wire family can enforce the verdict
    // schema only under the lane's own endpoint assertion.
    anthropicStructuredOutputSupported: profile.anthropicStructuredOutputSupported,
  };
}

/** #1047: bounded diagnostics for a tier-level failure, or null when there
 * is nothing to describe (never reached in practice — every failure variant
 * carries a failure kind). */
function tierDiagnostics(
  profile: TierProfile,
  response: unknown,
  failure: { kind?: string; status?: number } | undefined,
): ResponseDiagnostics | null {
  return describeUnusableResponse({
    response,
    apiFormat: profile.apiFormat,
    profile: profile.label,
    streamed: profile.stream,
    secrets: [profile.apiKey],
    ...(failure?.status !== undefined ? { httpStatus: failure.status } : {}),
    ...(failure?.kind !== undefined && failure.kind !== "" ? { failureKind: failure.kind } : {}),
  });
}

async function defaultSleep(seconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
}

/** #1006: Only the tier-level permanent set skips the retry budget. The
 * transport's same-request retry policy is independent. */
function isRetryableTransportFailure(failure: TransportFailure): boolean {
  if (failure.kind !== "http_status") return true;
  if (failure.status === undefined) return true;
  return !TIER_PERMANENT_HTTP_STATUSES.has(failure.status);
}

export async function callModelTier(
  profile: TierProfile,
  context: ModelCallContext,
  deps: ModelCallDeps = {},
): Promise<ModelCallOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const doCall = deps.call ?? runChatRequest;

  let delay = profile.retryDelaySec;
  let parseFails = 0;
  let attempt = 1;
  let lastParseFailure: VerdictParseFailure | null = null;
  let lastTransportFailure: TransportFailure | null = null;
  // #1047: the last body the endpoint returned (for failure diagnostics) and
  // the latched completion-budget raise. `raisedTokens` is set at most once,
  // only on token-cap evidence, and only upgrades an attempt that was
  // already going to run — the attempt count never grows.
  let lastRaw: unknown = null;
  let raisedTokens: number | null = null;

  // #867: `retries` is a total-attempt budget (attempt <= retries), but a
  // caller-configured 0 (accepted by schema validation: ai-primary-retries
  // must only be >= 0) must never mean "never call the model at all" — that
  // silently skipped the request entirely and fell through to the synthetic
  // default below, misreporting a real endpoint outage as a fabricated
  // parse/validate failure instead of a transport one. At least one attempt
  // always runs; `retries` still governs every attempt after the first.
  const totalAttempts = Math.max(1, profile.retries);
  while (attempt <= totalAttempts) {
    const payload = buildModelRequest(requestConfig(profile, context, profile.stream, raisedTokens ?? undefined));
    const outcome = await doCall({
      baseUrl: profile.baseUrl,
      apiFormat: profile.apiFormat,
      payload,
      apiKey: profile.apiKey,
      anthropicVersion: profile.anthropicVersion,
      requestTimeoutSec: profile.requestTimeoutSec,
      connectTimeoutSec: profile.connectTimeoutSec,
    });

    if (outcome.status === "failure") {
      if (!isRetryableTransportFailure(outcome.failure)) {
        return {
          status: "transport_exhausted",
          attempts: attempt,
          failure: outcome.failure,
          nonRetryable: true,
          diagnostics: tierDiagnostics(profile, null, outcome.failure) ?? undefined,
        };
      }
      // Transport or HTTP error: consume the retry budget with doubling
      // backoff, capped at 120 s. Only sleep/back off when another attempt
      // is actually coming — a final failed attempt (no budget left) must
      // never pay the retry delay for a retry that will never happen.
      lastTransportFailure = outcome.failure;
      attempt++;
      if (attempt <= totalAttempts) {
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_RETRY_DELAY_SEC);
      }
      continue;
    }

    lastRaw = outcome.raw;
    try {
      const verdict = parseVerdictResponse(outcome.raw, [profile.apiKey]);
      return {
        status: "ok",
        verdict,
        rawResponse: outcome.raw,
        attempts: attempt,
        ...(raisedTokens !== null ? { budgetRaisedTo: raisedTokens } : {}),
      };
    } catch (error) {
      if (!(error instanceof VerdictParseFailure)) throw error;
      lastParseFailure = error;
      parseFails++;
      // An empty completion is deterministic for a given input: escalate now
      // rather than spending the parse-failure budget on a repeat.
      if (error.emptyCompletion) {
        return {
          status: "empty_completion",
          attempts: attempt,
          failure: error,
          diagnostics: tierDiagnostics(profile, lastRaw, error) ?? undefined,
        };
      }
      if (parseFails >= PARSE_FAIL_CAP) {
        const exhaustedDiagnostics = tierDiagnostics(profile, lastRaw, error) ?? undefined;
        if (exhaustedDiagnostics !== undefined && raisedTokens !== null) {
          exhaustedDiagnostics.record.completion_budget_raised_to = raisedTokens;
        }
        return { status: "parse_exhausted", attempts: attempt, failure: error, diagnostics: exhaustedDiagnostics };
      }
      // #1047: the next parse attempt upgrades its completion budget when —
      // and only when — the failed body's own shape shows the cap destroyed
      // the verdict (token-cap stop reason, or the whole budget spent on
      // reasoning before any text). Latched once; every other failure class
      // retries with the configured budget unchanged.
      if (raisedTokens === null) {
        const raised = raisedCompletionBudget(profile.maxTokens);
        if (raised > profile.maxTokens) {
          const diagnostics = tierDiagnostics(profile, lastRaw, error);
          if (diagnostics === null || shouldRaiseCompletionBudget(diagnostics.class)) {
            raisedTokens = raised;
          }
        }
      }
      attempt++;
      // Same rule as the transport branch: only sleep when a further
      // attempt is actually going to run.
      if (attempt <= totalAttempts) await sleep(delay);
    }
  }
  if (lastTransportFailure) {
    return {
      status: "transport_exhausted",
      attempts: attempt - 1,
      failure: lastTransportFailure,
      diagnostics: tierDiagnostics(profile, null, lastTransportFailure) ?? undefined,
    };
  }
  const finalParseDiagnostics = tierDiagnostics(profile, lastRaw, lastParseFailure ?? undefined) ?? undefined;
  if (finalParseDiagnostics !== undefined && raisedTokens !== null) {
    finalParseDiagnostics.record.completion_budget_raised_to = raisedTokens;
  }
  return {
    status: "parse_exhausted",
    attempts: attempt - 1,
    failure: lastParseFailure ?? new VerdictParseFailure("not_object", "Expected JSON object but got NoneType"),
    diagnostics: finalParseDiagnostics,
  };
}

export type VerdictOutcome = {
  ok: boolean;
  verdict: ParsedReviewVerdict | null;
  attempts: number;
  retried: boolean;
  transport: "streamed" | "non-streamed" | "non-streamed-retry" | "";
  reason: "accepted" | "transport" | "parse" | "empty" | "";
  detail: string;
  rawResponse: unknown;
  /** Set when a streamed attempt failed and the non-streamed retry ran. */
  streamFailureKind: VerdictOutcome["reason"];
  streamFailureDetail: string;
  /** #1047: bounded failure-shape diagnostics for the final unusable
   * response (absent on success). */
  diagnostics?: ResponseDiagnostics;
  /** #1047: the raised completion budget the non-streamed retry used, when
   * the streamed attempt's failure shape justified one (absent otherwise). */
  budgetRaisedTo?: number;
};

/**
 * One-shot verdict production with the #637 stream→non-streamed retry: the
 * streamed attempt is the fast path; when it is unusable (transport,
 * reassembly, or a body the verdict parser rejects — empty completions
 * included) retry exactly once non-streamed. Never throws.
 */
export async function produceVerdict(
  profile: TierProfile,
  context: ModelCallContext,
  deps: ModelCallDeps = {},
): Promise<VerdictOutcome> {
  const doCall = deps.call ?? runChatRequest;

  const evaluate = (outcome: ChatRequestOutcome): { ok: boolean; verdict: ParsedReviewVerdict | null; raw: unknown; reason: VerdictOutcome["reason"]; detail: string } => {
    if (outcome.status === "failure") {
      // #846: carry the HTTP status and a redacted body excerpt (plus the
      // ai-api-format hint on a 404) instead of the bare "model endpoint
      // returned HTTP <status>" message. `secrets` masks the configured key
      // unconditionally — a provider echoing it in bare prose would
      // otherwise pass `redactText`'s pattern heuristics untouched.
      return { ok: false, verdict: null, raw: null, reason: "transport", detail: describeTransportFailure(outcome.failure, { secrets: [profile.apiKey] }) };
    }
    try {
      return { ok: true, verdict: parseVerdictResponse(outcome.raw, [profile.apiKey]), raw: outcome.raw, reason: "accepted", detail: "" };
    } catch (error) {
      if (!(error instanceof VerdictParseFailure)) throw error;
      return {
        ok: false,
        verdict: null,
        raw: outcome.raw,
        reason: error.emptyCompletion ? "empty" : "parse",
        detail: error.message,
      };
    }
  };

  const firstPayload = buildModelRequest(requestConfig(profile, context, profile.stream));
  const attemptedStream = profile.stream;
  const first = evaluate(await doCall({
    baseUrl: profile.baseUrl,
    apiFormat: profile.apiFormat,
    payload: firstPayload,
    apiKey: profile.apiKey,
    anthropicVersion: profile.anthropicVersion,
    requestTimeoutSec: profile.requestTimeoutSec,
    connectTimeoutSec: profile.connectTimeoutSec,
  }));
  let attempts = 1;
  let retried = false;
  let streamFailureKind: VerdictOutcome["reason"] = "";
  let streamFailureDetail = "";
  let current = first;
  let finalBudgetRaisedTo: number | null = null;

  if (!first.ok && attemptedStream) {
    retried = true;
    streamFailureKind = first.reason;
    streamFailureDetail = first.detail;
    // #1047: the single non-streamed retry raises its completion budget when
    // — and only when — the streamed body's own shape shows the token cap
    // destroyed the verdict (token-cap stop reason, or the whole budget
    // spent on reasoning before any text). No extra call is spent: the retry
    // was already going to run; only its cap changes. Transport failures and
    // true zero-output never raise — more tokens cannot recover those.
    let budgetRaisedTo: number | undefined;
    if (first.reason === "parse") {
      const diagnostics = describeUnusableResponse({
        response: first.raw,
        apiFormat: profile.apiFormat,
        profile: profile.label,
        streamed: true,
        secrets: [profile.apiKey],
        failureKind: "parse",
      });
      const raised = raisedCompletionBudget(profile.maxTokens);
      if (diagnostics !== null && shouldRaiseCompletionBudget(diagnostics.class) && raised > profile.maxTokens) {
        budgetRaisedTo = raised;
      }
    }
    const retryPayload = buildModelRequest(requestConfig(profile, context, false, budgetRaisedTo));
    current = evaluate(await doCall({
      baseUrl: profile.baseUrl,
      apiFormat: profile.apiFormat,
      payload: retryPayload,
      apiKey: profile.apiKey,
      anthropicVersion: profile.anthropicVersion,
      requestTimeoutSec: profile.requestTimeoutSec,
      connectTimeoutSec: profile.connectTimeoutSec,
    }));
    attempts++;
    finalBudgetRaisedTo = budgetRaisedTo ?? null;
  }

  const finalDiagnostics = current.ok
    ? null
    : describeUnusableResponse({
        response: current.raw,
        apiFormat: profile.apiFormat,
        profile: profile.label,
        streamed: current === first ? attemptedStream : false,
        secrets: [profile.apiKey],
        failureKind: current.reason === "transport" ? "network" : current.reason === "empty" ? "empty_completion" : "not_object",
      });

  return {
    ok: current.ok,
    verdict: current.verdict,
    attempts,
    retried,
    transport: current.ok
      ? (!attemptedStream ? "non-streamed" : retried ? "non-streamed-retry" : "streamed")
      : "",
    reason: current.ok ? "accepted" : current.reason,
    detail: current.ok ? "" : current.detail,
    rawResponse: current.raw,
    streamFailureKind: streamFailureKind,
    streamFailureDetail: streamFailureDetail,
    ...(finalDiagnostics !== null ? { diagnostics: finalDiagnostics } : {}),
    ...(finalBudgetRaisedTo !== null ? { budgetRaisedTo: finalBudgetRaisedTo } : {}),
  };
}
