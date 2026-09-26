import type { EnvLike } from "../tools/budget.js";

/**
 * Review routing and tier bindings, ported from scripts/sections/classification.sh
 * and scripts/model_call.sh. Resolution is pure and uses injected environment
 * values; post-primary heuristic escalation remains telemetry only (#721).
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
function value(env: EnvLike, key: string, fallback = ""): string { return env[key] || fallback; }
function numberValue(env: EnvLike, key: string, fallback: number): number {
  const parsed = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function trueValue(raw: string | undefined): boolean { return (raw ?? "").trim().toLowerCase() === "true"; }

export function resolveReviewRoute(input: {
  routingMode: string;
  routeSignals: string[];
  escalateOnRiskFlags: string[];
  smartModelResolved: boolean;
}): { route: ReviewRoute; reason: string } {
  if (input.routingMode.trim().toLowerCase() !== "auto") return { route: "legacy", reason: "routing off" };
  const candidates = `,${input.routeSignals.filter((x) => x !== "").join(",")},`;
  let matched = "";
  for (const raw of input.escalateOnRiskFlags) {
    const flag = raw.trim();
    if (!flag) continue;
    if (candidates.includes(`,${flag},`)) { matched = flag; break; }
  }
  if (matched) return input.smartModelResolved
    ? { route: "smart", reason: `risk match: ${matched}` }
    : { route: "primary", reason: `risk match: ${matched}, but no smart model configured` };
  return { route: "primary", reason: "no escalation flags matched" };
}

export function routeSignalsFromClassification(classification: Record<string, unknown>): string[] {
  const raw = Object.hasOwn(classification, "route_signals")
    ? (Array.isArray(classification.route_signals) ? classification.route_signals : [])
    : [...(Array.isArray(classification.risk_flags) ? classification.risk_flags : []), classification.pr_kind ?? ""];
  return raw.filter((signal) => signal !== "").map(String);
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
