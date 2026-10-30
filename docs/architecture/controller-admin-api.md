# Controller admin API (#737)

Design of `src/admin/`: the HTTP control-plane surface the self-hosted
controller daemon needs to be **operable without a UI**. Like the
event/job (#728), queue (#731), acquisition (#732), executor (#733),
credential (#735), and durable-state (#736) layers before it, this is
**a library for the future controller daemon — it is not wired into the
running action pipeline**. The daemon composition (#1348) supplies every
piece of state and every effect through the injected
`ControllerAdminDeps` seam; this library owns none of the state itself.

## Listener separation (normative)

Webhook routes are owned by the forge adapters
(`src/ingress/webhook-handler.ts`, `src/ingress/github-webhook-handler.ts`)
and stay on their **own public listener**. `createAdminHost`
(`src/admin/server.ts`) serves ONLY:

- `GET /healthz` — liveness: a fixed `{"status":"ok"}` body, no component
  probes, no configuration echo. Exposing it leaks nothing.
- `GET /readyz` — readiness: the injected `readiness()` components
  projected onto **synthetic fields only** (`{ name, ok, degraded }`);
  `200` when every component is ok and not degraded, `503` otherwise, with
  the failing components named. The seam's free-form `detail` string is
  never part of this projection — a readiness seam may populate it with a
  DSN, endpoint, or exception text, and this route is unauthenticated.
  Component names are echoed only when they are **plain identifiers**
  (`[A-Za-z0-9._-]`, at most 64 characters); any other name — a DSN, a
  URL, free text, one carrying control/format/bidi characters — is refused
  as `unknown`. That structural rule, not the redactor, is what keeps
  free-form seam text off the unauthenticated surface. Readiness is
  decided over **every** component the seam reports; only the exposed list
  is capped (64), and failing components are listed FIRST, so the cap
  cannot hide the component that made the endpoint answer `503`. Flags
  fail closed — a malformed flag (`"yes"`, `1`) is treated as unhealthy —
  but an ABSENT `degraded` flag (`null`/`undefined`, what a JSON-sourced
  seam yields for an unset boolean) is absent, not a failure, so a
  healthy component is never pulled out of rotation by its own silence
  (an absent `ok` still fails closed). During control-plane store, forge,
  or executor degradation the endpoint answers `503` — a load balancer
  sees THAT a component is degraded, and its name only when the seam's
  name is a plain identifier. The operator's "why", including the names
  the public route refuses, lives on the authenticated `/admin/status`
  route.
- `GET /metrics` — Prometheus text exposition (below).
- `GET /admin/*` — the authenticated admin namespace.

A deployment must not mount the webhook handler behind this router and
must not expose admin routes on the public webhook listener. Process
topology cannot be enforced by the library; the boundary is normative
here and guarded by tests proving the webhook handler's behavior is
independent of admin authentication configuration.

## Authentication

- Every `/admin/*` route — reads AND mutations — requires
  `Authorization: Bearer <token>`. The token is compared in constant
  time (`timingSafeEqual` over SHA-256 digests of both sides, so token
  length never leaks).
- **Fail closed:** a host constructed without a token refuses every
  admin request with a fixed `503` — an unconfigured admin surface is
  unavailable, never open. An empty or whitespace-only token is a
  construction error.
- `/healthz`, `/readyz`, and `/metrics` deliberately require no auth:
  they expose only synthetic or bounded-aggregate data (see metrics) —
  component identifiers and flags, never free-form configuration, secrets,
  or run content. The readiness seam's free-form `detail` is excluded from
  the public projection entirely.
- Authorization *beyond* the bearer token (who may cancel what) is
  delegated to the injected mutation seams; the admin layer enforces
  authentication, request shape, and bounds only. No request field is
  trusted merely because it arrived authenticated.

## Routes

| Route | Method | Effect |
|---|---|---|
| `/healthz` | GET | liveness (fixed body) |
| `/readyz` | GET | component readiness, 503 on degradation |
| `/metrics` | GET | Prometheus text, `text/plain; version=0.0.4` |
| `/admin/status` | GET | adoption entries + queue/executor status + bounded readiness detail |
| `/admin/runs` | GET | paged run list (`?limit=` 1–200 default 50, `?cursor=`) |
| `/admin/runs/{runId}` | GET | run detail: lifecycle, publication summary, per-role usage aggregates |
| `/admin/runs/{runId}/cancel` | POST | cancel a non-terminal run |
| `/admin/rereview` | POST | force rereview: body `{"prKey": ..., "reason": ...}` |
| `/admin/diagnostics` | GET | redacted configuration diagnostics |

Mutations require `Content-Type: application/json` and accept at most
`maxBodyBytes` (default 8 KiB); oversized bodies get a fixed `413`.
Unknown paths/methods get fixed `404`s. Error bodies are fixed JSON that
never echo request content.

### Force rereview and cancel semantics

- **Force rereview creates an intentional NEW generation.** Supersession
  is the #731 queue's existing semantics; the daemon seam owns it. The
  admin layer validates the `prKey` shape (fail closed), audits, and
  reports the new `jobId` (`202`). A refused effect is `409`.
- **Cancel only targets a live run:** unknown run → `404`, terminal run
  → `409` (also the idempotent second-cancel outcome), active run →
  `202`. The effect seam may still refuse; refusals are `409` too.
- **Auditability:** every mutation attempt that carries a validated target
  settles first, then records `{ atMs, requestId, action, target, outcome }`
  through the injected `audit` sink. `target` is `{ kind: "run" | "pr",
  id }`, where `id` is the validated, bounded identifier of the mutated run
  or PR — the sink can tell WHICH run was cancelled or WHICH PR was
  rereviewed without an external log. `outcome` is `accepted` (the effect
  happened), `refused` (the seam or the admin layer declined — unknown
  run, terminal run, or a refused effect), or `error` (an effect or
  lookup seam threw). `atMs` is stamped when the audit record is written,
  i.e. after the effect settled, through an injectable clock (`Date.now`
  by default; a clock that throws or returns a non-finite, negative, or
  unsafe value falls back to `Date.now`, so a broken clock can never
  record a false timestamp or break the mutation path), so the sink never
  has to reconstruct when the mutation settled. Audit-sink failure never
  fails the HTTP response (the operator action already happened) but is
  never swallowed silently — it bumps
  `pr_reviewer_admin_audit_failures_total`. This is a deliberate
  tradeoff: auditing after settlement keeps the audit record truthful
  about what actually happened.

## Readiness exposure (two projections, one seam)

`readiness()` returns the seam's own component view (`{ name, ok,
degraded?, detail? }`). Two routes project it, with different exposure:

| Route | Projection | `detail` |
|---|---|---|
| `/readyz` (public) | `{ name, ok, degraded }` — the name only when it is a plain identifier, otherwise `unknown` | dropped entirely |
| `/admin/status` (bearer) | `{ name, ok, degraded, detail? }` — the sanitized name the public route refuses | bounded to 512 chars, secret-redacted |

The public projection is synthetic **by construction** — the admin layer
builds it field by field instead of forwarding the seam's objects, and a
component name is echoed only when it is a plain identifier. The
identifier rule is PUBLIC-ONLY: the authenticated route keeps the
loosely sanitized name (`control-plane store`, a redacted DSN) because
the operator needs it, and that route is bearer-protected. The
authenticated projection also keeps the operator's "why" while still
refusing to become a credential channel: the same redaction pass the
diagnostics route uses applies to `detail` (see below), and the failing
components are listed first there too.

## Metrics (bounded cardinality, by construction)

`AdminMetricsRegistry` (`src/admin/metrics.ts`) renders Prometheus text
with metric names and label names declared by the registry. Cardinality
cannot grow unbounded from real-world identifiers because:

- label VALUES enter only through fixed enums (lifecycle states,
  `UsageRole`s, verdicts `approve`/`request_changes`, failure
  categories, tool-loop stop reasons, publication/webhook outcomes,
  cost provenance) or through capped allowlists (model routes,
  executor identities — default cap 16, overflow collapses to
  `other`);
- a hard series cap (default 512) rejects further distinct series; every
  rejected update bumps
  `pr_reviewer_admin_metrics_overflow_total` instead. The two fixed
  zero-label counters (`pr_reviewer_admin_metrics_overflow_total`,
  `pr_reviewer_admin_audit_failures_total`) are pre-created in the
  constructor, so the audit-failure counter stays recordable even when
  the cap is already full — the overflow counter's own update can never
  recurse into the cap-rejection branch. (A cap of 1 can hold only the
  overflow counter, so the audit pre-create is skipped there.)

There is deliberately **no** setter that accepts a PR number, head SHA,
commit message, prompt/model text, or file path as a label. The
derivation helpers cover the issue's observability list: queue
depth/age gauges, active workers by executor identity, review latency
histograms, verdict/failure counters, model request counts, token/cache
totals by role (cost provenance stays truthful — the same
never-fabricated invariant as #736 lives in the usage records the daemon
feeds in), tool-loop stop reasons, specialist usage, publication
retry/failure, webhook verification outcomes, and
cancellation/supersession counters.

## Diagnostics redaction (defense in depth)

The daemon feeds `/admin/diagnostics` values it already redacted, and
the admin layer applies its OWN pass anyway: keys whose names look
credential-shaped are dropped, and every surviving string
value is passed through the shared redactor. Both key vocabularies are
DERIVED from the canonical `SECRET_KEY_ALTERNATION` constant
(`src/context/redact.ts`, #1170) — the same single source of truth behind
every key-name rule in the repository (`api_key`, `token`, `password`,
`secret`, `access_key`, `auth_token`, `private_key`, `client_key`) — plus
admin-only names the canonical list does not carry (`passwd`, `pwd`,
`credential`, `authorization`), so a canonical credential key cannot go
unredacted here when it is added there. The key-drop test is unanchored
and case-insensitive (`token` alone covers `access_token`,
`refresh_token`, `auth_token` spellings):

- **credential shapes** — provider key prefixes (`sk-…`, `ghp_…`/`gho_…`/
  `ghu_…`/`ghs_…`/`ghr_…`, `github_pat_…`, `glpat-…`, `xox*…`, `AKIA…`,
  `AIza…`), `Bearer …`/`Basic …` authorization values, and JWTs;
- **credential assignments** — `key=value` and `key: value` forms whose
  key names a credential from the derived vocabulary above, with quoted or
  unquoted values. This is what protects the free-form readiness `detail`,
  where there is no key structure to drop on;
- **URL userinfo** — `scheme://user:pass@host` becomes
  `scheme://[REDACTED]@host`. The credential part may contain `/` (base64)
  and the host may contain `@`, so the match runs to the last `@` of the
  token.

Entries are bounded (128 keys, 2048-char values); readiness components
are bounded (64 names of 64 chars, details of 512 chars). Every
seam-supplied string is truncated BEFORE the patterns run, so a hostile
seam cannot make the redactor work on an unbounded string. Nothing in the
surface reads repository files.

This redaction is **defense in depth, not a secret oracle**: pattern
matching cannot recognize every credential encoding, and a token glued to
a preceding letter or digit (e.g. `xsk-…`) is not matched, deliberately —
without that guard an ordinary word containing `sk-` (`task-runner`,
`risk-management`) would be mangled. The structural guarantee, not the
pattern, is what makes the boundary sound: the unauthenticated routes
carry no free-form seam text at all, and the authenticated routes are
bearer-protected. The daemon must still not feed secrets into a seam.

## Testing posture

`tests-v3/admin-auth.test.ts`, `tests-v3/admin-metrics.test.ts`,
`tests-v3/admin-routes.test.ts`, `tests-v3/admin-server.test.ts` run
always (pure dispatch + real `http.createServer` on an ephemeral port):
auth on every admin route (reads and mutations), unconfigured-token
503s, webhook-handler independence, degraded-readiness 503 semantics,
the public readiness projection (a hostile `detail` never leaves the
unauthenticated route, a credential-shaped component NAME is redacted, and
a DSN-shaped name is refused as `unknown` — over the wire as well as in
dispatch), the bounded component list with failing components listed
first and readiness still decided over every component, fail-closed
readiness flags with an absent flag treated as absent, bounded work on a
hostile readiness seam, the bounded/redacted readiness detail on the
authenticated route (including quoted and keyed credential assignments),
metrics cardinality sanity and parseable exposition, diagnostics
redaction, rereview/cancel effect + audit ordering and refusal codes,
audit target identity and settlement timestamp on both mutation paths
(including refused, failed-lookup, and error outcomes), a broken audit
clock, body cap, and fixed 404s.

## Out of scope

Wiring the host into the daemon loop (#1348 owns the composition), the
deployment/qualification gates (#738/#739), persistent audit storage
(the `audit` seam is the boundary), and any UI.
