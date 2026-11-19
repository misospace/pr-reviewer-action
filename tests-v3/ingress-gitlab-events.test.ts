import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  computeGitLabWebhookSignatureHeader,
  createGitLabWebhookHandler,
  dispatchGitLabWebhookEvent,
  parseGitLabWebhookEvent,
  projectGitLabWebhookPayload,
  verifyGitLabWebhookDelivery,
  type GitLabWebhookDelivery,
} from "../src/ingress/gitlab-events.js";
import { normalizeGitHubEvent, normalizeGitLabEvent } from "../src/events/normalize.js";
import type { CanonicalForgeEvent } from "../src/events/types.js";

// Legacy SECRET mode: the configured secret is sent verbatim in X-Gitlab-Token.
const TOKEN = "gitlab-webhook-secret-0123456789";
// SIGNING mode (Standard Webhooks): `whsec_` + base64 HMAC key.
const SIGNING_SECRET = `whsec_${Buffer.from("signing-key-material-0123456789ab").toString("base64")}`;
const WEBHOOK_ID = "whtest_01JGABCDEF0123";
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const PATH = "group/sub/project";
const ACTOR = "bob";
const AUTHOR = "alice";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sig(id: string, timestamp: number | string, body: string, secret: string = SIGNING_SECRET): string {
  return computeGitLabWebhookSignatureHeader(secret, id, timestamp, body);
}

/** Well-formed signing-mode headers (fresh timestamp) for `body`. */
function signedHeaders(body: string, overrides: Record<string, string> = {}): Record<string, string> {
  const ts = String(nowSec());
  return {
    "webhook-id": WEBHOOK_ID,
    "webhook-timestamp": ts,
    "webhook-signature": sig(WEBHOOK_ID, ts, body),
    ...overrides,
  };
}

/** A realistic GitLab merge-request payload shape (object_attributes carries
 * title/description/branches that the projection must NEVER copy). */
function mrAttrs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 4,
    id: 99,
    source_project_id: 100,
    target_project_id: 100,
    last_commit: { id: HEAD, message: "feat: the thing" },
    work_in_progress: false,
    state: "opened",
    action: "open",
    title: "Add the thing",
    description: "do-not-leak-description",
    source_branch: "feature",
    target_branch: "main",
    url: "https://gitlab.example/group/sub/project/-/merge_requests/4",
    ...overrides,
  };
}

function mrPayload(
  attrs: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { name: "Bob", username: ACTOR },
    project: { id: 100, path_with_namespace: PATH },
    object_attributes: mrAttrs(attrs),
    repository: { name: "project", url: "git@gitlab.example:group/sub/project.git" },
    ...root,
  };
}

/** A realistic GitLab note payload shape: stock MR-note deliveries DO carry
 * `object_attributes.action` (`create` / `update`); the note body lives at
 * object_attributes.note and the MR at top-level `merge_request`
 * (object_attributes carries noteable_id, NOT the iid). */
function notePayload(
  attrs: Record<string, unknown> = {},
  root: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    object_kind: "note",
    event_type: "note",
    user: { name: "Bob", username: ACTOR },
    project: { id: 100, path_with_namespace: PATH },
    object_attributes: {
      id: 301,
      note: "do-not-leak-note-body",
      noteable_type: "MergeRequest",
      noteable_id: 99,
      action: "create",
      author: { username: AUTHOR },
      ...attrs,
    },
    merge_request: { id: 99, iid: 4, title: "Add the thing" },
    ...root,
  };
}

function project(
  eventHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  return projectGitLabWebhookPayload(eventHeader, payload, options);
}

// --- authentication ----------------------------------------------------------

test("SECRET mode: the token header is the secret verbatim; exact match accepts", () => {
  const body = '{"object_kind":"merge_request"}';
  assert.equal(verifyGitLabWebhookDelivery(TOKEN, { tokenHeader: TOKEN }, body), true);
  assert.equal(verifyGitLabWebhookDelivery(TOKEN, { tokenHeader: `${TOKEN}x` }, body), false);
  assert.equal(verifyGitLabWebhookDelivery(TOKEN, { tokenHeader: TOKEN.slice(0, -1) }, body), false);
  assert.equal(verifyGitLabWebhookDelivery(TOKEN, {}, body), false);
  assert.equal(verifyGitLabWebhookDelivery(TOKEN, { tokenHeader: [TOKEN] }, body), false, "duplicate header");
});

