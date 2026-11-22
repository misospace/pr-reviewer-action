/** The production controller entrypoint (#738 Phase A2 self-hosted
 * packaging): `controllerMain` composes the #1348 controller daemon from
 * the operator's environment — instance config, PostgreSQL control plane,
 * forge capability, executor bindings, ingress listeners — and runs it
 * until SIGTERM/SIGINT.
 *
 * COMPOSED THIN, FAIL CLOSED. This module owns NO policy: the #727
 * instance config is the policy, the #736 PostgreSQL backend is the
 * durable state, the daemon is the runtime, and every seam is the
 * production library. Every startup input that is missing, malformed, or
 * uncomposable refuses the process with a bounded, secret-free stderr
 * diagnostic and exit code 2 (configuration) or 1 (composition/runtime) —
 * the controller never starts on a partial policy, never accepts work
 * before migrations prove the schema (#736), and never serves the admin
 * surface unauthenticated.
 *
 * Environment contract (all secret material travels through the
 * environment or the projected service-account mount, never argv, never a
 * URL, never a log line):
 *
 * - `PR_REVIEWER_INSTANCE_CONFIG` (or `--config <path>`): the #727
 *   instance-config file (required).
 * - `PR_REVIEWER_CONTROL_PLANE_URL`: the PostgreSQL DSN (required).
 * - `PR_REVIEWER_DURABLE_STATE_DIR`, `PR_REVIEWER_RUNS_ROOT`,
 *   `PR_REVIEWER_WORKSPACE_CACHE_ROOT`: the controller-owned roots
 *   (required, absolute).
 * - `PR_REVIEWER_WEBHOOK_PORT`, `PR_REVIEWER_WEBHOOK_SECRET`: the forge
 *   webhook intake (optional; the daemon serves it).
 * - `PR_REVIEWER_ADMIN_PORT`, `PR_REVIEWER_ADMIN_TOKEN`: the #737 admin
 *   listener (optional; the token is REQUIRED whenever the port is set —
 *   an unauthenticated admin surface is never served).
 * - `PR_REVIEWER_ADMIN_BIND`: the admin listener's bind address (optional;
 *   default `127.0.0.1`). A closed allowlist — loopback or the pod-wide
 *   wildcards — never a resolved hostname: a typo must refuse startup,
 *   not rebind the surface. `0.0.0.0`/`::` exist so in-cluster scrapers
 *   (ServiceMonitor) can reach metrics; the bearer token and the
 *   operator's NetworkPolicy remain the guards.
 * - `PR_REVIEWER_RECONCILE_INTERVAL_MS`, `PR_REVIEWER_RECONCILE_REPOS`:
 *   the missed-webhook reconciliation schedule (optional).
 * - `PR_REVIEWER_GITHUB_APP_ID`, `PR_REVIEWER_GITHUB_APP_PRIVATE_KEY`
 *   (or `PR_REVIEWER_GITHUB_APP_PRIVATE_KEY_FILE` for a secret-mounted
 *   PEM): the GitHub App material when the instance serves `github`.
 *   `PR_REVIEWER_GITHUB_APP_INSTALLATION_ID` is additionally required when
 *   reconciliation is enabled.
 * - `FORGEJO_TOKEN` (the platform seam's own helper, `forgeTokenFromEnv`):
 *   the Forgejo/Gitea token when the instance serves `forgejo` or `gitea`
 *   (#1682: one family, one token env; the declared product decides the
 *   refusal — a Gitea instance fails closed on the Forgejo-only
 *   `authorized_integration` mode).
 * - `PR_REVIEWER_CREDENTIAL_<REF>`: the #735 credential material for each
 *   opaque reference the instance config names (model-profile credentials;
 *   the reference is uppercased with every non-alphanumeric character
 *   mapped to `_`).
 *
 * Model calls stay OUT of the review pipeline (the daemon drives the
 * executor seam, whose workers own the engine); the one model surface the
 * controller itself touches is the follow-up Q&A answer lane, which
 * composes `createFollowUpAnswerExecutor` on the default model profile and
 * stays DISABLED (returns "", planner fails closed) unless
 * `PR_REVIEWER_FOLLOWUP_MODEL` names a model id.
 */

import { createServer, type Server } from "node:http";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { validateContract } from "../config/contract.js";
import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import {
  parseInstanceConfigText,
  forgeFamily,
  MAX_INSTANCE_CONFIG_BYTES,
  type InstanceConfig,
  type ModelProfile,
} from "../config/instance-config.js";
import type { ApiFormat } from "../config/types.js";
import { forgeProductLabel, forgeTokenFromEnv } from "../platform/forge-identity.js";
import type { FetchLike } from "../platform/http.js";
import { parseRepoRef } from "../platform/repo-ref.js";
import {
  buildWorkerCredentialPlan,
  InMemorySecretVault,
  resolveWorkerCredentials,
  type CredentialBroker,
  type CredentialRef,
  type ResolveResult,
  type VaultEntry,
  type WorkerCredentialPlan,
} from "../credentials/index.js";
import {
  PostgresControlPlaneStore,
  PostgresQueueSnapshotStore,
  runControlPlaneMigrations,
  type ControlPlaneStore,
} from "../state/index.js";
import type { UsageAggregateRow } from "../state/store.js";
import { Pool } from "pg";
import {
  LocalExecutor,
  KubernetesExecutor,
  type ExecutionProfiles,
  type ExecutionRequest,
  type ProjectedWorkerCredential,
  type WorkerCredentialResolution,
  type WorkerCredentialResolver,
} from "../executor/index.js";
import { InClusterKubernetesApi } from "../executor/kubernetes-api.js";
import { InClusterCredentialStore } from "../executor/kubernetes-credential-store.js";
import { createFollowUpAnswerExecutor } from "../followup/executor.js";
import { createAdminHost, type AdminHost } from "../admin/server.js";
import type {
  AdminAdoptionEntry,
  AdminQueueStatus,
  AdminRunDetail,
  AdminRunSummary,
  ControllerAdminDeps,
  ReadinessComponent,
} from "../admin/types.js";
import { normalizeRepoFullName } from "../events/normalize.js";
import type { FollowUpForgeAdapter } from "../ingress/followup-host.js";
import type { ReconcileReport } from "../ingress/reconcile.js";
import {
  startControllerDaemon,
  type ControllerDaemon,
  type ControllerDaemonOptions,
  type ControllerForgeCapability,
  type ExecutorBindings,
} from "./daemon.js";
import {
  composeForgeCapability,
  type ComposedForge,
} from "./forge-capability.js";

/** The daemon's webhook option shape (re-exported locally for the
 * composition). */
type DaemonWebhook = NonNullable<ControllerDaemonOptions["webhook"]>;

/** The daemon's reconciliation option shape (re-exported locally for the
 * composition). */
type DaemonReconcile = NonNullable<ControllerDaemonOptions["reconcile"]>;

/** The running controller handle: health introspection plus the graceful
 * stop the signal handlers (and tests) drive. */
export interface ControllerMainHandle {
  readonly daemon: ControllerDaemon;
  /** Graceful stop: intake closed, bounded drain, listeners closed, pool
   * ended. Resolves with the process exit code to use. Idempotent. */
  stop(): Promise<number>;
}

/** Injected seams — all optional; the defaults are the production ones.
 * Tests inject an in-memory control plane, executor fakes, and forge
 * fakes (the daemon-test pattern) so the composition is provable without
 * a database, a cluster, or a forge. */
export interface ControllerMainDeps {
  /** Control-plane override (tests): skips the PostgreSQL pool, the
   * migrations hook, and the PostgreSQL queue snapshot store entirely. */
  readonly controlPlane?: ControlPlaneStore;
  /** Executor construction overrides (tests bind fakes; production binds
   * the real local executor and the in-cluster Kubernetes API). */
  readonly executors?: ExecutorBindings;
  /** Forge capability override (tests). */
  readonly forge?: ControllerForgeCapability;
  /** Follow-up adapter override (tests); production composes the platform
   * adapter from the forge integration. */
  readonly followUpAdapter?: FollowUpForgeAdapter;
  /** Follow-up identity probe override (tests). */
  readonly followUpBotLogin?: () => Promise<string | null>;
  /** Follow-up answer executor override (tests keep model calls out). */
  readonly followUpAnswer?: (prompt: string) => Promise<string>;
  /** Transport seam override for the forge composition (tests). */
  readonly fetchImpl?: FetchLike;
  /** Workspace-extraction override (tests bind a fake; production uses
   * `createReviewWorkspace` from #732 acquisition). */
  readonly createWorkspace?: NonNullable<ControllerDaemonOptions["createWorkspace"]>;
  /** Clock. */
  readonly now?: () => number;
  /** Called once the daemon is constructed and serving — the hook tests
   * use to reach the running handle without signals. */
  readonly onReady?: (handle: ControllerMainHandle) => void;
}

/** Bounded single-line stderr diagnostic. */
const MAX_DIAGNOSTIC_LINE_CHARS = 2_000;

