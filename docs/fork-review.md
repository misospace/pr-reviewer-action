# Fork PR reviews: the two-stage privilege-separated workflow

This repository accepts pull requests from forks. Fork-authored code is
untrusted: it is attacker-controlled content competing for review attention,
model compute, and — if the boundary ever slips — credentials. This document
describes how fork PRs get AI reviews without ever exposing credentials to,
or executing, fork-controlled code.

The design is **two-stage privilege separation**:

```
Stage 1 (unprivileged, fork-controlled code runs here)
  pull_request event → CI workflow (tests, lint, CodeQL)
    · no repository secrets (GitHub's default withholding)
    · read-only GITHUB_TOKEN
    · no model endpoint, no App private key, no privileged reviewer

Stage 2 (privileged, only trusted base-repository code runs here)
  workflow_run (CI completed) ─┐
  pull_request_target (label) ─┴→ fork-ai-review workflow
    · gate: authorization + identity from trusted GitHub API state
    · reviewer: the action checked out from the base repository
    · local models only, bounded compute, exact-head-guarded publication
```

## Why fork `pull_request` workflows get no secrets

This is GitHub platform behavior, not a choice this repository makes: for
`pull_request` events triggered from a fork, Actions runs the workflow **from
the merge commit of the fork branch but with `pull_request` secrets and
token permissions withheld**. A fork author controls every file that workflow
executes — scripts, actions, test code — so anything it holds is readable by
the fork author. The fork CI therefore runs tests, lint, and CodeQL with
nothing to steal.

**Maintainers must never "fix" a failing fork job by enabling secrets for
fork `pull_request` workflows** (e.g. by making secrets available to forks,
or switching the trigger to `pull_request_target` in a way that checks out or
executes fork code). There is no safe configuration of "secrets for
fork-controlled code": the fork author can print them. If a fork job needs
something privileged, it belongs in a stage-2 workflow like this one.

## Why `workflow_run`

`workflow_run` fires **after** the unprivileged CI workflow completes, and
the triggered run executes workflow code from the **default branch of the
base repository** with full repository access. That is exactly the seam we
need: the fork decides *when* (by pushing, which triggers CI), but never
*what code runs* (the workflow comes from the base repo) and never *what it
can reach* (secrets stay base-side).

The workflow is also triggered by `pull_request_target` limited to
`types: [labeled]` so that adding the authorization label produces a first
review without waiting for the next push. That trigger is safe here because:

- `pull_request_target` runs base-repository workflow code;
- the gate job performs API calls only — it never checks out the fork and
  never executes fork content;
- `labeled` events can only be produced by accounts with write/triage
  permission, so a fork author cannot trigger the privileged path at all.

## The `ai-review-fork` authorization flow

Fork AI review is **default-deny**. Model compute is spent only when a
maintainer has authorized the specific PR:

1. A fork PR is opened; normal CI runs (stage 1). No review happens.
2. A maintainer adds the **`ai-review-fork`** label. This both authorizes
   the PR and (via the `labeled` trigger) starts the first review.
