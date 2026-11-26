# Required checks: `must_check` as a review obligation (#750)

Canonical contract for the deterministic `must_check` checklist and its
structured dispositions. This is the contract #678 (conversation/verdict
routing) consumes and #680 (enforcement migration) cuts over to.

## What `must_check` is

`must_check` items come from the deterministic classifier
(`src/classification/classify.ts`): plain-text review questions derived from the
PR kind, risk flags, and linked-issue metadata. They are **policy the model
does not own**:

> A `must_check` item is a mandatory review QUESTION — the reviewer must
> investigate and disposition it. It is **not** automatically an
> implementation or test requirement: the PR does not have to implement
> whatever action or test the English checklist sentence happens to mention.

The motivating failure (PR #748): the classifier emitted path-handling
checks for a change with no untrusted filesystem-path surface. One review
correctly inspected the risk, established it did not apply, and approved. A
later review read the same sentences as acceptance criteria and requested
changes because the named null-byte/symlink tests were absent. That
ambiguity is what the typed contract below removes.

## The dispositions

Every deterministic check receives exactly one structured disposition in
the verdict's `required_check_dispositions` array (external/model-facing
name; the strict `json_schema` carries it on both OpenAI- and
Anthropic-compatible paths):

| status           | meaning                                                                                   | rationale     |
|------------------|-------------------------------------------------------------------------------------------|---------------|
| `satisfied`      | the risk/question is relevant and was adequately verified/addressed                        | optional      |
| `not_applicable` | the reviewer established, from concrete change context, that the risk surface does not exist | **required**  |
| `unresolved`     | the check is relevant (or applicability cannot be established) and the evidence does not resolve it | optional |
| `unmet`          | the reviewer performed the check and confirmed the requirement is **NOT** satisfied (#1381); `failed` is accepted as a prose alias and folds to `unmet` | **required** |

Identity is the **exact deterministic check text echoed back** (matched
case- and whitespace-insensitively; any rewording is a different identity
and is dropped as unknown). The model cannot omit checks, invent additional
mandatory checks, duplicate one check to satisfy another (duplicates
deterministically invalidate the check), or alter the deterministic text and
still count it as covered.

**Attributable malformed entries are preserved, never collapsed.** A
disposition whose check identity is usable but whose answer is not — an
unknown status prose alias (`"N/A"`), a `not_applicable` or `unmet` without a
usable rationale — is kept by the parser as `{check, status: "invalid",
rationale: null}` (internal-only marker, never in the wire schema; the same
fail-conservative precedent as `requirement_coverage` normalizing unusable
claims to `unknown`). The coverage evaluator treats it as malformed and
leaves the check unresolved, so a valid answer followed by a malformed
"retraction" of the same check can never fold into a single valid
disposition and complete coverage. Only entries with no attributable
identity (non-object, non-string/empty/oversized check text) are dropped.

**Tri-state with key presence.** True absence of the
`required_check_dispositions` key is distinct from an explicitly emitted
`null` or another invalid type: the parser preserves a present-but-unusable
key with a `null` value, and the bridge treats it as structured coverage
with no usable array (every check unresolved). `#678` reads the same
tri-state (`requiredCheckDispositions` + `requiredCheckDispositionsEmitted`
in `src/model/types.ts`). Since #1252 there is no keyword fallback in any
state: key absence means every check is conservatively unresolved.

### When `not_applicable` is legitimate

Grounded in the actual change, for example: there is no attacker-controlled
filesystem path; the change performs no filesystem path resolution; the
flagged signal comes from trusted test scaffolding rather than runtime
input. The rationale is bounded (500 chars) and control-char sanitized.
`not_applicable` without a usable rationale is malformed and the check stays
unresolved.

The deterministic layer verifies **presence and shape** of the rationale —
never its truth. Whether an N/A is genuinely grounded on a fixture where the
risk is present is judged by the semantic qualification suite
(`required_check_grounding` scenarios in `evals/corpus-historical-dogfood.json`,
added by #750): there, an N/A wave over a real risk scores `not_found` —
a miss, never a pass.

## How deterministic completeness treats each status

`src/enforcement/completeness.ts` `structuredCoverage` folds the
dispositions against the supplied check list into the version-1 coverage
artifact (`tests-v3/required-checks.test.ts`, byte-identical with
`src/enforcement/required-checks.ts`):

- **zero `must_check` entries** → `none` (the model cannot invent an
  obligation set);
- **every check `satisfied` or grounded `not_applicable`** → `complete`;
- **any check `unresolved`, `unmet`, missing, duplicate-dispositioned,
  malformed-dispositioned, or an ungrounded N/A** → `incomplete`;
- **unknown/forged check identities** are dropped, never credited;
- **no structured dispositions at all** → the artifact records
  `structured: false` with every check unresolved (the conservative v3
  semantics).

`not_applicable` is a completed disposition. An absent named test does not
force `request_changes` when the underlying risk is demonstrably absent;
requesting changes is reserved for an actually violated applicable
requirement (`unmet`), exactly like a real blocking finding. An `unmet` disposition is a completed-but-failed
one: it is recorded verbatim (`reason: ok`), but it is never clean coverage
— the check was performed and the requirement confirmed NOT satisfied — so
it keeps coverage `incomplete` exactly like an `unresolved` check.

## `required-check-validation-mode` mapping

The public `required-checks` output vocabulary is unchanged
(`complete` / `incomplete` / `none`):

- `auto` — validate when `must_check` is non-empty;
- `warn` — append an `### Unaddressed required checks` section listing the
  unresolved checks; the completeness pass itself never flips the verdict
  (but see #1381 below — the review-obligation gate does, and it is not
  governed by this mode);
- `fail` — additionally forces `request_changes` through the completeness
  pass itself;
- `metadata_only` — record only (again, the completeness pass; the #1381
  obligation gate below is independent of this mode).

Structured dispositions, when present, are authoritative for this decision;
no keyword mention can substitute for a missing or malformed disposition.

## Review-owned obligations (#1381)

Once represented as review-obligation rows (`src/enforcement/review-obligations.ts`),
deterministic `must_check` items share one approval semantics with extracted
trusted-base approval prerequisites. Forcing is **status-based** (#1505):
an **`unmet`** row — the check was performed and the requirement confirmed
NOT satisfied — is a confirmed negative and is a real blocking result
exactly like a blocker/major finding: it forces `request_changes` through
the enforcement overlays, and a native APPROVE never certifies it. #1657
(review) narrows this by row class: an `unmet` on a tagged review-prompt
row records the semantic negative for accounting but does NOT force — only
an explicitly-objective mandatory requirement (and untagged `legacy` rows)
keeps the forcing semantics. An
**`unresolved`** row — the evidence was never gathered — is an availability
failure, never a defect: it marks the review partial/incomplete, withholds
the trusted native APPROVE at the publish boundary (the native event
becomes a `COMMENT`, never a blocking `REQUEST_CHANGES`), and does not
manufacture a blocking request out of an incomplete review. Real blocking
findings still force `request_changes` as before — only the unresolved
coverage distinction changed. Disposition identity follows each source's contract: `must_check`
rows fold ONLY on the exact check text (identity parity with #750's
completeness fold, which recognizes only the deterministic check text — an
`obligation-<n>` echo never discharges one), while `trusted_base_guidance`
rows fold on the obligation id or the exact text.
`required-check-validation-mode` keeps owning the completeness markdown and
metadata; it no longer decides whether approval may publish. The single
operator opt-out is `VALIDATE_REQUIRED_CHECKS=false` (the public
`validate-required-checks` input): it removes `must_check` rows from the
obligation contract at both layers, so the model is not shown — and the
engine does not enforce — rows the operator disabled.

## v2/v3 coexistence (until #680) — historical

The v2 pipeline kept a shallow keyword matching fallback
(`completeness.py::validate_review`) for outputs that carried no
`required_check_dispositions` field at all (models on
`ai-response-format: off`/`json_object` that never engaged with the
structured contract). That fallback was removed from the live path by #680
and the remaining keyword reference code (`should_escalate`, its keyword
table, `validate_review`, and the duplicated concept table) was deleted by
#1252; see `docs/v3-migration.md`. The v3 evaluator treats a missing field
conservatively (all checks unresolved).

## Escalation authority (#721) is unchanged

Required-check incompleteness — including `unresolved` dispositions,
missing/malformed coverage, and every other completeness outcome — is
**never** an escalation trigger. The only post-primary smart trigger remains
the literal structured `smart_review_requested === true` from a successful
primary review (`escalation.py::reviewer_requested_escalation`). The
`should_escalate` heuristics they once fed were removed with the keyword
table (#1252); telemetry, where it still exists, follows the same
structured-first contract so a grounded N/A is not misreported.

## What #678 consumes

- `ParsedReviewVerdict.requiredCheckDispositions`
  (`src/model/types.ts`) — normalized per-entry
  `{check, status, rationale}` (camelCase internal), `null` when the model
  emitted no field;
- `evaluateRequiredCheckCoverage(checks, dispositions)` +
  `requiredCheckCoverageToArtifact` (`src/enforcement/required-checks.ts`)
  — the pure completeness fold, ready to wire into the #681 orchestrator;
- the verdict-turn contract now carries `required_check_dispositions` in
  the strict schema (the duplicated copies pinned byte-identical by
  `tests-v3/request.test.ts`).

## What #680 still owned (historical; completed by #680/#1252)

- consuming the typed coverage artifact in enforcement instead of the v2
  bridge — done by #680, with the residual keyword reference code deleted
  by #1252;
- deciding whether `incomplete` maps onto verdict policy in the v3 runtime
  (the v2 `warn`/`fail` behavior remains the production path until then);
- publishing/publication-side presentation of per-check dispositions;
- any richer rationale validation — the deterministic layer deliberately
  stays at presence/shape.

## CI-evidence discharge and contradiction (#1594)

A `must_check` ask that demands a **test run** may be discharged by existing
trusted CI evidence instead of a model disposition. The CI gate
(`src/gates/ci-wait.ts`) already reads the exact reviewed head's check list;
on a finalized wait it records that list as a head-bound `ci_checks_evidence`
gate-output artifact (never a published action output, never an extra forge
call). `src/enforcement/required-check-ci.ts` reconciles it into both the
#750 coverage rows and the #1381 obligation rows, keyed on identical row text:

- **discharge**: a check whose name is a delimited `test`/`tests` word —
  and no disqualifier token (coverage/report/upload/publish/deploy/image/
  scan/analysis/lint/docs/formatting names do not *run* tests) — concluded
  `success` **on the exact reviewed head**, and whose name **proves the
  requested test scope**. A narrow scope (`unit`, `integration`, `e2e`,
  `smoke`, `acceptance`, `contract`, `regression`, `performance`, `load`,
  `browser`, `ui`, `api`, `functional`, `mutation`, `fuzz`) must match the
  ask: `Unit Tests` cannot discharge `run integration tests`, and a generic
  `test` name cannot prove an integration-only ask. A full-suite ask
  (`full`/`all`/`entire`/`complete`/`exhaustive`/`suite`) needs an explicit
  exhaustive identity in the check name (`test suite`, `full test suite`,
  `all tests`) with no narrow scope: a bare generic `test`/`tests`/
  `test (24)` name does not prove which suite ran, and one narrow matrix leg
  cannot discharge it. A generic ask accepts any test execution.
  **Failure-first precedence** is scoped the same way: a differently named
  in-scope test check that went red on the exact head ref refutes discharge
  even when a differently named sibling matrix leg is green, while a red
  unrelated scope neither refutes nor discharges. Same-named legs within one
  workflow run are collapsed to the most recent run before this fold ever
  sees them — the producer's read inherits GitHub's default
  `filter=latest`, which returns the most recent check run per check-suite
  and name, so the forge itself already applies its retry/required-check
  semantics (see the producer fold below). A full-suite ask also needs every
  in-scope test check settled green: a pending leg, or a `skipped`/`neutral`
  leg collapsed to state `success`, keeps it unresolved beside a green
  sibling (the explicit conclusion is required, and one leg that did not run
  means the suite did not run). The row records the CI provenance
  (`reason: ci-evidence` / obligation `resolvedBy`), deterministically — no
  model re-invocation.
- **contradiction**: the reviewer narrative completed the row (`satisfied`,
  or a grounded `not_applicable` — the obligation fold #1381 folds both into
  a satisfied row, so the coverage fold downgrades both together to keep the
  two artifacts in agreement) but a matching head-bound test-execution check
  concluded negative — the row becomes `unresolved` with reason
  `ci-evidence-contradiction` and the published review carries the mismatch
  explicitly, never both claims. A row the model never dispositioned keeps
  its `unresolved` status with the annotated reason code
  `ci-evidence-test-check-contradicted`.
- **everything else stays unresolved** with a bounded reason code
  (`ci-evidence-no-ci-evidence`, `-head-mismatch`,
  `-no-matching-test-check` — including a check whose scope does not prove
  the ask, `-configured-test-job-missing` (#1820),
  `-configured-identity-ambiguous` (#1820 same-named rows),
  `-ci-workflow-surface-untrusted` (#1820 masquerade fence),
  `-test-check-not-success`):
  capability, missing-source, transport, budget and timeout shaped failures
  are coverage, never satisfaction.
- **derived rows and `unmet` (forcing) rows are never reconciled** by CI
  evidence (#1449/#1505/#1381 semantics unchanged — discharge only from
  validated evidence, contradiction only strengthens the approval fence).
- **no evidence, no change**: with no evidence artifact (or an unusable one,
  refused by the strict parser) every output is byte-identical to pre-#1594.
- **producer obeys the consumer without losing decision evidence**: the gate
  emits at most 50 rows and a 16,384-character (UTF-16 code unit) JSON value,
  truncates names/conclusions to the parser's 200-unit field bound (never
  splitting a surrogate pair), and drops invalid states. Classifying and
  retaining rows uses the COMPLETE source name, never the truncated copy:
  if bounding would change a check's decision identity (test-execution
  classification, proved scope, or exhaustive identity), the gate emits NO
  evidence line rather than let a truncated skipped test row read as
  disposable context. Every test-execution row is retained; only non-test
  context rows may be trimmed (failed rows first). If the complete test-row
  set cannot fit, the gate also emits NO evidence line — an artifact missing
  a skipped, pending, or otherwise incomplete test leg could otherwise look
  falsely complete and discharge a full-suite ask. Every exact GitHub Actions
  check-run row is retained unconditionally, and a row whose name or
  conclusion bounding altered is marked `clipped` in the artifact so it can
  never serve as an exact identity match downstream. Each row also carries
  its producer `origin`: `actions` (the forge's native Actions check run —
  on GitHub, `app.slug === "github-actions"`), `check` (a check run from
  another integration), or `status` (a commit-status context). Same-name
  check runs from different workflow runs are no longer collapsed into one
  row: a same-name green from one workflow can never discard a same-name red
  from another, which for unconfigured repositories can only make more
  failure rows visible, never fewer. Same-name check runs within one Actions
  workflow run collapse to the newest row — the same newest-attempt semantics
  GitHub itself applies, and usually redundant with them: the producer's
  read (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs` with GitHub's
  default `filter=latest`) already returns the most recent check run per
  check-suite and name, so a re-run's earlier attempts and a run's
  same-named legs are collapsed server-side before the fold sees them
  (verified against the live API: re-run attempts share one check-suite id,
  re-created check runs carry new ids, and the default read returns only the
  most recent). The fold's own same-run collapse is the bounded defense that
  mirrors the forge's view for payloads where duplicates do arrive; the
  forge's required-check view is the authority for retry and same-name-leg
  semantics, and the #1820 identity controls below — producer binding,
  config-time validation, and the masquerade fence — are the enforceable
  layer on top of it. Non-Actions check runs keep the #995 newest-wins
  collapse: their key carries no run identity, so same-app same-name rows
  are indistinguishable from retries. A final
  strict-parser round-trip means an oversized or malformed artifact is never
  emitted.
- **publish re-folds agree with the review**: the engine persists its
  RECONCILED fold to the run dir (`required-check-coverage.json`,
  version-tagged); the standalone `publish` CLI reads it back (strictly, and
  only when its status matches the recorded `required_check_fold_status`)
  instead of recomputing the raw #750 coverage — which would re-list a
  CI-discharged row as unresolved and omit a contradicted one. A run dir
  without the artifact keeps the pre-#1594 recompute exactly.

## Trusted explicit CI test-job identities (#1820)

Configured discharge requires an exact GitHub Actions check-run producer.
Forgejo and GitLab provide commit statuses without per-check producer identity,
so configured asks remain unresolved there by design; the workflow-surface
fence remains the second guard.

Name heuristics read the check NAME. Some real full-suite jobs do not carry a
test word — this repository's own `validate-typescript` and
`validate-runtime-floor` — so their green runs could not discharge a
full-suite ask. #1820 adds a trusted way to name those jobs; the
reconciliation above is unchanged for every repository that does not opt in.

- **Where**: an optional repository-owned file, read from the PR's base ref
  (never the PR head) with the same trust rules as repository config:
  `.github/pr-reviewer-ci-tests.yml`, then `.pr-reviewer-ci-tests.yml`.
  Implementation: `src/config/ci-test-jobs.ts`. A PR cannot declare its own
  job trusted. For PRs into the protected default branch, only a change
  merged there can alter the file; for PRs into other branches, whoever can
  push the target branch controls it — the same base-ref trust every
  repository-config file already has.
- **Shape**: a `test-jobs` mapping from the check identity to the scope it
  proves. The identity is the check name the forge exposes, matched exactly
  (after trimming; case-sensitive — a mismatch stays unresolved, the
  conservative side):

  ```yaml
  test-jobs:
    validate-typescript: full-suite
    validate-runtime-floor: full-suite
  ```

- **Scopes**: `full-suite`, or one narrow scope (`unit`, `integration`,
  `e2e`, `smoke`, `acceptance`, `contract`, `regression`, `performance`,
  `load`, `browser`, `ui`, `api`, `functional`, `mutation`, `fuzz`) — the
  same scope vocabulary the name heuristics use.
- **Authority**: for a configured check, the configured scope replaces the
  name-derived scope entirely only when the evidence row is an exact, unclipped
  GitHub Actions check run (`origin: "actions"`) and exactly one such row has
  the configured name. Two same-named rows — from different workflow runs (a
  workflow triggered by two events on the same commit produces two) — refuse
  the configured identity with `configured-identity-ambiguous`, and the
  configured ask stays unresolved. Commit-status
  contexts and third-party check runs never satisfy configured identities;
  those rows can still satisfy the pre-#1820 name heuristics. Unconfigured
  checks keep the name heuristics.
- **Config-time identity validation**: every configured identity must name
  exactly one static display name in the base ref's `.github/workflows`; a
  job without `name:` contributes its key, a static `name:` contributes only
  that name, and a dynamic name contributes neither. Undeclared or multiply
  declared identities are refused with a warning. Any unreadable, oversized,
  invalid-YAML, or jobs-less `.yml`/`.yaml` workflow, or any PR-controlled job
  display name, refuses ALL configured identities with a warning and degrades
  the feature to pre-#1820 name heuristics while the workflow-surface
  masquerade fence stays armed (see below). Non-YAML files are skipped. The
  scan is bounded to 32 YAML files, 256 KiB per file, 1 MiB aggregate, and one
  shared 10s deadline. It is deliberately GitHub-scoped because configured
  discharge is GitHub-Actions-only; the workflow-surface fence remains the
  broader forge-agnostic guard. Only `.yml`/`.yaml` files (any case) are
  scanned; other files under `.github/workflows` cannot mint check-run names
  and are skipped. Each expression span is accepted only when it
  references `matrix`, `strategy`, or admin-controlled `vars`, and contains no
  PR-controlled/launderable context (`github`, `env`, `needs`, `steps`,
  `secrets`, or `inputs`). A dynamic name is accepted only when its
  provenance is provable: a name that interpolates `matrix.*` requires the
  job's `strategy.matrix` to be statically enumerable — a literal mapping
  with no expression anywhere inside it (expressions in `fail-fast` or
  `max-parallel` do not affect rendered names) — and the job must not be a
  reusable-workflow call (`uses:` renders the name inside the callee). A
  matrix laundered from an expression (for example
  `strategy.matrix: ${{ fromJSON(...) }}`, where the producing job may run a
  script checked out from the PR head) or an absent matrix makes a
  `matrix.*` name PR-mintable; a dynamic name that does not interpolate
  `matrix.*` at all (for example a `vars`-only name) is accepted on a regular
  job but contributes neither key nor name, while any dynamic name on a
  reusable-workflow call (`uses:`) is PR-mintable regardless of what it
  interpolates (#1820 re-review). A PR-mintable name or an unreadable surface
  refuses ALL configured discharge; an identity that names no single static
  job is refused individually. When every declared identity ends up
  unhonored — a refused surface, malformed YAML that still declares entries,
  or declarations that all failed validation — the resolver computes the real
  workflow-surface state, reports the identities as refused, and the
  masquerade fence below stays armed even though no identity remains —
  refusing identities must never silently disable the fence that a
  PR-added-workflow masquerade would otherwise trip. The check-run payload
  carries no workflow
  identity, so the trusted base surface is the only statement of which names
  the repository's own CI can mint. A reusable-workflow caller contributes its
  job key even though the check name may come from an inner job; runtime
  matrix-leg names remain outside `staticNames`, so an identity can never be
  validated against them. Those conservative mismatches can leave a
  validated-but-never-satisfiable identity unresolved.
- **The declared set defines the suite**: when a full-suite ask is settled
  against a config that declares `full-suite` jobs, EVERY configured
  `full-suite` identity must appear in the head-bound evidence and be green.
  This every-declared-leg rule also applies to generic asks (every
  `full-suite`-declared leg) and narrow asks (every leg declaring one of the
  requested scopes), not only full-suite asks. One missing leg keeps the row
  unresolved (`configured-test-job-missing`) — even when an unrelated
  heuristic-matched `Tests` job is green. A red configured leg still
  contradicts (failure-first, unchanged); a pending or skipped-collapsed leg
  still blocks (unchanged).
- **Narrow and generic asks** discharge from a configured job only for its
  configured scope: a `full-suite` job proves a generic "run tests" ask, not
  a narrow `run integration tests` ask; a narrow-declared job proves only
  asks for its own scope.
- **Declare only jobs that run on every PR.** A configured `full-suite`
  identity that is absent from the evidence (a scheduled, path-filtered, or
  removed job — or a mis-declared name) keeps every full-suite ask
  unresolved, and an unresolved `must_check` row withholds the trusted
  native approve. The producer marks control-collapsed or truncated check
  names and conclusions as `clipped`; clipped rows never satisfy configured
  identities. The gate retains every test-named row and every exact Actions
  check-run row, and never trims Actions rows out of the evidence. Other
  context rows may still be trimmed at the 50-row / 16,384-character bounds.
- **Workflow-surface masquerade fence (#1820)**: configured identities exist
  and the PR leaves the supported forges' CI workflow surface unchanged
  relative to the merge-base of the trusted base ref before any CI evidence
  can settle a test-run ask. If a PR adds or edits a workflow file there —
  `.github/workflows`, `.forgejo/workflows`, `.gitea/workflows`, or
  `.gitlab-ci.yml` — or the surface cannot be verified (git failure or
  missing head) while the identities were readable, every test-run row stays
  unresolved that run with `ci-evidence-ci-workflow-surface-untrusted`. The
  fence also stays armed when identities were declared but not honored this
  run — a refused surface, an unreadable surface, a malformed config that
  still declared entries, or declarations that all failed validation — the
  refusal must never silently disable it (#1820 re-review). A red
  relevant leg still contradicts (failure-first). Repositories without
  configured identities retain the pre-#1820 name-heuristic behavior. The
  merge-base anchor is deliberate: for PR events the effective workflow set
  is the merge commit, so the attacker-controlled delta is exactly the
  merge-base diff; a two-dot diff would fence benign PRs whenever the trusted
  base advances its own workflows. Verification requires the base ref and its
  merge-base with the head locally. A shallow checkout (`fetch-depth: 1`)
  cannot resolve the base ref at all, so the identities are unreadable and
  the fence is inert — the pre-#1820 name heuristics stay in force, which is
  weaker than the fence but unchanged from before; the fork lane's base-only
  checkout keeps the identities readable, so there the fence stays closed and
  configured discharge is inert rather than weakened. CI evidence never
  certifies what tests DO: a PR can alter test content (`scripts`,
  `package.json`, `Makefile`) without touching a workflow file. The fence
  narrows the masquerade surface but does not attempt content certification.
  `full-suite` covers full-suite and generic asks only, never a narrow scope
  ask — declare `unit` (or the desired narrow scope) if a configured job is
  meant to prove it. The fence covers standard workflow-definition paths;
  external CI systems (CircleCI, Jenkins, Azure Pipelines, Travis, Buildkite)
  report commit-status contexts without any listed file, and a GitLab
  `include:` chain can define jobs outside `.gitlab-ci.yml` — a PR editing
  those configs can still mint a heuristic-accepted name for a narrow ask, so
  the residual risk is narrower than unfenced name matching but not zero.
  Configured identity discharge does not accept status contexts, closing that
  status-context residual for configured asks; status rows can still match the
  pre-#1820 name heuristics, so the residual remains for repositories without
  a matching configured identity.

## Evidence classes and objective provenance (#1657)

#1657 replaces the #1627/#1634 call-ID citation gate (a cited `call-<n>` plus
argument-token overlap was treated as consumable proof, one executed call
backed at most one discharge). That machinery is deleted. In its place every
`must_check` row carries an **evidence class** carried as TRUSTED PRODUCER
METADATA: the classifier tags each row it emits in
`MUST_CHECK_EVIDENCE_TAGS` (`src/classification/classify.ts`) and the tag
rides the persisted artifact as `must_check_evidence` into both folds. Row
class is never inferred from the row's wording downstream:

| class           | which rows                                                                 | merge-affecting? |
|-----------------|----------------------------------------------------------------------------|------------------|
| `objective`     | rows the classifier tags objective with an explicit gate kind at emission: test-run asks (exact-head CI), upstream provenance / release-delta / security-advisory acquisition asks, and rows the producer binds to exact path/version/head/slug identities | **yes** — an unresolved objective row is the merge-affecting incompleteness |
| `review-prompt` | rows tagged review-prompt at emission: generic auth/path/security/scrutiny questions and absence asks ("no vulnerability", "no breaking change") | no — disclosed with reason codes, never independently incomplete, and an `unmet` answer never manufactures `REQUEST_CHANGES` |
| `attention`     | rows tagged attention at emission: the P0/P1 linked-issue sentences ("treat as critical — verify all changes thoroughly", "treat as high priority — verify correctness carefully") | no — attention/routing signals, not propositions |
| `legacy`        | rows without a trusted tag: hand-written/minimal artifacts and dynamic rows | **yes** — untagged rows retain conservative pre-#1657 gating semantics. A row whose trusted metadata fails strict validation is `legacy` too: validation voids the metadata, never deletes the mandatory row (#1657 round 8) |

Identity extraction from a check's text happens only AFTER a row is tagged
`objective` — solely to validate the tagged identity against receipts. It
never decides whether the row is material.

The rules this buys, and their limits:

- **A receipt never certifies a semantic conclusion.** The deterministic
  layer validates objective acquisition facts only — what was acquired,
  source/path/span or CI/upstream identity, exact head/version/revision,
  acquisition success/failure, complete/truncated, freshness/trust scope —
  from records the run itself wrote (the `tool_calls`/`tool_results` trace,
  the assembler-certified corpus diff payloads, the CI gate's head-bound
  evidence). One implementation, `buildEvidenceLedger`, feeds both folds; a
  trace present but unparseable REFUSES the whole ledger (fail closed, never
  a silent no-op), and a trace without its aligned results is refused too.
  The aligned executor result is validated BEFORE any receipt is built and
  is the acquisition authority: a malformed envelope (missing entry,
  null/primitive/array, a missing `status` or one outside the executor's
  closed `ok`/`error` vocabulary, a nested `result` payload that is absent
  or not an object for ANY status — production nests one under both `ok`
  and `error` — or a present-but-malformed `truncated` flag) refuses the
  ledger rather than letting `tool_calls.status` — a harness display
  mirror — manufacture an `acquired` receipt. A valid result
  saying `error` beside a call claiming `ok` is evidence state, not a
  refusal: the receipt stays recorded and unacquired. A SUCCESS whose
  payload lacks the tool's minimum real output shape (the executor's own
  observation field for that tool — `content`, `matches`, `results`,
  `response`, …) is likewise refused: call arguments never stand in for
  the acquisition they merely requested. Legitimate non-text observations
  (a binary file read via `repo_contents` or decoded `gh_api` contents)
  are real but never earn a content-capability receipt — the receipt
  downgrades to discovery instead of masquerading as complete source
  content. Completeness is a SEPARATE authority read where production
  reports it: `executeToolRequest` nests every tool's fields under the
  envelope's `result` and records each output clip (mask/byte caps, the
  web-fetch body slice, the process-capture flags, and a default
  whole-file `read_file` whose 12k-codepoint window actually discarded
  bytes) as `truncated` on that PAYLOAD. The receipts layer reads the
  nested flag — an envelope-level `truncated` is unknown and ignored —
  and a malformed nested flag refuses the ledger like a malformed
  status. Correspondingly the executor boundary must report every clip it
  performs into the payload; receipt layers never guess completeness from
  output size, and a clipped read of a whole path is never a complete
  acquisition receipt.
- **Receipts are shareable evidence, not consumable tokens.** One genuine
  acquisition may support any number of conclusions; there is no allocation
  and no per-row consumption. A receipt that carries none of a row's
  required identity never contributes to it.
- **Objective `satisfied` claims are validated, never manufactured.** The
  reviewer's disposition stands or falls with the ledger: a claimed
  `satisfied` on an objective row is credited only when validated receipts
  cover the requirement (jointly — one receipt may carry several identities),
  and stays unresolved with a reason code otherwise: `receipt-absent`
  (nothing relevant was acquired), `receipt-unverified` (relevant attempts
  failed, were truncated (except in the #1782 dependency-evidence pool,
  where body completeness is not a pool gate — see below), or are outside
  the requirement's freshness/trust scope — an attempt is not evidence, and
  a stale/wrong-head read is objectively invalid), `receipt-mismatch` (relevant receipts exist but none
  carries the exact identity — kind-appropriate boundaries, never
  substrings), or `trace-refused`. The deterministic layer never flips an
  unresolved row to satisfied from receipts alone — that remains the
  reviewer's judgment, and #1656/#1659 own the final disposition.
- **Review prompts and attention rows carry no provenance choreography.**
  Their dispositions fold on the presence-and-shape rule exactly as before
  the citation gate existed; an unanswered or unresolved one is disclosed
  (row `status`/`reason`/`row_class`/`evidence`) but never gates
  completeness, never withholds by itself, and never forces. A tagged
  review prompt's `unmet` answer records the semantic negative for
  accounting but never independently manufactures `REQUEST_CHANGES` — a
  reviewer-determined semantic defect belongs in an ordinary grounded
  blocker/major finding, and the final approve/incomplete call is the
  disposition layer's (#1656/#1659). The one structural disclosure: a run
  that emits no structured dispositions at all still records
  `structured: false` — the skipped contract is visible, but only an
  unresolved OBJECTIVE row makes it merge-affecting.
- **Narrow deterministic reconciliation stays where truth is mechanical.**
  The #1594 exact-head CI discharge/contradiction above is unchanged — it
  remains the only auto-satisfaction reconciler, and only when the CI
  identity/scope genuinely proves the ask. Upstream-evidence rows
  (provenance/release-delta/advisory) are acquisition asks: their satisfaction
  is validated against acquisition receipts attributed by the shared #1379
  URL/query-shape rules, bound to the producer-parsed dependency scope. That
  scope (`dependency_scope` on the tagged rows) is the COMPLETE trustworthy
  set of dependency updates the PR's diff actually changes — exact
  `{slug, versions[, kind][, digests]}` entries parsed ONLY from
  producer-recognized dependency surfaces (npm lockfile package blocks, npm
   manifest dependency sections, Helm chart manifests, and — #1763 —
   container-image / OCI-chart surfaces: Kustomize files, Flux HelmReleases,
   Kubernetes workloads, compose files, Helm values files, Dockerfiles, and
   — Flux names OCIRepository manifests after the release, not the kind, so
   recognition of that surface reads the root-column document-marker pair
   `apiVersion: source.toolkit.fluxcd.io/…` + `kind: OCIRepository` in the
   file's own diff instead of the file name; a `diff --git` header whose path
   the parser cannot resolve (quoted non-ASCII, embedded space) fails the
   WHOLE scope closed),
  carrying the exact changed old→new version identity where the diff shape
  has one. An absent `kind` is `npm` (every pre-#1763 entry/artifact keeps
  byte-identical semantics); `image`/`chart` entries name the canonical
  registry identity (Docker Hub canonicalized to `docker.io/…`, `library/`
  stripped) and carry changed `sha256` digests when pinned. A receipt backs
   the row only when, per obligation kind, the validated receipts JOINTLY
   cover EVERY entry — identity per the entry's kind: an npm entry's exact
   slug, and #1763's image/chart identity via the exact slug token (the
   generic any-position carry the npm cells have always accepted — a page
   spelling the FULL artifact identity is the documented residual, never
   a single OWNER/artifact segment), the canonical registry-catalog page,
   the SOURCE mapping the artifact's canonical registry document
   established (#1782: a fetched `web_fetch` surface counts through the
   mapping only when the repository IT addresses equals the mapped
   `host/owner/repo` exactly — owner-token spelling, a same-owner
   unrelated repository, a lookalike name, or the same `owner/repo` on a
   different host carries nothing through the mapping; a forge read keeps
   only the generic slug carry, as its receipt records no forge host), or
   an advisory `web_search` QUERY naming the artifact or owner (a query is
   not an attacker-registerable surface) — and, for every kind
  that asserts the update itself (release delta
  AND advisory), the COMPLETE captured changed-version identity: an advisory
  check naming only one endpoint of a captured `old → new` range never
  certifies the updated range (acquisition provenance bound to the captured
   range — never semantic vulnerability proof). Provenance settles by ONE
   canonical-source rule per ecosystem (#1748 → #1763 → #1782): an npm entry
   only from the canonical npm registry document, an image/chart entry only
   from the canonical registry-catalog page for the exact artifact path
   WHOSE FETCHED DOCUMENT CLAIMS the artifact→source/build mapping
   (`org.opencontainers.image.source` annotation or registry metadata
   `source`/`repository` field, normalized to one `host/owner/repo`
   identity; a bare index body, an unattributable claim, or conflicting
   claims settle nothing — a pullable identity proves the registry serves
   the artifact, never which repository builds it, and this retained
   mapping is what the version-asserting rows then bind through). A
   same-named repository/image under another owner, a forge read, or a
   search query proves nothing about who publishes the artifact. A versionless entry
  (the parser emits one for re-resolution-only changes) certifies
  `provenance` only — the identity proves WHO the dependency is, never an
  exact delta or an updated version range — and a one-sided entry certifies
  no release delta; a kind-matched acquisition of the right identity then
   stays `receipt-mismatch` and the objective row stays material-unresolved
   through the existing disposition path (never a blocker, never versions
   inferred from prose, URLs, or receipt text). The dependency pool credits
   ACQUISITION facts — the tool, its target URL/query, the
   executor-validated redirect chain, and the 2xx status — so body
   completeness is NOT a pool gate for these cells (#1782): the executor's
   fixed fetch slice clips every real registry/repository HTML page, and a
   clipped body has never been evidence for them; the one place content IS
   evidence (a document-claimed source mapping) carries its own completeness
   gate in the rule above. `complete` stays on every receipt for all other
   ledger consumers, and a FAILED acquisition still splits to
   `receipt-unverified`. Attribution is HUNK-LOCAL: a
  `@@` header resets the lockfile package, manifest section, chart identity,
  and image/chart anchor, so a previous hunk's block header, dependency
  section, chart name, or image anchor never carries into this one (this
  hunk's own context may re-establish it). Version identity is EXACT: a
  lockfile version comes only from the package block's actual `"version"`
  field validated as one version token — never from relation values, ranges,
  resolved URLs, engines or integrity hashes; a chart version only from the
  `version`/`appVersion` field anchored to chart identity in the same hunk;
  an image version only from the reference's own tag or an anchored
  `version:`/`appVersion:`/`tag:` line, as one exact token (full `x.y.z` or
  short dotted like `7.2`, one optional leading `v`) — `latest` or
  `bookworm` is not a checkable version identity and fails closed. A
  split-key `registry:` (bitnami-style `<registry>/<repository>` spellings)
  is resolved per key column in a per-hunk pre-pass and qualifies only
  same-column host-less repo values; a `registry:` value that is not one
  clean host, two distinct hosts at one column, or any CHANGED `registry:`
  (a provenance switch, never a version refresh) fails the WHOLE scope
  CLOSED. Unchanged hunk-context neighbors never enter scope;
  dependency-shaped text outside a recognized surface never does; on a
  lockfile surface ANY changed line the current hunk cannot attribute to a
  package block fails the WHOLE scope CLOSED rather than being silently
  omitted — package content comes in every JSON value shape (boolean,
  number, null, object, array), so the only changed lines that stay
  non-scope metadata while unattributed are structural punctuation and the
  lockfile root object's own keys inside the attributed root; on an image
  surface an unanchored changed version line or an image-shaped-but-unparseable
  line (`newName:`/`newTag:`, a failed or quoted-key reference, a stray
  `oci://`, marker residue) likewise fails the WHOLE scope CLOSED, while
  plain non-image config content in the same file is legitimately ignored;
  and overflow, unattributable shapes, and unread dependency surfaces
  (yarn/pnpm/go/pip/…) fail the scope CLOSED — the rows stay unresolved
  rather than certifying a partial update set.
- **No repair from prose.** Malformed or stale provenance is visible and
  reason-coded; nothing rewrites a disposition.
- **Surfaces for #1656/#1659**: every coverage and obligation row carries
  additive `row_class` and `evidence` (`{gate, state, receipt_ids}`); the
  bounded ledger rides the run dir as `evidence-receipts.json` (strict
  round-trip reader, `unavailable` explicit rather than inferred); the
  required-evidence sentinel rows carry `row_class`. Nothing here decides
  APPROVE/INCOMPLETE — the disposition layer consumes the reason-coded state.
- **Compatibility**: without a ledger (fresh standard-call and fork paths)
  the receipt gate is INERT — satisfaction folds on the pre-#1627
  presence-and-shape rule — but trusted producer tags still intentionally
  govern which rows are merge-affecting: tagged review-prompt/attention rows
  are non-gating and only untagged `legacy` rows retain the old gating
  behavior. The retired #1627/#1634 reason strings remain readable in
  persisted artifacts but are no longer written.

## Regression coverage

- PR #748-shaped deterministic case (path checks over a change with no
  untrusted path surface; grounded N/A → complete), pinned by
  `tests-v3/required-checks.test.ts` and the inline inputs of
  `tests-v3/requirement-coverage.test.ts`;
- ungrounded-N/A converse: semantic scenarios #7480 (N/A wave over a real
  path risk is `not_found`) and #7481 (grounded N/A on a clean docs change
  is not flagged) in `evals/corpus-historical-dogfood.json`.
