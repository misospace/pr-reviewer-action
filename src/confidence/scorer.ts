/**
 * #1073: orchestration of the one independent confidence-scorer model call.
 *
 * Boundaries enforced here, not negotiated:
 * - exactly ONE wire attempt (the transport's single-shot path — no 429/5xx
 *   backoff loop, no fallback lane, no second review);
 * - credential isolation: the scorer's resolved `ConfidenceProfile` is the
 *   ONLY credential source; a distinct endpoint without its own key may only
 *   be a loopback address, and the primary lane's key must never ride a
 *   distinct scorer URL (defensively re-checked here even though the
 *   resolver already guarantees it);
 * - a failure of any kind (timeout, quota/429/5xx, network, malformed
 *   answer) degrades to `unscored` with a redacted, action-owned cause —
 *   the review itself still publishes unchanged.
 */
import type { ChatRequestInput, ChatRequestOutcome } from "../transport/transport.js";
import { runChatRequestOnce } from "../transport/transport.js";
import { describeTransportFailure } from "../transport/http.js";
import { maskDiagnostic } from "../context/redact.js";
import { buildModelRequest } from "../model/request.js";
import type { TokensParam } from "../model/types.js";
import type { ConfidenceProfile } from "../routing/tiers.js";
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
 * inside it. This constant is only the documented default. */
export const CONFIDENCE_MAX_TOKENS = 4096;

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
  /** The primary lane's token-field convention, so self-hosted OpenAI
   * proxies that only accept one field keep working. */
  tokensParam?: TokensParam;
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
    input.primaryApiKey,
  ];
  if (!profile.enabled) {
    return { result: disabledResult(), requestPayload: null, rawResponse: null, diagnostic: "" };
  }
  // Credential isolation, asserted at call time (the resolver already
  // guarantees both, but this boundary fails closed rather than trusting
  // any upstream wiring):
  // 1. a distinct endpoint with no explicit key may only be loopback;
  // 2. the primary lane's credential must never ride a distinct scorer URL.
  // Provenance-based, not value-based: an operator may deliberately reuse
  // the same secret on a distinct endpoint; only a resolver wiring bug
  // (primary credential on a distinct URL) trips this boundary.
  // Both refusals below happen BEFORE any transport call, so the scorer never
  // ran: the model identity stays empty (the contract reserves a non-empty
  // `confidence-model` for a call that was actually attempted). Reporting the
  // configured model here would claim that model graded the review.
  if (profile.apiKey === "" && !profile.inheritedTransport && !isLoopbackUrl(profile.baseUrl)) {
    return {
      result: unscoredConfidenceResult("missing_credential"),
      requestPayload: null, rawResponse: null, diagnostic: "",
    };
  }
  if (!profile.inheritedTransport && profile.credentialSource === "primary") {
    return {
      result: unscoredConfidenceResult("credential_isolation"),
      requestPayload: null, rawResponse: null, diagnostic: "",
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
    tokensParam: input.tokensParam ?? "max_tokens",
    reasoningEffort: profile.reasoningEffort,
    // #1368: the scorer's OWN capability assertions — never another lane's.
    // Unasserted, the Anthropic wire carries no effort/format at all.
    anthropicEffortSupported: profile.anthropicEffortSupported,
    anthropicStructuredOutputSupported: profile.structuredOutputSupported,
  });
  const call = input.transport ?? ((chatInput: ChatRequestInput) => runChatRequestOnce(chatInput));
  let outcome: ChatRequestOutcome;
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
    return {
      result: unscoredConfidenceResult("transport_error", profile.model),
      requestPayload: null, rawResponse: null,
      diagnostic: maskDiagnostic(cause instanceof Error ? cause.message : String(cause), diagnosticSecrets),
    };
  }
  if (outcome.status !== "ok") {
    return {
      result: unscoredConfidenceResult(
        transportCause(outcome.failure.kind, outcome.failure.status),
        profile.model,
      ),
      requestPayload: null, rawResponse: null,
      diagnostic: describeTransportFailure(outcome.failure, { secrets: diagnosticSecrets }),
    };
  }
  const parsed = parseConfidenceAnswer(outcome.response.content);
  if (!parsed.ok) {
    return {
      result: unscoredConfidenceResult(parsed.cause, profile.model),
      requestPayload: payload.body, rawResponse: outcome.raw,
      diagnostic: "",
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
  };
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