function diagnostic(message: string): void {
  const line = message.length <= MAX_DIAGNOSTIC_LINE_CHARS
    ? message
    : `${message.slice(0, MAX_DIAGNOSTIC_LINE_CHARS - 1)}…`;
  process.stderr.write(`controller: ${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The controller's rendering of one reconciliation pass (#1718).
 *
 * The report is the ONLY channel that distinguishes a poll that fails or is
 * refused every tick from a forge with nothing to review, so a pass with
 * anything to say gets one summary line plus one line per refused queue
 * handoff carrying the daemon's reason. A pass that listed every repository
 * and found nothing stays silent: a quiet forge must not generate log spam
 * on a 15-minute timer. A repository whose open pull requests are all
 * already scheduled DOES log (discovered > 0, skipped > 0) — that line is
 * the only evidence the sweep still sees them and the ledger still
 * suppresses them.
 *
 * Refusal reasons arrive single-line and secret-masked from the pass itself
 * (`describeHandoffRefusal`): they are rendered verbatim, never re-derived,
 * and no job id or credential ever joins the line. */
export function reconcileReportDiagnostics(report: ReconcileReport): readonly string[] {
  if (
    report.discovered === 0 &&
    report.failedRepositories.length === 0 &&
    report.handoffRefusals.length === 0
  ) {
    return [];
  }
  const lines = [
    `reconcile pass: scheduled=${String(report.jobs.length)}` +
      ` discovered=${String(report.discovered)}` +
      ` skipped=${String(report.skipped)}` +
      ` failed=${report.failedRepositories.length === 0 ? "-" : report.failedRepositories.join(",")}`,
  ];
  for (const refusal of report.handoffRefusals) {
    lines.push(`reconcile handoff refused for ${refusal.repo}: ${refusal.reason}`);
  }
  return lines;
}

/** The env var name that carries the material for one #735 credential
 * reference (every non-alphanumeric character mapped to `_`). */
export function credentialEnvName(reference: string): string {
  // Deliberately many-to-one: 'a-b' and 'a_b' map to the same env var. The
  // instance config already refuses duplicate profile/credential names, and
  // two references colliding here just share one operator-provided secret —
  // never two credentials writing over each other's material.
  return `PR_REVIEWER_CREDENTIAL_${reference.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

function portFromEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name];
  if (raw === undefined) return null;
  if (!/^[0-9]{1,5}$/.test(raw)) return -1;
  const value = Number(raw);
  if (value < 1 || value > 65_535) return -1;
  return value;
}

/** Read the instance-config file bounded: missing/oversized files refuse,
 * never partially parse. The content is read BEFORE its size is judged —
 * no stat-then-read window in which the file could be swapped. */
function readConfigFile(path: string): string {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw new Error(`the instance config file ${path} is not readable`);
  }
  if (content.byteLength > MAX_INSTANCE_CONFIG_BYTES) {
    throw new Error(
      `the instance config file ${path} is not a bounded regular file (cap ${MAX_INSTANCE_CONFIG_BYTES} bytes)`,
    );
  }
  return content.toString("utf8");
}

/** Read a secret-file variant (`*_FILE`), bounded, read-before-bound for
 * the same race-free reason. */
function readSecretFile(path: string): string {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw new Error(`the secret file ${path} is not readable`);
  }
  if (content.byteLength > 64 * 1024) {
    throw new Error(`the secret file ${path} is not a bounded regular file`);
  }
  return content.toString("utf8");
}

/** A startup refusal: the bounded diagnostic plus the exit code (2 for a
 * configuration problem, 1 for a composition/runtime problem). */
export class StartupRefusal extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "StartupRefusal";
    this.exitCode = exitCode;
  }
}

/** The resolved startup configuration (nothing has bound yet — refusal is
 * cheap and total). */
interface StartupConfig {
  readonly instance: InstanceConfig;
  /** The configured identity platform (#1682: `gitea` is a Gitea-family
   * identity served by the Forgejo-compatible stack). Canonical jobs,
   * events, and credential scopes stay in the `forgeFamily` of this value. */
  readonly platform: "github" | "forgejo" | "gitea";
  readonly forgeEndpoint: string;
  readonly controlPlaneDsn: string;
  readonly durableStateDir: string;
  readonly runsRoot: string;
  readonly workspaceCacheRoot: string;
  readonly webhook: { readonly port: number; readonly secret: string } | null;
  readonly admin: { readonly port: number; readonly token: string; readonly bind: string; readonly dashboard: boolean } | null;
  readonly reconcile: { readonly intervalMs: number; readonly repos: readonly string[] } | null;
  readonly githubAppId: string;
  readonly githubAppPrivateKeyPem: string;
  readonly githubInstallationId: string;
  readonly forgejoToken: string;
  readonly followUpModel: string;
  readonly followUpMentions: readonly string[];
  readonly modelCredentialMaterial: ReadonlyMap<string, string>;
}

