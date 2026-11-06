# Negative-evidence calibration against the human-findings corpus — go/no-go (#1517, PR #1529)

- **Date:** 2026-11-06
- **Source:** [#1517](https://github.com/misospace/pr-reviewer-action/issues/1517) deterministic negative evidence, implemented by [PR #1529](https://github.com/misospace/pr-reviewer-action/pull/1529) at head `3be41d5e` (`courier/misospace/pr-reviewer-action/issue-1517`). This eval decides whether the operator should declare `negative_evidence` providers **broadly, narrowly, or not at all**.
- **Evidence file:** `evals/reports/negative-evidence/evidence-2026-11-06.json` (`negative-evidence-eval/v1`) — corpus pins, replay distributions, all five raw demotions with adjudications, empirical cleanliness checks, gate/parse stress results, flip accounting, limitations. Every number below is traceable to that file.
- **Corpus:** `evals/corpus-human-findings.json` — 74 adjudicated human/second-review defects across 65 PRs in 10 repos, pinned at the exact heads the production reviewer also reviewed. 54 major + 20 blocker (no minor/info). **Every corpus entry is a REAL defect, so any demotion of a corpus finding is by construction a wrong demotion** — the target is zero.

## Method

The branch was built in a worktree (typecheck clean; `tests-v3/negative-evidence.test.ts` 21/21; full suite 5456/5474 pass with 4 failures all in test files byte-identical to `origin/main` and macOS-sandbox-caused — `/proc`-based process probing and an ENAMETOOLONG on a deliberately over-long path; the two acquisition suites are excluded as sandbox-hangers per eval constraints). The eval then drove **the branch's own compiled code** — `deriveNegativeEvidenceRules` → `serializeNegativeEvidenceArtifact` → `negativeEvidenceRulesFromArtifact` → `applyNegativeEvidence` — over every corpus finding under two operator postures, with rules derived under an **assumed fully clean provider run at each finding's own head** (the maximally dangerous derivation state; checked empirically where it matters, see below). The corpus carries no model category labels, so each finding was probed against every declared category of the applicable rule — recorded demotions are an upper bound over category assignment.

- **Posture N (narrow):** per-language formatter/lint/schema trio, style-only categories, **`max_severity: minor`**, tool-natural paths.
- **Posture B (broad):** same trio, **all parse-legal categories, `max_severity: major`** (the parse-time maximum), repo-wide `**` paths.

The strict verdict mapping forces `request_changes` only when an open finding is blocker or major (`src/enforcement/verdict-policy.ts`), so only a major→minor demotion can flip a verdict; blockers are never demoted (independent hard cap) and minor→info cannot flip.

## Headline numbers

| Metric | Posture N (narrow) | Posture B (broad) |
| --- | --- | --- |
| Raw demotions over 74 real defects | **0** | **5** |
| Wrong demotions after adjudication (target 0) | **0** | **4** |
| Protected by the derivation gate (provider cannot run clean) | — | 1 |
| Claim-shape gate saves (category+severity+path agreed, claim shape refused) | 0 | 47 |
| Blocker-refusal records (matched, capped, recorded) | 1 | 1 |
| Verdict flips in published reviews | 0 | 0 |

Additional stress results (all in the evidence file):

- **Real model prose, flag-same heads:** for the 12 corpus PRs where the production bot flagged the same defect (`flag_same` true/partial), the bot's actual published review at the exact corpus head was fetched for 11 of 12 (1 has no marker-bearing review) and split into 130 finding-shaped chunks. **Zero** formatter cues, **zero** schema cues, **zero** provider-identity mentions — no real published finding in that set is demote-shaped.
- **Parse-time refusals:** 8/8 hostile declaration shapes refused (security category, blocker ceiling, `../` traversal, absolute path, backslash path, unknown key, `requirements` category, unknown domain), control parses — using real corpus path material.
- **Identity-hole probe:** the parser accepts any ≤128-char token as a lint `identity`; identity `the` passes **71/74** real finding texts, `code` passes 4, `lint` 0. A mis-declared identity silently voids the identity gate.
- **Empirical cleanliness at candidate heads:** `yamllint` (the CI invocation) is **clean** at PR #467's exact head and the externalsecret.yaml at home-ops#5853's head **parses cleanly** — both derivations fire in reality (see adjudications). No Go/prisma/actionlint toolchain exists in the sandbox; those three candidates were adjudicated from the defect texts.

## The four wrong demotions (broad posture)

| Finding (real defect) | Demoting rule / gate | Why it is wrong |
| --- | --- | --- |
| pr-reviewer-action#467 (major, `.github/workflows/ci.yaml`) | `yamllint` lint / **identity mention** | The defect is "the PR deletes the entire test suite under the guise of add-shellcheck-to-CI"; the text names `yamllint` because the regression *removes its coverage*. The lint gate reads that as a lint-violation claim. yamllint empirically clean at the head → rule derives. Bot was APPROVED — **sole-major masking shape**. |
| dispatch#82 (major, `prisma/schema.prisma`) | `prisma-validate` schema / schema cue ("Schema migration") | The defect is a missing migration — semantic. `prisma validate` checks schema-file validity, which holds, so the provider runs clean while the real defect stands. |
| courier#108 (major, `internal/executor/mcp_status.go`) | `gofmt` formatter / formatter cue ("whitespace", "indented") | The words describe the *protocol shape* ("continuation lines start with a box-drawing character rather than whitespace, so the reason line isn't treated as indented"), not a formatting claim. A formatter says nothing about the parser bug and runs clean. Bot was APPROVED — **sole-major masking shape**. |
| home-ops#5853 (major, `…/openclaw/externalsecret.yaml`) | `kubeconform` schema / schema cue ("$schema") | The file **parses cleanly** at the exact head (empirical); a CRD-skipping schema tool is clean on exactly the file that is broken, and the cue fires on the literal token `$schema`. |

The fifth raw demotion (llmkube-images#237, "the workflow is not valid") is **refused by derivation under a competent declaration**: the tool whose domain covers `.github/workflows` (actionlint) cannot exit 0 at that head — GitHub itself rejected the workflow (quoted in the corpus). It demotes only under the incompetent shape "schema tool declared over paths it does not validate" (`kubeconform` over `**`), which yields vacuously-clean evidence.

What worked, quantified: the claim-shape gate refused **47** finding-rule pairs that had already passed category+severity+path — the load-bearing protection (the corpus's semantic findings in formatter-covered files never carry a pure-formatting claim). The blocker cap recorded its one match (`alert-triage#153`, "normalizes whitespace") as a refusal under both postures. The no-op guarantee held: without a declaration, no rule derives and behavior is byte-identical.

## Decision: declare narrowly — or not at all; never broadly

1. **Broad enable is REJECTED**: 4 real adjudicated defects demoted against a target of zero, two of them on approved-PR sole-major masking shapes.
2. **Narrow enable (zero wrong demotions on this corpus) requires an explicit `max_severity: minor`** — and this is the trap: `parseNegativeEvidenceSpec` **silently defaults an omitted `max_severity` to `major`** (`src/evidence/providers.ts`), the unsafe end of the axis on this corpus (all 74 findings are major/blocker, so a major ceiling is what admits them). A declaration that omits the field gets the dangerous posture by default.
3. **Categories**: style-only for formatters (style+docs linters, style+other schema). The corpus cannot vouch for `bug`/`verification` declarations: it contains no minor/info findings, so the categories axis is uncalibrated — all four genuine wrong demotions needed a non-style category under worst-case assignment.
4. **Never declare an identity token that is a prose word** (`the` passes 71/74 real texts), and never declare a provider over paths it does not actually validate (the vacuous-clean shape).
5. **Before any broadening**, three feature asks on #1529/#1517: (a) a findings-about-the-tool guard — the lint identity gate must not fire when the message describes *removing/altering* the tool's coverage (#467's shape); (b) cue hygiene — the formatter/schema cue regexes should not fire on incidental vocabulary (#108's "whitespace", #5853's "$schema", #82's "Schema migration"); (c) an adjudicated noise corpus so recall (how much real formatter/lint noise a broad enable suppresses) can be measured — this corpus is one-sided by construction and cannot.

Not-at-all remains a defensible answer: the capability is inert without a declaration, and the narrow posture's zero comes from one field (`max_severity: minor`) that defaults wrong when omitted.

## Limitations

- One-sided corpus: measures the wrong-demotion axis decisively; cannot measure recall (noise suppressed). No adjudicated noise corpus exists yet.
- All 74 severities are major/blocker: the categories axis is uncalibrated, and the replay's category probes are worst-case, not model labels.
- The demotion replay substitutes the adjudicated human text for the (nonexistent) model finding message; the flag-same heads' **actual** published bot prose was tested separately (0/130 gate passes) but is v2-era long-form — v3-era terse findings are less sampled there.
- Empirical cleanliness was machine-verified only where a tool exists in the sandbox (yamllint); gofmt-clean and prisma-validate-clean are plausible-but-unverified textual adjudications.
- The assumed-clean counterfactual is the maximally dangerous state; live exposure is smaller because the derivation gate refuses exactly the runs where the tool would have caught the claimed defect (llmkube-images#237).

Linked: PR #1529 (summary comment), issue #1517. Recorded 2026-11-06.
