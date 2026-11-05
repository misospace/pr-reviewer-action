/**
 * #590: the host-neutral Tangled/Spindle runner.
 *
 * These drive `platformActionMain` — precheck → review → publish in one ordinary
 * Node process — with the forge READ and WRITE capabilities injected as host
 * seams (a Tangled-shaped read adapter + a Tangled write API) and the model
 * served by a local mock. The environment deliberately carries NO GitHub
 * Actions bookkeeping (`GITHUB_EVENT_PATH` / `GITHUB_OUTPUT` /
 * `GITHUB_STEP_SUMMARY` / `RUNNER_TEMP`) and NO `GITHUB_API_URL`: if any stage
 * fell back to a GitHub or Forgejo client, it would fail rather than complete.
 *
 * Coverage of the issue's acceptance list:
 *   - a mocked Tangled context completes precheck → review → publish;
 *   - skip / no-review behavior is preserved (and publishes nothing);
 *   - review failures propagate (the process rejects);
 *   - publish failures propagate as a non-zero exit (and a superseded head
 *     exits 0, exactly like the Action);
 *   - no GitHub Actions bookkeeping variables are required;
 *   - the runner drives the SAME `runReview` engine and the Tangled publish
 *     seam (no gh/python/shell, no GitHub/Forgejo fallback);
 *   - an explicitly configured GitHub/Forgejo platform is refused rather than
 *     routed to that forge (the config input cannot re-resolve the platform
 *     behind the runner's Tangled pin).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformActionMain, PlatformActionError } from "../src/run/platform-action.js";
import { startMockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import {
  type NativeReviewRequest,
  type NativeReviewSurface,
  type PublishCommentRef,
  type PublishPlatformApi,
  type PublishReviewRef,
} from "../src/platform/publish-api.js";

const HEAD = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const BASE = "c".repeat(40);

function verdictResponse(): string {
  return JSON.stringify({
    id: "c1", object: "chat.completion", model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({
      verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null,
      findings: [], requirement_coverage: null, required_check_dispositions: [],
    }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

/** The reads a small Tangled pull needs, served offline. The object's forge tag
 * is `tangled`; the runner pins the platform so this adapter is the only read
 * source. Every method the pipeline touches under the test's feature flags
 * (tools off, deep review off) is served; nothing else is reached. */
function tangledReadCapability(overrides: {
  getPr?: () => Promise<unknown | null>;
  getPrDiff?: () => Promise<string>;
} = {}): PlatformReadAdapter {
  return {
    platform: "tangled",
    getPr: overrides.getPr ?? (() => Promise.resolve({
      title: "Tangled pull",
      body: "",
      state: "open",
      draft: false,
      head: { sha: HEAD, ref: "feature", repo: { full_name: "did:plc:repo" } },
      base: { sha: BASE, ref: "main", repo: { full_name: "did:plc:repo" } },
      user: { login: "did:plc:author" },
      changed_files: 1,
      additions: 1,
      deletions: 0,
      html_url: "at://did:plc:repo/org.tangled.pull/abc",
    })),
    getPrDiff: overrides.getPrDiff ?? (() => Promise.resolve(
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n",
    )),
    listPrFiles: () => Promise.resolve({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 }] }),
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

/** The Tangled write capability (#588's managed top-level record), with a
 * configurable current-head answer for the #451 publication-boundary re-check.
 * Records the calls so a test can prove which seam published. */
