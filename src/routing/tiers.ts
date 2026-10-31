import type { EnvLike } from "../tools/budget.js";
import { REASONING_EFFORT_PATTERN } from "../config/load-config.js";

/**
 * Review routing and tier bindings, ported from scripts/sections/classification.sh
 * and scripts/model_call.sh. Resolution is pure and uses injected environment
 * values; post-primary heuristic escalation remains telemetry only (#721).
 * #965: the primary-first policy — `auto` always starts on the primary model
 * and there is no deterministic pre-primary route to the smart model.
 */
export type ReviewRoute = "legacy" | "primary" | "smart";
export interface TierSettings {
  baseUrl: string;
  model: string;
  apiFormat: string;
  apiKey: string;
}
export interface ResolvedTier extends TierSettings {
  resolved: boolean;
  retries: number;
  retryDelaySec: number;
  stream: boolean;
  requestTimeoutSec: number;
  connectTimeoutSec: number;
  /** #1009: per-lane OpenAI response_format (off/json_object/json_schema).
   * Empty lane overrides inherit `ai-response-format`. The Anthropic transport
   * ignores this field regardless of value. */
  responseFormat: "off" | "json_object" | "json_schema";
  /** #998: the lane's resolved reasoning effort, or "" when none is
   * configured (the field is then omitted from the request entirely). */
  reasoningEffort: string;
  /** #998: the per-lane assertion that this lane's Anthropic endpoint accepts
   * `output_config.effort`. Every lane asserts its own endpoint
   * (`ai-anthropic-effort-support` for the base/primary route,
   * `ai-smart-anthropic-effort-support`, `ai-fallback-anthropic-effort-support`);
   * no lane inherits another, because a route may target a different
   * Anthropic-compatible backend that was never asserted. */
  anthropicEffortSupported: boolean;
  /** #1047: the per-lane assertion that this lane's Anthropic endpoint
   * accepts Anthropic-native structured output (`output_config.format` with
   * the verdict JSON schema). Only `json_schema` is sendable and only under
   * this assertion (`ai-anthropic-structured-output-support` for the
   * base/primary route, `ai-smart-…`, `ai-fallback-…`); no lane inherits
   * another, for the same endpoint-heterogeneity reason as the effort
   * opt-in. */
  anthropicStructuredOutputSupported: boolean;
}
export interface TierProfiles {
  primary: ResolvedTier;
  smart: ResolvedTier;
  fallback: ResolvedTier;
}

export type SpecialistModelSource = "role-override" | "specialist-profile" | "primary";
export interface SpecialistRoleModel {
  model: string;
  source: SpecialistModelSource;
}
export interface SpecialistProfiles {
  profileActive: boolean;
  transport: {
    baseUrl: string;
    model: string;
    apiFormat: string;
    apiKey: string;
    /** #998: resolved specialist reasoning effort ("" = omit the field). */
    reasoningEffort: string;
    /** #998: the specialist lane's OWN `output_config.effort` assertion
     * (`ai-specialist-anthropic-effort-support`); the base flag never scopes
     * this lane. False (the default) never emits the field. */
    anthropicEffortSupported: boolean;
  };
  roleModels: Record<"correctness" | "security" | "tests", SpecialistRoleModel>;
  overridesActive: boolean;
  warnings: string[];
}

function value(env: EnvLike, key: string, fallback = ""): string { return env[key] || fallback; }
function trimmed(env: EnvLike, key: string): string { return (env[key] ?? "").trim(); }
function numberValue(env: EnvLike, key: string, fallback: number): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function trueValue(raw: string | undefined): boolean { return (raw ?? "").trim().toLowerCase() === "true"; }
/** #1009: per-lane `response_format` resolution. Empty/unset lane overrides
 * inherit `ai-response-format` (the contract base), so existing single-value
 * workflows stay request-byte compatible. Only OpenAI-compatible lanes use
 * the value; the Anthropic transport ignores it (see request.ts). */
export function tierResponseFormat(tier: "primary" | "smart" | "fallback", env: EnvLike): "off" | "json_object" | "json_schema" {
  const base = (env.AI_RESPONSE_FORMAT ?? "off").trim().toLowerCase();
  const key = tier === "smart"
    ? "AI_SMART_RESPONSE_FORMAT"
    : tier === "fallback"
      ? "AI_FALLBACK_RESPONSE_FORMAT"
      : "AI_PRIMARY_RESPONSE_FORMAT";
  const laneValue = (env[key] ?? "").trim().toLowerCase();
  const resolved = laneValue === "" ? base : laneValue;
  if (resolved === "json_object" || resolved === "json_schema" || resolved === "off") return resolved;
  // The contract validates user-supplied values, but values that reach here
  // via ambient overrides or test rigs may be other strings; quietly fall
  // back to off rather than crashing the review.
  return "off";
}

// ── #998: reasoning effort ───────────────────────────────────────────────
// Free-form by design: providers and proxies define their own effort
// vocabularies, so the action imposes no enum and clamps nothing. What it does
// impose is a SHAPE — a short, lowercase, JSON-safe token — because the value
// travels into a provider request body. The shape lives in exactly one place
// (`src/config/load-config.ts`, the loader's boundary check); this module
// consumes it rather than keeping a second copy in step.
export { REASONING_EFFORT_PATTERN };

