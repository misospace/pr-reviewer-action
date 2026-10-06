# Distributed requirement proof (#962)

Status: **pinned proof contract (v1)** — implemented by `src/enforcement/requirement-trace.ts`,
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
      - name: feature-defaults
        owners:
          - src/config/repository-config.ts
      - name: secret-boundary
        owners:
          - src/publish/publish.ts
        tests:                       # optional per group
          - tests-v3/publish.test.ts
```

| Field | Required | Meaning |
|---|---|---|
| `<slug>.owners` | yes (existing) | Narrow globs that put the requirement **in scope** when changed (#958). Unchanged. |
| `<slug>.groups` | no | Presence (with ≥2 valid groups) makes the requirement **distributed**. |
| `groups[].name` | yes | Lowercase hyphenated slug. Diagnostics + fixture assertions only. |
| `groups[].owners` | yes, ≥1 | Enforcement surface of the seam. Same `isValidOwnerPattern` narrow-glob validation as top-level owners. |
| `groups[].tests` | no, 0+ | Test-path globs for the seam. A key that is absent, an empty list, or a list that yields zero valid globs declares **no per-seam test obligation** (the requirement's global test obligation still applies). A key that was present but produced no valid globs emits a warning. |

### Glob match semantics

A group glob matches a citation exactly as #958 ownership does: the glob is compiled to
an **anchored full-path regex** (`^…$`, `*`/`?` within a segment only) via the same
`ownerPatternRegex`, and the cited file path is **lowercased** before matching. Substring
matching is not used.

### Caps and validation

- `MAX_GROUPS_PER_RULE = MAX_TRACE_LOCATIONS - 1` (= 4). Groups ≤ 4 so the existing
  per-list citation cap (`MAX_TRACE_LOCATIONS = 5`) can always cover every seam without
  raising the citation bound.
- `MAX_GROUP_NAME_CHARS = 60`; `MIN_DISTRIBUTED_GROUPS = 2`.
- `groups[].owners` / `groups[].tests` reuse `isValidOwnerPattern` and the existing
  `MAX_OWNERS_PER_RULE` per-list cap.
- Group names must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Duplicate group names across rules merge (owners/tests unioned).
- Two groups in the same rule sharing an **identical owner glob** emit a warning (a
  config smell: that seam cannot be independently proven; see "Injective coverage").
- A rule whose `groups` block is present but yields **fewer than 2 valid groups** is
  dropped from the distributed set and retained as a plain ownership rule, with a
  warning. See "Fail-soft vs fail-closed".
- A rule with `groups` but no valid top-level `owners` is dropped entirely (existing
  rule: no owners ⇒ no rule).

## Determining distributed-ness

A requirement is **distributed** iff at least one ownership rule whose `match` tokens all
appear (case-insensitively, as whole words) in the requirement text declares ≥2 valid
groups. The **required groups** are the union over all matching rules, merged by name
(owners unioned, tests unioned), sorted by name for determinism, capped at
`MAX_GROUPS_PER_RULE`.

If the union would exceed the cap, the excess groups (after the name sort) are dropped
**and a warning naming the dropped groups is emitted through the ownership-warnings
channel**. Truncation weakens the proof (fewer seams required) in a way the maintainer
cannot see from the diff alone, so it must be loud; the warning is the mitigation. In
practice the cap is only reachable when several distributed rules match one requirement
text, which is itself a config smell.

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

The distributed note vocabulary is **exactly** these three, and nothing else — no
positional-index or aggregate-duplicate notes:

- `distributed-enforcement-group-uncovered:<name>` — one per unmatched enforcement group.
- `distributed-test-group-uncovered:<name>` — one per unmatched group that declared test globs.
- `distributed-test-location-uncovered` — the row has no test-path-valid citation at all
  (the global test obligation), independent of any per-group glob.

1. **Enforcement seam coverage (injective).** Every required group is assigned a
   **distinct** `enforcement` citation that is location-valid and whose file matches one
   of that group's `owners` globs. Assignment is a **maximum bipartite matching** between
   required groups and valid citations (augmenting-path; bounded by 4 groups × 5
   citations), so the row passes only when *every* group can be given its own seam
   location. Any unmatched group downgrades the row to `unverifiable` with a note
   `distributed-enforcement-group-uncovered:<name>` (one note per unmatched group,
   bounded by the group cap). A claim with **no** valid enforcement citation emits that
   note for every required group.
2. **Test coverage.** At least one `test` citation is test-path-valid (`isTestPath`
   **and** location-valid), **and** every group that declares `tests` globs is assigned a
   **distinct** test-path-valid citation matching one of its test globs (same maximum
   bipartite matching). A miss downgrades with `distributed-test-group-uncovered:<name>`.
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

Seam names are base-ref-trusted slugs, still length-capped at `MAX_GROUP_NAME_CHARS` and
control-character-stripped before rendering. Total rendered seam names are bounded by the
group cap.

## Prompt awareness

The model cannot infer which requirements are distributed, so when at least one in-scope
requirement is distributed, `applyRequirementTraceFragment` appends one bounded,
deterministic line naming the requirement ids and their seam names:

> Distributed requirements — cite one enforcement location in **each** declared seam
> (a single location cannot satisfy them): `req-…` → `privileged-checkout`,
> `feature-defaults`, `secret-boundary`.

Caps: at most `MAX_DISTRIBUTED_HINTS = 20` requirements, in the order the ledger yields
in-scope entries; seam names truncated to `MAX_GROUP_NAME_CHARS` and
control-character-stripped. When nothing is distributed the assembled prompt is
byte-identical to today's.

### Repair pass

`runRequirementTraceRepairPass` (#959) re-asks for in-scope ids that arrived with no
claim. Its system prompt currently hardcodes the narrow `met` definition, so a repaired
distributed requirement would be mis-instructed and land `unverifiable` again. The repair
pass therefore:

- appends the **same bounded seam-name block** to its user message, and
- gains one sentence in its system prompt: a `met` claim for a requirement listed as
  distributed must cite one enforcement location in each named seam.

Repair eligibility is unchanged (missing ids only); a repaired claim is validated by the
same distributed rule.

## Fail-soft vs fail-closed

| Condition | Behavior | Why |
|---|---|---|
| Model cites no location for a required group | `unverifiable`, incomplete | fail-closed on evidence |
| Model cites a malformed / non-existent / non-matching location | `unverifiable`, incomplete | fail-closed on evidence |
| Model cites many irrelevant locations | unchanged (still `unverifiable`) | coverage is glob-matched + injective; volume ignored |
| Model payload carries a `groups` field | ignored entirely | model never declares topology |
| Model supplies a `symbol` on a distributed row | ignored for the predicate term set | model cannot invent the term it must match |
| Narrow requirement, no distributed rule | existing behavior unchanged | do not make everything distributed |
| Base config `groups` block malformed (<2 valid groups) | drop groups, keep rule as plain ownership, warn | **fail-soft on trusted base config** — see below |
| Union of matching rules' groups exceeds the cap | truncate + warn naming dropped groups | loud, bounded, maintainer-visible |
| Base config unreadable / unresolvable ref | no ownership rules, warn (existing) | consistent with #958 |

The malformed-config row is a deliberate, bounded exception to fail-closed. It is
reachable only by a maintainer editing the base-ref config — never by a PR contributor,
whose branch copy is not read. It matches the config layer's existing contract ("invalid
metadata is dropped with a warning and can never broaden scope or crash the review"), and
it never *broadens* what a model can claim: it only reverts that requirement to the
narrow proof, which still requires a valid enforcement location, a valid test location and
a predicate.

## Anti-abuse properties

1. **No self-authorization.** Distributed-ness comes only from base-ref config; a model
   payload cannot promote a requirement to distributed.
2. **No volume attack.** Coverage is an injective glob match against trusted surfaces; N
   extra citations that miss every group glob change nothing.
3. **No single-location shortcut.** Injective coverage means one citation cannot cover two
   groups, even if globs overlap — so ≥2 groups can never be satisfied by one location.
4. **No predicate laundering by invention.** The distributed predicate term set excludes
   the model-supplied `symbol`, so a model cannot satisfy the anti-copy check with a term
   it chose. Cross-seam propping (a value-copying seam A propped up by a predicate-shaped
   seam B) remains possible in principle, but only *within maintainer-declared files*, and
   unlike narrow mode every citation must at least land inside a declared seam.
5. **Bounded.** Groups ≤ 4, names ≤ 60 chars, citations ≤ 5/list, notes bounded by the
   group cap, rendered seam names capped and stripped, prompt hints ≤ 20 requirements.

## Rejected alternatives

- **Model-declared groups.** Rejected: the model could declare any invariant "distributed"
  and satisfy it by citation volume — exactly the failure mode the issue names.
- **Inferring groups from changed files.** Rejected: the same lexical ambiguity #958 solved
  by declaration; a diff touching an unrelated file that shares a word would silently
  redefine the seams.
- **Requiring every seam to independently pass the predicate heuristic.** Rejected: the
  predicate check is a documented bounded heuristic that can miss declarative surfaces
  (workflow YAML, config) and helper-mediated enforcement; demanding it per seam would
  reintroduce false `unverifiable` rows. Group coverage (trusted) carries the anti-dumping
  property; the predicate carries anti-copy.
- **Raising `MAX_TRACE_LOCATIONS`.** Rejected: groups are capped at 4 so the existing
  citation bound suffices; raising it would grow every artifact for a minority case.

## Regression fixtures (#962)

Positive (must be `met` under a distributed declaration):

1. **Fork privilege separation** — groups `privileged-checkout`, `feature-defaults`,
   `secret-boundary`; three distinct citations covering the three seams, at least one
   predicate-shaped, plus a test-path citation; a group-declared test glob is satisfied.
2. **Untrusted content is data** — groups `redaction`, `fence-safe-rendering`,
   `instruction-separation`; `src/context/redact.ts` covers only `redaction`, the other
   seams are cited separately.

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
9. **Test-seam miss** — enforcement fully covered, but a group's declared test glob is not
   matched by any test-path citation ⇒ `distributed-test-group-uncovered:<name>`.
10. **Malformed groups block** — `<2` valid groups ⇒ rule degrades to narrow, warn, no
    distributed obligation.

Narrow control (unchanged):

11. **source/head identity** — single enforcement + single test still validates.

Existing #935/#957/#958 scope regressions must remain green.
