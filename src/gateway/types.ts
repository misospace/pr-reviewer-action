/** Model gateway contracts for #765: the run-scoped, budget-bounded,
 * provider-key-isolated model-call boundary between a review run and the
 * provider credentials the controller holds.
 *
 * The rule this module enforces: a review run presents a short-lived
 * capability token authorizing EXACTLY one `(runId, modelProfile)` identity
 * under explicit budget bounds until an expiry or a cancellation
 * generation; the controller-side gateway resolves the provider credential,
 * performs the call through the shared transport (`runChatRequest`), and
 * records normalized usage — and the provider key never enters the review
 * workspace or the gateway's returned objects.
 *
 * Like every contract layer before it (#728 events, #731 queue, #733
 * executor, #735 credentials, #736 state), every refusal is a closed,
 * deterministic code with a fixed bounded reason, and no runtime I/O lives
 * here. Worker-facing contracts (`GatewayCallInput`, `BudgetReservationRow`,
 * `UsageRecord`-shaped output) carry every field required with an explicit
 * sentinel (`""`/`0`/`false`) instead of an optional; the two
 * OPERATOR-SIDED config shapes (`GatewayProfileEndpoint`, the mint options)
 * deliberately use explicit `| undefined` optionals — they are
 * controller-owned configuration, never durable records, never worker
 * input. This is a library for the future self-hosted controller daemon
 * (#725): nothing wires it into the running action pipeline.
 */
import type { ApiFormat, NormalizedModelResponse, TransportWirePayload } from "../model/types.js";
import type { UsageRecord, UsageRole } from "../state/types.js";
import type { TransportFailure } from "../transport/http.js";

/** The budget bounds a capability token authorizes for one run: at most
 * `maxRequests` model requests, at most `maxTokens` input+output tokens
 * (cache reads/writes are recorded in usage but do not consume this cap),
 * and at most `maxCostMicros` cost. All three are safe non-negative
 * integers; request and token caps must be at least 1 (a token authorizing
 * zero requests is meaningless), the cost cap may be 0 (a hard no-cost
 * grant — which local models with unknown pricing still satisfy, because
 * unknown pricing contributes 0 cost while tokens/requests still count). */
export interface GatewayBudgetLimits {
  readonly maxRequests: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number;
}

/** Upper bound on any single budget-limit figure: the capability-token
 * grammar carries each limit as at most 15 decimal digits, so validation
 * refuses a value the token could not round-trip. */
export const MAX_BUDGET_LIMIT = 999_999_999_999_999;

/** Fail-closed validation of budget limits: every field a safe non-negative
 * integer within the token grammar's bound, request/token caps at least 1.
 * Returns a frozen copy — never the caller's own object. Throws `RangeError`
 * on any problem (construction errors are programmer errors, the same
 * posture as the result-channel factory's argument checks). */
export function validateBudgetLimits(value: GatewayBudgetLimits): GatewayBudgetLimits {
  if (typeof value !== "object" || value === null) {
    throw new RangeError("gateway budget limits must be a mapping");
  }
  const maxRequests = value.maxRequests;
  const maxTokens = value.maxTokens;
  const maxCostMicros = value.maxCostMicros;
  for (const [name, amount] of [
    ["maxRequests", maxRequests],
    ["maxTokens", maxTokens],
    ["maxCostMicros", maxCostMicros],
  ] as const) {
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError(`gateway budget limits.${name} must be a safe non-negative integer`);
    }
    if (amount > MAX_BUDGET_LIMIT) {
      throw new RangeError(`gateway budget limits.${name} must be at most ${MAX_BUDGET_LIMIT}`);
    }
  }
  if (maxRequests < 1) {
    throw new RangeError("gateway budget limits.maxRequests must be at least 1");
  }
  if (maxTokens < 1) {
    throw new RangeError("gateway budget limits.maxTokens must be at least 1");
  }
  return Object.freeze({ maxRequests, maxTokens, maxCostMicros });
}

/** Why a capability-token verification refused, as a closed union. The
 * vocabulary lives in a RUNTIME array so a consumer that must echo a refusal
 * code can derive its closed set from here instead of re-typing it (the
 * same anti-drift rationale as `RESOLUTION_REFUSAL_CODES`). */