test("auth fails closed: empty secret accepts nothing; arrays are refused in both modes", () => {
  const body = "{}";
  assert.equal(verifyGitLabWebhookDelivery("", { tokenHeader: "" }, body), false, "empty token, empty secret");
  assert.equal(verifyGitLabWebhookDelivery("", { tokenHeader: TOKEN }, body), false, "empty secret accepts the right token");
  assert.equal(verifyGitLabWebhookDelivery("", signedAuth(WEBHOOK_ID, String(nowSec()), sig(WEBHOOK_ID, nowSec(), body), body), body), false, "empty secret accepts nothing in signing shape");
  assert.equal(
    verifyGitLabWebhookDelivery(SIGNING_SECRET, { webhookIdHeader: [WEBHOOK_ID], webhookTimestampHeader: String(nowSec()), webhookSignatureHeader: sig(WEBHOOK_ID, nowSec(), body) }, body),
    false,
    "duplicate webhook-id array",
  );
  assert.equal(
    verifyGitLabWebhookDelivery(SIGNING_SECRET, { webhookIdHeader: WEBHOOK_ID, webhookTimestampHeader: String(nowSec()), webhookSignatureHeader: [sig(WEBHOOK_ID, nowSec(), body)] }, body),
    false,
    "duplicate webhook-signature array",
  );
});

function signedAuth(id: string, ts: string, signature: string, _body: string): Record<string, string> {
  return { webhookIdHeader: id, webhookTimestampHeader: ts, webhookSignatureHeader: signature };
}

test("SIGNING mode: a valid single v1 signature over {id}.{timestamp}.{body} accepts", () => {
  const body = '{"object_kind":"merge_request"}';
  const ts = String(nowSec());
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, ts, sig(WEBHOOK_ID, ts, body), body), body), true);
});

test("SIGNING mode: multiple space-separated entries, valid one second, accept", () => {
  const body = "{}";
  const ts = String(nowSec());
  const header = `v1,${Buffer.from("wrong-key-material!!", "utf8").toString("base64")} ${sig(WEBHOOK_ID, ts, body)}`;
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, ts, header, body), body), true);
});

test("SIGNING mode: tampered body, wrong token, and malformed inputs are refused", () => {
  const body = '{"object_kind":"merge_request"}';
  const ts = String(nowSec());
  const signature = sig(WEBHOOK_ID, ts, body);
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, ts, signature, body), body), true);
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, ts, signature, body.slice(0, -2)), body.slice(0, -2)), false, "tampered body");
  assert.equal(verifyGitLabWebhookDelivery("whsec_" + Buffer.from("other-key-material-9876543210cd").toString("base64"), signedAuth(WEBHOOK_ID, ts, signature, body), body), false, "wrong signing token");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth("other-id", ts, signature, body), body), false, "id is inside the HMAC input");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, String(nowSec() + 1), signature, body), body), false, "timestamp is inside the HMAC input");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, ts, signature.slice(3), body), body), false, "bare base64 without v1, prefix");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, ts, `v2,${signature.slice(3)}`, body), body), false, "unknown version");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth("", ts, signature, body), body), false, "empty webhook-id");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth("x".repeat(129), ts, signature, body), body), false, "over-long webhook-id");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth("bad\tid", ts, signature, body), body), false, "non-printable webhook-id");
});

test("SIGNING mode: missing webhook-id / timestamp / signature are refused", () => {
  const body = "{}";
  const ts = String(nowSec());
  const signature = sig(WEBHOOK_ID, ts, body);
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, { webhookTimestampHeader: ts, webhookSignatureHeader: signature }, body), false, "missing id");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, { webhookIdHeader: WEBHOOK_ID, webhookSignatureHeader: signature }, body), false, "missing timestamp");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, { webhookIdHeader: WEBHOOK_ID, webhookTimestampHeader: ts }, body), false, "missing signature");
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, signedAuth(WEBHOOK_ID, "not-a-number", signature, body), body), false, "non-numeric timestamp");
});

test("SIGNING mode: the ±300s replay bound with an injected clock", () => {
  const body = "{}";
  const NOW_MS = 1_780_000_000_500;
  const now = Math.floor(NOW_MS / 1000);
  const within = (offset: number): boolean =>
    verifyGitLabWebhookDelivery(
      SIGNING_SECRET,
      signedAuth(WEBHOOK_ID, String(now + offset), sig(WEBHOOK_ID, now + offset, body), body),
      body,
      { nowMs: NOW_MS },
    );
  assert.equal(within(0), true);
  assert.equal(within(300), true, "+300s is inside the bound");
  assert.equal(within(-300), true, "-300s is inside the bound");
  assert.equal(within(301), false, "+301s is outside");
  assert.equal(within(-301), false, "-301s is outside");
});

