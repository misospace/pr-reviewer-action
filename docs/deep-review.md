# Deep review (specialist leads)

Deep review runs up to three fixed specialist passes — `correctness`, `security`, `tests` — as a bounded advisory layer alongside the final review. Each role works from a small, deterministic corpus built once per review and returns structured leads; the final reviewer verifies every lead against the PR/repo evidence before it can affect a finding, and a lead never sets the verdict by itself.

`deep-review` takes three values (case-insensitive): **`auto`** (the v3 default), `true`, or `false`. This page covers `auto` first since it's what you get out of the box.

## Auto mode: how roles are selected

In `auto`, role selection is a pure lookup over classification data the pipeline already computed before the specialist phase — `pr_kind`, `risk_flags`, and the changed-file list. No model call, no network. Identical inputs always produce the identical selection. The logic lives in `src/classification/role-selection.ts`; `pr_kind` and `risk_flags` are produced by `src/classification/classify.ts`.

`pr_kind` is a single value from a fixed, precedence-ordered rule table (first match wins), falling back to `app_code` when nothing else matches:

`renovate_digest_only`, `image_digest_only`, `renovate_image_update`, `renovate_chart_update`, `dependency_upgrade`, `k8s_manifest`, `secret_handling_changes`, `db_or_migration_changes`, `auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `app_code` (default).

`renovate_image_update` (#1336) is a Renovate-authored refresh of image tags/digests in YAML/Dockerfile manifests; `renovate_chart_update` is a Renovate-authored Helm chart/`appVersion` version bump (every changed file is chart-bearing on its own: a `helmrelease.yaml`/`Chart.yaml`-shaped name, or the file's own diff region carrying a `kind: HelmRelease`/`helm.toolkit.fluxcd.io` marker — a marker in a sibling file's region blesses nothing). Both require forge-reported Renovate authorship — a login starting with `renovate` (`renovate[bot]`, `renovate-bot`, …) or a `renovate/` head branch — and a pure diff: every changed line is an image reference or chart-version key whose surrounding bytes and (where named) repository are unchanged — a bare `tag:` value carries no repository and never reads as one. For a chart-version key the VALUE is the only thing that may change: indentation, key, separator and quoting are held fixed, so a re-indent or a quote-style change travelling with the bump disqualifies the kind. A human edit, a mixed diff, or a renamed chart keeps the pre-existing kinds. Documented residual risk (#1336 review): both authorship signals are author-chosen strings — a human PR from a `renovate/` branch with a pure image-tag refresh reaches the benign zero-selection gate. That is accepted on purpose: the pure-diff requirement is the load-bearing guard (any other change in the diff disqualifies the kind), so the gate can only ever bless an update whose every changed line is a version bump.

`risk_flags` is a set of zero or more additional signals: `linked_security_issue`, `linked_audit_issue`, `linked_priority_p0`, `linked_priority_p1` (from linked-issue labels, or Linear priority 1/2), plus `file_serving_changes`, `path_handling_changes`, `auth_changes`, `secret_handling_changes` when those patterns match the diff content as well as (or instead of) the filename, plus `dependency_security_sensitive` (#1336) — a bounded dependency-update escalation that fires only on known-fact triggers: a paired image reference whose registry/repository changed (unknown upstream provenance, any authorship — the scan pairs what parses cleanly and is never aborted by unrelated diff content), or — inside a dependency-update PR (Renovate-authored or an update kind) — a forge-reported title carrying `CVE-…`/`GHSA-…`/"security", or a security-infrastructure component in a changed image repository or changed path. The component vocabulary is a closed exact-token list (`auth`, `oauth`, `oidc`, `saml`, `sso`, `proxy`, `gateway`, `ingress`, `traefik`, `nginx`, `caddy`, `haproxy`, `envoy`, `vpn`, `wireguard`, `tailscale`, `cloudflared`, `vault`, `sops`, `cert`, `certs`, `certificate`, `certbot`, `certmanager`, `secret`/`secrets`, `keycloak`, plus named compounds `authelia`, `authentik`, `auth0`, `oauth2`, `oauth2proxy`, `vaultwarden`). Matching is exact-token: any non-alphanumeric character separates tokens (`oauth2-proxy` → `oauth2`, `proxy`), so a token that is *not* on the list — `author` — never fires; only the listed tokens do (`certs` and `certificate` are on it: certificate material is the secret-handling class this trigger exists for). It never infers vulnerabilities from image contents.

### Untrusted PR metadata

The Renovate-update rules read three forge-reported PR fields: the author login, the head branch, and the PR title. All three are untrusted data — the title is author-influenced text, the login and the branch are author-chosen strings — and the classifier treats them as data, never instructions:

- the metadata boundary (`classifyPrMetadata` in `src/classification/classify.ts`) reduces all three to the two booleans the rules need: the title is read against the closed advisory vocabulary (`CVE-…`/`GHSA-…`/"security"), the login and the branch against the closed Renovate-authorship prefixes. The classifier retains no untrusted text, so the metadata can neither close a fence nor carry itself into an artifact, a log line, or the prompt through this path — the classifier emits closed values only (`pr_kind`, risk-flag names, changed-file paths);
- the title is read in full: a bounded projection would let an author pad the title past the bound and suppress the advisory signal, so the signal is never traded away for a smaller working set;
- the identity strings are not normalized (a padded login is still not Renovate-authored), and the authorship prefixes stay author-chosen strings — the residual risk documented above; the pure-diff requirement is the load-bearing guard for the kinds they gate.

Elsewhere in the pipeline the title does reach the model, inside the repo's existing untrusted-data boundary: the corpus renders the `# PR Metadata` projection as a fenced JSON section (`src/corpus/assemble.ts`), the confidence prompt wraps its untrusted sections in an explicit `<untrusted_review_content>` envelope after credential redaction (`src/confidence/prompt.ts`), and the claims prompt states the same rule in its own instructions (`src/claims/model.ts`). That path is unchanged by this feature. The PR body is never consulted by these rules at all.

