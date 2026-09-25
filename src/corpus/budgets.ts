/** Tier-aware context budgets (#676): byte-exact port of `apply_context_limits`
 * plus the per-tier profile resolution in scripts/sections/config.sh
 * (lines 146-221).
 *
 * Contract preserved from v2:
 * - Named context modes (`normal`/`low`/`minimal`) set coarse byte budgets;
 *   an unknown mode falls through to `normal`.
 * - `MODEL_CONTEXT_TOKENS` (global) or `PRIMARY_/SMART_MODEL_CONTEXT_TOKENS`
 *   (tier) derive byte budgets from the model's real context window: the
 *   output-token headroom (`AI_MAX_TOKENS + 2000` tokens for completions,
 *   system prompt, standards section and formatting) is reserved FIRST, the
 *   remainder converts at ~3 bytes/token (deliberately under-filling), and
 *   MAX_DIFF / MAX_FILES take 60% / 15% of that byte pool with small floors.
 * - Tier overrides are capped at 166,666 usable tokens and REFUSE (error) a
 *   window that cannot fit the output headroom plus a 2000-token input
 *   budget; the legacy global setting floors at 2000 instead of refusing.
 * - The runtime budgets always reflect the PRIMARY tier; the smart tier
 *   profile is what `build_review_corpus smart` consumes (#658/#668). */

export class BudgetError extends Error {}

export interface TierBudgets {
  maxCorpus: number;
  maxDiff: number;
  maxFiles: number;
}

export interface BudgetInputs {
  /** MODEL_CONTEXT_TOKENS (global legacy override). */
  modelContextTokens?: string | undefined;
  /** PRIMARY_MODEL_CONTEXT_TOKENS. */
  primaryModelContextTokens?: string | undefined;
  /** SMART_MODEL_CONTEXT_TOKENS. */
  smartModelContextTokens?: string | undefined;
  /** AI_MAX_TOKENS (default 8192). */
  aiMaxTokens?: string | undefined;
  /** CONTEXT_LIMIT_MODE (default normal). */
  contextLimitMode?: string | undefined;
}

const DEFAULT_AI_MAX_TOKENS = 8192;

function positiveIntOrEmpty(value: string | undefined): string | null | undefined {
  if (value === undefined || value === "") {
    return undefined; // unset
  }
  // v2 validates tier overrides with `! =~ ^[0-9]+$ || -lt 1`: zero is
  // numeric but NOT positive, so it is rejected with the same error.
  return /^[0-9]+$/.test(value) && Number(value) >= 1 ? value : null; // null = invalid
}

function applyContextLimits(
  ctx: string | undefined,
  kind: "global" | "tier",
  aiMaxTokens: number,
  contextLimitMode: string,
): TierBudgets {
  const isTier = kind === "tier";
  if (ctx !== undefined && ctx !== "" && !/^[0-9]+$/.test(ctx)) {
    if (isTier) {
      throw new BudgetError("Invalid tier model context capacity: expected a positive integer");
    }
    // Global mode silently ignores a non-numeric value and falls back to the
    // named modes (v2 sets ctx="" and continues).
    return namedModeBudgets(contextLimitMode);
  }
  if (ctx !== undefined && ctx !== "" && Number(ctx) > 0) {
    // Reserve output tokens plus headroom for the system prompt, standards
    // section and formatting; convert the remainder to bytes conservatively
    // (~3 bytes/token, which under-fills rather than overflows).
    const reserve = aiMaxTokens + 2000;
    let usable = Number(ctx) - reserve;
    if (usable < 2000) {
      if (isTier) {
        throw new BudgetError(
          `Model context ${ctx} cannot fit AI_MAX_TOKENS=${aiMaxTokens} plus 2000 tokens of headroom and a 2000-token input budget`,
        );
      }
      usable = 2000;
    }
    // Explicit tier overrides cannot allocate an unbounded corpus. The legacy
    // global setting retains its historical calculation when no override is set.
    if (isTier && usable > 166666) {
      usable = 166666;
    }
    const totalBytes = usable * 3;
    let maxDiff = Math.trunc((totalBytes * 6) / 10);
    let maxFiles = Math.trunc((totalBytes * 15) / 100);
    if (maxDiff < 2000) maxDiff = 2000;
    if (maxFiles < 1000) maxFiles = 1000;
    return { maxCorpus: totalBytes, maxDiff, maxFiles };
  }
  return namedModeBudgets(contextLimitMode);
}

function namedModeBudgets(contextLimitMode: string): TierBudgets {
  switch (contextLimitMode) {
    case "minimal":
      return { maxCorpus: 60000, maxDiff: 40000, maxFiles: 20000 };
    case "low":
      return { maxCorpus: 120000, maxDiff: 80000, maxFiles: 40000 };
    default:
      // normal|*
      return { maxCorpus: 220000, maxDiff: 140000, maxFiles: 70000 };
  }
}

/** Resolve each final-review tier once (v2 lines 198-221). Throws
 * `BudgetError` with the v2-identical message when a tier token override is
 * invalid or cannot fit the output headroom; the caller decides whether that
 * aborts the run (v2: `exit 1`). */
export function resolveTierBudgets(inputs: BudgetInputs): { primary: TierBudgets; smart: TierBudgets } {
  const aiMaxTokens = inputs.aiMaxTokens !== undefined && inputs.aiMaxTokens !== ""
    ? Number(inputs.aiMaxTokens)
    : DEFAULT_AI_MAX_TOKENS;
  const contextLimitMode = inputs.contextLimitMode ?? "normal";

  // v2 validates the tier variables up front with per-variable messages.
  for (const tier of ["PRIMARY", "SMART"] as const) {
    const raw = tier === "PRIMARY" ? inputs.primaryModelContextTokens : inputs.smartModelContextTokens;
    const checked = positiveIntOrEmpty(raw);
    if (checked === null) {
      throw new BudgetError(`Invalid ${tier}_MODEL_CONTEXT_TOKENS: expected a positive integer`);
    }
  }

  const global = positiveIntOrEmpty(inputs.modelContextTokens);
  if (global === null) {
    // Non-numeric global override: v2's apply_context_limits logs and falls
    // back to the named modes (only in global position).
    const fallback = namedModeBudgets(contextLimitMode);
    return resolveFrom(fallback, inputs, aiMaxTokens, contextLimitMode);
  }

  const base = applyContextLimits(inputs.modelContextTokens, "global", aiMaxTokens, contextLimitMode);
  return resolveFrom(base, inputs, aiMaxTokens, contextLimitMode);
}

function resolveFrom(
  base: TierBudgets,
  inputs: BudgetInputs,
  aiMaxTokens: number,
  contextLimitMode: string,
): { primary: TierBudgets; smart: TierBudgets } {
  let primary = base;
  let smart = base;
  if (inputs.primaryModelContextTokens !== undefined && inputs.primaryModelContextTokens !== "") {
    primary = applyContextLimits(inputs.primaryModelContextTokens, "tier", aiMaxTokens, contextLimitMode);
  }
  if (inputs.smartModelContextTokens !== undefined && inputs.smartModelContextTokens !== "") {
    smart = applyContextLimits(inputs.smartModelContextTokens, "tier", aiMaxTokens, contextLimitMode);
  }
  return { primary, smart };
}
