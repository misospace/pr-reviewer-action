# Requirement proof shapes (#985)

Status: **pinned proof contract** — implemented by `src/enforcement/requirement-trace.ts`.

## Problem

A single evidence rule is too strict for repository-state requirements and too weak to describe explicitly test-demanding or distributed requirements. The validator selects a proof shape deterministically, preserving strict behavioral proof while allowing state claims to be checked directly against the checkout.

## Proof shapes

- **`runtime_behavior`** — The requirement describes runtime semantics. Its truth depends on enforcement behavior, not merely repository contents.
- **`structural_state`** — The requirement asserts a property of repository state that can be verified by reading a named, non-source file. Classification requires no behavioral language, exactly one unambiguous assertion polarity, a containment or existence assertion, and a quoted/backticked literal where applicable. Config, manifest, ignore, and dotfiles may qualify; executable source, extensionless scripts, `Dockerfile`, and `Makefile` do not.
- **`test_required`** — The requirement explicitly demands test coverage. It uses the strict runtime proof and makes test evidence mandatory.
- **`distributed`** — Trusted topology declares at least two seams for the requirement (#962), requiring evidence across each seam.

## What is required per shape

| Proof shape | Evidence required for `met` | Is test evidence mandatory? |
|---|---|---|
| `runtime_behavior` | Valid enforcement and test locations, with the requirement predicate at the enforcement line. A comparison, guard, throw/assert, or match call must check the concept; a copy or assignment is not enforcement. | Yes |
| `structural_state` | A valid citation to the named file and the validator's re-derived assertion holding in the checkout. | No, unless the requirement also explicitly demands tests. |
| `test_required` | Same enforcement location and predicate as `runtime_behavior`, plus a valid test location. | Yes |
| `distributed` | Distinct valid enforcement and test citations covering every declared seam, plus a predicate over the matched enforcement evidence. | Yes, in every seam. |

For all shapes, test citations must point to real test/fixture files. `structural_state` and an explicit test demand are independent: a structural requirement that also demands tests needs both the checked state and test evidence. Any non-`met` disposition requires a reason; every `unmet` requires a matching finding. Use `not_applicable` only when the requirement genuinely does not apply.

## Fail-closed properties

- A structural row is `met` only when the validator re-derives the assertion from the checkout and confirms it holds. A failed or unavailable assertion yields `unverifiable`, never `met` and never a synthesized `unmet`.
- Ambiguous polarity, behavioral language, a source-file target, an unquoted asserted literal, or an assertion that matches both or neither polarity falls back to strict `runtime_behavior` evidence.
- The named file must be the **subject** of the assertion. A file that appears only as a locator after the assertion — "error responses must not include `stack_trace` in `sample.json`" — does not qualify. The converse phrasing, "`api_key` must be absent in `config.yaml`", therefore also falls back to the strict path: the two are indistinguishable by position, and rejecting the locator form is the fail-closed choice. Write the file first ("`config.yaml` must not contain `api_key`") to get the state proof.
- Exactly one file may be named. A requirement naming two files (`` "`a.json` and `b.json` must contain `x`" ``) falls back to the strict path rather than reading one file's name as the other's literal.
- Glob and bracket interpretation applies only to ignore-style dotfiles (`.gitignore`, `.dockerignore`, `.npmignore`, …), where lines are patterns by definition; elsewhere the literal is matched as text.
- A `presence: true` match is token-bounded, so `enable_audit_log` is not satisfied by `enable_audit_logger`; a literal ending in a non-identifier character (a path like `assets/`) still matches inside a longer path.
- Missing test evidence alone does not make a proven structural requirement `unverifiable`; it does when that requirement explicitly demands tests. Missing valid deterministic proof always does.
- The #854 control is preserved: a runtime-semantics requirement whose cited line merely copies a field (for example, `sourceSha: ctx.sourceSha`) is `unverifiable`, test or no test.
- `unverifiable` and `unmet` make `requirement_trace_incomplete`, forcing `required_checks=incomplete` and a non-clean verdict.

## Trust boundary

The validator derives the proof classification from the ledger requirement text and trusted topology rules; the model supplies citations only. It cannot authorize itself out of a test requirement, nor exempt runtime behavior by naming a config file. The classification requires exactly one named non-source file that is the **subject** of the assertion (a file named only as a locator, as in "error responses must not include `stack_trace` in `sample.json`", does not qualify), so a runtime claim cannot be laundered through a checked-in sample. Each trace row carries the selected shape in its persisted `proof` field, and a structural row whose state check failed is named as such in the rendered requirement trace — the decision is explainable from the artifact alone.
