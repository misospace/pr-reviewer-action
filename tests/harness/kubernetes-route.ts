/** Route D's driver for the self-hosted qualification harness (#1484).
 *
 * The REAL Kubernetes executor (`src/executor/kubernetes.ts`) reviews the
 * SAME parity head as the other parity routes, over the SAME worker
 * image. The harness has no Kubernetes cluster, so the CLUSTER side is a
 * harness-owned double: this file implements the two seams the executor
 * injects and does nothing else:
 *
 * - `KubernetesApi` (createJob/getJob/deleteJob/listJobs): a Job becomes
 *   a `docker run` of the manifest's own container, and the polling
 *   surface reports the launch's own lifecycle.
 * - `KubernetesCredentialStore` (putSecret/deleteSecret/listSecrets): the
 *   projected per-run material is held in process, so the executor's
 *   projection and teardown paths run unmodified.
 *
 * The #735 `WorkerCredentialResolver` seam resolves the request's
 * credential NAMES against the material the harness configures.
 *
 * Everything else is the production executor: the manifest building, the
 * envelope write, the credential projection, the job polling and the
 * result collection are the shipped code, so the route exercises the
 * executor's real path instead of a re-implementation of it.
 *
 * What the double is NOT — a scheduler, an admission controller, a
 * NetworkPolicy, a kubelet, or a secret store — is stated in
 * docs/self-hosted-qualification.md, which is where the route's scope
 * and its limits are recorded. The manifest's resource requests and
 * limits are carried into the manifest the executor builds, but the
 * double does not enforce them: a cluster does.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import {
  KubernetesExecutor,
  type KubernetesApi,
  type KubernetesContainerEnv,
  type KubernetesCredentialSecret,
  type KubernetesCredentialSecretSummary,
  type KubernetesCredentialStore,
  type KubernetesJobManifest,
  type KubernetesJobStatus,
  type KubernetesJobSummary,
} from "../../src/executor/kubernetes.js";
import { EXECUTION_REQUEST_ENV_KEY, EXECUTION_RESULT_ENV_KEY } from "../../src/executor/local.js";
import {
  validateExecutionRequest,
  type ExecutionRequest,
  type WorkerCredentialResolution,
  type WorkerCredentialResolver,
} from "../../src/executor/types.js";
import type { KubernetesExecutorSpec } from "../../src/config/instance-config.js";

/** How often the executor's poll loop asks the seam for the Job's state.
 * Short enough that a settled worker is observed promptly, long enough
 * that the poll is not a busy loop. */
const POLL_MS = 250;

/** The one-line summary the harness reads: the settled verdict, the head
 * the worker verified, the artifact the review produced, and whether the
 * double had to stand in for the shared claim's permission model. */
interface RouteSummary {
  readonly status: string;
  readonly resultHeadSha: string;
  readonly failureCategory: string;
  readonly failureMessage: string;
  readonly artifactPath: string;
  readonly sharedClaimRelaxed: boolean;
}

/** The harness-owned configuration of the route: the operator's deployment
 * facts (the image, the argv prefix, the namespace, the service account,
 * the TTL, the resources, the volume mappings) and the material the
 * credential resolver hands the worker. */
interface RouteConfig {
  readonly image: string;
  readonly args: readonly string[];
  readonly namespace: string;
  readonly serviceAccount: string;
  readonly ttlSecondsAfterFinished: number;
  readonly resources: KubernetesExecutorSpec["resources"];
  readonly volumes: KubernetesExecutorSpec["volumes"];
  readonly credentialMaterial: Readonly<Record<string, string>>;
}

/** One launched Job: the manifest it was created from and the container
 * process that backs it. */
interface JobRecord {
  readonly manifest: KubernetesJobManifest;
  readonly child: ChildProcess;
  /** The container's own exit, once it happened; null while it runs. */
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  /** Why the launch failed before the container ran, when it did. */
  launchFailure: string;
}

/** Exact label-selector semantics, the seam's contract: an object is in
 * scope only when its own labels carry EVERY key/value pair of the
 * requested selector. */
