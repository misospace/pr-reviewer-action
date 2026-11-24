/** The #1682 identity pin for the forge capability composition: `gitea` is
 * an identity served by the Forgejo-compatible stack — the composition
 * builds the same adapters under the `gitea` identity (the identity only
 * reaches `describe()` and the `identity` field), fails closed without the
 * shared FORGEJO_TOKEN material, and the `forgejo` identity keeps its own
 * diagnostic unchanged.
 *
 * The CANONICAL `platform` field never carries the identity: it stays the
 * `forgejo` family, exactly as before #1682, so a consumer of the exported
 * type cannot write `gitea` into a canonical record. */

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeForgeCapability,
  CONTROLLER_STICKY_MARKER,
} from "../src/controller/forge-capability.js";
import { createDurablePublisher } from "../src/controller/publication.js";
import {
  executionResultPath,
  executionRunDir,
  executionRunId,
} from "../src/controller/execution.js";
import { InMemoryControlPlaneStore } from "../src/state/index.js";
import { newJobRecord, withState } from "../src/queue/index.js";
import type { JobRecord } from "../src/queue/types.js";
import type { ReviewJob } from "../src/jobs/types.js";
import type { FetchLike } from "../src/platform/http.js";

test("a gitea composition serves the forgejo-family adapters under the gitea identity (#1682)", () => {
  const composed = composeForgeCapability({
    platform: "gitea",
    endpoint: "https://gitea.example/api/v1",
    workspaceCacheRoot: "/tmp/unused-cache",
    forgejoToken: "t",
  });
  assert.equal(composed.identity, "gitea", "the configured identity rides in its own field");
  assert.equal(
    composed.platform,
    "forgejo",
    "the canonical platform stays the forgejo family, so the identity never enters a canonical record",
  );
  assert.match(composed.describe(), /^gitea via /);
  for (const name of ["mirrorFor", "currentHeadSha", "publish"] as const) {
    assert.equal(typeof composed.capability[name], "function", `capability.${name}`);
  }
  for (const name of [
    "readPermission",
    "readComment",
    "fetchThreadComments",
    "readPrState",
    "postComment",
    "resolveHeadSha",
  ] as const) {
    assert.equal(typeof composed.followUp[name], "function", `followUp.${name}`);
  }
  assert.equal(composed.pollInstallationId, "", "the forgejo family has no App installation poll");
});

test("a gitea composition without a token fails closed naming FORGEJO_TOKEN (#1682)", () => {
  assert.throws(
    () =>
      composeForgeCapability({
        platform: "gitea",
        endpoint: "https://gitea.example/api/v1",
        workspaceCacheRoot: "/tmp/unused-cache",
      }),
    /serves gitea but no Gitea token is configured \(FORGEJO_TOKEN\)/,
  );
});

test("a forgejo composition keeps the forgejo identity (#1682 regression pin)", () => {
  const composed = composeForgeCapability({
    platform: "forgejo",
    endpoint: "https://gitea.example/api/v1",
    workspaceCacheRoot: "/tmp/unused-cache",
    forgejoToken: "t",
  });
  assert.equal(composed.platform, "forgejo");
  assert.equal(composed.identity, "forgejo");
  assert.match(composed.describe(), /^forgejo via /);
});

// #1682: one controller can host a `forgejo` AND a `gitea` integration (they
// share the wire protocol, so they share this cache root), and both may carry
// the same `owner/repo` name. The mirror directory is keyed by the DECLARED
// identity, so one product never reviews the other product's mirror content.
test("a gitea composition's mirror never shares the forgejo family's mirror directory (#1682)", async () => {
  const gitea = composeForgeCapability({
    platform: "gitea",
    endpoint: "https://gitea.example/api/v1",
    workspaceCacheRoot: "/tmp/unused-cache",
    forgejoToken: "t",
  });
  const forgejo = composeForgeCapability({
    platform: "forgejo",
    endpoint: "https://forgejo.example/api/v1",
    workspaceCacheRoot: "/tmp/unused-cache",
    forgejoToken: "t",
  });
  const job = { repoFullName: "acme/widgets", installationId: "" } as unknown as ReviewJob;
  const giteaMirror = await gitea.capability.mirrorFor(job);
  const forgejoMirror = await forgejo.capability.mirrorFor(job);
  assert.equal(giteaMirror.platform, "gitea", "the mirror carries the declared identity");
  assert.notEqual(
    giteaMirror.path,
    forgejoMirror.path,
    "one product's mirror is never the other product's mirror",
  );
});

