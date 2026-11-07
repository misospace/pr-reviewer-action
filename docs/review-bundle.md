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
  "unresolved_required_checks": []
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
- Every text field passes secret redaction and a length cap before it is
  serialized. The document carries no model transcripts, no raw tool
  output, no rendered Markdown, and no evidence blobs.
- The document is a single-line JSON string, so hostile finding text —
  quotes, braces, fake headings, delimiter names — stays inert string
  content and cannot forge structure. Tests feed those tokens back at the
  builder (`tests-v3/review-bundle.test.ts`).

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
  that lists more items than it counts, or that claims no truncation while
  its total disagrees with the list it carries, contradicts itself and is
  refused. The two id lists carry the same cross-check (#1538): a count
  below the listed length, a count that disagrees with the list while the
  document claims no truncation, and a truncation claim whose count matches
  the list exactly are all contradictions, and a contradictory document is
  refused.
- Treat an unknown id-list disclosure as an incomplete list. A `null`
  `*_truncated` flag means that the document discloses no truncation, so the
  list may be short. A count larger than the listed length means the list is
  short, whatever the flag says. A consumer MUST NOT read `null` as `false`.

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
  "unresolved_required_checks_truncated": false
}
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
  truncated set as the whole set.
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
- At most 25 findings are listed (`REVIEW_HANDOFF_MAX_ITEMS`).
- A suggestion is at most 2000 codepoints
  (`REVIEW_HANDOFF_MAX_SUGGESTION_CHARS`). A longer replacement is omitted
  rather than cut off.
- The published body grows by at most the 8 KiB document plus the container
  that holds it.
- Every text field passes secret redaction and a length cap before it is
  serialized. The HTML characters are written as JSON escapes, so the
  published body never carries a raw tag out of the payload.
- The document is a single-line JSON string, so hostile finding text stays
  inert string content and cannot forge structure.

### A read-only surface

The handoff is an added read surface. It never feeds the verdict, a gate or
the published verdict text. It carries no model transcript, no raw tool
output and no evidence blob.