/** The normalized effort for a raw value, or null when it is unset or fails
 * the shape check. Pure: the caller decides how loudly to report a drop. */
export function normalizeReasoningEffort(raw: string | undefined): string | null {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "") return null;
  return REASONING_EFFORT_PATTERN.test(normalized) ? normalized : null;
}

/** The bounded, key-naming notice a dropped effort produces. Never echoes the
 * rejected value: the warning is a log line and the value is free text. */
export function reasoningEffortWarning(key: string): string {
  return `${key} ignored: the reasoning effort must match ${REASONING_EFFORT_PATTERN.source} (lowercase letters, digits, '-', and '_'; up to 32 characters)`;
}

/** The env key a lane's own effort override lives under. Every per-lane
 * override has its own key — fallback included (#1053): availability
 * recovery still wants a per-lane effort so an operator can tune the
 * fallback lane separately, and the empty-or-rejected value then falls
 * back to the base `AI_REASONING_EFFORT`. */
function tierReasoningEffortKey(tier: "primary" | "smart" | "fallback"): string | null {
  if (tier === "smart") return "AI_SMART_REASONING_EFFORT";
  if (tier === "fallback") return "AI_FALLBACK_REASONING_EFFORT";
  return "AI_PRIMARY_REASONING_EFFORT";
}

interface EffortResolution {
  value: string;
  warning: string | null;
}

/** Resolve one env value: normalize-and-accept, or drop it with a warning. */
function effortFrom(env: EnvLike, key: string): EffortResolution {
  const raw = env[key] ?? "";
  if (raw.trim() === "") return { value: "", warning: null };
  const normalized = normalizeReasoningEffort(raw);
  if (normalized === null) return { value: "", warning: reasoningEffortWarning(key) };
  return { value: normalized, warning: null };
}

/**
 * #998: a lane's effective reasoning effort, mirroring `tierResponseFormat`'s
 * inheritance — an empty lane override inherits `ai-reasoning-effort` (the
 * contract base). The fallback lane (#1053) now has its own override too;
 * it stays availability recovery (never an escalation target) but inherits
 * the base only when its override is empty or malformed. A value that fails
 * validation is dropped as unset (announced loudly) so the inheritance below
 * still applies; "" means "omit the field from the request".
 *
 * Validation is repeated here on purpose: `loadConfig` guards
 * contract-supplied values, but these inputs can also arrive from ambient env
 * overrides or eval-harness rigs, which never pass through the loader.
 */
export function tierReasoningEffort(
  tier: "primary" | "smart" | "fallback",
  env: EnvLike,
  onWarning?: (warning: string) => void,
): string {
  const emit = (warning: string | null): void => {
    if (warning === null) return;
    if (onWarning !== undefined) onWarning(warning);
    else process.emitWarning(`WARNING: ${warning}`, "PrReviewerConfigWarning");
  };
  const key = tierReasoningEffortKey(tier);
  const lane = key === null ? { value: "", warning: null } : effortFrom(env, key);
  emit(lane.warning);
  if (lane.value !== "") return lane.value;
  const base = effortFrom(env, "AI_REASONING_EFFORT");
  emit(base.warning);
  return base.value;
}

/** #998: the operator's explicit opt-in that the configured
 * Anthropic-compatible endpoint accepts `output_config.effort`. True only on
 * the exact word "true"; anything else (including a malformed value) is off,
 * so an Anthropic request never carries an effort field by accident. This is
 * the base assertion: it scopes the base and primary lanes. Every other
 * lane requires its own assertion (below), because a heterogeneous
 * configuration routes it to a different Anthropic-compatible backend that
 * was never asserted to accept the field. */
export function anthropicEffortSupported(env: EnvLike): boolean {
  return (env.AI_ANTHROPIC_EFFORT_SUPPORT ?? "").trim().toLowerCase() === "true";
}

/** #998 (#1049 review): the per-lane Anthropic `output_config.effort`
 * assertion. No lane inherits another: an opt-in made for one endpoint must
 * never silently enable the field on a different Anthropic-compatible backend
 * the operator never asserted — which is why the fallback lane (its own
 * `AI_FALLBACK_BASE_URL`) asserts its own endpoint too, even though it
 * inherits the base effort. */
export function laneAnthropicEffortSupported(
  tier: "primary" | "smart" | "fallback",
  env: EnvLike,
): boolean {
  const key = tier === "smart"
    ? "AI_SMART_ANTHROPIC_EFFORT_SUPPORT"
    : tier === "fallback"
      ? "AI_FALLBACK_ANTHROPIC_EFFORT_SUPPORT"
      : "";
  // The base/primary lane delegates to the shared coercion, so every lane
  // agrees on what an asserted endpoint means.
  return key === "" ? anthropicEffortSupported(env) : (env[key] ?? "").trim().toLowerCase() === "true";
}

