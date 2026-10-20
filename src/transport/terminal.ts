import { maskKnownSecrets } from "../context/redact.js";
import type { TransportFailure } from "./http.js";

/**
 * #1080: terminal provider-failure classification — the ONE authority both
 * retry layers ask before spending an attempt.
 *
 * Why this exists: every provider 429 used to burn the whole retry budget
 * (transport: 3 same-request attempts with 1s/2s backoff; tier: up to 8
 * attempts with 15s→120s backoff) even when the provider had already said the
 * account's quota is EXHAUSTED — a condition no later attempt can recover from.
 * A real run spent 13m40s in silent primary retries before the already
 * configured fallback succeeded. A retired/deprecated model is the same class
 * of permanent failure and used to be misread as transient (an HTTP 410).
 *
 * Shape of the rule, deliberately narrow and evidence-gated:
 * - only an `http_status` failure carries provider evidence; network,
 *   connect/request-timeout and oversize failures have no body and can never
 *   match (they always return null);
 * - the scan is bounded to the first 64 KiB of the body;
 * - a decision is either an EXACT structured token from a small allowlist of
 *   key paths (any status), or an allowlisted literal PHRASE in a provider
 *   message (4xx only — see the status gate below). A bare substring, a
 *   heuristic, or "the body sounds negative" never decides;
 * - every result is an allowlisted id (`signature`), never provider prose, so
 *   nothing from an untrusted body can travel into a log line or an artifact
 *   through this module;
 * - a bare provider CODE is never decisive on its own. LiteLLM surfaces
 *   MiniMax's token-plan exhaustion as code `2056`, but a `2056` anywhere in a
 *   body is just as likely to be an unrelated number, an id, or prose, so the
 *   code carries no weight at all here — the token-plan SENTENCES beside it are
 *   what this module recognizes.
 *
 * The transient veto exists because the phrase lists cannot encode
 * "exhausted" vs "momentarily busy" perfectly: providers reuse quota wording
 * for short-window limits ("you exceeded your current quota, please limit
 * requests to 10000 requests per minute"). Any transient marker in the SAME
 * matched text vetoes a phrase match. Structured exact-token matches are NOT
 * vetoed, because an exact allowlisted token in an allowlisted key path
 * (`error.code: "insufficient_quota"`) is the provider naming a permanent
 * condition, and a body that ALSO says "please retry" is still that condition.
 *
 * Native tool loop: NO change is needed there. The harness calls
 * `runChatRequest`, so this classifier already removes its inner 1s/2s 429
 * retries on a terminal body; the harness's own single streamed→non-streamed
 * verdict retry is a bounded extra attempt outside this module's scope and is
 * deliberately left alone. Do not look for a harness-side change.
 *
 * Known boundary, stated rather than papered over: a 4xx body whose message
 * QUOTES the review corpus and happens to contain an allowlisted phrase IS
 * accepted as the provider's own claim. Rejecting an echo structurally would
 * need a leading-sentence or delimiter heuristic, and no such heuristic can be
 * told apart from a real provider message without reintroducing the false
 * negative this module exists to prevent. The 5xx echo channel — the one a
 * passthrough gateway actually opens — is closed by the status gate below. The
 * residual's consequence is bounded by design: an immediate, truthfully-logged
 * fallback (availability recovery), never a verdict change, a gate bypass, or
 * a fabricated outcome.
 */

/** The two permanent provider conditions worth failing over immediately. */
export type TerminalProviderReason = "quota_exhausted" | "model_unavailable";

export interface TerminalProviderFailure {
  reason: TerminalProviderReason;
  /** Short stable id of the matched evidence (e.g. `openai_insufficient_quota`).
   * An allowlist key of THIS module — never provider prose. */
  signature: string;
  /** The HTTP status the failure carried, when it had one. */
  httpStatus?: number;
}

/** Bounded scan: only the first 64 KiB of an error body is ever parsed. */
export const MAX_SCAN_BYTES = 64 * 1024;

/** Cap on a normalized structured token, so a long provider value can never be
 * trimmed into an allowlist entry by accident. */
const MAX_TOKEN_CHARS = 64;

