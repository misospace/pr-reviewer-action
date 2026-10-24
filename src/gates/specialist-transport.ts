import { maskKnownSecrets, redactText } from "../context/redact.js";
import type { ApiFormat, NormalizedModelResponse, TransportWirePayload } from "../model/types.js";
import type { SpecialistDiscardedWireAttempt, SpecialistRequestFn, SpecialistTransportOutcome } from "../specialists/runner.js";
import { describeTransportFailure, resolveEndpoint, TransportFailure } from "../transport/http.js";
import { applyExtraHeaders } from "../transport/headers.js";
import { runChatRequest, type ChatRequestInput, type ChatRequestOutcome } from "../transport/transport.js";
import { classifyTerminalProviderFailure, sharedTerminalLaneLatch, type TerminalLaneLatch, type TerminalProviderReason } from "../transport/terminal.js";

/**
 * Specialist transport adapter (#706 PR 6): `SpecialistRequestFn` over the v3
 * model transport (`runChatRequest`), standing in for v2's
 * `pr_reviewer.transport.run_chat_request` as `scripts/run_specialists.py`
 * uses it.
 *
 * - Streamed turns come back from `reassembleSse` in the flattened v3 shape;
 *   they are re-emitted in the v2 reassembler's OpenAI-style completion
 *   shape so `specialist-<role>.response.json` keeps its v2 bytes.
 * - Failures carry v2's message text (`planner model request failed with
 *   HTTP <status>: <redacted body>`), redacted and capped at 500 characters
 *   like the runner's `str(redact_text(str(exc)))[:500]`; a connect/request
 *   timeout, or any message containing "timed out", is a timeout (never
 *   retried by the runner).
 * - The API key only ever reaches the transport's request headers; it is
 *   never part of a payload, an outcome, or a message.
 * - #1080: a TERMINAL provider failure (quota exhausted, model retired) is
 *   reported with a normalized `terminal` reason and latched per lane, so the
 *   runner spends no retry on it and every LATER call on that same
 *   endpoint/model/format lane short-circuits with zero wire attempts. The
 *   classification result is an allowlisted enum + signature id — never body
 *   prose — so the key/extra-header masking below stays the only thing that
 *   keeps provider text out of the returned message and status detail.
 */

