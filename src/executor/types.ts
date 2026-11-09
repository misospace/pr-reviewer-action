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
import type { ApiFormat } from "../config/types.js";
import type { ReviewJobKind } from "../jobs/types.js";
import type { WorkspaceInfo } from "../acquisition/types.js";
import { isPlainObject } from "../platform/object.js";

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

/** Largest byte length the non-secret forge API base URL may carry in a
 * request envelope. Mirrors instance-config's `MAX_ENDPOINT_BYTES` (and
 * platform/urls' consumer expectations) so the envelope can never be wider
 * than the config layer that produces the endpoint — keep the three in
 * sync; drift fails closed here, never open. */
const MAX_EXECUTION_FORGE_API_URL_BYTES = 2_048;

/** Largest byte length the non-secret AI model base URL may carry in a
 * request envelope. Same ceiling as the forge API base (and the config
 * layer's `MAX_ENDPOINT_BYTES`) — the envelope is never wider than the
 * instance config that produces the endpoint. */
const MAX_EXECUTION_AI_BASE_URL_BYTES = 2_048;

/** Largest length a model id on the wire may carry in a request envelope.
 * Provider model ids are short identifiers; the cap leaves generous room
 * for namespaced/self-hosted ids while keeping the envelope bounded. */
const MAX_EXECUTION_MODEL_ID_CHARS = 512;

/** Path-field bound: the longest absolute path a request or result may
 * name. */
const MAX_PATH_CHARS = 4_096;

/** Largest worker result file the executor will read (bytes). The result
 * protocol is a file, so the file itself is the untrusted surface: a
 * worker must never be able to make the executor allocate an arbitrary
 * amount of memory. The cap leaves room for a validator-legal result
 * (64 artifact paths of at most 4096 characters each) plus its JSON
 * overhead. */
export const MAX_EXECUTION_RESULT_FILE_BYTES = 1_048_576;

/** Largest diagnostics tail an execution result may carry
 * (characters). */
export const MAX_EXECUTION_DIAGNOSTICS_CHARS = 8_000;

/** Largest failure message an execution result may carry (characters). */
export const MAX_EXECUTION_FAILURE_MESSAGE_CHARS = 2_000;

/** Largest number of artifact references an execution result may carry. */
export const MAX_EXECUTION_ARTIFACT_PATHS = 64;

/** Largest head sha an execution result may carry (characters). A git
 * object name is at most 64 hex characters; the cap keeps a
 * pathological value from reaching the durable queue record. */
export const MAX_EXECUTION_HEAD_SHA_CHARS = 128;

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

/** The prefix a worker-credential name derives its projected environment
 * variable from. An executor hands resolved credential MATERIAL to the
 * worker under `PR_REVIEWER_CREDENTIAL_<NAME>` (uppercased name, `-` →
 * `_`); the worker reads its model key under exactly this derivation of
 * the fixed `model` credential name (#735/#1496). Shared so the projecting
 * executor and the consuming worker can never drift apart. */
export const EXECUTION_CREDENTIAL_ENV_PREFIX = "PR_REVIEWER_CREDENTIAL_";

/** The env-var name grammar a derived credential variable must satisfy. */
const CREDENTIAL_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The worker environment variable that carries the resolved material for
 * one credential NAME. Fails closed: a name that cannot derive a valid
 * variable name is refused, never truncated or guessed. */
export function executionCredentialEnvName(name: string): string {
  const derived = EXECUTION_CREDENTIAL_ENV_PREFIX + name.toUpperCase().replaceAll("-", "_");
  if (!CREDENTIAL_ENV_NAME_RE.test(derived)) {
    throw new ExecutionRequestError(
      `credential name '${name}' does not derive a valid environment variable name`,
    );
  }
  return derived;
}

/** The operator's resolved model selection for one execution (#1496): the
 * non-secret half of "how this run reaches the model". A containerized
 * worker has no ambient model environment, so — exactly like the forge
 * API base (#1433) — the coordinate must ride the envelope or the review
 * can never start a model call.
 *
 * "Non-secret" is a hard contract: the credential NEVER appears here. It
 * stays on the #735 broker path (the `credentials` entry named `model`,
 * whose projected material the worker reads from the derived environment
 * variable), and `baseUrl` must pass the same credential-free endpoint
 * hygiene as `forgeApiUrl` — a token riding the AI base URL would be
 * persisted verbatim into every envelope. */
