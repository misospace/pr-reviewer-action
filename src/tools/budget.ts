/**
 * Tier-aware native tool-loop request budget (#701), scaled by PR size
 * (#810).
 *
 * The request budget follows the review route instead of one global ceiling:
 * the primary route keeps a conservative budget, the smart route gets more
 * headroom, and the escalated (deep) path gets the most — never above the
 * hard safety ceiling. Explicit user configuration always wins, bounded to
 * 1..TOOL_REQUEST_HARD_MAX; an unparsable value falls through to the next
 * source, never widening the budget.
 *
 * #810: when no explicit override wins, the default is derived from the PR's
 * changed-file count, changed lines and specialist-lead count, floored at the
 * route's tier default (so a small PR's budget matches the pre-#810 value
 * exactly) and capped at the hard ceiling. The derivation needs workspace
 * artifacts (pr.json / pr-files.json / specialist-*.json); when the caller
 * supplies no size signal the tier default is used as-is — which is exactly
 * what the tool-request-budget fixture (#673) exercises, so the fixture pins
 * the tier default with no size signal.
 *
 * This module is the v3 port of `tool_budget_route` /
 * `resolve_tool_max_requests` in scripts/run_tool_harness.py. The two stay
 * in lockstep on the explicit/override precedence and the smart/escalated
 * tier defaults: tests/fixtures/parity/tool-budget/ pins the shared behavior
 * through the parity harness (#673) so the #678 migration cannot regress to a
 * single undifferentiated request ceiling. They deliberately differ on the
 * primary tier default (v3 24, v2 16), pinned by the tool-request-budget
 * snapshots, and the size-scaled default is v3-only (#810).
 *
 * The Python side reads os.environ; this side takes the environment as a
 * plain record so the resolver is pure and the parity mode can evaluate
 * fixture cases without process-global state. The production caller passes
 * `process.env`.
 */

import { SPECIALIST_ROLES_ORDER } from "../specialists/types.js";

export type ToolBudgetTier = "primary" | "smart" | "escalated";

/**
 * Where the effective ceiling came from (#702 budget provenance). Part of
 * the telemetry contract the parity fixture pins: primary-override / smart-override >
 * explicit > tier-default, matching resolve_tool_budget in
 * scripts/run_tool_harness.py. `size-scaled` (#810) replaces `tier-default`
 * only when the PR-size derivation strictly exceeds the tier default; when
 * the floor binds, the tier default is what won and the source says so.
 */
export type ToolBudgetSource = "primary-override" | "smart-override" | "explicit" | "tier-default" | "size-scaled";

export const TOOL_REQUEST_HARD_MAX = 50;

export const TOOL_REQUEST_TIER_DEFAULTS: Readonly<
  Record<ToolBudgetTier, number>
> = Object.freeze({ primary: 24, smart: 32, escalated: 40 });

/**
 * PR-size weights for the #810 scaled default. One request per few changed
 * files, one per block of changed lines, and a fixed allowance per
 * specialist lead (each lead is a hypothesis that needs its own
 * verification calls). Provider-, model- and forge-agnostic by
 * construction: the inputs are diff sizes and lead counts, nothing else.
 */
export const TOOL_BUDGET_FILES_PER_REQUEST = 4;
export const TOOL_BUDGET_LINES_PER_REQUEST = 400;
export const TOOL_BUDGET_REQUESTS_PER_LEAD = 2;

/** PR-size signal for the #810 scaled default, in changed PR units. */
export interface ToolBudgetSizeInput {
  changedFiles: number;
  changedLines: number;
  specialistLeads: number;
}

function countOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Load the #810 size signal from the harness workspace artifacts the loop
 * can already see: pr.json (the PR-level totals, which survive the 100-file
 * manifest cap) with pr-files.json as the fallback, plus the per-role
 * specialist-*.json lead artifacts. Every read is tolerant: an absent or
 * unparsable artifact contributes zero, so a workspace without size signals
 * degrades to the tier default. Pure over the injected reader.
 */
