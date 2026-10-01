# Troubleshooting

Local-model failure modes, thinking-model token budgets, proxy timeouts, and common misconfigurations.

## Local model troubleshooting

The action is designed local-model-first (ollama, llama.cpp, vLLM, or anything behind an OpenAI/Anthropic-compatible proxy like LiteLLM). This section covers the failure modes that come up most often with self-hosted endpoints.

### Base URL examples

`ai-base-url` must point at the **OpenAI-compatible base** — the action appends `/chat/completions`, or `/messages` for `ai-api-format: anthropic`:

```yaml
# ollama on the same runner/host (note the /v1 — ollama's native API is not OpenAI-compatible)
ai-base-url: http://localhost:11434/v1

# ollama on another host on your network
ai-base-url: http://192.168.1.50:11434/v1

# llama.cpp llama-server
ai-base-url: http://llama-server.internal:8080/v1

# vLLM
ai-base-url: http://vllm.internal:8000/v1

# LiteLLM proxy (set ai-api-format to match the route's format; openai is typical)
ai-base-url: http://litellm.internal:4000/v1
```

Self-hosted runners must be able to reach the endpoint — GitHub-hosted runners cannot reach `localhost` or LAN addresses on your network. Leave `ai-api-key` unset if the endpoint is unauthenticated; nothing is sent in that case.

### Right-size the context budget with `model-context-tokens`

The named `context-limit-mode` budgets assume large cloud-model windows (`normal` is roughly 55-70k tokens of corpus). Local models commonly run 8k-32k windows, and an overflowing prompt fails in confusing ways: the server returns `context length exceeded` (visible in the action log thanks to error-body preservation), or worse, silently truncates the prompt and the model returns malformed or irrelevant JSON.

