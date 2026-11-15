/**
 * #1073: orchestration of the one independent confidence-scorer model call.
 *
 * Boundaries enforced here, not negotiated:
 * - exactly ONE wire attempt (the transport's single-shot path — no 429/5xx
 *   backoff loop, no fallback lane, no second review);
 * - a configuration the resolver itself refused (`ConfidenceProfile.refusalCause`,
 *   #1478: the require-dedicated isolation mode without its dedicated
 *   endpoint or without a dedicated model) publishes `unscored` with that
 *   action-owned cause before the wire;
 * - credential isolation: the scorer's resolved `ConfidenceProfile` is the
 *   ONLY credential source; a distinct endpoint without its own key may only
 *   be a loopback address, and the primary lane's key must never ride a
 *   distinct scorer URL (defensively re-checked here even though the
 *   resolver already guarantees it);
 * - a failure of any kind (timeout, quota/429/5xx, network, malformed
 *   answer) degrades to `unscored` with a redacted, action-owned cause —
 *   the review itself still publishes unchanged;
 * - the profile's declared budgets are actual bounds: a prompt that does not
 *   fit `ConfidenceProfile.promptTokens` is refused before the wire, never
 *   sent over the bound (#1368 review).
 */
import type { ChatRequestInput, ChatRequestOutcome } from "../transport/transport.js";
import { runChatRequestOnce } from "../transport/transport.js";
import { describeTransportFailure, endpointUrlCredentialOrEmpty } from "../transport/http.js";
import type { TransportFailureKind } from "../transport/http.js";
import { basicAuthorizationHeaderValue } from "../transport/headers.js";
import { maskDiagnostic } from "../context/redact.js";
import { buildModelRequest, wireEffortOf } from "../model/request.js";
import type { ConfidenceProfile } from "../routing/tiers.js";
import { confidenceUsageFromProviderBody, type ConfidenceUsageTelemetry } from "./telemetry.js";
import {
  applyConfidenceCeilings,
  CONFIDENCE_ANSWER_JSON_SCHEMA,
  parseConfidenceAnswer,
  scoredConfidenceResult,
  unscoredConfidenceResult,
  type ConfidenceResult,
} from "./result.js";
import type { ConfidencePromptInputs } from "./prompt.js";

/** DEFAULT completion budget for the scorer's answer: a bounded JSON object,
 * not a review. A reasoning model may consume the whole budget thinking and
 * return no JSON at all — the profile's configured budget
 * (`ai-confidence-max-tokens`, resolved into `ConfidenceProfile.maxTokens`)
 * is the real control, and provider accounting may include reasoning tokens
 * inside it. This constant is the documented default — and the SINGLE
 * source for it (#1387): `resolveConfidenceProfile` and the disabled
 * profile in `src/routing/tiers.ts` resolve these same constants, so the
 * calibration tooling's projected spend ceiling and the budgets production
 * actually resolves cannot drift apart. */
export const CONFIDENCE_MAX_TOKENS = 4096;

/** DEFAULT prompt budget for the scorer's request, the sibling of
 * `CONFIDENCE_MAX_TOKENS` and the same single source for it (#1387): the
 * resolver's `promptTokens` default and the disabled profile both read
 * this constant. */
export const CONFIDENCE_PROMPT_TOKENS = 98304;

/** Hosts a keyless distinct scorer endpoint may still point at: the
 * operator's own machine. Anything else without a credential is refused. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Redacted, action-owned cause token for a transport failure — never
 * provider text, never a secret. Exported so the calibration pilot's
 * bridge live-request path maps failures through the SAME authority. */
export function transportCause(kind: string, status: number | undefined): string {
  if (kind === "http_status" && status !== undefined) return `http_${status}`;
  if (kind === "request_timeout" || kind === "connect_timeout") return "timeout";
  if (kind === "response_too_large") return "response_too_large";
  return "transport_error";
}

export interface ConfidenceScorerInput {
  profile: ConfidenceProfile;
  /** The primary lane's resolved API key, used ONLY for the defensive
   * credential-isolation check (never attached to any request). */
  primaryApiKey: string;
  prompt: { system: string; user: string };
  connectTimeoutSec: number;
  transport?: (input: ChatRequestInput) => Promise<ChatRequestOutcome>;
  /** #726 (engine cancellation): caller-owned abort, propagated into the
   * transport so an aborted run tears the scorer's in-flight provider
   * request down instead of letting it run on. A `cancelled` transport
   * failure degrades to unscored exactly like any other transport failure. */
  signal?: AbortSignal;
  /** Every credential configured for this run, so thrown-transport and
   * transport-failure diagnostics mask the FULL lane set, not just the
   * scorer's own key and the primary's: a provider error body can echo any
   * lane's secret, and each one is a real credential for this run even when
   * this lane never carries it. */
  laneSecrets?: readonly (string | null | undefined)[];
}

