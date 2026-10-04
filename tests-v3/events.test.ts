import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForgeEvent,
  normalizeForgejoEvent,
  normalizeGitHubEvent,
  reconciliationPollEvent,
} from "../src/events/normalize.js";
import type { CanonicalForgeEvent, ForgeEventKind } from "../src/events/types.js";

/** Every field except `platform`: the cross-platform identity surface. */
function identityOf(event: CanonicalForgeEvent): Record<string, unknown> {
  return {
    source: event.source,
    kind: event.kind,
    installationId: event.installationId,
    repoFullName: event.repoFullName,
    prNumber: event.prNumber,
    prId: event.prId,
    headSha: event.headSha,
    baseSha: event.baseSha,
    draft: event.draft,
    fork: event.fork,
    labelName: event.labelName,
    actor: event.actor,
    eventReference: event.eventReference,
  };
}

const PR = {
  id: 4242,
  number: 7,
  draft: true,
  merged: false,
  user: { login: "pr-author" },
  head: { sha: "aa11bb22cc33", repo: { full_name: "Fork/Repo" } },
  base: { sha: "dd44ee55ff66", repo: { full_name: "owner/repo" } },
};

// ── Adapter boundary: GitHub vs Forgejo ──────────────────────────────────

test("GitHub and Forgejo payloads normalize to identical identity fields", () => {
  const gh = normalizeGitHubEvent({
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/Repo" },
    pull_request: PR,
    sender: { login: "opener" },
  });
  // Forgejo PR payloads use the same field vocabulary (prToGithubShape).
  const fj = normalizeForgejoEvent({
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/Repo" },
    pull_request: { ...PR, merged: undefined, merged_at: "" },
    sender: { login: "opener" },
  });
  assert.notEqual(gh, null);
  assert.notEqual(fj, null);
  assert.equal(gh!.platform, "github");
  assert.equal(fj!.platform, "forgejo");
  assert.deepEqual(identityOf(gh!), identityOf(fj!));
  assert.deepEqual(identityOf(gh!), {
    source: "webhook",
    kind: "pr_opened",
    installationId: "",
    repoFullName: "owner/repo",
    prNumber: 7,
    prId: 4242,
    headSha: "aa11bb22cc33",
    baseSha: "dd44ee55ff66",
    draft: true,
    fork: true,
    labelName: "",
    actor: "opener",
    eventReference: "",
  });
});

test("normalizeForgeEvent dispatches by platform", () => {
  const payload = {
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: PR,
  };
  assert.equal(normalizeForgeEvent("github", payload)?.platform, "github");
  assert.equal(normalizeForgeEvent("forgejo", payload)?.platform, "forgejo");
});

// ── pull_request action mapping ────────────────────────────────────────────

test("pull_request action mapping", () => {
  const cases: [string, boolean, ForgeEventKind][] = [
    ["opened", false, "pr_opened"],
    ["reopen", false, "pr_reopened"],
    ["synchronize", false, "synchronize"],
    ["ready_for_review", false, "ready_for_review"],
    ["closed", false, "pr_closed"],
    ["closed", true, "pr_merged"],
  ];
  for (const [action, merged, expected] of cases) {
    const event = normalizeGitHubEvent({
      name: "pull_request",
      action,
      repository: { full_name: "owner/repo" },
      pull_request: { ...PR, merged },
    });
    assert.equal(event?.kind, expected, `${action} merged=${merged}`);
  }
});

test("closed with merged_at (Forgejo shape) maps to pr_merged", () => {
  const event = normalizeForgejoEvent({
    name: "pull_request",
    action: "closed",
    repository: { full_name: "owner/repo" },
    pull_request: { ...PR, merged: undefined, merged_at: "2026-10-02T00:00:00Z" },
  });
  assert.equal(event?.kind, "pr_merged");
});

// ── Re-review label ────────────────────────────────────────────────────────

const LABELED_BASE = {
  name: "pull_request",
  action: "labeled",
  repository: { full_name: "owner/repo" },
  pull_request: {
    id: 1,
    number: 3,
    head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
    base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
  },
};

