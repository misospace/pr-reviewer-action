/** Executor boundary for #733: how a controller hands one review run to a
 * worker and gets a structured result back.
 *
 * Operator-mode library (like `src/queue/` and `src/acquisition/`): a future
 * controller daemon (#736) imports it to run the review engine behind the
 * queue's `JobExecutor` seam. NOT wired into the Action runtime —
 * `action.yml` and the action pipeline are untouched.
 *
 * The boundary is deliberately narrow and correlation-first:
 *
 * - The **run id** is the correlation identity. Every handle, result, and
 *   reconciliation decision is keyed by it, so a controller restart can
 *   never mix two generations of the same job.
 * - The **result protocol is a file**, never stdout: the worker writes a
 *   structured result artifact at the path the executor hands it, and the
 *   executor validates that artifact against this module's contract before
 *   it believes a run completed. Captured stdout/stderr stay diagnostics —
 *   they are never parsed as a result.
 * - Everything fails closed: an execution that cannot be attributed to this
 *   request (missing, unparseable, or foreign result) is a failure with an
 *   explicit `ExecutionFailureCategory`, never a guessed success.
 *
 * Like `ReviewJob` and `JobRecord`, every contract field is required with an
 * explicit sentinel (""/0/false/null) instead of an optional, so consumers
 * never branch on `undefined`.
 */

import { hasControlCharacters } from "../config/instance-config.js";
import type { ReviewJobKind } from "../jobs/types.js";
import type { WorkspaceInfo } from "../acquisition/types.js";

/** Credential-reference name: lowercase kebab-case, bounded. */
export const EXECUTION_CREDENTIAL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** Credential-reference grammar: mirrors the instance-config
 * `CREDENTIAL_REF_RE` shape — the opaque token the #735 credential broker
 * resolves operator-side. */
export const EXECUTION_CREDENTIAL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Execution-id grammar: `jobId` and `runId` must match it — a bounded,
 * path/filename-safe identity (whitespace-only or control-bearing ids are
 * rejected). */
export const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Path-field bound: the longest absolute path a request or result may
 * name. */
const MAX_PATH_CHARS = 4_096;

/** Opaque, short-lived credential REFERENCE handed to the execution. Never
 * material: the #735 credential broker resolves references operator-side,
 * so no secret ever travels through this contract or into a request
 * envelope. */
export interface ExecutionCredentialRef {
  /** Bounded kebab-case key the worker uses to look the secret up. */
  readonly name: string;
  /** Opaque broker reference (never the secret itself). */
  readonly reference: string;
}

/** The approved profile NAMES an execution runs under. Names only —
 * repository config never carries infrastructure: what these names resolve
 * to (command, image, endpoint, credentials) is operator-side state. */
export interface ExecutionProfiles {
  readonly executor: string;
  readonly model: string;
  readonly evidence: string;
}

/** One execution request: the complete, self-contained description of the
 * run a worker performs. Frozen at construction; the envelope file the
 * executor writes embeds this object verbatim. */
export interface ExecutionRequest {
  /** Deterministic generation id (see `ReviewJob`). */
  readonly jobId: string;
  /** Correlation identity for THIS attempt's execution. Non-empty: handles,
   * results, and reconciliation are keyed by it, never by jobId alone
   * (two attempts of one job must never collect across generations). */
  readonly runId: string;
  /** 1-based attempt number within the job generation. */
  readonly attempt: number;
  readonly kind: ReviewJobKind;
  readonly platform: "github" | "forgejo";
  readonly repoFullName: string;
  /** 1-based PR/MR number. */
  readonly prNumber: number;
  /** Head the review is about; "" when the job kind carries none. */
  readonly headSha: string;
  /** Effective base/merge-base input; "" when not required. */
  readonly baseSha: string;
  /** Execution deadline in epoch ms; 0 = none. The executor turns a
   * non-zero deadline into the worker's whole-process timeout. */
  readonly deadlineAtMs: number;
  /** The isolated exact-head workspace the worker runs in (#732). */
  readonly workspace: WorkspaceInfo;
  /** Approved profile names (never infrastructure). */
  readonly profiles: ExecutionProfiles;
  /** Opaque short-lived credential references; empty when the run needs
   * none. Never material secrets. */
  readonly credentials: readonly ExecutionCredentialRef[];
  /** Controller-owned scratch directory for this execution (request and
   * result files live here). */
  readonly runDir: string;
  /** Path the executor writes the request envelope JSON to BEFORE launch —
   * the correlation source of truth. */
  readonly requestPath: string;
  /** Path the worker writes the structured result JSON to. This file —
   * never stdout — is the result protocol. */
  readonly resultPath: string;
}

