/** The portable OCI worker-image contract for #733 — what a review-worker
 * image must do and the strict shape that contract is declared under. NOT
 * an executor implementation: `local.ts` remains the only executor in
 * this subsystem; #734 builds the container executor on THIS contract.
 *
 * Portability is the point: the same image must run under any
 * executor backend that speaks the envelope protocol, so the contract
 * fixes only what crosses the image boundary — the two environment
 * coordinates, the final-argv envelope path, the result file protocol,
 * and SIGTERM semantics. Everything runtime-specific (pull policy, run
 * flags, volumes) stays executor-side (#734).
 */

import { hasControlCharacters } from "../config/instance-config.js";
import type { OciImageSpec } from "../config/instance-config.js";
import { EXECUTION_REQUEST_ENV_KEY, EXECUTION_RESULT_ENV_KEY } from "./local.js";
import type { ExecutionRequest } from "./types.js";

/** The contract schema version. Bumped only by a breaking change to the
 * portability rules below; a parser must reject anything else. */
export const WORKER_IMAGE_CONTRACT_VERSION = 1;

/** The on-disk request envelope: the JSON the executor writes to
 * `requestPath` BEFORE launching the worker — the correlation source of
 * truth. The local executor serializes the VALIDATED `ExecutionRequest`
 * verbatim, so the stable wire contract is exactly the request's own
 * fields; the envelope type is that contract, not a second shape to keep
 * in sync. An image reads correlation (runId/jobId/attempt), the work
 * description, and the result path from it — never from stdout, argv
 * beyond the final element, or extra environment. */
export type ExecutionEnvelope = ExecutionRequest;

/** The portable contract between the controller and a containerized
 * review-worker image (#733; consumed by the OCI executor in #734).
 *
 * Portability rules every compliant image MUST satisfy:
 *
 * - The image entrypoint receives the request-envelope path as its FINAL
 *   argv element (the executor appends it after `args`).
 * - It MUST write the structured execution-result JSON (the
 *   `validateExecutionResult` contract) to the path named by `resultVar`
 *   BEFORE exiting 0. stdout is diagnostics only and is never parsed as
 *   a result.
 * - It MUST terminate promptly on SIGTERM (cancellation/deadline); the
 *   executor tree-terminates the worker.
 * - The executor owns the environment allowlist: the image MUST NOT
 *   require any environment beyond the two coordination variables
 *   (`requestVar`/`resultVar`) plus generic PATH/HOME/TMPDIR-style keys.
 *   Request/job/repo-derived data reaches the image exclusively inside
 *   the envelope file.
 */
export interface WorkerImageContract {
  readonly contractVersion: 1;
  /** The fully-qualified image reference the executor runs. */
  readonly image: string;
  /** The image's fixed argv (operator policy, never PR-derived), placed
   * BEFORE the envelope path the executor appends. */
  readonly args: readonly string[];
  /** Env coordinate carrying the request-envelope path. */
  readonly requestVar: string;
  /** Env coordinate carrying the result-file path. */
  readonly resultVar: string;
}

/** Fail-closed rejection for a structurally invalid worker-image
 * contract. */
export class WorkerImageContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerImageContractError";
  }
}

/** The OCI image-reference grammar: lowercase registry/repo name,
 * optional tag, optional sha256 digest pin. DUPLICATED from
 * instance-config's private `OCI_IMAGE_RE` (src/config is not extended in
 * this bounded phase) — keep the two in sync; a drift fails closed here,
 * never open. */
const OCI_IMAGE_RE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/;

/** Mirrors instance-config's image/argv bounds so a contract can never be
 * wider than the config layer that produces one. */
const MAX_IMAGE_CHARS = 512;
const MAX_CONTRACT_ARGS = 32;
const MAX_ARG_BYTES = 4_096;

/** Shell metacharacters an argv element must never contain — mirrors
 * instance-config's `EXECUTOR_ARGV_METACHARACTERS` discipline: each
 * element is ONE argv word; a shell line here is a mistake or an
 * injection attempt. */
const ARGV_METACHARS = /[|;&<>`$]/;

const CONTRACT_KEYS: readonly string[] = [
  "contractVersion",
  "image",
  "args",
  "requestVar",
  "resultVar",
];

function contractString(
  item: Record<string, unknown>,
  key: string,
  maxChars: number,
): string {
  const value = item[key];
  if (typeof value !== "string" || value === "") {
    throw new WorkerImageContractError(`worker image contract.${key} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new WorkerImageContractError(`worker image contract.${key} must be at most ${maxChars} characters`);
  }
  if (hasControlCharacters(value)) {
    throw new WorkerImageContractError(`worker image contract.${key} must not contain control characters`);
  }
  return value;
}

