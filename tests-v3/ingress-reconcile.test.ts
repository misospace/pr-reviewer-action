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