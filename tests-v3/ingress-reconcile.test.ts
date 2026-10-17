import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileForgejoRepositories,
  type ReconcileOptions,
} from "../src/ingress/reconcile.js";
import { MemoryGenerationLedger } from "../src/ingress/dispatch.js";
import { reconciliationPollEvent, normalizeForgejoEvent } from "../src/events/normalize.js";
import { buildReviewJob } from "../src/jobs/generation.js";
import type { ReadResult } from "../src/ingress/api-client.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NEW_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

/** A GitHub/Forgejo-shaped bare PR object (the shape the REST list endpoint
 * returns): `resolvePr`'s "bare" origin path keys on a positive integer
 * `number`, and `reconciliationPollEvent` resolves the repository from
 * `base.repo.full_name` when the envelope carries no `repository`. */
function makeBarePr(number: number, id: number, headSha: string, baseSha?: string): Record<string, unknown> {
  return {
    number,
    id,
    head: { sha: headSha, repo: { full_name: "org/repo" } },
    base: { sha: baseSha ?? "b".repeat(40), repo: { full_name: "org/repo" } },
    merged: false,
    draft: false,
  };
}

function listerFor(map: Record<string, ReadResult<unknown[]> | Error>): (repo: string) => Promise<ReadResult<unknown[]>> {
  return async (repo: string) => {
    const entry = map[repo];
    if (entry instanceof Error) throw entry;
    if (entry === undefined) return { ok: false, error: "not configured" };
    return entry;
  };
}

test("one open PR with an empty ledger mints exactly one job", async () => {
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
  });
  assert.equal(report.jobs.length, 1);
  assert.equal(report.discovered, 1);
  assert.equal(report.skipped, 0);
  assert.deepEqual([...report.failedRepositories], []);
  const job = report.jobs[0]!;
  assert.match(job.jobId, /^[0-9a-f]{64}$/);
  assert.equal(job.kind, "review");
  assert.equal(job.trigger, "poll");
  assert.equal(job.reason, "reconciliation_poll");
  assert.equal(job.headSha, HEAD);
  assert.equal(job.repoFullName, "org/repo");
});

test("a second reconcile of the same head on the same ledger is suppressed", async () => {
  const ledger = new MemoryGenerationLedger();
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });
  const options: ReconcileOptions = { listOpenPullRequests: lister, repos: ["org/repo"], ledger };
  const first = await reconcileForgejoRepositories(options);
  const second = await reconcileForgejoRepositories(options);
  assert.equal(first.jobs.length, 1);
  assert.equal(second.jobs.length, 0);
  assert.equal(second.discovered, 1);
  assert.equal(second.skipped, 1);
});

test("a head already reviewed via webhook is discovered but not rescheduled", async () => {
  const ledger = new MemoryGenerationLedger();
  const webhookEvent = normalizeForgejoEvent({
    name: "pull_request",
    action: "synchronize",
    pull_request: makeBarePr(7, 700, HEAD),
  });
  assert.notEqual(webhookEvent, null);
  const webhookJob = buildReviewJob(webhookEvent!);
  assert.notEqual(webhookJob, null);
  await ledger.add(webhookJob!.jobId);

  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 0);
  assert.equal(report.discovered, 1);
  assert.equal(report.skipped, 1);

  // The convergence requirement: the poll mints the SAME generation id the
  // webhook did, which is why the ledger could suppress it.
  const pollJob = buildReviewJob(reconciliationPollEvent("forgejo", makeBarePr(7, 700, HEAD))!);
  assert.notEqual(pollJob, null);
  assert.equal(pollJob!.jobId, webhookJob!.jobId);
});

test("a new head pushed since the webhook mints a distinct job", async () => {
  const ledger = new MemoryGenerationLedger();
  const webhookJob = buildReviewJob(
    normalizeForgejoEvent({ name: "pull_request", action: "synchronize", pull_request: makeBarePr(7, 700, HEAD) })!,
  )!;
  await ledger.add(webhookJob.jobId);

  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, NEW_HEAD)] } }),
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 1);
  assert.equal(report.jobs[0]!.headSha, NEW_HEAD);
  assert.notEqual(report.jobs[0]!.jobId, webhookJob.jobId);
});

test("a failed repository is reported, the other repos still produce jobs", async () => {
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "bad/repo": { ok: false, error: "boom" },
      "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] },
    }),
    repos: ["bad/repo", "org/repo"],
    ledger: new MemoryGenerationLedger(),
  });
  assert.deepEqual([...report.failedRepositories], ["bad/repo"]);
  assert.equal(report.jobs.length, 1);
  assert.equal(report.jobs[0]!.repoFullName, "org/repo");
});