export function toolBudgetSizeFromArtifacts(
  read: (name: string) => string | null,
): ToolBudgetSizeInput {
  const parse = (name: string): unknown => {
    const body = read(name);
    if (body === null || body.trim() === "") return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  };

  let changedFiles = 0;
  let changedLines = 0;
  const pr = parse("pr.json");
  if (pr !== null && typeof pr === "object" && !Array.isArray(pr)) {
    const record = pr as Record<string, unknown>;
    changedFiles = countOf(record.changedFiles);
    const additions = Number(record.additions);
    const deletions = Number(record.deletions);
    if (Number.isFinite(additions) && Number.isFinite(deletions) && additions >= 0 && deletions >= 0) {
      changedLines = Math.trunc(additions + deletions);
    }
  }
  const manifest = parse("pr-files.json");
  const entries =
    Array.isArray(manifest)
      ? manifest
      : manifest !== null && typeof manifest === "object" && Array.isArray((manifest as Record<string, unknown>).files)
        ? (manifest as Record<string, unknown>).files as unknown[]
        : [];
  let manifestFiles = 0;
  let manifestLines = 0;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.filename !== "string" || record.filename === "") continue;
    manifestFiles += 1;
    const additions = Number(record.additions);
    const deletions = Number(record.deletions);
    if (Number.isFinite(additions) && Number.isFinite(deletions) && additions >= 0 && deletions >= 0) {
      manifestLines += Math.trunc(additions + deletions);
    } else {
      const changes = Number(record.changes);
      if (Number.isFinite(changes) && changes >= 0) manifestLines += Math.trunc(changes);
    }
  }
  if (changedFiles === 0) changedFiles = manifestFiles;
  if (changedLines === 0) changedLines = manifestLines;

  let specialistLeads = 0;
  for (const role of SPECIALIST_ROLES_ORDER) {
    const artifact = parse(`specialist-${role}.json`);
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) continue;
    const leads = (artifact as Record<string, unknown>).leads;
    if (Array.isArray(leads)) specialistLeads += leads.length;
  }

  return { changedFiles, changedLines, specialistLeads };
}

/**
 * The #810 size-scaled default: enough requests to touch the diff at the
 * weights above, floored at the route's tier default (a small PR keeps
 * today's budget) and capped at the hard ceiling.
 */
export function sizeScaledToolBudget(size: ToolBudgetSizeInput, route: ToolBudgetTier): number {
  const derived =
    Math.ceil(countOf(size.changedFiles) / TOOL_BUDGET_FILES_PER_REQUEST) +
    Math.ceil(countOf(size.changedLines) / TOOL_BUDGET_LINES_PER_REQUEST) +
    countOf(size.specialistLeads) * TOOL_BUDGET_REQUESTS_PER_LEAD;
  return Math.min(
    TOOL_REQUEST_HARD_MAX,
    Math.max(TOOL_REQUEST_TIER_DEFAULTS[route], derived),
  );
}

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
 * Precedence: PRIMARY_TOOL_MAX_REQUESTS (primary only) or
 * SMART_TOOL_MAX_REQUESTS (smart/escalated only) >
 * TOOL_MAX_REQUESTS > the #810 size-scaled default (floored at the route's
 * tier default; without a `size` signal this is exactly the tier default).
 * The `source` reports which input won and `configured` echoes the winning
 * explicit integer (null for the derived defaults) — the #702 provenance
 * fields the loop telemetry carries, kept in lockstep with resolve_tool_budget.
 */
export function resolveToolMaxRequests(
  tier: string,
  env: EnvLike,
  size?: ToolBudgetSizeInput | null,
): { route: ToolBudgetTier; budget: number; source: ToolBudgetSource; configured: number | null } {
  const route = toolBudgetRoute(tier, env);
  const [tierVar, tierSource]: [string | undefined, ToolBudgetSource] = route === "primary"
    ? [env.PRIMARY_TOOL_MAX_REQUESTS, "primary-override"]
    : [env.SMART_TOOL_MAX_REQUESTS, "smart-override"];
  const tierOverride = clampedPositive(tierVar);
  if (tierOverride !== null) {
    return { route, budget: tierOverride, source: tierSource, configured: tierOverride };
  }
  const explicit = clampedPositive(env.TOOL_MAX_REQUESTS);
  if (explicit !== null) {
    return { route, budget: explicit, source: "explicit", configured: explicit };
  }
  if (size !== undefined && size !== null) {
    const scaled = sizeScaledToolBudget(size, route);
    if (scaled > TOOL_REQUEST_TIER_DEFAULTS[route]) {
      return { route, budget: scaled, source: "size-scaled", configured: null };
    }
  }
  return {
    route,
    budget: TOOL_REQUEST_TIER_DEFAULTS[route],
    source: "tier-default",
    configured: null,
  };
}
