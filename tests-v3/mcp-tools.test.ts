/** Tool dispatch, argument validation, payload projection, and the
 * store-backed adapter for the operator MCP surface (#1349). */
import test from "node:test";
import assert from "node:assert/strict";
import { buildStoreBackedMcpDeps } from "../src/operator-mcp/store-deps.js";
import { callMcpTool, MCP_TOOLS, validateToolArguments } from "../src/operator-mcp/tools.js";
import { parsePayloadProjection } from "../src/operator-mcp/projection.js";
import { InMemoryControlPlaneStore } from "../src/state/store.js";
import { newRunRecord } from "../src/state/types.js";
import { validateAdoptedRepository, validatePublication, type PublicationRecord, type RunRecord } from "../src/state/types.js";
import { newJobRecord, type JobRecord } from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";
import type { ControllerMcpDeps, McpAuditEvent, McpFindingView, McpMetrics } from "../src/operator-mcp/types.js";

const NO_METRICS: McpMetrics = { request: () => undefined, authFailure: () => undefined, auditFailure: () => undefined };

function reviewJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    jobId: "job-github-1",
    kind: "review",
    trigger: "webhook",
    reason: "synchronize",
    platform: "github",
    installationId: "1",
    repoFullName: "octo/widget",
    prNumber: 11,
    prId: 900,
    headSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
    baseSha: "bbbb2222cccc3333dddd4444eeee5555ffff6666",
    configFingerprint: "aaaaaaaaaaaaaaaa",
    nonce: "",
    adoptionEpoch: "epoch-1",
    eventReference: "",
    fork: false,
    deadlineAtMs: 0,
    runId: "run-1",
    ...overrides,
  };
}

function queueWith(...jobs: ReviewJob[]): { load: () => { version: 1; records: JobRecord[] } } {
  const records = jobs.map((job, index) => newJobRecord(job, 1000 + index, 0));
  return { load: () => ({ version: 1, records }) };
}

function reviewPayload(findings: unknown[] = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: "request_changes",
    review_result: "issues",
    required_checks: ["ci/build", "ci/test"],
    findings,
    ...extra,
  });
}

function publication(jobId: string, payload: string): PublicationRecord {
  const record = validatePublication({
    jobId,
    publicationState: "published",
    destination: `github-comment:${jobId}`,
    publicationId: "100",
    attempt: 1,
    lastError: "",
    resultHeadSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
    resultPayload: payload,
    history: [],
    createdAtMs: 1000,
    updatedAtMs: 1000,
  });
  assert.ok(record, "fixture publication must validate");
  return record;
}

function seedStore(options: { adopted?: Array<{ platform: "github" | "forgejo"; repository: string; enabled?: boolean }> } = {}): InMemoryControlPlaneStore {
  const store = new InMemoryControlPlaneStore();
  const adopted = options.adopted ?? [{ platform: "github", repository: "octo/widget", enabled: true }];
  for (const entry of adopted) {
    const record = validateAdoptedRepository({
      platform: entry.platform,
      installationId: "1",
      repoFullName: entry.repository,
      adoptionEpoch: "epoch-1",
      configFingerprint: "aaaaaaaaaaaaaaaa",
      headFingerprint: "",
      enabled: entry.enabled ?? true,
      adoptedAtMs: 1000,
      updatedAtMs: 1000,
    });
    assert.ok(record, "fixture adoption must validate");
    void store.apply([{ kind: "put-adopted-repository", record }]);
  }
  return store;
}

function seededRun(store: InMemoryControlPlaneStore): RunRecord {
  const run = newRunRecord({ runId: "run-1", jobId: "job-github-1", kind: "review", executorIdentity: "local:v1", headSha: "aaaa1111bbbb2222cccc3333dddd4444eeee5555", configFingerprint: "aaaaaaaaaaaaaaaa", attempt: 1 }, 1000);
  void store.apply([{ kind: "create-run", record: run }]);
  return run;
}

