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
// `X-Gitea-Event-Type` headers are UNAUTHENTICATED HINTS, not authenticated
// facts — `signature.ts` verifies the HMAC over the RAW BODY ONLY, so a
// captured, still-valid delivery can be replayed byte-for-byte with CHANGED
// headers (#1024). Both headers are shape-validated by the handler before this
// projection runs; shape validation is NOT cryptographic authentication. Only
// these headers (never a payload field) decide the projected `name`. The
// signed body's own `action` is the authoritative statement of WHAT HAPPENED,
// so every hint below is gated on COMPATIBILITY with it: a hint may refine a
// projection the signed body already authorizes and can never rewrite one, and
// an incompatible hint is simply not forced. A captured terminal delivery
// (`action: "closed"`) replayed with forged sync headers therefore stays
// `pr_merged`/`pr_closed` instead of being reclassified into a scheduleable
// `synchronize` (which would mint a review generation), and a forged label or
// comment hint cannot synthesize a `label` or re-nest a PR into a follow-up.
// The payload is UNTRUSTED: no untrusted string is ever copied into a
// synthesized field. The only value the projection synthesizes is the trusted
// rereview-label constant (the operator-configured trigger label, or the
// "ai-review" default) — it is matched byte-for-byte against the payload's
// `pull_request.labels` and re-emitted as that trusted constant, never as a
// copy of the payload text, so a hostile label cannot forge the trigger. The
// projection is pure: it never throws, never mutates the input, and always
// returns a fresh object with `name` set. An unrecognized shape falls through to
// `{ ...payload, name: <the name the helper authorizes> }` — for every family
// except the check/status one, exactly the behavior the handler had before this
// module existed — and a hint incompatible with the signed action is
// never forced: it degrades to the grouped rule for its header, or to that same
// passthrough.
//
// Hints and the signed action each one REQUIRES (a hint naming the legacy
// ungrouped header works the same way; the grouped `pull_request` deliveries
// need no hint at all — their own action decides):
//   pull_request_sync    -> name `pull_request`, action `synchronized`/`synchronize`
//   pull_request_label   -> name `pull_request_label`, action `label_updated`
//   pull_request_comment -> name `issue_comment`, action `created`
//
// The check/status family is closed here too (#1102): a `check_run`/
// `check_suite`/`status` GROUP header is honored as a passthrough ONLY when
// the SIGNED body carries the shape that name requires (the event-layer
// predicate `carriesCheckUpdateShape`: a top-level `check_run`/`check_suite`
// object, or the top-level `sha`/`state`/`context` triple Forgejo's native
// commit-status delivery carries). Otherwise the projected `name` is the fixed
// literal `unknown` — never the forged family name, so the normalizer can
// never reach the scheduleable `check_update` kind from a header alone. The
// `X-Gitea-Event-Type` header is deliberately NOT consulted for this family (as
// for every non-PR family: only the group header ever reaches the envelope).
// Forgejo check runs remain a declared capability degradation
// (`capabilities.ts` `checkRuns: false`), so the required shape drops no real
// Forgejo delivery.
//
// Failure mode is fail-closed throughout: a rejected hint, an unrecognizable
// label, or an unrecognizable comment projects to a shape the normalizer maps
// to `unknown` — the handler still acks (202) and forwards it, and the
// kind-gating consumer (dispatch) drops unknown kinds; only a null
// normalization is acked 200-ignored.