export const CAPABILITY_REFUSAL_CODES = Object.freeze([
  "invalid_token",
  "expired",
  "wrong_run",
  "profile_mismatch",
  "cancelled",
  "budget_bounds_mismatch",
] as const);

/** Why a capability-token verification refused, as a closed union — derived
 * from the runtime vocabulary above, so the type and the array cannot
 * disagree. */
export type CapabilityRefusalCode = (typeof CAPABILITY_REFUSAL_CODES)[number];

/** A capability-token verification verdict: `ok` or a refusal code with a
 * fixed, bounded reason — never a URL, a response body, or any token or
 * credential material. */
export type CapabilityVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CapabilityRefusalCode; readonly reason: string };

/** Why a budget-ledger operation refused, as a closed union (same
 * runtime-array discipline). */
export const BUDGET_REFUSAL_CODES = Object.freeze([
  "invalid_request",
  "reservation_mismatch",
  "budget_exhausted",
  "cancelled",
  "unknown_reservation",
] as const);

/** Why a budget-ledger operation refused, as a closed union — derived from
 * the runtime vocabulary above. */
export type BudgetRefusalCode = (typeof BUDGET_REFUSAL_CODES)[number];

/** The gateway's own refusal vocabulary: every capability and budget
 * refusal passes through, plus the gateway's own seam decisions (no
 * endpoint configured for the token's profile, the credential broker
 * refused, a reservation was already settled so a replayed id may not
 * re-call the provider, a caller-supplied usage id failed durable-shape
 * validation, the transport itself failed, or the transport/broker seam
 * threw an unexpected non-transport error — the gateway call is a TOTAL
 * function and converts that into this typed refusal instead of
 * rejecting). Derived from the sub-vocabularies so the sets cannot drift
 * apart. */
export const GATEWAY_REFUSAL_CODES = Object.freeze([
  ...CAPABILITY_REFUSAL_CODES,
  ...BUDGET_REFUSAL_CODES,
  "unknown_profile",
  "credential_refused",
  "reservation_settled",
  "usage_record_invalid",
  "transport_failure",
  "gateway_error",
] as const);

/** Why a gateway call refused, as a closed union — derived from the runtime
 * vocabulary above. */
export type GatewayRefusalCode = (typeof GATEWAY_REFUSAL_CODES)[number];

/** Per-million-token pricing an operator MAY configure for a model profile
 * (micros of the provider's currency unit per million input/output
 * tokens). Absent pricing is the common self-hosted case: the gateway
 * records tokens and requests normally while cost stays explicitly
 * `unknown` and zero — never fabricated (the #736 usage rule). */
export interface GatewayProfilePricing {
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
}

/** The controller-side, secret-free endpoint configuration for one model
 * profile: where the gateway calls and how. The provider credential is NOT
 * here — it is resolved through the #735 credential broker at call time and
 * travels only in the transport's auth header. */
export interface GatewayProfileEndpoint {
  readonly baseUrl: string;
  readonly apiFormat: ApiFormat;
  readonly anthropicVersion: string;
  readonly requestTimeoutSec: number;
  readonly connectTimeoutSec: number;
  /** Response-byte ceiling override (#745); unset = transport default. */
  readonly maxResponseBytes?: number | undefined;
  readonly pricing?: GatewayProfilePricing | undefined;
}

/** One budget reservation row: the durable-shaped accounting unit a
 * reserve-before-call creates. `state` carries the lifecycle; the `actual*`
 * fields carry the settled usage (0 sentinels until committed); `overran`
 * records that the committed ACTUALS exceeded the reserved estimate bounds
 * (admission gates on estimates; the ledger records reality and flags the
 * overrun instead of hiding it). The row is plain serializable data — no
 * credential material — so a durable backend (the #736 store) can persist
 * and replay it across a controller restart. */