/** The scorer's outcome plus the masked wire diagnostics the run persists
 * beside the other model artifacts. */
export interface ConfidenceScorerOutcome {
  result: ConfidenceResult;
  /** The request body actually built (secret-masked by the caller before
   * persistence); null when no call was attempted. */
  requestPayload: unknown;
  /** The raw provider response (secret-masked by the caller); null when no
   * usable response arrived. */
  rawResponse: unknown;
  /** Bounded, secret-redacted transport-failure detail for the persisted
   * artifact; "" when the call succeeded (or never happened). */
  diagnostic: string;
  /** The reasoning effort on the request this run SENT, read back from the
   * built body rather than re-derived from the profile; "" when the run sent
   * no request at all (a pre-wire refusal, or a transport that failed before
   * a request existed) or when the sent request carried no effort field.
   * #998's truth-telling rule: the run persists what was SENT, never what
   * the configuration named. */
  wireEffort: string;
  /** #1455: the token counts the provider reported for this call, in the
   * repo's canonical format-aware accounting. Null when the provider
   * reported none, and null on every failure path (a failed call has no
   * usage to report). The scorer is one-shot by contract, so this is one
   * call's usage. */
  usage: ConfidenceUsageTelemetry | null;
  /** #1455: the wall-clock milliseconds the scorer's provider call took —
   * the time the provider took to answer a request that demonstrably reached
   * it. Null when no such call happened: a refusal before the wire (the
   * pre-wire refusals above), a request that never left the machine (a
   * connect timeout, a cancellation), or a transport that failed before a
   * request existed. A latency for a call that never happened would be a
   * claim the run cannot back. */
  latencyMs: number | null;
}

/**
 * Run the scorer. Deterministic inputs for the ceilings (the final findings
 * and the coverage record) ride along so the parsed answer can never
 * outrank them.
 */
