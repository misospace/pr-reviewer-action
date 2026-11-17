/**
 * #591 / #1690: end-to-end Tangled smoke test on the PRODUCTION path.
 *
 * Drives the host-neutral runner (`platformActionMain`) through one full
 * offline round — pull resolution, metadata, diff/files, model review, and
 * managed-comment publication — and a second round that must UPDATE the
 * managed review instead of duplicating it.
 *
 * #1690 pins what makes this a real proof rather than a rigged one: the run
 * uses the STOCK `TangledAdapter` (no `getPrDiff`/`listPrFiles` overrides —
 * the adapter itself serves the #586 round-diff chain) and the PRODUCTION
 * `buildPublishApi` factory (no injected `currentHeadSha`) for every
 * successful round. Mocks sit only at the services' wire boundaries:
 * - the Spindle runtime variables come from the real `tangledContextFromEnv`
 *   over a plain `TANGLED_*` environment (no GitHub Actions bookkeeping);
 * - Bobbin reads are a real `startMockServer` serving
 *   `sh.tangled.repo.listPulls`, consumed by the real `TangledAdapter` /
 *   `resolveTangledPull` over real HTTP to loopback;
 * - the pull round diff runs the real #586 chain (round selection →
 *   `fetchAtprotoBlob` two-hop → gunzip → `normalizeGitFormatPatch`) with
 *   the documented transport seams pointed at a mocked PLC directory and PDS
 *   blob store (the `resolver` seam replaces DNS only; no blob/PDS logic is
 *   bypassed);
 * - the trusted current-head read (#1165) that the production publish
 *   factory wires (`readTangledCurrentHeadForContext` over the knot's
 *   `org.tangled.track.ticket` + `org.tangled.review.patch` records) is
 *   served at its own wire boundary: a transport stub installed over
 *   `globalThis.fetch` answers the knot's portless `http://127.0.0.1`
 *   origin (`TANGLED_REPO_KNOT` is a bare hostname by the Spindle contract,
 *   so the knot read has no port to point at a mock server) and forwards
 *   every other request to the real fetch;
 * - publication goes through the real `TangledAtprotoClient` +
 *   `TangledPublishApi` built by `buildPublishApi` from the same
 *   `ATPROTO_*` environment the Spindle example relies on, against a
 *   stateful mock PDS (session, listRecords, createRecord, putRecord), so
 *   the managed-record create/update semantics under test are production
 *   code;
 * - the model is a local mock serving one OpenAI-style chat completion.
 *
 * A dedicated round leaves `TANGLED_REPO_KNOT` unset, so the production
 * head reader fails closed and publication is refused — the runner-side
 * proof that the fail-closed head re-check is load-bearing.
 *
 * Everything stays offline: the only network targets are the three loopback
 * mock servers and the hosts the transport stub intercepts.
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
import { TANGLED_MANAGED_REVIEW_COLLECTION } from "../src/platform/tangled-publish.js";
import { TANGLED_PATCH_COLLECTION, TANGLED_TICKET_COLLECTION } from "../src/platform/tangled-head.js";
import { tangledContextFromEnv, type TangledContext } from "../src/platform/tangled.js";
import type { Resolver } from "../src/platform/safe-fetch.js";
import type { FetchLike } from "../src/platform/http.js";
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
const TICKET_RKEY = "3jqticketrkey000000000000000000000000000000000000000000";
const TICKET_URI = `at://${REPO_DID}/org.tangled.track.ticket/${TICKET_RKEY}`;
/** The knot's origin under the Spindle contract: `TANGLED_REPO_KNOT` is a
 * bare loopback hostname here, so `tangled-head.ts` builds a PORTLESS
 * `http://127.0.0.1` base — that exact origin is the transport stub's
 * interception key (every real mock server keeps its port and passes
 * through). */
const KNOT_ORIGIN = "http://127.0.0.1";

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

/** The knot's two bounded `listRecords` reads (#1165), answered at the wire:
 * one open ticket for `main`, and the newest patch revision for that ticket
 * whose trusted `head.oid` is the reviewed head, source-branch correlated.
 * A wrong collection or repo is refused, never answered empty — the same
 * discipline the mock PDS applies to the managed collection. */
function knotListRecords(url: URL): Response {
  if (url.pathname !== "/xrpc/com.atproto.repo.listRecords") {
    return json({ error: "Unknown XRPC" }, 404);
  }
  if (url.searchParams.get("repo") !== REPO_DID) {
    return json({ error: "Unknown repo" }, 400);
  }
  const collection = url.searchParams.get("collection");
  if (collection === TANGLED_TICKET_COLLECTION) {
    return json({
      records: [{
        uri: TICKET_URI,
        value: { state: "open", targetBranch: "main", title: "Tangled pull under review" },
      }],
    });
  }
  if (collection === TANGLED_PATCH_COLLECTION) {
    return json({
      records: [{
        uri: `at://${REPO_DID}/${TANGLED_PATCH_COLLECTION}/3jqpatchrev000000000000000000000000000000000000000001`,
        value: {
          ticket: TICKET_RKEY,
          createdAt: "2026-10-01T09:59:00.000Z",
          source: { branch: "feature" },
          head: { oid: HEAD },
        },
      }],
    });
  }
  return json({ error: "Unknown collection" }, 400);
}