export interface SpecialistTransportConfig {
  baseUrl: string;
  apiKey: string;
  anthropicVersion: string;
  /** #1037 (`ai-extra-headers`): operator correlation headers merged into
   * every specialist request; empty/absent merges nothing. */
  extraHeaders?: Readonly<Record<string, string>>;
  /** Test seam: replaces the HTTP transport. */
  runChat?: (input: ChatRequestInput) => Promise<ChatRequestOutcome>;
  sleep?: (ms: number) => Promise<void>;
  /** #1080: the per-process terminal-lane latch. Defaults to the shared
   * module-scoped instance (one process = one run); a test injects its own. */
  terminalLatch?: TerminalLaneLatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePointSlice(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** The v2 SSE reassembler's result shape for a streamed turn.
 * #1235 mirrors the #1207 clamp: a negative provider-reported count is
 * malformed input, not a measurement, and this shape has no "not reported"
 * slot (a missing usage already projects as 0), so it projects as 0 — the
 * fold's contribution for a malformed field is 0 either way. */
function usageCount(value: number): number {
  return value > 0 ? value : 0;
}

/** The same bounded depth the masking walker in `src/context/redact.ts`
 * uses for the same class of JSON-shaped provider body (`MAX_MASK_DEPTH`,
 * kept a module-private detail there; a local mirror costs a pointed
 * comment, not a widened export). */
const MAX_USAGE_PRUNE_DEPTH = 32;

function pruneNegativeUsageCounts(
  node: unknown,
  depth: number,
): { changed: boolean; value: unknown } {
  if (!isRecord(node)) return { changed: false, value: node };
  if (depth >= MAX_USAGE_PRUNE_DEPTH) {
    // #252 fail-closed, same shape as the masking walker's cutoff: a branch
    // deeper than this walker masters cannot be verified to carry no
    // negative count, so it is never published the way it arrived — `null`
    // is "not reported" for every accounting reader probing its keys
    // (`isRecord(null)` is always false).
    return { changed: true, value: null };
  }
  let changed = false;
  const value = Object.fromEntries(
    Object.entries(node).flatMap(([key, item]): [string, unknown][] => {
      if (typeof item === "number" && Number.isFinite(item) && (item < 0 || Object.is(item, -0))) {
        // A negative count is removed (the body's own "not reported"); a
        // `-0` count normalizes to a reported exactly-`0` one. Both mark
        // changed without carrying the malformed shape onward.
        changed = true;
        return Object.is(item, -0) ? [[key, 0]] : [];
      }
      const nested = pruneNegativeUsageCounts(item, depth + 1);
      if (nested.changed) changed = true;
      return [[key, nested.value]];
    }),
  );
  return { changed, value: changed ? value : node };
}

/** #1235 (review): the non-streamed ok path hands the genuine provider wire
 * body forward, and the runner persists it behind per-leaf string masking
 * that keeps structure intact — so a negative provider-reported count would
 * ride `specialist-<role>.response.json` verbatim: the one publication
 * surface the streamed projection (`usageCount`) covered but this path had
 * not. The same #1207 decision applies: the count is malformed input, not a
 * measurement. The offending field is removed — the body's own "not
 * reported"; every accounting reader (`extractResponseUsage` and its
 * presence-based fallbacks) treats an absent count as null exactly the way
 * the clamp would — and a `-0` count normalizes to exactly `0`. The sweep is
 * bounded to the top-level `usage` record, including its nested details
 * records, and never the rest of the body: legitimate negative numbers exist
 * elsewhere (e.g. `logprobs`) and no accounting surface outside `usage` is
 * read. A body with nothing malformed returns unchanged (same reference), so
 * provider bodies that carry no malformed usage numbers keep their identical
 * identity and bytes end to end. The rebuild never assigns `out[key] = …`:
 * `Object.fromEntries` only (CreateDataPropertyOrThrow), so a hostile own
 * `__proto__` key from JSON.parse defines a data property and cannot invoke
 * the prototype setter into a forged accounting record — the #252 boundary
 * the masking walker wrote the same norm for. */
function withoutNegativeUsage(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const usage = raw.usage;
  if (!isRecord(usage)) return raw;
  const pruned = pruneNegativeUsageCounts(usage, 0);
  return pruned.changed ? { ...raw, usage: pruned.value } : raw;
}

export function toV2Completion(response: NormalizedModelResponse): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: response.content };
  if (response.toolCalls.length > 0) message.tool_calls = response.toolCalls;
  const usage = response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const result: Record<string, unknown> = {
    id: response.id,
    object: "chat.completion",
    model: response.model,
    choices: [{ index: 0, message, finish_reason: response.finishReason }],
    usage: {
      prompt_tokens: usageCount(usage.promptTokens),
      completion_tokens: usageCount(usage.completionTokens),
      total_tokens: usageCount(usage.totalTokens),
    },
  };
  if (response.error !== undefined && response.error !== null) result.error = response.error;
  return result;
}

function failureMessage(
  outcome: Extract<ChatRequestOutcome, { status: "failure" }>,
  apiKey: string,
  extraSecrets: readonly string[],
): { message: string; timeout: boolean; status?: number; statusDetail?: string } {
  const failure = outcome.failure;
  if (failure.kind === "connect_timeout" || failure.kind === "request_timeout") {
    return { message: "planner model request timed out", timeout: true };
  }
  if (failure.kind === "http_status" && failure.status !== undefined) {
    // #846: `statusDetail` is the clean "HTTP <status>: <excerpt>[ — hint]"
    // form, carried separately for log lines/telemetry; `message` keeps the
    // v2-parity "planner model request failed with ..." phrasing used in
    // the persisted artifact errors. `secrets` masks the specialist call's
    // configured key unconditionally, on top of `redactText`'s heuristics —
    // a provider echoing the bare key in prose would otherwise pass every
    // heuristic pattern untouched. #1037: the configured extra-header VALUES
    // ride the same list (a provider error body can quote them back).
    const statusDetail = describeTransportFailure(failure, { maxBodyChars: 300, secrets: [apiKey, ...extraSecrets] });
    return { message: `planner model request failed with ${statusDetail}`, timeout: false, status: failure.status, statusDetail };
  }
  return { message: failure.message, timeout: false };
}

