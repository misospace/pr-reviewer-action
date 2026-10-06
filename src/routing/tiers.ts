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
  transport: { baseUrl: string; model: string; apiFormat: string; apiKey: string };
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

  return { profileActive, transport, roleModels, overridesActive, warnings };
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
    primary: { ...primary, resolved: Boolean(primary.model), retries: primaryRetries, retryDelaySec: delay, stream, requestTimeoutSec: timeout, connectTimeoutSec: connectTimeout },
    smart: { ...smart, resolved: smartResolved, retries: numberValue(env, "AI_SMART_RETRIES", 2), retryDelaySec: delay, stream, requestTimeoutSec: timeout, connectTimeoutSec: connectTimeout },
    fallback: {
      ...fallback, resolved: Boolean(fallback.baseUrl && fallback.model), retries: numberValue(env, "AI_FALLBACK_RETRIES", 2), retryDelaySec: delay,
      stream: fallbackStream, requestTimeoutSec: numberValue(env, "AI_FALLBACK_REQUEST_TIMEOUT_SEC", timeout),
      connectTimeoutSec: numberValue(env, "AI_FALLBACK_CONNECT_TIMEOUT_SEC", connectTimeout),
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