test("the v1 tool table is read-only and read-verb named", () => {
  assert.deepEqual(MCP_TOOLS.map((tool) => tool.name), ["get_review", "list_findings", "get_review_policy"]);
  for (const tool of MCP_TOOLS) {
    assert.match(tool.name, /^(get|list)_/);
    assert.equal(typeof tool.description, "string");
    assert.equal((tool.inputSchema as Record<string, unknown>).type, "object");
  }
});

test("argument validation rebuilds, bounds, and refuses hostile shapes", () => {
  // get_review requires exactly one of run_id/job_id.
  assert.equal(validateToolArguments("get_review", {}), null);
  assert.equal(validateToolArguments("get_review", { run_id: "r", job_id: "j" }), null);
  assert.equal(validateToolArguments("get_review", { run_id: " run-1 " }), null); // untrimmed input refused, never normalized
  assert.deepEqual(validateToolArguments("get_review", { run_id: "run-1" }), { runId: "run-1", limit: 25 });
  // Unknown argument names are dropped, never forwarded.
  const extra = validateToolArguments("get_review", { run_id: "run-1", admin_bypass: true });
  assert.deepEqual(extra, { runId: "run-1", limit: 25 });
  // Traversal and control characters are refused in path/repository filters.
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/../secret" }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/widget", path: "a/../b" }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/widget", path: "a\u0000b" }), null);
  assert.equal(validateToolArguments("list_findings", { repository: "octo/widget" }), null); // platform+repository required
  assert.equal(validateToolArguments("list_findings", { platform: "github" }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "gopher", repository: "octo/widget" }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/widget", limit: 0 }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/widget", limit: 101 }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/widget", limit: "ten" }), null);
  assert.equal(validateToolArguments("list_findings", { platform: "github", repository: "octo/widget", cursor: "bad+cursor" }), null);
  // get_review_policy: exactly one of the repository form or the run form.
  assert.equal(validateToolArguments("get_review_policy", {}), null);
  assert.equal(validateToolArguments("get_review_policy", { platform: "github", repository: "octo/widget", run_id: "run-1" }), null);
  assert.deepEqual(validateToolArguments("get_review_policy", { platform: "github", repository: "octo/widget" }), { platform: "github", repository: "octo/widget", limit: 25 });
  // Non-object arguments are refused wholesale.
  assert.equal(validateToolArguments("list_findings", "github"), null);
  assert.equal(validateToolArguments("list_findings", ["github"]), null);
});

test("payload projection is allowlist-based and degrades gracefully", () => {
  const empty = parsePayloadProjection("not json");
  assert.deepEqual(empty, { verdict: "", reviewResult: "", requiredChecks: [], findings: [] });
  assert.deepEqual(parsePayloadProjection(JSON.stringify([1, 2])), { verdict: "", reviewResult: "", requiredChecks: [], findings: [] });
  const projected = parsePayloadProjection(reviewPayload([
    { path: "src/a.ts", line: 12, severity: "blocker", category: "correctness", message: "off-by-one in loop" },
    { path: "src/b.ts", severity: "minor", category: "style", message: "naming" }, // missing line → line 0
    "hostile string entry",
    { path: 3, severity: "minor", category: "style", message: "x" }, // non-conforming: dropped
    { path: "src/c.ts", line: -1, severity: "minor", category: "style", message: "x" }, // dropped
  ]));
  assert.equal(projected.verdict, "request_changes");
  assert.equal(projected.reviewResult, "issues");
  assert.deepEqual(projected.requiredChecks, ["ci/build", "ci/test"]);
  assert.equal(projected.findings.length, 2);
  assert.equal(projected.findings[0]!.line, 12);
  assert.equal(projected.findings[1]!.line, 0);
  // A hostile verdict/review_result value is absent, never normalized.
  const hostile = parsePayloadProjection(JSON.stringify({ verdict: { approve: true }, review_result: "CLEAN\r" }));
  assert.equal(hostile.verdict, "");
  assert.equal(hostile.reviewResult, "");
});

