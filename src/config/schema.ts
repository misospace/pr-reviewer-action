export const BOOLEAN_INPUTS = new Set([
  "fail-on-request-changes", "inline-findings",
  "ai-stream", "related-code-context", "harness-obligations", "equivalent-paths", "requirement-trace", "linear-enable-for-forks",
  // #764: the syntax-aware context stage. Off by default — default
  // enablement requires measured quality/token benefit.
  "syntax-context",
  "ai-fallback-stream",
  "publish-review-comment", "allow-approve", "approve-forks", "repo-map-context", "pr-thread-context", "review-threads-context",
  "evidence-blocker-enforcement", "evidence-enable-for-forks", "tool-loop-summarize", "tool-failure-enforcement",
  "tool-enable-for-forks", "forgejo-skip-permission-preflight", "skip-if-diff-unchanged", "force-review",
  "ci-status-check", "ci-skip-on-timeout", "claim-falsification", "review-triage", "repository-skills",
  // #998: the operator's explicit assertion that the Anthropic-compatible
  // endpoint accepts `output_config.effort`. Default off; without it no
  // Anthropic request ever carries an effort field. Per-lane (#1049 review):
  // every lane asserts its own endpoint and never inherits another.
  "ai-anthropic-effort-support",
  "ai-smart-anthropic-effort-support",
  "ai-fallback-anthropic-effort-support",
  "ai-specialist-anthropic-effort-support",
  // #1047: the operator's explicit assertion that the Anthropic-compatible
  // endpoint accepts Anthropic-native structured output
  // (`output_config.format` with the verdict JSON schema). Default off;
  // without it no Anthropic request ever carries a structured-output
  // parameter. Per-lane like the effort opt-in (no specialist input:
  // specialist contracts are not the verdict schema).
  "ai-anthropic-structured-output-support",
  "ai-smart-anthropic-structured-output-support",
  "ai-fallback-anthropic-structured-output-support",
]);

export const INTEGER_INPUTS = new Set([
  "pr-number", "ai-max-tokens", "ai-primary-retries", "ai-primary-retry-delay-sec", "inline-findings-max",
  "related-code-max-bytes", "equivalent-paths-max-bytes", "linear-issue-timeout-sec", "model-context-tokens", "primary-model-context-tokens",
  // #764: the syntax-aware context section's corpus byte budget.
  "syntax-context-max-bytes",
  "smart-model-context-tokens", "fallback-model-context-tokens", "repo-map-max-bytes", "pr-thread-max-bytes", "review-threads-max-bytes", "deep-review-timeout-sec",
  "deep-review-max-tokens", "deep-review-corpus-max-bytes", "enrichment-budget-sec", "image-digest-budget-sec",
  "sarif-max-findings", "evidence-provider-timeout-sec", "evidence-provider-max-output-bytes",
  "evidence-provider-parallelism", "tool-loop-wall-clock-sec", "tool-loop-summarize-max-tokens", "tool-max-requests",
  "primary-tool-max-requests", "smart-tool-max-requests", "smart-tool-max-rounds", "smart-tool-loop-wall-clock-sec",
  "tool-max-rounds", "tool-turn-timeout-sec", "tool-corpus-max-bytes", "tool-max-tokens-per-turn",
  "tool-max-response-bytes", "tool-request-timeout-sec", "tool-max-search-results", "tool-min-successful-requests",
  "ai-request-timeout-sec", "ai-connect-timeout-sec", "ai-fallback-request-timeout-sec",
  "ai-fallback-connect-timeout-sec", "ci-timeout-sec", "ci-interval-sec",
  // #1073: the confidence scorer's request timeout is a positive integer.
  "ai-confidence-timeout-sec",
]);

