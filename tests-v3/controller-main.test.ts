/** The production controller entrypoint (#738 Phase A2): fail-closed
 * startup refusals (missing/invalid config, missing required environment,
 * an uncomposable forge platform, a kubernetes profile off-cluster), the
 * REAL in-cluster KubernetesApi client against a local API fake (the four
 * seam verbs, the bearer header from the projected token file, the bounded
 * response cap), and a successful minimal startup over the injected
 * in-memory control plane — webhook delivery → daemon intake → executor →
 * publication — with a graceful stop. Model calls stay out: the engine
 * rides a fake executor and a fake review runner, exactly the
 * controller-daemon test's pattern. */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryControlPlaneStore,
} from "../src/state/index.js";
import type { MirrorCache, WorkspaceHandle } from "../src/acquisition/index.js";
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatusReport,
  Executor,
} from "../src/executor/index.js";
import type { KubernetesExecutorSpec } from "../src/config/instance-config.js";
import { validateExecutionRequest } from "../src/executor/index.js";
import {
  kubernetesCredentialSecretName,
  type KubernetesJobManifest,
  type KubernetesJobStatus,
  type KubernetesJobSummary,
} from "../src/executor/kubernetes.js";
import { KubernetesExecutor } from "../src/executor/kubernetes.js";
import { InClusterKubernetesApi } from "../src/executor/kubernetes-api.js";
import { InClusterCredentialStore } from "../src/executor/kubernetes-credential-store.js";
import { parseInstanceConfigText } from "../src/config/instance-config.js";
import { validateContract } from "../src/config/contract.js";
import { V3_CONTRACT } from "../.v3-generated/contract.generated.js";
import { computeGitHubWebhookSignature } from "../src/ingress/github-app-signature.js";
import type { FollowUpForgeAdapter } from "../src/ingress/followup-host.js";
import type { ReconcileReport } from "../src/ingress/reconcile.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";
import {
  controllerMain,
  createGitHubPublishMintingBroker,
  createModelCredentialVault,
  createWorkerCredentialBinding,
  reconcileReportDiagnostics,
  type ControllerMainHandle,
} from "../src/controller/main.js";
import { composeForgeCapability } from "../src/controller/forge-capability.js";
import type { FetchLike } from "../src/platform/http.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";
const WEBHOOK_SECRET = "controller-webhook-secret";

/** Capture stderr diagnostics without touching the real stream. */
function captureStderr(): { readonly lines: () => readonly string[]; readonly attach: () => void; readonly detach: () => void } {
  const collected: string[] = [];
  let original: typeof process.stderr.write | null = null;
  return {
    lines: () => collected,
    attach: () => {
      original = process.stderr.write;
      process.stderr.write = ((chunk: unknown): boolean => {
        collected.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      }) as typeof process.stderr.write;
    },
    detach: () => {
      if (original !== null) process.stderr.write = original;
      original = null;
    },
  };
}

const MIN_INSTANCE_CONFIG = `version: 1
model-profiles:
  - name: fast
    endpoint: http://127.0.0.1:9/v1
    api-format: openai
    model: test-model
    credential: model-cred
default-model-profile: fast
executor-profiles:
  - name: local-dev
    kind: local
    local:
      command: /bin/true
      args: []
default-executor-profile: local-dev
evidence-profiles:
  - name: default
    providers-file: /tmp/providers.json
default-evidence-profile: default
adoption:
  mode: all_allowed
  discovered-default: adopt
queue:
  max-concurrent-reviews: 2
`;

const GITHUB_INSTANCE_CONFIG = `${MIN_INSTANCE_CONFIG}
forges:
  - name: primary
    kind: github
    endpoint: https://api.github.com
    credential: forge-cred
`;

const FORGEJO_INSTANCE_CONFIG = `${MIN_INSTANCE_CONFIG}
forges:
  - name: primary
    kind: forgejo
    endpoint: http://127.0.0.1:9
    credential: forge-cred
`;

/** #1682: `gitea` is an identity served by the Forgejo-compatible stack —
 * the config is identical except for the kind. */
const GITEA_INSTANCE_CONFIG = `${MIN_INSTANCE_CONFIG}
forges:
  - name: primary
    kind: gitea
    endpoint: http://127.0.0.1:9
    credential: forge-cred
`;

/** #1711: the #727 operator contract taken literally — no
 * `evidence-profiles`, no `default-evidence-profile`. The doc's example
 * carries `default-evidence-profile: null`, and Action-mode parity makes
 * evidence "not configured" (an empty providers file set), never a startup
 * refusal. */
const NO_EVIDENCE_INSTANCE_CONFIG = `version: 1
model-profiles:
  - name: fast
    endpoint: http://127.0.0.1:9/v1
    api-format: openai
    model: test-model
    credential: model-cred
default-model-profile: fast
executor-profiles:
  - name: local-dev
    kind: local
    local:
      command: /bin/true
      args: []
default-executor-profile: local-dev
forges:
  - name: primary
    kind: gitea
    endpoint: http://127.0.0.1:9
    credential: forge-cred
adoption:
  mode: all_allowed
  discovered-default: adopt
queue:
  max-concurrent-reviews: 2
`;

/** The minimal production-shaped environment for one startup. */
function baseEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    PR_REVIEWER_CONTROL_PLANE_URL: "postgres://controller:secret@db.local:5432/control",
    PR_REVIEWER_DURABLE_STATE_DIR: mkdtempSync(join(tmpdir(), "ctl-state-")),
    PR_REVIEWER_RUNS_ROOT: mkdtempSync(join(tmpdir(), "ctl-runs-")),
    PR_REVIEWER_WORKSPACE_CACHE_ROOT: mkdtempSync(join(tmpdir(), "ctl-cache-")),
    PR_REVIEWER_CREDENTIAL_MODEL_CRED: "sk-test-model-material",
    PR_REVIEWER_INSTANCE_CONFIG: configPath,
  };
}

function cleanupDirs(env: NodeJS.ProcessEnv): void {
  for (const name of [
    "PR_REVIEWER_DURABLE_STATE_DIR",
    "PR_REVIEWER_RUNS_ROOT",
    "PR_REVIEWER_WORKSPACE_CACHE_ROOT",
  ]) {
    const dir = env[name];
    if (typeof dir === "string" && dir !== "") rmSync(dir, { recursive: true, force: true });
  }
}

/** A scripted local-profile executor (the daemon-test pattern): writes the
 * request envelope and the settled result + review artifact. */
class FakeExecution implements Executor {
  readonly started: ExecutionRequest[] = [];
  private settled: ExecutionResult | null = null;

  async start(request: ExecutionRequest, _signal: AbortSignal): Promise<{
    observe: () => Promise<ExecutionStatusReport>;
    cancel: () => Promise<void>;
    collect: () => Promise<ExecutionResult>;
  }> {
    this.started.push(request);
    const reviewPath = join(request.runDir, "ai-output.json");
    mkdirSync(request.runDir, { recursive: true });
    writeFileSync(
      reviewPath,
      JSON.stringify({ verdict: "issues", summary: "a fake finding", headSha: request.headSha }),
      "utf8",
    );
    const result: ExecutionResult = {
      status: "completed",
      runId: request.runId,
      jobId: request.jobId,
      resultHeadSha: request.headSha,
      failureCategory: "",
      failureMessage: "",
      resultArtifactPath: reviewPath,
      diagnostics: "",
      artifactPaths: [],
      resourceMs: 1,
      observedAtMs: Date.now(),
    };
    writeFileSync(request.resultPath, JSON.stringify(result), "utf8");
    this.settled = result;
    return {
      observe: async () => ({
        phase: "terminal" as const,
        status: "completed" as const,
        observedAtMs: Date.now(),
      }),
      cancel: async () => undefined,
      collect: async () => this.settled!,
    };
  }

  async reconcile(): Promise<{ kind: "none" }> {
    return { kind: "none" };
  }

  async cancel(): Promise<{ kind: "terminated" }> {
    return { kind: "terminated" };
  }
}

/** The follow-up adapter fake (the configuration only has to be complete
 * enough for the operator host to construct the consumer). */
function followUpAdapter(): FollowUpForgeAdapter {
  return {
    async readPermission() {
      return null;
    },
    async readComment() {
      return "";
    },
    async fetchThreadComments() {
      return [];
    },
    async readPrState() {
      return { state: "open", draft: "not-draft" };
    },
    async postComment() {
      return true;
    },
    async resolveHeadSha() {
      return HEAD;
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address() as AddressInfo;
      probe.close(() => resolve(addr.port));
    });
  });
}

async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("waitFor: condition not reached within budget");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ── fail-closed startup refusals ─────────────────────────────────────────

test("no config: exit 2 with a bounded diagnostic and no partial composition", async () => {
  const stderr = captureStderr();
  stderr.attach();
  let composed = false;
  try {
    const code = await controllerMain([], {}, {
      onReady: () => {
        composed = true;
      },
    });
    assert.equal(code, 2);
  } finally {
    stderr.detach();
  }
  assert.equal(composed, false, "nothing composed on a missing config");
  const text = stderr.lines().join("");
  assert.match(text, /no instance config/);
  assert.ok(text.length < 4_000, "the diagnostic stayed bounded");
});

test("a missing config file: exit 2", async () => {
  const stderr = captureStderr();
  stderr.attach();
  const env = baseEnv("/nonexistent/instance.yaml");
  try {
    const code = await controllerMain([], env);
    assert.equal(code, 2);
    assert.match(stderr.lines().join(""), /not readable/);
  } finally {
    stderr.detach();
    cleanupDirs(env);
  }
});

test("an invalid instance config: exit 2 with the validator's bounded reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-bad-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, "version: 2\n", "utf8");
  const env = baseEnv(configPath);
  delete env.PR_REVIEWER_CREDENTIAL_MODEL_CRED;
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /instance config is invalid/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("missing required environment: exit 2 naming every missing variable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-env-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, MIN_INSTANCE_CONFIG, "utf8");
  const stderr = captureStderr();
  stderr.attach();
  try {
    const code = await controllerMain(["--config", configPath], {
      PR_REVIEWER_DURABLE_STATE_DIR: "/tmp/state",
    });
    assert.equal(code, 2);
    const text = stderr.lines().join("");
    assert.match(text, /missing required environment/);
    assert.match(text, /PR_REVIEWER_CONTROL_PLANE_URL/);
    assert.match(text, /PR_REVIEWER_RUNS_ROOT/);
    assert.match(text, /PR_REVIEWER_WORKSPACE_CACHE_ROOT/);
  } finally {
    stderr.detach();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a github instance without GitHub App material: exit 2 (no forge integration)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-gh-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /PR_REVIEWER_GITHUB_APP_ID/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("a forgejo instance without FORGEJO_TOKEN: exit 2 (no forge integration)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-fj-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, FORGEJO_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /Forgejo token/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("a gitea-kind instance starts with FORGEJO_TOKEN (#1682)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-gitea-ok-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITEA_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";

  let handle: ControllerMainHandle | null = null;
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (_input) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
      publish: async () => ({ publicationId: "forgejo-comment:1" }),
    },
    followUpAdapter: followUpAdapter(),
    followUpBotLogin: async () => "reviewer-bot",
    followUpAnswer: async () => "an answer",
    onReady: (ready) => {
      handle = ready;
    },
  });
  t.after(async () => {
    if (handle !== null) await handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handle !== null);
  assert.notEqual(handle, null);
  const started = handle!;

  // The graceful stop drains and exits 0, exactly the successful-boot contract.
  const code = await started.stop();
  assert.equal(code, 0);
  assert.equal(started.daemon.stopped, true);
});

test("an instance config with no evidence profiles composes: 'no providers' is expressible (#1711)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-no-evidence-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, NO_EVIDENCE_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";

  let handle: ControllerMainHandle | null = null;
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (_input) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
      publish: async () => ({ publicationId: "forgejo-comment:1" }),
    },
    followUpAdapter: followUpAdapter(),
    followUpBotLogin: async () => "reviewer-bot",
    followUpAnswer: async () => "an answer",
    onReady: (ready) => {
      handle = ready;
    },
  });
  t.after(async () => {
    if (handle !== null) await handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  // The #727 doc's example instance config (`default-evidence-profile:
  // null`) must start: the schema makes evidence optional, so the
  // composition may not refuse what the contract declares valid (#1711).
  await waitFor(() => handle !== null);
  assert.notEqual(handle, null);
  const started = handle!;

  const code = await started.stop();
  assert.equal(code, 0);
  assert.equal(started.daemon.stopped, true);
});

