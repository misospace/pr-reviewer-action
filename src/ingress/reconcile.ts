/** Missed-webhook reconciliation poll for the self-hosted controller
 * (#730 Forgejo, #729 GitHub App).
 *
 * PLATFORM: the pass is platform-agnostic — the GitHub App capability
 * client and the Forgejo ingress client expose the same
 * `listOpenPullRequests` lister — and the caller declares WHICH forge it
 * polls through `options.platform`. The platform is part of the canonical
 * event's identity, so a poll MUST name it: a poll mislabelled as the
 * other platform would mint a DIFFERENT generation than the webhook
 * delivery of the same head, and the two would never converge.
 *
 * Convergence invariant: a poll of the same PR/head/config MUST converge on
 * the SAME generation id the webhook would have minted, because identity is
 * `deriveGenerationId`'s field set alone — the trigger (`source`) and the
 * reason (event `kind`) are excluded from it. That is what makes the ledger
 * suppress the duplicate: a missed webhook discovers exactly one job, and a
 * discovered-but-already-known head discovers none.
 *
 * Poll-scope binding (#1025): the adapter only schedules jobs for the
 * repository it polled. An entry whose normalized target repository
 * disagrees with `options.repos` (either via the envelope
 * `repository.full_name` or via `base.repo.full_name` when the envelope is
 * absent) is reported in `skipped` and never reserves a generation id —
 * the normalizer's resolved `repoFullName` IS the target identity, so a
 * cross-repo response cannot piggy-back on the configured repo's ledger
 * reservation. Forks (head.repo differs from base.repo) are preserved
 * because the normalizer already keys the target on `base.repo.full_name`.
 *
 * Raw PR payloads from the lister are passed UNTOUCHED to
 * `reconciliationPollEvent`; nothing in this module interprets them.
 */

import { DIAGNOSTIC_MAX_CHARS, maskDiagnostic } from "../context/redact.js";
import { reconciliationPollEvent, normalizeRepoFullName } from "../events/normalize.js";
import { buildReviewJob } from "../jobs/generation.js";
import type { BuildJobOptions, ReviewJob } from "../jobs/types.js";
import type { ReadResult } from "./api-client.js";
import type { GenerationLedger } from "./dispatch.js";

/** One reconciliation pass. `discovered` counts EVERY array entry the lister
 * returned (including ones that fail normalization); `skipped` counts every
 * discovered entry that was not scheduled (unnormalizable, unbuildable,
 * already known to the ledger, or refused by the queue handoff). */
export interface ReconcileReport {
  readonly jobs: readonly ReviewJob[];
  readonly discovered: number;
  readonly skipped: number;
  readonly failedRepositories: readonly string[];
  /** WHY each queue handoff was refused (#1445), next to the `skipped`
   * count that alone cannot explain itself. A refused head releases its
   * reservation and is re-discovered on every later pass, so without the
   * reason a permanently refused head is silent and the operator has to
   * reconstruct the cause from source. Bounded on purpose: at most
   * `MAX_HANDOFF_REFUSALS` entries, and every `reason` is a single line
   * passed through `maskDiagnostic` (secret masking, credential-shape
   * redaction, `DIAGNOSTIC_MAX_CHARS` cap) because a throw from arbitrary
   * operator handoff code is untrusted diagnostic text. */
  readonly handoffRefusals: readonly ReconcileHandoffRefusal[];
}

/** One refused queue handoff: the configured repository the entry was
 * polled from (same identity `failedRepositories` reports) and a bounded,
 * redacted one-line reason. */
export interface ReconcileHandoffRefusal {
  readonly repo: string;
  readonly reason: string;
}

/** Cap on reported refusals per pass: refusals exist to diagnose, not to
 * grow the report without bound on a queue that refuses everything.
 * Refusals past the cap are still counted in `skipped`. */
const MAX_HANDOFF_REFUSALS = 25;

/** Reason recorded when the handoff simply returns `false` (or throws a
 * value carrying no usable message): the refusal itself is the whole
 * information the operator code offered. */
const HANDOFF_REFUSED_REASON = "the queue handoff refused the job";

/** Turn a thrown handoff value into a safe reason string: an `Error`'s
 * (or a bare string's) message, control characters and newlines collapsed
 * so the reason stays a single line, then the shared `maskDiagnostic`
 * recipe (known-secret masking, credential-shape heuristics, length cap).
 * Anything else thrown yields the generic refusal reason — the pass must
 * never itself fail while describing a refusal. */
function describeHandoffRefusal(error: unknown): string {
  const message =
    error instanceof Error
      ? typeof error.message === "string"
        ? error.message
        : ""
      : typeof error === "string"
        ? error
        : "";
  // Same class as `CELL_BREAK_RE` (src/gates/ci-wait.ts): C0, DEL, C1, and
  // the Unicode line/paragraph separators — NEL/LS/PS end a rendered line
  // just as well as \n and would let a reason forge log/report structure.
  const singleLine = message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return maskDiagnostic(
    singleLine === "" ? HANDOFF_REFUSED_REASON : singleLine,
    [],
    DIAGNOSTIC_MAX_CHARS,
  );
}