export interface BudgetReservationRow {
  readonly reservationId: string;
  readonly runId: string;
  readonly generation: number;
  readonly modelProfile: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
  readonly state: "reserved" | "committed" | "refunded";
  readonly actualRequestCount: number;
  readonly actualTokens: number;
  readonly actualCostMicros: number;
  /** `true` only on committed rows whose actual tokens or cost exceeded
   * the reserved estimate bounds (the worker-supplied estimate was too
   * small). Admission still gated the reservation; this flag makes the
   * overshoot visible instead of silently absorbed. */
  readonly overran: boolean;
  readonly reservedAtMs: number;
  /** Epoch ms the row was settled (committed or refunded); 0 = live. */
  readonly settledAtMs: number;
}

/** Validate an unknown value as a `BudgetReservationRow`; returns a rebuilt,
 * frozen row (extras dropped) or null when malformed. The ONE definition of
 * a valid reservation row, shared by the in-memory ledger's writes and by
 * any durable backend seeding the ledger from persisted rows after a
 * restart. */
export function validateBudgetReservationRow(value: unknown): BudgetReservationRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const reservationId = rowIdentifier(record["reservationId"], 128);
  if (reservationId === null) return null;
  const runId = rowIdentifier(record["runId"], 128);
  if (runId === null) return null;
  const generation = record["generation"];
  if (!isSafeNonNegativeInteger(generation) || generation < 1) return null;
  const modelProfile = rowIdentifier(record["modelProfile"], 64);
  if (modelProfile === null) return null;
  const estimatedTokens = record["estimatedTokens"];
  if (!isSafeNonNegativeInteger(estimatedTokens)) return null;
  const estimatedCostMicros = record["estimatedCostMicros"];
  if (!isSafeNonNegativeInteger(estimatedCostMicros)) return null;
  const state = record["state"];
  if (state !== "reserved" && state !== "committed" && state !== "refunded") return null;
  const actualRequestCount = record["actualRequestCount"];
  if (!isSafeNonNegativeInteger(actualRequestCount)) return null;
  if (state === "committed" && actualRequestCount < 1) return null;
  const actualTokens = record["actualTokens"];
  if (!isSafeNonNegativeInteger(actualTokens)) return null;
  const actualCostMicros = record["actualCostMicros"];
  if (!isSafeNonNegativeInteger(actualCostMicros)) return null;
  const overran = record["overran"];
  if (typeof overran !== "boolean") return null;
  if (state !== "committed" && overran) return null;
  const reservedAtMs = record["reservedAtMs"];
  if (!isSafeNonNegativeInteger(reservedAtMs)) return null;
  const settledAtMs = record["settledAtMs"];
  if (!isSafeNonNegativeInteger(settledAtMs)) return null;
  if (state === "reserved" && settledAtMs !== 0) return null;
  if (state !== "reserved" && settledAtMs <= 0) return null;
  return Object.freeze({
    reservationId,
    runId,
    generation,
    modelProfile,
    estimatedTokens,
    estimatedCostMicros,
    state,
    actualRequestCount,
    actualTokens,
    actualCostMicros,
    overran,
    reservedAtMs,
    settledAtMs,
  });
}

/** One durable per-run cancellation-generation record. Cancellation state
 * is NOT inferable from reservation rows (a cancelled run may have no
 * gen-2 reservation at all), so the ledger records it explicitly and a
 * restarted controller re-seeds from these rows — without them, a
 * cancelled run's outstanding older-generation capability tokens would
 * verify again after a restart. */
export interface BudgetRunGenerationRow {
  readonly runId: string;
  readonly generation: number;
}

/** Validate an unknown value as a `BudgetRunGenerationRow`; returns a
 * rebuilt, frozen row (extras dropped) or null when malformed. */
export function validateBudgetRunGeneration(value: unknown): BudgetRunGenerationRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const runId = rowIdentifier(record["runId"], 128);
  if (runId === null) return null;
  const generation = record["generation"];
  if (!isSafeNonNegativeInteger(generation) || generation < 1) return null;
  return Object.freeze({ runId, generation });
}

