/**
 * #591: end-to-end Tangled smoke test on the CURRENT record model (#1690
 * protocol pivot).
 *
 * Drives the host-neutral runner (`platformActionMain`) through one full
 * offline round — ticket/patch resolution, diff/files, model review, and
 * managed-comment publication — and a second round that must UPDATE the
 * managed review instead of duplicating it.
 *
 * Current Tangled models a pull request as one `org.tangled.track.ticket`
 * in the repository account plus immutable `org.tangled.review.patch`
 * revisions carrying trusted `base.oid`/`head.oid`; the pre-2026-10-28
 * `sh.tangled.repo.pull` / `rounds[].patchBlob` model is obsolete and is
 * NOT mocked or consumed here (the corrected #1690 is the contract).
 *
 * Unlike the #590 runner suite (which injects whole fake read/write seams to
 * prove the orchestration), this smoke runs the REAL production capability
 * stack — `platformActionMain` receives NO seams at all — and mocks only
 * the services the Tangled host would provide, each at its own wire
 * boundary:
 * - the Spindle runtime variables come from the real `tangledContextFromEnv`
 *   over a plain `TANGLED_*` environment (no GitHub Actions bookkeeping);
 * - the read capability is the STOCK `TangledAdapter` built by the
 *   production factory (`buildPlatformReadAdapter` over the engine's
 *   admission stage env, workspace included) — no method overrides, no
 *   injected transports;
 * - the knot is a scoped `globalThis.fetch` stub intercepting ONLY
 *   `https://knot.test/xrpc/com.atproto.repo.listRecords` — the one wire
 *   the production factory builds without an injectable transport — serving
 *   the current ticket/patch record shapes; every other request passes
 *   through untouched. The knot is the record authority for tickets and
 *   patches (and the #1165 head-proof source), so one stub proves the
 *   whole read side;
 * - the reviewed diff/files derive from the selected patch revision's
 *   trusted base/head through the REAL Git read surface: the workspace is a
 *   real SHA-256 repository checked out across the patch's two commits;
 * - publication goes through the PRODUCTION `buildPublishApi` factory: the
 *   real `TangledAtprotoClient` + `TangledPublishApi` against a stateful
 *   mock PDS (session, listRecords, createRecord, putRecord, deleteRecord),
 *   and the real #1165 current-head re-check against the same knot stub.
 *   The #1691 concurrency races drive the same real client + publish API
 *   directly against the mock PDS, because the runner cannot interleave two
 *   of its own rounds deterministically;
 * - the model is a local mock serving one OpenAI-style chat completion.
 *
 * Everything stays offline: the only network targets are the loopback mock
 * servers and the stubbed knot host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { platformActionMain } from "../src/run/platform-action.js";
import { TangledHeadReadConfigError } from "../src/platform/tangled-head.js";
import { TangledAtprotoClient } from "../src/platform/tangled-atproto.js";
import { TANGLED_MANAGED_REVIEW_COLLECTION, TangledPublishApi, managedReviewRkey } from "../src/platform/tangled-publish.js";
import type { TangledReviewIdentity } from "../src/platform/tangled-ticket.js";
import type { TangledContext } from "../src/platform/tangled.js";
import { startMockServer, type MockServer } from "./helpers.js";

const OWNER_DID = "did:plc:owner00000000000000000000000000000000000000000000000";
const REPO_DID = "did:plc:repo000000000000000000000000000000000000000000000000";
const AUTHOR_DID = "did:plc:author000000000000000000000000000000000000000000000";
const BOT_DID = "did:plc:bot0000000000000000000000000000000000000000000000000";
const TICKET_RKEY = "3lzq4w5qk2c2a";
const TICKET_URI = `at://${REPO_DID}/org.tangled.track.ticket/${TICKET_RKEY}`;
const PATCH_CID = "bafyreipatch0000000000000000000000000000000000000000000";
const TICKET2_RKEY = "3lzvvvvvvvvvvvvb";
const TICKET2_URI = `at://${REPO_DID}/org.tangled.track.ticket/${TICKET2_RKEY}`;
const PATCH2_CID = "bafyreipatch200000000000000000000000000000000000000000";
const KNOT_HOST = "knot.test";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A real SHA-256 repository spanning three commits: base (`hello`), an
 * intermediate round H1, and the head commit H2 (`world`). SHA-256 is the
 * current knot default (new repositories), so the smoke proves the 64-hex
 * oid path end to end. Fixed-argv git with local config overrides — no
 * global config (signing, identity) can leak into the fixture. */