function matchesSelector(
  labels: Readonly<Record<string, string>>,
  selector: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

/** The harness's double of the per-run credential Secret: the projected
 * material, held in process for the lifetime of the projection. */
class ProjectedSecretStore implements KubernetesCredentialStore {
  private readonly secrets = new Map<
    string,
    { readonly labels: Readonly<Record<string, string>>; readonly material: Map<string, string> }
  >();

  async putSecret(secret: KubernetesCredentialSecret): Promise<void> {
    const material = new Map<string, string>();
    for (const credential of secret.credentials) {
      material.set(credential.name, credential.value);
    }
    this.secrets.set(secret.name, { labels: secret.labels, material });
  }

  async deleteSecret(_namespace: string, name: string): Promise<void> {
    this.secrets.delete(name);
  }

  async listSecrets(
    _namespace: string,
    labelSelector: Readonly<Record<string, string>>,
  ): Promise<readonly KubernetesCredentialSecretSummary[]> {
    const summaries: KubernetesCredentialSecretSummary[] = [];
    for (const [name, secret] of this.secrets) {
      if (!matchesSelector(secret.labels, labelSelector)) continue;
      summaries.push({ name, labels: secret.labels });
    }
    return summaries;
  }

  /** The material of one projected key, or undefined when the Secret does
   * not carry it (a manifest that references a key nobody projected). */
  material(secretName: string, key: string): string | undefined {
    return this.secrets.get(secretName)?.material.get(key);
  }
}

/** The #735 resolution seam, bound to the harness's own material: the
 * request's credential NAMES decide what is resolved, and a name the
 * harness holds no material for is REFUSED (never half-credentialed). */
class HarnessCredentialResolver implements WorkerCredentialResolver {
  constructor(private readonly material: Readonly<Record<string, string>>) {}

  async resolve(request: ExecutionRequest): Promise<WorkerCredentialResolution> {
    const credentials: { name: string; value: string }[] = [];
    for (const reference of request.credentials) {
      const value = this.material[reference.name];
      if (value === undefined || value === "") {
        return {
          ok: false,
          code: "unknown_reference",
          reason: `the harness holds no material for the credential '${reference.name}'`,
        };
      }
      credentials.push({ name: reference.name, value });
    }
    return { ok: true, credentials };
  }
}

/** The harness's double of the cluster: the executor's Job surface, bound
 * to a docker launcher.
 *
 * The double implements the SHARED-CLAIM model a real deployment gets
 * from the cluster: the controller and the worker reach the same volume,
 * and both sides can read what the other side wrote. The executor writes
 * the envelope 0600 and the worker writes the result 0600, so the double
 * relaxes the two shared files around the launch — the envelope becomes
 * readable for the worker's uid, and the result file is pre-created
 * writable so the controller can read it back. The shipped chart does not
 * give the controller (uid 1000) and the worker pod (uid 65532) a claim
 * they can both read, so that relaxation is a stand-in the route reports
 * rather than a property the deployment has today (issue #1631). */
class DockerClusterDouble implements KubernetesApi {
  private readonly jobs = new Map<string, JobRecord>();
  /** Whether the double had to relax the shared claim's file permissions:
   * the controller writes the envelope 0600 as its own uid and the worker
   * writes the result 0600 as the pod's uid, so a claim both sides can
   * read had to be stood in for. The flag keeps that visible in the
   * route's own report instead of hiding it. */
  private sharedClaimRelaxed = false;

  constructor(private readonly store: ProjectedSecretStore) {}

  /** True when the double stood in for the shared claim's permissions. */
  get claimRelaxed(): boolean {
    return this.sharedClaimRelaxed;
  }

  async createJob(manifest: KubernetesJobManifest): Promise<"created" | "already-exists"> {
    if (this.jobs.has(manifest.name)) return "already-exists";
    const container = manifest.pod.containers[0];
    const argv: string[] = ["run", "--rm", "--network", "host"];
    // The pod's own identity: the executor pins the worker to a
    // dedicated non-root uid/gid, and the container runs as exactly that
    // identity so the route exercises the same one a cluster would.
    argv.push(
      "--user",
      `${manifest.pod.securityContext.runAsUser}:${manifest.pod.securityContext.runAsGroup}`,
    );
    for (const mount of container.volumeMounts) {
      // The claim is mounted at the SAME absolute path on both sides: the
      // envelope carries the controller's own coordinates, so a renamed
      // path would break the worker's request and result paths.
      argv.push("-v", `${mount.mountPath}:${mount.mountPath}`);
    }
    const env: NodeJS.ProcessEnv = {
      // The launcher gets an ALLOWLIST, never the harness's whole
      // environment: the operator's model key, the forge token and the
      // GitHub App material stay out of the process that starts the
      // container, exactly as the local executor's child environment
      // carries only its coordination variables and the projected
      // credentials.
      PATH: process.env["PATH"] ?? "",
      TMPDIR: process.env["TMPDIR"] ?? "",
    };
    for (const entry of container.env) {
      if ("value" in entry) {
        argv.push("-e", `${entry.name}=${entry.value}`);
        continue;
      }
      const reference = entry.valueFrom.secretKeyRef;
      const material = this.store.material(reference.name, reference.key);
      if (material === undefined) {
        throw new Error(
          `the projected credential secret carries no key '${reference.key}'`,
        );
      }
      // The material travels through the client environment only: the
      // docker argv names the variable, never its value.
      env[entry.name] = material;
      argv.push("-e", entry.name);
    }
    // The git safe.directory pin the other parity routes use: the
    // workspace belongs to the harness's user while the worker runs as
    // the executor's pinned uid, and git refuses a repository owned by
    // another user.
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "safe.directory";
    env["GIT_CONFIG_VALUE_0"] = "*";
    argv.push(
      "-e",
      "GIT_CONFIG_COUNT",
      "-e",
      "GIT_CONFIG_KEY_0",
      "-e",
      "GIT_CONFIG_VALUE_0",
    );
    argv.push(container.image, ...container.args);
    await this.sharedClaimPermissions(container.env);
    const child = spawn("docker", argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    const record: JobRecord = { manifest, child, exit: null, launchFailure: "" };
    this.jobs.set(manifest.name, record);
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", (error: Error) => {
      record.launchFailure = `the container launcher could not start: ${error.message}`;
      record.exit = { code: null, signal: null };
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      record.exit = { code, signal };
    });
    return "created";
  }

  async getJob(_namespace: string, name: string): Promise<KubernetesJobStatus | null> {
    const record = this.jobs.get(name);
    if (record === undefined) return null;
    if (record.exit === null) {
      return { active: true, succeeded: false, failed: false, failureReason: "" };
    }
    if (record.exit.code === 0) {
      return { active: false, succeeded: true, failed: false, failureReason: "" };
    }
    // A launcher that never started the container names its own reason; a
    // container that ran and failed has no cluster-side reason to report,
    // and the executor's own wording covers it.
    return {
      active: false,
      succeeded: false,
      failed: true,
      failureReason: record.launchFailure,
    };
  }

  async deleteJob(_namespace: string, name: string): Promise<void> {
    const record = this.jobs.get(name);
    if (record === undefined || record.exit !== null) return;
    record.child.kill("SIGTERM");
  }

  async listJobs(
    namespace: string,
    labelSelector: Readonly<Record<string, string>>,
  ): Promise<readonly KubernetesJobSummary[]> {
    const summaries: KubernetesJobSummary[] = [];
    for (const [name, record] of this.jobs) {
      if (!matchesSelector(record.manifest.labels, labelSelector)) continue;
      const status = await this.getJob(namespace, name);
      if (status === null) continue;
      summaries.push({ name, labels: record.manifest.labels, status });
    }
    return summaries;
  }

  /** The shared claim's permission model: the envelope the controller
   * wrote becomes readable for the worker's uid, and the result file the
   * worker writes becomes readable for the controller. Both files live on
   * the one volume both sides mount. The relaxation is recorded only when
   * a mode actually had to change, so the flag reports whether the
   * stand-in was needed rather than that a launch happened. */
  private async sharedClaimPermissions(env: readonly KubernetesContainerEnv[]): Promise<void> {
    for (const entry of env) {
      if (!("value" in entry)) continue;
      if (entry.name === EXECUTION_REQUEST_ENV_KEY) {
        const mode = await fileMode(entry.value);
        if (mode !== null && (mode & 0o004) !== 0) continue;
        await chmod(entry.value, 0o644);
        this.sharedClaimRelaxed = true;
      }
      if (entry.name === EXECUTION_RESULT_ENV_KEY) {
        const mode = await fileMode(entry.value);
        if (mode === null) {
          await writeFile(entry.value, "", { flag: "a" });
          await chmod(entry.value, 0o666);
          this.sharedClaimRelaxed = true;
          continue;
        }
        if ((mode & 0o006) === 0o006) continue;
        await chmod(entry.value, mode | 0o006);
        this.sharedClaimRelaxed = true;
      }
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}

/** The permission bits of a file, or null when it does not exist. */
async function fileMode(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return stats.mode & 0o777;
  } catch {
    return null;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") fail(`${label} must be a non-empty string`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return value;
}

function requirePair(value: unknown, label: string): { cpu: string; memory: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be a mapping`);
  }
  const pair = value as Record<string, unknown>;
  return {
    cpu: requireString(pair["cpu"], `${label}.cpu`),
    memory: requireString(pair["memory"], `${label}.memory`),
  };
}

/** The harness's configuration, parsed fail-closed: a malformed config
 * never reaches the executor as a half-specified deployment. */
function parseConfig(raw: unknown): RouteConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("the route config must be a mapping");
  }
  const config = raw as Record<string, unknown>;
  const argsRaw = config["args"];
  if (!Array.isArray(argsRaw)) fail("config.args must be a list of argv strings");
  const args = argsRaw.map((entry, index) => requireString(entry, `config.args[${index}]`));
  const resourcesRaw = config["resources"];
  if (typeof resourcesRaw !== "object" || resourcesRaw === null || Array.isArray(resourcesRaw)) {
    fail("config.resources must be a mapping");
  }
  const resources = resourcesRaw as Record<string, unknown>;
  const volumesRaw = config["volumes"];
  if (!Array.isArray(volumesRaw) || volumesRaw.length === 0) {
    fail("config.volumes must list at least one volume mapping");
  }
  const volumes = volumesRaw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`config.volumes[${index}] must be a mapping`);
    }
    const mapping = entry as Record<string, unknown>;
    return {
      claim: requireString(mapping["claim"], `config.volumes[${index}].claim`),
      controllerRoot: requireString(
        mapping["controllerRoot"],
        `config.volumes[${index}].controllerRoot`,
      ),
    };
  });
  const materialRaw = config["credentialMaterial"];
  if (typeof materialRaw !== "object" || materialRaw === null || Array.isArray(materialRaw)) {
    fail("config.credentialMaterial must be a mapping of credential name to material");
  }
  const material: Record<string, string> = {};
  for (const [name, value] of Object.entries(materialRaw as Record<string, unknown>)) {
    material[name] = requireString(value, `config.credentialMaterial.${name}`);
  }
  return {
    image: requireString(config["image"], "config.image"),
    args,
    namespace: requireString(config["namespace"], "config.namespace"),
    serviceAccount: requireString(config["serviceAccount"], "config.serviceAccount"),
    ttlSecondsAfterFinished: requireInteger(
      config["ttlSecondsAfterFinished"],
      "config.ttlSecondsAfterFinished",
    ),
    resources: {
      requests: requirePair(resources["requests"], "config.resources.requests"),
      limits: requirePair(resources["limits"], "config.resources.limits"),
    },
    volumes,
    credentialMaterial: material,
  };
}

function parseArguments(argv: readonly string[]): { request: string; config: string } {
  let request = "";
  let config = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--request") {
      request = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--config") {
      config = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    fail(`unexpected argument '${argument}'`);
  }
  if (request === "" || config === "") {
    fail("the route needs --request <file> and --config <file>");
  }
  return { request, config };
}

function print(summary: RouteSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function main(): Promise<number> {
  const { request: requestPath, config: configPath } = parseArguments(process.argv.slice(2));
  const request = validateExecutionRequest(
    JSON.parse(await readFile(requestPath, "utf8")) as unknown,
  );
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const spec: KubernetesExecutorSpec = {
    image: config.image,
    args: config.args,
    namespace: config.namespace,
    serviceAccount: config.serviceAccount,
    ttlSecondsAfterFinished: config.ttlSecondsAfterFinished,
    resources: config.resources,
    volumes: config.volumes,
  };
  const store = new ProjectedSecretStore();
  const api = new DockerClusterDouble(store);
  const resolver = new HarnessCredentialResolver(config.credentialMaterial);
  const executor = new KubernetesExecutor(spec, {
    api,
    credentialResolver: resolver,
    credentialStore: store,
    pollMs: POLL_MS,
  });
  const controller = new AbortController();
  let result;
  try {
    const handle = await executor.start(request, controller.signal);
    result = await handle.collect();
  } catch (error) {
    print({
      status: "failed",
      resultHeadSha: "",
      failureCategory: "launch_refused",
      failureMessage: error instanceof Error ? error.message : String(error),
      artifactPath: "",
      sharedClaimRelaxed: api.claimRelaxed,
    });
    return 1;
  }
  print({
    status: result.status,
    resultHeadSha: result.resultHeadSha,
    failureCategory: result.failureCategory,
    failureMessage: result.failureMessage,
    artifactPath: result.resultArtifactPath,
    sharedClaimRelaxed: api.claimRelaxed,
  });
  return result.status === "completed" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    print({
      status: "failed",
      resultHeadSha: "",
      failureCategory: "launch_refused",
      failureMessage: error instanceof Error ? error.message : String(error),
      artifactPath: "",
      sharedClaimRelaxed: false,
    });
    process.exitCode = 1;
  },
);
