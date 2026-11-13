/** #1645: stale review-thread state must never force REQUEST_CHANGES on the
 * current head. The four acceptance shapes from the issue, driven through the
 * real composition (thread settlement → strict verdict mapping), plus the
 * live-listing reader's fail-closed states. */
import test from "node:test";
import assert from "node:assert/strict";
import { applyAllEnforcement, type EnforcementInputs } from "../src/enforcement/enforce.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import { readLiveReviewThreadListing, type ThreadLiveReconciliation } from "../src/enforcement/thread-reconcile.js";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    verdict: "approve",
    review_markdown: "Recommendation: approve",
    findings: [
      { severity: "minor", category: "tests", file: "src/a.ts", line: 3, message: "fresh minor" },
      { severity: "info", category: "docs", file: "src/b.ts", line: 9, message: "fresh info" },
    ],
    required_checks: "complete",
    ...overrides,
  } as ReviewArtifact;
}

function carriedMajor(threadId: string, severity = "major") {
  return {
    thread_id: threadId,
    path: "src/old.ts",
    line: 12,
    severity,
    message: "old major from a previous head",
    own_finding: true,
    replies: 0,
  };
}

function liveListing(entries: Array<[string, boolean]>): ThreadLiveReconciliation {
  return { listingComplete: true, unresolvedById: new Map(entries) };
}

function inputs(overrides: Partial<EnforcementInputs>): EnforcementInputs {
  return {
    evidenceBlockerEnabled: false,
    toolFailureEnabled: false,
    toolMinSuccessful: 0,
    evidence: null,
    toolHarness: null,
    threads: null,
    humanReviews: null,
    verdictPolicy: "strict",
    ...overrides,
  };
}

/** The #811 composition the engine runs: overlays, then the strict mapping
 * over the final still-open findings set. Returns the strict outcome so a
 * test can assert the handoff state (marker/native event) and the verdict
 * come from the SAME reconciled finding set. */
function compose(a: ReviewArtifact, enforcement: EnforcementInputs): ReturnType<typeof applyStrictVerdictPolicy> {
  applyAllEnforcement(a, enforcement);
  return applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
}

const GHOST_ONE = "PRRT_kwDOSDff6c62AWST";
const GHOST_TWO = "PRRT_kwDOSDff6c62AWSO";

test("#1645 stale carried blockers: absent from the live listing, an approve stays an approve", () => {
  const a = artifact();
  const outcome = compose(a, inputs({
    threads: [carriedMajor(GHOST_ONE), carriedMajor(GHOST_TWO)],
    threadReconciliation: liveListing([]),
    reviewedHeadSha: "5".repeat(40),
  }));

  assert.equal(a.verdict, "approve", "historical majors must not force REQUEST_CHANGES");
  assert.equal(outcome.verdict, "approve", "handoff and verdict derive from the reconciled set");
  assert.equal(outcome.reviewResult, "findings", "not `issues`: nothing blocking is open");
  assert.equal(a.findings.length, 2, "the ghosts never enter the open findings");
  assert.equal(a.findings.some((f) => f.thread_id === GHOST_ONE || f.thread_id === GHOST_TWO), false);
  assert.ok(String(a.review_markdown).includes("Review-Thread Reconciliation (#1645)"), "the drop is disclosed");
  assert.ok(String(a.review_markdown).includes(`\`${GHOST_ONE}\`: absent from the current review-thread listing`));
  const provenance = (a as { thread_reconciliation?: { entries: Array<{ thread_id: string; reconciliation: string; dropped: boolean }>; head_sha: string; listing_complete: boolean } }).thread_reconciliation;
  assert.ok(provenance, "provenance persisted on the artifact");
  assert.equal(provenance.listing_complete, true);
  assert.equal(provenance.head_sha, "5".repeat(40));
  assert.deepEqual(provenance.entries.map((e) => [e.thread_id, e.reconciliation, e.dropped]), [
    [GHOST_ONE, "absent", true],
    [GHOST_TWO, "absent", true],
  ]);
});

test("#1645 live carried blocker: the live listing reports it unresolved, the review still blocks", () => {
  const a = artifact();
  compose(a, inputs({
    threads: [carriedMajor(GHOST_ONE), carriedMajor(GHOST_TWO)],
    threadReconciliation: liveListing([[GHOST_ONE, true], [GHOST_TWO, false]]),
  }));

  assert.equal(a.verdict, "request_changes", "a live unresolved major still blocks");
  const carried = a.findings.filter((f) => f.thread_id === GHOST_ONE);
  assert.equal(carried.length, 1);
  assert.equal(carried[0]!.severity, "major", "a live-carried blocker keeps its severity");
  assert.equal(a.findings.some((f) => f.thread_id === GHOST_TWO), false, "the resolved ghost is dropped");
  const entries = ((a as { thread_reconciliation?: { entries: Array<{ thread_id: string; reconciliation: string }> } }).thread_reconciliation)!.entries;
  assert.deepEqual(entries.map((e) => [e.thread_id, e.reconciliation]), [
    [GHOST_ONE, "live-unresolved"],
    [GHOST_TWO, "resolved"],
  ]);
});