test("garbage lister entries are discovered and skipped without throwing", async () => {
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [42, "str", {}] } }),
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
  });
  assert.equal(report.discovered, 3);
  assert.equal(report.skipped, 3);
  assert.equal(report.jobs.length, 0);
  assert.deepEqual([...report.failedRepositories], []);
});

test("installationId propagates; an invalid one is the fail-closed sentinel", async () => {
  const withId = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    installationId: "12",
  });
  assert.equal(withId.jobs.length, 1);
  assert.equal(withId.jobs[0]!.installationId, "12");

  const invalid = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    installationId: "012",
  });
  assert.equal(invalid.jobs.length, 1);
  assert.equal(invalid.jobs[0]!.installationId, "");
});

test("buildOptions pass through; a config change re-keys the same head", async () => {
  const ledger = new MemoryGenerationLedger();
  const withFingerprint = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger,
    buildOptions: { configFingerprint: "abcd1234" },
  });
  assert.equal(withFingerprint.jobs.length, 1);
  assert.equal(withFingerprint.jobs[0]!.configFingerprint, "abcd1234");

  const withoutFingerprint = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(withoutFingerprint.jobs.length, 1);
  assert.equal(withoutFingerprint.jobs[0]!.configFingerprint, "");
  assert.notEqual(withoutFingerprint.jobs[0]!.jobId, withFingerprint.jobs[0]!.jobId);
});

test("a throwing lister is reported as a failed repository, the pass resolves", async () => {
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "bad/repo": new Error("boom"),
      "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] },
    }),
    repos: ["bad/repo", "org/repo"],
    ledger: new MemoryGenerationLedger(),
  });
  assert.deepEqual([...report.failedRepositories], ["bad/repo"]);
  assert.equal(report.jobs.length, 1);
});

// ── poll-scope binding (#1025) ─────────────────────────────────────────────
//
// The adapter must REJECT every entry whose normalized target repository
// disagrees with the configured repository it polled. The normalizer
// already prefers `repository.full_name` over `base.repo.full_name`, so
// either conflict surfaces as a mismatch on `event.repoFullName` and the
// pass MUST NOT reserve a generation for it.

/** A bare PR shape with NO `repository` envelope — the normalizer falls
 * back to `base.repo.full_name` for the target identity, which is also how
 * the REST list endpoint commonly serializes its entries. */
function bareBaseOnlyPr(
  number: number,
  id: number,
  headSha: string,
  baseFullName: string,
  headFullName?: string,
  baseSha?: string,
): Record<string, unknown> {
  return {
    number,
    id,
    head: { sha: headSha, repo: { full_name: headFullName ?? baseFullName } },
    base: { sha: baseSha ?? "b".repeat(40), repo: { full_name: baseFullName } },
    merged: false,
    draft: false,
  };
}

/** A bare PR shape WITH a `repository` envelope — the normalizer prefers
 * it over the nested `base.repo`. A mismatch between the envelope and
 * the polled repo MUST still be rejected. */
function envelopePr(
  number: number,
  id: number,
  headSha: string,
  envelopeFullName: string,
  baseFullName: string,
  baseSha?: string,
): Record<string, unknown> {
  return {
    number,
    id,
    head: { sha: headSha, repo: { full_name: envelopeFullName } },
    base: { sha: baseSha ?? "b".repeat(40), repo: { full_name: baseFullName } },
    repository: { full_name: envelopeFullName },
    merged: false,
    draft: false,
  };
}

test("envelope repository.full_name that disagrees with the polled repo is rejected without reserving a generation", async () => {
  const ledger = new MemoryGenerationLedger();
  // The polled repo is allowed/repo; the entry's envelope and base
  // both claim other/repo — the response is out of scope.
  const outOfScope = envelopePr(7, 700, HEAD, "other/repo", "other/repo");
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "allowed/repo": { ok: true, data: [outOfScope] },
    }),
    repos: ["allowed/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 0);
  assert.equal(report.discovered, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual([...report.failedRepositories], []);
  // Observable receipt: the job the OUT-of-scope entry WOULD have minted
  // is still addable from outside — `addIfAbsent` returns `true` only
  // when the id was NOT previously reserved, which proves the reconcile
  // path never called `ledger.addIfAbsent` for the rejected entry.
  const wouldBe = buildReviewJob(reconciliationPollEvent("forgejo", outOfScope)!);
  assert.notEqual(wouldBe, null);
  assert.equal(
    await ledger.addIfAbsent(wouldBe!.jobId),
    true,
    "out-of-scope entry must not have reserved a generation",
  );
});

