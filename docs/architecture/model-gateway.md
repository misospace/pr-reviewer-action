# Optional model gateway with run-scoped budgets and provider-key isolation (#765)

Design of `src/gateway/`: the controller-side boundary one review run's
model traffic flows through when an operator enables gateway mode. Like
the queue (#731), acquisition (#732), executor (#733), credential (#735),
and state (#736) layers before it, this is **a library for the future
self-hosted controller daemon — it is not wired into the running action
pipeline**. Parent: #725 (post-v3 self-hosted); builds on #735 (credential
broker) and #736 (durable control-plane state); composes with the shared
transport (#677).

The one-sentence rule: **a review run presents a short-lived capability
token authorizing exactly one `(runId, modelProfile)` under explicit
budget bounds until an expiry or a cancellation generation; the gateway
resolves the provider credential controller-side, calls through the
shared transport, and records normalized usage — and the provider key
never enters the review workspace or anything the gateway hands back.**

## How the existing seams compose

No new trust primitive is invented; #765 supplies the budget and
authorization layer the sibling layers defer to:

- `src/credentials/types.ts` defines the `CredentialBroker` seam and the
  `model` purpose — the gateway resolves the selected profile's provider
  credential through it at call time; the material travels only in the
  transport's auth header and never crosses back out.
- `src/credentials/result-channel.ts` is the pattern the capability token
  mirrors: HMAC-SHA256 over the bounded identity, controller signing key
  held privately, expiry inside the MAC, total verification over hostile
  input, `timingSafeEqual` comparison.
- `src/transport/transport.ts` (`runChatRequest`) IS the wire path: the
  gateway does not reimplement transport, streaming, retries, clamps, or
  response normalization — it delegates, so gateway mode and direct mode
  produce the same wire request shape and the same typed outcomes.
- `src/state/types.ts` (`UsageRecord`, `validateUsage`, `UsageRole`) and
  `src/state/usage.ts` (`usageWithoutCost`) are the accounting shape: the
  gateway records durable-shaped usage with provenance, never fabricating
  cost.
- `src/credentials/worker-set.ts` already anticipated the swap: the model
  credential is one named plan slot whose reference can become a gateway
  capability instead of a direct profile credential — no
  `ExecutionRequest` field changes.

## Module map

| module | role |
|---|---|
| `types.ts` | Frozen contracts: `GatewayBudgetLimits` (max requests / max input+output tokens / max cost micros; validated fail-closed, bounded to the token grammar) and `GatewayPerRequestBudget` (the operator-trusted per-call reservation bound the gateway books, validated within the run caps), the closed refusal vocabularies (`CAPABILITY_REFUSAL_CODES`, `BUDGET_REFUSAL_CODES`, and the derived `GATEWAY_REFUSAL_CODES` — the same runtime-array discipline as `RESOLUTION_REFUSAL_CODES`), `BudgetReservationRow` (the durable-shaped reservation record with its `validateBudgetReservationRow` validator, including the `overran` flag) and `BudgetRunGenerationRow` (the durable per-run cancellation-generation record with its validator), `BudgetDurableState` (the ONE durable payload: both halves together), the `BudgetLedger` seam, the `GatewayCapabilityAuth` seam, the secret-free `GatewayProfileEndpoint` controller config (including the operator's `extraHeaders`), `GatewayCallInput`, the `GatewayCallOutcome` union, and the `ModelGateway` seam |
| `capability.ts` | `createGatewayCapabilityAuth()` — HMAC-SHA256 over `(runId, modelProfile, generation, expiry, budget limits)`, keyed by the controller signing key (never in any token or error). The token carries the expiry, generation, identity, and limits in the clear with all of them inside the MAC, so verification can attribute a failure to its closed code (`invalid_token` / `expired` / `wrong_run` / `profile_mismatch` / `cancelled` / `budget_bounds_mismatch`) without ever trusting an unauthenticated field — every comparison happens only after the MAC passes. Verification is total over hostile input (never throws, `timingSafeEqual`, bounded token length) |
| `budget.ts` | `InMemoryBudgetLedger implements BudgetLedger` — reserve-before-call accounting: admission is decided against the REQUESTING RUN's committed actuals plus its live reserved estimates BEFORE the wire call (the projection is **scoped to the run** — the caps are one run's allowance, so a shared controller ledger never lets one run consume another run's requests/tokens/cost; `usageFor(runId)` reports one run and `usage()` the controller-wide total), and a reservation that would exceed any cap is refused with `budget_exhausted`; the caller-supplied reservation id is the idempotency identity (a retry after a crash returns the SAME row; a different identity under the same id is `reservation_mismatch`); failed requests refund; commit settles exact actuals (idempotent replay of identical actuals, refusal on divergence, `requestCount >= 1`) and flags `overran` when the actuals exceeded the reserved estimate bounds — admission gates on estimates, the ledger records reality, the overshoot is visible; cancellation is a generation bump the ledger records per run. `durableState()` returns the durable payload as ONE object — the reservation rows AND the per-run cancellation-generation rows together — and the constructor re-seeds from that one object (`state:`), so "persist the accounting but forget the cancellation" is a visible act instead of an omission (the cancellation half is NOT inferable from reservation rows: without it a restart would reset an unseen-cancel run to generation 1 and resurrect its outstanding older-generation tokens). The in-memory implementation is the tests/dev backend, like `InMemoryControlPlaneStore` |
| `gateway.ts` | `createModelGateway()` — the per-call flow: verify capability FIRST (before any profile-existence check, so an unauthenticated caller cannot enumerate configured profiles — a bad token gets a capability refusal whatever profile name it claims) → resolve the token's profile endpoint → reserve the operator's per-call budget bound against the run's remaining allowance → resolve the provider credential via the #735 broker (purpose `model`, bound to the token's profile and the run's forge scope) → call `runChatRequest` with the profile's endpoint config exactly as direct mode would (the response-byte ceiling, the per-request reservation bound, and the operator's extra headers are OPERATOR config — a worker supplies none, so it can neither raise the ceiling, inject headers, nor under-estimate to slip past the run budget; the extra-header set is validated through the transport's own fence, so a reserved name like `authorization` can never be overridden) → record usage (`configured-estimate` when the profile declares per-million pricing, else zero-cost `unknown` per the never-fabricate rule) → commit actuals or refund on failure; a `usage_record_invalid` outcome refunds AND still records the zero-token attempt row (a provider-billed call is never erased). Fail-closed construction: caps must equal the ledger's, the operator per-request reservation bound must be a positive integer within the run caps (a single call can never reserve past them), the credential reference must be an opaque non-secret-shaped reference, endpoint URLs must be http(s) without embedded credentials. `call` is a TOTAL function: it never rejects — an unexpected throw from the transport or credential seam becomes a typed `gateway_error` refusal with the reservation refunded, and broker refusal reasons are mapped to a fixed bounded vocabulary, never echoed unbounded |
| `sanitize.ts` | The provider-key-isolation fence at the gateway's worker-facing boundary. A provider can quote the credential it was given straight back into its own answer, so three surfaces could carry it out: the RAW provider body, the RESPONSE (completion text, tool calls, error payload, and the `id`/`model`/`finishReason` metadata), and a TRANSPORT FAILURE body. The diagnostic surfaces (raw body, failure body/message) are MASKED (`redactTextDeep` — the #1149 composition: configured values first, then the generic credential-shape heuristics; masking never changes the call's outcome), and the response REFUSES rather than masks (`containsKnownSecret`, the #1094 rule — a response carrying the credential fails the whole call with `provider_response_unsafe` instead of publishing it or corrupting a verdict with a spliced marker). The scan is LEAF-WISE over the whole response, not over the completion text alone and not over one JSON stringification: a credential carrying a JSON-escaped character (`"`, `\`) survives neither spelling. The secret list is the transport's own `callKnownSecrets` (the provider credential plus the VALUES of the operator's extra headers) PLUS each value's JSON-escaped spelling, so gateway mode and direct mode mask the same bytes. One asymmetry is the repo's own (#1094): detection uses `containsKnownSecret`'s 8-character floor (below it a raw value is prose-indistinguishable — masking it in a verdict would corrupt the verdict, refusing on it would refuse ordinary prose), while the diagnostic surfaces mask at ANY length |

## What crosses the boundary, and what never does

| crossing | allowed | forbidden |
|---|---|---|
| review worker / workspace | the capability token (a MAC, no provider authority) | provider API keys, controller signing key, other profiles' credentials |
| gateway outcome objects | normalized response, raw provider body, validated `UsageRecord` | credential material (serialization-guarded: outcomes and the gateway object stringify to names/caps only) |
| durable state (reservation rows, usage records) | reservation identities/estimates/actuals, usage counts, cost + provenance | credential material, tokens, key values |
| refusal reasons | fixed bounded strings, closed codes | token bytes, key values, response bodies |
| provider endpoint config | baseUrl, API format, timeouts, optional pricing | inline secrets (the credential is a broker reference) |

## Security invariants

- **Provider-key isolation.** The provider credential exists only inside
  the gateway call: resolved from the #735 broker at the last moment,
  passed to `runChatRequest` as `apiKey` (auth headers only — never argv,
  never URLs, never bodies), and never placed in an outcome, a refusal
  reason, a reservation row, or a diagnostic. A worker in gateway mode
  holds a capability token, not a provider key.
- **Provider-key isolation also covers the reflection path.** A provider
  can quote the credential it was given straight back into its own answer
  ("your Authorization header was `Bearer <key>`"), so the boundary — the
  component that resolved the key — closes three surfaces itself
  (`src/gateway/sanitize.ts`): the raw provider body and a transport
  failure body are MASKED (diagnostic surfaces: masking never changes the
  call's outcome), and the response REFUSES the call
  (`provider_response_unsafe`, reservation refunded, attempt recorded
  honestly) rather than publishing the key or corrupting a verdict with a
  spliced marker. The refusal scan is leaf-wise over the WHOLE response —
  every provider-authored string, including the `id`/`model`/`finishReason`
  metadata, the tool calls and the error payload — and the secret list
  carries each value's JSON-escaped spelling, so an escaped echo is
  caught too. The operator's extra-header VALUES are masked with the
  credential — they routinely carry proxy tokens.
- **Gateway mode is not a lesser endpoint.** The operator's per-profile
  config — base URL, API format, timeouts, response-byte ceiling, extra
  headers — is applied exactly as direct mode applies it, so a provider
  that needs the operator's proxy/token headers behaves identically in
  both modes. The extra-header set is validated through the transport's
  own fence (`applyExtraHeaders`), so an operator can never override the
  auth header this gateway authenticates with, and a worker can never
  inject a header at all.
- **Run/profile scoping.** The token authorizes exactly one
  `(runId, modelProfile)`; a request naming another profile is refused
  with `profile_mismatch`, another run with `wrong_run` — refused, not
  filtered, the same posture as the broker's scope binding.
- **Cancellation and expiry bound usefulness.** The token expires
  (enforced against the injected clock), and cancellation is a generation
  bump: the ledger records the current generation per run and a token
  minted for an older one is refused with `cancelled`, immediately —
  without waiting out the TTL. The bump is DURABLE: it lives in the
  per-run generation rows alongside the reservation rows, so a restarted
  controller re-seeds the cancellation state too and a cancelled run's
  outstanding older-generation tokens stay refused (no resurrection). The
  ledger produces that state as ONE durable payload
  (`durableState()` — rows AND generations together) and re-seeds from
  that one object (`state:`), so a controller cannot persist the
  accounting half and forget the cancellation half.
- **Budget refusal is its own stop reason.** `budget_exhausted` is a
  closed gateway refusal code; it is an operator-bound fact about the
  run's allowance, never evidence about the PR, and must never be
  surfaced as a safety finding or as a provider failure.
- **Budget is run-scoped and controller-owned.** The caps are one run's
  allowance; the ledger projects admission against that run's own committed
  and reserved rows, so a shared controller ledger never lets run A exhaust
  run B. And the figure reserved for each call is the operator's per-request
  bound — never a worker-supplied estimate — so an untrusted worker cannot
  submit a zero estimate to slip a request past the signed budget before the
  provider-billed actuals are recorded.
- **No double-charge, no silent exceed.** Reserve-before-call with
  caller-supplied idempotency ids; a replayed settled reservation refuses
  (`reservation_settled`) rather than re-calling the provider; refunds
  are exact; committed usage counts actuals; when actuals exceed the
  reserved estimate the row is flagged `overran` (admission gates on
  estimates; the ledger records reality and makes the overshoot
  visible); a restarted controller re-seeds from the durable rows and
  behaves identically.
- **Total-function call surface.** `gateway.call` never rejects: every
  failure is a typed closed-code refusal outcome, including unexpected
  throws from the transport or credential seam (`gateway_error`, with the
  reservation refunded), and every refusal reason is a fixed bounded
  string from the gateway's own vocabulary — never an echoed foreign
  message, a URL, a response body, or credential material.
- **Provider-agnostic; local endpoints first-class.** The endpoint is
  ordinary per-profile controller config (`baseUrl` + API format); no
  provider-specific behavior exists anywhere in the module, and a profile
  with no configured pricing records tokens normally at zero cost with
  `unknown` provenance.
- **No routing policy.** The gateway forwards the engine's wire payload
  verbatim and returns the transport's typed failures unchanged; provider
  fallback/routing stays the engine's declared route, never gateway
  policy.
- **No engine or pipeline infection.** Nothing in `src/run/`,
  `src/engine/`, or the action pipeline imports this package; gateway
  mode is not required — direct worker mode (`#735`'s
  `direct_worker`) remains the shipped Action path.
- **Fail closed.** Construction validates caps, references, profiles, and
  endpoint URLs; call inputs are grammar-checked before anything runs;
  the usage record must pass `validateUsage` before the reservation
  commits; verification is total over hostile input.

## Out of scope (follow-on work)

- Controller-daemon wiring (#736/#725): which component mints capability
  tokens, bumps generations on cancellation, persists reservation rows in
  the durable store, and fronts the gateway for workers.
- A durable budget backend: deliberately absent — the in-memory ledger is
  the tests/dev reference; the durable payload it produces
  (`durableState()`) is what a #736 backend persists and re-seeds from.
- Provider-reported cost: the shared transport reports usage tokens, not
  a cost figure; `provider-reported` provenance activates when a transport
  outcome carries one. Until then cost is `configured-estimate` or the
  honest zero-cost `unknown`.
- Gateway-mode plan wiring in `buildWorkerCredentialPlan` (`WorkerModelMode`
  gains a gateway member when the daemon work lands).

## #765 requirement → enforcement → test

The issue's requirement statements, each with the enforcement site and the
test that proves it. Every claim in the table is a path in this change, so
a reviewer can check a row without re-deriving it.

| #765 requirement | enforcement | test |
|---|---|---|
| local/self-hosted endpoints remain first-class | `src/gateway/types.ts:162` (the profile endpoint is ordinary config; pricing is optional), `src/gateway/gateway.ts:502` (no pricing → zero cost, `unknown` provenance) | `gateway: a local model with no monetary pricing records tokens at zero cost, provenance unknown`; `budget: unknown pricing contributes 0 cost but tokens and requests still count` |
| no provider-specific behavior leaks into the engine | `src/gateway/gateway.ts:199` (the shared transport seam — the gateway never speaks to a provider API itself) | `gateway: direct mode vs gateway mode — the same wire request shape and outcome mapping`; `gateway: Action mode stays unaffected — nothing outside the library imports it` |
| gateway is not required by Action mode | `src/gateway/` is imported by nothing outside itself; `action.yml` exposes no gateway input | `gateway: Action mode stays unaffected — nothing outside the library imports it` |
| streaming/non-streaming semantics follow the shared transport contract | `src/gateway/gateway.ts:199` (`runChatRequest` owns streaming, retries, clamps, normalization) | `gateway: direct mode vs gateway mode — the same wire request shape and outcome mapping` |
| provider fallback/routing remains the engine's declared route, not gateway policy drift | the gateway forwards the payload verbatim and returns the transport's typed failure unchanged (`src/gateway/gateway.ts:273`) — it never picks a provider | `gateway: a failed request refunds its reservation and records the attempt honestly`; `gateway: direct mode vs gateway mode — the same wire request shape and outcome mapping` |
| budget refusal is a distinct failure/stop reason, never evidence of safety | `src/gateway/budget.ts:146` (`budget_exhausted`), `src/gateway/types.ts:111` (closed refusal vocabulary) | `budget: a reservation that would exceed any cap is refused with budget_exhausted`; `gateway: budget refusal is its own closed stop reason — never a provider call, never a safety finding` |
| controller restart/worker retry cannot double-charge or silently exceed the accounting contract | `src/gateway/budget.ts:146` (reserve-before-call, caller-supplied idempotency id), `src/gateway/budget.ts:321` (`durableState()` — one payload, both halves), `src/gateway/budget.ts:222` (exact settle, `overran` flag) | `budget: a retry with the same reservation id returns the SAME reservation (no double-charge)`; `budget: the durable payload is ONE object — a restart from it keeps the cancellation`; `gateway: a replayed settled reservation id refuses and never re-calls the provider (no double-charge)` |
| record input/cache/output tokens where available | `src/gateway/gateway.ts:501` (provider-reported usage, cache read/write included) | `gateway: a valid call verifies, reserves, resolves, calls the transport, records and commits` |
| record model/profile/route/role | `src/gateway/gateway.ts:517` (route = the profile, role = the call's `UsageRole`) | `gateway: a valid call verifies, reserves, resolves, calls the transport, records and commits` |
| record request count | `src/gateway/budget.ts:222` (`requestCount >= 1` on every committed row) | `budget: reserve records an estimate, commit settles actuals, refund removes it` |
| record estimated or provider-reported cost with provenance | `src/gateway/gateway.ts:511` (`configured-estimate` from operator pricing) | `gateway: a valid call verifies, reserves, resolves, calls the transport, records and commits` |
| record the run total | `src/gateway/budget.ts:288` (`usageFor(runId)` / `usage()`) | `budget: usageFor is one run's totals; usage is the controller-wide total` |
| unknown pricing remains unknown/zero-with-explicit-source | `src/gateway/gateway.ts:514` (`usageWithoutCost` → zero cost, `unknown` provenance) | `gateway: a local model with no monetary pricing records tokens at zero cost, provenance unknown` |
| expired/canceled/wrong-run token refused | `src/gateway/capability.ts:97` (`verifyDetailed`, total over hostile input), `src/gateway/budget.ts:293` (generation) | `gateway: an expired token is refused against the injected clock`; `gateway: a cancelled run (generation bump) refuses its outstanding token`; `gateway: a token cannot drive another run` |
| model-profile isolation | `src/gateway/capability.ts:97` (`profile_mismatch`), `src/gateway/gateway.ts:148` (no profile-existence oracle before verification) | `gateway: profile isolation — a request naming another profile is refused before any provider call`; `gateway: an unauthenticated caller cannot enumerate configured profiles` |
| provider key absent from worker | `src/gateway/sanitize.ts:93` (raw body masked), `src/gateway/sanitize.ts:109` (the response refuses, leaf-wise over every provider-authored string), `src/gateway/sanitize.ts:141` (failure body masked) | `gateway: the provider key never enters the worker-facing surface (serialization + refusal guards)`; `gateway: a provider that reflects the credential into the raw body is masked before it reaches the worker`; `gateway: a completion that carries the credential fails the call closed instead of publishing it`; `gateway: a provider that reflects the credential into the response metadata is refused, not published`; `gateway: a credential with a JSON-escaped character is caught wherever the provider writes it` |
| concurrent budget reservation | `src/gateway/budget.ts:146` (the reserve critical section is synchronous — no await between the totals read and the row write) | `budget: concurrent reservations are safe — the cap admits exactly what fits` |
| failed request refund/accounting semantics | `src/gateway/budget.ts:262` (`refund`), `src/gateway/gateway.ts:336` (the honest zero-token attempt row) | `budget: reserve records an estimate, commit settles actuals, refund removes it`; `gateway: a failed request refunds its reservation and records the attempt honestly` |
| direct mode vs gateway mode transport equivalence | `src/gateway/gateway.ts:199` (same transport, same request shape) and `src/gateway/gateway.ts:208` (the operator's extra headers reach the provider identically) | `gateway: direct mode vs gateway mode — the same wire request shape and outcome mapping`; `gateway: operator extra headers reach the transport exactly as they do in direct mode` |
| local model with no monetary pricing | `src/gateway/gateway.ts:502` (pricing optional) | `gateway: a local model with no monetary pricing records tokens at zero cost, provenance unknown` |
| restart/retry behavior | `src/gateway/budget.ts:321` (`durableState()`), `src/gateway/budget.ts:87` (re-seed from that one payload) | `budget: restart replay — a re-seeded ledger returns the same reservation and never double-charges`; `budget: cancellation survives a restart — generation rows are part of the durable re-seed payload`; `budget: the durable payload is ONE object — a restart from it keeps the cancellation`; `gateway: cancellation survives a restart — a gen-1 token still refuses after a re-seed` |

## #765 acceptance mapping

| criterion | where | tests |
|---|---|---|
| Token authorizes only the selected profile, run, limits, expiry, generation | HMAC over all of them; every dimension checked after the MAC | `tests-v3/gateway-capability.test.ts :: capability: mint produces a v1 gateway token that verifies for its own identity`; `capability: a token cannot serve another run or another model profile` |
| Expired / cancelled / wrong-run tokens refused | `expired` against the injected clock; `cancelled` on generation bump; `wrong_run` | `capability: an expired token is refused even for its own identity`; `capability: a token minted for an older generation is refused`; `tests-v3/gateway.test.ts :: gateway: an expired token is refused against the injected clock`; `gateway: a cancelled run (generation bump) refuses its outstanding token`; `gateway: a token cannot drive another run` |
| Model-profile isolation | `profile_mismatch` before any provider call | `gateway: profile isolation — a request naming another profile is refused before any provider call` |
| Provider key never in the worker/workspace | broker-resolved at call time, auth header only, serialization + refusal guards | `gateway: the provider key never enters the worker-facing surface (serialization + refusal guards)`; `capability: different keys derive different tokens, and the key never appears in a token or error` |
| Budget enforced before each step; refusal is its own stop reason | reserve-before-call, `budget_exhausted` closed code, no provider call, no finding shape | `gateway: budget refusal is its own closed stop reason`; `tests-v3/gateway-budget.test.ts :: budget: a reservation that would exceed any cap is refused with budget_exhausted` |
| Budget is run-scoped — one run never consumes another's allowance | the ledger projects admission against the requesting run's own rows; `usageFor(runId)` per run, `usage()` controller-wide | `tests-v3/gateway-budget.test.ts :: budget: the caps are a RUN's allowance — one run never exhausts another's`; `budget: a run at its token cap does not block another run under it`; `budget: usageFor is one run's totals; usage is the controller-wide total`; `tests-v3/gateway.test.ts :: gateway: the budget is run-scoped — one run never consumes another's allowance` |
| Admission reserves the operator bound, never a worker figure | `perRequestBudget` (operator config, validated within the caps); `GatewayCallInput` carries no budget estimate | `tests-v3/gateway.test.ts :: gateway: admission reserves the operator per-call bound, never a worker figure`; `gateway: construction fails closed on disagreeing caps, secret-shaped references, and bad endpoints` |
| Failed requests refund; accounting stays honest | refund on failure, zero-token attempt row, exact settle transitions | `budget: reserve records an estimate, commit settles actuals, refund removes it`; `budget: settle-state transitions are exact`; `gateway: a failed request refunds its reservation and records the attempt honestly` |
| Restart/retry cannot double-charge or silently exceed | caller-supplied reservation ids, durable rows + generation rows, re-seeded ledger, `reservation_settled`, `overran` flag | `budget: a retry with the same reservation id returns the SAME reservation`; `budget: restart replay`; `budget: cancellation survives a restart`; `budget: committed actuals beyond the reserved estimate are flagged overran`; `gateway: a replayed settled reservation id refuses and never re-calls the provider`; `gateway: restart/retry`; `gateway: cancellation survives a restart` |
| Concurrent reservations are safe | synchronous reserve critical section over recorded rows | `budget: concurrent reservations are safe — the cap admits exactly what fits` |
| Local model, no monetary pricing | zero cost, `unknown` provenance, tokens/requests recorded | `gateway: a local model with no monetary pricing records tokens at zero cost, provenance unknown`; `budget: unknown pricing contributes 0 cost but tokens and requests still count` |
| Direct mode vs gateway mode equivalence | same wire request, same auth header, same outcome mapping | `gateway: direct mode vs gateway mode — the same wire request shape and outcome mapping` |
| Usage conforms to #736 records | `validateUsage` before commit; `usageWithoutCost` for unpriced routes | `gateway: a valid call verifies...` (validateUsage asserted); `tests-v3/gateway.test.ts` throughout |
| Total-function call surface / hostile tokens / profile-name probes | `gateway_error` on seam throws; `invalid_token` on garbage tokens; no profile-existence oracle before verification; null-prototype profile lookup | `gateway: an unexpected transport-seam throw becomes a typed gateway_error refusal with refund`; `gateway: a structurally garbage token is refused with invalid_token, never a throw`; `gateway: an unauthenticated caller cannot enumerate configured profiles`; `gateway: prototype-chain profile names are looked up on the null-prototype record, never a crash`; `capability: hostile tokens fail closed without throwing`; `capability: malformed presented limits refuse without throwing` |
| Hostile provider usage / operator-only transport knobs | `usage_record_invalid` refunds AND records the attempt; response ceiling from profile config only | `gateway: a hostile provider usage shape fails closed`; `gateway: the response-byte ceiling is operator config only` |
| Provider-key isolation under provider reflection (a provider that quotes the credential back) | `src/gateway/sanitize.ts` — the raw body and a transport failure body are MASKED, the completion REFUSES the call (`provider_response_unsafe`); the secret list is the transport's `callKnownSecrets` (credential + extra-header values) | `gateway: a provider that reflects the credential into the raw body is masked before it reaches the worker`; `gateway: a completion that carries the credential fails the call closed instead of publishing it`; `gateway: a transport failure body that echoes the credential is masked` |
| Gateway mode is not a lesser endpoint (operator extra headers reach the provider) | `GatewayProfileEndpoint.extraHeaders` (operator config), validated through the transport's own fence and passed to `runChatRequest`; a worker supplies none | `gateway: operator extra headers reach the transport exactly as they do in direct mode`; `gateway: an invalid operator extra-header set fails closed at construction` |
| The durable payload is ONE object (a controller cannot persist the accounting and forget the cancellation) | `BudgetLedger.durableState()` / `InMemoryBudgetLedger({ state })` — reservation rows AND per-run generations together | `budget: the durable payload is ONE object — a restart from it keeps the cancellation`; `budget: cancellation survives a restart — generation rows are part of the durable re-seed payload`; `gateway: cancellation survives a restart — a gen-1 token still refuses after a re-seed` |
| Action mode remains unaffected (the library is unwired) | no source file outside `src/gateway/` imports the library; `action.yml` exposes no gateway input | `gateway: Action mode stays unaffected — nothing outside the library imports it` |