test("payload projection bounds, strips, and redacts untrusted message text", () => {
  const projected = parsePayloadProjection(reviewPayload([
    { path: "src/secret.ts", line: 1, severity: "blocker", category: "security", message: `token sk-abcdefabcdefabcdefabcd and Bearer eyJh.eyJi.eyJj leaked ${"x".repeat(2000)}` },
    { path: "src/ctrl.ts", line: 2, severity: "minor", category: "style", message: "line\u0000break\u000bvertical\u202eoverride" },
  ]));
  const first = projected.findings[0]!.message;
  assert.ok(!first.includes("sk-abcdefabcdefabcdefabcd"), "credential shape must be redacted");
  assert.ok(!first.includes("Bearer"), "bearer shape must be redacted");
  assert.ok(first.length <= 500, `message bounded, got ${first.length}`);
  const second = projected.findings[1]!.message;
  assert.ok(!/[\u0000\u000b\u202e]/.test(second), "control/format characters stripped");
  // A non-string message degrades to empty rather than normalizing.
  const nonString = parsePayloadProjection(reviewPayload([{ path: "a.ts", line: 1, severity: "minor", category: "x", message: { nested: "object" } }]));
  assert.equal(nonString.findings[0]!.message, "");
});

test("payload projection caps findings per review", () => {
  const many = Array.from({ length: 300 }, (_, index) => ({ path: `src/f${index}.ts`, line: index, severity: "minor", category: "style", message: `finding ${index}` }));
  const projected = parsePayloadProjection(reviewPayload(many));
  assert.equal(projected.findings.length, 200);
});

test("store-backed adapter serves get_review through run and job identity", async () => {
  const store = seedStore();
  seededRun(store);
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload([{ path: "src/a.ts", line: 3, severity: "blocker", category: "correctness", message: "bug here" }])) }]);
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  const byRun = await deps.getReview({ runId: "run-1" });
  assert.ok(byRun);
  assert.equal(byRun!.jobId, "job-github-1");
  assert.equal(byRun!.state, "queued");
  assert.equal(byRun!.verdict, "request_changes");
  assert.equal(byRun!.findingCount, 1);
  assert.deepEqual(byRun!.pr, { platform: "github", repository: "octo/widget", prNumber: 11 });
  assert.equal(byRun!.publication!.state, "published");
  const byJob = await deps.getReview({ jobId: "job-github-1" });
  assert.ok(byJob);
  assert.equal(byJob!.runId, "run-1");
  // Unknown identity → not found; unprovable identity (no queue record) →
  // unread even though the control plane has data.
  assert.equal(await deps.getReview({ runId: "absent" }), null);
  const noQueue = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith() });
  assert.equal(await noQueue.getReview({ runId: "run-1" }), null);
  assert.equal(await noQueue.getReview({ jobId: "job-github-1" }), null);
});

test("store-backed adapter enforces per-repository authorization on every call", async () => {
  const store = seedStore();
  seededRun(store);
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload()) }]);
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  // list_findings authorizes first: a denial throws out of the seam and is
  // converted to a fixed denial by the tool layer — zero rows, no data.
  await assert.rejects(deps.listFindings({ platform: "github", repository: "other/repo", limit: 25 }), /not adopted/);
  // get_review by identity: authorization consults the run's OWN proven
  // repository — a non-adopted repository is unread.
  const otherStore = seedStore({ adopted: [] });
  seededRun(otherStore);
  void otherStore.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload()) }]);
  const closed = buildStoreBackedMcpDeps({ controlPlane: otherStore, queue: queueWith(reviewJob()) });
  assert.equal(await closed.getReview({ runId: "run-1" }), null);
  // A custom authorize seam that denies is honored (fail closed on throw).
  const denying = buildStoreBackedMcpDeps({
    controlPlane: store,
    queue: queueWith(reviewJob()),
    authorize: () => {
      throw new Error("denied");
    },
  });
  assert.equal(await denying.getReview({ runId: "run-1" }), null);
  // The custom authorize seam denies EVERYTHING: the adapter's own
  // listFindings consults it and refuses (the tool layer converts the
  // throw into the fixed denial).
  await assert.rejects(denying.listFindings({ platform: "github", repository: "octo/widget", limit: 25 }), /denied/);
});