test("#1645 resolved/dismissed carried blocker never blocks", () => {
  const a = artifact();
  compose(a, inputs({
    threads: [carriedMajor(GHOST_ONE)],
    threadReconciliation: liveListing([[GHOST_ONE, false]]),
  }));
  assert.equal(a.verdict, "approve");
  assert.equal(a.findings.length, 2);
  const settled = (a.thread_dispositions as Array<Record<string, unknown>>)[0]!;
  assert.equal(settled.reconciliation, "resolved");
});

test("#1645 reconciliation unavailable: recorded as unknown and disclosed, never silently trusted", () => {
  const a = artifact();
  const outcome = compose(a, inputs({
    threads: [carriedMajor(GHOST_ONE)],
    threadReconciliation: { listingComplete: false, unresolvedById: new Map() },
  }));
  // Nothing beyond the context-listed row entered the finding set: unknown
  // cannot INVENT a blocker. The context-listed row keeps today's behavior
  // and is explicitly flagged as unproven rather than confirmed live.
  assert.equal(a.findings.length, 3);
  const carried = a.findings.find((f) => f.thread_id === GHOST_ONE);
  assert.ok(carried, "the row stays visible");
  assert.equal(carried!.thread_state_unverified, true, "flagged unverified, not confirmed live");
  assert.ok(String(a.review_markdown).includes("Review-state reconciliation incomplete"), "disclosed in the review");
  assert.equal(outcome.verdict, "request_changes", "the carried row still decides, as today");
  const entries = ((a as { thread_reconciliation?: { entries: Array<{ reconciliation: string; dropped: boolean }>; listing_complete: boolean } }).thread_reconciliation)!;
  assert.equal(entries.listing_complete, false);
  assert.deepEqual(entries.entries.map((e) => [e.reconciliation, e.dropped]), [["unknown", false]]);
});

test("#1645 reconciliation unavailable with nothing carried: no findings, no blocker invented", () => {
  const a = artifact();
  compose(a, inputs({
    threads: null,
    threadReconciliation: { listingComplete: false, unresolvedById: new Map() },
  }));
  assert.equal(a.verdict, "approve");
  assert.equal(a.findings.length, 2);
});

test("#1645 reconciliation unavailable: a current-head blocker still blocks", () => {
  const a = artifact({
    findings: [{ severity: "blocker", category: "bug", file: "src/c.ts", line: 1, message: "fresh blocker" }],
  });
  compose(a, inputs({
    threads: [carriedMajor(GHOST_ONE)],
    threadReconciliation: { listingComplete: false, unresolvedById: new Map() },
  }));
  assert.equal(a.verdict, "request_changes", "the fresh blocker decides, not the carried row");
});

