import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { startMockServer } from "./helpers.js";
import { runReview } from "../src/run/review.js";
import { runEnforcementFixture } from "../src/enforcement/fixture.js";
import { publishReview } from "../src/publish/publish.js";
import { isAlwaysNonBlockingCategory } from "../src/enforcement/verdict-policy.js";
import { KNOWN_SECRET_REDACTED, REDACTED_SOURCE } from "../src/context/redact.js";
import type {
  NativeReviewRequest,
  PublishPlatformApi,
} from "../src/platform/publish-api.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";

const ROOT = resolve(__dirname, "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "golden-replay");

// Redaction marker tokens: a blocking claim that cites a token the PR's own
// source does not contain is a claim the evidence cannot support. The plain
// `[REDACTED]` placeholder is module-private (src/context/redact.ts:10), so it
// stays literal here; the other two markers are imported from the module that
// owns them.
const MARKERS = ["[REDACTED]", REDACTED_SOURCE, KNOWN_SECRET_REDACTED];

// Findings in the post-pipeline artifact carry no id. The set present IS the
// open set: thread enforcement re-emits unresolved prior threads and drops
// fixed ones, so "absent from the artifact" is the evidence of resolution.
interface ArtifactFinding {
  severity: string;
  category?: string;
  file?: string;
  line?: number;
  message: string;
  preliminary_finding?: unknown;
  thread_id?: string;
  capped_from?: unknown;
  ci_capped?: boolean;
  outside_diff?: boolean;
}

interface RecordedFinding { id?: string; message?: string; [k: string]: unknown; }

interface ThreadDispositionExpect {
  thread_id: string;
  disposition: string;
  evidence?: string | null;
}

interface GoldenExpect {
  verdict?: string;
  blocking_finding_ids?: string[];
  prior_blocker_status?: string;
  unsupported_blocking_claims?: number;
  supported_blocking_claims?: number;
  published_body_excludes?: string[];
  published_body_includes?: string[];
  thread_dispositions?: ThreadDispositionExpect[];
}

interface GoldenCase {
  file: string;
  name: string;
  status: "active" | "expected-failure";
  knownGap?: string | undefined;
  engine: "run-review" | "enforcement-fixture";
  pr: Record<string, unknown>;
  sourceFiles: Record<string, string>;
  recordedModelResponse?: Record<string, unknown> | undefined;
  enforcement?: Record<string, unknown> | undefined;
  config: Record<string, string>;
  priorBlockerId?: string | undefined;
  secrets?: string[];
  expectedMismatchKeys?: string[] | undefined;
  expect: GoldenExpect;
}

interface RefusedCase {
  file: string;
  name: string;
  status: "active" | "expected-failure";
  reason: string;
  expectRefusal?: string | undefined;
}

// Contract gate: every validation failure is a refusal, never a replay.
// The head guard (stale-source-head) is a run-review-engine refusal only:
// a replay whose recorded head is not the fixture head would score a review
// the model never saw, so such a case can never be trusted.
function validateCase(raw: unknown): GoldenCase | { refusal: string } {
  const fx = (raw ?? {}) as Record<string, unknown>;
  if (fx.contract !== "golden-replay/v1") return { refusal: `bad-contract:${String(fx.contract)}` };
  const sourceHead = String(((fx.provenance ?? {}) as Record<string, unknown>).source_head ?? "");
  if (!/^[0-9a-f]{40}$/.test(sourceHead)) return { refusal: "bad-source-head" };
  if (fx.status !== "active" && fx.status !== "expected-failure") return { refusal: `bad-status:${String(fx.status)}` };
  if (fx.status === "expected-failure" && !fx.known_gap) return { refusal: "expected-failure-without-known-gap" };
  if (fx.engine !== "run-review" && fx.engine !== "enforcement-fixture") return { refusal: `bad-engine:${String(fx.engine)}` };
  const pr = (fx.pr ?? {}) as Record<string, unknown>;
  if (fx.engine === "run-review" && sourceHead !== String(pr.head_sha ?? "")) return { refusal: "stale-source-head" };
  return {
    file: "",
    name: String(fx.name ?? ""),
    status: fx.status as "active" | "expected-failure",
    knownGap: typeof fx.known_gap === "string" ? fx.known_gap : undefined,
    engine: fx.engine as "run-review" | "enforcement-fixture",
    pr,
    sourceFiles: (fx.source_files ?? {}) as Record<string, string>,
    recordedModelResponse: fx.recorded_model_response as Record<string, unknown> | undefined,
    enforcement: fx.enforcement as Record<string, unknown> | undefined,
    config: (fx.config ?? {}) as Record<string, string>,
    priorBlockerId: typeof fx.prior_blocker_id === "string" ? fx.prior_blocker_id : undefined,
    secrets: Array.isArray(fx.secrets) ? (fx.secrets as unknown[]).filter((s): s is string => typeof s === "string") : [],
    expectedMismatchKeys: Array.isArray(fx.expected_mismatch_keys)
      ? ((fx.expected_mismatch_keys as unknown[]).filter((s): s is string => typeof s === "string"))
      : undefined,
    expect: (fx.expect ?? {}) as GoldenExpect,
  };
}

export function loadGoldenFixtures(dir: string): { cases: GoldenCase[]; refusals: RefusedCase[] } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const cases: GoldenCase[] = [];
  const refusals: RefusedCase[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const name = String(raw.name ?? file);
    const status = raw.status === "expected-failure" ? "expected-failure" : "active";
    const expectRefusal = typeof raw.expect_refusal === "string" ? raw.expect_refusal : undefined;
    const v = validateCase(raw);
    if ("refusal" in v) { refusals.push({ file, name, status, reason: v.refusal, expectRefusal }); continue; }
    cases.push({ ...v, file, name: v.name || name });
  }
  return { cases, refusals };
}