test("store-backed adapter paginates findings with a keyset cursor", async () => {
  const store = seedStore();
  seededRun(store);
  const findings = Array.from({ length: 30 }, (_, index) => ({ path: `src/f${index}.ts`, line: index, severity: "minor", category: "style", message: `finding ${index}` }));
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload(findings)) }]);
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  const first = await deps.listFindings({ platform: "github", repository: "octo/widget", limit: 10 });
  assert.equal(first.findings.length, 10);
  assert.ok(first.nextCursor);
  const second = await deps.listFindings({ platform: "github", repository: "octo/widget", limit: 10, cursor: first.nextCursor! });
  assert.equal(second.findings.length, 10);
  assert.equal(second.findings[0]!.path, "src/f10.ts");
  const third = await deps.listFindings({ platform: "github", repository: "octo/widget", limit: 10, cursor: second.nextCursor! });
  assert.equal(third.findings.length, 10);
  // The data exhausted exactly at the page boundary: no next page exists.
  assert.equal(third.nextCursor, undefined);
  // A stale cursor naming an unknown job yields an empty page, never an
  // unfiltered read.
  const stale = await deps.listFindings({ platform: "github", repository: "octo/widget", limit: 10, cursor: Buffer.from(JSON.stringify({ j: "no-such-job", o: 0 }), "utf8").toString("base64url") });
  assert.deepEqual(stale.findings, []);
  assert.equal(stale.nextCursor, undefined);
  // A corrupted cursor yields an empty page, never an unfiltered read.
  const corrupted = await deps.listFindings({ platform: "github", repository: "octo/widget", limit: 10, cursor: Buffer.from("garbage!!!", "utf8").toString("base64url") });
  assert.deepEqual(corrupted.findings, []);
});

test("store-backed adapter applies severity, category, and path filters", async () => {
  const store = seedStore();
  seededRun(store);
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload([
    { path: "src/auth/login.ts", line: 1, severity: "blocker", category: "security", message: "a" },
    { path: "src/ui/button.tsx", line: 2, severity: "minor", category: "style", message: "b" },
    { path: "src/auth/logout.ts", line: 3, severity: "minor", category: "security", message: "c" },
  ])) }]);
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  const blockers = await deps.listFindings({ platform: "github", repository: "octo/widget", severity: "BLOCKER", limit: 25 });
  assert.equal(blockers.findings.length, 1);
  assert.equal(blockers.findings[0]!.path, "src/auth/login.ts");
  const security = await deps.listFindings({ platform: "github", repository: "octo/widget", category: "security", limit: 25 });
  assert.equal(security.findings.length, 2);
  const authPaths = await deps.listFindings({ platform: "github", repository: "octo/widget", path: "AUTH/", limit: 25 });
  assert.equal(authPaths.findings.length, 2);
  const none = await deps.listFindings({ platform: "github", repository: "octo/widget", severity: "critical", limit: 25 });
  assert.deepEqual(none.findings, []);
});

test("list_findings denies a repository the authorize seam refuses, with audit and no data", async () => {
  const store = seedStore();
  seededRun(store);
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload([{ path: "src/a.ts", line: 1, severity: "blocker", category: "security", message: "secret finding" }])) }]);
  const events: McpAuditEvent[] = [];
  const outcomes: string[] = [];
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  const context = {
    deps: {
      ...deps,
      audit: async (event: McpAuditEvent) => {
        events.push(event);
      },
    },
    metrics: {
      request: (outcome: "ok" | "denied" | "invalid" | "error" | "too_large") => {
        outcomes.push(outcome);
      },
      authFailure: () => undefined,
      auditFailure: () => undefined,
    } satisfies McpMetrics,
    requestId: "req-1",
  };
  const denied = await callMcpTool(context, "list_findings", { platform: "github", repository: "closed/repo" });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.message, "repository access denied");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.target.id, "closed/repo");
  assert.equal(events[0]!.outcome, "refused");
  assert.ok(!JSON.stringify(events).includes("token"), "audit record carries no token material");
  assert.deepEqual(outcomes, ["denied"]);
  const serialized = JSON.stringify(denied);
  assert.ok(!serialized.includes("secret finding"), "denied response never leaks findings");
});

