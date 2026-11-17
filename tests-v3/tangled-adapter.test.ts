import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectTangledReviewIdentity, TangledAdapter } from "../src/platform/tangled-adapter.js";
import { TangledNotImplementedError } from "../src/platform/tangled.js";
import { TangledResolverError } from "../src/platform/tangled-bobbin.js";
import { TangledGitError } from "../src/platform/tangled-git.js";
import type { FetchLike } from "../src/platform/http.js";
import type { TangledContext } from "../src/platform/tangled.js";
import { deriveDraftState, deriveIsFork, normalizePrIdentity } from "../src/platform/pr.js";

/**
 * Tangled read adapter (#585) on the CURRENT record model (#1690 protocol
 * pivot): ticket + newest immutable patch revision from the repo account on
 * the knot, and the reviewed diff/files derived from the patch's trusted
 * base/head through the Git read surface. Exercised through injected mock
 * transports (no network) and a real local git fixture for the diff reads.
 */

const BASE_OID = "1111111111111111111111111111111111111111";
const HEAD_OID = "2222222222222222222222222222222222222222";
const TICKET_RKEY = "3lzq4w5qk2c2a";
const TICKET_URI = `at://did:plc:repo/org.tangled.track.ticket/${TICKET_RKEY}`;
const REPO_DID = "did:plc:repo";
const AUTHOR_DID = "did:plc:author";

function makeCtx(over: Partial<TangledContext> = {}): TangledContext {
  return {
    ownerDid: REPO_DID,
    repoDid: REPO_DID,
    repoName: "owner/repo",
    sourceBranch: "feat/x",
    targetBranch: "main",
    sourceSha: HEAD_OID,
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.test",
    ...over,
  };
}

interface TicketFixture {
  value: Record<string, unknown>;
  cid?: string;
  uri?: string;
}

/** One current-model ticket: a pull request (targetBranch set), open,
 * authored by the knot-stamped editor. */
function ticketFixture(over: Partial<TicketFixture> = {}): { uri: string; cid?: string; value: Record<string, unknown> } {
  return {
    uri: over.uri ?? TICKET_URI,
    cid: over.cid ?? "bafyreiticket",
    value: {
      $type: "org.tangled.track.ticket",
      title: "Add tangled read adapter",
      body: { text: "Wires the Tangled read adapter." },
      createdAt: "2026-01-02T03:04:05Z",
      state: "open",
      targetBranch: "main",
      tangledLabels: [{ name: "backend" }],
      "x-tngl-editor": AUTHOR_DID,
      ...over.value,
    },
  };
}

/** One current-model patch revision: immutable, keyed by its CID, carrying
 * trusted base/head commit ids and an optional source. */
function patchFixture(over: {
  ticket?: string;
  baseOid?: string;
  headOid?: string;
  createdAt?: string;
  source?: Record<string, unknown> | null;
  value?: Record<string, unknown>;
  uri?: string;
  cid?: string;
} = {}): { uri: string; cid?: string; value: Record<string, unknown> } {
  const value: Record<string, unknown> = {
    $type: "org.tangled.review.patch",
    ticket: over.ticket ?? TICKET_URI,
    base: { oid: over.baseOid ?? BASE_OID },
    head: { oid: over.headOid ?? HEAD_OID },
    createdAt: over.createdAt ?? "2026-01-02T03:04:05Z",
    ...(over.source === null ? {} : { source: over.source ?? { repo: REPO_DID, branch: "feat/x" } }),
    ...over.value,
  };
  return {
    uri: over.uri ?? `at://${REPO_DID}/org.tangled.review.patch/${over.cid ?? "bafyreipatch1"}`,
    cid: over.cid ?? "bafyreipatch1",
    value,
  };
}

/** A transport serving the knot's `com.atproto.repo.listRecords` for the
 * ticket and patch collections at their wire boundary. */
function makeKnotFetch(
  tickets: { uri: string; cid?: string; value: Record<string, unknown> }[],
  patches: { uri: string; cid?: string; value: Record<string, unknown> }[],
): { fetchImpl: FetchLike; calls: Array<{ collection: string | undefined; repo: string | undefined; auth: string | null }> } {
  const calls: Array<{ collection: string | undefined; repo: string | undefined; auth: string | null }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const query = Object.fromEntries(url.searchParams.entries());
    calls.push({ collection: query.collection, repo: query.repo, auth: new Headers(init?.headers).get("authorization") });
    const page = (items: typeof tickets): Response =>
      new Response(JSON.stringify({ records: items }), { status: 200, headers: { "content-type": "application/json" } });
    if (query.collection === "org.tangled.track.ticket") return page(tickets);
    if (query.collection === "org.tangled.review.patch") return page(patches);
    return new Response(JSON.stringify({ error: "unknown collection" }), { status: 400 });
  };
  return { fetchImpl, calls };
}

