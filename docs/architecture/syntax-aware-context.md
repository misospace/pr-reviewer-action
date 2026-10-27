# Syntax-aware context (#764)

The syntax-aware context stage is an **optional, engine-level** context
stage: it retrieves bounded source context for a change that the lexical
related-code path cannot see, and hands it to the model as evidence.

It is **OFF BY DEFAULT** — the issue's acceptance criterion is "default
enablement requires measured quality/token benefit", and that benefit is
not established yet (see [Measured evaluation](#measured-evaluation)).
Enabling it is an operator decision (`syntax-context: "true"`); it never
runs on a fork pull request (see [The fork boundary](#the-fork-boundary)).

## Goal and relation to the lexical stage

The lexical related-code stage (`src/context/related-context.ts`, enabled by
`related-code-context`) stays the **baseline**: nothing here replaces it,
and nothing here changes its semantics. It searches for the **symbols the
diff declares** and returns the *matching lines* it finds elsewhere. Three
structural blind spots follow, all named in the issue: an identifier merely
**referenced** on a changed line is not among the diff's symbols, so its
**definition** is never retrieved; the stage returns matching *lines*,
never the **whole declaration** a hunk cuts through; and a textual match
cannot be told apart from a **same-name binding in another scope**, so
shadowed locals come back as if they were callers. The syntax stage answers
exactly those three questions, with the same anchors the lexical stage
already produced: it **adds** a corpus section and never edits, filters or
suppresses the lexical one.

## The provider seam

`src/context/syntax/types.ts` defines the seam: a provider answers syntax
questions about **one file** — `declarations(file)`,
`identifiersOnLine(file, line)` and `classify(file, line, name)` — and
nothing else. Everything a reviewer would call *policy* — candidate
discovery, budgets, provenance, filtering, truncation, fallback — belongs
to the **builder** (`src/context/syntax/build.ts`), not to the provider, so
a parser-backed provider registers under a new id
(`registerSyntaxProvider`) and no policy changes shape. The operator-visible
seam is the `syntax-context-provider` input; an unknown id degrades to the
default provider with a recorded reason (never an exception).

### Why the default provider is dependency-free

The default provider (`structural`) is plain TypeScript over node built-ins:
the repository's own declaration grammar (`declarationAt`/`declarationEnd`)
plus a lexical reader and an indentation-aware scope walk. No parser, no
grammar files, no dependency. The parser-backed alternative was spiked and
closed (PR #783): `web-tree-sitter` + `tree-sitter-wasms` measured
**5,490,724 B (~5.24 MiB)** of grammar WASMs plus a 205 KB core engine
against a 244 KiB `dist/index.js`, and the grammar bundle and the runtime
are **versioned independently** — a `web-tree-sitter` bump broke
`Language.load()` for every prebuilt grammar.

## What the stage retrieves

1. **Touched declarations** — the whole declaration (bounded body) the
   diff touches, not just the hunk.
2. **Definitions of referenced identifiers** — where the identifiers the
   changed lines reference are defined, with the reference sites recorded.
3. **Callers of the touched declarations** — the call sites of the
   declarations the diff touched, each bound to the declaration it calls.

**Callers vs. the lexical baseline.** The baseline matches text; the
syntax stage resolves *scope*. A local binding that shadows the name — a
nested function, a parameter, a local assignment — is **not** a caller (the
provider answers `unknown`, not `call`), and a file that owns the name at
module scope owns a *different* symbol than the one under review. The
baseline cannot make either distinction. The stage emits **context only**:
no findings, no severity, no obligations, no gates, no verdict.

## Budgets and truncation

Every cap is a hard limit, and every drop is visible.

| Bound | Value | What it bounds |
|---|---|---|
| `MAX_SYNTAX_ITEMS` | 40 | items per category and in total |
| `MAX_SYNTAX_BYTES` | 100,000 | bytes of text the artifact carries: declaration bodies, caller snippets, and every path, name, kind and `referenced_from` site the renderer prints |
| `MAX_SYNTAX_SECONDS` | 20 | wall-clock seconds of ONE build — a module constant, not configurable |
| `MAX_SYNTAX_CANDIDATE_FILES` | 200 | repository files considered as candidates |
| `MAX_SYNTAX_DECLARATIONS_PER_FILE` | 2,000 | declarations a provider may report for ONE file |
| `MAX_SYNTAX_IDENTIFIERS_PER_LINE` / `MAX_SYNTAX_REFERENCED_TOTAL` | 50 / 2,000 | identifiers kept per changed line / referenced identifiers tracked in total |
| `MAX_SYNTAX_BODY_CHARS` / `_LINES`, `MAX_SYNTAX_SNIPPET_CHARS` | 2,000 / 120, 300 | one declaration body, one caller snippet |
| `MAX_SYNTAX_CHANGED_LINES` / `_RANGES` | 500 / 200 | changed lines scanned |
| `MAX_SYNTAX_CHANGED_FILE_CHARS` | 8,000,000 | changed-file content RETAINED in total — the anchor extractor's own file cap (100) times the safe reader's per-file cap (2 MB) would otherwise let a PR hold hundreds of megabytes; past the budget the remaining changed files are skipped, visibly |
| `syntax-context-max-bytes` | 8,000 (1–200,000) | bytes of the section that enters the corpus. The **effective** ceiling is `min(syntax-context-max-bytes, 100,000)`: the rendered document is itself capped at `MAX_SYNTAX_MARKDOWN_BYTES` (100,000) before the corpus clip |

What is dropped first: a **definition** before a caller, a caller before a
touched declaration — the value order is "the change itself, then its
direct impact, then its background". Any drop sets `truncated: true` and
`truncated_reason` in the artifact — WHICH bound ended the collection
("item cap", "byte cap", "deadline", "declaration cap", …) — and renders a
`_Output is bounded and incomplete._` note in the Markdown. The corpus byte
cap is a *second*, independent bound: the artifact is built under the
module's own cap, and the section that enters the corpus is clipped to
`syntax-context-max-bytes` on a fence-safe line boundary.

The wall-clock bound bounds the **WORK**, not the output: a collection loop
that runs long stops, what was collected stays, and the artifact says the
result is incomplete. Expiry is **not** fatal — the section is kept, marked
incomplete, and `truncated_reason` says `"deadline"` (the deadline reports
itself as the bound that ended the collection, even when an earlier cap
also bit). The bound is a module constant on purpose: it cannot be widened
by an operator input or an environment variable, because a stage that can
be told to spend minutes of runner time is a stage that can stall a review.
The per-item caps bound the work the same way: the scope resolution is one
linear pass over a file's declarations, a definition lookup reads a name
index, and the candidate phase holds ONE file at a time (a parsed 2 MB file
is ~100 MB of memory), so neither the time nor the memory of the phase
grows with the size of the repository.

The section rides in the corpus **body**, right after the lexical
related-code section and before the diff. The body is truncated from the
**tail** (`truncate_clean`), and the diff sits in the body's tail half — so
enabling the stage CAN push the diff toward the truncation boundary, and a
body-budget cut can shorten the diff. Only the **standards block** is
genuinely outside the body budget (it is reserved separately) and therefore
survives. What the operator accepts is body budget that the low-value tail
sections (linked sources, repo impact scan, repo history) would otherwise
have used, and — in a body already near its budget — a shorter diff. The
stage is off by default, and `syntax-context-max-bytes` bounds what it adds.

## Provenance

Per item, provenance follows the contract in
[`source-evidence-provenance.md`](source-evidence-provenance.md):

- the text is read from the **working tree**, so no revision is bound
  (`revision: null`). Binding one would claim a byte-identity the read
  never established, and a literal claim against such a snippet must fail
  closed (`authorizesLiteralClaim` refuses it) — the same rule as the
  related-code stage's snippets;
- the **PR head SHA** is recorded **once**, at artifact level, as
  `head_revision` — it is the revision the *review* is about, not a claim
  that any particular snippet was read from it;
- the **candidates** are git-tracked files when the repository can be asked
  (`git ls-files`, argv-only, timeout-bounded): their bytes can be vouched
  for as repository-committed content. When the listing falls back to the
  filesystem walk (no git, not a repository, a timeout), the candidate
  items carry the `untrusted_text` representation instead — an untracked
  file (a local virtualenv, build output) is not repository content. The
  **changed** files' own items keep the committed-source treatment: the
  diff vouches for those bytes;
- a credential in a retrieved body is masked before truncation can split
  it, and the redaction count rides along in the provenance
  (`representation`, `synthesized`, `redaction_count`);
- the provenance annotation is stamped on the harness-authored header line
  preceding the fence, never on the fenced body, so repository text cannot
  forge the annotation channel.

The rendered section states, in its own **harness-authored** line outside
any fence, that what follows is untrusted repository source data and not
instructions — the same trust framing the repository-map section carries.
No new provenance scheme is introduced.

## Failure and degradation

`errors` holds **fatal** problems only; `notes` holds **non-fatal**
observations. A fatal problem drops the section whole (the review falls back
to the lexical context); a note never does — it says what was left out.

| Situation | Result |
|---|---|
| stage disabled (`syntax-context` false — the default), or the anchors are unavailable | all three artifacts empty; no corpus section |
| the lexical related-code stage is disabled | the syntax stage is a no-op: it consumes the anchors the lexical stage already extracted, so `related-code-context: "false"` also silences it |
| the pull request is a fork | the stage refuses in code (`IS_FORK_PR === "true"`): all three artifacts empty; no corpus section — see [The fork boundary](#the-fork-boundary) |
| provider throws, or the anchor artifact is malformed | the build is degraded (`errors` non-empty); the section is dropped whole — empty artifacts, no corpus section, the review falls back to the lexical context |
| an unreadable or binary changed file (over the reader's size cap, a symlink, a refused path) | a **per-file skip**: the file is recorded in `notes` and the rest of the section is kept — one oversized file cannot silence the evidence |
| the candidate listing could not be git-backed | the filesystem walk stands in; the candidate items carry the `untrusted_text` representation and a note says so |
| a bound bit (declaration cap, identifier cap, candidate cap, item cap, byte cap), or the wall-clock bound expired | the collection is cut, `truncated: true` and `truncated_reason` name the bound (`"deadline"` for the wall-clock bound, which is **not** fatal: what was collected stays, the section is kept and marked incomplete) |
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

**The pin alone is not enough, so the stage refuses the fork IN CODE.** The
contract default of `syntax-context` is `"false"` — the same value the fork
workflow pins — and `isOperatorExplicit`
(`src/config/repository-config.ts`) treats an operator value EQUAL to the
contract default as *not explicitly set*. A repository's base-ref
`.github/pr-reviewer.yml` could therefore set `syntax-context: "true"`, the
pin would not stop it, and the stage would scan the base checkout of a fork
PR. `buildSyntaxContextSection` therefore refuses a fork PR itself, before
the flag is read: `IS_FORK_PR === "true"` (the comparison
`src/routing/tiers.ts` makes; the flag is resolved upstream by `deriveFork`,
which fails closed to `"true"` when the PR object cannot be parsed) writes
the empty artifacts and returns. (`related-code-context` has no such hole:
its default is `"true"`, so the fork's `"false"` IS explicit.)

The stage is off by default everywhere else. Toggling the stage (or its
budget, or its provider) changes what the review corpus carries, so
`SYNTAX_CONTEXT`, `SYNTAX_CONTEXT_MAX_BYTES` and `SYNTAX_CONTEXT_PROVIDER`
are part of the precheck fingerprint.

## Measured evaluation

The measurement is **deterministic and offline**: synthetic git
repositories, the real lexical stage (`buildRelatedContext`) and the real
builder (`buildSyntaxContext`) over the **same** change anchors. No model
endpoint, no network. It lives in `tests-v3/syntax-context-stage.test.ts`.

Method: for each case the gold item — the context the defect depends on —
is known by construction; each path is scored on whether it retrieved that
item (recall), how many items it produced, how many are not the gold
(noise), and how many bytes it would put into the corpus. The token cost is
an **estimate at 4 bytes/token** (no tokenizer).

```
case                                        lex recall  syn recall  lex items  syn items  lex noise  syn noise  lex bytes  syn bytes  added tok*
------------------------------------------ ---------- ---------- ---------- ---------- ---------- ---------- ---------- ---------- ----------
A caller outside the diff                   1           1           2          2          1          0          566        781        196
B definition outside the diff               0           1           0          2          0          0          258        768        192
C changed declaration larger than the hunk  0           1           0          1          0          0          261        1351       338
D ambiguous same-name match                 1           1           4          2          3          0          873        781        196
```

- **The syntax stage retrieves the gold item in every case.** The lexical
  baseline misses **two** of the four outright: the definition of a
  referenced identifier (B) and the body of a declaration larger than the
  hunk (C). Both misses are structural: the lexical stage searches the
  symbols the *diff* declares, and an identifier merely referenced on a
  changed line is not one of them.
- **The caller case (A) is the honest surprise.** The lexical baseline
  *does* retrieve the call site — as an untyped textual reference — so the
  issue's expectation that the baseline misses it is not borne out here.
  What the baseline cannot do is *qualify* it: it also returns the import
  line (one noise item), and in the ambiguous case (D) it returns the
  shadowed local as if it were a caller (three noise items against the
  syntax stage's zero).
- **The cost is bounded and small.** The section adds 196–338 estimated
  tokens on these cases, against a default corpus budget of 8,000 bytes;
  the cost is *additive* to the lexical section.

This is consistent with the closed spike's real-PR finding (PR #783): the
lexical baseline produced **zero** symbol-level context for the file that
contained the fix in 2 of 3 sampled real PRs — a blind spot like case B.

### What is NOT measured

- **Model-graded quality.** The measurement above is a retrieval
  measurement: it says whether the context was *found*, not whether the
  reviewer *used* it. A model-graded A/B needs an operator-side model run
  (`docs/evals.md`).
- **Persistent retrieval (#741).** Out of scope: the issue sequences it
  after the cheaper exact/symbol stages, and no index, embedding store or
  database is involved here.
- **Real repositories.** The four cases are reconstructed, as the issue
  asks; the spike's three real PRs are the closest real-data evidence.

## Known limitations

- Types, dynamic dispatch and cross-module method identity are **not**
  resolved: a same-named method in another module is not distinguished
  beyond the module-scope rule.
- Destructuring and annotated Python assignments do **not** shadow: a
  name bound by `a, b = ...` or `x: int = ...` is not treated as a local
  binding. Declaration extents are **indentation-based** (Python, Go) or
  brace-based (JS/TS), so a multi-line signature bounds the extent loosely.
- Only **call-shaped** usages count as callers; a reference that is not a
  call (an import, an alias, a decorator) is not a caller. The candidate
  listing is **bounded** (200 files, 2,000 directories): a caller in a file
  beyond the cap is not found.
- A file with more than **2,000 declarations** keeps only its first 2,000
  (the per-file cap), and a build that passes **20 seconds** stops early.
  Both are visible in `truncated_reason` and in the notes.
- The corpus section title (`# Syntax-Aware Context`) and the artifact's
  own title (`# Syntax Context (v1)`) are two level-1 headings, the same
  shape as the lexical section's. The tool-harness planning context knows
  the outer title, so the syntax bytes stay in their own region instead of
  riding inside the "Related Code Context" region; the section is
  deliberately **not** embedded in the planning context.

## Configuration

`syntax-context` (boolean, default `false`), `syntax-context-max-bytes`
(integer, default `8000`, range 1–200,000) and `syntax-context-provider`
(free-form, default `structural`) are repository-configurable and part of
the precheck fingerprint. See [`docs/inputs.md`](../inputs.md).
