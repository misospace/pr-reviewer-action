# Required checks: `must_check` as a review obligation (#750)

Canonical contract for the deterministic `must_check` checklist and its
structured dispositions. This is the contract #678 (conversation/verdict
routing) consumes and #680 (enforcement migration) cuts over to.

## What `must_check` is

`must_check` items come from the deterministic classifier
(`pr_reviewer/classifier.py`): plain-text review questions derived from the
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

## The three dispositions

Every deterministic check receives exactly one structured disposition in
the verdict's `required_check_dispositions` array (external/model-facing
name; the strict `json_schema` carries it on both OpenAI- and
Anthropic-compatible paths):

| status           | meaning                                                                                   | rationale     |
|------------------|-------------------------------------------------------------------------------------------|---------------|
| `satisfied`      | the risk/question is relevant and was adequately verified/addressed                        | optional      |
| `not_applicable` | the reviewer established, from concrete change context, that the risk surface does not exist | **required**  |
| `unresolved`     | the check is relevant (or applicability cannot be established) and the evidence does not resolve it | optional |

Identity is the **exact deterministic check text echoed back** (matched
case- and whitespace-insensitively; any rewording is a different identity
and is dropped as unknown). The model cannot omit checks, invent additional
mandatory checks, duplicate one check to satisfy another (duplicates
deterministically invalidate the check), or alter the deterministic text and
still count it as covered.

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

`pr_reviewer/completeness.py::evaluate_structured_coverage` folds the
dispositions against the supplied check list into the version-1 coverage
artifact (`required-check-coverage` parity boundary, byte-identical with
`src/enforcement/required-checks.ts`):

- **zero `must_check` entries** → `none` (the model cannot invent an
  obligation set);
- **every check `satisfied` or grounded `not_applicable`** → `complete`;
- **any check `unresolved`, missing, duplicate-dispositioned,
  malformed-dispositioned, or an ungrounded N/A** → `incomplete`;
- **unknown/forged check identities** are dropped, never credited;
- **no structured dispositions at all** → the artifact records
  `structured: false` with every check unresolved (the conservative v3
  semantics).

`not_applicable` is a completed disposition. An absent named test does not
force `request_changes` when the underlying risk is demonstrably absent;
requesting changes is reserved for an actually violated or unresolved
applicable requirement.

## `required_check_validation_mode` mapping

The public `required_checks` output vocabulary is unchanged
(`complete` / `incomplete` / `none`):

- `auto` — validate when `must_check` is non-empty;
- `warn` — append an `### Unaddressed required checks` section listing the
  unresolved checks; never flips the verdict;
- `fail` — additionally forces `request_changes`;
- `metadata_only` — record only.

Structured dispositions, when present, are authoritative for this decision;
no keyword mention can substitute for a missing or malformed disposition.

## v2/v3 coexistence (until #680)

The v2 pipeline keeps its shallow keyword matching
(`completeness.py::validate_review`) **only** as a fallback for outputs that
carry no `required_check_dispositions` field at all (models on
`ai_response_format: off`/`json_object` that never engaged with the
structured contract). When the field is present — even partially or
malformed — the structured evaluation is authoritative. This fallback is
explicit, documented, and removed by #680; it is not the v3 contract. The
v3 evaluator treats a missing field conservatively (all checks unresolved).

## Escalation authority (#721) is unchanged

Required-check incompleteness — including `unresolved` dispositions,
missing/malformed coverage, and every other completeness outcome — is
**never** an escalation trigger. The only post-primary smart trigger remains
the literal structured `smart_review_requested === true` from a successful
primary review (`escalation.py::reviewer_requested_escalation`). The
`should_escalate` heuristics (including `incomplete_required_checks`) stay
telemetry-only, and their telemetry follows the same structured-first
contract so a grounded N/A is not misreported.

## What #678 consumes

- `ParsedReviewVerdict.requiredCheckDispositions`
  (`src/model/types.ts`) — normalized per-entry
  `{check, status, rationale}` (camelCase internal), `null` when the model
  emitted no field;
- `evaluateRequiredCheckCoverage(checks, dispositions)` +
  `requiredCheckCoverageToArtifact` (`src/enforcement/required-checks.ts`)
  — the pure completeness fold, ready to wire into the #681 orchestrator;
- the verdict-turn contract now carries `required_check_dispositions` in
  the strict schema (all three duplicated copies pinned byte-identical by
  `tests/test_verdict_contract_equivalence.py` and the
  `model-request-construction` parity boundary).

## What #680 still owns

- consuming the typed coverage artifact in enforcement instead of the v2
  bridge (and removing the legacy keyword fallback entirely);
- deciding whether `incomplete` maps onto verdict policy in the v3 runtime
  (the v2 `warn`/`fail` behavior remains the production path until then);
- publishing/publication-side presentation of per-check dispositions;
- any richer rationale validation — the deterministic layer deliberately
  stays at presence/shape.

## Regression coverage

- PR #748-shaped deterministic fixture:
  `tests/fixtures/parity/required-check-coverage/path-checks-grounded-na.json`
  (path checks over a change with no untrusted path surface; grounded N/A →
  complete) and the unit tests mirroring it on both sides;
- ungrounded-N/A converse: semantic scenarios #7480 (N/A wave over a real
  path risk is `not_found`) and #7481 (grounded N/A on a clean docs change
  is not flagged) in `evals/corpus-historical-dogfood.json`.