// ── the Git read surface fixture ────────────────────────────────────────

/** A real git repository checked out at the reviewed head: base commit
 * `hello`, head commit adds `world` and a second file. The git commands are
 * fixed-argv with local config overrides, so no global config (signing,
 * identity) can leak into the fixture. */
function makeWorkspace(): { workspace: string; baseOid: string; headOid: string; close(): void } {
  const workspace = mkdtempSync(join(tmpdir(), "v3-tangled-adapter-ws-"));
  const git = (args: string[]): string =>
    execFileSync("git", [
      "-c", "commit.gpgsign=false",
      "-c", "user.name=fixture",
      "-c", "user.email=fixture@example.com",
      ...args,
    ], {
      cwd: workspace,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8").trim();
  git(["init", "-q"]);
  writeFileSync(join(workspace, "README.md"), "hello\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "base"]);
  const baseOid = git(["rev-parse", "HEAD"]);
  writeFileSync(join(workspace, "README.md"), "hello\nworld\n");
  writeFileSync(join(workspace, "src.txt"), "new file\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "head"]);
  const headOid = git(["rev-parse", "HEAD"]);
  return {
    workspace,
    baseOid,
    headOid,
    close(): void {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

function patchFor(fix: { baseOid: string; headOid: string }): { uri: string; cid?: string; value: Record<string, unknown> } {
  return patchFixture({ baseOid: fix.baseOid, headOid: fix.headOid });
}

/** The projected GitHub-REST pull shape with its nested objects typed. */
function prOf(value: unknown): {
  title: unknown; body: unknown; state: unknown; user: Record<string, unknown>;
  head: Record<string, unknown>; base: Record<string, unknown>; merged_at: unknown;
  created_at: unknown; url: unknown; html_url: unknown; labels: unknown; draft: unknown;
} & Record<string, unknown> {
  return value as never;
}

// ── getPr: projection of the resolved review identity ──────────────────

test("getPr resolves the ticket + newest patch and projects the GitHub-REST shape", async () => {
  const fix = makeWorkspace();
  try {
    const knot = makeKnotFetch([ticketFixture()], [patchFor(fix)]);
    const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: knot.fetchImpl });
    const pr = prOf(await adapter.getPr());
    assert.equal(pr.title, "Add tangled read adapter");
    assert.equal(pr.body, "Wires the Tangled read adapter.");
    assert.equal(pr.state, "open");
    assert.deepEqual(pr.user, { login: AUTHOR_DID }, "the knot-stamped editor is the author");
    const head = pr.head;
    assert.equal(head.sha, fix.headOid, "head.sha is the selected patch revision's trusted head.oid");
    assert.equal(head.ref, "feat/x");
    assert.deepEqual(head.repo, { full_name: REPO_DID });
    const base = pr.base;
    assert.equal(base.sha, fix.baseOid, "base.sha is the selected patch revision's trusted base.oid");
    assert.equal(base.ref, "main");
    assert.deepEqual(base.repo, { full_name: REPO_DID });
    assert.equal(pr.merged_at, null);
    assert.equal(pr.created_at, "2026-01-02T03:04:05Z");
    assert.equal(pr.url, TICKET_URI);
    assert.equal(pr.html_url, TICKET_URI);
    assert.deepEqual(pr.labels, ["backend"]);
    // Tangled has no draft concept: the honest model answer is false.
    assert.equal(pr.draft, false);
    assert.equal(deriveDraftState(pr), "not-draft");
    // number is intentionally absent: Tangled has no numeric identity.
    assert.equal("number" in pr, false);
    // The knot read the run's two collections, bound to the repo DID.
    const collections = knot.calls.map((c) => c.collection);
    assert.ok(collections.includes("org.tangled.track.ticket"));
    assert.ok(collections.includes("org.tangled.review.patch"));
    for (const call of knot.calls) assert.equal(call.repo, REPO_DID);
  } finally {
    fix.close();
  }
});

test("a completed (merged) ticket projects to the closed state", () => {
  const identity = {
    ticketUri: TICKET_URI,
    ticketCid: "bafyreiticket",
    ticketRkey: TICKET_RKEY,
    ticketValue: {
      title: "Merged pull",
      createdAt: "2026-01-02T03:04:05Z",
      state: "completed",
      targetBranch: "main",
      "x-tngl-editor": AUTHOR_DID,
    },
    patchUri: `at://${REPO_DID}/org.tangled.review.patch/bafyreipatch1`,
    patchCid: "bafyreipatch1",
    patchValue: {},
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    targetBranch: "main",
    sourceBranch: "feat/x",
    sourceRepoDid: REPO_DID,
    state: "completed",
  };
  const pr = prOf(projectTangledReviewIdentity(identity, REPO_DID));
  assert.equal(pr.state, "closed", "completed maps to the merged-equivalent closed state");
  assert.equal(pr.head.sha, HEAD_OID, "head.sha is the trusted patch head");
  assert.equal(pr.base.sha, BASE_OID, "base.sha is the trusted patch base");
});

test("a source-less patch revision fails closed to fork and an empty head branch", async () => {
  const fix = makeWorkspace();
  try {
    const sourceless = patchFor(fix);
    delete sourceless.value.source;
    const knot2 = makeKnotFetch([ticketFixture()], [sourceless]);
    const pr = prOf(await new TangledAdapter({ context: makeCtx(), fetchImpl: knot2.fetchImpl }).getPr());
    assert.equal(pr.head.ref, "", "a source-less revision names no head branch");
    assert.equal((pr.head.repo as Record<string, unknown>).full_name, "");
    assert.equal(deriveIsFork(pr), true, "a source-less revision fails closed to fork");
  } finally {
    fix.close();
  }
});

// ── getPr: failure surfaces ─────────────────────────────────────────────

test("getPr returns null on resolution failures (never throws)", async () => {
  // No ticket matches the context's target branch.
  const other = makeKnotFetch(
    [ticketFixture({ value: { targetBranch: "develop" } })],
    [],
  );
  assert.equal(
    await new TangledAdapter({ context: makeCtx(), fetchImpl: other.fetchImpl }).getPr(),
    null,
    "no matching ticket → null",
  );
  // An unreadable knot.
  const dead: FetchLike = async () => {
    throw new TypeError("network");
  };
  assert.equal(
    await new TangledAdapter({ context: makeCtx(), fetchImpl: dead }).getPr(),
    null,
    "transport failure → null",
  );
  // No knot host configured at all.
  assert.equal(
    await new TangledAdapter({ context: makeCtx({ knotHost: undefined }), fetchImpl: other.fetchImpl }).getPr(),
    null,
    "missing knot host → null",
  );
});

test("getPrDiff fails closed with the typed error of the failing step", async () => {
  // No matching ticket: the resolution step fails before any diff work.
  const noMatch = makeKnotFetch([], []);
  const noMatchAdapter = new TangledAdapter({
    context: makeCtx(),
    fetchImpl: noMatch.fetchImpl,
    workspace: ".",
  });
  await assert.rejects(
    () => noMatchAdapter.getPrDiff(),
    (e: unknown) => e instanceof TangledResolverError,
  );
  const noMatchFiles = await noMatchAdapter.listPrFiles();
  assert.equal(noMatchFiles.ok, false, "listPrFiles surfaces the same failed resolution");
});

test("getPrDiff fails closed when the checkout cannot produce the reviewed diff", async () => {
  const fix = makeWorkspace();
  try {
    // A patch revision whose head object the checkout does not carry
    // (e.g. a round submitted after the host checked out): git exits
    // nonzero → fail closed with the failing read named.
    const knot = makeKnotFetch(
      [ticketFixture()],
      [patchFixture({ baseOid: fix.baseOid, headOid: "3".repeat(40) })],
    );
    const adapter = new TangledAdapter({
      context: makeCtx(),
      fetchImpl: knot.fetchImpl,
      workspace: fix.workspace,
    });
    await assert.rejects(
      () => adapter.getPrDiff(),
      (e: unknown) => e instanceof TangledGitError,
    );
    const files = await adapter.listPrFiles();
    assert.equal(files.ok, false);
    if (!files.ok) assert.match(files.error, /git diff/, "the ReadResult error carries the typed failure");
  } finally {
    fix.close();
  }
});

test("getPrDiff fails closed without a run workspace (the checkout is the Git read surface)", async () => {
  const knot = makeKnotFetch([ticketFixture()], [patchFixture()]);
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: knot.fetchImpl });
  await assert.rejects(
    () => adapter.getPrDiff(),
    (e: unknown) => e instanceof TangledNotImplementedError && /workspace/.test(e.message),
  );
});

// ── the wired diff/files reads (#1690) ──────────────────────────────────

test("getPrDiff and listPrFiles derive the reviewed diff/files from the selected patch revision", async () => {
  const fix = makeWorkspace();
  try {
    const knot = makeKnotFetch([ticketFixture()], [patchFor(fix)]);
    const adapter = new TangledAdapter({
      context: makeCtx(),
      fetchImpl: knot.fetchImpl,
      workspace: fix.workspace,
    });
    const diff = await adapter.getPrDiff();
    assert.match(diff, /\+world/, "the diff carries the head commit's change against the trusted base");
    assert.match(diff, /README\.md/, "the diff names the changed file");
    assert.match(diff, /src\.txt/, "the diff names the added file");

    const files = await adapter.listPrFiles();
    assert.equal(files.ok, true, "listPrFiles serves the same revision's files");
    if (!files.ok) assert.fail("files read must succeed here");
    const rows = files.data as Array<{ filename?: string; status?: string; additions?: number; patch?: string }>;
    const byName = new Map(rows.map((r) => [r.filename, r]));
    assert.equal(byName.get("README.md")?.status, "modified");
    assert.equal(byName.get("README.md")?.additions, 1);
    assert.match(byName.get("README.md")?.patch ?? "", /\+world/);
    assert.equal(byName.get("src.txt")?.status, "added");

    // Memoized: a second read re-presents the same reviewed revision
    // without re-reading the knot or re-running git.
    const diffAgain = await adapter.getPrDiff();
    assert.equal(diffAgain, diff);
    assert.equal(knot.calls.length, 2, "one ticket + one patch knot read for the whole run");
  } finally {
    fix.close();
  }
});

// ── capabilities ────────────────────────────────────────────────────────

test("listIssueComments and listPrReviews return the empty truth (#1690)", async () => {
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: makeKnotFetch([], []).fetchImpl });
  assert.deepEqual(await adapter.listIssueComments(), []);
  assert.deepEqual(await adapter.listPrReviews(), []);
});

test("every capability Tangled has no source for keeps its fail-closed answer", async () => {
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: makeKnotFetch([], []).fetchImpl });
  assert.equal(adapter.platform, "tangled");

  // ghApi never throws; it reports the error in-band.
  const gh = await adapter.ghApi("/repos/o/r");
  assert.ok(gh.error !== undefined && /gh_api/.test(gh.error), "gh_api reports its capability error in-band");
  // Unprovable identity and coarse permission fail closed.
  assert.equal(await adapter.authenticatedIdentity(), null);
  assert.equal(await adapter.repoPermission(), "unknown");
  // ReadResult-shaped reads return { ok: false, error }.
  const reads = [
    adapter.getIssue("o/r", "9"),
    adapter.listPrConversationComments(),
    adapter.listReviewThreads(),
    adapter.listPrReviewsPaginated(),
  ];
  for (const read of reads) {
    const r = await read;
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error !== "", "every ReadResult failure carries a capability message");
  }
  // externalChecks fails loud: null is the seam's transient-retry signal,
  // and a permanently-missing capability must not masquerade as a retryable read.
  await assert.rejects(
    () => adapter.externalChecks("deadbeef"),
    (e: unknown) => e instanceof TangledNotImplementedError && /external check/.test(e.message),
  );
});

