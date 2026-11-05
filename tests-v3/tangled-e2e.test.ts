/**
 * #591: end-to-end Tangled smoke test.
 *
 * Drives the host-neutral runner (`platformActionMain`) through one full
 * offline round — pull resolution, metadata, diff/files, model review, and
 * managed-comment publication — and a second round that must UPDATE the
 * managed review instead of duplicating it.
 *
 * Unlike the #590 runner suite (which injects whole fake read/write seams to
 * prove the orchestration), this smoke runs the REAL Tangled capability
 * stack and mocks only the services the Tangled host would provide, each at
 * its own wire boundary:
 * - the Spindle runtime variables come from the real `tangledContextFromEnv`
 *   over a plain `TANGLED_*` environment (no GitHub Actions bookkeeping);
 * - Bobbin reads are a real `startMockServer` serving
 *   `sh.tangled.repo.listPulls`, consumed by the real `TangledAdapter` /
 *   `resolveTangledPull` over real HTTP to loopback;
 * - the pull round diff runs the real #586 chain (round selection →
 *   `fetchAtprotoBlob` two-hop → gunzip → `normalizeGitFormatPatch`) with
 *   the documented `fetchImpl`/`resolver` transport seams pointed at a
 *   mocked PLC directory and PDS blob store;
 * - publication goes through the real `TangledAtprotoClient` +
 *   `TangledPublishApi` against a stateful mock PDS (session, listRecords,
 *   createRecord, putRecord), so the managed-record update semantics under
 *   test are production code; the fail-closed round leaves the `publishApi`
 *   seam unset, so the PRODUCTION `buildPublishApi` factory — reading the
 *   same `ATPROTO_*` environment the Spindle example relies on — is the
 *   code path that builds the capability and refuses it;
 * - the model is a local mock serving one OpenAI-style chat completion.
 *
 * The runner itself wires `getPrDiff`/`listPrFiles` from the round-diff
 * chain here because the stock `TangledAdapter` still fails those reads
 * closed until the #586 pipeline wiring lands; the context reads Tangled
 * has no source for answer with the same empty contract the #590 runner
 * suite pins. The trusted current-head read the publish boundary re-checks
 * (#1165) is emulated by injecting a fresh `currentHeadSha` reader — and a
 * dedicated test proves publication still fails closed when it is absent.
 *
 * Everything stays offline: the only network targets are the three loopback
 * mock servers and the two hosts the blob transport seam intercepts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { IncomingMessage } from "node:http";
import { platformActionMain } from "../src/run/platform-action.js";
import { TangledAdapter } from "../src/platform/tangled-adapter.js";
import { fetchTangledPullRoundDiff, type TangledPullRoundDiff } from "../src/platform/tangled-diff.js";
import { TangledAtprotoClient } from "../src/platform/tangled-atproto.js";
import { TangledPublishApi, TANGLED_MANAGED_REVIEW_COLLECTION } from "../src/platform/tangled-publish.js";
import { tangledContextFromEnv, type TangledContext } from "../src/platform/tangled.js";
import type { Resolver } from "../src/platform/safe-fetch.js";
import type { FetchLike } from "../src/platform/http.js";
import type { GhApiResult, ManagedComment, ManagedReview, ReadResult } from "../src/platform/types.js";
import { startMockServer, type MockServer } from "./helpers.js";

const OWNER_DID = "did:plc:owner00000000000000000000000000000000000000000000000";
const REPO_DID = "did:plc:repo000000000000000000000000000000000000000000000000";
const AUTHOR_DID = "did:plc:author000000000000000000000000000000000000000000000";
const BOT_DID = "did:plc:bot0000000000000000000000000000000000000000000000000";
const HEAD = "a".repeat(40);
const PULL_RKEY = "3jqpullrkey000000000000000000000000000000000000000000000";
const PULL_URI = `at://${AUTHOR_DID}/sh.tangled.repo.pull/${PULL_RKEY}`;
const PULL_CID = "bafyreipullcid000000000000000000000000000000000000000000000";
const BLOB_CID = "bafyreiblobcid00000000000000000000000000000000000000000000";

/** One `git format-patch` mail envelope whose latest boundary declares the
 * reviewed head; gzipped, it is exactly the round patch blob a real Tangled
 * pull author would have published. */
