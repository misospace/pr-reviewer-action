/** The daemon's execution composition (#1348): how a dispatched
 * `JobRecord` becomes an `ExecutionRequest` a worker can run, and how an
 * operator's executor profile becomes an `Executor` instance.
 *
 * `docs/architecture/executor-boundary.md` fixes the division of labor:
 * "the host supplies a `QueueRequestBuilder` (composing acquisition
 * workspaces, effective-config profile resolution, and credential
 * references)". This module IS that host-side composition — the last
 * unwired seam between the #731 queue and the #733 executor boundary. It
 * owns no policy of its own: workspaces come from #732 acquisition, the
 * profile names come from the operator-approved effective config, and the
 * credential entries are opaque #735 references — material never crosses
 * this boundary, and no repository-controlled value can reach a command,
 * an image, an argv element, or an environment key.
 *
 * The run-directory layout is a CONTRACT, not a convenience:
 * `<runsRoot>/<jobId>/<attempt>/` holds `request.json` (the executor's
 * correlation envelope) and `result.json` (the worker's structured result).
 * The durable publisher (#1348, `./publication.ts`) re-derives the result
 * path from the same layout so a publish retry after a controller restart
 * can find the artifact without rerunning the model — the layout must
 * therefore never change shape without migrating durable state.
 *
 * Workspace ownership follows #732: the executor receives only
 * `WorkspaceInfo`; the `WorkspaceHandle.close()` obligation belongs to the
 * daemon, which releases each attempt's workspace once the executor seam
 * has settled it (`releaseWorkspace`). The builder registers every handle
 * it hands out; release is idempotent and a no-op for an unknown key.
 */

import { isAbsolute, join } from "node:path";
import {
  createReviewWorkspace,
  type MirrorCache,
  type WorkspaceHandle,
  type WorkspaceInfo,
  type WorkspaceRequest,
} from "../acquisition/index.js";
import type { InstanceConfig } from "../config/instance-config.js";
import { isSecretShapedValue } from "../credentials/types.js";
import type { CredentialRef } from "../credentials/types.js";
import {
  LocalExecutor,
  EXECUTION_ID_RE,
  validateExecutionRequest,
  type ExecutionCredentialRef,
  type ExecutionProfiles,
  type ExecutionRequest,
  type Executor,
} from "../executor/index.js";
import type {
  KubernetesExecutorSpec,
  LocalExecutorSpec,
} from "../config/instance-config.js";
import type { JobRecord } from "../queue/types.js";
import type { ReviewJob } from "../jobs/types.js";

/** The fixed request-envelope file name inside an attempt's run dir. */
export const EXECUTION_REQUEST_FILENAME = "request.json";

/** The fixed worker-result file name inside an attempt's run dir. */
export const EXECUTION_RESULT_FILENAME = "result.json";

function requireAbsoluteRoot(value: string, label: string): void {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
    throw new RangeError(`${label} must be an absolute path`);
  }
}

/** The identity grammar the run-dir layout relies on: a jobId that does
 * not match it can never become a safe path component (and the executor
 * contract itself refuses it). */
function requireExecutionId(value: string, label: string): void {
  if (typeof value !== "string" || !EXECUTION_ID_RE.test(value)) {
    throw new RangeError(`${label} must match ${EXECUTION_ID_RE.source}`);
  }
}