/** Lifecycle phase of an in-flight execution. */
export type ExecutionPhase = "starting" | "running" | "terminal";

/** Point-in-time observation of an execution. */
export interface ExecutionStatusReport {
  readonly phase: ExecutionPhase;
  /** Terminal status; "" until the execution settles. */
  readonly status: "completed" | "failed" | "cancelled" | "";
  /** Epoch ms the report was observed at. */
  readonly observedAtMs: number;
}

/** Why an execution failed, closed union — infrastructure failure is
 * distinct from a review verdict, and verdicts never appear here:
 *
 * - `launch_refused` — the executor refused to launch (policy refusal,
 *   missing binary, pre-aborted signal): nothing ran.
 * - `deadline` — the whole-process deadline expired and the tree was
 *   terminated.
 * - `worker_crash` — the worker died to a signal it did not choose.
 * - `worker_error` — the worker exited non-zero.
 * - `no_result` — the worker exited 0 but left no verifiable result file.
 * - `stale_result` — a result file exists but belongs to another
 *   correlation identity; collecting it would mix generations.
 * - `orphaned` — the recorded worker is gone with no terminal state (found
 *   by post-restart reconciliation). */
export type ExecutionFailureCategory =
  | "launch_refused"
  | "deadline"
  | "worker_crash"
  | "worker_error"
  | "no_result"
  | "stale_result"
  | "orphaned";

/** The terminal outcome of one execution. Frozen at construction; the
 * FIRST terminal result for a correlation identity wins — a duplicate
 * result must never replace it. */
export interface ExecutionResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly runId: string;
  readonly jobId: string;
  /** Head the result was computed for; "" unless completed. */
  readonly resultHeadSha: string;
  /** Infrastructure failure category; "" unless failed. */
  readonly failureCategory: ExecutionFailureCategory | "";
  /** Bounded failure explanation; "" unless failed. */
  readonly failureMessage: string;
  /** Path of the worker's structured review-result artifact; "" unless
   * completed. The publication layer consumes this, not stdout. */
  readonly resultArtifactPath: string;
  /** Bounded diagnostics tail (stderr / exit info) — never the result
   * protocol. */
  readonly diagnostics: string;
  /** Additional artifacts the run produced (paths). */
  readonly artifactPaths: readonly string[];
  /** Wall-clock worker duration in ms; 0 = unavailable. */
  readonly resourceMs: number;
  /** Epoch ms the result was observed/settled at. */
  readonly observedAtMs: number;
}

/** Live view of one started execution.
 *
 * - `cancel` is idempotent and tree-terminates the worker.
 * - `collect` after terminal is idempotent: the FIRST terminal result wins
 *   and every later call returns that identical frozen object — a duplicate
 *   result (or a late re-classification) must never replace it. */
export interface ExecutionHandle {
  observe(): Promise<ExecutionStatusReport>;
  cancel(): Promise<void>;
  collect(): Promise<ExecutionResult>;
}

/** The tri-state answer `reconcile` gives for one correlation identity.
 * Frozen instances; the discrimination is explicit so "nothing was ever
 * found" (the caller may start fresh) can never be confused with "the
 * execution is still alive" (the caller retries later). */