class FakeTangledPublishApi implements PublishPlatformApi {
  readonly platform = "tangled" as const;
  readonly nativeReviewSurface: NativeReviewSurface = { supported: false, reason: "Tangled has no native pull-review surface" };
  readonly currentHeadUnavailableReason = "Tangled has no trustworthy current-head source yet";
  upserts = 0;
  constructor(private readonly head: string | null) {}
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(): Promise<{ ok: boolean; created: boolean }> { this.upserts += 1; return { ok: true, created: true }; }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async listManagedInlineComments() { return { supported: false, complete: false, comments: [] }; }
  async retireInlineComment(): Promise<boolean> { return false; }
  async createReview(_request: NativeReviewRequest): Promise<{ ok: boolean }> { return { ok: false }; }
  async dismissReview(): Promise<boolean> { return false; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return false; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: never[]; hasNextPage: boolean }> { return { ok: false, threads: [], hasNextPage: false }; }
  async resolveThread(): Promise<boolean> { return false; }
  async removeLabel(): Promise<boolean> { return false; }
  async requestReviewers(): ReturnType<PublishPlatformApi["requestReviewers"]> {
    return { ok: false, supported: false, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

/** A Tangled/Spindle host environment: only the contract-required inputs
 * (`ai-base-url`/`ai-model`) plus the Tangled context. NO `GITHUB_*` and NO
 * `RUNNER_TEMP` — the exact acceptance requirement. Deliberately NOT spread
 * from `process.env` so the test host's own runner vars never leak in. */
function tangledEnv(modelUrl: string, workspace: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    // Contract-required inputs (+ the provider wiring the transport reads).
    "INPUT_AI-BASE-URL": modelUrl,
    "INPUT_AI-MODEL": "m",
    "INPUT_AI-API-KEY": "k",
    "INPUT_AI-STREAM": "false",
    "INPUT_TOOL-MODE": "off",
    "INPUT_DEEP-REVIEW": "false",
    "INPUT_PUBLISH-MODE": "comment",
    // The Tangled/Spindle context consumed through the typed platform modules.
    TANGLED_REPO_DID: "did:plc:owner",
    TANGLED_REPO_REPO_DID: "did:plc:repo",
    TANGLED_REPO_NAME: "tangled.example/repo",
    TANGLED_PR_SOURCE_BRANCH: "feature",
    TANGLED_PR_TARGET_BRANCH: "main",
    TANGLED_PR_SOURCE_SHA: HEAD,
    // The reviewed checkout, so the engine never reads the test repo itself.
    GITHUB_WORKSPACE: workspace,
  } as NodeJS.ProcessEnv;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "v3-tangled-runner-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#590: a mocked Tangled context completes precheck → review → publish with no GitHub Actions bookkeeping", async () => {
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictResponse());
  });
  const publishApi = new FakeTangledPublishApi(HEAD);
  try {
    await withTemp(async (workspace) => {
      const code = await platformActionMain(tangledEnv(model.url, workspace), {
        platformAdapter: tangledReadCapability(),
        publishApi,
      });
      // Published through the Tangled write capability → exit 0.
      assert.equal(code, 0);
      assert.equal(publishApi.upserts, 1, "the review published exactly once through the Tangled seam");
    });
  } finally {
    await model.close();
  }
});

test("#590: a skipped run (closed pull) is a clean no-op and publishes nothing", async () => {
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictResponse());
  });
  const publishApi = new FakeTangledPublishApi(HEAD);
  try {
    await withTemp(async (workspace) => {
      const closed = await tangledReadCapability({
        getPr: () => Promise.resolve({
          state: "closed",
          draft: false,
          head: { sha: HEAD, ref: "feature", repo: { full_name: "did:plc:repo" } },
          base: { sha: BASE, ref: "main", repo: { full_name: "did:plc:repo" } },
          user: { login: "did:plc:author" },
          title: "Closed", body: "",
        }),
      });
      const code = await platformActionMain(tangledEnv(model.url, workspace), {
        platformAdapter: closed,
        publishApi,
      });
      assert.equal(code, 0, "a skip exits green");
      assert.equal(publishApi.upserts, 0, "a skip never publishes");
    });
  } finally {
    await model.close();
  }
});

test("#590: a review failure propagates as a rejected run (no silent success)", async () => {
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictResponse());
  });
  const publishApi = new FakeTangledPublishApi(HEAD);
  try {
    await withTemp(async (workspace) => {
      // A null PR read is an operational forge failure precheck must NOT turn
      // into a successful "no review" — the engine throws.
      const broken = tangledReadCapability({ getPr: () => Promise.resolve(null) });
      await assert.rejects(
        platformActionMain(tangledEnv(model.url, workspace), { platformAdapter: broken, publishApi }),
        (error: unknown) => error instanceof Error && /Could not read pull request/.test(error.message),
      );
      assert.equal(publishApi.upserts, 0, "a failed review publishes nothing");
    });
  } finally {
    await model.close();
  }
});

test("#590: a publish failure propagates as a non-zero exit (Tangled head unavailable fails closed)", async () => {
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictResponse());
  });
  // No trustworthy current head (the pre-#1165 state): publication is refused.
  const publishApi = new FakeTangledPublishApi(null);
  try {
    await withTemp(async (workspace) => {
      const code = await platformActionMain(tangledEnv(model.url, workspace), {
        platformAdapter: tangledReadCapability(),
        publishApi,
      });
      assert.equal(code, 1, "a failed publication exits non-zero");
      assert.equal(publishApi.upserts, 0, "the refused publication wrote no managed record");
    });
  } finally {
    await model.close();
  }
});

test("#590: a newer head supersedes the publication and exits 0 (parity with the Action)", async () => {
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictResponse());
  });
  // The pull advanced mid-run: the fresh head differs from the reviewed head.
  const publishApi = new FakeTangledPublishApi(HEAD2);
  try {
    await withTemp(async (workspace) => {
      const code = await platformActionMain(tangledEnv(model.url, workspace), {
        platformAdapter: tangledReadCapability(),
        publishApi,
      });
      assert.equal(code, 0, "a superseded publication is not a failure");
      assert.equal(publishApi.upserts, 0, "a superseded run writes nothing");
    });
  } finally {
    await model.close();
  }
});

