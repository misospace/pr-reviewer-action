/** #1449 (Phase C): the derived-obligation state reaches the PUBLISHED
 * marker.
 *
 * Phases A and B made the derived rows part of the #1381 obligation contract
 * and disclosed the run's derived state in the RUN's own artifacts (the
 * `review-coverage.json` record and the engine's own marker). The PUBLISHED
 * comment's metadata marker is built by the publish step from its OWN input,
 * so the state did not reach it: a reader of the review — or a collector
 * reading published comments — could not tell that a trusted approve was
 * withheld because a derived architectural obligation stayed undischarged.
 *
 * This phase threads the state to the published marker:
 *  - the engine exposes the state it ALREADY computed (never recomputed);
 *  - the publish input carries it into the marker context, where the
 *    marker builder's existing additive key validates it;
 *  - the composite action passes it in process, and the standalone `publish`
 *    CLI reads it back from the run dir's own artifact — so both paths
 *    publish ONE record.
 *
 * A run without the feature publishes byte-identical output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishReview } from "../src/publish/publish.js";
import { publishInputFromEnv } from "../src/run/entrypoints.js";
import { parseMetadata } from "../src/precheck/metadata.js";
import { runReviewEngine } from "../src/engine/review.js";
import { actionMain } from "../src/run/action.js";
import { startMockServer, type CapturedRequest } from "./helpers.js";
import type { NativeReviewSurface, PublishPlatformApi } from "../src/platform/publish-api.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

const MARKER = "<!-- ai-pr-review -->";
const HEAD = "head-123";

// ── the publish seam ──────────────────────────────────────────────────

/** A minimal publish API that records the published sticky body — the
 * record a PR reader (and a later collector) sees. */
class StickyApi implements PublishPlatformApi {
  readonly platform: "github" | "forgejo" = "github";
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  readonly sticky: { marker: string; body: string }[] = [];
  comments: never[] = [];
  reviews: never[] = [];
  async getHeadSha(): Promise<string | null> { return HEAD; }
  async listIssueComments() { return this.comments; }
  async upsertStickyComment(marker: string, body: string) { this.sticky.push({ marker, body }); return { ok: true, created: true }; }
  async listReviews() { return this.reviews; }
  async listManagedInlineComments() { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment() { return true; }
  async createReview() { return { ok: true }; }
  async dismissReview() { return true; }
  async minimizedReviewIds() { return []; }
  async minimizeReview() { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread() { return true; }
  async removeLabel() { return true; }
  async requestReviewers() { return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] }; }
}

function publishInput(overrides: Partial<Parameters<typeof publishReview>[0]> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "## Review\n\nBody.", verdict: "approve",
    analysisEngine: "test-engine", baseSha: "base-1", headSha: HEAD,
    prNumber: "42", commentMarker: MARKER, requiredChecks: "complete", reviewRoute: "primary",
    escalationReason: "", cacheHitRatio: "-", inlineFindings: false, inlineFindingsMax: 10,
    findings: [], cleanupPreviousNativeReviews: "false", approveForks: false,
    isForkPr: false, upstreamLinkMode: "inert",
    conditionalPresence: {
      linkedIssue: false, evidenceProvider: false, standards: false,
      toolHarnessFindings: false, toolHarnessResults: false,
    },
    forgejoPositions: false,
    ...overrides,
  };
}

/** The metadata marker line of a published body. */
function markerLine(body: string): string {
  const line = body.split("\n").find((entry) => entry.startsWith("<!-- ai-pr-reviewer:{"));
  assert.ok(line !== undefined, "the published body carries no metadata marker");
  return line!;
}

/** The metadata marker's own `review_result`. */
function markerReviewResult(body: string): string {
  const line = markerLine(body);
  const json = line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1);
  return String((JSON.parse(json) as Record<string, unknown>).review_result);
}

/** The `review-handoff/v1` payload of a published body — the fenced JSON
 * document the action renders into its marker preamble. */
