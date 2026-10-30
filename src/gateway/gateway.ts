/** The model gateway for #765: the controller-side boundary one review
 * run's model traffic flows through when the operator enables gateway mode.
 *
 * The flow per call, in order: verify the run-scoped capability token
 * (expired/cancelled/wrong-run/wrong-profile tokens refuse with their own
 * closed codes — verification comes FIRST, before any profile existence
 * check, so an unauthenticated caller cannot enumerate configured
 * profiles) → resolve the token's profile endpoint → reserve the operator's
 * per-call budget bound against the run's remaining allowance BEFORE the
 * wire call → resolve the provider credential through
 * the #735 credential broker (purpose `model`, bound to the token's
 * profile and the run's forge scope) → call the provider through the
 * SHARED transport (`runChatRequest`) with the provider key traveling only
 * in the transport's auth header → record normalized usage (`UsageRecord`,
 * validated by `validateUsage`; cost from operator-configured per-million
 * pricing as `configured-estimate`, else the #736 never-fabricate rule:
 * zero cost, `unknown` provenance) → commit the reservation with actuals,
 * or refund it on failure.
 *
 * `call` is a TOTAL function: it never rejects. The response-byte ceiling
 * and any extra headers are operator config carried by the profile
 * endpoint — a worker supplies neither — and any unexpected throw from the
 * transport or credential seam becomes a typed `gateway_error` refusal
 * with the reservation refunded.
 *
 * What this seam deliberately does NOT do: it does not reimplement the
 * transport (streaming and non-streaming semantics are `runChatRequest`'s),
 * it does not route or fall back between providers (provider
 * fallback/routing stays the engine's declared route, never gateway
 * policy), and it never lets provider credentials reach the review
 * workspace: the gateway's outcomes carry the normalized response, the raw
 * provider body, and the usage record — never key material — and the
 * gateway object itself serializes to names and caps only.
 *
 * Budget refusal is its own stop reason (`budget_exhausted`, a closed
 * refusal code): it is never evidence about the PR and must never be
 * surfaced as a safety finding. Local/self-hosted endpoints are first-class:
 * a profile with no pricing records tokens normally at zero cost.
 */
import {
  validateBudgetLimits,
  validatePerRequestBudget,
  type BudgetLedger,
  type GatewayBudgetLimits,
  type GatewayCallInput,
  type GatewayCallOutcome,
  type GatewayCapabilityAuth,
  type GatewayPerRequestBudget,
  type GatewayProfileEndpoint,
  type GatewayRefusalCode,
  type ModelGateway,
} from "./types.js";
import { RUN_ID_RE, isSecretShapedValue, isValidProfileName, type CredentialBroker, type ResolutionRefusalCode } from "../credentials/types.js";
import { runChatRequest, type ChatRequestInput, type ChatRequestOutcome } from "../transport/transport.js";
import { TransportFailure } from "../transport/http.js";
import type { NormalizedModelResponse } from "../model/types.js";
import { usageWithoutCost } from "../state/usage.js";
import { validateUsage, type UsageCostProvenance, type UsageRecord } from "../state/types.js";

export interface ModelGatewayOptions {
  /** The run budget caps every capability token must carry and the ledger
   * enforces. Must equal the ledger's own caps (checked at construction —
   * two disagreeing cap sources would make admission and verification
   * diverge). */
  readonly caps: GatewayBudgetLimits;
  /** The operator-trusted worst-case reservation booked for a single call.
   * Admission reserves THIS, never a worker figure, so a worker cannot
   * under-estimate to bypass the run budget; bounded by `caps`. */
  readonly perRequestBudget: GatewayPerRequestBudget;
  readonly ledger: BudgetLedger;
  readonly capability: GatewayCapabilityAuth;
  readonly broker: CredentialBroker;
  /** The opaque reference of the selected profile's provider credential in
   * the #735 broker — never the material itself. */
  readonly modelCredentialRef: string;
  /** The controller-side per-profile endpoint configuration, keyed by
   * profile name on a null-prototype record (a key like "constructor" is a
   * name, not a profile). No secret material belongs here. */
  readonly profiles: Readonly<Record<string, GatewayProfileEndpoint>>;
  /** Injected clock, epoch ms. */
  readonly now?: (() => number) | undefined;
  /** The transport seam; defaults to the shared `runChatRequest`. Injectable
   * for tests — never reimplemented by this module. */
  readonly runChat?: ((input: ChatRequestInput) => Promise<ChatRequestOutcome>) | undefined;
}

