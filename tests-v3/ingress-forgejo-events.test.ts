import test from "node:test";
import assert from "node:assert/strict";

import { projectForgejoWebhookPayload } from "../src/ingress/forgejo-events.js";

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

test("sync: grouped pull_request + type pull_request_sync forces action synchronize", () => {
  const out = project("pull_request", "pull_request_sync", { action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("sync: grouped pull_request + action synchronized (no type header) → synchronize", () => {
  const out = project("pull_request", "", { action: "synchronized" });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "synchronize");
});

test("sync: older ungrouped pull_request_sync header forces synchronize over any payload action", () => {
  const out = project("pull_request_sync", "", { action: "opened" });
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

test("label: ungrouped/older pull_request_label header projects to labeled regardless of payload action", () => {
  const out = project("pull_request_label", "", {
    action: "something-else",
    pull_request: { labels: [{ name: "ai-review" }] },
  });
  assert.equal(out.name, "pull_request");
  assert.equal(out.action, "labeled");
  assert.deepEqual(out.label, { name: "ai-review" });
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
