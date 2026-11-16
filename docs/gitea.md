# Gitea

Gitea runs on the Forgejo wire family. Set `platform: gitea` explicitly.
Gitea and Forgejo share one wire protocol, so the Gitea adapter reuses the
Forgejo implementation instead of duplicating it. Gitea adds an identity,
and that identity has one job: refusing what upstream Gitea does not have.

## What is shared

Gitea and Forgejo share these, and each is implemented once:

- the `/api/v1` REST routes,
- the `Authorization: token <value>` access-token scheme,
- the GitHub-compatible pull-request shape (`head.sha`, `head.ref`,
  `head.repo.full_name`),
- the per-pull-request head ref `refs/pull/<n>/head`.

The read adapter and the publish client are the Forgejo ones
(`ForgejoAdapter`, `ForgejoPublishApi`) built with the Gitea identity
(`src/platform/gitea.ts`). Publication uses the same REST paths: the
managed comment, the native review, and its inline comments.

## Configuration

Set `platform: gitea` on the action. `auto` never selects Gitea: the
server URL cannot tell Gitea from Forgejo, so a guess would silently
enable or refuse a product-specific capability.

A Gitea instance still uses the existing `forgejo-api-url` and
`forgejo-token` inputs. They are the shared-family settings, and there is
no new action input. This is a known naming wart.

For self-hosted runs the token may also come from the environment.
`GITEA_TOKEN` is an alias. The family's own `FORGEJO_TOKEN` still wins over
it, then `GITHUB_TOKEN`, then `GH_TOKEN`. The alias is honored by the shared
family token resolver, not only by the Gitea-named entry point: every family
call site (read adapter, publish client, CI-wait gate, ancillary clients)
resolves through that one resolver, so an alias honored in only one place
would leave the others unauthenticated.

## Refused: authorized_integration

Authorized OAuth Integrations, an OIDC-asserted JWT exchange, exist only on
Forgejo. On Gitea every way of selecting that mode is refused:

- `platform: gitea` with `forgejo-auth-method: authorized_integration` is
  rejected at config validation, before any token lookup or request.
- A bare `forgejo-authorized-integration-audience` is rejected too. On Forgejo
  an audience alone forces integration mode, so refusing only the explicit
  method would let that configuration degrade silently into token mode.
- The read adapter and the publish client repeat the refusal at construction,
  so a direct caller that skips config validation cannot bypass it. The
  construction refusal says:

```text
Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token
```

The auth method has one name for the whole family: `FORGEJO_AUTH_METHOD`. There
is no `GITEA_AUTH_METHOD`, and `giteaTokenFromEnv` is the only reader that
would have honored one. A method key that one lane reads makes one run refuse
the mode on the review path while the CI-wait gate and ancillary writes carry
on in token mode.

## Webhooks

Gitea sets two event headers: `X-Gitea-Event` (the grouped event name)
and `X-Gitea-Event-Type` (the specific type). It signs the raw request
body with HMAC-SHA256 and puts the hex digest in `X-Gitea-Signature`.
There is no timestamp header. Gitea's own docs are ambiguous on this
point and people look for one. The HMAC covers the raw body only, so the
two event headers are unauthenticated hints: they may refine a projection
that the signed body's own `action` already authorizes, and they can
never rewrite one.

The Gitea intake route is `/webhooks/gitea` (`GITEA_WEBHOOK_PATH`,
`src/ingress/endpoints.ts`). Set a webhook secret on the instance and on
the controller. An empty secret accepts nothing: the handler fails
closed, and it verifies the signature over the raw body before parsing
any JSON.

`createGiteaWebhookHandler` and `dispatchGiteaWebhookEvent` are served
today by the Action runtime and by `createOperatorHost({ platform:
"gitea" })`. The shipped controller daemon does not select them yet: its
instance schema accepts only `kind: github` and `kind: forgejo`
(`src/config/instance-config.ts`), and its webhook listener mounts one
handler for every path. A Gitea instance behind the daemon must
configure `kind: forgejo`, which means the deliveries run the Forgejo
projection. Wiring `gitea` through the instance schema and the daemon
intake is tracked separately; until it lands, do not set
`kind: gitea` — validation rejects it.

Subscribe the webhook to the events that schedule reviews:

- pull request: opened, closed, reopened, synchronized,
- pull request label,
- issue comment.

A closed pull request that did not merge schedules nothing. A merged one
is recorded as merged. Neither schedules a review. A `ping` delivery is
acknowledged and ignored.

## Capabilities

Gitea declares the Forgejo baseline verbatim (`GITEA_CAPABILITIES` in
`src/ingress/capabilities.ts`): native review, sticky comment, inline
review comments and commit status are supported; check runs and GraphQL
are not. Degradation follows the Forgejo behavior described in
[Self-hosted deployment](self-hosted-deployment.md).

## Reconciliation polling

The missed-webhook reconciliation poll for a Gitea instance still
declares the `forgejo` family. The platform field is part of the
review-generation identity, so a poll naming a different family would
mint a different generation than the webhook delivery for the same head,
and the two would never converge.

## Not covered by this change

- The shipped controller daemon cannot select the Gitea intake. Its instance
  forge `kind` still accepts only `github` and `forgejo`. See Webhooks above.
- No new `gitea-*` action inputs. The shared `forgejo-*` settings stay.
- No separate Gitea REST client class. The Forgejo client serves both.
- No per-release Gitea version qualification. The shared family is not
  pinned to a Gitea version.
- Features that need GitHub GraphQL (review minimization) degrade as they
  do on Forgejo.

## Related pages

- [Self-hosted deployment](self-hosted-deployment.md): instance config,
  forge credentials, images.
- [Inputs and outputs](inputs.md): every input and output.