/** The controller-owned run directory for one execution attempt. */
export function executionRunDir(runsRoot: string, jobId: string, attempt: number): string {
  requireAbsoluteRoot(runsRoot, "runsRoot");
  requireExecutionId(jobId, "jobId");
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1, got ${String(attempt)}`);
  }
  const runDir = join(runsRoot, jobId, String(attempt));
  // Belt and braces: the grammar-checked jobId can never traverse, but the
  // layout refuses to hand out a path that is not lexically inside the
  // runs root whatever the inputs were.
  if (!runDir.startsWith(`${runsRoot}/`)) {
    throw new RangeError("runsRoot layout escape refused");
  }
  return runDir;
}

/** The request-envelope path the executor serializes BEFORE launch. */
export function executionRequestPath(runsRoot: string, jobId: string, attempt: number): string {
  return join(executionRunDir(runsRoot, jobId, attempt), EXECUTION_REQUEST_FILENAME);
}

/** The result-file coordinate the worker writes its structured result to.
 * The durable publisher re-derives this path on every retry — this layout
 * is the no-rerun publish contract. */
export function executionResultPath(runsRoot: string, jobId: string, attempt: number): string {
  return join(executionRunDir(runsRoot, jobId, attempt), EXECUTION_RESULT_FILENAME);
}

/** Correlation identity for ONE attempt of a job generation: the job's
 * deterministic generation id plus the 1-based attempt number. Two
 * attempts of one generation must never share a run id (collect, cancel,
 * and reconcile are keyed by it). */
export function executionRunId(jobId: string, attempt: number): string {
  return `${jobId}-a${attempt}`;
}

/** Daemon-side dependencies the composition cannot infer. Every injected
 * seam is trusted operator configuration or derived from it. */
export interface RequestBuilderDeps {
  /** Absolute controller-owned root for per-attempt run directories. */
  readonly runsRoot: string;
  /** The mirror cache serving this job's repository (#732). */
  mirrorFor(job: ReviewJob): Promise<MirrorCache>;
  /** Approved profile NAMES for this run, resolved from the operator's
   * effective config — never infrastructure, never repository-derived. */
  resolveProfiles(job: ReviewJob): Promise<ExecutionProfiles>;
  /** Opaque credential REFERENCES for the run's worker plan (#735) —
   * references only; the broker resolves material at the final handoff. */
  credentialRefs(job: ReviewJob, runId: string): Promise<readonly CredentialRef[]>;
  /** Workspace extraction seam; defaults to `createReviewWorkspace` (#732).
   * Injected by tests so the composition is testable without real git. */
  createWorkspace?: (
    mirror: MirrorCache,
    request: WorkspaceRequest,
  ) => Promise<WorkspaceHandle>;
}

/** The builder the daemon hands to `toQueueJobExecutor`, plus the
 * workspace-release obligation it retains. */
export interface ControllerRequestBuilder {
  /** The `QueueRequestBuilder` seam. */
  build(record: JobRecord): Promise<ExecutionRequest>;
  /** Close the workspace handle created for one attempt. Idempotent; a
   * no-op for an unknown key. */
  releaseWorkspace(jobId: string, attempt: number): Promise<void>;
}

/** Compose the daemon's execution requests from dispatched job records. */
export function createControllerRequestBuilder(deps: RequestBuilderDeps): ControllerRequestBuilder {
  if (deps === null || typeof deps !== "object") {
    throw new TypeError("RequestBuilderDeps must be an object");
  }
  requireAbsoluteRoot(deps.runsRoot, "RequestBuilderDeps.runsRoot");
  if (typeof deps.mirrorFor !== "function") {
    throw new TypeError("RequestBuilderDeps.mirrorFor must be a function");
  }
  if (typeof deps.resolveProfiles !== "function") {
    throw new TypeError("RequestBuilderDeps.resolveProfiles must be a function");
  }
  if (typeof deps.credentialRefs !== "function") {
    throw new TypeError("RequestBuilderDeps.credentialRefs must be a function");
  }
  const createWorkspace = deps.createWorkspace ?? createReviewWorkspace;
  const workspaces = new Map<string, WorkspaceHandle>();

  return {
    async build(record: JobRecord): Promise<ExecutionRequest> {
      if (record === null || typeof record !== "object" || typeof record.job !== "object") {
        throw new RangeError("build: record must be a JobRecord");
      }
      const job: ReviewJob = record.job;
      const attempt = record.attempt;
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new RangeError(
          `build: record.attempt must be an integer >= 1, got ${String(attempt)}`,
        );
      }
      const runId = executionRunId(job.jobId, attempt);
      const runDir = executionRunDir(deps.runsRoot, job.jobId, attempt);
      const requestPath = join(runDir, EXECUTION_REQUEST_FILENAME);
      const resultPath = join(runDir, EXECUTION_RESULT_FILENAME);
      const mirror = await deps.mirrorFor(job);
      const handle = await createWorkspace(mirror, {
        headSha: job.headSha,
        baseSha: job.baseSha,
      });
      workspaces.set(`${job.jobId}#${attempt}`, handle);
      const info: WorkspaceInfo = handle.info;
      const profiles = await deps.resolveProfiles(job);
      const refs = await deps.credentialRefs(job, runId);
      // The reference field is an opaque handle (#735): an operator who
      // pasted material into it must fail at composition time, before the
      // value can ride the durable request envelope.
      for (const ref of refs) {
        if (isSecretShapedValue(ref.reference)) {
          throw new RangeError(
            `credential reference '${ref.name}' looks like secret material, not an opaque reference`,
          );
        }
      }
      const credentials: readonly ExecutionCredentialRef[] = refs.map((ref) => {
        const credential: ExecutionCredentialRef = Object.freeze({
          name: ref.name,
          reference: ref.reference,
        });
        return credential;
      });
      const request: ExecutionRequest = Object.freeze({
        jobId: job.jobId,
        runId,
        attempt,
        kind: job.kind,
        platform: job.platform,
        repoFullName: job.repoFullName,
        prNumber: job.prNumber,
        headSha: job.headSha,
        baseSha: job.baseSha,
        deadlineAtMs: job.deadlineAtMs,
        workspace: info,
        profiles,
        credentials,
        runDir,
        requestPath,
        resultPath,
      });
      // Fail closed at the boundary: a malformed composition is a builder
      // rejection (the scheduler's failed-outcome path), never a launch.
      return validateExecutionRequest(request);
    },
    async releaseWorkspace(jobId: string, attempt: number): Promise<void> {
      const key = `${jobId}#${attempt}`;
      const handle = workspaces.get(key);
      if (handle === undefined) return;
      workspaces.delete(key);
      await handle.close();
    },
  };
}

