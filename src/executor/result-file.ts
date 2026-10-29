/** Shared worker-result and message helpers for the executor subsystem:
 * the ONE implementation of reading, correlation-checking, and validating
 * the worker's structured result file (used by the local reference
 * executor and the #734 Kubernetes executor alike), plus the bounded
 * failure-message helper every executor's synthesized results use so no
 * executor can produce a result its own contract rejects.
 *
 * The result file is untrusted worker output: it is proven contained
 * against the run directory on disk (no symlink, canonical directory
 * inside the run directory), read with no-follow bounded semantics, and
 * only then parsed and validated. Correlation comes first among the
 * CONTENT checks: a parseable file from another generation is `stale`,
 * never a validation target.
 */

import { MAX_EXECUTION_RESULT_FILE_BYTES, validateExecutionResult } from "./types.js";
import type { ExecutionRequest } from "./types.js";
import { MAX_EXECUTION_FAILURE_MESSAGE_CHARS } from "./types.js";
import { proveContained, readBoundedFileNoFollow } from "./paths.js";

/** Failure messages are bounded by the result contract
 * (`MAX_EXECUTION_FAILURE_MESSAGE_CHARS`). Refusal messages embed
 * filesystem paths — which the request contract itself allows to be long
 * — so the message is truncated to the cap: an executor result must
 * always satisfy the contract it is validated against, or the queue seam
 * would reject the executor's OWN result. */
export function boundedFailureMessage(message: string): string {
  if (message.length <= MAX_EXECUTION_FAILURE_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_EXECUTION_FAILURE_MESSAGE_CHARS - 1)}…`;
}

/** What reading the worker's result file concluded. `stale` is distinct:
 * a parseable file from ANOTHER correlation identity is a different
 * failure than no file at all, and neither is ever believed. */
export type ResultFileOutcome =
  | { readonly kind: "ok"; readonly result: Awaited<ReturnType<typeof validateExecutionResult>> }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "stale" };

/** Read, correlation-check, and validate the worker's structured result
 * file. The file is proven contained (no symlink, canonical directory
 * inside the run directory) and read with no-follow, bounded semantics
 * before it is parsed at all — a planted symlink is never followed and
 * an oversized file never reaches the parser. Correlation comes NEXT and
 * stays first among the CONTENT checks: a parseable file from another
 * generation is `stale`, never a validation target. */
export async function readWorkerResultFile(
  request: ExecutionRequest,
): Promise<ResultFileOutcome> {
  const proof = await proveContained(request.runDir, request.resultPath);
  if (!proof.contained) {
    return { kind: "invalid" };
  }
  const read = await readBoundedFileNoFollow(
    request.resultPath,
    MAX_EXECUTION_RESULT_FILE_BYTES,
  );
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "invalid") return { kind: "invalid" };
  let raw: unknown;
  try {
    raw = JSON.parse(read.text);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "invalid" };
  const item = raw as Record<string, unknown>;
  if (item["runId"] !== request.runId || item["jobId"] !== request.jobId) {
    return { kind: "stale" };
  }
  try {
    return { kind: "ok", result: validateExecutionResult(raw, { runDir: request.runDir }) };
  } catch {
    return { kind: "invalid" };
  }
}