/**
 * Structured-token evidence. Only these exact key paths count — a value that
 * merely LOOKS like a code somewhere else in the body is not evidence (a
 * hostile body can put anything anywhere; an allowlisted KEY is what makes a
 * value a provider code).
 */
const TOKEN_PATHS: readonly (readonly string[])[] = [
  ["error", "type"],
  ["error", "code"],
  ["error", "status"],
  ["error", "error_type"],
  ["error", "reason"],
  ["error", "code_num"],
  ["type"],
  ["code"],
  ["code_num"],
  ["error", "error", "type"],
  ["error", "error", "code"],
  ["error", "error", "status"],
];

/** Provider message paths a decisive phrase may be matched against. */
const MESSAGE_PATHS: readonly (readonly string[])[] = [
  ["error", "message"],
  ["error", "error", "message"],
  ["error", "msg"],
  ["message"],
  ["detail"],
  // MiniMax's own (unwrapped) error envelope when the operator points
  // ai_base_url straight at the provider rather than through LiteLLM.
  ["base_resp", "status_msg"],
];

/** Providers that put the human-readable message in a STRING-valued `error`
 * instead of an object (Ollama, vLLM, assorted simple gateways). */
const STRING_ERROR_PATHS: readonly (readonly string[])[] = [["error"]];

/** Signature for the MiniMax token-plan exhaustion evidence. */
const LITELLM_MINIMAX_TOKEN_PLAN = "litellm_minimax_token_plan";

/**
 * Exact structured tokens, compared after lowercase/trim (and a length cap).
 * Every entry is a PERMANENT condition a later attempt cannot fix.
 */
const QUOTA_TOKENS: ReadonlyMap<string, string> = new Map([
  // OpenAI's own account-quota error type.
  ["insufficient_quota", "openai_insufficient_quota"],
  ["quota_exceeded", "provider_quota_exceeded"],
  ["usage_limit_reached", "provider_usage_limit_reached"],
  // OpenAI's billing hard limit: the account stops serving requests entirely.
  ["billing_hard_limit_reached", "openai_billing_hard_limit"],
  ["billing_not_active", "openai_billing_not_active"],
  ["credit_exhausted", "provider_credit_exhausted"],
  ["plan_exhausted", "provider_plan_exhausted"],
  // LiteLLM's normalized name for MiniMax's token-plan exhaustion.
  ["token_plan_usage_limit_reached", LITELLM_MINIMAX_TOKEN_PLAN],
]);

const MODEL_TOKENS: ReadonlyMap<string, string> = new Map([
  ["model_not_found", "provider_model_not_found"],
  ["model_deprecated", "provider_model_deprecated"],
  ["model_retired", "provider_model_retired"],
  ["model_unavailable", "provider_model_unavailable"],
  ["model_removed", "provider_model_removed"],
  ["deprecated_model", "provider_model_deprecated"],
  ["unknown_model", "provider_unknown_model"],
  // Azure OpenAI's deployment-not-found code: the named deployment (and every
  // request addressed to it) is gone, not slow.
  ["deploymentnotfound", "provider_model_not_found"],
]);

/**
 * Decisive phrases: case-insensitive allowlisted literal substrings. The list
 * is intentionally tight — each entry is a phrase a provider emits ONLY for a
 * permanent condition, with its rationale inline. Adding a phrase is how this
 * class grows; broadening a match (regex, fuzzy, "the body mentions quota")
 * is how this class would start cancelling real retries.
 */
const QUOTA_PHRASES: ReadonlyArray<readonly [phrase: string, signature: string]> = [
  // MiniMax/LiteLLM's token-plan exhaustion (reported alongside provider code
  // 2056): the plan's period allowance is spent, so the next period — not the
  // next attempt — recovers. The CODE is deliberately not evidence on its own
  // (a bare `2056` in any body is just an unrelated number); these sentences
  // are the decisive part.
  ["token plan usage limit reached", LITELLM_MINIMAX_TOKEN_PLAN],
  // The same body's remediation sentence: the plan must be upgraded or bought.
  ["upgrade your token plan or purchase credits", LITELLM_MINIMAX_TOKEN_PLAN],
  // OpenAI's account-quota exhaustion sentence (distinct from its
  // per-minute rate-limit prose, which the transient veto refuses anyway).
  ["you exceeded your current quota", "openai_quota_exceeded"],
  // OpenAI's billing hard-limit sentence: serving stops until billing changes.
  ["billing hard limit has been reached", "openai_billing_hard_limit"],
  ["insufficient quota", "openai_insufficient_quota"],
  // A pre-paid balance at zero: topping up, not waiting, is the fix.
  ["insufficient balance", "provider_insufficient_balance"],
  ["insufficient credit", "provider_insufficient_credit"],
];