test("a gitea-kind instance without FORGEJO_TOKEN refuses startup (#1682)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-gitea-notoken-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITEA_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(
        stderr.lines().join(""),
        /serves gitea but no Gitea token is configured \(FORGEJO_TOKEN\)/,
      );
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("a gitea-kind instance with FORGEJO_AUTH_METHOD=authorized_integration is refused (#1682)", async () => {
  // Gitea has no Forgejo "authorized integration": the DECLARED product
  // decides the refusal, and the platform seam's Gitea token reader raises
  // it (#1678's canonical message) before any token lookup. The refusal
  // names the missing capability — not a missing credential.
  const dir = mkdtempSync(join(tmpdir(), "ctl-gitea-oidc-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITEA_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_AUTH_METHOD = "authorized_integration";
  env.FORGEJO_TOKEN = "forgejo-token";
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2, "authorized integration is never accepted for gitea");
      assert.match(
        stderr.lines().join(""),
        /Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token/,
      );
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("a gitea-kind instance with a bare authorized-integration audience is refused (#1682)", async () => {
  // The audience alone forces integration mode on Forgejo, so refusing only
  // the explicit method would let the configuration degrade silently into
  // token mode on Gitea instead of naming the misconfiguration.
  const dir = mkdtempSync(join(tmpdir(), "ctl-gitea-audience-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITEA_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE = "https://forgejo.example";
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2, "a bare authorized-integration audience is refused for gitea");
      assert.match(
        stderr.lines().join(""),
        /Gitea does not support 'forgejo-authorized-integration-audience'/,
      );
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("a mixed forgejo+gitea-kind instance is refused at startup (#1682)", async () => {
  // One daemon serves ONE platform (#1484's guard), and `gitea` does NOT
  // relax it by sharing the forgejo FAMILY: two kind labels mean two
  // integrations an operator could bind inconsistently. Refuse, exit 2.
  const dir = mkdtempSync(join(tmpdir(), "ctl-gitea-mixed-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(
    configPath,
    `${MIN_INSTANCE_CONFIG}
forges:
  - name: fj
    kind: forgejo
    endpoint: http://127.0.0.1:9
    credential: forge-cred
  - name: gt
    kind: gitea
    endpoint: http://127.0.0.1:9
    credential: forge-cred
`,
    "utf8",
  );
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /exactly one platform/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("an admin port without an admin token: exit 2 (never served unauthenticated)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-admin-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, FORGEJO_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";
  env.PR_REVIEWER_ADMIN_PORT = "8081";
  delete env.PR_REVIEWER_ADMIN_TOKEN;
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /PR_REVIEWER_ADMIN_TOKEN/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("an admin bind outside the closed allowlist: exit 2 (a hostname never rebinds the surface)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-admin-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, FORGEJO_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";
  env.PR_REVIEWER_ADMIN_PORT = "8081";
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";
  env.PR_REVIEWER_ADMIN_BIND = "admin.example.com";
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /PR_REVIEWER_ADMIN_BIND/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("an invalid PR_REVIEWER_ADMIN_DASHBOARD value: exit 2 (a typo is refused, not silently disabled)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-dash-typo-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, FORGEJO_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";
  env.PR_REVIEWER_ADMIN_PORT = "8081";
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";
  env.PR_REVIEWER_ADMIN_DASHBOARD = "ture";
  try {
    const stderr = captureStderr();
    stderr.attach();
    try {
      const code = await controllerMain([], env);
      assert.equal(code, 2);
      assert.match(stderr.lines().join(""), /PR_REVIEWER_ADMIN_DASHBOARD/);
    } finally {
      stderr.detach();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

// ── the env → createAdminHost wiring for the #742 dashboard flag ──────────

/** Boot a minimal composition with the admin listener on an ephemeral port
 * (the "minimal composition" harness) and resolve the handle once onReady
 * fired — by then the admin listener is bound. Teardown (graceful stop, then
 * the scratch dirs) is registered on `t` in one callback, stop FIRST. */
async function bootWithAdmin(env: NodeJS.ProcessEnv, t: { after: (fn: () => Promise<void>) => void }, dir: string): Promise<{ readonly handle: ControllerMainHandle; readonly adminPort: number }> {
  const handleBox: { handle: ControllerMainHandle | null } = { handle: null };
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (_input) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
      publish: async () => ({ publicationId: "github-comment:1" }),
    },
    followUpAdapter: followUpAdapter(),
    followUpBotLogin: async () => "reviewer-bot",
    followUpAnswer: async () => "an answer",
    onReady: (ready) => {
      handleBox.handle = ready;
    },
  });
  t.after(async () => {
    if (handleBox.handle !== null) await handleBox.handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handleBox.handle !== null);
  return { handle: handleBox.handle!, adminPort: Number(env.PR_REVIEWER_ADMIN_PORT) };
}

test("PR_REVIEWER_ADMIN_DASHBOARD=true serves the dashboard shell on the admin listener", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-dash-on-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
  const adminPort = await freePort();
  env.PR_REVIEWER_ADMIN_PORT = String(adminPort);
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";
  env.PR_REVIEWER_ADMIN_DASHBOARD = "true";
  await bootWithAdmin(env, t, dir);
  const shell = await fetch(`http://127.0.0.1:${adminPort}/dashboard`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(shell.headers.get("x-frame-options"), "DENY");
  // The shell is unauthenticated, the data routes are not.
  assert.equal((await fetch(`http://127.0.0.1:${adminPort}/admin/status`)).status, 401);
});

test("with the dashboard flag unset, /dashboard stays a fixed 404 on a running controller", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-dash-unset-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
  const adminPort = await freePort();
  env.PR_REVIEWER_ADMIN_PORT = String(adminPort);
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";
  await bootWithAdmin(env, t, dir);
  const shell = await fetch(`http://127.0.0.1:${adminPort}/dashboard`);
  assert.equal(shell.status, 404);
  assert.match(await shell.text(), /not found/);
});

test("PR_REVIEWER_ADMIN_DASHBOARD=false boots with the dashboard off (explicit off is not a refusal)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-dash-off-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
  const adminPort = await freePort();
  env.PR_REVIEWER_ADMIN_PORT = String(adminPort);
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";
  env.PR_REVIEWER_ADMIN_DASHBOARD = "false";
  await bootWithAdmin(env, t, dir);
  const shell = await fetch(`http://127.0.0.1:${adminPort}/dashboard`);
  assert.equal(shell.status, 404);
  assert.match(await shell.text(), /not found/);
});

test("the dashboard flag without an admin listener boots and serves nothing", async (t) => {
  // The flag means nothing without the listener: the composition boots, no
  // admin surface exists, and the lexical check does not refuse the ON value.
  const dir = mkdtempSync(join(tmpdir(), "ctl-dash-noadmin-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
  env.PR_REVIEWER_ADMIN_DASHBOARD = "true";
  const handleBox: { handle: ControllerMainHandle | null } = { handle: null };
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (_input) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
      publish: async () => ({ publicationId: "github-comment:1" }),
    },
    followUpAdapter: followUpAdapter(),
    followUpBotLogin: async () => "reviewer-bot",
    followUpAnswer: async () => "an answer",
    onReady: (ready) => {
      handleBox.handle = ready;
    },
  });
  t.after(async () => {
    if (handleBox.handle !== null) await handleBox.handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handleBox.handle !== null);
  assert.notEqual(handleBox.handle, null);
});

// ── the real in-cluster KubernetesApi against a local API fake ───────────

interface KubeFake {
  readonly server: ReturnType<typeof createServer>;
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly authHeaders: string[];
  readonly bodies: string[];
  readonly requests: { readonly method: string; readonly url: string }[];
  /** The Secret objects the fake holds, keyed by name (metadata only). */
  readonly secrets: Map<string, Record<string, unknown>>;
}

/** A local HTTP fake of the batch/v1 Jobs verbs and the core/v1 Secret verbs
 * the credential projection path needs. */
async function startKubeFake(): Promise<KubeFake> {
  const authHeaders: string[] = [];
  const bodies: string[] = [];
  const requests: { method: string; url: string }[] = [];
  const jobs = new Map<string, KubernetesJobStatus>();
  const secrets = new Map<string, Record<string, unknown>>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    authHeaders.push(String(request.headers.authorization ?? ""));
    const url = String(request.url ?? "");
    const method = String(request.method ?? "");
    requests.push({ method, url });
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      bodies.push(raw);
      // The flood route (response-cap probe) must be matched first.
      if (url.endsWith("/flood")) {
        response.statusCode = 200;
        response.end("x".repeat(4 * 1024 * 1024));
        return;
      }
      if (url.startsWith("/api/v1/namespaces/")) {
        const match = /^\/api\/v1\/namespaces\/[^/]+\/secrets(?:\/([^?]+))?$/.exec(url);
        const name = match?.[1] ?? "";
        if (method === "POST" && name === "") {
          const created = (JSON.parse(raw) as { metadata?: { name?: string } }).metadata?.name ?? "";
          if (secrets.has(created)) {
            response.statusCode = 409;
            response.end("{}");
            return;
          }
          secrets.set(created, { metadata: { name: created, uid: `uid-${created}`, resourceVersion: "1" } });
          response.statusCode = 201;
          response.end("{}");
          return;
        }
        if (method === "GET" && name !== "") {
          const secret = secrets.get(name);
          if (secret === undefined) {
            response.statusCode = 404;
            response.end("{}");
            return;
          }
          response.statusCode = 200;
          response.end(JSON.stringify(secret));
          return;
        }
        if (method === "GET" && name === "") {
          response.statusCode = 200;
          response.end(JSON.stringify({ items: [...secrets.values()] }));
          return;
        }
        if ((method === "PUT" || method === "PATCH") && secrets.has(name)) {
          response.statusCode = 200;
          response.end("{}");
          return;
        }
        if (method === "DELETE") {
          response.statusCode = secrets.delete(name) ? 200 : 404;
          response.end("{}");
          return;
        }
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      if (request.method === "POST" && url.startsWith("/apis/batch/v1/namespaces/") && url.endsWith("/jobs")) {
        const name = (JSON.parse(raw) as { metadata?: { name?: string } }).metadata?.name ?? "";
        if (jobs.has(name)) {
          response.statusCode = 409;
          response.end("{}");
          return;
        }
        jobs.set(name, { active: true, succeeded: false, failed: false, failureReason: "" });
        response.statusCode = 201;
        response.end("{}");
        return;
      }
      if (request.method === "GET" && /\/jobs\/[^?]+$/.test(url)) {
        const name = url.split("/").pop() ?? "";
        const status = jobs.get(name ?? "");
        if (status === undefined) {
          response.statusCode = 404;
          response.end("{}");
          return;
        }
        response.statusCode = 200;
        response.end(JSON.stringify({ metadata: { name, uid: "job-uid-1" }, status }));
        return;
      }
      if (request.method === "DELETE" && /\/jobs\/[^?]+$/.test(url)) {
        const name = url.split("/").pop() ?? "";
        jobs.delete(name ?? "");
        response.statusCode = 200;
        response.end("{}");
        return;
      }
      if (request.method === "GET" && url.includes("/jobs?")) {
        response.statusCode = 200;
        response.end(JSON.stringify({
          items: [...jobs.entries()].map(([name, status]) => ({
            metadata: { name, labels: { "app": "worker" } },
            status,
          })),
        }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = String((server.address() as AddressInfo).port);
  return {
    server,
    port: Number(port),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    authHeaders,
    bodies,
    requests,
    secrets,
  };
}

function sampleManifest(namespace: string, name: string): KubernetesJobManifest {
  return Object.freeze({
    name,
    namespace,
    labels: Object.freeze({ "app.kubernetes.io/managed-by": "pr-reviewer-controller" }),
    podTemplateLabels: Object.freeze({ "app.kubernetes.io/managed-by": "pr-reviewer-controller" }),
    ttlSecondsAfterFinished: 3600,
    backoffLimit: 0 as const,
    activeDeadlineSeconds: 600,
    pod: Object.freeze({
      restartPolicy: "Never" as const,
      serviceAccountName: "worker",
      automountServiceAccountToken: false as const,
      hostNetwork: false as const,
      terminationGracePeriodSeconds: 30,
      securityContext: Object.freeze({
        runAsNonRoot: true as const,
        runAsUser: 65532,
        runAsGroup: 65532,
        seccompProfile: Object.freeze({ type: "RuntimeDefault" as const }),
      }),
      containers: [
        Object.freeze({
          name: "worker" as const,
          image: "registry.local/worker:1",
          args: Object.freeze(["/usr/local/bin/worker"]),
          env: Object.freeze([
            Object.freeze({ name: "PR_REVIEWER_RUN_ID", value: "run-1" }),
          ]) as readonly ({ readonly name: string; readonly value: string } | { readonly name: string; readonly valueFrom: { readonly secretKeyRef: { readonly name: string; readonly key: string } } })[],
          resources: Object.freeze({
            requests: Object.freeze({ cpu: "1", memory: "1Gi" }),
            limits: Object.freeze({ cpu: "2", memory: "2Gi" }),
          }),
          securityContext: Object.freeze({
            allowPrivilegeEscalation: false as const,
            readOnlyRootFilesystem: true as const,
            capabilities: Object.freeze({ drop: Object.freeze(["ALL"]) as readonly ["ALL"] }),
            seccompProfile: Object.freeze({ type: "RuntimeDefault" as const }),
          }),
          volumeMounts: Object.freeze([
            Object.freeze({ name: "vol-0", mountPath: "/srv/runs" }),
          ]) as readonly { readonly name: string; readonly mountPath: string }[],
        }),
      ] as unknown as KubernetesJobManifest["pod"]["containers"],
      volumes: Object.freeze([
        Object.freeze({
          name: "vol-0",
          persistentVolumeClaim: Object.freeze({ claimName: "runs", readOnly: false as const }),
        }),
      ]) as KubernetesJobManifest["pod"]["volumes"],
    }),
  });
}

test("the in-cluster KubernetesApi performs the four seam verbs with the projected bearer token", async (t) => {
  const fake = await startKubeFake();
  const dir = mkdtempSync(join(tmpdir(), "ctl-kube-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "token"), "test-token-abc", "utf8");
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = new InClusterKubernetesApi({
    serviceAccountDir: dir,
    host: "127.0.0.1",
    port: String(fake.port),
    scheme: "http",
  });
  const manifest = sampleManifest("review", "prv-run-1");
  assert.equal(await api.createJob(manifest), "created");
  assert.equal(await api.createJob(manifest), "already-exists");
  assert.equal(fake.authHeaders[0], "Bearer test-token-abc");
  // The Job body carries the closed manifest shape.
  const body = JSON.parse(fake.bodies[0]!) as Record<string, unknown>;
  assert.equal(body.apiVersion, "batch/v1");
  assert.equal(body.kind, "Job");
  const spec = body.spec as Record<string, unknown>;
  assert.equal(spec.backoffLimit, 0);
  assert.equal(spec.activeDeadlineSeconds, 600);

  const running = await api.getJob("review", "prv-run-1");
  assert.notEqual(running, null);
  assert.equal(running!.active, true);
  assert.equal(await api.getJob("review", "prv-run-missing"), null);

  const listed = await api.listJobs("review", { "app.kubernetes.io/managed-by": "pr-reviewer-controller" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.name, "prv-run-1");
  assert.equal(listed[0]!.labels["app"], "worker");

  await api.deleteJob("review", "prv-run-1");
  assert.equal(await api.getJob("review", "prv-run-1"), null);
});

test("the in-cluster KubernetesApi bounds responses and refuses without projected material", async (t) => {
  const fake = await startKubeFake();
  const dir = mkdtempSync(join(tmpdir(), "ctl-kube2-"));
  writeFileSync(join(dir, "token"), "test-token-abc", "utf8");
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = new InClusterKubernetesApi({
    serviceAccountDir: dir,
    host: "127.0.0.1",
    port: String(fake.port),
    scheme: "http",
  });
  // The bounded response cap: a flood answer is refused, never buffered.
  await assert.rejects(
    () => api.getJob("review", "flood"),
    /exceeded the response-size bound/,
  );
  // No projected token: construction refuses (the startup refusal shape).
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.KUBERNETES_SERVICE_PORT;
  assert.throws(
    () => new InClusterKubernetesApi({ serviceAccountDir: join(tmpdir(), "no-such-sa-dir") }),
    /not running in a cluster|not readable/,
  );
});

// ── a successful minimal startup over the injected control plane ─────────

test("a minimal composition starts, serves the webhook intake, and stops gracefully", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-ok-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
  // #1723: the App installation identity is read for the webhook intake
  // too (it is the fallback for a delivery that omitted `installation.id`),
  // not only for the reconciliation poll.
  env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID = "4242";
  const port = await freePort();
  env.PR_REVIEWER_WEBHOOK_PORT = String(port);
  env.PR_REVIEWER_WEBHOOK_SECRET = WEBHOOK_SECRET;
  env.PR_REVIEWER_ADMIN_PORT = String(await freePort());
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";

  const fake = new FakeExecution();
  const publishes: Array<{ job: unknown; resultPayload: string }> = [];
  let handle: ControllerMainHandle | null = null;
  const controlPlane = new InMemoryControlPlaneStore();
  const running = controllerMain([], env, {
    controlPlane,
    executors: { local: () => fake },
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (_input) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
      publish: async (input) => {
        publishes.push({ job: input.job, resultPayload: input.resultPayload });
        return { publicationId: "github-comment:1" };
      },
    },
    followUpAdapter: followUpAdapter(),
    followUpBotLogin: async () => "reviewer-bot",
    followUpAnswer: async () => "an answer",
    createWorkspace: async (): Promise<WorkspaceHandle> => ({
      info: {
        rootPath: "/srv/workspace-fake",
        headSha: HEAD,
        mergeBaseSha: BASE,
        platform: "github",
        repoFullName: "owner/repo",
        createdAtMs: 1000,
      },
      close: async () => undefined,
    }),
    onReady: (ready) => {
      handle = ready;
    },
  });
  t.after(async () => {
    if (handle !== null) await handle.stop().catch(() => undefined);
    // Let the run settle (exit code resolved or rejected) before the
    // scratch directories disappear underneath it.
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handle !== null);
  assert.notEqual(handle, null);
  const started = handle!;

  // A REAL signed GitHub `pull_request`/synchronize delivery reaches the
  // daemon's intake through the composed operator host.
  const body = JSON.stringify({
    action: "synchronize",
    number: 7,
    pull_request: {
      number: 7,
      id: 4242,
      head: { sha: HEAD, repo: { full_name: "owner/repo" } },
      base: { sha: BASE, repo: { full_name: "owner/repo" } },
    },
    repository: { full_name: "owner/repo" },
    // A REAL App delivery carries the delivering installation (#1723).
    installation: { id: 4242 },
    sender: { login: "contributor" },
  });
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": computeGitHubWebhookSignature(WEBHOOK_SECRET, body),
    },
    body,
  });
  assert.equal(response.status, 202);

  await waitFor(() => fake.started.length === 1);
  assert.equal(fake.started.length, 1, "the intake scheduled exactly one generation");
  await waitFor(() => publishes.length > 0);
  assert.equal(publishes.length, 1, "the review published exactly once");
  assert.equal(
    (publishes[0]!.job as { readonly installationId?: string }).installationId,
    "4242",
    "the minted job carries the delivery's installation identity (#1723)",
  );

  // The graceful stop drains and closes the intake.
  const code = await started.stop();
  assert.equal(code, 0);
  assert.equal(started.daemon.stopped, true);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" }));
});

test("a kubernetes profile off-cluster refuses startup (fail closed)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-k8s-"));
  const configPath = join(dir, "instance.yaml");
  const configText = FORGEJO_INSTANCE_CONFIG.replace(
    "default-executor-profile: local-dev",
    `  - name: k8s
    kind: kubernetes
    kubernetes:
      image: registry.local/worker:1
      args: []
      namespace: review
      service-account: worker
      ttl-seconds-after-finished: 3600
      resources:
        requests: { cpu: "1", memory: 1Gi }
        limits: { cpu: "2", memory: 2Gi }
      volumes:
        - claim: runs
          controller-root: /srv/runs
default-executor-profile: k8s`,
  );
  writeFileSync(configPath, configText, "utf8");
  const env = baseEnv(configPath);
  env.FORGEJO_TOKEN = "forgejo-token";
  const port = await freePort();
  env.PR_REVIEWER_WEBHOOK_PORT = String(port);
  env.PR_REVIEWER_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete env.KUBERNETES_SERVICE_HOST;
  delete env.KUBERNETES_SERVICE_PORT;

  const stderr = captureStderr();
  stderr.attach();
  let handle: ControllerMainHandle | null = null;
  try {
    const code = await controllerMain([], env, {
      controlPlane: new InMemoryControlPlaneStore(),
      executors: { local: () => new FakeExecution() },
      forge: {
        mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
        currentHeadSha: async () => HEAD,
        readPrIdentity: async (_input) => ({ headSha: HEAD, prId: 4242, baseSha: BASE, fork: false }),
        publish: async () => ({ publicationId: "x" }),
      },
      onReady: (ready) => {
        handle = ready;
      },
    });
    assert.equal(code, 1);
    assert.equal(handle, null, "the controller never started");
    assert.match(stderr.lines().join(""), /not running in a cluster/);
  } finally {
    stderr.detach();
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  }
});

test("the kubernetes executor binding drives the real in-cluster API end to end", async (t) => {
  // The executor binding composes the real InClusterKubernetesApi the
  // daemon binds for kubernetes profiles — proven here against the local
  // fake, with the service-account material pointed at a temp dir.
  const fake = await startKubeFake();
  const dir = mkdtempSync(join(tmpdir(), "ctl-kube3-"));
  writeFileSync(join(dir, "token"), "test-token-abc", "utf8");
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = new InClusterKubernetesApi({
    serviceAccountDir: dir,
    host: "127.0.0.1",
    port: String(fake.port),
    scheme: "http",
  });
  // The four verbs are exactly the executor's seam; nothing else exists.
  assert.equal(typeof api.createJob, "function");
  assert.equal(typeof api.getJob, "function");
  assert.equal(typeof api.deleteJob, "function");
  assert.equal(typeof api.listJobs, "function");
  const listed = await api.listJobs("review", { "app.kubernetes.io/managed-by": "pr-reviewer-controller" });
  assert.deepEqual(listed, [] as readonly KubernetesJobSummary[]);
});

// ── the #735 → #734 credential projection path (#1435 review blocker) ───

function kubeSpecOf(controllerRoot: string): KubernetesExecutorSpec {
  return {
    image: "registry.local/pr-reviewer-worker:1",
    args: ["/usr/local/bin/worker"],
    namespace: "review-workers",
    serviceAccount: "pr-reviewer-worker",
    ttlSecondsAfterFinished: 3_600,
    resources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2Gi" },
    },
    volumes: [{ claim: "pr-reviewer-data", controllerRoot }],
  };
}

function credentialCompositionFixture(runId: string, runRoot: string, defaultEvidenceProfile?: string) {
  const instance = parseInstanceConfigText(GITHUB_INSTANCE_CONFIG, validateContract(V3_CONTRACT));
  const broker = createModelCredentialVault({
    instance,
    platform: "github",
    modelCredentialMaterial: new Map([
      ["model-cred", "sk-test-model-material"],
      ["forge-cred", "gh-test-forge-material"],
    ]),
  });
  const refusals: string[] = [];
  const binding = createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: defaultEvidenceProfile ?? instance.defaultEvidenceProfile!,
    broker,
    onRefusal: (message) => refusals.push(message),
  });
  const runDir = join(runRoot, runId);
  mkdirSync(runDir, { recursive: true });
  return { binding, refusals, runDir, instance };
}

test("a binding composes a valid plan with the EMPTY evidence profile name — 'no providers' rides the #735 seam (#1711)", async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "ctl-cred-noev-"));
  try {
    // #1711: the composition may run with no default evidence profile —
    // the plan seam documents "" as the no-evidence state, so the binding
    // must compose a VALID plan for it (and add no evidence credential).
    const { binding } = credentialCompositionFixture("run-no-evidence", runRoot, "");
    const refs = await binding.credentialRefs(
      { jobId: "job-1", repoFullName: "owner/repo", platform: "github", installationId: "42", fork: false },
      "run-no-evidence",
    );
    assert.equal(refs.some((ref) => ref.name === "evidence"), false);
    assert.deepEqual(refs.map((ref) => ref.name).sort(), ["forge-publish", "model"]);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("a credential-bearing Kubernetes run projects its Secret through the real store before the Job", async (t) => {
  const fake = await startKubeFake();
  const saDir = mkdtempSync(join(tmpdir(), "ctl-cred-sa-"));
  const runRoot = mkdtempSync(join(tmpdir(), "ctl-cred-run-"));
  writeFileSync(join(saDir, "token"), "test-token-abc", "utf8");
  const runId = "run-composition-1";
  const { binding, runDir } = credentialCompositionFixture(runId, runRoot);
  const refs = await binding.credentialRefs(
    { jobId: "job-1", repoFullName: "owner/repo", platform: "github", installationId: "42", fork: false },
    runId,
  );
  assert.deepEqual(refs.map((ref) => `${ref.name}=${ref.reference}`), [
    "forge-publish=forge-cred",
    "model=model-cred",
  ]);
  const request = validateExecutionRequest({
    jobId: "job-1",
    runId,
    attempt: 1,
    kind: "review",
    platform: "github",
    forgeApiUrl: "https://api.github.com",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    deadlineAtMs: Date.now() + 60_000,
    workspace: Object.freeze({
      rootPath: runRoot,
      headSha: HEAD,
      mergeBaseSha: BASE,
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    }),
    profiles: Object.freeze({ executor: "k8s", model: "fast", evidence: "default" }),
    modelSelection: Object.freeze({ baseUrl: "http://127.0.0.1:9/v1", modelId: "test-model", apiFormat: "openai" as const }),
    credentials: refs,
    runDir,
    requestPath: join(runDir, "request.json"),
    resultPath: join(runDir, "result.json"),
  });
  const apiOptions = {
    serviceAccountDir: saDir,
    host: "127.0.0.1",
    port: String(fake.port),
    scheme: "http" as const,
  };
  const store = new InClusterCredentialStore({ ...apiOptions, sweepIntervalMs: 0 });
  const executor = new KubernetesExecutor(kubeSpecOf(runRoot), {
    api: new InClusterKubernetesApi(apiOptions),
    pollMs: 5,
    credentialResolver: binding.resolver,
    credentialStore: store,
  });
  t.after(async () => {
    store.stopSweeper();
    await fake.close();
    rmSync(saDir, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const handle = await executor.start(request, controller.signal);

  const secretIndex = fake.requests.findIndex((entry) => entry.method === "POST" && entry.url.endsWith("/secrets"));
  const jobIndex = fake.requests.findIndex((entry) => entry.method === "POST" && entry.url.endsWith("/jobs"));
  // The blocker this test pins: the run reaches the cluster at all, and the
  // material exists BEFORE the worker that reads it.
  assert.ok(secretIndex >= 0, "the per-run credential Secret was never projected");
  assert.ok(jobIndex > secretIndex, "the worker Job was created before its credential Secret");
  assert.equal(fake.authHeaders[secretIndex], "Bearer test-token-abc");
  const secretBody = JSON.parse(fake.bodies[secretIndex] ?? "{}") as {
    apiVersion?: string;
    kind?: string;
    type?: string;
    metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
    data?: Record<string, string>;
  };
  const secretName = kubernetesCredentialSecretName(runId);
  assert.equal(secretBody.apiVersion, "v1");
  assert.equal(secretBody.kind, "Secret");
  assert.equal(secretBody.type, "Opaque");
  assert.equal(secretBody.metadata?.name, secretName);
  // Hashed correlation labels only: the identity rides as a hash prefix,
  // never as the raw run/job id.
  assert.equal(secretBody.metadata?.labels?.["app.kubernetes.io/managed-by"], "pr-reviewer-action");
  const runHash = createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 40);
  assert.equal(secretBody.metadata?.labels?.["pr-reviewer.io/run-hash"], runHash);
  assert.equal(secretName.startsWith("prv-cred-"), true);
  assert.equal(
    Buffer.from(secretBody.data?.["model"] ?? "", "base64").toString("utf8"),
    "sk-test-model-material",
  );
  assert.equal(
    Buffer.from(secretBody.data?.["forge-publish"] ?? "", "base64").toString("utf8"),
    "gh-test-forge-material",
  );
  // The Job's env projects exactly that Secret/key (#734 contract).
  const jobBody = JSON.parse(fake.bodies[jobIndex] ?? "{}") as {
    spec?: { template?: { spec?: { containers?: { env?: { name: string; valueFrom?: { secretKeyRef?: { name?: string; key?: string } } }[] }[] } } };
  };
  const env = jobBody.spec?.template?.spec?.containers?.[0]?.env ?? [];
  assert.deepEqual(
    env.filter((entry) => entry.name.startsWith("PR_REVIEWER_CREDENTIAL_"))
      .map((entry) => `${entry.name}=${entry.valueFrom?.secretKeyRef?.name}/${entry.valueFrom?.secretKeyRef?.key}`),
    [
      `PR_REVIEWER_CREDENTIAL_FORGE_PUBLISH=${secretName}/forge-publish`,
      `PR_REVIEWER_CREDENTIAL_MODEL=${secretName}/model`,
    ],
  );

  // Cancellation removes the worker AND its material.
  controller.abort();
  const result = await handle.collect();
  assert.equal(result.status, "cancelled");
  assert.equal(fake.secrets.has(secretName), false);
});

test("an unknown correlation identity never receives credential material", async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "ctl-cred-unknown-"));
  const { binding, refusals } = credentialCompositionFixture("run-known", runRoot);
  try {
    const unknown = await binding.resolver.resolve({ runId: "run-never-planned" } as ExecutionRequest);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "invalid_request");

    const refs = await binding.credentialRefs(
      { jobId: "job-2", repoFullName: "owner/repo", platform: "github", installationId: "42", fork: false },
      "run-known",
    );
    assert.equal(refs.length, 2);
    const first = await binding.resolver.resolve({ runId: "run-known" } as ExecutionRequest);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.deepEqual(first.credentials.map((entry) => entry.name), ["forge-publish", "model"]);
      assert.equal(first.credentials[1]?.value, "sk-test-model-material");
    }
    // A resolution is single-use: a second ask for the same run is the closed
    // refusal, never a replay of material.
    const second = await binding.resolver.resolve({ runId: "run-known" } as ExecutionRequest);
    assert.equal(second.ok, false);
    assert.equal(
      refusals.every((line) => !line.includes("sk-test-model-material")),
      true,
      "a refusal diagnostic carried credential material",
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

// ── #1484: the worker's forge-read credential (publish purpose) ─────────

/** A binding over the forgejo instance fixture (forge credential
 * `forge-cred`), with broker material for both purposes. */
function forgejoCompositionFixture() {
  const instance = parseInstanceConfigText(FORGEJO_INSTANCE_CONFIG, validateContract(V3_CONTRACT));
  const broker = createModelCredentialVault({
    instance,
    platform: "forgejo",
    modelCredentialMaterial: new Map([
      ["model-cred", "sk-test-model-material"],
      ["forge-cred", "fj-test-forge-material"],
    ]),
  });
  return createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
  });
}

test("a plan for a job whose platform matches a configured forge carries exactly the publish-purpose forge entry (#1484)", async () => {
  const binding = forgejoCompositionFixture();
  const refs = await binding.credentialRefs(
    { jobId: "job-fj", repoFullName: "owner/repo", platform: "forgejo", installationId: "7", fork: false },
    "run-fj-1",
  );
  // Exactly ONE forge-purpose entry (`forge-publish`; workspace acquisition
  // is controller-side, so no `forge-clone` ever rides), plus the model one.
  assert.deepEqual(refs.map((ref) => ref.name), ["forge-publish", "model"]);
  assert.deepEqual(
    refs.find((ref) => ref.name === "forge-publish"),
    { name: "forge-publish", reference: "forge-cred" },
  );
  // The late resolution succeeds against the broker: the vault serves the
  // publish-purpose material for the plan's platform, and the forge
  // material is the ONLY value handed to the worker besides the model key.
  const resolved = await binding.resolver.resolve({ runId: "run-fj-1" } as ExecutionRequest);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.deepEqual(resolved.credentials.map((entry) => entry.name), ["forge-publish", "model"]);
    assert.equal(resolved.credentials[0]?.value, "fj-test-forge-material");
  }
});

test("a plan for a job whose platform has no matching forge carries no forge entry (#1484)", async () => {
  const binding = forgejoCompositionFixture();
  // The instance serves forgejo only: a github-platform job has no serving
  // forge, so the plan carries the model entry alone (the pre-existing
  // fail-closed posture — the worker's forge reads would refuse at
  // authentication, never guess a credential).
  const refs = await binding.credentialRefs(
    { jobId: "job-gh", repoFullName: "owner/repo", platform: "github", installationId: "7", fork: false },
    "run-gh-1",
  );
  assert.deepEqual(refs.map((ref) => ref.name), ["model"]);
});

test("a FORK job's plan never carries the forge entry (#1484, fork trust boundary)", async () => {
  const binding = forgejoCompositionFixture();
  // docs/fork-review.md: the instance-wide forge credential never crosses
  // the fork trust boundary, even though a serving forge exists — the
  // fork worker's forge reads fail closed at authentication, the exact
  // pre-#1484 posture for forks.
  const refs = await binding.credentialRefs(
    { jobId: "job-fork", repoFullName: "owner/repo", platform: "forgejo", installationId: "7", fork: true },
    "run-fork-1",
  );
  assert.deepEqual(refs.map((ref) => ref.name), ["model"]);
});

test("a plan for an ambiguous platform (several same-kind forges) refuses instead of guessing (#1484)", async () => {
  const ambiguous = `${MIN_INSTANCE_CONFIG}
forges:
 - name: forgejo-a
   kind: forgejo
   endpoint: http://127.0.0.1:9
   credential: forge-cred-a
 - name: forgejo-b
   kind: forgejo
   endpoint: http://127.0.0.2:9
   credential: forge-cred-b
`;
  const instance = parseInstanceConfigText(ambiguous, validateContract(V3_CONTRACT));
  const broker = createModelCredentialVault({
    instance,
    platform: "forgejo",
    modelCredentialMaterial: new Map([["model-cred", "sk-test-model-material"]]),
  });
  const binding = createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
  });
  await assert.rejects(
    binding.credentialRefs(
      { jobId: "job-amb", repoFullName: "owner/repo", platform: "forgejo", installationId: "7", fork: false },
      "run-amb-1",
    ),
    RangeError,
  );
});

test("a job naming its forge integration resolves THAT integration's credential, never a same-kind guess (#1484)", async () => {
  const ambiguous = `${MIN_INSTANCE_CONFIG}
forges:
 - name: forgejo-a
   kind: forgejo
   endpoint: http://127.0.0.1:9
   credential: forge-cred-a
 - name: forgejo-b
   kind: forgejo
   endpoint: http://127.0.0.2:9
   credential: forge-cred-b
`;
  const instance = parseInstanceConfigText(ambiguous, validateContract(V3_CONTRACT));
  const broker = createModelCredentialVault({
    instance,
    platform: "forgejo",
    modelCredentialMaterial: new Map([
      ["model-cred", "sk-test-model-material"],
      ["forge-cred-b", "fj-test-forge-b-material"],
    ]),
  });
  const binding = createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
  });
  // The same-kind set is ambiguous, but the job names its integration, so
  // the plan resolves by NAME — the same resolution the envelope's
  // endpoint uses (daemon.ts resolveForgeApiUrl).
  const refs = await binding.credentialRefs(
    {
      jobId: "job-named",
      repoFullName: "owner/repo",
      platform: "forgejo",
      installationId: "7",
      fork: false,
      forgeIntegration: "forgejo-b",
    },
    "run-named-1",
  );
  assert.deepEqual(
    refs.find((ref) => ref.name === "forge-publish"),
    { name: "forge-publish", reference: "forge-cred-b" },
  );
});

test("a job naming an unresolvable forge integration refuses at plan build (#1484)", async () => {
  const binding = forgejoCompositionFixture();
  await assert.rejects(
    binding.credentialRefs(
      {
        jobId: "job-named-missing",
        repoFullName: "owner/repo",
        platform: "forgejo",
        installationId: "7",
        fork: false,
        forgeIntegration: "no-such-forge",
      },
      "run-named-missing-1",
    ),
    RangeError,
  );
});

test("a job naming a forge integration of ANOTHER kind refuses at plan build (#1484)", async () => {
  // The instance serves forgejo; the job names the github integration.
  // The daemon's own endpoint resolution refuses that identity, so the
  // publish-purpose credential must not be selected from it either.
  const config = `${MIN_INSTANCE_CONFIG}
forges:
  - name: forgejo-a
    kind: forgejo
    endpoint: http://127.0.0.1:9
    credential: forge-cred-forgejo
  - name: github-a
    kind: github
    endpoint: https://api.github.com
    credential: forge-cred-github
`;
  const instance = parseInstanceConfigText(config, validateContract(V3_CONTRACT));
  const broker = createModelCredentialVault({
    instance,
    platform: "forgejo",
    modelCredentialMaterial: new Map([
      ["model-cred", "sk-test-model-material"],
      ["forge-cred-forgejo", "fj-test-forge-material"],
      ["forge-cred-github", "gh-test-forge-material"],
    ]),
  });
  const binding = createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
  });
  await assert.rejects(
    binding.credentialRefs(
      {
        jobId: "job-named-other-kind",
        repoFullName: "owner/repo",
        platform: "forgejo",
        installationId: "7",
        fork: false,
        forgeIntegration: "github-a",
      },
      "run-named-other-kind-1",
    ),
    RangeError,
  );
});