function verdictBody(v: Record<string, unknown>): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(v) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

function mockPlatform(pr: Record<string, unknown>): PlatformReadAdapter {
  const headSha = String(pr.head_sha ?? "");
  const diff = String(pr.diff ?? "");
  const files = (pr.files as unknown[] | undefined) ?? [];
  const threads = (pr.threads as unknown[] | undefined) ?? [];
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 1, title: String(pr.title ?? "t"), body: "",
      head: { sha: headSha, ref: "feature" }, base: { ref: "main" },
      user: { login: "someone" }, changed_files: files.length || 1,
      additions: 0, deletions: 0, html_url: "https://github.com/o/r/pull/1",
    }),
    getPrDiff: () => Promise.resolve(diff),
    listPrFiles: () => Promise.resolve({ ok: true, data: files }),
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: threads }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

// Capture-side stand-in for the real publish seam. upsertStickyComment takes
// (marker, body) in the real interface, so captured comments are bodies.
class MinimalPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  submitted: NativeReviewRequest[] = [];
  comments: string[] = [];
  constructor(private readonly head: string) {}
  async getHeadSha() { return this.head; }
  async listIssueComments() { return []; }
  async upsertStickyComment(_marker: string, body: string) { this.comments.push(body); return { ok: true, created: true }; }
  async listReviews() { return []; }
  async createReview(request: NativeReviewRequest) { this.submitted.push(request); return { ok: true }; }
  async dismissReview() { return true; }
  async minimizedReviewIds() { return []; }
  async minimizeReview() { return true; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async resolveThread() { return true; }
  async removeLabel() { return true; }
}