function resolveStartup(argv: readonly string[], env: NodeJS.ProcessEnv): StartupConfig {
  // ── config location: --config <path> (preferred) or the env path.
  let configPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--config") {
      const value = argv[index + 1] ?? "";
      if (value === "" || value.startsWith("--")) {
        throw new StartupRefusal("--config requires a file path", 2);
      }
      configPath = value;
      index += 1;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else {
      throw new StartupRefusal(`unknown argument '${arg}' (only --config <path> is accepted)`, 2);
    }
  }
  if (configPath === "") configPath = env.PR_REVIEWER_INSTANCE_CONFIG ?? "";
  if (configPath === "") {
    throw new StartupRefusal(
      "no instance config was provided (use --config <path> or PR_REVIEWER_INSTANCE_CONFIG)",
      2,
    );
  }

  // ── required environment, fail closed with ONE bounded diagnostic that
  //    names every missing variable.
  const required = [
    "PR_REVIEWER_CONTROL_PLANE_URL",
    "PR_REVIEWER_DURABLE_STATE_DIR",
    "PR_REVIEWER_RUNS_ROOT",
    "PR_REVIEWER_WORKSPACE_CACHE_ROOT",
  ] as const;
  const missing = required.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new StartupRefusal(`missing required environment: ${missing.join(", ")}`, 2);
  }
  const controlPlaneDsn = env.PR_REVIEWER_CONTROL_PLANE_URL!;
  const durableStateDir = env.PR_REVIEWER_DURABLE_STATE_DIR!;
  const runsRoot = env.PR_REVIEWER_RUNS_ROOT!;
  const workspaceCacheRoot = env.PR_REVIEWER_WORKSPACE_CACHE_ROOT!;
  for (const [name, value] of [
    ["PR_REVIEWER_DURABLE_STATE_DIR", durableStateDir],
    ["PR_REVIEWER_RUNS_ROOT", runsRoot],
    ["PR_REVIEWER_WORKSPACE_CACHE_ROOT", workspaceCacheRoot],
  ] as const) {
    if (!isAbsolute(value) || value.includes("\u0000")) {
      throw new StartupRefusal(`${name} must be an absolute path`, 2);
    }
  }

  // ── the instance config (validated strictly; a problem is a refusal).
  let text: string;
  try {
    text = readConfigFile(configPath);
  } catch (error) {
    throw new StartupRefusal(errorMessage(error), 2);
  }
  let instance: InstanceConfig;
  try {
    instance = parseInstanceConfigText(text, validateContract(V3_CONTRACT));
  } catch (error) {
    throw new StartupRefusal(`the instance config is invalid: ${errorMessage(error)}`, 2);
  }

  // ── ONE platform per instance: the daemon serves one forge platform.
  const kinds = new Set(instance.forges.map((forge) => forge.kind));
  if (instance.forges.length === 0 || kinds.size !== 1) {
    throw new StartupRefusal(
      "the instance config must declare forges for exactly one platform (the controller serves one forge per instance)",
      2,
    );
  }
  const platform = instance.forges[0]!.kind;
  const forgeEndpoint = instance.forges[0]!.endpoint;
  if (platform === "gitlab") {
    // #740: the GitLab adapter stack (ingress intake, read/publish
    // adapters) exists at the platform seam, but the controller daemon's
    // capability composition, credential wiring and reconciliation for
    // GitLab are not landed yet. Refuse at startup — the daemon must
    // never compose a GitLab instance on another family's adapters.
    throw new StartupRefusal(
      "the instance config declares a gitlab forge integration, but controller-daemon GitLab composition is not wired yet (#1677)",
      2,
    );
  }

  // ── forge material (platform-specific, fail closed).
  let githubAppId = "";
  let githubAppPrivateKeyPem = "";
  let githubInstallationId = "";
  let forgejoToken = "";
  if (platform === "github") {
    githubAppId = env.PR_REVIEWER_GITHUB_APP_ID ?? "";
    if (!/^[1-9][0-9]{0,18}$/.test(githubAppId)) {
      throw new StartupRefusal(
        "PR_REVIEWER_GITHUB_APP_ID must be the GitHub App's numeric id when the instance serves github",
        2,
      );
    }
    const keyFile = env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY_FILE ?? "";
    const keyInline = env.PR_REVIEWER_GITHUB_APP_PRIVATE_KEY ?? "";
    try {
      githubAppPrivateKeyPem = keyFile !== "" ? readSecretFile(keyFile) : keyInline;
    } catch (error) {
      throw new StartupRefusal(errorMessage(error), 2);
    }
    if (!githubAppPrivateKeyPem.includes("-----BEGIN ") || !githubAppPrivateKeyPem.includes("PRIVATE KEY-----")) {
      throw new StartupRefusal(
        "PR_REVIEWER_GITHUB_APP_PRIVATE_KEY must contain a PEM private key",
        2,
      );
    }
    // #1723: the App installation identity the instance serves. The SAME
    // value seeds the reconciliation poll's minted identity (#1624) and
    // repairs a webhook delivery whose signed payload omitted
    // `installation.id`. Optional for the App intake alone (a real App
    // delivery carries it); REQUIRED for the poll (enforced below).
    githubInstallationId = env.PR_REVIEWER_GITHUB_APP_INSTALLATION_ID ?? "";
    if (githubInstallationId !== "" && !/^[1-9][0-9]{0,18}$/.test(githubInstallationId)) {
      throw new StartupRefusal(
        "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID must be the installation id the instance serves (a positive decimal id) when the instance serves github",
        2,
      );
    }
  } else {
    // #1682: `forgejo` and `gitea` are one family — the token env contract
    // is shared (FORGEJO_TOKEN) — but the DECLARED product decides what the
    // family refuses, and that difference lives in the platform seam
    // (`forgeTokenFromEnv`): Gitea has no Forgejo "authorized integration",
    // so a Gitea instance may never authenticate by that mode. The refusal
    // is a misconfiguration, not a missing credential: it is reported as
    // the startup refusal it is.
    let token: string | undefined;
    try {
      token = forgeTokenFromEnv(platform, env);
    } catch (error) {
      throw new StartupRefusal(errorMessage(error), 2);
    }
    if (token === undefined) {
      throw new StartupRefusal(
        `the instance config serves ${platform} but no ${forgeProductLabel(platform)} token is configured (FORGEJO_TOKEN)`,
        2,
      );
    }
    forgejoToken = token;
  }

  // ── listeners.
  let webhook: { readonly port: number; readonly secret: string } | null = null;
  const webhookPort = portFromEnv(env, "PR_REVIEWER_WEBHOOK_PORT");
  if (webhookPort !== null) {
    if (webhookPort === -1) {
      throw new StartupRefusal("PR_REVIEWER_WEBHOOK_PORT must be a TCP port number", 2);
    }
    const secret = env.PR_REVIEWER_WEBHOOK_SECRET ?? "";
    if (secret.trim() === "") {
      throw new StartupRefusal(
        "PR_REVIEWER_WEBHOOK_SECRET is required when PR_REVIEWER_WEBHOOK_PORT is set",
        2,
      );
    }
    webhook = { port: webhookPort, secret };
  }
  let admin: { readonly port: number; readonly token: string; readonly bind: string; readonly dashboard: boolean } | null = null;
  const adminPort = portFromEnv(env, "PR_REVIEWER_ADMIN_PORT");
  if (adminPort !== null) {
    if (adminPort === -1) {
      throw new StartupRefusal("PR_REVIEWER_ADMIN_PORT must be a TCP port number", 2);
    }
    // ── the optional #742 operations dashboard on the admin listener. The
    //    flag means nothing without the listener, so the lexical check runs
    //    only here: OFF = unset, `0`, `false`, `off`, `no`, `disabled`;
    //    ON = `1`, `true`, `enabled`, `on`, `yes` (case-insensitive,
    //    trimmed). ANY other non-empty value is a refusal — a typo like
    //    `ture` must never silently disable the flag on a deployment that
    //    DOES serve the admin listener.
    const DASHBOARD_OFF = ["0", "false", "off", "no", "disabled"] as const;
    const DASHBOARD_ON = ["1", "true", "enabled", "on", "yes"] as const;
    const dashboardRaw = (env.PR_REVIEWER_ADMIN_DASHBOARD ?? "").trim().toLowerCase();
    if (dashboardRaw !== "" && !DASHBOARD_OFF.includes(dashboardRaw as typeof DASHBOARD_OFF[number]) && !DASHBOARD_ON.includes(dashboardRaw as typeof DASHBOARD_ON[number])) {
      throw new StartupRefusal(
        "PR_REVIEWER_ADMIN_DASHBOARD must be unset or one of 0/false/off/no/disabled (off) or 1/true/enabled/on/yes (on) — any other value is refused, not silently disabled",
        2,
      );
    }
    const dashboardEnabled = DASHBOARD_ON.includes(dashboardRaw as typeof DASHBOARD_ON[number]);
    // FAIL CLOSED: an admin listener without its bearer token is never
    // served — the composition refuses instead of starting unauthenticated.
    const token = env.PR_REVIEWER_ADMIN_TOKEN ?? "";
    if (token.trim() === "") {
      throw new StartupRefusal(
        "PR_REVIEWER_ADMIN_TOKEN is required when PR_REVIEWER_ADMIN_PORT is set (the admin surface is never served unauthenticated)",
        2,
      );
    }
    // The bind address is a closed allowlist: a hostname would resolve and
    // rebind the surface in ways the operator cannot see, so only literal
    // loopback/wildcard addresses are accepted. Default stays loopback.
    const bind = env.PR_REVIEWER_ADMIN_BIND ?? "127.0.0.1";
    if (!["127.0.0.1", "0.0.0.0", "::1", "::"].includes(bind)) {
      throw new StartupRefusal(
        "PR_REVIEWER_ADMIN_BIND must be one of 127.0.0.1, 0.0.0.0, ::1, :: (a hostname is never accepted)",
        2,
      );
    }
    admin = { port: adminPort, token, bind, dashboard: dashboardEnabled };
  }

  // ── reconciliation schedule.
  let reconcile: { readonly intervalMs: number; readonly repos: readonly string[] } | null = null;
  const intervalRaw = env.PR_REVIEWER_RECONCILE_INTERVAL_MS;
  const repoTargetsRaw = env.PR_REVIEWER_RECONCILE_REPOS ?? "";
  // A trusted repo list alone opts into the default 15-minute sweep.
  // An explicit interval with no targets remains a startup refusal.
  if (intervalRaw !== undefined || repoTargetsRaw.trim() !== "") {
    const intervalMs = intervalRaw === undefined ? 900_000 : Number(intervalRaw);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 50) {
      throw new StartupRefusal(
        "PR_REVIEWER_RECONCILE_INTERVAL_MS must be an integer >= 50 (milliseconds)",
        2,
      );
    }
    const repos = (env.PR_REVIEWER_RECONCILE_REPOS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (repos.length === 0) {
      throw new StartupRefusal(
        "PR_REVIEWER_RECONCILE_REPOS is required when PR_REVIEWER_RECONCILE_INTERVAL_MS is set (comma-separated owner/name list)",
        2,
      );
    }
    if (platform === "github" && githubInstallationId === "") {
      throw new StartupRefusal(
        "PR_REVIEWER_GITHUB_APP_INSTALLATION_ID must be the installation id the reconciliation poll authenticates as when the instance serves github",
        2,
      );
    }
    reconcile = { intervalMs, repos };
  }

  // ── credential material (#735): every reference the config names must
  //    have env-defined material, fail closed at startup. Forge
  //    integration references (#1484) are collected opportunistically —
  //    an operator that provides the material enables the worker's
  //    publish-purpose forge reads; one that does not keeps starting, and
  //    the worker credential plan's forge reference fails closed at
  //    resolution (`unknown_reference`) instead of refusing the whole
  //    controller at startup.
  const modelCredentialMaterial = new Map<string, string>();
  const requiredRefs = new Set<string>();
  for (const profile of instance.modelProfiles) requiredRefs.add(profile.credential);
  for (const reference of requiredRefs) {
    const name = credentialEnvName(reference);
    const material = env[name];
    if (typeof material !== "string" || material === "") {
      throw new StartupRefusal(
        `the credential reference '${reference}' has no material (${name} is unset)`,
        2,
      );
    }
    modelCredentialMaterial.set(reference, material);
  }
  for (const forge of instance.forges) {
    if (modelCredentialMaterial.has(forge.credential)) continue;
    const material = env[credentialEnvName(forge.credential)];
    if (typeof material === "string" && material !== "") {
      modelCredentialMaterial.set(forge.credential, material);
    }
  }

  // ── the execution profile resolution (fail closed here, not at the
  //    first dispatch): execution requests require an executor and a model
  //    profile, so the operator must have declared each default. Evidence
  //    is OPTIONAL (#1711, Action-mode parity): the schema makes
  //    `evidence-profiles`/`default-evidence-profile` optional, so a null
  //    default means "not configured" — the plan/credential seam carries
  //    the empty name (src/credentials/worker-set.ts) and the envelope's
  //    `profiles.evidence` accepts "" (src/executor/types.ts). The
  //    executor deliberately consumes no evidence config, so there is
  //    nothing a missing default could break downstream.
  if (instance.defaultExecutorProfile === null) {
    throw new StartupRefusal(
      "the instance config declares no default executor profile; execution requests require one",
      2,
    );
  }

  return {
    instance,
    platform,
    forgeEndpoint,
    controlPlaneDsn,
    durableStateDir,
    runsRoot,
    workspaceCacheRoot,
    webhook,
    admin,
    reconcile,
    githubAppId,
    githubAppPrivateKeyPem,
    githubInstallationId,
    forgejoToken,
    followUpModel: env.PR_REVIEWER_FOLLOWUP_MODEL ?? "",
    followUpMentions: (env.PR_REVIEWER_FOLLOWUP_MENTIONS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    modelCredentialMaterial,
  };
}

