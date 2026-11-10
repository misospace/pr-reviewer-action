# Operator onboarding and diagnostics surface (#1028)

Design decision for the operator-adoption epic (#1028): where the
preflight/doctor diagnostics live, what each check proves, and how the epic
decomposes into independently shippable children. The grooming pass of
2026-11-10 found the issue's blocked premise stale (#738 landed the OCI
images and the chart, PR #1435; the #739 harness program's first scenario
family landed with #1482) and reduced the remaining design work to this
decision; the implementation is the children listed at the end.

Everything here builds on landed contracts and creates no new one: the
#1348 daemon composition (`src/controller/`), the #737 admin API
(`src/admin/`, [controller-admin-api.md](controller-admin-api.md)), the #727
instance config and adoption policy
([operator-config-and-adoption.md](operator-config-and-adoption.md)), the
#735 credential broker, and the chart + images under `deploy/`
([Self-hosted deployment](../self-hosted-deployment.md)).

## Decision: preflight is a server-side route; the CLI is only its client

**The doctor runs inside the running controller and is served as
`GET /admin/preflight` on the bearer-guarded #737 admin listener. The
`controller doctor` CLI subcommand is a thin HTTP client of that route —
it loads no operator configuration of its own.**

The running daemon is the only effective-config authority the deployment
has. It holds the parsed instance config (#727), the loaded webhook secret
(`PR_REVIEWER_WEBHOOK_SECRET`, `src/controller/main.ts:395`), the forge
capability with the App key or Forgejo token, the #735 credential
projections, the migration state of the #736 store, and the latched
persistence/intake state its readiness seam already reports. A doctor that
re-assembles that picture anywhere else cannot answer the question the
operator is actually asking — *what will THIS daemon do* — because:

- A standalone script or an in-cluster second process re-reads values files
  and environment and becomes a **second mutable config authority**, the
  exact failure the issue forbids. The env contract is fail-closed and
  locked against drift by `tests-v3/deploy-packaging.test.ts`; re-parsing
  it in a second implementation would need the same lock twice.
- The controller's environment is a **startup snapshot** (documented in
  [Self-hosted deployment](../self-hosted-deployment.md): rotated Secrets
  require a controller restart). A separate process started later sees
  different credential material than the daemon actually uses, so it can
  report healthy while the daemon fails — the "silently appearing healthy"
  outcome the issue calls out.
- State that matters is process state: the latched queue persistence
  error, the intake-stopped flag, recovery/lease state, adoption records.
  Today the daemon already projects these to
  `/admin/diagnostics` (`src/controller/main.ts:656-664` — passive config
  and latch dump) and `/admin/status` (adoption entries, queue depth,
  readiness detail). What is missing is the **active** half: probes that
  exercise the capabilities, not just describe them.

Rejected alternatives:

- **Standalone script** (`scripts/doctor.mjs` parsing operator values):
  second config authority (above); also cannot see process state, and the
  repo has no dependency surface for a second YAML consumer of the chart's
  values.
- **In-cluster CLI re-reading the same env**: still a second loader of the
  same authority; the snapshot problem above; and it double-loads the
  instance config that startup validation already refused to start on.
- **Doctor as an operator-MCP tool**: the #1349 v1 tool table is read-only
  over durable state by construction and its auth model is scoped,
  per-call, per-repository capability — the doctor runs live network probes
  (token mints, model endpoint calls) that fit neither. If a probe later
  maps to a durable read, it can join the tool table through a contract
  change, not through this surface.

## The `GET /admin/preflight` route

Same listener, same bearer token, same redaction posture as
`/admin/diagnostics` (`src/admin/routes.ts:211` — the derived
`SECRET_KEY_ALTERNATION` key-drop plus the shared `redactSecretShapes`
pass). It is **GET**: the doctor never mutates control-plane state, never
enqueues, cancels, or writes a record. Probes use capabilities only the way
review processing itself would (reads and token mints, never forge writes).

The response is `200` with a structured verdict — the doctor's job is to
REPORT a failing deployment, so the failing state must not be confused with
the route being unavailable (`503` keeps its existing meaning: admin
surface unconfigured/unauthorized):

```json
{
  "overall": "failing",
  "checks": [
    { "id": "control-plane.store", "ok": true },
    { "id": "webhook.intake", "ok": false,
      "reason": "PR_REVIEWER_WEBHOOK_SECRET is empty; the GitHub App intake refuses every delivery" },
    { "id": "model-profile.primary", "ok": false,
      "reason": "endpoint https://[REDACTED] refused the probe: 401 (credential reference 'primary' resolved but rejected)" }
  ]
}
```

- `checks[].id` is `family.profile-or-executor-name` — fixed families, the
  operator's own profile names as the suffix.
- `reason` is bounded (512 chars, the readiness-detail rule), carries
  **key names and outcomes, never values**: it names the env var, the
  credential reference, the profile name, the HTTP status — not the secret,
  not the URL's userinfo, not a token. The admin layer's redaction pass
  runs on the response anyway (defense in depth, same as diagnostics).
- Each probe has a hard timeout (default 5s, one shared bound per route
  call); a timed-out probe reports `ok: false` with a timeout reason, never
  hangs the admin listener.
- The CLI turns `overall` into its exit code (`0` healthy, `1` degraded,
  `2` failing) and prints the checks; the route itself always answers `200`
  when served.

### The check families (the issue's six diagnoses)

| family | proves | how (existing seam only) | redaction / fail mode |
|---|---|---|---|
| `control-plane.store` | PostgreSQL reachable, #736 migrations current, no latched persistence failure | the daemon's own migration hook state and `queuePersistenceError()` latch — no new probe | reason names the state ("migrations pending", "persistence error latched"), never the DSN |
| `webhook.intake` | the intake is configured and would VERIFY a delivery: port bound, secret present, platform handler self-test passes | sign a synthetic delivery with the loaded secret and run it through the bound intake handler's verification path (GitHub `X-Hub-Signature-256` / Forgejo `X-Gitea-Signature`); never opens a socket | the self-test proves the SECRET and verifier, not network reachability — the reason must say so; see the reachability limit below |
| `forge.authorization` | the forge credential works and is authorized: GitHub App key parses and an installation token mints for the declared installation; Forgejo token authenticates | one read-shaped call through the bound platform capability (`src/platform/`) — the same mint/read a review's first forge call would do; no forge write | result is ok/fail + bounded reason ("token rejected: 401"); the minted token is used in-memory and never rendered anywhere |
| `model-profile.<name>` | each named #727 model profile is reachable and its credential reference resolves and authenticates | one bounded probe request through the typed transport (`src/transport/`) with the profile's resolved #735 material (the controller already holds the projections it hands executors); wire format as configured | reason carries HTTP status / connect error class and the profile name; the credential never appears in any field; a profile without a `model` id fails with the composition-refusal reason (#1496) instead of probing |
| `executor.<name>` | each executor profile can actually launch: `local` — runs root writable, git present; `kubernetes` — API authenticates and the worker namespace admits Job+Secret creation (dry-run-shaped check through the existing #734 client); `oci` — reports unavailable, no implementation ships | reuse the profile→Executor selector's construction path (`src/controller/execution.ts`) | reason names the failing precondition ("runs root not writable", "forbidden on batch/jobs create"); an unconstructible profile fails, never silently degrades |
| `adoption` | which repositories are adopted and enabled under the CURRENT #727 policy | the daemon's own adoption records + policy re-gate (the same resolution the intake runs) | the route accepts an optional `?expect=owner/name` (repeatable) and reports each expectation as `adopted` / `denylisted` / `disabled` / `missing` — the expectation is a per-call CLI argument, never stored config |

The webhook reachability limit, stated once and honored everywhere: **no
in-process check can prove that the forge can reach the ingress through
TLS.** The route proves the listener is bound and a signed delivery
verifies; the outside-in proof is the operator's test delivery and the
first-review smoke (child 5). The check's `reason` on success says exactly
what was proven ("secret present; a signed self-test verifies; reachability
is proven by a test delivery, not by this check") — fail clearly, claim
nothing silently.

### What the doctor deliberately does not do

- No second config surface: no doctor-specific config file, no values-file
  parsing, no stored expectations. The CLI's only inputs are the admin base
  URL and the bearer token.
- No credential in argv: the CLI reads the token from
  `PR_REVIEWER_ADMIN_TOKEN` (the daemon's existing env name) only; the URL
  may be `--url` or `PR_REVIEWER_ADMIN_URL` because a URL is not a
  credential. This is the AGENTS.md normative rule applied to the new
  surface.
- No new durable state, no DB beyond #736, no UI, no metrics Cardinality
  additions (the route adds zero new series; if a counter is ever wanted,
  it is zero-label like `pr_reviewer_admin_audit_failures_total`).

## Decomposition into shippable children

Each child is independently shippable to `main`, carries its own tests, and
reuses the landed contracts — no new test framework, no new config surface.
The doctor route (child 3) unblocks the CLI (4) and makes the smoke runbook
(5) concrete; the doc children (1, 2, 6) have no code dependencies.

| # | child | imperative ask | paths | notes |
|---|---|---|---|---|
| 1 | Quickstart | Write the canonical first-review quickstart for a fresh generic Kubernetes cluster using the released GHCR images (`ghcr.io/misospace/pr-reviewer-controller@sha256:…` + worker, digest-pinned per `deploy/images/README.md`) and `deploy/charts/pr-reviewer/`, plus a non-Kubernetes local path (plain `node dist/index.js controller` + PostgreSQL container + `local` executor); link it from the README | `docs/quickstart.md`, `README.md`, `docs/self-hosted-deployment.md` (cross-link) | extends, never replaces, the deployment runbook; no maintainer-private files, no home-ops references |
| 2 | Minimal config guide | Document the minimal working configuration: GitHub App creation + the exact requested permissions, webhook URL/TLS, secret injection via `existingSecret`, one model profile, one adopted repository, allow/deny policy and per-repo opt-out keys per the #727 contract; give the parallel Forgejo path | `docs/operator-setup.md`, `deploy/charts/pr-reviewer/examples/README.md` | permission table = the read/ mint/write set the ingress and publication contracts already require; nothing new to grant |
| 3 | Preflight route | Implement `GET /admin/preflight` with the six check families, bounded reasons, per-probe timeout, and the redaction pass; feed it from the daemon composition | `src/admin/types.ts`, `src/admin/routes.ts`, `src/controller/main.ts`, `src/controller/daemon.ts`, `tests-v3/admin-routes.test.ts`, `tests-v3/controller-main.test.ts`, `docs/architecture/controller-admin-api.md` | the route table (`ADMIN_ROUTE_TABLE`) and the admin docs grow together; probes run through existing capabilities only |
| 4 | Doctor CLI | Implement the `controller doctor` subcommand as a thin authenticated client of `/admin/preflight` (token from `PR_REVIEWER_ADMIN_TOKEN`, URL from `--url`/`PR_REVIEWER_ADMIN_URL`), printing checks and mapping `overall` to exit codes | `src/index.ts`, `src/controller/doctor-cli.ts` (new), `tests-v3/controller-doctor-cli.test.ts` (new), `docs/self-hosted-deployment.md`, `docs/troubleshooting.md` | no config loading, no probe logic — the client must stay thin enough that its only tests are HTTP-mapping and exit-code tests |
| 5 | First-review smoke runbook | Document the operator-facing first-review smoke: send one real PR event, watch it become a job, and inspect queue state, last failure, model consumption, and the published review through the existing admin/MCP surfaces; note the #739 harness scenario families as the CI/disposable-environment equivalent | `docs/first-review.md`, `docs/self-hosted-qualification.md` (cross-link), `docs/troubleshooting.md` | uses `/admin/status`, `/admin/runs`, run usage aggregates, and the `get_review` MCP tool as they exist today; the harness stays the programmatic proof (#1483/#1484/#1485 land their families separately) |
| 6 | Migration checklist | Document the Action→controller cutover checklist: disable/remove the per-repo Action workflow (`on: pull_request` trigger) BEFORE enabling controller adoption, verify no duplicate competing reviews, preserve identical policy inputs when moving them into instance/repository config, no implicit approval enablement | `docs/action-to-controller-migration.md`, `README.md` | order of operations is the deliverable; the duplicate-review failure mode must be called out explicitly |

Child filing: each row is written to be lifted into an issue as-is (one
imperative ask, concrete paths), following the AGENTS.md filing rules. They
are recorded here rather than filed from this PR so the maintainer can trim
or reorder before the queue grows.

## Testing posture

This document decides; it ships no code. The children carry the tests:

- Child 3 extends the admin-route suite pattern (auth on the new route,
  fixed `200`-with-verdict, bounded redacted reasons, per-probe timeout
  against a hung probe, no state mutation) and the controller composition
  tests (the daemon supplies the probe seams; a probe that throws fails its
  own check, never the route).
- Child 4's CLI tests cover URL/token sourcing (token never accepted from
  argv), exit-code mapping, and a fixed error when the route answers `401`/
  `503` (the doctor reporting "admin surface itself is unconfigured" IS a
  diagnosis).
- The #739 harness (and its CI job) remains the end-to-end proof; the
  doctor is the interactive diagnostic, not a test framework.

## Out of scope

Any UI/dashboard (#742), a new DB surface beyond #736, a doctor-specific
config file or values parser, outside-in network probing from inside the
cluster, mutation endpoints (the route is read-only + self-tests), and any
change to the Action path, which stays first-class.