export type ExecutionReconcileOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "running" }
  | { readonly kind: "settled"; readonly result: ExecutionResult };

/** The executor seam (#733). Implementations own launching, observing,
 * cancelling, and reconciling executions for the correlation identities the
 * controller hands them. `reconcile` is the crash-recovery path: after a
 * controller restart the controller asks whether an execution for a
 * request's correlation identity already exists — `none` means none was
 * found (the caller may start fresh), `running` means it is still alive
 * (the caller retries later), and `settled` carries the terminal result,
 * which MUST NOT be rerun. */
export interface Executor {
  start(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionHandle>;
  reconcile(request: ExecutionRequest): Promise<ExecutionReconcileOutcome>;
}

/** Fail-closed rejection for a structurally invalid execution request. */
export class ExecutionRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionRequestError";
  }
}

/** Fail-closed rejection for a structurally invalid execution result. */
export class ExecutionResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionResultError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireString(
  item: Record<string, unknown>,
  key: string,
  path: string,
  options: { nonEmpty?: boolean } = {},
): string {
  const value = item[key];
  if (typeof value !== "string") {
    throw new ExecutionRequestError(`${path}.${key} must be a string`);
  }
  if (options.nonEmpty && value === "") {
    throw new ExecutionRequestError(`${path}.${key} must be non-empty`);
  }
  return value;
}

function requireInteger(
  item: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
): number {
  const value = item[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ExecutionRequestError(`${path}.${key} must be an integer >= ${min}`);
  }
  return value;
}

function requireFiniteMs(
  item: Record<string, unknown>,
  key: string,
  path: string,
): number {
  const value = item[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ExecutionRequestError(`${path}.${key} must be a finite non-negative epoch-ms number`);
  }
  return value;
}

function rejectUnknownFields(
  item: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(item)) {
    if (!allowed.includes(key)) {
      throw new ExecutionRequestError(`${path}: unsupported field '${key}'`);
    }
  }
}

/** Shared strict path check: absolute, control-character-free, and bounded
 * in length. The executor hands these paths to the filesystem and the
 * child process verbatim. */
function requireStrictPath(value: string, path: string): void {
  if (!value.startsWith("/")) {
    throw new ExecutionRequestError(`${path} must be an absolute path`);
  }
  if (value.length > MAX_PATH_CHARS) {
    throw new ExecutionRequestError(`${path} must be at most ${MAX_PATH_CHARS} characters`);
  }
  if (hasControlCharacters(value)) {
    throw new ExecutionRequestError(`${path} must not contain control characters`);
  }
}

/** Lexical containment: `child` must live under `dir` (a path can escape
 * its run directory by string alone — no filesystem resolution needed to
 * reject it). Returns the problem description, or "" when contained. */
function lexicallyInsideProblem(child: string, dir: string, path: string): string {
  if (!child.startsWith(`${dir}/`)) {
    return `${path} must be inside runDir`;
  }
  const remainder = child.slice(dir.length + 1);
  if (remainder.split("/").includes("..")) {
    return `${path} must not contain '..' path segments`;
  }
  return "";
}

function validateWorkspaceShape(value: unknown, path: string): WorkspaceInfo {
  if (!isPlainObject(value)) {
    throw new ExecutionRequestError(`${path} must be a mapping`);
  }
  rejectUnknownFields(
    value,
    ["rootPath", "headSha", "mergeBaseSha", "platform", "repoFullName", "createdAtMs"],
    path,
  );
  const platform = value["platform"];
  if (platform !== "github" && platform !== "forgejo") {
    throw new ExecutionRequestError(`${path}.platform must be 'github' or 'forgejo'`);
  }
  const workspace: WorkspaceInfo = Object.freeze({
    rootPath: requireString(value, "rootPath", path, { nonEmpty: true }),
    headSha: requireString(value, "headSha", path, { nonEmpty: true }),
    mergeBaseSha: requireString(value, "mergeBaseSha", path),
    platform,
    repoFullName: requireString(value, "repoFullName", path, { nonEmpty: true }),
    createdAtMs: requireFiniteMs(value, "createdAtMs", path),
  });
  return workspace;
}