/** The admin surface's PR key: `"<owner>/<repo>#<prNumber>"`.
 *
 * ONE strict grammar: an owner and a repository of `[A-Za-z0-9._-]`, a
 * `#`, and a POSITIVE decimal PR number with no leading zero. A URL
 * scheme, whitespace, a path, or a padded number is refused — the key
 * names one pull request, and a key that could name several is never
 * resolved by guessing. A DOT-ONLY segment (`.` or `..`) is no repository
 * identity either: the parsed identity is validated through the platform's
 * ONE repository-reference validator, so a traversal-shaped key like
 * `../..#7` gets the shape refusal at this gate, never the opaque forge
 * refusal it would later reach. The reason a refusal carries names the
 * grammar, never the operator's input. */
const PR_KEY_PATTERN = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]{0,9})$/;

function parsePrKey(prKey: string): { readonly repoFullName: string; readonly prNumber: number } | null {
  if (typeof prKey !== "string") return null;
  const match = PR_KEY_PATTERN.exec(prKey);
  if (match === null) return null;
  const prNumber = Number(match[3]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  // The charset match is not a repository identity: a dot-only segment
  // survives it and is exactly the shape the platform's repo-ref validator
  // refuses (`parseRepoRef` rejects `.`/`..` for the URL-normalization hole
  // it exists to close). Refuse the same shapes HERE, at the shape gate, so
  // the operator reads the grammar, not a downstream "could not be read".
  if (parseRepoRef(`${match[1]}/${match[2]}`) === null) return null;
  // The identity carries the SAME canonical case the intake's forge
  // normalizer produces (`normalizeRepoFullName`: trim + lowercase): the
  // adoption records, the allow/denylist matching, and the generation
  // identity all key on that canonical form, so a mixed-case operator key
  // names the same repository the webhook event would — it can never miss
  // the adoption record, and can never mint a generation whose identity
  // diverges from the intake's for the same head.
  const repoFullName = normalizeRepoFullName(`${match[1]}/${match[2]}`);
  if (repoFullName === "") return null;
  return { repoFullName, prNumber };
}

/** The admin surface's thin deps (#737): projections over the control
 * plane and the running daemon. Mutations this composition cannot express
 * yet refuse HONESTLY (a bounded reason the admin sees) instead of
 * pretending to succeed. */
function createAdminDeps(deps: {
  readonly store: ControlPlaneStore;
  readonly daemon: ControllerDaemon;
  readonly instance: InstanceConfig;
  /** The configured identity platform (a diagnostics string — `gitea` is
   * reported as configured, #1682). */
  readonly platform: "github" | "forgejo" | "gitea";
  readonly auditPath: string;
}): ControllerAdminDeps {
  const audit = (line: string): void => {
    try {
      appendFileSync(deps.auditPath, `${line}\n`, { mode: 0o600 });
    } catch {
      // Audit-write failure is surfaced through the metrics' audit-failure
      // counter at the dispatch layer, never by throwing into the route.
    }
  };
  return {
    async readiness() {
      const persistenceLatched = deps.daemon.queuePersistenceError() !== "";
      const components: ReadinessComponent[] = [
        { name: "control-plane", ok: true },
        {
          name: "queue",
          ok: !persistenceLatched,
          ...(persistenceLatched ? { degraded: true } : {}),
        },
        { name: "intake", ok: !deps.daemon.stopped },
      ];
      return { components };
    },
    async listRuns(input: { readonly limit: number; readonly cursor?: string }) {
      const { runs } = await deps.store.exportState();
      const summaries: AdminRunSummary[] = runs
        .map((run) => ({
          runId: run.runId,
          jobId: run.jobId,
          kind: run.kind,
          state: run.state,
          executorIdentity: run.executorIdentity,
          attempt: run.attempt,
          headSha: run.headSha,
          failureReason: run.failureReason,
          supersededByJobId: run.supersededByJobId,
          createdAtMs: run.createdAtMs,
          updatedAtMs: run.updatedAtMs,
          startedAtMs: run.startedAtMs,
          finishedAtMs: run.finishedAtMs,
        }))
        .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.runId < b.runId ? -1 : 1));
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
      const page = summaries.slice(start, start + input.limit);
      const nextCursor = start + input.limit < summaries.length ? String(start + input.limit) : undefined;
      return {
        runs: page,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },
    async getRun(runId: string): Promise<AdminRunDetail | null> {
      const run = await deps.store.getRun(runId);
      if (run === null) return null;
      const publication = await deps.store.getPublication(run.jobId);
      const usage = (await deps.store.exportState()).usage.filter((entry) => entry.runId === runId);
      const byRole = new Map<string, UsageAggregateRow>();
      for (const entry of usage) {
        const key = `${entry.route}:${entry.role}`;
        const existing = byRole.get(key);
        byRole.set(key, {
          route: entry.route,
          role: entry.role,
          requestCount: (existing?.requestCount ?? 0) + entry.requestCount,
          inputTokens: (existing?.inputTokens ?? 0) + entry.inputTokens,
          cacheReadTokens: (existing?.cacheReadTokens ?? 0) + entry.cacheReadTokens,
          cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + entry.cacheWriteTokens,
          outputTokens: (existing?.outputTokens ?? 0) + entry.outputTokens,
          costMicros: (existing?.costMicros ?? 0) + entry.costMicros,
          costProvenance: entry.costProvenance,
        });
      }
      return {
        ...run,
        publication: {
          jobId: run.jobId,
          state: publication?.publicationState ?? "none",
          attempt: publication?.attempt ?? 0,
          lastOutcome: publication?.lastError ?? "",
        },
        usage: [...byRole.values()].map((row) => ({
          role: row.role as AdminRunDetail["usage"][number]["role"],
          requestCount: row.requestCount,
          tokens: row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens,
          costMicros: row.costMicros,
          costProvenance: row.costProvenance,
        })),
      };
    },
    async adoptionStatus() {
      const { adoptedRepositories } = await deps.store.exportState();
      const repositories: AdminAdoptionEntry[] = adoptedRepositories.map((entry) => ({
        platform: entry.platform,
        repository: entry.repoFullName,
        configFingerprint: entry.configFingerprint,
        enabled: entry.enabled,
        adoptedAtMs: entry.adoptedAtMs,
      }));
      return { repositories };
    },
    async queueStatus(): Promise<AdminQueueStatus> {
      // The durable RUN records are the control plane's own account of the
      // work (the queue's live snapshot is the #731 store's); the admin
      // projection reports the run lifecycle states.
      const { runs } = await deps.store.exportState();
      const depthByState: Record<string, number> = {};
      let oldestAgeMs = 0;
      const nowMs = Date.now();
      const activeByExecutor = new Map<string, number>();
      for (const run of runs) {
        depthByState[run.state] = (depthByState[run.state] ?? 0) + 1;
        if (run.state !== "completed" && run.state !== "failed" && run.state !== "cancelled" && run.state !== "superseded") {
          oldestAgeMs = Math.max(oldestAgeMs, Math.max(0, nowMs - run.createdAtMs));
        }
        if (run.leaseOwner !== "" && (run.state === "running" || run.state === "starting")) {
          activeByExecutor.set(run.executorIdentity, (activeByExecutor.get(run.executorIdentity) ?? 0) + 1);
        }
      }
      return {
        depthByState: depthByState as AdminQueueStatus["depthByState"],
        oldestAgeMs,
        activeWorkersByExecutor: Object.fromEntries(activeByExecutor),
      };
    },
    async diagnostics(): Promise<Record<string, string | number | boolean>> {
      const intakeInstallation = deps.daemon.intakeInstallationDiagnostics();
      return {
        platform: deps.platform,
        executorProfiles: deps.instance.executorProfiles.length,
        modelProfiles: deps.instance.modelProfiles.length,
        queuePersistenceError: deps.daemon.queuePersistenceError() === "" ? "ok" : "latched",
        intakeStopped: deps.daemon.stopped,
        // #1723: a webhook delivery that omitted its installation identity
        // is visible AT INTAKE: `repairs` used the configured App
        // installation; `refusals` never minted a job (fail closed).
        intakeInstallationRepairs: intakeInstallation.repairs,
        intakeInstallationRefusals: intakeInstallation.refusals,
      };
    },
    async forceRereview(input) {
      // The PR key grammar: "<owner>/<repo>#<prNumber>". ONE definition,
      // parsed strictly: a malformed key is refused, never guessed at.
      const parsed = parsePrKey(input.prKey);
      if (parsed === null) {
        return { refused: "the PR key must be owner/repo#123" };
      }
      const result = await deps.daemon.forceRereview({
        repoFullName: parsed.repoFullName,
        prNumber: parsed.prNumber,
      });
      return result.status === "scheduled" ? { jobId: result.jobId } : { refused: result.reason };
    },
    async cancelRun(input) {
      const result = await deps.daemon.cancelRun(input.runId);
      return result.status === "cancelled" ? { cancelled: true } : { refused: result.reason };
    },
    audit: (event) => {
      audit(JSON.stringify({
        atMs: event.atMs,
        action: event.action,
        requestId: event.requestId,
        target: event.target,
        outcome: event.outcome,
        // The operator's stated reason rides the row when the mutation
        // carries one (the rereview): the ledger must answer WHY the
        // operator forced it. The key is OMITTED — never `undefined` — when
        // there is no reason (the cancel), so the row's shape stays
        // byte-compatible.
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      }));
    },
  };
}

