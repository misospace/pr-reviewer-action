import type { ActionContract } from "./contract.js";
import { BOOLEAN_INPUTS, ENUM_INPUTS, FLOAT_INPUTS, INTEGER_INPUTS, POSITIVE_INTEGER_INPUTS, SECRET_INPUTS } from "./schema.js";
import { isRuntimeConfig, isSecretValue, secretValue, type RuntimeConfig } from "./types.js";

type MutableConfig = Record<string, string | number | boolean | ReturnType<typeof secretValue>>;
export const INTEGER_BOUNDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  "repo-map-max-bytes": [1, 200_000],
  "pr-thread-max-bytes": [1, 200_000],
  "deep-review-corpus-max-bytes": [1, 500_000],
  // #701: the tool request budget is bounded by the same hard ceiling the v2
  // harness clamps to — an out-of-range explicit value can never widen it.
  "tool-max-requests": [1, 50],
  "primary-tool-max-requests": [1, 50],
  "smart-tool-max-requests": [1, 50],
});

export type RawInputs = Readonly<Record<string, string | undefined>>;

// For these inputs an explicit empty string is a functional value, not an
// absent one: it disables what the input configures (ai-temperature: no
// sampling-temperature override; rereview-command: comment-triggered
// re-reviews), so the loader must keep it and not substitute the contract
// default. Every member MUST have a non-empty contract default: an input whose
// default is already "" preserves an explicit "" by construction (the
// empty-default rule in `loadConfig`), so listing it here would be a no-op —
// the drift guard in tests-v3/config.test.ts enforces that. #998: the
// reasoning-effort family is exactly that case — its "" default means empty
// keeps "omit the provider's effort field entirely", which is what keeps an
// unset configuration request-byte identical, so a new lane override (#1053)
// needs no entry here.
export const EMPTY_DISABLING_INPUTS: ReadonlySet<string> = new Set([
  "ai-temperature",
  "rereview-command",
]);

// #998: the reasoning-effort values are free-form but bounded, so they get
// their own shape check (below) rather than an ENUM_INPUTS vocabulary. A new
// lane override must be registered here or its value would skip the boundary
// check; the drift guard in tests-v3/config.test.ts catches that omission.
export const REASONING_EFFORT_INPUTS: ReadonlySet<string> = new Set([
  "ai-reasoning-effort", "ai-primary-reasoning-effort", "ai-smart-reasoning-effort", "ai-fallback-reasoning-effort", "ai-specialist-reasoning-effort",
]);

/** #998: the bounded, free-form shape every reasoning-effort value must have
 * after trim+lowercase. Deliberately NOT an enum: providers and proxies
 * define their own effort vocabularies, so the action validates the *shape*
 * of the value (a bounded token that is safe to put in a JSON string) and
 * passes the vocabulary through verbatim. Shared with the resolution-time
 * validator in `src/routing/tiers.ts`. */
