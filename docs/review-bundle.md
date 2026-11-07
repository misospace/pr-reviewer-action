# Review bundle (`review-bundle/v1`)

Every run of the action writes one machine-readable JSON document — the
**review bundle** — to the `review-bundle` step output, plus a copy at
`review-bundle.json` inside the run directory. It is the automation surface;
the published Markdown comment stays the human surface. A coding agent can
react to a review without scraping comments or logs, and can prove it is
acting on the latest review of the current head.

- Producer: `src/publish/bundle.ts` (`buildReviewBundle`), wired in
  `src/run/action.ts`.
- Parser: `parseReviewBundle` (same module) fails closed — refuse anything
  it does not fully recognize. It also cross-checks the findings counters
  against the findings list they carry (#1542).
- Issue: #1425.

## How to consume it

```js
const bundle = parseReviewBundle(steps.review.outputs["review-bundle"]);
if (bundle && bundle.head_sha === currentHeadSha) {
  // This is a fresh review of the head you are on.
}
```

A consumer MUST:

- Refuse a document whose `schema` is not exactly `review-bundle/v1`.
- Treat anything `parseReviewBundle` refuses, or an empty output, as absent
  — never guess.
- Compare `head_sha` with the PR's current head before acting. A bundle is
  only authoritative for the exact head it names.
- Compare the findings counters with the findings list they describe. A
  count below the listed length, a count that disagrees with the list while
  the document claims no truncation, and a truncation claim whose count
  matches the list exactly are contradictions. Refuse such a document
  (#1542).

## Document shape

The document is one line of JSON with a fixed key order. Example (wrapped
here for readability — real output has no newlines):

```json
{
  "schema": "review-bundle/v1",
  "review_id": "9f3c2a1b7d04e5c6",
  "generated_at": "2026-11-02T12:00:00.000Z",
  "action_version": "v3.4.1",
  "repository": "owner/repo",
  "pr_number": 123,
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "base_sha": "b40hex",
  "state": "complete",
  "identity": {
    "diff_fingerprint": "…",
    "analysis_engine": "model-name @ https://endpoint (openai)"
  },
  "disposition": {
    "verdict": "request_changes",
    "verdict_source": "model",
    "required_checks": "complete",
    "review_result": "findings",
    "incomplete_reason": "none",
    "degraded": false
  },
  "publication": { "status": "published" },
  "findings": [
    {
      "id": "3f2a…64 hex chars…",
      "severity": "major",
      "category": "bug",
      "status": "open",
      "file": "src/a.ts",
      "line": 42,
      "end_line": 45,
      "message": "…",
      "suggestion": "…",
      "agent_prompt": "…"
    }
  ],
  "findings_total": 1,
  "findings_truncated": false,
  "unresolved_requirement_ids": [],
  "unresolved_required_checks": [],
  "unresolved_review_obligations": [
    {
      "id": "must-check-1",
      "source": "must_check",
      "status": "unmet",
      "cause": "missing-source-evidence",
      "text": "verify the changelog entry"
    }
  ],
  "unresolved_review_obligations_total": 1,
  "unresolved_review_obligations_truncated": false,
  "derived_obligation_state": "complete"
}
```

### Lifecycle states

Every run that reaches an output boundary produces exactly one state:

| `state` | Meaning | `findings` key |
| --- | --- | --- |
| `complete` | A review finished with full coverage. | Present (may be empty). |
| `partial` | A review finished, but execution or requirement-trace coverage was incomplete (same signals as `incomplete-reason` / `review-result`, and the #810 partial-coverage notice). | Present. |
| `skipped` | No review ran (precheck skip, plain-issue no-op, follow-up consumed the event). `skip_reason` names the fixed reason. | Absent. |
| `failed` | The run crashed and produced no verdict. `failure_reason` is a bounded, redacted shape. | Absent. |
| `superseded` | The review completed but was withheld at the publication boundary because a newer push landed. The bundle still pins the exact head it reviewed. | Present. |

An absent `findings` key means "no verdict was produced". A present, empty
array means "a review ran and found nothing". Those two must never be
confused.

### Unresolved requirements and checks

`unresolved_requirement_ids` and `unresolved_required_checks` name the
obligations the deterministic enforcement pass could not discharge. A
requirement id appears when its trace row is `unmet` or `unverifiable`. A
required-check id appears when its structured disposition is `unresolved` or
`unmet`. Both lists ride the same presence rule as `findings`, so a skipped
or failed bundle carries neither.

These ids are enforcement output, not model output. They let a consumer see
which obligation stayed open instead of only seeing that coverage was
incomplete. Each list holds at most 20 ids, and each id is at most 64
characters.

### Blocking review obligations and derived coverage

A review obligation is a check the reviewer was expected to perform. A
blocking review obligation is one that stayed open and stopped the review.
The bundle names each blocking row in `unresolved_review_obligations`.

```json
{
  "id": "must-check-1",
  "source": "must_check",
  "status": "unmet",
  "cause": null,
  "text": "verify the changelog entry"
}
```

- `id` names the obligation. It is at most 64 codepoints.
- `source` names the rule that made the row blocking. It is `must_check` for
  the operator's checklist. It is `trusted_base_guidance` for an ask the
  trusted base stated. Those two are the only values a row carries.
- `status` is always `unmet` (#1505): the row was checked, and the
  requirement did not hold — a confirmed negative. An `unresolved` row is an
  availability failure: coverage, never a defect, so it never rides here.
- `cause` explains the block. It is `tool-capability`, `budget-exhausted`,
  `provider-failure`, `missing-source-evidence` or `derivation-incomplete`,
  or null when the run knows no cause. The cause never decides a block.
- `text` is the obligation's own wording. It is at most 300 codepoints.

A derived obligation is a different thing. The reviewer never stated it, so
the run derived it from the change itself. A derived obligation is discharged
when evidence proves it. An undischarged derived obligation is a coverage
statement. It withholds the trusted approval, and it never forces a request
for changes. A derived row therefore never rides in
`unresolved_review_obligations`.

The derived coverage rides as a state in `derived_obligation_state`:

- `complete` means every derived obligation was discharged.
- `unresolved` means at least one derived obligation stayed open.
- `unavailable` means the run could not prove the coverage.
- null means the run has no derived state. The feature was off, or the run
  could not read it. An unknown state is never read as `complete`.

`unresolved_review_obligations_total` counts every blocking row the run had
that the document could list. A row whose id is empty after the bounds, and a
row whose id repeats an earlier row, are dropped and are not counted.
`unresolved_review_obligations_truncated` says whether the list is shorter
than that count. Never read a shortened list as the whole set.

The bundle carries the COMPLETE blocking set: its only row bound is the
document's own 64 KiB byte budget, and rows are admitted one at a time ahead
of the findings, because they name what blocked the review (#1521 review: a
controller must be able to name every blocking row, not only the first ten).
The published handoff keeps a tighter listing bound — at most 10 rows, its
8 KiB budget — and discloses its shortening, so the handoff's list is always
a disclosed PREFIX of the bundle's rows, never a different or longer set.
When the handoff reports `unresolved_review_obligations_truncated: true`,
the bundle is the machine surface that names the rest.

All four members ride the same presence rule as `findings`. A skipped or
failed bundle carries none of them. A run that never reviewed blocked
nothing.

The parser treats the four members as optional. A bundle written before
#1521 carries none of them, and it stays parseable. A row whose `source`,
`status` or `cause` is outside the published vocabulary is refused: a
`derived` row is a coverage statement, a `satisfied` row blocked nothing,
and an `unresolved` row is an availability failure, never a defect (#1505).

The obligation counters are cross-checked against the rows they carry, and
not only type-checked. A document that lists more blocking rows than it
counts is contradictory. So is a document that claims no truncation while
its total disagrees with the list. The parser refuses both. An absent
counter defaults to the list's own length (the total) or to `false` (the
truncation flag), so a bundle that carries the rows without the counters
still parses. The published handoff's parser refuses the same contradictions.

### Freshness and supersession

- `head_sha` is the exact commit this run reviewed — never a newer head.
- `review_id` names this run; `head_sha` + `review_id` together name its
  review. A rerun produces a new bundle with a new `review_id`; nothing is
  silently overwritten — the older bundle keeps describing the review it did.
- A `superseded` bundle states the relationship directly: it is the review
  that the newer head replaced.

### Findings

- `id` is the stable finding digest from the #1027 outcome contract (SHA-256
  over path, severity, category, and the redacted message — not the line).
  The same finding re-anchored after a force-push keeps its id; a rewritten
  message honestly gets a new one. `id` is `null` when the record cannot
  prove one (for example an unanchorable path).
- `status` is `open` today: every listed finding was still open when the
  review finished. Cross-run resolution state lives in the finding-outcomes
  ledger, not in this snapshot.
- `severity` is closed to `blocker`, `major`, `minor`, `info`; anything else
  reports as `info`.
- `file`/`line`/`end_line` are anchors where available, `null` where not.
- `findings_total` counts every finding the review produced;
  `findings_truncated` says whether some are not listed. Never read a
  truncated bundle as the whole set.
- The parser cross-checks those two counters against the `findings` array
  (#1542). It refuses a document that lists more findings than it counts, a
  document that claims no truncation while its total disagrees with the
  list it carries, and a document that claims a truncation while its total
  matches the list exactly. The published handoff refuses the same three
  contradictions for its id lists (#1538), and the first two for its item
  counters.
- The counters and the `findings` array are one unit. The parser refuses a
  document that carries a counter without the array, and a document that
  carries the array without both counters.

### Identity and disposition

- `identity.diff_fingerprint` matches the `diff-fingerprint` output.
- `identity.analysis_engine` matches the `analysis-engine` output (model and
  endpoint). `action_version` is the release stamp of the running action.
- `disposition` is the authoritative verdict plus deterministic enforcement
  state — the same values as the `verdict`, `verdict-source`,
  `required-checks`, `review-result`, and `incomplete-reason` outputs.
  `degraded` marks a review eligible for the degraded gate bypass (fallback
  with no evidence, or a model-failure notice).
- On a skipped run that carried an earlier verdict, `disposition` shows the
  carried decision and `verdict_source` names its origin (for example
  `carry_forward`). The findings of a carried verdict live in that earlier
  run's bundle, not this one.
- `publication.status` (`published` / `superseded` / `failed`) appears only
  when publication was attempted — same rule as `publish-status` (#1257).

## Bounds and redaction (by construction)

- The whole document is at most 64 KiB (`REVIEW_BUNDLE_MAX_BYTES`), checked
  on the exact serialized string. Omitted findings are disclosed, not hidden.
- At most 100 findings are listed (`REVIEW_BUNDLE_MAX_FINDINGS`).
- The two merge-gating id lists are reserved in that budget at their exact
  serialized byte length, so an id made of multi-byte codepoints can never
  push the document over the cap.
- The blocking obligation rows are admitted one at a time against that
  budget, each charged at its exact serialized byte length, ahead of the
  findings; a row the budget cannot carry is disclosed, not hidden, so a
  long row can never push the document over the cap.
- Every text field passes secret redaction and a length cap before it is
  serialized. The document carries no model transcripts, no raw tool
  output, no rendered Markdown, and no evidence blobs.
- The document is a single-line JSON string, so hostile finding text and
  hostile obligation text stay inert string content and cannot forge
  structure. Quotes, braces, fake headings, and delimiter names are all
  string content. Tests feed those tokens back at the builder
  (`tests-v3/review-bundle.test.ts`).

## What does NOT change

The Markdown comment, native review publication, verdict policy, branch
protection, and the fail-on-request-changes gate are untouched. The bundle
is an added read surface: it never feeds the verdict or any gate.

## Published handoff (`review-handoff/v1`)

The bundle is the local surface. It rides the `review-bundle` step output
and a run-directory file, so only a workflow inside the same run can read it.
The handoff is the published surface. It rides the action-owned managed body,
so any consumer with ordinary pull-request comment or review reads can read
it. No artifact download and no forge-specific API are needed.

- Producer: `src/publish/handoff.ts` (`buildReviewHandoff` builds the
  document, `renderReviewHandoffBlock` renders the container), wired in
  `src/publish/publish.ts`.
- Consumer-side parser: `parseReviewHandoffBlock` reads the first anchored
  block, `parseReviewHandoff` parses the document and fails closed. The
  consumer must select the managed body by the forge-reported author before
  it reads the block.
- Issue: #1518.

### Container format

The action renders one block into the managed body. The anchor line comes
first, then the fence, then the payload on one line, then the closing fence.

````text
<!-- ai-pr-reviewer-handoff:v1 -->
```json
{"schema":"review-handoff/v1", ...}
```
````

The payload is one line of JSON, so it cannot break out of the fence. The
fence delimiter is longer than any backtick run inside the payload.

### Trust rules

A consumer MUST:

- Select the action-owned managed body by the forge-reported author. That is
  the action's own posting identity, and the trusted owner identity AND the
  managed marker together are what prove the body belongs to the action.
  This is the same trusted-owner rule `readPriorPublishedHead` applies in
  `src/publish/publish.ts`. A content prefix alone is never enough, because
  any reader of the repository can post a look-alike comment. A look-alike
  PR-authored comment that starts with the managed marker and carries a
  valid handoff is refused by the author check.
- Never read an inline finding comment for the handoff. An inline comment is
  never the handoff's home.
- Take the first anchored block in that managed body. The action renders the
  container in the marker preamble, the action-owned markers at the top of
  the body. The preamble comes before every model-authored surface. The
  anchor is also reserved against model markdown, so model prose can never
  emit it. A later copy can never pass for the action's block.
- Compare `head_sha` with the pull request's current head before acting. A
  handoff is authoritative only for the exact head it names.
- Refuse a document whose `schema` is not exactly `review-handoff/v1`, and
  treat anything `parseReviewHandoff` refuses as absent. The parser refuses
  an empty `review_id`, and it cross-checks the item counters. A document
  that lists more items than it counts, that claims no truncation while
  its total disagrees with the list it carries, or that claims a truncation
  whose total matches the list exactly (#1547), contradicts itself and is
  refused. The two id lists carry the same cross-check (#1538): a count
  below the listed length, a count that disagrees with the list while the
  document claims no truncation, and a truncation claim whose count matches
  the list exactly are all contradictions, and a contradictory document is
  refused. All three lists are checked by the one rule (#1547).
- Treat an unknown id-list disclosure as an incomplete list. A `null`
  `*_truncated` flag means that the document discloses no truncation, so the
  list may be short. A count larger than the listed length means the list is
  short, whatever the flag says. A consumer MUST NOT read `null` as `false`.
- Treat the four obligation members as optional. A document published before
  #1521 carries none of them, so it stays parseable. An absent list parses
  as empty, and an absent state parses as null. A member that is present is
  shape-checked, and the obligation counters are cross-checked the same way
  as the item counters.
- Refuse a row whose `source`, `status` or `cause` is outside the published
  vocabulary. A `derived` row is a coverage statement, a `satisfied` row
  blocked nothing, and an `unresolved` row is an availability failure —
  coverage, never a defect (#1505). A document that carries any of them as a
  blocking obligation did not come from this action, so it is refused.
### Document shape

The document is one line of JSON with a fixed key order. Example (wrapped
here for readability, real output has no newlines):

```json
{
  "schema": "review-handoff/v1",
  "review_id": "9f3c2a1b7d04e5c6",
  "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "verdict": "request_changes",
  "review_result": "findings",
  "required_checks": "complete",
  "items": [
    {
      "id": "3f2a…64 hex chars…",
      "severity": "major",
      "category": "bug",
      "path": "src/a.ts",
      "line": 42,
      "end_line": 45,
      "message": "…",
      "suggestion": "…",
      "agent_prompt": "…"
    }
  ],
  "items_total": 1,
  "items_truncated": false,
  "unresolved_requirement_ids": ["REQ-7"],
  "unresolved_requirement_ids_total": 1,
  "unresolved_requirement_ids_truncated": false,
  "unresolved_required_checks": ["tests cover the new path"],
  "unresolved_required_checks_total": 1,
  "unresolved_required_checks_truncated": false,
  "unresolved_review_obligations": [
    {
      "id": "must-check-1",
      "source": "must_check",
      "status": "unmet",
      "cause": "missing-source-evidence",
      "text": "verify the changelog entry"
    }
  ],
  "unresolved_review_obligations_total": 1,
  "unresolved_review_obligations_truncated": false,
  "derived_obligation_state": "complete"}
```

- `items` holds the FINAL post-enforcement findings. That is the artifact's
  findings after the severity caps, the suppression, the blocker
  verification demotion and the thread-settlement re-emission. It is never
  raw model output.
- `review_id` names the run. Together with `head_sha` it names this review
  of this head. A rerun publishes a new handoff with a new `review_id`.
- `id` is the stable finding identity from the #1027 outcome contract, or
  null when the record cannot prove one. It is never a positional index.
- `severity` is closed to `blocker`, `major`, `minor` and `info`. Anything
  else reports as `info`.
- `path` is the finding's file path, or null. The path must pass the same
  `safePath` bar every other untrusted-path surface applies (#1163): a
  non-empty, repository-relative path with no `..` segment and no NUL byte.
  An absolute, traversing, or NUL-bearing path proves no anchor and is
  dropped — the finding itself still rides the item. Paths are strings here
  and are never opened, so a relative path through a symlink component stays
  an ordinary anchor.
- `suggestion` rides an item only when this run published that exact
  replacement as a review comment. The action publishes the replacement
  under the finding's identity digest, and the handoff carries that digest's
  replacement and nothing else. A replacement a trusted reviewer rejected
  never rides the handoff, and neither does a replacement the action never
  published. The item survives in both cases. No replacement is ever
  truncated. A replacement longer than the suggestion cap loses the
  suggestion and keeps the item, because a cut-off patch is worse than no
  patch. Publication is the proof, not intent: when the inline review
  submission fails after a body that carries suggestions was already
  published, the run re-publishes that body with the suggestions withdrawn,
  and the body-only fallback of a native review carries the suggestion-free
  variant from the start. A suggestion in a published handoff therefore
  always has a review comment behind it.
- A platform where the publish boundary holds no diff publishes no inline
  comment and therefore no suggestion. That is GitHub today: the publish
  seam passes an empty diff to the publish step on every platform but
  Forgejo. The same holds for a mode that publishes no inline review
  comments, such as `publish-mode: comment`.
- `items_total` counts every finding the review produced, and
  `items_truncated` says whether some of them are not listed. Never read a
  truncated set as the whole set. The two must agree with `items`, and the
  parser refuses a document that breaks that agreement — including a
  truncation claim whose total equals the listed length (#1547).
- `unresolved_requirement_ids` and `unresolved_required_checks` carry the
  same ids as the bundle, on the same presence rule. They name the
  obligations the deterministic enforcement pass could not discharge.
- `unresolved_requirement_ids_total` and `unresolved_required_checks_total`
  count the ids each list carried before the byte budget shortened it.
  `unresolved_requirement_ids_truncated` and
  `unresolved_required_checks_truncated` say whether the byte budget dropped
  an id from that list. Never read a shortened list as the whole set.
- A handoff published before #1538 carries no id counters. The parser then
  reports the count and the flag as unknown (`null`). An unknown flag is
  never read as `false`, because such a document may still hide a dropped
  id.

### Blocking review obligations and derived coverage

The handoff projects the same blocking rows as the bundle. A consumer that
reads a published body sees what blocked the review, not only an opaque id.
Per #1505, a row blocks only when it is `unmet` (the check was performed and
the requirement did NOT hold — a confirmed negative). An `unresolved` row is
an availability failure (coverage, never a defect): it withholds the trusted
approval and marks the review partial, but it never rides here as a blocking
obligation. The `derived` rows are likewise coverage, never blocks.
The handoff's byte budget can shorten its list, so the handoff may carry a
prefix of the bundle's rows. Its total and its truncated flag say so.

- `unresolved_review_obligations` holds the blocking rows. Each row carries
  `id`, `source`, `status`, `cause` and `text`. The row shape and the
  closed vocabularies are the ones the bundle section above lists.
- `unresolved_review_obligations_total` counts every blocking row the run
  had that the document could list. `unresolved_review_obligations_truncated`
  says whether the list is shorter than that count. At most 10 rows are
  listed.
- `derived_obligation_state` carries the run's derived coverage as a state.
  It is `complete`, `unresolved` or `unavailable`, and null when the state
  is unknown. The states are the ones the bundle section above lists.

A derived obligation is a coverage statement, never a blocking obligation.
It withholds the trusted approval, and it never forces a request for
changes. A derived row therefore never rides in
`unresolved_review_obligations`. It rides only as the derived state.

The four members are always present in a published handoff, so the key set
of the document stays fixed. The presence of `derived_obligation_state` does
not mean that the derived feature ran. A null value means the run has no
derived state.

### Bounds and redaction

- The whole document is at most 8 KiB (`REVIEW_HANDOFF_MAX_BYTES`), checked
  on the exact serialized string. Omitted findings are disclosed, not
  hidden. The zero-item base (metadata plus the two id lists) can itself
  exceed the cap — twenty four-byte-codepoint ids per list is more than the
  bound — so the base is shrunk first: the last ids of the longer id list
  are dropped one at a time (requirements first on a tie) until the document
  fits. The empty-list base is far below the cap, so the bound always holds.
- The two id counters ride the base (#1538). The byte budget that shortens
  the lists measures the counters too, so a shortened document still fits the
  cap, and the shortened list is disclosed by its own count and flag.
- The two id lists give way before the obligation rows. The rows name what
  blocked the review, so they are the last thing the byte budget takes (and
  only after both id lists are empty). A shed row sets
  `unresolved_review_obligations_truncated` to true, and the honest count
  stays in `unresolved_review_obligations_total`. The zero-item base
  (metadata plus the two id lists plus the obligation rows) can itself exceed
  the cap — twenty four-byte-codepoint ids per list is more than the bound —
  so the base is shrunk first: the last ids of the longer id list are dropped
  one at a time (requirements first on a tie) until the document fits. The
  empty-list base is far below the cap, so the bound always holds.
- At most 25 findings are listed (`REVIEW_HANDOFF_MAX_ITEMS`).
- At most 10 obligation rows are listed on the PUBLISHED handoff
  (`REVIEW_HANDOFF_MAX_OBLIGATIONS`) — the complete set lives in the local
  bundle, and the handoff's list is its disclosed prefix (#1521 review).
  A row's text is at most 300
  codepoints (`REVIEW_HANDOFF_MAX_OBLIGATION_TEXT_CHARS`). A row's id is at
  most 64 codepoints.
- A suggestion is at most 2000 codepoints
  (`REVIEW_HANDOFF_MAX_SUGGESTION_CHARS`). A longer replacement is omitted
  rather than cut off.
- The published body grows by at most the 8 KiB document plus the container
  that holds it, and the whole published body is bounded at 65,536 UTF-8
  bytes (`MAX_PUBLISHED_BODY_BYTES`) — the byte form of the forge's
  65,536-character comment ceiling (#1554). At the publish boundary only the
  model-authored review prose is ever trimmed to fit; the machine documents
  and action-owned notices are never trimmed, and any trim is disclosed in
  the body's final line. The prose always has room because every
  action-owned block's own bounds keep it far below the ceiling.
- Every text field passes secret redaction and a length cap before it is
  serialized. The HTML characters are written as JSON escapes, so the
  published body never carries a raw tag out of the payload.
- The document is a single-line JSON string, so hostile finding text and
  hostile obligation text stay inert string content and cannot forge
  structure.

### A read-only surface

The handoff is an added read surface. It never feeds the verdict, a gate or
the published verdict text. It carries no model transcript, no raw tool
output and no evidence blob.
