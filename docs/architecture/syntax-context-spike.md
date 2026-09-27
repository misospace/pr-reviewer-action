# Syntax-context spike (#764)

Time-boxed spike on branch `spike/v3-syntax-context`. Prototype code:
`src/context/syntax/{grammars,declarations,diff,imports,callers,syntax-context}.ts`.
Tests: `tests-v3/syntax-{diff,declarations,callers,context}.test.ts` (20
cases, all passing; full existing `tests-v3` suite — 519 cases — still
passes unmodified). `package.json`/`package-lock.json` gained two pinned
devDependencies (`web-tree-sitter@0.25.10`, `tree-sitter-wasms@0.1.13`) so
the prototype type-checks and its tests actually run; see "Deviations"
at the bottom.

## Recommendation: go, with limits

The current `related-context.ts` baseline produced **zero** symbol-level
context for the file that actually contained the fix in 2 of the 3 sampled
real PRs — not a marginal gap, a structural blind spot (see "Real-PR
comparison" below). Syntax-context closes it, at a bounded, one-time asset
cost and negligible per-run latency. But two real correctness bugs turned
up in this spike within a single session against three small samples,
which is a signal to scope the initial rollout narrowly (TypeScript/
JavaScript + Python, this repo's own two primary languages, and the two
languages actually validated here) rather than ship all six languages'
naive per-node-type matching at once.

## 1. Parser options and cost

**web-tree-sitter (WASM) is the only fit for a single-file esbuild bundle.**
Native `tree-sitter` ships a compiled `.node` addon — it cannot be inlined
into `dist/index.js` by esbuild, and using it would mean either vendoring
exact runner-OS/arch/Node-ABI prebuilds or a native compile step, both of
which are worse fits than committing WASM files given "no network fetches
at runtime." Its own unpacked size (4.5 MiB) is the same order of
magnitude as the WASM option below, without a portable path to being
consumed as shipped files. Rejected outright, not a close call.

**Version-compatibility finding (real, cost real debugging time in this
spike):** `web-tree-sitter@0.27.0` (latest) fails to load
`tree-sitter-wasms@0.1.13`'s prebuilt grammars — `Language.load()` throws
inside `getDylinkMetadata`/`failIf`, an ABI/dylink-metadata mismatch
between the newer runtime and grammars built against an older
`tree-sitter` CLI. `web-tree-sitter@0.25.10` loads them cleanly. **The
grammar-bundle package and the runtime package are versioned
independently and are not guaranteed compatible** — a future Renovate bump
of either needs a smoke-parse check in CI, not a blind version bump, or
outages recur every time either package moves.

**Bundle/asset size** (measured against the pinned pair above; current
`dist/index.js` is 248,275 bytes / 244 KiB for comparison):

| Asset | Size |
| --- | --- |
| `web-tree-sitter` JS runtime, esbuild-bundled + minified | 72,361 B (70.7 KiB) / 19,128 B (18.7 KiB) gzipped |
| `web-tree-sitter` core parsing engine (`tree-sitter.wasm`) | 205,488 B (200.7 KiB) |
| `tree-sitter-typescript.wasm` | 2,342,690 B (2.23 MiB) |
| `tree-sitter-javascript.wasm` | 647,334 B (632 KiB) |
| `tree-sitter-python.wasm` | 476,105 B (465 KiB) |
| `tree-sitter-go.wasm` | 235,957 B (230 KiB) |
| `tree-sitter-bash.wasm` | 1,400,214 B (1.34 MiB) |
| `tree-sitter-yaml.wasm` | 182,936 B (179 KiB) |
| **6 grammars + core engine, total** | **5,490,724 B (~5.24 MiB)** |

That ~5.24 MiB is a one-time addition to what a consumer's checkout of the
action carries (committed binary assets alongside `dist/index.js`, not
something downloaded per PR run) — see §3 for why it can't just be
embedded in `dist/index.js` itself. The JS runtime portion alone grows
`dist/index.js` by ~29% (248 KiB → ~319 KiB minified).

**Cold-start / parse timing** (Node v26.3.0, this machine; GH Actions
runners will differ in absolute terms but not in relative shape):

| Step | Time |
| --- | --- |
| `Parser.init()` (instantiate core WASM engine) | 2.5–3.7 ms |
| `Language.load()`, TypeScript grammar | 2.7 ms |
| `Language.load()`, remaining 5 grammars combined | 4.4 ms |
| Parse a real ~2,266-line/95 KB TS file (concatenation of this repo's own `src/tools/harness.ts` + `src/requirements/ledger.ts`), first/cold call | 20.9–21.1 ms |
| Same file, warm (repeat parse, avg of 20) | 8.7–8.8 ms |
| Parse a real ~1,964-line Python file (`scripts/run_tool_harness.py`), cold | 9.0 ms |

All of this is noise next to the review action's existing model-call
latency (seconds to minutes). Cost is not the concern; correctness is (§2).

## 2. Prototype and real-PR comparison

The prototype (`src/context/syntax/syntax-context.ts`) takes a unified
diff + a checked-out workspace and returns, per changed file: (a) the
enclosing declaration(s) touched by each hunk, (b) same-file/bounded-
relative-import definitions of identifiers referenced on added lines, (c)
bounded call-shaped-text "callers" of each enclosing declaration's name —
all under a byte budget, with every stage degrading to "no result for
this file" (never throwing) on an unsupported language, unreadable file,
or parse failure. `declarations.ts` does node-type matching (no `.scm`
query files); `callers.ts` is a plain bounded directory walk + regex, not
tree-sitter, per issue #764's "no language is required for correctness."

It was run against three real merged PRs in this repo, comparing its
output to the real `related-context.ts` baseline — fed the actual
`pr_reviewer/change_anchors.py` output (the real upstream anchor
extractor), not a hand-built fixture — checked out at each PR's real head
SHA, with defects as described in issue #779's candidate-corpus comment.

### PR #547 — `fix(forgejo): make the Authorized Integration JWT cache thread-safe`

Production file: `pr_reviewer/forgejo_backend.py`. Only edits the *bodies*
of two pre-existing functions (`_get_jwt`, `_fetch_authorized_integration_jwt`)
to add locking — no `def` line is added or changed.

- **Baseline:** `change_anchors.py` only seeds symbols from *added
  declaration lines*; since none exist here, `forgejo_backend.py` gets
  **"Symbols: none"** — zero context on the exact file with the fix. The
  only real code it happens to surface is via an unrelated coincidence: a
  test helper also named `worker()` textually matches `ThreadPoolExecutor`
  call sites elsewhere (including the real `linked_sources.py` prewarm
  path), mixed in with irrelevant matches from `scripts/image_digest_analysis.py`.
- **Syntax-context:** correctly finds both enclosing declarations in full
  (`_fetch_authorized_integration_jwt` lines 127–192, `_get_jwt` lines
  195–210) and their callers, including the one real same-file production
  caller — `_get_jwt` calling `_fetch_authorized_integration_jwt` at line
  210 — that the baseline's "exclude the whole changed file" convention
  hides entirely.
- **Limitation found:** the actual concurrency-triggering call site (the
  `ThreadPoolExecutor` prewarm in `linked_sources.py`) is *two* call-hops
  away, through an intermediate `_resolve_auth_header()` wrapper. A
  one-hop caller search — this prototype's, or a plain `rg` — cannot reach
  it automatically; a human/agent still has to follow one more hop, though
  they now start from `_get_jwt`'s real caller instead of nothing.

### PR #597 — `fix(precheck): fail closed when the @ai-reviewer dismiss permission check can't run`

Production file: `pr_reviewer/precheck.py`. Same shape: edits the fallback
branches inside the pre-existing `_resolve_maintainers()` security gate,
no new `def` line.

- **Baseline:** again **"Symbols: none"** for `precheck.py` — zero context
  on the exact security-critical function named in the defect.
- **Syntax-context:** correctly encloses `_resolve_maintainers` (lines
  1260–1335) and `_write_previous_dismissals` (1109–1212) with full bodies
  and callers.
- **Limitation found:** `maxCallersPerDeclaration` (10) was consumed
  entirely by the test suite's many calls before reaching `precheck.py`'s
  own `main()` call site — bounded caps plus filesystem scan order let a
  test-heavy repo crowd out the one production caller that matters.
  Recommend ranking hits non-test-path-first (`related-context.ts` already
  buckets tests separately from symbol references — the same convention
  should apply here).

### PR #756 — `fix(classifier): require a real untrusted-path surface for path handling`

Files: `pr_reviewer/classifier.py` + its TS port `src/classification/classify.ts`.
Unlike the other two, every touched function here was newly added/renamed
by the fixing PR, so the "added declaration line" anchor heuristic works.

- **Baseline:** already anchors nearly every touched helper; correctly
  reports "no references" for almost all of them — they are genuinely
  private, single-file helpers with no cross-file callers, and this
  defect was purely internal control-flow logic, not a missing-context
  problem.
- **Syntax-context:** agrees with that conclusion, and additionally
  surfaces full bodies plus 2 same-file definitions the baseline omitted
  (`_strip_static_string_literals`/`_division_operand` and their TS
  counterparts). Net new *relevant* signal is modest here — a useful
  negative control showing that syntax-context's marginal value tracks
  how far outside the diff the missing context actually lives, not a
  constant win.

### Bugs found and fixed mid-spike (both are exactly what issue #764 asks to be evaluated against)

1. **Hunks spanning sibling declarations.** Git's default 3-line diff
   context can merge edits to two adjacent functions into one hunk (this
   is exactly PR #547's third hunk: `_fetch_authorized_integration_jwt`'s
   tail through all of `_get_jwt`). A naive "smallest declaration
   containing the *whole* hunk range" containment check then matches
   **nothing** — no single node spans two siblings — silently producing
   zero enclosing declarations. Fixed by finding the enclosing declaration
   per contiguous added-line run instead of per whole-hunk span
   (`groupConsecutive` in `syntax-context.ts`). This is issue #764's own
   listed evaluation criterion ("a changed declaration whose full body is
   larger than the hunk") in its mirror form, and a **must-fix**, not a
   nice-to-have, for any real implementation.
2. **Node-type-only matching is unsound for `const`/`let`.**
   `lexical_declaration` covers both a real function-valued declaration
   (`const foo = () => {}`) and an ordinary local variable
   (`const result = x + 1`). Without checking the declarator's value
   shape, *every* local assignment becomes its own bogus "enclosing
   declaration" and gets searched for callers. On PR #756 this flooded
   the byte/caller budget with junk on common names (`result`, `i`, `n`,
   `ch`, `line`, `content`, `closed`, ...) before it was fixed. Mitigated
   with an `isRealDeclarationNode` predicate (declarator's value must be
   function/arrow/class-shaped) — but this is still node-type pattern
   matching, not real binding/scope resolution. A sound implementation of
   "definitions of identifiers on changed lines" needs proper scope
   tracking (e.g. tree-sitter's standard `locals.scm` query convention) to
   avoid matching an unrelated same-named local elsewhere in the file;
   this spike's predicate is a cheap partial mitigation, not that.
3. **Plain-text caller matching over-recalls.** A bare `\bidentifier\b`
   regex matches the name inside comments/docstrings/prose — observed
   both in the real PR #597 defect narrative's own evidence trail and in
   this prototype's first pass. Tightening to require call-shape
   (`identifier(`) cut most of it, but a comment that literally writes out
   `name()`, or the declaration's own `def name(`/`function name(` line
   (which is itself call-shaped), still match; the orchestrator filters
   the second case because it knows the declaration's own line range, but
   the comment case is open. A sound fix means parsing candidate files
   too and checking the match sits inside a `call_expression` node — real
   cost, worth bounding to only the highest-value candidates rather than
   doing it for every text hit.

## 3. Integration sketch

**Where it plugs in.** `related-context.ts` is wired into the v3 runtime
today only as a parity-fixture CLI mode (`related-code-fixture` in
`src/index.ts`), tested against the Python original ahead of the bash/
Python pipeline's retirement (#706); real production corpus assembly still
runs through `scripts/sections/corpus.sh`. Syntax-context should follow
the identical pattern already used by every other `src/context/*.ts`
module: its own artifact type and `-fixture` CLI mode now, becoming a real
corpus section (a new `## Syntax Context` markdown block, alongside
`## Related Code`) once v3's own corpus assembly replaces the bash
pipeline post-#706. **It augments, it does not replace** — `related-context.ts`
still owns test/manifest discovery and cross-repo textual references that
syntax-context doesn't attempt.

**Tool-loop planning context.** The agentic tool loop
(`pr_reviewer/tool_loop.py` / `src/tools/harness.ts`) currently spends live
`read_file`/`git_grep` round-trips discovering a changed function's body
and callers when the model asks. Feeding syntax-context's bounded output
into the system-prompt/planning context up front could cut those
round-trips for the cases it handles well (single-hop, well-named
declarations) — issue #764 is right to scope this as "evidence, not
authority": the model should still be free to go deeper via the tool loop
when the pre-computed context falls short, which PR #547's two-hop case
above shows it sometimes will.

**Failure modes** (all exercised by the prototype's own tests):
unsupported language → `supported: false`, contributes nothing, existing
`related-context.ts` output for that file is unaffected
(`buildSyntaxContext degrades an unsupported language...`). Unreadable or
missing file (deleted/renamed away) → same degrade path, captured in
`parseError`, never thrown (`...degrades a missing file...`). Byte budget
exceeded → stops adding, reports `truncated: true` with explicit `reasons`
(`...enforces the byte budget...`) — though note it is a stop-adding
threshold, not a hard per-item clip: a single large declaration can
overshoot it before the check fires, so a production version should clip
an individual declaration's text to the *remaining* budget rather than
just stopping after it.

**Not done in this spike (explicitly out of scope — `dist/`,
`scripts/build-v3.mjs` are off-limits here):** `build-v3.mjs` needs to
copy the core WASM engine plus the selected grammar WASMs into `dist/` as
committed binary files (not base64-inlined into `index.js` — the ~33%
inflation plus V8 parsing multi-MB string literals is worse than a
handful of extra committed binaries), and the runtime needs to resolve
their paths relative to `__dirname`/`import.meta.url` inside the shipped
bundle, not via `require.resolve` against `node_modules` (which won't
exist in a consumer's checkout of the action — only `dist/` is fetched).
`check:bundle`'s `git diff --exit-code -- dist` gate would then also cover
the new binaries; git diffs them fine, just opaquely.

## Scope estimate

Two real correctness bugs in one session against three small samples is a
signal against shipping all six languages' naive matching at once.

- **Phase 1 (~1–1.5 weeks):** productionize TypeScript/JavaScript + Python
  (the two languages validated here, and this repo's own two primary
  languages) — non-test-path-first caller ranking, per-item byte clipping,
  the `dist`/build-script asset wiring, the corpus/fixture integration
  point, and an opt-in flag (#764 requires "optional, engine-level").
- **Phase 2 (~3–5 days):** Go + Bash declaration/definition support —
  mostly registering the right node types and validating against a couple
  of real Go/Bash PRs in this repo (`kube-tools/`, `hack/` scripts) — lower
  priority given this repo is TS/Python-dominant.
- **YAML:** keep the grammar loaded (cheap, 179 KiB) for the plain-text
  caller stage's language bookkeeping; don't invest in declaration/
  definition support — YAML has no function/class concept this scheme
  models.
- **Scope-aware identifier resolution** (tree-sitter `locals.scm`-style
  binding tracking) is explicitly **out** of this estimate — a follow-up
  only if Phase 1's `isRealDeclarationNode` mitigation proves insufficient
  against a larger PR sample; recommend measuring before investing further.

## Deviations from the branch's stated file scope

`package.json`/`package-lock.json` gained two pinned devDependencies
(`web-tree-sitter@0.25.10`, `tree-sitter-wasms@0.1.13`) so the prototype
under `src/context/syntax/` actually type-checks and its tests under
`tests-v3/` actually run via this repo's own `npm test`. No other existing
file was edited. This is flagged for review/removal before any of this
code is treated as more than a spike artifact.
