/** One-shot answer execution (#1294): runs a bounded follow-up prompt
 * through the SAME model/transport path the review uses — `buildModelRequest`
 * + `runChatRequestOnce` — with the verdict surface OFF (no response format,
 * no corpus, no verdict parsing). It is the confidence scorer's wire pattern
 * (#1073) reused for the conversation lane: a follow-up answer is free text,
 * and nothing here can produce or mutate a verdict.
 *
 * Credentials travel only in the typed transport's auth headers on the
 * origin-bound request (never argv, URL, or body); a failure of any kind
 * degrades to "" so the consumer fails closed (no post) instead of throwing.
 */

import { buildModelRequest } from "../model/request.js";
import type { ApiFormat, TransportWirePayload } from "../model/types.js";
import { runChatRequestOnce, type ChatRequestInput, type ChatRequestOutcome } from "../transport/transport.js";

/** Output bound for a follow-up answer: the prompt instructs concision, and
 * the consumer byte-caps the result anyway; this only stops a runaway
 * completion from streaming forever. */
export const FOLLOWUP_ANSWER_MAX_TOKENS = 2048;

/** The trusted one-line role statement sent as the system message. The
 * detailed instruction (discussion-not-verdict, untrusted-data boundary)
 * lives in the prompt itself; this header keeps the system turn non-empty
 * on both wire formats without ever quoting untrusted content. */
const ANSWER_SYSTEM =
  "You are the AI pull-request reviewer answering one follow-up question in a PR conversation. Reply with the answer text only.";

/** The transport lane an answer runs on — a projection of the operator's
 * primary profile (or any explicitly chosen lane); the caller resolves it,
 * the executor never reads env. */
export interface FollowUpAnswerProfile {
  baseUrl: string;
  model: string;
  apiFormat: ApiFormat;
  apiKey: string;
  reasoningEffort: string;
  anthropicEffortSupported: boolean;
  requestTimeoutSec: number;
  connectTimeoutSec: number;
}

export interface FollowUpExecutorOptions {
  /** Transport seam override for tests; defaults to the real one-shot call
   * (no retry loop: a follow-up answer is cheap to skip, and the next
   * mention re-runs the gate honestly). */
  transport?: (input: ChatRequestInput) => Promise<ChatRequestOutcome>;
  /** Injectable for tests that assert the exact wire payload. */
  onPayload?: (payload: TransportWirePayload) => void;
}

/** Build the answer runner for one profile. An empty model (nothing
 * configured) never calls the transport at all and returns "". */
export function createFollowUpAnswerExecutor(
  profile: FollowUpAnswerProfile,
  options: FollowUpExecutorOptions = {},
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    if (profile.model === "") return "";
    const payload = buildModelRequest({
      apiFormat: profile.apiFormat,
      model: profile.model,
      system: ANSWER_SYSTEM,
      user: prompt,
      // Single bounded payload; no review corpus on the conversation lane.
      corpus: "",
      stream: false,
      shape: "default",
      maxTokens: FOLLOWUP_ANSWER_MAX_TOKENS,
      temperature: "",
      // The verdict schema is OFF by construction — an answer never parses
      // as, or becomes, a verdict.
      responseFormat: "off",
      tokensParam: "max_tokens",
      reasoningEffort: profile.reasoningEffort,
      // The conversation lane asserts no Anthropic-only capability: no
      // effort or structured-output key is ever sent on its wire.
      anthropicEffortSupported: false,
      anthropicStructuredOutputSupported: false,
    });
    options.onPayload?.(payload);
    const call = options.transport ?? runChatRequestOnce;
    try {
      const outcome = await call({
        baseUrl: profile.baseUrl,
        apiFormat: profile.apiFormat,
        payload,
        apiKey: profile.apiKey,
        anthropicVersion: "2023-06-01",
        requestTimeoutSec: profile.requestTimeoutSec,
        connectTimeoutSec: profile.connectTimeoutSec,
      });
      return outcome.status === "ok" ? outcome.response.content : "";
    } catch {
      return "";
    }
  };
}