function rowIdentifier(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  if (value !== value.trim()) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The controller-side worst-case reservation the gateway books for a
 * SINGLE model call. Admission reserves THIS operator-trusted bound and
 * NEVER any worker-supplied figure: an untrusted worker cannot under-
 * estimate (e.g. zero) to slip a request past the run's signed budget
 * before the provider-billed actuals are recorded (the same posture as the
 * response-byte ceiling, which is likewise operator config the worker cannot
 * set). Sized by the operator to the largest single call the profile makes
 * and bounded by the run's own caps so a single request can never reserve
 * past them. */
export interface GatewayPerRequestBudget {
  readonly maxTokens: number;
  readonly maxCostMicros: number;
}

/** Fail-closed validation of the per-request reservation bound against the
 * run caps. Tokens reserve at least 1 (a request that reserves no tokens
 * would make the token cap unenforceable — the same reason
 * `validateBudgetLimits` requires the run token cap to be at least 1); cost
 * may be 0 (a hard no-cost grant, satisfying a zero cost cap). The bound may
 * never exceed the run caps it reserves inside. Throws `RangeError` (a
 * construction-time programmer/configuration error). */
export function validatePerRequestBudget(
  value: GatewayPerRequestBudget,
  caps: GatewayBudgetLimits,
): GatewayPerRequestBudget {
  const checkedCaps = validateBudgetLimits(caps);
  if (typeof value !== "object" || value === null) {
    throw new RangeError("gateway per-request budget must be a mapping");
  }
  const maxTokens = value.maxTokens;
  const maxCostMicros = value.maxCostMicros;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("gateway per-request budget.maxTokens must be an integer of at least 1");
  }
  if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) {
    throw new RangeError("gateway per-request budget.maxCostMicros must be a safe non-negative integer");
  }
  if (maxTokens > checkedCaps.maxTokens) {
    throw new RangeError("gateway per-request budget.maxTokens must not exceed the run token cap");
  }
  if (maxCostMicros > checkedCaps.maxCostMicros) {
    throw new RangeError("gateway per-request budget.maxCostMicros must not exceed the run cost cap");
  }
  return Object.freeze({ maxTokens, maxCostMicros });
}

/** The budget reservation input shape: the caller-supplied idempotency id,
 * a token bound, and a cost bound. The bound is the ADMISSION quantity the
 * caps are enforced against before the wire call; the settled usage
 * (actuals) is what the accounting records. The gateway passes its
 * operator-trusted per-request bound here (never a worker figure); the
 * field stays an explicit input because the durable #736 backend re-seeds
 * historical rows whose bound was recorded at reserve time. */
export interface BudgetReservationInput {
  readonly reservationId: string;
  readonly runId: string;
  /** The generation the caller's capability was minted for; a reservation
   * for an older generation than the ledger's current one is a cancelled
   * run and is refused. */
  readonly generation: number;
  readonly modelProfile: string;
  readonly estimatedTokens: number;
  readonly estimatedCostMicros: number;
}

/** The actual usage a settled request consumed. `requestCount` must be at
 * least 1 (a settled row is one real request); the ledger refuses 0. */
export interface BudgetActualUsage {
  readonly requestCount: number;
  readonly tokens: number;
  readonly costMicros: number;
}

/** Committed/live usage totals — either across every run the ledger
 * accounts, or scoped to one run (admission is per-run). */
export interface BudgetUsageTotals {
  readonly requestCount: number;
  readonly tokens: number;
  readonly costMicros: number;
}

export type BudgetReserveResult =
  | { readonly ok: true; readonly reservation: BudgetReservationRow }
  | { readonly ok: false; readonly code: BudgetRefusalCode; readonly reason: string };

export type BudgetSettleResult =
  | { readonly ok: true; readonly row: BudgetReservationRow }
  | { readonly ok: false; readonly code: BudgetRefusalCode; readonly reason: string };

/** The budget ledger seam (#765): reserve-before-call accounting for one
 * controller's model gateway. The in-memory implementation is the tests/dev
 * backend (like `InMemoryControlPlaneStore`); the reservation ROWS are the
 * durable shape a #736 backend persists so a restarted controller re-seeds
 * the ledger and a worker retry replays idempotently — never double-charging
 * and never silently exceeding the accounting contract. */