function backtickSpans(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/`([^`]+)`/g)) out.push(m[1] ?? "");
  return out;
}

function scoreClaims(findings: ArtifactFinding[], sourceFiles: Record<string, string>) {
  // Mirror the production policy: a category that can never block does not
  // count as blocking, whatever severity it carries.
  const blocking = findings.filter(
    (f) => (f.severity === "blocker" || f.severity === "major") && !isAlwaysNonBlockingCategory(f.category),
  );
  let unsupported = 0;
  let supported = 0;
  for (const f of blocking) {
    const content = f.file ? sourceFiles[f.file] : undefined;
    const tokens = MARKERS.filter((t) => f.message.includes(t));
    if (tokens.some((t) => content === undefined || !content.includes(t))) unsupported++;
    // A cited span only supports a claim when it looks like code rather than
    // prose: it must contain a space or an operator/punctuation character.
    // Bare identifiers and marker tokens do not.
    const spans = backtickSpans(f.message).filter((s) => s.length >= 4 && /[ <>=&|;()]/.test(s));
    if (content !== undefined && spans.some((s) => content.includes(s))) supported++;
  }
  return { blocking, unsupported, supported };
}

// Artifact findings carry no id: recover the recorded id by exact message
// equality. A match against nothing is a fabricated re-emission — represent
// it as a message prefix so it shows up in the diff.
function recoverBlockingIds(actual: ArtifactFinding[], recorded: RecordedFinding[]): string[] {
  const ids: string[] = [];
  for (const f of actual) {
    const match = recorded.find((r) => typeof r.message === "string" && r.message === f.message);
    ids.push(match && typeof match.id === "string" && match.id ? match.id : f.message.slice(0, 60));
  }
  return ids.sort();
}

function parseArtifact(enforcement: Record<string, unknown> | undefined): Record<string, unknown> {
  const art = enforcement?.artifact;
  if (typeof art === "string") { try { return JSON.parse(art); } catch { return {}; } }
  if (art && typeof art === "object") return art as Record<string, unknown>;
  return {};
}

function recordedFindings(c: GoldenCase): RecordedFinding[] {
  if (c.engine === "run-review") return (c.recordedModelResponse?.findings ?? []) as RecordedFinding[];
  return (parseArtifact(c.enforcement).findings ?? []) as RecordedFinding[];
}

interface CaseScore {
  verdict: string;
  unsupported: number;
  supported: number;
  priorStatus: string | null;
  mismatches: string[];
}

function scoreCase(
  c: GoldenCase,
  actualVerdict: string,
  findings: ArtifactFinding[],
  recorded: RecordedFinding[],
  published?: { reviewBody: string; submitted: string[]; comments: string[] },
  threadDispositions?: Array<Record<string, unknown>>,
): CaseScore {
  const mismatches: string[] = [];
  const { blocking, unsupported, supported } = scoreClaims(findings, c.sourceFiles);
  const recovered = recoverBlockingIds(blocking, recorded);
  if (c.expect.verdict !== undefined) {
    const ok = c.expect.verdict === "comment" ? actualVerdict !== "request_changes" : c.expect.verdict === actualVerdict;
    if (!ok) mismatches.push(`verdict: expected ${c.expect.verdict}, got ${actualVerdict}`);
  }
  if (c.expect.blocking_finding_ids !== undefined) {
    const expected = [...c.expect.blocking_finding_ids].sort();
    if (JSON.stringify(expected) !== JSON.stringify(recovered)) {
      mismatches.push(`blocking_finding_ids: expected ${JSON.stringify(expected)}, got ${JSON.stringify(recovered)}`);
    }
  }
  // prior_blocker_status is only meaningful when the fixture names a prior
  // blocker. A re-emitted open finding carries the thread_id but a message
  // suffix, so message-equality id recovery misses it — the carried
  // thread_id is the reliable signal that the thread is still unresolved.
  const priorStatus = c.priorBlockerId
    ? (recovered.includes(c.priorBlockerId) || blocking.some((f) => f.thread_id === c.priorBlockerId) ? "open" : "resolved")
    : null;
  if (c.expect.prior_blocker_status !== undefined && c.expect.prior_blocker_status !== priorStatus) {
    mismatches.push(`prior_blocker_status: expected ${c.expect.prior_blocker_status}, got ${priorStatus ?? "n/a"}`);
  }
  if (c.expect.unsupported_blocking_claims !== undefined && c.expect.unsupported_blocking_claims !== unsupported) {
    mismatches.push(`unsupported_blocking_claims: expected ${c.expect.unsupported_blocking_claims}, got ${unsupported}`);
  }
  if (c.expect.supported_blocking_claims !== undefined && c.expect.supported_blocking_claims !== supported) {
    mismatches.push(`supported_blocking_claims: expected ${c.expect.supported_blocking_claims}, got ${supported}`);
  }
  // The settled disposition records the pipeline wrote to the final artifact,
  // compared as a sorted (thread_id, disposition, evidence) set.
  if (c.expect.thread_dispositions !== undefined) {
    const canonical = (d: Record<string, unknown>) =>
      `${String(d.thread_id ?? "")}:${String(d.disposition ?? "")}:${typeof d.evidence === "string" ? d.evidence : ""}`;
    const actual = (threadDispositions ?? []).map(canonical).sort();
    const expected = c.expect.thread_dispositions
      .map((d) => `${d.thread_id}:${d.disposition}:${d.evidence ?? ""}`)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push(`thread_dispositions: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  // Published-body checks apply to the run-review engine only; enforcement
  // fixtures pass empty arrays and never publish. Fixture `secrets` are
  // excluded on every published surface in addition to explicit excludes.
  if (c.engine === "run-review" && published) {
    const excludes = [...new Set([...(c.expect.published_body_excludes ?? []), ...(c.secrets ?? [])])];
    for (const v of excludes) {
      const where = [...(published.reviewBody.includes(v) ? ["review-body.md"] : [])]
        .concat(published.submitted.filter((b) => b.includes(v)).map(() => "submitted-review"))
        .concat(published.comments.filter((b) => b.includes(v)).map(() => "sticky-comment"));
      if (where.length) mismatches.push(`published_body_excludes: ${JSON.stringify(v)} found in ${where.join(", ")}`);
    }
    for (const v of c.expect.published_body_includes ?? []) {
      if (!published.reviewBody.includes(v)) mismatches.push(`published_body_includes: ${JSON.stringify(v)} missing from review-body.md`);
    }
  }
  return { verdict: actualVerdict, unsupported, supported, priorStatus, mismatches };
}