function validateProfilesShape(value: unknown, path: string): ExecutionProfiles {
  if (!isPlainObject(value)) {
    throw new ExecutionRequestError(`${path} must be a mapping`);
  }
  rejectUnknownFields(value, ["executor", "model", "evidence"], path);
  return Object.freeze({
    executor: requireString(value, "executor", path, { nonEmpty: true }),
    model: requireString(value, "model", path, { nonEmpty: true }),
    evidence: requireString(value, "evidence", path, { nonEmpty: true }),
  });
}

function validateCredentialRef(value: unknown, path: string): ExecutionCredentialRef {
  if (!isPlainObject(value)) {
    throw new ExecutionRequestError(`${path} must be a mapping`);
  }
  rejectUnknownFields(value, ["name", "reference"], path);
  const name = requireString(value, "name", path, { nonEmpty: true });
  if (!EXECUTION_CREDENTIAL_NAME_RE.test(name)) {
    throw new ExecutionRequestError(`${path}.name must match ${EXECUTION_CREDENTIAL_NAME_RE.source}`);
  }
  const reference = requireString(value, "reference", path, { nonEmpty: true });
  if (!EXECUTION_CREDENTIAL_REF_RE.test(reference)) {
    throw new ExecutionRequestError(`${path}.reference must be a credential reference (letters, digits, '.', '_', ':', '-')`);
  }
  return Object.freeze({ name, reference });
}

const REQUEST_KEYS = [
  "jobId", "runId", "attempt", "kind", "platform", "repoFullName", "prNumber",
  "headSha", "baseSha", "deadlineAtMs", "workspace", "profiles", "credentials",
  "runDir", "requestPath", "resultPath",
] as const;

/** Fail-closed validation of an execution request — the ONE definition of
 * what a valid `ExecutionRequest` is, shared by every layer that accepts
 * one (the executor validates again at `start`, so a forged or drifted
 * caller cannot bypass the contract).
 *
 * Strict and structural: unknown top-level (and nested) fields are
 * REJECTED, every required field must be present with the right type and
 * sentinel discipline, the correlation fields (`runId`, `jobId`) must match
 * `EXECUTION_ID_RE`, and the envelope paths must be absolute, bounded,
 * control-free, and lexically inside `runDir`. Returns a deep-frozen copy —
 * never the caller's own object — so a request cannot be mutated after it
 * was validated. Throws `ExecutionRequestError` on any problem. */