const MODEL_PHRASES: ReadonlyArray<readonly [phrase: string, signature: string]> = [
  // Provider retirement notice ("The model `x` has been retired").
  ["has been retired", "provider_model_retired"],
  // Anthropic/OpenAI deprecation notice: the id will stop being served. Both
  // tenses appear in the wild ("has been deprecated", "is deprecated").
  ["has been deprecated", "provider_model_deprecated"],
  ["is deprecated and will be removed", "provider_model_deprecated"],
  ["model not found", "provider_model_not_found"],
  // Anthropic's combined "wrong model OR no entitlement" sentence.
  ["does not exist or you do not have access", "provider_model_not_found"],
  ["you do not have access to model", "provider_model_not_found"],
  ["no access to this model", "provider_model_not_found"],
  ["unknown model", "provider_unknown_model"],
];

/**
 * Transient markers. Their presence in the SAME matched text vetoes a phrase
 * match: the provider is describing a short-window condition (busy, cooling
 * down, per-minute limits, retry-later advice), which is exactly what the
 * retry budget is for.
 *
 * `retry` is deliberately NOT a bare marker. Providers state the permanent
 * condition while telling the caller not to retry ("Token Plan usage limit
 * reached. Do not retry; upgrade your token plan"), and a bare substring match
 * would veto exactly the evidence this module exists to recognize. Only the
 * forward-looking forms — advice to come BACK later — mean transient.
 */
const TRANSIENT_MARKERS: readonly string[] = [
  "temporar",
  "try again",
  "retry after",
  "retry later",
  "retry in",
  "busy",
  "loading",
  "warming",
  "overloaded",
  "high demand",
  "queue",
  "capacity",
  "cooling down",
  "rate limit",
  "too many requests",
  "resource_exhausted",
  "requests per",
  "slow down",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Lowercase, trim, and cap a provider-supplied scalar. */
function normalizeScalar(value: string | number): string {
  const text = typeof value === "number" ? String(value) : value;
  return text.trim().toLowerCase().slice(0, MAX_TOKEN_CHARS);
}

/** The first 64 KiB of a body, never more. A multi-byte character split by the
 * byte cut degrades to a replacement character rather than throwing. */
function boundedText(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_SCAN_BYTES) return body;
  return Buffer.from(body, "utf8").subarray(0, MAX_SCAN_BYTES).toString("utf8").replace(/\uFFFD$/, "");
}

function parseJson(bounded: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bounded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Plain-text (or truncated) body: phrase-matched as text below.
    return null;
  }
}

function containsTransientMarker(text: string): boolean {
  const haystack = text.toLowerCase();
  return TRANSIENT_MARKERS.some((marker) => haystack.includes(marker));
}

interface PhraseMatch {
  reason: TerminalProviderReason;
  signature: string;
  phrase: string;
}

/** First decisive phrase in `text`, or null — including null when a transient
 * marker vetoes the match. */
function matchPhrase(text: string): PhraseMatch | null {
  if (containsTransientMarker(text)) return null;
  const haystack = text.toLowerCase();
  for (const [phrase, signature] of QUOTA_PHRASES) {
    if (haystack.includes(phrase)) return { reason: "quota_exhausted", signature, phrase };
  }
  for (const [phrase, signature] of MODEL_PHRASES) {
    if (haystack.includes(phrase)) return { reason: "model_unavailable", signature, phrase };
  }
  return null;
}

function terminal(reason: TerminalProviderReason, signature: string, failure: TransportFailure): TerminalProviderFailure {
  return {
    reason,
    signature,
    ...(failure.status !== undefined ? { httpStatus: failure.status } : {}),
  };
}

