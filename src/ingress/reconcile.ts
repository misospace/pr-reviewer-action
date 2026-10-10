/** Missed-webhook reconciliation poll for the self-hosted Forgejo controller
 * (#730).
 *
 * Convergence invariant: a poll of the same PR/head/config MUST converge on
 * the SAME generation id the webhook would have minted, because identity is
 * `deriveGenerationId`'s field set alone — the trigger (`source`) and the
 * reason (event `kind`) are excluded from it. That is what makes the ledger
 * suppress the duplicate: a missed webhook discovers exactly one job, and a
 * discovered-but-already-known head discovers none.
 *
 * Raw PR payloads from the lister are passed UNTOUCHED to
 * `reconciliationPollEvent`; nothing in this module interprets them.
 */

import { reconciliationPollEvent } from "../events/normalize.js";
import { buildReviewJob } from "../jobs/generation.js";
import type { BuildJobOptions, ReviewJob } from "../jobs/types.js";
import type { ReadResult } from "./api-client.js";
import type { GenerationLedger } from "./dispatch.js";

/** One reconciliation pass. `discovered` counts EVERY array entry the lister
 * returned (including ones that fail normalization); `skipped` counts every
 * discovered entry that was not scheduled (unnormalizable, unbuildable, or
 * already known to the ledger). */
export interface ReconcileReport {
  readonly jobs: readonly ReviewJob[];
  readonly discovered: number;
  readonly skipped: number;
  readonly failedRepositories: readonly string[];
}

export interface ReconcileOptions {
  readonly listOpenPullRequests: (repo: string) => Promise<ReadResult<unknown[]>>;
  readonly repos: readonly string[];
  readonly ledger: GenerationLedger;
  readonly buildOptions?: BuildJobOptions | undefined;
  readonly installationId?: string | undefined;
}

/** Poll every configured repository and schedule the review generations the
 * ledger has not seen yet. Never throws: a failed or throwing repository is
 * reported in `failedRepositories` and the pass continues. */
export async function reconcileForgejoRepositories(
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const jobs: ReviewJob[] = [];
  const failed: string[] = [];
  let discovered = 0;
  let skipped = 0;
  for (const repo of options.repos) {
    try {
      const listed = await options.listOpenPullRequests(repo);
      if (!listed.ok) {
        failed.push(repo);
        continue;
      }
      for (const entry of listed.data) {
        discovered += 1;
        const event = reconciliationPollEvent(
          "forgejo",
          entry,
          options.installationId === undefined ? {} : { installationId: options.installationId },
        );
        if (event === null) {
          skipped += 1;
          continue;
        }
        const job = buildReviewJob(event, options.buildOptions ?? {});
        if (job === null) {
          skipped += 1;
          continue;
        }
        if (!(await options.ledger.addIfAbsent(job.jobId))) {
          skipped += 1;
          continue;
        }
        jobs.push(job);
      }
    } catch {
      failed.push(repo);
    }
  }
  return Object.freeze({
    jobs: Object.freeze([...jobs]),
    discovered,
    skipped,
    failedRepositories: Object.freeze([...failed]),
  });
}