/** #998: the input name that carries the effort opt-in for one lane. */
export function anthropicEffortSupportInput(lane: "primary" | "smart" | "fallback" | "specialist" | "confidence"): string {
  if (lane === "smart") return "ai-smart-anthropic-effort-support";
  if (lane === "specialist") return "ai-specialist-anthropic-effort-support";
  if (lane === "fallback") return "ai-fallback-anthropic-effort-support";
  if (lane === "confidence") return "ai-confidence-anthropic-effort-support";
  // The base assertion scopes the base and primary lanes.
  return "ai-anthropic-effort-support";
}

/** #998: the effective effort a request actually carries on the wire. An
 * Anthropic request without its opt-in sends no effort at all, so logs and
 * any other "what did we ask for" surface must report "" here rather than the
 * configured value — the operator is told what was SENT, never what the
 * config happened to name. */
export function effectiveWireEffort(
  apiFormat: string,
  effort: string,
  anthropicEffortSupported: boolean,
): string {
  if (effort === "") return "";
  if (apiFormat === "anthropic" && !anthropicEffortSupported) return "";
  return effort;
}

/** #998: the operator-facing notice for a configured Anthropic effort that
 * will NOT be sent because the lane's endpoint opt-in is off. Names the lane,
 * the bounded (validated) effort value, and the exact input that turns it on;
 * it never mentions a secret. Silent omission alone is what made a configured
 * effort indistinguishable from an ignored one (#1049 review). */
export function anthropicEffortInactiveWarning(
  lane: "primary" | "smart" | "fallback" | "specialist" | "confidence",
  effort: string,
  boundary = "",
): string {
  const supportInput = anthropicEffortSupportInput(lane);
  return `${lane} lane${boundary}: the Anthropic endpoint is not asserted to accept output_config.effort, so the configured reasoning effort "${effort}" is NOT sent; set ${supportInput}: true only if the endpoint is known to accept it`;
}

// ── #1047: Anthropic-native structured output ───────────────────────────
// The Messages API's structured-output contract is
// `output_config.format = {type: "json_schema", schema}` — a sibling of
// `effort` in the same object. A wire family is not proof a backend supports
// its optional features, so the parameter is opt-in per lane, exactly like
// the effort opt-in: asserted endpoints only, never inherited across lanes,
// never translated from `json_object` (that mode has no Anthropic-native
// equivalent at all).

/** #1047: the input name that carries the structured-output opt-in for one
 * lane. The specialist lane has none by design: specialist payloads do not
 * use the verdict schema, so there is no Anthropic-native schema to assert
 * for them (their JSON stays prompted, and the truthful warning below says
 * so). */
export function anthropicStructuredOutputSupportInput(lane: "primary" | "smart" | "fallback"): string {
  if (lane === "smart") return "ai-smart-anthropic-structured-output-support";
  if (lane === "fallback") return "ai-fallback-anthropic-structured-output-support";
  return "ai-anthropic-structured-output-support";
}

/** #1047: the per-lane Anthropic structured-output assertion. True only on
 * the exact word "true"; anything else (including a malformed value) is off,
 * so an Anthropic request never carries `output_config.format` by accident.
 * Like the effort opt-in, no lane inherits another. */
export function laneAnthropicStructuredOutputSupported(
  tier: "primary" | "smart" | "fallback",
  env: EnvLike,
): boolean {
  const key = tier === "smart"
    ? "AI_SMART_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT"
    : tier === "fallback"
      ? "AI_FALLBACK_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT"
      : "";
  return key === ""
    ? (env.AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT ?? "").trim().toLowerCase() === "true"
    : (env[key] ?? "").trim().toLowerCase() === "true";
}

/** #1047: the effective structured-output mode a request actually enforces
 * on the wire. An Anthropic lane enforces `json_schema` only under its
 * opt-in; everything else on that wire family is prompt-only and reports as
 * "off" — logs and diagnostics state what was SENT, never what the config
 * happened to name. */
export function effectiveWireResponseFormat(
  apiFormat: string,
  responseFormat: string,
  anthropicStructuredOutputSupported: boolean,
): "off" | "json_object" | "json_schema" {
  if (responseFormat !== "json_object" && responseFormat !== "json_schema") return "off";
  if (apiFormat === "anthropic") {
    return responseFormat === "json_schema" && anthropicStructuredOutputSupported ? "json_schema" : "off";
  }
  return responseFormat;
}

/** #1047: the operator-facing notice for a resolved `json_schema` that will
 * NOT be enforced because the lane's Anthropic endpoint opt-in is off. Names
 * the lane, the effective prompt-only mode, and the exact input that turns
 * enforcement on; never mentions a secret. This is the truth-telling the
 * issue exists for: a silently omitted parameter is indistinguishable from
 * an enforced one. */
export function anthropicStructuredOutputInactiveWarning(
  lane: "primary" | "smart" | "fallback",
  boundary = "",
): string {
  const supportInput = anthropicStructuredOutputSupportInput(lane);
  return `${lane} lane${boundary}: ai-response-format resolved to json_schema, but the Anthropic endpoint is not asserted to accept output_config.format, so NO structured-output parameter is sent and the JSON contract is prompt-only; set ${supportInput}: true only if the endpoint is known to accept it`;
}