/**
 * The production transport stub, installed over `globalThis.fetch` for the
 * duration of a round. It intercepts exactly the three hosts a real Spindle
 * run would resolve over the public internet and forwards everything else
 * to the real fetch (the loopback Bobbin/PDS/model mock servers):
 * - the PLC directory (DID document → author PDS endpoint);
 * - the mocked PDS `getBlob` (the gzipped round patch);
 * - the knot's portless loopback origin (`listRecords` for the trusted
 *   current-head read).
 * `hosts` records only the blob chain's intercepted hostnames, pinning its
 * two network targets; `knot.hits` counts the head-read requests.
 */
function makeWorldFetch(patchBytes: Buffer, knot: { hits: number }): { fetchImpl: FetchLike; hosts: string[] } {
  const hosts: string[] = [];
  const realFetch = globalThis.fetch;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === KNOT_ORIGIN) {
      knot.hits += 1;
      return knotListRecords(url);
    }
    if (url.hostname === "plc.directory") {
      hosts.push(url.hostname);
      if (url.pathname !== `/${AUTHOR_DID}`) return json({ error: "not found" }, 404);
      return json({
        id: AUTHOR_DID,
        service: [
          { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.test" },
        ],
      });
    }
    if (url.hostname === "pds.test" && url.pathname === "/xrpc/com.atproto.sync.getBlob") {
      hosts.push(url.hostname);
      return new Response(new Uint8Array(patchBytes), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return realFetch(input, init);
  };
  return { fetchImpl, hosts };
}

/** Real round-diff chain over the mocked blob transport: the seam replaces
 * DNS only (no real resolution of the mocked `pds.test` host), never any
 * blob/patch logic. */
const publicResolver: Resolver = async () => ["93.184.216.34"];

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

/** The whole emulated Tangled world: Bobbin + PDS + model servers, the knot
 * transport handler state, a workspace checked out at the reviewed head, and
 * a run-directory root. */
interface TangledWorld {
  bobbin: MockServer;
  pds: MockPds;
  model: MockServer;
  markdown: { current: string };
  workspace: string;
  runsRoot: string;
  worldFetch: FetchLike;
  blobHosts: string[];
  knot: { hits: number };
  close(): Promise<void>;
}

async function startTangledWorld(): Promise<TangledWorld> {
  const patchBytes = gzipSync(Buffer.from(formatPatchText(), "utf8"));
  const knot = { hits: 0 };
  const transport = makeWorldFetch(patchBytes, knot);
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
    worldFetch: transport.fetchImpl,
    blobHosts: transport.hosts,
    knot,
    async close() {
      await Promise.all([bobbin.close(), pds.server.close(), model.close()]);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(runsRoot, { recursive: true, force: true });
    },
  };
}

/** A Spindle host environment: contract inputs plus the runtime variables
 * Spindle injects (see examples/tangled-workflow.yml), with Bobbin pointed
 * at the local mock and the knot pointed at the bare loopback hostname the
 * transport stub answers. `withKnot: false` omits `TANGLED_REPO_KNOT` — the
 * production head reader then has no knot to read and publication must fail
 * closed. NO `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`,
 * `GITHUB_TOKEN`, or `RUNNER_TEMP` — only `GITHUB_WORKSPACE`, which the
 * runner reads as the plain checkout directory. */
function tangledEnv(
  world: TangledWorld,
  runDir: string,
  atprotoPdsUrl?: string | undefined,
  withKnot = true,
): NodeJS.ProcessEnv {
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
    ...(withKnot ? { TANGLED_REPO_KNOT: "127.0.0.1" } : {}),
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

/**
 * One runner round against the shared world, with fresh runner state and
 * the FULL production capability stack (#1690): the stock `TangledAdapter`
 * (no read overrides — only the documented `resolver` DNS seam) and no
 * `publishApi` seam, so the production `buildPublishApi` factory builds the
 * `TangledPublishApi` — with the real `readTangledCurrentHeadForContext`
 * current-head reader — from the `ATPROTO_*` environment. The world
 * transport stub is installed over `globalThis.fetch` for the round, so the
 * knot head read and the blob chain reach their mock wires while the
 * loopback servers keep using the real transport.
 */
async function runTangledSmokeRound(
  world: TangledWorld,
  runDirName: string,
  options: { withKnot?: boolean } = {},
): Promise<number> {
  const { withKnot = true } = options;
  const runDir = join(world.runsRoot, runDirName);
  const env = tangledEnv(world, runDir, world.pds.server.url, withKnot);
  const realFetch = globalThis.fetch;
  globalThis.fetch = world.worldFetch as unknown as typeof fetch;
  try {
    return await platformActionMain(env, {
      platformAdapter: new TangledAdapter({ context: smokeContext(world), resolver: publicResolver }),
      runDir,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
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

    // The managed record is the production buildPublishApi's output, and the
    // #451 publication re-check read the trusted head from the knot: one
    // ticket listing plus one patch listing per publication.
    assert.ok(world.knot.hits >= 2, "the publication head re-check consulted the knot records");
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
    // Same production publish factory as the success rounds, but with no
    // `TANGLED_REPO_KNOT`: `readTangledCurrentHeadForContext` has no knot to
    // read, returns null, and the #451 re-check must refuse publication.
    const code = await runTangledSmokeRound(world, "run-no-head", { withKnot: false });
    assert.equal(code, 1, "a review whose publication is refused exits non-zero");
    assert.ok(world.model.requests.length >= 1, "the review itself still ran");
    assert.equal(world.knot.hits, 0, "no knot read happened without a knot host");
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
