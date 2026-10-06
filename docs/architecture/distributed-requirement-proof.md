# Distributed requirement proof (#962)

Status: **pinned proof contract (v2)** — implemented by `src/enforcement/requirement-trace.ts`,
`src/config/requirement-owners.ts`, `src/requirements/trace-repair.ts` and the
`requirement_trace` prompt fragment.

## Problem

Requirement-trace (#874) assumes an in-scope requirement is provable by a single
enforcement location plus a single regression-test location. That is correct for a
narrow invariant ("`sourceSha` must match the reviewed head") but wrong for a
cross-cutting security/architecture standard whose enforcement is intentionally
distributed across several seams.

PR #958 exposed this. Two standards were legitimately in scope because the PR changed
their architectural metadata, yet trace downgraded them to `unverifiable`:

- **Untrusted content is data** — cited at `src/context/redact.ts`, but redaction is
  one part of a boundary that also includes fence-safe rendering and instruction/data
  separation, which live elsewhere.
- **Fork privilege separation** — cited at `gateForkForForks()`, but that proves one
  fork gate, not the invariant (privileged checkout separation, feature defaults,
  secret boundaries, private enrichment).

The failure is the **proof shape**, not scope selection (#957/#958 fixed scope). A
single location cannot honestly prove a distributed invariant, so the validator
correctly refused — and every such requirement became `unverifiable`.

## Design principle: trusted topology, untrusted citations

The only way to let the model represent distributed enforcement without letting it
self-authorize a broad invariant is to split authority:

- **Which requirements are distributed, and which seams each one spans, is declared by
  base-ref-trusted repository config.** The model never declares a group and never
  supplies a glob. This is the same trust boundary as `requirement-owners.ts` (#958):
  the file is read from the PR's base ref via `git show <ref>:<path>`, never the head.
- **The model supplies `{file, line}` citations only.** The validator proves coverage by
  matching those citations against the trusted group globs.

Consequently "citation dumping" is structurally useless: extra citations that fall
outside a declared group's surface contribute nothing to coverage, and a group cannot be
satisfied without citing a location inside that group's declared surface.

## Completeness principle: bounded caps fail closed

Two limits could otherwise let the validator accept a **weaker proof than the trusted
topology declares**. Neither may:

- **Test evidence must be anchored to trusted seams.** An enforcement seam with no
  declared test glob cannot be satisfied by an arbitrary test file elsewhere — the test
  evidence is tied to the same trusted topology as the enforcement evidence.
- **Topology overflow must fail closed.** When the trusted config declares more seams
  than the bounded citation/presentation cap can represent, the validator must **not**
  silently drop the excess and validate the remainder. It forces the trace incomplete.

Bounded caps are a presentation limit. They never become a silent weakening of the proof.

## Config schema

Extension to `.github/pr-reviewer-owners.yml` (and its `.pr-reviewer-owners.yml`
fallback). The existing rule shape is unchanged and still governs **scope**; an
optional `groups` block additionally declares the **proof topology**.

```yaml
requirements:
  fork-privilege-separation:
    # unchanged: narrow owner globs that scope the requirement in (#958)
    owners:
      - .github/workflows/fork-ai-review.yaml
      - scripts/fork_review_gate.py
    # new: the distributed proof topology (presence ⇒ this requirement is distributed)
    groups:
      - name: privileged-checkout
        owners:
          - .github/workflows/fork-ai-review.yaml
        tests:
          - tests/fork_review_gate.test.py
      - name: feature-defaults
        owners:
          - src/config/repository-config.ts
        tests:
          - tests-v3/repository-config.test.ts
      - name: secret-boundary
        owners:
          - src/publish/publish.ts
        tests:
          - tests-v3/publish.test.ts
```

| Field | Required | Meaning |
|---|---|---|
| `<slug>.owners` | yes (existing) | Narrow globs that put the requirement **in scope** when changed (#958). Unchanged. |
| `<slug>.groups` | no | Presence (with ≥2 valid groups) makes the requirement **distributed**. |
| `groups[].name` | yes | Lowercase hyphenated slug. Diagnostics + fixture assertions only. |
| `groups[].owners` | yes, ≥1 | Enforcement surface of the seam. Same `isValidOwnerPattern` narrow-glob validation as top-level owners. |
| `groups[].tests` | yes, ≥1 | Test surface of the seam. Every group must be covered by a distinct test-path citation matching one of these globs, exactly as `owners` is covered by enforcement. A group that declares no valid test globs can **never** be satisfied — the requirement stays `unverifiable` — and emits a parse warning. It is deliberately **not** a parse error that drops the group, because dropping groups could fall below `MIN_DISTRIBUTED_GROUPS` and silently weaken the requirement to the narrow proof. |

### Glob match semantics

A group glob matches a citation exactly as #958 ownership does: the glob is compiled to
an **anchored full-path regex** (`^…$`, `*`/`?` within a segment only) via the same
`ownerPatternRegex`, and the cited file path is **lowercased** before matching. Substring
matching is not used.

### Caps and validation

- `MAX_GROUPS_PER_RULE = 4` — the **representable** cap. Exceeding it (per rule, or in
  the union across matching rules) is a topology overflow and **fails closed**; see
  "Determining distributed-ness".
- `MAX_DECLARED_GROUPS_PER_RULE = 16` — a parse-time **safety bound** on parser/matcher
  work only. Exceeding it drops the excess with a warning; the validator still sees an
  over-cap set and fails closed, so the safety bound never changes the outcome.
- `MAX_GROUP_NAME_CHARS = 60`; `MIN_DISTRIBUTED_GROUPS = 2`.
- `groups[].owners` / `groups[].tests` reuse `isValidOwnerPattern` and the existing
  `MAX_OWNERS_PER_RULE` per-list cap.
- Group names must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Duplicate group names across rules merge (owners/tests unioned).
- Two groups in the same rule sharing an **identical owner glob** emit a warning (a
  config smell: that seam cannot be independently proven; see "Injective coverage").
- A group declaring no valid test globs emits a warning (and can never be satisfied).
- A rule whose `groups` block is present but yields **fewer than 2 valid groups** is
  dropped from the distributed set and retained as a plain ownership rule, with a
  warning. See "Fail-soft vs fail-closed".
- A rule with `groups` but no valid top-level `owners` is dropped entirely (existing
  rule: no owners ⇒ no rule).

## Determining distributed-ness

A requirement is **distributed** iff at least one ownership rule whose `match` tokens all
appear (case-insensitively, as whole words) in the requirement text declares ≥2 valid
groups. The **effective groups** are the union over all matching rules, merged by name
(owners unioned, tests unioned), sorted by name for determinism.

If the effective group count exceeds `MAX_GROUPS_PER_RULE`, the requirement is
**overflowed**: it is still distributed, but the validator does **not** validate a
truncated proof. It forces the row `unverifiable` with a `distributed-topology-overflow`
note and marks coverage incomplete, whatever the model cited. The excess group names are
also surfaced through the ownership-warnings channel so the maintainer can see the
declared topology is not representable.

Distributed-ness is gated on lexical `match` tokens appearing in the requirement text, so
a standard whose prose drifts from its slug tokens falls back to the **narrow** (weaker)
proof. This is the same lexical fragility #958 accepted for scope, now on the
proof-strength axis; it fails toward narrow, never toward "easier than declared", and is
never reachable by the model. Choose slug tokens from the standard's canonical phrasing.

## Validation algorithm

`met` on a **narrow** requirement is unchanged, byte for byte:

> ≥1 location-valid enforcement citation **and** ≥1 test-path-valid test citation
> **and** a predicate involving one of the requirement's derived terms found over the
> valid enforcement locations.

Distributed validation **replaces** the narrow `met` path entirely for a distributed row:
the narrow downgrade notes (`downgraded-no-valid-enforcement-location`,
`downgraded-no-valid-test-location`) never apply to it. `met` on a distributed
requirement requires all three of:

1. **Enforcement seam coverage (injective).** Every effective group is assigned a
   **distinct** `enforcement` citation that is location-valid and whose file matches one
   of that group's `owners` globs. Assignment is a **maximum bipartite matching** between
   groups and valid citations (augmenting-path; bounded by the group and citation caps),
   so the row passes only when *every* group can be given its own seam location. Any
   unmatched group downgrades the row to `unverifiable` with a note
   `distributed-enforcement-group-uncovered:<name>` (one note per unmatched group). A
   claim with **no** valid enforcement citation emits that note for every group.
2. **Test seam coverage (injective).** Every effective group is assigned a **distinct**
   test-path-valid citation (`isTestPath` **and** location-valid) matching one of that
   group's `tests` globs (same maximum bipartite matching). A group that declares no test
   globs can never be assigned one. A miss downgrades with
   `distributed-test-group-uncovered:<name>`. A row with no test-path-valid citation at
   all additionally carries `distributed-test-location-uncovered`.
3. **Predicate (anti-copy, #854).** `enforcementPredicateFound` must hold over the set of
   **matched group-covering** enforcement citations. The term set is the requirement's
   derived terms **only** — the model-supplied `symbol` is **excluded** for distributed
   rows, because the model chooses both the cited line and the symbol and could otherwise
   satisfy the check with a term it invented. When the requirement text yields **no usable
   terms at all**, the distributed path does **not** fall through to the narrow path's
   documented empty-terms skip: it requires at least one predicate-shaped line among the
   matched group-covering citations, or downgrades. A miss downgrades with the existing
   `enforcement-location-copies-without-comparing` note.

All three must pass for `met`. A distributed requirement's `unmet` / `not_applicable` /
`unverifiable` paths are unchanged (reason required, else downgrade to `unverifiable`),
and a well-formed `unmet` still marks coverage incomplete.

The distributed note vocabulary is **exactly** these four, and nothing else — no
positional-index or aggregate-duplicate notes:

- `distributed-enforcement-group-uncovered:<name>` — one per unmatched enforcement group.
- `distributed-test-group-uncovered:<name>` — one per unmatched test group.
- `distributed-test-location-uncovered` — the row has no test-path-valid citation at all.
- `distributed-topology-overflow` — the trusted topology exceeds `MAX_GROUPS_PER_RULE`;
  the row is forced `unverifiable` and incomplete.

### Injective coverage is what makes the acceptance case hold

Requiring a **distinct** citation per group means a single citation can never satisfy two
seams, regardless of whether the maintainer's globs overlap. This is what guarantees the
issue's acceptance case — `gateForkForForks()` alone, one citation, cannot cover a
standard with ≥2 declared groups. It is also why identical owner globs across groups warn:
they declare two seams with one surface, so the proof can never be stronger than a single
seam.

### Row shape

The persisted row shape is **unchanged** — `enforcement` and `test` were already
`TraceLocation[]`, so no artifact version bump. Distributed diagnostics ride in the
existing `notes` channel (`distributed-*`), mirroring the requirement_coverage
convention.

### Rendering

`renderRequirementTraceMarkdown` keeps the existing `file:line` text (the first cited
enforcement location) and appends the uncovered seams so the published body stays
understandable:

- enforcement miss with a citation present: ``… (`src/x.ts:12`; uncovered enforcement seams: `secret-boundary`)``
- no enforcement citation at all: ``… (uncovered enforcement seams: `privileged-checkout`, `feature-defaults`)``
- test miss: ``… (uncovered test seams: `secret-boundary`)``
- no test citation at all: ``… (`src/x.ts:12`; no test location cited)``
- topology overflow: ``… (distributed topology exceeds the 4 representable seams)``

Seam names are base-ref-trusted slugs, still length-capped at `MAX_GROUP_NAME_CHARS` and
control-character-stripped before rendering. Total rendered seam names are bounded by the
group cap. The requirement id is sanitized the same way before interpolation: in practice
a ledger id is always `req-<12 hex>`, but the validator duck-types the ledger and the
review body is a published boundary, so control characters and backticks are stripped and
the id is length-capped rather than trusted verbatim.

## Prompt awareness

The model cannot infer which requirements are distributed, so when at least one in-scope
requirement is distributed, `applyRequirementTraceFragment` appends one bounded,
deterministic line naming the requirement ids and their seam names:

> Distributed requirements — cite one enforcement location **and** one matching test in
> **each** declared seam (a single location cannot satisfy them): `req-…` →
> `privileged-checkout`, `feature-defaults`, `secret-boundary`.

Caps: at most `MAX_DISTRIBUTED_HINTS = 20` requirements, in the order the ledger yields
in-scope entries; seam names truncated to `MAX_GROUP_NAME_CHARS` and
control-character-stripped. Overflowed requirements are omitted from the hint block (their
topology cannot be represented, so asking the model to cover it is pointless) and surfaced
as warnings instead. When nothing is distributed the assembled prompt is byte-identical to
today's.

### Repair pass

`runRequirementTraceRepairPass` (#959) re-asks for in-scope ids that arrived with no
claim. Its system prompt currently hardcodes the narrow `met` definition, so a repaired
distributed requirement would be mis-instructed and land `unverifiable` again. The repair
pass therefore:

- appends the **same bounded seam-name block** to its user message, and
- gains one sentence in its system prompt: a `met` claim for a requirement listed as
  distributed must cite one enforcement location **and one matching test** in each named
  seam.

Repair eligibility is unchanged (missing ids only); a repaired claim is validated by the
same distributed rule.

## Fail-soft vs fail-closed

| Condition | Behavior | Why |
|---|---|---|
| Model cites no location for a required group | `unverifiable`, incomplete | fail-closed on evidence |
| Model cites a malformed / non-existent / non-matching location | `unverifiable`, incomplete | fail-closed on evidence |
| Model cites many irrelevant locations | unchanged (still `unverifiable`) | coverage is glob-matched + injective; volume ignored |
| A group declares no test globs | `unverifiable`, incomplete, warn | test evidence must anchor to a trusted seam |
| Effective topology exceeds `MAX_GROUPS_PER_RULE` | `unverifiable`, incomplete, warn | never validate a truncated proof |
| Model payload carries a `groups` field | ignored entirely | model never declares topology |
| Model supplies a `symbol` on a distributed row | ignored for the predicate term set | model cannot invent the term it must match |
| Narrow requirement, no distributed rule | existing behavior unchanged | do not make everything distributed |
| Base config `groups` block malformed (<2 valid groups) | drop groups, keep rule as plain ownership, warn | **fail-soft on trusted base config** — see below |
| Declared groups exceed the parse safety bound | drop excess + warn; validator still fails closed | bound parser work without changing the outcome |
| Base config unreadable / unresolvable ref | no ownership rules, warn (existing) | consistent with #958 |

The malformed-config row is a deliberate, bounded exception to fail-closed. It is
reachable only by a maintainer editing the base-ref config — never by a PR contributor,
whose branch copy is not read. It matches the config layer's existing contract ("invalid
metadata is dropped with a warning and can never broaden scope or crash the review"), and
it never *broadens* what a model can claim: it only reverts that requirement to the
narrow proof, which still requires a valid enforcement location, a valid test location and
a predicate. Note the asymmetry with the two rows above it: a *missing test glob* and a
*topology overflow* are both valid config that declares an unrepresentable or unanchored
proof, so they fail closed; only structurally malformed config degrades.

## Anti-abuse properties

1. **No self-authorization.** Distributed-ness comes only from base-ref config; a model
   payload cannot promote a requirement to distributed.
2. **No volume attack.** Coverage is an injective glob match against trusted surfaces; N
   extra citations that miss every group glob change nothing.
3. **No single-location shortcut.** Injective coverage means one citation cannot cover two
   groups, even if globs overlap — so ≥2 groups can never be satisfied by one location.
4. **No unanchored test.** Every group's test evidence must match a trusted `tests` glob,
   so a generic or unrelated test file cannot satisfy a distributed requirement.
5. **No truncated proof.** Topology overflow fails closed rather than validating the
   representable subset.
6. **No predicate laundering by invention.** The distributed predicate term set excludes
   the model-supplied `symbol`. Cross-seam propping (a value-copying seam A propped up by a
   predicate-shaped seam B) remains possible in principle, but only *within
   maintainer-declared files*, and unlike narrow mode every citation must at least land
   inside a declared seam.
7. **Bounded.** Groups ≤ 4 representable (16 parse safety bound), names ≤ 60 chars,
   citations ≤ 5/list, notes bounded by the group cap, rendered seam names capped and
   stripped, prompt hints ≤ 20 requirements.

## Rejected alternatives

- **Model-declared groups.** Rejected: the model could declare any invariant "distributed"
  and satisfy it by citation volume — exactly the failure mode the issue names.
- **Inferring groups from changed files.** Rejected: the same lexical ambiguity #958 solved
  by declaration; a diff touching an unrelated file that shares a word would silently
  redefine the seams.
- **Optional per-group `tests`.** Rejected: it let a distributed requirement reach `met`
  with an unrelated generic test file, which is the "meaningful enforcement/test
  correspondence" failure the issue names. `tests` is required in effect.
- **Warning-only topology overflow.** Rejected: a warning does not make a truncated proof
  safe; overflow forces incomplete.
- **Requiring every seam to independently pass the predicate heuristic.** Rejected: the
  predicate check is a documented bounded heuristic that can miss declarative surfaces
  (workflow YAML, config) and helper-mediated enforcement; demanding it per seam would
  reintroduce false `unverifiable` rows. Group coverage (trusted) carries the anti-dumping
  property; the predicate carries anti-copy.
- **Raising `MAX_TRACE_LOCATIONS`.** Rejected: it would grow every artifact for a minority
  case; overflow failing closed is the bounded, honest answer.

## Regression fixtures (#962)

Positive (must be `met` under a distributed declaration, every group declaring both an
enforcement and a test surface):

1. **Fork privilege separation** — groups `privileged-checkout`, `feature-defaults`,
   `secret-boundary`; three distinct enforcement citations covering the three seams (at
   least one predicate-shaped) **and** three distinct test citations matching each group's
   `tests` globs.
2. **Untrusted content is data** — groups `redaction`, `fence-safe-rendering`,
   `instruction-separation`; `src/context/redact.ts` covers only `redaction`, the other
   seams are cited separately, and each seam's test glob is satisfied by a distinct test.

Negative (must stay `unverifiable`):

3. **`gateForkForForks()` alone** for the whole fork-privilege standard — one citation, so
   every group but one is uncovered ⇒ `distributed-enforcement-group-uncovered:*`,
   incomplete.
4. **`src/context/redact.ts` alone** for untrusted-content — same.
5. **Citation dumping** — many valid locations that match no declared group glob.
6. **Predicate laundering across seams** — every group matched by a value-copying line,
   with one predicate-shaped citation that matches **no** group glob ⇒ predicate check
   fails ⇒ `unverifiable`.
7. **Symbol injection** — every group matched by a value-copying line, `symbol` chosen to
   appear on one of them ⇒ predicate still fails (symbol excluded for distributed).
8. **Injective coverage** — two groups with overlapping globs and a single matching
   citation ⇒ second group uncovered.
9. **Test-seam miss** — enforcement fully covered, but a group's declared `tests` glob is
   matched by no test-path citation ⇒ `distributed-test-group-uncovered:<name>`.
10. **Group with no test globs** — every enforcement seam covered, but one group declares
    no `tests` ⇒ that group is test-uncovered and the row is `unverifiable` (this is the
    #981 blocker-1 regression).
11. **Topology overflow** — trusted config declares more than `MAX_GROUPS_PER_RULE` seams
    (per rule or via a multi-rule union) while the model cites a full matching set ⇒ the
    row is `unverifiable` with `distributed-topology-overflow` (the #981 blocker-2
    regression).
12. **Malformed groups block** — `<2` valid groups ⇒ rule degrades to narrow, warn, no
    distributed obligation.
13. **Distributed `met` emits none of the narrow downgrade notes.**

Narrow control (unchanged):

14. **source/head identity** — single enforcement + single test still validates.

Existing #935/#957/#958 scope regressions must remain green.
