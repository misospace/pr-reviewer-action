import type { AnthropicSystem, AnthropicWireBody, ModelRequestConfig, OpenAiWireBody, TransportWirePayload } from "./types.js";

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
 * deterministic must_check item, echoed by exact check text. A Required
 * Review Evidence section also requires one disposition per listed
 * obligation, echoed by id or exact text.
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
        // checks. `not_applicable` and `unmet` (#1381: a confirmed negative)
        // must each carry a grounded rationale. When a Required Review Evidence section is present, emit one disposition per listed obligation, echoing `obligation-<n>` or the exact text as `check`, with a grounded rationale.
        required_check_dispositions: {
          type: ["array", "null"],
          // #1449: the derived architectural obligation rows are disposed by
          // their row id (`derived-<n>`), and a satisfied derived row's
          // rationale must name one of that row's listed locations. Prose
          // only — the schema's shape (properties, enum, required) is
          // unchanged. #1627/#1657: when the verdict corpus carries the
          // Required-Check Proof Index, a call id there is a disclosure
          // pointer, never proof (#1657 retired the citation demand).
          description:
            "One disposition per listed obligation: must_check rows by the exact check text, trusted_base_guidance rows by 'obligation-<n>' or the exact text, derived architectural obligation rows by their row id ('derived-<n>') — a satisfied derived row's rationale must name one of that row's listed locations — and risk evidence obligation rows by their row id ('risk-<n>') — a satisfied risk row's rationale must name one of that row's listed locations and state the risk-specific counterexample considered with its source or test evidence.",
          items: {
            type: "object",
            // #1627/#1657: description-only annotation (no shape change) — a
            // citation into the proof index is an optional disclosure
            // pointer, never proof, and never one-per-disposition.
            description: "When the Required-Check Proof Index section is present, the rationale MAY cite one of its executed call ids (for example 'call-7') purely as a disclosure pointer to what the run actually executed. A citation is never proof of satisfaction, and one genuine acquisition may back several 'satisfied' dispositions; the deterministic layer validates objective-evidence claims against the run's own records, so an unsupported 'satisfied' on an objective check stays unresolved however well-cited the rationale is.",
            properties: {
              check: { type: "string" },
              status: { type: "string", enum: ["satisfied", "not_applicable", "unresolved", "unmet"] },
              rationale: { type: ["string", "null"] },
            },
            required: ["check", "status", "rationale"],
            additionalProperties: false,
          },
        },
        // #1337: dependency-upgrade coverage accounting, one entry per
        // closed aspect; unknown status words are parsed fail-closed to
        // `invalid` (counted not-checked), so the wire enum mirrors the
        // parser's accepted set.
        dependency_coverage: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              aspect: { type: "string", enum: ["source_mapping", "release_notes", "advisories", "signature_verification", "relevance"] },
              status: { type: "string", enum: ["checked_no_match", "finding_present", "unavailable", "not_checked", "skipped"] },
              note: { type: ["string", "null"] },
            },
            required: ["aspect", "status", "note"],
            additionalProperties: false,
          },
        },
        // #1835: the reviewer's declared materially-relevant unresolved
        // questions — the structured counterpart of the Unknowns or Needs
        // Verification section. Each entry is one concise subject sentence
        // plus the optional `affects` association: the reviewer's own answer
        // to WHICH finding the question undermines, as a repository-relative
        // citation. A question whose answer could change the verdict must be
        // declared here rather than left in prose.
        material_unknowns: {
          type: ["array", "null"],
          description: "Declare each unresolved question that materially bears on the verdict — the reference unavailable, the comparison not performed — as one object per question: subject (one concise sentence) and affects (the path or path:LINE citation of the location whose finding the question undermines; null when it ties to no specific location). An association that matches several unresolved findings is ambiguous and takes no effect. Null when none; at most 8 are kept. Declare a question required_check_dispositions also carries as unresolved; do not declare routine tool unavailability that bore on no conclusion.",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              affects: { type: ["string", "null"] },
            },
            required: ["subject", "affects"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict", "review_markdown", "smart_review_requested", "smart_review_reason", "review_triage_decision", "review_triage_reason", "review_triage_targets", "findings", "requirement_coverage", "required_check_dispositions", "dependency_coverage", "material_unknowns"],
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

/** #1678 hardening: the canonical requirement-decision status enum, mirrored
 * from the frozen base schema's `requirement_coverage.items.status` (a test
 * pins the mirror against the single contract-module list, so neither can
 * drift). Lives here because the run-specific pinning below is the wire
 * layer's own job and `verdict-contract.ts` imports this module, never the
 * other way around. */
const REQUIREMENT_DECISION_WIRE_STATUSES = ["satisfied", "violated", "unknown"] as const;

/**
 * #1678 hardening: the run-specific strict verdict schema — the pinned
 * verdict schema with `requirement_coverage` narrowed from nullable to an
 * EXACT-N array whose `requirement_id` is enum-pinned to the expected set.
 * Schema support is an aid, never the authority: the deterministic
 * pre-acceptance validator stays the gate for prompt-only and
 * capability-stripped providers. The base {@link OPENAI_VERDICT_JSON_SCHEMA}
 * object is NEVER mutated (its byte pin is a separate, frozen contract).
 * A base schema without the canonical `requirement_coverage` shape is
 * returned unpinned — no invented property, fail-soft.
 */
export function buildRunVerdictSchema(
  expectedIds: readonly string[],
  baseSchema: Record<string, unknown> = OPENAI_VERDICT_JSON_SCHEMA,
): Record<string, unknown> {
  const asObject = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const schema = structuredClone(baseSchema) as Record<string, unknown>;
  const inner = (schema.json_schema as { schema: Record<string, unknown> } | undefined)?.schema;
  const properties = (asObject(inner)?.properties as Record<string, unknown> | undefined) ?? null;
  const baseCoverage = properties === null ? null : asObject(properties.requirement_coverage);
  const baseItems = baseCoverage === null ? null : asObject(baseCoverage.items);
  if (properties === null || baseCoverage === null || baseItems === null) return schema;
  const coverage = structuredClone(baseCoverage) as Record<string, unknown>;
  const count = expectedIds.length;
  coverage.type = "array";
  coverage.minItems = count;
  coverage.maxItems = count;
  coverage.description = `Exactly ${count} requirement decision row(s): one per required requirement ID, no others. satisfied = current-head evidence establishes the requirement; violated = current-head evidence establishes it is not met; unknown = neither conclusion can be established. Unknown is always preferable to omission.`;
  const items = structuredClone(baseItems) as Record<string, unknown>;
  const itemProps: Record<string, unknown> = asObject(items.properties) ?? {};
  itemProps.requirement_id = {
    type: "string",
    enum: [...expectedIds],
    description: "The requirement ID this row decides. Must be one of the required IDs; echo it exactly.",
  };
  const itemStatus = asObject(itemProps.status);
  if (itemStatus !== null) {
    itemStatus.enum = [...REQUIREMENT_DECISION_WIRE_STATUSES];
  } else {
    itemProps.status = { type: "string", enum: [...REQUIREMENT_DECISION_WIRE_STATUSES] };
  }
  items.properties = itemProps;
  coverage.items = items;
  properties.requirement_coverage = coverage;
  return schema;
}

/** #1678 hardening: the Anthropic `output_config.format` envelope for the
 * run-specific schema, mirroring {@link ANTHROPIC_VERDICT_OUTPUT_FORMAT}'s
 * shape (the inner schema, not the OpenAI wrapper). */
export function buildRunVerdictOutputFormat(
  expectedIds: readonly string[],
  baseSchema: Record<string, unknown> = OPENAI_VERDICT_JSON_SCHEMA,
): Record<string, unknown> {
  const schema = buildRunVerdictSchema(expectedIds, baseSchema);
  return {
    type: "json_schema",
    schema: (schema.json_schema as { schema: Record<string, unknown> }).schema,
  };
}

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
 * #1368 review: the reasoning-effort value a BUILT wire body actually
 * carries, or "" when it carries none. Read back from the body the transport
 * sends rather than re-derived from the configuration that named it, so a
 * recorded provenance can never claim an effort the wire never carried
 * (#998's truth-telling rule: the operator is told what was SENT, never what
 * the config named).
 *
 * The wire FAMILY decides the field, not the body's shape: the OpenAI family
 * carries `reasoning_effort` and never `output_config`, the Anthropic family
 * carries `output_config.effort` (only under the operator's effort-support
 * assertion) and never `reasoning_effort`. Reading the family's own field is
 * what keeps this a statement about the bytes that were sent.
 */
export function wireEffortOf(payload: TransportWirePayload): string {
  const body = payload.body;
  if (payload.endpointPath === "/messages") {
    const outputConfig = (body as AnthropicWireBody).output_config;
    if (outputConfig !== undefined) {
      const effort = outputConfig.effort;
      if (typeof effort === "string" && effort !== "") return effort;
    }
    return "";
  }
  const direct = (body as OpenAiWireBody).reasoning_effort;
  if (typeof direct === "string" && direct !== "") return direct;
  return "";
}

/**
 * #1655: the one-shot corpus-only REVIEW request carried no `cache_control`
 * marker, so Anthropic's explicit prefix cache never engaged for it — unlike
 * the native tool loop, whose Conversation renderer already places
 * system/tool/message breakpoints (#263 Part 2).
 *
 * WHO reuses the cached prefix, precisely: Anthropic's cache entries are
 * scoped to the model that wrote them, so the reuse is SAME-MODEL reuse only.
 * Inside one run that is the non-streamed verdict retry
 * (`src/model/call.ts:617`), which re-sends the identical prefix to the SAME
 * model; across runs it is a later review of the same repository inside the
 * provider's cache TTL, whose system prompt and standards prefix are
 * byte-identical. A tier chain that switches models (primary → fallback, or
 * the smart-escalation pass on its own model) does NOT reuse the primary's
 * entry unless the operator points those lanes at the SAME model — the
 * fallback lane normally runs `ai-fallback-model`, so the common case is no
 * cross-lane reuse at all.
 *
 * LENGTH FLOOR (#1655 review): Anthropic caches a prefix only when it reaches
 * the model's minimum cacheable prompt length — from 512 up to 4,096 tokens
 * depending on the model — and a shorter prefix is processed WITHOUT caching
 * and WITHOUT any error. A system prompt below that floor keeps the
 * checkpoint inert (no cost, no benefit), so the win above is real only for
 * system prompts at or above the floor, not for every deployment.
 *
 * Shaped exactly like the Conversation renderer's stable system breakpoint
 * (`[{ type: "text", text, cache_control: { type: "ephemeral" } }]`) so the
 * two surfaces cache identically and a gateway that already serves the native
 * loop already accepts this shape. An empty system passes through unchanged
 * (never an empty-block array), and the OpenAI branch is untouched —
 * `cache_control` is Anthropic wire-only. Scope note: this is the
 * system-prompt checkpoint only; the user message (corpus + instruction) is
 * deliberately left as a plain string, keeping the request at ONE breakpoint
 * and the user-content bytes byte-identical to before.
 *
 * WHO may carry it (#1655 review): only the review lanes, whose transport
 * can DEGRADE a gateway that rejects the marker (the checkpoint strip in
 * `src/transport/transport.ts`). The one-attempt lanes — the confidence
 * scorer and the follow-up answer executor — cannot retry without it, so
 * they send the system prompt as the plain string they always sent.
 */
function anthropicSystemCacheCheckpoint(system: string): AnthropicSystem {
  if (system === "") return system;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
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
 *   #1655: it carries the `system` prompt-cache checkpoint only when the
 *   lane's own `anthropicCacheCheckpoint` decision is set — the review lanes,
 *   whose transport can degrade a gateway that rejects the marker.
 * - OpenAI-compatible: the token field flips wholesale via `tokensParam`
 *   (never both), temperature is omitted iff empty, stream_options is
 *   attached only while streaming, and #998 `reasoning_effort` is sent
 *   verbatim whenever an effort is resolved.
 */
export function buildModelRequest(config: ModelRequestConfig): TransportWirePayload {
  const content = userContent(config);
  if (config.apiFormat === "anthropic") {
    // Typed as the wire contract itself, not a loose record: the #1655 system
    // checkpoint is CHECKED at this construction site, so the `system` union
    // and the block shape the helper builds cannot drift apart unnoticed.
    const body: AnthropicWireBody = {
      model: config.model,
      max_tokens: config.maxTokens,
      stream: config.stream,
      // #1655 review: the checkpoint rides ONLY the lanes whose transport can
      // degrade a gateway that rejects it (the review lanes). A lane that
      // cannot retry without it sends the plain string it always sent.
      system: config.anthropicCacheCheckpoint ? anthropicSystemCacheCheckpoint(config.system) : config.system,
      messages: [{ role: "user", content }],
    };
    if (config.temperature !== "") body.temperature = config.temperature;
    // Each output_config key is gated by its OWN opt-in: #998's effort never
    // rides along because #1047's format was asserted (and vice versa), an
    // unset/unasserted key contributes nothing, and only a surviving key set
    // emits the object at all — never `thinking: {"type":"disabled"}` and
    // never an invented "none" effort. #1368: a `responseSchema` replaces
    // the pinned verdict schema with the caller's own (the confidence
    // scorer's answer contract); absent keeps the verdict envelope exactly
    // as before.
    const effort = config.anthropicEffortSupported ? config.reasoningEffort : "";
    const format = config.anthropicStructuredOutputSupported && config.responseFormat === "json_schema"
      ? (config.responseSchema !== undefined
          // #1678 hardening: a run with in-scope requirements pins the
          // verdict envelope exactly like the OpenAI arm and the native
          // lane; prompt-only / unasserted endpoints stay byte-identical.
          ? { type: "json_schema", schema: config.responseSchema }
          : (config.verdictRequirementIds?.length ?? 0) > 0
            ? buildRunVerdictOutputFormat(config.verdictRequirementIds ?? [])
            : ANTHROPIC_VERDICT_OUTPUT_FORMAT)
      : undefined;
    const outputConfig = buildAnthropicOutputConfig(effort, format);
    if (outputConfig !== null) body.output_config = outputConfig;
    return { endpointPath: "/messages", body };
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
    // #1368: a `responseSchema` swaps the pinned verdict schema for the
    // caller's own inner schema (the confidence scorer's answer contract);
    // absent keeps the verdict wrapper byte-for-byte as before.
    body.response_format = config.responseSchema !== undefined
      ? { type: "json_schema", json_schema: { name: "confidence_review", strict: true, schema: config.responseSchema } }
      : OPENAI_VERDICT_JSON_SCHEMA;
    // #1678 hardening: with an in-scope requirement set the verdict schema is
    // the run-specific pinning (non-null coverage, exactly N items, enum
    // IDs) — same builder the native lane uses, so every lane teaches the
    // schema the ONE contract. `responseSchema` (the scorer's own contract)
    // is the deliberate exception and never gets pinned. Absent IDs keep the
    // base wrapper byte-for-byte.
    if (config.responseSchema === undefined && (config.verdictRequirementIds?.length ?? 0) > 0) {
      body.response_format = buildRunVerdictSchema(config.verdictRequirementIds ?? []);
    }
  }
  if (config.stream) body.stream_options = { include_usage: true };
  // #998: the protocol-native effort field, verbatim.
  if (config.reasoningEffort !== "") body.reasoning_effort = config.reasoningEffort;
  return { endpointPath: "/chat/completions", body: body as unknown as TransportWirePayload["body"] };
}
