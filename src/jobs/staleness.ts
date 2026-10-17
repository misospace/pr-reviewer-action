/** Result staleness predicates (#728): the exact-head rule a controller
 * applies to a worker's result before it may publish.
 *
 * These generalize the enforcement points that already exist in the
 * running pipeline: the precheck's superseded-head guard
 * (`src/precheck/decide.ts`) and the publication-boundary head re-check
 * (`src/publish/publish.ts`). The rule is the same: a result computed for
 * head A must never publish over head B, and an unknown head fails
 * closed.
 */

import type { ReviewJob } from "./types.js";

/** Normalize a SHA for comparison: trim, then lowercase. */
function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/** A git commit SHA: 7–64 hex chars (the adapter boundary's form). */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** True when the result's head is stale against the current head: the
 * normalized (trim + lowercase) heads differ, or EITHER side fails the
 * SHA form (fail closed — an empty or malformed head means freshness is
 * unknowable, so treat as stale). */
export function isResultStale(resultHeadSha: string, currentHeadSha: string): boolean {
  const result = normalizeSha(resultHeadSha);
  const current = normalizeSha(currentHeadSha);
  if (!SHA_PATTERN.test(result) || !SHA_PATTERN.test(current)) return true;
  return result !== current;
}

/** True when the worker's result is both fresh (see `isResultStale`) and
 * for the job's own head. The controller passes the freshly fetched
 * current head, so it can decide staleness without trusting the worker. */
export function resultMatchesJob(
  job: ReviewJob,
  resultHeadSha: string,
  currentHeadSha: string,
): boolean {
  if (isResultStale(resultHeadSha, currentHeadSha)) return false;
  return normalizeSha(resultHeadSha) === normalizeSha(job.headSha);
}

/** True when the job's deadline has passed. A 0 deadline means "no
 * deadline" and never expires. A non-finite clock (`NaN`, `±Infinity`)
 * means the deadline state is unknowable, so the check fails closed:
 * the job is treated as expired. */
export function isExpired(job: ReviewJob, nowMs: number): boolean {
  if (job.deadlineAtMs === 0) return false;
  if (!Number.isFinite(nowMs)) return true;
  return nowMs >= job.deadlineAtMs;
}