test("#590: the runner refuses a non-Tangled environment rather than falling back", async () => {
  await withTemp(async (workspace) => {
    const env = tangledEnv("http://127.0.0.1:1", workspace);
    // A Tangled host that never supplied its required DID fails closed in the
    // typed context module — it is never silently treated as GitHub/Forgejo.
    delete env.TANGLED_REPO_DID;
    await assert.rejects(
      platformActionMain(env, {}),
      (error: unknown) => error instanceof Error && /TANGLED_REPO_DID/.test(error.message),
    );
  });
});

test("#590: with no injected seams the engine still routes to the Tangled read capability", async () => {
  // Locks the production no-seam path: the engine rebuilds its stage from
  // the contract config (where the runner pinned `platform` to `tangled`) and
  // reaches Tangled only through the resolved DID. The real `TangledAdapter`
  // then fails closed at its own unimplemented read (#586) — it never
  // constructs or reads through a GitHub or Forgejo client, and never dies on a
  // missing GitHub token.
  await withTemp(async (workspace) => {
    await assert.rejects(
      platformActionMain(tangledEnv("http://127.0.0.1:1", workspace), {}),
      (error: unknown) =>
        error instanceof Error
        && /tangled|Bobbin/i.test(error.message)
        && !/GitHub|GH_TOKEN|GITHUB_TOKEN|Forgejo/i.test(error.message),
    );
  });
});

test("#590: an explicitly configured GitHub/Forgejo platform is refused, never routed to that forge", async () => {
  // The engine rebuilds its stage from the CONTRACT CONFIG, so an operator's
  // `INPUT_PLATFORM=github` (or `forgejo`) used to re-resolve the platform
  // during admission and drive a GitHub/Forgejo client — the fallback #590
  // forbids. The runner pins the platform input to `tangled` and refuses a
  // contradictory explicit platform instead of silently ignoring it.
  const forge = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([]));
  });
  try {
    for (const platform of ["github", "forgejo"]) {
      await withTemp(async (workspace) => {
        const publishApi = new FakeTangledPublishApi(HEAD);
        const env = tangledEnv("http://127.0.0.1:1", workspace);
        env["INPUT_PLATFORM"] = platform;
        // A GitHub token and API URL are present on purpose: a run that
        // reached a GitHub client would use them, and the mock server would
        // record the request.
        env.GITHUB_TOKEN = "token-that-must-never-be-used";
        env.GH_TOKEN = "token-that-must-never-be-used";
        env.GITHUB_API_URL = forge.url;
        await assert.rejects(
          platformActionMain(env, { publishApi }),
          (error: unknown) =>
            error instanceof PlatformActionError
            && new RegExp(`platform '${platform}'`).test(error.message),
        );
        assert.equal(forge.requests.length, 0, `no ${platform} request was ever issued`);
        assert.equal(publishApi.upserts, 0, "a refused platform publishes nothing");
      });
    }
  } finally {
    await forge.close();
  }
});

test("#590: an explicit 'auto' platform still resolves to Tangled through the DID", async () => {
  // `auto` is the contract default and is compatible with the Tangled host:
  // the DID decides, so the run stays on the Tangled capability. The same
  // holds for an explicit `tangled`.
  for (const platform of ["auto", "tangled"]) {
    await withTemp(async (workspace) => {
      const env = tangledEnv("http://127.0.0.1:1", workspace);
      env["INPUT_PLATFORM"] = platform;
      await assert.rejects(
        platformActionMain(env, {}),
        (error: unknown) =>
          error instanceof Error
          && /tangled|Bobbin/i.test(error.message)
          && !/GitHub|GH_TOKEN|GITHUB_TOKEN|Forgejo/i.test(error.message),
      );
    });
  }
});

test("#590: the runner forces the CI gate off, so no gate child is ever launched", async () => {
  // Tangled has no pipeline-status seam, so CI waiting stays unsupported. The
  // runner forces `ci-status-check` off even when the host asks for it: a
  // gate child would resolve the platform to tangled and fail there
  // (`requireImplementedBackend`), so the review must not launch one. The
  // fake bundle writes a marker when a child starts, which proves the gate
  // stayed off.
  const model = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictResponse());
  });
  const publishApi = new FakeTangledPublishApi(HEAD);
  try {
    await withTemp(async (workspace) => {
      const marker = join(workspace, "gate-child-ran.txt");
      const entry = join(workspace, "fake-bundle.cjs");
      writeFileSync(entry, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "gate-ran");\n`, "utf8");
      const env = tangledEnv(model.url, workspace);
      env["INPUT_CI-STATUS-CHECK"] = "true";
      env.PR_REVIEWER_ENTRY = entry;
      const code = await platformActionMain(env, {
        platformAdapter: tangledReadCapability(),
        publishApi,
      });
      assert.equal(code, 0, "the run completes without a CI gate");
      assert.equal(existsSync(marker), false, "no CI gate child was launched");
      assert.equal(publishApi.upserts, 1, "the review still published");
    });
  } finally {
    await model.close();
  }
});
