# Syntax-aware context (#764)

The syntax-aware context stage is an **optional, engine-level** context
stage: it retrieves bounded source context for a change that the lexical
related-code path cannot see, and hands it to the model as evidence.

It is **OFF BY DEFAULT**. The issue's acceptance criterion is "default
enablement requires measured quality/token benefit", and that benefit is
not established yet (see [Measured evaluation](#measured-evaluation)).
Enabling it is an operator decision (`syntax-context: "true"`), and it is
never enabled on fork pull requests (see [The fork
boundary](#the-fork-boundary)).

## Goal and relation to the lexical stage

The lexical related-code stage (`src/context/related-context.ts`, enabled by
`related-code-context`) stays the **baseline**: nothing here replaces it,
and nothing here changes its semantics.

The lexical stage searches for the **symbols the diff declares** — the
declaration lines the diff adds and the declarations enclosing the changed
lines — and returns the *matching lines* it finds elsewhere in the
repository. Three structural blind spots follow, all named in the issue: an
identifier merely **referenced** on a changed line is not among the diff's
symbols, so its **definition** is never retrieved; the stage returns
matching *lines*, never the **whole declaration** a hunk cuts through; and
a textual match cannot be told apart from a **same-name binding in another
scope**, so shadowed locals come back as if they were callers.

The syntax stage answers exactly those three questions, with the same
anchors the lexical stage already produced. It **adds** a corpus section;
it never edits, filters or suppresses the lexical one.

## The provider seam

`src/context/syntax/types.ts` defines the seam: a provider answers syntax
questions about **one file** — `declarations(file)`,
`identifiersOnLine(file, line)` and `classify(file, line, name)` — and
nothing else.
Everything a reviewer would call *policy* — candidate discovery, budgets,
provenance, filtering, truncation, fallback — belongs to the **builder**
(`src/context/syntax/build.ts`), not to the provider. A parser-backed
provider therefore registers under a new id (`registerSyntaxProvider`) and
the builder, the stage and every policy that consumes the result stay
unchanged. The operator-visible seam is the `syntax-context-provider`
input; an unknown id degrades to the default provider with a recorded
reason (never an exception).

### Why the default provider is dependency-free

The default provider (`structural`) is plain TypeScript over node built-ins:
the repository's own declaration grammar (`declarationAt`/`declarationEnd`
from `src/context/change-anchors.ts`) plus a lexical reader and an
indentation-aware scope walk. No parser, no grammar files, no dependency.

The parser-backed alternative was spiked and closed: PR #783
(`web-tree-sitter` + `tree-sitter-wasms`) measured **5,490,724 B (~5.24 MiB)**
of grammar WASMs plus a 205 KB core engine, against a 244 KiB
`dist/index.js` — and found that the grammar bundle package and the
runtime package are **versioned independently**: a `web-tree-sitter` bump
broke `Language.load()` for every prebuilt grammar (ABI/dylink-metadata
mismatch). Shipping no parser keeps the install size and the dependency
graph flat, and keeps a version-skew class of failure out of the shipped
path.

## What the stage retrieves

1. **Touched declarations** — the whole declaration (bounded body) the
   diff touches, not just the hunk.
2. **Definitions of referenced identifiers** — where the identifiers the
   changed lines reference are defined, with the reference sites recorded.
3. **Callers of the touched declarations** — the call sites of the
   declarations the diff touched, each bound to the declaration it calls.

**Callers vs. the lexical baseline.** The lexical baseline matches text;
the syntax stage resolves *scope*. A local binding that shadows the name —
a nested function, a parameter, a local assignment — is **not** a caller
(the provider answers `unknown`, not `call`), and a file that owns the
name at module scope owns a *different* symbol than the one under review.
The lexical baseline cannot make either distinction and returns all of
them. The stage emits **context only**: no findings, no severity, no
requirement obligations, no gates, no verdict. It is evidence, never
authority.

## Budgets and truncation

Every cap is a hard limit, and every drop is visible.

| Bound | Value | What it bounds |
|---|---|---|
| `MAX_SYNTAX_ITEMS` | 40 | items per category and in total |
| `MAX_SYNTAX_BYTES` | 100,000 | bytes of retrieved body/snippet text |
| `MAX_SYNTAX_CANDIDATE_FILES` | 200 | repository files walked as candidates |
| `MAX_SYNTAX_BODY_CHARS` / `_LINES`, `MAX_SYNTAX_SNIPPET_CHARS` | 2,000 / 120, 300 | one declaration body, one caller snippet |
| `MAX_SYNTAX_CHANGED_LINES` / `_RANGES` | 500 / 200 | changed lines scanned |
| `syntax-context-max-bytes` | 8,000 (1–200,000) | bytes of the section that enters the corpus |

What is dropped first: a **definition** before a caller, a caller before a
touched declaration — the value order is "the change itself, then its
direct impact, then its background". Any drop sets `truncated: true` in
the artifact and renders a `_Output is bounded and incomplete._` note in
the Markdown; a bounded artifact never pretends to be complete. The corpus
byte cap is a *second*, independent bound: the artifact is built under the
module's own cap, and the section that enters the corpus is clipped to
`syntax-context-max-bytes` on a fence-safe line boundary (the same shape
as `related-code-max-bytes`).

The section rides in the corpus **body**, right after the lexical
related-code section and before the diff. The body is truncated
head-first, so an enabled stage never evicts the diff or the standards
block; what it costs is body budget that the low-value tail sections
(linked sources, repo impact scan, repo history) would otherwise have
used. That cost is the operator's to accept — the stage is off by
default, and `syntax-context-max-bytes` bounds it.

## Provenance

Per item, provenance follows the contract in
[`source-evidence-provenance.md`](source-evidence-provenance.md):

- the text is read from the **working tree**, so no revision is bound
  (`revision: null`). Binding one would claim a byte-identity the read
  never established, and a literal claim against such a snippet must fail
  closed (`authorizesLiteralClaim` refuses it) — the same rule, for the
  same reason, as the related-code stage's snippets;
- the **PR head SHA** is recorded **once**, at artifact level, as
  `head_revision` — it is the revision the *review* is about, not a claim
  that any particular snippet was read from it;
- a credential in a retrieved body is masked before truncation can split
  it, and the redaction count rides along in the provenance
  (`representation`, `synthesized`, `redaction_count`);
- the provenance annotation is stamped on the harness-authored header line
  preceding the fence, never on the fenced body, so repository text
  cannot forge the annotation channel.

No new provenance scheme is introduced.

## Failure and degradation

| Situation | Result |
|---|---|
| stage disabled (`syntax-context` false — the default) | all three artifacts empty; no corpus section |
| anchors unavailable (the related-code stage produced none) | all three artifacts empty; no corpus section |
| the lexical related-code stage is disabled | the syntax stage is a no-op: it consumes the anchors the lexical stage already extracted, so `related-code-context: "false"` also silences it |
| provider throws / unreadable changed file / malformed anchor artifact | the build is degraded (`errors` non-empty); the stage drops the section whole — empty artifacts, no corpus section, the review falls back to the lexical context |
| unknown provider id | the default provider runs; the artifact records `provider_fallback: true` and `provider_fallback_reason` naming the unknown id |
| corpus byte cap reached | the section is clipped to `syntax-context-max-bytes` with a truncation marker |
| a stage-level failure (any exception) | caught; all three artifacts reset to empty; the review continues |

The stage never throws and never breaks the review: the worst case is the
context it would have added is absent.

## The fork boundary

The stage scans the local git worktree, exactly like `related-code-context`
and `repo-map-context`. In the privileged fork job the worktree holds the
trusted **base** checkout, not the fork head — a worktree-scanning section
would describe the wrong tree. The fork workflow therefore pins
`syntax-context: "false"` next to `related-code-context: "false"` and
`repo-map-context: "false"` (see [`docs/fork-review.md`](../fork-review.md)).
The stage is off by default everywhere else, so the boundary does not rest
on the workflow pin alone. Toggling the stage (or its budget, or its
provider) changes what the review corpus carries, so `SYNTAX_CONTEXT`,
`SYNTAX_CONTEXT_MAX_BYTES` and `SYNTAX_CONTEXT_PROVIDER` are part of the
precheck fingerprint: a config change invalidates a cached review instead
of silently reusing it.

## Measured evaluation

The measurement is **deterministic and offline**: synthetic git
repositories, the real lexical stage (`buildRelatedContext`) and the real
builder (`buildSyntaxContext`) over the **same** change anchors. No model
endpoint, no network. It lives in
`tests-v3/syntax-context-stage.test.ts` and prints its table on every run.

Method: for each case the gold item — the context the defect depends on —
is known by construction; each path is scored on whether it retrieved that
item (recall), how many items it produced, how many of them are not the
gold (noise), and how many bytes it would put into the corpus. The token
cost is an **estimate at 4 bytes/token** (no tokenizer), reported as the
bytes the stage *adds* to the corpus.

```
case                                        lex recall  syn recall  lex items  syn items  lex noise  syn noise  lex bytes  syn bytes  added tok*
------------------------------------------ ---------- ---------- ---------- ---------- ---------- ---------- ---------- ---------- ----------
A caller outside the diff                   1           1           2          2          1          0          566        711        178
B definition outside the diff               0           1           0          2          0          0          258        698        175
C changed declaration larger than the hunk  0           1           0          1          0          0          261        1281       321
D ambiguous same-name match                 1           1           4          2          3          0          873        711        178
```

- **The syntax stage retrieves the gold item in every case.** The lexical
  baseline misses **two** of the four outright: the definition of a
  referenced identifier (B) and the body of a declaration larger than the
  hunk (C). Both misses are structural, not marginal: the lexical stage
  searches the symbols the *diff* declares, and an identifier merely
  referenced on a changed line is not one of them.
- **The caller case (A) is the honest surprise.** The lexical baseline
  *does* retrieve the call site — as an untyped textual reference — so the
  issue's expectation that the baseline misses it is not borne out here.
  What the baseline cannot do is *qualify* it: it also returns the import
  line (one noise item), and in the ambiguous case (D) it returns the
  shadowed local as if it were a caller (three noise items against the
  syntax stage's zero).
- **The cost is bounded and small.** The section adds 175–321 estimated
  tokens on these cases, against a default corpus budget of 8,000 bytes.
  The cost is *additive* to the lexical section: the stage augments, it
  does not replace.

This is consistent with the closed spike's real-PR finding (PR #783): the
lexical baseline produced **zero** symbol-level context for the file that
contained the fix in 2 of 3 sampled real PRs — a structural blind spot of
the same shape as case B.

### What is NOT measured

- **Model-graded quality.** The measurement above is a retrieval
  measurement: it says whether the context was *found*, not whether the
  reviewer *used* it. A model-graded A/B on the real-PR corpus needs an
  operator-side model run (`docs/evals.md`); nothing was added to
  `evals/` for that reason.
- **Persistent retrieval (#741).** Out of scope: the issue sequences it
  after the cheaper exact/symbol stages, and no index, embedding store or
  database is involved here. The action works with no persistent store.
- **Real repositories.** The four cases are reconstructed, as the issue
  asks; the spike's three real PRs are the closest real-data evidence and
  are not part of this measurement.

## Known limitations

- Types, dynamic dispatch and cross-module method identity are **not**
  resolved: a same-named method in another module is not distinguished
  from the one under review beyond the module-scope rule.
- Destructuring and annotated Python assignments do **not** shadow: a
  name bound by `a, b = ...` or `x: int = ...` is not treated as a local
  binding. Declaration extents are **indentation-based** (Python, Go) or
  brace-based (JS/TS), so a multi-line signature or a decorator-heavy
  declaration can bound the extent loosely.
- Only **call-shaped** usages count as callers; a reference that is not a
  call (an import, an alias, a decorator) is not a caller. The candidate
  walk is **bounded** (200 files, 2,000 directories): a caller in a file
  beyond the cap is not found.
- The corpus section title (`# Syntax-Aware Context`) and the artifact's
  own title (`# Syntax Context (v1)`) are two level-1 headings, the same
  shape as the lexical section's (`# Related Code Context` containing
  `# Related Code (v1)`). The tool-harness planning context knows the
  outer title, so the syntax bytes stay in their own region instead of
  riding inside the "Related Code Context" region; the section is
  deliberately **not** embedded in the planning context, so the planner's
  budget is unchanged.

## Configuration

`syntax-context` (boolean, default `false`), `syntax-context-max-bytes`
(integer, default `8000`, range 1–200,000) and `syntax-context-provider`
(free-form, default `structural`). All three are repository-configurable
and part of the precheck fingerprint. See [`docs/inputs.md`](../inputs.md).
