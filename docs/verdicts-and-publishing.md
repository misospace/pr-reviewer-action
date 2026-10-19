# Verdicts and publishing

How the final verdict is decided, what gets published, and how re-reviews work.

## Verdict policy

`verdict-policy` controls how the model's raw verdict becomes the published one.

| Policy | Behavior |
| --- | --- |
| `strict` (default, v3) | Deterministic: the published verdict is derived from the still-open findings and required-check coverage, not just copied from the model. |
| `model` | v2 passthrough — the model's own `approve`/`request_changes` stands as-is. |
| `findings_severity_gated` | One-way escalation on top of the model's verdict: `request_changes` is preserved; `approve` escalates to `request_changes` when any blocker-severity finding exists. Non-blocker findings never weaken a model rejection. |

Enforcement settings (`evidence-blocker-enforcement`, tool-failure enforcement) run after whichever policy applies and can still force `request_changes`.

### `strict` in detail

Under `strict`, the model's verdict is an input, not the final answer. The rule:

- `request_changes` only when at least one still-open finding is `blocker` or `major` severity.
- `approve` otherwise.

"Still-open" means after carry-forward resolution of any findings the settlement pass re-emitted — it's the one open-findings set, not something reconciled separately. When the mapping overrides the model's own verdict, the published review adds a one-line note explaining why (e.g. `N blocker/major finding(s) out of M open`), and `verdict-source` records how.

A fail-closed enforcement layer (evidence blocker, tool-harness failure, `required-check-validation-mode: fail`, `min-successful-requests`) can still force `request_changes` even with zero open blocking findings; that forced verdict is never relaxed back to `approve`, even if the model also asked for changes independently.

### `findings_severity_gated` and non-blocking categories

`non-blocking-finding-categories` (comma-separated: `tests`, `docs`, `style`, `question`, `performance`, `bug`, `other` — `security` is never eligible) lets a repo declare categories that can't request changes on their own. Under `findings_severity_gated`:

- Blocker/major findings in those categories are capped to `minor` (recorded with their original severity for audit).
- If capping leaves nothing blocking, no required check is unresolved, and the model itself asked for `request_changes`, the verdict is relaxed to `approve` — the only downgrade this policy makes.
- A PR carrying a security risk flag (`auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes`, `db_or_migration_changes`, `linked_security_issue`) is exempt from capping, even in a nominally non-blocking category.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: http://llama-server.internal:8080/v1
    ai-model: qwen3-32b
    verdict-policy: findings_severity_gated
    non-blocking-finding-categories: tests,docs,style
