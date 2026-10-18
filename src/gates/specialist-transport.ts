import { createHash } from "node:crypto";
import { maskKnownSecrets, redactText } from "../context/redact.js";
import type { ApiFormat, NormalizedModelResponse, TransportWirePayload } from "../model/types.js";
import type { SpecialistRequestFn, SpecialistTransportOutcome } from "../specialists/runner.js";
import { describeTransportFailure, TransportFailure } from "../transport/http.js";
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

function codePointSlice(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** The v2 SSE reassembler's result shape for a streamed turn. */
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
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
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
 * #1080: a lane's credential IDENTITY, for the terminal-lane key only — a
 * truncated SHA-256 of the configured API key. The digest is not reversible
 * into the key and never leaves this module, so it cannot become a secret
 * carrier in a log line or an artifact; an empty key yields a fixed
 * `unauthenticated` marker so a keyless lane still keys consistently.
 */
function credentialIdentity(apiKey: string): string {
  return apiKey === "" ? "unauthenticated" : createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
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
    // none; the credential enters as a truncated SHA-256 digest, never the key
    // itself, so a second key on the SAME endpoint and model stays a distinct
    // lane — quota exhaustion is an ACCOUNT condition, so a differently
    // credentialed lane may well recover and must not inherit the latch. A
    // terminal answer for this tuple is permanent by definition, so no wire
    // attempt is spent on it at all.
    const laneModel = typeof payload.model === "string" ? payload.model : "";
    const laneKey = `${config.baseUrl}\n${laneModel}\n${format}\n${credentialIdentity(config.apiKey)}`;
    const latched = latch.terminalFor(laneKey);
    if (latched !== undefined) {
      return { ok: false, errorMessage: `lane terminally unavailable (${latched})`, terminal: latched };
    }
    let outcome: ChatRequestOutcome;
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
      });
    } catch (error) {
      // #1080: a throwing adapter can still hand back a typed transport
      // failure; classify and latch it exactly like the returned one.
      if (error instanceof TransportFailure) {
        const terminal = classifyTerminalProviderFailure(error);
        if (terminal !== null) {
          latch.latch(laneKey, terminal.reason);
          return { ok: false, errorMessage: `lane terminally unavailable (${terminal.reason})`, terminal: terminal.reason };
        }
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const masked = codePointSlice(redactText(maskKnownSecrets(rawMessage, [config.apiKey, ...extraSecrets])), 500);
      return { ok: false, errorMessage: masked, timeout: masked.toLowerCase().includes("timed out") };
    }
    if (outcome.status === "ok") {
      const raw = payload.stream === true ? toV2Completion(outcome.response) : outcome.raw;
      return { ok: true, raw };
    }
    // #1080: latch FIRST so the classification is recorded even if the
    // masking below throws on a pathological body, then report the reason
    // alongside the existing (unchanged) timeout/status/statusDetail shape.
    const terminal = classifyTerminalProviderFailure(outcome.failure);
    if (terminal !== null) latch.latch(laneKey, terminal.reason);
    const { message, timeout, status, statusDetail } = failureMessage(outcome, config.apiKey, extraSecrets);
    const masked = codePointSlice(redactText(maskKnownSecrets(message, [config.apiKey, ...extraSecrets])), 500);
    return {
      ok: false,
      errorMessage: masked,
      timeout: timeout || masked.toLowerCase().includes("timed out"),
      ...(status !== undefined ? { status } : {}),
      ...(statusDetail !== undefined ? { statusDetail } : {}),
      ...(terminal !== null ? { terminal: terminal.reason } : {}),
    };
  };
}
