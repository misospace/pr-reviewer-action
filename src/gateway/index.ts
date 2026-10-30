/** Model gateway subsystem for #765 — public surface.
 *
 * The run-scoped, budget-bounded, provider-key-isolated model-call
 * boundary: the capability-token authority (`./capability.js`) that binds
 * model authority to exactly one `(runId, modelProfile)` under explicit
 * budget limits until expiry or a cancellation generation, the budget
 * ledger (`./budget.js`) whose reserve-before-call rows make a controller
 * restart or worker retry idempotent, and the gateway seam
 * (`./gateway.js`) that verifies, reserves, resolves the provider
 * credential through the #735 broker, calls through the shared transport,
 * and records #736-shaped usage.
 *
 * Operator-mode library (like `src/queue/`, `src/executor/`,
 * `src/credentials/`, and `src/state/`): the future controller daemon
 * (#725/#736) imports it — NOT wired into the Action runtime; direct
 * worker mode stays the shipped Action path. Design:
 * docs/architecture/model-gateway.md.
 */

export {
  BUDGET_REFUSAL_CODES,
  CAPABILITY_REFUSAL_CODES,
  GATEWAY_REFUSAL_CODES,
  MAX_BUDGET_LIMIT,
  validateBudgetLimits,
  validateBudgetReservationRow,
  validateBudgetRunGeneration,
} from "./types.js";
export type {
  BudgetActualUsage,
  BudgetLedger,
  BudgetRefusalCode,
  BudgetReservationInput,
  BudgetReservationRow,
  BudgetReserveResult,
  BudgetRunGenerationRow,
  BudgetSettleResult,
  BudgetUsageTotals,
  CapabilityRefusalCode,
  CapabilityVerification,
  GatewayBudgetLimits,
  GatewayCallInput,
  GatewayCallOutcome,
  GatewayCapabilityAuth,
  GatewayCapabilityIdentity,
  GatewayProfileEndpoint,
  GatewayProfilePricing,
  GatewayRefusalCode,
  MintedGatewayToken,
  ModelGateway,
} from "./types.js";

export {
  GATEWAY_DEFAULT_TTL_MS,
  GATEWAY_TOKEN_RE,
  createGatewayCapabilityAuth,
} from "./capability.js";
export type { GatewayCapabilityAuthOptions } from "./capability.js";

export { BudgetLedgerError, InMemoryBudgetLedger } from "./budget.js";
export type { InMemoryBudgetLedgerOptions } from "./budget.js";

export { createModelGateway } from "./gateway.js";
export type { ModelGatewayOptions } from "./gateway.js";
