# Context and evidence

What the reviewer sees before it writes a verdict, and the inputs you use to
steer it: deterministic classification, the requirement ledger, PR/issue
context, repository standards and prompts, evidence providers, CI results,
and linked sources.

## Deterministic PR classification

Before any model call, a rule-based step (`src/classification/classify.ts`)
analyzes changed file paths, diff content, and linked-issue metadata into
structured classification. No model is involved — pattern matching only —
which keeps smaller/weaker reviewer models focused and resistant to
irrelevant context.

| Field | Description |
|-------|-------------|
| `pr_kind` | One of `renovate_digest_only`, `image_digest_only`, `dependency_upgrade`, `app_code`, `k8s_manifest`, `auth_changes`, `public_route_changes`, `file_serving_changes`, `path_handling_changes`, `secret_handling_changes`, `db_or_migration_changes` |
| `risk_flags` | Risk indicators: `linked_security_issue`, `linked_audit_issue`, `linked_priority_p0`, `linked_priority_p1`, `file_serving_changes`, `path_handling_changes`, `auth_changes`, `secret_handling_changes` |
| `changed_files_summary` | Changed file paths, truncated to 50 |
| `linked_issue_labels` | Labels from linked issues (GitHub labels + Linear state), merged into `linked-issues.json` |
| `must_check` | The required-check checklist derived from `pr_kind` and every detected risk flag |

`must_check` drives the required-check completeness contract — dispositions,
validation modes, and the `required-checks` output. That contract, including
the full per-risk-class check table and how `validate-required-checks` and
`required-check-validation-mode` behave, is documented in
[Required checks](required-checks.md).

## Requirement ledger and coverage

When linked issues, the PR description, or the standards file state explicit
requirements — acceptance-criteria bullets, `MUST`/`SHALL` sentences,
ordering invariants — the action extracts them into a bounded, deterministic
**requirement ledger** (`src/requirements/ledger.ts`) with content-derived
ids and per-source provenance. The ledger gets its own reserved slice of the
corpus budget on every review, so it's never silently dropped by other
content.

The reviewer must report, per ledger item, a `requirement_coverage` entry:
`satisfied`, `violated`, or `unknown`, backed by concrete evidence (`file`,
`test`, `tool`, `ci`, or `diff`). Claims are checked deterministically
(`src/enforcement/requirement-coverage.ts`): a claim without concrete
evidence — or a "satisfied" invariant backed only by a source-code glance,
with no test/tool/CI evidence — is downgraded to `unknown`, and `unknown` is
never promoted.

This is a completeness signal for review-quality tracking, not independent
verdict authority. A PR whose inputs carry no explicit normative text sees
unchanged behavior.

## Linked issues

Closing references in the PR body (`Fixes #40`, `Closes owner/repo#12`) are
fetched and folded into the review corpus so the model can compare the
implementation against issue guidance and acceptance criteria. The
past-participle forms (`Closed`/`Fixed`/`Resolved`) are ambiguous with
ordinary prose ("covered by closed #479"), so they only count as closing when
they start a line, after optional indentation and a markdown list/blockquote
marker (`Fixed #42`, `- Fixed #42`).

Non-closing references count too: a title using the `(#N)` convention, or a
body reference like `Implements`/`Part of`/`Refs`/`Addresses`. If a
title-linked or body-referenced number resolves to a pull request rather than
an issue, it's rejected before use — a skip notice is recorded instead of
issue content, and it never reaches the requirement ledger. This only applies
to non-closing refs; closing keywords (`Closes`/`Fixes`/`Resolves`) behave as
before.

Labels on linked issues feed classification: a GitHub `security`, `audit`,
`priority/p0`, or `priority/p1` label produces the matching `risk_flags`
entry (`linked_security_issue`, `linked_audit_issue`,
`linked_priority_p0`/`p1`). Linear native priority 1/2 map to the same p0/p1
flags when a Linear adapter is configured.

## PR thread, review threads, and human-review context

Three independent, bounded context sources, each gated on its own input:

| Input | Default | What it adds |
|-------|---------|--------------|
| `pr-thread-context` | `true` | Recent PR conversation comments, with the action's own managed comments filtered out |
| `review-threads-context` | `true` | Unresolved inline review threads — the action's earlier findings and replies to them. The reviewer must disposition each listed thread |
| (human reviews — always collected) | — | Outstanding human `CHANGES_REQUESTED` reviews, newest first, per non-managed reviewer |

The action's own reviews are identified by the managed marker in the review
body, never by author, so a maintainer who happens to reuse the bot's
wording isn't mistaken for it.

## Related-code and repo-map context

| Input | Default | What it adds |
|-------|---------|--------------|
| `related-code-context` | `true` | Deterministic related-code references, test candidates, and nearest manifests derived from changed-file anchors |
| `related-code-max-bytes` | `16000` | Byte cap for that section (clamped to a minimum of 64 so the truncation marker stays readable) |
| `repo-map-context` | `true` | A bounded deterministic map of Git-tracked repository structure, in both the review corpus and native-loop planning context |
| `repo-map-max-bytes` | `12000` | Byte cap for the framed repository-map section |