function makeRoundWorkspace(): { workspace: string; baseOid: string; intermediateOid: string; headOid: string; close(): void } {
  const workspace = mkdtempSync(join(tmpdir(), "v3-tangled-e2e-ws-"));
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
  git(["init", "-q", "--object-format=sha256"]);
  writeFileSync(join(workspace, "README.md"), "hello\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base: greeting"]);
  const baseOid = git(["rev-parse", "HEAD"]);
  writeFileSync(join(workspace, "README.md"), "hello\ndevelopment\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "round 1: development state"]);
  const intermediateOid = git(["rev-parse", "HEAD"]);
  writeFileSync(join(workspace, "README.md"), "hello\nworld\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "round 2: add the greeting"]);
  const headOid = git(["rev-parse", "HEAD"]);
  return {
    workspace,
    baseOid,
    intermediateOid,
    headOid,
    close(): void {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** The knot wire boundary: the production read factory AND the production
 * publish factory both build their knot reads without an injectable
 * transport, so the knot's `com.atproto.repo.listRecords` is mocked by a
 * scoped `globalThis.fetch` stub that intercepts ONLY the knot host and
 * passes everything else through. `calls` records every intercepted
 * collection read. */
interface KnotFixtures {
  ticket: Record<string, unknown>;
  patch: Record<string, unknown>;
  /** Additional tickets/patches the tracker exposes alongside the run's own
   * (the stateful TOCTOU fixtures: a replacement ticket that appeared). */
  extraTickets?: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
  extraPatches?: Array<{ uri: string; cid: string; value: Record<string, unknown> }>;
}

/** Optional extras for a STATEFUL knot: `afterFirstTicketRead` fires exactly
 * once, after the first ticket-collection page is served — the hook a test
 * uses to mutate the tracker mid-run (the TOCTOU window opens at that
 * moment: the read adapter has resolved, publication has not run yet). */
interface KnotStubOptions {
  fixtures: () => KnotFixtures;
  afterFirstTicketRead?: (() => void) | undefined;
}

async function withKnotStub<T>(
  run: () => Promise<T>,
  options: KnotStubOptions,
): Promise<{ result: T; knotCalls: string[] }> {
  const calls: string[] = [];
  let ticketReads = 0;
  const original = globalThis.fetch;
  const stubbed: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== KNOT_HOST || url.pathname !== "/xrpc/com.atproto.repo.listRecords") {
      return original(input, init);
    }
    calls.push(String(url.searchParams.get("collection")));
    if (url.searchParams.get("repo") !== REPO_DID) return json({ error: "unknown repo" }, 400);
    if (url.searchParams.get("collection") === "org.tangled.track.ticket") {
      ticketReads += 1;
      const fixtures = options.fixtures();
      if (ticketReads === 1) options.afterFirstTicketRead?.();
      return json({
        records: [
          { uri: TICKET_URI, cid: "bafyreiticket", value: fixtures.ticket },
          ...(fixtures.extraTickets ?? []),
        ],
      });
    }
    if (url.searchParams.get("collection") === "org.tangled.review.patch") {
      const fixtures = options.fixtures();
      return json({
        records: [
          {
            uri: `at://${REPO_DID}/org.tangled.review.patch/${PATCH_CID}`,
            cid: PATCH_CID,
            value: fixtures.patch,
          },
          ...(fixtures.extraPatches ?? []),
        ],
      });
    }
    return json({ records: [] });
  };
  globalThis.fetch = stubbed;
  try {
    const result = await run();
    return { result, knotCalls: calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** Stateful AT-Proto record store behind a mock PDS: the managed-record
 * create/update assertions run against real `TangledPublishApi` +
 * `TangledAtprotoClient` calls hitting this server. */
interface MockPds {
  server: MockServer;
  records: Map<string, Record<string, unknown>>;
  creates: number;
  puts: number;
  deletes: number;
  /** #1691: hold every subsequent `listRecords` response until `needed`
   * list requests have arrived (the response snapshots the store AT
   * REQUEST ENTRY), so a test can force a concurrent list-then-create
   * race deterministically over real HTTP. */
  armListBarrier(needed: number): void;
}

async function startMockPds(): Promise<MockPds> {
  const records = new Map<string, Record<string, unknown>>();
  let counter = 0;
  let barrierNeeded = 0;
  let barrierEntered = 0;
  let barrierPromise: Promise<void> = Promise.resolve();
  let barrierRelease: () => void = () => {};
  const pds: MockPds = {
    records,
    creates: 0,
    puts: 0,
    deletes: 0,
    server: undefined as unknown as MockServer,
    armListBarrier(needed: number) {
      barrierNeeded = needed;
      barrierEntered = 0;
      barrierPromise = new Promise<void>((resolve) => {
        barrierRelease = resolve;
      });
    },
  };
  pds.server = await startMockServer(async (req: IncomingMessage, body: string, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/xrpc/com.atproto.server.createSession") {
      const request = JSON.parse(body) as { identifier?: string; password?: string };
      if (request.password !== "app-password-value") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "Invalid identifier or password" }));
        return;
      }
      res.end(JSON.stringify({
        did: BOT_DID,
        handle: request.identifier ?? "bot.test",
        accessJwt: "access-jwt",
        refreshJwt: "refresh-jwt",
      }));
      return;
    }
    if (path === "/xrpc/com.atproto.repo.listRecords") {
      // Bound the read to the managed collection: a wrong-NSID or
      // wrong-repo regression must not be answered with an empty page.
      if (url.searchParams.get("collection") !== TANGLED_MANAGED_REVIEW_COLLECTION
        || url.searchParams.get("repo") !== BOT_DID) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Unknown collection or repo" }));
        return;
      }
      const snapshot = JSON.stringify({
        records: [...records.entries()].map(([uri, value]) => ({ uri, value })),
      });
      if (barrierNeeded > 0) {
        barrierEntered += 1;
        if (barrierEntered >= barrierNeeded) barrierRelease();
        await barrierPromise;
      }
      res.end(snapshot);
      return;
    }
    if (path === "/xrpc/com.atproto.repo.createRecord") {
      const request = JSON.parse(body) as { collection: string; record: Record<string, unknown> };
      if (request.collection !== TANGLED_MANAGED_REVIEW_COLLECTION) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Unknown collection" }));
        return;
      }
      counter += 1;
      pds.creates += 1;
      const uri = `at://${BOT_DID}/${request.collection}/r${counter}`;
      records.set(uri, request.record);
      res.end(JSON.stringify({ uri, cid: `bafyerecord${counter}` }));
      return;
    }
    if (path === "/xrpc/com.atproto.repo.putRecord") {
      const request = JSON.parse(body) as { collection: string; rkey: string; record: Record<string, unknown> };
      if (request.collection !== TANGLED_MANAGED_REVIEW_COLLECTION) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Unknown collection" }));
        return;
      }
      counter += 1;
      pds.puts += 1;
      const uri = `at://${BOT_DID}/${request.collection}/${request.rkey}`;
      records.set(uri, request.record);
      res.end(JSON.stringify({ uri, cid: `bafyerecord${counter}` }));
      return;
    }
    if (path === "/xrpc/com.atproto.repo.deleteRecord") {
      // #1691: a real PDS answers a successful delete with 200 and an
      // EMPTY body — the mock matches that wire behavior, including the
      // 404 `RecordNotFound` for an already-missing record (the shape a
      // concurrent reconcile loser sees).
      const request = JSON.parse(body) as { collection: string; rkey: string };
      if (request.collection !== TANGLED_MANAGED_REVIEW_COLLECTION) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Unknown collection" }));
        return;
      }
      const uri = `at://${BOT_DID}/${request.collection}/${request.rkey}`;
      if (!records.has(uri)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "RecordNotFound", message: "no such record" }));
        return;
      }
      counter += 1;
      pds.deletes += 1;
      records.delete(uri);
      res.statusCode = 200;
      res.end("");
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Unknown XRPC" }));
  });
  return pds;
}