function handoffPayload(body: string): Record<string, unknown> {
  const lines = body.split("\n");
  const anchor = lines.findIndex((entry) => entry.startsWith("<!-- ai-pr-reviewer-handoff:v1 -->"));
  assert.ok(anchor !== -1, "the published body carries no handoff container");
  const payload = lines[anchor + 2];
  assert.ok(payload !== undefined, "the handoff container carries no payload");
  return JSON.parse(payload!) as Record<string, unknown>;
}

test("#1449: the published marker carries the run's derived-obligation state", async () => {
  for (const state of ["complete", "unresolved", "unavailable"] as const) {
    const api = new StickyApi();
    await publishReview(publishInput({ derivedObligationState: state }), api, { diffText: "" });
    const marker = parseMetadata(api.sticky[0]!.body);
    assert.ok(marker !== null, "the published comment carries no metadata marker");
    assert.equal(marker!.derived_obligation_state, state);
    // The key is the additive one, appended LAST — no pre-existing key
    // moves.
    assert.ok(markerLine(api.sticky[0]!.body).endsWith(`"derived_obligation_state":"${state}"} -->`));
  }
});

test("#1449: the published marker omits an absent or unusable derived state", async () => {
  // Absent (the feature is off) and unknown values publish nothing: the
  // marker builder validates the value against the three closed states.
  const cases: Array<{ label: string; state?: string }> = [
    { label: "absent" },
    { label: "empty", state: "" },
    { label: "unknown", state: "whatever" },
    { label: "wrong case", state: "Complete" },
    { label: "trailing space", state: "unresolved " },
    { label: "not a state", state: "true" },
  ];
  for (const entry of cases) {
    const api = new StickyApi();
    await publishReview(publishInput(entry.state === undefined ? {} : { derivedObligationState: entry.state }), api, { diffText: "" });
    const body = api.sticky[0]!.body;
    // The MARKER omits the state — that is what this test is about.
    assert.ok(!markerLine(body).includes("derived_obligation_state"), `state ${entry.label} leaked into the marker`);
    // #1521: the machine-readable `review-handoff/v1` document carries the
    // same member with a FIXED key set, so the key is always there — but
    // its value is null (unknown) whenever the state is absent or
    // unusable, so no state VALUE leaks into the published body.
    assert.equal(handoffPayload(body).derived_obligation_state, null);
  }
});

test("#1449: a run without the feature publishes byte-identical output", async () => {
  const without = new StickyApi();
  await publishReview(publishInput(), without, { diffText: "" });
  // The MARKER carries no derived state at all.
  assert.ok(!markerLine(without.sticky[0]!.body).includes("derived_obligation_state"));
  // #1521: the `review-handoff/v1` document's key set is fixed, so its
  // derived-state member is always there — as null (unknown) when the
  // feature is off.
  assert.equal(handoffPayload(without.sticky[0]!.body).derived_obligation_state, null);
  // The pre-#1449 bytes: the same keys, in the same order, with nothing
  // appended (the build stamp is the only optional key).
  assert.match(
    markerLine(without.sticky[0]!.body),
    /^<!-- ai-pr-reviewer:\{"version":1,"head_sha":"head-123","base_sha":"base-1","review_result":"clean","required_checks":"complete","review_route":"primary"(,"action_version":"[^"]*")?\} -->$/,
  );

  // The additive discipline: enabling the state appends exactly one key and
  // moves nothing. The review also reads `partial` (an undischarged derived
  // obligation is missing coverage, not a defect), so the comparison drops
  // that one state word — and the recommendation header, which may never
  // read APPROVE over an unfinished review.
  const enabled = new StickyApi();
  await publishReview(publishInput({ derivedObligationState: "unresolved" }), enabled, { diffText: "" });
  const enabledBody = enabled.sticky[0]!.body;
  const withoutBody = without.sticky[0]!.body;
  // The marker line, compared on its own.
  assert.equal(
    markerLine(enabledBody).replace(',"derived_obligation_state":"unresolved"', ""),
    markerLine(withoutBody).replace('"review_result":"clean"', '"review_result":"partial"'),
  );
  // #1518: the published body now carries the `review-handoff/v1` container,
  // which repeats the review result in its own JSON payload. The bodies are
  // NOT compared whole: a whole-body comparison that normalizes every
  // occurrence lets a handoff payload disagree with the marker and still
  // compare equal. The handoff payload is extracted and compared SEPARATELY,
  // and its `review_result` must carry the SAME expectation the marker has —
  // the derived-obligation run reads `partial`, never `clean`.
  const enabledPayload = handoffPayload(enabledBody);
  const withoutPayload = handoffPayload(withoutBody);
  assert.equal(enabledPayload.review_result, "partial", "the derived-obligation run's handoff reads partial, never clean");
  assert.equal(withoutPayload.review_result, "clean", "the run without the derived state reads clean");
  assert.equal(enabledPayload.review_result, markerReviewResult(enabledBody), "the handoff payload agrees with the marker");
  assert.equal(withoutPayload.review_result, markerReviewResult(withoutBody), "the handoff payload agrees with the marker");
  // The recommendation header agrees too: an unfinished review never reads
  // as an approval.
  assert.ok(enabledBody.includes("🟡 **Automated recommendation: INCOMPLETE — not an approval**"));
  assert.ok(withoutBody.includes("✅ **Automated recommendation: APPROVE**"));
});

// ── the standalone `publish` CLI ──────────────────────────────────────

/** The run dir's own `review-coverage.json` — the artifact the engine
 * writes and the standalone CLI reads. */
function writeCoverageArtifact(dir: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, "review-coverage.json"), JSON.stringify({
    version: 1,
    tool_loop_ran: false,
    enforcement_harness: null,
    route: "primary",
    partial_coverage: null,
    required_checks: "complete",
    ...overrides,
  }));
}

