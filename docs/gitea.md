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

`forgejo-auth-method: authorized_integration` is refused when `platform`
is `gitea`. Authorized OAuth Integrations, an OIDC-asserted JWT exchange,
exist only on Forgejo.

The refusal fires at config validation, before any token lookup or
request, and again at adapter and publish-client construction, so a direct
caller cannot bypass it. The construction refusal says:

```text
Gitea does not support auth method 'authorized_integration'; use 'token' mode with a Gitea access token
```

Config validation rejects the same combination first. Use `token` mode
with a Gitea access token.

## Webhooks

Gitea sets two event headers: `X-Gitea-Event` (the grouped event name)
and `X-Gitea-Event-Type` (the specific type). It signs the raw request
body with HMAC-SHA256 and puts the hex digest in `X-Gitea-Signature`.
There is no timestamp header. Gitea's own docs are ambiguous on this
point and people look for one. The HMAC covers the raw body only, so the
two event headers are unauthenticated hints: they may refine a projection
that the signed body's own `action` already authorizes, and they can
never rewrite one.

Mount the Gitea intake at `/webhooks/gitea` (the `GITEA_WEBHOOK_PATH`
constant, `src/ingress/endpoints.ts`). Set a webhook secret on the
instance and on the controller. An empty secret accepts nothing: the
handler fails closed, and it verifies the signature over the raw body
before parsing any JSON.

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