/** The whole emulated Tangled world: a stateful mock PDS, a model server, a
 * real SHA-256 git workspace spanning the patch revision's two commits, and
 * a run-directory root. The knot is stubbed per run (see `withKnotStub`). */
interface TangledWorld {
  pds: MockPds;
  model: MockServer;
  markdown: { current: string };
  workspace: string;
  baseOid: string;
  intermediateOid: string;
  headOid: string;
  runsRoot: string;
  close(): Promise<void>;
}

async function startTangledWorld(): Promise<TangledWorld> {
  const markdown = { current: "First review: looks fine.\n" };
  const pds = await startMockPds();

  const model = await startMockServer((_req, _body, res) => {
    res.end(JSON.stringify({
      id: "c1",
      object: "chat.completion",
      model: "m",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({
            verdict: "approve",
            review_markdown: markdown.current,
            smart_review_requested: false,
            smart_review_reason: null,
            findings: [],
            requirement_coverage: null,
            required_check_dispositions: [],
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    }));
  });

  const round = makeRoundWorkspace();
  const runsRoot = mkdtempSync(join(tmpdir(), "v3-tangled-e2e-runs-"));

  return {
    pds,
    model,
    markdown,
    workspace: round.workspace,
    baseOid: round.baseOid,
    intermediateOid: round.intermediateOid,
    headOid: round.headOid,
    runsRoot,
    async close() {
      await Promise.all([pds.server.close(), model.close()]);
      rmSync(round.workspace, { recursive: true, force: true });
      rmSync(runsRoot, { recursive: true, force: true });
    },
  };
}

/** Current-model record fixtures bound to the world's git commits. */
function knotFixtures(world: TangledWorld): { ticket: Record<string, unknown>; patch: Record<string, unknown> } {
  return {
    ticket: {
      $type: "org.tangled.track.ticket",
      title: "Tangled pull under review",
      body: { text: "Adds a line to the README." },
      createdAt: "2026-10-01T10:00:00.000Z",
      state: "open",
      targetBranch: "main",
      "x-tngl-editor": AUTHOR_DID,
    },
    patch: {
      $type: "org.tangled.review.patch",
      ticket: TICKET_URI,
      base: { oid: world.baseOid },
      head: { oid: world.headOid },
      createdAt: "2026-10-01T10:01:00.000Z",
      source: { repo: REPO_DID, branch: "feature" },
    },
  };
}

/** A Spindle host environment: contract inputs plus the runtime variables
 * Spindle injects (see examples/tangled-workflow.yml), with the knot at the
 * stubbed host. NO `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT`,
 * `GITHUB_STEP_SUMMARY`, `GITHUB_TOKEN`, or `RUNNER_TEMP` — only
 * `GITHUB_WORKSPACE`, the checked-out round the Git read surface reads.
 * The `ATPROTO_*` credentials and `TANGLED_REPO_KNOT` feed the production
 * `buildPublishApi` factory. */
function tangledEnv(world: TangledWorld, runDir: string, sourceSha?: string): NodeJS.ProcessEnv {
  mkdirSync(runDir, { recursive: true });
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    "INPUT_AI-BASE-URL": world.model.url,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-API-KEY": "k",
    "INPUT_AI-STREAM": "false",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_PUBLISH-MODE": "comment",
    TANGLED_REPO_DID: OWNER_DID,
    TANGLED_REPO_REPO_DID: REPO_DID,
    TANGLED_REPO_NAME: "demo/repo",
    TANGLED_PR_SOURCE_BRANCH: "feature",
    TANGLED_PR_TARGET_BRANCH: "main",
    TANGLED_PR_SOURCE_SHA: sourceSha ?? world.headOid,
    TANGLED_REPO_KNOT: KNOT_HOST,
    ATPROTO_HOST: world.pds.server.url,
    ATPROTO_HANDLE: "reviewer.bot.test",
    ATPROTO_APP_PASSWORD: "app-password-value",
    GITHUB_WORKSPACE: world.workspace,
  } as NodeJS.ProcessEnv;
}

/** One runner round against the shared world, with fresh runner state. NO
 * seams are injected: the engine builds the stock `TangledAdapter` from the
 * production factory and publication runs through the production
 * `buildPublishApi`, including its real #1165 current-head re-check. When
 * `withKnot` is set the run executes under the knot stub; without it the
 * knot read fails closed, as on a host with no reachable knot. */
async function runTangledSmokeRound(
  world: TangledWorld,
  runDirName: string,
  options: {
    withKnot?: boolean;
    sourceSha?: string;
    fixtures?: () => KnotFixtures;
    afterFirstTicketRead?: () => void;
  } = {},
): Promise<{ code: number; knotCalls: string[] }> {
  const { withKnot = true, sourceSha, fixtures, afterFirstTicketRead } = options;
  const runDir = join(world.runsRoot, runDirName);
  const execute = async (): Promise<number> =>
    platformActionMain(tangledEnv(world, runDir, sourceSha), { runDir });
  if (!withKnot) {
    return { code: await execute(), knotCalls: [] };
  }
  const { result, knotCalls } = await withKnotStub(execute, {
    fixtures: fixtures ?? (() => knotFixtures(world)),
    ...(afterFirstTicketRead !== undefined ? { afterFirstTicketRead } : {}),
  });
  return { code: result, knotCalls };
}

function soleManagedRecord(world: TangledWorld): { uri: string; value: Record<string, unknown> } {
  assert.equal(world.pds.records.size, 1, "exactly one managed review record exists");
  const entry = [...world.pds.records.entries()][0];
  assert.ok(entry, "the managed record map holds one entry");
  return { uri: entry[0], value: entry[1] };
}

/** #1691 concurrency races: a REAL `TangledPublishApi` + `TangledAtprotoClient`
 * against the world's mock PDS, carrying the same reviewed identity the knot
 * fixtures encode — the same object the production `buildPublishApi` factory
 * constructs inside a runner round. Two of these racing over the shared PDS
 * is the interleaving the runner itself cannot force deterministically. */
function makePublishApi(world: TangledWorld): TangledPublishApi {
  const context: TangledContext = {
    ownerDid: OWNER_DID,
    repoDid: REPO_DID,
    repoName: "demo/repo",
    sourceBranch: "feature",
    targetBranch: "main",
    sourceSha: world.headOid,
    knotHost: KNOT_HOST,
    bobbinUrl: undefined,
  };
  const reviewedIdentity: TangledReviewIdentity = {
    ticketUri: TICKET_URI,
    ticketCid: "bafyreiticket",
    ticketRkey: TICKET_RKEY,
    ticketValue: {},
    patchUri: `at://${REPO_DID}/org.tangled.review.patch/${PATCH_CID}`,
    patchCid: PATCH_CID,
    patchValue: {},
    baseOid: world.baseOid,
    headOid: world.headOid,
    targetBranch: "main",
    sourceBranch: "feature",
    sourceRepoDid: REPO_DID,
    state: "open",
  };
  return new TangledPublishApi({
    context,
    atproto: new TangledAtprotoClient({
      host: world.pds.server.url,
      handle: "reviewer.bot.test",
      appPassword: "app-password-value",
      timeoutMs: 5000,
    }),
    reviewedIdentity,
  });
}

test("one offline round drives the runner from ticket resolution to a created managed review record", async () => {
  const world = await startTangledWorld();
  try {
    world.markdown.current = "First review: looks fine.\n";
    const { code, knotCalls } = await runTangledSmokeRound(world, "run-1");
    assert.equal(code, 0, "a published review exits 0");

    // Resolution went through the real knot record reads, bound to the repo
    // account: tickets and patches, per the current record model.
    assert.ok(knotCalls.includes("org.tangled.track.ticket"), "the ticket collection was read");
    assert.ok(knotCalls.includes("org.tangled.review.patch"), "the patch collection was read");

    // The model saw the real metadata and reviewed diff content in its prompt.
    assert.ok(world.model.requests.length >= 1, "the model was consulted");
    const prompt = world.model.requests[0]?.body ?? "";
    assert.match(prompt, /Tangled pull under review/, "the ticket metadata reached the prompt");
    assert.match(prompt, /README\.md/, "the changed file reached the prompt");
    assert.match(prompt, /\+world/, "the reviewed diff reached the prompt");

    // The managed record is the real TangledPublishApi's output, published
    // through the production buildPublishApi factory, bound to the TICKET.
    const { uri, value } = soleManagedRecord(world);
    assert.equal(value.$type, TANGLED_MANAGED_REVIEW_COLLECTION);
    assert.equal(value.pull, TICKET_URI, "the record is bound to the resolved ticket");
    assert.equal(value.pullRepoDid, REPO_DID);
    assert.equal(value.reviewer, BOT_DID, "the record is attributed to the session DID");
    assert.equal(value.sourceSha, world.headOid, "the reviewed head is the selected patch revision's trusted head.oid");
    assert.equal(typeof value.body, "string");
    assert.match(String(value.body), /First review: looks fine\./, "the record body is the published review");
    // #1691: first publication is a `putRecord` at the deterministic rkey
    // derived from the ticket URI the record binds to — no `createRecord`,
    // so a concurrent run converges here.
    assert.equal(uri, `at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/${managedReviewRkey(TICKET_URI)}`,
      "the record lives at the deterministic ticket-bound rkey");
    assert.equal(world.pds.creates, 0);
    assert.equal(world.pds.puts, 1);

    assert.deepEqual(world.pds.server.handlerErrors, []);
    assert.deepEqual(world.model.handlerErrors, []);
  } finally {
    await world.close();
  }
});

test("a re-review updates the existing managed review instead of duplicating it", async () => {
  const world = await startTangledWorld();
  try {
    world.markdown.current = "First review: looks fine.\n";
    assert.equal((await runTangledSmokeRound(world, "run-1")).code, 0);
    const first = soleManagedRecord(world);

    world.markdown.current = "Second review: still looks fine.\n";
    assert.equal((await runTangledSmokeRound(world, "run-2")).code, 0);
    const second = soleManagedRecord(world);

    assert.equal(second.uri, first.uri, "the managed review keeps the same record uri");
    assert.equal(world.pds.creates, 0, "no run ever uses createRecord anymore (#1691)");
    assert.equal(world.pds.puts, 2, "the re-review updated the record in place");
    assert.match(String(second.value.body), /Second review: still looks fine\./);
    assert.doesNotMatch(String(second.value.body), /First review: looks fine\./,
      "the superseded body no longer stays visible");
  } finally {
    await world.close();
  }
});

test("#1691: a forced concurrent first publication leaves ONE record, and a re-review after the race updates it in place", async () => {
  const world = await startTangledWorld();
  try {
    // Force the list-then-create race deterministically over real HTTP:
    // both listRecords responses are held until BOTH concurrent upserts
    // have listed, so both observe zero records and both take the create
    // branch — the exact interleaving that used to form two records and
    // permanently wedge every later run on the ambiguous guard.
    world.pds.armListBarrier(2);
    const marker = "<!-- pr-reviewer managed review (race) -->";
    const [first, second] = await Promise.all([
      makePublishApi(world).upsertStickyComment(marker, `${marker}\nConcurrent review A.`),
      makePublishApi(world).upsertStickyComment(marker, `${marker}\nConcurrent review B.`),
    ]);
    assert.equal(first.ok, true, `first publication failed: ${first.error}`);
    assert.equal(second.ok, true, `second publication failed: ${second.error}`);
    assert.equal(first.created, true, "both listed zero records, so both report creating");
    assert.equal(second.created, true);
    assert.equal(first.commentId, second.commentId, "both converge on the deterministic ticket-bound rkey");
    assert.equal(world.pds.records.size, 1, "the race left exactly ONE managed record");
    assert.equal(world.pds.creates, 0, "no run ever uses createRecord anymore");
    assert.equal(world.pds.puts, 2, "last writer wins on the one record");

    // The re-review after the race is a FULL runner round: it must update
    // that same single record in place, proving no permanent ambiguous
    // state was formed.
    world.markdown.current = "Post-race review: still looks fine.\n";
    assert.equal((await runTangledSmokeRound(world, "run-post-race")).code, 0);
    const { uri, value } = soleManagedRecord(world);
    assert.equal(uri, first.commentId, "the managed record kept one identity across the race and the re-review");
    assert.equal(uri, `at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/${managedReviewRkey(TICKET_URI)}`);
    assert.match(String(value.body), /Post-race review: still looks fine\./);
    assert.doesNotMatch(String(value.body), /Concurrent review/, "the superseded race bodies no longer stay visible");
    assert.equal(world.pds.records.size, 1);
    assert.equal(world.pds.puts, 3);
    assert.deepEqual(world.pds.server.handlerErrors, []);
  } finally {
    await world.close();
  }
});

test("#1691: a full runner round heals a pre-existing duplicate set instead of wedging", async () => {
  const world = await startTangledWorld();
  try {
    // Seed the wedge pre-#1691 publication could form: two managed records
    // bound to the SAME ticket (neither carrying the CURRENT runner marker —
    // the shape that used to answer every run with "ambiguous managed
    // review" until a human deleted a record from the AT-Proto repo).
    const legacyMarker = "<!-- pr-reviewer managed review (legacy) -->";
    const legacy = (createdAt: string, text: string) => ({
      $type: TANGLED_MANAGED_REVIEW_COLLECTION,
      pull: TICKET_URI,
      pullRepoDid: REPO_DID,
      reviewer: BOT_DID,
      body: `${legacyMarker}\n${text}`,
      createdAt,
    });
    world.pds.records.set(`at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3mqdupa`,
      legacy("2026-10-01T00:00:00.000Z", "Legacy review one."));
    world.pds.records.set(`at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3mqdupb`,
      legacy("2026-10-02T00:00:00.000Z", "Legacy review two."));

    world.markdown.current = "Recovery review: healed.\n";
    assert.equal((await runTangledSmokeRound(world, "run-heal")).code, 0,
      "the run PUBLISHES (exit 0) where the old guard refused forever");

    const { uri, value } = soleManagedRecord(world);
    assert.equal(uri, `at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3mqdupb`,
      "the newest createdAt is kept in place");
    assert.match(String(value.body), /Recovery review: healed\./);
    assert.doesNotMatch(String(value.body), /Legacy review/, "the superseded body no longer stays visible");
    assert.equal(world.pds.deletes, 1, "the superseded duplicate was deleted through the real client (empty-200 wire)");
    assert.equal(world.pds.puts, 1);
    assert.equal(world.pds.creates, 0);
    assert.deepEqual(world.pds.server.handlerErrors, []);
  } finally {
    await world.close();
  }
});

test("a stale checkout fails closed BEFORE the model is called, even with H2 present locally", async () => {
  const world = await startTangledWorld();
  try {
    // The host launched at the intermediate round H1 (checked out, and
    // TANGLED_PR_SOURCE_SHA=H1), while the newest immutable patch revision
    // for the ticket is H2 — whose object DOES exist in the local
    // repository. The resolver selects H2, the HEAD binding must refuse
    // before any review content is derived, and the model must never be
    // consulted (no split-brain review: the context readers would have
    // seen H1's checked-out bytes against H2's diff).
    execFileSync("git", ["checkout", "-q", "--detach", world.intermediateOid], {
      cwd: world.workspace,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await assert.rejects(
      () => runTangledSmokeRound(world, "run-stale-checkout", { sourceSha: world.intermediateOid }),
      (e: unknown) => e instanceof Error,
      "the run fails on the checkout binding (the TangledGitError message itself is pinned in tangled-git.test.ts)",
    );
    assert.equal(world.model.requests.length, 0, "the model was never consulted");
    assert.equal(world.pds.records.size, 0, "nothing was published");
    assert.equal(world.pds.creates, 0);
    assert.equal(world.pds.puts, 0);
  } finally {
    await world.close();
  }
});

test("#1691: concurrent reconcile: the loser's 404 on an already-deleted duplicate still updates the keeper", async () => {
  const world = await startTangledWorld();
  try {
    // Seed the legacy duplicate set, then force BOTH concurrent runs to
    // list it before either writes: both pick the same keeper and both
    // delete the same superseded duplicate, so the loser's delete answers
    // 404 RecordNotFound over the real wire — the interleaving that used
    // to fail the run without ever updating the keeper.
    const legacyMarker = "<!-- pr-reviewer managed review (legacy) -->";
    const legacy = (createdAt: string, text: string) => ({
      $type: TANGLED_MANAGED_REVIEW_COLLECTION,
      pull: TICKET_URI,
      pullRepoDid: REPO_DID,
      reviewer: BOT_DID,
      body: `${legacyMarker}\n${text}`,
      createdAt,
    });
    world.pds.records.set(`at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3mqdupa`,
      legacy("2026-10-01T00:00:00.000Z", "Legacy review one."));
    world.pds.records.set(`at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3mqdupb`,
      legacy("2026-10-02T00:00:00.000Z", "Legacy review two."));

    world.pds.armListBarrier(2);
    const marker = "<!-- pr-reviewer managed review (reconcile race) -->";
    const [first, second] = await Promise.all([
      makePublishApi(world).upsertStickyComment(marker, `${marker}\nReconcile race A.`),
      makePublishApi(world).upsertStickyComment(marker, `${marker}\nReconcile race B.`),
    ]);
    assert.equal(first.ok, true, `first reconcile run failed: ${first.error}`);
    assert.equal(second.ok, true, `loser reconcile run failed on its 404: ${second.error}`);
    assert.equal(first.action, "reconciled");
    assert.equal(second.action, "reconciled");
    assert.equal(first.commentId, `at://${BOT_DID}/${TANGLED_MANAGED_REVIEW_COLLECTION}/3mqdupb`,
      "both runs deterministically keep the newest createdAt record");
    assert.equal(second.commentId, first.commentId);

    const { uri, value } = soleManagedRecord(world);
    assert.equal(uri, first.commentId);
    assert.equal(world.pds.deletes, 1, "the duplicate was deleted once; the loser's second delete answered 404");
    assert.match(String(value.body), /Reconcile race/);
    assert.doesNotMatch(String(value.body), /Legacy review/, "the superseded body no longer stays visible");
    assert.deepEqual(world.pds.server.handlerErrors, []);
  } finally {
    await world.close();
  }
});

test("publication refuses when the reviewed ticket closes mid-run and a replacement shares the head", async () => {
  const world = await startTangledWorld();
  try {
    // The TOCTOU window opens the moment the read adapter resolves T1/H1
    // (the first ticket read): the tracker then closes T1 and a replacement
    // T2 appears on the same target/source with a patch whose head is STILL
    // H1. A SHA-only freshness guard would pass (the fresh head equals the
    // reviewed SHA) and the T1 review would be published onto T2; the
    // lineage-bound guard must refuse instead, with zero writes anywhere.
    let flipped = false;
    const base = knotFixtures(world);
    const t2Patch = {
      $type: "org.tangled.review.patch",
      ticket: TICKET2_URI,
      base: { oid: world.baseOid },
      head: { oid: world.headOid },
      createdAt: "2026-10-02T10:00:00.000Z",
      source: { repo: REPO_DID, branch: "feature" },
    };
    const { code } = await runTangledSmokeRound(world, "run-ticket-closed", {
      fixtures: () => flipped
        ? {
          ticket: { ...base.ticket, state: "closed" },
          patch: base.patch,
          extraTickets: [{
            uri: TICKET2_URI,
            cid: "bafyreiticket2",
            value: { ...base.ticket, title: "Replacement ticket", state: "open" },
          }],
          extraPatches: [{ uri: `at://${REPO_DID}/org.tangled.review.patch/${PATCH2_CID}`, cid: PATCH2_CID, value: t2Patch }],
        }
        : base,
      afterFirstTicketRead: () => { flipped = true; },
    });
    assert.equal(code, 1, "the publication is refused (fail closed)");
    assert.ok(world.model.requests.length >= 1, "the review itself ran against the reviewed ticket T1");
    assert.equal(world.pds.records.size, 0, "nothing was published");
    assert.equal(world.pds.creates, 0, "no managed record was created — not on T1, not on T2");
    assert.equal(world.pds.puts, 0, "no managed record was updated");
  } finally {
    await world.close();
  }
});

test("#1696: a publishing run without the repository DID gets the named config refusal before any read, model call or publication", async () => {
  // The production shape on the current record model: a publishing run whose
  // Tangled context cannot ever satisfy the #1165 current-head read is
  // refused by the named guard BEFORE the review engine starts — before the
  // knot resolution, before the model, before publication. No knot stub is
  // installed: a run that reached any knot read would hit real DNS for the
  // stub host and fail with a different error, so the named refusal proves
  // the guard ordering end to end.
  const world = await startTangledWorld();
  try {
    const runDir = join(world.runsRoot, "run-no-repo-did");
    const env = tangledEnv(world, runDir);
    delete env.TANGLED_REPO_REPO_DID;
    await assert.rejects(
      platformActionMain(env, { runDir }),
      (error: unknown) =>
        error instanceof Error
        && /TANGLED_REPO_REPO_DID/.test(error.message)
        && !error.message.includes("TANGLED_REPO_KNOT"),
    );
    assert.equal(world.model.requests.length, 0, "the review never reached the model");
    assert.equal(world.pds.records.size, 0, "nothing was published");
    assert.equal(world.pds.creates, 0);
    assert.equal(world.pds.puts, 0);
  } finally {
    await world.close();
  }
});

test("#1696 review: a publishing run without the knot host gets the named config refusal, not the resolver failure", async () => {
  // The stock adapter's review-identity resolution itself needs the knot
  // host, so `getPr()` yields null when it is missing — the config probe
  // must not be bypassed by that failure. The typed error class is the
  // discriminator: the resolver error also names TANGLED_REPO_KNOT, so a
  // message match alone could not tell the early guard from a later
  // resolution stop. No knot stub is installed and the knot host is unset:
  // the run issues no knot request at all, and the named refusal proves
  // the guard ordering end to end.
  const world = await startTangledWorld();
  try {
    const runDir = join(world.runsRoot, "run-no-knot");
    const env = tangledEnv(world, runDir);
    delete env.TANGLED_REPO_KNOT;
    await assert.rejects(
      platformActionMain(env, { runDir }),
      (error: unknown) =>
        error instanceof TangledHeadReadConfigError
        && /TANGLED_REPO_KNOT/.test(error.message)
        && !error.message.includes("TANGLED_REPO_REPO_DID")
        && /current-head/i.test(error.message)
        && /publication/i.test(error.message),
    );
    assert.equal(world.model.requests.length, 0, "the review never reached the model");
    assert.equal(world.pds.records.size, 0, "nothing was published");
    assert.equal(world.pds.creates, 0);
    assert.equal(world.pds.puts, 0);
  } finally {
    await world.close();
  }
});

test("publication still fails closed when the knot cannot prove the current head", async () => {
  const world = await startTangledWorld();
  const stderr: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // Production factories everywhere, but NO knot stub: the review-identity
    // resolution reads a knot that cannot answer and must fail closed — a
    // failed PR metadata lookup is an operational failure, so the runner
    // THROWS (the host maps it to a non-zero exit) and nothing publishes.
    await assert.rejects(
      () => runTangledSmokeRound(world, "run-no-head", { withKnot: false }),
      (e: unknown) => e instanceof Error,
      "a run that cannot resolve its review identity fails the run",
    );
    assert.equal(world.pds.records.size, 0, "nothing was published");
    assert.equal(world.pds.creates, 0);
    assert.equal(world.pds.puts, 0);
  } finally {
    process.stderr.write = originalWrite;
    await world.close();
  }
});