/**
 * #1080: a lane's credential IDENTITY, for the terminal-lane key only — an
 * opaque per-process slot label interned from the configured API key. The
 * key itself never enters the lane string, so the lane cannot become a
 * secret carrier in a log line or an artifact; distinct configured keys
 * always intern to distinct slots (no digest means no collision budget to
 * reason about), and an empty key yields a fixed `unauthenticated` marker
 * so a keyless lane still keys consistently.
 */
const credentialSlots = new Map<string, string>();
let nextCredentialSlot = 0;
// Deliberately never cleared: a cleared registry would re-intern the same
// key to a NEW slot while a live latch still remembers the old one, silently
// re-opening a terminally-latched lane. Growth is bounded by the distinct
// keys a run configures (a handful), so a lifetime hold costs nothing.

function credentialIdentity(apiKey: string): string {
  // Deliberately NOT a hash or HMAC: the latch is per-process, so a
  // credential's identity here is plain string equality, and interning
  // captures that exactly — a digest would only add collision reasoning,
  // per-request cost, and (as CWE-916 tooling correctly insists) the shape
  // of a low-effort password hash, which this is not. The registry is
  // module-private: entries are created here and never enumerated, logged,
  // or serialized anywhere.
  if (apiKey === "") return "unauthenticated";
  const interned = credentialSlots.get(apiKey);
  if (interned !== undefined) return interned;
  const slot = `key-${++nextCredentialSlot}`;
  credentialSlots.set(apiKey, slot);
  return slot;
}