test("modes are EXCLUSIVE by token shape: neither header works outside its mode", () => {
  const body = "{}";
  const ts = String(nowSec());
  // SIGNING mode: X-Gitlab-Token verbatim (even the signing token itself) does
  // NOT authenticate without a valid webhook-signature.
  assert.equal(verifyGitLabWebhookDelivery(SIGNING_SECRET, { tokenHeader: SIGNING_SECRET }, body), false);
  // SECRET mode: a structurally perfect webhook signature does not authenticate.
  assert.equal(
    verifyGitLabWebhookDelivery(TOKEN, signedAuth(WEBHOOK_ID, ts, sig(WEBHOOK_ID, ts, body, TOKEN), body), body),
    false,
  );
  // And the legacy hex form is dead: the estimated-signature header is not read.
  assert.equal(verifyGitLabWebhookDelivery(TOKEN, { tokenHeader: TOKEN }, body), true);
});

test("the signing twin tracks id, timestamp, body, and token", () => {
  const body = '{"a":1}';
  const ts = nowSec();
  const s1 = sig("id-1", ts, body);
  assert.notEqual(s1, sig("id-2", ts, body));
  assert.notEqual(s1, sig("id-1", ts + 1, body));
  assert.notEqual(s1, sig("id-1", ts, body + " "));
  assert.notEqual(s1, sig("id-1", ts, body, "whsec_" + Buffer.from("zz").toString("base64")));
  assert.match(s1, /^v1,[A-Za-z0-9+/]+={0,3}$/);
});

// --- projection / parse ------------------------------------------------------

test("MR open: the envelope carries only the documented synthesized fields", () => {
  const envelope = project("Merge Request Hook", mrPayload());
  assert.equal(envelope.name, "pull_request");
  assert.equal(envelope.action, "opened");
  assert.deepEqual(envelope.repository, { full_name: PATH });
  assert.deepEqual(envelope.sender, { login: ACTOR });
  assert.equal("installation" in envelope, false, "GitLab has no installation id — never synthesized");
  const rendered = JSON.stringify(envelope);
  // Untrusted payload content never reaches the envelope.
  assert.equal(rendered.includes("do-not-leak-description"), false);
  assert.equal(rendered.includes("Add the thing"), false);
  assert.equal(rendered.includes("feature"), false);
});

test("parity: a GitLab MR-open projects to the SAME canonical event as the GitHub envelope", () => {
  // The repo here is TWO segments, not the brief's "group/sub/project":
  // normalizeGitHubEvent's grammar is EXACTLY one slash, so it nulls any nested
  // path and field-for-field parity on a nested name is arithmetically
  // impossible. Two segments are valid under BOTH grammars; the nested GitLab
  // grammar is pinned by its own test below.
  const gitlabEnvelope = project("Merge Request Hook", mrPayload({}, {
    project: { id: 100, path_with_namespace: "Group/Widgets" },
  }));
  const gitlabEvent = normalizeGitLabEvent(gitlabEnvelope);
  const ghEnvelope = {
    name: "pull_request",
    action: "opened",
    repository: { full_name: "group/widgets" },
    sender: { login: ACTOR },
    pull_request: {
      number: 4,
      id: 99,
      draft: false,
      head: { sha: HEAD, repo: { full_name: "group/widgets" } },
      base: { sha: "", repo: { full_name: "group/widgets" } },
      user: { login: ACTOR },
    },
  };
  const ghEvent = normalizeGitHubEvent(ghEnvelope);
  assert.ok(gitlabEvent !== null);
  assert.ok(ghEvent !== null);
  assert.equal(gitlabEvent.platform, "gitlab");
  assert.deepEqual(gitlabEvent, { ...ghEvent, platform: "gitlab" });
});

test("nested project paths: three segments accepted; stray slashes rejected; case lowered", () => {
  const nested = parseGitLabWebhookEvent("Merge Request Hook", mrPayload({}, {
    project: { id: 100, path_with_namespace: " Group/Subgroup/Project " },
  }));
  assert.equal(nested?.repoFullName, "group/subgroup/project");
  for (const bad of ["/group/sub/project", "group//sub/project", "group/sub/project/"]) {
    assert.equal(
      parseGitLabWebhookEvent("Merge Request Hook", mrPayload({}, {
        project: { id: 100, path_with_namespace: bad },
      })),
      null,
      `${bad} must reject`,
    );
  }
});

test("action mapping: open/reopen/close/merge/approval family and unknown actions", () => {
  const kind = (attrs: Record<string, unknown>): unknown =>
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload(attrs))?.kind;
  assert.equal(kind({ action: "open" }), "pr_opened");
  assert.equal(kind({ action: "reopen" }), "pr_reopened");
  assert.equal(kind({ action: "close" }), "pr_closed");
  assert.equal(kind({ action: "merge" }), "pr_merged");
  assert.equal(kind({ action: "approval" }), "unknown", "approval never mints a review generation");
  assert.equal(kind({ action: "approved" }), "unknown");
  assert.equal(kind({ action: "unapproved" }), "unknown");
  assert.equal(kind({ action: "unapproval" }), "unknown");
  assert.equal(kind({ action: "something-else" }), "unknown");
  assert.equal(kind({ action: undefined }), "unknown");
});

