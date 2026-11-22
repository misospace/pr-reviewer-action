# Operations dashboard (#742, redesigned #1717)

The operations dashboard is a static web shell served by the controller
admin listener. It gives an operator a browser view over the existing
admin API (`src/admin/routes.ts`). The shell holds no data and no logic
beyond rendering. Every value the operator sees is fetched from the
bearer-protected `/admin/*` routes, so the API stays the single source of
truth and the single enforcement point.

## What gets served

`src/admin/dashboard.ts` holds the shell's style block, an HTML shell,
and a small vanilla-JS script as module constants. The pure function
`serveDashboard(pathname)` answers exactly two GET routes. `GET /dashboard`
serves the shell (`200`, `text/html; charset=utf-8`) and
`GET /dashboard/app.js` serves the script (`200`,
`text/javascript; charset=utf-8`). Any other method or path under
`/dashboard`, including subpaths like `/dashboard/extra`, returns `null`,
and the host renders the fixed JSON 404. The shell carries zero dynamic
data: no request echo, no repository content, no configuration, no token.

## Optional mount, off by default

The mount is an option on `createAdminHost`: pass
`dashboard: {}` in `AdminHostOptions` to enable it. When the option is
absent, `/dashboard` paths answer the fixed 404 like any unknown path.
The surface is not part of that deployment, so it is never open.

The controller wires this through `PR_REVIEWER_ADMIN_DASHBOARD`. OFF
(case-insensitive, trimmed): unset, `0`, `false`, `off`, `no`,
`disabled`. ON: `1`, `true`, `enabled`, `on`, `yes`. Any other non-empty
value is a startup refusal. The check is lexical, and it runs only when
the admin listener is configured, because the flag means nothing without
that listener. A typo like `ture` on a deployment that serves the admin
listener can never silently disable the flag. The startup summary reports
`dashboard=on|off`.

## Why the shell is unauthenticated but carries no data

The dashboard paths sit OUTSIDE the `/admin/` namespace. This is what
keeps the normative rule intact: every `/admin/*` route requires the
bearer token, and the dashboard mount does not change that rule or add an
exception to it. The shell itself needs no auth because it carries nothing: it is static structure,
styles, and rendering code.

The operator enters the admin bearer token in the browser. The script
keeps the token in one in-memory JavaScript variable and in the token
input's value: it is never written to browser storage, never set as a
cookie, never placed in a URL, and read from the input field only when
loading. All data access uses relative `fetch` calls under `/admin/` with
the token in the `Authorization` header, so the browser only ever talks
to the same listener the shell came from.

## The CSP fence

Every dashboard response carries:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'sha256-2UPZoIdLr/DB0rB7iH8yqCXgjRaaF654c+JAFCZDcgM='; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

`style-src` names the SHA-256 hash of the style block in the shell, and
nothing else. The browser applies that one block and refuses every other
inline style. The hash is computed from the same constant that the shell
serves, so the served text and the hash never drift apart. The test and
this page both carry the pinned value. If you change the style block, you
must change both.

A browser that predates CSP3 ignores the hash source. It then applies no
style at all, because `default-src 'none'` covers `style-src`. The shell
renders without its styles. No browser applies an inline style that the
hash does not name.

`connect-src 'self'` is the structural guarantee: the UI can only
send requests to the controller API on the same origin. It can never
reach a database, the Kubernetes API, or a forge API directly.
`frame-ancestors 'none'` and `X-Frame-Options: DENY` keep the shell out
of any framing host (clickjacking). The responses also carry
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store`.

## Operator console

The header carries product identity, overview/runs/diagnostics navigation,
connection state, a system/dark/light theme cycle, and a compact token control.
Theme preference is held only in memory. The overview composes readiness,
queue counters, workers, adoption, recent runs, actionable failures, and a
rereview action. Runs use a horizontally scrollable table with status chips,
relative ages, short head SHAs, and cursor pagination backed by an in-memory
cursor stack; an empty list has an explicit state. Run detail presents metadata,
a lifecycle timeline, usage and cost provenance, publication status, and a
danger-zoned cancel action. Diagnostics classify severity and place technical
values in expandable native details.

## Rendering rule

Every dynamic value inserted into the page goes through
`document.createTextNode` (via the `text()` helper). Markup-injection DOM
APIs are not used. Runtime class names come only from fixed whitelist
vocabularies; API values cannot choose classes. Diagnostics are rendered as
returned by the API, with redaction remaining in `src/admin/routes.ts`.

## Actions

A non-terminal run detail calls `POST /admin/runs/{id}/cancel` only after a
`confirm()` dialog. The rereview form calls `POST /admin/rereview`, also behind
`confirm()`. Both render human feedback with technical failure detail. Control-
plane logic remains in the controller.

The rereview form's own gate runs BEFORE the request: the PR key must match
the controller's grammar (`owner/repo#123` — an owner, a repository, a `#`,
and a positive PR number with no leading zero) and the reason must be
non-empty after trimming. An invalid form NEVER reaches the controller: the
feedback element names the field that was wrong, and no request is made.