async function replayRunReview(c: GoldenCase): Promise<CaseScore> {
  const pr = c.pr;
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(c.recordedModelResponse ?? {}));
  });
  const runDir = mkdtempSync(join(tmpdir(), "golden-replay-"));
  try {
    const result = await runReview({
      env: { GITHUB_OUTPUT: join(runDir, "o.txt"), GITHUB_STEP_SUMMARY: join(runDir, "s.md") },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "1",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        // The replay workspace is not a git checkout, so repository-map
        // generation can only fail; the config input that controls it keeps
        // the run quiet instead of logging the guaranteed failure.
        "repo-map-context": "false",
        ...c.config,
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(pr),
      persistArtifacts: true,
      quiet: true,
    });
    const artifact = result.reviewArtifact as unknown as {
      findings?: ArtifactFinding[];
      thread_dispositions?: Array<Record<string, unknown>>;
    };
    const findings = artifact.findings ?? [];
    const api = new MinimalPublishApi(String(pr.head_sha));
    await publishReview(
      {
        mode: "review_verdict",
        reviewMarkdown: result.outputs.reviewMarkdown,
        verdict: result.outputs.verdict,
        verdictPolicy: result.verdictPolicy,
        analysisEngine: result.outputs.analysisEngine,
        baseSha: "b".repeat(40),
        headSha: String(pr.head_sha),
        prNumber: "1",
        commentMarker: "<!-- ai-pr-review -->",
        requiredChecks: result.outputs.requiredChecks,
        reviewRoute: result.outputs.reviewRoute,
        escalationReason: result.outputs.escalationReason,
        cacheHitRatio: result.outputs.cacheHitRatio,
        inlineFindings: false,
        inlineFindingsMax: 5,
        findings: JSON.parse(result.outputs.findings),
        cleanupPreviousNativeReviews: "false",
        allowApprove: true,
        approveForks: false,
        isForkPr: false,
        upstreamLinkMode: "inert",
        conditionalPresence: { linkedIssue: false, evidenceProvider: false, standards: false, toolHarnessFindings: false, toolHarnessResults: false },
        forgejoPositions: false,
      },
      api,
      { diffText: String(pr.diff ?? "") },
    );
    const published = {
      reviewBody: readFileSync(join(runDir, "review-body.md"), "utf8"),
      submitted: api.submitted.map((r) => r.body),
      comments: api.comments,
    };
    return scoreCase(c, result.outputs.verdict, findings, recordedFindings(c), published, artifact.thread_dispositions);
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

function replayEnforcement(c: GoldenCase): CaseScore {
  const tmp = mkdtempSync(join(tmpdir(), "golden-enf-"));
  const path = join(tmp, "enforcement.json");
  writeFileSync(path, JSON.stringify(c.enforcement ?? {}));
  try {
    const result = runEnforcementFixture(path);
    if (!result.ok) {
      return { verdict: "(run failed)", unsupported: 0, supported: 0, priorStatus: null, mismatches: [`enforcement_run: expected ok, got failed: ${String(result.stderr).slice(0, 200)}`] };
    }
    if (result.values === undefined) {
      return { verdict: "(no values)", unsupported: 0, supported: 0, priorStatus: null, mismatches: ["enforcement_run: expected values, got none"] };
    }
    const art = JSON.parse(String(result.values.artifact ?? "{}")) as {
      verdict?: string;
      findings?: ArtifactFinding[];
      thread_dispositions?: Array<Record<string, unknown>>;
    };
    return scoreCase(c, String(art.verdict ?? ""), art.findings ?? [], recordedFindings(c), undefined, art.thread_dispositions);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const refusalReason = (raw: unknown): string | undefined => {
  const v = validateCase(raw);
  return "refusal" in v ? v.refusal : undefined;
};

test("golden-replay loader head guard", () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    contract: "golden-replay/v1",
    name: "inline",
    status: "active",
    provenance: { source_head: "a".repeat(40) },
    engine: "run-review",
    pr: { head_sha: "a".repeat(40), diff: "" },
    ...over,
  });
  assert.ok(!("refusal" in validateCase(mk())), "valid active run-review case passes");
  assert.equal(refusalReason(mk({ provenance: { source_head: "b".repeat(40) } })), "stale-source-head");
  assert.equal(refusalReason(mk({ contract: "golden-replay/v9" })), "bad-contract:golden-replay/v9");
  assert.equal(refusalReason(mk({ provenance: { source_head: "nope" } })), "bad-source-head");
  assert.equal(refusalReason(mk({ status: "weird" })), "bad-status:weird");
  assert.equal(refusalReason(mk({ status: "expected-failure" })), "expected-failure-without-known-gap");
  assert.equal(refusalReason(mk({ engine: "weird-engine" })), "bad-engine:weird-engine");
  // The head guard is run-review only: an enforcement fixture with no PR
  // head of its own must not be refused on a head it does not have.
  assert.ok(refusalReason(mk({ engine: "enforcement-fixture", pr: {} })) === undefined, "enforcement engine skips the head guard");
});