export const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Loud, non-fatal notice for a dropped value. Config validation of every
 * other input throws, but a malformed effort must not abort a review the
 * operator asked for (#998): it is dropped as unset and reported. The notice
 * names the input and never echoes the rejected value — the value is
 * operator-supplied free text and the warning is a log line. */
function warnRejectedEffort(id: string): void {
  process.emitWarning(
    `Input '${id}' was dropped: the reasoning effort must match ${REASONING_EFFORT_PATTERN.source} `
    + "(lowercase letters, digits, '-', and '_'; up to 32 characters). The review runs without it.",
    "PrReviewerInputWarning",
  );
}

export function toCamelCase(id: string): string {
  return id.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function loadConfig(contract: ActionContract, raw: RawInputs): RuntimeConfig {
  const config: MutableConfig = {};
  for (const input of contract.inputs) {
    const external = raw[input.id];
    // A `${{ ... }}` default (github-token's `${{ github.token }}`) is a
    // runner expression the action runner evaluates before exporting the
    // input; outside the runner it is not a value and must never be used.
    const fallback = typeof input.default === "string" && /^\$\{\{.*\}\}$/s.test(input.default.trim())
      ? ""
      : input.default;
    // An explicit empty string is preserved — never replaced by the contract
    // default — when the default is itself empty, so the reasoning-effort
    // family's "empty means omit the field" behavior falls out of the contract
    // default rather than a per-input registration. The declared carve-outs
    // cover the remaining inputs (non-empty defaults) for which "" is a
    // functional disable rather than "use the default".
    const emptyIsFunctional = fallback === "" || EMPTY_DISABLING_INPUTS.has(input.id);
    const source = external === undefined
      ? fallback
      : external === "" && fallback !== undefined && !emptyIsFunctional
        ? String(fallback)
        : external;
    if (source === undefined) {
      if (input.required) throw new Error(`Required input '${input.id}' is missing`);
      config[toCamelCase(input.id)] = "";
      continue;
    }
    const text = String(source);
    if (input.required && text === "") throw new Error(`Required input '${input.id}' is missing`);
    let value: string | number | boolean = text;
    if (BOOLEAN_INPUTS.has(input.id)) {
      if (text === "") value = "";
      else if (text !== "true" && text !== "false") throw new Error(`Input '${input.id}' must be 'true' or 'false'`);
      else value = text === "true";
    } else if (INTEGER_INPUTS.has(input.id) && text !== "") {
      if (!/^-?(?:0|[1-9]\d*)$/.test(text)) throw new Error(`Input '${input.id}' must be an integer`);
      const number = Number(text);
      if (!Number.isSafeInteger(number)) throw new Error(`Input '${input.id}' is outside the safe integer range`);
      const bounds = INTEGER_BOUNDS[input.id];
      if (bounds && (number < bounds[0] || number > bounds[1])) throw new Error(`Input '${input.id}' must be between ${bounds[0]} and ${bounds[1]}`);
      if (POSITIVE_INTEGER_INPUTS.has(input.id) && number < 1) throw new Error(`Input '${input.id}' must be at least 1`);
      if (input.id === "pr-number" && number < 1) throw new Error("Input 'pr-number' must be at least 1");
      if (input.id === "tool-min-successful-requests" && number < 0) throw new Error("Input 'tool-min-successful-requests' must be at least 0");
      if (input.id === "ai-primary-retries" && number < 0) throw new Error("Input 'ai-primary-retries' must be at least 0");
      if (input.id === "ai-primary-retry-delay-sec" && number < 0) throw new Error("Input 'ai-primary-retry-delay-sec' must be at least 0");
      if (input.id === "image-digest-budget-sec" && number < 0) throw new Error("Input 'image-digest-budget-sec' must be at least 0");
      value = number;
    } else if (FLOAT_INPUTS.has(input.id) && text !== "") {
      const number = Number(text);
      if (!Number.isFinite(number)) throw new Error(`Input '${input.id}' must be a finite number`);
      value = number;
    } else if (REASONING_EFFORT_INPUTS.has(input.id) && text !== "") {
      // #998: free-form but bounded. Normalize (trim, lowercase) and drop —
      // never crash, never clamp, never invent a vocabulary — when the shape
      // is wrong; the drop is announced by key and the value then behaves as
      // unset (inheriting its base, if any).
      const normalized = text.trim().toLowerCase();
      if (REASONING_EFFORT_PATTERN.test(normalized)) value = normalized;
      else {
        warnRejectedEffort(input.id);
        value = "";
      }
    }
    const allowed = ENUM_INPUTS[input.id];
    if (allowed && text !== "" && !allowed.includes(text)) throw new Error(`Input '${input.id}' must be one of: ${allowed.join(", ")}`);
    config[toCamelCase(input.id)] = SECRET_INPUTS.has(input.id) ? secretValue(text) : value;
  }
  if (config.forgejoAuthMethod === "authorized_integration") {
    if (typeof config.forgejoAuthorizedIntegrationAudience !== "string"
      || config.forgejoAuthorizedIntegrationAudience.trim() === "") {
      throw new Error("Input 'forgejo-authorized-integration-audience' is required when 'forgejo-auth-method' is 'authorized_integration'");
    }
    if (isSecretValue(config.forgejoToken) && config.forgejoToken.present) {
      throw new Error("Input 'forgejo-token' cannot be set when 'forgejo-auth-method' is 'authorized_integration'; use 'token' mode to authenticate with a token");
    }
  }
  resolveInherited(config);
  const frozen: unknown = Object.freeze(config);
  if (!isRuntimeConfig(frozen)) throw new Error("Internal config does not match the canonical v3 contract");
  return frozen;
}

function resolveInherited(config: MutableConfig): void {
  inherit(config, "aiFallbackBaseUrl", "aiBaseUrl");
  inherit(config, "aiFallbackApiFormat", "aiApiFormat");
  inheritSecret(config, "aiFallbackApiKey", "aiApiKey");
  inherit(config, "aiFallbackRequestTimeoutSec", "aiRequestTimeoutSec");
  inherit(config, "aiFallbackConnectTimeoutSec", "aiConnectTimeoutSec");
  inherit(config, "aiFallbackStream", "aiStream");
  // #1009: per-lane response_format inheritance — explicit empty defaults
  // back to the base setting so the existing `ai-response-format` stays the
  // behavioral baseline for workflows that only set one input.
  inherit(config, "aiPrimaryResponseFormat", "aiResponseFormat");
  inherit(config, "aiSmartResponseFormat", "aiResponseFormat");
  inherit(config, "aiFallbackResponseFormat", "aiResponseFormat");
  // #998: per-lane reasoning-effort inheritance. Empty lane overrides fall
  // back to the base `ai-reasoning-effort`, and the specialist input inherits
  // the primary lane's already-resolved value, exactly like the
  // response_format family above. A rejected value was dropped to "" above,
  // so it inherits here rather than crashing the load.
  inherit(config, "aiPrimaryReasoningEffort", "aiReasoningEffort");
  inherit(config, "aiSmartReasoningEffort", "aiReasoningEffort");
  // #1053: the fallback effort deliberately does NOT inherit here. The
  // resolved config is projected verbatim into the stage env
  // (`stageEnvFromConfig`), and `AI_FALLBACK_REASONING_EFFORT` is a
  // conditional fingerprint key — copying the base into an unset override
  // would add a new fingerprint line for every existing
  // `ai-reasoning-effort` installation and invalidate its cached reviews on
  // upgrade. The unset override must stay distinguishable from a configured
  // one, so the fallback lane resolves the base itself in
  // `tierReasoningEffort` (which already inherits when its key is empty);
  // request bytes are identical either way.
  inherit(config, "aiSpecialistReasoningEffort", "aiPrimaryReasoningEffort");
  inherit(config, "aiPrimaryModel", "aiModel");
  inherit(config, "aiPrimaryBaseUrl", "aiBaseUrl");
  inherit(config, "aiPrimaryApiFormat", "aiApiFormat");
  inheritSecret(config, "aiPrimaryApiKey", "aiApiKey");
  inherit(config, "aiSmartBaseUrl", "aiBaseUrl");
  inherit(config, "aiSmartApiFormat", "aiApiFormat");
  inheritSecret(config, "aiSmartApiKey", "aiApiKey");
  inherit(config, "primaryModelContextTokens", "modelContextTokens");
  inherit(config, "smartModelContextTokens", "modelContextTokens");
  inherit(config, "fallbackModelContextTokens", "modelContextTokens");
}

function inherit(config: MutableConfig, target: string, fallback: string): void {
  if (config[target] === "") config[target] = config[fallback] ?? "";
}

function inheritSecret(config: MutableConfig, target: string, fallback: string): void {
  const current = config[target];
  if (typeof current === "object" && current.present === false) {
    const value = config[fallback];
    config[target] = typeof value === "object" ? value : secretValue("");
  }
}