Both are deterministic (no model call) and derived from the changed-file
list, so they're reproducible across runs with the same diff.

## Standards files

A repository standards file (`AGENTS.md`, `CLAUDE.md`, `.github/ai-review-rules.md`,
etc.) supplies conventions and policy context to the reviewer.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: https://api.openai.com/v1
    ai-model: gpt-4.1
    ai-api-key: ${{ secrets.OPENAI_API_KEY }}
    standards-file: .github/review-rules.md
```

Leave `standards-file` empty (the default) to auto-discover from
`standards-file-candidates` — the first candidate that exists wins:

```
AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt
```

**Resolved from the PR's base ref, not the PR head** (`src/context/standards-file-ref.ts`,
#885): a PR cannot edit `AGENTS.md` on its own branch, or add a
higher-priority candidate, to loosen or remove the rules its own review
enforces. Resolution reads the trusted ref via bounded `git ls-tree`/`git
show` calls — nothing here touches the working tree. A `..` path segment is
refused, and only regular-blob entries are accepted (a tracked symlink is
skipped). An absolute path is treated as operator-owned and read directly
from disk, since it's never part of the reviewed repository's git history.

## Repo-local prompt files

`system-prompt-file` points at a file in the reviewed repository to use as
the system prompt:

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: https://api.openai.com/v1
    ai-model: gpt-4.1
    ai-api-key: ${{ secrets.OPENAI_API_KEY }}
    system-prompt-file: .github/pr-review-prompt.md
```

Like the standards file, it's **read from the PR's base ref** (fixed in
v3.0.1, #905 — earlier v3 builds read it from the run artifact directory
instead). A PR cannot rewrite the prompt that reviews it. When both
`system-prompt-file` and inline `system-prompt` are set, the file content is
read first and the inline value appended, separated by two newlines.

`system-prompt-mode` controls how a supplied prompt combines with the
bundled default:

- `replace` (default): the supplied prompt is used verbatim.
- `append`: the bundled default (with its conditional fragments) is kept,
  and the supplied prompt is appended as a repo-specific addendum — so you
  add conventions without copying and re-syncing the whole default.

## `review-verbosity`

The bundled default prompt asks for a recommendation, change-by-change
findings, sources, and a Standards Compliance section on every review. For a
repo of small, low-risk PRs that reads as padding.

```yaml
    review-verbosity: concise
```

`concise` appends a brevity fragment: a ~300-word target, prose limited to
blocker/major issues (minor/info go in the `findings` array only), no
restating the diff back to its author, one sentence per point, and Standards
Compliance omitted unless a documented convention is actually violated.

Two things stay exempt from brevity:

- **`must_check` coverage** — every required check still gets an explicit
  mention. Dropping them would let the deterministic completeness validation
  report a false `complete`.
- **The Unknowns or Needs Verification section** — still emitted whenever
  evidence is incomplete.

`normal` (the default) leaves the assembled prompt byte-identical to a run
without the input, and contributes nothing to the config fingerprint —
upgrading to it never triggers a re-review. Switching to `concise` does
change the fingerprint. Applies only to the bundled default: a
`replace`-mode `system-prompt`/`system-prompt-file` ignores the dial
entirely.

## Evidence providers

Evidence providers are external commands (or pre-generated SARIF) whose
output is folded into the review as evidence.

```yaml
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: http://llama-server.internal:8080/v1
    ai-model: qwen3-32b
    evidence-providers-file: .github/pr-review-providers.json
    sarif-files: reports/codeql.sarif, reports/semgrep.sarif
    sarif-max-findings: "200"
    evidence-provider-timeout-sec: "30"
    evidence-provider-max-output-bytes: "20000"
    evidence-blocker-enforcement: "true"
```

Example provider config:

```json
{
  "providers": [
    {
      "id": "version-compat",
      "command": ["python3", "scripts/check_version_compat.py"],
      "timeout_sec": 45,
      "max_output_bytes": 15000
    }
  ]
}
```

Provider commands print plain text, or JSON with `severity` and `findings`
fields. With `evidence-blocker-enforcement: true`, any provider output with
blocker severity forces a `request_changes` verdict. SARIF files are parsed
as data (never executed) in the requested order, capped globally by
`sarif-max-findings`; paths must be workspace-relative and stay inside the
checkout. SARIF findings are evidence only — they don't trigger blocker
enforcement on their own.

Providers run with full access to the **checked-out PR working tree**
(files, environment, installed tools) — not the base ref. Prefer an argv
array for `command` (e.g. `["python3", "scripts/check.py"]`): it runs via
direct `subprocess.run` with no shell. A string `command` runs through `bash
-lc`, which is a shell-injection risk if any part of the command or
environment is influenced by untrusted PR content.

