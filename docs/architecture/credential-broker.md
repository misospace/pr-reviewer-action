# Credential broker and per-review secret scoping (#735)

Design of `src/credentials/`: the handoff boundary between the long-lived
controller and the short-lived review workers. Like the event/job, queue,
acquisition, and executor layers before it, this is **a library for the
future self-hosted controller daemon — it is not wired into the running
action pipeline**. Parent: #725 (post-v3 self-hosted); builds on #729
(GitHub App ingress), #730 (Forgejo adapter), #731 (durable queue), #732
(acquisition), #733 (executor boundary).

The one-sentence rule: **a worker receives only the credentials the current
review needs, for the shortest practical lifetime, and everything that
crosses the boundary into durable state is an opaque reference — the
material is resolved as late as possible and never serialized.**

## How the existing seams compose

The boundary was already prepared by the layers this composes with; #735
supplies the piece they all defer to:

- `src/config/instance-config.ts` validates model-profile and forge
  integration `credential` fields as opaque references (`CREDENTIAL_REF_RE`)
  — the schema has no field that could hold a secret.
- `src/executor/types.ts` carries `ExecutionRequest.credentials` as opaque
  `{name, reference}` pairs — "the #735 credential broker resolves
  references operator-side; no material ever crosses this boundary".
- `src/ingress/github-app-auth.ts` already implements the Konflate-style
  pattern controller-side: App JWT in the process, installation discovered
  lazily, short-lived installation tokens minted/refreshed against the
  clock, read/write authority separated. The private key never leaves that
  module's `#private` field.
- `src/acquisition/git-env.ts` moves git credentials only through
  per-invocation `GIT_CONFIG_*` env, never argv, never persisted config.
- `src/queue/` persists `JobRecord` snapshots as JSON — which must never
  contain material.

## Module map

