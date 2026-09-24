# Evidence: specialist execution-shape benchmark (#704)

Raw harness reports backing `docs/architecture/deep-review-execution-shape.md`.
Generated 2026-09-24 with `scripts/eval_harness.py --corpus evals/corpus-specialists.json
--modes tools_off --deep-review true` against two OpenAI-compatible lanes routed through
one LiteLLM proxy:

- `cloud-*` — `MiniMax-M3-chat`, production-default context settings,
  `DEEP_REVIEW_MAX_TOKENS` 16383 (`three_call`) / 16385 (`combined_scout`) / 16386
  (`prime_then_fanout`).
- `local-*` — `qwen3.8-27b-chat` on a self-hosted RTX 3090 vLLM,
  `CONTEXT_LIMIT_MODE=low`, `AI_MAX_TOKENS=16384`, `DEEP_REVIEW_MAX_TOKENS`
  16373 / 16375 / 16376 respectively.

The per-shape `DEEP_REVIEW_MAX_TOKENS` perturbation is semantically inert (no run
approached the cap; max observed specialist output ≈ 13.1 k tokens) and exists to
defeat the LiteLLM response cache, which keys on the full request body and would
otherwise serve `prime_then_fanout` cached copies of `three_call`'s responses.
`--runs-per-mode 1` was used so every (shape, PR) latency sample is a first-touch
request. `smoke-*` files are lane-characterization runs (thinking-variant model,
default-token-cap and `minimal`-context probes) cited in the ADR's limitations.

One invocation per shape per lane; lanes ran concurrently, shapes sequentially.
Reports contain no credentials.