test("labeled with the trigger label is rereview_label; other labels are unknown", () => {
  const hit = normalizeGitHubEvent({ ...LABELED_BASE, label: { name: "ai-review" } });
  assert.equal(hit?.kind, "rereview_label");
  assert.equal(hit?.labelName, "ai-review");

  const miss = normalizeGitHubEvent({ ...LABELED_BASE, label: { name: "pinned" } });
  assert.equal(miss?.kind, "unknown");
  assert.equal(miss?.labelName, "pinned");

  // Case-SENSITIVE match (parity with the shipped precheck pipeline): a
  // differently-cased label does NOT trigger a rereview.
  const ci = normalizeGitHubEvent({ ...LABELED_BASE, label: { name: "AI-REVIEW" } });
  assert.equal(ci?.kind, "unknown");

  // Label-as-string form is handled.
  const asString = normalizeGitHubEvent({ ...LABELED_BASE, label: "ai-review" });
  assert.equal(asString?.kind, "rereview_label");
  const asStringMiss = normalizeGitHubEvent({ ...LABELED_BASE, label: "other" });
  assert.equal(asStringMiss?.kind, "unknown");
});

test("rereviewLabel option overrides the default trigger", () => {
  const custom = normalizeGitHubEvent(
    { ...LABELED_BASE, label: { name: "re-review" } },
    "webhook",
    { rereviewLabel: "re-review" },
  );
  assert.equal(custom?.kind, "rereview_label");
  const defaultMiss = normalizeGitHubEvent({ ...LABELED_BASE, label: { name: "re-review" } });
  assert.equal(defaultMiss?.kind, "unknown");
});

// ── Follow-up comments ─────────────────────────────────────────────────────

test("issue_comment created on a PR is a follow_up", () => {
  const event = normalizeGitHubEvent({
    name: "issue_comment",
    action: "created",
    repository: { full_name: "owner/repo" },
    issue: { number: 9, pull_request: { id: 55, number: 9, head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } }, base: { sha: "deadbeef", repo: { full_name: "owner/repo" } } } },
    comment: { id: 1, user: { login: "commenter" } },
  });
  assert.notEqual(event, null);
  assert.equal(event!.kind, "follow_up");
  assert.equal(event!.prNumber, 9);
  assert.equal(event!.prId, 55);
  assert.equal(event!.actor, "commenter");
  // The comment id now surfaces as the canonical event reference.
  assert.equal(event!.eventReference, "1");
});

test("issue_comment not on a PR (or not created) is unknown", () => {
  const noPr = normalizeGitHubEvent({
    name: "issue_comment",
    action: "created",
    repository: { full_name: "owner/repo" },
    issue: { number: 9 },
    comment: { id: 1, user: { login: "commenter" } },
  });
  assert.equal(noPr?.kind, "unknown");
  assert.equal(noPr?.prNumber, 0);
  // Comment-shaped envelope: the id is still captured as the reference.
  assert.equal(noPr?.eventReference, "1");

  const edited = normalizeGitHubEvent({
    name: "issue_comment",
    action: "edited",
    repository: { full_name: "owner/repo" },
    issue: { number: 9, pull_request: { id: 55, number: 9 } },
    comment: { id: 1, user: { login: "commenter" } },
  });
  assert.equal(edited?.kind, "unknown");
  assert.equal(edited?.eventReference, "1");
});

function commentPayload(
  name: "issue_comment" | "comment",
  comment: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    action: "created",
    repository: { full_name: "owner/repo" },
    issue: {
      number: 9,
      pull_request: {
        id: 55,
        number: 9,
        head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
        base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
      },
    },
    comment,
  };
}

