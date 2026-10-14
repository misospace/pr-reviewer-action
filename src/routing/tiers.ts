import type { EnvLike } from "../tools/budget.js";

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
   * `output_config.effort`. The base/primary/fallback lanes share the base
   * `ai-anthropic-effort-support` opt-in; the smart lane requires its own
   * `ai-smart-anthropic-effort-support`, because a route may target a
   * different Anthropic-compatible backend that was never asserted. */
  anthropicEffortSupported: boolean;
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
// travels into a provider request body.

/** Same shape contract as `REASONING_EFFORT_PATTERN` in `src/config/load-config.ts`. */
export const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

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

/** The env key a lane's own effort override lives under. `fallback` has no
 * lane key at all: fallback is availability recovery and inherits the base. */
function tierReasoningEffortKey(tier: "primary" | "smart" | "fallback"): string | null {
  if (tier === "smart") return "AI_SMART_REASONING_EFFORT";
  if (tier === "fallback") return null;
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
 * contract base) and the fallback lane always uses the base. A value that
 * fails validation is dropped as unset (announced loudly) so the inheritance
 * below still applies; "" means "omit the field from the request".
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
 * the base assertion: it scopes the base/primary/fallback lanes. The smart
 * and specialist lanes each require their own assertion (below), because a
 * heterogeneous configuration routes those lanes to a different Anthropic-
 * compatible backend that was never asserted to accept the field. */
export function anthropicEffortSupported(env: EnvLike): boolean {
  return (env.AI_ANTHROPIC_EFFORT_SUPPORT ?? "").trim().toLowerCase() === "true";
}

/** #998: the per-lane Anthropic `output_config.effort` assertion. The smart
 * lane never inherits the base flag: an opt-in made for the primary
 * endpoint must not silently enable the field on an unrelated Anthropic-
 * compatible smart backend (and vice versa). The fallback lane shares the
 * base assertion exactly like it inherits the base effort. */
export function laneAnthropicEffortSupported(
  tier: "primary" | "smart" | "fallback",
  env: EnvLike,
): boolean {
  if (tier === "smart") {
    return (env.AI_SMART_ANTHROPIC_EFFORT_SUPPORT ?? "").trim().toLowerCase() === "true";
  }
  return anthropicEffortSupported(env);
}

/** #998: the input name that carries the effort opt-in for one lane. */
export function anthropicEffortSupportInput(lane: "primary" | "smart" | "fallback" | "specialist"): string {
  if (lane === "smart") return "ai-smart-anthropic-effort-support";
  if (lane === "specialist") return "ai-specialist-anthropic-effort-support";
  // The base assertion scopes the base/primary/fallback lanes.
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
  lane: "primary" | "smart" | "fallback" | "specialist",
  effort: string,
): string {
  const supportInput = anthropicEffortSupportInput(lane);
  return `${lane} lane: the Anthropic endpoint is not asserted to accept output_config.effort, so the configured reasoning effort "${effort}" is NOT sent; set ${supportInput}: true only if the endpoint is known to accept it`;
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
  // `ai-anthropic-effort-support` assertion covers the base/primary/fallback
  // endpoint; the specialist lane only sends `output_config.effort` when its
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
    baseUrl: value(env, "AI_FALLBACK_BASE_URL"), model: value(env, "AI_FALLBACK_MODEL"),
    apiFormat: value(env, "AI_FALLBACK_API_FORMAT", value(env, "AI_API_FORMAT", "openai")),
    apiKey: value(env, "AI_FALLBACK_API_KEY", value(env, "AI_API_KEY")),
  };
  const primaryRetries = numberValue(env, "AI_PRIMARY_RETRIES", 8);
  const delay = numberValue(env, "AI_PRIMARY_RETRY_DELAY_SEC", 15);
  const stream = trueValue(env.AI_STREAM === undefined ? "true" : env.AI_STREAM);
  const timeout = numberValue(env, "AI_REQUEST_TIMEOUT_SEC", 300);
  const connectTimeout = numberValue(env, "AI_CONNECT_TIMEOUT_SEC", 30);
  const fallbackStream = trueValue(env.AI_FALLBACK_STREAM);
  return {
    primary: {
      ...primary, resolved: Boolean(primary.model), retries: primaryRetries, retryDelaySec: delay, stream,
      requestTimeoutSec: timeout, connectTimeoutSec: connectTimeout,
      responseFormat: tierResponseFormat("primary", env),
      reasoningEffort: tierReasoningEffort("primary", env),
      anthropicEffortSupported: laneAnthropicEffortSupported("primary", env),
    },
    smart: {
      ...smart, resolved: smartResolved, retries: numberValue(env, "AI_SMART_RETRIES", 2), retryDelaySec: delay, stream,
      requestTimeoutSec: timeout, connectTimeoutSec: connectTimeout,
      responseFormat: tierResponseFormat("smart", env),
      reasoningEffort: tierReasoningEffort("smart", env),
      // #998: the smart lane asserts its own endpoint capability; the base
      // flag never scopes a route that may point at another backend.
      anthropicEffortSupported: laneAnthropicEffortSupported("smart", env),
    },
    fallback: {
      ...fallback, resolved: Boolean(fallback.baseUrl && fallback.model), retries: numberValue(env, "AI_FALLBACK_RETRIES", 2), retryDelaySec: delay,
      stream: fallbackStream, requestTimeoutSec: numberValue(env, "AI_FALLBACK_REQUEST_TIMEOUT_SEC", timeout),
      connectTimeoutSec: numberValue(env, "AI_FALLBACK_CONNECT_TIMEOUT_SEC", connectTimeout),
      responseFormat: tierResponseFormat("fallback", env),
      // #998: availability recovery, never quality escalation — the fallback
      // lane inherits the base effort and has no override input of its own.
      reasoningEffort: tierReasoningEffort("fallback", env),
      // #998: like its effort, the fallback lane shares the base endpoint
      // assertion; it has no effort opt-in input of its own.
      anthropicEffortSupported: laneAnthropicEffortSupported("fallback", env),
    },
  };
}

export function tierRequestShape(profile: "primary" | "smart" | "fallback", env: EnvLike): "default" | "trailing_task" {
  if (profile === "fallback") return "default";
  const key = profile === "smart" || (env.REVIEW_CONTEXT_PROFILE ?? "").trim() === "smart"
    ? "SMART_REQUEST_SHAPE" : "PRIMARY_REQUEST_SHAPE";
  const shape = env[key];
  return shape === "trailing_task" ? "trailing_task" : "default";
}