Evidence providers are **disabled by default on cross-repository PRs**
(`evidence-enable-for-forks=false`), so a fork can't define arbitrary scripts
that the destination repo's config then executes. Set
`evidence-enable-for-forks: "true"` only when you trust fork contributors or
run reviews in an isolated environment.

## Waiting for CI checks

Set `ci-status-check: true` to wait for all CI checks to reach a terminal
state before the AI review starts, so the review considers final results
instead of in-progress ones. This needs the `checks: read` permission —
without it, CI evidence is silently skipped. On Forgejo, auto-discovery first
uses `FORGEJO_RUN_NUMBER` or `GITHUB_RUN_NUMBER` to find a pending status whose
URL is scoped to this repository and the runner's origin (`FORGEJO_API_URL`, or
`GITHUB_SERVER_URL` fallback). It excludes that status only when the run-jobs
API, queried with numeric `FORGEJO_RUN_ID` (or `GITHUB_RUN_ID` fallback), proves
the run has exactly one job and the job's `html_url` path exactly matches the
status `target_url` path. Run IDs are never status-URL candidates. Multi-job,
mismatched, and unavailable cases leave statuses visible. Automatic discovery
requires Forgejo v16.0+, which introduced the run-jobs API; older instances warn
immediately and fall back to bounded waiting. Set `CI_STATUS_CONTEXT` on older
instances and in multi-job reviewer workflows to avoid a self-deadlock; a
whitespace-only value is treated as unset and enables auto-discovery.

```yaml
permissions:
  checks: read
# ...
- uses: misospace/pr-reviewer-action@v3
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-base-url: http://llama-server.internal:8080/v1
    ai-model: qwen3-32b
    ci-status-check: "true"
    ci-timeout-sec: "300"
    ci-interval-sec: "15"
    ci-skip-on-timeout: "true"
```

Per-check outcomes (name, status, conclusion) are folded into the corpus as
a CI Check Results section, so the model cites real test/lint results rather
than reporting them as "not verifiable". The reviewer never runs your test
suite itself — it consumes results your CI already produced in its own
sandbox.

With `deep-review` also enabled, the specialist passes run **concurrently**
with the CI wait rather than after it, so wall clock composes near `max(CI,
specialists)` instead of their sum. A CI timeout or failure never blocks the
review.

With `ci-skip-on-timeout: true` (the default), the action proceeds with the
review after `ci-timeout-sec` even if checks are still running; set it to
`false` to fail the action on timeout instead. The `ci-status-skipped` and
`ci-status-final` outputs report whether the wait completed and the final
state.

## Linked sources and allowed hosts

The native tool loop's `web_fetch` tool, and any linked-source fetching, are
restricted to an explicit host allowlist:

```yaml
    allowed-source-hosts: "github.com,api.github.com,gitlab.com,registry.terraform.io,artifacthub.io"
```

That's the default list. Any host not on it is refused.

## The upstream link sanitizer

Before publishing, `src/publish/sanitize.ts` neutralizes upstream GitHub
references in the review markdown — PR URLs, issue URLs, commit URLs,
compare URLs, cross-repo `owner/repo#123` references, and bare `#123`
references — so GitHub doesn't auto-link them into the reviewed repository
and create notification noise or misleading cross-links.

By default these are rewritten to inert text. Set `upstream-link-mode:
togithub` to instead rewrite them to `https://togithub.com/...` — clickable,
but without triggering notifications or cross-repository auto-linking.
Shorthand references (`owner/repo#123`, bare `#123`) stay inert in both
modes, since a bare `#N` can't be disambiguated between a PR and an issue.

## Empty conditional sections

Every conditional review section is tied to a corpus trigger: **Linked
Issue Fit** to linked-issue context, **Evidence Provider Findings** to
provider output, **Tool Harness Findings** to tool output, **Standards
Compliance** to a resolved standards file, **Unknowns or Needs
Verification** to incomplete evidence. When a trigger is unmet, the section
is omitted entirely rather than emitted with "No findings" filler.

The prompt asks for this, and the sanitizer enforces it at publish time for
sections whose triggers are deterministic — it reads the same presence
signals the corpus builder used, so it can only remove a section the corpus
never offered in the first place.

## Repository config

A repository can also tune review behavior through an optional, repo-owned
config file instead of a wall of workflow `with:` inputs — same trust model
as the standards file (read from a trusted ref; can only narrow operator
inputs, never grant new authority). See
[`docs/repository-config.md`](./repository-config.md) for file locations
and precedence rules.

## Issue-first review workflows

If PRs are driven by detailed GitHub issues, use closing references
(`Fixes #40`, `Closes owner/repo#12`) in the PR body. The action fetches
those issue bodies into the review corpus so the model can compare the
implementation against issue guidance and acceptance criteria — see
[Linked issues](#linked-issues) above for the full fetch and labeling
behavior.