/** The audit ledger path inside the durable state directory (created with
 * the daemon's own directory preparation). */
const AUDIT_LEDGER_FILENAME = "admin-audit.jsonl";

async function closePool(pool: Pool | null): Promise<void> {
  if (pool === null) return;
  try {
    await pool.end();
  } catch {
    // A pool that will not end cleanly cannot block the refusal.
  }
}

/** Upper bound on the run plans the credential binding remembers. A #735 plan
 * carries REFERENCES only, so an entry is never material; the bound exists so
 * a request build that dies between planning and launching cannot grow the
 * map forever. Eviction fails CLOSED: a run whose plan was evicted refuses its
 * credential handoff, and the executor launches nothing half-credentialed. */
const MAX_TRACKED_RUN_PLANS = 256;

/** The job identity a worker credential plan is built from (the daemon's
 * `ReviewJob` projection this composition needs, and no more). */
export interface CredentialPlanJob {
  readonly jobId: string;
  readonly repoFullName: string;
  readonly platform: "github" | "forgejo" | "gitlab";
  readonly installationId: string;
  readonly fork: boolean;
  /** The serving forge integration's identity (#1440), when the job names
   * one: the plan's `forge-publish` reference must come from the SAME
   * integration whose endpoint the envelope resolves, never a same-kind
   * guess. Absent (or empty) for jobs minted without an identity. */
  readonly forgeIntegration?: string;
}

/** The two ends of one #735 credential path, built from one plan registry so
 * the references the durable request carries and the material handed to the
 * worker are always the SAME run's. */
export interface WorkerCredentialBinding {
  /** The daemon's request-builder seam: the opaque references this run's
   * worker may draw on. */
  credentialRefs(job: CredentialPlanJob, runId: string): Promise<readonly CredentialRef[]>;
  /** The #734 executor seam: the LATE, all-or-nothing resolution of exactly
   * the plan `credentialRefs` built for this run id. */
  readonly resolver: WorkerCredentialResolver;
}

/** The serving forge's opaque publish-purpose credential reference for one
 * job: the instance integration the job's own forge identity names, or —
 * for an integration-name-less job — the single same-kind entry.
 * Selection mirrors the daemon's endpoint resolution exactly (a NAMED
 * integration resolves by name and refuses an unresolvable or ambiguous
 * name; a name-less job resolves the single same-kind entry, and an
 * AMBIGUOUS kind — several integrations share it — is unresolvable state
 * that refuses rather than guessing). No serving integration means the
 * operator configured no forge credential for this job: the plan carries
 * no `forge-publish` entry and the worker's forge reads fail closed at
 * authentication, exactly the pre-existing posture. */
function servingForgePublishCredentialRef(
  instance: InstanceConfig,
  platform: "github" | "forgejo" | "gitlab",
  forgeIntegration: string,
): string {
  if (forgeIntegration !== "") {
    const named = instance.forges.filter((entry) => entry.name === forgeIntegration);
    if (named.length === 0) {
      throw new RangeError(
        `job names unresolvable forge integration '${forgeIntegration}': no instance forge integration has that name`,
      );
    }
    if (named.length > 1) {
      throw new RangeError(
        `job names forge integration '${forgeIntegration}' which ${named.length} instance forge integrations share: the worker's publish-purpose credential cannot be selected without guessing`,
      );
    }
    // A named integration whose kind belongs to a different FAMILY than
    // the serving platform is a corrupted or misrouted identity: the
    // daemon's own endpoint resolution refuses it, so the credential
    // reference must not be selected from it either — fail closed on
    // uncertain state. A `gitea`-kind integration serving a `forgejo`-
    // family job is the same installation (#1682) and selects.
    if (forgeFamily(named[0]!.kind) !== platform) {
      throw new RangeError(
        `job names forge integration '${forgeIntegration}' of kind '${named[0]!.kind}' but the job's platform is '${platform}': the identity does not match the job's platform`,
      );
    }
    return named[0]!.credential;
  }
  const sameKind = instance.forges.filter((entry) => forgeFamily(entry.kind) === platform);
  if (sameKind.length > 1) {
    throw new RangeError(
      `${sameKind.length} instance forge integrations share platform family '${platform}': the worker's publish-purpose credential cannot be selected without guessing`,
    );
  }
  return sameKind[0]?.credential ?? "";
}

/** Compose the #735 plan builder and its late resolver as one unit.
 *
 * The durable `ExecutionRequest` deliberately carries credential REFERENCES
 * and the run's correlation identity, never the plan's scope identity, so the
 * plan built at request-build time is remembered here (bounded, references
 * only) and looked up by `runId` when the executor asks for material. A
 * resolution consumes the entry; a second resolution of the same run — or a
 * run that was never planned — refuses with the closed `invalid_request`
 * code, so an unknown correlation identity never receives material. */
export function createWorkerCredentialBinding(deps: {
  readonly instance: InstanceConfig;
  readonly defaultModelProfile: string;
  readonly defaultEvidenceProfile: string;
  readonly broker: CredentialBroker;
  readonly onRefusal?: (message: string) => void;
}): WorkerCredentialBinding {
  const plans = new Map<string, WorkerCredentialPlan>();
  const credentialRefs = async (
    job: CredentialPlanJob,
    runId: string,
  ): Promise<readonly CredentialRef[]> => {
    const modelProfile = deps.instance.modelProfiles.find(
      (entry) => entry.name === deps.defaultModelProfile,
    );
    if (modelProfile === undefined) {
      throw new Error(
        `the default model profile '${deps.defaultModelProfile}' is not defined in the instance config`,
      );
    }
    const plan = buildWorkerCredentialPlan({
      jobId: job.jobId,
      runId,
      platform: job.platform,
      repoFullName: job.repoFullName,
      installationId: job.installationId,
      fork: job.fork,
      modelMode: "direct_worker",
      modelProfileName: deps.defaultModelProfile,
      evidenceProfileName: deps.defaultEvidenceProfile,
      modelCredentialRef: modelProfile.credential,
      evidenceCredentialRef: "",
      // The workspace is produced controller-side (#732), so the worker
      // needs no clone material. But the worker's engine performs the
      // review's forge READS (admission-stage env validation, the
      // authentication and permission preflights, PR context), so a
      // NON-FORK run draws on exactly one forge credential: the serving
      // forge's publish-purpose reference (#1484). Publication itself
      // stays controller-side (the durable publisher); the worker never
      // publishes.
      //
      // FORK runs draw on NO forge material (docs/fork-review.md): the
      // instance-wide credential never crosses the fork trust boundary —
      // a fork worker's forge reads fail closed at authentication, the
      // exact pre-#1484 posture for forks.
      forgeCloneCredentialRef: "",
      forgePublishCredentialRef: job.fork ? "" : servingForgePublishCredentialRef(
        deps.instance,
        job.platform,
        job.forgeIntegration ?? "",
      ),
      resultChannel: false,
      allowForkEvidence: false,
    });
    if (plans.size >= MAX_TRACKED_RUN_PLANS) {
      const oldest = plans.keys().next();
      if (!oldest.done) plans.delete(oldest.value);
    }
    plans.set(runId, plan);
    return plan.credentials;
  };
  const resolver: WorkerCredentialResolver = {
    async resolve(request: ExecutionRequest): Promise<WorkerCredentialResolution> {
      const plan = plans.get(request.runId);
      if (plan === undefined) {
        deps.onRefusal?.(`no credential plan was planned for run ${request.runId}`);
        return {
          ok: false,
          code: "invalid_request",
          reason: "no worker credential plan exists for this correlation identity",
        };
      }
      const resolved = await resolveWorkerCredentials(deps.broker, plan);
      if (!resolved.ok) {
        // Only the closed code and the entry name are logged: the refusal is
        // the daemon's own diagnosis, and never a credential's material.
        deps.onRefusal?.(
          `credential resolution refused for run ${request.runId}: ${resolved.name} ${resolved.code}`,
        );
        return { ok: false, code: resolved.code, reason: resolved.reason };
      }
      plans.delete(request.runId);
      return {
        ok: true,
        credentials: Object.freeze(
          resolved.entries.map(
            (entry): ProjectedWorkerCredential =>
              Object.freeze({ name: entry.name, value: entry.material.value }),
          ),
        ),
      };
    },
  };
  return { credentialRefs, resolver };
}

