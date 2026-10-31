# Self-hosted Forgejo ingress and publication adapters

Design of the #730 operator-mode adapter layer, `src/ingress/`: the webhook
ingress, endpoint/credential plumbing, capability matrix, and
scheduling/reconciliation glue a self-hosted controller needs to service
Forgejo repositories over the canonical event/job contracts of #728
([forge-events-and-review-jobs.md](forge-events-and-review-jobs.md)).

This layer is **not wired into the Action runtime** — `action.yml` is
unchanged and Action mode behaves exactly as before. It is operator-mode
(#725) infrastructure: controllers import `src/ingress/` (via its barrel)
and own their own HTTP server, queue, and worker lifecycle;
`operator-host.ts` (`createOperatorHost`) is the pre-bound handler — it
constructs the operator event router (follow-up consumer included) and hands
it to the webhook handler, so the daemon only supplies the listening socket.
It also owns the Q&A budget's durable state (#1295): the daemon supplies its
durable state location (`durableStateDir`, required) and the host builds the
durable budget store over the ledger inside it, so the follow-up budget
survives a daemon restart and the shipped operator path cannot run on a
per-process budget. The daemon also owns the budget's IDEMPOTENCY horizon
(`rateLimitIdempotencyRetentionMs`, optional): how long a request-identity
record survives, i.e. how long a redelivery of an already-charged question
is recognized and charged nothing (a value shorter than the budget retention
is refused at construction).

## Module map

| module | role |
|---|---|
| `signature.ts` | `X-Gitea-Signature` computation/verification: lowercase-hex HMAC-SHA256 over the raw body, constant-time compare |
| `webhook-handler.ts` | Node `http` request handler for Forgejo webhook deliveries: size cap, verify-before-parse, fixed response bodies, then the native→canonical projection and the #728 normalizer, and the canonical-event callback |
| `forgejo-events.ts` | `projectForgejoWebhookPayload`: native Forgejo/Gitea webhook vocabulary → the GitHub-compatible envelope the #728 normalizer expects; runs after signature verification + JSON parse, before `normalizeForgejoEvent`; each header hint is gated on the signed body (signed `action` for the PR families, the signed check/status shape for the check family) |
| `endpoints.ts` | Resolve REST API / web / repo-scoped / clone URLs from a configured platform base URL |
| `api-client.ts` | `ForgejoIngressClient`: read-only authenticated REST reads (`getJson`, `listOpenPullRequests`, `getPullRequest`) |
| `clone-credentials.ts` | Build a git clone credential as an HTTP Basic `Authorization` header pair |
| `capabilities.ts` | GitHub/Forgejo publish-capability matrix and `requireCapability` degradation checks |
| `dispatch.ts` | Canonical event → deduped review generation (`GenerationLedger`) and the exact-head publication gate |
| `reconcile.ts` | Missed-webhook reconciliation poll across configured repositories |
| `followup-host.ts` | Operator-mode follow-up consumer (#1294): one canonical `follow_up` event through the shared planner; all forge I/O through the injected `FollowUpForgeAdapter` |
| `operator-router.ts` | Operator-mode canonical event router: `follow_up` → the follow-up consumer, every other kind → the daemon's dispatch seam (rejection propagates) |
| `operator-host.ts` | Production host: constructs the router UNCONDITIONALLY and binds it into `webhook-handler.ts` — the in-repo production caller, so follow-up consumption is never an opt-in the wiring can forget — and owns the Q&A budget's durable backend (#1295): it builds the `DurableRateLimitStore` over the ledger inside the operator's durable state location (`durableStateDir`, required) and refuses a follow-up configuration that brings its own budget backend; the budget's idempotency horizon is the operator's configuration too (`rateLimitIdempotencyRetentionMs`, optional) |

## Trust boundaries (webhook ingress)

- `X-Gitea-Signature` is HMAC-SHA256 over the **raw body**, verified
  **before** any `JSON.parse` — unauthenticated bytes never reach the JSON
  parser (`ingress-webhook.test.ts` pins the ordering both ways).
  Verification fails closed: an empty configured secret accepts nothing
  (even a request signed with the empty secret), and duplicate-header
  arrays and the GitHub `sha256=` prefixed form are rejected before any
  comparison (`ingress-signature.test.ts`).
- The `X-Gitea-Event` and `X-Gitea-Event-Type` headers are **unauthenticated
  hints**, not authenticated facts: the HMAC covers the raw body only, so both
  are shape-checked against a strict pattern (shape validation, not
  authentication) and each hint is honored **only when the signed body's own
  `action` authorizes it** — `synchronized`/`synchronize` for the sync hint,
  `label_updated` for the label hint, `created` for the comment hint. A hint
  conflicting with the signed action is never forced: the delivery falls back to
  the grouped rule for its header (the legacy ungrouped `pull_request_sync`
  header rejoins the `pull_request` group, so its signed action decides) or to
  the generic passthrough, so a captured delivery replayed with forged
  sync/label/comment headers cannot reclassify a terminal
  `pr_merged`/`pr_closed` into a scheduleable `synchronize`, mint a
  `rereview_label`, or turn a signed body into a `follow_up` (#1024). The
  headers still decide the projected `name`, and payload text never reaches a
  synthesized field, so a hostile payload `name`/`event` cannot re-route a
  delivery. The payload is untrusted and no untrusted string is copied into a
  synthesized field: the only value the projection synthesizes is the trusted
  re-review-label constant, matched byte-for-byte against `pull_request.labels`
  and re-emitted as that constant — never as a copy of the payload text — so a
  hostile label cannot forge the trigger.
- The check/status family is shape-anchored (#1102): a `check_run` /
  `check_suite` / `status` group header is honored as a passthrough **only**
  when the **signed** body carries the shape that name requires — a top-level
  `check_run` / `check_suite` object, or the top-level `sha`/`state`/`context`
  triple. The shape fields are read as **own** properties (the JSON-parsed keys
   a real delivery carries), so a prototype-carried shape is not this delivery's
   data. Otherwise the projected `name` is the fixed literal `unknown` (the
  normalizer maps it to `unknown`; 202 accepted/unknown, no response-code
  change), never the forged family name, so a captured delivery replayed
  under a forged check/status header cannot reach the scheduleable
  `check_update` kind. The gate requires nothing GitHub-only: Gitea/Forgejo
  emits no `check_run`/`check_suite` webhook event at all (check runs are a
  capability degradation, `capabilities.ts`: `checkRuns: false`) and does emit
  commit-status webhooks natively with exactly the `sha`/`state`/`context`
  triple, so no real Forgejo delivery is dropped. The `X-Gitea-Event-Type`
  header is not consulted for this family (as for every non-PR family: only
  the group header ever reaches the envelope).
- Every response is a fixed status + fixed body; the payload, secret,
  signature, and error text are never reflected. Oversize bodies are
  refused mid-stream (413) and buffering stops immediately; `ping` and
  permanently unroutable deliveries are acked as ignored so the forge
  stops redelivering.
- Raw payloads stop at the projection (`projectForgejoWebhookPayload`,
  `forgejo-events.ts`), which runs after the HMAC signature check and
  `JSON.parse` and before the #728 `normalizeForgejoEvent`; it reads only
   the two shape-guarded headers and a small set of field shapes (to remap
   native vocabulary, gate each hint on the signed action, and gate the
   check/status family on the signed body's shape) and forwards
   everything else untouched, so the
   frozen provider-neutral normalizer still sees only the
   GitHub-compatible envelope.

### Native event projection (`forgejo-events.ts`)

Why it exists: native Gitea/Forgejo deliveries do not speak GitHub's
event vocabulary, so `projectForgejoWebhookPayload` re-maps them into the
GitHub-compatible envelope the #728 normalizer expects. It runs after
HMAC verification + `JSON.parse` and before the frozen #728
`normalizeForgejoEvent`. That normalizer is a frozen provider-neutral
contract shared with GitHub, so provider vocabulary is the ingress
adapter's concern: GitHub deliveries are already in the canonical
envelope and are projected unchanged — GitHub behavior stays
byte-identical (`ingress-webhook.test.ts`).

Header quirk: `X-Gitea-Event` carries the **grouped** event name;
`X-Gitea-Event-Type` carries the specific type. Grouping:
`pull_request_sync`/`pull_request_label` → `pull_request`, and
`pull_request_comment` → `issue_comment`. An invalid or missing type
header is ignored — the grouped header alone drives projection. Neither
header is authenticated (the HMAC covers the body only), so a hint only
refines a projection the signed `action` already authorizes; an
incompatible hint is never forced — the grouped rule re-dispatches on the
signed action.

| Native delivery | Projected envelope | Canonical kind |
|---|---|---|
| `pull_request` + action `synchronized` (hint: header/type `pull_request_sync` — honored only on a `synchronized`/`synchronize` body) | `pull_request` + `synchronize` | `synchronize` |
| `pull_request` + action `reopened` | `pull_request` + `reopen` | `pr_reopened` |
| `pull_request` + action `label_updated` (hint: the ungrouped `pull_request_label` header — honored only on a `label_updated` body; the grouped `pull_request` delivery needs no hint) | `pull_request` + `labeled`, `label` synthesized | `rereview_label` when the trigger label is present, else ignored |
| `issue_comment` + action `created` (hint: type `pull_request_comment`, or the ungrouped header — honored only on a `created` body), top-level `pull_request` | `issue_comment` with `pull_request` re-nested under `issue` (top-level key removed) | `follow_up` |
| `check_run` (required signed shape: top-level `check_run` object) | `check_run` | `check_update` |
| `check_suite` (required signed shape: top-level `check_suite` object) | `check_suite` | `check_update` |
| `status` (required signed shape: top-level non-empty `sha` + `state` + `context` strings) | `status` | `check_update` |
| any of the three family names WITHOUT that signed shape (the type header is not consulted) | the fixed literal `unknown` — never the forged family name | `unknown` (acked 202, dropped by the kind-gating consumer) |

Label synthesis caveat: a native `label_updated` carries no top-level
`label`, so the projection fires `rereview_label` only when the re-review
label appears in `pull_request.labels`, synthesizing the operator's
trusted constant (never payload text). An unrelated-label update while
the trigger label already exists can over-trigger — harmless, because
same-head re-review generations converge to the ONE #728 job id via the
generation ledger (see Dedupe and convergence). A removal
(`label_deleted`/`label_cleared`) under the legacy ungrouped label header
now degrades to `unknown` instead of projecting `labeled`: the signed
action no longer authorizes a re-review trigger (#1024).

Fail-closed: unknown events, labels, and comments project to shapes the
normalizer maps to `unknown` — those are still acked (202) and forwarded to
the canonical-event callback, and the kind-gating consumer (dispatch) drops
them; only a null normalization is acked 200-ignored. Neither path is ever a
mis-route. Both headers are shape-guarded but unauthenticated: the HMAC covers
the raw body only, so they may refine a projection compatible with the signed
action and nothing else (#1024).

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
`reconcileRepositories` (the platform-agnostic missed-webhook pass — `platform: "forgejo"` here) reuses the same identity path for its poll
and never throws — a failed repository is reported and the pass continues.

`dispatchCanonicalEvent` reserves through `ledger.addIfAbsent`, the atomic
reserve-and-check: a "scheduled" outcome means RESERVED, not enqueued, so
a failed queue handoff must release the reservation via `ledger.remove`
(durable lifecycle: #736 — the release is DURABLE, so the redelivery re-mints
instead of waiting out the claim horizon).

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
| Forgejo jobs are indistinguishable from GitHub jobs after normalization, except explicit capability metadata | `normalizeForgejoEvent` (#728) produces the same `CanonicalForgeEvent` → same `deriveGenerationId` identity; the only forge-specific surface is `capabilities.ts`; the `check_update` family is shape-anchored in BOTH layers — the #728 normalizer requires the signed check/status shape (`carriesCheckUpdateShape`) and the Forgejo projection gates the family header on the same predicate (#1102), so GitHub keeps accepting every real shape while a header alone can never mint a generation | `tests-v3/ingress-dispatch.test.ts` (webhook/poll convergence, re-keying), `tests-v3/ingress-webhook.test.ts` (canonical fields + forged check/status headers), `tests-v3/ingress-forgejo-events.test.ts` (family shape gate), `tests-v3/jobs.test.ts`, `tests-v3/events.test.ts` (identity parity, shape gate, genuine Forgejo status shape) |
| existing v3 Forgejo behavior remains the source of reviewer semantics | unchanged `src/platform/publish-api.ts` (`ForgejoPublishApi`); `capabilities.ts` only describes degradation | `tests-v3/publish-api.test.ts` (GraphQL degradation precedent) |

## Out of scope (follow-on issues)

Queue durability (#731/#736), the credential broker (#735 — integration
`credential` fields stay opaque references), a durable generation ledger,
GitHub App ingress (#729), and executor/worker lifecycle (#733).