// ── identity retention ─────────────────────────────────────────────────

test("the review identity is retained after a resolved getPr and is null before it", async () => {
  const knot = makeKnotFetch([ticketFixture()], [patchFixture()]);
  const adapter = new TangledAdapter({ context: makeCtx(), fetchImpl: knot.fetchImpl });
  const before = adapter.pullIdentity;
  assert.equal(before, null, "no identity before a resolution");
  await adapter.getPr();
  const identity = adapter.pullIdentity;
  if (identity === null) assert.fail("the resolved identity must be retained after getPr");
  assert.equal(identity.ticketUri, TICKET_URI);
  assert.equal(identity.patchUri, `at://${REPO_DID}/org.tangled.review.patch/bafyreipatch1`);
  assert.equal(identity.headOid, HEAD_OID);
  assert.equal(identity.baseOid, BASE_OID);
  assert.equal(identity.sourceBranch, "feat/x");
});

// ── credential transport ─────────────────────────────────────────────────

test("the token travels only as the Authorization header to the validated knot origin", async () => {
  const secret = "s3cr3t-tangled-token";
  const token = `Bearer ${secret}`;
  const knot = makeKnotFetch([ticketFixture()], [patchFixture()]);
  await new TangledAdapter({ context: makeCtx(), fetchImpl: knot.fetchImpl, token }).getPr();
  for (const call of knot.calls) {
    assert.equal(call.auth, token, "the token is sent as the Authorization header");
  }
  // (URL/argv/body leakage is impossible by construction here: requestJson
  // carries the token only in headers, and the pinned adapter test below
  // asserts the knot binding.)
});
