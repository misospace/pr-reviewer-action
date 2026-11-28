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
For a deterministic unresolved requirement the subject leads with the row's
own per-row rejection reason (the same closed code the obligation fold and
the published body render — #1822), so the record names why the requirement
stayed open, not only which one it was.

Material codes (each can withhold approval when applicable to the changed
behavior): `unread_affected_path`, `exact_head_evidence_unavailable`,
`required_ci_failing`, `upstream_source_unavailable`,
`unverified_blocking_claim`, `mandatory_requirement_unresolved`,
`investigation_unavailable`, `reviewer_declared_unknown` (#1835).

Advisory codes (observable, never vetoing, never independent authorities):
`proof_shape_mismatch`, `citation_allocation_failed`,
`stale_thread_bookkeeping`, `generic_scrutiny_row_missing`,
`serialization_diagnostic`, `investigation_floor_unmet`,
`investigation_partial`. These are SEAM vocabulary: the engine feeds
`investigation_floor_unmet` (the configured min-successful CALL-COUNT floor —
a count never defines adequacy), `generic_scrutiny_row_missing` and
`investigation_partial` (#1657/#1659 row metadata), and `stale_thread_bookkeeping`
(#1645: the settlement-time reconciliation of carried review threads reported
`incomplete`, i.e. at least one carried thread whose live state the listing
could not prove — provenance for the disclosure only, never a veto and never a
blocker). `proof_shape_mismatch` is fed since #1753: the requirement trace's
satisfied-no-enforcement-citation serialization omission (no citation emitted,
evidence disclosed) rides it as an ADVISORY diagnostic — never a material
unknown by itself. `citation_allocation_failed` and `serialization_diagnostic`
stay unfed reserved vocabulary.

The mapping after #1657/#1658 (`buildDispositionEvidence`) — still
deliberately CONSERVATIVE where settlement has not arrived, so #1656 does not
raise native APPROVE merely because the old proof machinery could not
settle a state:

- a model-authored `unmet` row (must_check, trusted-base) is a MATERIAL
  unknown — a usable rationale makes the disposition structurally valid,
  not objectively true; only a MECHANICAL current-head refutation (the
  #1658 requirement-trace validators' `confirmed_unmet` rows, re-derived
  from the checkout at head) may prove a requirement and drive
  `request_changes`;
- unresolved required-check rows (receipt states — #1657 classifies them by
  trusted `row_class`; the #1634 safety contract) and the #810
  loop-stopped-early record are MATERIAL unknowns;
- the requirement trace settles by PROVENANCE (#1658): the artifact's
  reason-coded summary classes feed the seam — `unresolved_material` rows
  are a MATERIAL unknown (INCOMPLETE), `unresolved_advisory` rows are
  diagnostics that can never veto approval, and an IN-SCOPE
  `unmet_claimed` row is likewise a MATERIAL unknown: a claim alone can
  never certify an approve, yet is never converted into a refutation or a
  synthesized blocker — a grounded blocker/major finding outranks it into
  REQUEST_CHANGES through the existing finding path, while an
  OUT-OF-SCOPE claim (the row's `out-of-scope-reported-unmet` marker)
  stays disclosure-only and can never independently prevent APPROVE;
- a tool CAPABILITY failure (planning/execution error, every call failed)
  and a RECORDED zero-evidence loop degradation (`native_loop_degraded`,
  lane-independent — never a route/tier name) are MATERIAL. #1837 narrows
  the producer: the harness records the degradation only for a zero-call
  stop the LOOP chose (a transport failure or deadline before any model
  reply); the model's own `no-tool-calls` reply is a deliberate
  corpus-direct completion — the same evidence surface a `tool-mode: off`
  run has — and is not recorded, so that run settles the way the
  tools-disabled run settles (investigation adequacy decides approval
  eligibility, never the call count);
- #1659's canonical per-question settlement record feeds the seam. Its two
  dimensions are deliberately separate: the loop writes EVIDENCE state
  (`acquired` / `cap-released` / `open` — the `obligations-settled` stop is
  only evidence-ready, never proof of a clean settlement), and after the
  verdict the engine reconciles each tracked question with the fold's
  SEMANTIC outcome (`resolved` / `finding` / `unknown` / `not-tracked`) over
  the SAME obligation rows this disposition consumes — dependency shape rows
  join their fold row through that row's own TEXT, since the loop keys them
  by obligation name, and ONLY the classifier-owned `must_check` row may own
  one (`foldOwnershipForDependencyQuestions`, the mirror of the harness's
  shape-row dedupe — a satisfied `derived`/`risk`/trusted-base row that
  merely mentions the dependency vocabulary can neither resolve the question
  nor hide it; reconcile and the disposition's dedupe call the SAME helper).
  So the record and the disposition cannot disagree. A
  MATERIAL question with no semantic resolution AND no fold row owning it
  (left `open`, cap/budget released, or an acquisition that failed) becomes a
  MATERIAL `investigation_unavailable` unknown — never a certified
  APPROVE; a non-material one becomes the ADVISORY `investigation_partial`
  diagnostic (never a material code with advisory materiality, which
  `parseFinalDisposition` refuses). A question the folds already own keeps
  its single entry — the obligation row (or the must_check completeness row
  found through the text join) is the disclosure; `not-tracked` is reserved
  for the #1658 trace rows AND is refused by the strict reader on any other
  row kind, so it can never hide an unanswered material question. A question
  the producer tagged `attention` or `review-prompt` is recorded ADVISORY
  even when the obligation fold drops it (#1657's non-gating classes can
  never acquire a material veto through this seam). Admission alone never
  overrides this disposition. A persisted
  record the strict reader had to DROP rows from is itself a MATERIAL
  `investigation_unavailable` unknown — a corrupted record can never read as
  "no gaps";
- the exact-head CI floor reads the CI gate's already-paid conclusion — a
  KNOWN failure is always material, a PENDING one withholds only when the
  #1594 head-bound evidence contract proves CI materially required;
- #1835: the reviewer's own declared materially-relevant unresolved
  questions (the parser's fail-closed `material_unknowns` normalization on
  the verdict — the structured counterpart of the Unknowns or Needs
  Verification section) each become a MATERIAL `reviewer_declared_unknown`
  entry ruled by the reviewer. The disposition never validates the subject:
  the reviewer judges what relevant evidence means. Round 2 made the
  undermining PER FINDING: a declaration's own `affects` citation — the
  reviewer's answer to WHICH location's finding the question contradicts —
  is matched structurally by the one canonical citation grammar against the
  open blocker/major findings; a matched finding that the verification
  boundary never positively grounded (`grounding_status` recorded per
  classified claim since #1835; "grounded", a capping path, or an
  evidence-provider signal is immune) is excluded from
  `blockingFindingOpen` upstream (`hasUnunderminedBlockingFinding`), so the
  disposition's own rule stays severity-only over a set the association has
  already narrowed. Round 3: an association resolves only when it matches
  EXACTLY ONE suppressible candidate — a bare path over several undecided
  majors in one file, or a line shared by several independent findings, is
  ambiguous and suppresses nothing (every candidate keeps its standing
  authority), and an explicit line never reaches a line-less finding. The undermined finding keeps its severity and stays
  listed, disclosed as `unverified_blocking_claim`; the disposition
  publishes INCOMPLETE/COMMENT. An unrelated declared unknown never touches
  another finding's standing authority, a declaration without an
  association never touches any finding, and runs that never declare
  unknowns are behavior-identical.

The historical enforcement layer may keep rendering the model-authored
`unmet` rows and forcing the artifact verdict (telemetry), but it is never a
second final authority: the disposition ignores the raw verdict (an
ungrounded blocking conclusion is itself an unverified claim) and the
fail-on-request-changes gate reads the disposition kind.

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

## Evidence provenance for settlements (#1681 r6/r7)

Detail behind the AGENTS.md #1663 invariant; the normative rules stay there.

- **One citation grammar** (`src/enforcement/citations.ts`): `path`,
  `path:LINE`, `path:LINE-END`, and the corpus diff anchor
  `path:+START-END[:INDEX]` (`+` = new-side numbering = head numbering; the
  trailing ordinal is evidence-entry metadata, never a line). Citations are
  repository-relative: absolute, drive-shaped and traversal paths are
  refused at the parse door; the exact-head checkout resolver keeps its
  containment/symlink/existence/line guards as defense-in-depth. Parsing is
  syntax only; resolution against the reviewed head is provenance truth.
  The free-text extractor only discovers candidate spans and delegates
  every one to the canonical parser, so structured requirement refs and
  prose evidence can never drift into two vocabularies.
- **Thread/human-review grounding** consumes the same grammar plus the
  engine-supplied `EvidenceGrounding` (the requirement trace's own head
  validator, plus the run's head-bound acquisition receipts that let a bot
  `fixed` rest on evidence the run already holds when no citation was
  attempted). An attempted-but-unresolvable citation is never rescued by
  acquisition.
- **Per-review human aggregation**: settled human-thread records carry the
  semantic concern state (`addressed`/`present`/`unresolved`) and the
  forge-proven `parent_review_id` (GitHub `pullRequestReview.databaseId`;
  platforms without the link leave every concern unassociated). The
  human-change-request pass aggregates only the settlement's OWN records,
  filtered to the review that provably owns them — never the artifact
  field (which can still hold raw model rows), never by login/timing/text
  guesses. A review with no attributable concerns keeps its own grounded
  model claim.
- **Disclosure vs downgrade**: settlement notes that overwrite the model's
  disposition count as downgrades; annotation-only notes (e.g. a
  proven-addressed human thread that stays physically open) count as
  disclosures — the section still renders, the telemetry does not lie.