// ── #1624: the per-job GitHub installation-token mint serves forge-publish ──

/** A github binding (forge credential `forge-cred`) over the minting broker:
 * the vault holds the model material and — when `vaultForgeMaterial` is
 * given — the env-defined static forge material. `mintCalls` records every
 * (installation id, repository) pair the mint is asked for. */
function githubMintBindingFixture(options: {
  readonly vaultForgeMaterial?: string;
  readonly mint: (
    installationId: string,
    repoFullName: string,
  ) => Promise<{ readonly value: string; readonly expiresAtMs: number }>;
  readonly mintCalls: string[];
}) {
  const instance = parseInstanceConfigText(GITHUB_INSTANCE_CONFIG, validateContract(V3_CONTRACT));
  const material = new Map<string, string>([["model-cred", "sk-test-model-material"]]);
  if (options.vaultForgeMaterial !== undefined) {
    material.set("forge-cred", options.vaultForgeMaterial);
  }
  const broker = createGitHubPublishMintingBroker(
    createModelCredentialVault({
      instance,
      platform: "github",
      modelCredentialMaterial: material,
    }),
    async (installationId, repoFullName) => {
      options.mintCalls.push(`${installationId}/${repoFullName}`);
      return options.mint(installationId, repoFullName);
    },
    instance.forges.map((entry) => entry.credential),
  );
  return createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
  });
}

