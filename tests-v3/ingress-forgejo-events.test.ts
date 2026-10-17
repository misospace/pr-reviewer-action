import test from "node:test";
import assert from "node:assert/strict";

import { projectForgejoWebhookPayload } from "../src/ingress/forgejo-events.js";
import { normalizeForgejoEvent } from "../src/events/normalize.js";

const DEFAULT_LABEL = "ai-review";

function project(
  eventHeader: string,
  eventTypeHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  return projectForgejoWebhookPayload(eventHeader, eventTypeHeader, payload, options);
}

// ---------------------------------------------------------------------------
// Rule 1 / 2 — PR sync
// ---------------------------------------------------------------------------

test("sync: grouped pull_request + type pull_request_sync on a synchronized body → synchronize", () => {
  const out = project("pull_request", "pull_request_sync", { action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("sync: grouped pull_request + action synchronized (no type header) → synchronize", () => {
  const out = project("pull_request", "", { action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("sync: older ungrouped pull_request_sync header + a synchronized action → synchronize", () => {
  const out = project("pull_request_sync", "", { action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("sync: the GitHub-vocabulary 'synchronize' action also satisfies the sync hint", () => {
  // Pinned on a non-PR group so the clause is observable: the sync hint alone
  // decides the name there (without it the delivery would keep `check_run`).
  const out = project("check_run", "pull_request_sync", { action: "synchronize" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("sync projection preserves the payload's pull_request object for the normalizer to resolve", () => {
  const pr = { number: 7, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } };
  const out = project("pull_request", "", { action: "synchronized", pull_request: pr });
  assert.equal(out.action, "synchronize");
  assert.equal(out.pull_request, pr);
});

// ---------------------------------------------------------------------------
// Rule 2 — PR reopen
// ---------------------------------------------------------------------------

test("reopen: grouped pull_request + action reopened → action reopen", () => {
  const out = project("pull_request", "", { action: "reopened", pull_request: { number: 7 } });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "reopen");
});

// ---------------------------------------------------------------------------
// Rule 2 / 3 / 4 — label
// ---------------------------------------------------------------------------

test("label: grouped pull_request + type pull_request_label + action label_updated fires on the trigger in pull_request.labels", () => {
  const out = project("pull_request", "pull_request_label", {
    action: "label_updated",
    pull_request: { labels: [{ name: "ai-review", color: "00ff00" }] },
  });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "labeled");
  assert.deepEqual(out.label, { name: "ai-review" });
});

test("label: ungrouped/older pull_request_label header + a label_updated action projects to labeled", () => {
  const out = project("pull_request_label", "", {
    action: "label_updated",
    pull_request: { labels: [{ name: "ai-review" }] },
  });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "labeled");
  assert.deepEqual(out.label, { name: "ai-review" });
});

test("label: a pull_request_label TYPE hint alone does not re-group an unrelated delivery", () => {
  const out = project("push", "pull_request_label", {
    action: "label_updated",
    pull_request: { labels: [{ name: "ai-review" }] },
  });
  // Only the ungrouped HEADER is a label hint. A type header may refine the
  // event it groups with (sync/comment), never re-group an unrelated delivery,
  // so the generic passthrough owns the name and the normalizer maps it to
  // `unknown`.
  assert.equal(out.name, "push");
  assert.equal(out.action, "label_updated");
  assert.equal("label" in out, false);
});

test("label: no trigger in pull_request.labels → label '' (normalizer maps to unknown)", () => {
  const out = project("pull_request", "", {
    action: "label_updated",
    pull_request: { labels: [{ name: "docs", color: "00ff00" }] },
  });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "labeled");
  assert.equal(out.label, "");
});

test("label: a usable top-level label is passed through unchanged (no scan)", () => {
  // A string label passes through as-is.
  assert.equal(project("pull_request", "", { action: "label_updated", label: "ai-review" }).label, "ai-review");
  // An object label with a string name passes through as-is (even a non-trigger label).
  assert.deepEqual(
    project("pull_request", "", { action: "label_updated", label: { name: "docs" } }).label,
    { name: "docs" },
  );
  // A non-usable top-level label (no string name) falls through to the scan.
  assert.deepEqual(
    project("pull_request", "", {
      action: "label_updated",
      label: { color: "red" },
      pull_request: { labels: [{ name: "ai-review" }] },
    }).label,
    { name: "ai-review" },
  );
});

test("label: matching is case-sensitive and byte-exact (no trim)", () => {
  const cases: Array<[string, boolean]> = [
    ["ai-review", true],
    ["AI-Review", false],
    ["ai-review ", false],
    [" ai-review", false],
  ];
  for (const [name, fires] of cases) {
    const out = project("pull_request", "", {
      action: "label_updated",
      pull_request: { labels: [{ name }] },
    });
    if (fires) {
      assert.deepEqual(out.label, { name: DEFAULT_LABEL }, name);
    } else {
      assert.equal(out.label, "", name);
    }
  }
});

test("label: matching honors the configured rereviewLabel; empty/absent falls back to the default", () => {
  const hit = project(
    "pull_request",
    "",
    { action: "label_updated", pull_request: { labels: [{ name: "rerun" }] } },
    { rereviewLabel: "rerun" },
  );
  assert.deepEqual(hit.label, { name: "rerun" });

  const miss = project(
    "pull_request",
    "",
    { action: "label_updated", pull_request: { labels: [{ name: "ai-review" }] } },
    { rereviewLabel: "rerun" },
  );
  assert.equal(miss.label, "");

  // An EMPTY option falls back to the "ai-review" default.
  const fallback = project(
    "pull_request",
    "",
    { action: "label_updated", pull_request: { labels: [{ name: "ai-review" }] } },
    { rereviewLabel: "" },
  );
  assert.deepEqual(fallback.label, { name: "ai-review" });
});

test("label: label_deleted / label_cleared are NOT projected to labeled", () => {
  for (const action of ["label_deleted", "label_cleared"]) {
    const out = project("pull_request", "", {
      action,
      pull_request: { labels: [{ name: "ai-review" }] },
    });
    // Not one of the special-cased actions → plain passthrough (name set,
    // original action preserved, no synthesized label).
    assert.equal(out.name, "pull_request");
    assert.equal(out.action, action);
    assert.equal("label" in out, false);
  }
});

test("label: a labels array of hostile entries (__proto__ / non-object / nested array) is safely ignored", () => {
  const out = project("pull_request", "", {
    action: "label_updated",
    pull_request: {
      labels: ["__proto__", { color: "red" }, ["nested", "array"], 42, null, undefined],
    },
  });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "labeled");
  assert.equal(out.label, "");
  // No prototype pollution from the "__proto__" array element.
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "color"), false);
});

// ---------------------------------------------------------------------------
// Rule 5 — comment
// ---------------------------------------------------------------------------

test("comment: grouped issue_comment + pull_request_comment moves the top-level pull_request into issue", () => {
  const payload = {
    action: "created",
    comment: { id: 55, user: { login: "dev" } },
    issue: { number: 7 },
    pull_request: { number: 7, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } },
  };
  const out = project("issue_comment", "pull_request_comment", payload);
  assert.equal(out.name, "issue_comment");
  // The top-level key is removed ENTIRELY (not left `undefined`).
  assert.equal(Object.hasOwn(out, "pull_request"), false);
  // It is moved into issue.pull_request; the issue's own fields are preserved.
  assert.deepEqual(out.issue, { number: 7, pull_request: payload.pull_request });
  // The top-level comment is left untouched (eventReference comes from it).
  assert.deepEqual(out.comment, { id: 55, user: { login: "dev" } });
});

test("comment: ungrouped pull_request_comment header also projects to issue_comment", () => {
  const payload = {
    action: "created",
    comment: { id: 55 },
    issue: { number: 7 },
    pull_request: { number: 7 },
  };
  const out = project("pull_request_comment", "", payload);
  assert.equal(out.name, "issue_comment");
  assert.equal(Object.hasOwn(out, "pull_request"), false);
  assert.equal((out.issue as { pull_request?: { number: number } }).pull_request?.number, 7);
});

test("comment: an issue-only comment (no top-level pull_request) is unchanged apart from name", () => {
  const payload = {
    action: "created",
    comment: { id: 9 },
    issue: { number: 3, title: "an issue" },
  };
  const out = project("issue_comment", "", payload);
  assert.equal(out.name, "issue_comment");
  assert.equal(Object.hasOwn(out, "pull_request"), false);
  assert.deepEqual(out.issue, { number: 3, title: "an issue" });
});

test("comment: a GitHub-shaped delivery (issue.pull_request present) is left untouched", () => {
  const payload = {
    action: "created",
    comment: { id: 1 },
    issue: { number: 7, pull_request: { url: "http://example/x" } },
  };
  const out = project("issue_comment", "pull_request_comment", payload);
  assert.equal(out.name, "issue_comment");
  assert.deepEqual(out.issue, { number: 7, pull_request: { url: "http://example/x" } });
  assert.equal(Object.hasOwn(out, "pull_request"), false);
});

test("comment: when issue.pull_request already exists the stray top-level pull_request is NOT moved", () => {
  const payload = {
    action: "created",
    comment: { id: 1 },
    issue: { number: 7, pull_request: { number: 7 } },
    pull_request: { number: 999 },
  };
  const out = project("issue_comment", "", payload);
  assert.equal(out.name, "issue_comment");
  // The existing issue.pull_request stays; the stray top-level is left in
  // place (the normalizer resolves the envelope origin → non-follow_up, fail closed).
  assert.deepEqual(out.issue, { number: 7, pull_request: { number: 7 } });
  assert.deepEqual(out.pull_request, { number: 999 });
});

// ---------------------------------------------------------------------------
// Rule 6 — passthrough
// ---------------------------------------------------------------------------

test("passthrough: an existing GitHub-vocabulary event passes through with only name set", () => {
  const payload = { action: "completed", check_run: { id: 1 }, repository: { full_name: "o/r" } };
  const out = project("check_run", "", payload);
  assert.equal(out.name, "check_run");
  assert.deepEqual(out.check_run, { id: 1 });
  assert.deepEqual(out.repository, { full_name: "o/r" });
  // Nothing else is synthesized.
  assert.deepEqual(out, { ...payload, name: "check_run" });
});

test("passthrough: an unknown event header passes through unchanged with only name set", () => {
  const payload = { foo: 1, bar: { baz: 2 } };
  const out = project("some_future_event", "", payload);
  assert.equal(out.name, "some_future_event");
  assert.deepEqual(out, { ...payload, name: "some_future_event" });
});

// ---------------------------------------------------------------------------
// Signed-replay regressions (#1024) — headers are unauthenticated HINTS
// ---------------------------------------------------------------------------
//
// `signature.ts` verifies the HMAC over the RAW BODY ONLY, so a captured,
// still-valid delivery can be replayed byte-for-byte with CHANGED event
// headers. The signed body's own action is therefore authoritative: a hint may
// refine a projection the signed body already authorizes, and a conflicting
// hint must degrade fail-closed — never mint a review generation, never
// rewrite a terminal action into a scheduleable one.

test("replay: a signed terminal body under forged sync headers keeps its own action", () => {
  // Grouped `pull_request` + `pull_request_sync` type, and the legacy ungrouped
  // `pull_request_sync` header — the two shapes a captured delivery can be
  // replayed under.
  const forged: Array<[string, string]> = [
    ["pull_request", "pull_request_sync"],
    ["pull_request_sync", ""],
  ];
  for (const [eventHeader, eventTypeHeader] of forged) {
    for (const extra of [{}, { merged: true }]) {
      const payload = {
        action: "closed",
        pull_request: { number: 7, head: { sha: "a".repeat(40) }, ...extra },
      };
      const out = project(eventHeader, eventTypeHeader, payload);
      // The sync hint is NOT forced: the grouped rule runs on the signed action
      // and the hinted action never reaches the envelope.
      assert.equal(out.name, "pull_request", `${eventHeader}/${eventTypeHeader}`);
      assert.equal(out.action, "closed", `${eventHeader}/${eventTypeHeader}`);
      assert.deepEqual(out, { ...payload, name: "pull_request" }, `${eventHeader}/${eventTypeHeader}`);
      assert.equal("label" in out, false);
    }
  }
});

test("replay: a signed non-sync body under a forged sync hint keeps every action", () => {
  // `synchronized`/`synchronize` are the only actions the sync hint may force;
  // every other action keeps its own meaning (`reopened` is the grouped rule's
  // own refinement, exactly as it is without the forged hint).
  for (const action of ["opened", "reopened", "ready_for_review", "label_deleted"]) {
    const expected = action === "reopened" ? "reopen" : action;
    for (const [eventHeader, eventTypeHeader] of [
      ["pull_request", "pull_request_sync"],
      ["pull_request_sync", ""],
    ] as Array<[string, string]>) {
      const out = project(eventHeader, eventTypeHeader, { action, pull_request: { number: 7 } });
      assert.equal(out.name, "pull_request", `${eventHeader}/${action}`);
      assert.equal(out.action, expected, `${eventHeader}/${action}`);
      assert.notEqual(out.action, "synchronize", `${eventHeader}/${action}`);
    }
  }
});

test("replay: a signed non-label body under a forged label hint never projects to labeled", () => {
  // A terminal body that already carries the trigger label on its PR: the
  // forged hint must not turn it into a `labeled` projection (or mine
  // `pull_request.labels` into a synthesized trigger).
  const payload = {
    action: "closed",
    pull_request: { number: 7, labels: [{ name: "ai-review", color: "00ff00" }] },
  };
  for (const [eventHeader, eventTypeHeader] of [
    ["pull_request", "pull_request_label"],
    ["pull_request_label", ""],
  ] as Array<[string, string]>) {
    const out = project(eventHeader, eventTypeHeader, payload);
    assert.notEqual(out.action, "labeled", eventHeader);
    assert.equal(out.action, "closed", eventHeader);
    assert.equal("label" in out, false, eventHeader);
  }

  // The grouped header keeps its own signed-action refinement (a sync body
  // still projects to `synchronize`) but never gains a `label` from the hint.
  const sync = project("pull_request", "pull_request_label", {
    action: "synchronized",
    pull_request: { number: 7, labels: [{ name: "ai-review" }] },
  });
  assert.equal(sync.action, "synchronize");
  assert.equal("label" in sync, false);

  // The ungrouped label group with a rejected hint degrades to the generic
  // passthrough (whose name the normalizer maps to `unknown`).
  const terminal = project("pull_request_label", "", payload);
  assert.equal(terminal.name, "pull_request_label");
  assert.equal(terminal.action, "closed");
  assert.equal("label" in terminal, false);
});

test("label: a label_deleted / label_cleared body is never projected to labeled under a label hint", () => {
  for (const action of ["label_deleted", "label_cleared"]) {
    // Grouped PR delivery: the signed action is preserved verbatim.
    const grouped = project("pull_request", "pull_request_label", {
      action,
      pull_request: { number: 7, labels: [{ name: "ai-review" }] },
    });
    assert.equal(grouped.name, "pull_request", action);
    assert.equal(grouped.action, action, action);
    assert.equal("label" in grouped, false, action);
    // Legacy ungrouped label group: the hint is rejected, so the delivery
    // degrades to the generic passthrough (the normalizer maps it to `unknown`)
    // instead of re-triggering on a label that was just REMOVED (#1024).
    const ungrouped = project("pull_request_label", "", {
      action,
      pull_request: { number: 7, labels: [{ name: "ai-review" }] },
    });
    assert.equal(ungrouped.name, "pull_request_label", action);
    assert.equal(ungrouped.action, action, action);
    assert.equal("label" in ungrouped, false, action);
  }
});

test("replay: a signed non-created body under a forged comment hint is not re-nested", () => {
  const payload = {
    action: "closed",
    comment: { id: 55, user: { login: "dev" } },
    issue: { number: 7, title: "a PR" },
    pull_request: { number: 7, head: { sha: "a".repeat(40) } },
  };
  for (const [eventHeader, eventTypeHeader] of [
    ["issue_comment", "pull_request_comment"],
    ["pull_request_comment", ""],
  ] as Array<[string, string]>) {
    const out = project(eventHeader, eventTypeHeader, payload);
    // The hint is NOT honored: the top-level `pull_request` stays where the
    // signed body put it and no `issue.pull_request` is synthesized, so the
    // normalizer cannot reach the follow_up (issue-origin) path.
    assert.equal(out.name, eventHeader, eventHeader);
    assert.equal(out.action, "closed", eventHeader);
    assert.equal(out.pull_request, payload.pull_request, eventHeader);
    assert.equal(
      Object.hasOwn((out.issue as Record<string, unknown>)!, "pull_request"),
      false,
      eventHeader,
    );
    assert.deepEqual(out.issue, { number: 7, title: "a PR" }, eventHeader);
    assert.deepEqual(out.comment, payload.comment, eventHeader);
  }
});

// ---------------------------------------------------------------------------
// Check/status family is shape-anchored (#1102) — the group header alone can
// never mint the scheduleable `check_update` kind
// ---------------------------------------------------------------------------
//
// The HMAC covers the RAW BODY ONLY, so the same signed bytes replay under a
// forged `check_run`/`check_suite`/`status` group header. The projection
// therefore honors the family hint ONLY when the signed body carries the shape
// that name requires (the event layer's `carriesCheckUpdateShape`); otherwise
// the projected name is the fixed literal `unknown`, which `mapKind` maps to
// `unknown` — 202 accepted/unknown, no response-code change.

test("replay: a signed PR body under a forged check/status header projects name 'unknown'", () => {
  // IDENTICAL signed body bytes under each forged family header, with an empty
  // and a non-empty type header.
  const payload = {
    action: "closed",
    merged: true,
    pull_request: {
      number: 7,
      head: { sha: "a".repeat(40), repo: { full_name: "o/r" } },
      base: { sha: "b".repeat(40), repo: { full_name: "o/r" } },
    },
    repository: { full_name: "o/r" },
  };
  for (const eventHeader of ["check_run", "check_suite", "status"]) {
    for (const eventTypeHeader of ["", eventHeader]) {
      const out = project(eventHeader, eventTypeHeader, payload);
      assert.equal(out.name, "unknown", `${eventHeader}/${eventTypeHeader}`);
      // The signed action is untouched: nothing is synthesized from the hint.
      assert.equal(out.action, "closed", `${eventHeader}/${eventTypeHeader}`);
      assert.notEqual(out.action, "synchronize", eventHeader);
      assert.deepEqual(out, { ...payload, name: "unknown" }, `${eventHeader}/${eventTypeHeader}`);
      assert.equal("label" in out, false, eventHeader);
      assert.equal("check_run" in out, false, eventHeader);
    }
  }
});

test("check/status family: a GENUINE Forgejo status delivery passes through byte-identically", () => {
  // Forgejo's native commit-status webhook: the top-level sha/state/context
  // triple, no `pull_requests`, no `installation`, no `check_run` object. This
  // is a real delivery, so the family hint is honored and nothing changes.
  const payload = {
    sha: "a".repeat(40),
    state: "success",
    context: "ci/jenkins",
    repository: { full_name: "o/r" },
  };
  const out = project("status", "", payload);
  assert.equal(out.name, "status");
  assert.deepEqual(out, { ...payload, name: "status" });
});

test("check/status family: a genuine status body under a forged check_run header is 'unknown'", () => {
  // Cross-family: the shapes are not interchangeable, so a captured status
  // delivery replayed as a check run degrades fail-closed.
  const payload = { sha: "a".repeat(40), state: "success", context: "ci", repository: { full_name: "o/r" } };
  for (const eventHeader of ["check_run", "check_suite"]) {
    const out = project(eventHeader, "", payload);
    assert.equal(out.name, "unknown", eventHeader);
    assert.deepEqual(out, { ...payload, name: "unknown" }, eventHeader);
  }
});

test("check/status family: a genuine check_run / check_suite delivery keeps its header name", () => {
  const run = { action: "completed", check_run: { id: 1 }, repository: { full_name: "o/r" } };
  assert.equal(project("check_run", "", run).name, "check_run");
  const suite = { action: "completed", check_suite: { id: 2 }, repository: { full_name: "o/r" } };
  assert.equal(project("check_suite", "", suite).name, "check_suite");
});

test("check/status family: a hostile shape degrades to 'unknown', never the forged family name", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["check_run", { check_run: null }],
    ["check_run", { check_run: [] }],
    ["check_run", { check_run: "x" }],
    ["check_suite", { check_suite: 1 }],
    ["status", { sha: 1, state: "success", context: "ci" }],
    ["status", { sha: "", state: "success", context: "ci" }],
  ];
  for (const [eventHeader, payload] of cases) {
    const out = project(eventHeader, "", payload);
    assert.equal(out.name, "unknown", `${eventHeader} ${JSON.stringify(payload)}`);
    assert.deepEqual(out, { ...payload, name: "unknown" }, `${eventHeader} ${JSON.stringify(payload)}`);
  }
});

test("check/status family: a throwing shape getter cannot resurrect the forged family name", () => {
  const hostile: Record<string, unknown> = {
    action: "completed",
    get check_run(): Record<string, unknown> {
      throw new Error("boom");
    },
  };
  // `carriesCheckUpdateShape` does NOT swallow a hostile accessor, and neither
  // does the spread of the hostile payload — so the catch ladder's last-resort
  // twin answers, with the SAME helper's name, which is why the forged family
  // name cannot come back. That twin necessarily carries no payload fields (the
  // spread is what threw), so pin the exact degraded shape here: at the HTTP
  // handler a JSON-parsed body can never carry a throwing accessor, so this
  // branch is unreachable there and cannot change a response code.
  const out = projectForgejoWebhookPayload("check_run", "", hostile, {});
  assert.equal(out.name, "unknown");
  assert.deepEqual(out, { name: "unknown" });
});

test("check/status family: a spelling variant of a family header passes through verbatim and lands on unknown", () => {
  // The family gate matches EXACT names, so a variant (`STATUS`, a padded or
  // dotted name) is not gated and not rewritten — it stays the header's own
  // bytes, and the normalizer's default arm is the fail-closed backstop.
  const payload = {
    action: "closed",
    pull_request: {
      number: 7,
      head: { sha: "a".repeat(40), repo: { full_name: "o/r" } },
      base: { sha: "b".repeat(40), repo: { full_name: "o/r" } },
    },
    repository: { full_name: "o/r" },
  };
  for (const eventHeader of ["STATUS", " status ", "check_run.", "check-runs"]) {
    const out = project(eventHeader, "", payload);
    assert.equal(out.name, eventHeader, eventHeader);
    assert.deepEqual(out, { ...payload, name: eventHeader }, eventHeader);
    const event = normalizeForgejoEvent(out);
    assert.notEqual(event, null, eventHeader);
    assert.equal(event!.kind, "unknown", eventHeader);
  }
});

test("check/status family: a non-family header is never gated on the signed shape", () => {
  // The gate applies to the check/status family ONLY — an unrelated group with
  // no matching shape keeps its exact prior passthrough behavior.
  const payload = { foo: 1, bar: { baz: 2 } };
  const out = project("some_future_event", "", payload);
  assert.equal(out.name, "some_future_event");
  assert.deepEqual(out, { ...payload, name: "some_future_event" });
});

// ---------------------------------------------------------------------------
// Adversarial / boundary
// ---------------------------------------------------------------------------

test("adversarial: a hostile payload name/event cannot override the projected (trusted) name", () => {
  const out = project("pull_request", "", { name: "issues", event: "push", action: "opened" });
  // The projected `name` (from the trusted header) wins over any payload field.
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "opened");
  // The hostile `event` is inert for routing: the normalizer reads `name` first.
  assert.equal(out.event, "push");
});

test("adversarial: a hostile payload name cannot override the name on a sync delivery", () => {
  const out = project("pull_request_sync", "", { name: "issues", action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("boundary: the input payload is never mutated and the result is a fresh object", () => {
  const payload = {
    action: "synchronized",
    name: "hostile-name",
    pull_request: { number: 7 },
    sender: { login: "x" },
  };
  const before = JSON.stringify(payload);
  const out = project("pull_request", "", payload);
  // The input is unchanged.
  assert.equal(JSON.stringify(payload), before);
  // The result is a fresh object, not the input.
  assert.notEqual(out, payload);
  // The projected name overrides the hostile payload name.
  assert.equal(out.name, "pull_request");
});

test("boundary: a top-level __proto__ own-property in the payload does not pollute Object.prototype", () => {
  const payload: Record<string, unknown> = { action: "synchronized" };
  // An OWN `__proto__` data property (as JSON.parse produces), not the
  // object-literal prototype setter.
  Object.defineProperty(payload, "__proto__", { value: { polluted: true }, enumerable: true });
  const out = project("pull_request", "", payload);
  assert.equal(out.action, "synchronize");
  // The spread fence: `__proto__` is copied as an own data property, never
  // through the prototype setter, so Object.prototype stays clean.
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
});

test("adversarial: a throwing payload getter degrades to the passthrough shape without throwing", () => {
  // A hostile getter on a payload field: the rule body reads it and throws;
  // the projection must degrade to the passthrough shape, never propagate.
  const hostile: Record<string, unknown> = {
    get action() {
      throw new Error("x");
    },
  };
  const out = projectForgejoWebhookPayload("pull_request", "", hostile, {});
  assert.equal(out.name, "pull_request");
});