export interface BudgetLedger {
  /** The caps this ledger enforces (the same limits capability tokens must
   * carry). */
  caps(): GatewayBudgetLimits;
  /** Reserve admission for one request BEFORE the wire call. A retry with
   * the same `reservationId` after a crash/restart returns the SAME row —
   * no double-charge — and refuses a different identity under the same id
   * (`reservation_mismatch`). A reservation that would exceed any cap is
   * refused with `budget_exhausted`; a reservation for a generation older
   * than the run's current one is refused with `cancelled`. */
  reserve(input: BudgetReservationInput): BudgetReserveResult;
  /** Settle a live reservation with the actual usage: the committed
   * accounting switches from the estimate to the actuals (`requestCount`
   * must be at least 1). When the actuals exceed the reserved estimate
   * bounds, the row is flagged `overran` — admission gated on the
   * estimate; the ledger records reality and makes the overshoot visible.
   * Re-committing a committed row with IDENTICAL actuals is an idempotent
   * no-op (a crash between commit and response replays safely); any other
   * settle-state conflict refuses with `reservation_mismatch`. */
  commit(reservationId: string, actual: BudgetActualUsage): BudgetSettleResult;
  /** Refund a live reservation (failed request): the reserved estimate is
   * removed from the accounting. Re-refunding is an idempotent no-op;
   * refunding a committed row refuses with `reservation_mismatch`. */
  refund(reservationId: string): BudgetSettleResult;
  /** Current accounting totals ACROSS EVERY run the ledger accounts:
   * committed rows count ACTUALS, live reserved rows count ESTIMATES,
   * refunded rows count nothing. This is the controller-wide diagnostic;
   * admission itself is per-run — use {@link usageFor} for one run. */
  usage(): BudgetUsageTotals;
  /** One run's accounting totals — the quantity admission enforces the caps
   * against. Committed rows for THIS run count ACTUALS, live reserved rows
   * for THIS run count ESTIMATES, refunded rows count nothing. */
  usageFor(runId: string): BudgetUsageTotals;
  /** The run's current cancellation generation (1 when the run has never
   * been cancelled). */
  generationFor(runId: string): number;
  /** Cancellation = generation bump: bumps and returns the run's new
   * generation. Tokens minted for any older generation stop reserving.
   * The bump is recorded in the DURABLE generation rows (see
   * `generationRows`), so it survives a controller restart. */
  cancelRun(runId: string): number;
  /** Every recorded reservation row (re-seed a restarted ledger from
   * these; no credential material, ever). */
  rows(): readonly BudgetReservationRow[];
  /** Every recorded per-run cancellation-generation row — the second half
   * of the durable re-seed payload. NOT inferable from the reservation
   * rows: a cancelled run may have no gen-2 reservation at all, so without
   * these rows a restart would resurrect a cancelled run's outstanding
   * older-generation tokens. */
  generationRows(): readonly BudgetRunGenerationRow[];
}

/** The capability-token authority seam (#765): mirrors the #735
 * result-channel pattern — HMAC-SHA256 over the bounded identity, keyed by
 * a controller signing key held privately, verification total over hostile
 * input. */
export interface GatewayCapabilityAuth {
  /** Mint the run-scoped capability token for one identity: exactly one
   * `(runId, modelProfile)` under explicit budget limits until expiry or a
   * cancellation generation. */
  mint(identity: GatewayCapabilityIdentity, opts?: { ttlMs?: number | undefined }): MintedGatewayToken;
  /** Verify a presented token against the identity the caller claims and
   * the ledger's current generation + caps. Total function over hostile
   * input: any malformed, overlong, foreign-format, forged, expired,
   * wrong-run, wrong-profile, stale-generation, or bounds-mismatched token
   * returns a typed refusal, never a throw. */
  verifyDetailed(
    token: string,
    presented: {
      readonly runId: string;
      readonly modelProfile: string;
      readonly expectedGeneration: number;
      readonly limits: GatewayBudgetLimits;
    },
  ): CapabilityVerification;
}

/** The identity a capability token is minted for and bound to. */
export interface GatewayCapabilityIdentity {
  readonly runId: string;
  readonly modelProfile: string;
  readonly generation: number;
  readonly limits: GatewayBudgetLimits;
}