const loaded = loadGoldenFixtures(FIXTURES);
const report: Array<Record<string, unknown>> = [];
const ordered = [
  ...loaded.cases.map((c) => ({ kind: "case" as const, file: c.file, c })),
  ...loaded.refusals.map((refusal) => ({ kind: "refusal" as const, file: refusal.file, refusal })),
].sort((a, b) => a.file.localeCompare(b.file));

for (const entry of ordered) {
  if (entry.kind === "case") {
    const c = entry.c;
    test(`golden-replay:${c.name}`, async () => {
      const score = c.engine === "run-review" ? await replayRunReview(c) : replayEnforcement(c);
      report.push({
        name: c.name, status: c.status, verdict: score.verdict,
        unsupported_blocking_claims: score.unsupported, supported_blocking_claims: score.supported,
        prior_blocker_status: score.priorStatus,
      });
      if (c.status === "active") {
        if (score.mismatches.length) throw new Error(`golden ${c.name} mismatched: ${score.mismatches.join("; ")}`);
      } else {
        // expected-failure is a pinned regression: the documented gap must
        // still fail, and a zero-mismatch run means the companion fix landed.
        if (score.mismatches.length === 0) throw new Error(`golden ${c.name}: companion fix landed — promote golden to active`);
        if (c.expectedMismatchKeys !== undefined) {
          // The recorded key set (the field before each mismatch's ":") pins
          // the failure shape: a different set means the gap changed shape,
          // which a key-count-only pin would have missed.
          const keys = [...new Set(
            score.mismatches.map((m) => {
              const i = m.indexOf(":");
              return (i >= 0 ? m.slice(0, i) : m).trim();
            }),
          )].sort();
          const expected = [...c.expectedMismatchKeys].sort();
          if (JSON.stringify(keys) !== JSON.stringify(expected)) {
            throw new Error(`golden ${c.name}: failure shape changed — recorded keys ${JSON.stringify(expected)}, actual ${JSON.stringify(keys)}`);
          }
        }
        console.log(`golden ${c.name} still fails as documented (${c.knownGap}): ${score.mismatches.join(" | ")}`);
      }
    });
  } else {
    const r = entry.refusal;
    test(`golden-replay:${r.name}`, () => {
      const mismatches: string[] = [];
      if (r.expectRefusal !== undefined) {
        if (r.reason !== r.expectRefusal) mismatches.push(`expect_refusal: expected ${r.expectRefusal}, got ${r.reason}`);
      } else {
        mismatches.push(`expect_refusal: expected (none), got ${r.reason}`);
      }
      report.push({
        name: r.name, status: `refused:${r.reason}`, verdict: null,
        unsupported_blocking_claims: 0, supported_blocking_claims: 0, prior_blocker_status: null,
      });
      if (r.status === "active") {
        if (mismatches.length) throw new Error(`golden ${r.name} (refused, never replayed) mismatched: ${mismatches.join("; ")}`);
      } else {
        if (mismatches.length === 0) throw new Error(`golden ${r.name}: companion fix landed — promote golden to active`);
        console.log(`golden ${r.name} still fails as documented (refused ${r.reason})`);
      }
    });
  }
}

after(() => {
  console.log(JSON.stringify({ "golden-replay": report }));
});