async function withRunDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "v3-derived-marker-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1449: the standalone publish CLI reads the state from the run dir's review-coverage.json", async () => {
  await withRunDir((dir) => {
    writeCoverageArtifact(dir, { derived_obligation_state: "unresolved" });
    const input = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(input.derivedObligationState, "unresolved");
  });
  await withRunDir((dir) => {
    writeCoverageArtifact(dir, { derived_obligation_state: "complete" });
    assert.equal(
      publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
      "complete",
    );
  });
  await withRunDir((dir) => {
    writeCoverageArtifact(dir, { derived_obligation_state: "unavailable" });
    assert.equal(
      publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
      "unavailable",
    );
  });
});

test("#1449: the standalone publish CLI publishes the state in the marker", async () => {
  // The CLI path end to end: the run dir's artifact → the publish input →
  // the published marker.
  await withRunDir(async (dir) => {
    writeCoverageArtifact(dir, { derived_obligation_state: "unresolved" });
    const input = publishInputFromEnv({
      PR_REVIEWER_RUN_DIR: dir,
      PUBLISH_MODE: "comment",
      COMMENT_MARKER: MARKER,
      REVIEW_MARKDOWN: "## Review\n\nBody.",
      VERDICT: "approve",
      HEAD_SHA: HEAD,
      BASE_SHA: "base-1",
      PR_NUMBER: "42",
      REPO: "o/r",
    } as NodeJS.ProcessEnv, "github");
    const api = new StickyApi();
    await publishReview(input, api, { diffText: "" });
    const marker = parseMetadata(api.sticky[0]!.body);
    assert.ok(marker !== null, "the published comment carries no metadata marker");
    assert.equal(marker!.derived_obligation_state, "unresolved");
  });
});

test("#1449: the standalone publish CLI omits the state when the feature was off", async () => {
  // No artifact at all: a run without the feature.
  await withRunDir((dir) => {
    assert.equal(
      publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
      undefined,
    );
  });
  // An unparseable artifact in a run without the feature.
  await withRunDir((dir) => {
    writeFileSync(join(dir, "review-coverage.json"), "not json");
    assert.equal(
      publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
      undefined,
    );
  });
  // An artifact with no derived field at all (a run without the feature).
  await withRunDir((dir) => {
    writeCoverageArtifact(dir);
    assert.equal(
      publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
      undefined,
    );
  });
});