3. Subsequent pushes are reviewed automatically **while the label remains**
   (each push's CI completion re-enters stage 2).
4. Removing the label stops future reviews and aborts any run that has not
   yet reached the model (the pre-model verify step re-checks the label).

The label is verified against the **current PR state fetched through the
GitHub API** (`scripts/fork_review_gate.py`) — never against the event
payload, which is attacker-influenced data. A fork author cannot
self-authorize by editing the PR body, title, files, or labels: labels are
maintainer-only, and every authorization check re-reads live API state.

Same-repository PRs never enter this workflow: the gate requires the PR to
be cross-repository, and the dogfood `AI PR Review` workflow skips fork PRs
cleanly (it used to fail noisily at its bot-token step, which never receives
secrets on `pull_request` events).

## Local-model-only policy

The fork reviewer is pinned to the self-hosted LiteLLM endpoint and must
**never** fall back to a cloud provider. The pin is enforced at three layers:

| Layer | Mechanism |
|---|---|
| Workflow inputs | `ai_model` / `ai_smart_model` read **only** the `FORK_PRIMARY_*` / `FORK_SMART_*` repo variables — never the org-level `PRIMARY_*` / `SMART_*` / `FALLBACK_*` dogfood variables, which are not local-only and drift over time |
| No fallback | The workflow passes no `ai_fallback_*` inputs; with `ai_fallback_model` empty the pipeline never attempts a fallback call. An unavailable local model degrades via `on_model_failure: notice` — a visible `request_changes` notice on the PR — and stops |
| Credential scope | `FORK_LITELLM_API_KEY` is a LiteLLM virtual key scoped to exactly the two fork models, so even a routing mistake cannot bill or reach another model |

The credential-scope row is an **operational** requirement: create the key
with model scope limited to the two fork models at the LiteLLM side and
verify it there (e.g. confirm a request for any other model is rejected).
The repository cannot enforce LiteLLM-side scoping from a workflow; what the
workflow does enforce is that a *missing* secret fails the review job loudly
(see the pre-flight guard) instead of issuing unauthenticated model calls.

- Primary: `FORK_PRIMARY_MODEL` (`muse-glimmer`, OpenAI format)
- Smart/escalation: `FORK_SMART_MODEL` (`qwen3.8-flash-next`, OpenAI format),
  reachable only through the reviewer-requested post-primary escalation
  (#721) — one smart call at most, never recursive.

A fork cannot alter model names, base URLs, API keys, routing policy, or
context limits by changing files in its PR: those values live in the trusted
workflow file and repo variables only.

### Required configuration (maintainers, one-time)

Repo **variables**:

| Name | Value |
|---|---|
| `FORK_PRIMARY_MODEL` | `muse-glimmer` |
| `FORK_PRIMARY_FORMAT` | `openai` |
| `FORK_SMART_MODEL` | `qwen3.8-flash-next` |
| `FORK_SMART_FORMAT` | `openai` |

Repo **secret**:

| Name | Value |
|---|---|
| `FORK_LITELLM_API_KEY` | LiteLLM virtual key scoped to `muse-glimmer` + `qwen3.8-flash-next` only |

The org-level `LITELLM_URL` variable provides the base URL. If any pin is
missing, the review job fails loudly with an explicit error — it never
silently inherits the dogfood configuration.

## Reduced fork context/tooling (vs trusted PRs)

Fork reviews deliberately run a smaller feature set. Anything that would
require executing the fork's checkout, reach private services, or carry
private credentials is disabled:

| Feature | Trusted PR | Fork PR | Why |
|---|---|---|---|
| Native tool calling (`native_loop`) | on | **off** | The tool surface reads a checked-out workspace; here that workspace is the trusted base checkout, not the fork head, so tool results could only mislead — and read-only-ness of the whole surface is not provable today |
| Related-code context | on | **off** | Scans the local worktree (wrong tree here) |
| Repository map | on | **off** | Same worktree dependency |
| Evidence providers / SARIF | per config | **off** | Operator commands + private config |
| Linear context | per config | **off** | Private credentials |
| Linked-source URL fetching | allowlisted hosts | **off** (`allowed_source_hosts: ""`) | Fork-controlled URLs must not be fetched with review credentials in play |
| PR thread context | on | on | Read-only API data |
| Image digest provenance | on | on | Public registry metadata, budgeted |
| Deep review specialists | all roles | `auto` (classifier-selected, bounded) | Compute bound |
| CI gating | polls Checks API | **off** | CI just completed — that completion triggered the run |
| Standards/prompt source | PR workspace | trusted base checkout | The fork's `AGENTS.md` edits are reviewed *as diff*, never used to configure the review of their own PR |

## Why the privileged workflow never executes fork code

GitHub's `workflow_run` security guidance is treated as authoritative here:

- **Checkout is pinned to `github.sha`** — for `workflow_run` that is a
  commit on the default branch of the base repository; for
  `pull_request_target` it is the base branch. The fork head
  (`github.event.workflow_run.head_sha`) is used **only** as untrusted data
  to resolve the PR through the API; it is never a checkout ref.
- **`uses: ./`** resolves to the code checked out in the previous step —
  trusted base-repository code. The `$/{...}` self-repository shorthand is
  deliberately avoided here because its resolution is implicit; the fork
  path wants the explicit trusted checkout.
- **No artifacts or caches** produced by the unprivileged fork workflow are
  downloaded or executed.
- **Fork-controlled files are data, never configuration.** The fork's copy
  of `action.yml`, workflow files, `AGENTS.md`, `CLAUDE.md`,
  `.github/ai-review-rules.*`, prompt files, and provider configs may all
  appear in the review *corpus* as diff content — they never configure the
  reviewer that reads them. `tests/test_fork_review_workflow.py` pins this.
- **No shell interpolation of untrusted identifiers.** The gate resolves
  PR numbers and SHAs through the API and validates them strictly
  (positive integer, 40-hex) before they are emitted; PR titles, bodies,
  and branch names are never emitted anywhere. All subprocess calls are
  argv lists (`shell=False`).

## Compute and abuse limits

A fork author must not be able to convert maintainer attention into
model-compute denial of service. Hard limits, and why:

| Limit | Value | Why |
|---|---|---|
| Authorization | `ai-review-fork` label, verified live | Default-deny; revocable mid-run |
| One active review per PR | concurrency group `fork-ai-review-<repo>-pr-<N>`, cancel-in-progress | Repeated pushes cancel superseded work instead of accumulating reviews |
| Stale heads | skipped at the gate (PR head ≠ triggering run head) and re-verified pre-model and pre-publication | Only the newest head spends compute; a superseded run never publishes |
| Model retries | 1 retry, 5 s delay | An outage must not become prolonged load |
| Model timeout | job `timeout-minutes: 30` | Hard wall-clock bound on the whole review |
| Completion budget | `ai_max_tokens: 16384` | Bounds per-review token spend |
| Context budget | `context_limit_mode: low` | Bounds prompt size |
| Smart escalation | reviewer-requested only, single shot | No repeated or recursive escalation |
| Specialist phase | `auto` selection, 300 s budget | Possibly zero roles; never unbounded |
| Duplicate suppression | the action's unchanged-diff fingerprint skip | An unchanged head re-runs CI but costs zero model tokens |

Not built here (deliberately): a general external rate-limiting service. The
label gate plus the concurrency group bound abuse to "at most one review per
push on labeled PRs", which is the actual threat.

## Publication

The reviewer publishes as the existing BOT GitHub App (short-lived
installation token) — the same trusted publication architecture as the
dogfood workflow. Workflow permissions are minimal: `contents: read` +
`pull-requests: write` on the review job; the gate job holds only
read permissions and never sees any credential.

Fork reviews may publish findings, inline comments, and `request_changes`.
They must never create a native approval: `allow_approve: false` and
`approve_forks: false` are pinned (both by the workflow and by the action's
own fork gate in `scripts/publish.sh`).

Publication is exact-head guarded twice: `fork_review_gate.py verify` before
model work, and `scripts/verify_pr_head.sh` inside the publish step — a push
landing mid-review stops publication of the stale verdict.

## Qualification and tests

`tests/test_fork_review_gate.py` and `tests/test_fork_review_workflow.py`
pin the security properties (default-deny, trusted-API label checks, stale-head
skips, shell-injection hygiene, feature pins, no-fallback, permissions,
concurrency, dogfood separation). The real-world qualification case was the
cross-repository PR from `hampsterx` (#747 shape): cross-repo fork PR,
maintainer-labeled, reviewed without any credential entering stage 1.

Run locally:

```bash
python3 -m pytest tests/test_fork_review_gate.py tests/test_fork_review_workflow.py -v
actionlint .github/workflows/fork-ai-review.yaml
```

## Follow-up (v3)

The related-code / repository-map features are disabled for forks because
they scan the local worktree, and the privileged job must not check out the
fork. The clean fix is a v3 **immutable repository-snapshot abstraction**
behind the forge adapter: the reviewer consumes a read-only snapshot of the
PR head (fetched via trusted API as data) instead of a checked-out worktree,
letting full fork context be gathered without executing a checkout. Until
then, fork reviews run with the reduced context documented above — the
boundary is worth more than the context richness.
