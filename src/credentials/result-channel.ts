/** Run-scoped result-channel authentication for #735: how the controller
 * proves that a result artifact belongs to THIS execution attempt — and how
 * it refuses a worker that tries to submit for another run.
 *
 * The result protocol (#733) is a file at a controller-owned path, keyed by
 * the correlation identity (`runId`). But a path alone is only a coordinate;
 * the result-channel token binds the SUBMISSION AUTHORITY to the exact
 * `(runId, jobId)` pair: the worker receives a short token derived from the
 * controller's signing key, and a verifier recomputes the same derivation
 * for the run it is checking. A token minted for run A can never authorize
 * a submission for run B — the hash of a different pair is a different
 * token — and a hostile worker that replays, mutates, or forges a token
 * fails the constant-time comparison.
 *
 * This is the "authenticated result/report channel credential" from the
 * issue's worker-credential list: minimal (a MAC, not a bearer secret to any
 * shared store), run-scoped (useless after the run settles), and derived —
 * the controller signing key itself never leaves the controller.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { RUN_ID_RE } from "./types.js";

export interface ResultChannelAuthOptions {
  /** Controller signing key. Held in a `#key` private field; never exposed,
   * never logged, never included in any token. */
  readonly key: string;
  /** Injected clock, epoch milliseconds (reserved for future expiry
   * enforcement; injected so tests stay deterministic). */
  readonly now?: (() => number) | undefined;
}

/** Token grammar: `v1.<64 lowercase hex>` — versioned so a future format
 * change cannot be confused with a v1 token by a lenient verifier. */
export const RESULT_CHANNEL_TOKEN_RE = /^v1\.[0-9a-f]{64}$/;

export interface ResultChannelAuth {
  /** Mint the submission token for one correlation identity. */
  mint(runId: string, jobId: string): string;
  /** Verify a presented token against a correlation identity. Total
   * function over hostile input: any malformed, foreign-format, overlong,
   * or mismatched token is `false`, never a throw. */
  verify(token: string, runId: string, jobId: string): boolean;
}

/** Upper bound on the token string the verifier will even look at — a
 * hostile caller cannot make the comparison allocate or digest an
 * unbounded input. */
const MAX_TOKEN_CHARS = 256;

export function createResultChannelAuth(options: ResultChannelAuthOptions): ResultChannelAuth {
  const key = options.key;
  if (typeof key !== "string" || key.length < 16) {
    throw new RangeError("result-channel signing key must be at least 16 characters");
  }
  const keyBytes = Buffer.from(key, "utf8");
  return {
    mint(runId: string, jobId: string): string {
      requireRunIdentity(runId, "runId");
      requireRunIdentity(jobId, "jobId");
      return `v1.${hmacFor(keyBytes, runId, jobId)}`;
    },
    verify(token: string, runId: string, jobId: string): boolean {
      if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return false;
      if (!RESULT_CHANNEL_TOKEN_RE.test(token)) return false;
      if (!RUN_ID_RE.test(runId) || !RUN_ID_RE.test(jobId)) return false;
      const expected = Buffer.from(hmacFor(keyBytes, runId, jobId), "utf8");
      const presented = Buffer.from(token.slice("v1.".length), "utf8");
      return expected.length === presented.length && timingSafeEqual(expected, presented);
    },
  };
}

function hmacFor(keyBytes: Buffer, runId: string, jobId: string): string {
  // The newline separator makes the two identities unambiguous: without it,
  // ("a" + "bc") and ("ab" + "c") would produce the same digest input. The
  // id grammar excludes newlines, so no id can smuggle one.
  return createHmac("sha256", keyBytes).update(`${runId}\n${jobId}`, "utf8").digest("hex");
}

function requireRunIdentity(value: string, field: string): void {
  if (typeof value !== "string" || !RUN_ID_RE.test(value)) {
    throw new RangeError(`result-channel ${field} must match the execution-id grammar`);
  }
}