const GITHUB_PLAN_JOB = {
  jobId: "job-gh",
  repoFullName: "owner/repo",
  platform: "github" as const,
  installationId: "4242",
  fork: false,
};

test("an App-based GitHub run's forge-publish entry resolves from the per-job installation-token mint (#1624)", async () => {
  const mintCalls: string[] = [];
  const binding = githubMintBindingFixture({
    mintCalls,
    mint: async () => ({
      value: "ghs_minted_installation_token_material",
      expiresAtMs: 1_800_000_000_000,
    }),
  });
  // The plan still carries only the opaque reference (#735): the mint is
  // material, and material never rides the durable request.
  const refs = await binding.credentialRefs(GITHUB_PLAN_JOB, "run-gh-mint-1");
  assert.deepEqual(refs, [
    { name: "forge-publish", reference: "forge-cred" },
    { name: "model", reference: "model-cred" },
  ]);
  // LATE: planning minted nothing.
  assert.deepEqual(mintCalls, []);
  const resolved = await binding.resolver.resolve({ runId: "run-gh-mint-1" } as ExecutionRequest);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.deepEqual(resolved.credentials.map((entry) => entry.name), ["forge-publish", "model"]);
    assert.equal(resolved.credentials[0]?.value, "ghs_minted_installation_token_material");
  }
  // The mint runs at resolution (once), for THIS run's installation, and
  // its grant is SCOPED to THIS run's repository.
  assert.deepEqual(mintCalls, ["4242/owner/repo"]);
});

