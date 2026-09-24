# ADR: Specialist execution shape — `three_call` retained over `combined_scout` / `prime_then_fanout`

Status: decided by benchmark under #704 (parent #636; machinery from #635 / PR #691). No production architecture change.

## Current architecture

`run_specialists.py` runs the deep-review specialist phase as **three concurrent role calls** (`three_call`): one request per fixed role (`correctness` / `security` / `tests`), each carrying the compact #632 specialist corpus plus that role's prompt fragment. `DEEP_REVIEW_EXECUTION` (`combined_scout` = one role-keyed call split into per-role artifacts; `prime_then_fanout` = the three payloads with the first completing before the rest launch) is benchmark-only and was never enabled in production.

## Decision

**Keep `three_call` as the production specialist architecture. Neither alternative cleared the decision bar, so no production change is made.**

- `combined_scout` is faster and materially cheaper per request, but **collapses specialist output**: 0.3 leads/run vs 2.0 (`three_call`) and 5.2 (`prime_then_fanout`) on the cloud lane — an ~85% reduction in advisory lead yield. The decision rule requires the alternative to *preserve specialist capability within a documented tolerance*; scout does not.
- `prime_then_fanout` is **strictly dominated**: identical request count and bytes as `three_call`, no measured latency win on the cloud lane (specialist phase 85.4 s vs 85.5 s), and zero cached-input tokens reported on either lane — the cache-priming premise never materialized in telemetry.
- The negative-control and known-finding corpus checks grade 0.0 for **every** shape (see limitations), i.e. no shape demonstrated a capability or false-positive advantage that could offset scout's lead-yield collapse.

## Benchmark design

`scripts/eval_harness.py --corpus evals/corpus-specialists.json --modes tools_off --deep-review true --deep-execution <shape>` over the 5 corpus PRs (547, 551, 612, 622, 597; 622 is the negative control), one invocation per shape per lane, `--runs-per-mode 1`.

- **`tools_off`** isolates the specialist phase (the object of study) from tool-loop variance and keeps runs inside the harness's fixed 300 s per-run subprocess ceiling.
- **Two lanes**, both OpenAI-compatible via the same LiteLLM proxy:
  - *local/self-hosted (prefill-expensive)*: `qwen3.8-27b-chat` on a self-hosted RTX 3090 vLLM (W4A16). Lane config `CONTEXT_LIMIT_MODE=low`, `AI_MAX_TOKENS=16384` — the production-default `normal` context budget and the `minimal` fallback both made the 27 B main review fail to complete (truncation/agentic drift), so the lane was given the smallest config under which its reviews complete at all.
  - *cloud (prefill-cheap)*: `MiniMax-M3-chat` with production-default context settings.
- **`DEEP_REVIEW_MAX_TOKENS` raised to ~16.4 k on both lanes**: at the 4096 default, reasoning-heavy specialists hit exactly 4095 completion tokens and degraded to zero leads (truncated JSON) — a config artifact that would have measured the cap, not the shapes. All three shapes on a lane share one value.
- **LiteLLM response-cache defeat**: the proxy serves byte-identical requests from a response cache (probed: identical body → same completion id in 0.036 s vs 0.91 s; `max_tokens` participates in the cache key). Since `prime_then_fanout` sends byte-identical payloads to `three_call`, whichever ran second would have measured cache reads. Each shape therefore ran with a distinct, semantically inert `DEEP_REVIEW_MAX_TOKENS` (cloud 16383/16385/16386, local 16373/16375/16376 — all far above the ~13.1 k max observed specialist output, so no cap binds differently), and `--runs-per-mode 1` so every (shape, PR) latency sample is a first-touch request.
- Shape order per lane: `three_call` → `combined_scout` → `prime_then_fanout`; lanes ran concurrently (independent upstreams).

### Known limitations (recorded honestly)

1. **Corpus staleness**: the corpus PRs are long-merged; `gh pr diff` now computes against the *moved* base branch, and reviewers visibly complained ("diff does not contain any hunks for pr_reviewer/precheck.py", "changes … pulled in via merge from main; unrelated to the PR's stated purpose"). Absolute corpus pass rates (0.0 for lead and effectiveness checks on every shape, both lanes) reflect stale fixtures plus mid-tier lane models — they are reported as the floor they are, and the shape comparison rests on same-input relative deltas (identical per-PR inputs across shapes), which the staleness affects equally.
2. **Cache telemetry unavailable**: both providers reported `cached_tokens = 0` on every request (field present, never non-zero), so the cache-priming hypothesis could not be validated through telemetry — only through measured wall clock.
3. **Local-lane completion rates are low** (1–3 of 5 per shape; main-review JSON parse failures from agentic drift/truncation on the 27 B chat model, identical across shapes). Local latency cells are n=1–3 and are labeled as such.
4. Error runs record fail-soft stderr (e.g. `No module named pr_reviewer.pr_thread` from old-PR-head clones lacking newer modules) — noise by design; the fatal cause in every error run was a main-review verdict parse failure, not a specialist-phase failure.