/** #1047: the operator-facing notice for `json_object` resolved onto an
 * Anthropic-format lane. There is no Anthropic-native `json_object` — no
 * opt-in exists that could enable it, and the action never translates the
 * mode into some other wire parameter — so the request asks for JSON in the
 * prompt only. The actionable alternative is named: `json_schema` plus the
 * lane's structured-output opt-in. The specialist lane has no opt-in at all
 * (specialist payloads do not use the verdict schema), so its notice says
 * that instead of naming an input that would do nothing. */
export function anthropicJsonObjectsPromptOnlyWarning(
  lane: "primary" | "smart" | "fallback" | "specialist",
  responseFormat: "json_object" | "json_schema" = "json_object",
  boundary = "",
): string {
  if (lane === "specialist") {
    return `${lane} lane${boundary}: ai-response-format is ignored for Anthropic-format specialist calls — specialist JSON contracts are prompted only and are never sent as output_config.format`;
  }
  const supportInput = anthropicStructuredOutputSupportInput(lane);
  if (responseFormat === "json_schema") {
    return anthropicStructuredOutputInactiveWarning(lane, boundary);
  }
  return `${lane} lane${boundary}: ai-response-format resolved to json_object, which has no Anthropic-native equivalent — the request is prompt-only for JSON and nothing is schema-enforced; use json_schema with ${supportInput}: true on an endpoint known to accept it`;
}

/** #965: the primary-first policy. In `auto` mode the initial review always
 * uses the primary profile; the smart model is reached only when the completed
 * primary verdict explicitly sets `smart_review_requested: true` (#721), and
 * fallback remains availability recovery, never escalation. Deterministic
 * classification (`route_signals`) stays available for specialist role
 * selection, required checks, and telemetry — never for model routing. */
export function resolveReviewRoute(input: { routingMode: string }): { route: ReviewRoute; reason: string } {
  if (input.routingMode.trim().toLowerCase() !== "auto") return { route: "legacy", reason: "routing off" };
  return { route: "primary", reason: "primary-first: the primary reviews first; smart is reviewer-requested only (#721)" };
}

export function resolveSpecialistProfiles(env: EnvLike): SpecialistProfiles {
  const warnings: string[] = [];
  const primary = {
    baseUrl: trimmed(env, "AI_BASE_URL"),
    model: trimmed(env, "AI_MODEL"),
    apiFormat: trimmed(env, "AI_API_FORMAT").toLowerCase() || "openai",
    apiKey: trimmed(env, "AI_API_KEY"),
  };
  const specialistModel = trimmed(env, "AI_SPECIALIST_MODEL");
  const specialistBaseUrl = trimmed(env, "AI_SPECIALIST_BASE_URL");
  const specialistApiFormat = trimmed(env, "AI_SPECIALIST_API_FORMAT");
  const specialistApiKey = trimmed(env, "AI_SPECIALIST_API_KEY");
  const configuredFormat = specialistApiFormat.toLowerCase();
  const hasTransportWithoutModel = specialistBaseUrl !== "" || specialistApiFormat !== "" || specialistApiKey !== "";

  let profileActive = specialistModel !== "";
  if (specialistApiFormat !== "" && configuredFormat !== "openai" && configuredFormat !== "anthropic") {
    profileActive = false;
    warnings.push("specialist profile ignored: AI_SPECIALIST_API_FORMAT must be openai or anthropic");
  } else if (!profileActive && hasTransportWithoutModel) {
    const configuredKeys = [
      specialistBaseUrl !== "" ? "ai-specialist-base-url" : "",
      specialistApiFormat !== "" ? "ai-specialist-api-format" : "",
      specialistApiKey !== "" ? "ai-specialist-api-key" : "",
    ].filter(Boolean);
    warnings.push(`specialist profile ignored: ${configuredKeys.join("/")} set without ai-specialist-model`);
  }

  const transport = profileActive
    ? {
        baseUrl: specialistBaseUrl || primary.baseUrl,
        model: specialistModel,
        apiFormat: specialistApiFormat ? configuredFormat : primary.apiFormat,
        apiKey: specialistApiKey || primary.apiKey,
      }
    : primary;
  const roles = ["correctness", "security", "tests"] as const;
  const roleModels = Object.fromEntries(roles.map((role) => {
    const override = trimmed(env, `AI_SPECIALIST_${role.toUpperCase()}_MODEL`);
    if (override !== "") return [role, { model: override, source: "role-override" as const }];
    if (profileActive) return [role, { model: specialistModel, source: "specialist-profile" as const }];
    return [role, { model: primary.model, source: "primary" as const }];
  })) as SpecialistProfiles["roleModels"];
  const overridesActive = profileActive || Object.values(roleModels).some((role) => role.source === "role-override");

  // #998: the specialist lane's effort — its own override, else the primary
  // lane's resolved value, exactly like the transport fields above. A rejected
  // value is dropped as unset and reported through `warnings` (the specialist
  // phase prints them as WARNING lines), so a typo can never silently change
  // the request body.
  const specialistEffort = effortFrom(env, "AI_SPECIALIST_REASONING_EFFORT");
  if (specialistEffort.warning !== null) warnings.push(specialistEffort.warning);
  const primaryEffort = tierReasoningEffort("primary", env, (warning) => warnings.push(warning));
  const reasoningEffort = specialistEffort.value !== "" ? specialistEffort.value : primaryEffort;
  // #998: the opt-in is per-lane, like the transport fields above. The base
  // `ai-anthropic-effort-support` assertion covers the base/primary endpoint;
  // the specialist lane only sends `output_config.effort` when its
  // OWN assertion is true, so enabling it for one Anthropic backend never
  // silently enables it on another. An effort resolved onto an Anthropic
  // specialist transport without that assertion is reported through
  // `warnings`, never dropped silently.
  const anthropicSupport = (env.AI_SPECIALIST_ANTHROPIC_EFFORT_SUPPORT ?? "").trim().toLowerCase() === "true";
  if (transport.apiFormat === "anthropic" && reasoningEffort !== "" && !anthropicSupport) {
    warnings.push(anthropicEffortInactiveWarning("specialist", reasoningEffort));
  }

  return {
    profileActive,
    transport: {
      ...transport,
      reasoningEffort,
      anthropicEffortSupported: anthropicSupport,
    },
    roleModels,
    overridesActive,
    warnings,
  };
}