/** Bound per-executor-kind factories the selector uses to construct (or
 * test-double) the concrete executors. Kubernetes bindings are REQUIRED
 * when any kubernetes profile exists: the daemon injects the real
 * `KubernetesApi` and credential seams — a cluster executor without its
 * seams is not constructible, so the composition refuses instead of
 * launching an executor that cannot work. */
export interface ExecutorSelectorOptions {
  readonly instance: InstanceConfig;
  /** Override for `kind: "local"` profiles (tests). */
  readonly local?: (spec: LocalExecutorSpec, profileName: string) => Executor;
  /** REQUIRED binding for `kind: "kubernetes"` profiles: constructs the
   * executor from the profile spec plus the daemon-bound cluster seams. */
  readonly kubernetes?: (spec: KubernetesExecutorSpec, profileName: string) => Executor;
}

/** The profile→executor mapping the daemon dispatches through, plus the
 * fan-out surface recovery needs (reconcile/cancel by correlation
 * identity must be able to reach every backend the daemon constructed). */
export interface ExecutorSelector {
  /** The executor instance for one approved profile name (cached per
   * name). Fails closed on an unknown/unwired profile. */
  forProfile(profileName: string): Executor;
  /** Every executor instance this selector constructed. */
  all(): readonly Executor[];
}

/** Map the operator's executor profiles to `Executor` instances, one per
 * profile name, cached so every dispatch of a profile shares the executor
 * (and its in-flight run bookkeeping). Fail closed: an `oci` profile has
 * no shipped executor implementation yet — the composition refuses to
 * start with one rather than launching an executor that cannot exist, and
 * an unknown profile name refuses at dispatch time. */
export function createExecutorSelector(options: ExecutorSelectorOptions): ExecutorSelector {
  if (options === null || typeof options !== "object") {
    throw new TypeError("ExecutorSelectorOptions must be an object");
  }
  const instance = options.instance;
  if (instance === null || typeof instance !== "object") {
    throw new TypeError("ExecutorSelectorOptions.instance must be an InstanceConfig");
  }
  const cache = new Map<string, Executor>();
  const forProfile = (profileName: string): Executor => {
    const cached = cache.get(profileName);
    if (cached !== undefined) return cached;
    const profile = instance.executorProfiles.find((entry) => entry.name === profileName);
    if (profile === undefined) {
      throw new RangeError(
        `executor profile '${profileName}' is not defined in the instance config`,
      );
    }
    let executor: Executor;
    if (profile.kind === "local") {
      if (profile.local === null) {
        throw new RangeError(`executor profile '${profileName}' carries no local spec`);
      }
      executor = options.local !== undefined
        ? options.local(profile.local, profileName)
        : new LocalExecutor(profile.local);
    } else if (profile.kind === "kubernetes") {
      if (profile.kubernetes === null) {
        throw new RangeError(`executor profile '${profileName}' carries no kubernetes spec`);
      }
      if (options.kubernetes === undefined) {
        throw new RangeError(
          `executor profile '${profileName}' is a kubernetes profile but the daemon has no cluster executor binding`,
        );
      }
      executor = options.kubernetes(profile.kubernetes, profileName);
    } else {
      // The instance-config schema admits `kind: "oci"`, but no executor
      // implementation ships for it yet (#733 shipped local + kubernetes).
      // Fail closed at selection instead of launching nothing.
      throw new RangeError(
        `executor profile '${profileName}' has kind '${profile.kind}': no executor implementation is wired for it in this composition`,
      );
    }
    cache.set(profileName, executor);
    return executor;
  };
  return {
    forProfile,
    all: () => [...cache.values()],
  };
}