A refused mutation renders the CONTROLLER's reason, not a bare status: the
response body is read as JSON and its `detail` (or its `error`) becomes the
feedback text. The headline separates the two failure classes, so the
operator can tell "I typed it wrong" from "the controller said no" without
reading the status code: a `400` is the request's own shape ("Rereview was
not requested." / "The request was invalid."), a `409` is the controller's
refusal ("Rereview was refused." / "Cancellation was refused."). Every
dynamic value — the server's reason included — reaches the page as a text
node, never as markup.

## Testing posture

`tests-v3/admin-dashboard.test.ts` covers route/auth/CSP pins, method and raw
path discipline, inert shell behavior, structural fences, and the
admin-API-compatibility pin. Its hostile execution fence runs the script in a
`node:vm` DOM harness and proves one hostile marker per render path reaches only
text nodes: readiness, adoption, queue workers key, runs rows, failures list,
run-detail publication/usage, diagnostics, and mutation error bodies. UI-state
coverage pins the `confirm()` refusal gate (no mutation request), asserts the
cancel call, and exercises empty runs, auth/offline responses, pagination, and
accepted/refused mutation feedback. The mutation coverage pins the refusal
REASON: a `409` carries the controller's `detail` into the feedback element,
and an empty reason or a malformed PR key names the offending field and posts
nothing. A whitelist-completeness pin covers all
lifecycle chip states, while the CSP/style-hash test, served header, and this
documentation line must agree exactly. Redaction coverage confirms sensitive
diagnostics remain filtered by the API.

## Out of scope

The UI holds no control-plane logic, no websocket live state, no
persistence, and no roles or authorization beyond the bearer token. An
optional read-only role would be a follow-up. The dashboard is a
product-quality operator console over the admin API, not a product with its
own backend.

## Deployment notes

The shipped Helm chart exposes the flag as `controller.admin.dashboard`
(`deploy/charts/pr-reviewer`). The default is `false`, and the chart
then leaves `PR_REVIEWER_ADMIN_DASHBOARD` unset, which is the controller's
OFF state. Setting it to `true` renders
`PR_REVIEWER_ADMIN_DASHBOARD=true`, one of the accepted ON spellings. The
knob requires `controller.admin.enabled`, because the flag means nothing
without the admin listener: with the listener disabled the chart fails
the render instead of silently dropping the setting. Operators outside
the chart still set the environment variable directly. Because the shell
itself is served unauthenticated, network-level access control is the
operator's remaining control for who can REACH the shell: the admin bind
address (`PR_REVIEWER_ADMIN_BIND`, loopback by default) and network
policy. All data stays bearer-protected regardless.

Reaching `/dashboard` from outside the pod is a separate step from turning
the flag on. The chart binds the admin listener to the pod-wide wildcard when
the admin surface is enabled, but it defines only the webhook Service, so the
dashboard port has no route by default. Exposing it is the operator's ingress
choice: add a Service port for the admin listener and route the dashboard and
admin paths to it, keeping `/admin` on the same origin as `/dashboard` (the
script's `connect-src 'self'` only ever calls the origin that served it) and
never routing `/dashboard*` or `/admin*` as the forge intake path. The chart
README ("Reaching the dashboard from outside the pod") and
`docs/self-hosted-deployment.md` carry the verified Gateway values.