export function resolveTierProfiles(env: EnvLike): TierProfiles {
  const primary = {
    baseUrl: value(env, "AI_PRIMARY_BASE_URL", value(env, "AI_BASE_URL")),
    model: value(env, "AI_PRIMARY_MODEL", value(env, "AI_MODEL")),
    apiFormat: value(env, "AI_PRIMARY_API_FORMAT", value(env, "AI_API_FORMAT", "openai")),
    apiKey: value(env, "AI_PRIMARY_API_KEY", value(env, "AI_API_KEY")),
  };
  const smartModel = value(env, "AI_SMART_MODEL");
  const smartResolved = smartModel.length > 0;
  const smart = {
    baseUrl: value(env, "AI_SMART_BASE_URL", value(env, "AI_BASE_URL")),
    model: smartModel,
    apiFormat: value(env, "AI_SMART_API_FORMAT", value(env, "AI_API_FORMAT", "openai")),
    apiKey: value(env, "AI_SMART_API_KEY", value(env, "AI_API_KEY")),
  };
  const fallback = {
    // #1251: raw-env parity with the config loader's resolveInherited —
    // an unset/empty fallback endpoint inherits the base endpoint (but never
    // the base model; the config loader deliberately leaves that unset).
    baseUrl: value(env, "AI_FALLBACK_BASE_URL", value(env, "AI_BASE_URL")),
    model: value(env, "AI_FALLBACK_MODEL"),
    apiFormat: value(env, "AI_FALLBACK_API_FORMAT", value(env, "AI_API_FORMAT", "openai")),
    apiKey: value(env, "AI_FALLBACK_API_KEY", value(env, "AI_API_KEY")),
  };
  const primaryRetries = numberValue(env, "AI_PRIMARY_RETRIES", 8);
  const delay = numberValue(env, "AI_PRIMARY_RETRY_DELAY_SEC", 15);
  const stream = trueValue(env.AI_STREAM === undefined ? "true" : env.AI_STREAM);
  const timeout = numberValue(env, "AI_REQUEST_TIMEOUT_SEC", 300);
  const connectTimeout = numberValue(env, "AI_CONNECT_TIMEOUT_SEC", 30);
  // #1251: raw-env parity with resolveInherited — an empty/unset
  // ai-fallback-stream inherits the base ai-stream, including its
  // unset-means-"true" default (v2: `${AI_FALLBACK_STREAM:-$AI_STREAM}`).
  const baseStreamRaw = env.AI_STREAM === undefined ? "true" : env.AI_STREAM;
  const fallbackStreamRaw = env.AI_FALLBACK_STREAM ?? "";
  const fallbackStream = trueValue(fallbackStreamRaw === "" ? baseStreamRaw : fallbackStreamRaw);
  return {
    primary: {
      ...primary, resolved: Boolean(primary.model), retries: primaryRetries, retryDelaySec: delay, stream,
      requestTimeoutSec: timeout, connectTimeoutSec: connectTimeout,
      responseFormat: tierResponseFormat("primary", env),
      reasoningEffort: tierReasoningEffort("primary", env),
      anthropicEffortSupported: laneAnthropicEffortSupported("primary", env),
      // #1047: the base assertion scopes the base/primary route, exactly like
      // the effort opt-in.
      anthropicStructuredOutputSupported: laneAnthropicStructuredOutputSupported("primary", env),
    },
    smart: {
      ...smart, resolved: smartResolved, retries: numberValue(env, "AI_SMART_RETRIES", 2), retryDelaySec: delay, stream,
      requestTimeoutSec: timeout, connectTimeoutSec: connectTimeout,
      responseFormat: tierResponseFormat("smart", env),
      reasoningEffort: tierReasoningEffort("smart", env),
      // #998: the smart lane asserts its own endpoint capability; the base
      // flag never scopes a route that may point at another backend.
      anthropicEffortSupported: laneAnthropicEffortSupported("smart", env),
      // #1047: same per-lane rule — the smart route may target a different
      // Anthropic-compatible backend that was never asserted.
      anthropicStructuredOutputSupported: laneAnthropicStructuredOutputSupported("smart", env),
    },
    fallback: {
      ...fallback, resolved: Boolean(fallback.baseUrl && fallback.model), retries: numberValue(env, "AI_FALLBACK_RETRIES", 2), retryDelaySec: delay,
      stream: fallbackStream, requestTimeoutSec: numberValue(env, "AI_FALLBACK_REQUEST_TIMEOUT_SEC", timeout),
      connectTimeoutSec: numberValue(env, "AI_FALLBACK_CONNECT_TIMEOUT_SEC", connectTimeout),
      responseFormat: tierResponseFormat("fallback", env),
      // #998 / #1053: availability recovery, never quality escalation — the
      // fallback lane now has its own override input
      // (ai-fallback-reasoning-effort) but stays byte-compatible when it is
      // empty or malformed: the base effort is then inherited, exactly like
      // the primary and smart lanes.
      reasoningEffort: tierReasoningEffort("fallback", env),
      // #998: like its effort, the fallback lane shares the base endpoint
      // assertion; it has no effort opt-in input of its own.
      anthropicEffortSupported: laneAnthropicEffortSupported("fallback", env),
      // #1047: the fallback endpoint asserts its own support (it runs on its
      // own ai-fallback-base-url, which may be a different backend).
      anthropicStructuredOutputSupported: laneAnthropicStructuredOutputSupported("fallback", env),
    },
  };
}