test("#1645 without a reconciliation input settlement keeps its pre-#1645 bytes", () => {
  const a = artifact();
  compose(a, inputs({ threads: [carriedMajor(GHOST_ONE)] }));
  assert.equal(a.verdict, "request_changes", "unchanged legacy behavior (no reconciliation attempted)");
  const finding = a.findings.find((f) => f.thread_id === GHOST_ONE)!;
  assert.equal(finding.severity, "major");
  assert.equal(finding.capped_from, undefined);
  assert.equal(finding.thread_state_unverified, undefined);
  assert.equal((a as { thread_reconciliation?: unknown }).thread_reconciliation, undefined);
  assert.equal((a.thread_dispositions as Array<Record<string, unknown>>)[0]!.reconciliation, undefined);
  assert.doesNotMatch(String(a.review_markdown), /#1645/);
});

test("#1645 a model finding that already carries the thread id is never dropped", () => {
  const a = artifact({
    findings: [
      { severity: "major", category: "bug", file: "src/a.ts", line: 3, message: "current-head major on the same thread", thread_id: GHOST_ONE },
      { severity: "info", category: "docs", file: "src/b.ts", line: 9, message: "fresh info" },
    ],
  });
  compose(a, inputs({
    threads: [carriedMajor(GHOST_ONE)],
    threadReconciliation: liveListing([]),
  }));
  assert.equal(a.verdict, "request_changes", "an independently re-found blocker keeps blocking");
});

test("#1645 findings_severity_gated: a resolved/absent carried blocker never escalates", () => {
  const a = artifact({ verdict: "approve" });
  applyAllEnforcement(a, inputs({
    threads: [carriedMajor(GHOST_ONE, "blocker"), carriedMajor(GHOST_TWO)],
    threadReconciliation: liveListing([[GHOST_ONE, false]]),
    verdictPolicy: "findings_severity_gated",
  }));
  assert.equal(a.verdict, "approve", "the gated escalation only sees re-emitted (live) threads");
  assert.equal(a.findings.length, 2);
  assert.doesNotMatch(String(a.review_markdown), /Verdict escalated from unresolved review threads/);
});

test("#1645 findings_severity_gated: a live-unresolved carried blocker still escalates", () => {
  const a = artifact({ verdict: "approve" });
  applyAllEnforcement(a, inputs({
    threads: [carriedMajor(GHOST_ONE, "blocker")],
    threadReconciliation: liveListing([[GHOST_ONE, true]]),
    verdictPolicy: "findings_severity_gated",
  }));
  assert.equal(a.verdict, "request_changes");
});

// ── the live-listing reader ──────────────────────────────────────────────

function adapterWith(partial: Partial<PlatformReadAdapter>): PlatformReadAdapter {
  return { platform: "github", ...partial } as unknown as PlatformReadAdapter;
}

test("#1645 an adapter without a completeness-proving read reconciles as unknown", async () => {
  const listing = await readLiveReviewThreadListing(adapterWith({
    listReviewThreads: async () => ({ ok: true, data: [{ thread_id: "t1", resolved: false, comments: [{ id: 1, body: "x", created_at: "", user: "u" }] }] }),
  }));
  assert.equal(listing.state, "unknown");
  assert.equal(listing.reconciliation!.listingComplete, false);
  assert.match(String(listing.reason), /complete/);
});

test("#1645 a failed or capped live listing reconciles as unknown, never as absence", async () => {
  const failed = await readLiveReviewThreadListing(adapterWith({
    listReviewThreadsLiveListing: async () => ({ ok: false, error: "forge 500" }),
  }));
  assert.equal(failed.state, "unknown");
  const capped = await readLiveReviewThreadListing(adapterWith({
    listReviewThreadsLiveListing: async () => ({ ok: true, data: [], complete: false }),
  }));
  assert.equal(capped.state, "unknown");
  assert.equal(capped.reconciliation!.listingComplete, false);
});

test("#1645 a throwing live listing never throws out of the seam", async () => {
  const listing = await readLiveReviewThreadListing(adapterWith({
    listReviewThreadsLiveListing: async () => {
      throw new Error("socket died");
    },
  }));
  assert.equal(listing.state, "unknown");
});

test("#1645 a complete listing maps resolved and unresolved thread ids", async () => {
  const thread = (id: string, resolved: boolean) => ({
    thread_id: id,
    resolved,
    comments: [{ id: 1, body: "finding body", created_at: "2026-01-01T00:00:00Z", user: "bot" }],
  });
  const listing = await readLiveReviewThreadListing(adapterWith({
    listReviewThreadsLiveListing: async () => ({
      ok: true,
      complete: true,
      data: [thread(GHOST_ONE, false), thread(GHOST_TWO, true)],
    }),
  }));
  assert.equal(listing.state, "complete");
  assert.equal(listing.reconciliation!.listingComplete, true);
  assert.equal(listing.reconciliation!.unresolvedById.get(GHOST_ONE), true);
  assert.equal(listing.reconciliation!.unresolvedById.get(GHOST_TWO), false);
  assert.equal(listing.reconciliation!.unresolvedById.has("PRRT_missing"), false);
});

test("#1645 a live-listing duplicate id keeps the unresolved sighting (never dropped as resolved)", async () => {
  const thread = (id: string, resolved: boolean) => ({
    thread_id: id,
    resolved,
    comments: [{ id: 1, body: "finding body", created_at: "2026-01-01T00:00:00Z", user: "bot" }],
  });
  const listing = await readLiveReviewThreadListing(adapterWith({
    listReviewThreadsLiveListing: async () => ({
      ok: true,
      complete: true,
      data: [thread("t-dup", true), thread("t-dup", false)],
    }),
  }));
  assert.equal(listing.reconciliation!.unresolvedById.get("t-dup"), true, "unresolved wins over a paired resolved entry");
});

test("#1645 a thread whose comments were all stripped never counts as live", async () => {
  const listing = await readLiveReviewThreadListing(adapterWith({
    listReviewThreadsLiveListing: async () => ({
      ok: true,
      complete: true,
      data: [{ thread_id: "t-empty", resolved: false, comments: [] }],
    }),
  }));
  assert.equal(listing.reconciliation!.unresolvedById.has("t-empty"), false);
});