```

## `review-result` states

The metadata marker's `review-result` output distinguishes four states, in precedence order:

| State | Meaning |
| --- | --- |
| `issues` | Blocking — at least one open finding is blocker/major (verdict is `request_changes`). |
| `partial` | Coverage gap, no blocking findings: required-check validation reported `incomplete`, or the tool loop stopped before reading every changed file (see [Tool loop](tool-loop.md#stop-reasons-and-partial-coverage)). |
| `findings` | Open minor/info findings only; coverage is otherwise complete. |
| `clean` | Nothing open, coverage complete. |

`verdict: approve` with `review-result: partial` is **not a clean run** — gate merges on both outputs, never `verdict` alone. Since #1145 the two outputs are independent facts: in `review_verdict` mode the native event follows the verdict (a partial-coverage approve still publishes `APPROVE`, with an explicit gap note in the body), while `review-result: partial` keeps recording that the investigation/trace did not finish. `clean`/`issues` keep their v2 meaning because the unchanged-diff carry-forward reads them; `findings`/`partial` carry an approve.

The published review surfaces the same inputs: open findings and any coverage gap render at the top of the review body, and an override note (`_Verdict set from open findings (verdict-policy=strict): ..._`) explains any mismatch with the model's own verdict.

## Publish modes

`publish-mode` controls what the action actually posts to the PR:

| Mode | Behavior | Branch protection impact |
| --- | --- | --- |
| `comment` | Sticky PR comment with `<!-- ai-pr-reviewer -->` markers, edited in place. Opt-in. | None — advisory only. |
| `review_comment` (default) | Non-blocking native PR review via `gh pr review --comment`. | None — review comments don't affect status checks. |
| `review_verdict` | Native PR review with `approve`/`request_changes`. | Counts as a real review against branch protection. |

### Permissions per mode

| Mode | Required permissions |
| --- | --- |
| `comment` | `contents: read`, `pull-requests: write` |
| `review_comment` | `contents: read`, `pull-requests: write` |
| `review_verdict` | `contents: read`, `pull-requests: write`, plus the repo/org setting **Allow GitHub Actions to create and approve pull requests** for approvals to succeed |

## Native review verdicts, `allow-approve`, and `approve-forks`

With `publish-mode: review_verdict`:

- `allow-approve` defaults to `false` — a model `approve` is blocked from being submitted as a native approval unless this is explicitly `true`.
- `approve-forks` defaults to `false` — even with `allow-approve: true`, approvals are still blocked for cross-repository (fork) PRs unless this is also `true`.
- Evidence-provider or tool-failure enforcement that forced `request_changes` always blocks approval.
- The review body must be non-empty for an approval to publish.
- **The publish mode is authoritative (#1145): a valid final `approve` publishes a native `APPROVE` and a valid final `request_changes` publishes a native `REQUEST_CHANGES`.** A requirement-trace or coverage shortfall (`requirement_trace` incompleteness, `review-result: partial`, a tool-loop coverage gap, or unconfirmable coverage) never downgrades the verdict to a `COMMENT`. The shortfall stays visible — the marker keeps reporting `review-result: partial` with its `incomplete-reason`, the coverage notice renders in the body, and an approved-but-incomplete review carries an explicit "Approval published with incomplete coverage" note — and the review pipeline is expected to close traceable evidence gaps (bounded evidence-repair continuation of the tool loop) before finalizing rather than after.
- **Confirmed-unmet requirements escalate to `request_changes` (#1145).** Where the requirement-trace validator positively refutes an in-scope requirement with a deterministic predicate that ran against the checkout at head — the #854 `enforcement-location-copies-without-comparing` and #985 `structural-proof-unconfirmed` cases — the action synthesizes a concrete blocker finding per refuted requirement (capped) and escalates the final verdict to `request_changes` (recorded as `verdict-source: enforcement` under the non-strict policies; under `strict` the mapping derives the same `request_changes` from the synthesized open blockers, so the source reads as findings-derived). This is the only synthesis the trace layer performs: a model-*claimed* `unmet` with no deterministic refutation stays disclosure-only (#1095), an unproven gap goes to the bounded evidence-repair continuation first ([Tool loop](tool-loop.md#evidence-repair-continuation-1145)), and a genuinely unverifiable row never forces a verdict — it just keeps the run from reading as clean.
- The only remaining reason a valid `approve` publishes as a non-blocking `COMMENT` is an operator guardrail: `allow-approve: false`, a fork PR without `approve-forks: true`, or unknown fork-ness (fails closed). It never turns a withheld approval into a blocking `request_changes`. A run that reaches `review_verdict` publication with **no valid final verdict** fails the action explicitly — `COMMENTED` is not an alternate failure state for verdict mode. A true approval failure (e.g. the 403 from a disabled "Allow GitHub Actions to create and approve pull requests" setting) fails the step loudly.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: https://api.openai.com/v1
    ai-model: gpt-4.1
    ai-api-key: ${{ secrets.OPENAI_API_KEY }}
    publish-mode: review_verdict
    allow-approve: "true"
```

## Non-blocking comments and cleanup of superseded reviews

`publish-mode: review_comment` submits a native `COMMENT` review — visible in the PR conversation, but it never affects branch protection or status checks.

When `publish-mode` is `review_comment` or `review_verdict`, `cleanup-previous-native-reviews` (default `auto`) keeps the timeline readable:

- `auto`: cleanup runs for `review_comment`/`review_verdict` (which each create a new review per run); disabled for `comment` (which already edits one sticky comment in place).
- `true`: always clean up, regardless of mode.
- `false`: never clean up.