export function tierRequestShape(profile: "primary" | "smart" | "fallback", env: EnvLike): "default" | "trailing_task" {
  if (profile === "fallback") return "default";
  // #1253: the profile argument decides — the unreachable
  // REVIEW_CONTEXT_PROFILE=smart env override has been removed.
  const key = profile === "smart" ? "SMART_REQUEST_SHAPE" : "PRIMARY_REQUEST_SHAPE";
  const shape = env[key];
  return shape === "trailing_task" ? "trailing_task" : "default";
}

// ── #1073: the independent post-review confidence scorer ─────────────────
// An opt-in lane that grades the completed review's confidence (0-5 plus a
// risk band and a short reason). Purely advisory telemetry: it never affects
// the verdict, findings, or approval, and it is disabled entirely when
// `ai-confidence-model` is empty. Resolution mirrors `resolveSpecialistProfiles`
// with one stricter credential rule: a DISTINCT configured base URL never
// implicitly inherits the primary API key — the whole point of pointing the
// scorer at another backend is independence, and silently reusing the primary
// credential there would couple the two lanes anyway (enforcement of the
// transport boundary itself happens in the runtime phase; this resolver only
// carries configuration).

export interface ConfidenceProfile {
  /** False when `ai-confidence-model` is empty: the scorer costs no model
   * call and every confidence-* output stays empty. */
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiFormat: string;
  apiKey: string;
  requestTimeoutSec: number;
  /** #998-style free-form effort, "" = omit the field. Unlike the review
   * lanes it never inherits `ai-reasoning-effort`: the scorer is an
   * independent lane and an empty value omits the field entirely. */
  reasoningEffort: string;
  /** True when the endpoint+credential came from the primary lane rather
   * than the scorer's own configuration — the same-endpoint caveat. */
  inheritedTransport: boolean;
  /** Where the resolved credential came from: the scorer's own
   * configuration ("own") or inherited from the primary lane ("primary").
   * Provenance, not value equality — an operator may deliberately reuse
   * the same secret on a distinct endpoint, and that must stay allowed. */
  credentialSource: "own" | "primary";
  /** #1368: the scorer's completion/output budget in tokens (positive
   * integer). Provider accounting may include reasoning/thinking tokens
   * inside this budget, so it must leave room for hidden reasoning plus the
   * final structured JSON answer; default 4096. A scorer that exhausts the
   * budget degrades to unscored — it never affects the review. */
  maxTokens: number;
  /** #1368: the scorer's prompt budget in tokens (~96k default). A
   * deterministic bytes/4 estimate bounds the assembled prompt with explicit
   * in-band truncation when exceeded. */
  promptTokens: number;
  /** #1368: the operator-declared context window of the confidence model,
   * for deterministic budget validation; 0 = unknown (no clamping). */
  modelContextTokens: number;
  /** #1368: the operator's assertion that the scorer's Anthropic-compatible
   * endpoint accepts `output_config.effort`. Never inherited from any other
   * lane (capability assertions never cross lanes); false keeps the
   * Anthropic request byte-identical even when an effort is configured. */
  anthropicEffortSupported: boolean;
  /** #1368: the operator's assertion that the scorer's endpoint (either wire
   * family) accepts structured output with the scorer's own compact JSON
   * schema. False (the default) keeps the request bytes unchanged. */
  structuredOutputSupported: boolean;
}