/** Seed the #735 vault with the model-profile credentials the environment
 * provides (#738: `PR_REVIEWER_CREDENTIAL_<REF>`, proven present at startup),
 * plus the forge integrations' publish-purpose material (#1484) so the
 * worker's `forge-publish` plan reference resolves.
 *
 * Bindings are as tight as the operator's declaration allows: each entry is
 * bound to the instance's platform, to its own purpose, and — when the
 * instance config uses the reference for exactly one profile — to that profile
 * name, so a mapping bug handing profile B's run profile A's reference is
 * refused by the broker. A reference the operator shares across profiles
 * declares `profileName` unscoped: it is ONE credential the operator already
 * gave to several profiles, so there is no distinct material to isolate (the
 * env-var mapping is many-to-one on the reference for the same reason).
 * Installation and repository are declared unscoped because env-seeded model
 * credentials are instance-wide, not per-installation; purpose is always exact.
 * Material is a controller-startup snapshot (`expiresAtMs: 0`): Kubernetes
 * Secret-backed environment variables do not mutate in a running process, so
 * rotating model material requires a controller rollout/restart. The vault
 * only bounds reuse within that process. */
export function createModelCredentialVault(options: {
  readonly instance: InstanceConfig;
  readonly platform: "github" | "forgejo" | "gitlab";
  readonly modelCredentialMaterial: ReadonlyMap<string, string>;
}): InMemorySecretVault {
  const profilesByReference = new Map<string, string[]>();
  for (const profile of options.instance.modelProfiles) {
    const names = profilesByReference.get(profile.credential) ?? [];
    profilesByReference.set(profile.credential, [...names, profile.name]);
  }
  const entries: VaultEntry[] = [];
  const seeded = new Set<string>();
  for (const [reference, profileNames] of profilesByReference) {
    const soleProfile = profileNames.length === 1 ? (profileNames[0] ?? "") : "";
    seeded.add(reference);
    entries.push({
      reference,
      scope: {
        platform: options.platform,
        installationId: "",
        repoFullName: "",
        profileName: soleProfile,
        purpose: "model",
        unscopedDimensions: soleProfile === ""
          ? ["installationId", "repoFullName", "profileName"]
          : ["installationId", "repoFullName"],
      },
      material: {
        value: options.modelCredentialMaterial.get(reference) ?? "",
        expiresAtMs: 0,
      },
    });
  }
  // The forge integrations' publish-purpose material (#1484): the worker's
  // engine performs the review's forge reads, so its plan's `forge-publish`
  // reference must resolve. Bound exactly like the model entries: the
  // instance's one platform, installation/repository/profile unscoped (the
  // env-seeded material is instance-wide), purpose exact. A reference an
  // operator shares between a model profile and a forge stays a MODEL entry
  // (one reference holds exactly one scope; the shared shape cannot serve
  // both purposes), and a forge reference with no material in the map is
  // not seeded at all — its plan reference then fails closed at resolution
  // (`unknown_reference`), never degrades.
  for (const forge of options.instance.forges) {
    if (seeded.has(forge.credential)) continue;
    const material = options.modelCredentialMaterial.get(forge.credential) ?? "";
    if (material === "") continue;
    seeded.add(forge.credential);
    entries.push({
      reference: forge.credential,
      scope: {
        platform: options.platform,
        installationId: "",
        repoFullName: "",
        profileName: "",
        purpose: "forge_publish",
        unscopedDimensions: ["installationId", "repoFullName", "profileName"],
      },
      material: { value: material, expiresAtMs: 0 },
    });
  }
  return new InMemorySecretVault(entries);
}

/** #1624: wrap the #735 broker so a GitHub App deployment's worker
 * `forge-publish` reference resolves from the controller's per-job
 * installation-token mint.
 *
 * The GitHub serving credential is minted per job by the App capability
 * (`tokenFor(job.installationId)`), so — unlike the env-seeded Forgejo
 * token — there is no startup snapshot for the vault to hold. This seam
 * rides the LATE, all-or-nothing `resolveWorkerCredentials` path exactly:
 * the mint happens only when the executor resolves THIS run's plan, the
 * minted material is never stored (not in the vault, not in durable
 * state, not in the envelope), and a fork run — whose plan carries no
 * `forge-publish` entry at all — never reaches this code.
 *
   * Selection is deliberately narrow, and fail-closed at every step:
   * - the vault keeps priority: env-defined material (an operator's static
   *   token) is served unchanged; the mint fires ONLY on the refusals that
   *   prove the vault holds NO forge material for the request —
   *   `unknown_reference`, and `scope_mismatch` on a declared forge
   *   reference (the operator shared it with a model profile, so the entry
   *   serves the model purpose and there is no forge material to paper
   *   over: a vault forge entry binds only the instance platform and
   *   declares installation/repository/profile unscoped, so it always
   *   satisfies a request this broker would mint for). An expired or
   *   revoked entry is never papered over;
 * - only the `github` platform's `forge_publish` purpose and only a
 *   reference the instance config actually declares for a forge
 *   integration are ever minted — every other refusal passes through
 *   untouched (model material in particular);
 * - the mint is SCOPED to the run's repository: the worker boundary never
 *   receives the installation's full grant;
 * - a missing installation or repository identity refuses without
 *   reaching the mint;
 * - a mint failure (or mint output that fails the vault's own material
 *   discipline) refuses the WHOLE credential set with a fixed, bounded,
 *   credential-free reason — never an unauthenticated, stale, or
 *   echoed-error degradation. Because the refusal code is the closed
 *   `unknown_reference` (the mint holds no reference — it is an
 *   authority) and the executor boundary keeps only that code, the
 *   daemon's own logs would otherwise read a transient App-side failure
 *   as missing operator configuration; `onMintFailure` therefore reports
 *   each mint-path refusal's fixed diagnosis to the CONTROLLER side only,
 *   never toward the executor. */
export function createGitHubPublishMintingBroker(
  base: CredentialBroker,
  mint: (
    installationId: string,
    repoFullName: string,
  ) => Promise<{
    readonly value: string;
    readonly expiresAtMs: number;
  }>,
  declaredReferences: readonly string[],
  onMintFailure: (detail: string) => void = () => {},
): CredentialBroker {
  const mintable = new Set(declaredReferences);
  return {
    async resolve(reference, request) {
      const result = await base.resolve(reference, request);
      if (result.ok) return result;
      // `unknown_reference`: nothing is held. `scope_mismatch`: a vault
      // entry exists but serves a different purpose — reachable only when
      // the operator shares one reference between a model profile and the
      // forge integration (createModelCredentialVault keeps it a MODEL
      // entry, one reference holds exactly one scope), never when a real
      // forge entry refuses (see the doc comment above).
      const vaultHoldsNoForgeMaterial =
        result.code === "unknown_reference" || result.code === "scope_mismatch";
      if (
        !vaultHoldsNoForgeMaterial
        || request.platform !== "github"
        || request.purpose !== "forge_publish"
        || !mintable.has(reference)
      ) {
        return result;
      }
      if (request.installationId === "" || request.repoFullName === "") {
        // Both identity dimensions are required: the installation to mint
        // against and the repository to scope the mint to. This mint-path
        // refusal is diagnosed controller-side too (the executor keeps
        // only the code), with a distinct fixed string: the mint was
        // never reached, so it is not a mint failure.
        const noIdentity =
          "the per-job GitHub installation-token mint cannot run: the plan carries no installation or repository identity to scope the mint to";
        onMintFailure(noIdentity);
        return refusalFromMint(noIdentity);
      }
      let minted: { readonly value: string; readonly expiresAtMs: number };
      try {
        minted = await mint(request.installationId, request.repoFullName);
      } catch (error) {
        // The mint's own reason is bounded and credential-free by its
        // contract, but the broker refusal stays a FIXED string: the
        // closed-vocabulary reason must never echo mint or transport
        // detail toward the executor boundary. The mint's diagnosis is
        // reported to the controller side only, where the code alone
        // would misread a transient App failure as missing configuration.
        onMintFailure(
          `the per-job GitHub installation-token mint failed: ${mintFailureDetail(errorMessage(error))}`,
        );
        return refusalFromMint("the per-job GitHub installation-token mint failed");
      }
      // The vault's material discipline applied to mint output too
      // (vault.ts `isValidSecretMaterial`): no empty, line-bearing, or
      // nonsensical-expiry value crosses the handoff — defense in depth
      // beside the authenticator's own liveness rules, not instead them.
      if (
        minted.value === ""
        || minted.value.includes("\n")
        || minted.value.includes("\r")
        || !Number.isFinite(minted.expiresAtMs)
        || minted.expiresAtMs < 0
      ) {
        onMintFailure("the per-job GitHub installation-token mint returned no usable material");
        return refusalFromMint("the per-job GitHub installation-token mint returned no usable material");
      }
      return { ok: true, material: Object.freeze({ value: minted.value, expiresAtMs: minted.expiresAtMs }) };
    },
    // The minted material is never held, so there is nothing here to
    // revoke beyond the vault's own entries, and `describe` reports only
    // what the base broker holds (the mint serves no stored reference).
    revoke(reference) {
      return base.revoke(reference);
    },
    describe() {
      return base.describe();
    },
  };
}

/** The mint error's message for the CONTROLLER-side diagnostic: the
 * composed mint's own contract says its reason is bounded and
 * credential-free (same discipline as `tokenFor`), but a diagnostic is
 * exactly where an injected mint's output is not taken at its word —
 * whitespace is collapsed so one mint failure is one stderr line (a
 * newline-bearing message could forge extra log lines), and the detail is
 * truncated. Never crosses the executor boundary. */