test("follow_up eventReference: number and digit-string comment.id normalize to canonical digits", () => {
  const ghNumeric = normalizeGitHubEvent(commentPayload("issue_comment", { id: 123456789, user: { login: "commenter" } }));
  assert.notEqual(ghNumeric, null);
  assert.equal(ghNumeric!.kind, "follow_up");
  assert.equal(ghNumeric!.eventReference, "123456789");

  const ghString = normalizeGitHubEvent(commentPayload("issue_comment", { id: "987654321", user: { login: "commenter" } }));
  assert.equal(ghString?.kind, "follow_up");
  assert.equal(ghString?.eventReference, "987654321");

  // Trimmed digit string is accepted.
  const ghTrimmed = normalizeGitHubEvent(commentPayload("issue_comment", { id: "  42  ", user: { login: "commenter" } }));
  assert.equal(ghTrimmed?.eventReference, "42");

  const fjNumeric = normalizeForgejoEvent(commentPayload("comment", { id: 123456789, user: { login: "commenter" } }));
  assert.notEqual(fjNumeric, null);
  assert.equal(fjNumeric!.kind, "follow_up");
  assert.equal(fjNumeric!.eventReference, "123456789");

  const fjString = normalizeForgejoEvent(commentPayload("comment", { id: "987654321", user: { login: "commenter" } }));
  assert.equal(fjString?.kind, "follow_up");
  assert.equal(fjString?.eventReference, "987654321");

  // 19 digits is the upper bound and still canonical.
  const max = normalizeGitHubEvent(commentPayload("issue_comment", { id: "123456789123456789", user: { login: "commenter" } }));
  assert.equal(max?.eventReference, "123456789123456789");
});

test("follow_up eventReference: adversarial comment.id values are '' and never throw", () => {
  const hostile: unknown[] = [
    0, // zero
    -5, // negative
    "007", // leading zero
    "abc", // non-digit
    "1\nbaseSha=x", // newline-injection payload token
    "1".repeat(20), // oversized (20 digits)
    1.5, // float
    "1.5", // float as string
    // 18-digit NUMERIC: not a safe integer; String() would silently
    // alter it, so it is the sentinel "" (see the convergence test).
    123456789123456789,
    null, // absent
    undefined, // absent
    true, // non-string/number
    { id: 1 }, // id itself an object
  ];
  for (const id of hostile) {
    const event = normalizeGitHubEvent(commentPayload("issue_comment", { id, user: { login: "commenter" } }));
    assert.notEqual(event, null, `id: ${JSON.stringify(id)}`);
    assert.equal(event!.eventReference, "", `id: ${JSON.stringify(id)}`);
  }
  // Same on the Forgejo `comment` envelope.
  const fj = normalizeForgejoEvent(commentPayload("comment", { id: "1\nbaseSha=x", user: { login: "commenter" } }));
  assert.notEqual(fj, null);
  assert.equal(fj!.eventReference, "");

  // A `__proto__`-keyed comment object (as parsed from a hostile JSON
  // body): the pollution key must not surface a reference and must not
  // throw. No own `id` ⇒ "".
  const polluted = JSON.parse(
    '{"name":"issue_comment","action":"created","repository":{"full_name":"owner/repo"},"issue":{"number":9,"pull_request":{"id":55,"number":9,"head":{"sha":"a1b2c3d","repo":{"full_name":"owner/repo"}},"base":{"sha":"deadbeef","repo":{"full_name":"owner/repo"}}}},"comment":{"__proto__":{"id":999999,"user":{"login":"polluter"}},"user":{"login":"commenter"}}}',
  );
  const polluter = normalizeGitHubEvent(polluted);
  assert.notEqual(polluter, null);
  assert.equal(polluter!.eventReference, "");

  // Non-comment event shapes carry no reference, even with a comment key.
  const prEvent = normalizeGitHubEvent({
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: { number: 7 },
    comment: { id: 1, user: { login: "commenter" } },
  });
  assert.equal(prEvent?.eventReference, "");
});

test("unsafe numeric comment.id is '' while the digit string normalizes to itself (no convergence)", () => {
  // The numeric literal is NOT a safe integer: String() on it silently
  // alters the value while still matching the digit patterns, which
  // would collapse two distinct comment ids. It must be the sentinel "".
  const numeric = normalizeGitHubEvent(
    commentPayload("issue_comment", { id: 123456789123456789, user: { login: "commenter" } }),
  );
  assert.notEqual(numeric, null);
  assert.equal(numeric!.eventReference, "");
  // The digit STRING of the same magnitude still normalizes to itself,
  // so the two observations do NOT converge:
  const asString = normalizeGitHubEvent(
    commentPayload("issue_comment", { id: "123456789123456790", user: { login: "commenter" } }),
  );
  assert.notEqual(asString, null);
  assert.equal(asString!.eventReference, "123456789123456790");

  // Same on the Forgejo `comment` envelope.
  const fj = normalizeForgejoEvent(
    commentPayload("comment", { id: 123456789123456789, user: { login: "commenter" } }),
  );
  assert.equal(fj?.eventReference, "");
});

