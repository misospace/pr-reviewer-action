// Provider-specific webhook projection at the Forgejo ingress edge (#730).
//
// Native Gitea/Forgejo webhook deliveries do not share GitHub's event
// vocabulary: the `X-Gitea-Event` header carries the GROUPED event name and a
// second `X-Gitea-Event-Type` header carries the specific type (e.g. a PR
// sync arrives as header `pull_request` + type `pull_request_sync` with
// `action: "synchronized"`, a PR label change as header `pull_request` + type
// `pull_request_label` with `action: "label_updated"` and NO top-level
// `label`, and a PR comment as header `issue_comment` + type
// `pull_request_comment` with the PR on a TOP-LEVEL `pull_request` object
// instead of GitHub's `issue.pull_request`). This module projects a raw
// (HMAC-verified) native delivery onto the GitHub-shaped envelope that the
// FROZEN #728 normalizer (`normalizeForgejoEvent`) already accepts, BEFORE that
// normalizer runs. The normalizer and everything downstream are untouched;
// only this projection is new, and GitHub behavior is unaffected.
//
// Security posture (mirrors `webhook-handler.ts`): the `X-Gitea-Event` and
// `X-Gitea-Event-Type` headers are TRUSTED — the delivery is HMAC-verified over
// the raw body and both headers are shape-validated by the handler before this
// projection runs, and only these headers (never a payload field) decide the
// projected `name`. The payload is UNTRUSTED: no untrusted string is ever
// copied into a synthesized field. The only value the projection synthesizes
// is the trusted rereview-label constant (the operator-configured trigger
// label, or the "ai-review" default) — it is matched byte-for-byte against the
// payload's `pull_request.labels` and re-emitted as that trusted constant,
// never as a copy of the payload text, so a hostile label cannot forge the
// trigger. The projection is pure: it never throws, never mutates the input,
// and always returns a fresh object with `name` set. Any unrecognized shape
// falls through to `{ ...payload, name: eventHeader }` — exactly the behavior
// the handler had before this module existed.
//
// Grouping table (the `specific` type header):
//   pull_request_sync   -> header `pull_request` + `action: "synchronized"`
//   pull_request_label  -> header `pull_request` + `action: "label_updated"`
//   pull_request_comment-> header `issue_comment` + `action: "created"`
//
// Failure mode is fail-closed throughout: an unrecognizable label or comment
// projects to a shape the normalizer maps to `unknown`, which the handler acks
// (200) without dispatching a PR-specific pipeline.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The effective trigger label: the operator-configured value, falling back
 * to the "ai-review" default on an absent or EMPTY option — the same `||`
 * convention the #728 normalizer (`options.rereviewLabel || "ai-review"`) and
 * the precheck use, so the projection and the normalizer can never disagree
 * on which label triggers a re-review. */
function rereviewLabelOf(options: { rereviewLabel?: string }): string {
  return options.rereviewLabel || "ai-review";
}

/** Rule 3 — project a Forgejo label delivery onto the canonical `labeled`
 * shape. The name is forced to `pull_request` and the action to `labeled`.
 *
 * Label synthesis: if the payload already carries a usable top-level `label`
 * (a string, or an object with a string `name`), it is passed through
 * UNCHANGED and the normalizer's own byte-exact trigger comparison decides the
 * outcome. Otherwise the payload's `pull_request.labels` array is scanned for
 * the FIRST entry whose `name` is EXACTLY (case-sensitive, no trim) the
 * trusted rereview label; on a match `label` is synthesized as the trusted
 * constant (NEVER a copy of the payload text), and on no match `label` is the
 * sentinel `""` (which the normalizer maps to `unknown` → 200-ignored, fail
 * closed).
 *
 * Rationale for synthesizing on a "label already present" delivery: a
 * `label_updated` while the trigger label merely ALREADY EXISTS on the PR can
 * over-trigger a re-review, but same-head re-review generations converge to
 * the ONE job id via the #728 ledger, so a redundant trigger is harmless.
 */
function projectLabelEvent(
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string },
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...payload,
    name: "pull_request",
    action: "labeled",
  };

  const label = payload.label;
  const hasUsableLabel =
    typeof label === "string" || (isPlainObject(label) && typeof label.name === "string");
  if (hasUsableLabel) {
    // A usable top-level label is passed through untouched (it was copied by
    // the spread above); the normalizer's byte-exact comparison owns the
    // trigger decision for it.
    return projected;
  }

  const rereview = rereviewLabelOf(options);
  const pr = payload.pull_request;
  let matched = false;
  if (isPlainObject(pr)) {
    const labels = pr.labels;
    if (Array.isArray(labels)) {
      for (const entry of labels) {
        // Only a plain object with a byte-exact string `name` can match;
        // strings, numbers, arrays, and nulls are skipped (a `"__proto__"`
        // entry is just an array element, never a property access).
        if (isPlainObject(entry) && typeof entry.name === "string" && entry.name === rereview) {
          matched = true;
          break;
        }
      }
    }
  }
  // Synthesize ONLY the trusted constant. The match above is byte-exact, so a
  // copy of the payload would be identical in value — but the fence is to keep
  // a synthesized field from ever being derived from untrusted input.
  projected.label = matched ? { name: rereview } : "";
  return projected;
}