test("env-defined static forge material keeps priority; the mint is not reached (#1624)", async () => {
  const mintCalls: string[] = [];
  const binding = githubMintBindingFixture({
    vaultForgeMaterial: "ghp_static_operator_token",
    mintCalls,
    mint: async () => ({ value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 }),
  });
  await binding.credentialRefs(GITHUB_PLAN_JOB, "run-gh-static-1");
  const resolved = await binding.resolver.resolve({ runId: "run-gh-static-1" } as ExecutionRequest);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.credentials[0]?.value, "ghp_static_operator_token");
  }
  assert.deepEqual(mintCalls, []);
});

test("a FORK run never reaches the installation-token mint (#1624, fork trust boundary)", async () => {
  const mintCalls: string[] = [];
  const binding = githubMintBindingFixture({
    mintCalls,
    mint: async () => ({ value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 }),
  });
  const refs = await binding.credentialRefs(
    { ...GITHUB_PLAN_JOB, jobId: "job-fork-gh", fork: true },
    "run-gh-fork-1",
  );
  // No forge entry structurally (pre-existing posture), so the mint is
  // never asked and the instance's serving identity never crosses the fork
  // trust boundary.
  assert.deepEqual(refs.map((ref) => ref.name), ["model"]);
  const resolved = await binding.resolver.resolve({ runId: "run-gh-fork-1" } as ExecutionRequest);
  assert.equal(resolved.ok, true);
  assert.deepEqual(mintCalls, []);
});

test("a failing mint refuses the WHOLE credential set with a fixed reason that echoes nothing (#1624)", async () => {
  const mintCalls: string[] = [];
  const refusals: string[] = [];
  const instance = parseInstanceConfigText(GITHUB_INSTANCE_CONFIG, validateContract(V3_CONTRACT));
  const broker = createGitHubPublishMintingBroker(
    createModelCredentialVault({
      instance,
      platform: "github",
      modelCredentialMaterial: new Map([["model-cred", "sk-test-model-material"]]),
    }),
    async (installationId, repoFullName) => {
      mintCalls.push(`${installationId}/${repoFullName}`);
      throw new Error("GitHub App authentication failed: private-token-leak at https://example.invalid");
    },
    instance.forges.map((entry) => entry.credential),
  );
  const binding = createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
    onRefusal: (message) => refusals.push(message),
  });
  await binding.credentialRefs(GITHUB_PLAN_JOB, "run-gh-mintfail-1");
  const resolved = await binding.resolver.resolve({ runId: "run-gh-mintfail-1" } as ExecutionRequest);
  // Fail closed, all-or-nothing: the run gets NOTHING — not even the
  // model credential — and never degrades to an unauthenticated worker.
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.code, "unknown_reference");
    assert.match(resolved.reason, /installation-token mint failed/);
    assert.ok(!resolved.reason.includes("private-token-leak"), resolved.reason);
    assert.ok(!resolved.reason.includes("example.invalid"), resolved.reason);
  }
  // The mint was attempted exactly once for this run's installation,
  // scoped to its repository.
  assert.deepEqual(mintCalls, ["4242/owner/repo"]);
  // The refusal diagnostic carries only the closed code and the entry name.
  assert.equal(refusals.length, 1);
  assert.ok(!refusals[0]?.includes("private-token-leak"), refusals[0] ?? "");
});