export function validateExecutionRequest(value: unknown): ExecutionRequest {
  if (!isPlainObject(value)) {
    throw new ExecutionRequestError("execution request must be a mapping");
  }
  rejectUnknownFields(value, REQUEST_KEYS, "execution request");

  const kind = value["kind"];
  if (kind !== "review" && kind !== "follow_up") {
    throw new ExecutionRequestError("execution request.kind must be 'review' or 'follow_up'");
  }
  const platform = value["platform"];
  if (platform !== "github" && platform !== "forgejo") {
    throw new ExecutionRequestError("execution request.platform must be 'github' or 'forgejo'");
  }
  const credentialsRaw = value["credentials"];
  if (!Array.isArray(credentialsRaw)) {
    throw new ExecutionRequestError("execution request.credentials must be a list");
  }

  const jobId = requireString(value, "jobId", "execution request", { nonEmpty: true });
  const runId = requireString(value, "runId", "execution request", { nonEmpty: true });
  if (!EXECUTION_ID_RE.test(jobId)) {
    throw new ExecutionRequestError(`execution request.jobId must match ${EXECUTION_ID_RE.source}`);
  }
  if (!EXECUTION_ID_RE.test(runId)) {
    throw new ExecutionRequestError(`execution request.runId must match ${EXECUTION_ID_RE.source}`);
  }

  const request: ExecutionRequest = Object.freeze({
    jobId,
    runId,
    attempt: requireInteger(value, "attempt", "execution request", 1),
    kind,
    platform,
    repoFullName: requireString(value, "repoFullName", "execution request", { nonEmpty: true }),
    prNumber: requireInteger(value, "prNumber", "execution request", 1),
    headSha: requireString(value, "headSha", "execution request"),
    baseSha: requireString(value, "baseSha", "execution request"),
    deadlineAtMs: requireFiniteMs(value, "deadlineAtMs", "execution request"),
    workspace: validateWorkspaceShape(value["workspace"], "execution request.workspace"),
    profiles: validateProfilesShape(value["profiles"], "execution request.profiles"),
    credentials: Object.freeze(credentialsRaw.map((entry, index) => validateCredentialRef(entry, `execution request.credentials[${index}]`))),
    runDir: requireString(value, "runDir", "execution request", { nonEmpty: true }),
    requestPath: requireString(value, "requestPath", "execution request", { nonEmpty: true }),
    resultPath: requireString(value, "resultPath", "execution request", { nonEmpty: true }),
  });
  requireStrictPath(request.runDir, "execution request.runDir");
  requireStrictPath(request.requestPath, "execution request.requestPath");
  requireStrictPath(request.resultPath, "execution request.resultPath");
  for (const childPath of [request.requestPath, request.resultPath]) {
    const problem = lexicallyInsideProblem(childPath, request.runDir, "execution request envelope path");
    if (problem !== "") throw new ExecutionRequestError(problem);
  }
  return request;
}

const RESULT_KEYS = [
  "status", "runId", "jobId", "resultHeadSha", "failureCategory", "failureMessage",
  "resultArtifactPath", "diagnostics", "artifactPaths", "resourceMs", "observedAtMs",
] as const;

const RESULT_FAILURE_CATEGORIES: readonly string[] = [
  "launch_refused", "deadline", "worker_crash", "worker_error", "no_result", "stale_result", "orphaned",
];

/** Fail-closed validation of an execution result — the ONE definition of
 * what a verifiable `ExecutionResult` (and worker result file) is.
 *
 * Strict and structural: unknown fields are REJECTED, correlation fields
 * must match `EXECUTION_ID_RE`, artifact paths must be control-free and
 * bounded (and, when `opts.runDir` is supplied, lexically inside that
 * directory), and the sentinel discipline is enforced per status —
 * `completed` requires a non-empty `resultHeadSha` and
 * `resultArtifactPath`, `failed` requires a `failureCategory` from the
 * closed union (and `cancelled` requires both absent). Returns a
 * deep-frozen copy. Throws `ExecutionResultError` on any problem. */