test("base.repo.full_name that disagrees with the polled repo is rejected when the envelope is absent", async () => {
  const ledger = new MemoryGenerationLedger();
  const outOfScope = bareBaseOnlyPr(7, 700, HEAD, "other/repo");
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "allowed/repo": { ok: true, data: [outOfScope] },
    }),
    repos: ["allowed/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 0);
  assert.equal(report.discovered, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual([...report.failedRepositories], []);
  const wouldBe = buildReviewJob(reconciliationPollEvent("forgejo", outOfScope)!);
  assert.notEqual(wouldBe, null);
  assert.equal(await ledger.addIfAbsent(wouldBe!.jobId), true);
});

test("an in-scope entry mixed with out-of-scope entries yields only the in-scope job; legitimate repos continue", async () => {
  const ledger = new MemoryGenerationLedger();
  const legitimate = bareBaseOnlyPr(7, 700, HEAD, "allowed/repo");
  const outViaEnvelope = envelopePr(8, 800, HEAD, "other/repo", "other/repo");
  const outViaBase = bareBaseOnlyPr(9, 900, HEAD, "other/repo");
  const second = bareBaseOnlyPr(11, 1100, HEAD, "second/repo");
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "allowed/repo": {
        ok: true,
        data: [legitimate, outViaEnvelope, outViaBase],
      },
      // An entirely different configured repo whose response is fully in
      // scope — the adapter must keep polling it after the rejected
      // entries in the previous one.
      "second/repo": { ok: true, data: [second] },
    }),
    repos: ["allowed/repo", "second/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 2);
  assert.equal(report.discovered, 4);
  assert.equal(report.skipped, 2);
  assert.deepEqual([...report.failedRepositories], []);
  assert.deepEqual(
    report.jobs.map((j) => j.repoFullName).sort(),
    ["allowed/repo", "second/repo"],
  );
  // Each successful job reserved exactly one generation; the two rejected
  // entries left no trace in the ledger (their jobIds are still addable).
  for (const outOfScope of [outViaEnvelope, outViaBase]) {
    const wouldBe = buildReviewJob(reconciliationPollEvent("forgejo", outOfScope)!);
    assert.notEqual(wouldBe, null);
    assert.equal(await ledger.addIfAbsent(wouldBe!.jobId), true);
  }
});

test("a legitimate fork PR (head.repo differs from base.repo) still mints a job on the polled repo", async () => {
  const ledger = new MemoryGenerationLedger();
  // Fork PR: head.repo is the contributor's fork (forker/their-fork),
  // base.repo is the upstream polled target (allowed/repo).
  const pr = bareBaseOnlyPr(7, 700, HEAD, "allowed/repo", "forker/their-fork");
  // Sanity: this is what the normalizer sees as a fork.
  const evt = reconciliationPollEvent("forgejo", pr);
  assert.notEqual(evt, null);
  assert.equal(evt!.fork, true);

  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "allowed/repo": { ok: true, data: [pr] },
    }),
    repos: ["allowed/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 1);
  assert.equal(report.skipped, 0);
  assert.equal(report.jobs[0]!.repoFullName, "allowed/repo");
  assert.equal(report.jobs[0]!.fork, true);
  assert.equal(
    await ledger.addIfAbsent(report.jobs[0]!.jobId),
    false,
    "the in-scope fork job must have been reserved exactly once",
  );
});

test("a polled repo string in a non-canonical case/spacing form still binds correctly", async () => {
  const ledger = new MemoryGenerationLedger();
  // Polled repo has uppercase and a stray space; the entry uses the
  // canonical lowercase form. Both normalize to `allowed/repo` so the
  // scope check accepts the entry.
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: listerFor({
      "  Allowed/Repo ": { ok: true, data: [bareBaseOnlyPr(7, 700, HEAD, "allowed/repo")] },
    }),
    repos: ["  Allowed/Repo "],
    ledger,
  });
  assert.equal(report.jobs.length, 1);
  assert.equal(report.skipped, 0);
  assert.equal(report.jobs[0]!.repoFullName, "allowed/repo");
});

test("a malformed option.repos entry is reported as a failed repository without invoking the lister", async () => {
  let calls = 0;
  const report = await reconcileForgejoRepositories({
    listOpenPullRequests: async () => {
      calls += 1;
      return { ok: true, data: [] };
    },
    repos: ["not a repo"],
    ledger: new MemoryGenerationLedger(),
  });
  assert.equal(report.jobs.length, 0);
  assert.equal(calls, 0);
  assert.deepEqual([...report.failedRepositories], ["not a repo"]);
});