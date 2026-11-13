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
the enforcement overlays, and a native APPROVE never certifies it. An
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
  **Failure-first precedence** is scoped the same way: an
  in-scope test-named check that went red on the exact head refutes
  discharge even when a sibling matrix leg is green, while a red unrelated
  scope neither refutes nor discharges. A full-suite ask also needs every
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
  the ask, `-test-check-not-success`): capability, missing-source, transport,
  budget and timeout shaped failures are coverage, never satisfaction.
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
  falsely complete and discharge a full-suite ask. A final strict-parser
  round-trip means an oversized or malformed artifact is never emitted.
- **publish re-folds agree with the review**: the engine persists its
  RECONCILED fold to the run dir (`required-check-coverage.json`,
  version-tagged); the standalone `publish` CLI reads it back (strictly, and
  only when its status matches the recorded `required_check_fold_status`)
  instead of recomputing the raw #750 coverage — which would re-list a
  CI-discharged row as unresolved and omit a contradicted one. A run dir
  without the artifact keeps the pre-#1594 recompute exactly.

## Evidence classes and objective provenance (#1657)

#1657 replaces the #1627/#1634 call-ID citation gate (a cited `call-<n>` plus
argument-token overlap was treated as consumable proof, one executed call
backed at most one discharge). That machinery is deleted. In its place every
`must_check` row carries a deterministic **evidence class** — a pure function
of the check text (`classifyCheckEvidence` in
`src/enforcement/evidence-receipts.ts`) over closed vocabularies:

| class          | which rows                                                                 | merge-affecting? |
|----------------|----------------------------------------------------------------------------|------------------|
| `objective`    | rows mapping to a concrete deterministic gate: test-run asks (exact-head CI), upstream provenance / release-delta / security-advisory acquisition asks, and rows naming exact path/version/head/slug identities | **yes** — an unresolved objective row is the merge-affecting incompleteness |
| `review-prompt`| generic auth/path/security/scrutiny questions and absence asks ("no vulnerability", "no breaking change") | no — disclosed with reason codes, never independently incomplete |
| `attention`    | the P0/P1 linked-issue sentences ("treat as critical — verify all changes thoroughly", "treat as high priority — verify correctness carefully") | no — attention/routing signals, not propositions |

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
  failed, were truncated, or are outside the requirement's freshness/trust
  scope — an attempt is not evidence, and a stale/wrong-head read is
  objectively invalid), `receipt-mismatch` (relevant receipts exist but none
  carries the exact identity — kind-appropriate boundaries, never
  substrings), or `trace-refused`. The deterministic layer never flips an
  unresolved row to satisfied from receipts alone — that remains the
  reviewer's judgment, and #1656/#1659 own the final disposition.
- **Review prompts and attention rows carry no provenance choreography.**
  Their dispositions fold on the presence-and-shape rule exactly as before
  the citation gate existed; an unanswered or unresolved one is disclosed
  (row `status`/`reason`/`row_class`/`evidence`) but never gates
  completeness, never withholds by itself, and never forces. The ONE
  conservative exception to non-gating is structural: a run that emits no
  structured dispositions at all still records `structured: false` — the
  skipped contract is visible, but only an unresolved OBJECTIVE row makes it
  merge-affecting. Generic questions affect the merge only through a
  concrete objective gate or the reviewer's own material unknown/finding
  (a confirmed negative `unmet` still forces, status-based #1505 semantics
  unchanged).
- **Narrow deterministic reconciliation stays where truth is mechanical.**
  The #1594 exact-head CI discharge/contradiction above is unchanged — it
  remains the only auto-satisfaction reconciler, and only when the CI
  identity/scope genuinely proves the ask. Upstream-evidence rows
  (provenance/release-delta/advisory) are acquisition asks: their satisfaction
  is validated against acquisition receipts attributed by the shared #1379
  URL/query-shape rules — the static classifier sentence still embeds no
  package identity (#1595), and the receipts carry the objective identity.
- **No repair from prose.** Malformed or stale provenance is visible and
  reason-coded; nothing rewrites a disposition.
- **Surfaces for #1656/#1659**: every coverage and obligation row carries
  additive `row_class` and `evidence` (`{gate, state, receipt_ids}`); the
  bounded ledger rides the run dir as `evidence-receipts.json` (strict
  round-trip reader, `unavailable` explicit rather than inferred); the
  required-evidence sentinel rows carry `row_class`. Nothing here decides
  APPROVE/INCOMPLETE — the disposition layer consumes the reason-coded state.
- **Compatibility**: without a ledger (fresh standard-call and fork paths)
  both folds are byte-identical to pre-#1627 semantics; the retired
  #1627/#1634 reason strings remain readable in persisted artifacts but are
  no longer written.

## Regression coverage

- PR #748-shaped deterministic case (path checks over a change with no
  untrusted path surface; grounded N/A → complete), pinned by
  `tests-v3/required-checks.test.ts` and the inline inputs of
  `tests-v3/requirement-coverage.test.ts`;
- ungrounded-N/A converse: semantic scenarios #7480 (N/A wave over a real
  path risk is `not_found`) and #7481 (grounded N/A on a clean docs change
  is not flagged) in `evals/corpus-historical-dogfood.json`.