test("merge sets the normalizer's merged signal; close does not", () => {
  const envelope = project("Merge Request Hook", mrPayload({ action: "merge" }));
  const pr = envelope.pull_request as Record<string, unknown>;
  assert.equal(pr.merged, true);
  const closed = project("Merge Request Hook", mrPayload({ action: "close" }));
  assert.equal((closed.pull_request as Record<string, unknown>).merged, undefined);
});

test("update with new commits (well-formed oldrev) is synchronize", () => {
  const event = parseGitLabWebhookEvent("Merge Request Hook", mrPayload({
    action: "update",
    oldrev: OLD_HEAD,
  }));
  assert.equal(event?.kind, "synchronize");
  // A non-SHA oldrev is not commit evidence.
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ action: "update", oldrev: "not-a-sha" }))?.kind,
    "unknown",
  );
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ action: "update", oldrev: "abc12" }))?.kind,
    "unknown",
    "under 7 hex chars",
  );
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ action: "update", oldrev: 12345 }))?.kind,
    "unknown",
    "non-string",
  );
  // Uppercase hex is still a SHA for the gate.
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ action: "update", oldrev: OLD_HEAD.toUpperCase() }))?.kind,
    "synchronize",
  );
});

// GitLab's `changes` lives at the payload ROOT, not inside object_attributes.
function updatePayload(
  root: Record<string, unknown>,
  attrs: Record<string, unknown> = {},
): Record<string, unknown> {
  return mrPayload({ action: "update", ...attrs }, root);
}

test("update title-only (no oldrev, no labels change) is unknown", () => {
  const event = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({ changes: { title: { previous: "old", current: "new" } } }),
  );
  assert.equal(event?.kind, "unknown");
});

/** A real GitLab label object exactly as the webhook contract serializes it:
 * `{ id, title, color, project_id, created_at, updated_at, template,
 * description, type, group_id }` — the name is `title`, never `name`. */
function gitlabLabel(id: number, title: string): Record<string, unknown> {
  return {
    id,
    title,
    color: "#123123",
    project_id: 14,
    created_at: "2013-12-03T17:15:43.000Z",
    updated_at: "2013-12-03T17:15:43.000Z",
    template: false,
    description: `${title} related issues`,
    type: "ProjectLabel",
    group_id: 41,
  };
}

test("update adding the rereview label (object-form changes, documented title shape) is rereview_label", () => {
  const event = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({
      changes: { labels: { previous: [gitlabLabel(206, "API")], current: [gitlabLabel(206, "API"), gitlabLabel(205, "ai-review")] } },
    }),
  );
  assert.equal(event?.kind, "rereview_label");
  assert.equal(event?.labelName, "ai-review");
});

test("update adding the rereview label (array-form changes, minus previous)", () => {
  const hit = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({
      changes: [{ key: "labels", previous: [gitlabLabel(1, "docs")], current: [gitlabLabel(1, "docs"), gitlabLabel(2, "ai-review")] }],
    }),
  );
  assert.equal(hit?.kind, "rereview_label");
  // present-but-not-added (already in previous) is NOT an add.
  const noAdd = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({
      changes: [{ key: "labels", previous: [gitlabLabel(2, "ai-review")], current: [gitlabLabel(2, "ai-review"), gitlabLabel(1, "docs")] }],
    }),
  );
  assert.equal(noAdd?.kind, "unknown");
});

test("label objects use the documented title field; name-only is the tolerated REST alias", () => {
  // The regression: the documented webhook object shape carries `title`.
  const titled = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({ changes: { labels: { previous: [], current: [gitlabLabel(205, "ai-review")] } } }),
  );
  assert.equal(titled?.kind, "rereview_label");
  // title wins when both fields disagree with the trigger.
  const disagree = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({ changes: { labels: { previous: [], current: [{ title: "ai-review", name: "other" }] } } }),
  );
  assert.equal(disagree?.kind, "rereview_label");
  // A name-only entry remains accepted as the REST-API alias.
  const named = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({ changes: { labels: { previous: [], current: [{ name: "ai-review" }] } } }),
  );
  assert.equal(named?.kind, "rereview_label");
  // An object with neither field contributes nothing.
  const bare = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload({ changes: { labels: { previous: [], current: [{ id: 9, color: "#ffffff" }] } } }),
  );
  assert.equal(bare?.kind, "unknown");
});

test("synchronize is checked before the labels branch (oldrev wins over a label add)", () => {
  const event = parseGitLabWebhookEvent(
    "Merge Request Hook",
    updatePayload(
      { changes: { labels: { previous: [], current: ["ai-review"] } } },
      { oldrev: OLD_HEAD },
    ),
  );
  assert.equal(event?.kind, "synchronize");
});