export const ENUM_INPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "ai-api-format": ["openai", "anthropic"],
  "ai-fallback-api-format": ["openai", "anthropic"],
  "ai-primary-api-format": ["openai", "anthropic"],
  "ai-smart-api-format": ["openai", "anthropic"],
  // #1073: the confidence scorer is its own lane; empty (the default) inherits
  // the primary lane's format rather than defaulting to openai.
  "ai-confidence-api-format": ["openai", "anthropic"],
  "ai-response-format": ["off", "json_object", "json_schema"],
  "ai-primary-response-format": ["off", "json_object", "json_schema"],
  "ai-smart-response-format": ["off", "json_object", "json_schema"],
  "ai-fallback-response-format": ["off", "json_object", "json_schema"],
  "ai-tokens-param": ["max_tokens", "max_completion_tokens"],
  "on-model-failure": ["fail", "notice"],
  "verdict-policy": ["model", "findings_severity_gated", "strict"],
  "validate-required-checks": ["auto", "true", "false"],
  "required-check-validation-mode": ["warn", "fail", "metadata_only"],
  "review-routing-mode": ["off", "auto"],
  "review-triage-routing-mode": ["off", "advisory", "request"],
  "system-prompt-mode": ["replace", "append"],
  "review-verbosity": ["normal", "concise"],
  "publish-mode": ["comment", "review_comment", "review_verdict", "review_blockers"],
  "cleanup-previous-native-reviews": ["auto", "true", "false"],
  "upstream-link-mode": ["inert", "togithub"],
  "context-limit-mode": ["normal", "low", "minimal"],
  "deep-review": ["false", "true", "auto"],
  "tool-mode": ["off", "native_loop"],
  "primary-request-shape": ["default", "trailing_task"],
  "smart-request-shape": ["default", "trailing_task"],
  // #1247: 'tangled' is a resolvable platform (`src/platform/resolve.ts`
  // implements it and the contract documents it), so the typed config
  // vocabulary must accept it — the resolver, not this enum, owns the
  // fail-closed TANGLED_REPO_DID requirement.
  platform: ["auto", "forgejo", "github", "tangled"],
  "forgejo-auth-method": ["token", "authorized_integration"],
});

export const FLOAT_INPUTS = new Set(["ai-temperature"]);

export const SECRET_INPUTS = new Set([
  "github-token", "ai-api-key", "ai-fallback-api-key", "ai-primary-api-key", "ai-smart-api-key", "ai-specialist-api-key",
  "linear-api-key", "tool-mcp-token", "forgejo-token",
  // #1073: the confidence scorer's credential is a secret like every other
  // lane key — redacted at every config serialization boundary.
  "ai-confidence-api-key",
  // #1037: header VALUES routinely carry proxy/gateway tokens, so the whole
  // input is secret at the typed config boundary. The runtime stage env
  // reveals it (`stageEnvFromConfig`) because the transport parser needs the
  // plain text; redaction, `toJSON`, and the debug CLI then never see it.
  "ai-extra-headers",
]);

export const POSITIVE_INTEGER_INPUTS = new Set([
  "ai-max-tokens", "inline-findings-max", "related-code-max-bytes", "equivalent-paths-max-bytes", "linear-issue-timeout-sec",
  // #764: the syntax-aware context section's corpus byte budget.
  "syntax-context-max-bytes",
  "model-context-tokens", "primary-model-context-tokens", "smart-model-context-tokens", "fallback-model-context-tokens",
  "deep-review-timeout-sec", "deep-review-max-tokens",
  "sarif-max-findings", "evidence-provider-timeout-sec", "evidence-provider-max-output-bytes",
  "evidence-provider-parallelism", "tool-loop-wall-clock-sec", "tool-loop-summarize-max-tokens", "tool-max-requests",
  "primary-tool-max-requests", "smart-tool-max-requests", "smart-tool-max-rounds", "smart-tool-loop-wall-clock-sec",
  "tool-max-rounds", "tool-turn-timeout-sec", "tool-corpus-max-bytes", "tool-max-tokens-per-turn",
  "tool-max-response-bytes", "tool-request-timeout-sec", "tool-max-search-results", "ai-request-timeout-sec",
  "ai-connect-timeout-sec", "ai-fallback-request-timeout-sec", "ai-fallback-connect-timeout-sec", "ci-timeout-sec",
  "ci-interval-sec",
  "ai-confidence-timeout-sec",
]);

for (const id of ["repo-map-max-bytes", "pr-thread-max-bytes", "deep-review-corpus-max-bytes"]) {
  POSITIVE_INTEGER_INPUTS.delete(id);
}