test("the minting broker serves exactly github publish-purpose material for declared references (#1624)", async () => {
  const mintCalls: string[] = [];
  const mint = async (installationId: string, repoFullName: string) => {
    mintCalls.push(`${installationId}/${repoFullName}`);
    return { value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 };
  };
  const base = {
    async resolve() {
      return { ok: false as const, code: "unknown_reference" as const, reason: "not held" };
    },
    revoke() {
      return false;
    },
    describe() {
      return ["model-cred"];
    },
  };
  const broker = createGitHubPublishMintingBroker(base, mint, ["forge-cred"]);
  // The minted material keeps the mint's own expiry (the #735 contract is
  // epoch-ms; an installation token is short-lived and never "no expiry").
  const served = await broker.resolve("forge-cred", {
    purpose: "forge_publish",
    platform: "github",
    installationId: "4242",
    repoFullName: "owner/repo",
    profileName: "",
  });
  assert.equal(served.ok, true);
  if (served.ok) {
    assert.equal(served.material.value, "ghs_minted_installation_token_material");
    assert.equal(served.material.expiresAtMs, 1_800_000_000_000);
  }
  // Every other shape keeps the base refusal, mint untouched.
  assert.deepEqual(mintCalls, ["4242/owner/repo"]);
  for (const request of [
    { purpose: "model" as const, platform: "github" as const, installationId: "4242", repoFullName: "owner/repo" },
    { purpose: "forge_publish" as const, platform: "forgejo" as const, installationId: "4242", repoFullName: "owner/repo" },
    { purpose: "forge_publish" as const, platform: "github" as const, installationId: "", repoFullName: "owner/repo" },
    { purpose: "forge_publish" as const, platform: "github" as const, installationId: "4242", repoFullName: "" },
  ]) {
    const refused = await broker.resolve("forge-cred", {
      ...request,
      profileName: "",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "unknown_reference");
  }
  // A reference the instance config never declared is never minted: the
  // mint serves the operator's declared forge credentials and nothing else.
  const undeclared = await broker.resolve("other-cred", {
    purpose: "forge_publish",
    platform: "github",
    installationId: "4242",
    repoFullName: "owner/repo",
    profileName: "",
  });
  assert.equal(undeclared.ok, false);
  assert.deepEqual(mintCalls, ["4242/owner/repo"]);
});

test("a vault refusal that is NOT missing material passes through, never minted over (#1624)", async () => {
  for (const code of ["expired", "revoked", "invalid_request"] as const) {
    const mintCalls: string[] = [];
    const base = {
      async resolve() {
        return { ok: false as const, code, reason: `held but refused: ${code}` };
      },
      revoke() {
        return false;
      },
      describe() {
        return [];
      },
    };
    const broker = createGitHubPublishMintingBroker(
      base,
      async (installationId, repoFullName) => {
        mintCalls.push(`${installationId}/${repoFullName}`);
        return { value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 };
      },
      ["forge-cred"],
    );
    const refused = await broker.resolve("forge-cred", {
      purpose: "forge_publish",
      platform: "github",
      installationId: "4242",
      repoFullName: "owner/repo",
      profileName: "",
    });
    // An entry the broker HOLDS and refuses for a reason that does NOT
    // prove the absence of forge material (expired, revoked, malformed
    // request) is never papered over with a fresh mint: the closed code
    // passes through and the mint is not reached.
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, code);
    assert.deepEqual(mintCalls, []);
  }
});

test("a reference shared between a model profile and the forge still mints forge-publish (#1624 review)", async () => {
  // The shared shape: one reference serves the model profile AND the forge
  // integration, so the vault holds it as a MODEL entry and the vault-level
  // forge entry is never seeded. The forge-publish resolution therefore
  // refuses `scope_mismatch`, which proves the vault holds no forge
  // material — the mint is the forge identity for that run.
  const instance = parseInstanceConfigText(
    `${MIN_INSTANCE_CONFIG}
forges:
  - name: primary
    kind: github
    endpoint: https://api.github.com
    credential: model-cred
`,
    validateContract(V3_CONTRACT),
  );
  const mintCalls: string[] = [];
  const broker = createGitHubPublishMintingBroker(
    createModelCredentialVault({
      instance,
      platform: "github",
      modelCredentialMaterial: new Map([["model-cred", "sk-test-model-material"]]),
    }),
    async (installationId, repoFullName) => {
      mintCalls.push(`${installationId}/${repoFullName}`);
      return { value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 };
    },
    instance.forges.map((entry) => entry.credential),
  );
  const binding = createWorkerCredentialBinding({
    instance,
    defaultModelProfile: instance.defaultModelProfile,
    defaultEvidenceProfile: instance.defaultEvidenceProfile!,
    broker,
  });
  await binding.credentialRefs(GITHUB_PLAN_JOB, "run-gh-shared-1");
  const resolved = await binding.resolver.resolve({ runId: "run-gh-shared-1" } as ExecutionRequest);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    // The model entry keeps the vault's env material; the forge-publish
    // entry is served by the per-job mint, scoped to this run.
    assert.deepEqual(
      resolved.credentials.map((entry) => [entry.name, entry.value]),
      [
        ["forge-publish", "ghs_minted_installation_token_material"],
        ["model", "sk-test-model-material"],
      ],
    );
  }
  assert.deepEqual(mintCalls, ["4242/owner/repo"]);
  // Revoking the shared reference revokes the vault entry: `revoked` (not
  // `scope_mismatch`) then passes through — a revoked credential is never
  // papered over with a fresh mint, and the model entry fails too.
  assert.equal(broker.revoke("model-cred"), true);
  await binding.credentialRefs(GITHUB_PLAN_JOB, "run-gh-shared-2");
  const afterRevoke = await binding.resolver.resolve({ runId: "run-gh-shared-2" } as ExecutionRequest);
  assert.equal(afterRevoke.ok, false);
  if (!afterRevoke.ok) assert.equal(afterRevoke.code, "revoked");
  assert.deepEqual(mintCalls, ["4242/owner/repo"]);
});

test("a scope refusal on an undeclared reference or non-mintable request passes through (#1624 review)", async () => {
  const mintCalls: string[] = [];
  const base = {
    async resolve() {
      return { ok: false as const, code: "scope_mismatch" as const, reason: "credential is bound to a different purpose" };
    },
    revoke() {
      return false;
    },
    describe() {
      return [];
    },
  };
  const broker = createGitHubPublishMintingBroker(
    base,
    async (installationId, repoFullName) => {
      mintCalls.push(`${installationId}/${repoFullName}`);
      return { value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 };
    },
    ["forge-cred"],
  );
  for (const request of [
    { name: "undeclared", reference: "other-cred", purpose: "forge_publish" as const, platform: "github" as const, installationId: "4242", repoFullName: "owner/repo" },
    { name: "model purpose", reference: "forge-cred", purpose: "model" as const, platform: "github" as const, installationId: "4242", repoFullName: "owner/repo" },
    { name: "forgejo platform", reference: "forge-cred", purpose: "forge_publish" as const, platform: "forgejo" as const, installationId: "4242", repoFullName: "owner/repo" },
  ]) {
    const { name, reference, ...resolution } = request;
    const refused = await broker.resolve(reference, { ...resolution, profileName: "" });
    // The closed scope refusal rides out untouched: the mint serves only
    // declared GitHub forge references under the forge-publish purpose.
    assert.equal(refused.ok, false, name);
    if (!refused.ok) assert.equal(refused.code, "scope_mismatch");
  }
  assert.deepEqual(mintCalls, []);
});

test("a mint that yields no usable material fails closed (#1624)", async () => {
  const base = {
    async resolve() {
      return { ok: false as const, code: "unknown_reference" as const, reason: "not held" };
    },
    revoke() {
      return false;
    },
    describe() {
      return [];
    },
  };
  for (const broken of [
    { value: "", expiresAtMs: 1_800_000_000_000 },
    { value: "ghs_minted_installation_token_material", expiresAtMs: Number.NaN },
    // The vault's own material discipline applies to mint output too:
    // line-bearing values and nonsensical expiries never cross the handoff.
    { value: "ghs_minted\ninstallation_token_material", expiresAtMs: 1_800_000_000_000 },
    { value: "ghs_minted_installation_token_material", expiresAtMs: -1 },
    { value: "ghs_minted_installation_token_material", expiresAtMs: Number.POSITIVE_INFINITY },
  ]) {
    const broker = createGitHubPublishMintingBroker(base, async () => broken, ["forge-cred"]);
    const refused = await broker.resolve("forge-cred", {
      purpose: "forge_publish",
      platform: "github",
      installationId: "4242",
      repoFullName: "owner/repo",
      profileName: "",
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "unknown_reference");
  }
});

test("a mint failure diagnoses controller-side, never in the refusal (#1624 review)", async () => {
  const base = {
    async resolve() {
      return { ok: false as const, code: "unknown_reference" as const, reason: "not held" };
    },
    revoke() {
      return false;
    },
    describe() {
      return [];
    },
  };
  const mintRequest = {
    purpose: "forge_publish" as const,
    platform: "github" as const,
    installationId: "4242",
    repoFullName: "owner/repo",
    profileName: "",
  };
  const details: string[] = [];
  // A plan with no mint identity: the mint is never reached, and this
  // mint-path refusal is diagnosed controller-side with its own fixed
  // string (the executor keeps only the `unknown_reference` code).
  const noIdentity = createGitHubPublishMintingBroker(
    base,
    async () => {
      throw new Error("must not be reached");
    },
    ["forge-cred"],
    (detail) => {
      details.push(detail);
    },
  );
  const identityRefused = await noIdentity.resolve("forge-cred", {
    ...mintRequest,
    installationId: "",
  });
  assert.equal(identityRefused.ok, false);
  assert.equal(
    details[0],
    "the per-job GitHub installation-token mint cannot run: the plan carries no installation or repository identity to scope the mint to",
  );
  // A transient App-side throw: the daemon's diagnostic names the mint's
  // diagnosis (so `unknown_reference` is not misread as missing config),
  // while the refusal toward the executor stays the FIXED reason.
  const thrown = createGitHubPublishMintingBroker(
    base,
    async () => {
      throw new Error("GitHub App authentication failed:\ninstallation rate limited by api.github.com");
    },
    ["forge-cred"],
    (detail) => {
      details.push(detail);
    },
  );
  const refused = await thrown.resolve("forge-cred", mintRequest);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "unknown_reference");
    assert.equal(refused.reason, "the per-job GitHub installation-token mint failed");
  }
  assert.equal(details.length, 2);
  assert.ok(
    details[1]?.includes("the per-job GitHub installation-token mint failed: GitHub App authentication failed: installation rate limited"),
    details[1] ?? "",
  );
  // Mint output is not taken at its word for the single-line discipline:
  // the newline-bearing throw is one diagnostic line, never two.
  assert.ok(!details[1]?.includes("\n"), details[1] ?? "");
  // An oversized mint message stays bounded.
  const oversized = createGitHubPublishMintingBroker(
    base,
    async () => {
      throw new Error(`x${"y".repeat(500)}`);
    },
    ["forge-cred"],
    (detail) => {
      details.push(detail);
    },
  );
  await oversized.resolve("forge-cred", mintRequest);
  assert.equal(details.length, 3);
  // The 51-char prefix plus the 200-char bounded detail, nothing looser.
  assert.ok((details[2] ?? "").length <= 251, String((details[2] ?? "").length));
  // Unusable mint output gets the fixed controller-side diagnostic too.
  const unusable = createGitHubPublishMintingBroker(
    base,
    async () => ({ value: "", expiresAtMs: 1_800_000_000_000 }),
    ["forge-cred"],
    (detail) => {
      details.push(detail);
    },
  );
  await unusable.resolve("forge-cred", mintRequest);
  assert.equal(details[3], "the per-job GitHub installation-token mint returned no usable material");
  // A served mint reports nothing.
  const served = createGitHubPublishMintingBroker(
    base,
    async () => ({ value: "ghs_minted_installation_token_material", expiresAtMs: 1_800_000_000_000 }),
    ["forge-cred"],
    (detail) => {
      details.push(detail);
    },
  );
  const ok = await served.resolve("forge-cred", mintRequest);
  assert.equal(ok.ok, true);
  assert.equal(details.length, 4);
});