test("the label trigger is byte-exact, case-sensitive, and operator-configurable", () => {
  const changed = (current: unknown[]): Record<string, unknown> =>
    updatePayload({ changes: { labels: { previous: [], current } } });
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", changed([{ name: "AI-Review" }]))?.kind, "unknown");
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", changed([{ name: " ai-review" }]))?.kind, "unknown");
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", changed([{ name: "rerun-review" }]))?.kind, "unknown");
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", changed([{ name: "rerun-review" }]), {
      rereviewLabel: "rerun-review",
    })?.kind,
    "rereview_label",
  );
  // The synthesized label is the trusted constant, not a payload entry copy.
  const envelope = project("Merge Request Hook", changed(["ai-review"]), {});
  assert.deepEqual(envelope.label, { name: "ai-review" });
});

test("draft is draft===true or work_in_progress===true", () => {
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ work_in_progress: true }))?.draft, true);
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ work_in_progress: false, draft: true }))?.draft, true);
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ work_in_progress: "yes" }))?.draft, false);
});

test("head sha requires a well-formed last_commit; otherwise the empty sentinel", () => {
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload())?.headSha, HEAD);
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ last_commit: { message: "no id" } }))?.headSha, "");
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ last_commit: "a".repeat(40) }))?.headSha, "");
});

test("fork: source_project_id equal to the project id is not a fork; differing or missing is", () => {
  assert.equal(parseGitLabWebhookEvent("Merge Request Hook", mrPayload())?.fork, false, "source == project");
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ source_project_id: 101 }))?.fork,
    true,
    "source != project (target equality never overrides a disagreeing source)",
  );
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({ source_project_id: undefined }))?.fork,
    false,
    "missing source falls back to target == project",
  );
  assert.equal(
    parseGitLabWebhookEvent("Merge Request Hook", mrPayload({
      source_project_id: undefined,
      target_project_id: undefined,
    }))?.fork,
    true,
    "no ids at all → conservative fork",
  );
});

// --- note events (follow-ups) ------------------------------------------------

test("note on a MergeRequest becomes follow_up with the comment id as reference", () => {
  const event = parseGitLabWebhookEvent("Note Hook", notePayload());
  assert.ok(event !== null);
  assert.equal(event.kind, "follow_up");
  assert.equal(event.prNumber, 4, "MR iid, synthesized from the signed payload");
  assert.equal(event.eventReference, "301");
  assert.equal(event.repoFullName, PATH);
  assert.equal(event.actor, AUTHOR, "the note author wins over the envelope sender");
  assert.equal(event.platform, "gitlab");
});

test("the note BODY never enters the envelope", () => {
  const envelope = project("Note Hook", notePayload());
  assert.equal(JSON.stringify(envelope).includes("do-not-leak-note-body"), false);
  assert.equal(JSON.stringify(envelope).includes("Add the thing"), false);
});

test("note gate: non-MergeRequest noteable, non-create action, or unresolvable iid degrade to unknown", () => {
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({ noteable_type: "Issue" })), null);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({ noteable_type: "Commit" })), null);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({ action: "update" })), null);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({ action: undefined })), null);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({ action: "new" })), null, "the docs action is create, not new");
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({}, { merge_request: undefined })), null);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({}, { merge_request: { iid: 0 } })), null);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({}, { merge_request: { iid: "4" } })), null);
});

test("note iid precedence: object_attributes.iid, then merge_request.iid — never the instance-global merge_request.id", () => {
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({ iid: 7 }))?.prNumber, 7);
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({}, { merge_request: { iid: 9 } }))?.prNumber, 9);
  // The global `id` addresses a different id space than the project-scoped
  // iid; guessing with it could answer an unrelated merge request (#740 r).
  assert.equal(parseGitLabWebhookEvent("Note Hook", notePayload({}, { merge_request: { id: 42 } })), null);
});

// --- event-header hint gating ------------------------------------------------

test("a header/payload family disagreement degrades fail-closed and never re-routes", () => {
  // "Note Hook" over a signed merge_request payload must NOT mint a follow_up.
  assert.deepEqual(project("Note Hook", mrPayload()), { name: "unknown" });
  assert.equal(parseGitLabWebhookEvent("Note Hook", mrPayload()), null);
  // And the mirror: an MR header over a signed note payload does not mint one either.
  assert.deepEqual(project("Merge Request Hook", notePayload()), { name: "unknown" });
  // "Push Hook" over an MR payload: unknown, never a re-route.
  assert.deepEqual(project("Push Hook", mrPayload()), { name: "unknown" });
});

