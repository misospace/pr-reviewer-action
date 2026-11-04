# Independent merge-safety verifier — advisory dogfood evidence and go/no-go (#1452)

- **Date:** 2026-11-03 (evidence window 2026-10-20 → 2026-11-03)
- **Source issue:** [#1452](https://github.com/misospace/pr-reviewer-action/issues/1452) — collect and adjudicate ordinary live dogfood evidence for the independent merge-safety verifier (#1073/#1369) and decide whether it earns gate authority in trusted approval (#1075, umbrella #1447, qualification #1450).
- **Evidence file:** `evals/reports/confidence-dogfood/evidence-2026-11-03.json` (`confidence-dogfood-evidence/v1`) — one bounded, URL-redacted record per verifier-enabled run: head/base/config/action pins, primary verdict state, verifier status/cause/latency/score/risk/model/concerns, and per record what the published evidence does not carry.
- **Method:** read-only sweep of every published bot review body in `misospace/pr-reviewer-action` (GraphQL), extracting the `ai-pr-reviewer:` metadata marker, the `ai-pr-review-fingerprint` marker, and the `## Independent Confidence` block. 419 marker-bearing runs carry `confidence_status` (the verifier enabled and ran); 218 older runs predate the field and are excluded. This mirrors the collector PR #1454 adds (`scripts/confidence_dogfood_evidence.py`); that collector supersedes the sweep method for ongoing runs.
- **What the verifier publishes (code-grounded):** the marker fields (`confidence_status`, `confidence_cause`, `confidence_latency_ms`, `confidence_score`) plus a rendered block of exactly one head line, one reason line, and at most 8 "Advisory concern" bullets (`src/publish/publish.ts:477-541`). `unscored` publishes an empty score, `risk: unknown`, and no reason (`src/confidence/result.ts:652-653`); `disabled` renders no section at all (`src/publish/publish.ts:461-466`). Everything else visible under the `## Independent Confidence` heading in a review body (recommendation prose, claims, requirement traces) belongs to the primary review body, not the verifier.

## Headline numbers

| Metric | Value |
| --- | --- |
| Verifier-enabled runs in window | 419 across 166 PRs (2026-10-20 → 2026-11-03) |
| Scored runs | **1** (PR #1175, 2026-10-20, 3/5 low, model `glm-5.3-flash`) — 0.24% of runs, 0.6% of PRs |
| Unscored runs | **418** (99.76%) |
| Unscored causes published | 2/418 (both `http_403`, both 2026-11-03, the first runs on heads carrying #1457's cause publication); 416 permanently unmeasurable |
| Verifier concern bullets published in the whole window | 2 (the single scored run) |
| Scored runs coinciding with a clean primary approval | 0 (46 PRs' latest runs were `clean` approvals; 0 scored among them) |
| Live true catches | 0 |
| Live false challenges | 0 |
| Adjudicated known-miss PRs in the window where the verifier published nothing | 5 (#1438, #1435, #1443, #1446, #1453) |
| Verifier model on enabled runs | `Minimax-M3.1-flash` 400 (same family as the primary route), `glm-5.3-flash` 3, unset 16 — 15 review bodies carry no `ai-pr-review-sha` marker and 1 carries no model line; regenerated from published bodies, see `verifier_model_provenance` in the artifact |

## The six decision questions

**1. Does the verifier catch real primary misses at a useful rate?** No live catch is observed, and the honest statement is stronger than "0/n": the verifier produced a usable scored result on exactly one of 419 runs, and on every adjudicated known miss in the window (five PRs, below) it published nothing at all — no score, no reason, no concern. The only positive recall signal remains the production-shape canary (`evals/reports/confidence-canary/README.md`, 2026-11-01): on the retained corpus's one known false approval (`courier-46-61`) the verifier scored 3/5, risk medium, with a `missed_issue/major` concern — a true catch through the production request path. That is n=1, canary conditions (operator environment, retained artifacts), not ordinary dogfood.

**2. How often does it invent blocker/major concerns on clean approvals?** Never observed. Concern bullets were published once in the entire window (the PR #1175 scored run, on a `partial` primary review, two concerns — neither invented a blocker); the canary's clean control row published 0 concerns at 5/5 low. But the rate on clean approvals is formally undefined, not reassuring: zero scored runs coincided with any of the 46 clean-approval PRs.

**3. How often is it unscored, and why?** 418/419 (99.76%). Published causes exist only for the two runs whose heads carried #1457's publication change (both `http_403` — the model endpoint refused the verifier's request; `src/confidence/scorer.ts:69-73` maps transport failures to `http_<status>`; the full cause taxonomy is `missing_credential`, `credential_isolation`, `prompt_over_budget`, `http_<status>`, plus model-side fail-closed `cannot_verify`/malformed answers, `src/confidence/scorer.ts:189,196,215`, `src/confidence/result.ts:493-515`). The other 416 causes lived only in the run directory and died with the runner (the #1455 gap, closed today) — they are permanently unmeasurable. Corroborating context: the inherited MiniMax arm was unstable for the primary itself in the same window (the PR #1446 03:54 run published on `glm-5.3-flash — fallback (primary failed)`; PRs #1438/#1435 show `request-error`/budget stop reasons), and the declared dogfood profile (`dogfood-inherited`, canary README) gives the verifier the primary's endpoint, credential, and model family with no fallback.

**4. Does it catch the same composition/dataflow misses motivating #1447?** No. The canonical cross-path invariant — webhook intake and reconciliation must populate the same forge-integration identity before generation hashing — was live across PRs #1443/#1446 while the verifier published no usable result on any of their 7 combined runs (see adjudications 1–2). The one composition-adjacent catch in the window was made by the primary itself, on its glm fallback route (PR #1446, `tests-v3/controller-daemon.test.ts:902`, the converged-generation assertion still indirect).

**5. Are latency/token costs acceptable?** Yes, where a call completes. The canary's production-path reference: 21.3 s / 2 066 completion tokens (`courier-46-61`, the known false approval) and 17.2 s / 2 841 tokens (`pr-reviewer-action-133-clean`, the clean control) — ~38.5 s total wire time for both calls. Live, the only measured latency is a failed call (400 ms to the `http_403`); no live token-usage sample exists yet because usage publishes only on completed calls since #1457 and is absent when unmeasured. Cost is not the constraint; availability is.

**6. Is there an evidence-backed deterministic gate rule for #1075?** Only fail-closed components are evidence-backed; no score threshold is:

- **`unscored`/unavailable ⇒ error/fail closed** — vindicated: it is already #1075's contract, and a gate enabled over this window would have held 99.76% of runs red. That behavior is correct (never turn unscored into 0/5) and also means the gate is unusable until the unscored rate collapses.
- **Verifier model must differ from the primary model.** The dogfood profile inherits the primary's arm; the single live scored run's own advisory concern warned "same-model correlation acknowledged but not verified live" against `ai-confidence-model: vars.CONFIDENCE_MODEL \|\| vars.SMART_MODEL` (`.github/workflows/ai-pr-review.yaml:218`), and #1286's same-model arm returned 32/32 `malformed_answer`. Same-model verifier output is disqualified from gating.
- **Exact-head/config pin match** — already #1075's contract, and the only pin components this window can evidence: the artifact carries per-run head/config pins, while it records `rubric_version` as unavailable for every run in the window, so rubric-pin matching remains contract-backed, not evidence-backed.
- A numeric pass threshold (e.g. ≥4/5) has no evidence base: n=1 live scored run and n=2 canary rows cannot calibrate one, and #1286's no-ship calibration result stands.

## Material disagreement adjudications

Human/second-review findings in the window, adjudicated per #1452's classes. "Unscored" means the verifier published no result at all in every run of that PR (see evidence file).

| Where | Finding (who found it, when) | Dogfood primary did | Verifier did | Class |
| --- | --- | --- | --- | --- |
| PR #1443 | Cross-path composition blocker: webhook vs reconciliation forge-integration identity (author's adversarial pass, pre-merge; human re-review confirmed resolution 11-03 14:19) | Findings run held 1 minor (a comment nit at `src/jobs/generation.ts:47`); final run partial/incomplete, native approve | Unscored on all 3 runs | **True primary miss**; verifier: **known primary miss the verifier also missed** |
| PR #1446 | Reconciliation mint site does not prove it uses the daemon's identity (human CHANGES_REQUESTED 11-03 02:42; resolved `a0b8475`) | Early runs missed it; the glm-fallback run caught the adjacent regression-indirectness and tracked the human CR; final clean approve after fix | Unscored on all 4 runs | **True primary miss** (early runs) + primary later caught a **real-but-adjacent concern**; verifier: **known miss the verifier also missed** |
| PR #1453 | Derived pass is fed `pr.diff.truncated` preferentially, blinding the derived-falsification path (human CHANGES_REQUESTED 11-03 14:10; PR open) | partial/incomplete, native approve, "no blocker or major issues found" (11-03 07:43) | Unscored | **True primary miss** (unsafe-approval candidate — primary recommended approve); verifier: **known miss the verifier also missed** |
| PR #1438 | `forgeApiUrlProblem` accepts path-embedded credentials (human hard security blocker 11-02 19:47; refined 22:09) | Degraded runs (`request-error`, budget stops); never found it independently; verified the human-flagged fix (21:07) | Unscored on all 6 runs | **True primary miss** (independent discovery); primary contributed fix verification; verifier: **known miss the verifier also missed** |
| PR #1435 | Kubernetes-worker credential projection not wired (human hard blocker 11-02 22:05) | **Independently found the same class** — 3 majors including `deploy/charts/pr-reviewer/templates/worker-rbac.yaml:83` ("lacks the permissions needed for credential projection") — and issued CHANGES_REQUESTED | Unscored on all runs | **Already covered** (by the primary); verifier: no signal, no contribution |
| PR #1454 | Collector misreads native-review timestamps (human 2 hard blockers 11-03 14:29) | **Independently found the same major** (`scripts/confidence_dogfood_evidence.py:590`) + an unmet fork-isolation requirement; CHANGES_REQUESTED | Unscored | **Already covered** (by the primary); verifier: no signal |
| PR #1175 (the one scored run) | — | partial review, native approve | 3/5 low + 2 concerns: (a) same-model correlation unverified — **real-but-adjacent** (prescient: today's verifier arm IS the primary's family); (b) CI unobserved — **already covered** (the primary flagged it too) | No material challenge; no false challenge |
| Canary row `courier-46-61` (retained corpus, 11-01) | Known false approval in the retained corpus | (retained artifacts; no re-run) | Scored 3/5 medium, 1 `missed_issue/major` concern | **True catch** (canary conditions, n=1) |
| Canary row `pr-reviewer-action-133-clean` | Clean correct approval | (retained artifacts) | Scored 5/5 low, 0 concerns | **No false challenge** |

## Recommendation (go/no-go for #1075)

**Remain advisory. Do not proceed to gate design now. Do not remove the verifier from the trusted-approval critical path yet.**

- In ordinary dogfood the verifier currently contributes **zero measured recall**: 99.76% unscored, 0 live catches, 0 scored runs on the 46-PR clean-approval gate population, and no usable result on any of the five adjudicated known-miss PRs. A gate built on today's evidence would be a permanently red check — honest fail-closure, but trust theatre.
- It is **not** removed because the canary demonstrates the production path does catch a known false approval when a call completes (3/5 medium, `missed_issue/major`), it has published **zero false challenges** anywhere, and its cost when it completes is small (~20 s, ~2–3k completion tokens). The failure mode is availability plus same-arm inheritance, not wrongness.
- **Re-evaluation conditions** (each necessary before the gate question reopens):
  1. Give the verifier a distinct endpoint/credential/model from the primary — retire the `dogfood-inherited` same-arm shape.
  2. Re-observe a dogfood window on heads ≥ `ab603409` so every unscored run publishes its cause (#1457, merged 2026-11-03), and drive the unscored rate to a measured, explainable level.
  3. Re-collect and adjudicate with PR #1454's collector (`scripts/confidence_dogfood_evidence.py`) so per-run cause/latency/usage are retained by construction.
  4. Obtain scored coverage of #1450's qualification corpus — at minimum #1443/#1446/#1453-class composition rows, `courier-46-61`, and clean controls — before any score threshold is proposed. A threshold calibrated on n=1 live + n=2 canary would inherit #1286's no-ship result.
- The gate-rule components that ARE evidence-backed now and should carry into any future #1075 design unchanged: unscored ⇒ error/fail closed (never 0/5); verifier-model ≠ primary-model; exact-head/config/rubric pin match; high score never waives review-result/required-checks eligibility.

Linked: recorded on #1452 (adjudication comment); #1075 stays blocked; #1447/#1450 reference this report for the verifier prong of their metrics.

## Limitations

- 416 of 418 unscored causes are permanently unmeasurable (run-directory telemetry died with the runners; cause publication merged only today). This window can never explain its own unscored rate beyond the two `http_403` samples plus the primary-route instability corroboration.
- One live scored run and two canary rows bound everything rate-shaped: catch rate, false-challenge rate, and any threshold are formally undefined, not merely low.
- The verifier's rubric version, parser notes, and token usage are not published in the marker (run-directory only; usage publishes on completed calls since #1457 and was unmeasured on every live run to date) — each record's `unavailable` block in the evidence file says so explicitly.
- This adjudication reads published reviews only; the retained-corpus canary numbers are quoted from `evals/reports/confidence-canary/README.md` and were not re-run here.

## Retained attempt dataset (#1479)

The adjudication above reads one published body per pull request, so a later
review replaces the attempt it describes. The retained dataset
(`scripts/confidence_dogfood_dataset.py`) keeps every published attempt of every
pull request, and folds each collection into the dataset file in place.

- **Dataset file:** `evals/reports/confidence-dogfood/dataset-2026-11-04.json` (`verifier-dogfood-dataset/v1`), 480 retained attempts across 175 pull requests. 419 attempts are the imported #1459 baseline of 2026-11-03; 84 attempts come from a live read of the pull requests with the most recent traffic on 2026-11-04, of which 61 were new and 23 were the baseline attempts the live read re-observed.
- **Summary file:** `evals/reports/confidence-dogfood/summary-2026-11-04.json` (`verifier-dogfood-summary/v1`).
- **Reconciliation:** the baseline declared 419 enabled runs across 166 pull requests, and the import produced 419 records across 166 pull requests with no skipped record. The dataset holds the whole baseline.
- **Why the per-pull-request count matters:** 92 of the 175 pull requests carry more than one retained attempt, and the largest carries 50. Under the #1452 collector those earlier attempts were never visible.
- **What the newer attempts add:** the dataset now holds 30 published causes (`http_429` 10, `malformed_answer` 7, `http_403` 6, `cannot_verify` 4, `dedicated_config_missing` 3), 27 published latencies and 11 published token-usage records. The baseline file itself carries only 2 causes and no token usage, because that telemetry was not published before #1457.
- **What the dataset does NOT settle:** the baseline retained the concern count of each run but not the concern details, so the clean-versus-challenged question stays open for the 419 imported attempts. The summary reports them as not assessed rather than as clean.

Three known limits of the retained data:

- The published model name is spelled in two ways (`Minimax-M3.1-flash` and `MiniMax-M3.1-Flash`). The dataset counts them as the forge published them, so the model histogram in the summary shows both.
- A managed comment is rewritten in place, so only its newest body is observable. The dataset keys such an attempt on the comment's creation time and records the observation count. An edit of a body keeps the identity of that body, and it is never counted as a fresh attempt. A body republished on a new head is a different attempt, because the head pin is part of the identity.
- One pull request (#1287) published more attempts than the per-pull-request bound of 50 allows, so 19 of its older attempts are not in this dataset. The collection log names the pull request and the number. Raise `--max-attempts-per-pr` to fold them in.

Runbook and update cadence: `docs/evals.md`, section "Verifier dogfood attempt
dataset (#1479)". The adjudication of this evidence against the verifier's
authority belongs to #1450.
