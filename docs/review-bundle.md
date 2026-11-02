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
  it does not fully recognize.
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
  "findings_truncated": false
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