export function validateExecutionResult(
  value: unknown,
  opts: { runDir?: string } = {},
): ExecutionResult {
  if (!isPlainObject(value)) {
    throw new ExecutionResultError("execution result must be a mapping");
  }
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    if (!(RESULT_KEYS as readonly string[]).includes(key)) {
      throw new ExecutionResultError(`execution result: unsupported field '${key}'`);
    }
  }
  const status = item["status"];
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new ExecutionResultError("execution result.status must be 'completed', 'failed', or 'cancelled'");
  }
  const runId = item["runId"];
  const jobId = item["jobId"];
  if (typeof runId !== "string" || !EXECUTION_ID_RE.test(runId)) {
    throw new ExecutionResultError(`execution result.runId must match ${EXECUTION_ID_RE.source}`);
  }
  if (typeof jobId !== "string" || !EXECUTION_ID_RE.test(jobId)) {
    throw new ExecutionResultError(`execution result.jobId must match ${EXECUTION_ID_RE.source}`);
  }
  const resultHeadSha = item["resultHeadSha"];
  if (typeof resultHeadSha !== "string") {
    throw new ExecutionResultError("execution result.resultHeadSha must be a string");
  }
  if (status === "completed" && resultHeadSha === "") {
    throw new ExecutionResultError("execution result.resultHeadSha must be non-empty when completed");
  }
  if (status !== "completed" && resultHeadSha !== "") {
    throw new ExecutionResultError("execution result.resultHeadSha must be '' unless completed");
  }
  const failureCategory = item["failureCategory"];
  if (typeof failureCategory !== "string") {
    throw new ExecutionResultError("execution result.failureCategory must be a string");
  }
  if (status === "failed" && !(RESULT_FAILURE_CATEGORIES as readonly string[]).includes(failureCategory)) {
    throw new ExecutionResultError("execution result.failureCategory must be a failure category when failed");
  }
  if (status !== "failed" && failureCategory !== "") {
    throw new ExecutionResultError("execution result.failureCategory must be '' unless failed");
  }
  const failureMessage = item["failureMessage"];
  if (typeof failureMessage !== "string") {
    throw new ExecutionResultError("execution result.failureMessage must be a string");
  }
  if (status === "failed" && failureMessage === "") {
    throw new ExecutionResultError("execution result.failureMessage must be non-empty when failed");
  }
  if (status !== "failed" && failureMessage !== "") {
    throw new ExecutionResultError("execution result.failureMessage must be '' unless failed");
  }
  const resultArtifactPath = item["resultArtifactPath"];
  if (typeof resultArtifactPath !== "string") {
    throw new ExecutionResultError("execution result.resultArtifactPath must be a string");
  }
  if (status === "completed" && resultArtifactPath === "") {
    throw new ExecutionResultError("execution result.resultArtifactPath must be non-empty when completed");
  }
  if (status !== "completed" && resultArtifactPath !== "") {
    throw new ExecutionResultError("execution result.resultArtifactPath must be '' unless completed");
  }
  const diagnostics = item["diagnostics"];
  if (typeof diagnostics !== "string") {
    throw new ExecutionResultError("execution result.diagnostics must be a string");
  }
  const artifactPathsRaw = item["artifactPaths"];
  if (!Array.isArray(artifactPathsRaw) || artifactPathsRaw.some((entry) => typeof entry !== "string")) {
    throw new ExecutionResultError("execution result.artifactPaths must be a list of strings");
  }
  const resourceMs = item["resourceMs"];
  if (typeof resourceMs !== "number" || !Number.isFinite(resourceMs) || resourceMs < 0) {
    throw new ExecutionResultError("execution result.resourceMs must be a finite non-negative number");
  }
  const observedAtMs = item["observedAtMs"];
  if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs)) {
    throw new ExecutionResultError("execution result.observedAtMs must be a finite number");
  }
  const resultPaths = [resultArtifactPath, ...artifactPathsRaw as readonly string[]].filter(
    (entry) => entry !== "",
  );
  for (const resultPath of resultPaths) {
    if (resultPath.length > MAX_PATH_CHARS) {
      throw new ExecutionResultError("execution result artifact paths must be at most 4096 characters");
    }
    if (hasControlCharacters(resultPath)) {
      throw new ExecutionResultError("execution result artifact paths must not contain control characters");
    }
    if (opts.runDir !== undefined) {
      const problem = lexicallyInsideProblem(resultPath, opts.runDir, "execution result artifact path");
      if (problem !== "") throw new ExecutionResultError(problem);
    }
  }
  const result: ExecutionResult = Object.freeze({
    status,
    runId,
    jobId,
    resultHeadSha,
    failureCategory: failureCategory as ExecutionFailureCategory | "",
    failureMessage,
    resultArtifactPath,
    diagnostics,
    artifactPaths: Object.freeze([...artifactPathsRaw]) as readonly string[],
    resourceMs,
    observedAtMs,
  });
  return result;
}
