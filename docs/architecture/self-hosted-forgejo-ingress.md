# Self-hosted Forgejo ingress and publication adapters

Design of the #730 operator-mode adapter layer, `src/ingress/`: the webhook
ingress, endpoint/credential plumbing, capability matrix, and
scheduling/reconciliation glue a self-hosted controller needs to service
Forgejo repositories over the canonical event/job contracts of #728
([forge-events-and-review-jobs.md](forge-events-and-review-jobs.md)).

This layer is **not wired into the Action runtime** — `action.yml` is
unchanged and Action mode behaves exactly as before. It is operator-mode
(#725) infrastructure: controllers import `src/ingress/` (via its barrel)
and own their own HTTP server, queue, and worker lifecycle.

## Module map

| module | role |
|---|---|
| `signature.ts` | `X-Gitea-Signature` computation/verification: lowercase-hex HMAC-SHA256 over the raw body, constant-time compare |
| `webhook-handler.ts` | Node `http` request handler for Forgejo webhook deliveries: size cap, verify-before-parse, fixed response bodies, canonical-event callback |
| `endpoints.ts` | Resolve REST API / web / repo-scoped / clone URLs from a configured platform base URL |
| `api-client.ts` | `ForgejoIngressClient`: read-only authenticated REST reads (`getJson`, `listOpenPullRequests`, `getPullRequest`) |
| `clone-credentials.ts` | Build a git clone credential as an HTTP Basic `Authorization` header pair |
| `capabilities.ts` | GitHub/Forgejo publish-capability matrix and `requireCapability` degradation checks |
| `dispatch.ts` | Canonical event → deduped review generation (`GenerationLedger`) and the exact-head publication gate |
| `reconcile.ts` | Missed-webhook reconciliation poll across configured repositories |

## Trust boundaries (webhook ingress)

- `X-Gitea-Signature` is HMAC-SHA256 over the **raw body**, verified
  **before** any `JSON.parse` — unauthenticated bytes never reach the JSON
  parser (`ingress-webhook.test.ts` pins the ordering both ways).
  Verification fails closed: an empty configured secret accepts nothing
  (even a request signed with the empty secret), and duplicate-header
  arrays and the GitHub `sha256=` prefixed form are rejected before any
  comparison (`ingress-signature.test.ts`).
- The `X-Gitea-Event` header is authoritative: it shape-checks against a
  strict pattern and is injected as `payload.name`, so a hostile payload
  `name` cannot re-route a delivery.
- Every response is a fixed status + fixed body; the payload, secret,
  signature, and error text are never reflected. Oversize bodies are
  refused mid-stream (413) and buffering stops immediately; `ping` and
  permanently unroutable deliveries are acked as ignored so the forge
  stops redelivering.
- Raw payloads stop at `normalizeForgejoEvent` (#728's adapter boundary);
  nothing in `src/ingress/` interprets untrusted content beyond the
  event-header shape and the canonical event's `kind`.

## Endpoint and credential model

Cloud hosts (e.g. `codeberg.org`) and self-hosted instances resolve
through the **same code**: `resolveForgejoEndpoints` delegates to
`parsePlatformBaseUrl` (which throws on non-http(s) protocols, embedded
credentials, missing hostname, or empty input) and appends `/api/v1`.
There are no hardcoded cloud hosts. The endpoint itself comes from the
operator's instance config (`ForgeIntegration` in
`src/config/instance-config.ts`; schema in
[operator-config-and-adoption.md](operator-config-and-adoption.md)).

`ForgejoIngressClient` validates and origin-binds the endpoint **before**
considering the token, then sends it only as the
`Authorization: token <value>` header through `platform/http.ts`, whose
policy pins the request to the validated origin and refuses redirects
(`redirect: "manual"`; a blocked redirect never reports its target).
Tokens that are empty or carry CR/LF (header injection) are refused at
construction. Reads are GET-only, and non-2xx/transport failures map to
fixed credential-free error strings — a hostile server reflecting the
token in a 404 body cannot leak it into a returned value.
`buildCloneCredential` follows the same rule for git: the token travels
only as a Basic `Authorization` header, **never** as userinfo in the
clone URL, so it never appears in process argv.

## Dedupe and convergence

`dispatchCanonicalEvent` turns a canonical event into at most one review
generation, deduped through a `GenerationLedger`
(`MemoryGenerationLedger` for process memory; durable state is #736).
Because job identity is `deriveGenerationId`'s field set alone — trigger
(`source`) and reason (`kind`) are excluded — a webhook delivery and a
reconciliation poll of the same head/config mint the **same** `jobId`, so
exactly one job survives — provided the identity metadata agrees: the
poller must supply the same `installationId` the webhook carried, and both
observations must carry the PR `id` (a missing `id` on one side sends
`prId` 0-vs-N and splits the generation; see
[forge-events-and-review-jobs.md](forge-events-and-review-jobs.md)); a new
head or a material config-fingerprint change re-keys.
`shouldSchedule` remains the single scheduling policy: `follow_up` and
terminal kinds never mint review generations through dispatch.
`reconcileForgejoRepositories` reuses the same identity path for its poll
and never throws — a failed repository is reported and the pass continues.

`dispatchCanonicalEvent` reserves through `ledger.addIfAbsent`, the atomic
reserve-and-check: a "scheduled" outcome means RESERVED, not enqueued, so
a failed queue handoff must release the reservation via `ledger.remove`
(durable lifecycle: #736).

`gateJobPublication` is the publication gate: `isExpired` first (an
expired job skips the head fetch entirely), then fetch the current head,
then `resultMatchesJob` for the exact-head rule — a null (unreadable)
current head fails closed as `stale`. A `publish()` rejection
**propagates**: the caller owns retry, and swallowing it would hide
partial-publication state behind a status value.

## Capability degradation

`capabilitiesFor` returns the frozen `GITHUB_CAPABILITIES` /
`FORGEJO_CAPABILITIES` matrix; the deltas are `checkRuns: false` and
`graphql: false` on Forgejo. `requireCapability` returns an explicit
refused `CapabilityCheck` naming the degradation — for `checkRuns` on
Forgejo, the commit-status fallback — and an unknown capability name
fails closed rather than silently passing. This mirrors the existing
precedent at the publication seam (`src/platform/publish-api.ts`), where
GraphQL-only operations degrade explicitly for Forgejo and are never a
publish failure; `ForgejoPublishApi` remains the source of reviewer
publication semantics — #730 adds **no** new publication behavior.

## Secrets policy

Consistent with the #728 jobs policy: durable events and jobs carry
**references only**. The resolved token lives only in the client/handler
options and the outbound `Authorization` header — never in URLs, response
bodies, error strings, or persisted job fields.

## #730 acceptance mapping

| criterion | where | tests |
|---|---|---|
| one self-hosted controller can service Forgejo repositories | `webhook-handler.ts` + `api-client.ts` + `dispatch.ts` + `reconcile.ts` over the #728 contracts | `tests-v3/ingress-webhook.test.ts`, `tests-v3/ingress-client.test.ts`, `tests-v3/ingress-endpoints.test.ts`, `tests-v3/ingress-reconcile.test.ts` |
| Forgejo jobs are indistinguishable from GitHub jobs after normalization, except explicit capability metadata | `normalizeForgejoEvent` (#728) produces the same `CanonicalForgeEvent` → same `deriveGenerationId` identity; the only forge-specific surface is `capabilities.ts` | `tests-v3/ingress-dispatch.test.ts` (webhook/poll convergence, re-keying), `tests-v3/ingress-webhook.test.ts` (canonical fields), `tests-v3/jobs.test.ts`, `tests-v3/events.test.ts` (identity parity) |
| existing v3 Forgejo behavior remains the source of reviewer semantics | unchanged `src/platform/publish-api.ts` (`ForgejoPublishApi`); `capabilities.ts` only describes degradation | `tests-v3/publish-api.test.ts` (GraphQL degradation precedent) |

## Out of scope (follow-on issues)

Queue durability (#731/#736), the credential broker (#735 — integration
`credential` fields stay opaque references), a durable generation ledger,
GitHub App ingress (#729), and executor/worker lifecycle (#733).