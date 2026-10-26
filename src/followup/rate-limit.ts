/** Deterministic follow-up rate limiting (#763).
 *
 * A sliding-window counter keyed by an opaque scope (per-PR, per-actor, …).
 * It is clock-injected so a decision is a pure function of the recorded
 * instants and the caller-supplied `now` — no wall clock, no hidden state
 * that a test could not reproduce, matching the codebase's injected-clock
 * convention. The store is an INTERFACE so the durable operator controller can
 * back it with persistent state across runs; the in-memory implementation here
 * is the deterministic control surface (and what the loop/run-level budget
 * exercises), and an embedding that needs cross-run enforcement injects its
 * own store without touching the planner.
 *
 * Counting semantics: an event recorded at instant `t` counts for the window
 * `(now - windowMs, now]` — i.e. strictly within the last `windowMs`. A request
 * is allowed while its scope has FEWER than `limit` events in the window; the
 * check NEVER records (recording is a separate, explicit step the caller takes
 * only after EVERY scope it enforces has allowed), so a denied follow-up cannot
 * consume budget and a caller enforcing several scopes at once does not
 * half-charge any of them.
 */

/** A single-window budget: at most `limit` events per `windowMs` for one key. */
export interface RateLimitRule {
  /** Maximum events allowed in the window. A limit <= 0 always denies. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** The rate-limit state a planner needs: count a scope's recent events, and
 * (separately) record a fresh event for it. Implementations must prune older
 * events so `countInWindow` reflects only the requested window. */
export interface RateLimitStore {
  /** Number of recorded events for `key` in `(nowMs - windowMs, nowMs]`. */
  countInWindow(key: string, windowMs: number, nowMs: number): number;
  /** Record one event for `key` at `nowMs`. */
  record(key: string, nowMs: number): void;
}

/** Default cap on distinct tracked keys, so an unbounded stream of distinct
 * scopes cannot grow the in-memory store without limit. Over the cap the
 * oldest-inserted key is evicted (Map iteration order is insertion order). */
export const MAX_RATE_LIMIT_KEYS = 10_000;

/** In-memory sliding-window store. Deterministic given the sequence of
 * (key, nowMs) calls; intended for a single process/run. Evicts a key once its
 * last event has aged out of every plausible window is NOT attempted (a key is
 * only dropped on an over-cap insert or when it becomes empty after a prune in
 * `countInWindow`), which bounds memory at `maxKeys` live scopes. */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly events: Map<string, number[]> = new Map();
  private readonly maxKeys: number;

  constructor(maxKeys: number = MAX_RATE_LIMIT_KEYS) {
    this.maxKeys = maxKeys >= 1 ? Math.floor(maxKeys) : 1;
  }

  countInWindow(key: string, windowMs: number, nowMs: number): number {
    const list = this.events.get(key);
    if (list === undefined) return 0;
    const windowStart = nowMs - Math.max(0, windowMs);
    const recent = list.filter((t) => t > windowStart);
    if (recent.length === 0) {
      this.events.delete(key);
    } else if (recent.length !== list.length) {
      this.events.set(key, recent);
    }
    return recent.length;
  }

  record(key: string, nowMs: number): void {
    let list = this.events.get(key);
    if (list === undefined) {
      if (this.events.size >= this.maxKeys) {
        const oldest = this.events.keys().next();
        if (!oldest.done) this.events.delete(oldest.value);
      }
      list = [];
      this.events.set(key, list);
    }
    list.push(nowMs);
  }
}

/** One scope's rule paired with its store key. */
export interface RateLimitScope {
  key: string;
  rule: RateLimitRule;
}

/** Decide a multi-scope follow-up budget in one atomic pass: allowed only when
 * EVERY scope is under its limit; then record the event for every scope. A
 * denied decision records nothing. Returns whether it was allowed (the caller
 * maps a denial to the `rate-limited` ignore reason). */
export function consumeFollowUpBudget(
  store: RateLimitStore,
  scopes: readonly RateLimitScope[],
  nowMs: number,
): { allowed: boolean } {
  for (const scope of scopes) {
    const limit = Math.floor(scope.rule.limit);
    // A non-positive limit OR a non-positive window proves nothing usable; a
    // zero-length window would otherwise count nothing and silently ALLOW
    // unlimited traffic. Fail closed on a malformed rule rather than open.
    if (limit <= 0 || Math.floor(scope.rule.windowMs) <= 0) return { allowed: false };
    if (store.countInWindow(scope.key, scope.rule.windowMs, nowMs) >= limit) {
      return { allowed: false };
    }
  }
  for (const scope of scopes) store.record(scope.key, nowMs);
  return { allowed: true };
}
