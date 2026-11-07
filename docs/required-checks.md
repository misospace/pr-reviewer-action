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

## Regression coverage

- PR #748-shaped deterministic case (path checks over a change with no
  untrusted path surface; grounded N/A → complete), pinned by
  `tests-v3/required-checks.test.ts` and the inline inputs of
  `tests-v3/requirement-coverage.test.ts`;
- ungrounded-N/A converse: semantic scenarios #7480 (N/A wave over a real
  path risk is `not_found`) and #7481 (grounded N/A on a clean docs change
  is not flagged) in `evals/corpus-historical-dogfood.json`.