## Results

Completion is out of 5 corpus PRs; wall = whole review; phase = specialist phase. All values as recorded by the harness reports (committed under `evals/reports/deep-execution-shape/`).

### Cloud — MiniMax-M3-chat (prefill-cheap)

| shape | done | wall mean | phase mean | requests | req bytes | tok in | tok out | leads/run |
|---|---|---|---|---|---|---|---|---|
| three_call | 4/5 | 158.4 s | 85.5 s | 3 | 58 327 | 14 072 | 14 035 | 2.0 |
| combined_scout | 3/5 | 105.0 s | 70.7 s | 1 | 23 458 | 5 540 | 10 993 | 0.3 |
| prime_then_fanout | 4/5 | 147.8 s | 85.4 s | 3 | 60 632 | 14 672 | 12 961 | 5.2 |

- Scout: −33% wall, −60% request bytes, −60% specialist input tokens (corpus sent once instead of three times) — **but** 0.3 leads/run (0 on 2 of 3 completed runs) vs 2.0 for the production shape. The role-keyed single stream starves roles: in every observed scout run the model front-loaded `tests` (or nothing) and returned empty `correctness`/`security` arrays.
- Prime: phase time identical to `three_call` (85.4 vs 85.5 s) with the same 3 requests and slightly *more* bytes; zero cached tokens. Priming bought nothing where prefill is cheap.
- Negative control (PR 622): false-positive findings under every shape that completed (3 findings under `three_call`, 4 under scout; prime errored on this PR) — model-inherent, not shape-differentiated.

### Local — qwen3.8-27b-chat on a 3090 vLLM (prefill-expensive)

| shape | done | wall mean | phase mean | requests | req bytes | tok in | leads/run |
|---|---|---|---|---|---|---|---|
| three_call | 3/5 | 127.2 s | 40.0 s | 3 | 64 775 | 15 854 | 0 |
| combined_scout | 1/5 | 228.1 s | 180.3 s | 1 | 25 378 | 6 075 | 1 |
| prime_then_fanout | 1/5 | 53.8 s | 13.5 s | 3 | 54 474 | 13 275 | 1 |

- n is too small for confident per-shape latency claims (cells are n=1–3, labeled). The one scout completion had the *slowest* specialist phase observed locally (180.3 s for a single 6 k-token request); the one prime completion had the fastest (13.5 s) — consistent with prefix-cache priming helping on the GPU lane, but `cached_tokens` read 0 so the mechanism could not be confirmed, and the lane's completion rates dominate any such effect.
- Even granting prime its best local number, its cloud evidence (no benefit, +bytes) and this lane's 1/5 completion rate do not support a production switch.

### Lane-characterization smokes (not part of the shape tables)

With the *thinking* `qwen3.8-27b` at `minimal` context: `three_call` completed (284 s — 5 s under the harness ceiling) and `combined_scout` failed on main-review truncation. With either lane at the 4096 specialist token cap, roles degraded at exactly 4095 completion tokens. These motivated the per-lane configs above; raw reports are committed alongside the matrix reports.

## Why this satisfies the #704 decision rule

- All three shapes ran on the same specialist corpus with per-lane comparable settings: yes (above).
- Local/self-hosted and cloud results recorded: yes (above; local cells carry completion-rate caveats).
- Quality, false-positive, latency, token, request-byte, and cache telemetry compared: yes — with the explicit findings that (a) scout's request economy is real but its lead yield collapses, (b) prime's premise produced no measurable cache benefit on either lane, and (c) quality/false-positive corpus gates are at the floor for every shape, so they cannot justify switching to either alternative.
- Explicit keep/change decision: **keep `three_call`**; the benchmark machinery (`DEEP_REVIEW_EXECUTION`, `--deep-execution`) stays benchmark-only and fingerprint-free.

## What would change this decision

- A provider/lane where cached-input telemetry shows real prefix-cache savings for `prime_then_fanout` **and** lead-yield parity with `three_call` (within a stated tolerance) on a refreshed corpus.
- A scout variant that provably preserves per-role lead yield (e.g. per-role output quotas inside the single stream) — that is a *new* mechanism, requiring its own benchmark, not a switch enabled by this evidence.
- Corpus fixtures refreshed to post-merge diffs and lane models that reach the corpus needles, making the absolute quality gates meaningful again; rerun then.