import { carriesCheckUpdateShape } from "../events/normalize.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The check/status family names: the group headers that reach the envelope as
 * a plain passthrough hint but whose kind is only reachable when the SIGNED
 * body carries the matching shape (#1102). */
const CHECK_FAMILY_NAMES: ReadonlySet<string> = new Set(["check_run", "check_suite", "status"]);

/** The name the envelope may carry for a passthrough hint: the group header
 * itself, EXCEPT for the check/status family, where the header alone is not
 * authority — the signed body must carry that group's shape (the event layer's
 * `carriesCheckUpdateShape`), or the name degrades to the fixed literal
 * `unknown` that `mapKind` already maps to `unknown`.
 *
 * Fail-closed on a throw: the predicate does NOT swallow a hostile accessor
 * (the normalizer's contract is that such a body drops the whole event), and
 * this helper is the boundary that must never throw — its own try/catch takes
 * the SAME degraded answer. Load-bearing in the catch ladder below: the
 * last-resort twin calls this helper too, so an unguarded throw there would
 * escape the projection. The `unknown` literal is never synthesized from
 * untrusted input — it is a fixed constant. */
function passthroughName(eventHeader: string, payload: Record<string, unknown>): string {
  if (CHECK_FAMILY_NAMES.has(eventHeader)) {
    try {
      if (!carriesCheckUpdateShape(eventHeader, payload)) return "unknown";
    } catch {
      return "unknown";
    }
  }
  return eventHeader;
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
  * sentinel `""` (which the normalizer maps to `unknown` — still acked 202
 * and forwarded, dropped by the kind-gating consumer; only a null
 * normalization is 200-ignored).
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
 * @param eventHeader the (UNAUTHENTICATED, shape-validated) value of the
 *   `X-Gitea-Event` header — the GROUPED event name. It decides the projected
 *   `name`, but only as a hint: it may not override the signed payload action.
 * @param eventTypeHeader the (UNAUTHENTICATED, shape-validated) value of the
 *   `X-Gitea-Event-Type` header — the specific type — or `""` when absent or
 *   invalid. Likewise a hint: honored only when the signed action authorizes it.
 * @param payload the parsed (untrusted) webhook body. Its own `action` is
 *   authoritative — it is inside the HMAC, the headers are not.
 * @param options the re-review trigger label; an absent/empty value falls back
 *   to the "ai-review" default.
 */
export function projectForgejoWebhookPayload(
  eventHeader: string,
  eventTypeHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  try {
    // The specific type: the dedicated header when it carries one, else the
    // grouped header (an undivided delivery's type defaults to its group).
    const specific = eventTypeHeader !== "" ? eventTypeHeader : eventHeader;

    // The SIGNED action — the one authenticated statement of what happened.
    // Every hint below is gated on it, so a header can never rewrite a signed
    // `closed` into a scheduleable `synchronize` (#1024).
    const action = typeof payload.action === "string" ? payload.action : "";

    // The effective GROUP for the grouped rule below: the grouped header, with
    // the legacy ungrouped `pull_request_sync` header mapped to the group it
    // belongs to, so a rejected sync hint degrades to the same grouped
    // `pull_request` dispatch a grouped header gets (signed action preserved).
    const group = eventHeader === "pull_request_sync" ? "pull_request" : eventHeader;

    // Rule 1 — PR sync: the older ungrouped `pull_request_sync` header, or the
    // grouped `pull_request` + `pull_request_sync` type. Honored ONLY when the
    // signed action is the sync action (native `synchronized` or the
    // GitHub-vocabulary `synchronize`). Otherwise the hint is NOT forced and the
    // grouped rule below decides from the signed action alone — so a captured
    // terminal delivery replayed with a forged sync header keeps its own action.
    if (eventHeader === "pull_request_sync" || specific === "pull_request_sync") {
      if (action === "synchronized" || action === "synchronize") {
        return { ...payload, name: "pull_request", action: "synchronize" };
      }
    }

    // Rule 2 — grouped `pull_request`: dispatch on the SIGNED action, which is
    // authoritative here too (the header only supplies the name).
    if (group === "pull_request") {
      if (action === "synchronized") {
        return { ...payload, name: "pull_request", action: "synchronize" };
      }
      if (action === "reopened") {
        return { ...payload, name: "pull_request", action: "reopen" };
      }
      if (action === "label_updated") {
        return projectLabelEvent(payload, options);
      }
      // opened / closed / ready_for_review / ... pass through with the header
      // as the authoritative name; the normalizer maps the action as usual.
      return { ...payload, name: "pull_request" };
    }

    // Rule 4 — the ungrouped/older `pull_request_label` group. Honored ONLY
    // when the signed action is `label_updated`; otherwise it falls through to
    // the generic passthrough (whose name the normalizer maps to `unknown`), so a
    // forged label hint on a replayed non-label body can neither project to
    // `labeled` nor synthesize a trigger `label`. The type header alone is not a
    // label hint: a grouped `pull_request` delivery is already covered by the
    // signed-action dispatch above, so consulting `pull_request_label` here
    // would only let an unauthenticated type header re-group an unrelated
    // delivery.
    if (eventHeader === "pull_request_label") {
      if (action === "label_updated") {
        return projectLabelEvent(payload, options);
      }
    }

    // Rule 5 — PR comments: the ungrouped `pull_request_comment`, the grouped
    // `issue_comment` + `pull_request_comment` type, and a plain `issue_comment`
    // all normalize to the GitHub `issue_comment` envelope — but only when the
    // signed action is `created`. Otherwise the generic passthrough leaves the
    // top-level `pull_request` where the signed body put it, so a forged comment
    // hint cannot re-nest it into a `follow_up`-shaped `issue.pull_request`.
    if (
      eventHeader === "issue_comment" ||
      eventHeader === "pull_request_comment" ||
      specific === "pull_request_comment"
    ) {
      if (action === "created") {
        return projectCommentEvent(payload);
      }
    }

    // Rule 6 — anything else, and every hint rejected above as incompatible with
    // the signed body: pass through with the header as name — EXCEPT the
    // check/status family (`check_run`/`check_suite`/`status`), which
    // `passthroughName` honors ONLY when the SIGNED body carries the shape that
    // name requires. A captured delivery replayed byte-for-byte under a forged
    // family header (the HMAC covers the raw body only) carries some other
    // shape, so its projected name degrades to the fixed literal `unknown` —
    // never the forged family name, and never a name that could reach the
    // scheduleable `check_update` kind from a header alone. The
    // `X-Gitea-Event-Type` header is deliberately NOT consulted for that
    // family: for every non-PR family only the group header ever reaches the
    // envelope, and a second unauthenticated hint would only widen the forgery
    // surface.
    return { ...payload, name: passthroughName(eventHeader, payload) };
  } catch {
    // Fail closed, mirroring the normalizeEvent try/catch: any throw degrades
    // to the passthrough; a throwing copy falls back to the bare hint name
    // (through the SAME helper, so a mid-projection throw can never resurrect a
    // forged check/status family name).
    try {
      return { ...payload, name: passthroughName(eventHeader, payload) };
    } catch {
      return { name: passthroughName(eventHeader, payload) };
    }
  }
}