### Selection table

| Role | Selected when `pr_kind` is... | ...or `risk_flags` includes |
| --- | --- | --- |
| `correctness` | `app_code`, `k8s_manifest` | `linked_priority_p0`, `linked_priority_p1` |
| `security` | `auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes` | `linked_security_issue`, `linked_audit_issue`, `auth_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes`, `dependency_security_sensitive` |
| `tests` | `dependency_upgrade`, `db_or_migration_changes` | — |

A PR can match several lanes and select several roles. There's one additional, independent force-on: if the PR's non-test source footprint is substantial (a new non-test source module, or over 200 non-test source lines changed — `SUBSTANTIAL_SOURCE_LINE_THRESHOLD` in `classify.ts`), `correctness` runs regardless of which lane matched. This closes a gap where a real, sizable change classified only on a content-only `file_serving_changes`/`path_handling_changes` match (too weak to route on by itself) could otherwise skip correctness entirely (#871).

### Zero-selection gates

Zero selection only ever happens through one of five explicit, documented trivial gates — all require `risk_flags` to be empty:

1. **`renovate_digest_only` with no risk flags** — a lockfile digest bump with no version change and no risk signal.
2. **`image_digest_only` with no risk flags** — an image-reference-only change (YAML `image:`/`tag:`, compose, Dockerfile `FROM`) where every changed line keeps its repository and tag and only the `@sha256:` digest differs.
3. **`renovate_image_update` with no risk flags** (#1336) — a Renovate-authored image tag/digest refresh whose diff is pure (every changed line is an image reference; repository unchanged).
4. **`renovate_chart_update` with no risk flags** (#1336) — a Renovate-authored chart/`appVersion` value bump whose diff is pure: the version value is the only thing that changes, and every changed file is chart-bearing on its own.
5. **`app_code` with no risk flags, where every changed file is in the enumerated trivial class** — `docs/`, prose extensions (`.md`, `.rst`, `.txt`, ...), license/contributor/bot-config files, and a specific inert subset of `.github/` (issue templates, `CODEOWNERS`, `dependabot.yml`, `FUNDING.yml`). This gate only applies when the changed-file list is under the classifier's 50-file summary cap — a capped (truncated) list can't prove every file is trivial, so it doesn't fire. Unknown `.github/**` content (workflows, actions, anything not explicitly enumerated) is treated as non-trivial on purpose.

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
| Renovate PR bumping an image tag (`litellm-database:v1.106.5` → `v1.106.6`) in a manifest (#11591) | `renovate_image_update` | none | **Zero selection** — benign image-refresh trivial gate |
| Renovate PR bumping a security-infrastructure image (e.g. `authelia`) or changing an image's repository, or whose title reports a CVE | `renovate_image_update` | `dependency_security_sensitive` | `security` selected; correctness per the fall-through kind |
| Renovate PR bumping a HelmRelease chart `version`/`appVersion` (not renaming the `chart:` value) | `renovate_chart_update` | none | **Zero selection** — benign chart-refresh trivial gate |
| New 300-line non-test module, e.g. `src/platform/foo.ts` | `app_code` | none | `correctness` selected (direct `app_code` match, reinforced by the #871 substantial-change force-on); `security`/`tests` skipped |

## Where to see the decision

Every run records the mode and the per-role reasoning in `specialists.json`: `deep_review_mode`, and a `selection` object with `selected_roles`, `skipped_roles`, and per-role `decisions` (each with the matched signals and a human-readable reason). The job step summary also shows the selected/skipped counts for auto-mode runs. Skipped roles are telemetry, not failures: they never produce a `specialist-<role>.json`, never set `any_errors`, and never appear in the leads section of the review corpus.

## Cost and limits

| Input | Default | What it bounds |
| --- | --- | --- |
| `deep-review-timeout-sec` | `600` | Wall-clock budget for the whole specialist phase (selected roles run concurrently). A straggler past the deadline is recorded as an error on its own artifact; it never blocks or fails the review. |
| `deep-review-max-tokens` | `16384` | Completion tokens per specialist role — independent of `ai-max-tokens`. Raised from 4096 by #1061: reasoning-heavy models spend the same budget on thinking and on the short structured lead list, and the 4096 default truncated them at exactly 4095 tokens with zero leads. Lower it for small-output-cap models. |
| `deep-review-corpus-max-bytes` | `48000` | Hard byte cap on the shared specialist corpus (PR metadata, classification, changed files, diff, capped standards, requirement ledger, related-code, evidence/CI), built once and reused by every selected role. |

When `deep-review` is enabled, the specialist passes run **concurrently with the CI wait**, not after it — both branches fork after the unchanged-review precheck and join before the final reviewer starts, so wall clock is closer to `max(CI, specialists)` than their sum. A CI timeout/failure never blocks the review, and specialists stay advisory and fail-soft either way.

### Completion caps, overrun recovery, and reasoning effort

Reasoning-heavy models spend the same completion budget on thinking and on the answer, so a cap that is fine for a plain chat model truncates them. The per-role default is `16384` (#1061). When a role's response stops at the cap and yields no leads — whether it failed to parse or parsed cleanly as an empty list — the phase raises the budget **once**, to a bounded `32768` ceiling, and re-parses; the same rule applies to `combined_scout`'s single shared call. A response that already carries leads is never retried. That recovery only fires when the stop reason is recognized — OpenAI's `length` and Anthropic's `max_tokens` are both handled, streamed or not; before #1061 a streamed Anthropic `max_tokens` turn was invisible to the check, so the retry never ran. Lower `deep-review-max-tokens` for small-output-cap models.

Each role's outcome records the bounded, non-sensitive diagnostic needed to tell the failure modes apart: `stop_reason`, `output_chars`, `overrun_detected`, `overrun_retry_result` (`recovered`/`failed`/`skipped`), and `error_kind` — `overrun` for an unrecovered completion-limit truncation, `parser` for a malformed/no-lead response with a normal stop, and `transport`/`timeout`/`input`/`guard` for non-response failures (null on success). The role's log line carries the same fields. None of it contains prompts, chain-of-thought, credentials, or provider bodies.

### Per-attempt retry telemetry

The role-level fields above report only the final adopted response. To make the cost of a recovery path measurable (#1200), every **actual wire attempt** a role makes — the initial call, transport retries, the one-shot completion-overrun retry, and the discarded same-request retries a single wire call's own retry loop makes — is also persisted as a bounded, content-free `attempts[]` record on the role's entry in `specialists.json`, and summarized additively on the role's log line (`attempts=N (initial …; overrun-retry …)`).

Each record has a closed nine-key schema: `attempt_type` (`initial` / `transport-retry` / `overrun-retry` / `wire-retry`), `max_tokens` (the budget actually sent), `elapsed_sec`, `prompt_tokens` / `completion_tokens` / `cached_tokens` (each `null` when the provider reported nothing — never inferred), `stop_reason` (bounded and secret-masked), `adopted` (exactly one record per role, or none), and `retry_trigger`.

One specialist call can itself make **several actual wire attempts**: the wire transport's own same-request retry loop resends on retryable 429/5xx statuses (up to 3 with backoff) and once on a 400 that a `max_tokens` clamp (#824) or structured-output strip (#1047) answers. Every **discarded** attempt of that loop is its own `wire-retry` record — carrying the elapsed time and the budget THAT call sent, with `adopted: false`, `retry_trigger: "transport-failure"` (its outcome caused the same-request follow-up), and null usage/stop (a discarded attempt produced no response data). The final wire call settles the outer record, whose `max_tokens` is the budget the final call actually sent — the clamped cap when a clamp retry fired — so the records reconstruct the whole wire sequence in order. The outer record's `elapsed_sec` spans its whole request attempt (discards, transport backoff, and retries included), so per-record elapsed times do not sum to it; only the `max_tokens` of the final call is the final call's own. A report-bearing transport failure keeps its discarded records too, and the aggregate `request_count` counts every actual wire attempt (outer call plus reported discards), reconciling with the records.

`retry_trigger` names the attempt's own outcome that caused a follow-up attempt — or would have caused one had the retry model allowed it. So it is also marked when **no follow-up fired**: the exhausted transport loop marks its final failure `transport-failure` (the `MAX_ATTEMPTS` ceiling, not the absence of a cause, ended the attempts), and a skipped overrun retry marks its trigger `completion-overrun` (the ceiling was already reached). A skipped overrun opens no retry record of its own — no attempt was made. The trigger stays `null` only for outcomes that are never retry-eligible by policy: a final success, a timeout, a terminal provider failure (quota exhausted / model retired), a 200 carrying an error body, and an in-flight record snapshotted by a phase-deadline reap. The aggregate `request_count` counts unique wire attempts (in `combined_scout`, the shared call's records attach identically to every role entry but are never multiplied per role), and `usage_totals` reconciles with the per-attempt records. None of this telemetry contains prompts, response content, chain-of-thought, credentials, or provider headers.

A call that the transport refuses **before the wire** is not an attempt at all: the #1080 terminal-lane latch short-circuits every later call on a terminally failed lane with zero provider attempts, and a malformed lane configuration (an unparsable endpoint, an extra-header set the wire boundary refuses) is rejected before any socket opens. Such a call opens no attempt record and is not counted in `request_count`. The affected role keeps the same persisted failure shape (`transport` error kind plus the normalized terminal reason where the lane was latched) — only the attempt accounting changes. An attempt still in flight when the phase deadline reaps its role is a real attempt: it stays in the aggregate and stays visible on the reaped entry.

Reasoning effort is a **separate** control. On an Anthropic endpoint the specialist lane sends `output_config.effort` only when `ai-specialist-anthropic-effort-support: true` is asserted for that endpoint; otherwise the configured effort is not sent and the run prints a warning naming the input. Raising the token cap is deliberately independent of that opt-in — it does not require, enable, or imply provider effort support, and asserting support still needs its own provider-capability testing.

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