test("the composed GitHub mint is repository-scoped and speaks epoch-ms expiry (#1624)", async () => {
  // Pins the two conversion rules the fake-mint binding tests cannot see:
  // GitHub's `expires_at` (epoch SECONDS on the wire) becomes the #735
  // SecretMaterial `expiresAtMs`, and the mint request carries the run's
  // repository scope — never the installation's full grant.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  const bodies: string[] = [];
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    urls.push(String(input));
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(
      JSON.stringify({
        token: "ghs_scoped_installation_token",
        expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
      }),
      { status: 201 },
    );
  };
  const composed = composeForgeCapability({
    platform: "github",
    endpoint: "https://api.github.com",
    workspaceCacheRoot: "/tmp/ctl-mint-test-cache",
    githubAppId: "123456",
    githubAppPrivateKeyPem: privateKeyPem,
    fetchImpl,
  });
  assert.equal(composed.mintInstallationToken !== undefined, true);
  const minted = await composed.mintInstallationToken!("4242", "owner/repo");
  assert.equal(minted.value, "ghs_scoped_installation_token");
  assert.equal(minted.expiresAtMs, expiresAtSeconds * 1000);
  // The wire mint targets the installation-token endpoint with the
  // repository-scope body (GitHub's scoped mint contract takes repo names).
  assert.equal(urls.length, 1);
  assert.match(urls[0] ?? "", /\/app\/installations\/4242\/access_tokens$/);
  const scope = JSON.parse(bodies[0] ?? "{}") as { repositories?: unknown };
  assert.deepEqual(scope.repositories, ["repo"]);
});

// ── #1624: the reconcile composition binds the App poll's installation id ──

