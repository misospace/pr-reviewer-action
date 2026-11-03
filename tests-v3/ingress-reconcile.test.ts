import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileRepositories,
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const options: ReconcileOptions = {
    platform: "forgejo",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
  };
  const first = await reconcileRepositories(options);
  const second = await reconcileRepositories(options);
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

  const report = await reconcileRepositories({
    platform: "forgejo",
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

  const report = await reconcileRepositories({
    platform: "forgejo",
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, NEW_HEAD)] } }),
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 1);
  assert.equal(report.jobs[0]!.headSha, NEW_HEAD);
  assert.notEqual(report.jobs[0]!.jobId, webhookJob.jobId);
});

test("a failed repository is reported, the other repos still produce jobs", async () => {
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const withId = await reconcileRepositories({
    platform: "forgejo",
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    installationId: "12",
  });
  assert.equal(withId.jobs.length, 1);
  assert.equal(withId.jobs[0]!.installationId, "12");

  const invalid = await reconcileRepositories({
    platform: "forgejo",
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
  const withFingerprint = await reconcileRepositories({
    platform: "forgejo",
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger,
    buildOptions: { configFingerprint: "abcd1234" },
  });
  assert.equal(withFingerprint.jobs.length, 1);
  assert.equal(withFingerprint.jobs[0]!.configFingerprint, "abcd1234");

  const withoutFingerprint = await reconcileRepositories({
    platform: "forgejo",
    listOpenPullRequests: listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } }),
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(withoutFingerprint.jobs.length, 1);
  assert.equal(withoutFingerprint.jobs[0]!.configFingerprint, "");
  assert.notEqual(withoutFingerprint.jobs[0]!.jobId, withFingerprint.jobs[0]!.jobId);
});

test("a throwing lister is reported as a failed repository, the pass resolves", async () => {
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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

  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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
  const report = await reconcileRepositories({
    platform: "forgejo",
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
test("the GitHub platform converges on the same generation a GitHub webhook would mint", async () => {
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });
  const ledger = new MemoryGenerationLedger();
  const report = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(report.jobs.length, 1);
  const job = report.jobs[0]!;
  // The poll's platform is part of the canonical identity: a GitHub poll
  // MUST NOT mint a Forgejo generation, or the two would never converge.
  assert.equal(job.platform, "github");
  // The same PR/head polled on the OTHER platform is a DIFFERENT
  // generation: the platform is part of the identity, so the caller has
  // to name the forge it polls.
  const forgejoEvent = reconciliationPollEvent("forgejo", makeBarePr(7, 700, HEAD));
  assert.notEqual(forgejoEvent, null);
  const forgejoJob = buildReviewJob(forgejoEvent!, {});
  assert.notEqual(forgejoJob?.jobId, job.jobId);
  // A second pass over the same head is suppressed by the ledger.
  const again = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
  });
  assert.equal(again.jobs.length, 0);
  assert.equal(again.skipped, 1);
});

test("a refused queue handoff releases the durable reservation", async () => {
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });
  const ledger = new MemoryGenerationLedger();
  // The queue refuses the handoff: the reservation MUST be released, or
  // the head stays suppressed until the claim's horizon expires.
  const report = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
    enqueueJob: () => false,
  });
  assert.equal(report.jobs.length, 0);
  assert.equal(report.skipped, 1);
  const pollEvent = reconciliationPollEvent("github", makeBarePr(7, 700, HEAD));
  assert.notEqual(pollEvent, null);
  const jobId = buildReviewJob(pollEvent!, {})!.jobId;
  assert.equal(
    await ledger.has(jobId),
    false,
    "no reservation survives a refused handoff",
  );
  // The next pass re-discovers the head: the reservation is free again.
  const again = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
    enqueueJob: () => true,
  });
  assert.equal(again.jobs.length, 1);
});

test("a refused queue handoff is REPORTED with its reason", async () => {
  // A pass that handed nothing over must be OBSERVABLE: the operator sees
  // which generation was refused and why, not only a `skipped` counter.
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });

  // (a) a handoff that refuses without throwing: the reason is empty.
  const refused = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    enqueueJob: () => false,
  });
  assert.equal(refused.jobs.length, 0);
  assert.equal(refused.skipped, 1, "the refused generation is still counted as skipped");
  assert.deepEqual(
    refused.refusals.map((entry) => ({ ...entry })),
    [{ repository: "org/repo", reason: "" }],
  );

  // (b) a handoff that THROWS: the error's message is the reason.
  const thrown = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    enqueueJob: () => {
      throw new Error("the daemon refused the identity-less job");
    },
  });
  assert.equal(thrown.jobs.length, 0);
  assert.equal(thrown.skipped, 1);
  assert.deepEqual(
    thrown.refusals.map((entry) => ({ ...entry })),
    [
      {
        repository: "org/repo",
        reason: "the daemon refused the identity-less job",
      },
    ],
  );
});

