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

If the endpoint rejects the request after enabling this (HTTP 400 mentioning `response_format`), the server doesn't support that mode — drop back to `json_object` or `off`. On an Anthropic-format endpoint see [the Anthropic section below](#anthropic-format-lanes-what-ai-response-format-actually-does-1047): `json_object` is prompt-only there and `json_schema` needs an explicit opt-in.

Fireworks/LiteLLM note: grammar-constrained decoding under `json_schema` can cause some models (e.g. `glm-4p5`, `qwen3-coder`) to under-emit `\n` inside the `review_markdown` string, producing a single-line wall of bolded headings. The action detects a payload with multiple `## ` heading markers but no newlines and fails it into the retry path — but the reliable fix is `ai-response-format: json_object` for those endpoints.

### Per-lane `ai-{primary,smart,fallback}-response-format` overrides (#1009)

A single global `ai-response-format` cannot fit heterogeneous deployments: a primary model behind a proxy that rejects `response_format` would force the value off for every lane, even though the smart or fallback lane supports `json_schema`. The base setting stays request-byte compatible with existing workflows, and each lane can be pinned independently:

```yaml
ai-response-format: json_object          # base / default
ai-primary-response-format: ""            # inherits json_object (default)
ai-smart-response-format: json_schema     # smart re-review uses structured output
ai-fallback-response-format: ""           # inherits json_object (default)
```

Override only the lanes that need it; an empty/unset value never coerces `off` and is never silently translated between modes — the inherited base value is used. Changing an effective lane value changes the request byte sequence, so the unchanged-diff skip will not hide it.

### Anthropic-format lanes: what `ai-response-format` actually does (#1047)

The Anthropic Messages API has no `response_format` parameter. Its native structured output is a different field with a different shape (`output_config.format` carrying a bare JSON schema), and not every Anthropic-compatible backend implements it — a wire family is no proof a proxy supports the family's optional features. The action therefore treats the two formats honestly instead of pretending:

- **`json_object` is prompt-only on Anthropic, always.** There is no Anthropic-native equivalent to translate it into, and the action never invents one. The run logs a warning saying the JSON contract is prompted, not enforced.
- **`json_schema` is enforced only with an explicit opt-in**: `ai-anthropic-structured-output-support` (base/primary lane), `ai-smart-anthropic-structured-output-support`, or `ai-fallback-anthropic-structured-output-support`. Each lane asserts its own endpoint; an opt-in never crosses lanes. When the opt-in is off, the parameter is NOT sent — the request bytes are identical to `off` — and the run logs exactly that rather than implying enforcement.
- **A wrong assertion degrades safely.** If an opted-in endpoint rejects the parameter (HTTP 400 naming `response_format`/`output_config`/`json_schema`), the same request is retried once without it, and the review continues with prompted JSON instead of failing.

```yaml
# MiniMax-M3.1 (or another Anthropic-compatible endpoint) confirmed to accept
# output_config.format — e.g. first-party Anthropic:
ai-api-format: anthropic
ai-response-format: json_schema
ai-anthropic-structured-output-support: "true"
```

To verify an endpoint accepts it before opting in, send one request with `output_config.format` yourself (a 400 naming the parameter means it does not). When `json_schema` is enforced the run's per-call log line says `format=json_schema`; an unasserted lane never shows that note.

### When a model turn produces an unusable reply: the failure-shape line

When a model call ends without a usable verdict — an empty reply, a reply spent entirely in a thinking channel, a token-cap truncation, a proxy 524, or JSON too malformed to decode — the error log carries a bounded, content-free failure-shape line next to the error, e.g.:

```
Primary: parse/validate failures exhausted (Expected JSON object but got NoneType) [response_class=reasoning-only profile=Primary api_format=anthropic streamed=false failure_kind=not_object finish_reason=end_turn text_blocks=0 text_chars=0 thinking_blocks=1 tool_blocks=0 completion_tokens=4096 completion_budget_raised_to=4096]
```

`response_class` is the diagnosis: `zero-output` (nothing came back), `reasoning-only` (the whole budget went to the thinking channel before any text — raise `ai-max-tokens` or the model's reasoning effort), `truncated` (token cap; raise `ai-max-tokens`), `malformed-json` (text arrived but does not decode), `sse-framing-loss` (tokens were billed but the payload frames were lost behind a proxy), `http-error`/`timeout` (transport), or `endpoint-error` (a 200 body carrying an error). The line contains counts, stop reasons, and token figures only — never reply text, reasoning content, or credentials.

When the failure shape shows the token cap destroyed the verdict (a truncation, or a reasoning-only reply), the single retry that follows automatically uses a raised completion budget (4x `ai-max-tokens`, capped at 32768) — no extra model call is spent, and the line reports the raise as `completion_budget_raised_to`. The native tool loop's final verdict turn gets the same bounded treatment, recorded in `tool-harness.json` as `native_loop_verdict_diagnostics` and rendered in the step summary's Native verdict row; tools and evidence already gathered are never re-collected.

### Timeouts, streaming, and retries

- **Slow prompt eval** (big corpus, CPU offload): raise `ai-request-timeout-sec` (default 300). Each `tool-mode: native_loop` model turn has its own `tool-turn-timeout-sec` — raise it too if loop turns time out.
- **Proxies with idle-read timeouts** (e.g. Cloudflare's ~100s edge timer): keep `ai-stream: "true"` (the default) so bytes flow before the timer fires.
- **Models that reject sampling params**: set `ai-temperature: ""` to omit the field entirely; set `ai-tokens-param: max_completion_tokens` for newer OpenAI reasoning models.
- **Endpoint not always up** (homelab): configure `ai-fallback-base-url`/`ai-fallback-model` (e.g. a small cloud model), or set `on-model-failure: notice` so the PR gets a visible explanation instead of a bare red check.
- **Ambiguous failures no longer burn minutes** (#1305): an unrecognized 429, 5xx, or network/timeout failure on the primary lane gets at most one short retry (tier sleeps capped at 5 s) before the configured fallback runs — no low-retry profile is needed. Tune the per-attempt patience with `ai-connect-timeout-sec`/`ai-request-timeout-sec` instead:

```yaml
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