| module | role |
|---|---|
| `types.ts` | Frozen contracts: `SecretPurpose` (closed union: `forge_clone`/`forge_publish`/`model`/`evidence`/`result_channel`), `SecretMaterial` (value + epoch-ms expiry, `0` = source-owned lifetime), `SecretScope` (the binding: every dimension not explicitly declared unscoped must be non-empty and match the request exactly — a blank bound field is a construction error, never a silent unrestricted grant), `ResolutionRequest`, closed `ResolutionRefusalCode` union, the `CredentialBroker` seam, the reference/name/profile grammars (textually mirroring the instance-config and executor regexes, deliberately not imported so the packages stay decoupled), secret-shaped-reference screening (a reference that looks like a literal API key is refused at construction, before it can ride the durable envelope), and the `WorkerCredentialPlan` shape (including `forkEvidencePolicy` and the claimed profile names) with its fail-closed `validateCredentialPlan` |
| `vault.ts` | `InMemorySecretVault implements CredentialBroker` — the controller's hand, not its memory: reference → material in a `#secrets` private field with no serializer, no accessor, and no error path that can echo a value; exact scope binding with one-directional matching (bound dimensions must equal the request; explicitly declared-unscoped dimensions accept any value); unknown fields rejected on entry, scope, AND material (a misspelled scope dimension cannot quietly unscope a credential; a stray material field cannot ride out unredacted); expiry against an injected clock with a minimum-remaining-lifetime margin (#729 `REFRESH_MARGIN_SECONDS` parity — a credential with less life left than the margin is not handed to a run that will outlive it), one refresh attempt per resolution via an injected refresh source, the refreshed material re-validated (shape + margin) before it replaces the stored one; `revoke()` for revoked/denied tokens; bounded capacity (1024 entries); duplicate references refused at construction |
| `worker-set.ts` | `buildWorkerCredentialPlan()` — the explicit per-run allowlist: five fixed names (`forge-clone`, `forge-publish`, `model`, `evidence`, `result-channel`), each backed by exactly one opaque reference from operator config. **Structural isolation**: the input has ONE model slot (the selected profile's) and the plan records the profile it claims (`modelProfileName`/`evidenceProfileName`), so a controller mapping bug that hands profile B's job profile A's reference is caught by the broker at resolution. **Structural + durable fork policy**: a fork job's plan contains `evidence` only when the operator policy explicitly permits it (`allowForkEvidence`), the decision is recorded as `forkEvidencePolicy` (`"off"`/`"allowed"`) IN the plan, and `validateCredentialPlan` refuses a fork plan with policy `off` carrying an `evidence` entry — so the trust boundary holds wherever the plan is proven (builder, resolver, or any consumer validating a plan from durable state), not just at construction. `resolveWorkerCredentials()` — LATE, ALL-OR-NOTHING resolution called at the final handoff: every entry is resolved against the run's exact identity, the `result-channel` token is minted per run from the controller's result-channel authority (derived, not stored), and ANY refusal withholds the whole set — a worker never launches with a partial allowlist. The resolved set is serialization-guarded: `JSON.stringify` yields credential NAMES only |
| `result-channel.ts` | `createResultChannelAuth()` — HMAC-SHA256 over `runId` + `jobId` + `installationId` + `repoFullName` + expiry, keyed by the controller signing key (held privately, never in any token or error). A token minted for run A can never authorize a submission for run B or another repository/installation — the hash of a different identity is a different token — and the token EXPIRES with the expiry inside the MAC input (it cannot be stripped or forged); verification is total over hostile input (malformed/overlong/foreign/expired tokens are `false`, never a throw; comparison is `timingSafeEqual`) |
| `redact.ts` | `createSecretRedactor()` — exact-value scrubber bound to one run's live material: every occurrence of every issued value becomes `[REDACTED]` (the same marker as the pattern layer in `src/context/redact.ts`, which complements this by masking *unpredicted* secrets in untrusted content), longest values first so substring values are fully covered, and for JSON artifacts BOTH the raw value and its JSON-escaped form are scrubbed (a secret containing a quote, backslash, or tab cannot survive serialization); values under 8 characters and values containing the marker itself are refused at construction (fail closed) |

## What crosses the boundary, and what never does

| crossing | allowed | forbidden |
|---|---|---|
| durable queue/ledger state | opaque references, credential NAMES | plaintext provider secrets, tokens, keys |
| execution request envelope | `ExecutionCredentialRef[]` (name + opaque reference) | material |
| worker environment | the resolved `WorkerSecretSet` (short-lived, run-scoped) | controller-only credentials (App private key, global admin tokens, database credentials, controller signing keys, unrelated model credentials) |
| logs and artifacts | reference names, fixed refusal reasons | secret values (the redactor enforces this for the values the broker itself issued) |

## Security invariants

- **Late resolution.** Plans are built from references early (safe to
  persist); material exists only after `resolveWorkerCredentials`, called
  at the last moment before handoff. An expired (or margin-expiring)
  credential is never handed out: expiry is checked against the clock with
  a minimum-remaining-lifetime margin, and the refresh source can mint a
  fresh short-lived token.
- **Explicit allowlists.** The plan is a closed list of five fixed names;
  nothing implicit rides the handoff, and `validateCredentialPlan` rejects
  unknown names (null-prototype lookup — `"constructor"` is a name, not a
  purpose), duplicate names, malformed references, and secret-shaped
  references.
- **Cancellation/expiry bounds token usefulness.** The material's
  `expiresAtMs` plus the vault's refresh margin bounds reuse; the
  result-channel token expires with the expiry inside its MAC and
  authorizes exactly one `(runId, jobId, installationId, repoFullName)`
  identity until then.
- **Cross-run/cross-repo confusion is refused, not filtered.** Scope
  binding mismatch is a closed refusal code (`scope_mismatch`); profile-B
  isolation is both structural (one model slot) and broker-checked (the
  plan's claimed profile name vs the credential's bound profile).
- **Fork separation.** Fork jobs receive no evidence credential unless
  policy explicitly permits it — recorded in the durable plan as
  `forkEvidencePolicy` and enforced by `validateCredentialPlan` wherever
  the plan is proven, so the #730/#725 fork trust boundary holds by
  construction at every consumer, not by review attention.
- **Fail closed.** Vault construction refuses duplicates, unknown fields,
  and blank bound dimensions; resolution refuses unknown/expired/revoked/
  mismatched references with fixed bounded reasons; the handoff is
  all-or-nothing; the redactor refuses too-short and marker-bearing
  values instead of guessing.
- **No engine or pipeline infection.** Nothing in `src/run/`, `src/engine/`,
  or the action pipeline imports this package; the controller daemon (#736)
  is the consumer.

## Out of scope (follow-on issues)

- **#765 run-scoped gateway tokens.** The plan shape already supports the
  swap: the model credential is one named entry whose reference can become
  a gateway capability instead of a direct profile credential — no
  `ExecutionRequest` field changes, and the engine's model semantics are
  untouched. `WorkerModelMode` is the closed union with exactly one member
  (`direct_worker`) today; do not block direct local/self-hosted model use
  on the gateway.
- Controller-daemon wiring (#736): which operator component constructs the
  vault from the operator's secret store at startup (re-deriving bindings —
  never persisting this map), and which component calls
  `resolveWorkerCredentials` immediately before `Executor.start`.
- A persistent cross-process vault: deliberately absent — the vault is
  in-memory by design (see `vault.ts`'s header comment).
- A version field on the plan shape: the plan is not persisted by anything
  yet; add one when the controller daemon (#736) starts writing plans into
  durable state, so a future shape change can migrate instead of refusing
  every pre-change plan.

## #735 acceptance mapping

| criterion | where | tests |
|---|---|---|
| Long-lived controller secrets stay controller-side | App private key / signing key held in private fields (`github-app-auth.ts`, `result-channel.ts`); vault is in-memory, never serialized | `tests-v3/credentials-vault.test.ts :: vault: the vault object serializes without secret values`; `tests-v3/credentials-result-channel.test.ts :: result-channel: the signing key never appears in a token or error` |
| Worker secret set is minimal and run-scoped | `buildWorkerCredentialPlan` five fixed names; `resolveWorkerCredentials` late + all-or-nothing | `tests-v3/credentials-worker-set.test.ts :: worker-set: plan carries exactly the five fixed names for a full non-fork run`; `worker-set: resolveWorkerCredentials hands back exactly the plan's material, all-or-nothing`; `worker-set: one refusal withholds the whole set — no partial handoff` |
| Boundary supports direct model credentials or a future #765 gateway token | `WorkerModelMode` closed union with one member; model credential is one swappable named entry | `docs/architecture/credential-broker.md` (this section); `tests-v3/credentials-worker-set.test.ts :: worker-set: builder fails closed on malformed references and unknown model mode` |
| Durable state contains no plaintext provider secrets | references only in plan / `ExecutionRequest` / `JobRecord` shapes | `tests-v3/credentials-worker-set.test.ts :: worker-set: no secrets in durable payload — plan and executor request stay reference-only` |
| Multi-installation token isolation | `scopeMismatch` exact matching on bound dimensions; end-to-end through plan → resolve | `tests-v3/credentials-vault.test.ts :: vault: multi-installation token isolation — another installation is refused`; `vault: cross-repo isolation — another repository under the same installation is refused`; `vault: platform isolation — a github-bound credential never serves forgejo`; `vault: purpose isolation — a forge_clone credential never serves a model request`; `tests-v3/credentials-worker-set.test.ts :: worker-set: multi-installation isolation end-to-end through plan → resolve` |
| Selected model only receives its credential | one model slot in the plan input; the plan's claimed `modelProfileName` is broker-checked against the credential's bound profile | `tests-v3/credentials-worker-set.test.ts :: worker-set: the selected model profile is the only model credential — structurally`; `worker-set: a mapping bug handing profile B's job profile A's ref is caught by the broker`; `worker-set: cross-repo model credential cannot be resolved into another repo's set` |
| Expired token refresh | vault refresh source, one attempt, re-checked binding | `tests-v3/credentials-vault.test.ts :: vault: expired token refresh — one refresh replaces the material and persists`; `vault: expired material is refused without a refresh source`; `vault: refresh failure and refresh throw both refuse expired, never leak` |
| Revoked/denied token behavior | `revoke()` + `revoked` refusal | `tests-v3/credentials-vault.test.ts :: vault: revoked references refuse and revoke is idempotent` |
| Fork policy | structural `evidence` omission for fork jobs, recorded as `forkEvidencePolicy` in the durable plan and enforced by `validateCredentialPlan` at every consumer | `tests-v3/credentials-worker-set.test.ts :: worker-set: fork policy — evidence reference omitted unless explicitly allowed, durably`; `worker-set: fork policy survives a durable round trip — validation enforces the boundary`; `worker-set: forkEvidencePolicy 'allowed' is only valid on a fork plan` |
| Result-channel auth cannot submit for another run | HMAC over `(runId, jobId, installationId, repoFullName, expiry)`; expiry enforced at verify | `tests-v3/credentials-result-channel.test.ts :: result-channel: a token cannot submit for another run or another job`; `result-channel: an expired token is refused even for its own identity`; `result-channel: hostile tokens fail closed without throwing`; `result-channel: different keys derive different tokens` |
| Logs/artifacts redaction | `createSecretRedactor` bound to the resolved set | `tests-v3/credentials-worker-set.test.ts :: worker-set: resolved material redacts from logs and artifacts`; `redactor: longest-first replacement covers substring secrets` |
