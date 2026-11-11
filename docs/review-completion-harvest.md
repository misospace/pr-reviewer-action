# Review-completion harvest (#1602)

A read-only, offline-analyzable collector for **organic review completion
metrics**. It harvests what the action already published — the
`ai-pr-reviewer` metadata marker ([`docs/telemetry.md`](telemetry.md)), the
`_Analysis engine: … · pr-reviewer-action vX.Y.Z_` body line, native review
events, and optionally trusted-review attestations — into one normalized
row per eligible (head, review attempt) plus two rollups, **without
re-running any model**.

- Core (pure, stdlib-only, no I/O): `pr_reviewer/review_completion.py`
- CLI (thin adapter over the configured forge capability):
  `scripts/harvest_review_completion.py`
- Offline fixture: `tests/fixtures/review-completion/organic-fixture.json`
- Tests: `tests/test_review_completion.py`

## What it must never do

By construction, this collector:

- never calls a model or a provider — it only reads published artifacts;
- never schedules anything and never mutates forge state (reads only);
- never closes or edits #1563 and never posts anything automatically;
- never writes raw comment/review bodies, secrets, or tokens into the
  report — only parsed, bounded fields and HTML links (the forge module
  already refuses credential reflection; the CLI refuses a serialized
  report that carries the configured credential, so a hostile forge that
  reflects the bearer token back as a SHA or a URL fails closed).

## CLI usage

```bash
python3 scripts/harvest_review_completion.py \
  --repo misospace/pr-reviewer-action \
  --bot-login myoshia[bot] \
  --since 2026-10-01 \
  --out review-completion.json
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--repo OWNER/NAME` | Repository to harvest (repeatable). |
| `--since` / `--until` | `YYYY-MM-DD`; filters on PR `updated_at`. The PR-list walk stops at the first PR older than `--since` (newest-updated first). |
| `--bot-login` | Reviewer bot login (repeatable). Defines whose records are attempts and enables native-event attribution. Without it, attempt authorship cannot be attributed, so the collector fails closed with zero rows — bot identity is an input, never hardcoded or inferred from a marker. |
| `--action-version` | Action version token in scope, e.g. `3.5.0` or `v3.5.0` (repeatable). Keeps only the rows published by that version; a row whose version is `unknown` is excluded, because it cannot be proven to be in scope. The token is at most 32 characters (`ACTION_VERSION_LIMIT`, the bound the published version is truncated at), so a longer token is rejected before the run starts. |
| `--max-prs` | Per-repo PR cap (default 100). |
| `--max-pages` | Page-walk bound per list read (default 20); truncation is reported in `collection.truncated`, never silently trusted. |
| `--per-page` | Page size (default 100). |
| `--out PATH` | JSON report path (default: stdout only). |
| `--from-json PATH` | Offline mode: replay a fixture of the same records the forge calls would return; bypasses all network. |
| `--attestations PATH` | Optional JSON array of trusted-review attestation records `{"conclusion","reason_code","head_sha","review_id"?}`. A record with `review_id` is evidence only for that native review row (at a consistent head); a head-only record is evidence only when exactly one collected attempt binds that head, so the binding is unambiguous. A `null` `review_id` reads as absent; a record whose `review_id` is present with any non-integer value is poisoned and certifies nothing — it never silently becomes head-scoped evidence. Never borrowed across attempts sharing a head; additional trusted evidence only. |
| `--adjudications PATH` | Optional JSON array of human-label records `{"pr": N, "head_sha": "...", "label": "confirmed_blocker"\|"missed_blocker"\|"false_blocker"}`; the only input of the `correctness` rollup. |

Forge reads go exclusively through `pr_reviewer.forge.ForgeClient`
(`default_forge()`) on `repos/{owner}/{repo}/pulls`,
`repos/{owner}/{repo}/pulls/{n}/reviews`, and
`repos/{owner}/{repo}/issues/{n}/comments`. The script never shells out to
a forge CLI, never hand-rolls `urllib`, and never accepts a token as an
argument.

## Offline mode

```bash
python3 scripts/harvest_review_completion.py \
  --from-json tests/fixtures/review-completion/organic-fixture.json \
  --bot-login 'myoshia[bot]'
```