/** Perform one gateway call. */
export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const caps = validateBudgetLimits(options.caps);
  const ledgerCaps = options.ledger.caps();
  if (
    ledgerCaps.maxRequests !== caps.maxRequests ||
    ledgerCaps.maxTokens !== caps.maxTokens ||
    ledgerCaps.maxCostMicros !== caps.maxCostMicros
  ) {
    throw new RangeError("gateway caps must equal the budget ledger's caps");
  }
  if (typeof options.broker?.resolve !== "function") {
    throw new RangeError("gateway broker must implement the credential broker seam");
  }
  const perRequestBudget = validatePerRequestBudget(options.perRequestBudget, caps);
  if (typeof options.modelCredentialRef !== "string" || options.modelCredentialRef === "") {
    throw new RangeError("gateway modelCredentialRef must be a non-empty opaque reference");
  }
  if (isSecretShapedValue(options.modelCredentialRef)) {
    throw new RangeError("gateway modelCredentialRef looks like secret material, not an opaque reference");
  }
  const profiles = validateProfiles(options.profiles);
  const runChat = options.runChat ?? runChatRequest;
  const now = options.now ?? Date.now;
  return {
    async call(input: GatewayCallInput): Promise<GatewayCallOutcome> {
      // Total function: `call` never rejects. Any unexpected throw from a
      // seam (transport, broker) is converted into a typed closed-code
      // refusal with the reservation refunded — a seam crash must never
      // escape as a raw rejection or strand a reservation.
      let reservedId: string | null = null;
      try {
        const shape = validateCallInput(input);
        if (shape !== "") {
          return refusal("invalid_request", shape, null, null);
        }
        // Capability verification FIRST: an unauthenticated caller learns
        // nothing about which profiles this gateway serves — a bad token
        // gets a capability refusal, never a profile-existence oracle.
        const expectedGeneration = options.ledger.generationFor(input.runId);
        const verdict = options.capability.verifyDetailed(input.token, {
          runId: input.runId,
          modelProfile: input.modelProfile,
          expectedGeneration,
          limits: caps,
        });
        if (!verdict.ok) {
          return refusal(verdict.code, verdict.reason, null, null);
        }
        const profile = Object.hasOwn(profiles, input.modelProfile)
          ? profiles[input.modelProfile]!
          : undefined;
        if (profile === undefined) {
          return refusal("unknown_profile", "the token's model profile has no gateway endpoint configuration", null, null);
        }
        // The admission bound is the OPERATOR's per-request budget, never a
        // worker figure: a worker cannot under-estimate (zero) to slip a
        // request past the run's signed allowance before the actuals land.
        const reservation = options.ledger.reserve({
          reservationId: input.reservationId,
          runId: input.runId,
          generation: expectedGeneration,
          modelProfile: input.modelProfile,
          estimatedTokens: perRequestBudget.maxTokens,
          estimatedCostMicros: perRequestBudget.maxCostMicros,
        });
        if (!reservation.ok) {
          return refusal(reservation.code, reservation.reason, null, null);
        }
        if (reservation.reservation.state !== "reserved") {
          return refusal(
            "reservation_settled",
            "this reservation id was already settled; a retried request must use a fresh reservation id",
            null,
            null,
          );
        }
        reservedId = input.reservationId;
        const resolved = await options.broker.resolve(options.modelCredentialRef, {
          purpose: "model",
          platform: input.platform,
          installationId: input.installationId,
          repoFullName: input.repoFullName,
          profileName: input.modelProfile,
        });
        if (!resolved.ok) {
          options.ledger.refund(input.reservationId);
          reservedId = null;
          return refusal(
            "credential_refused",
            `credential broker refused the model credential (${resolved.code}): ${CREDENTIAL_REFUSAL_REASONS[resolved.code]}`,
            null,
            null,
          );
        }
        // The response-byte ceiling is the OPERATOR's profile config, never
        // worker input; extra headers are operator config the transport
        // seam applies itself — the worker supplies neither.
        const outcome = await runChat({
          baseUrl: profile.baseUrl,
          apiFormat: profile.apiFormat,
          payload: input.payload,
          apiKey: resolved.material.value,
          anthropicVersion: profile.anthropicVersion,
          requestTimeoutSec: profile.requestTimeoutSec,
          connectTimeoutSec: profile.connectTimeoutSec,
          ...(profile.maxResponseBytes !== undefined ? { maxResponseBytes: profile.maxResponseBytes } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        if (outcome.status === "ok") {
          const usage = buildUsageRecord(input, outcome.response, profile.pricing, now());
          if (usage === null) {
            // The provider-billed call succeeded but produced an
            // unvalidatable usage record: fail closed — refund the
            // reservation AND still record the attempt honestly (never
            // erase a provider-billed call from the accounting).
            options.ledger.refund(input.reservationId);
            reservedId = null;
            return refusal("usage_record_invalid", "the produced usage record failed durable-shape validation", attemptRecord(input, now()), null);
          }
          const committed = options.ledger.commit(input.reservationId, {
            requestCount: 1,
            tokens: usage.inputTokens + usage.outputTokens,
            costMicros: usage.costMicros,
          });
          if (!committed.ok) {
            options.ledger.refund(input.reservationId);
            reservedId = null;
            return refusal(committed.code, committed.reason, usage, null);
          }
          reservedId = null;
          return Object.freeze({
            ok: true as const,
            response: outcome.response,
            raw: outcome.raw,
            usage,
          });
        }
        options.ledger.refund(input.reservationId);
        reservedId = null;
        return Object.freeze({
          ok: false as const,
          code: "transport_failure",
          reason: `model request failed (${outcome.failure.kind})`,
          usage: attemptRecord(input, now()),
          transportFailure: outcome.failure,
        });
      } catch (error) {
        if (reservedId !== null) {
          // A committed row refuses the refund safely, so this can never
          // double-credit a settled reservation.
          options.ledger.refund(reservedId);
        }
        return refusal(
          "gateway_error",
          "the gateway's transport or credential seam threw an unexpected error",
          null,
          null,
        );
      }
    },
    describe() {
      return Object.freeze({
        caps,
        perRequestBudget,
        modelCredentialRef: options.modelCredentialRef,
        profileNames: Object.freeze(Object.keys(profiles).sort()),
      });
    },
    toJSON(): Record<string, unknown> {
      return { gateway: "model", ...this.describe() };
    },
  };
}

function refusal(
  code: GatewayRefusalCode,
  reason: string,
  usage: UsageRecord | null,
  transportFailure: TransportFailure | null,
): GatewayCallOutcome {
  return Object.freeze({ ok: false as const, code, reason, usage, transportFailure });
}

/** Fixed, bounded reasons for the broker's refusal codes: the gateway's own
 * refusal surface never interpolates a foreign reason string unbounded —
 * the code identifies the refusal, this table supplies the words. */
const CREDENTIAL_REFUSAL_REASONS: Readonly<Record<ResolutionRefusalCode, string>> = Object.freeze(
  Object.assign(Object.create(null), {
    unknown_reference: "the credential reference is not held by this broker",
    expired: "the credential material has expired or could not be refreshed",
    revoked: "the credential reference has been revoked",
    scope_mismatch: "the credential is bound to a different scope than this run",
    invalid_request: "the credential request was malformed",
  }),
);

/** The honest attempt row for a call that did not settle with usable
 * provider usage: one logical request, zero tokens, zero cost, `unknown`
 * provenance (the #736 never-fabricate rule). Returns null when the
 * caller-supplied usage id fails durable-shape validation — the attempt is
 * then simply not recordable, and the refusal carries that fact. */
function attemptRecord(input: GatewayCallInput, recordedAtMs: number): UsageRecord | null {
  return validateUsage(
    usageWithoutCost({
      usageId: input.usageId,
      runId: input.runId,
      route: input.modelProfile,
      role: input.role,
      requestCount: 1,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      recordedAtMs,
    }),
  );
}

/** Validate the per-profile endpoint configuration at construction: every
 * key a valid profile name, every endpoint an http(s) URL with no embedded
 * credentials (userinfo in a URL is a credential leak channel, not an
 * endpoint), bounded timeouts. Returns a frozen null-prototype copy. */
function validateProfiles(
  profiles: Readonly<Record<string, GatewayProfileEndpoint>>,
): Readonly<Record<string, GatewayProfileEndpoint>> {
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
    throw new RangeError("gateway profiles must be a mapping of profile name to endpoint config");
  }
  const checked = Object.create(null) as Record<string, GatewayProfileEndpoint>;
  for (const name of Object.keys(profiles)) {
    if (!isValidProfileName(name) || name === "") {
      throw new RangeError(`gateway profile name '${name.slice(0, 16)}' is malformed`);
    }
    const endpoint = profiles[name]!;
    if (typeof endpoint !== "object" || endpoint === null) {
      throw new RangeError(`gateway profile '${name}' endpoint must be a mapping`);
    }
    if (typeof endpoint.baseUrl !== "string" || !isSafeBaseUrl(endpoint.baseUrl)) {
      throw new RangeError(`gateway profile '${name}' baseUrl must be an http(s) URL without embedded credentials`);
    }
    if (endpoint.apiFormat !== "openai" && endpoint.apiFormat !== "anthropic") {
      throw new RangeError(`gateway profile '${name}' apiFormat must be 'openai' or 'anthropic'`);
    }
    if (typeof endpoint.anthropicVersion !== "string") {
      throw new RangeError(`gateway profile '${name}' anthropicVersion must be a string`);
    }
    for (const field of ["requestTimeoutSec", "connectTimeoutSec"] as const) {
      const value = endpoint[field];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`gateway profile '${name}' ${field} must be a positive integer`);
      }
    }
    if (
      endpoint.maxResponseBytes !== undefined &&
      (typeof endpoint.maxResponseBytes !== "number" || !Number.isSafeInteger(endpoint.maxResponseBytes) || endpoint.maxResponseBytes < 1)
    ) {
      throw new RangeError(`gateway profile '${name}' maxResponseBytes must be a positive integer`);
    }
    if (endpoint.pricing !== undefined) {
      const pricing = endpoint.pricing;
      if (
        typeof pricing !== "object" ||
        pricing === null ||
        !Number.isSafeInteger(pricing.inputMicrosPerMillion) ||
        pricing.inputMicrosPerMillion < 0 ||
        !Number.isSafeInteger(pricing.outputMicrosPerMillion) ||
        pricing.outputMicrosPerMillion < 0
      ) {
        throw new RangeError(`gateway profile '${name}' pricing must be non-negative integer micros per million tokens`);
      }
    }
    checked[name] = Object.freeze({
      ...endpoint,
      ...(endpoint.pricing !== undefined ? { pricing: Object.freeze({ ...endpoint.pricing }) } : {}),
    });
  }
  return Object.freeze(checked);
}

function isSafeBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // Userinfo in a URL is a credential smuggled through the endpoint field.
  if (url.username !== "" || url.password !== "") return false;
  return true;
}

/** Structural validation of one call input: grammars and bounded integers.
 * Returns "" when the input is well-formed, otherwise a fixed reason. */
function validateCallInput(input: GatewayCallInput): string {
  if (typeof input !== "object" || input === null) return "gateway call input must be a mapping";
  if (typeof input.token !== "string" || input.token === "" || input.token.length > 512) {
    return "gateway call token is absent or overlong";
  }
  if (typeof input.runId !== "string" || !RUN_ID_RE.test(input.runId)) {
    return "gateway call run id is malformed";
  }
  if (typeof input.modelProfile !== "string" || !isValidProfileName(input.modelProfile) || input.modelProfile === "") {
    return "gateway call model profile is malformed";
  }
  if (input.role !== "primary" && input.role !== "specialist" && input.role !== "tool" && input.role !== "evidence" && input.role !== "judge") {
    return "gateway call role must be a UsageRole";
  }
  if (typeof input.usageId !== "string" || input.usageId.length === 0 || input.usageId.length > 256 || input.usageId !== input.usageId.trim()) {
    return "gateway call usage id is malformed";
  }
  if (typeof input.reservationId !== "string" || input.reservationId.length === 0 || input.reservationId.length > 128 || input.reservationId !== input.reservationId.trim()) {
    return "gateway call reservation id is malformed";
  }
  if (input.platform !== "github" && input.platform !== "forgejo") {
    return "gateway call platform must be 'github' or 'forgejo'";
  }
  if (typeof input.installationId !== "string" || input.installationId.length > 128) {
    return "gateway call installation id is malformed";
  }
  if (typeof input.repoFullName !== "string" || input.repoFullName === "" || input.repoFullName.length > 256) {
    return "gateway call repository is malformed";
  }
  if (typeof input.payload !== "object" || input.payload === null || typeof input.payload.body !== "object" || input.payload.body === null) {
    return "gateway call payload is malformed";
  }
  return "";
}

