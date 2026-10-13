# Canonical forge events and the ReviewJob contract

Design of the #728 event/job layer: `src/events/` (the provider-neutral
canonical event model) and `src/jobs/` (the immutable ReviewJob contract
it feeds). The job layer is a **contract for a future queue/executor
(Operator mode)** — it is not wired into the running action pipeline.
The scheduling semantics for that queue have since landed in `src/queue/`
([durable-review-queue.md](durable-review-queue.md)).

## Canonical event model

`src/events/types.ts` defines the provider-neutral surface both platform
adapters project onto:

- `ForgeEventSource` — `webhook` | `poll` | `manual`: how the observation
  arrived.
- `ForgeEventKind` — the normalized taxonomy: PR lifecycle
  (`pr_opened`, `pr_reopened`, `synchronize`, `ready_for_review`,
  `rereview_label`, `pr_closed`, `pr_merged`), `check_update`,
  `installation_change`, `visibility_change`, the poll-only
  `reconciliation_poll`, PR-thread `follow_up`, and `unknown` (a routable
  sentinel: identity is preserved, no PR pipeline).
- `CanonicalForgeEvent` — one frozen observation. Every field is required
  with an explicit sentinel (`""`/`0`/`false`), never optional, so
  downstream consumers never branch on `undefined`.

### Adapter boundary

Raw webhook/API payloads stop at the normalizers
(`src/events/normalize.ts`: `normalizeGitHubEvent`,
`normalizeForgejoEvent`, `reconciliationPollEvent`). No forge-specific
shape leaks past `src/events/`; every downstream layer receives only
`CanonicalForgeEvent`. Normalizers fail conservatively (return `null`,
never throw) and normalize head/base SHAs to lowercase hex at the
adapter boundary (trim + lowercase, then `/^[0-9a-f]{7,64}$/`; anything
else — including a missing SHA — becomes the sentinel `""`) so the
generation identity and the staleness checks agree on SHA form, and
downstream staleness checks fail closed on `""`. `reconciliationPollEvent`
runs the same bare-PR extraction and overrides `kind`/`source`, so ALL
identity fields converge between a webhook and a reconciliation poll of
the same PR (the poll path validates the caller's
`options.installationId` at the boundary with the same digits-only
canonical form as the webhook's `installation.id` — trim + 1–32 digits,
no leading zero, fail-closed to `""` — and never trusts its caller, so
the poller supplies the same `installationId` the webhook carried) and
the two differ only in `source` (`webhook` vs `poll`) and `kind` — the
property the webhook/poll dedupe below relies on. `actor` is NOT an
identity field and may differ between the two observations.

## ReviewJob shape

`src/jobs/types.ts` defines `ReviewJob`: the immutable unit of work a
queue/executor would schedule. All fields are `readonly` and required,
with sentinels in the same style as `CanonicalForgeEvent`:

| field | meaning | sentinel |
|---|---|---|
| `jobId` | deterministic generation id (dedupe key) | — |
| `kind` | `review` \| `follow_up` | — |
| `trigger` | producing event's source | — |
| `reason` | producing event's kind | — |
| `platform` | `github` \| `forgejo` | — |
| `installationId` / `repoFullName` | scoping identity | `""` |
| `prNumber` / `prId` | PR identity | `0` |
| `headSha` / `baseSha` | the head the review is about; effective base/merge-base input (lowercase hex) | `""` |
| `configFingerprint` | effective reviewer-config fingerprint: `""` or an 8–64 hex digest | `""` |
| `nonce` | manual forced-rereview nonce | `""` |
| `adoptionEpoch` | operator adoption/config-generation reference layered on the fingerprint (the #728 epoch dimension); changing it re-keys every job for the same head+config | `""` = pre-adoption/absent |
| `eventReference` | the follow-up comment id a `follow_up` job answers (1–19 digits, no leading zero); forced `""` for `review` jobs | `""` |
| `fork` | trust metadata preserved from the event | `false` |
| `deadlineAtMs` | deadline/cancellation identity | `0` = none |
| `runId` | assigned run id | `""` = unassigned |

## Generation identity

`deriveGenerationId` (`src/jobs/generation.ts`) is sha256 over a
canonical serialization — a fixed-order `key=value\n` line per field — of
exactly these twelve **identity fields**:

```
platform, installationId, repoFullName, prNumber, prId,
headSha, baseSha, configFingerprint, kind, nonce,
adoptionEpoch, eventReference
```

**Excluded, deliberately:**

- `source`/`trigger` and `reason` — a webhook observation and a
  reconciliation-poll observation of the same head under the same
  effective config must dedupe to ONE job, and which producing kind
  happened to be observed is routing metadata, not identity.
- `labelName`, `actor`, `draft` — presentation/routing data.

**Included, deliberately:**

- `kind` — a `follow_up` Q&A job and a `review` job for the same
  head/config must never share a generation.
- `nonce` — a manual forced rereview is a new generation of the same
  head.
- `adoptionEpoch` — the operator adoption/config-generation reference
  layered on `configFingerprint` (#728): a disable→re-enable cycle on
  the unchanged head+config hashes back to the same fingerprint, so
  without the epoch it would dedupe to the same job; the operator
  transition must trigger a fresh review.
- `eventReference` — the follow-up comment id: two distinct authorized
  follow-up comments on the same PR must not collapse into one job.
  Forced `""` for `review` jobs, so a review's identity never depends on
  a comment id (webhook/poll/reconcile dedupe of reviews is unchanged).

**Rejected:** if ANY of the twelve identity values, stringified, contains
a `\n` or `\r`, `deriveGenerationId` returns `""` instead of a hash — in
the `key=value\n` join, a newline inside one value can make two distinct
identities serialize to the same bytes and collide their ids.
`buildReviewJob` then refuses to build the job (fail closed).

`buildReviewJob` (same module) constructs the frozen job from a
`CanonicalForgeEvent` plus `BuildJobOptions`, and enforces the
scheduling boundary itself (defense in depth on top of `schedule.ts`):

- terminal/unreviewable kinds (`pr_closed`, `pr_merged`,
  `installation_change`, `visibility_change`, `unknown`) produce no job —
  a job for such a kind would be unreviewable by construction, so the
  builder must not be able to mint one even if a caller bypasses the
  scheduler;
- headSha/baseSha are normalized (trim + lowercase) and any non-empty
  one must match `/^[0-9a-f]{7,64}$/`; the job carries the normalized
  values; review jobs additionally require a non-empty `headSha` (fail
  closed). The normalizers already enforce the SHA form at the adapter
  boundary; this is the builder's own fail-closed guard for hand-built
  events;
- the scoping identity fields are well-formed (the builder's own
  fail-closed guard for hand-built events): `platform` is exactly
  "github" or "forgejo"; `installationId` is a string and, when
  non-empty, matches the canonical `INSTALLATION_ID_PATTERN` form
  imported from the event boundary; `repoFullName` is a non-empty
  string; `prNumber` is a safe integer > 0; `prId` is a safe integer
  >= 0; `fork` is a boolean — a cast-away `undefined` in any of them
  would otherwise serialize as the literal text "undefined" in the
  identity and hash identically to a real value of that text (the same
  "two distinct tuples, one id" class the `\n`/`\r` guard prevents);
- the builder never throws: every option/event value is type-checked
  before it is tested or stored (a SHA is a string; a provided
  nonce/adoptionEpoch/configFingerprint and a follow_up's
  eventReference are a string or a number), so a hostile value (a
  symbol, an object with a throwing `toString`) is refused, not
  coerced;
- a provided nonce for a review job must match `[A-Za-z0-9._-]{1,64}`
  exactly; only the EMPTY string (or absent) is absent (not validated) —
  a numeric 0 is PROVIDED (validates as "0"); a number must be a safe
  integer before pattern/coercion (the event-boundary rule); a
  provided-but-invalid nonce fails the build rather than being silently
  emptied into the identity;
- a provided `adoptionEpoch` (any job kind) must match
  `[A-Za-z0-9._-]{1,64}` exactly; only the EMPTY string (or absent) is
  absent (becomes `""`) — a numeric 0 is PROVIDED; a number must be a
  safe integer before pattern/coercion (the event-boundary rule); a
  provided-but-invalid epoch fails the build rather than being silently
  emptied into the identity;
- a `follow_up` job's `eventReference` is the event's, and must be
  non-empty and match `/^[1-9]\d{0,18}$/` (1–19 digits, no leading
  zero); a number must be a safe integer before pattern/coercion (the
  event-boundary rule); else the build fails — an unidentifiable
  follow-up cannot be safely deduped; a `review` job's is forced `""`
  even if a stray event carries a reference;
- a non-empty `configFingerprint` must be an 8–64 hex digest
  (`/^[0-9a-f]{8,64}$/`); a number must be a safe integer before
  pattern/coercion (the event-boundary rule);
- a provided `deadlineAtMs` must be a safe integer >= 0;
- the build fails when `deriveGenerationId` returns `""` (an identity
  value containing a `\n`/`\r`);
- the `runId` is sanitized (trim; `""` when empty, >128 chars, or
  containing a control character) so the durable payload carries a clean
  reference;
- `check_update` producing a review job is intended: a relevant CI
  update re-triggers the review. A check-reference entry may carry FLAT
  `head_sha`/`base_sha` instead of nested `head`/`base` objects (a
  nested SHA wins only when it is well-formed; a malformed nested SHA
  falls back to the flat field, which is form-checked too), and such
  flat entries carry no repo names, so the fork rule conservatively
  reports a fork — this is what makes the re-trigger reachable from a
  real payload.

`shouldSchedule` (`src/jobs/schedule.ts`) is the single scheduling
policy: true for `pr_opened`, `pr_reopened`, `synchronize`,
`ready_for_review`, `rereview_label`, `reconciliation_poll`,
`check_update` — and every scheduleable kind additionally requires a
resolvable PR number (`prNumber > 0`), so a headless `check_update`
(a CI check event with no resolvable PR) creates NO generation; false
for the rest — including `follow_up`, which is not a VERDICT review (it
becomes a `follow_up` job via `buildReviewJob` but is never a candidate
for the review generation a verdict is published against).

## Manual rereview nonce

A manual forced rereview passes a `nonce` in `BuildJobOptions`. Because
`nonce` is an identity field, a valid nonce mints a new generation id for
the same head/config — the dedupe key changes, so the forced rereview is
never skipped as "unchanged". The same nonce twice is idempotent (same
id); a different nonce is a different generation. An EMPTY nonce is
treated as absent (not validated, builds the plain job). The strict
`[A-Za-z0-9._-]{1,64}` bound on non-empty values keeps the identity free
of arbitrary text.

## follow_up isolation

A `follow_up` (Q&A on an existing review) builds a `follow_up` job that
must never mutate the managed review/verdict of the `review` job. The
isolation is structural: `kind` is an identity field, so the two job
kinds for the same head/config can never share a `jobId`; the nonce is
ignored for `follow_up` jobs (a valid one is dropped, an invalid one
does not fail), so Q&A can never bump a review generation; and
`eventReference` is an identity field for `follow_up` jobs (the comment
id they answer) while forced `""` for `review` jobs — distinct
authorized follow-up comments on the same PR each mint their own job,
while a stray reference on a review event changes nothing.

The real GitHub `issue_comment` payload carries `issue.pull_request` as
`{ url }` only — the PR number comes from `issue.number`, and no
head/base SHAs are present in it, so a `follow_up` job's `headSha` is
`""` at webhook time and is NOT required (unlike `review` jobs, which
fail closed without a head); the platform adapter hydrates the head/base
SHAs later. The `comment.id` of the follow-up is captured at the adapter
boundary as the canonical `eventReference` (1–19 digits, no leading zero;
`""` sentinel) in both the GitHub `issue_comment` and the Forgejo
`comment` envelope.

## Staleness

`src/jobs/staleness.ts` generalizes the exact-head rule the pipeline
already enforces at two points: the precheck's superseded-head guard
(`src/precheck/decide.ts` — an event head different from the live PR
head skips the review) and the publication-boundary head re-check
(`src/publish/publish.ts` — the head is re-fetched and a mismatch
refuses publication). The contract form:

- `isResultStale(resultHeadSha, currentHeadSha)` — both sides are
  trimmed and lowercased; true when they then differ, or **either side
  fails the SHA form** `/^[0-9a-f]{7,64}$/` (fail closed: an empty or
  malformed head means freshness is unknowable).
- `resultMatchesJob(job, resultHeadSha, currentHeadSha)` — false unless
  the result is fresh AND its head is the job's own head; the controller
  passes the freshly fetched current head, so it decides staleness
  without trusting the worker.
- `isExpired(job, nowMs)` — `deadlineAtMs` 0 never expires; otherwise
  `nowMs >= deadlineAtMs`; a non-finite clock (`NaN`, `±Infinity`)
  fails closed (the job is treated as expired).

## Secrets policy

Durable job payloads carry **references only**: no long-lived secrets in
any persisted event/job field. `configFingerprint` is a hash of the
effective reviewer config (the same value the precheck config hash
produces), never the config itself; credentials travel only through the
HTTP auth headers of the typed transport, as everywhere else in the
runtime.

## #728 acceptance mapping

| criterion | where |
|---|---|
| webhook + poll of the same PR/config dedupe to one job id; only reason/trigger differ (through the REAL normalizers, same installationId) | `normalizeGitHubEvent` + `reconciliationPollEvent` + `buildReviewJob`; test "webhook and poll … identical jobs" |
| new headSha / new configFingerprint ⇒ new id | `deriveGenerationId`; tests "a new headSha …", "a different configFingerprint …" |
| each of the twelve identity fields, varied alone ⇒ distinct id | `deriveGenerationId`; test "each of the twelve identity fields …" |
| irrelevant kinds (pr_closed, unknown, visibility_change, …) schedule nothing and build nothing | `shouldSchedule` + `buildReviewJob`; test "irrelevant events …" |
| headless check_update (no PR number) ⇒ no generation | `shouldSchedule`; test "a headless check_update …" |
| same head/config: rereview_label ≡ synchronize id; manual nonce breaks it | `deriveGenerationId` (reason out, nonce in); tests "rereview_label and synchronize …", "a manual forced rereview …" |
| nonce semantics: empty = absent, stable per nonce, distinct per nonce, invalid/65-chars ⇒ null | `buildReviewJob`; tests "an empty nonce is ABSENT …", "an invalid provided nonce …" |
| adoptionEpoch: disable→re-enable on the unchanged head+config re-keys the generation; empty = absent, invalid/newline/65-chars ⇒ null | `buildReviewJob`; tests "disable→re-enable: …", "an empty adoptionEpoch is ABSENT …", "an invalid provided adoptionEpoch …" |
| follow_up: own job kind, nonce ignored, id never collides with a review job; `""` head not required | `buildReviewJob`; tests "follow_up job: …", "buildReviewJob normalizes head/base SHAs …" |
| follow_up eventReference: distinct comment ids ⇒ distinct ids; same id any source dedupes; `""`/`0`/`-5`/`abc`/newline/20-digits ⇒ null; review jobs forced `""` (stray reference changes nothing) | `buildReviewJob`; tests "follow_up: two events differing only by eventReference …", "follow_up: the same comment id from webhook and poll …", "follow_up: an empty or invalid eventReference …", "review jobs force eventReference …" |
| fork metadata preserved | `buildReviewJob`; test "event fields (including fork) …" |
| SHA form: builder normalizes trim+lowercase, fails closed on malformed; 10KB headSha ⇒ null | `buildReviewJob`; tests "buildReviewJob normalizes head/base SHAs …", "a 10KB headSha …" |
| newline/CR in an identity value ⇒ empty id ⇒ no job | `deriveGenerationId` + `buildReviewJob`; test "a newline/CR in any identity value …" |
| `__proto__`-keyed event: no throw, no Object.prototype pollution | `buildReviewJob` + `deriveGenerationId`; test "a `__proto__`-keyed event object …" |
| configFingerprint form (8–64 hex) and deadlineAtMs bounds (safe integer >= 0) | `buildReviewJob`; tests "a non-empty configFingerprint …", "a provided deadlineAtMs …" |
| staleness: stale on differ/malformed/empty, case-insensitive, job match, deadline expiry | `staleness.ts`; tests "isResultStale …", "resultMatchesJob …", "isExpired …" |
| malformed event (review intent, missing head) ⇒ null | `buildReviewJob`; test "a review-kind event without a headSha …" |
| serialization format pinned | `deriveGenerationId`; test "deriveGenerationId pins the canonical serialization" |