export interface ExecutionModelSelection {
  /** The operator-resolved AI base URL (the selected model profile's
   * endpoint). Always required: unlike the forge API base there is no
   * platform default an AI endpoint could fall back to, and a review
   * without a model endpoint cannot produce a verdict. */
  readonly baseUrl: string;
  /** The model id on the wire (what the provider is asked for) — from the
   * selected model profile's `model` key. Non-empty. */
  readonly modelId: string;
  /** The wire format of the endpoint (the selected profile's API format). */
  readonly apiFormat: ApiFormat;
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
  /** The non-secret forge API base URL coordinate (like `platform`, never
   * credential material — secrets travel only on the #735 broker path).
   * A containerized worker has no ambient forge environment, so the
   * endpoint must ride the envelope (#1433). "" means "platform default"
   * and is legal only where a default exists (GitHub: `api.github.com`);
   * consumers must treat "" as ABSENT and apply the default explicitly —
   * `??` never fires on an empty string, and the platform seams refuse an
   * empty base. A `forgejo` request without one is REFUSED at validation,
   * never at adapter construction inside the worker.
   *
   * "Non-secret" is a hard contract, not a convention: the value is
   * persisted verbatim in every envelope, so a credential riding the URL
   * (userinfo, query, fragment, or a credential-shaped path segment) is
   * REFUSED by `forgeApiUrlProblem`, not warned about. */
  readonly forgeApiUrl: string;
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
  /** The operator's resolved model selection (#1496): the non-secret AI
   * base URL, the model id on the wire, and the wire format. Required on
   * every review execution — there is no default model, so an envelope
   * without a selection can never reach the model and is REFUSED at
   * validation, never degraded to an empty engine input set. */
  readonly modelSelection: ExecutionModelSelection;
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
 *   by post-restart reconciliation). The controller's recovery path keys
 *   its compensating process-group sweep on exactly this category, so the
 *   value is pinned by `EXECUTION_ORPHANED_CATEGORY` and both sides import
 *   it — a rename on either side alone cannot silently detach the sweep.
 * - `terminate_failed` — the executor could NOT confirm that the worker
 *   was terminated (a cancellation whose deletion never succeeded): the
 *   worker may still be running, so the run must never be reported as
 *   `cancelled`. */
export type ExecutionFailureCategory =
  | "launch_refused"
  | "deadline"
  | "worker_crash"
  | "worker_error"
  | "no_result"
  | "stale_result"
  | typeof EXECUTION_ORPHANED_CATEGORY
  | "terminate_failed";

/** The reconcile failure category for a recorded worker that can no longer
 * execute and produced no terminal state: the attempt can never produce a
 * result, and the controller's recovery path keys its compensating
 * process-group sweep on exactly this value. One shared constant, imported
 * by the executor that emits it and the daemon that reacts to it. */
export const EXECUTION_ORPHANED_CATEGORY = "orphaned";

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
 * - `cancel` is idempotent and tree-terminates the worker. When the
 *   termination cannot be CONFIRMED, the collected result says so
 *   (`failed` `terminate_failed`) instead of claiming a `cancelled`
 *   verdict for a worker that may still be running.
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

/** Why a correlation-keyed cancellation could not be completed. A closed
 * vocabulary: the reason is a machine-readable fact about the cluster (or
 * the worker host), never free text and never a secret. */
export type ExecutionCancelFailureReason =
  /** The worker could not be confirmed terminated: it may still be
   * running. */
  | "worker-not-terminated"
  /** The worker's credential material could not be removed: it may still
   * be live. */
  | "material-not-removed";

/** The outcome of a correlation-keyed cancellation (`Executor.cancel`).
 *
 * The distinction IS the contract: `terminated` PROVES that the worker
 * for this correlation identity is gone (terminated now, or there was
 * nothing running to terminate), while `failed` says it could not be
 * proven — the worker may still be running and the caller must treat the
 * execution as possibly alive (retry later, never assume). */
export type ExecutionCancelOutcome =
  | { readonly kind: "terminated" }
  | { readonly kind: "failed"; readonly reason: ExecutionCancelFailureReason };

