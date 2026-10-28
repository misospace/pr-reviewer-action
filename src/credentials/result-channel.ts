/** Run-scoped result-channel authentication for #735: how the controller
 * proves that a result artifact belongs to THIS execution attempt — and how
 * it refuses a worker that tries to submit for another run.
 *
 * The result protocol (#733) is a file at a controller-owned path, keyed by
 * the correlation identity (`runId`). But a path alone is only a coordinate;
 * the result-channel token binds the SUBMISSION AUTHORITY to the exact
 * `(runId, jobId, installationId, repoFullName)` identity: the worker
 * receives a short token derived from the controller's signing key, and a
 * verifier recomputes the same derivation for the run it is checking. A
 * token minted for run A can never authorize a submission for run B — the
 * hash of a different identity is a different token — and a hostile worker
 * that replays, mutates, or forges a token fails the constant-time
 * comparison. The token EXPIRES (the expiry is part of the MAC input, so it
 * cannot be stripped or forged): once past its lifetime a verifier refuses
 * it even for the original run, so cancellation/expiry bounds its
 * usefulness.
 *
 * This is the "authenticated result/report channel credential" from the
 * issue's worker-credential list: minimal (a MAC, not a bearer secret to any
 * shared store), run-scoped, expiring, and derived — the controller signing
 * key itself never leaves the controller.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { RUN_ID_RE, isValidProfileName } from "./types.js";

export interface ResultChannelAuthOptions {
  /** Controller signing key. Held in a closure the caller cannot reach;
   * never exposed, never logged, never included in any token. */
  readonly key: string;
  /** Injected clock, epoch milliseconds (used to enforce token expiry at
   * verify time; injected so tests stay deterministic). */
  readonly now?: (() => number) | undefined;
}

/** Token grammar: `v1.<expiry hex>.<64 lowercase hex>` — the expiry is
 * carried in the token so a verifier can enforce it without shared state,
 * and it is part of the MAC input so a hostile worker cannot alter it.
 * Versioned so a future format change cannot be confused with a v1 token by
 * a lenient verifier. */
export const RESULT_CHANNEL_TOKEN_RE = /^v1\.[0-9a-f]{1,16}\.[0-9a-f]{64}$/;

/** The identity a result-channel token is bound to: the correlation
 * identity plus the repository scope the plan carries, so a token minted in
 * one repository's context can never authorize a submission in another's. */
export interface ResultChannelIdentity {
  readonly runId: string;
  readonly jobId: string;
  readonly installationId: string;
  readonly repoFullName: string;
}

/** Default token lifetime (ms). Short by design — the run's deadline is the
 * real bound; this is the ceiling. */
export const RESULT_CHANNEL_DEFAULT_TTL_MS = 3_600_000;

export interface MintedResultChannelToken {
  readonly token: string;
  /** Epoch ms the token stops being valid (already enforced by `verify`). */
  readonly expiresAtMs: number;
}

export interface ResultChannelAuth {
  /** Mint the submission token for one correlation identity. */
  mint(
    identity: ResultChannelIdentity,
    opts?: { ttlMs?: number | undefined },
  ): MintedResultChannelToken;
  /** Verify a presented token against a correlation identity, enforcing the
   * token's own expiry against the injected clock. Total function over
   * hostile input: any malformed, foreign-format, overlong, expired, or
   * mismatched token is `false`, never a throw. */
  verify(token: string, identity: ResultChannelIdentity): boolean;
}

/** Upper bound on the token string the verifier will even look at — a
 * hostile caller cannot make the comparison allocate or digest an
 * unbounded input. */
const MAX_TOKEN_CHARS = 256;

const MAX_TTL_MS = 7 * 24 * 3_600_000;

export function createResultChannelAuth(options: ResultChannelAuthOptions): ResultChannelAuth {
  const key = options.key;
  if (typeof key !== "string" || key.length < 16) {
    throw new RangeError("result-channel signing key must be at least 16 characters");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new RangeError("result-channel now must be a function");
  }
  const keyBytes = Buffer.from(key, "utf8");
  const now = options.now ?? Date.now;
  return {
    mint(identity, opts = {}): MintedResultChannelToken {
      requireIdentity(identity);
      const ttlMs = opts.ttlMs ?? RESULT_CHANNEL_DEFAULT_TTL_MS;
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
        throw new RangeError(`result-channel ttlMs must be an integer in (0, ${MAX_TTL_MS}]`);
      }
      const expiresAtMs = now() + ttlMs;
      const expiryHex = expiresAtMs.toString(16);
      return Object.freeze({
        token: `v1.${expiryHex}.${hmacFor(keyBytes, identity, expiryHex)}`,
        expiresAtMs,
      });
    },
    verify(token, identity): boolean {
      if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return false;
      if (!RESULT_CHANNEL_TOKEN_RE.test(token)) return false;
      if (!validIdentity(identity)) return false;
      const expiryHex = token.slice("v1.".length, token.indexOf(".", "v1.".length));
      const expiresAtMs = Number.parseInt(expiryHex, 16);
      if (!Number.isSafeInteger(expiresAtMs)) return false;
      if (now() >= expiresAtMs) return false;
      const expected = Buffer.from(hmacFor(keyBytes, identity, expiryHex), "utf8");
      const macStart = "v1.".length + expiryHex.length + 1;
      const presented = Buffer.from(token.slice(macStart), "utf8");
      return expected.length === presented.length && timingSafeEqual(expected, presented);
    },
  };
}

function hmacFor(keyBytes: Buffer, identity: ResultChannelIdentity, expiryHex: string): string {
  // Newline separators make the identity fields unambiguous: without them,
  // ("a"+"bc") and ("ab"+"c") would produce the same digest input. The id
  // and profile grammars exclude newlines, so no field can smuggle one.
  return createHmac("sha256", keyBytes)
    .update(
      `${identity.runId}\n${identity.jobId}\n${identity.installationId}\n` +
        `${identity.repoFullName}\n${expiryHex}`,
      "utf8",
    )
    .digest("hex");
}

function validIdentity(identity: ResultChannelIdentity): boolean {
  return (
    typeof identity === "object" &&
    identity !== null &&
    RUN_ID_RE.test(identity.runId) &&
    RUN_ID_RE.test(identity.jobId) &&
    typeof identity.installationId === "string" &&
    typeof identity.repoFullName === "string" &&
    identity.repoFullName !== "" &&
    isValidProfileName(identity.installationId)
  );
}

function requireIdentity(identity: ResultChannelIdentity): void {
  if (!validIdentity(identity)) {
    throw new RangeError("result-channel identity must carry a valid run/job identity and repo scope");
  }
}
