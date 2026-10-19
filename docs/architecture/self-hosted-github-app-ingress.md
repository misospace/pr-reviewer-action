# Post-v3 self-hosted GitHub App ingress: auth and capability

Design of the #729 GitHub App substrate in `src/ingress/`: webhook-signature
verification, App JWT minting, the short-lived installation-token broker, and
the read+write capability client that issues every forge read and write over the
repo's typed HTTP transport instead of a forge-specific CLI.

This layer is **not wired into the Action runtime** — `action.yml`,
`contracts/`, and `src/platform/` are unchanged, nothing imports these modules
from the Action path, and Action mode behaves exactly as before. It is
operator-mode (#725) infrastructure for a self-hosted controller, exactly like
[#730](self-hosted-forgejo-ingress.md): the controller owns its own server,
queue, and worker lifecycle. The webhook handler and the reconciliation loop for
the GitHub App path are **follow-on work** (see Follow-ons) — this phase is the
auth + capability substrate they will sit on.

Why the App path needs its own client at all: the App credential **lifecycle is
not something a forge CLI can own**. `gh` (like any CLI) can *carry* a supplied
token — `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` accept an arbitrary PAT, OAuth token,
or even a minted installation token — but nothing in a CLI can **mint** the App
RS256 JWT from the private key, run the installation-token mint/refresh
lifecycle against the clock, or keep the credential scoped to exactly the
repository each call names. So "route every forge read and write through the
configured forge capability, not a forge-specific CLI" is not achievable by
parameterizing the existing CLI path: the minting authority has to live in the
controller process, and the App credential path needs its own client. It has
**no `child_process` import, no `gh`/`gj`/`forge` invocation, and no shell-out
of any kind**; every request goes through `src/platform/http.ts`'s
`requestJson`.

## Module map

| module | role |
|---|---|
| `github-app-signature.ts` | `X-Hub-Signature-256` computation/verification: `sha256=` + lowercase-hex HMAC-SHA256 over the **raw** body, constant-time compare after a length equality check |
| `github-app-auth.ts` | `GitHubAppAuthenticator`: the RS256 App JWT mint, the cached, repo-scoped installation-token broker with permanent/transient failure classification, and `appIdentity()` — the `GET /app`-proven bot login |
| `github-app-client.ts` | `GitHubAppCapabilityClient`: the read (`listOpenPullRequests`, `getPullRequest`) and write (`upsertIssueComment`, `createReview`, `createCommitStatus`, `createCheckRun`) capability seam |

## Credential lifecycle

Two distinct credentials, never conflated:

1. **App JWT** (`mintAppJwt`) — RS256 over `{ iat, exp, iss: appId }`, spent only
   against `/app/...`. `iat` is skewed **60 seconds into the past** so a verifier
   whose clock runs fast still accepts it; `exp` is `iat + 600`, i.e. exactly
   GitHub's hard 10-minute App-JWT cap, and the skew is inside that window rather
   than beyond it. It is an *app* credential, not a repository credential: it
   cannot read or write repository content.
2. **Installation token** (`installationToken`) — the repository credential,
   minted by `POST <apiBase>/app/installations/<id>/access_tokens` authenticated
   with `Authorization: Bearer <jwt>`, optionally scoped by a `repositories`
   list in the body. It is short-lived and repo-scoped by construction, and the
   client asks for a token scoped to exactly the repository each call names.

Both are cached only in the authenticator instance (`expires_at` minus a 60 s
safety margin), never globally and never pinned to one configured repository. A
missing or unparseable `expires_at` falls back to a **conservative** 3600 s
lifetime: an over-short cache entry only costs one extra mint, while an over-long
one would hand out a token GitHub has already revoked. Inside the margin the
token is re-minted rather than handed out — and the liveness rule applies to a
freshly minted token too, validated against the injected clock after each
request completes: a mint whose `expires_at` is already past or already inside
the margin is retried once, and if the second mint is also not live the broker
fails with a fixed **transient** reason, with nothing from either rejected
attempt ever cached or returned. The cache is bounded by scope count
(512 entries); on overflow it is dropped whole rather than evicted selectively —
tokens are cheap to re-mint and short-lived, so a flush costs one extra mint per
live scope and can never serve a stale one.

### Cache keying rule

The cache key is `installationId + normalized sorted repository scope`, exported
as `installationScopeKey` so the rule itself is pinnable. Two required
consequences:

- two installations can never see each other's tokens (the installation id is
  part of the key);
- the same installation asked for two different scopes never receives a token
  minted for the other scope (the scope is part of the key) — the empty scope is
  its own distinct key (`*`), the installation-wide grant.

Scope entries are validated with `parseRepoRef` (the ONE repo-ref validator), so
a traversal-shaped repository can never become a token scope.

## Trust boundaries

- **The private key never crosses the seam.** It lives in a `#private` field
  read only by `mintAppJwt`: no accessor, no `toJSON`, no
  `Object.keys`/`Reflect.ownKeys`, and no error message returns it. Only the
  JWT and the installation token are ever produced, and only short-lived,
  repo-scoped credentials cross into worker/queue payloads — the durable-event
  policy (#728) stays references-only.
- **Origin binding first.** `apiBaseUrl` is validated through
  `parsePlatformBaseUrl` in the constructor *before* the app id or the key are
  read, so a credential can only ever bind to a validated http(s) origin with no
  embedded credentials (#674/#670/#682 SSRF boundary). A self-hosted GHE base
  keeps its path prefix (`https://host/api/v3`) and is a first-class target, not
  a hardcoded cloud host.
- **Credentials travel only in the Authorization header.** `platform/http.ts`
  pins every request to the validated origin and refuses redirects
  (`redirect: "manual"`; a blocked redirect never reports its target). No
  token, JWT, or private key ever appears in a URL, query string, request
  body, returned value, or diagnostic, and a minted token carrying CR/LF is
  refused (header injection). The one deliberate exception for *scope
  metadata*: the mint request body carries the repository scope as repository
  **names** (`{"repositories":["repo"]}` — GitHub's mint endpoint defines
  `repositories` as names, not owner-qualified full names), scoped to the
  installation being minted against. Scope is not a credential; the token
  minted from it travels only in the Authorization header.
- **Signature verified before parse.** `github-app-signature.ts` computes the
  HMAC over the **raw** bytes, so unauthenticated bytes never reach a JSON
  parser. It is deliberately *not* the same function as `signature.ts`:
  `X-Gitea-Signature` is bare lowercase hex and correctly **rejects** the
  `sha256=` form; `X-Hub-Signature-256` is prefixed and correctly **rejects**
  the bare form. Each accepts exactly what the other refuses, so do not
  "unify" them. Both fail closed: an empty secret accepts nothing (even a header
  computed over the empty secret), a duplicate-header array is refused rather
  than picked from (ambiguous input, not a value to choose between), the prefix
  must be exact, and the digest must be exactly 64 **lowercase** hex characters.
- **Fixed, credential-free failures.** Every non-2xx, transport failure, and
  malformed response maps to a bounded reason plus a classification.
  `401`/`403`/`404`/`422` and a malformed private key are **permanent** (retrying
  cannot help); `429`, `5xx`, transport failures, and a blocked redirect are
  **transient**. A hostile or reflecting server that echoes the credential or
  the key back in a body body cannot get any of it back out through a reason.
- **Visitor input never directly invokes a forge write.** A delivery body is
  untrusted data; it reaches a write only after signature verification, and the
  payloads this seam sends are built by the module from typed values (validated
  repo refs, PR numbers, shas, states, contexts, and byte-bounded bodies), never
  interpolated from caller text into a URL.

## Publication idempotency

`upsertIssueComment` locates the existing managed comment by its marker — the
same marker identity the production publisher uses (`src/platform/publish-api.ts`)
— and **PATCHes** it; it POSTs only when no managed comment exists. A retry after
a partial publication failure therefore converges on ONE managed comment instead
of duplicating the managed output.

Two failure modes that would each produce a duplicate are refused rather than
absorbed:

- **A failed lookup is propagated**, never degraded to "no comment exists" —
  that degradation would turn a read failure into a duplicate create.
- **Exhausting the comment page bound fails loudly** instead of reporting
  "absent". GitHub returns issue comments oldest-first, so the comment this seam
  just published is the one on the *last* page — precisely the page a silent
  truncation drops. A bound that reports absence is worse than no bound.
- **The body must carry the marker.** A comment published without one cannot be
  located by the next run, so every publication would duplicate it. The marker is
  not the caller's to omit.

## Managed-comment ownership is proven, not assumed

A marker is body content, and body content is forgeable: the PR author can post
the marker in their own comment. So the marker locates a **candidate**; it does
not authorize a PATCH. Before any comment this seam rewrites, the author of the
located comment must be the App identity this seam posts as — the same
proven-owner rule and the same `owner-identity.ts` matcher the production
publisher applies. The identity is resolved by `GitHubAppAuthenticator.appIdentity()`:

- `GET /user` cannot answer for an App — it returns 403 "Resource not accessible
  by integration" for `GITHUB_TOKEN` and for an installation token alike.
- `GET /app`, authenticated with the **App JWT**, does answer, and its `slug`
  yields the bot login `<slug>[bot]`. The slug is public metadata, not a
  credential, so caching the resolved login leaks nothing.

The slug is matched against the App-slug charset rather than interpolated into
anything, so a hostile `/app` response cannot install a login chosen to match an
attacker-authored comment.

Outcomes, all fail-closed:

| situation | result |
|---|---|
| App identity proven, marker comment authored by it | PATCH that comment |
| identity unprovable (`GET /app` refused, unusable payload, transport failure) | no PATCH **and** no POST |
| a marker comment exists but is foreign-authored, or carries no forge-reported author, and no owned match exists | no PATCH **and** no POST |
| a foreign marker comment exists *alongside* a proven-owned match | the owned one is PATCHed |

**Documented divergence from the shipped publisher.** `publish-api.ts:352-355`
blocks only on an *unattributable* author and otherwise POSTs beside a foreign
marker; this seam also blocks on a merely *foreign* one. That is stricter, and
it is deliberate — the App path has no second publisher to fall back on. The
cost is an availability edge: a PR author who posts the marker once suppresses
the managed comment on that PR for as long as the foreign comment is the only
match. Fail-closed is the correct default here (`AGENTS.md`, "Fail closed where
required"), so the stricter rule stays; a controller that needs to publish over
a marker-squatted PR should surface it rather than weaken the check.

An unprovable identity is never treated as trusted, matching
`PlatformAdapter.authenticatedIdentity()`'s contract in `src/platform/types.ts`.
A failure is never cached as a negative identity: the next call re-proves, so a
transient 5xx cannot pin the publisher into a permanently broken state. A
*successful* proof is cached for 15 minutes — bounded because the App slug is
renameable, and a login cached forever would strand every managed comment as
foreign after a rename with no recovery short of a restart. The
refinement over the marker is implemented **here** rather than deferred to
`src/platform/publish-api.ts`, because #729 lists "own-comment/review identity
cannot be spoofed by PR author" as a required property of this seam.

## Capability gating

Check runs go through `requireCapability("github", "checkRuns")` so
`capabilities.ts` stays the single declaration of what a platform supports; a
refused capability is reported before any network call and is never a forge
failure. Commit status is the documented fallback. `github-app-client.ts`
re-exports no second capability matrix and defines no publication semantics —
`src/platform/publish-api.ts` remains the source of reviewer publication
semantics.

## #729 phase acceptance mapping

| criterion | where | tests |
|---|---|---|
| the App path can authenticate without any forge CLI | `github-app-auth.ts` (JWT + installation token over `requestJson`, no `child_process`) | `tests-v3/ingress-github-app-auth.test.ts` |
| `X-Hub-Signature-256` is verified fail-closed over the raw body | `github-app-signature.ts` | `tests-v3/ingress-github-app-signature.test.ts` |
| every forge read/write goes through the configured capability | `github-app-client.ts` reads + writes, per-call repo-scoped credential, capability-gated check runs | `tests-v3/ingress-github-app-client.test.ts` |
| credentials and key material stay inside the seam | `#private` key containment, header-only credentials, fixed credential-free errors, origin binding | `tests-v3/ingress-github-app-auth.test.ts`, `tests-v3/ingress-github-app-client.test.ts` |
| a retried publication converges | marker lookup → PATCH, POST only when absent; loud failure on a failed lookup, on page-bound exhaustion, and on a marker-less body | `tests-v3/ingress-github-app-client.test.ts` |
| managed-comment identity cannot be spoofed by the PR author | `appIdentity()` (`GET /app` with the App JWT) + `ownerMatchesIdentity` before any PATCH; foreign/unknown/unprovable ownership fails closed | `tests-v3/ingress-github-app-client.test.ts` |
| webhook handler + reconciliation for the App path | not in this phase | — |

## Follow-ons

The GitHub App **webhook server** (Node `http` handler + canonical-event
projection over `X-Hub-Signature-256`), the reconciliation wiring, the queue /
durable-ledger lifecycle (#731/#736), the credential broker (#735), and
executor/worker lifecycle (#733) are follow-on issues. `reconcile.ts` already
takes a lister callback, so `listOpenPullRequests` is the only surface
reconciliation needs from this phase.