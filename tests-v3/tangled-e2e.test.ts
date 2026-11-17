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
 *   mock PDS (session, listRecords, createRecord, putRecord), and the real
 *   #1165 current-head re-check against the same knot stub;
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
import { TANGLED_MANAGED_REVIEW_COLLECTION } from "../src/platform/tangled-publish.js";
import { startMockServer, type MockServer } from "./helpers.js";

const OWNER_DID = "did:plc:owner00000000000000000000000000000000000000000000000";
const REPO_DID = "did:plc:repo000000000000000000000000000000000000000000000000";
const AUTHOR_DID = "did:plc:author000000000000000000000000000000000000000000000";
const BOT_DID = "did:plc:bot0000000000000000000000000000000000000000000000000";
const TICKET_RKEY = "3lzq4w5qk2c2a";
const TICKET_URI = `at://${REPO_DID}/org.tangled.track.ticket/${TICKET_RKEY}`;
const PATCH_CID = "bafyreipatch0000000000000000000000000000000000000000000";
const KNOT_HOST = "knot.test";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A real SHA-256 repository spanning the patch revision's two commits:
 * the base commit says `hello`, the head commit adds `world`. SHA-256 is
 * the current knot default (new repositories), so the smoke proves the
 * 64-hex oid path end to end. Fixed-argv git with local config overrides —
 * no global config (signing, identity) can leak into the fixture. */
function makeRoundWorkspace(): { workspace: string; baseOid: string; headOid: string; close(): void } {
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
  writeFileSync(join(workspace, "README.md"), "hello\nworld\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "head: add the greeting"]);
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

/** The knot wire boundary: the production read factory AND the production
 * publish factory both build their knot reads without an injectable
 * transport, so the knot's `com.atproto.repo.listRecords` is mocked by a
 * scoped `globalThis.fetch` stub that intercepts ONLY the knot host and
 * passes everything else through. `calls` records every intercepted
 * collection read. */
async function withKnotStub<T>(
  run: () => Promise<T>,
  fixtures: { ticket: Record<string, unknown>; patch: Record<string, unknown> },
): Promise<{ result: T; knotCalls: string[] }> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  const stubbed: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== KNOT_HOST || url.pathname !== "/xrpc/com.atproto.repo.listRecords") {
      return original(input, init);
    }
    calls.push(String(url.searchParams.get("collection")));
    if (url.searchParams.get("repo") !== REPO_DID) return json({ error: "unknown repo" }, 400);
    if (url.searchParams.get("collection") === "org.tangled.track.ticket") {
      return json({
        records: [{ uri: TICKET_URI, cid: "bafyreiticket", value: fixtures.ticket }],
      });
    }
    if (url.searchParams.get("collection") === "org.tangled.review.patch") {
      return json({
        records: [{
          uri: `at://${REPO_DID}/org.tangled.review.patch/${PATCH_CID}`,
          cid: PATCH_CID,
          value: fixtures.patch,
        }],
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

/** The whole emulated Tangled world: a stateful mock PDS, a model server, a
 * real SHA-256 git workspace spanning the patch revision's two commits, and
 * a run-directory root. The knot is stubbed per run (see `withKnotStub`). */
interface TangledWorld {
  pds: MockPds;
  model: MockServer;
  markdown: { current: string };
  workspace: string;
  baseOid: string;
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
function tangledEnv(world: TangledWorld, runDir: string): NodeJS.ProcessEnv {
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
    TANGLED_PR_SOURCE_SHA: world.headOid,
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
  options: { withKnot?: boolean } = {},
): Promise<{ code: number; knotCalls: string[] }> {
  const { withKnot = true } = options;
  const runDir = join(world.runsRoot, runDirName);
  const execute = async (): Promise<number> =>
    platformActionMain(tangledEnv(world, runDir), { runDir });
  if (!withKnot) {
    return { code: await execute(), knotCalls: [] };
  }
  const { result, knotCalls } = await withKnotStub(execute, knotFixtures(world));
  return { code: result, knotCalls };
}

function soleManagedRecord(world: TangledWorld): { uri: string; value: Record<string, unknown> } {
  assert.equal(world.pds.records.size, 1, "exactly one managed review record exists");
  const entry = [...world.pds.records.entries()][0];
  assert.ok(entry, "the managed record map holds one entry");
  return { uri: entry[0], value: entry[1] };
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
    const { value } = soleManagedRecord(world);
    assert.equal(value.$type, TANGLED_MANAGED_REVIEW_COLLECTION);
    assert.equal(value.pull, TICKET_URI, "the record is bound to the resolved ticket");
    assert.equal(value.pullRepoDid, REPO_DID);
    assert.equal(value.reviewer, BOT_DID, "the record is attributed to the session DID");
    assert.equal(value.sourceSha, world.headOid, "the reviewed head is the selected patch revision's trusted head.oid");
    assert.equal(typeof value.body, "string");
    assert.match(String(value.body), /First review: looks fine\./, "the record body is the published review");
    assert.equal(world.pds.creates, 1, "the first round creates the record");
    assert.equal(world.pds.puts, 0);

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
    assert.equal(world.pds.creates, 1, "the re-review created no second record");
    assert.equal(world.pds.puts, 1, "the re-review updated the record in place");
    assert.match(String(second.value.body), /Second review: still looks fine\./);
    assert.doesNotMatch(String(second.value.body), /First review: looks fine\./,
      "the superseded body no longer stays visible");
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
