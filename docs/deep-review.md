# Deep review (specialist leads)

Deep review runs up to three fixed specialist passes — `correctness`, `security`, `tests` — as a bounded advisory layer alongside the final review. Each role works from a small, deterministic corpus built once per review and returns structured leads; the final reviewer verifies every lead against the PR/repo evidence before it can affect a finding, and a lead never sets the verdict by itself.

`deep-review` takes three values (case-insensitive): **`auto`** (the v3 default), `true`, or `false`. This page covers `auto` first since it's what you get out of the box.

## Auto mode: how roles are selected

In `auto`, role selection is a pure lookup over classification data the pipeline already computed before the specialist phase — `pr_kind`, `risk_flags`, and the changed-file list. No model call, no network. Identical inputs always produce the identical selection. The logic lives in `src/classification/role-selection.ts`; `pr_kind` and `risk_flags` are produced by `src/classification/classify.ts`.

`pr_kind` is a single value from a fixed, precedence-ordered rule table (first match wins), falling back to `app_code` when nothing else matches:

`renovate_digest_only`, `image_digest_only`, `dependency_upgrade`, `k8s_manifest`, `secret_handling_changes`, `db_or_migration_changes`, `auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `app_code` (default).

`risk_flags` is a set of zero or more additional signals: `linked_security_issue`, `linked_audit_issue`, `linked_priority_p0`, `linked_priority_p1` (from linked-issue labels, or Linear priority 1/2), plus `file_serving_changes`, `path_handling_changes`, `auth_changes`, `secret_handling_changes` when those patterns match the diff content as well as (or instead of) the filename.

### Selection table

| Role | Selected when `pr_kind` is... | ...or `risk_flags` includes |
| --- | --- | --- |
| `correctness` | `app_code`, `k8s_manifest` | `linked_priority_p0`, `linked_priority_p1` |
| `security` | `auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes` | `linked_security_issue`, `linked_audit_issue`, `auth_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes` |
| `tests` | `dependency_upgrade`, `db_or_migration_changes` | — |

A PR can match several lanes and select several roles. There's one additional, independent force-on: if the PR's non-test source footprint is substantial (a new non-test source module, or over 200 non-test source lines changed — `SUBSTANTIAL_SOURCE_LINE_THRESHOLD` in `classify.ts`), `correctness` runs regardless of which lane matched. This closes a gap where a real, sizable change classified only on a content-only `file_serving_changes`/`path_handling_changes` match (too weak to route on by itself) could otherwise skip correctness entirely (#871).

### Zero-selection gates

Zero selection only ever happens through one of three explicit, documented trivial gates — all require `risk_flags` to be empty:

1. **`renovate_digest_only` with no risk flags** — a lockfile digest bump with no version change and no risk signal.
2. **`image_digest_only` with no risk flags** — an image-reference-only change (YAML `image:`/`tag:`, compose, Dockerfile `FROM`) where every changed line keeps its repository and tag and only the `@sha256:` digest differs.
3. **`app_code` with no risk flags, where every changed file is in the enumerated trivial class** — `docs/`, prose extensions (`.md`, `.rst`, `.txt`, ...), license/contributor/bot-config files, and a specific inert subset of `.github/` (issue templates, `CODEOWNERS`, `dependabot.yml`, `FUNDING.yml`). This gate only applies when the changed-file list is under the classifier's 50-file summary cap — a capped (truncated) list can't prove every file is trivial, so it doesn't fire. Unknown `.github/**` content (workflows, actions, anything not explicitly enumerated) is treated as non-trivial on purpose.

### Unknown kinds and conservative fallback

Any time the classifier gives no deterministic basis to skip a role, auto fails toward **more** scrutiny, never less:

- Missing/malformed classification, or the classifier's own `unknown`-kind failure placeholder → all three roles run.
- A usable `pr_kind` that matches no lane (e.g. a future classifier value) → all three roles run.
- Linked-issue or Linear metadata that was expected but couldn't be determined (a failed lookup) → all three roles run, since a missing signal must never be read as an absent one.

### Worked examples

| PR | `pr_kind` | `risk_flags` | Result |
| --- | --- | --- | --- |
| Docs-only edit (`docs/foo.md`, `README.md`) | `app_code` (no other rule matches) | none | **Zero selection** — docs/meta-only trivial gate |
| Edit to `src/auth/login.ts` | `auth_changes` | `auth_changes` | `security` selected; `correctness`/`tests` skipped unless the diff is also substantial (#871) |
| Renovate PR bumping only `package-lock.json` hashes | `renovate_digest_only` | none | **Zero selection** — digest-only trivial gate |
| Renovate PR refreshing only an image `@sha256:` digest in a HelmRelease | `image_digest_only` | none | **Zero selection** — image-digest-only trivial gate |
| New 300-line non-test module, e.g. `src/platform/foo.ts` | `app_code` | none | `correctness` selected (direct `app_code` match, reinforced by the #871 substantial-change force-on); `security`/`tests` skipped |

## Where to see the decision

Every run records the mode and the per-role reasoning in `specialists.json`: `deep_review_mode`, and a `selection` object with `selected_roles`, `skipped_roles`, and per-role `decisions` (each with the matched signals and a human-readable reason). The job step summary also shows the selected/skipped counts for auto-mode runs. Skipped roles are telemetry, not failures: they never produce a `specialist-<role>.json`, never set `any_errors`, and never appear in the leads section of the review corpus.

## Cost and limits

| Input | Default | What it bounds |
| --- | --- | --- |
| `deep-review-timeout-sec` | `600` | Wall-clock budget for the whole specialist phase (selected roles run concurrently). A straggler past the deadline is recorded as an error on its own artifact; it never blocks or fails the review. |
| `deep-review-max-tokens` | `4096` | Completion tokens per specialist role — independent of `ai-max-tokens`, since a specialist returns a short structured lead list, not a full review. |
| `deep-review-corpus-max-bytes` | `48000` | Hard byte cap on the shared specialist corpus (PR metadata, classification, changed files, diff, capped standards, requirement ledger, related-code, evidence/CI), built once and reused by every selected role. |

When `deep-review` is enabled, the specialist passes run **concurrently with the CI wait**, not after it — both branches fork after the unchanged-review precheck and join before the final reviewer starts, so wall clock is closer to `max(CI, specialists)` than their sum. A CI timeout/failure never blocks the review, and specialists stay advisory and fail-soft either way.

## `true` / `false` overrides

- `deep-review: true` runs all three roles unconditionally — no classification-based selection, the v2.5 behavior.
- `deep-review: false` disables the phase entirely. No specialist corpus is built and the review corpus stays byte-identical to a build without deep review at all.

## How leads are used

Specialist leads are **advisory only**. The final reviewer:

- verifies each lead against the PR and repository evidence before adopting it, and discards any it can't support;
- merges overlapping leads across roles;
- never raises or escalates an issue merely because a specialist flagged it — a specialist's severity is capped below a blocker (specialist `major` is never treated as `blocker`);
- keeps sole ownership of the verdict, the findings schema, and enforcement policy.

Leads render into a bounded **Specialist Review Leads** corpus section only when at least one usable lead survives; the final-review guidance that references them is gated on that same presence signal, so the guidance is never shown without the section actually reaching the model.

## Fingerprinting

The `deep-review` value (`false`/`true`/`auto`) is part of the config fingerprint, so switching between modes invalidates a stale managed comment. In `auto` mode, selection also depends on inputs the diff fingerprint alone can't see — linked-issue labels and Linear priority/labels — so the precheck separately hashes a bounded selection signature (PR title + body + linked refs' labels + configured Linear priority/labels) into the fingerprint. If any of those lookups fails, the run forces a fresh review rather than risk silently reusing a stale decision.