test("GitHub issue_comment and Forgejo comment of the SAME comment normalize identically (eventReference equal)", () => {
  const issue = {
    number: 9,
    pull_request: {
      id: 55,
      number: 9,
      head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
      base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
    },
  };
  const gh = normalizeGitHubEvent({
    name: "issue_comment",
    action: "created",
    repository: { full_name: "owner/repo" },
    issue,
    comment: { id: 123456789, user: { login: "commenter" } },
  });
  const fj = normalizeForgejoEvent({
    name: "comment",
    action: "created",
    repository: { full_name: "owner/repo" },
    issue,
    comment: { id: 123456789, user: { login: "commenter" } },
  });
  assert.notEqual(gh, null);
  assert.notEqual(fj, null);
  assert.equal(gh!.platform, "github");
  assert.equal(fj!.platform, "forgejo");
  // Equal in every provider-neutral field, including the event reference.
  assert.equal(gh!.eventReference, fj!.eventReference);
  assert.equal(gh!.eventReference, "123456789");
  assert.deepEqual(identityOf(gh!), identityOf(fj!));
});

// ── Repo-scoped events ─────────────────────────────────────────────────────

test("check_run / check_suite / status map to check_update", () => {
  for (const name of ["check_run", "check_suite", "status"] as const) {
    const event = normalizeGitHubEvent({
      name,
      repository: { full_name: "owner/repo" },
      pull_requests: [{ id: 5, number: 9 }],
    });
    assert.equal(event?.kind, "check_update", name);
    assert.equal(event?.prNumber, 9, name);
    assert.equal(event?.prId, 5, name);
  }
});

test("installation and installation_repositories map to installation_change", () => {
  const event = normalizeGitHubEvent({
    name: "installation_repositories",
    installation: { id: 77 },
    repositories: [{ full_name: "Owner/Repo" }],
  });
  assert.notEqual(event, null);
  assert.equal(event!.kind, "installation_change");
  assert.equal(event!.repoFullName, "owner/repo");
  assert.equal(event!.installationId, "77");
  assert.equal(event!.prNumber, 0);

  const installation = normalizeGitHubEvent({
    name: "installation",
    action: "created",
    installation: { id: 77 },
    repositories: [{ full_name: "owner/repo" }],
  });
  assert.equal(installation?.kind, "installation_change");
});

test("public maps to visibility_change", () => {
  const event = normalizeGitHubEvent({
    name: "public",
    repository: { full_name: "owner/repo" },
  });
  assert.notEqual(event, null);
  assert.equal(event!.kind, "visibility_change");
  assert.equal(event!.repoFullName, "owner/repo");
  assert.equal(event!.prNumber, 0);
});

// ── Reconciliation poll (dedupe prerequisite) ─────────────────────────────

test("poll observation of the same PR matches the webhook identity", () => {
  const prPayload = {
    id: 4242,
    number: 7,
    draft: true,
    head: { sha: "aa11bb22cc33", repo: { full_name: "Fork/Repo" } },
    base: { sha: "dd44ee55ff66", repo: { full_name: "owner/repo" } },
  };
  // The webhook carries `installation.id`; the poller supplies the same
  // installation id explicitly so the two converge in EVERY identity field.
  const webhook = normalizeGitHubEvent({
    name: "pull_request",
    action: "synchronize",
    repository: { full_name: "owner/repo" },
    installation: { id: 12345 },
    pull_request: prPayload,
  });
  const poll = reconciliationPollEvent("github", prPayload, { installationId: "12345" });
  assert.notEqual(webhook, null);
  assert.notEqual(poll, null);
  // Identity fields are identical across the two sources (including the
  // installation id that used to diverge).
  for (const field of [
    "installationId",
    "repoFullName",
    "prNumber",
    "prId",
    "headSha",
    "baseSha",
    "draft",
    "fork",
  ] as const) {
    assert.deepEqual(webhook![field], poll![field], field);
  }
  // Only kind and source differ.
  assert.equal(webhook!.kind, "synchronize");
  assert.equal(webhook!.source, "webhook");
  assert.equal(poll!.kind, "reconciliation_poll");
  assert.equal(poll!.source, "poll");
});

