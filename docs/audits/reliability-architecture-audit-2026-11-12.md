# Reliability Architecture Audit — #1636

**Date:** 2026-11-12 · **Baseline:** `main` at `ec3c52cb` plus the four open PRs cited below · **Method:** code and contract survey only — no model runs, no pipeline changes, no organic-data claims (the issue forbids claiming improvement before organic data supports it). Companion audits: [`configuration-and-simplification-audit.md`](configuration-and-simplification-audit.md) (2026-10-24, uncommitted), [`v3-security-trust-boundaries.md`](v3-security-trust-boundaries.md) (2026-10-24, uncommitted).

**The question this audit answers (#1636):** whether any reliability architecture is actually still missing, measured against the issue's four required contract changes (A applicability before evidence demand, B evidence objects and relevance, C risk-driven investigation, D one final post-validation publication state) and its five-item work order.

## Verdict

**No whole missing stage is evident.** Every architecture-level seam the issue demanded exists and is enforced in deterministic code as of this baseline. What remains is (1) one deliberate contract TENSION between the merged direction of #1636 §B and the check-specific one-to-one citation allocation #1637/#1634 shipped — a human decision, not an implementation gap; (2) two staleness seams of the #1645 class (human-review settlement; the #1630-class partial-review residuals that are now measurable rather than fixable blind); (3) small bookkeeping gaps that do not affect review trust. The residual risk is concentrated where the issue said it would be: the semantic layer, which only organic exact-head evidence (#1602's harvester) can adjudicate.

## Work order ledger (issue §"Work order / ownership")

| # | Item | Status at baseline | Evidence |
| --- | --- | --- | --- |
| 1 | #1596 single post-validation publication state | **MERGED** | `9ac54618` (PR #1639): the published recommendation, machine handoff, native event and marker derive from one validated machine disposition; the model suggestion is retained nonauthoritative |
| 2 | #1627 / PR #1634 evidence-to-disposition contract | **OPEN, in review** | round-6 fix pushed (`ee222a8`): check-specific citation identity matching, atomic version extraction, fail-closed malformed traces, one-to-one allocation — see finding F1 below |
| 3 | #1600 applicability before evidence demand | **MERGED** | `4e366227` (PR #1619): standards requirements scope by affected boundary, not quoted vocabulary; incidental vocabulary overlap alone cannot scope a broad security requirement |
| 4 | #1577 risk-based counterexample investigation | **MERGED** | `f4eca97e` (PR #1637): deterministic risk-obligation scan (one obligation per affected category — file identity/path mode, bounded state/concurrency, persisted state, credential/security boundary) gates clean reviews with evidence receipts; no arbitrary counts |
| 5 | #1602 denominator-aware harvester | **MERGED, issue closed** | `2903b8c4` (PR #1611): exact-head organic review-completion metrics harvested from published attestations, segmented by deployed version — no model reruns |

Merged in the same window and load-bearing for this contract: #1612 (`e04a546d` — head-bound CI evidence reconciles test-run asks in both enforcement folds), #1595/#1618 (provably low-risk lockfile scoping), #1145/#1566 (trace-repair liveness — the #1630-class "bogus partials into complete reviews" machinery), #1625/#1630 (self-hosted parity + forge-read credential mint), #1631 (shared-claim permission modes), #1646 (CSP).

## Contract clause survey

### A. Applicability before evidence demand — **shipped, one partial**

- Standards rules: shipped by #1619 — the affected-boundary scoping keeps fail-closed treatment for genuinely applicable high-risk security/authorization boundaries and does not exempt Markdown/YAML wholesale (the scoping keys on the boundary the change actually touches).
- Reason-coded scope decisions: the obligation fold's closed reason vocabulary (`no-disposition`, `unrelated-executed-call`, `citation-already-used`, …) plus #1629's envelope receipt give bounded machine reasons for in-scope/out-of-scope and investigate/stop decisions.
- **Partial (finding F2):** the *linked-issue flag* path (`linked_security_issue`, `linked_priority_p0/p1`, `dependency_security_sensitive` → `FLAG_CHECKS` in `src/classification/classify.ts`) still derives mandatory `must_check` rows from the linked issue's LABELS alone. The issue's §A demands "an explicit linked-issue acceptance criterion or a meaningful affected-boundary connection for mandatory obligations." A label is human intent, which leans explicit — but the row text never carries the issue's acceptance criteria, and no boundary check filters it. The corpus presents the linked issue's body, so the model sees the criteria; the enforced ROW does not. Narrow follow-up: derive flag rows with the criterion attached, or scope them by the boundary the change touches.

### B. Evidence objects and relevance — **shipped, one deliberate tension**

- Mechanical provenance validation: #1634's citation gate binds every `satisfied` `must_check` answer to executed, successful repository/forge read calls whose bounded targets carry EVERY identity token the check names (exact identities, kind-specific boundaries — versions atomic per the round-6 fix, head shas, slugs, paths); unrelated successful calls fail closed as `unrelated-executed-call`; suite/CI asks reconcile only through the #1612 head-bound matcher; absence asks are never citable. Both folds and the publish-side recompute share one allocator, so agreement holds by construction.
- Reason-coded receipts + fail-closed malformed traces: shipped (#1634), exactly as the issue's coordination note demands retained.
- Invalid provenance is never repaired by prose: shipped — the disposition parser drops unusable entries with reasons; the folds recompute deterministically (#1596 makes the published state agree).
- **Finding F1 — the one-to-one tension.** #1636 §B: "A single genuine evidence item may support multiple independent conclusions; **one-to-one tool-call allocation is not a sound proof rule**." The shipped allocator (`allocateCallCitations`, `src/enforcement/executed-calls.ts`) is deliberately one-call-per-row: a second row citing the same genuine evidence gets `citation-already-used` and stays unresolved. This is STRICTER than the contract — it errs in the false-negative direction (withheld approvals, revision cycles), never false-approves — and it was the human review's fix for the original any-call-discharges-everything failure. The two requirements genuinely conflict: per-row uniqueness is the anti-false-discharge rail; multi-check sharing is the anti-false-negative rule. **This needs a human decision, not an autonomous change:** either (a) keep one-to-one and accept the false-negative cost (status quo; defensible while organic data shows false-partial rates), or (b) let one executed call back multiple rows when the identity reconciliation proves each row's OWN required tokens against that call (identity-proof replaces uniqueness as the rail). The deterministic layer cannot pick between them because the choice is about which error the product prefers to make.
- What "evidence objects" adds that is still missing: nothing structural — the executed-call index, the CI evidence line, the risk-evidence receipts, and the obligation receipts together are the objective-provenance layer the issue described. The evidence-loop failover (#1585/#1598) closes the #1563 root cause (fallback now runs the same evidence loop on the same budget instead of failing over the verdict alone).

### C. Risk-driven investigation, not proof choreography — **shipped**

- #1637's risk scan raises one obligation per affected category — not a counterexample quota, not universal checklist rows (§C's explicit prohibition respected).
- Objective coverage from actual observed reads (#921/#930/#1338 partial-coverage machinery; corpus-diff credit is assembler-certified, not self-declared).
- Material unknowns withhold clean approval (strict mapping + #1016 grounding demotions + #1517 negative evidence).
- The investigation budget is risk-shaped, not choreographed: #1629's envelope (PR #1648) caps spend only on positive proof of the low-risk shape and never on PR-title/extension heuristics; the required-evidence window reserves the tail for the specific missing obligations first, then the run abstains — §C's "use the remaining bounded budget for the specific missing obligations" is the existing #1379/#1396 reservation.

### D. One final, post-validation publication state — **shipped**

- One actionable disposition: #1596/#1639 — the recommendation, handoff, native event and marker all read the same final validated machine state; a model "Approve" can no longer survive as an actionable lead over a native COMMENT/REQUEST_CHANGES.
- Stale "fixed" narratives: #1636's own complaint case (#1612 review) is covered by #1645 (PR #1651) on the THREAD seam — a carried prior blocker now needs live reconciliation; resolved/absent/unknown carried threads cannot force REQUEST_CHANGES, with bounded receipts proving which. See F3 for the human-review sibling.
- Trusted attestation: `review-bundle/v1` (#1425) is the exact-head, bounded-by-construction contract; #1631/#1630 closed the self-hosted credential/permission gaps that would have made it untrustable in production.

## Findings (all bounded; none is a whole missing stage)

**F1 — the one-to-one allocation tension (decision needed, human-owned).** Detailed under §B. The governing question for Jory: does the product prefer withheld approvals (current) over shared genuine evidence (the #1636 §B rule)? If (b) is chosen, the change is confined to `allocateCallCitations`' `used`-set semantics plus BOTH-fold parity tests — the identity reconciliation (round-6 exact matching) is the prerequisite and is already in place on PR #1634.

**F2 — linked-issue flag rows lack criterion/boundary attachment (A-partial).** Narrow: extend the `FLAG_CHECKS` derivation in `src/classification/classify.ts` to carry the linked issue's acceptance-criterion text into the row (bounded, redacted) or gate the rows on a boundary connection the way #1619 did for standards rules. Either keeps the fail-closed security posture ("Keep fail-closed treatment for genuinely applicable/unknown high-risk security and authorization boundaries") — a linked security issue should stay mandatory even when its criterion cannot be parsed.

**F3 — human-review settlement staleness (the #1645 sibling).** PR #1651 reconciles carried review THREADS against the live listing before settlement. The human-review overlay (`human-reviews.json`, #1238) has the same shape: prior human-review state carried into the current disposition without liveness proof. Its liveness shape differs (comment existence/edit state vs thread resolution) and deserves its own contract change rather than a bolt-on.

**F4 — the #1630-class residual is now measurable, not observable-by-reading.** "Converts bogus partials into complete reviews" shipped as #1145/#1566 (validation-aware repair) and #1585/#1598 (evidence failover); whether bogus partials STILL reach publication is exactly what #1602's harvester measures from published markers, segmented by version. Per the issue's own discipline ("Use only … existing organic exact-head reviews and #1602's versioned denominator-aware harvester for observational success"), the residual's status is a DATA question, closed by reading harvester output — not by another repair agent. No code gap identified.

**F5 — small bookkeeping gaps, no trust impact.** (a) CI-wait wall-clock is not yet separated from model time in run telemetry (#1629 deferred it — the CI gate is a concurrent subprocess with no artifact to fold); (b) the #1563 reliability ledger stays human-owned and needs-human, correctly untouched; (c) the two 2026-10-24 audit documents remain uncommitted in `docs/audits/` — this audit deliberately does not commit them; they are theirs to land.

## What would falsify this audit

- Harvester output (#1611) showing exact-head complete-eligible-review rates NOT improving across the versions that shipped #1596/#1637/#1619/#1651 — that would mean the shipped seams do not compose, contradicting the survey above.
- A future organic review where a false blocker or false approve survives with all deterministic layers green — the #1619 and #1586 precedents both came with artifact evidence naming the seam; a new one names the next gap.
