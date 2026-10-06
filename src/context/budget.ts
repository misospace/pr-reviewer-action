/** Port of `pr_reviewer/budget.py` (#706 PR 5b): the wall-clock budget for
 * best-effort enrichment. Once the budget elapses remaining phases are
 * skipped, so a review is never blocked on a slow upstream; the first time the
 * budget is found exhausted a single warning goes to stderr.
 *
 * The clocks are injectable so tests can drive budget exhaustion
 * deterministically: `BudgetTracker` reads its clock exactly as v2 does (once
 * at construction, twice per `ok()`), so an injected fake clock sees the same
 * call sequence. */

export type Clock = () => number;

export interface BudgetTrackerOptions {
  /** Seconds since the epoch (`time.time()`). */
  now?: Clock | undefined;
  warn?: ((line: string) => void) | undefined;
}

export class BudgetTracker {
  readonly start: number;
  readonly maxSeconds: number;
  private readonly now: Clock;
  private readonly warn: (line: string) => void;
  private budgetLogged = false;

  constructor(maxSeconds = 60, options: BudgetTrackerOptions = {}) {
    this.now = options.now ?? ((): number => Date.now() / 1000);
    this.warn = options.warn ?? ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
    this.start = this.now();
    this.maxSeconds = maxSeconds;
  }

  ok(): boolean {
    if (this.now() - this.start >= this.maxSeconds && !this.budgetLogged) {
      this.budgetLogged = true;
      this.warn("WARNING: enrichment budget exceeded");
    }
    return this.now() - this.start < this.maxSeconds;
  }

  /** Epoch seconds at which `ok()` turns false (used to cap in-flight work). */
  deadline(): number {
    return this.start + this.maxSeconds;
  }
}

/** `int(raw)` for the ASCII forms CPython accepts (sign, `_` separators,
 * surrounding whitespace); null where `int()` would raise. */
export function pyParseInt(raw: string): number | null {
  const text = raw.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) return null;
  return Number.parseInt(text.replaceAll("_", ""), 10);
}

/** Monotonic deadline helper: disabled (`deadline === null`) when the
 * budget is <= 0 or not given. */
export class DeadlineBudget {
  readonly deadline: number | null;
  private readonly monotonic: Clock;

  constructor(maxSeconds: number | null = null, monotonic: Clock = () => performance.now() / 1000) {
    this.monotonic = monotonic;
    this.deadline = maxSeconds === null || maxSeconds <= 0 ? null : monotonic() + maxSeconds;
  }

  /** `DeadlineBudget.from_env(name, default)`: an unparseable value falls
   * back to the default. */
  static fromEnv(env: Record<string, string | undefined>, name: string, fallback = 60, monotonic?: Clock): DeadlineBudget {
    const budget = pyParseInt(env[name] ?? String(fallback)) ?? fallback;
    return new DeadlineBudget(budget, monotonic);
  }

  exceeded(): boolean {
    return this.deadline !== null && this.monotonic() >= this.deadline;
  }
}