export interface ConfidenceResolution {
  profile: ConfidenceProfile;
  /** Operator-facing config warnings (the specialist phase prints these as
   * WARNING lines); never contains a secret. */
  warnings: string[];
}

/** The primary lane's resolved transport, read the way resolveSpecialistProfiles
 * reads it (trimmed, lowercased format) so the confidence lane's inherited
 * values are consistent with the specialist lane's. Kept local so the
 * confidence resolver stays a pure function over env with no dependency on
 * the tier profile shape. */
function primaryLane(env: EnvLike): { baseUrl: string; model: string; apiFormat: string; apiKey: string } {
  return {
    baseUrl: trimmed(env, "AI_PRIMARY_BASE_URL") || trimmed(env, "AI_BASE_URL"),
    model: trimmed(env, "AI_PRIMARY_MODEL") || trimmed(env, "AI_MODEL"),
    apiFormat: (trimmed(env, "AI_PRIMARY_API_FORMAT") || trimmed(env, "AI_API_FORMAT") || "openai").toLowerCase(),
    apiKey: trimmed(env, "AI_PRIMARY_API_KEY") || trimmed(env, "AI_API_KEY"),
  };
}

/** The disabled profile every early return shares: no endpoint, no
 * credential, no model — nothing the run could dial. The #1368 budget and
 * capability fields carry their documented defaults so the shape stays
 * uniform for every consumer. */
function disabledConfidenceProfile(): ConfidenceProfile {
  return {
    enabled: false, baseUrl: "", model: "", apiFormat: "", apiKey: "",
    requestTimeoutSec: 120, reasoningEffort: "", inheritedTransport: false,
    credentialSource: "own",
    maxTokens: 4096, promptTokens: 98304, modelContextTokens: 0,
    anthropicEffortSupported: false, structuredOutputSupported: false,
  };
}

/** `IS_FORK_PR` as the stages resolved it (exactly "true" = fork), the same
 * comparison `gateForkForForks` and `evidenceForkGateApplies` make. The stage
 * env always carries a resolved value — an unresolvable flag is itself
 * "true" upstream — so this reads state, it does not decide it. */
function isForkPr(env: EnvLike): boolean {
  return env.IS_FORK_PR === "true";
}

/** #1368: one positive-integer env value, or its documented default with a
 * WARNING naming the input — the same drop-loudly-never-fatal style
 * `effortFrom` uses. An empty value means "not set" and takes the default
 * silently (the contract's own unset shape). */
function positiveIntFrom(env: EnvLike, key: string, fallback: number, warnings: string[]): number {
  const raw = (env[key] ?? "").trim();
  if (raw === "") return fallback;
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 1) {
    warnings.push(`${key} ignored: the value must be a positive integer; the default ${fallback} is used`);
    return fallback;
  }
  return parsed;
}

/** #1368: the boolean capability-assertion convention every lane opt-in
 * shares — true only on the exact word "true", so nothing is ever enabled by
 * accident (malformed values are off, never an opt-in). */
function confidenceCapabilityFlag(env: EnvLike, key: string): boolean {
  return (env[key] ?? "").trim().toLowerCase() === "true";
}