export async function runConfidenceScorer(input: ConfidenceScorerInput & ConfidenceCeilingArgs): Promise<ConfidenceScorerOutcome> {
  const { profile } = input;
  // #1140 review: the diagnostic mask set is EVERY configured credential for
  // this run, not just the two this lane could plausibly echo. Applied before
  // truncation (via `maskDiagnostic`) so a secret straddling the cap is never
  // partially exposed.
  const diagnosticSecrets: readonly (string | null | undefined)[] = [
    ...(input.laneSecrets ?? []),
    profile.apiKey,
    // #1428 review: when the endpoint URL carries the credential, the wire
    // sends `Authorization: Basic <base64>` (one shared builder, so this list
    // can never drift from the header bytes); a provider echo of the exact
    // header value must mask before any diagnostic or artifact is produced.
    ...(
      endpointUrlCredentialOrEmpty(profile.baseUrl)
        ? [endpointUrlCredentialOrEmpty(profile.baseUrl), basicAuthorizationHeaderValue(endpointUrlCredentialOrEmpty(profile.baseUrl))]
        : []
    ),
    input.primaryApiKey,
  ];
  if (!profile.enabled) {
    return { result: disabledResult(), requestPayload: null, rawResponse: null, diagnostic: "", wireEffort: "", usage: null, latencyMs: null };
  }
  // #1478: a configuration the RESOLVER itself refused (the require-dedicated
  // isolation mode with no dedicated endpoint configured, or with no
  // dedicated model configured). Same contract as the refusals below: no
  // wire attempt, no request artifact, an action-owned cause, and the review
  // unaffected. The model identity stays empty on the result — nothing
  // audited the review.
  if (profile.refusalCause !== "") {
    return {
      result: unscoredConfidenceResult(profile.refusalCause),
      requestPayload: null, rawResponse: null, diagnostic: "", wireEffort: "",
      usage: null, latencyMs: null,
    };
  }
  // Credential isolation, asserted at call time (the resolver already
  // guarantees both, but this boundary fails closed rather than trusting
  // any upstream wiring):
  // 1. a distinct endpoint with no explicit key may only be loopback, or
  // carry its own credential in the URL userinfo (#1428: a URL credential
  // IS the lane's credential, so the Basic request reaches the transport —
  // and a URL whose credential cannot be attributed fails closed here);
  // 2. the primary lane's credential must never ride a distinct scorer URL.
  // Provenance-based, not value-based: an operator may deliberately reuse
  // the same secret on a distinct endpoint; only a resolver wiring bug
  // (primary credential on a distinct URL) trips this boundary.
  // Both refusals below happen BEFORE any transport call, so the scorer never
  // ran: the model identity stays empty (the contract reserves a non-empty
  // `confidence-model` for a call that was actually attempted). Reporting the
  // configured model here would claim that model graded the review.
  if (
    profile.apiKey === "" &&
    endpointUrlCredentialOrEmpty(profile.baseUrl) === "" &&
    !profile.inheritedTransport &&
    !isLoopbackUrl(profile.baseUrl)
  ) {
    return {
      result: unscoredConfidenceResult("missing_credential"),
      requestPayload: null, rawResponse: null, diagnostic: "", wireEffort: "",
      usage: null, latencyMs: null,
    };
  }
  if (!profile.inheritedTransport && profile.credentialSource === "primary") {
    return {
      result: unscoredConfidenceResult("credential_isolation"),
      requestPayload: null, rawResponse: null, diagnostic: "", wireEffort: "",
      usage: null, latencyMs: null,
    };
  }
  // #1368 review: the declared prompt budget is an ACTUAL bound. The prompt
  // builder shrinks the diff section to hold it, but its 4,096-byte diff floor
  // is the SMALLEST usable diff, not permission to overrun: once the fixed
  // sections alone leave less than the floor, the assembled request is over
  // the budget — and through the declared-context clamp, over the declared
  // context window. Refuse it here: no wire attempt, no request artifact,
  // `unscored` with an action-owned cause. `CONFIDENCE_MINIMUM_PROMPT_TOKENS`
  // is the resolver's system-inclusive floor, so an empty-evidence prompt can
  // never reach this branch; it fires only when the run's own evidence does
  // not fit the budget the operator declared.
  const promptBytes = Buffer.byteLength(input.prompt.system, "utf8")
    + Buffer.byteLength(input.prompt.user, "utf8");
  if (promptBytes > profile.promptTokens * 4) {
    return {
      result: unscoredConfidenceResult("prompt_over_budget"),
      requestPayload: null, rawResponse: null, diagnostic: "", wireEffort: "",
      usage: null, latencyMs: null,
    };
  }
  const payload = buildModelRequest({
    apiFormat: profile.apiFormat === "anthropic" ? "anthropic" : "openai",
    model: profile.model,
    system: input.prompt.system,
    user: input.prompt.user,
    // Single bounded payload; no corpus split for the one-shot scorer.
    corpus: "",
    stream: false,
    shape: "default",
    // #1368: the profile's configured budget, not the constant above.
    maxTokens: profile.maxTokens,
    temperature: "",
    // #1073/#1368: response format OFF by default — no schema attaches, the
    // scorer's answer is its own bounded JSON contract parsed tolerantly
    // downstream. Under the operator's structured-output assertion the
    // scorer's OWN compact schema rides the wire (never the verdict schema).
    responseFormat: profile.structuredOutputSupported ? "json_schema" : "off",
    responseSchema: CONFIDENCE_ANSWER_JSON_SCHEMA,
    // #1481: the token-limit field is the RESOLVED profile's own — the engine
    // no longer feeds this lane the primary/global AI_TOKENS_PARAM state, so a
    // require-dedicated verifier can never silently inherit the review lane's
    // convention.
    tokensParam: profile.tokensParam,
    reasoningEffort: profile.reasoningEffort,
    // #1368: the scorer's OWN capability assertions — never another lane's.
    // Unasserted, the Anthropic wire carries no effort/format at all.
    anthropicEffortSupported: profile.anthropicEffortSupported,
    anthropicStructuredOutputSupported: profile.structuredOutputSupported,
    // #1655 review: the scorer makes EXACTLY ONE wire attempt (the boundary
    // this module enforces), so it cannot retry without a marker it carries:
    // a gateway that accepts only a string `system` would answer 400 and the
    // confidence score would be lost. The scorer's request therefore keeps
    // the plain-string system prompt it always sent.
    anthropicCacheCheckpoint: false,
  });
  // #998: the effort this dispatch carries, read back from the body the
  // transport sends — never re-derived from the profile.
  const wireEffort = wireEffortOf(payload);
  const call = input.transport ?? ((chatInput: ChatRequestInput) => runChatRequestOnce(chatInput));
  let outcome: ChatRequestOutcome;
  // #1455: the wall-clock cost of the scorer's ONE wire attempt, measured
  // around the awaited call. The pre-wire refusals above returned before
  // this point, so they carry no latency at all — a duration for a call
  // that never happened would be a claim the run cannot back.
  const startedAt = Date.now();
  try {
    outcome = await call({
      baseUrl: profile.baseUrl,
      apiFormat: profile.apiFormat === "anthropic" ? "anthropic" : "openai",
      payload,
      apiKey: profile.apiKey,
      anthropicVersion: "2023-06-01",
      requestTimeoutSec: profile.requestTimeoutSec,
      connectTimeoutSec: input.connectTimeoutSec,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause: unknown) {
    // A thrown transport (should not happen — failures are typed) still
    // degrades to unscored, never fails the review. `maskDiagnostic` masks on
    // the FULL untruncated message before capping it, so a configured secret
    // straddling the 300-char boundary cannot leave a partial prefix behind.
    //
    // #998: a THROWN transport never produced a request — the endpoint URL
    // never resolved, the headers never merged — so nothing was sent and the
    // run reports no effort, whatever the body would have carried.
    //
    // #1455: the same truth bounds the latency: nothing reached the
    // provider, so there is no provider-call duration to report. The time
    // spent failing locally is not the provider's latency.
    return {
      result: unscoredConfidenceResult("transport_error", profile.model),
      requestPayload: null, rawResponse: null,
      diagnostic: maskDiagnostic(cause instanceof Error ? cause.message : String(cause), diagnosticSecrets),
      wireEffort: "",
      usage: null,
      latencyMs: null,
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (outcome.status !== "ok") {
    // #1455: the latency is the provider's answer time, so it rides the same
    // predicate the effort provenance rides: a request that demonstrably
    // reached the provider has an answer to wait for, and one that never
    // left the machine (a connect timeout, a cancellation) has none. The
    // cause already tells the consumer which of the two happened.
    return {
      result: unscoredConfidenceResult(
        transportCause(outcome.failure.kind, outcome.failure.status),
        profile.model,
      ),
      requestPayload: null, rawResponse: null,
      diagnostic: describeTransportFailure(outcome.failure, { secrets: diagnosticSecrets }),
      wireEffort: failureReachedProvider(outcome.failure.kind) ? wireEffort : "",
      usage: null,
      latencyMs: failureReachedProvider(outcome.failure.kind) ? latencyMs : null,
    };
  }
  const parsed = parseConfidenceAnswer(outcome.response.content);
  // #1455: the usage the provider reported for THIS call, read from the raw
  // provider body in the wire format the run used. The raw body is the
  // source on purpose: the transport's own projection is shape-only, so it
  // sums a total the provider did not report and cannot see the Anthropic
  // cache tokens the canonical accounting counts.
  const usage = confidenceUsageFromProviderBody(outcome.raw, profile.apiFormat === "anthropic" ? "anthropic" : "openai");
  if (!parsed.ok) {
    return {
      result: unscoredConfidenceResult(parsed.cause, profile.model),
      requestPayload: payload.body, rawResponse: outcome.raw,
      diagnostic: "",
      wireEffort,
      // #1455: the provider DID answer and DID report its accounting for
      // that answer — only the parse failed. The run spent those tokens, so
      // the usage is reported; dropping it would understate the cost of a
      // run that failed to read the answer, not save it.
      usage,
      latencyMs,
    };
  }
  const ceilings = applyConfidenceCeilings(parsed.answer, {
    findings: input.findings,
    coverage: input.coverage,
  });
  return {
    result: scoredConfidenceResult({
      score: ceilings.score,
      risk: ceilings.risk,
      reason: ceilings.reason,
      concerns: parsed.answer.concerns,
      model: profile.model,
      caps: ceilings.caps,
      parserNotes: parsed.answer.notes,
    }),
    requestPayload: payload.body,
    rawResponse: outcome.raw,
    diagnostic: "",
    wireEffort,
    // #1455: the provider's own accounting for the one call that produced
    // this answer — the transport normalized it, the scorer no longer drops
    // it.
    usage,
    latencyMs,
  };
}

/**
 * #998: whether a typed transport failure can have carried the dispatched
 * request to the provider — the only question the effort-sent provenance
 * turns on.
 *
 * - `connect_timeout` never opened a connection, so no request was
 *   transmitted at all;
 * - `cancelled` can fire before the body was written;
 * - `http_status` and `response_too_large` are the provider's OWN answer, so
 *   the request demonstrably arrived;
 * - `request_timeout` is a written request whose answer was lost;
 * - `network` is the transport's catch-all socket kind, and it also covers a
 *   provider answer that was not JSON — so it cannot mean "never reached the
 *   provider", and it keeps the dispatched effort (the conservative
 *   direction for a spend-provenance field).
 */
function failureReachedProvider(kind: TransportFailureKind): boolean {
  return kind !== "connect_timeout" && kind !== "cancelled";
}

function disabledResult(): ConfidenceResult {
  return {
    status: "disabled",
    score: null,
    risk: "",
    reason: "",
    concerns: [],
    model: "",
    cause: "",
    caps: [],
    parserNotes: [],
  };
}

interface ConfidenceCeilingArgs {
  /** The FINAL normalized still-open findings (deterministic cap input). */
  findings: unknown;
  /** The review's own coverage record (deterministic cap input). */
  coverage: Record<string, unknown>;
}
