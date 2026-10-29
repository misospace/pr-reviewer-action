# Owner-anchored enforcement citation (#1343)

Status: design note for the requirement-trace enforcement-citation gate (the #854
rule) — implemented by `src/enforcement/requirement-trace.ts`
(`declaredOwnerGlobsFor`, `enforcementPredicateSatisfied`) and disclosed in
`scripts/prompt_fragments/requirement_trace.txt` and `TRACE_REPAIR_SYSTEM_PROMPT`
(`src/requirements/trace-repair.ts`). Builds on the trusted-seam topology of
[distributed-requirement-proof.md](distributed-requirement-proof.md) and the
ownership map of `src/config/requirement-owners.ts` (#958).

## Problem

`validateRequirementTrace` accepts a `met` claim only when the cited enforcement
line carries **both** a term derived from the requirement text **and** a
predicate signal (comparison, guard, throw/assert, match call) on the same line
(`enforcementPredicateFound`). For prose standards rows the derived terms are
generic — `data`, `close`, `never`, `content` — and the enforcing code never
spells them, so a reviewer citing the correct enforcement is rejected for a
reason it cannot see: PR #1340 published `review_result=partial` with
`incomplete_reason=requirement_trace` on three consecutive reviews for exactly
this reason, and the bounded repair pass cannot converge because neither prompt
that asks for claims states the term half of the rule.

## Decision (issue option 2)

Keep the predicate requirement; drop the lexical subject requirement where the
subject is established by **declaration** instead:

- **Narrow rows** (`runtime_behavior` / `test_required`): if a location-valid
  enforcement citation matches a declared owner glob of this requirement — a
  rule whose `match` tokens all appear in the requirement text, the same
  association rule #958 uses for scope — the **cited line itself** must be
  predicate-shaped (`enforcementPredicateSatisfied`), and that suffices: no
  term from the requirement's wording is needed. Every other citation keeps
  the unchanged lexical rule.
- **Distributed rows**: every matched citation is already anchored to a trusted
  declared seam surface (group owner globs from the same config), so the
  predicate gate is `predicateSignalFound` over the matched citations —
  predicate-only, by the same principle. The model-supplied `symbol` is no
  longer consulted anywhere.

The ownership association is base-ref-trusted (`git show <base>:<path>`, never
the PR head), so a contributor cannot declare its way past the gate and the
model contributes citations only.

**The predicate must be on the cited line for the owner-anchored rows.** The
lexical half was what bounded *which* line could qualify (the term and the
predicate had to co-occur on one line); once the subject is established by
declaration, that bound is gone, so the predicate itself must sit on the line
the reviewer cited. A copy-only cited line standing next to an unrelated
comparison does not pass — that is the case the issue's acceptance criterion
("a real predicate on the cited line") rules out, and it is why the rule is
stated in the prompts that way (see [Disclosure](#disclosure-ac3)). The
distributed seam gate keeps the window shape: there the declared seam, not the
cited line, is the anchor, and the disclosed rule is "a real predicate in a
cited seam".

## Why the boundary does not become fail-open

- The association between a rule and a requirement is the **slug-token match**
  the config already defines: a rule anchors every requirement whose text
  contains **all** of the rule's slug tokens — deliberately the same
  association #958 (scope) and #962 (seam topology) use. One rule therefore
  CAN anchor several requirements, and a requirement sharing another
  standard's tokens inherits its globs; that is config semantics, not a new
  hole, and it is pinned by a test in both directions (tokens absent ⇒ no
  anchoring; tokens shared ⇒ anchoring follows). The maintainer's defense is
  distinctive slug tokens; a borrowed anchoring is still bounded by the
  trusted glob, a location-valid citation, and a predicate on the cited line.
- The predicate requirement is **never** dropped: an owner-anchored citation
  whose cited line holds only a value copy downgrades with
  `enforcement-location-copies-without-comparing` even when a predicate sits
  on a neighbouring line (pinned by test).
- A citation into a file that is **neither a declared owner nor carries the
  requirement's vocabulary** still downgrades — the identical claim without the
  declaration is the accepted case's control (pinned by test).
- Distributed: citations that match no declared group glob contribute nothing
  to coverage (#962.6 unchanged), and a seam matched only by value-copying
  lines still downgrades (#962.18 unchanged).

## What was loosened, and the residual risk

The lexical half provided no real assurance for standards rows — its derived
terms are generic (`data`, `close`, `never`, `content`), so it produced false
downgrades far more often than true rejections (PR #1340 published
`review_result=partial` on three consecutive reviews for exactly this reason).
Dropping it inside declared surfaces moves the load to the declaration.
Be honest about what remains: `linePredicateSignal` is the module's
deliberately permissive shape heuristic — any comparison or ternary/logical
operator, an `if`/`unless` guard, an assertion-shaped call — applied to raw
text, not to parsed code. A line that only *looks* predicate-shaped therefore
counts: an arrow function (`=>`), optional chaining (`?.`) and nullish
coalescing (`??`) read as a comparison, and an assertion-shaped word inside an
identifier, a comment or a string literal reads as an assertion. For
owner-anchored rows this is therefore a coarse copy-detector, not a proof of
concept: the cited line must carry one of those shapes, and a line that does
can still be the wrong line of the right file — including a copy-only
assignment that happens to be arrow-shaped (`const readCeiling = (state) =>
state.requested;`). The load-bearing boundary for these rows is the
maintainer-declared glob plus the cited-line predicate. Tightening the
*accepted shape* (which predicate shapes count) would strengthen this gate
further; it is deliberately left as follow-up work ([#1347]), not smuggled into
this change, because the shape heuristic is shared with the legacy and
distributed paths and tightening it there risks false downgrades across every
consumer.

The cited-line requirement is itself a deliberate tightening over the first
draft of this gate, which searched a ±3-line window around the owner
citation: with the lexical half dropped, a window let a copy-only cited line
pass by borrowing an unrelated neighbouring comparison, and the disclosed rule
(cited line) and the enforced rule (window) disagreed. The gate now enforces
what the prompts say.

On the distributed path the model-supplied `symbol` is no longer consulted.
On the narrow path the fallback lexical check is byte-for-byte unchanged and
still consults `symbol` (pre-existing behavior, unchanged by #1343).

## Disclosure (AC3)

The rule is now stated in **both** places that ask the reviewer for claims,
including that the predicate's line must also carry a word from the
requirement's own wording (or `symbol`) unless the cited file is a declared
owner — and, in that owner case, that the cited line itself must carry the
predicate: the main trace fragment and the repair system prompt (the latter
also states the distributed seam rule so a repaired distributed row is not
mis-instructed into an impossible lexical demand). Both name the canonical
config path; the resolver also accepts a `.pr-reviewer-owners.yml` fallback.
A light test pins both surfaces. The wording is deliberately no stronger than
the gate: the legacy half accepts the term+predicate line within a small
window around the citation, so the prompts say "the predicate's line" rather
than "the cited line" there, and only the owner-anchored exception claims the
cited line. Known residual: the reviewer cannot enumerate
the declared owner list (it is not part of the assembled corpus), so the
disclosure primarily prevents the model from treating the lexical half as
mandatory and discarding correct citations; surfacing the map to the reviewer
is follow-up work.

## Follow-ups

- Consider surfacing declared owner paths (or per-requirement owner hints, as
  the distributed hints already do) in the prompt corpus, so the owners-file
  exception is fully actionable for the model.
- Consider a stricter accepted predicate *shape* for owner-anchored citations
  (which predicate shapes count), measured against false-downgrade rates —
  tracked as [#1347](https://github.com/misospace/pr-reviewer-action/issues/1347).

## Rejected alternatives

- **Prompt disclosure only (issue option 1).** Necessary but not sufficient:
  the repair pass still cannot converge when the enforcing code genuinely does
  not spell the standard's generic words. Implemented anyway, alongside.
- **Window-level term-or-predicate co-occurrence.** Fail-open: generic derived
  terms would let almost any citation pass. The subject requirement is dropped
  only where a declaration replaces it.
- **Window-level predicate for owner-anchored citations.** Rejected: once the
  lexical half is dropped, the window would let a copy-only cited line borrow
  an unrelated neighbouring comparison. The predicate stays on the cited line.
- **Dropping the predicate for owner citations.** Rejected: the predicate is
  the anti-copy core (#854).

## Fixture delta

`#962.7` (symbol injection) flips from `unverifiable` to `met` **by design**:
the symbol does not appear on the predicate line, so the pre-#1343 gate would
still fail — the flipped fixture discriminates the two contracts and pins that
the symbol changes a distributed row's outcome neither way. The downgrade
direction stays pinned by `#962.6` (off-seam predicate) and `#962.18` (no
predicate inside the seams). See
[distributed-requirement-proof.md](distributed-requirement-proof.md) for the
amended predicate clause.