export interface ReconcileOptions {
  /** The forge platform the poll observes. It is part of the canonical
   * event's identity, so a poll MUST name the platform it polls: a poll
   * mislabelled as the other platform would mint a DIFFERENT generation
   * than the webhook delivery of the same head, and the two would never
   * converge. */
  readonly platform: "github" | "forgejo";
  readonly listOpenPullRequests: (repo: string) => Promise<ReadResult<unknown[]>>;
  readonly repos: readonly string[];
  readonly ledger: GenerationLedger;
  readonly buildOptions?: BuildJobOptions | undefined;
  readonly installationId?: string | undefined;
  /** The queue handoff for the discovered generations (the same seam the
   * follow-up host uses). When provided, each minted job is handed over
   * here and a REFUSED handoff releases the durable reservation — the
   * dispatch contract — so the head is re-discovered on the next pass
   * instead of staying suppressed until the claim's horizon expires.
   *
   * Absent → the caller owns the handoff AND the release: a caller that
   * enqueues the returned jobs itself MUST release the reservation when
   * its handoff fails (`ledger.remove(job.jobId)`). */
  readonly enqueueJob?: ((job: ReviewJob) => boolean | Promise<boolean>) | undefined;
}

/** Poll every configured repository and schedule the review generations the
 * ledger has not seen yet. Never throws: a failed or throwing repository is
 * reported in `failedRepositories` and the pass continues.
 *
 * The pass is PLATFORM-AGNOSTIC: the GitHub App capability client and the
 * Forgejo ingress client both expose the same `listOpenPullRequests`
 * lister, so one reconciliation implementation serves both forges — the
 * platform is the caller's declaration of WHICH forge it polls. */
export async function reconcileRepositories(
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const jobs: ReviewJob[] = [];
  const failed: string[] = [];
  const refusals: ReconcileHandoffRefusal[] = [];
  let discovered = 0;
  let skipped = 0;
  for (const rawRepo of options.repos) {
    // The polled target identity in the normalizer's own canonical form,
    // so the per-entry scope check below uses the SAME definition the
    // normalizer derived `event.repoFullName` with (#1025) — case and
    // whitespace differences never bypass the boundary.
    const targetRepo = normalizeRepoFullName(rawRepo);
    if (targetRepo === "") {
      failed.push(rawRepo);
      continue;
    }
    try {
      const listed = await options.listOpenPullRequests(rawRepo);
      if (!listed.ok) {
        failed.push(rawRepo);
        continue;
      }
      for (const entry of listed.data) {
        discovered += 1;
        const event = reconciliationPollEvent(
          options.platform,
          entry,
          options.installationId === undefined ? {} : { installationId: options.installationId },
        );
        if (event === null) {
          skipped += 1;
          continue;
        }
        // Scope binding (#1025): an entry whose normalized target
        // repository disagrees with the polled `targetRepo` is not in
        // scope and MUST NOT mint a job or reserve a generation id. The
        // normalizer already prefers `repository.full_name` over
        // `base.repo.full_name`, so either conflict surfaces here.
        // Legitimate forks resolve to `base.repo.full_name` and so
        // still match — the head repo is intentionally NOT compared.
        if (event.repoFullName !== targetRepo) {
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
        // The reservation is taken; the job is handed over. A REFUSED
        // handoff releases it (the dispatch contract), so the head is
        // re-discovered on the next pass instead of staying suppressed
        // until the claim's horizon expires. #1445: the refusal also
        // records WHY on the report — the handoff's `false`, or the
        // thrown value's bounded and redacted message (e.g. #1444's
        // RangeError naming the remedy for an ambiguous forge
        // integration) — because a re-discovered-and-refused-every-pass
        // head is otherwise silent. The catch stays total: describing a
        // refusal must never abort the pass.
        if (options.enqueueJob !== undefined) {
          let handedOver = false;
          let reason = HANDOFF_REFUSED_REASON;
          try {
            handedOver = await options.enqueueJob(job);
          } catch (error) {
            handedOver = false;
            try {
              reason = describeHandoffRefusal(error);
            } catch {
              reason = HANDOFF_REFUSED_REASON;
            }
          }
          if (!handedOver) {
            await Promise.resolve(options.ledger.remove(job.jobId)).catch(() => undefined);
            skipped += 1;
            if (refusals.length < MAX_HANDOFF_REFUSALS) {
              refusals.push({ repo: rawRepo, reason });
            }
            continue;
          }
        }
        jobs.push(job);
      }
    } catch {
      failed.push(rawRepo);
    }
  }
  return Object.freeze({
    jobs: Object.freeze([...jobs]),
    discovered,
    skipped,
    failedRepositories: Object.freeze([...failed]),
    handoffRefusals: Object.freeze(refusals.map((refusal) => Object.freeze({ ...refusal }))),
  });
}