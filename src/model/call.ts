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
import { runChatRequest, type ChatRequestOutcome } from "../transport/transport.js";
import { TransportFailure } from "../transport/http.js";

/**
 * Port of the v2 `call_model_tier` retry loop (scripts/model_call.sh): one
 * tier, one retry budget, typed failures. Semantics preserved exactly:
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
 *   that does it.
 */

export const EMPTY_COMPLETION_EXIT = 3;
export const PARSE_FAIL_CAP = 2;
export const MAX_RETRY_DELAY_SEC = 120;

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
  | { status: "ok"; verdict: ParsedReviewVerdict; rawResponse: unknown; attempts: number }
  | { status: "empty_completion"; attempts: number; failure: VerdictParseFailure }
  | { status: "parse_exhausted"; attempts: number; failure: VerdictParseFailure }
  | { status: "transport_exhausted"; attempts: number; failure: TransportFailure };

function requestConfig(profile: TierProfile, context: ModelCallContext, stream: boolean): ModelRequestConfig {
  return {
    apiFormat: profile.apiFormat,
    model: profile.model,
    system: context.system,
    user: context.user,
    corpus: context.corpus,
    stream,
    shape: profile.shape,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    responseFormat: profile.responseFormat,
    tokensParam: profile.tokensParam,
  };
}

async function defaultSleep(seconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
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

  while (attempt <= profile.retries) {
    const payload = buildModelRequest(requestConfig(profile, context, profile.stream));
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
      // Transport or HTTP error: consume the retry budget with doubling
      // backoff, capped at 120 s.
      lastTransportFailure = outcome.failure;
      attempt++;
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_SEC);
      continue;
    }

    try {
      const verdict = parseVerdictResponse(outcome.raw);
      return { status: "ok", verdict, rawResponse: outcome.raw, attempts: attempt };
    } catch (error) {
      if (!(error instanceof VerdictParseFailure)) throw error;
      lastParseFailure = error;
      parseFails++;
      // An empty completion is deterministic for a given input: escalate now
      // rather than spending the parse-failure budget on a repeat.
      if (error.emptyCompletion) {
        return { status: "empty_completion", attempts: attempt, failure: error };
      }
      if (parseFails >= PARSE_FAIL_CAP) {
        return { status: "parse_exhausted", attempts: attempt, failure: error };
      }
      attempt++;
      await sleep(delay);
    }
  }
  return lastTransportFailure
    ? { status: "transport_exhausted", attempts: attempt - 1, failure: lastTransportFailure }
    : {
      status: "parse_exhausted",
      attempts: attempt - 1,
      failure: lastParseFailure ?? new VerdictParseFailure("not_object", "Expected JSON object but got NoneType"),
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
      return { ok: false, verdict: null, raw: null, reason: "transport", detail: outcome.failure.message };
    }
    try {
      return { ok: true, verdict: parseVerdictResponse(outcome.raw), raw: outcome.raw, reason: "accepted", detail: "" };
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

  if (!first.ok && attemptedStream) {
    retried = true;
    streamFailureKind = first.reason;
    streamFailureDetail = first.detail;
    const retryPayload = buildModelRequest(requestConfig(profile, context, false));
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
  }

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
  };
}