The fixture mirrors this repository's organic history (PRs #1579, #1580,
#1585, #1586 outcome shapes): `{"repos": [{"full_name", "pulls": [{"number",
"head_sha", "updated_at", "reviews": [...], "comments": [...]}]}],
"attestations": [...], "adjudications": [...]}`. Offline runs are
deterministic — the report carries no run-generated timestamps (the only
times in it are the replayed records' own `created_at` values) — which is
what makes the pipeline testable without any forge.

## Row semantics

One normalized row per eligible (head, review attempt): every native
review and issue comment authored by a configured bot login. Rows dedupe
idempotently on `(repo, pr, review_id, head_sha)` — a sticky comment has
no native review id, so its own comment id stands in for `review_id` in
that slot, keeping distinct attempts distinct while a re-run reproduces
exactly the same keys.

Fields: `repo`, `pr`, `head_sha`, `review_id` (native review id, or null
for a sticky comment), `source` (`native_review` | `comment`),
`created_at`, `action_version` (parsed from the engine line — the engine
name is a model identifier and may itself contain underscores; the
version token ends at whitespace or the closing underscore — the
publisher's own spelling, for example `v3.5.0`; `unknown` when absent),
`review_result`, `coverage`, `required_checks`,
`incomplete_reason`, `tool_stop_reason`, `review_route`,
`verdict_prose` (a model verdict text claim from a marker verdict-like
field, read defensively: the marker schema the action ships today
(`docs/telemetry.md`) defines no verdict key, so on organic data this is
always null — it is recorded, **never trusted**, if a future schema adds
one), `native_event`
(APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED or null — only a native
review row reports an event, and it reports its own: another attempt's
event at the same head is never this row's, and a comment row never
reports `APPROVED`),
`native_event_bound` (native `commit_id` equals the row head and is
non-null), `attestation_conclusion`/`attestation_reason_code` (when an
attestation record is correlated with this attempt — by `review_id`, or
by head when exactly one collected attempt binds that head),
`disposition`, `head_conflict`
(the native review's `commit_id` and its marker's `head_sha` are both
bound and disagree — the row's two supplied head identities contradict
each other), `superseded_head`
(a later head exists on the PR at collection time), `rerun_of` (prior
attempt's id at the *same* head, same source kind), `raw_link`.

## Action-version scope

`--action-version` narrows the collected rows after the collection and
before the rollups, so every denominator in the report describes the
scoped population. Two report fields say what the scope did:

- `collection.scope.action_versions`: the requested scope as the
  normalized tokens that were applied. Normalizing strips surrounding
  whitespace, strips one leading `v` or `V`, and lowercases the rest, so
  `3.5.0`, `v3.5.0` and `V3.5.0` are the same token. This list is the
  scope that was applied: the report never names a scope the run did not
  apply. A token that normalizes to an empty string stays in the list as
  an empty token, because it was requested and named no version.
- `collection.scope.excluded`: the attempts the scope excluded, by
  reason, and only the reasons that occurred:
  - `action_version_unknown`: the row carries no usable version, so it
    cannot be proven to be in scope. That is a row whose published body
    has no engine line, so its version is `unknown`.
  - `action_version_other`: the row carries a known version that is not
    one of the requested tokens.

The comparison is normalized on both sides; the row itself keeps the
publisher's own spelling of the version (`v3.5.0`), in the row's
`action_version` and in the `by_action_version` breakdown. A scope token
that normalizes to an empty string (for example `v`, or a blank token)
names no version, so it keeps no row: the run fails closed instead of
reading an empty scope as "everything". A scope with no token at all is
no scope: every row is kept and nothing is excluded. Through the CLI a
blank token never reaches this point, because the token grammar rejects
it first.

## Disposition taxonomy

Per-row, mutually exclusive:

| Disposition | Meaning |
| --- | --- |
| `skipped` | Marker present and the body's own header/note says the run was a carried skip (`**AI PR Review skipped:**`). |
| `trusted_complete_approval` | The full metric invariant held (below). |
| `complete_findings` | Marker `review_result` is `findings` or `issues` — a completed review with open findings. |
| `partial_or_abstained` | Incomplete/unsafe telemetry: `review_result: partial`, `coverage` partial/unknown, `required_checks: incomplete`, an unbound marker head, or a marker head that contradicts the row's head (`head_conflict`) — **even with a native APPROVED or a model approve-prose claim**. |
| `failed_or_unavailable` | Marker present but no usable `review_result`. |
| `unknown_no_marker` | No parseable marker (the default heuristic — a missing signal is never upgraded). |
| `unknown_missing_native` | Marker complete and `review_result: clean`, but no approval evidence correlated with this attempt exists (its own proven native APPROVED, or a correlated approval attestation). |

### Metric invariant

`trusted_complete_approval` requires **all** of:

1. a parseable marker with `head_sha` neither empty nor `"unknown"`;
2. every independently supplied head identity agrees: when the native
   review carries a bound `commit_id` and the marker carries a bound
   `head_sha`, they must be equal (compared exactly — a case or width
   difference is not agreement and fails closed) — a disagreement
   (`head_conflict`) is unsafe telemetry, and a clean marker for one
   head riding a review bound to another head proves nothing about
   either head;
3. `review_result == "clean"`;
4. no `coverage` of `partial`/`unknown`;
5. `required_checks` not `incomplete`;
6. evidence correlated with the specific published attempt: either the
   row's OWN native review event — APPROVED by a configured bot login,
   non-null `commit_id` equal to the row's head, own marker binding no
   different head — **or** an attestation record with
   `conclusion == "approved"` bound to this attempt (`review_id`, or a
   head-only record where the head has exactly one collected attempt).
   A bot APPROVED from a different review at the same head proves only
   that attempt, never this row; rows are per (head, review attempt), so
   same-head evidence is not per-attempt proof.

Consequently: a model approve-prose claim plus `review_result: partial`
is never trusted; a native APPROVED over partial/unknown coverage is
`partial_or_abstained`; a marker riding a review bound to a different
head is `partial_or_abstained` with `head_conflict: true` — the
disagreement outranks every evidence path (attestation included) and
applies to every `review_result`, so a findings marker on a
contradictory head is not `complete_findings` either, and a
self-contradicting APPROVED is not evidence for a sibling comment row;
comment prose alone (no native event, no attestation) is
`unknown_missing_native`; and a missing marker is `unknown_no_marker` no
matter what workflow context suggests. There is no workflow-success
short circuit and no comment-prose short circuit.

### Attempts that publish nothing

The attempt kinds whose review outcome is unobservable are named in
`collection.policy.unobservable_attempts`: `canceled_job`, `never_run`,
and `skipped_run`.

- `canceled_job` and `never_run`: a canceled job and a job that never
  ran publish nothing at all. They leave no row, so they are never
  folded into a disposition and are never counted.
- `skipped_run`: a skipped run publishes no review artifact. Its skip
  note goes to the step summary only, so no published body carries it
  and the `skipped` disposition does not fire on organic published
  data. Two paths post a bot-authored reply comment instead of a review:
  the fork-PR skip reply (`src/run/action.ts`) and a follow-up answer
  (`src/followup/reply.ts`). Neither reply body carries the
  `ai-pr-reviewer` metadata marker nor the engine line, so the collector
  records those replies as rows with the `unknown_no_marker` disposition
  and the action version `unknown`. Such a row counts as unknown
  telemetry, never as a completed review.

The collector reads published artifacts only and never reads workflow or
check status, so it cannot tell a canceled job from a job that never
ran and never claims it did.

## Rollups

Two separate keys, never merged:

- **`operational_completion`** — counts of review attempts by disposition,
  with breakdowns by `incomplete_reason`, `required_checks`,
  `tool_stop_reason`, `review_route` (an absent route value buckets under
  its real name, `legacy` — the fallback route), and `action_version`; an
  explicit `denominators` object (`total_attempts`, `eligible_attempts`,
  `attempts_with_marker`, `attempts_with_native_event`,
  `attempts_with_unknown_or_missing_telemetry`, `scoped_out_attempts`)
  and `missing_data` counts. `total_attempts` counts the attempts that
  stayed inside the requested scope, and `scoped_out_attempts` counts
  the attempts that scope excluded (0 when no scope was requested).

  The summary text states the denominators in prose: the collected total
  (the attempts collected before the scope filter), the eligible count,
  and the marker, native-event and unknown/missing-telemetry counts. A
  small sample is a count, never proof of a completion rate. The summary
  also states that attempts which published nothing are not counted,
  because this collector reads published artifacts only, and, when a
  version scope was requested, how many attempts that scope excluded.
- **`correctness`** — computed **only** from `--adjudications` records
  matched to collected rows by `(pr, head_sha)`. The three known labels
  are `confirmed_blocker` (a human confirmed the attempt reported a real
  blocker), `missed_blocker` (a human confirmed the attempt missed a real
  blocker), and `false_blocker` (a human confirmed the attempt reported a
  blocker that was not real).

  The unit is the **head**, not the attempt. An adjudication record
  names a head, so one record applies to every attempt at that head, and
  two attempts at one head (a rerun) share the adjudication key. One
  effective label per head: several records for the same head with the
  same known label count once, while records for the same head with
  different known labels are contradictory, so that head leaves every
  count and denominator and is counted once in `contradictory_excluded`.

  The fields are `confirmed_blockers`, `missed_blockers`,
  `false_blockers`, `adjudicated_heads` (the heads with one effective
  known label), `unknown_excluded` (the excluded **records**: a label
  outside the known vocabulary, a record matching no collected head, and
  a record that is not a record at all), `contradictory_excluded` (the
  excluded **heads**), `precision`, and `recall`, where
  `precision = confirmed / (confirmed + false_blockers)` and
  `recall = confirmed / (confirmed + missed_blockers)`, each `None` when
  its denominator is zero. The two exclusion counters never mix units: a
  head is not counted as a record, and a record is not counted as a
  head. Correctness is never inferred from comments resolved, merge
  state, CI green, or model agreement.