test("an unknown header makes no family claim; the signed payload still drives", () => {
  assert.equal(parseGitLabWebhookEvent("Pipeline Hook", mrPayload())?.kind, "pr_opened");
  assert.equal(parseGitLabWebhookEvent("System Hook", notePayload())?.kind, "follow_up");
});

test("non-MR kinds (push etc.) project to the unmapped shape but parse safely", () => {
  const push = { object_kind: "push", event_type: "push", project: { id: 1, path_with_namespace: PATH }, after: HEAD };
  assert.deepEqual(project("Push Hook", push), { name: "unknown" });
  assert.equal(parseGitLabWebhookEvent("Push Hook", push as Record<string, unknown>), null);
  assert.equal(parseGitLabWebhookEvent("Pipeline Hook", { object_kind: "pipeline" }), null);
});

test("the projection never throws and never mutates its input", () => {
  const hostile = {
    object_kind: "merge_request",
    get object_attributes() {
      throw new Error("hostile accessor");
    },
  };
  assert.deepEqual(project("Merge Request Hook", hostile), { name: "unknown" });
  const payload = mrPayload();
  const before = JSON.stringify(payload);
  project("Merge Request Hook", payload);
  project("Note Hook", payload);
  assert.equal(JSON.stringify(payload), before);
});

// --- dispatch core -------------------------------------------------------------

function delivery(body: string, extras: Partial<GitLabWebhookDelivery> = {}): GitLabWebhookDelivery {
  return {
    eventHeader: "Merge Request Hook",
    tokenHeader: TOKEN,
    rawBody: body,
    ...extras,
  };
}

/** SECRET-mode defaults overridden by signing-mode headers. */
function signedDelivery(body: string, headerOverrides: Record<string, string> = {}): GitLabWebhookDelivery {
  const h = signedHeaders(body, headerOverrides);
  return {
    eventHeader: "Merge Request Hook",
    webhookIdHeader: h["webhook-id"],
    webhookTimestampHeader: h["webhook-timestamp"],
    webhookSignatureHeader: h["webhook-signature"],
    rawBody: body,
  };
}

const MR_OPEN = JSON.stringify(mrPayload());

test("dispatch: accepted with the canonical kind over the token, and over the signature", async () => {
  const seen: CanonicalForgeEvent[] = [];
  const outcome = await dispatchGitLabWebhookEvent(delivery(MR_OPEN), {
    secret: TOKEN,
    onEvent: (event) => { seen.push(event); },
  });
  assert.deepEqual(outcome, { status: "accepted", kind: "pr_opened" });
  assert.equal(seen[0]?.platform, "gitlab");

  const sigOutcome = await dispatchGitLabWebhookEvent(signedDelivery(MR_OPEN), {
    secret: SIGNING_SECRET,
    onEvent: () => undefined,
  });
  assert.deepEqual(sigOutcome, { status: "accepted", kind: "pr_opened" });
});

