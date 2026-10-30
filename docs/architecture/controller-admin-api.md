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
  (`{ name, ok, degraded?, detail? }`); `200` when every component is ok
  and not degraded, `503` otherwise, with the failing components named.
  During control-plane store, forge, or executor degradation the endpoint
  answers `503` — a load balancer or the operator can see WHY.
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
  they expose only synthetic or bounded-aggregate data (see metrics),
  never configuration, secrets, or run content.
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
| `/admin/status` | GET | adoption entries + queue/executor status |
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
- **Auditability:** every mutation settles first, then records
  `{ atMs, requestId, action, target, outcome }` through the injected
  `audit` sink. Audit-sink failure never fails the HTTP response (the
  operator action already happened) but is never swallowed silently — it
  bumps `pr_reviewer_admin_audit_failures_total`. This is a deliberate
  tradeoff: auditing after settlement keeps the audit record truthful
  about what actually happened.

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
  `pr_reviewer_admin_metrics_overflow_total` instead.

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
credential-shaped (`token`, `secret`, `password`, `credential`,
`api_key`, `private_key`, `auth`) are dropped, credential-shaped string
values (`sk-…`, `ghp_…`, `AKIA…`, bearer strings) are replaced, and URLs
with embedded userinfo are redacted. Entries are bounded (128 keys,
2048-char values). No admin route returns secret material; nothing in
the surface reads repository files.

## Testing posture

`tests-v3/admin-auth.test.ts`, `tests-v3/admin-metrics.test.ts`,
`tests-v3/admin-routes.test.ts`, `tests-v3/admin-server.test.ts` run
always (pure dispatch + real `http.createServer` on an ephemeral port):
auth on every admin route (reads and mutations), unconfigured-token
503s, webhook-handler independence, degraded-readiness 503 semantics,
metrics cardinality sanity and parseable exposition, diagnostics
redaction, rereview/cancel effect + audit ordering and refusal codes,
body cap, and fixed 404s.

## Out of scope

Wiring the host into the daemon loop (#1348 owns the composition), the
deployment/qualification gates (#738/#739), persistent audit storage
(the `audit` seam is the boundary), and any UI.