test("#1449: the standalone publish CLI FAILS CLOSED when a feature-on run's state cannot be read", async () => {
  // The state is a GATE: it decides whether a native approval may publish, so
  // an unreadable state in a feature-on run must never read as "no gap".
  // The engine writes `derived-obligation-state.json` only when the operator
  // enabled the feature — that file is the run's own sentinel.
  const unusable: Array<{ label: string; prepare: (dir: string) => void }> = [
    { label: "no coverage artifact", prepare: (dir) => { writeFileSync(join(dir, "derived-obligation-state.json"), JSON.stringify({ version: 1, enabled: true, coverage: "complete", reason: null, obligations: [] })); } },
    { label: "unparseable coverage artifact", prepare: (dir) => {
      writeFileSync(join(dir, "derived-obligation-state.json"), JSON.stringify({ version: 1, enabled: true, coverage: "complete", reason: null, obligations: [] }));
      writeFileSync(join(dir, "review-coverage.json"), "not json");
    } },
    { label: "coverage artifact without the state", prepare: (dir) => {
      writeFileSync(join(dir, "derived-obligation-state.json"), JSON.stringify({ version: 1, enabled: true, coverage: "complete", reason: null, obligations: [] }));
      writeCoverageArtifact(dir);
    } },
  ];
  for (const entry of unusable) {
    await withRunDir((dir) => {
      entry.prepare(dir);
      assert.equal(
        publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
        "unavailable",
        entry.label,
      );
    });
  }
  // A value outside the three closed states is never published as itself —
  // the disclosure is a closed vocabulary, not free text.
  for (const unusableValue of ["unknown", "", "Complete", "unresolved ", 42, null, true, ["unresolved"]]) {
    await withRunDir((dir) => {
      writeCoverageArtifact(dir, { derived_obligation_state: unusableValue });
      assert.equal(
        publishInputFromEnv({ PR_REVIEWER_RUN_DIR: dir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
        undefined,
        `value ${JSON.stringify(unusableValue)} was published`,
      );
    });
  }
});

test("#1449: the standalone publish CLI never reads the checkout for the derived state", () => {
  // No explicit run dir: the state is absent — never a cwd fallback (#838).
  assert.equal(
    publishInputFromEnv({ PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github").derivedObligationState,
    undefined,
  );
  assert.equal(
    publishInputFromEnv({ PUBLISH_MODE: "comment", PR_REVIEWER_RUN_DIR: "" } as NodeJS.ProcessEnv, "github").derivedObligationState,
    undefined,
  );
  assert.equal(
    publishInputFromEnv({ PUBLISH_MODE: "comment", PR_REVIEWER_RUN_DIR: " " } as NodeJS.ProcessEnv, "github").derivedObligationState,
    undefined,
  );
});

// ── the engine's own state (the value both publish paths carry) ───────

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({ number: 7, title: "Update README", body: "", state: "open", draft: false, head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, user: { login: "someone" }, changed_files: 1, additions: 1, deletions: 0 }),
    getPrDiff: async () => "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    listPrFiles: async () => ({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => [],
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => null,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

const engineInputs = { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": "", "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" };

function fixtureDir(): { root: string; runDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "v3-derived-marker-engine-"));
  const runDir = join(root, "run");
  mkdirSync(runDir);
  return { root, runDir, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}

function engineRequest(aiBaseUrl: string, runDir: string, derived: boolean): ReviewRequest {
  return {
    repository: "o/r",
    prNumber: "7",
    headSha: "a".repeat(40),
    baseRef: "",
    isForkPr: "false",
    platform: "github",
    forgejoApiUrl: "",
    ciChecksFile: join(runDir, "ci-checks-context.md"),
    inputs: { ...engineInputs, "ai-base-url": aiBaseUrl, ...(derived ? { "derived-obligations": "true" } : {}) },
    ambient: {},
    triggerReason: "manual",
    forceRereview: false,
  };
}

function engineDeps(root: string, runDir: string): ReviewDependencies {
  return { workspace: root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(root, "summary.md"), adapter: mockPlatform(), persistArtifacts: true, quiet: true, log: () => {}, error: () => {}, annotate: () => {} };
}

const OBLIGATION = "every producer places the generation identity before the dedupe hash";
const LOCATIONS = ["src/ingress/reconcile.ts:mintFoundJob"];

/** The model mock: the derived pre-pass answers with one obligation, the
 * review answers with a verdict that discharges nothing (so the derived row
 * stays undischarged). */
function derivedModelServer(): Promise<Awaited<ReturnType<typeof startMockServer>>> {
  return startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    if (body.includes("You derive the architectural obligations")) {
      res.end(JSON.stringify({ id: "d1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ obligations: [{ obligation: OBLIGATION, topology: "identity", paths: LOCATIONS }] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } }));
      return;
    }
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } }));
  });
}

test("#1449: the engine exposes the derived state it computed, and the artifact carries the same value", async () => {
  const server = await derivedModelServer();
  const f = fixtureDir();
  try {
    const result = await runReviewEngine(engineRequest(server.url, f.runDir, true), engineDeps(f.root, f.runDir));
    // The derived row stayed undischarged, so the state says so.
    assert.equal(result.derivedObligationState, "unresolved");
    // The artifact the standalone CLI reads carries the same value — one
    // record, two publish paths.
    const coverage = JSON.parse(readFileSync(join(f.runDir, "review-coverage.json"), "utf8")) as Record<string, unknown>;
    assert.equal(coverage.derived_obligation_state, "unresolved");
    const standalone = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: f.runDir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(standalone.derivedObligationState, result.derivedObligationState);
  } finally {
    await server.close();
    f.cleanup();
  }
});

test("#1449: a run without the feature exposes no derived state at all", async () => {
  const server = await derivedModelServer();
  const f = fixtureDir();
  try {
    const result = await runReviewEngine(engineRequest(server.url, f.runDir, false), engineDeps(f.root, f.runDir));
    assert.equal(result.derivedObligationState, undefined);
    const coverage = JSON.parse(readFileSync(join(f.runDir, "review-coverage.json"), "utf8")) as Record<string, unknown>;
    assert.equal("derived_obligation_state" in coverage, false);
    const standalone = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: f.runDir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(standalone.derivedObligationState, undefined);
  } finally {
    await server.close();
    f.cleanup();
  }
});

// ── the composite action (the end-to-end published record) ────────────

function verdictBody(): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null,
      findings: [], requirement_coverage: null, required_check_dispositions: [],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

function derivedPassBody(): string {
  return JSON.stringify({
    id: "d1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      obligations: [{ obligation: OBLIGATION, topology: "identity", paths: LOCATIONS }],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  });
}

function startGithubMock(options: { baseSha: string; headSha: string }): Promise<{
  url: string;
  requests: CapturedRequest[];
  commentPosts: string[];
  close: () => Promise<void>;
}> {
  const commentPosts: string[] = [];
  return startMockServer((req, body, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/repos/o/r/issues/7/comments")) {
      if (req.method === "POST") {
        commentPosts.push(body);
        res.statusCode = 201;
        res.end(JSON.stringify({ id: 100 }));
        return;
      }
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/collaborators/")) {
      res.end(JSON.stringify({ permission: "write", role: "write" }));
      return;
    }
    if (url.startsWith("/repos/o/r/issues/comments/")) {
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "README.md", status: "modified", additions: 1, deletions: 1, changes: 2 }]));
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7/reviews")) {
      res.end("[]");
      return;
    }
    if (url.startsWith("/repos/o/r/pulls/7")) {
      if (req.headers.accept === "application/vnd.github.v3.diff") {
        res.setHeader("Content-Type", "text/plain");
        res.end("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n");
        return;
      }
      res.end(JSON.stringify({
        number: 7,
        state: "open",
        draft: false,
        title: "Some PR",
        body: "",
        head: { sha: options.headSha, ref: "feature", repo: { full_name: "o/r" } },
        base: { sha: options.baseSha, ref: "main", repo: { full_name: "o/r" } },
        user: { login: "someone" },
        changed_files: 1,
        additions: 1,
        deletions: 1,
        html_url: "https://github.com/o/r/pull/7",
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  }).then((server) => ({ ...server, commentPosts }));
}

function commentEvent(): string {
  return JSON.stringify({
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/o/r/pulls/7" } },
    comment: { id: 42, body: "/ai-review", user: { login: "alice" } },
    action: "created",
  });
}

interface ActionCase {
  exitCode: number;
  /** Bodies POSTed to the sticky-comment endpoint. */
  commentPosts: string[];
  /** The action's own run dir. */
  runDir: string;
  cleanup: () => Promise<void>;
}

/** The real `actionMain()` entrypoint against a mocked forge and a mocked
 * model, with the derived-obligation feature on or off. */
async function runActionCase(derived: boolean): Promise<ActionCase> {
  const workspace = mkdtempSync(join(tmpdir(), "v3-derived-marker-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "v3-derived-marker-runner-temp-"));
  const model = await startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(body.includes("You derive the architectural obligations") ? derivedPassBody() : verdictBody());
  });
  const github = await startGithubMock({ baseSha: "b".repeat(40), headSha: "a".repeat(40) });
  const eventPath = join(runnerTemp, "event.json");
  writeFileSync(eventPath, commentEvent());
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_HEAD_REF: "feature",
    GITHUB_BASE_REF: "main",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: github.url,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    GITHUB_STEP_SUMMARY: join(runnerTemp, "step-summary.md"),
    "INPUT_GITHUB-TOKEN": "tok",
    "INPUT_AI-BASE-URL": model.url,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-STREAM": "false",
    "INPUT_AI-API-KEY": "k",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_CI-STATUS-CHECK": "false",
    "INPUT_PUBLISH-MODE": "comment",
    "INPUT_PUBLISH-REVIEW-COMMENT": "false",
    ...(derived ? { "INPUT_DERIVED-OBLIGATIONS": "true" } : {}),
  };
  const cleanup = async (): Promise<void> => {
    await model.close();
    await github.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  };
  let exitCode = -1;
  try {
    exitCode = await actionMain(env);
  } catch (error) {
    await cleanup();
    throw error;
  }
  const runDirs = readdirSync(runnerTemp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("v3-review-run-"))
    .map((entry) => join(runnerTemp, entry.name));
  assert.equal(runDirs.length, 1, "expected exactly one action run dir");
  return { exitCode, commentPosts: github.commentPosts, runDir: runDirs[0]!, cleanup };
}

test("#1449 action: the published comment's marker carries the derived state", async () => {
  const result = await runActionCase(true);
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.commentPosts.length, 1, "the sticky comment did not publish");
    const body = (JSON.parse(result.commentPosts[0]!) as { body?: string }).body ?? "";
    const marker = parseMetadata(body);
    assert.ok(marker !== null, "the published comment carries no metadata marker");
    // The derived obligation stayed undischarged, so the state says so.
    assert.equal(marker!.derived_obligation_state, "unresolved");
    // The standalone CLI publishes the SAME record for the same run.
    const standalone = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: result.runDir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(standalone.derivedObligationState, marker!.derived_obligation_state);
  } finally {
    await result.cleanup();
  }
});

test("#1449 action: a run without the feature publishes no derived state value", async () => {
  const result = await runActionCase(false);
  try {
    assert.equal(result.exitCode, 0);
    assert.equal(result.commentPosts.length, 1, "the sticky comment did not publish");
    const body = (JSON.parse(result.commentPosts[0]!) as { body?: string }).body ?? "";
    // #1521: the MARKER carries no derived state when the feature is off,
    // and the handoff document's member is null (unknown). No derived state
    // VALUE is published anywhere; the member itself is always present.
    assert.ok(!markerLine(body).includes("derived_obligation_state"));
    assert.equal(handoffPayload(body).derived_obligation_state, null);
    const coverage = JSON.parse(readFileSync(join(result.runDir, "review-coverage.json"), "utf8")) as Record<string, unknown>;
    assert.equal("derived_obligation_state" in coverage, false);
    const standalone = publishInputFromEnv({ PR_REVIEWER_RUN_DIR: result.runDir, PUBLISH_MODE: "comment" } as NodeJS.ProcessEnv, "github");
    assert.equal(standalone.derivedObligationState, undefined);
  } finally {
    await result.cleanup();
  }
});
