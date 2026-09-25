import type { ModelRequestConfig, TransportWirePayload } from "./types.js";

/**
 * The strict OpenAI verdict schema. VERDICT-TURN CONTRACT (#362): this must
 * stay semantically identical to `_OPENAI_VERDICT_JSON_SCHEMA` in
 * pr_reviewer/conversation.py and to the inline `rf_json` literal in
 * scripts/model_call.sh — the parity harness `model-request-construction`
 * boundary and tests/v3-schema-contract.test.ts pin it. `findings` and
 * `requirement_coverage` are nullable-but-required: OpenAI strict mode
 * requires every property to be listed in `required`, so optionality is
 * expressed via the null type. The parser tolerates null/absent/malformed
 * findings. `smart_review_requested`/`smart_review_reason` (#721) are the
 * reviewer's structured request for a smart-tier second pass; the parser
 * normalizes them so only the JSON boolean `true` requests one.
 * `required_check_dispositions` (#750) carries one disposition per
 * deterministic must_check item, echoed by exact check text.
 */
export const OPENAI_VERDICT_JSON_SCHEMA: Record<string, unknown> = {
  type: "json_schema",
  json_schema: {
    name: "pr_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approve", "request_changes"] },
        review_markdown: { type: "string" },
        smart_review_requested: { type: "boolean" },
        smart_review_reason: { type: ["string", "null"] },
        findings: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["blocker", "major", "minor", "info"] },
              category: { type: ["string", "null"] },
              file: { type: ["string", "null"] },
              line: { type: ["integer", "null"] },
              message: { type: "string" },
              preliminary_finding: { type: ["integer", "null"] },
            },
            required: ["severity", "category", "file", "line", "message", "preliminary_finding"],
            additionalProperties: false,
          },
        },
        requirement_coverage: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              requirement_id: { type: "string" },
              status: { type: "string", enum: ["satisfied", "violated", "unknown"] },
              evidence: {
                type: ["array", "null"],
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["file", "test", "tool", "ci", "diff"] },
                    ref: { type: ["string", "null"] },
                    detail: { type: ["string", "null"] },
                  },
                  required: ["kind", "ref", "detail"],
                  additionalProperties: false,
                },
              },
            },
            required: ["requirement_id", "status", "evidence"],
            additionalProperties: false,
          },
        },
        // #750: one structured disposition per deterministic must_check item.
        // Identity is the EXACT deterministic check text echoed back; the
        // parser/coverage layers validate it against the supplied list, so
        // the model cannot invent, omit, duplicate, or reword mandatory
        // checks. `not_applicable` must carry a grounded rationale.
        required_check_dispositions: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              check: { type: "string" },
              status: { type: "string", enum: ["satisfied", "not_applicable", "unresolved"] },
              rationale: { type: ["string", "null"] },
            },
            required: ["check", "status", "rationale"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict", "review_markdown", "smart_review_requested", "smart_review_reason", "findings", "requirement_coverage", "required_check_dispositions"],
      additionalProperties: false,
    },
  },
};

function userContent(config: ModelRequestConfig): string {
  // v2 shape contract: trailing_task puts the corpus first so the instruction
  // is the last thing the model reads; default puts the instruction first.
  return config.shape === "trailing_task"
    ? `${config.corpus}\n\n${config.user}`
    : `${config.user}\n\n${config.corpus}`;
}

/**
 * Build the transport wire payload for a review request. Provider-neutral:
 * branches only on the configured api format, never on model names.
 *
 * - Anthropic always sends `max_tokens` and never response_format/token-param
 *   switching/stream_options.
 * - OpenAI-compatible: the token field flips wholesale via `tokensParam`
 *   (never both), temperature is omitted iff empty, and stream_options is
 *   attached only while streaming.
 */
export function buildModelRequest(config: ModelRequestConfig): TransportWirePayload {
  const content = userContent(config);
  if (config.apiFormat === "anthropic") {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens,
      stream: config.stream,
      system: config.system,
      messages: [{ role: "user", content }],
    };
    if (config.temperature !== "") body.temperature = config.temperature;
    return { endpointPath: "/messages", body: body as unknown as TransportWirePayload["body"] };
  }
  const body: Record<string, unknown> = {
    model: config.model,
    stream: config.stream,
    messages: [
      { role: "system", content: config.system },
      { role: "user", content },
    ],
  };
  body[config.tokensParam] = config.maxTokens;
  if (config.temperature !== "") body.temperature = config.temperature;
  if (config.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  } else if (config.responseFormat === "json_schema") {
    body.response_format = OPENAI_VERDICT_JSON_SCHEMA;
  }
  if (config.stream) body.stream_options = { include_usage: true };
  return { endpointPath: "/chat/completions", body: body as unknown as TransportWirePayload["body"] };
}
