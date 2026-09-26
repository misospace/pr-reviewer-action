export type ApiFormat = "openai" | "anthropic";
export type RequestShape = "default" | "trailing_task";
export type ResponseFormatMode = "off" | "json_object" | "json_schema";
export type TokensParam = "max_tokens" | "max_completion_tokens";
export type VerdictValue = "approve" | "request_changes";

/**
 * Contract 1: model request config. Everything the request builder needs,
 * resolved from the typed action config. No provider or model names here:
 * capabilities come from config (`apiFormat`, `responseFormat`, `tokensParam`).
 */
export interface ModelRequestConfig {
  apiFormat: ApiFormat;
  model: string;
  system: string;
  user: string;
  corpus: string;
  stream: boolean;
  shape: RequestShape;
  maxTokens: number;
  /** Empty string means "omit the temperature field entirely" (v2 semantics). */
  temperature: number | "";
  /** OpenAI-compatible only; Anthropic never sends a response_format. */
  responseFormat: ResponseFormatMode;
  /** OpenAI-compatible token-limit field name. */
  tokensParam: TokensParam;
}

/**
 * Contract 2: transport wire payload. Protocol-specific field names stay
 * protocol-native (snake_case where the wire format uses it); secrets never
 * appear here — auth headers are the transport's job.
 */
export interface TransportWirePayload {
  endpointPath: "/chat/completions" | "/messages";
  body: OpenAiWireBody | AnthropicWireBody;
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface OpenAiWireBody {
  model: string;
  stream: boolean;
  messages: OpenAiMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  response_format?: Record<string, unknown>;
  stream_options?: { include_usage: boolean };
}

export interface AnthropicWireBody {
  model: string;
  max_tokens: number;
  stream: boolean;
  system: string;
  messages: [{ role: "user"; content: string }];
  temperature?: number;
}

export interface NormalizedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Contract 3: normalized model response — one shape regardless of provider,
 * streaming, or error source. Mirrors the v2 SSE reassembler's normalized
 * OpenAI-style output.
 */
export interface NormalizedModelResponse {
  id: string;
  object: "chat.completion";
  model: string;
  content: string;
  toolCalls: NormalizedToolCall[];
  finishReason: string;
  usage: NormalizedUsage | null;
  error: unknown;
}

export interface NormalizedFinding {
  severity: "blocker" | "major" | "minor" | "info";
  category: string;
  file: string | null;
  line: number | null;
  message: string;
  preliminaryFinding?: number;
}

/**
 * #750: the three structured dispositions a reviewer may record for a
 * deterministic `must_check` item. A required check is a mandatory review
 * QUESTION, not automatically an implementation requirement: `not_applicable`
 * is a completed disposition when the reviewer can ground it in the actual
 * change context.
 */
export type RequiredCheckStatus = "satisfied" | "not_applicable" | "unresolved";

export interface NormalizedRequiredCheckDisposition {
  /** The check text as the model echoed it (sanitized, bounded). */
  check: string;
  /**
   * One of the three reviewer dispositions, or the internal-only
   * `"invalid"` marker: the model attributed an answer to this check but
   * the answer was unusable (unknown status alias, ungrounded
   * not_applicable). The coverage evaluation treats it as
   * malformed and leaves the check unresolved; it is never a valid
   * disposition and never appears in the wire schema.
   */
  status: RequiredCheckStatus | "invalid";
  /** Bounded control-char-free rationale; null when absent/empty. */
  rationale: string | null;
}

/**
 * Contract 4: parsed review verdict. `extra` carries every additional key the
 * model produced (v2 passes them through to ai-output.json untouched).
 *
 * `smartReviewRequested` / `smartReviewReason` (#721) are the reviewer's
 * structured request for a smart-tier second pass, normalized by the parser:
 * requested is true only for the JSON boolean `true`, and the reason is a
 * bounded single-line string (or null). PR-controlled prose cannot forge the
 * request — the fields are read from the parsed verdict object, never from
 * review markdown.
 */
/** #766: one per unresolved review thread the corpus listed. `invalid`
 * marks an attributable entry whose disposition word was not recognized;
 * the v2 enforcement pass treats it as missing. */
export interface NormalizedThreadDisposition {
  threadId: string;
  disposition: "fixed" | "open" | "disputed" | "invalid";
  evidence: string | null;
}

export interface ParsedReviewVerdict {
  verdict: VerdictValue;
  reviewMarkdown: string;
  findings: NormalizedFinding[];
  requirementCoverage: unknown;
  /**
   * #750: structured dispositions for the deterministic must_check items —
   * the normalized array when the model emitted a usable one, null when the
   * key was present but carried no usable array. Tri-state with
   * `requiredCheckDispositionsEmitted`: only true key absence may use the
   * legacy coexistence path; an explicitly emitted null/malformed value
   * fails conservatively as structured-incomplete.
   */
  requiredCheckDispositions: NormalizedRequiredCheckDisposition[] | null;
  /** True iff the model emitted the `required_check_dispositions` key at all. */
  requiredCheckDispositionsEmitted: boolean;
  /** #766: same tri-state as the required-check dispositions. */
  threadDispositions: NormalizedThreadDisposition[] | null;
  threadDispositionsEmitted: boolean;
  smartReviewRequested: boolean;
  /** Bounded single-line reason; null when no request (or no usable reason). */
  smartReviewReason: string | null;
  extra: Record<string, unknown>;
}

/** Why a response could not be turned into a valid review verdict. */
export type VerdictParseErrorKind =
  | "endpoint_error"
  | "not_object"
  | "missing_verdict_key"
  | "missing_review_markdown_key"
  | "invalid_verdict"
  | "empty_markdown"
  | "flattened_markdown"
  | "empty_completion";

export class VerdictParseFailure extends Error {
  readonly kind: VerdictParseErrorKind;
  /** True when the model's finish/stop reason indicates a token-cap cut. */
  readonly truncated: boolean;
  /** v2 EMPTY_COMPLETION_EXIT: callers must not burn the retry budget. */
  readonly emptyCompletion: boolean;

  constructor(kind: VerdictParseErrorKind, message: string, options: { truncated?: boolean } = {}) {
    super(message);
    this.name = "VerdictParseFailure";
    this.kind = kind;
    this.truncated = options.truncated ?? false;
    this.emptyCompletion = kind === "empty_completion";
  }
}