/**
 * The single shared authority: does this transport failure end the lane now,
 * or is it another attempt's problem? Returns null for every failure that
 * carries no provider evidence (network, connect/request timeout, oversize,
 * an empty body) and for every body whose evidence is absent, ambiguous, or
 * transient.
 */
export function classifyTerminalProviderFailure(failure: TransportFailure): TerminalProviderFailure | null {
  if (failure.kind !== "http_status") return null;
  const body = failure.body;
  if (body === undefined || body === "") return null;

  const bounded = boundedText(body);
  const record = parseJson(bounded);

  // 1. Structured tokens: exact, allowlisted, decisive — never vetoed.
  if (record !== null) {
    for (const path of TOKEN_PATHS) {
      const value = readPath(record, path);
      if (typeof value !== "string" && typeof value !== "number") continue;
      const token = normalizeScalar(value);
      const quota = QUOTA_TOKENS.get(token);
      if (quota !== undefined) return terminal("quota_exhausted", quota, failure);
      const model = MODEL_TOKENS.get(token);
      if (model !== undefined) return terminal("model_unavailable", model, failure);
    }
  }

  // 2. Phrase evidence: 4xx only, and vetoable. A 5xx body is server-side text
  // a gateway or proxy composes — frequently by echoing request content back
  // (an upstream error surfaced through a passthrough, or a validation error
  // that quotes the caller's payload) — so PR-controlled text could otherwise
  // flip a deterministic failover decision and cancel a retry budget that
  // exists precisely for 5xx (#1006). Structured exact-token evidence above is
  // unaffected: a provider must CONSTRUCT `insufficient_quota` to send it,
  // and PR content cannot. For a non-JSON body the phrase is matched against
  // the bounded body text itself.
  const status = failure.status;
  if (status !== undefined && status >= 500) return null;
  const texts: string[] = [];
  if (record === null) {
    texts.push(bounded);
  } else {
    for (const path of MESSAGE_PATHS) {
      const value = readPath(record, path);
      if (typeof value === "string" && value !== "") texts.push(value);
    }
    // `{"error": "model not found"}`: the message sits directly in `error`.
    for (const path of STRING_ERROR_PATHS) {
      const value = readPath(record, path);
      if (typeof value === "string" && value !== "") texts.push(value);
    }
  }

  for (const text of texts) {
    const match = matchPhrase(text);
    // A phrase is decisive only on its own terms — there is no bare-code path
    // that can promote an unrecognized body to terminal.
    if (match !== null) return terminal(match.reason, match.signature, failure);
  }
  return null;
}

/**
 * The canonical bounded, secret-redacted log line for a terminal stop.
 * Built only from this module's own enums and allowlisted signatures, so it
 * cannot carry provider prose; the mask is belt-and-braces for a configured
 * secret that happens to spell part of a lane's static text.
 */
export function terminalProviderFailureLine(
  terminalFailure: TerminalProviderFailure,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  const status = terminalFailure.httpStatus !== undefined ? ` HTTP ${terminalFailure.httpStatus}` : "";
  return maskKnownSecrets(`terminal provider failure: ${terminalFailure.reason} (${terminalFailure.signature})${status}`, secrets);
}

/**
 * Per-process lane latch (#1080): once a lane (endpoint + model + wire format)
 * has answered terminally, every later call on the SAME lane is known to fail
 * the same way, so the specialist adapter short-circuits it with zero wire
 * attempts instead of repeating the request. One process is one run, so one
 * module-scoped instance is the whole scope — and a fallback lane has its own
 * key (different endpoint/model), so it is never short-circuited by the
 * primary's failure.
 */
export interface TerminalLaneLatch {
  terminalFor(lane: string): TerminalProviderReason | undefined;
  latch(lane: string, reason: TerminalProviderReason): void;
}

const latchedLanes = new Map<string, TerminalProviderReason>();

const sharedLatch: TerminalLaneLatch = {
  terminalFor: (lane) => latchedLanes.get(lane),
  latch: (lane, reason) => {
    latchedLanes.set(lane, reason);
  },
};

export function sharedTerminalLaneLatch(): TerminalLaneLatch {
  return sharedLatch;
}

/** Test-only: clear the process-scoped latch between cases. */
export function resetSharedTerminalLaneLatch(): void {
  latchedLanes.clear();
}