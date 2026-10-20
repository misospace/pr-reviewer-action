# Finding outcomes and feedback data contract (#1027)

`src/outcomes/` carries the shared, privacy-aware finding-outcome and
usefulness-feedback data contract (`finding-outcomes/v1`). Action mode is
stateless: each publish derives bounded events from forge state it already
reads plus one new bounded thread-state query, and exports them as a run
artifact. Operator mode may persist the same events through the controller
later; `parseOutcomeLedger` is the fail-closed seam for that.

## Finding identity

`findingIdentity({ path, severity, category, message })` is a SHA-256 digest
over the JSON-serialized tuple of the trimmed path, lowercased severity and
category, and the **redacted**, whitespace-collapsed, 500-codepoint-bounded
message (JSON, not a bare NUL join, so the encoding stays injective when a
model-authored field itself contains a NUL byte). The anchor line and range are deliberately **not** part of the
identity, so line drift and force-push keep the same identity; a rewritten
message is honestly a NEW identity — the contract records only what it can
prove deterministically and never fuzzy-matches prose. Accepted consequence:
a model that paraphrases the same defect across runs mints a new identity,
so `repeated` events are exact-text matches only; cross-run tracking of
reworded findings is future work (a similarity key would be exactly the
non-determinism this contract forbids). The digest also depends on the
current secret-redaction pattern set: a future redaction change re-keys
every finding (a one-time ledger discontinuity, not a correctness failure).

The identity travels between runs inside the published inline finding comment
as a hidden, action-owned marker (`pr-reviewer:finding-id:v1:<64 hex>`), with
the same discipline as the #762 rejection carry marker:

- strict single-line grammar — a near-miss line is ordinary content;
- reserved against model-authored markdown (`RESERVED_MARKER_PATTERNS`), so
  model text can never mint or rewrite a finding identity;
- stripped from every surface that extracts finding content (the review-thread
  footer strip and the corpus renderer).

## Event kinds

| Kind | Meaning | Provenance |
|---|---|---|
| `reported` | first time this identity is reported | `current-review` |
| `repeated` | the identity is reported again on a later run | `current-review` |
| `resolved` | thread resolved while the head **provably** advanced | `forge-thread` |
| `dismissed` | thread resolved with the head unchanged or unprovable; bounded `reason` (`thread_resolved` / `thread_resolved_head_unverified`) | `forge-thread` |
| `still_open` | prior finding's thread is still unresolved | `forge-thread` |
| `unknown` | ledger-tracked identity whose latest status was open, now gone from both findings and observations (lost history) | `prior-ledger` |
| `feedback` | 👍/👎 reaction tallies from the #762 signal — informational only | `forge-reaction` |
| `adjudication` | explicit human label (`confirmed_valid_defect`, `confirmed_false_positive`, `valid_but_unhelpful`, `uncertain`) with who/when/provenance | `operator` |

The table is enforced structurally, not just documented:
`normalizeOutcomeEvent` rejects any event whose provenance is not the single
seam listed for its kind (an untrusted ledger can neither re-label where an
observation came from nor mint a lifecycle outcome it never observed),
rejects a `dismissed` event without a bounded reason, and rejects `feedback`
claiming `trusted: true`. This validates WHAT a payload claims, not WHO wrote
it: an `operator`-provenance adjudication is meaningful only because the
persistence channel that stores ledgers is itself the trusted-operator seam
(ledger authenticity is that channel's guarantee, never inferable from the
event bytes).

Trust separation is structural: only an `adjudication` event moves the
adjudicated precision denominator, and it moves it **per finding** — the
latest adjudication for an identity (by timestamp, then array order) is its
label, counted once, so a corrected label replaces the one it corrects
instead of landing in both denominators. A resolved thread, a thumbs-down, or
a vanished comment can change open/resolved/dismissed counts and reaction
tallies, but never an adjudicated label. Forge-derived feedback is always
`trusted: false`; reactions never resolve, dismiss, or reclassify anything,
and never touch severity or verdict.

