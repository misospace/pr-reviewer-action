import type { EnvAllowlist } from "../runtime/env.js";

/**
 * Explicit per-gate child-environment allowlists (#679).
 *
 * `CI_GATE_ENV_KEYS` mirrors `_CI_GATE_ENV_KEYS` in
 * `scripts/sections/gating.sh` key-for-key: the CI child keeps exactly the
 * pre-#634 standalone-step authority (runner basics, transport config,
 * GitHub/Forgejo auth + repository identity, the CI-wait controls) and never
 * sees the review step's model/tool/Linear secrets. Deliberately NOT
 * included: AI_*_API_KEY, TOOL_MCP_TOKEN, LINEAR_API_KEY,
 * AI_REQUEST_TIMEOUT_SEC. `tests-v3/gates.test.ts` cross-checks this list
 * against the bash source so the two cannot drift while v2/v3 coexist.
 *
 * `SPECIALIST_GATE_ENV_KEYS` is deliberately NARROWER than production (the
 * bash gate inherits the full review environment): the specialist phase only
 * needs process basics, transport config, the model-call settings it reads,
 * and the deep-review/corpus controls. TOOL_MCP_TOKEN and LINEAR_API_KEY are
 * excluded — specialists never run a tool loop and never touch Linear.
 */

export const CI_GATE_ENV_KEYS: EnvAllowlist = [
  // Process/runner basics + benign network transport/runtime config.
  "PATH",
  "HOME",
  "RUNNER_TRACKING_ID",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  // Runner metadata: outputs, self-exclusion identity, OIDC request vars.
  "GITHUB_OUTPUT",
  "GITHUB_RUN_ID",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GH_HOST",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  // GitHub/Forgejo auth.
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  // Repository/PR identity + platform selection.
  "REPO",
  "PR_NUMBER",
  "PR_HEAD_SHA",
  "PLATFORM",
  "FORGEJO_API_URL",
  "FORGEJO_TOKEN",
  "FORGEJO_AUTH_METHOD",
  "FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE",
  "FORGEJO_SKIP_PERMISSION_PREFLIGHT",
  // CI gate controls.
  "CI_STATUS_CHECK",
  "CI_TIMEOUT_SEC",
  "CI_INTERVAL_SEC",
  "CI_SKIP_ON_TIMEOUT",
  "CI_API_TIMEOUT_SEC",
  "CI_CHECKS_FILE",
  "CI_STATUS_CONTEXT",
];

export const SPECIALIST_GATE_ENV_KEYS: EnvAllowlist = [
  // Process basics + UTF-8/locale defaults for Python file IO.
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  // Model-endpoint transport (proxy + custom CA), same categories as CI.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  // Model-call settings read by scripts/run_specialists.py.
  "AI_BASE_URL",
  "AI_API_FORMAT",
  "AI_MODEL",
  "AI_API_KEY",
  "AI_REQUEST_TIMEOUT_SEC",
  "ANTHROPIC_VERSION",
  "AI_TEMPERATURE",
  "AI_RESPONSE_FORMAT",
  "AI_TOKENS_PARAM",
  "AI_STREAM",
  // Deep-review phase controls.
  "DEEP_REVIEW",
  "DEEP_REVIEW_TIMEOUT_SEC",
  "DEEP_REVIEW_MAX_TOKENS",
  "DEEP_REVIEW_CORPUS_MAX_BYTES",
  "DEEP_REVIEW_EXECUTION",
  "SPECIALISTS_SECTION_MAX_BYTES",
  "MAX_CORPUS",
  // Corpus inputs.
  "GITHUB_WORKSPACE",
  "CI_CHECKS_FILE",
];

/** Keys that must never reach the CI gate child (the #634 sentinel set). */
export const CI_GATE_FORBIDDEN_KEYS: EnvAllowlist = [
  "AI_API_KEY",
  "AI_PRIMARY_API_KEY",
  "AI_SMART_API_KEY",
  "AI_FALLBACK_API_KEY",
  "TOOL_MCP_TOKEN",
  "LINEAR_API_KEY",
];

/** Keys that must never reach the specialist phase child. */
export const SPECIALIST_GATE_FORBIDDEN_KEYS: EnvAllowlist = [
  "TOOL_MCP_TOKEN",
  "LINEAR_API_KEY",
];