function contractArg(entry: unknown, index: number): string {
  const path = `worker image contract.args[${index}]`;
  if (typeof entry !== "string" || entry === "") {
    throw new WorkerImageContractError(`${path} must be a non-empty string`);
  }
  if (Buffer.byteLength(entry, "utf8") > MAX_ARG_BYTES) {
    throw new WorkerImageContractError(`${path} must be at most ${MAX_ARG_BYTES} bytes`);
  }
  if (hasControlCharacters(entry)) {
    throw new WorkerImageContractError(`${path} must not contain control characters`);
  }
  if (ARGV_METACHARS.test(entry)) {
    throw new WorkerImageContractError(`${path} must be a single argv element (no shell metacharacters)`);
  }
  return entry;
}

/** Fail-closed validation of a worker-image contract: unknown fields are
 * REJECTED, the schema version must be exactly
 * `WORKER_IMAGE_CONTRACT_VERSION`, the image must satisfy the same
 * grammar instance-config applies to `oci.image` (mirrored above), args
 * obey the local-executor argv hygiene (non-empty, NUL/control-free,
 * no shell metacharacters, bounded count/length), and the two env
 * coordinates must be exactly the executor's coordination variables —
 * a contract naming other coordinates is not this protocol. Returns a
 * frozen copy; throws `WorkerImageContractError` on any problem. */
export function parseWorkerImageContract(value: unknown): WorkerImageContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkerImageContractError("worker image contract must be a mapping");
  }
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    if (!CONTRACT_KEYS.includes(key)) {
      throw new WorkerImageContractError(`worker image contract: unsupported field '${key}'`);
    }
  }
  if (item["contractVersion"] !== WORKER_IMAGE_CONTRACT_VERSION) {
    throw new WorkerImageContractError(
      `worker image contract.contractVersion must be ${WORKER_IMAGE_CONTRACT_VERSION}`,
    );
  }
  const image = contractString(item, "image", MAX_IMAGE_CHARS);
  if (!OCI_IMAGE_RE.test(image)) {
    throw new WorkerImageContractError(
      "worker image contract.image must be an image reference (name[:tag][@sha256:digest])",
    );
  }
  const argsRaw = item["args"] ?? [];
  if (!Array.isArray(argsRaw)) {
    throw new WorkerImageContractError("worker image contract.args must be a list of argv strings");
  }
  if (argsRaw.length > MAX_CONTRACT_ARGS) {
    throw new WorkerImageContractError(
      `worker image contract.args must have at most ${MAX_CONTRACT_ARGS} entries`,
    );
  }
  const args = Object.freeze(argsRaw.map((entry, index) => contractArg(entry, index))) as readonly string[];
  const requestVar = contractString(item, "requestVar", 128);
  const resultVar = contractString(item, "resultVar", 128);
  if (requestVar !== EXECUTION_REQUEST_ENV_KEY) {
    throw new WorkerImageContractError(
      `worker image contract.requestVar must be '${EXECUTION_REQUEST_ENV_KEY}'`,
    );
  }
  if (resultVar !== EXECUTION_RESULT_ENV_KEY) {
    throw new WorkerImageContractError(
      `worker image contract.resultVar must be '${EXECUTION_RESULT_ENV_KEY}'`,
    );
  }
  return Object.freeze({
    contractVersion: WORKER_IMAGE_CONTRACT_VERSION,
    image,
    args,
    requestVar,
    resultVar,
  });
}

/** Build the worker-image contract for an instance-config executor
 * profile: the contract for an `oci` profile (built from its validated
 * image reference and re-parsed fail-closed), `null` for every other
 * kind (local executors carry their own argv; kubernetes has no spec
 * until #734). An `oci` profile without its spec is a malformed profile —
 * fail closed rather than degrade. */
export function validateImageContractForProfile(
  profile: { kind: string; oci: OciImageSpec | null },
): WorkerImageContract | null {
  if (profile.kind !== "oci") return null;
  if (profile.oci === null) {
    throw new WorkerImageContractError("an 'oci' executor profile must carry an image reference");
  }
  return parseWorkerImageContract({
    contractVersion: WORKER_IMAGE_CONTRACT_VERSION,
    image: profile.oci.image,
    args: [],
    requestVar: EXECUTION_REQUEST_ENV_KEY,
    resultVar: EXECUTION_RESULT_ENV_KEY,
  });
}

/** The fixed argv prefix an OCI executor would launch: the image
 * reference as the file and the contract's fixed args. Container-runtime
 * binding (pull, run flags, the envelope path appended last) is #734+ —
 * this returns only the contract-derived pieces and fakes nothing. */
export function resolveExecutionImageCommand(
  contract: WorkerImageContract,
): { file: string; args: readonly string[] } {
  return { file: contract.image, args: contract.args };
}