// ── GitHub composition: the authenticated current-head read (#1780) ─────────
//
// The publication gate reads the CURRENT PR head over this capability. A
// private repository answers an unauthenticated PR read with 404, so an
// uncredentialed head read failed the gate on every publish attempt. The pin:
// the head read travels the SAME authenticated client as the publish write,
// and with no installation to authenticate as it refuses instead of falling
// back to an unauthenticated read.

const { privateKey: GITHUB_TEST_KEY } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const GITHUB_TEST_KEY_PEM = GITHUB_TEST_KEY.export({ type: "pkcs8", format: "pem" }).toString();

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_APP_ID = "123456";
const GITHUB_INSTALLATION = "42";
const GITHUB_INSTALLATION_TOKEN = "ghs_installation_token_value";
const GITHUB_HEAD_SHA = "abc1234def5678abc1234def5678abc1234def56";

interface GitHubCall {
  readonly url: string;
  readonly auth: string | null;
  readonly method: string;
  readonly body: string | null;
}

function makeGitHubFetch(
  prResponder: (call: { readonly url: string; readonly method: string }) => {
    status: number;
    body: unknown;
  },
): { fetchImpl: FetchLike; calls: GitHubCall[]; prCalls: () => GitHubCall[] } {
  const calls: GitHubCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: GitHubCall = {
      url: url.toString(),
      auth: headers.get("authorization"),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    if (url.pathname.includes("/app/installations/")) {
      return new Response(
        JSON.stringify({
          token: GITHUB_INSTALLATION_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    const served = prResponder({ url: call.url, method: call.method });
    return new Response(JSON.stringify(served.body), { status: served.status });
  };
  return {
    fetchImpl,
    calls,
    prCalls: () => calls.filter((call) => call.url.includes("/pulls/")),
  };
}

function githubCompose(fetchImpl: FetchLike) {
  return composeForgeCapability({
    platform: "github",
    endpoint: GITHUB_API_BASE,
    workspaceCacheRoot: "/tmp/unused-cache",
    githubAppId: GITHUB_APP_ID,
    githubAppPrivateKeyPem: GITHUB_TEST_KEY_PEM,
    fetchImpl,
  });
}

function githubJob(overrides: Record<string, unknown> = {}): ReviewJob {
  return {
    repoFullName: "acme/private-thing",
    prNumber: 7,
    installationId: GITHUB_INSTALLATION,
    ...overrides,
  } as unknown as ReviewJob;
}

const prBody = { id: 991, head: { sha: GITHUB_HEAD_SHA }, base: { sha: "ffff0000ffff0000ffff0000ffff0000ffff0000" } };

test("the GitHub currentHeadSha reads with the installation credential, not unauthenticated (#1780)", async () => {
  const { fetchImpl, calls, prCalls } = makeGitHubFetch(() => ({ status: 200, body: prBody }));
  const composed = githubCompose(fetchImpl);

  const head = await composed.capability.currentHeadSha(githubJob());

  assert.equal(head, GITHUB_HEAD_SHA);
  const mint = calls.find((call) => call.url.includes("/app/installations/42/access_tokens"));
  assert.ok(mint !== undefined, "the head read mints an installation token for the job's installation");
  const reads = prCalls();
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.url, `${GITHUB_API_BASE}/repos/acme/private-thing/pulls/7`);
  assert.equal(reads[0]!.auth, `Bearer ${GITHUB_INSTALLATION_TOKEN}`, "the PR read carries the installation token");
});

test("the GitHub currentHeadSha with no installation refuses instead of reading unauthenticated (#1780)", async () => {
  const { fetchImpl, calls } = makeGitHubFetch(() => ({ status: 200, body: prBody }));
  const composed = githubCompose(fetchImpl);

  for (const installationId of ["", "0", "not-a-number", "12345678901234567890"]) {
    const head = await composed.capability.currentHeadSha(githubJob({ installationId }));
    assert.equal(head, null, `installation ${installationId}: no usable credential means no read`);
  }
  assert.equal(calls.length, 0, "not one request leaves the process");
});

test("the GitHub currentHeadSha maps a failed or malformed read to null (the publisher fails closed) (#1780)", async () => {
  for (const served of [
    { status: 404, body: { message: "Not Found" } },
    { status: 500, body: { message: "boom" } },
    { status: 200, body: { head: {} } },
    { status: 200, body: { head: { sha: "" } } },
    { status: 200, body: null },
  ]) {
    const { fetchImpl } = makeGitHubFetch(() => served);
    const composed = githubCompose(fetchImpl);
    assert.equal(await composed.capability.currentHeadSha(githubJob()), null, JSON.stringify(served));
  }
});

test("the head read and the identity read agree on one authenticated head (#1780, #1772)", async () => {
  const { fetchImpl, prCalls } = makeGitHubFetch(() => ({ status: 200, body: prBody }));
  const composed = githubCompose(fetchImpl);
  const job = githubJob();

  const head = await composed.capability.currentHeadSha(job);
  const identity = await composed.capability.readPrIdentity({
    repoFullName: job.repoFullName,
    prNumber: job.prNumber,
    installationId: job.installationId,
  });

  assert.equal(identity?.headSha, head);
  assert.equal(identity?.prId, 991);
  for (const call of prCalls()) {
    assert.equal(call.auth, `Bearer ${GITHUB_INSTALLATION_TOKEN}`, "both reads authenticate the same way");
  }
});

test("head and identity reads reuse one minted installation token instead of re-minting (#1780 review)", async () => {
  const { fetchImpl, calls } = makeGitHubFetch(() => ({ status: 200, body: prBody }));
  const composed = githubCompose(fetchImpl);
  const job = githubJob();

  await composed.capability.currentHeadSha(job);
  await composed.capability.currentHeadSha(job);
  await composed.capability.readPrIdentity({
    repoFullName: job.repoFullName,
    prNumber: job.prNumber,
    installationId: job.installationId,
  });

  const mints = calls.filter((call) => call.url.includes("/app/installations/"));
  assert.equal(
    mints.length,
    1,
    "the composition's authenticator cache serves every read of the same (installation, scope)",
  );
  // The reused mint must stay REPOSITORY-SCOPED: a shared cache that
  // silently moved to the unscoped key would keep showing "one mint" while
  // broadening the grant.
  assert.deepEqual(
    (JSON.parse(mints[0]!.body!) as { repositories?: unknown }).repositories,
    ["private-thing"],
    "the one cached mint carries the repository scope, never the full installation grant",
  );
});

// ── #1780 review: the criterion the capability layer alone cannot prove ─────
//
// "The exact-head publication gate publishes a result for a private
// repository's head" is an END-TO-END claim: the daemon binds
// `createDurablePublisher`'s `currentHeadSha` and `forge` seams to THIS
// composition (src/controller/daemon.ts), so the test wires exactly those
// two seams from the composed GitHub capability and drives one publish.
// It pins that the gate passes on an authenticated head (the pre-fix 404
// read settled every attempt retry-later and never published), that the
// sticky-comment write carries the installation credential, and — the
// performance pin — that the whole flow mints ONE installation token.

test("the durable publisher publishes a private repository's head through the composed capability (#1780 review)", async (t) => {
  const { fetchImpl, calls } = makeGitHubFetch((call) => {
    if (call.url === `${GITHUB_API_BASE}/app`) return { status: 200, body: { slug: "acme-reviewer" } };
    if (call.url.includes("/pulls/")) return { status: 200, body: prBody };
    if (call.method === "GET") return { status: 200, body: [] };
    return { status: 201, body: { id: 555 } };
  });
  const composed = githubCompose(fetchImpl);

  // The worker's run directory: the execution envelope naming the review
  // artifact, exactly the layout the publication layer consumes.
  const runsRoot = mkdtempSync(join(tmpdir(), "prv-forge-pub-"));
  t.after(() => rmSync(runsRoot, { recursive: true, force: true }));
  const jobId = "job-1";
  const runDir = executionRunDir(runsRoot, jobId, 1);
  mkdirSync(runDir, { recursive: true });
  const review = { verdict: "issues", summary: "one finding" };
  const reviewPath = join(runDir, "review.json");
  writeFileSync(reviewPath, JSON.stringify(review), "utf8");
  writeFileSync(
    executionResultPath(runsRoot, jobId, 1),
    JSON.stringify({
      status: "completed",
      runId: executionRunId(jobId, 1),
      jobId,
      resultHeadSha: GITHUB_HEAD_SHA,
      failureCategory: "",
      failureMessage: "",
      resultArtifactPath: reviewPath,
      diagnostics: "",
      artifactPaths: [],
      resourceMs: 12,
      observedAtMs: 4000,
    }),
    "utf8",
  );

  // The queue record in the state the scheduler hands the publisher.
  const job: ReviewJob = Object.freeze({
    jobId,
    kind: "review",
    trigger: "webhook",
    reason: "synchronize",
    platform: "github",
    installationId: GITHUB_INSTALLATION,
    repoFullName: "acme/private-thing",
    prNumber: 7,
    prId: 991,
    headSha: GITHUB_HEAD_SHA,
    baseSha: prBody.base.sha,
    configFingerprint: "ecfg-v1-0123456789abcdef",
    nonce: "",
    adoptionEpoch: "",
    eventReference: "",
    forgeIntegration: "",
    fork: false,
    deadlineAtMs: 0,
    runId: "",
  });
  const started = {
    ...withState(
      withState(newJobRecord(job, 1000, 0), "starting", 1000),
      "running",
      1000,
    ),
    attempt: 1,
  };
  const record: JobRecord = { ...withState(started, "publishing", 2000), resultHeadSha: GITHUB_HEAD_SHA };

  // The daemon's own binding of the two seams (src/controller/daemon.ts).
  const store = new InMemoryControlPlaneStore();
  const publisher = createDurablePublisher({
    store,
    forge: composed.capability,
    currentHeadSha: (headJob) => composed.capability.currentHeadSha(headJob),
    runsRoot,
    now: () => 5000,
  });

  assert.equal(await publisher.publish(record), true, "the gate published — no retry-later");

  const publication = await store.getPublication(jobId);
  assert.notEqual(publication, null);
  assert.equal(publication!.publicationState, "published");
  assert.equal(publication!.publicationId, "github-comment:555");
  assert.equal(publication!.resultPayload, JSON.stringify(review));

  const writes = calls.filter(
    (call) => call.method === "POST" && call.url.endsWith("/repos/acme/private-thing/issues/7/comments"),
  );
  assert.equal(writes.length, 1, "one sticky-comment write reached the forge");
  assert.equal(writes[0]!.auth, `Bearer ${GITHUB_INSTALLATION_TOKEN}`, "the write authenticates");
  const commentBody = (JSON.parse(writes[0]!.body!) as { body: string }).body;
  assert.ok(commentBody.includes(CONTROLLER_STICKY_MARKER), "the body carries the managed marker");
  assert.ok(commentBody.includes(JSON.stringify(review)), "the body carries the durable payload");
  for (const call of calls.filter((c) => c.url.includes("/repos/"))) {
    assert.equal(call.auth, `Bearer ${GITHUB_INSTALLATION_TOKEN}`, `${call.method} ${call.url} authenticated`);
  }
  const mints = calls.filter((call) => call.url.includes("/app/installations/"));
  assert.equal(
    mints.length,
    1,
    "the gate's head read and the publish write share one live installation token",
  );
  assert.deepEqual(
    (JSON.parse(mints[0]!.body!) as { repositories?: unknown }).repositories,
    ["private-thing"],
    "the shared token is repository-scoped, never the full installation grant",
  );
});