test("a refused queue handoff releases the reservation so the head is re-discovered", async () => {
  // The refusal is not a suppression: the durable reservation is released
  // exactly as before, so the NEXT pass discovers the head again (and can
  // hand it over once the handoff works).
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });
  const ledger = new MemoryGenerationLedger();
  const refused = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
    enqueueJob: () => {
      throw new Error("the queue refused the handoff");
    },
  });
  assert.equal(refused.refusals.length, 1);
  const pollEvent = reconciliationPollEvent("github", makeBarePr(7, 700, HEAD));
  assert.notEqual(pollEvent, null);
  const jobId = buildReviewJob(pollEvent!, {})!.jobId;
  assert.equal(
    await ledger.has(jobId),
    false,
    "no reservation survives a refused handoff",
  );
  const again = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
    enqueueJob: () => true,
  });
  assert.equal(again.jobs.length, 1, "the next pass re-discovers the head");
  assert.equal(again.refusals.length, 0);
});

test("a per-event resolver supplies the identity the poll mints with", async () => {
  // The intake resolves its identity PER REPOSITORY (config fingerprint,
  // adoption epoch, bound forge integration), so a poll that mints from
  // one static options object cannot converge with it: the two would mint
  // different generations of the same head. The per-event resolver is the
  // seam that carries the intake's own answer.
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });

  // (a) A resolver that returns options: the job carries them.
  const resolved = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    resolveBuildOptions: () => ({
      configFingerprint: "abcdef12",
      adoptionEpoch: "3",
      forgeIntegration: "gh-app",
    }),
  });
  assert.equal(resolved.jobs.length, 1, "the resolver's options produced a job");
  assert.equal(resolved.skipped, 0);
  assert.equal(resolved.jobs[0]!.configFingerprint, "abcdef12");
  assert.equal(resolved.jobs[0]!.adoptionEpoch, "3");
  assert.equal(resolved.jobs[0]!.forgeIntegration, "gh-app");
  // The resolver saw the DISCOVERED event, not a static stand-in, and it
  // is called ONCE per REPOSITORY: the identity is per repository, and the
  // resolution reads the control plane, so one read per open pull request
  // would be waste.
  const seen: string[] = [];
  const twoPrs = listerFor({
    "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD), makeBarePr(8, 800, HEAD)] },
  });
  const perRepo = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: twoPrs,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    resolveBuildOptions: (discovered) => {
      seen.push(discovered.repoFullName);
      return { adoptionEpoch: "1" };
    },
  });
  assert.deepEqual(seen, ["org/repo"], "the resolver is called once per repository");
  assert.equal(perRepo.jobs.length, 2, "both pull requests of the repository were minted");
  assert.equal(perRepo.jobs[0]!.adoptionEpoch, "1");
  assert.equal(perRepo.jobs[1]!.adoptionEpoch, "1", "the repository's answer reached both jobs");

  // (b) A resolver that returns null: the intake mints nothing for that
  // repository, so the poll mints nothing either — no job, no
  // reservation, and the entry is counted as skipped.
  const ledger = new MemoryGenerationLedger();
  const refused = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger,
    resolveBuildOptions: () => null,
  });
  assert.equal(refused.jobs.length, 0, "the refused repository mints no job");
  assert.equal(refused.discovered, 1);
  assert.equal(refused.skipped, 1, "the refused entry is counted as skipped");
  assert.deepEqual([...refused.refusals], [], "no handoff was attempted");
  const pollEvent = reconciliationPollEvent("github", makeBarePr(7, 700, HEAD));
  assert.notEqual(pollEvent, null);
  assert.equal(
    await ledger.has(buildReviewJob(pollEvent!, {})!.jobId),
    false,
    "no reservation survives a refused entry",
  );

  // (c) WITHOUT a resolver the static path is unchanged: the static
  // options decide the identity, exactly as before.
  const staticReport = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    buildOptions: { adoptionEpoch: "7" },
  });
  assert.equal(staticReport.jobs.length, 1);
  assert.equal(staticReport.jobs[0]!.adoptionEpoch, "7");
  assert.equal(staticReport.jobs[0]!.configFingerprint, "");
});

test("a refusal reason is bounded and control-character-free", async () => {
  // A handoff's throw text is UNTRUSTED: it lands in the operator-visible
  // report, so it is echoed through the house bound (control characters
  // stripped, capped at 128 characters) rather than verbatim.
  const lister = listerFor({ "org/repo": { ok: true, data: [makeBarePr(7, 700, HEAD)] } });
  const hostile = `refused\u0000\u0007\u001b[31m${"x".repeat(500)}`;
  const report = await reconcileRepositories({
    platform: "github",
    listOpenPullRequests: lister,
    repos: ["org/repo"],
    ledger: new MemoryGenerationLedger(),
    enqueueJob: () => {
      throw new Error(hostile);
    },
  });
  assert.equal(report.refusals.length, 1);
  const reason = report.refusals[0]!.reason;
  assert.ok(reason.length <= 128, `the reason is bounded: ${reason.length}`);
  assert.ok(
    ![...reason].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    }),
    `the reason carries no control character: ${JSON.stringify(reason)}`,
  );
  assert.ok(reason.startsWith("refused"), `the readable head of the reason survives: ${reason}`);
});
