# Authoritative final review disposition (#1656)

Every review run publishes ONE statement about what it concluded, and every
downstream surface — the human-readable recommendation line, the machine
handoff (`review-handoff/v1`), the marker's `review_result`, the review
attestation and the native review event — reads it from the same object.
There is no second authority: no downstream module may change an approve's
native event, re-derive the conclusion from raw bits, or withhold approval
through a parallel guardrail.

## Where it lives

| Piece | Location |
|---|---|
| Types, decision table, wording, marker projection, artifact parser | `src/disposition/final.ts` |
| The engine-side evidence builder (reason-coded seam inputs) | `src/disposition/engine-evidence.ts` |
| The one computation site (post-validation, pre-publish) | `src/engine/review.ts` (`finalDisposition`) |
| Consumers | `src/publish/publish.ts`, `src/publish/handoff.ts`, `src/publish/attestation.ts`, `src/publish/bundle.ts`, `src/run/action.ts` |

The engine writes the object to `final-disposition.json` in the run
directory; the standalone `publish` CLI reads it back (`parseFinalDisposition`,
fail-closed) instead of re-deriving anything. A run directory without the
artifact (pre-#1656) keeps the legacy scalar derivation, byte-compatible.

## The closed vocabulary

- `request_changes` — an evidenced current-head blocker/major defect
  (grounded finding, evidence-provider blocker) or an objectively proven
  unmet mandatory requirement. Always native `REQUEST_CHANGES`.
- `approve` — the full objective APPROVE floor passed. Always native
  `APPROVE`. There is no uncertified approve: kind `approve` means a
  certified APPROVE, and `approvalCertified` is derived
  (`kind === "approve"`), never an independent flag.
- `incomplete` — certification withheld with no proven defect. Reasons:
  `material_unknown` (a materially relevant review question remains
  unknown/unavailable) or `approval_withheld` (the review itself completed,
  but an objective certification gate withheld the native approval: fork
  scope policy, a non-verdict-bearing surface, an unproven/unbound head).
- `unavailable` — the review failed before enough semantic assessment
  existed to certify anything (`review_failed`, `no_verdict`,
  `degraded_no_evidence`).

## The APPROVE floor

Kind `approve` requires ALL of, evaluated inside `computeFinalDisposition`:

- a meaningful semantic review actually completed (not a
  provider/transport/platform failure, not a degraded no-evidence fallback,
  no recorded zero-evidence degradation);
- exact reviewed head (`exactHead`) and a publication bound to it
  (`publicationHeadBound`; the body-only fallback remains caught by the
  attestation's `native_approval_unbound`);
- no open blocker/major finding, no evidence-provider blocker, no proven
  unmet mandatory requirement;
- no material unknown (below);
- the applicable objective gates: verdict-bearing surface, fork scope
  policy, head-bound publication.

When the review is otherwise clean but a certification gate withholds, the
disposition is `incomplete`/`approval_withheld` — the marker's
`review_result` stays `findings`/`clean` (the review itself completed) while
the native event is a COMMENT.

**Adequacy is never defined by** a tool-call count, a route/tier name, a
primary-good/fallback-bad rule, or a read-every-file requirement: the
disposition input carries no route/tier field, and a fallback lane certifies
exactly like a primary lane when the evidence it actually gathered was
adequate.

## Materiality: the reason-coded seam

Materiality never derives from the `required_checks=incomplete` bit. The
seam (`DispositionEvidence`) carries closed reason codes, WHO ruled the
materiality (`deterministic` for the objective floors, `reviewer` for the
genuinely semantic calls #1657/#1658/#1659 feed) and a bounded subject.

Material codes (each can withhold approval when applicable to the changed
behavior): `unread_affected_path`, `exact_head_evidence_unavailable`,
`required_ci_failing`, `upstream_source_unavailable`,
`unverified_blocking_claim`, `mandatory_requirement_unresolved`,
`investigation_unavailable`.

Advisory codes (observable, never vetoing, never independent authorities):
`proof_shape_mismatch`, `citation_allocation_failed`,
`stale_thread_bookkeeping`, `generic_scrutiny_row_missing`,
`serialization_diagnostic`, `investigation_floor_unmet`,
`investigation_partial`.

The compatibility mapping while #1657/#1658 are in flight
(`buildDispositionEvidence`): the citation-gate reason family
(`citation-already-used`, `uncited-satisfaction`, `unrelated-executed-call`,
`malformed-executed-trace`), the requirement trace's remaining
incompleteness, the configured min-successful CALL-COUNT floor and the #810
loop-stopped-early record are advisory; a tool CAPABILITY failure (planning/
execution error, every call failed) and a recorded no-evidence degradation
are material; confirmed-negative (`unmet`) rows prove
`request_changes`; the exact-head CI floor reads the CI gate's already-paid
conclusion — a KNOWN failure is always material, a PENDING one withholds
only when the #1594 head-bound evidence contract proves CI materially
required.

## Consumers (all read the same object)

- Recommendation line and prose reconciliation: `disposition.recommendation`
  / `statement` (wording contract in `final.ts`).
- Native review event: `disposition.nativeEvent` — nothing else chooses it.
- Marker `review_result`: `reviewResultFromDisposition` (kind + reason;
  `approval_withheld` is not a coverage gap).
- Attestation: `computeReviewAttestation` consumes the disposition for the
  semantic conclusion and owns only the publication proof (whether a
  commit-bound native event actually landed).
- Handoff/bundle: verdict-level words and the additive
  `disposition_kind`/`disposition_reason` fields.