## Reconciliation rules

`deriveOutcomeEvents` is pure and deterministic. It takes the identities of
the findings this run is actually about to publish (parsed from the markers
of the built comments — a finding the anchor validation skipped never
produces a `reported` event for a comment that does not exist). Within one
derivation, events are emitted chronologically — prior published state
first, current review last — and the aggregate reads latest state by event
instant (an unprovable instant sorts oldest; ties fall back to array order),
so a finding re-reported after its old thread was resolved is open again. An
unprovable thread state
(`resolved: null`) emits no resolution claim at all, and "resolved after a
newer head" is claimed only when both heads are known and differ; the prior
head comes only from an **owned** managed sticky comment's metadata marker
(plus a caller-supplied fallback accepted under the same hex proof rule),
never from forge-supplied review metadata (see Collection).

With a prior ledger (operator mode), the run's events are merged after the
ledger events, exact duplicates collapse, the ledger keeps its latest
`MAX_LEDGER_EVENTS` (1000), and an identity becomes `unknown` only when its
**latest status-bearing** ledger event is still open (by instant, then
array order — the same latest-wins rule the aggregate uses) and it is now
absent from both findings and observations. A finding already `resolved` or
`dismissed` before the run is never re-declared unknown.

### Feedback is a delta contract under a prior ledger

Reaction observations are per-comment **snapshots** of the current
👍/👎 totals. Summing snapshots across runs would let one unchanged reaction
multiply with every re-review (observed at two timestamps, it would report
two reactions), so operator mode — the only mode that merges a prior
ledger — enforces an **observation-vs-delta contract** at derivation time:
the run computes its per-identity current totals, subtracts the prior
cumulative total (the sum over the ledger's `feedback` events for that
identity and signal), and emits only the positive remainder as the new
event. The ledger therefore always sums to the current observed total:
one unchanged 👍 at two timestamps aggregates as one, a genuinely added
reaction increments once, and a stateless run's artifact still records the
full snapshot. Two consequences are pinned:

- A **removed** reaction (a negative delta) has no representable count in
  v1 and emits nothing: informational reaction counts may read stale-high
  after a removal, and are never invented or inflated.
- The dedupe key includes the head anchor, so a delta event is never
  collapsed into the prior snapshot it was derived from.

Reactions remain informational throughout: the delta contract changes only
how counts accumulate, never adjudicated precision, status, or the verdict.

## Collection (Action mode)

