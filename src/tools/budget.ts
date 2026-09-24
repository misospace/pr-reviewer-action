/**
 * Tier-aware native tool-loop request budget (#701).
 *
 * The request budget follows the review route instead of one global ceiling:
 * the primary route keeps a conservative budget, the smart route gets more
 * headroom, and the escalated (deep) path gets the most — never above the
 * hard safety ceiling. Explicit user configuration always wins, bounded to
 * 1..TOOL_REQUEST_HARD_MAX; an unparsable value falls through to the next
 * source, never widening the budget.
 *
 * This module is the v3 port of `tool_budget_route` /
 * `resolve_tool_max_requests` in scripts/run_tool_harness.py. The two MUST
 * stay in lockstep: tests/fixtures/parity/tool-budget/ pins the shared
 * behavior through the parity harness (#673) so the #678 migration cannot
 * regress to a single undifferentiated request ceiling.
 *
 * The Python side reads os.environ; this side takes the environment as a
 * plain record so the resolver is pure and the parity mode can evaluate
 * fixture cases without process-global state. The production caller passes
 * `process.env`.
 */

export type ToolBudgetTier = "primary" | "smart" | "escalated";

export const TOOL_REQUEST_HARD_MAX = 20;

export const TOOL_REQUEST_TIER_DEFAULTS: Readonly<
  Record<ToolBudgetTier, number>
> = Object.freeze({ primary: 8, smart: 16, escalated: 20 });

export type EnvLike = Readonly<Record<string, string | undefined>>;

function flagTrue(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/**
 * int()-shaped parse: optional sign, digits with Python-style between-digit
 * underscores, then clamp to [1, TOOL_REQUEST_HARD_MAX]. Anything else
 * returns null so the caller falls through to the next budget source.
 */
function clampedPositive(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (!/^[+-]?[0-9]+(_[0-9]+)*$/.test(text)) return null;
  const value = Number(text.replaceAll("_", ""));
  return Math.max(1, Math.min(TOOL_REQUEST_HARD_MAX, value));
}

/**
 * Classify a harness run's budget tier. Mirrors tool_budget_route:
 *   primary   — the ordinary primary-tier harness run;
 *   smart     — a directly routed smart review (REVIEW_CONTEXT_PROFILE=smart)
 *               or the smart-tier harness run;
 *   escalated — the smart-tier harness run under post-review escalation
 *               (run_review.sh exports TOOL_ESCALATION=true around it).
 */
export function toolBudgetRoute(tier: string, env: EnvLike): ToolBudgetTier {
  if (tier === "smart") {
    return flagTrue(env.TOOL_ESCALATION) ? "escalated" : "smart";
  }
  if ((env.REVIEW_CONTEXT_PROFILE ?? "").trim().toLowerCase() === "smart") {
    return "smart";
  }
  return "primary";
}

/**
 * Resolve the effective native-loop request budget for one harness run.
 * Precedence: SMART_TOOL_MAX_REQUESTS (smart/escalated only) >
 * TOOL_MAX_REQUESTS > the route's tier default.
 */
export function resolveToolMaxRequests(
  tier: string,
  env: EnvLike,
): { route: ToolBudgetTier; budget: number } {
  const route = toolBudgetRoute(tier, env);
  if (route !== "primary") {
    const tierOverride = clampedPositive(env.SMART_TOOL_MAX_REQUESTS);
    if (tierOverride !== null) return { route, budget: tierOverride };
  }
  const explicit = clampedPositive(env.TOOL_MAX_REQUESTS);
  if (explicit !== null) return { route, budget: explicit };
  return { route, budget: TOOL_REQUEST_TIER_DEFAULTS[route] };
}