test("get_review through the tool layer reports not-found and fixed errors", async () => {
  const store = seedStore();
  seededRun(store);
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload()) }]);
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  const missing = await callMcpTool({ deps, metrics: NO_METRICS, requestId: "r" }, "get_review", { run_id: "absent" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.message, "review not found");
  const broken: ControllerMcpDeps = {
    ...deps,
    getReview: async () => {
      throw new Error("database on fire: host db-1.internal");
    },
  };
  const errored = await callMcpTool({ deps: broken, metrics: NO_METRICS, requestId: "r" }, "get_review", { run_id: "run-1" });
  assert.equal(errored.ok, false);
  if (!errored.ok) {
    assert.equal(errored.message, "review state unavailable");
    assert.ok(!errored.message.includes("db-1.internal"), "exception text never leaks");
  }
});

test("get_review_policy exposes fingerprints and provenance without config material", async () => {
  const store = seedStore();
  seededRun(store);
  void store.apply([{ kind: "put-publication", record: publication("job-github-1", reviewPayload()) }]);
  const deps = buildStoreBackedMcpDeps({ controlPlane: store, queue: queueWith(reviewJob()) });
  const byRepository = await callMcpTool({ deps, metrics: NO_METRICS, requestId: "r" }, "get_review_policy", { platform: "github", repository: "octo/widget" });
  assert.ok(byRepository.ok);
  if (byRepository.ok) {
    const policy = (byRepository.data as { policy: Record<string, unknown> }).policy;
    assert.equal(policy.configFingerprint, "aaaaaaaaaaaaaaaa");
    assert.equal(policy.adoptionEpoch, "epoch-1");
    assert.equal(policy.enabled, true);
    assert.equal(policy.provenance, "control-plane adoption record");
    assert.ok(!JSON.stringify(policy).includes("api_key"), "no config material exposed");
  }
  const byRun = await callMcpTool({ deps, metrics: NO_METRICS, requestId: "r" }, "get_review_policy", { run_id: "run-1" });
  assert.ok(byRun.ok);
  const absent = await callMcpTool({ deps, metrics: NO_METRICS, requestId: "r" }, "get_review_policy", { run_id: "absent" });
  assert.equal(absent.ok, false);
  // A disabled adoption is still readable metadata (policy state, not data).
  const disabledStore = seedStore({ adopted: [{ platform: "github", repository: "octo/widget", enabled: false }] });
  const disabledDeps = buildStoreBackedMcpDeps({ controlPlane: disabledStore, queue: queueWith(reviewJob()) });
  const disabled = await callMcpTool({ deps: disabledDeps, metrics: NO_METRICS, requestId: "r" }, "get_review_policy", { platform: "github", repository: "octo/widget" });
  assert.ok(disabled.ok);
  if (disabled.ok) assert.equal((disabled.data as { policy: { enabled: boolean } }).policy.enabled, false);
});

test("unknown tools are refused at the tool layer", async () => {
  const deps = buildStoreBackedMcpDeps({ controlPlane: seedStore(), queue: queueWith() });
  const refused = await callMcpTool({ deps, metrics: NO_METRICS, requestId: "r" }, "cancel_run", {});
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "invalid-arguments");
  // A separator-mangled lookalike is not a read tool either.
  const mangled = await callMcpTool({ deps, metrics: NO_METRICS, requestId: "r" }, "get_review\rdelete_all", {});
  assert.equal(mangled.ok, false);
});