export function resolveConfidenceProfile(env: EnvLike): ConfidenceResolution {
  const warnings: string[] = [];
  const primary = primaryLane(env);
  const model = trimmed(env, "AI_CONFIDENCE_MODEL");
  const enabled = model !== "";
  const baseUrl = trimmed(env, "AI_CONFIDENCE_BASE_URL");
  const apiFormatRaw = trimmed(env, "AI_CONFIDENCE_API_FORMAT");
  const apiKey = trimmed(env, "AI_CONFIDENCE_API_KEY");

  if (!enabled) {
    // Disabled is the default: a transport configured without a model is a
    // likely typo, reported the same way the specialist lane reports orphan
    // transport fields — loudly, but never fatal.
    const orphans = [
      baseUrl !== "" ? "ai-confidence-base-url" : "",
      apiFormatRaw !== "" ? "ai-confidence-api-format" : "",
      apiKey !== "" ? "ai-confidence-api-key" : "",
    ].filter(Boolean);
    if (orphans.length > 0) {
      warnings.push(`confidence scorer disabled: ${orphans.join("/")} set without ai-confidence-model`);
    }
    return { profile: disabledConfidenceProfile(), warnings };
  }

  // Fork gate (#1073): default-off on a cross-repository PR, mirroring
  // `gateForkForForks`. The scorer's prompt is built from PRIVILEGED
  // review-derived output — the final findings, summary, coverage account,
  // review_result, and required checks — and sends it outward over a
  // privileged credential, so on a fork PR it would carry private review
  // content across the fork trust boundary. Disabled (the same resolved
  // "off" the unset model produces), loudly, never fatal; the operator
  // override is the only way it runs there.
  if (isForkPr(env) && (env.AI_CONFIDENCE_ENABLE_FOR_FORKS ?? "false").toLowerCase() !== "true") {
    warnings.push("confidence scorer skipped for a cross-repository pull request; set ai-confidence-enable-for-forks=true to override");
    return { profile: disabledConfidenceProfile(), warnings };
  }

  const distinctEndpoint = baseUrl !== "";
  // An explicitly configured api-format wins; empty inherits the primary
  // lane's resolved format (the contract validates the enum, but ambient
  // overrides or test rigs may not — an unknown value falls back to the
  // primary format rather than crashing the run).
  const configuredFormat = apiFormatRaw.toLowerCase();
  const apiFormat = apiFormatRaw !== ""
    ? (configuredFormat === "openai" || configuredFormat === "anthropic" ? configuredFormat : primary.apiFormat)
    : primary.apiFormat;

  // Credential rule (#1073): an explicitly configured scorer key is ALWAYS
  // used as-is — including on the same endpoint, where the operator named the
  // credential they want to answer with. Only an EMPTY key inherits, and only
  // when the endpoint is the primary's own (it is the same backend, so there
  // is nothing to separate); a DISTINCT base URL never inherits — the scorer
  // uses only its own key, and a distinct URL without an explicit key is
  // warned about rather than silently degrading.
  const inheritedTransport = !distinctEndpoint;
  const resolvedBaseUrl = distinctEndpoint ? baseUrl : primary.baseUrl;
  const apiKeyResolved = apiKey !== "" ? apiKey : (distinctEndpoint ? "" : primary.apiKey);
  if (distinctEndpoint && apiKey === "") {
    warnings.push(
      "confidence scorer: ai-confidence-base-url is set but ai-confidence-api-key is empty — a distinct endpoint never inherits the primary API key; set ai-confidence-api-key explicitly",
    );
  }

  // Same-endpoint AND same-model scoring is less independent: the model that
  // produced the review would grade its own work, so correlated errors go
  // unnoticed. Reported, never fatal — a deliberate same-lane scorer is a
  // legitimate cheap default.
  if (!distinctEndpoint && model === primary.model) {
    warnings.push(
      "confidence scorer: the resolved endpoint and model are identical to the primary review lane — same-model scoring is less independent; point ai-confidence-base-url at a different backend for a genuinely independent second opinion",
    );
  }

  const effort = effortFrom(env, "AI_CONFIDENCE_REASONING_EFFORT");
  if (effort.warning !== null) warnings.push(effort.warning);

  // #1368: the scorer's own budgets and capability assertions. Every value
  // is resolved here — defaults, validation warnings, and the deterministic
  // context clamps — so the profile is the single source the scorer reads.
  const maxTokensDefault = 4096;
  const promptTokensDefault = 98304;
  let maxTokens = positiveIntFrom(env, "AI_CONFIDENCE_MAX_TOKENS", maxTokensDefault, warnings);
  let promptTokens = positiveIntFrom(env, "AI_CONFIDENCE_PROMPT_TOKENS", promptTokensDefault, warnings);
  const modelContextTokens = positiveIntFrom(env, "AI_CONFIDENCE_MODEL_CONTEXT_TOKENS", 0, warnings);
  const anthropicEffortSupported = confidenceCapabilityFlag(env, "AI_CONFIDENCE_ANTHROPIC_EFFORT_SUPPORT");
  const structuredOutputSupported = confidenceCapabilityFlag(env, "AI_CONFIDENCE_STRUCTURED_OUTPUT_SUPPORT");
  // Deterministic clamping against a declared context window. Never fatal:
  // each clamp is announced and the budgets stay positive (the prompt floor
  // keeps a tiny window from starving the prompt to zero).
  if (modelContextTokens > 0) {
    if (maxTokens > modelContextTokens) {
      warnings.push(
        `AI_CONFIDENCE_MAX_TOKENS clamped to ${modelContextTokens}: the declared ai-confidence-model-context-tokens window (${modelContextTokens}) is smaller than the configured completion budget`,
      );
      maxTokens = modelContextTokens;
    }
    if (promptTokens + maxTokens > modelContextTokens) {
      const clampedPrompt = Math.max(modelContextTokens - maxTokens, 1024);
      warnings.push(
        `AI_CONFIDENCE_PROMPT_TOKENS clamped to ${clampedPrompt}: prompt plus completion budgets must fit the declared ai-confidence-model-context-tokens window (${modelContextTokens})`,
      );
      promptTokens = clampedPrompt;
    }
  }
  // #1368: a configured effort that cannot be sent must never be silent —
  // the same truth-telling warning the review lanes emit (#1049 review).
  if (apiFormat === "anthropic" && effort.value !== "" && !anthropicEffortSupported) {
    warnings.push(anthropicEffortInactiveWarning("confidence", effort.value));
  }

  return {
    profile: {
      enabled: true,
      baseUrl: resolvedBaseUrl,
      model,
      apiFormat,
      apiKey: apiKeyResolved,
      requestTimeoutSec: numberValue(env, "AI_CONFIDENCE_TIMEOUT_SEC", 120),
      reasoningEffort: effort.value,
      inheritedTransport,
      credentialSource: apiKey !== "" || distinctEndpoint ? "own" : "primary",
      maxTokens,
      promptTokens,
      modelContextTokens,
      anthropicEffortSupported,
      structuredOutputSupported,
    },
    warnings,
  };
}