Set `model-context-tokens` to the window you actually serve the model with (e.g. ollama's `num_ctx`, llama.cpp's `--ctx-size`, vLLM's `--max-model-len`):

```yaml
model-context-tokens: "16384"   # derive corpus/diff/file budgets from the real window
ai-max-tokens: "2048"           # reserved for the model's reply within that window
```

The action reserves `ai-max-tokens` plus prompt headroom and converts the rest to byte budgets conservatively (~3 bytes/token). Check the run's step summary — it shows the active budget and whether the diff/corpus were truncated.

### Get reliable JSON out of small models with `ai-response-format`

Small models often wrap their JSON in prose or markdown fences. The parser tolerates a lot, but structured output is more reliable when the server supports it:

```yaml
ai-response-format: json_object   # broad support: ollama, vLLM, llama.cpp server, LiteLLM
# or, where supported (enforces the exact verdict/review_markdown schema):
ai-response-format: json_schema   # vLLM guided decoding, llama.cpp grammars, newer servers
```

If the endpoint rejects the request after enabling this (HTTP 400 mentioning `response_format`), the server doesn't support that mode — drop back to `json_object` or `off`. Ignored entirely for `ai-api-format: anthropic`.

Fireworks/LiteLLM note: grammar-constrained decoding under `json_schema` can cause some models (e.g. `glm-4p5`, `qwen3-coder`) to under-emit `\n` inside the `review_markdown` string, producing a single-line wall of bolded headings. The action detects a payload with multiple `## ` heading markers but no newlines and fails it into the retry path — but the reliable fix is `ai-response-format: json_object` for those endpoints.

### Timeouts, streaming, and retries

- **Slow prompt eval** (big corpus, CPU offload): raise `ai-request-timeout-sec` (default 300). Each `tool-mode: native_loop` model turn has its own `tool-turn-timeout-sec` — raise it too if loop turns time out.
- **Proxies with idle-read timeouts** (e.g. Cloudflare's ~100s edge timer): keep `ai-stream: "true"` (the default) so bytes flow before the timer fires.
- **Models that reject sampling params**: set `ai-temperature: ""` to omit the field entirely; set `ai-tokens-param: max_completion_tokens` for newer OpenAI reasoning models.
- **Endpoint not always up** (homelab): configure `ai-fallback-base-url`/`ai-fallback-model` (e.g. a small cloud model), or set `on-model-failure: notice` so the PR gets a visible explanation instead of a bare red check.
- **Don't burn 10 minutes on a dead endpoint**: the defaults (`ai-primary-retries: "8"`, 15s delay with backoff, 300s request timeout) are tuned for flaky-but-alive endpoints and can spend ~10 minutes before giving up. If your endpoint is either up or down (typical homelab), use a low-retry profile:

```yaml
ai-primary-retries: "2"
ai-primary-retry-delay-sec: "5"
ai-connect-timeout-sec: "10"
on-model-failure: notice   # visible explanation instead of a long red check
```

### Quick symptom table

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED`, `ENOTFOUND` or a connect timeout in the model-call error | endpoint unreachable from the runner | check `ai-base-url`, runner network, server is listening |
| HTTP 404 from the endpoint | base URL missing `/v1` (ollama) or wrong `ai-api-format` | use the OpenAI-compatible base path |
| HTTP 404 from the endpoint, model only served in Anthropic format | `ai-api-format` (and/or `ai-fallback-api-format`/`ai-primary-api-format`/`ai-smart-api-format`) left at the `openai` default | set the matching input(s) to `ai-api-format: anthropic` so the action posts to `/messages` instead of `/chat/completions` |
| `context length exceeded` in the logged error body | corpus exceeds the served window | set `model-context-tokens` (and/or lower `ai-max-tokens`) |
| Verdict parse failures, retries, then fallback | model wraps JSON in prose | set `ai-response-format: json_object` |
| Reviews time out behind a proxy | idle-read timer on non-streamed response | keep `ai-stream: "true"` |
| HTTP 400 mentioning `temperature` | model rejects non-default sampling | `ai-temperature: ""` |

## Thinking models need `ai-max-tokens` headroom

`ai-max-tokens` (default `16384`) caps completion tokens for the primary and fallback final review calls, and is required by Anthropic-compatible APIs. Reasoning/thinking models (those that emit a thinking channel, e.g. Gemma's reasoning variants) spend part of that cap on the hidden reasoning before ever writing the verdict JSON. Set it too low and the model's visible content comes back empty with `finish_reason=length` — the verdict JSON fails to parse, and the review needlessly escalates or fails.

Raise `ai-max-tokens` to `16000`+ (or higher) for verbose reasoners so there's room left for the actual `verdict`/`review_markdown` output after reasoning tokens are spent.

## Reverse-proxy timeouts on long verdict turns

A long native-loop turn (big corpus, slow local hardware, a thinking model chewing through reasoning) can outlast a reverse proxy's idle-read timeout — for example Cloudflare's HTTP 524 on a connection that goes quiet too long. `ai-stream: "true"` (the default) mitigates this for the main review call by keeping bytes flowing before the timer fires.

If the native-loop's in-conversation verdict turn still fails outright (timeout, dropped connection, or any transport error), the harness logs it and the run doesn't fail: the standard (non-tool-loop) review call synthesizes the verdict as a separate, fresh request instead. You lose the inline tool-conversation framing for that one turn, but you still get a published verdict.

## Common misconfigurations

- **Wrong `ai-api-format` gives 404s**: the default is `openai`, posting to `/chat/completions`. If your model is only served over an Anthropic-style `/messages` endpoint, every one of the format inputs that applies to that model slot must say so — `ai-api-format`, and the matching `ai-fallback-api-format`/`ai-primary-api-format`/`ai-smart-api-format` for any slot that isn't inheriting the primary's format.
- **Missing `checks: read`**: `ci-status-check: "true"` (the default) polls the Checks API for the PR head SHA before reviewing. Without `checks: read` in the workflow's `permissions`, the wait degrades (it can't see check status) rather than hard-failing — but you won't get CI results folded into the review corpus as evidence. Grant `checks: read` alongside `pull-requests: write` if you want CI evidence in the review.
- **`branches:` filters that skip stacked PRs**: a workflow trigger scoped with `on.pull_request.branches: [main]` only fires for PRs targeting `main`. A stacked PR chain (PR B targeting PR A's branch, not `main`) never matches that filter and silently gets no review at all. If you review stacked PRs, either drop the `branches:` filter or list every branch the stack can target.