export function specialistRequestFn(config: SpecialistTransportConfig): SpecialistRequestFn {
  const runChat = config.runChat ?? runChatRequest;
  const latch = config.terminalLatch ?? sharedTerminalLaneLatch();
  return async (payload, apiFormat, timeoutSec): Promise<SpecialistTransportOutcome> => {
    const format: ApiFormat = apiFormat === "anthropic" ? "anthropic" : "openai";
const wire = {
      endpointPath: format === "anthropic" ? "/messages" : "/chat/completions",
      body: payload,
    } as unknown as TransportWirePayload;
    // #1037: the configured extra-header VALUES are known secrets for every
    // diagnostic this lane emits (they carry proxy tokens and a provider
    // error body can quote them back); unset config adds nothing.
    const extraSecrets = Object.values(config.extraHeaders ?? {});
    // #1080: one lane key per (endpoint, model, wire format, credential) tuple.
    // The model comes off the wire payload and is "" when the payload carries
    // none; the credential enters only as its opaque interned slot label, never
    // the key itself, so a second key on the SAME endpoint and model stays a distinct
    // lane — quota exhaustion is an ACCOUNT condition, so a differently
    // credentialed lane may well recover and must not inherit the latch. A
    // terminal answer for this tuple is permanent by definition, so no wire
    // attempt is spent on it at all.
    const laneModel = typeof payload.model === "string" ? payload.model : "";
    const laneKey = `${config.baseUrl}\n${laneModel}\n${format}\n${credentialIdentity(config.apiKey)}`;
    const latched = latch.terminalFor(laneKey);
    if (latched !== undefined) {
      // #1200: this call never reaches the wire — the lane is known to be
      // terminally unavailable — so it is NOT a provider attempt: the
      // specialist telemetry opens no attempt record for it and the aggregate
      // request counter does not count it.
      return { ok: false, errorMessage: `lane terminally unavailable (${latched})`, terminal: latched, wire_attempted: false };
    }
    // #1200: the endpoint join and the extra-header merge are refused BEFORE
    // any socket opens, so such a call is not a provider attempt either. Both
    // fences are the transport's OWN (the same `resolveEndpoint` and the same
    // `applyExtraHeaders` assertion the wire boundary uses), so this cannot
    // drift from what the transport would have thrown. The failure text is
    // the one the transport itself would have produced — masked and capped
    // exactly as the catch-all below masks a thrown adapter error — so the
    // persisted failure shape is unchanged.
    try {
      resolveEndpoint(config.baseUrl, format);
      if (config.extraHeaders !== undefined) applyExtraHeaders({}, config.extraHeaders);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const masked = codePointSlice(redactText(maskKnownSecrets(rawMessage, [config.apiKey, ...extraSecrets])), 500);
      return { ok: false, errorMessage: masked, wire_attempted: false };
    }
    let outcome: ChatRequestOutcome;
    // #1200: the transport's own same-request retry loop (retryable 429/5xx
    // statuses, the #824 max_tokens clamp, the #1047 structured-output strip)
    // makes SEVERAL actual wire attempts inside this one call. Its per-call
    // decision reports are collected here and carried on the outcome, so a
    // discarded wire attempt is a real, recorded provider attempt exactly
    // once — never hidden inside the single outer call the runner sees.
    const discardedWireAttempts: SpecialistDiscardedWireAttempt[] = [];
    let wireSentMaxTokens: number | null = null;
    let wireReported = false;
    const wireTelemetry = (base: SpecialistTransportOutcome): SpecialistTransportOutcome =>
      wireReported
        ? {
            ...base,
            ...(discardedWireAttempts.length > 0 ? { discarded_wire_attempts: discardedWireAttempts } : {}),
            wire_sent_max_tokens: wireSentMaxTokens,
          }
        : base;
    try {
      outcome = await runChat({
        baseUrl: config.baseUrl,
        apiFormat: format,
        payload: wire,
        apiKey: config.apiKey,
        anthropicVersion: config.anthropicVersion,
        requestTimeoutSec: timeoutSec,
        // curl --max-time bounds the whole attempt in v2, connect included.
        connectTimeoutSec: timeoutSec,
        ...(config.extraHeaders !== undefined ? { extraHeaders: config.extraHeaders } : {}),
        ...(config.sleep !== undefined ? { sleep: config.sleep } : {}),
        onWireCall: (report) => {
          wireReported = true;
          if (report.discarded) {
            discardedWireAttempts.push({ elapsed_sec: report.elapsedSec, max_tokens: report.maxTokens });
          }
          wireSentMaxTokens = report.maxTokens;
        },
      });
    } catch (error) {
      // #1080: a throwing adapter can still hand back a typed transport
      // failure; classify and latch it exactly like the returned one.
      if (error instanceof TransportFailure) {
        const terminal = classifyTerminalProviderFailure(error);
        if (terminal !== null) {
          latch.latch(laneKey, terminal.reason);
          return wireTelemetry({ ok: false, errorMessage: `lane terminally unavailable (${terminal.reason})`, terminal: terminal.reason });
        }
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const masked = codePointSlice(redactText(maskKnownSecrets(rawMessage, [config.apiKey, ...extraSecrets])), 500);
      return wireTelemetry({ ok: false, errorMessage: masked, timeout: masked.toLowerCase().includes("timed out") });
    }
    if (outcome.status === "ok") {
      // #1235: the streamed projection clamps in `toV2Completion`; the
      // non-streamed genuine body clamps its top-level usage record here, so
      // either way the body that reaches the runner — and the persisted
      // artifact — publishes no negative provider-reported count.
      const raw = payload.stream === true ? toV2Completion(outcome.response) : withoutNegativeUsage(outcome.raw);
      return wireTelemetry({ ok: true, raw });
    }
    // #1080: latch FIRST so the classification is recorded even if the
    // masking below throws on a pathological body, then report the reason
    // alongside the existing (unchanged) timeout/status/statusDetail shape.
    const terminal = classifyTerminalProviderFailure(outcome.failure);
    if (terminal !== null) latch.latch(laneKey, terminal.reason);
    const { message, timeout, status, statusDetail } = failureMessage(outcome, config.apiKey, extraSecrets);
    const masked = codePointSlice(redactText(maskKnownSecrets(message, [config.apiKey, ...extraSecrets])), 500);
    return wireTelemetry({
      ok: false,
      errorMessage: masked,
      timeout: timeout || masked.toLowerCase().includes("timed out"),
      ...(status !== undefined ? { status } : {}),
      ...(statusDetail !== undefined ? { statusDetail } : {}),
      ...(terminal !== null ? { terminal: terminal.reason } : {}),
    });
  };
}