test("dispatch: auth is verified before parse — malformed JSON sorts by auth state", async () => {
  const broken = '{"object_kind":"merge_request",';
  const withGoodSig = await dispatchGitLabWebhookEvent(signedDelivery(broken), {
    secret: SIGNING_SECRET,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(withGoodSig, { status: "invalid-payload" });
  const withBadSig = await dispatchGitLabWebhookEvent(
    signedDelivery(broken, { "webhook-signature": sig(WEBHOOK_ID, nowSec(), MR_OPEN) }),
    { secret: SIGNING_SECRET, onEvent: () => assert.fail("must not be called") },
  );
  assert.deepEqual(withBadSig, { status: "invalid-auth" }, "auth failure takes precedence");
});

test("dispatch: unauthenticated, empty-secret, and non-object payloads are refused", async () => {
  const noAuth = await dispatchGitLabWebhookEvent(delivery(MR_OPEN, { tokenHeader: undefined }), {
    secret: TOKEN,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(noAuth, { status: "invalid-auth" });
  const emptySecret = await dispatchGitLabWebhookEvent(delivery(MR_OPEN), {
    secret: "",
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(emptySecret, { status: "invalid-auth" });
  // A signing-mode delivery under a SECRET-mode config never authenticates.
  const sigUnderSecret = await dispatchGitLabWebhookEvent(signedDelivery(MR_OPEN), {
    secret: TOKEN,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(sigUnderSecret, { status: "invalid-auth" });
  const arrayBody = "[1,2,3]";
  const array = await dispatchGitLabWebhookEvent(delivery(arrayBody), {
    secret: TOKEN,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(array, { status: "invalid-payload" });
});

test("dispatch: ping is ignored before projection — by header and by payload kind", async () => {
  const byHeader = await dispatchGitLabWebhookEvent(
    delivery('{"object_kind":"ping"}', { eventHeader: "Ping" }),
    { secret: TOKEN, onEvent: () => assert.fail("must not be called") },
  );
  assert.deepEqual(byHeader, { status: "ignored" });
  const byBody = await dispatchGitLabWebhookEvent(
    delivery('{"object_kind":"ping","event_type":"ping"}', { eventHeader: "System Hook" }),
    { secret: TOKEN, onEvent: () => assert.fail("must not be called") },
  );
  assert.deepEqual(byBody, { status: "ignored" });
});

test("dispatch: an unmapped delivery with no resolvable repository is ignored, not retried", async () => {
  const body = JSON.stringify({ object_kind: "merge_request", object_attributes: { action: "open" } });
  const outcome = await dispatchGitLabWebhookEvent(delivery(body), {
    secret: TOKEN,
    onEvent: () => assert.fail("must not be called"),
  });
  assert.deepEqual(outcome, { status: "ignored" });
});

test("dispatch: a follow_up goes to the router and never to onEvent", async () => {
  const body = JSON.stringify(notePayload());
  const routed: CanonicalForgeEvent[] = [];
  const outcome = await dispatchGitLabWebhookEvent(
    delivery(body, { eventHeader: "Note Hook" }),
    {
      secret: TOKEN,
      onEvent: () => assert.fail("follow_up must not reach onEvent"),
      router: {
        handleEvent: async (event) => {
          routed.push(event);
          return { kind: "ignored" as const };
        },
      },
    },
  );
  assert.deepEqual(outcome, { status: "accepted", kind: "follow_up" });
  assert.equal(routed.length, 1);
});

test("dispatch: a throwing sink reports error and never rethrows", async () => {
  const outcome = await dispatchGitLabWebhookEvent(delivery(MR_OPEN), {
    secret: TOKEN,
    onEvent: () => { throw new Error("sink blew up"); },
  });
  assert.deepEqual(outcome, { status: "error" });
});

test("dispatch: a Buffer body verifies and parses the same as a string", async () => {
  const outcome = await dispatchGitLabWebhookEvent(
    { eventHeader: "Merge Request Hook", tokenHeader: TOKEN, rawBody: Buffer.from(MR_OPEN, "utf8") },
    { secret: TOKEN, onEvent: () => undefined },
  );
  assert.deepEqual(outcome, { status: "accepted", kind: "pr_opened" });
});

test("dispatch: the outcome never echoes the payload, the secret, or a header", async () => {
  const outcome = await dispatchGitLabWebhookEvent(
    delivery(MR_OPEN, { tokenHeader: "wrong", webhookSignatureHeader: "v1=garbage" }),
    { secret: SIGNING_SECRET, onEvent: () => assert.fail("must not be called") },
  );
  assert.equal(JSON.stringify(outcome), '{"status":"invalid-auth"}');
});

// --- HTTP handler (fake req/res: the full status contract, no socket) --------

interface HandlerResult {
  status: number;
  body: string;
}

function runHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  opts: { method?: string; headers?: Record<string, string | string[]>; body?: string },
): Promise<HandlerResult> {
  return new Promise<HandlerResult>((resolve) => {
    const req = Object.assign(new PassThrough(), {
      method: opts.method ?? "POST",
      headers: opts.headers ?? {},
    });
    const res = {
      statusCode: 0,
      setHeader(): void {},
      end(chunk?: unknown): void {
        resolve({ status: res.statusCode, body: chunk === undefined ? "" : String(chunk) });
      },
    };
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    if (opts.body !== undefined) req.end(opts.body);
    else req.end();
  });
}

const MR_HEADERS = {
  "x-gitlab-event": "Merge Request Hook",
  "x-gitlab-token": TOKEN,
};

test("handler: 405 for non-POST", async () => {
  const handler = createGitLabWebhookHandler({ secret: TOKEN, onEvent: () => undefined });
  const res = await runHandler(handler, { method: "GET", headers: MR_HEADERS });
  assert.equal(res.status, 405);
});

test("handler: 400 for a missing or shape-invalid event header (and it accepts spaces)", async () => {
  const events: CanonicalForgeEvent[] = [];
  const handler = createGitLabWebhookHandler({ secret: TOKEN, onEvent: (e) => { events.push(e); } });
  assert.equal((await runHandler(handler, { body: MR_OPEN })).status, 400, "absent");
  assert.equal(
    (await runHandler(handler, { headers: { "x-gitlab-event": "bad header!", "x-gitlab-token": TOKEN }, body: MR_OPEN })).status,
    400,
    "invalid shape",
  );
  assert.equal(
    (await runHandler(handler, { headers: { "x-gitlab-event": "x".repeat(129), "x-gitlab-token": TOKEN }, body: MR_OPEN })).status,
    400,
    "over 128 chars",
  );
  // The shape guard DOES accept GitLab's real spaced vocabulary.
  assert.equal((await runHandler(handler, { headers: MR_HEADERS, body: MR_OPEN })).status, 202);
  assert.equal(events.length, 1);
});

test("handler: 413 refuses an oversize body mid-stream and echoes nothing", async () => {
  const handler = createGitLabWebhookHandler({
    secret: TOKEN,
    maxBodyBytes: 32,
    onEvent: () => assert.fail("must not be called"),
  });
  const big = JSON.stringify(mrPayload({ description: "x".repeat(500) }));
  const res = await runHandler(handler, { headers: MR_HEADERS, body: big });
  assert.equal(res.status, 413);
  assert.equal(res.body.includes("x".repeat(500)), false);
});

test("handler: 401 when neither auth path carries the secret, without echoing either", async () => {
  const handler = createGitLabWebhookHandler({ secret: SIGNING_SECRET, onEvent: () => assert.fail("must not be called") });
  const res = await runHandler(handler, {
    headers: {
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": TOKEN,
      "webhook-id": WEBHOOK_ID,
      "webhook-timestamp": String(nowSec()),
      "webhook-signature": "v1=bm9wZQ== nope",
    },
    body: MR_OPEN,
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.includes(SIGNING_SECRET), false);
  assert.equal(res.body.includes("bm9wZQ"), false);
  assert.equal(res.body.includes(PATH), false);
});

test("handler: the signing-mode headers alone authenticate over the raw bytes", async () => {
  const events: CanonicalForgeEvent[] = [];
  const handler = createGitLabWebhookHandler({ secret: SIGNING_SECRET, onEvent: (e) => { events.push(e); } });
  const res = await runHandler(handler, {
    headers: { "x-gitlab-event": "Merge Request Hook", ...signedHeaders(MR_OPEN) },
    body: MR_OPEN,
  });
  assert.equal(res.status, 202);
  assert.equal(events[0]?.kind, "pr_opened");
});

test("handler: a token-authenticated delivery with malformed json or a non-object payload gets 400", async () => {
  const handler = createGitLabWebhookHandler({ secret: TOKEN, onEvent: () => undefined });
  assert.equal((await runHandler(handler, { headers: MR_HEADERS, body: "{" })).status, 400);
  assert.equal((await runHandler(handler, { headers: MR_HEADERS, body: "[1,2]" })).status, 400);
});

test("handler: 200-ignored for ping and for unmapped kinds", async () => {
  const events: CanonicalForgeEvent[] = [];
  const handler = createGitLabWebhookHandler({ secret: TOKEN, onEvent: (e) => { events.push(e); } });
  const pingRes = await runHandler(handler, {
    headers: { "x-gitlab-event": "Ping", "x-gitlab-token": TOKEN },
    body: '{"object_kind":"ping"}',
  });
  assert.deepEqual(pingRes, { status: 200, body: '{"status":"ignored"}' });
  const pushRes = await runHandler(handler, {
    headers: { "x-gitlab-event": "Push Hook", "x-gitlab-token": TOKEN },
    body: '{"object_kind":"push","project":{"id":1,"path_with_namespace":"g/p"}}',
  });
  assert.equal(pushRes.status, 200);
  assert.equal(events.length, 0);
});

test("handler: 202 with the canonical kind, and the body never echoes the payload", async () => {
  const handler = createGitLabWebhookHandler({ secret: TOKEN, onEvent: () => undefined });
  const res = await runHandler(handler, { headers: MR_HEADERS, body: MR_OPEN });
  assert.deepEqual(res, { status: 202, body: '{"status":"accepted","kind":"pr_opened"}' });
});

test("handler: a follow_up reaches the router, and a throwing sink gets the fixed 500", async () => {
  const noteBody = JSON.stringify(notePayload());
  const routed: CanonicalForgeEvent[] = [];
  const routing = createGitLabWebhookHandler({
    secret: TOKEN,
    onEvent: () => assert.fail("follow_up must not reach onEvent"),
    router: {
      handleEvent: async (event) => {
        routed.push(event);
        return { kind: "ignored" as const };
      },
    },
  });
  const routedRes = await runHandler(routing, {
    headers: { "x-gitlab-event": "Note Hook", "x-gitlab-token": TOKEN },
    body: noteBody,
  });
  assert.equal(routedRes.status, 202);
  assert.equal(routed.length, 1);

  const throwing = createGitLabWebhookHandler({
    secret: TOKEN,
    onEvent: () => { throw new Error("sink blew up"); },
  });
  const res = await runHandler(throwing, { headers: MR_HEADERS, body: MR_OPEN });
  assert.deepEqual(res, { status: 500, body: '{"status":"internal error"}' });
});