The #762 feedback read (`readFeedbackState` in `src/publish/publish.ts`) is
the single enumeration: suppression keys (#762), reaction tallies, identity
markers, and thread states are harvested from the same bounded pass, with
independent per-kind caps so a flood of one kind cannot displace the other.
Reaction reads happen **only** when the suppression gate needs them (the
current findings could post a prescription); outcome tallies are a passive
byproduct of the same records — outcomes never make an independent reaction
or permission request. Consequence (accepted v1 limitation): a prior
finding whose comment carries no recoverable prescription contributes
identity and thread state but zero reaction tallies. The feature's only new
requests are one bounded `reviewThreadStates` query and the managed sticky
comment read for the prior head, both made only when identity-bearing
observations exist. An unprovable or failed read contributes no observations
and no outcomes. The enumeration itself is forge-agnostic: a forge without
the collaborator-permission seam (Forgejo) still derives reported/repeated/
resolution events, with zeroed tallies and degraded thread state.

A *completed* enumeration that proves no managed review of ours exists is a
**positive** reading of the prior set — provably empty, not uncertain — so
the first-ever publication on a repository still derives `reported` events
and writes the artifact. `enumerated: false` is reserved for the fail-closed
cases: a thrown review read, or an unsupported/incomplete inline-comment
enumeration.

Identity provenance: an identity marker counts only on a top-level comment
of a managed review whose author matches the trusted owner identity the
carry-marker path itself proves (`resolvePublishTrustedOwner` — resolved
**once per publish run** and threaded from there into the carry-marker read,
the prior-head read, and cleanup, so a run proves ownership once instead of
once per read; the resolution stays lazy — no consumer asks until it has
something to authorize — and is scoped to one publish run in one process,
nothing is cached across the precheck/publish boundary) — the same bar the rejection
carry marker applies, because `selectManagedReviews` matches by body prefix
and any repo reader could post a marker-shaped comment. Unprovable authors
contribute nothing. The prior published head obeys the same bar: only an
owned managed sticky comment's marker is read, and among owned candidates the
**newest** one is authoritative — the same selection the sticky upsert uses to
find its patch target, so a stale legacy sticky is history rather than a
competing candidate. No candidate, an unresolvable owner, or an unusable head
on the newest candidate fails closed to "unprovable head" (the thread becomes
a `thread_resolved_head_unverified` dismissal, never a `resolved`); an
unusable newest head never falls back to an older comment, and the
caller-supplied fallback head is accepted only under the same hex proof rule,
so an unproven value can never stand in for the missing marker. "Newest" is a
claim about absence — no newer publication exists — so the read must be a
PROVEN enumeration: an issue-comment read that is absent, thrown, truncated
mid-pagination, or malformed (`listIssueCommentsResult`, whose `complete` flag
the GitHub adapter sets only on a short page) yields no READ-DERIVED prior
head, never a head selected from a partial comment list; the operator-supplied
`priorHeadSha` fallback (`PRIOR_HEAD_SHA`) stays available under its own hex
proof rule.

## Export and report

On a successful publish, `publishWith` writes `finding-outcomes.json` (the
serialized ledger: schema, generation metadata, events, aggregate) into the
run directory — only when the review actually published (a superseded run
returns before outcomes exist, a failed publication or a failed
inline-findings submission never carries outcomes), only when the
enumeration was proven — either a provably empty prior review list or at
least one prior observation — and never on a #588 managed-record path: a
platform that declares no native review surface never creates the inline
finding comments the ledger's `reported` events describe (the findings live
in the managed record's body), so the ledger and its tally line are both
dropped there. The producer runs its own event
normalizer before serializing, so the artifact always parses under the same
rules a reader applies, with the endpoint URL stripped from the model field
(`publicAnalysisEngine`). Past the 1000-event cap the producer drops the
OLDEST events, the same end readers keep, so an overflowing run exports the
newest state. `aggregateOutcomeEvents` produces the denominator-aware
aggregate (unique findings, open/resolved/dismissed/unknown, reaction
tallies, adjudicated counts and precision — `null` when no adjudication pair
exists, and the latest adjudication per finding counted once), and
`renderOutcomeReportMarkdown` renders a minimal operator report
(counts only: no paths, no message text, no logins).

Reader side: `parseOutcomeLedger` is fail-closed (one bad event, wrong
schema, or unparseable generation metadata nulls the whole ledger, and the
1000-event cap applies) and it **recomputes** the aggregate from the events
it validated instead of trusting the serialized counts, so a tampered or
stale `aggregate` can never reach a reader.

Privacy: events carry digests, counts, and bounded metadata only — no
finding message text, no reaction logins, no review content; free-text
fields are redacted and bounded; paths appear only in the digest input, not
in events.

## Operator persistence boundary (scope obligation)

A finding identity digest is stable per finding but carries **no forge or
repository scope**: the same finding text on the same path in two different
repositories (or two forges) hashes identically. Within one repository's
run artifact that is the intended line-drift invariant; across tenants it
is a collision surface. Operator-mode persistence that merges or groups
ledgers from more than one repository, forge, or tenant **must partition
the stored events by that trusted context before merging or grouping** —
identities, reaction deltas, and adjudication counts from two contexts are
never combinable, and the contract provides no in-event scope field to
recover the partition after the fact.