/** The executor seam (#733). Implementations own launching, observing,
 * cancelling, and reconciling executions for the correlation identities the
 * controller hands them. `reconcile` is the crash-recovery path: after a
 * controller restart the controller asks whether an execution for a
 * request's correlation identity already exists — `none` means none was
 * found (the caller may start fresh), `running` means it is still alive
 * (the caller retries later), and `settled` carries the terminal result,
 * which MUST NOT be rerun.
 *
 * `cancel` is the RECOVERY-side cancellation: it terminates the worker for
 * a correlation identity WITHOUT an in-memory handle, so a controller that
 * restarted (or one that adopted a worker another controller started) can
 * still stop a superseded or cancelled run. It is keyed by the request's
 * correlation identity, never by a live handle: a foreign identity is
 * never touched, and a termination that cannot be CONFIRMED is reported
 * as `failed`, never as `terminated`. */
export interface Executor {
  start(request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionHandle>;
  reconcile(request: ExecutionRequest): Promise<ExecutionReconcileOutcome>;
  cancel(request: ExecutionRequest): Promise<ExecutionCancelOutcome>;
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

/** The credential-shaped run floor (#1433): an opaque gateway token is a
 * long blob, while a legitimate API base-path segment (`api`, `v1`,
 * `completions`) is short prose. The floor keeps false refusals rare; it
 * also means a SHORT secret-shaped run is not detected — this is a shape
 * screen, not a proof that a path is credential-free.
 *
 * It is the SAME 20-character floor the #1429 advisory path check uses in
 * the Python lane (`pr_reviewer/http_safe.py`). The shape below is a
 * superset of that lane's (base64's `+` and `=`), and this boundary
 * additionally judges the path as written, judges a RUN inside a segment
 * (not only a whole segment), joins the path across its separators, and
 * refuses a malformed encoding — so the two lanes share the floor, not
 * the whole rule. */
const MIN_CREDENTIAL_SHAPED_PATH_RUN = 20;

/** The characters an opaque token is made of: the URL unreserved set
 * (`A-Z` `a-z` `0-9` `-` `.` `_` `~` — `_` included, base64url uses it)
 * plus the base64 alphabet's `+` and `=`. No real token alphabet (hex,
 * base64, base64url, JWT) reaches beyond them; a run built from anything
 * else is path prose, not token material. Dropping `_` would let a token
 * split into underscore-joined sub-floor chunks evade the screen. */
const TOKEN_RUN_RE = /[A-Za-z0-9._~+=-]+/g;

/** A percent-escape the URL cannot decode: the path's meaning is
 * uncertain, so it cannot be proven credential-free. */
const MALFORMED_ESCAPE_RE = /%(?![0-9A-Fa-f]{2})/;

/** Percent-decode a path TOLERANTLY: a valid escape is decoded, an
 * invalid one is left as written, so a decoded form never throws and the
 * decoding can run to a fixed point. Byte-wise decoding is enough here —
 * the screen judges character shape, not text. */
function decodePathTolerant(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** The path AS WRITTEN in the value, before the URL parser's
 * normalization: the parser removes dot segments, so a credential can hide
 * in a path that `url.pathname` no longer shows — while the envelope
 * persists the raw value verbatim. The raw path is therefore judged too.
 *
 * The authority boundary is found the way the URL PARSER finds it, not by
 * searching for "//": the parser accepts `http:host/path`,
 * `http:/host/path` and `http://host/path` alike, and for http(s) it
 * treats a backslash as a path separator. A "//"-only search returns an
 * empty raw path for the first two spellings, and the credential that
 * hides behind the parser's dot-segment removal would then be judged
 * nowhere — the parsed path is already normalized and the raw path is
 * empty. */
function rawPathOf(value: string): string {
  const schemeEnd = value.indexOf(":");
  if (schemeEnd < 0) return "";
  // The authority starts after the scheme's slashes; the parser skips any
  // number of them.
  let index = schemeEnd + 1;
  while (index < value.length && (value[index] === "/" || value[index] === "\\")) index += 1;
  // The authority ends at the first path separator.
  while (index < value.length && value[index] !== "/" && value[index] !== "\\") index += 1;
  return index < value.length ? value.slice(index) : "";
}

/** The token-character RUNS of one path form: a run, not a whole
 * segment, so a credential sharing its segment with one punctuation
 * character (`token!junk`, `token;v=1`) is still a run of token
 * characters. The separators are removed, so a token split across a
 * separator (base64's own `/`) is judged as ONE run. A backslash is a
 * separator too — the URL parser reads it as one for http(s) — so it is
 * removed as well and the raw form is joined like the parsed one. */
function tokenRunsIn(path: string): string[] {
  return path.replaceAll("/", "").replaceAll("\\", "").match(TOKEN_RUN_RE) ?? [];
}

/** Path-credential problem of a URL's path, or "" when the path carries no
 * credential material.
 *
 * A credential can ride the endpoint's PATH: gateway providers hand out
 * URLs like `https://host/<token>/v1`. There the Python lane (#1429) only
 * WARNS, because a path segment cannot be reliably told apart from a
 * legitimate path part and a legitimate endpoint's authentication can
 * genuinely ride it. This field's contract is stronger — `forgeApiUrl` may
 * never carry credential material, and it is persisted verbatim in every
 * execution envelope — so the same suspicion REFUSES here.
 *
 * The boundary refuses a path that
 *
 * - carries a credential-shaped run: at least
 *   `MIN_CREDENTIAL_SHAPED_PATH_RUN` token characters, judged over the
 *   path as written, over the parsed path, and over every
 *   percent-decoding round of each, so an encoded token cannot slip
 *   through; or
 * - smuggles a query, fragment, whitespace, or control character through
 *   percent-encoding (the plain forms are already refused above); or
 * - carries an `@` outside its authority (the #1419 class the Python lane
 *   refuses: a password carrying an unencoded `/` ends the authority
 *   early, so the userinfo lands in the path); or
 * - carries a malformed percent-escape, which cannot be decoded and
 *   therefore cannot be proven credential-free.
 *
 * The channels this covers are the URL's userinfo, query, fragment, and
 * path. The hostname is not screened: a long DNS label is ordinary
 * operator naming, and a per-key subdomain gateway is a rarer channel
 * than a path token.
 *
 * The screen is a shape screen, not a proof: it cannot tell a token from
 * prose, and this field's contract leaves no room for the doubt. A
 * legitimate base path whose token run reaches the floor is refused too —
 * such a deployment must shorten or alias its base path; there is no
 * secret to move. */
function forgeApiUrlPathProblem(url: URL, rawPath: string): string {
  const paths = [rawPath, url.pathname];
  for (const path of paths) {
    if (MALFORMED_ESCAPE_RE.test(path)) {
      return "must not contain a malformed percent-encoding in its path";
    }
  }
  for (const path of paths) {
    let current = path;
    // The decoding runs to a fixed point: a decode round either shrinks
    // the path or changes nothing, and the path is byte-capped, so the
    // loop terminates.
    for (;;) {
      if (current.includes("@")) {
        return "must not carry a credential outside its authority (an '@' in the path)";
      }
      if (/[?#\s]/.test(current) || hasControlCharacters(current)) {
        return "must not contain a percent-encoded query, fragment, whitespace, or control character in its path";
      }
      for (const run of tokenRunsIn(current)) {
        if (run.length >= MIN_CREDENTIAL_SHAPED_PATH_RUN) {
          return "must not contain a credential-shaped path segment";
        }
      }
      const decoded = decodePathTolerant(current);
      if (decoded === current) break;
      current = decoded;
    }
  }
  return "";
}

/** Envelope hygiene problem of a present forge API base URL value, or ""
 * when it is a valid coordinate: absolute http(s), a hostname, bounded
 * length, and NO credential material — including no query and no fragment,
 * where a `?access_token=`-style secret hides from plain scheme checks,
 * and no credential-shaped path segment, where a `<token>` in the path
 * hides from every other check (#1429's class, refused here).
 *
 * This is `validateExecutionRequest`'s own check, exported so operator
 * wiring can refuse a configured endpoint at STARTUP instead of refusing
 * every request the builder composes with it. The same hygiene the config
 * layer applies to endpoints (`instance-config`'s `endpointAt`, plus the
 * stricter query/fragment/whitespace/path discipline this envelope adds)
 * and that `platform/urls`'s `parsePlatformBaseUrl` applies worker-side —
 * keep them in sync; this one is deliberately one-way stricter than both,
 * so anything accepted here is accepted by every consumer of the
 * coordinate. */
export function forgeApiUrlProblem(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_EXECUTION_FORGE_API_URL_BYTES) {
    return `must be at most ${MAX_EXECUTION_FORGE_API_URL_BYTES} bytes`;
  }
  if (hasControlCharacters(value) || /\s|\?|#/.test(value)) {
    return "must not contain whitespace, control characters, a query, or a fragment";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `must use http or https (got '${url.protocol}')`;
  }
  if (url.username !== "" || url.password !== "") {
    return "must not embed credentials";
  }
  if (url.hostname === "") {
    return "must include a hostname";
  }
  return forgeApiUrlPathProblem(url, rawPathOf(value));
}

/** Fail-closed check of the non-secret forge API base coordinate (#1433).
 *
 * Absent ("") is legal ONLY where the platform itself carries a default
 * endpoint (GitHub's `api.github.com`); a Forgejo request without one can
 * never construct its adapter, so the envelope refuses it at validation.
 * A present value must satisfy `forgeApiUrlProblem` above. */
function requireForgeApiUrl(platform: "github" | "forgejo", value: string): void {
  const path = "execution request.forgeApiUrl";
  if (value === "") {
    if (platform === "forgejo") {
      throw new ExecutionRequestError(
        `${path} must be non-empty for forgejo (no default forge endpoint exists to fall back to)`,
      );
    }
    return;
  }
  const problem = forgeApiUrlProblem(value);
  if (problem !== "") {
    throw new ExecutionRequestError(`${path} ${problem}`);
  }
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

/** Envelope hygiene of the non-secret AI model base URL, or "" when it is
 * a valid coordinate. It reuses `forgeApiUrlProblem` — the ONE
 * credential-free http(s) endpoint check this contract has — because the
 * AI base URL carries the identical promise: persisted verbatim into every
 * envelope, never allowed to smuggle a credential (userinfo, query,
 * fragment, or a credential-shaped path segment). A byte cap wider than
 * the endpoint's own grammar would only ever reject on the cap, so the
 * shared check runs first and the cap is belt-and-braces. */
function aiBaseUrlProblem(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_EXECUTION_AI_BASE_URL_BYTES) {
    return `must be at most ${MAX_EXECUTION_AI_BASE_URL_BYTES} bytes`;
  }
  return forgeApiUrlProblem(value);
}

/** Fail-closed check of the operator's model selection (#1496). Every
 * component is required: `baseUrl` must be a credential-free http(s)
 * endpoint, `modelId` a non-empty bounded control-free identifier, and
 * `apiFormat` one of the two wire formats. An absent or partial selection
 * throws — a worker-driven review must be able to start a model call, and
 * "we'll find out at model-call time" is exactly the failure this field
 * closes. */
function validateModelSelectionShape(value: unknown, path: string): ExecutionModelSelection {
  if (!isPlainObject(value)) {
    throw new ExecutionRequestError(
      `${path} must be a mapping (a review execution cannot reach the model without a model selection)`,
    );
  }
  rejectUnknownFields(value, ["baseUrl", "modelId", "apiFormat"], path);
  const baseUrl = requireString(value, "baseUrl", path, { nonEmpty: true });
  const baseProblem = aiBaseUrlProblem(baseUrl);
  if (baseProblem !== "") {
    throw new ExecutionRequestError(`${path}.baseUrl ${baseProblem}`);
  }
  const modelId = requireString(value, "modelId", path, { nonEmpty: true });
  if (modelId.length > MAX_EXECUTION_MODEL_ID_CHARS) {
    throw new ExecutionRequestError(
      `${path}.modelId must be at most ${MAX_EXECUTION_MODEL_ID_CHARS} characters`,
    );
  }
  if (hasControlCharacters(modelId)) {
    throw new ExecutionRequestError(`${path}.modelId must not contain control characters`);
  }
  const apiFormat = value["apiFormat"];
  if (apiFormat !== "openai" && apiFormat !== "anthropic") {
    throw new ExecutionRequestError(`${path}.apiFormat must be 'openai' or 'anthropic'`);
  }
  return Object.freeze({ baseUrl, modelId, apiFormat });
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
  "jobId", "runId", "attempt", "kind", "platform", "forgeApiUrl", "repoFullName",
  "prNumber", "headSha", "baseSha", "deadlineAtMs", "workspace", "profiles",
  "modelSelection", "credentials", "runDir", "requestPath", "resultPath",
] as const;

/** Fail-closed validation of an execution request — the ONE definition of
 * what a valid `ExecutionRequest` is, shared by every layer that accepts
 * one (the executor validates again at `start`, so a forged or drifted
 * caller cannot bypass the contract).
 *
 * Strict and structural: unknown top-level (and nested) fields are
 * REJECTED, every required field must be present with the right type and
 * sentinel discipline, the correlation fields (`runId`, `jobId`) must match
 * `EXECUTION_ID_RE`, the envelope paths must be absolute, bounded,
 * control-free, and lexically inside `runDir`, and the non-secret forge API
 * base (`forgeApiUrl`) must be a credential-free http(s) endpoint wherever
 * it is present — and must be present for `forgejo`, which has no default
 * to fall back to (#1433); and the model selection (`modelSelection`) must
 * carry a credential-free AI base URL, a bounded non-empty model id, and a
 * known wire format — every review execution must be able to reach the
 * model (#1496). Returns a deep-frozen copy —
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
    forgeApiUrl: requireString(value, "forgeApiUrl", "execution request"),
    repoFullName: requireString(value, "repoFullName", "execution request", { nonEmpty: true }),
    prNumber: requireInteger(value, "prNumber", "execution request", 1),
    headSha: requireString(value, "headSha", "execution request"),
    baseSha: requireString(value, "baseSha", "execution request"),
    deadlineAtMs: requireFiniteMs(value, "deadlineAtMs", "execution request"),
    workspace: validateWorkspaceShape(value["workspace"], "execution request.workspace"),
    profiles: validateProfilesShape(value["profiles"], "execution request.profiles"),
    modelSelection: validateModelSelectionShape(
      value["modelSelection"],
      "execution request.modelSelection",
    ),
    credentials: Object.freeze(credentialsRaw.map((entry, index) => validateCredentialRef(entry, `execution request.credentials[${index}]`))),
    runDir: requireString(value, "runDir", "execution request", { nonEmpty: true }),
    requestPath: requireString(value, "requestPath", "execution request", { nonEmpty: true }),
    resultPath: requireString(value, "resultPath", "execution request", { nonEmpty: true }),
  });
  requireStrictPath(request.runDir, "execution request.runDir");
  requireStrictPath(request.requestPath, "execution request.requestPath");
  requireStrictPath(request.resultPath, "execution request.resultPath");
  requireForgeApiUrl(platform, request.forgeApiUrl);
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
  "terminate_failed",
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
 * closed union (and `cancelled` requires both absent). The free-text
 * fields are bounded too (`diagnostics`, `failureMessage`) and the
 * artifact list is capped, so a worker can never make the executor hold
 * an unbounded result in memory. Returns a deep-frozen copy. Throws
 * `ExecutionResultError` on any problem. */
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
  if (resultHeadSha.length > MAX_EXECUTION_HEAD_SHA_CHARS) {
    throw new ExecutionResultError(
      `execution result.resultHeadSha must be at most ${MAX_EXECUTION_HEAD_SHA_CHARS} characters`,
    );
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
  if (failureMessage.length > MAX_EXECUTION_FAILURE_MESSAGE_CHARS) {
    throw new ExecutionResultError(
      `execution result.failureMessage must be at most ${MAX_EXECUTION_FAILURE_MESSAGE_CHARS} characters`,
    );
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
  if (diagnostics.length > MAX_EXECUTION_DIAGNOSTICS_CHARS) {
    throw new ExecutionResultError(
      `execution result.diagnostics must be at most ${MAX_EXECUTION_DIAGNOSTICS_CHARS} characters`,
    );
  }
  const artifactPathsRaw = item["artifactPaths"];
  if (!Array.isArray(artifactPathsRaw) || artifactPathsRaw.some((entry) => typeof entry !== "string")) {
    throw new ExecutionResultError("execution result.artifactPaths must be a list of strings");
  }
  if (artifactPathsRaw.length > MAX_EXECUTION_ARTIFACT_PATHS) {
    throw new ExecutionResultError(
      `execution result.artifactPaths must have at most ${MAX_EXECUTION_ARTIFACT_PATHS} entries`,
    );
  }
  const resourceMs = item["resourceMs"];
  if (typeof resourceMs !== "number" || !Number.isFinite(resourceMs) || resourceMs < 0) {
    throw new ExecutionResultError("execution result.resourceMs must be a finite non-negative number");
  }
  const observedAtMs = item["observedAtMs"];
  if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || observedAtMs < 0) {
    throw new ExecutionResultError("execution result.observedAtMs must be a finite non-negative number");
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