test("poll observation is forge-agnostic and fails closed without identity", () => {
  const prPayload = {
    id: 1,
    number: 3,
    head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
    base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
  };
  const gh = reconciliationPollEvent("github", prPayload);
  const fj = reconciliationPollEvent("forgejo", prPayload);
  assert.notEqual(gh, null);
  assert.notEqual(fj, null);
  assert.equal(gh!.platform, "github");
  assert.equal(fj!.platform, "forgejo");
  assert.deepEqual(identityOf(gh!), identityOf(fj!));

  assert.equal(reconciliationPollEvent("github", null), null);
  assert.equal(reconciliationPollEvent("github", { number: 3 }), null); // no repo
  assert.equal(reconciliationPollEvent("github", { repository: { full_name: "owner/repo" } }), null); // no number
});

test("poll installationId is validated at the boundary (fail closed on non-digits)", () => {
  const prPayload = {
    number: 3,
    head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
    base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
  };
  // Valid digits pass through (32 is the upper bound).
  assert.equal(reconciliationPollEvent("github", prPayload, { installationId: "12345" })?.installationId, "12345");
  assert.equal(
    reconciliationPollEvent("github", prPayload, { installationId: "1".repeat(32) })?.installationId,
    "1".repeat(32),
  );
  // Padded valid digits are trimmed and accepted (the documented trim
  // behavior):
  assert.equal(reconciliationPollEvent("github", prPayload, { installationId: " 12345 " })?.installationId, "12345");
  // Empty, whitespace, non-digit, mixed, and oversized become "".
  const invalid: unknown[] = [
    "",
    "   ",
    "abc",
    "12a45",
    "1".repeat(33),
    // 33-digit NUMERIC: not a safe integer; String() would silently
    // alter it, so it is the sentinel "".
    1234567891234567891234567891234567891,
    null,
    undefined,
    true,
    {},
  ];
  for (const id of invalid) {
    const poll = reconciliationPollEvent("github", prPayload, { installationId: id as string });
    assert.notEqual(poll, null, `installationId: ${JSON.stringify(id)}`);
    assert.equal(poll!.installationId, "", `installationId: ${JSON.stringify(id)}`);
  }
  // No options at all ⇒ the sentinel "".
  assert.equal(reconciliationPollEvent("github", prPayload)?.installationId, "");
});

// ── Conservative failure ───────────────────────────────────────────────────

test("malformed inputs return null and never throw", () => {
  const inputs: unknown[] = [
    null,
    undefined,
    42,
    "payload",
    [],
    { name: "pull_request", action: "opened" }, // no repo
    { name: "pull_request", action: "opened", repository: { full_name: "owner/repo" } }, // no PR number
    { name: "pull_request", action: "opened", repository: { full_name: "owner/repo" }, pull_request: { number: "seven" } },
    { name: "pull_request", action: "opened", repository: { full_name: "no-slash" }, pull_request: { number: 3 } },
    { name: "pull_request", action: "opened", repository: { full_name: "a/b/c" }, pull_request: { number: 3 } },
    { name: "pull_request", action: "opened", repository: { full_name: "/repo" }, pull_request: { number: 3 } },
    { name: "pull_request", action: "opened", repository: { full_name: "owner/" }, pull_request: { number: 3 } },
    { name: "pull_request", action: "opened", repository: { full_name: "owner/repo" }, pull_request: "not-an-object" },
  ];
  for (const input of inputs) {
    assert.equal(normalizeGitHubEvent(input), null, `input: ${JSON.stringify(input)}`);
  }
});

test("a throwing accessor on a captured field drops the WHOLE event (fail closed, never a degraded field)", () => {
  // A hostile `comment.id` getter: the throw is caught by the
  // normalizer's boundary, so the ENTIRE event is null — the field is
  // never silently degraded.
  const throwingComment = {
    user: { login: "commenter" },
    get id() {
      throw new Error("hostile getter");
    },
  };
  const commentEvent = commentPayload("issue_comment", throwingComment);
  assert.doesNotThrow(() => normalizeGitHubEvent(commentEvent));
  assert.equal(normalizeGitHubEvent(commentEvent), null);

  // Likewise a throwing `installation.id` getter on the webhook path.
  const throwingInstallation = {
    get id() {
      throw new Error("hostile getter");
    },
  };
  const installationEvent = {
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/repo" },
    installation: throwingInstallation,
    pull_request: PR,
  };
  assert.doesNotThrow(() => normalizeGitHubEvent(installationEvent));
  assert.equal(normalizeGitHubEvent(installationEvent), null);
});