Cleanup identifies previous managed reviews by the configured marker, dismisses stale verdicts where permissions allow, and resolves eligible GitHub threads. Individual inline comments are considered only after a substantive replacement publishes successfully at the expected head; incomplete/notice runs and head races preserve old findings. Cleanup snapshots previous reviews before publication and retires only older inline comments after complete replacement coverage, an unchanged PR head, and verification that no newer managed review has superseded the run. A complete clean `review_comment` re-review creates an empty managed COMMENT review as its ordering anchor when previous managed reviews exist. GitHub comment deletion requires `pull-requests: write`; roots with any enumerated replies are retained rather than relying on deletion cascade behavior. Forgejo v11-v16 exposes `GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments` and `DELETE` on the same route with `/{comment}` (204 success; 403/404 possible). Forgejo authorization allows the comment poster or a write-capable repository role, so the action verifies authenticated identity and preserves every comment in a review if any comment has a foreign or unknown author. Forgejo stores human replies as sibling review comments without a parent link; the conservative whole-review guard prevents deleting a mixed discussion. Review resolution changes thread state, GitHub minimization hides supported review objects, and deletion removes an individual comment; these are not interchangeable. Incomplete enumeration, unsupported API versions, and permission failures skip or stop cleanup safely. Enumeration is capped at 10 GitHub comment pages or 25 Forgejo reviews/1,000 comments, and each run attempts at most 100 unique deletions. Discussion and head/latest-review state are revalidated before each deletion; APIs do not provide an atomic compare-and-delete, so a narrow concurrent interaction window remains. When authenticated identity cannot be established (including repository-scoped Forgejo integration tokens without `/user` access), destructive inline cleanup is skipped with a warning; use a token with identity access for this capability. See the [Forgejo v1 API](https://codeberg.org/forgejo/forgejo/src/branch/v16.0/templates/swagger/v1_json.tmpl) and [review comment handlers](https://codeberg.org/forgejo/forgejo/src/branch/v16.0/routers/api/v1/repo/pull_review.go).

## Inline findings

With `inline-findings: "true"` (default) and a native publish mode, findings that anchor to a `file` + `line` in the PR diff are attached as line-anchored review comments, capped by `inline-findings-max` (default `20`):

- `review_verdict` — the verdict review itself carries the inline comments; if GitHub rejects the payload (e.g. the diff moved under it), the action falls back to a plain review rather than failing to publish.
- `review_comment` — the sticky summary comment posts as usual, plus a separate `COMMENT` review carrying the inline comments (carrying the managed marker, so cleanup can supersede it next run).
- `comment` — ignored.

Findings that can't be anchored to a diff line stay in the review body only.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: http://llama-server.internal:8080/v1
    ai-model: qwen3-32b
    publish-mode: review_verdict
    verdict-policy: findings_severity_gated
    inline-findings: "true"
```

## `fail-on-request-changes` without a GitHub App

`fail-on-request-changes` (default `false`) fails the action step itself when the final verdict is `request_changes`, so a plain `GITHUB_TOKEN` workflow can use the step's own exit code as a merge gate without standing up a GitHub App for native approvals.

- Runs **after** publishing — the review comment and inline findings still land on the PR either way.
- Reads the same final verdict the `verdict` output reports: post-`verdict-policy`, post-evidence-blocker and tool-failure enforcement — not the model's raw verdict.
- `on-model-failure: notice` still passes the step: a model outage produces no verdict and must never wedge merges.
- A **degraded** review warns and passes — but only in two narrow cases: the verdict is the `on-model-failure: notice`, or the review ran on the **fallback** model with no evidence gathered and its own verdict was `request_changes`. A **primary** review that gathered no evidence still fails, and a `request_changes` forced by a deterministic layer (evidence blocker, tool-failure enforcement, required-check `mode: fail`, an incomplete requirement trace, or a verdict-policy escalation) always fails — degradation never outranks fail-closed policy. Set `fail-on-degraded-review: "true"` to fail on the two degraded cases as well.

## Re-reviews

### The `ai-review` label

Add the `rereview-label` (default `ai-review`) to a PR and the action re-reviews it in full, even if the diff hasn't changed. To enable it, add `labeled` to the workflow's `pull_request` event types:

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, labeled]
```

On a `labeled` event, the action reviews only if the added label matches `rereview-label`; any other label is ignored. After a label-triggered run, the action **removes the label**, so adding it again re-triggers a fresh review. The trigger is self-authorizing — only users with write/triage permission can apply a label — and it rides the normal `pull_request` event, so there's no privileged-checkout exposure.

If your workflow uses `concurrency` with `cancel-in-progress: true`, give `labeled` events and `issue_comment` re-reviews their own groups — otherwise an auto-applied label (e.g. Renovate labeling a PR at creation) can spawn a `labeled` run that cancels the in-flight `opened` review, and a comment can cancel an in-flight push/label review of the same PR (and vice versa):

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}${{ github.event.action == 'labeled' && format('-label-{0}', github.run_id) || '' }}${{ github.event_name == 'issue_comment' && format('-comment-{0}', github.event.issue.number) || '' }}
  cancel-in-progress: true
