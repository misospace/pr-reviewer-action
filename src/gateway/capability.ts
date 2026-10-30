/** Run-scoped gateway capability tokens for #765: how the controller proves
 * that a model call belongs to THIS run, THIS model profile, under THESE
 * budget bounds — and how it refuses a worker that replays, forges, or
 * outlives its authorization.
 *
 * The pattern mirrors #735's result-channel token (`src/credentials/
 * result-channel.ts`): an HMAC-SHA256 over the bounded identity, keyed by a
 * controller signing key that never leaves the controller (never in any
 * token, never in any error). The token binds EXACTLY one
 * `(runId, modelProfile)` identity and carries its expiry, cancellation
 * generation, and budget limits INSIDE the MAC input, so none of them can
 * be stripped or forged. Cancellation is a generation bump: a token minted
 * for an older generation fails verification even before its expiry, so an
 * operator-cancelled run loses its model authority immediately.
 *
 * Verification is TOTAL over hostile input: a malformed, overlong,
 * foreign-format, forged, expired, wrong-run, wrong-profile,
 * stale-generation, or bounds-mismatched token returns a typed refusal from
 * the closed vocabulary — never a throw — and the comparison is
 * `timingSafeEqual`. Refusal reasons are fixed bounded strings that never
 * echo the token or any key material.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { RUN_ID_RE, isValidProfileName } from "../credentials/types.js";
import {
  validateBudgetLimits,
  type CapabilityRefusalCode,
  type CapabilityVerification,
  type GatewayBudgetLimits,
  type GatewayCapabilityAuth,
  type GatewayCapabilityIdentity,
  type MintedGatewayToken,
} from "./types.js";

/** Token grammar: `gw1.<expiry hex>.<generation hex>.<runId b64url>.
 * <profile b64url>.<maxRequests>.<maxTokens>.<maxCostMicros>.<64 hex mac>`.
 * The expiry and generation are carried so a verifier can enforce them
 * without shared state, and they are part of the MAC input so a hostile
 * worker cannot alter them; the identity fields are base64url so the
 * dot-separated grammar stays unambiguous (the id/profile grammars contain
 * no base64url characters). Versioned (`gw1`) so a future format change
 * cannot be confused with a v1 token by a lenient verifier. */
export const GATEWAY_TOKEN_RE =
  /^gw1\.[0-9a-f]{1,16}\.[0-9a-f]{1,8}\.[A-Za-z0-9_-]{1,172}\.[A-Za-z0-9_-]{1,88}\.[0-9]{1,15}\.[0-9]{1,15}\.[0-9]{1,15}\.[0-9a-f]{64}$/;

/** Default token lifetime (ms). Short by design — the run's deadline is the
 * real bound; this is the ceiling. */
export const GATEWAY_DEFAULT_TTL_MS = 3_600_000;

const MAX_TTL_MS = 7 * 24 * 3_600_000;

/** Upper bound on the token string the verifier will even look at — a
 * hostile caller cannot make the comparison allocate or digest an
 * unbounded input. */
const MAX_TOKEN_CHARS = 512;

/** Minimum cancellation generation a token may be minted for, and the
 * maximum the token grammar carries (8 hex digits). */
const MIN_GENERATION = 1;
const MAX_GENERATION = 0xffffffff;

export interface GatewayCapabilityAuthOptions {
  /** Controller signing key. Held in a closure the caller cannot reach;
   * never exposed, never logged, never included in any token. */
  readonly key: string;
  /** Injected clock, epoch milliseconds (used to enforce token expiry at
   * verify time; injected so tests stay deterministic). */
  readonly now?: (() => number) | undefined;
}

