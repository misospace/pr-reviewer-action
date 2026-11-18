# GitLab

GitLab is its own wire family. Set `platform: gitlab` explicitly.
The GitLab REST surface (`/api/v4`), the merge-request webhooks, and the
acquisition ref (`refs/merge-requests/<iid>/head`) all differ from GitHub
and from the Forgejo family, so no other adapter is reused.

## What is different

GitLab shares no wire with the other platforms:

- REST base is `GITLAB_API_URL` plus `/api/v4`. There is no default host.
  A self-hosted instance and gitlab.com are both first-class, and each one
  must be named.
- The access token travels only in the `PRIVATE-TOKEN` header. The token
  comes from `GITLAB_TOKEN` and is attached at the fetch seam after the
  origin check, so it never appears in a URL, in process arguments, or in
  diagnostics.
- A merge request (the GitLab name for a pull request) is addressed by its
  project-scoped `iid`. The project path can nest: `group/subgroup/project`.
- Head acquisition uses `refs/merge-requests/<iid>/head`, not
  `refs/pull/<n>/head`.
- Publication uses GitLab notes (the sticky review comment), discussions
  (inline comments), and commit statuses.

## Configuration

Set `platform: gitlab` on the action or the instance configuration. `auto`
never selects GitLab: nothing observable tells a self-hosted GitLab apart
from any other host, so a guess would silently enable or refuse a
product-specific capability.

The GitLab settings are the two environment variables `GITLAB_API_URL` and
`GITLAB_TOKEN`. They have no `forgejo-*` equivalents and no action inputs.
`GITLAB_API_URL` is required: every GitLab read and write refuses to start
without it. `gitlab-*`-family settings from another platform are refused:
`forgejo-auth-method` or a `FORGEJO_TOKEN` chain never authenticates a
GitLab run.

## Webhook intake

The GitLab intake listens on `/webhooks/gitlab` and accepts merge-request
events and comment events on merge requests. One configured secret decides
the authentication mode, and the mode is exclusive:

- A secret that starts with `whsec_` is a signing token. The handler
  verifies the `webhook-signature` header: an HMAC-SHA256 signature over
  `{webhook-id}.{webhook-timestamp}.{raw-body}`, in the format GitLab
  documents for its signing token. A delivery without a valid signature is
  rejected, and the `X-Gitlab-Token` header is not consulted.
- Any other non-empty secret is a legacy secret token. The handler compares
  it, constant-time, against the `X-Gitlab-Token` header. A
  `webhook-signature` header alone does not authenticate.

An empty secret accepts nothing. Signatures are compared constant-time. In
signing mode the delivery timestamp must be within five minutes, because an
old captured delivery must not start a review. The legacy secret token has
no timestamp, so an exact copy of one accepted delivery stays replayable.
The review queue absorbs the duplicate, and webhook-id dedupe is part of
the daemon composition (#1677).

The projection maps GitLab actions onto the canonical events: MR `open` and
`reopen` start a review, a new comment projects to a follow-up, and an
`update` whose `object_attributes.oldrev` names a commit projects to a
synchronize. An `update` without that field starts nothing, unless it adds
the configured re-review label, which projects to a labeled re-review. A
comment body is never copied into the job.

## What works today, and what does not

The read adapter (`GitLabAdapter`), the publish client
(`GitLabPublishApi`), and the webhook intake are complete and tested. The
declared capability matrix is: native review true, sticky comment true,
inline review comments true, commit status true, check runs false, GraphQL
false.

The controller daemon refuses a GitLab instance at startup. The durable
worker lane (job intake, credential projection, execution admission for
`platform: gitlab`) is issue #1677, and nothing silently degrades to GitHub
in the meantime. Until #1677 lands, the shipped GitHub Actions host does
not run GitLab reviews. The adapters here are the pieces that composition
builds on.
