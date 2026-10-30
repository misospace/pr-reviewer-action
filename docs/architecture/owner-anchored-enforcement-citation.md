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
Be honest about what remains: `linePredicateSignal` is still a shape heuristic
over source text, not a parser. **#1347 closed the artifacts that made it fire
on text which is not a predicate at all** — an arrow function (`=>`, and the
`->` spelling Ruby/PHP/C++ use) read as a `>` comparison, an optional chain
(`?.`), nullish coalesce (`??`) or optional property marker (`x?: T`) read as a
ternary, and an assertion-shaped word read inside an identifier, a comment or a
string literal. Only `throw` keeps bare-word semantics — and only as the
KEYWORD: `throw` is not a reserved word in every language (Python and Rust
have no `throw` statement), so a property named `throw` (`state.throw`,
`state?.throw`) is an ordinary name, not enforcement. `reject`, `expect`,
`invariant`, `assert` and `must…` are library/identifier names, so they count
only in a call shape (`expect(…)`, `Assert.ok(…)`, `invariant(…)`) or as a
member CALL reached through the bare name (`assert.deep.equal(…)`); a member
READ (`expect.value`) copies a value and is refused. That is what separates
enforcement from `const expect = state.requested;`. The `?`-marker blanking is
adjacency-only (`?.`, `??`, `?:` are spelled without a space), so a ternary
whose branch starts with a dot — `flag ? .5 : 1`, or the Swift-style
contextual case `wide ? .large : .small` — keeps its `?`. Those rules live in
the shared helper, so the legacy, owner-anchored and distributed paths all
accept the same shape. On owner-anchored rows this is what makes the disclosed
rule real: a copy-only citation such as
`const readCeiling = (state) => state.ceiling;`,
`const ceiling = state?.requested;`,
`const note = 'must not exceed the ceiling';`,
`const expect = state.requested;` or
`const value = state.throw;` no longer passes as `met`.

What the coarse copy-detector still cannot tell you, named rather than silently
wrong:

- A generic argument list (`Map<string, Ceiling>`) still reads as a comparison.
  It is indistinguishable from an unspaced `a<b` without a parser, and refusing
  both would reject real enforcement.
- A regex literal (`const GT = />/;`) is still an accepted shape, and a `//`
  inside an unquoted URL is treated as a comment opening.
- Only single-quoted, double-quoted and backtick spans, `//`, `/* … */`, a `#`
  comment at line start or after whitespace, and a doc-comment continuation line
  are stripped. Permissive residuals: a `#` glued directly to code is not a
  comment, because `this.#ceiling > requested` is a private field and cutting
  there would erase a real comparison — so an inline script comment written
  without its own leading space still reads as code; and the interior of a
  multi-line template literal (or of a block comment whose lines do not begin
  with `*`) is not tracked across lines. Strict residual: a quote character
  inside a regex literal (`if (/[="']/.test(key))`) opens a span that swallows
  the rest of the line, so a real comparison after it is lost.
- The adjacency-only `?` blanker resolves the spaced-`?` ambiguity toward the
  ternary: the legal-but-never-formatted optional chain `obj ? .value` survives
  as a `?` shape, because the alternative would erase the `?` of a real
  leading-dot branch (`wide ? .large : .small`).
- A member read on a bare assertion name (`expect.value`, `must.not`) is
  refused: only a member CALL enforces (`assert.ok(…)`, `assert.deep.equal(…)`),
  because a read copies a value. A suffixed spelling keeps no member shape at
  all (`expected.ceiling`, `rejected.length` are English identifiers, not
  assertions), so `expected.ok(…)` is refused too.
- A bare `throw` outside statement position still reads as the keyword:
  `throw = 1` (a binding named `throw`, in a language with no `throw`
  statement) and `x = throw;` are accepted shapes. Only the member-property
  case is distinguished, because that is the shape a copy-only citation
  takes; telling the remaining positions apart would need a parser.
- The assertion shapes are the spellings the corpus speaks. A parenless or
  underscore-joined idiom such as Ruby's `assert_equal ceiling, actual` was only
  ever matched by accident and is now refused; a keyword-assert statement whose
  operand is a bare name — Python's `assert ceiling_ok` — is refused too, since
  #1347's review follow-up requires a call/member shape for every
  non-keyword assertion name (an operand carrying a real comparison,
  `assert x <= ceiling`, still passes); and a language/style the regexes do
  not recognize is the pre-existing limit of this heuristic.
- A line that genuinely is predicate-shaped can still be the wrong line of the
  right file.

Each of these boundaries has a test, so a later change cannot move one silently
— including the two line-scan residuals above, which are pinned at their actual
(permissive and strict) outcome rather than at an idealized one.

The load-bearing boundary for these rows remains the maintainer-declared glob
plus the cited-line predicate.

The tightening was measured against false downgrades, not only against the
artifacts. The measurement is retained as a reproducible artifact (#1347
review follow-up): `node scripts/measure_predicate_signal.mjs` re-runs the
pre-#1347 baseline shape (embedded verbatim from base revision
`8b91cf01bbadcf8c1f280c98227418089cd000fc`) against the shipped production
`linePredicateSignal` over the git-tracked TypeScript files (an optional
positional arg narrows the corpus to a path prefix), and prints the counts
plus file:line samples of both change directions; the production logic is
imported from source, never re-implemented, so the measurement cannot drift
from the runtime. At the measured head (487 tracked `.ts` files, 216.8k
lines) the tightening took accepted shapes from 54.3k to 37.6k: the sampled
removed lines are arrows, optional chains, nullish coalescing, comment/doc
text, string literals, optional-property declarations and member reads off an
assertion name (`c.expect.…`) — none of them a comparison, guard, throw/assert
or match call. The baseline comparison is
not a pure subset: 68 lines became newly accepted, and every sampled one is
a prefixed assertion-name call (`rejectUnknown(…)`, `expectFailed(…)`,
`rejectCancelled(…)`) — call-shaped enforcement the tightened call-shape
rule deliberately accepts and the old bare-word regex (`\breject\b`) could
not match, not a loosened copy. A `src`-only scope reproduces the scale of
the earlier unretained one-off run (297 files, 20.8k → 14.8k). That corpus
is TypeScript, so it
measures this product's own risk, not every language a reviewed repository might
use. The same measurement caught one over-tightening: erasing a literal span
collapses a real ternary such as `clip(symbol ? "x" : path)` into `? :`, so the
operator blanking runs *before* span removal. A review of the first fix caught
a second one: a blanker that matched a **spaced** `? .` erased the `?` of a
genuine ternary whose branch begins with a dot (`wide ? .large : .small`,
valid Swift), so the blanker is adjacency-only — the non-predicate `?` markers
never contain a space, and a ternary `?` always does. A second review caught a
third: the shape still read a member PROPERTY as the keyword and a member
READ as an assertion call, so `state.throw` and `expect.value` passed as
enforcement. The keyword check now refuses a member read — which is why it
reads the unblanked code view, where the optional chain still carries its dot —
and the assertion shape requires a member call. Measured against this
repository's own sources, that refinement removed exactly five accepted lines
(`c.expect.…` member reads in the golden-replay test) and added none, so it
removed no enforcement.

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
- Consider excluding generic argument lists from the accepted predicate shape
  without also rejecting an unspaced `a<b` (a parser-grade shape check) — the
  one artifact #1347 named but deliberately left in place.

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