// ── Fork derivation ────────────────────────────────────────────────────────

function payloadWithRepos(headRepo: string | null, baseRepo: string | null): Record<string, unknown> {
  return {
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 1,
      head: { sha: "a1b2c3d", ...(headRepo !== null ? { repo: { full_name: headRepo } } : {}) },
      base: { sha: "deadbeef", ...(baseRepo !== null ? { repo: { full_name: baseRepo } } : {}) },
    },
  };
}

test("fork derivation: different repos, missing head repo, same repo", () => {
  assert.equal(normalizeGitHubEvent(payloadWithRepos("Fork/Repo", "owner/repo"))?.fork, true);
  assert.equal(normalizeGitHubEvent(payloadWithRepos("owner/repo", "owner/repo"))?.fork, false);
  assert.equal(normalizeGitHubEvent(payloadWithRepos(null, "owner/repo"))?.fork, true);
  assert.equal(normalizeGitHubEvent(payloadWithRepos("owner/repo", null))?.fork, true);
});

// ── Identity field extraction ──────────────────────────────────────────────

test("installationId is extracted from installation.id; '' when absent", () => {
  const base = {
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 1,
      head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
      base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
    },
  };
  const numeric = normalizeGitHubEvent({ ...base, installation: { id: 42 } });
  assert.equal(numeric?.installationId, "42");
  // 33-digit NUMERIC: not a safe integer; String() would silently alter
  // it, so it is the sentinel "" (no convergence with the string form).
  const unsafeNumeric = normalizeGitHubEvent({
    ...base,
    installation: { id: 1234567891234567891234567891234567891 },
  });
  assert.equal(unsafeNumeric?.installationId, "");
  // Non-digit strings are rejected (digits-only identity field).
  const stringId = normalizeGitHubEvent({ ...base, installation: { id: "abc" } });
  assert.equal(stringId?.installationId, "");
  const absent = normalizeGitHubEvent(base);
  assert.equal(absent?.installationId, "");
  const invalid = normalizeGitHubEvent({ ...base, installation: { id: null } });
  assert.equal(invalid?.installationId, "");
});

test("bare PR objects normalize (no envelope) with unknown kind", () => {
  const event = normalizeGitHubEvent({
    number: 7,
    id: 4242,
    draft: false,
    user: { login: "pr-author" },
    head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } },
    base: { sha: "deadbeef", repo: { full_name: "owner/repo" } },
  });
  assert.notEqual(event, null);
  assert.equal(event!.kind, "unknown");
  assert.equal(event!.repoFullName, "owner/repo");
  assert.equal(event!.prNumber, 7);
  assert.equal(event!.prId, 4242);
  assert.equal(event!.headSha, "a1b2c3d");
  assert.equal(event!.baseSha, "deadbeef");
  assert.equal(event!.fork, false);
  assert.equal(event!.actor, "pr-author");
});

test("repo full name normalizes to lowercase owner/name", () => {
  const event = normalizeGitHubEvent({
    name: "pull_request",
    action: "opened",
    repository: { full_name: "  Owner/Repo  " },
    pull_request: { number: 1, head: { sha: "a1b2c3d", repo: { full_name: "Owner/Repo" } }, base: { sha: "deadbeef", repo: { full_name: "Owner/Repo" } } },
  });
  assert.equal(event?.repoFullName, "owner/repo");
});

test("returned events are frozen", () => {
  const event = normalizeGitHubEvent({
    name: "pull_request",
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: { number: 1, head: { sha: "a1b2c3d", repo: { full_name: "owner/repo" } }, base: { sha: "deadbeef", repo: { full_name: "owner/repo" } } },
  });
  assert.notEqual(event, null);
  assert.ok(Object.isFrozen(event));
});