test("the reconcile composition mints the poll job with the App installation id (#1624)", async (t) => {
  // The re-review blocker: controllerMain's reconcile composition called
  // reconcileRepositories WITHOUT the startup's poll installation id, so the
  // canonical poll event minted jobs carrying installationId "" — and the
  // #1624 minting broker refuses a forge-publish request whose installation
  // identity is empty, withholding the WHOLE worker credential set on the
  // exact GitHub self-hosted path this PR unlocks. The REAL composition runs
  // here (an injected forge fake never builds the mint-backed broker): the
  // lister authenticates as the configured App installation over a scripted
  // transport, and the durable queue snapshot's job payload — the record the
  // late forge-publish mint reads its installation identity from — must
  // carry the EXACT env id. No env-defined GitHub forge material exists in
  // this boot: the App mint is the composition's only forge credential
  // source. The job→plan→mint chain itself is pinned by the binding tests
  // above (the plan embeds the job's installation id; the mint receives it).
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(tmpdir(), "ctl-gh-reconcile-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = privateKeyPem;
  env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID = "4242";
  env.PR_REVIEWER_RECONCILE_INTERVAL_MS = "100";
  env.PR_REVIEWER_RECONCILE_REPOS = "owner/name";

  const mintInstallations: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint !== null) {
      mintInstallations.push(mint[1]!);
      return new Response(
        JSON.stringify({
          token: "ghs_poll_installation_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    if (url.pathname === "/repos/owner/name/pulls") {
      return new Response(
        JSON.stringify([
          {
            number: 7,
            state: "open",
            draft: false,
            head: { sha: HEAD },
            base: { sha: BASE, repo: { full_name: "owner/name" } },
          },
        ]),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };

  const handleBox: { handle: ControllerMainHandle | null } = { handle: null };
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    fetchImpl,
    onReady: (ready) => {
      handleBox.handle = ready;
    },
  });
  t.after(async () => {
    if (handleBox.handle !== null) await handleBox.handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handleBox.handle !== null);

  // The poll authenticates AS the configured installation: the lister's own
  // App mint carries the exact env id in the mint URL.
  await waitFor(() => mintInstallations.includes("4242"));

  // The enqueued job's payload — read from the durable queue snapshot the
  // way a restart would — carries the same installation identity. Before the
  // composition wiring this job minted with installationId "".
  interface SnapshotJob {
    readonly platform?: string;
    readonly repoFullName?: string;
    readonly prNumber?: number;
    readonly headSha?: string;
    readonly installationId?: string;
  }
  let reconciled: SnapshotJob | null = null;
  await waitFor(() => {
    try {
      const snapshot = JSON.parse(
        readFileSync(join(env.PR_REVIEWER_DURABLE_STATE_DIR!, "queue-snapshot.json"), "utf8"),
      ) as { records?: ReadonlyArray<{ job?: SnapshotJob }> };
      reconciled =
        snapshot.records?.find(
          (record) => record.job?.platform === "github" && record.job?.repoFullName === "owner/name",
        )?.job ?? null;
    } catch {
      return false;
    }
    return reconciled !== null;
  });
  assert.equal(reconciled!.installationId, "4242");
  assert.equal(reconciled!.prNumber, 7);
  assert.equal(reconciled!.headSha, HEAD);

  // Credential-free App deployment: no env-defined forge material anywhere —
  // the mint-backed broker is the composition's only forge credential source.
  assert.equal(env.PR_REVIEWER_CREDENTIAL_FORGE_CRED, undefined);
  assert.equal(env.PR_REVIEWER_CREDENTIAL_GITHUB, undefined);
});

// ── #1718: the reconcile schedule binds the canonical poll composition ────

interface ReconcileSnapshotJob {
  readonly platform?: string;
  readonly repoFullName?: string;
  readonly prNumber?: number;
  readonly headSha?: string;
  readonly adoptionEpoch?: string;
}

/** Read the durable queue snapshot the way a restart would and pick out the
 * poll-minted job for `owner/name`. */
function readReconciledJob(
  durableStateDir: string,
): ReconcileSnapshotJob | null {
  try {
    const snapshot = JSON.parse(
      readFileSync(join(durableStateDir, "queue-snapshot.json"), "utf8"),
    ) as { records?: ReadonlyArray<{ job?: ReconcileSnapshotJob }> };
    return (
      snapshot.records?.find(
        (record) => record.job?.platform === "github" && record.job?.repoFullName === "owner/name",
      )?.job ?? null
    );
  } catch {
    return null;
  }
}

test("a poll-only intake mints the job with the intake's per-repository identity (#1718)", async (t) => {
  // The bug: controllerMain bound the schedule through an operator `run`
  // that called reconcileRepositories WITHOUT the daemon's per-event
  // resolveBuildOptions, so buildReviewJob minted from `{}` — an EMPTY
  // adoption identity, a DIFFERENT generation id than the daemon's own
  // webhook intake mints for the same head, and a poll that scheduled
  // nothing that ever converged. No webhook delivery runs in this boot: the
  // poll alone must produce a queue record carrying the intake-resolved
  // identity. `adoptionEpoch` is the field that proves it: the fixture's
  // adoption policy (`all_allowed` / `discovered-default: adopt`) resolves a
  // repository with no adoption record to the intake's FIRST_ADOPTION_EPOCH
  // ("1") through createAdoptionIdentityResolver (src/controller/daemon.ts),
  // while the old `{}` build options minted `adoptionEpoch: ""`.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(tmpdir(), "ctl-poll-identity-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = privateKeyPem;
  env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID = "4242";
  env.PR_REVIEWER_RECONCILE_INTERVAL_MS = "100";
  env.PR_REVIEWER_RECONCILE_REPOS = "owner/name";

  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return new Response(
        JSON.stringify({
          token: "ghs_poll_installation_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    if (url.pathname === "/repos/owner/name/pulls") {
      return new Response(
        JSON.stringify([
          {
            number: 7,
            state: "open",
            draft: false,
            head: { sha: HEAD },
            base: { sha: BASE, repo: { full_name: "owner/name" } },
          },
        ]),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };

  const handleBox: { handle: ControllerMainHandle | null } = { handle: null };
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    fetchImpl,
    onReady: (ready) => {
      handleBox.handle = ready;
    },
  });
  t.after(async () => {
    if (handleBox.handle !== null) await handleBox.handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handleBox.handle !== null);

  let pollJob: ReconcileSnapshotJob | null = null;
  await waitFor(() => {
    pollJob = readReconciledJob(env.PR_REVIEWER_DURABLE_STATE_DIR!);
    return pollJob !== null;
  });
  // The intake's per-repository identity is IN the minted job: the poll-only
  // intake now converges with what the webhook would have minted (#1718).
  assert.equal(pollJob!.adoptionEpoch, "1");
  assert.equal(pollJob!.prNumber, 7);
  assert.equal(pollJob!.headSha, HEAD);
});

test("a failing reconcile pass surfaces on the controller stderr (#1718)", async (t) => {
  // The report used to be discarded (`void run(...)`), so a lister failing
  // every tick looked EXACTLY like a quiet forge. The composed poll's
  // onReport must put the failing repository on the controller's diagnostics.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(tmpdir(), "ctl-poll-fail-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = privateKeyPem;
  env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID = "4242";
  env.PR_REVIEWER_RECONCILE_INTERVAL_MS = "100";
  env.PR_REVIEWER_RECONCILE_REPOS = "owner/name";

  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return new Response(
        JSON.stringify({
          token: "ghs_poll_installation_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    if (url.pathname === "/repos/owner/name/pulls") {
      // The broken forge: the pass records the repository as failed.
      return new Response("boom", { status: 500 });
    }
    return new Response("{}", { status: 404 });
  };

  const handleBox: { handle: ControllerMainHandle | null } = { handle: null };
  const stderr = captureStderr();
  stderr.attach();
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    fetchImpl,
    onReady: (ready) => {
      handleBox.handle = ready;
    },
  });
  try {
    t.after(async () => {
      if (handleBox.handle !== null) await handleBox.handle.stop().catch(() => undefined);
      await running.catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      cleanupDirs(env);
    });
    await waitFor(() => handleBox.handle !== null);

    const passLines = () =>
      stderr.lines().filter((line) => line.includes("reconcile pass:"));
    await waitFor(() => passLines().length > 0);
    const line = passLines()[0]!;
    assert.ok(line.includes("owner/name"), line);
    // ONE bounded line derived only from the report's counters.
    assert.ok(line.includes("failed=owner/name"), line);
    assert.ok(line.includes("scheduled=0"), line);
    // One line only (the trailing newline the diagnostic helper appends is
    // the sole line break).
    assert.ok(!line.replace(/\n$/, "").includes("\n"), line);
  } finally {
    stderr.detach();
  }
});

test("a quiet reconcile pass stays silent on the controller stderr (#1718)", async (t) => {
  // The companion half of #1718's acceptance: surfacing the report must not
  // turn a healthy, empty forge into log spam on a 15-minute timer. Two
  // completed passes (the second list request proves the FIRST pass and its
  // onReport fully settled) must still produce no `reconcile pass:` line.
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(tmpdir(), "ctl-poll-quiet-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = privateKeyPem;
  env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID = "4242";
  env.PR_REVIEWER_RECONCILE_INTERVAL_MS = "100";
  env.PR_REVIEWER_RECONCILE_REPOS = "owner/name";

  let listed = 0;
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      return new Response(
        JSON.stringify({
          token: "ghs_poll_installation_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201 },
      );
    }
    if (url.pathname === "/repos/owner/name/pulls") {
      listed += 1;
      // The quiet forge: every repository listed, nothing discovered.
      return new Response("[]", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };

  const handleBox: { handle: ControllerMainHandle | null } = { handle: null };
  const stderr = captureStderr();
  stderr.attach();
  const running = controllerMain([], env, {
    controlPlane: new InMemoryControlPlaneStore(),
    executors: { local: () => new FakeExecution() },
    fetchImpl,
    onReady: (ready) => {
      handleBox.handle = ready;
    },
  });
  try {
    t.after(async () => {
      if (handleBox.handle !== null) await handleBox.handle.stop().catch(() => undefined);
      await running.catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      cleanupDirs(env);
    });
    await waitFor(() => handleBox.handle !== null);
    await waitFor(() => listed >= 2);
    assert.equal(
      stderr.lines().filter((line) => line.includes("reconcile pass:")).length,
      0,
      stderr.lines().join(""),
    );
  } finally {
    stderr.detach();
  }
});

test("the reconciliation report renderer carries each refusal's reason (#1718)", () => {
  // The boot-level tests prove the summary line reaches stderr; they cannot
  // provoke a refusal on an UNBOUND daemon (the handoff's identity guard is
  // inert without a bound integration), so the refusal lines the operator
  // actually reads are pinned here, on the renderer the composed `onReport`
  // uses. A dropped loop or a mangled reason is the difference between a
  // refused head an operator can diagnose and one that is only counted.
  const report = {
    jobs: [],
    discovered: 2,
    skipped: 2,
    failedRepositories: ["owner/broken"],
    handoffRefusals: [
      {
        repo: "owner/name",
        reason:
          "job carries no forge integration identity but this daemon serves 'gh-primary'",
      },
    ],
  } satisfies ReconcileReport;
  const lines = reconcileReportDiagnostics(report);
  assert.equal(lines.length, 2, "one summary line plus one line per refusal");
  assert.match(lines[0]!, /^reconcile pass: scheduled=0 discovered=2 skipped=2 failed=owner\/broken$/);
  assert.equal(
    lines[1],
    "reconcile handoff refused for owner/name: " +
      "job carries no forge integration identity but this daemon serves 'gh-primary'",
  );
  // The quiet pass renders nothing at all (the silence rule lives here, so a
  // regression that logs every 15-minute tick fails here rather than in prod).
  assert.deepEqual(
    reconcileReportDiagnostics({
      jobs: [],
      discovered: 0,
      skipped: 0,
      failedRepositories: [],
      handoffRefusals: [],
    } as unknown as ReconcileReport),
    [],
  );
  // A pass that discovered heads and skipped them all (already scheduled) is
  // NOT quiet: the heartbeat is the point.
  assert.equal(
    reconcileReportDiagnostics({
      jobs: [],
      discovered: 5,
      skipped: 5,
      failedRepositories: [],
      handoffRefusals: [],
    } as unknown as ReconcileReport).length,
    1,
  );
});

// ── the operator's admin mutations over the REAL composition (#1772) ──────

/** A local-profile executor that holds its attempt OPEN until the daemon
 * aborts it: the cancel seam's live-run precondition (#1772). The attempt
 * settles `cancelled` when the abort lands, exactly like a real worker. */
class HangingExecution implements Executor {
  readonly started: ExecutionRequest[] = [];

  async start(request: ExecutionRequest, signal: AbortSignal) {
    this.started.push(request);
    mkdirSync(request.runDir, { recursive: true });
    writeFileSync(request.requestPath, JSON.stringify(request), "utf8");
    const settled = new Promise<ExecutionResult>((resolve) => {
      const onAbort = (): void => {
        resolve({
          status: "cancelled",
          runId: request.runId,
          jobId: request.jobId,
          resultHeadSha: "",
          failureCategory: "",
          failureMessage: "",
          resultArtifactPath: "",
          diagnostics: "",
          artifactPaths: [],
          resourceMs: 0,
          observedAtMs: Date.now(),
        });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return {
      observe: async () => ({ phase: "running" as const, status: "" as const, observedAtMs: Date.now() }),
      cancel: async () => undefined,
      collect: async () => settled,
    };
  }

  async reconcile(): Promise<{ kind: "none" }> {
    return { kind: "none" };
  }

  async cancel(): Promise<{ kind: "terminated" }> {
    return { kind: "terminated" };
  }
}

test("#1772: the admin surface drives the REAL composition (a forced rereview mints a generation; a cancel settles the run)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctl-admin-mut-"));
  const configPath = join(dir, "instance.yaml");
  writeFileSync(configPath, GITHUB_INSTANCE_CONFIG, "utf8");
  const env = baseEnv(configPath);
  env.PR_REVIEWER_GITHUB_APP_ID = "12345";
  env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
  // The App installation identity: the forced rereview reads the pull request
  // AS this installation, and a daemon without one refuses before it reads.
  env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID = "12345";
  const adminPort = await freePort();
  env.PR_REVIEWER_ADMIN_PORT = String(adminPort);
  env.PR_REVIEWER_ADMIN_TOKEN = "admin-token";

  const fake = new HangingExecution();
  const prReads: Array<{ repoFullName: string; prNumber: number; installationId: string }> = [];
  const controlPlane = new InMemoryControlPlaneStore();
  let handle: ControllerMainHandle | null = null;
  const running = controllerMain([], env, {
    controlPlane,
    executors: { local: () => fake },
    forge: {
      mirrorFor: async () => ({ ensureMirror: async () => undefined }) as unknown as MirrorCache,
      currentHeadSha: async () => HEAD,
      readPrIdentity: async (input) => {
        prReads.push({ repoFullName: input.repoFullName, prNumber: input.prNumber, installationId: input.installationId });
        return { headSha: HEAD, prId: 4242, baseSha: BASE, fork: false };
      },
      publish: async () => ({ publicationId: "github-comment:1" }),
    },
    createWorkspace: async (): Promise<WorkspaceHandle> => ({
      info: {
        rootPath: "/srv/workspace-fake",
        headSha: HEAD,
        mergeBaseSha: BASE,
        platform: "github",
        repoFullName: "owner/repo",
        createdAtMs: 1000,
      },
      close: async () => undefined,
    }),
    onReady: (ready) => {
      handle = ready;
    },
  });
  t.after(async () => {
    if (handle !== null) await handle.stop().catch(() => undefined);
    await running.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    cleanupDirs(env);
  });
  await waitFor(() => handle !== null);
  const started = handle!;
  const admin = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://127.0.0.1:${adminPort}${path}`, {
      ...init,
      headers: { authorization: "Bearer admin-token", ...(init?.headers ?? {}) },
    });

  // 1. The forced rereview: the operator's key reaches the daemon, the forge
  //    read happens AS the daemon's installation, and a generation is minted.
  const rereview = await admin("/admin/rereview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prKey: "owner/repo#7", reason: "manual" }),
  });
  assert.equal(rereview.status, 202);
  const accepted = await rereview.json() as { jobId?: string };
  assert.equal(typeof accepted.jobId, "string");
  assert.notEqual(accepted.jobId, "");
  assert.deepEqual(
    prReads,
    [{ repoFullName: "owner/repo", prNumber: 7, installationId: "12345" }],
    "the forced rereview read the pull request AS the daemon's installation",
  );
  await waitFor(() => fake.started.length >= 1);
  const snapshot = JSON.parse(readFileSync(join(env.PR_REVIEWER_DURABLE_STATE_DIR!, "queue-snapshot.json"), "utf8")) as {
    records: Array<{ job: { jobId: string } }>;
  };
  assert.ok(
    snapshot.records.some((record) => record.job.jobId === accepted.jobId),
    "the forced generation is in the daemon's own queue",
  );

  // 2. The cancellation: a LIVE run, discovered through the admin surface
  //    and cancelled through it.
  const ingestHead = "cc33dd44ee55ff6677889900aabbccddeeff0011";
  const event: CanonicalForgeEvent = {
    platform: "github",
    source: "webhook",
    kind: "synchronize",
    installationId: "12345",
    repoFullName: "owner/repo",
    prNumber: 9,
    prId: 4243,
    headSha: ingestHead,
    baseSha: BASE,
    draft: false,
    fork: false,
    labelName: "",
    actor: "contributor",
    eventReference: "",
  };
  assert.equal(await started.daemon.ingest(event), "scheduled");
  await waitFor(() => fake.started.length >= 2);
  const listed = await admin("/admin/runs?limit=50");
  assert.equal(listed.status, 200);
  const runs = await listed.json() as { runs: Array<{ runId: string; headSha: string; state: string }> };
  const target = runs.runs.find((run) => run.headSha === ingestHead);
  assert.ok(target !== undefined, "the live run is listed for the operator");
  assert.ok(!["completed", "failed", "cancelled", "superseded"].includes(target.state), "the run is live");

  const cancelled = await admin(`/admin/runs/${encodeURIComponent(target.runId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { cancelled: true });

  // The durable run settles `cancelled` with the operator's attribution.
  const settled = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await controlPlane.getRun(target.runId);
      if (run !== null && run.state === "cancelled") return run;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  assert.notEqual(settled, null, "the run settles cancelled");
  assert.equal(settled!.state, "cancelled");
  assert.equal(settled!.failureReason, "cancelled-by-operator");
  assert.equal(settled!.supersededByJobId, "", "the run was never superseded");

  // 3. The operator's WHY reaches the DURABLE audit ledger: the rereview row
  //    carries the stated reason, the cancel row carries none.
  const ledger = readFileSync(join(env.PR_REVIEWER_DURABLE_STATE_DIR!, "admin-audit.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const rereviewRow = ledger.find((row) => row["action"] === "rereview");
  assert.equal(rereviewRow?.["reason"], "manual", "the rereview row records WHY the operator forced it");
  const cancelRow = ledger.find((row) => row["action"] === "cancel");
  assert.ok(cancelRow !== undefined, "the cancel was audited");
  assert.ok(!("reason" in cancelRow!), "the cancel row carries no reason field at all");
});
