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
| `--max-prs` | Per-repo PR cap (default 100). |
| `--max-pages` | Page-walk bound per list read (default 20); truncation is reported in `collection.truncated`, never silently trusted. |
| `--per-page` | Page size (default 100). |
| `--out PATH` | JSON report path (default: stdout only). |
| `--from-json PATH` | Offline mode: replay a fixture of the same records the forge calls would return; bypasses all network. |
| `--attestations PATH` | Optional JSON array of trusted-review attestation records `{"conclusion","reason_code","head_sha"}`, attached per head as additional trusted evidence only. |
| `--adjudications PATH` | Optional JSON array of human-label records `{"pr": N, "head_sha": "...", "label": "missed_blocker"\|"false_blocker"}`; the only input of the `correctness` rollup. |

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
`created_at`, `action_version` (parsed from the engine line; `unknown`
when absent), `review_result`, `coverage`, `required_checks`,
`incomplete_reason`, `tool_stop_reason`, `review_route`,
`verdict_prose` (a model verdict text claim from a marker verdict-like
field, read defensively: the marker schema the action ships today
(`docs/telemetry.md`) defines no verdict key, so on organic data this is
always null — it is recorded, **never trusted**, if a future schema adds
one), `native_event`
(APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED or null),
`native_event_bound` (native `commit_id` equals the row head and is
non-null), `attestation_conclusion`/`attestation_reason_code` (when an
attestation record matches the row head), `disposition`, `superseded_head`
(a later head exists on the PR at collection time), `rerun_of` (prior
attempt's id at the *same* head, same source kind), `raw_link`.

## Disposition taxonomy

Per-row, mutually exclusive:

| Disposition | Meaning |
| --- | --- |
| `skipped` | Marker present and the body's own header/note says the run was a carried skip (`**AI PR Review skipped:**`). |
| `trusted_complete_approval` | The full metric invariant held (below). |
| `complete_findings` | Marker `review_result` is `findings` or `issues` — a completed review with open findings. |
| `partial_or_abstained` | Incomplete/unsafe telemetry: `review_result: partial`, `coverage` partial/unknown, `required_checks: incomplete`, or an unbound marker head — **even with a native APPROVED or a model approve-prose claim**. |
| `failed_or_unavailable` | Marker present but no usable `review_result`. |
| `unknown_no_marker` | No parseable marker (the default heuristic — a missing signal is never upgraded). |
| `unknown_missing_native` | Marker complete and `review_result: clean`, but neither a proven native approval nor a head-bound approval attestation exists. |

### Metric invariant

`trusted_complete_approval` requires **all** of:

1. a parseable marker with `head_sha` neither empty nor `"unknown"`;
2. `review_result == "clean"`;
3. no `coverage` of `partial`/`unknown`;
4. `required_checks` not `incomplete`;
5. proven native evidence — a native APPROVED event by a configured bot
   login with non-null `commit_id` equal to the row's head — **or** a
   head-bound attestation with `conclusion == "approved"`.

Consequently: a model approve-prose claim plus `review_result: partial`
is never trusted; a native APPROVED over partial/unknown coverage is
`partial_or_abstained`; comment prose alone (no native event, no
attestation) is `unknown_missing_native`; and a missing marker is
`unknown_no_marker` no matter what workflow context suggests. There is no
workflow-success short circuit and no comment-prose short circuit.

## Rollups

Two separate keys, never merged:

- **`operational_completion`** — counts of review attempts by disposition,
  with breakdowns by `incomplete_reason`, `required_checks`,
  `tool_stop_reason`, `review_route` (an absent route value buckets under
  its real name, `legacy` — the fallback route), and `action_version`; an
  explicit `denominators` object (total attempts, eligible attempts,
  attempts with a marker, attempts with a native event, attempts with
  unknown/missing telemetry) and `missing_data` counts. The summary text
  states the denominators: a small sample is a count, never proof of a
  completion rate.
- **`correctness`** — computed **only** from `--adjudications` records:
  `missed_blockers`, `false_blockers`, `adjudicated_total`,
  `unknown_excluded` (unknown labels and records matching no collected
  row), plus `precision` and `recall` over the adjudicated rows only
  (`None` when nothing was adjudicated). Correctness is never inferred
  from comments resolved, merge state, CI green, or model agreement.
