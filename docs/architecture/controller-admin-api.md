# Controller admin API (#737)

Design of `src/admin/`: the HTTP control-plane surface the self-hosted
controller daemon needs to be **operable without a UI**. Like the
event/job (#728), queue (#731), acquisition (#732), executor (#733),
credential (#735), and durable-state (#736) layers before it, it is
consumed live by the controller daemon (#1348): `src/controller/main.ts`
serves `createAdminHost` on a dedicated admin listener. The daemon
composition supplies every piece of state and every effect through the
injected `ControllerAdminDeps` seam; this library owns none of the state
itself.

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
  URL, free text, one longer than the limit, or one carrying control/format/bidi
  characters — is refused as `unknown`, never truncated into a different
  name. That structural rule, not the redactor, is what keeps
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
- Optionally (`AdminHostOptions.dashboard`), `GET /dashboard` and
  `GET /dashboard/app.js` — the #742 static operations shell, served from
  compile-time constants OUTSIDE the `/admin/` namespace; the shell carries
  no dynamic data and every data route stays bearer-protected
  ([operations-dashboard.md](operations-dashboard.md)).

A deployment must not mount the webhook handler behind this router and
must not expose admin routes on the public webhook listener. Process
topology cannot be enforced by the library; the boundary is normative
here and guarded by tests proving the webhook handler's behavior is
independent of admin authentication configuration.

## Authentication

- Every `/admin/*` route — reads AND mutations — requires a valid bearer token OR a valid OIDC session. Bearer tokens are compared in constant
  time (`timingSafeEqual` over SHA-256 digests of both sides, so token
  length never leaks).
- **Fail closed:** a host without either bearer auth or OIDC sessions refuses every admin request with a fixed `503`; an unconfigured surface is unavailable, never open. Empty configured tokens are refused.
- Cookie-authenticated POST requests require a matching `X-CSRF-Token` header and return `403` when absent or invalid. Bearer-authenticated POST behavior does not change.
- `/healthz`, `/readyz`, and `/metrics` deliberately require no auth:
  they expose only synthetic or bounded-aggregate data (see metrics) —
  component identifiers and flags, never free-form configuration, secrets,
  or run content. The readiness seam's free-form `detail` is excluded from
  the public projection entirely.
- Authorization *beyond* the bearer token (who may cancel what) is
  delegated to the injected mutation seams; the admin layer enforces
  authentication, request shape, and bounds only. No request field is
  trusted merely because it arrived authenticated.

## Browser authentication endpoints and environment

`GET /auth/config` exposes only the selected mode. OIDC mode additionally serves `GET /auth/login`, `GET /auth/callback`, `GET /auth/session`, and `POST /auth/logout`. Login uses Authorization Code + PKCE; sessions are opaque, in-memory, fixed-expiry, and cookie-backed. Cookie attributes are HttpOnly, Path=/, SameSite=Lax, and Secure for an HTTPS redirect base. `/auth/session` returns identity plus a CSRF token only for a valid session; logout clears both cookies and destroys the session. Missing or invalid provider metadata, signatures, claims, or allowlist matches fail closed.

Authorization policy facts an operator relies on:

- The subject, email, and group lists combine as OR: a claim that satisfies any configured list authorizes the session. Keep each list as tight as the policy needs.
- An email list entry matches only when the provider attests `email_verified: true`; a bare `email` claim is self-asserted and never authorizes on its own. The same rule governs the displayed identity: the session stores and `/auth/session` returns the email only when attested, so with an unverified or absent claim the dashboard shows the signed subject instead. The group list trusts the provider's `groups` claim, so use it only with a provider whose group membership is operator-controlled.
- Issuer comparison tolerates a trailing-slash difference on either side; configure the issuer exactly as the provider publishes it.
- ID tokens must be RS256 signed by a key from the provider's JWKS; the key set is cached for at most 15 minutes. `iss`, `aud`, `azp` (when present), `exp`, `iat`, and the login `nonce` are all validated.

`PR_REVIEWER_ADMIN_AUTH_MODE` is `token` by default or `oidc`. Token mode requires `PR_REVIEWER_ADMIN_TOKEN`. OIDC requires `PR_REVIEWER_ADMIN_OIDC_ISSUER`, `PR_REVIEWER_ADMIN_OIDC_CLIENT_ID`, `PR_REVIEWER_ADMIN_OIDC_CLIENT_SECRET`, `PR_REVIEWER_ADMIN_OIDC_REDIRECT_BASE`, and at least one of `PR_REVIEWER_ADMIN_OIDC_ALLOWED_SUBJECTS`, `PR_REVIEWER_ADMIN_OIDC_ALLOWED_EMAILS`, or `PR_REVIEWER_ADMIN_OIDC_ALLOWED_GROUPS`. `PR_REVIEWER_ADMIN_OIDC_SESSION_TTL_MS` defaults to 28800000 and accepts 300000–86400000. The token is optional in OIDC mode and continues to support automation and break-glass.

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

When configured (`AdminHostOptions.dashboard`), the optional #742
dashboard shell mounts at `/dashboard` on the same listener, stays
outside the `/admin/` namespace, and serves a static shell only — every
data route stays bearer-protected (see
[operations-dashboard.md](operations-dashboard.md)).

### Force rereview and cancel semantics

- **Force rereview creates an intentional NEW generation.** Supersession
  is the #731 queue's existing semantics; the daemon seam owns it. The
  admin layer validates the `prKey` shape (fail closed), audits, and
  reports the new `jobId` (`202`). A refused effect is `409`.
- **Cancel only targets a live run:** unknown run → `404`, terminal run
  → `409` (also the idempotent second-cancel outcome), an active run →
  `200 { "cancelled": true }`. The effect seam applied the cancellation
  before the route answered (the queue stamped the generation and aborted
  its attempt), so the route ACKNOWLEDGES the cancellation instead of
  promising it; the durable run settles `cancelled` when the attempt
  observes the abort. The effect seam may still refuse; refusals are `409` too.
  If a newer head had already stamped the live generation (supersession
  requested its abort but it had not settled yet), the operator's click
  CONVERTS the record to the operator attribution — clearing the pending
  superseder — so the acknowledgement and the durable settlement always
  agree: the generation ends `cancelled` / `cancelled-by-operator`, never
  supersession-shaped. The newer generation still runs; the conversion
  only says why THIS generation ended.
- **`200 { "cancelled": true }` is the ONLY answer that promises an
  operator-cancelled run** (#1772). Every settle path behind it ends
  `cancelled-by-operator`: a queued generation settles at once, an
  attempt settles when it observes the abort, and a generation whose
  publication FAILED and awaits its retry never publishes again.
- **A publication that was already ATTEMPTED answers `202`, not the
  applied-cancellation `200`.** The publication's outcome is not
  determined here: the forge side effect may already have landed and it
  cannot be undone, so the terminal state belongs to the publication,
  not to the operator's click. The cancellation is REGISTERED (a
  publication that fails still settles `cancelled-by-operator`, and no
  retry publishes the review), but the run may still end `completed`
  with the review published. The route answers `202 { "status":
  "cancellation-registered", "cancelled": false, "detail": "<reason>"
  }` — the request was accepted, its effect is not determined. The
  dashboard reports the same outcome instead of "Cancellation accepted."
  The attempt marker is DURABLE: the queue records that the publication
  attempt was fired BEFORE the forge write, so a crash between the write
  and its outcome leaves the same "undetermined" reading for the next
  process — a publication that never happened is never reported as
  cancelled.
- **Contract change (#1781), disclosed for out-of-repo consumers:** releases
  through v3.10.0 answered `202` on `POST /admin/runs/{runId}/cancel`; this
  surface now answers `200` with the same `{ "cancelled": true }` body.
  A consumer that checks `res.ok` (the shipped dashboard does) is
  unaffected; one that requires exactly `202` must accept `200`. No other
  route's status codes changed. A consumer that reads the body must
  distinguish the three cancel answers: `200 { "cancelled": true }` (the
  cancellation is applied), `202 { "status": "cancellation-registered",
  "cancelled": false }` (registered, the publication's outcome is not
  determined), and `409 { "error": "cancellation refused" }` (not
  applied). Only the first promises a run that settles `cancelled`.

| Mutation | Request body | Accepted | Refused |
|---|---|---|---|
| `POST /admin/rereview` | `{"prKey": "owner/repo#123", "reason": "<one line>"}` | `202 {"jobId": "<generation id>"}` | `400` invalid request, `409` refused effect |
| `POST /admin/runs/{runId}/cancel` | `{}` | `200 {"cancelled": true}` (applied), `202 {"status": "cancellation-registered", "cancelled": false, "detail": "<reason>"}` (publication attempted) | `404` unknown run, `409` terminal run, `409` refused effect |

- **The PR key names ONE pull request.** The controller's grammar is
  `owner/repo#123`: an owner and a repository of `[A-Za-z0-9._-]`, a `#`,
  and a POSITIVE decimal number with no leading zero. A dot-only segment
  (`.` or `..`) is no repository identity: the parsed owner/repository pass
  the platform's ONE repository-reference validator (`parseRepoRef`, which
  refuses exactly those segments), so a traversal-shaped key like
  `../..#7` is refused AT THE SHAPE GATE with the grammar as its reason —
  never a forge read that surfaces the opaque "could not be read". The
  admin layer's own shape gate is the wider, trimmed identifier vocabulary
  (`[A-Za-z0-9._/@#:-]`, at most 512 characters) and refuses anything
  else with a `400`; the controller's stricter parse refuses the rest as
  a `409` with its reason. A key that could name several pull requests is
  never resolved by guessing. The dashboard's client-side pattern carries
  the same rules (the same charset, the same dot-segment refusal, the same
  digit cap) so the form refuses what the controller refuses without a
  round trip.
- **The parsed repository identity carries the intake's canonical case.**
  The controller lowercases the owner/repository the same way the intake's
  forge normalizer does (`normalizeRepoFullName`), so a mixed-case key
  names the same repository a webhook event would. The adoption record, the
  allow/denylist match, and the generation identity all key on this
  canonical form, so the operator's spelling can never miss the adoption
  gate or mint a generation whose identity diverges from the intake's.
- **Every refusal names itself.** No mutation answers with a bare
  status: the body carries `detail` — the reason the effect seam gave,
  or the admin layer's own fixed reason for an unknown run, a terminal
  run, or a malformed request. The error field stays the stable class
  name (`request refused`, `cancellation refused`, `run is terminal`,
  `run not found`, `invalid request`), and `detail` is the "why".
- **A seam reason is free text, so it passes ONE bounded projection.**
  The input is capped (1 KiB) BEFORE any pattern runs, the
  control/format/bidi characters are replaced (never rendered), the
  whitespace collapses, the credential shapes are redacted through the
  shared `redactSecretShapes` pass, and the RESULT is capped (200
  characters). A blank or unusable reason falls back to a fixed phrase,
  so the operator never gets an empty "why" and the response never
  carries an unbounded or credential-shaped string.
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
  about what actually happened. Every attempted outcome writes exactly
  ONE row — accepted, refused, or error — and the row is written after
  the effect settled, never before.
- **The operator's WHY rides the row.** The rereview's `reason` is a
  required, validated input, so the row carries it: `reason` is present
  on every rereview row (accepted, refused, and error) and ABSENT on
  every cancel row — the cancel request carries no reason, and the field
  is omitted rather than written as an empty value, so a row's shape
  stays byte-compatible. The reason is operator free text on its way to a
  durable ledger, so it passes the same redaction every other outbound
  string passes (a credential shape is never written down) and keeps the
  request's own bounds (trimmed, one line, at most 256 characters, capped
  again after the redaction can lengthen it). It is never echoed into an
  HTTP response body: the response carries the EFFECT's refusal reason,
  not the operator's text.

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
feeds in), tool-loop budget counters — request and round counters
(`pr_reviewer_admin_tool_loop_requests_total`,
`pr_reviewer_admin_tool_loop_rounds_total`, zero-label amounts fed from the
loop telemetry) plus the stop-reason counter —, specialist usage, publication
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
the refusal reason reaching the operator (the seam's reason verbatim,
the `400` naming the offending field, and a hostile or oversized reason
bounded and redacted), audit target identity and settlement timestamp on
both mutation paths (including refused, failed-lookup, and error
outcomes), a broken audit clock, body cap, and fixed 404s. The daemon's
own composition (`tests-v3/controller-main.test.ts`) pins the two
mutations end to end and the key grammar: the canonical-case identity for
a mixed-case operator key, and the shape gate refusing a traversal-shaped
key (`../..#7`, `owner/..#7`) with the grammar as its reason before any
forge read.

## Out of scope

Wiring the host into the daemon loop (#1348 owns the composition), the
deployment/qualification gates (#738/#739), persistent audit storage
(the `audit` seam is the boundary), and any UI.
