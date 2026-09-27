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

export function ciAttemptTimeoutMs(options: CiBoundOptions = {}): number | null {
  const raw = options.apiTimeoutSec ?? "";
  let bound = DIGITS.test(raw) ? Number(raw) : 10;
  const outer = options.ciTimeoutSec ?? "";
  if (DIGITS.test(outer) && bound > Number(outer)) bound = Number(outer);
  const deadline = options.deadlineEpoch ?? "";
  if (DIGITS.test(deadline)) {
    const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
    const remaining = Number(deadline) - nowSec;
    if (remaining < 1) return null;
    if (bound > remaining) bound = remaining;
  }
  return bound * 1000;
}
