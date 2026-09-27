/** Wall-clock bound for one CI-polling API attempt — the port of
 * `_gh_api_bounded`'s bound arithmetic (scripts/platform_api.sh, #663).
 *
 * The bound is `CI_API_TIMEOUT_SEC` (default 10, integer seconds; anything
 * else falls back to 10), clamped to `CI_TIMEOUT_SEC` when that is a smaller
 * integer, and — when `CI_DEADLINE_EPOCH` is an integer — to the outer budget
 * REMAINING when the attempt starts, so sequential attempts share one
 * deadline. An exhausted deadline skips the attempt entirely (`null`). */

import type { CiBoundOptions } from "./types.js";

const DIGITS = /^[0-9]+$/;

export function ciAttemptTimeoutMs(options: CiBoundOptions = {}): number | null | undefined {
  const raw = options.apiTimeoutSec ?? "";
  let bound = DIGITS.test(raw) ? Number(raw) : 10;
  // curl's `--max-time 0` means no per-attempt limit: only the outer budget
  // bounds it, or, with none, the transport default.
  const unbounded = bound === 0;
  const outer = options.ciTimeoutSec ?? "";
  if (DIGITS.test(outer) && (unbounded || bound > Number(outer)) && Number(outer) > 0) bound = Number(outer);
  const deadline = options.deadlineEpoch ?? "";
  if (DIGITS.test(deadline)) {
    const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
    const remaining = Number(deadline) - nowSec;
    if (remaining < 1) return null;
    if (bound === 0 || bound > remaining) bound = remaining;
  }
  return bound === 0 ? undefined : bound * 1000;
}

/** The v3 CI gate's transient-read rule (`ExternalChecksOptions
 * .transientAsUnknown`, #706 PR 6): a CI read counts as an answer only when
 * a response arrived (`status` non-null), was neither 429 nor 5xx, and
 * carried a JSON body. Anything else is "unknown, retry" — never "no
 * external CI". */
export function isTransientCiRead(status: number | null, text: string): boolean {
  if (status === null || status === 0 || status === 429 || status >= 500) return true;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}