export function createGatewayCapabilityAuth(options: GatewayCapabilityAuthOptions): GatewayCapabilityAuth {
  const key = options.key;
  if (typeof key !== "string" || key.length < 16) {
    throw new RangeError("gateway signing key must be at least 16 characters");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new RangeError("gateway now must be a function");
  }
  const keyBytes = Buffer.from(key, "utf8");
  const now = options.now ?? Date.now;
  return {
    mint(identity, opts = {}): MintedGatewayToken {
      requireIdentity(identity);
      const ttlMs = opts.ttlMs ?? GATEWAY_DEFAULT_TTL_MS;
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
        throw new RangeError(`gateway ttlMs must be an integer in (0, ${MAX_TTL_MS}]`);
      }
      const limits = validateBudgetLimits(identity.limits);
      const expiresAtMs = now() + ttlMs;
      const expiryHex = expiresAtMs.toString(16);
      const generationHex = identity.generation.toString(16);
      const token = `gw1.${expiryHex}.${generationHex}.${encode(identity.runId)}.${encode(identity.modelProfile)}.` +
        `${limits.maxRequests}.${limits.maxTokens}.${limits.maxCostMicros}.` +
        `${macFor(keyBytes, identity.runId, identity.modelProfile, generationHex, expiryHex, limits)}`;
      return Object.freeze({ token, expiresAtMs, generation: identity.generation });
    },
    verifyDetailed(token, presented): CapabilityVerification {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) {
        return refusal("invalid_token", "capability token is absent or overlong");
      }
      if (!GATEWAY_TOKEN_RE.test(token)) {
        return refusal("invalid_token", "capability token is malformed or a foreign format");
      }
      const parts = token.split(".");
      if (parts.length !== 9 || parts[0] !== "gw1") {
        return refusal("invalid_token", "capability token is malformed or a foreign format");
      }
      const expiryHex = parts[1]!;
      const generationHex = parts[2]!;
      const runId = decode(parts[3]!);
      const modelProfile = decode(parts[4]!);
      const maxRequests = Number(parts[5]);
      const maxTokens = Number(parts[6]);
      const maxCostMicros = Number(parts[7]);
      const presentedMac = parts[8]!;
      if (runId === null || modelProfile === null) {
        return refusal("invalid_token", "capability token identity is malformed");
      }
      if (
        !Number.isSafeInteger(maxRequests) ||
        !Number.isSafeInteger(maxTokens) ||
        !Number.isSafeInteger(maxCostMicros) ||
        maxRequests < 0 ||
        maxTokens < 0 ||
        maxCostMicros < 0
      ) {
        return refusal("invalid_token", "capability token budget bounds are malformed");
      }
      const expiresAtMs = Number.parseInt(expiryHex, 16);
      const generation = Number.parseInt(generationHex, 16);
      if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(generation) || generation < MIN_GENERATION) {
        return refusal("invalid_token", "capability token expiry or generation is malformed");
      }
      const expectedMac = Buffer.from(
        macFor(keyBytes, runId, modelProfile, generationHex, expiryHex, {
          maxRequests,
          maxTokens,
          maxCostMicros,
        }),
        "utf8",
      );
      const mac = Buffer.from(presentedMac, "utf8");
      if (expectedMac.length !== mac.length || !timingSafeEqual(expectedMac, mac)) {
        return refusal("invalid_token", "capability token failed verification");
      }
      if (now() >= expiresAtMs) {
        return refusal("expired", "capability token has expired");
      }
      if (presented.runId !== runId) {
        return refusal("wrong_run", "capability token is bound to a different run");
      }
      if (presented.modelProfile !== modelProfile) {
        return refusal("profile_mismatch", "capability token is bound to a different model profile");
      }
      if (presented.expectedGeneration !== generation) {
        return refusal("cancelled", "capability token is bound to a cancelled generation of this run");
      }
      let limits: GatewayBudgetLimits;
      try {
        limits = validateBudgetLimits(presented.limits);
      } catch {
        return refusal("invalid_token", "presented budget bounds are malformed");
      }
      if (
        limits.maxRequests !== maxRequests ||
        limits.maxTokens !== maxTokens ||
        limits.maxCostMicros !== maxCostMicros
      ) {
        return refusal("budget_bounds_mismatch", "capability token budget bounds do not match the gateway's");
      }
      return { ok: true };
    },
  };
}

function macFor(
  keyBytes: Buffer,
  runId: string,
  modelProfile: string,
  generationHex: string,
  expiryHex: string,
  limits: GatewayBudgetLimits,
): string {
  // Newline-separated canonical fields (the #735 result-channel discipline):
  // without separators, ("a"+"bc") and ("ab"+"c") would produce the same
  // digest input. The id/profile grammars exclude newlines and the numeric
  // fields are carried in their canonical forms, so no field can smuggle a
  // separator.
  return createHmac("sha256", keyBytes)
    .update(
      `${runId}\n${modelProfile}\n${generationHex}\n${expiryHex}\n` +
        `${limits.maxRequests}\n${limits.maxTokens}\n${limits.maxCostMicros}`,
      "utf8",
    )
    .digest("hex");
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded === "" && value !== "" ? null : decoded;
  } catch {
    return null;
  }
}

function requireIdentity(identity: GatewayCapabilityIdentity): void {
  if (typeof identity !== "object" || identity === null) {
    throw new RangeError("gateway capability identity must be a mapping");
  }
  if (typeof identity.runId !== "string" || !RUN_ID_RE.test(identity.runId)) {
    throw new RangeError(`gateway capability identity.runId must match ${RUN_ID_RE.source}`);
  }
  if (typeof identity.modelProfile !== "string" || !isValidProfileName(identity.modelProfile) || identity.modelProfile === "") {
    throw new RangeError("gateway capability identity.modelProfile must be a non-empty profile name");
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation < MIN_GENERATION || identity.generation > MAX_GENERATION) {
    throw new RangeError(`gateway capability identity.generation must be an integer in [${MIN_GENERATION}, ${MAX_GENERATION}]`);
  }
  validateBudgetLimits(identity.limits);
}

function refusal(code: CapabilityRefusalCode, reason: string): CapabilityVerification {
  return Object.freeze({ ok: false as const, code, reason });
}