export interface MintedGatewayToken {
  readonly token: string;
  /** Epoch ms the token stops being valid (enforced by `verifyDetailed`). */
  readonly expiresAtMs: number;
  readonly generation: number;
}

/** One gateway call request: the worker's capability token, the identity it
 * claims, the run's forge scope (for the credential broker's resolution
 * request), the accounting ids, and the transport-facing payload EXACTLY as
 * direct mode would supply it. No credential material is ever an input —
 * the gateway resolves it controller-side. The worker supplies NO budget
 * estimate: the admission bound is the gateway's operator-trusted per-call
 * reservation, so a worker cannot under-estimate to bypass the signed
 * budget. */
export interface GatewayCallInput {
  readonly token: string;
  readonly runId: string;
  readonly modelProfile: string;
  /** Which lane of model work this call accounts for (#736 `UsageRole`). */
  readonly role: UsageRole;
  /** The caller-supplied idempotency identity of the usage record this call
   * produces (e.g. `<runId>:<seq>`). */
  readonly usageId: string;
  /** The caller-supplied idempotency id of the budget reservation. */
  readonly reservationId: string;
  readonly platform: "github" | "forgejo";
  readonly installationId: string;
  readonly repoFullName: string;
  /** The wire payload, verbatim from the engine — the gateway does not
   * reshape model semantics and does not route or fall back (provider
   * fallback/routing stays the engine's declared route, never gateway
   * policy). The response-byte ceiling and any extra headers are
   * OPERATOR config carried by the profile endpoint, never worker input:
   * a worker cannot raise the response ceiling or inject headers. */
  readonly payload: TransportWirePayload;
  /** The caller-owned abort, propagated to the transport (same contract
   * as direct mode's `ChatRequestInput.signal`). */
  readonly signal?: AbortSignal | undefined;
}

/** The gateway call outcome. Success carries the normalized response, the
 * raw provider body (exactly as direct mode's `ChatRequestOutcome` would),
 * and the validated `UsageRecord` the controller persists. Failure carries
 * a closed refusal code with a fixed bounded reason, the recorded usage row
 * when one was produced (a failed request records its attempt with zero
 * tokens and unknown cost — honest accounting, refunded reservation), and
 * the underlying `TransportFailure` when the failure came from the wire so
 * routing/fallback logic sees the same typed failure direct mode sees.
 * `call` is a TOTAL function: it never rejects — an unexpected throw from
 * the transport or broker seam becomes a `gateway_error` refusal with the
 * reservation refunded. No outcome — success, refusal, or transport
 * failure — ever carries credential material. */
export type GatewayCallOutcome =
  | {
      readonly ok: true;
      readonly response: NormalizedModelResponse;
      readonly raw: unknown;
      readonly usage: UsageRecord;
    }
  | {
      readonly ok: false;
      readonly code: GatewayRefusalCode;
      readonly reason: string;
      readonly usage: UsageRecord | null;
      readonly transportFailure: TransportFailure | null;
    };

/** The model gateway seam (#765): the controller-side component a run's
 * model traffic flows through when the operator enables gateway mode. The
 * gateway verifies the capability, enforces the run budget, resolves the
 * provider credential through the #735 broker, calls the provider through
 * the shared transport, and records normalized usage. Local/self-hosted
 * endpoints are first-class: the endpoint configuration is ordinary
 * per-profile controller config, and nothing in the seam is provider
 * specific. */
export interface ModelGateway {
  /** Perform one budget-bounded, capability-checked model call. */
  call(input: GatewayCallInput): Promise<GatewayCallOutcome>;
  /** Diagnostics only: the caps, the per-request reservation bound, the
   * model credential REFERENCE, and the configured profile names. Never
   * material, never tokens, never scope detail. The `toJSON` twin makes the
   * natural controller diagnostic of stringifying the gateway yield names,
   * caps, and the bound only (the `WorkerCredentialPlan` serialization
   * guard). */
  describe(): {
    readonly caps: GatewayBudgetLimits;
    readonly perRequestBudget: GatewayPerRequestBudget;
    readonly modelCredentialRef: string;
    readonly profileNames: readonly string[];
  };
  toJSON(): Record<string, unknown>;
}