```

The `-comment-<issue number>` suffix keys comment runs to the issue, so they get their own group and can never cancel an in-flight push review.

For non-interactive callers, `force-review: "true"` bypasses the unchanged-diff guard directly; a `workflow_dispatch`/`repository_dispatch` event only sets it when the consuming workflow explicitly maps its input or payload to `force-review`.

### Comment command

Post a comment on a PR whose body is exactly `rereview-command` (default `/ai-review`) and the action re-reviews it in full, even if the diff hasn't changed — the same fresh full review the label triggers, for users who don't have label permissions. To enable it, add `issue_comment` to the workflow's events:

```yaml
on:
  issue_comment:
    types: [created]
```

The comment body must be exactly the command (leading/trailing whitespace is ignored; v1 takes no arguments, so trailing text never triggers); anything else is ignored. A comment is not self-authorizing the way a label is — the action checks the commenter's repository permission through the forge API, requiring the label bar (triage-or-higher), and fails closed on lookup errors: GitHub's endpoint reports `write`/`admin` directly but collapses a `triage` user into `permission: "read"` with the role only in `role_name`, so the action reads both fields, and an unrecognized or custom role never authorizes. The lookup runs with the action's token, so that token must be able to read repository collaborators. When a run picks up the comment, the action reacts 👀 to it as the acknowledgement. Same-repository comment runs check out the PR head (the `pr-gate`-resolved head sha, pinned at gate time) so the review covers the current PR. Comments on a **closed** PR are a silent no-op.

Fork PRs never get a review from this path: the action replies to the comment pointing at the `ai-review-fork` label workflow (see [Fork reviews](fork-review.md)) and stops. Comment runs on **draft** PRs are skipped before the action runs (matching how draft PRs are never reviewed), so a draft fork PR gets no reply either.

Set `rereview-command` to an empty string to disable comment-triggered re-reviews. v1 scope is the bare command only — it takes no arguments.

> **SECURITY:** Comment-triggered runs carry base-repo secrets, and the `issue_comment` payload has no head SHA. Resolve the PR through the API *before* any checkout — the dogfood workflow's `pr-gate` step (`.github/workflows/ai-pr-review.yaml`) is the pattern to mirror — and never check out or build a fork PR's head in such a run: compare the PR head's repository id against `github.repository_id` and route fork comments to a base-repo checkout.

### The unchanged-diff skip

`skip-if-diff-unchanged` (default `true`) skips the LLM review entirely when the current PR patch plus config fingerprint matches the last managed review, and carries the prior verdict forward (`verdict-source: carry_forward`) — zero model calls spent on a PR nobody touched. Any new push, force-push, rebase, or config change busts the fingerprint and triggers a fresh full review; there is no incremental/delta mode, every review is a full review of the current PR.

## On model failure

`on-model-failure` controls what happens when both the primary and fallback models fail to return a usable review:

- `notice` (default): publishes a visible `request_changes` notice explaining the review could not run. It never auto-approves and the `verdict` output is `request_changes`, but the notice counts as a degraded review, so `fail-on-request-changes: "true"` warns and passes it (set `fail-on-degraded-review: "true"` to fail instead). A gate of your own on the `verdict` output still sees `request_changes`.
- `fail`: fails the action step instead.