/** Build the normalized usage record for a successful call: tokens from the
 * provider-reported usage, one logical request, cost from the profile's
 * configured pricing (`configured-estimate`) or — when no pricing is
 * configured, the common local/self-hosted case — zero cost with `unknown`
 * provenance (the #736 never-fabricate rule, via `usageWithoutCost`).
 * Returns null when the caller-supplied usage id makes the record fail
 * `validateUsage` (fail closed: never accept an unvalidatable record as
 * durable-shaped). */
function buildUsageRecord(
  input: GatewayCallInput,
  response: NormalizedModelResponse,
  pricing: { inputMicrosPerMillion: number; outputMicrosPerMillion: number } | undefined,
  recordedAtMs: number,
): UsageRecord | null {
  const inputTokens = response.usage?.promptTokens ?? 0;
  const outputTokens = response.usage?.completionTokens ?? 0;
  const cacheReadTokens = response.usage?.cacheReadTokens ?? 0;
  const cacheWriteTokens = response.usage?.cacheWriteTokens ?? 0;
  let costMicros = 0;
  let costProvenance: UsageCostProvenance = "unknown";
  if (pricing !== undefined) {
    costMicros = Math.round(
      (inputTokens * pricing.inputMicrosPerMillion + outputTokens * pricing.outputMicrosPerMillion) / 1_000_000,
    );
    costProvenance = "configured-estimate";
  }
  const candidate: UsageRecord = costProvenance === "unknown"
    ? usageWithoutCost({
        usageId: input.usageId,
        runId: input.runId,
        route: input.modelProfile,
        role: input.role,
        requestCount: 1,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        recordedAtMs,
      })
    : Object.freeze({
        usageId: input.usageId,
        runId: input.runId,
        route: input.modelProfile,
        role: input.role,
        requestCount: 1,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        costMicros,
        costProvenance,
        recordedAtMs,
      });
  return validateUsage(candidate);
}
