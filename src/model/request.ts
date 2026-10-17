import type { ModelRequestConfig, TransportWirePayload } from "./types.js";

/**
 * The strict OpenAI verdict schema. VERDICT-TURN CONTRACT (#362): this must
 * stay semantically identical to `_OPENAI_VERDICT_JSON_SCHEMA` in
 * pr_reviewer/conversation.py and to the inline `rf_json` literal in
 * scripts/model_call.sh — the schema remains pinned by
 * `tests-v3/request.test.ts`. `findings` and
 * `requirement_coverage` are nullable-but-required: OpenAI strict mode
 * requires every property to be listed in `required`, so optionality is
 * expressed via the null type. The parser tolerates null/absent/malformed
 * findings. `smart_review_requested`/`smart_review_reason` (#721) are the
 * reviewer's structured request for a smart-tier second pass; the parser
 * normalizes them so only the JSON boolean `true` requests one.
 * `review_triage_decision`/`review_triage_reason` (#1003) are the opt-in
 * human-review triage answer; they are always in the strict schema (so every
 * provider emits them) while the prompt explains them only when the
 * `review-triage` input is on, and the parser fails an absent or malformed
 * decision closed to `unknown`.
 * `review_triage_targets` (#1005) is the model's bounded selection of LOGICAL
 * routing target ids when `review_triage_decision === "required"`; it is
 * always present in the strict schema (so OpenAI strict-mode does not drop it
 * mid-request) while the prompt only explains it when routing is enabled, and
 * the parser caps the list and drops non-string/empty/oversized entries. The
 * model can only ever name a logical id here — the deterministic resolver
 * validates every id against the trusted base-ref configuration.
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
        // #1003: the opt-in human-review triage answer. Always present in the
        // strict schema (strict mode requires every property in `required`);
        // the prompt only explains the fields when `review-triage` is on. The
        // parser accepts only the three literal words and fails closed to
        // `unknown` — like every other triage value here, it never touches
        // the verdict, findings, or any capability.
        review_triage_decision: { type: "string", enum: ["not_required", "required", "unknown"] },
        review_triage_reason: { type: ["string", "null"] },
        // #1005: the model emits only LOGICAL ids here. The deterministic
        // resolver validates every id against the trusted base-ref config
        // before any reviewer request; this pass only bounds the list. A
        // null/empty array is the "not_required" / no-routing-configured
        // default, so the strict-mode required entry below always permits
        // null under OpenAI strict semantics.
        review_triage_targets: {
          type: ["array", "null"],
          items: { type: "string" },
        },
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
              end_line: { type: ["integer", "null"], description: "Inclusive last line of the affected range; use the same value as line for a single-line change, or null when the finding is not tied to a replaceable range." },
              suggestion: { type: ["string", "null"], description: "Exact replacement text for the affected file lines (line through end_line), suitable for a one-click suggestion; null when you cannot provide a safe exact replacement." },
              agent_prompt: { type: ["string", "null"], description: "A concise prompt a human can hand to a coding agent to make the fix; null when not applicable." },
            },
            required: ["severity", "category", "file", "line", "message", "preliminary_finding", "end_line", "suggestion", "agent_prompt"],
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
      required: ["verdict", "review_markdown", "smart_review_requested", "smart_review_reason", "review_triage_decision", "review_triage_reason", "review_triage_targets", "findings", "requirement_coverage", "required_check_dispositions"],
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
 * #1047: the Anthropic-native structured-output envelope for the verdict —
 * `output_config.format = {type: "json_schema", schema}` per the Messages API
 * contract, carrying the SAME inner schema the OpenAI `json_schema` mode
 * enforces (the `json_schema.schema` object, not the OpenAI wrapper around
 * it). Only ever sent under the lane's explicit structured-output opt-in;
 * there is no Anthropic-native `json_object` to translate that mode into, so
 * it is never attempted.
 */
export const ANTHROPIC_VERDICT_OUTPUT_FORMAT: Record<string, unknown> = {
  type: "json_schema",
  schema: (OPENAI_VERDICT_JSON_SCHEMA.json_schema as { schema: Record<string, unknown> }).schema,
};

/**
 * #998: build Anthropic's `output_config` object — the ONE place the wire
 * family merges its keys. `format` (#1047) and `effort` are siblings of the
 * same object, so a later key must never clobber an existing one:
 * `setOutputConfigKey` writes a key only when it is absent (or already holds
 * that exact value) and drops null/undefined outright. Returns null when
 * nothing survives, so an unset effort leaves the body untouched
 * (byte-identical to a build without the feature).
 */
export function buildAnthropicOutputConfig(
  effort: string,
  format?: unknown,
): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  const setOutputConfigKey = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (key in config && config[key] !== value) return;
    config[key] = value;
  };
  setOutputConfigKey("format", format);
  const normalizedEffort = effort.trim();
  setOutputConfigKey("effort", normalizedEffort === "" ? null : normalizedEffort);
  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Build the transport wire payload for a review request. Provider-neutral:
 * branches only on the configured api format, never on model names.
 *
 * - Anthropic always sends `max_tokens` and never response_format/token-param
 *   switching/stream_options. #998: it carries `output_config.effort` only
 *   under the operator's explicit `anthropicEffortSupported` opt-in, and
 *   never OpenAI's `reasoning_effort`. #1047: it carries
 *   `output_config.format` (the Anthropic-native verdict schema envelope)
 *   only when `responseFormat` resolved to `json_schema` AND the lane's
 *   `anthropicStructuredOutputSupported` opt-in is set; `json_object` has no
 *   Anthropic-native equivalent and is never sent or translated, so an
 *   un-opted-in or `json_object` configuration leaves the bytes unchanged.
 * - OpenAI-compatible: the token field flips wholesale via `tokensParam`
 *   (never both), temperature is omitted iff empty, stream_options is
 *   attached only while streaming, and #998 `reasoning_effort` is sent
 *   verbatim whenever an effort is resolved.
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
    // Each output_config key is gated by its OWN opt-in: #998's effort never
    // rides along because #1047's format was asserted (and vice versa), an
    // unset/unasserted key contributes nothing, and only a surviving key set
    // emits the object at all — never `thinking: {"type":"disabled"}` and
    // never an invented "none" effort.
    const effort = config.anthropicEffortSupported ? config.reasoningEffort : "";
    const format = config.anthropicStructuredOutputSupported && config.responseFormat === "json_schema"
      ? ANTHROPIC_VERDICT_OUTPUT_FORMAT
      : undefined;
    const outputConfig = buildAnthropicOutputConfig(effort, format);
    if (outputConfig !== null) body.output_config = outputConfig;
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
  // #998: the protocol-native effort field, verbatim.
  if (config.reasoningEffort !== "") body.reasoning_effort = config.reasoningEffort;
  return { endpointPath: "/chat/completions", body: body as unknown as TransportWirePayload["body"] };
}
