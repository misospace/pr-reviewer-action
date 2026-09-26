export const BOOLEAN_INPUTS = new Set([
  "fail-on-request-changes", "inline-findings", "escalate-on-incomplete-required-checks",
  "escalate-on-fast-request-changes", "escalate-on-fast-low-confidence", "escalate-on-tool-or-evidence-blockers",
  "escalate-on-tool-planning-failure", "ai-stream", "related-code-context", "linear-enable-for-forks",
  "ai-fallback-stream",
  "publish-review-comment", "allow-approve", "approve-forks", "repo-map-context", "pr-thread-context", "review-threads-context",
  "evidence-blocker-enforcement", "evidence-enable-for-forks", "tool-loop-summarize", "tool-failure-enforcement",
  "tool-enable-for-forks", "forgejo-skip-permission-preflight", "skip-if-diff-unchanged", "force-review",
  "ci-status-check", "ci-skip-on-timeout",
]);

export const INTEGER_INPUTS = new Set([
  "pr-number", "ai-max-tokens", "ai-primary-retries", "ai-primary-retry-delay-sec", "inline-findings-max",
  "related-code-max-bytes", "linear-issue-timeout-sec", "model-context-tokens", "primary-model-context-tokens",
  "smart-model-context-tokens", "repo-map-max-bytes", "pr-thread-max-bytes", "review-threads-max-bytes", "deep-review-timeout-sec",
  "deep-review-max-tokens", "deep-review-corpus-max-bytes", "enrichment-budget-sec", "image-digest-budget-sec",
  "sarif-max-findings", "evidence-provider-timeout-sec", "evidence-provider-max-output-bytes",
  "evidence-provider-parallelism", "tool-loop-wall-clock-sec", "tool-loop-summarize-max-tokens", "tool-max-requests",
  "tool-max-rounds", "tool-turn-timeout-sec", "tool-corpus-max-bytes", "tool-max-tokens-per-turn",
  "tool-max-response-bytes", "tool-request-timeout-sec", "tool-max-search-results", "tool-min-successful-requests",
  "ai-request-timeout-sec", "ai-connect-timeout-sec", "ai-fallback-request-timeout-sec",
  "ai-fallback-connect-timeout-sec", "ci-timeout-sec", "ci-interval-sec",
]);

export const ENUM_INPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "ai-api-format": ["openai", "anthropic"],
  "ai-fallback-api-format": ["openai", "anthropic"],
  "ai-primary-api-format": ["openai", "anthropic"],
  "ai-smart-api-format": ["openai", "anthropic"],
  "ai-response-format": ["off", "json_object", "json_schema"],
  "ai-tokens-param": ["max_tokens", "max_completion_tokens"],
  "on-model-failure": ["fail", "notice"],
  "verdict-policy": ["model", "findings_severity_gated"],
  "validate-required-checks": ["auto", "true", "false"],
  "required-check-validation-mode": ["warn", "fail", "metadata_only"],
  "review-routing-mode": ["off", "auto"],
  "system-prompt-mode": ["replace", "append"],
  "review-verbosity": ["normal", "concise"],
  "publish-mode": ["comment", "review_comment", "review_verdict"],
  "cleanup-previous-native-reviews": ["auto", "true", "false"],
  "upstream-link-mode": ["inert", "togithub"],
  "context-limit-mode": ["normal", "low", "minimal"],
  "deep-review": ["false", "true", "auto"],
  "tool-mode": ["off", "native_loop"],
  "primary-request-shape": ["default", "trailing_task"],
  "smart-request-shape": ["default", "trailing_task"],
  platform: ["auto", "forgejo", "github"],
  "forgejo-auth-method": ["token", "authorized_integration"],
});

export const FLOAT_INPUTS = new Set(["ai-temperature"]);

export const SECRET_INPUTS = new Set([
  "github-token", "ai-api-key", "ai-fallback-api-key", "ai-primary-api-key", "ai-smart-api-key",
  "linear-api-key", "tool-mcp-token", "forgejo-token",
]);

export const POSITIVE_INTEGER_INPUTS = new Set([
  "ai-max-tokens", "inline-findings-max", "related-code-max-bytes", "linear-issue-timeout-sec",
  "model-context-tokens", "primary-model-context-tokens", "smart-model-context-tokens",
  "deep-review-timeout-sec", "deep-review-max-tokens",
  "sarif-max-findings", "evidence-provider-timeout-sec", "evidence-provider-max-output-bytes",
  "evidence-provider-parallelism", "tool-loop-wall-clock-sec", "tool-loop-summarize-max-tokens", "tool-max-requests",
  "tool-max-rounds", "tool-turn-timeout-sec", "tool-corpus-max-bytes", "tool-max-tokens-per-turn",
  "tool-max-response-bytes", "tool-request-timeout-sec", "tool-max-search-results", "ai-request-timeout-sec",
  "ai-connect-timeout-sec", "ai-fallback-request-timeout-sec", "ai-fallback-connect-timeout-sec", "ci-timeout-sec",
  "ci-interval-sec",
]);

for (const id of ["repo-map-max-bytes", "pr-thread-max-bytes", "deep-review-corpus-max-bytes"]) {
  POSITIVE_INTEGER_INPUTS.delete(id);
}