function mintFailureDetail(message: string): string {
  const singleLine = message.replace(/\s+/gu, " ").trim();
  return singleLine.length <= 200 ? singleLine : `${singleLine.slice(0, 199)}…`;
}

/** A mint-path refusal: the closed `unknown_reference` code (the mint
 * holds no reference either — it is an authority), with a FIXED reason
 * naming the mint's own diagnosis rather than asserting the reference is
 * "not held", which would misread a transient mint failure as missing
 * operator configuration. */
function refusalFromMint(reason: string): ResolveResult {
  return Object.freeze({
    ok: false as const,
    code: "unknown_reference" as const,
    reason,
  });
}

/** Compose and run the controller. Resolves with the process exit code
 * after the graceful stop completes. */
export async function controllerMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: ControllerMainDeps = {},
): Promise<number> {
  const now = deps.now ?? ((): number => Date.now());
  let startup: StartupConfig;
  try {
    startup = resolveStartup(argv, env);
  } catch (error) {
    if (error instanceof StartupRefusal) {
      diagnostic(error.message);
      return error.exitCode;
    }
    diagnostic(errorMessage(error));
    return 1;
  }

  // ── the control plane: the injected in-memory store (tests) or the
  //    PostgreSQL backend with its migrations hook (production — work is
  //    accepted only AFTER migrations prove the schema, #736; the daemon
  //    runs the hook BEFORE it accepts work and fails closed on it).
  const injectedControlPlane = deps.controlPlane !== undefined;
  const pool = injectedControlPlane ? null : new Pool({ connectionString: startup.controlPlaneDsn });
  // A pg pool emits client errors asynchronously (an idle-client socket
  // death); without a listener that becomes an uncaught exception and
  // kills the process outside the bounded-refusal path. Surface it as a
  // bounded diagnostic instead — never the connection string.
  if (pool !== null) {
    pool.on("error", (error: Error) => {
      process.stderr.write(`controller: control-plane client error: ${errorMessage(error)}\n`);
    });
  }
  const controlPlane: ControlPlaneStore = deps.controlPlane ?? new PostgresControlPlaneStore(pool!);
  const migrate = injectedControlPlane
    ? undefined
    : async (): Promise<void> => {
        await runControlPlaneMigrations(pool!);
      };
  const queueSnapshotStore = injectedControlPlane
    ? undefined
    : new PostgresQueueSnapshotStore(pool!);

  // ── the forge capability for the ONE platform (or the injected fake).
  // Composed BEFORE the credentials below: a GitHub composition's per-job
  // installation-token mint is one source of the worker credential path
  // (#1624).
  let forge: ControllerForgeCapability;
  let composedForge: ComposedForge | null = null;
  if (deps.forge !== undefined) {
    forge = deps.forge;
  } else {
    try {
      composedForge = composeForgeCapability({
        platform: startup.platform,
        endpoint: startup.forgeEndpoint,
        workspaceCacheRoot: startup.workspaceCacheRoot,
        ...(startup.platform === "github"
          ? {
              githubAppId: startup.githubAppId,
              githubAppPrivateKeyPem: startup.githubAppPrivateKeyPem,
              ...(startup.githubInstallationId !== ""
                ? { githubPollInstallationId: startup.githubInstallationId }
                : {}),
            }
          : { forgejoToken: startup.forgejoToken }),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });
      forge = composedForge.capability;
    } catch (error) {
      diagnostic(errorMessage(error));
      await closePool(pool);
      return 1;
    }
  }

  // ── #735 credentials: one vault seeded from the env-provided model
  //    material, and one plan registry behind the two seams (the daemon
  //    plans opaque references through `credentialRefs`; the Kubernetes
  //    executor resolves THAT plan late, through `resolver`). The follow-up
  //    answer lane reads the same startup map directly — it is controller-
  //    side, not a worker handoff. The evidence default may be "" ("not
  //    configured", #1711): the plan seam documents the empty name as the
  //    no-evidence state and omits the evidence credential for it.
  const credentialVault = createModelCredentialVault({
    instance: startup.instance,
    // Credential scopes are FAMILY-scoped (#1682): a Gitea instance's
    // material carries the `forgejo` scope, the family every plan request
    // for this instance names.
    platform: forgeFamily(startup.platform),
    modelCredentialMaterial: startup.modelCredentialMaterial,
  });
  // A real GitHub composition serves the worker's `forge-publish` reads
  // through its per-job installation-token mint (#1624): the vault is
  // wrapped so a declared reference with no env material resolves from
  // the mint at LATE resolution. Every other composition (Forgejo, an
  // injected test fake) keeps the plain vault.
  const mintInstallationToken = composedForge?.mintInstallationToken;
  const credentialBroker = mintInstallationToken === undefined
    ? credentialVault
    : createGitHubPublishMintingBroker(
        credentialVault,
        mintInstallationToken,
        startup.instance.forges.map((entry) => entry.credential),
        (detail) => diagnostic(detail),
      );
  const credentialBinding = createWorkerCredentialBinding({
    instance: startup.instance,
    defaultModelProfile: startup.instance.defaultModelProfile,
    // "" = "not configured" (#1711): the plan seam carries the empty
    // evidence profile name and adds no evidence credential for it.
    defaultEvidenceProfile: startup.instance.defaultEvidenceProfile ?? "",
    broker: credentialBroker,
    onRefusal: diagnostic,
  });

  // ── executor bindings: `local` is the real #733 executor; `kubernetes`
  //    binds the REAL in-cluster API, constructed EAGERLY so a controller
  //    that is not running in a cluster refuses the profile at startup.
  let clusterApi: InClusterKubernetesApi | null = null;
  let clusterCredentials: InClusterCredentialStore | null = null;
  if (
    deps.executors?.kubernetes === undefined &&
    startup.instance.executorProfiles.some((profile) => profile.kind === "kubernetes")
  ) {
    try {
      clusterApi = new InClusterKubernetesApi();
      // The #735 projection path is part of the same fail-closed startup:
      // every credential-bearing request needs BOTH executor seams, so a
      // store that cannot reach the API refuses the profile here instead of
      // refusing every review at launch.
      clusterCredentials = new InClusterCredentialStore({
        initialNamespaces: startup.instance.executorProfiles.flatMap((profile) =>
          profile.kind === "kubernetes" && profile.kubernetes !== null
            ? [profile.kubernetes.namespace]
            : [],
        ),
        onSweepFailure: (message) => diagnostic(`credential sweep: ${message}`),
      });
    } catch (error) {
      clusterCredentials?.stopSweeper();
      diagnostic(
        `a kubernetes executor profile is configured but the controller is not running in a cluster: ${errorMessage(error)}`,
      );
      await closePool(pool);
      return 1;
    }
  }
  const executors: ExecutorBindings = {
    ...(deps.executors ?? {}),
    ...(deps.executors?.local === undefined
      ? {
          // The default local binding: the real executor over the
          // operator's fixed argv (the worker-image contract), with the
          // same #735 credential seam the Kubernetes binding takes — a
          // credential-bearing local execution is resolved late and
          // projected into the child environment, never launched
          // half-credentialed.
          local: (spec) => new LocalExecutor(spec, {
            credentialResolver: credentialBinding.resolver,
          }),
        }
      : {}),
    ...(deps.executors?.kubernetes === undefined && clusterApi !== null
      ? {
        kubernetes: (spec) => new KubernetesExecutor(spec, {
          api: clusterApi!,
          credentialResolver: credentialBinding.resolver,
          credentialStore: clusterCredentials!,
        }),
      }
      : {}),
  };

  // ── profile resolution: operator-approved names resolved from the
  //    instance config's defaults (repository config selects names only
  //    and can never supply infrastructure). Evidence may be "" ("not
  //    configured", #1711): the executor deliberately consumes no evidence
  //    config, so the empty name is the no-providers state, never an
  //    execution refusal (Action-mode parity).
  const defaultModel = startup.instance.defaultModelProfile;
  const defaultExecutor = startup.instance.defaultExecutorProfile!;
  const defaultEvidence = startup.instance.defaultEvidenceProfile ?? "";
  const resolveProfiles = async (_job: unknown): Promise<ExecutionProfiles> =>
    Object.freeze({ executor: defaultExecutor, model: defaultModel, evidence: defaultEvidence });

  // The run's worker credential references come from the binding composed
  // with the control plane above, so the durable plan and the late
  // resolution can never describe two different runs.

  // ── the webhook intake and the reconciliation schedule.
  let webhook: DaemonWebhook | undefined;
  if (startup.webhook !== null) {
    // The follow-up lane's forge adapter: the composed platform adapter,
    // or the injected fake. Nothing composable is a startup refusal — the
    // intake is never served half-wired.
    const followUpAdapter = deps.followUpAdapter ?? composedForge?.followUp;
    const botLogin = deps.followUpBotLogin ?? composedForge?.botLogin;
    if (followUpAdapter === undefined) {
      diagnostic("a webhook intake is configured but no follow-up forge adapter could be composed");
      await closePool(pool);
      return 1;
    }
    let answer: (prompt: string) => Promise<string>;
    if (deps.followUpAnswer !== undefined) {
      answer = deps.followUpAnswer;
    } else {
      const modelProfile = startup.instance.modelProfiles.find((entry) => entry.name === defaultModel) as
        | ModelProfile
        | undefined;
      const material = modelProfile === undefined ? "" : (startup.modelCredentialMaterial.get(modelProfile.credential) ?? "");
      answer = createFollowUpAnswerExecutor({
        baseUrl: modelProfile?.endpoint ?? "",
        // Disabled unless the operator names a model id: the executor's
        // documented empty-model behavior returns "" without a call, and
        // the planner fails closed on an empty answer.
        model: startup.followUpModel,
        apiFormat: (modelProfile?.apiFormat ?? "openai") as ApiFormat,
        apiKey: material,
        reasoningEffort: "",
        anthropicEffortSupported: false,
        requestTimeoutSec: 60,
        connectTimeoutSec: 10,
      });
    }
    webhook = {
      platform: startup.platform,
      port: startup.webhook.port,
      secret: startup.webhook.secret,
      followUp: {
        adapter: followUpAdapter,
        // An unprovable bot identity fails closed inside the consumer's
        // own guards; the composition never guesses one.
        botLogin: botLogin ?? (async () => null),
        clock: now,
        rereviewCommand: "/ai-review",
        mentionHandles: startup.followUpMentions,
        answer,
      },
    };
  }

  // The schedule binds the daemon's canonical `poll` composition (#1446),
  // NEVER an operator `run` (#1718). The intake mints every job with a
  // PER-EVENT identity (adoption epoch, config fingerprint, bound
  // integration) resolved through `resolveIntakeBuildOptions`; no
  // operator-side build options can mirror it, and a `run` passing its own
  // (here: empty) options minted a SECOND generation of every head the
  // webhook already claimed — the live #1718 failure where the poll
  // scheduled nothing that converged. With `poll` the daemon drives
  // `reconcileRepositories` against its OWN context, so there is no
  // operator callback that can drop the identity.
  const reconcile: DaemonReconcile | undefined = startup.reconcile === null
    ? undefined
    : {
        intervalMs: startup.reconcile.intervalMs,
        // The daemon hashes the FAMILY identity itself (#1682): a Gitea
        // instance's poll mints what its own intake mints for the same head.
        platform: startup.platform,
        poll: {
          // The poll's installation identity rides the canonical event into
          // the minted job (#1624): the reconciler authenticates and
          // list-opens AS the configured App installation, so the job's
          // late forge-publish resolution must mint for THAT installation.
          // A poll event minted without it carries `installationId: ""`,
          // and the minting broker refuses the whole worker credential
          // set — the exact GitHub self-hosted path this wiring unlocks.
          ...(startup.githubInstallationId !== ""
            ? { installationId: startup.githubInstallationId }
            : {}),
          listOpenPullRequests: (repo) =>
            composedForge === null
              ? Promise.resolve({ ok: false as const, error: "no reconcile lister is bound" })
              : composedForge.listOpenPullRequests(repo),
          repos: startup.reconcile.repos,
          // #1718: the report is never discarded. See
          // `reconcileReportDiagnostics` for the silence rule and what each
          // line may carry.
          onReport: (report) => {
            try {
              for (const line of reconcileReportDiagnostics(report)) diagnostic(line);
            } catch {
              // observability only: a broken diagnostic must never stop the
              // reconciliation schedule.
            }
          },
        },
      };

  // ── the daemon. Any construction failure is a startup refusal.
  let daemon: ControllerDaemon;
  try {
    daemon = await startControllerDaemon({
      instance: startup.instance,
      controlPlane,
      ...(migrate !== undefined ? { migrate } : {}),
      ...(queueSnapshotStore !== undefined ? { queueSnapshotStore } : {}),
      durableStateDir: startup.durableStateDir,
      runsRoot: startup.runsRoot,
      workspaceCacheRoot: startup.workspaceCacheRoot,
      forge,
      resolveProfiles,
      credentialRefs: credentialBinding.credentialRefs,
      executors,
      ...(deps.createWorkspace !== undefined ? { createWorkspace: deps.createWorkspace } : {}),
      // #1723: the App installation identity repairs a webhook delivery that
      // omitted `installation.id` — the same identity the poll mints with.
      ...(startup.githubInstallationId !== ""
        ? { githubInstallationId: startup.githubInstallationId }
        : {}),
      ...(webhook !== undefined ? { webhook } : {}),
      ...(reconcile !== undefined ? { reconcile } : {}),
      now,
    });
  } catch (error) {
    diagnostic(`the controller daemon failed to start: ${errorMessage(error)}`);
    await closePool(pool);
    return 1;
  }
  // ── the admin listener (#737): never unauthenticated, never shared with
  //    the webhook intake (the normative listener boundary).
  let adminServer: Server | null = null;
  if (startup.admin !== null) {
    try {
      mkdirSync(startup.durableStateDir, { recursive: true, mode: 0o700 });
      const auditPath = join(startup.durableStateDir, AUDIT_LEDGER_FILENAME);
      // The ledger file is created 0600 once; appends keep the mode.
      // Exclusive create (`wx`) is the race-free shape: an existing file
      // is left untouched (EEXIST), a missing one is created with the
      // mode in the same atomic step — never stat-then-create.
      try {
        closeSync(openSync(auditPath, "wx", 0o600));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const adminHost = createAdminHost({
        deps: createAdminDeps({
          store: controlPlane,
          daemon,
          instance: startup.instance,
          platform: startup.platform,
          auditPath,
        }),
        token: startup.admin.token,
        ...(startup.admin.dashboard ? { dashboard: {} } : {}),
        nowMs: now,
      });
      adminServer = createServer(adminHost.handler);
      await new Promise<void>((resolve, reject) => {
        const server = adminServer!;
        // The bind-failure handler is scoped to the listen attempt: once
        // the listener is up, a later runtime error surfaces through the
        // process's own diagnostics instead of a reject nobody awaits.
        const listenError = (error: Error): void => reject(error);
        server.once("error", listenError);
        server.listen(startup.admin!.port, startup.admin!.bind, () => {
          server.removeListener("error", listenError);
          resolve();
        });
      });
    } catch (error) {
      diagnostic(`the admin listener failed to start: ${errorMessage(error)}`);
      await gracefulStop(daemon, adminServer, pool, clusterCredentials);
      return 1;
    }
  }

  // ── bounded, secret-free startup summary (stderr is diagnostics; never
  //    the DSN, never a token, never a secret).
  process.stderr.write(
    `controller: platform=${startup.platform} executors=${startup.instance.executorProfiles.length}` +
      ` models=${startup.instance.modelProfiles.length}` +
      ` webhook=${startup.webhook === null ? "off" : String(startup.webhook.port)}` +
      // The canonical intake route (#1682): the path an operator points the
      // forge webhook at. Empty when the platform has no route (the GitHub
      // App intake is path-agnostic) — never a guess.
      ` route=${daemon.intakeRoute}` +
      ` admin=${startup.admin === null ? "off" : String(startup.admin.port)}` +
      ` dashboard=${startup.admin !== null && startup.admin.dashboard ? "on" : "off"}` +
      ` reconcile=${startup.reconcile === null ? "off" : String(startup.reconcile.intervalMs)}\n`,
  );

  // ── lifecycle: the first stop wins; signals drive it in production and
  //    `handle.stop()` drives it in tests. The returned code is the exit.
  let stopRequested = false;
  let shutdownResolve: ((code: number) => void) | null = null;
  const shutdownPromise = new Promise<number>((resolve) => {
    shutdownResolve = resolve;
  });
  let stoppedResult: number | null = null;
  const stop = async (exitCode: number): Promise<number> => {
    if (stopRequested && stoppedResult !== null) return stoppedResult;
    const firstStop = !stopRequested;
    stopRequested = true;
    if (firstStop) {
      stoppedResult = await gracefulStop(daemon, adminServer, pool, clusterCredentials, exitCode);
      shutdownResolve?.(stoppedResult);
    }
    return stoppedResult ?? exitCode;
  };
  const handle: ControllerMainHandle = {
    daemon,
    stop: () => stop(0),
  };
  const onSignal = (): void => {
    void stop(0).catch(() => undefined);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  deps.onReady?.(handle);
  const exitCode = await shutdownPromise;
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  return exitCode;
}

/** Graceful stop: drain the daemon, close the listeners, stop the credential
 * sweeper, end the pool. Resolves with the exit code (1 when the drain itself
 * failed).
 *
 * Stopping the sweeper AFTER the drain is deliberate: every settled run's
 * material is already deleted by the executor, and the annotations the store
 * wrote are the cluster-side bound that survives this process either way. */
async function gracefulStop(
  daemon: ControllerDaemon,
  adminServer: Server | null,
  pool: Pool | null,
  credentialStore: InClusterCredentialStore | null = null,
  exitCode = 0,
): Promise<number> {
  let code = exitCode;
  try {
    await daemon.stop();
  } catch (error) {
    diagnostic(`the controller drain failed: ${errorMessage(error)}`);
    code = 1;
  }
  if (adminServer !== null) {
    await new Promise<void>((resolve) => adminServer!.close(() => resolve()));
  }
  credentialStore?.stopSweeper();
  await closePool(pool);
  return code;
}