function formatPatchText(): string {
  return [
    `From ${HEAD} Mon Sep 17 00:00:00 1997 +0000`,
    "From: Ada <ada@example.com>",
    "Date: Mon, 17 Sep 2026 10:00:00 +0000",
    "Subject: [PATCH] Add a line to the README",
    "",
    "Add the greeting the review asks about.",
    "",
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    " hello",
    "+world",
    "-- ",
    "2.47.0",
    "",
  ].join("\n");
}

function pullRecordValue(): Record<string, unknown> {
  return {
    $type: "sh.tangled.repo.pull",
    title: "Tangled pull under review",
    description: "Adds a line to the README.",
    createdAt: "2026-10-01T10:00:00.000Z",
    draft: false,
    target: { repo: REPO_DID, branch: "main" },
    source: { branch: "feature" },
    rounds: [
      {
        createdAt: "2026-10-01T10:00:00.000Z",
        patchBlob: { $link: BLOB_CID, mimeType: "application/gzip", size: 128 },
      },
    ],
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The blob transport seam: a mocked PLC directory (DID document → PDS
 * endpoint) and a mocked PDS `getBlob` returning the gzipped round patch.
 * `hosts` records every intercepted hostname, pinning the blob chain's two
 * network targets (offline-ness itself comes from the sealed env and the
 * loopback mock URLs). */
function mockBlobTransport(patchBytes: Buffer): { fetchImpl: FetchLike; hosts: string[] } {
  const hosts: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    if (url.hostname === "plc.directory") {
      if (url.pathname !== `/${AUTHOR_DID}`) return json({ error: "not found" }, 404);
      return json({
        id: AUTHOR_DID,
        service: [
          { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.test" },
        ],
      });
    }
    if (url.hostname === "pds.test" && url.pathname === "/xrpc/com.atproto.sync.getBlob") {
      return new Response(new Uint8Array(patchBytes), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return json({ error: "unmocked host" }, 500);
  };
  return { fetchImpl, hosts };
}

/** Real round-diff chain over the mocked blob transport. */
const publicResolver: Resolver = async () => ["93.184.216.34"];

/**
 * The read capability the runner drives: real `TangledAdapter` metadata
 * reads over real HTTP (Bobbin), `getPrDiff`/`listPrFiles` backed by the
 * real #586 round-diff pipeline (the stock adapter still fails those closed
 * until the #586 pipeline wiring lands), and — exactly as the #590 runner
 * contract pins — the empty answers for context reads Tangled has no source
 * for yet. Everything else keeps the adapter's honest fail-closed behavior.
 */
class RoundDiffTangledAdapter extends TangledAdapter {
  private roundPending: Promise<TangledPullRoundDiff> | null = null;

  constructor(context: TangledContext, blobTransport: FetchLike) {
    super({ context });
    this.blobTransport = blobTransport;
  }

  private readonly blobTransport: FetchLike;

  private roundDiff(): Promise<TangledPullRoundDiff> {
    this.roundPending ??= (async () => {
      await this.getPr();
      const identity = this.pullIdentity;
      if (identity === null) throw new Error("Tangled pull resolution failed before the diff read");
      return fetchTangledPullRoundDiff(identity, {
        fetchImpl: this.blobTransport,
        resolver: publicResolver,
      });
    })();
    return this.roundPending;
  }

  override async getPrDiff(): Promise<string> {
    return (await this.roundDiff()).diff;
  }

  override async listPrFiles(): Promise<ReadResult<unknown>> {
    return { ok: true, data: (await this.roundDiff()).files };
  }

  override listIssueComments(): Promise<ManagedComment[]> {
    return Promise.resolve([]);
  }

  override listPrReviews(): Promise<ManagedReview[]> {
    return Promise.resolve([]);
  }

  override listPrConversationComments(): Promise<ReadResult<unknown[]>> {
    return Promise.resolve({ ok: true, data: [] });
  }

  override listReviewThreads(): Promise<ReadResult<unknown[]>> {
    return Promise.resolve({ ok: true, data: [] });
  }

  override listPrReviewsPaginated(): Promise<ReadResult<unknown[]>> {
    return Promise.resolve({ ok: true, data: [] });
  }

  override getIssue(): Promise<ReadResult<unknown>> {
    return Promise.resolve({ ok: false, error: "linked-issue reads are not served on Tangled" });
  }

  override async ghApi(): Promise<GhApiResult> {
    return { error: "gh_api reads are not served on Tangled" };
  }

  override async externalChecks(): Promise<never[]> {
    return [];
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
}

async function startMockPds(): Promise<MockPds> {
  const records = new Map<string, Record<string, unknown>>();
  let counter = 0;
  const pds: MockPds = { records, creates: 0, puts: 0, server: undefined as unknown as MockServer };
  pds.server = await startMockServer((req: IncomingMessage, body: string, res) => {
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
      res.end(JSON.stringify({
        records: [...records.entries()].map(([uri, value]) => ({ uri, value })),
      }));
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
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Unknown XRPC" }));
  });
  return pds;
}

/** The whole emulated Tangled world: Bobbin + PDS + model servers, a
 * workspace checked out at the reviewed head, and a run-directory root. */
interface TangledWorld {
  bobbin: MockServer;
  pds: MockPds;
  model: MockServer;
  markdown: { current: string };
  workspace: string;
  runsRoot: string;
  blobFetch: FetchLike;
  blobHosts: string[];
  close(): Promise<void>;
}

async function startTangledWorld(): Promise<TangledWorld> {
  const patchBytes = gzipSync(Buffer.from(formatPatchText(), "utf8"));
  const blob = mockBlobTransport(patchBytes);
  const markdown = { current: "First review: looks fine.\n" };

  const bobbin = await startMockServer((req, _body, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/xrpc/sh.tangled.repo.listPulls") {
      res.end(JSON.stringify({
        items: [{ uri: PULL_URI, cid: PULL_CID, state: "open", value: pullRecordValue() }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Unknown XRPC" }));
  });

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

  const workspace = mkdtempSync(join(tmpdir(), "v3-tangled-e2e-ws-"));
  writeFileSync(join(workspace, "README.md"), "hello\nworld\n");
  const runsRoot = mkdtempSync(join(tmpdir(), "v3-tangled-e2e-runs-"));

  return {
    bobbin,
    pds,
    model,
    markdown,
    workspace,
    runsRoot,
    blobFetch: blob.fetchImpl,
    blobHosts: blob.hosts,
    async close() {
      await Promise.all([bobbin.close(), pds.server.close(), model.close()]);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(runsRoot, { recursive: true, force: true });
    },
  };
}

/** A Spindle host environment: contract inputs plus the runtime variables
 * Spindle injects (see examples/tangled-workflow.yml), with Bobbin pointed
 * at the local mock. NO `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT`,
 * `GITHUB_STEP_SUMMARY`, `GITHUB_TOKEN`, or `RUNNER_TEMP` — only
 * `GITHUB_WORKSPACE`, which the runner reads as the plain checkout
 * directory. */
function tangledEnv(world: TangledWorld, runDir: string, atprotoPdsUrl?: string): NodeJS.ProcessEnv {
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
    TANGLED_PR_SOURCE_SHA: HEAD,
    TANGLED_BOBBIN_URL: world.bobbin.url,
    ...(atprotoPdsUrl === undefined
      ? {}
      : {
        ATPROTO_HOST: atprotoPdsUrl,
        ATPROTO_HANDLE: "reviewer.bot.test",
        ATPROTO_APP_PASSWORD: "app-password-value",
      }),
    GITHUB_WORKSPACE: world.workspace,
  } as NodeJS.ProcessEnv;
}

function smokeContext(world: TangledWorld): TangledContext {
  return tangledContextFromEnv(tangledEnv(world, join(world.runsRoot, "ctx")));
}

/** Real publish capability against the mock PDS. `withCurrentHead` emulates
 * the trustworthy current-head read #1165 will provide: publication is
 * expected to succeed with it and to fail closed without it. */
function makePublishApi(world: TangledWorld, withCurrentHead: boolean): TangledPublishApi {
  const atproto = new TangledAtprotoClient({
    host: world.pds.server.url,
    handle: "reviewer.bot.test",
    appPassword: "app-password-value",
    timeoutMs: 5000,
  });
  return new TangledPublishApi({
    context: smokeContext(world),
    atproto,
    ...(withCurrentHead ? { currentHeadSha: async () => HEAD } : {}),
  });
}

/** One runner round against the shared world, with fresh runner state.
 * `productionPublish` leaves the `publishApi` seam unset so the run takes
 * the production `buildPublishApi` factory from the `ATPROTO_*`
 * environment (which then has no current-head reader — the fail-closed
 * shape). */
async function runTangledSmokeRound(
  world: TangledWorld,
  runDirName: string,
  options: { withCurrentHead?: boolean; productionPublish?: boolean } = {},
): Promise<number> {
  const { withCurrentHead = true, productionPublish = false } = options;
  const runDir = join(world.runsRoot, runDirName);
  return platformActionMain(
    tangledEnv(world, runDir, productionPublish ? world.pds.server.url : undefined),
    {
      platformAdapter: new RoundDiffTangledAdapter(smokeContext(world), world.blobFetch),
      ...(productionPublish ? {} : { publishApi: makePublishApi(world, withCurrentHead) }),
      runDir,
    },
  );
}

function soleManagedRecord(world: TangledWorld): { uri: string; value: Record<string, unknown> } {
  assert.equal(world.pds.records.size, 1, "exactly one managed review record exists");
  const entry = [...world.pds.records.entries()][0];
  assert.ok(entry, "the managed record map holds one entry");
  return { uri: entry[0], value: entry[1] };
}

test("one offline round drives the runner from pull resolution to a created managed review record", async () => {
  const world = await startTangledWorld();
  try {
    world.markdown.current = "First review: looks fine.\n";
    const code = await runTangledSmokeRound(world, "run-1");
    assert.equal(code, 0, "a published review exits 0");

    // Pull resolution went through the real Bobbin resolver.
    assert.ok(world.bobbin.requests.length >= 1, "the runner read the pull from Bobbin");

    // The model saw the real metadata and round-diff content in its prompt.
    assert.ok(world.model.requests.length >= 1, "the model was consulted");
    const prompt = world.model.requests[0]?.body ?? "";
    assert.match(prompt, /Tangled pull under review/, "the pull metadata reached the prompt");
    assert.match(prompt, /README\.md/, "the changed file reached the prompt");
    assert.match(prompt, /\+world/, "the round patch reached the prompt");

    // The managed record is the real TangledPublishApi's output.
    const { value } = soleManagedRecord(world);
    assert.equal(value.$type, TANGLED_MANAGED_REVIEW_COLLECTION);
    assert.equal(value.pull, PULL_URI, "the record is bound to the resolved pull");
    assert.equal(value.pullRepoDid, REPO_DID);
    assert.equal(value.reviewer, BOT_DID, "the record is attributed to the session DID");
    assert.equal(value.sourceSha, HEAD, "the record carries the reviewed head");
    assert.equal(typeof value.body, "string");
    assert.match(String(value.body), /First review: looks fine\./, "the record body is the published review");
    assert.equal(world.pds.creates, 1, "the first round creates the record");
    assert.equal(world.pds.puts, 0);

    // Offline: the blob chain only touched its two intercepted hosts.
    assert.deepEqual([...new Set(world.blobHosts)].sort(), ["pds.test", "plc.directory"]);
    assert.deepEqual(world.bobbin.handlerErrors, []);
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
    assert.equal(await runTangledSmokeRound(world, "run-1"), 0);
    const first = soleManagedRecord(world);

    world.markdown.current = "Second review: still looks fine.\n";
    assert.equal(await runTangledSmokeRound(world, "run-2"), 0);
    const second = soleManagedRecord(world);

    assert.equal(second.uri, first.uri, "the managed review keeps the same record uri");
    assert.equal(world.pds.creates, 1, "the re-review created no second record");
    assert.equal(world.pds.puts, 1, "the re-review updated the record in place");
    assert.match(String(second.value.body), /Second review: still looks fine\./);
    assert.doesNotMatch(String(second.value.body), /First review: looks fine\./,
      "the superseded body no longer stays visible");
  } finally {
    await world.close();
  }
});

test("publication still fails closed without a trustworthy current-head read", async () => {
  const world = await startTangledWorld();
  const stderr: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    stderr.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // No publishApi seam: the production `buildPublishApi` factory builds
    // the Tangled capability from the ATPROTO_* environment — and, with no
    // trustworthy current-head read wired yet (#1165), must refuse.
    const code = await runTangledSmokeRound(world, "run-no-head", { productionPublish: true });
    assert.equal(code, 1, "a review whose publication is refused exits non-zero");
    assert.ok(world.model.requests.length >= 1, "the review itself still ran");
    assert.equal(world.pds.records.size, 0, "nothing was published");
    assert.equal(world.pds.creates, 0);
    assert.equal(world.pds.puts, 0);
    const refusal = stderr.join("");
    assert.match(refusal, /current[- ]head/i, "the refusal names the current-head re-check");
    assert.match(refusal, /refus/i, "the refusal says it refused to publish");
  } finally {
    process.stderr.write = originalWrite;
    await world.close();
  }
});
