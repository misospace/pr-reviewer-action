# Operations dashboard (#742)

The operations dashboard is a static web shell served by the controller
admin listener. It gives an operator a browser view over the existing
admin API (`src/admin/routes.ts`). The shell holds no data and no logic
beyond rendering. Every value the operator sees is fetched from the
bearer-protected `/admin/*` routes, so the API stays the single source of
truth and the single enforcement point.

## What gets served

`src/admin/dashboard.ts` holds two compile-time constants: an HTML shell
and a small vanilla-JS script. The pure function `serveDashboard(pathname)`
answers exactly two GET routes: `GET /dashboard` serves the shell
(`200`, `text/html; charset=utf-8`) and `GET /dashboard/app.js` serves
the script (`200`, `text/javascript; charset=utf-8`). Any other method
or path under `/dashboard`, including subpaths like `/dashboard/extra`,
returns `null`, and the host renders the fixed JSON 404. The shell
carries zero dynamic data: no request echo, no repository content, no
configuration, no token.

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
exception to it. The shell itself needs no auth because it contains
nothing: it is a form and some rendering code.

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
Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

`style-src 'unsafe-inline'` covers the small inline style block in the
shell. `connect-src 'self'` is the structural guarantee: the UI can only
send requests to the controller API on the same origin. It can never
reach a database, the Kubernetes API, or a forge API directly.
`frame-ancestors 'none'` and `X-Frame-Options: DENY` keep the shell out
of any framing host (clickjacking). The responses also carry
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: no-store`.

## Rendering rule

Every dynamic value the script inserts into the page goes through
`document.createTextNode` (via the `text()` helper). Markup-injection DOM
APIs are not used anywhere in the script. API data is rendered as text,
so a hostile value in an API response cannot become markup in the
operator's browser. Diagnostics are rendered exactly as the API returns
them: the UI applies no un-redaction and no transformation. Redaction
stays where
it is enforced, in `src/admin/routes.ts`.

## Actions

The dashboard exposes the two admin mutations: a cancel button on a
non-terminal run detail view calls `POST /admin/runs/{id}/cancel` after
a `confirm()` dialog, and inputs plus a button call
`POST /admin/rereview` with the `prKey` and reason fields (also behind a
`confirm()` dialog). Both show the HTTP status and the fixed error
body text on failure. There is no retry logic and no client-side state
machine. Control-plane logic stays in the controller.

## Testing posture

`tests-v3/admin-dashboard.test.ts` runs with the admin suite. It covers
the fail-closed default (no option means fixed 404), the two routes with
their exact content types and security headers, method and path
discipline (including raw verbatim-path traversal requests that never
serve shell content), the inert and byte-identical shell, the intact auth
boundary on every data route, structural fence checks on the script
source, and an EXECUTION fence test in the #252 pattern: the script runs
in a `node:vm` sandbox against a minimal DOM stub, fed hostile API
payloads (markup injection, fence escapes, attribute breakouts, control
characters, a credential-shaped string), and every hostile string must
arrive in the recorded DOM as verbatim text data through
`createTextNode` only, one unique marker per render path (including a
refused mutation's error body and the cancel button's call). A redaction
test points the diagnostics seam at a credential-shaped value and makes
sure that the API response stays redacted and the shell carries no
un-redaction mechanism.

## Out of scope

The UI holds no control-plane logic, no websocket live state, no
persistence, and no roles or authorization beyond the bearer token. An
optional read-only role would be a follow-up. The dashboard is a
demonstration-quality operator surface over the admin API, not a product
with its own backend.

## Deployment notes

The shipped Helm chart does not yet expose `PR_REVIEWER_ADMIN_DASHBOARD`
(a chart knob is a follow-up), so the flag is set through the
controller's environment for now. Because the shell itself is served
unauthenticated, network-level access control is the operator's remaining
control for who can REACH the shell: the admin bind address
(`PR_REVIEWER_ADMIN_BIND`, loopback by default) and network policy. All
data stays bearer-protected regardless.