/** Rule 5 — project a Forgejo comment delivery onto the GitHub `issue_comment`
 * envelope the `follow_up` gate requires.
 *
 * Gitea/Forgejo carry the PR on a TOP-LEVEL `pull_request` object (with
 * `issue` and `comment` as siblings); GitHub nests it at `issue.pull_request`.
 * The #728 normalizer's `resolvePr` prefers a top-level `pull_request` (the
 * "envelope" origin) and the `follow_up` kind requires the "issue" origin, so
 * the top-level `pull_request` must be MOVED into `issue.pull_request` —
 * deleting the top-level key (not leaving it `undefined`) — for the
 * normalizer to take the issue-origin path. The top-level `comment` is left
 * untouched (`eventReference` comes from `comment.id`).
 *
 * - top-level `pull_request` present and `issue.pull_request` absent → move it
 *   into `issue.pull_request`;
 * - no top-level `pull_request` (issue-only comment) → unchanged (a non-PR
 *   comment stays `unknown` → ignored, which is correct);
 * - `issue.pull_request` already present (GitHub-shaped delivery) → unchanged.
 */
function projectCommentEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...payload, name: "issue_comment" };

  const issue = payload.issue;
  const hasIssuePr = isPlainObject(issue) && isPlainObject(issue.pull_request);
  const hasTopPr = isPlainObject(payload.pull_request);
  if (hasTopPr && !hasIssuePr) {
    // DELETE the top-level key (not `undefined`) so `resolvePr` takes the
    // issue-origin path the follow_up gate requires.
    delete projected.pull_request;
    projected.issue = {
      ...(isPlainObject(issue) ? issue : {}),
      pull_request: payload.pull_request,
    };
  }
  return projected;
}

/** Project a raw native Forgejo delivery onto the GitHub-shaped envelope the
 * #728 normalizer accepts. See the module header for the security posture.
 *
 * @param eventHeader the (trusted, HMAC-verified, shape-validated) value of
 *   the `X-Gitea-Event` header — the GROUPED event name.
 * @param eventTypeHeader the (trusted) value of the `X-Gitea-Event-Type`
 *   header — the specific type — or `""` when absent or invalid.
 * @param payload the parsed (untrusted) webhook body.
 * @param options the re-review trigger label; an absent/empty value falls back
 *   to the "ai-review" default.
 */
export function projectForgejoWebhookPayload(
  eventHeader: string,
  eventTypeHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  // The specific type: the dedicated header when it carries one, else the
  // grouped header (an undivided delivery's type defaults to its group).
  const specific = eventTypeHeader !== "" ? eventTypeHeader : eventHeader;

  // Rule 1 — PR sync: the older ungrouped `pull_request_sync` header, or the
  // grouped `pull_request` + `pull_request_sync` type. The header forces the
  // kind regardless of the payload's own `action`.
  if (eventHeader === "pull_request_sync" || specific === "pull_request_sync") {
    return { ...payload, name: "pull_request", action: "synchronize" };
  }

  // Rule 2 — grouped `pull_request`: dispatch on the payload's action.
  if (eventHeader === "pull_request") {
    const action = typeof payload.action === "string" ? payload.action : "";
    if (action === "synchronized") {
      return { ...payload, name: "pull_request", action: "synchronize" };
    }
    if (action === "reopened") {
      return { ...payload, name: "pull_request", action: "reopen" };
    }
    if (action === "label_updated") {
      return projectLabelEvent(payload, options);
    }
    // opened / closed / ready_for_review / ... pass through with the header as
    // the authoritative name; the normalizer maps the action as usual.
    return { ...payload, name: "pull_request" };
  }

  // Rule 4 — the ungrouped/older `pull_request_label` shape: always a label
  // event, regardless of the payload's action.
  if (eventHeader === "pull_request_label") {
    return projectLabelEvent(payload, options);
  }

  // Rule 5 — PR comments: the ungrouped `pull_request_comment`, the grouped
  // `issue_comment` + `pull_request_comment` type, and a plain `issue_comment`
  // all normalize to the GitHub `issue_comment` envelope.
  if (
    eventHeader === "issue_comment" ||
    eventHeader === "pull_request_comment" ||
    specific === "pull_request_comment"
  ) {
    return projectCommentEvent(payload);
  }

  // Rule 6 — anything else: pass through with the (trusted) header as name.
  return { ...payload, name: eventHeader };
}
