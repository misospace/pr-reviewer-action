import test from "node:test";
import assert from "node:assert/strict";
import { FEEDBACK_AFFORDANCE, INLINE_DISCLAIMER } from "../src/publish/inline-findings.js";
import {
  findingIdentity,
  findingIdentityFromRecord,
  parseFindingIdentityMarker,
  renderFindingIdentityMarker,
  stripFindingIdentityMarkers,
} from "../src/outcomes/identity.js";
import {
  deriveOutcomeEvents,
  type PriorFindingObservation,
} from "../src/outcomes/reconcile.js";
import {
  aggregateOutcomeEvents,
  renderOutcomeReportMarkdown,
} from "../src/outcomes/report.js";
import {
  FINDING_OUTCOMES_SCHEMA,
  MAX_LEDGER_EVENTS,
  normalizeOutcomeEvent,
  parseOutcomeLedger,
  serializeOutcomeLedger,
  type AdjudicationLabel,
  type OutcomeEvent,
} from "../src/outcomes/schema.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const AT = "2026-10-18T00:00:00.000Z";
const META = { route: "primary", model: "test-model", at: AT };

function findingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { file: "src/app.ts", line: 10, severity: "major", category: "bug", message: "unchecked null deref", ...overrides };
}

function observation(overrides: Partial<PriorFindingObservation> = {}): PriorFindingObservation {
  return {
    findingId: findingIdentityFromRecord(findingRecord())!,
    commentId: "100",
    resolved: null,
    reactions: { helpful: 0, notHelpful: 0 },
    ...overrides,
  };
}

test("#1027 identity: deterministic and drift-invariant", () => {
  const base = findingIdentity({ path: "src/app.ts", severity: "major", category: "bug", message: "unchecked null deref" });
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, findingIdentity({ path: "src/app.ts", severity: "major", category: "bug", message: "unchecked null deref" }));
  // Line drift: the anchor line is not part of the identity at all.
  assert.equal(findingIdentityFromRecord(findingRecord({ line: 999 })), base);
  assert.equal(findingIdentityFromRecord(findingRecord({ line: null })), base);
  // Whitespace and severity case normalization.
  assert.equal(findingIdentityFromRecord(findingRecord({ severity: "MAJOR", message: "unchecked\n null   deref" })), base);
  // A different message, severity, category, or path is a different finding.
  assert.notEqual(findingIdentityFromRecord(findingRecord({ message: "other problem" })), base);
  assert.notEqual(findingIdentityFromRecord(findingRecord({ severity: "minor" })), base);
  assert.notEqual(findingIdentityFromRecord(findingRecord({ category: "security" })), base);
  assert.notEqual(findingIdentityFromRecord(findingRecord({ file: "src/other.ts" })), base);
});

test("#1027 identity: secrets are redacted before hashing", () => {
  const secret = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12";
  assert.equal(
    findingIdentity({ path: "a.ts", severity: "info", category: "", message: `token ${secret} leaked` }),
    findingIdentity({ path: "a.ts", severity: "info", category: "", message: "token [REDACTED] leaked" }),
  );
});

test("#1027 identity: malformed records prove nothing", () => {
  assert.equal(findingIdentityFromRecord(null), null);
  assert.equal(findingIdentityFromRecord("nope"), null);
  assert.equal(findingIdentityFromRecord([1]), null);
  assert.equal(findingIdentityFromRecord(findingRecord({ file: "/abs" })), null);
  assert.equal(findingIdentityFromRecord(findingRecord({ file: "../traversal" })), null);
  assert.equal(findingIdentityFromRecord(findingRecord({ message: "" })), null);
  // severity defaults to "info" when absent, but only with a usable path+message.
  assert.match(findingIdentityFromRecord({ file: "a.ts", message: "x" })!, /^[0-9a-f]{64}$/);
});

test("#1027 identity: edge-case paths stay digest inputs and never collide", () => {
  // Unanchorable paths fail closed before any hashing: empty, absolute, and
  // any `..` segment (leading, interior, or trailing). These never reach a
  // filesystem here — paths are only ever fed to the digest — but the same
  // fail-closed bar the publish link renderer applies must hold here too.
  for (const file of ["", "/", "/abs/path.ts", "../traversal.ts", "src/../secrets.env", "..", "a/.."]) {
    assert.equal(findingIdentityFromRecord(findingRecord({ file })), null, `file: ${JSON.stringify(file)}`);
  }
  // Symlink-shaped and NUL-bearing paths are ordinary digest inputs: they
  // hash deterministically and are never touched, resolved, or rejected as
  // traversal when no `..` segment is present.
  const symlinked = findingIdentity({ path: "link/real.ts", severity: "major", category: "bug", message: "m" });
  assert.match(symlinked, /^[0-9a-f]{64}$/);
  assert.equal(symlinked, findingIdentity({ path: "link/real.ts", severity: "major", category: "bug", message: "m" }));
  // A symlink path and its resolved-looking target are DIFFERENT findings —
  // the digest never canonicalizes a path it cannot see through.
  assert.notEqual(symlinked, findingIdentity({ path: "real/real.ts", severity: "major", category: "bug", message: "m" }));
  const nulled = findingIdentity({ path: "a\u0000.ts", severity: "info", category: "", message: "m" });
  assert.match(nulled, /^[0-9a-f]{64}$/);
  assert.equal(nulled, findingIdentity({ path: "a\u0000.ts", severity: "info", category: "", message: "m" }));
  // The field encoding is injective even when a field carries the historical
  // NUL separator: these two tuples shared a digest under a bare NUL join
  // ("a\0x\0y\0\0m"), which would have merged two distinct findings into one
  // identity — one finding's dismissal could then be read as the other's.
  assert.notEqual(
    findingIdentity({ path: "a\u0000x", severity: "y", category: "", message: "m" }),
    findingIdentity({ path: "a", severity: "x\u0000y", category: "", message: "m" }),
  );
  assert.notEqual(
    findingIdentity({ path: "a.ts", severity: "major", category: "x\u0000y", message: "z" }),
    findingIdentity({ path: "a.ts", severity: "major", category: "x", message: "y\u0000z" }),
  );
});

test("#1027 marker: strict grammar round-trip and near-miss retention", () => {
  const digest = findingIdentity({ path: "a.ts", severity: "info", message: "m" });
  const marker = renderFindingIdentityMarker(digest)!;
  assert.equal(marker, `\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`);
  const body = `**Major (bug):** m\n\n_Automated finding from AI PR review._${marker}`;
  assert.equal(parseFindingIdentityMarker(body), digest);
  const stripped = stripFindingIdentityMarkers(body);
  assert.equal(stripped, `**Major (bug):** m\n\n_Automated finding from AI PR review._\n`);
  assert.equal(parseFindingIdentityMarker(stripped), null);
  assert.equal(renderFindingIdentityMarker("NOT-A-DIGEST"), null);
  assert.equal(renderFindingIdentityMarker(`${digest}x`), null);
  // Near-misses are ordinary content: retained by the strip, refused by the parser.
  const nearMisses = [
    `<!-- pr-reviewer:finding-id:v1:${"a".repeat(63)} -->`,
    `<!-- pr-reviewer:finding-id:v1:${"a".repeat(65)} -->`,
    `<!-- pr-reviewer:finding-id:v1:${"A".repeat(64)} -->`,
    `<!-- pr-reviewer:finding-id:v1:${digest} --> trailing text`,
  ];
  for (const nearMiss of nearMisses) {
    const body2 = `content\n${nearMiss}\nmore`;
    assert.equal(stripFindingIdentityMarkers(body2), body2, nearMiss);
    assert.equal(parseFindingIdentityMarker(body2), null, nearMiss);
  }
  // Two distinct digests fail closed.
  const other = "b".repeat(64);
  const ambiguous = `x${marker}\n<!-- pr-reviewer:finding-id:v1:${other} -->`;
  assert.equal(parseFindingIdentityMarker(ambiguous), null);
  // Identical duplicates collapse.
  assert.equal(parseFindingIdentityMarker(`x${marker}\ny${marker}`), digest);
});

test("#1027 event normalization: fail-closed per kind", () => {
  const base: OutcomeEvent = {
    finding_id: "a".repeat(64),
    kind: "reported",
    at: AT,
    head_sha: HEAD_A,
    route: "primary",
    model: "m",
    provenance: "current-review",
  };
  assert.deepEqual(normalizeOutcomeEvent(base), base);
  // Bad id, kind, provenance → null.
  assert.equal(normalizeOutcomeEvent({ ...base, finding_id: "zz" }), null);
  assert.equal(normalizeOutcomeEvent({ ...base, kind: "invented" }), null);
  assert.equal(normalizeOutcomeEvent({ ...base, provenance: "nowhere" }), null);
  // A feedback event cannot smuggle an adjudication label; the label is dropped.
  const feedback = normalizeOutcomeEvent({ ...base, kind: "feedback", signal: "not_helpful", count: 2, label: "confirmed_false_positive" })!;
  assert.equal(feedback.signal, "not_helpful");
  assert.equal(feedback.label, undefined);
  // An adjudication event without a valid label is rejected outright.
  assert.equal(normalizeOutcomeEvent({ ...base, kind: "adjudication", label: "kind_of_fine" }), null);
  assert.equal(
    normalizeOutcomeEvent({ ...base, provenance: "operator", kind: "adjudication", label: "confirmed_false_positive", actor: "maintainer" })!.actor,
    "maintainer",
  );
  // #1027: an adjudication from any non-operator provenance — or without an
  // actor — is not an adjudication.
  assert.equal(normalizeOutcomeEvent({ ...base, kind: "adjudication", label: "confirmed_false_positive", actor: "attacker" }), null);
  assert.equal(normalizeOutcomeEvent({ ...base, provenance: "operator", kind: "adjudication", label: "confirmed_false_positive" }), null);
  // Unparseable timestamps become null, never fabricated.
  assert.equal(normalizeOutcomeEvent({ ...base, at: "not-a-date" })!.at, null);
  // Reason text is redacted and bounded.
  const dismissed = normalizeOutcomeEvent({
    ...base, kind: "dismissed", reason: `secret github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef12 ${"x".repeat(500)}`,
  })!;
  assert.ok(dismissed.reason!.includes("[REDACTED]"));
  assert.ok(dismissed.reason!.length <= 200);
});

test("#1027 reconcile: reported vs repeated, line drift keeps identity", () => {
  const events = deriveOutcomeEvents({
    postedIdentities: [findingIdentityFromRecord(findingRecord({ line: 12 }))!, findingIdentityFromRecord(findingRecord({ line: 40 }))!],
    prior: [observation()],
    priorHeadSha: HEAD_A,
    currentHeadSha: HEAD_B,
    ...META,
  });
  assert.equal(events.filter((event) => event.kind === "repeated").length, 1);
  assert.equal(events.filter((event) => event.kind === "reported").length, 0);
  const first = events.find((event) => event.kind === "repeated")!;
  assert.equal(first.provenance, "current-review");
  assert.equal(first.head_sha, HEAD_B);
  assert.equal(first.route, "primary");
  assert.equal(first.model, "test-model");
});

test("#1027 reconcile: resolved after a provably newer head; dismissed otherwise", () => {
  const advanced = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [observation({ resolved: true })],
    priorHeadSha: HEAD_A,
    currentHeadSha: HEAD_B,
    ...META,
  });
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0]!.kind, "resolved");
  assert.equal(advanced[0]!.reason, undefined);

  const sameHead = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [observation({ resolved: true })],
    priorHeadSha: HEAD_A,
    currentHeadSha: HEAD_A,
    ...META,
  });
  assert.equal(sameHead[0]!.kind, "dismissed");
  assert.equal(sameHead[0]!.reason, "thread_resolved");

  const unknownHead = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [observation({ resolved: true })],
    priorHeadSha: null,
    currentHeadSha: HEAD_B,
    ...META,
  });
  assert.equal(unknownHead[0]!.kind, "dismissed");
  assert.equal(unknownHead[0]!.reason, "thread_resolved_head_unverified");
});

test("#1027 reconcile: open threads, unprovable state, reactions informational", () => {
  const events = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [
      observation({ commentId: "1", resolved: false, reactions: { helpful: 2, notHelpful: 1 } }),
      observation({ commentId: "2", findingId: "e".repeat(64), resolved: null }),
    ],
    priorHeadSha: null,
    currentHeadSha: HEAD_B,
    ...META,
  });
  const kinds = events.map((event) => `${event.finding_id}:${event.kind}`);
  assert.deepEqual(kinds, [
    `${observation().findingId}:still_open`,
    `${observation().findingId}:feedback`,
    `${observation().findingId}:feedback`,
  ]);
  const feedback = events.filter((event) => event.kind === "feedback");
  assert.deepEqual(feedback.map((event) => [event.signal, event.count, event.trusted]), [["helpful", 2, false], ["not_helpful", 1, false]]);
  assert.equal(feedback.every((event) => event.provenance === "forge-reaction"), true);
  assert.equal(events.some((event) => event.kind === "resolved" || event.kind === "dismissed"), false);
});

test("#1027 reconcile: ledger merge, lost history, dedupe, cap", () => {
  const oldEvents: OutcomeEvent[] = [
    { finding_id: observation().findingId, kind: "reported", at: "2026-10-01T00:00:00.000Z", head_sha: HEAD_A, route: null, model: null, provenance: "current-review" },
    { finding_id: "c".repeat(64), kind: "reported", at: "2026-10-01T00:00:00.000Z", head_sha: HEAD_A, route: null, model: null, provenance: "current-review" },
  ];
  // The current run re-reports the first identity and drops the second: it
  // is gone from both findings and observations → unknown (lost history).
  const merged = deriveOutcomeEvents({
    postedIdentities: [findingIdentityFromRecord(findingRecord())!],
    prior: [],
    priorHeadSha: HEAD_A,
    currentHeadSha: HEAD_B,
    ...META,
    priorLedger: oldEvents,
  });
  assert.equal(merged.filter((event) => event.kind === "unknown").length, 1);
  assert.equal(merged.find((event) => event.kind === "unknown")!.finding_id, "c".repeat(64));
  assert.equal(merged.find((event) => event.kind === "unknown")!.provenance, "prior-ledger");
  // A still-lost identity is re-derived each run (a new instant), so the
  // merge adds one more unknown; everything else collapses.
  const deduped = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [],
    priorHeadSha: null,
    currentHeadSha: HEAD_B,
    ...META,
    priorLedger: merged,
  });
  assert.equal(deduped.length, merged.length + 1);
  assert.equal(deduped.filter((event) => event.kind === "unknown").length, 2);
  // Cap keeps the LATEST events.
  const many: OutcomeEvent[] = Array.from({ length: MAX_LEDGER_EVENTS + 10 }, (_unused, index) => ({
    finding_id: "d".repeat(64),
    kind: "feedback",
    at: AT,
    head_sha: null,
    route: null,
    model: null,
    provenance: "forge-reaction",
    signal: "helpful" as const,
    count: index,
  }));
  const capped = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [],
    priorHeadSha: null,
    currentHeadSha: HEAD_B,
    ...META,
    priorLedger: many,
  });
  assert.equal(capped.length, MAX_LEDGER_EVENTS);
  assert.equal(capped.at(-1)!.count, MAX_LEDGER_EVENTS + 9);
});

test("#1027 ledger dedupe: separator-bearing fields cannot collapse two distinct events", () => {
  const fid = observation().findingId;
  const T = "2026-01-01T00:00:00.000Z";
  // Both events pass the fail-closed normalizer: the odd `at` keeps the ISO
  // prefix and Date.parse accepts its trailing NULs, and `reason` is bounded
  // free text that never strips NUL.
  const forgedAt = normalizeOutcomeEvent({
    finding_id: fid, kind: "dismissed", at: `${T}\u0000\u0000forged-reason`,
    reason: "x", provenance: "current-review",
  });
  const plain = normalizeOutcomeEvent({
    finding_id: fid, kind: "dismissed", at: T,
    reason: "forged-reason\u0000\u0000x", provenance: "current-review",
  });
  assert.notEqual(forgedAt, null);
  assert.notEqual(plain, null);
  assert.notEqual(forgedAt!.at, plain!.at);
  assert.notEqual(forgedAt!.reason, plain!.reason);
  // Under the old bare-NUL join these two DISTINCT events produced ONE key
  // ("…T\0\0forged-reason\0\0x\0…"), so the merge silently dropped the
  // second dismissal; the JSON-encoded key keeps them distinct.
  const merged = deriveOutcomeEvents({
    postedIdentities: [],
    prior: [],
    priorHeadSha: null,
    currentHeadSha: HEAD_B,
    ...META,
    priorLedger: [forgedAt!, plain!],
  });
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((event) => event.reason), ["x", "forged-reason\u0000\u0000x"]);
});

test("#1027 ACCEPTANCE FIXTURE: resolution and dislike never inflate adjudicated precision", () => {
  const events = deriveOutcomeEvents({
    postedIdentities: [findingIdentityFromRecord(findingRecord({ file: "src/other.ts", message: "still open elsewhere" }))!],
    prior: [
      // A maintainer resolved the fixed finding's thread after a newer head.
      observation({ resolved: true }),
      // A different finding was disliked but its thread is still open.
      observation({ commentId: "200", findingId: "e".repeat(64), resolved: false, reactions: { helpful: 0, notHelpful: 3 } }),
    ],
    priorHeadSha: HEAD_A,
    currentHeadSha: HEAD_B,
    ...META,
  });
  const aggregate = aggregateOutcomeEvents(events);
  // Resolution counted exactly once, as resolution.
  assert.equal(aggregate.resolved, 1);
  assert.equal(aggregate.dismissed, 0);
  // The disliked finding stays OPEN — a 👎 never resolves, dismisses, or reclassifies.
  assert.equal(aggregate.open, 2);
  assert.equal(aggregate.reactions.not_helpful, 3);
  // And with no adjudication events, adjudicated precision is null, not 0 or 1.
  assert.equal(aggregate.adjudicated.precision, null);
  assert.equal(aggregate.adjudicated.confirmed_valid_defect, 0);
  assert.equal(aggregate.adjudicated.confirmed_false_positive, 0);
  assert.equal(aggregate.unique_findings, 3);
  const markdown = renderOutcomeReportMarkdown(aggregate);
  assert.ok(markdown.includes("Resolved: 1"));
  assert.ok(markdown.includes("n/a (no adjudications)"));
  assert.ok(!markdown.includes("src/app.ts"));
});

test("#1027 aggregate: re-reported after resolution counts open; adjudication moves precision", () => {
  const identity = "f".repeat(64);
  const events: OutcomeEvent[] = [
    { finding_id: identity, kind: "reported", at: AT, head_sha: HEAD_A, route: null, model: null, provenance: "current-review" },
    { finding_id: identity, kind: "resolved", at: AT, head_sha: HEAD_B, route: null, model: null, provenance: "forge-thread" },
    { finding_id: identity, kind: "repeated", at: AT, head_sha: HEAD_B, route: null, model: null, provenance: "current-review" },
    { finding_id: identity, kind: "adjudication", at: AT, head_sha: null, route: null, model: null, provenance: "operator", label: "confirmed_valid_defect", actor: "maintainer" },
    { finding_id: "9".repeat(64), kind: "adjudication", at: AT, head_sha: null, route: null, model: null, provenance: "operator", label: "confirmed_false_positive", actor: "maintainer" },
  ];
  const aggregate = aggregateOutcomeEvents(events);
  assert.equal(aggregate.open, 1);
  assert.equal(aggregate.resolved, 0);
  assert.equal(aggregate.unique_findings, 2);
  assert.equal(aggregate.adjudicated.precision, 0.5);
});

test("#1027 ledger: fail-closed parse and stable round-trip", () => {
  const events: OutcomeEvent[] = [
    { finding_id: "a".repeat(64), kind: "reported", at: AT, head_sha: HEAD_A, route: "primary", model: "m", provenance: "current-review" },
  ];
  const ledger = {
    schema: FINDING_OUTCOMES_SCHEMA,
    generated_at: AT,
    head_sha: HEAD_A,
    route: "primary",
    model: "m",
    events,
    aggregate: aggregateOutcomeEvents(events),
  };
  const serialized = serializeOutcomeLedger(ledger);
  const parsed = parseOutcomeLedger(serialized)!;
  assert.equal(parsed.schema, FINDING_OUTCOMES_SCHEMA);
  assert.deepEqual(parsed.events, events);
  assert.equal(parsed.aggregate.unique_findings, 1);
  // Any corruption fails closed to null.
  assert.equal(parseOutcomeLedger("not json"), null);
  assert.equal(parseOutcomeLedger(JSON.stringify({ ...ledger, schema: "finding-outcomes/v2" })), null);
  assert.equal(parseOutcomeLedger(JSON.stringify({ ...ledger, events: [{ finding_id: "nope" }] })), null);
  assert.equal(parseOutcomeLedger(JSON.stringify({ ...ledger, generated_at: "nope" })), null);
  assert.equal(parseOutcomeLedger(""), null);
  // #1027: the serialized aggregate is never trusted. A tampered or stale one
  // is recomputed from the events the reader will actually see.
  const tampered = parseOutcomeLedger(JSON.stringify({
    ...ledger,
    aggregate: { unique_findings: 99, open: 99, resolved: 99, dismissed: 99, unknown: 99, reactions: { helpful: 9, not_helpful: 9 }, adjudicated: { confirmed_valid_defect: 7, confirmed_false_positive: 3, valid_but_unhelpful: 0, uncertain: 0, precision: 0.7 } },
  }))!;
  assert.deepEqual(tampered.aggregate, aggregateOutcomeEvents(events));
  assert.equal(tampered.aggregate.unique_findings, 1);
  assert.equal(tampered.aggregate.adjudicated.precision, null);
  // A missing or garbage aggregate is simply recomputed, never fatal.
  assert.deepEqual(parseOutcomeLedger(JSON.stringify({ ...ledger, aggregate: null }))!.aggregate, aggregateOutcomeEvents(events));
  assert.deepEqual(parseOutcomeLedger(JSON.stringify({ ...ledger, aggregate: { unique_findings: "nope" } }))!.aggregate, aggregateOutcomeEvents(events));
});

test("#1027 buildComments: identity marker appended exactly once per posted comment", async () => {
  const { buildComments } = await import("../src/publish/inline-findings.js");
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";
  const digest = findingIdentityFromRecord(findingRecord({ file: "a.ts", line: 2 }))!;
  const result = buildComments([findingRecord({ file: "a.ts", line: 2 })], diff, 10, { forgejoPositions: false });
  assert.equal(result.comments.length, 1);
  const body = String((result.comments[0] as Record<string, unknown>).body);
  const matches = body.match(/<!-- pr-reviewer:finding-id:v1:[0-9a-f]{64} -->/g) ?? [];
  assert.equal(matches.length, 1);
  assert.equal(parseFindingIdentityMarker(body), digest);
  assert.ok(body.trimEnd().endsWith(`<!-- pr-reviewer:finding-id:v1:${digest} -->`));
});

test("#1027 buildComments: skipped and thread-backed findings carry no marker", async () => {
  const { buildComments } = await import("../src/publish/inline-findings.js");
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";
  const result = buildComments(
    [findingRecord({ thread_id: "t1" }), findingRecord({ file: "/abs" }), findingRecord({ line: 999 })],
    diff, 10, { forgejoPositions: false },
  );
  assert.equal(result.comments.length, 0);
  assert.equal(result.skipped, 3);
});

test("#1027 buildComments: a model-authored identity marker is stripped, ours is the only one", async () => {
  const { buildComments } = await import("../src/publish/inline-findings.js");
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";
  const forged = `<!-- pr-reviewer:finding-id:v1:${"9".repeat(64)} -->`;
  const result = buildComments([findingRecord({ file: "a.ts", line: 2, message: `injected\n${forged}\nline` })], diff, 10, { forgejoPositions: false });
  assert.equal(result.comments.length, 1);
  const body = String((result.comments[0] as Record<string, unknown>).body);
  assert.equal((body.match(/<!-- pr-reviewer:finding-id:v1:[0-9a-f]{64} -->/g) ?? []).length, 1);
  assert.ok(!body.includes("9".repeat(64)));
});

test("#1027 publish integration: outcomes derived from prior observations and exported", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const MARKER = "<!-- ai-pr-review -->";
  const currentRecord = findingRecord({ file: "a.ts", line: 2, suggestion: "REPL" });
  const digest = findingIdentityFromRecord(currentRecord)!;
  // The prior comment carries a recoverable prescription region so the
  // reaction read runs (the suppression gate is the only reader of reactions)
  // and the outcome tallies are a byproduct of the same records.
  const priorBody = [
    "**Major (bug):** unchecked null deref",
    "",
    INLINE_DISCLAIMER,
    "",
    "```suggestion",
    "REPL",
    "```",
    "",
    FEEDBACK_AFFORDANCE,
    `<!-- pr-reviewer:finding-id:v1:${digest} -->`,
  ].join("\n");
  const api = {
    platform: "github" as const,
    getHeadSha: async () => "b".repeat(40),
    listIssueComments: async () => [],
    upsertStickyComment: async () => ({ ok: true, commentId: 5, updatedAt: "now" }),
    listReviews: async () => [{ id: 500, body: `${MARKER}\nreview`, user: { login: "bot" }, state: "COMMENT" }],
    listManagedInlineComments: async () => ({
      supported: true,
      complete: true,
      comments: [{ id: 77, reviewId: 500, body: priorBody, path: "a.ts", line: 2, user: { login: "bot" } }],
    }),
    retireInlineComment: async () => true,
    createReview: async () => ({ ok: true, reviewId: 1000 }),
    dismissReview: async () => true,
    minimizedReviewIds: async () => [],
    minimizeReview: async () => true,
    unresolvedSupersededThreads: async () => ({ ok: true, threads: [], hasNextPage: false }),
    resolveThread: async () => true,
    removeLabel: async () => true,
    requestReviewers: async () => ({ supported: true, ok: true, requestedUsers: [], requestedTeams: [] }),
    collaboratorPermission: async () => null,
    resolveTrustedOwner: async () => ({ identity: { kind: "login" as const, login: "bot" }, reason: "user-login" }),
    reviewCommentFeedback: async () => ({
      supported: true,
      complete: true,
      records: [{ commentId: "77", content: "-1" as const, login: "someone" }],
    }),
    reviewThreadStates: async () => ({
      supported: true,
      complete: true,
      threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }],
    }),
  };
  const result = await publishReview({
    mode: "review_comment",
    reviewMarkdown: "# review",
    verdict: "request_changes",
    analysisEngine: "test-model",
    baseSha: "base",
    headSha: "b".repeat(40),
    prNumber: "8",
    commentMarker: MARKER,
    requiredChecks: "",
    reviewRoute: "primary",
    escalationReason: "",
    cacheHitRatio: "",
    inlineFindings: true,
    inlineFindingsMax: 5,
    findings: [currentRecord],
    cleanupPreviousNativeReviews: "false",
    allowApprove: false,
    approveForks: false,
    isForkPr: false,
    upstreamLinkMode: "inert",
    conditionalPresence: { linkedIssue: false, evidenceProvider: false, standards: false, toolHarnessFindings: false, toolHarnessResults: false },
    forgejoPositions: false,
    priorHeadSha: "a".repeat(40),
  }, api as never, { diffText: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n" });
  assert.equal(result.status, "published");
  assert.ok(result.outcomes !== undefined);
  const ledger = parseOutcomeLedger(result.outcomes!)!;
  assert.equal(ledger.schema, FINDING_OUTCOMES_SCHEMA);
  const kinds = ledger.events.map((event) => event.kind).sort();
  assert.deepEqual(kinds, ["feedback", "repeated", "resolved"]);
  // The finding is re-reported this run, so despite its old thread being
  // resolved the LATEST truth is open again.
  assert.equal(ledger.aggregate.open, 1);
  assert.equal(ledger.aggregate.resolved, 0);
  assert.equal(ledger.aggregate.reactions.not_helpful, 1);
  assert.equal(ledger.aggregate.adjudicated.precision, null);
  assert.ok(result.messages.some((message) => message.startsWith("Finding outcomes:")));
});

test("#1027 publish integration: unsupported or incomplete reads degrade to no outcomes", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const MARKER = "<!-- ai-pr-review -->";
  const base = {
    platform: "github" as const,
    getHeadSha: async () => "b".repeat(40),
    listIssueComments: async () => [],
    upsertStickyComment: async () => ({ ok: true, commentId: 5, updatedAt: "now" }),
    listReviews: async () => [{ id: 500, body: `${MARKER}\nreview`, user: { login: "bot" }, state: "COMMENT" }],
    retireInlineComment: async () => true,
    createReview: async () => ({ ok: true, reviewId: 1000 }),
    dismissReview: async () => true,
    minimizedReviewIds: async () => [],
    minimizeReview: async () => true,
    unresolvedSupersededThreads: async () => ({ ok: true, threads: [], hasNextPage: false }),
    resolveThread: async () => true,
    removeLabel: async () => true,
    requestReviewers: async () => ({ supported: true, ok: true, requestedUsers: [], requestedTeams: [] }),
  };
  const input = {
    mode: "review_comment" as const,
    reviewMarkdown: "# review",
    verdict: "request_changes",
    analysisEngine: "test-model",
    baseSha: "base",
    headSha: "b".repeat(40),
    prNumber: "8",
    commentMarker: MARKER,
    requiredChecks: "",
    reviewRoute: "primary",
    escalationReason: "",
    cacheHitRatio: "",
    inlineFindings: true,
    inlineFindingsMax: 5,
    findings: [findingRecord()],
    cleanupPreviousNativeReviews: "false",
    allowApprove: false,
    approveForks: false,
    isForkPr: false,
    upstreamLinkMode: "inert" as const,
    conditionalPresence: { linkedIssue: false, evidenceProvider: false, standards: false, toolHarnessFindings: false, toolHarnessResults: false },
    forgejoPositions: false,
  };
  // Incomplete managed-comment enumeration → no outcomes at all.
  const incompleteApi = { ...base, listManagedInlineComments: async () => ({ supported: true, complete: false, comments: [] }) };
  const incomplete = await publishReview(input, incompleteApi as never, { diffText: "" });
  assert.equal(incomplete.outcomes, undefined);
  // No seam methods at all (older adapter) → no outcomes, publish unaffected.
  const legacy = await publishReview(input, base as never, { diffText: "" });
  assert.equal(legacy.status, "published");
  assert.equal(legacy.outcomes, undefined);
  assert.equal(legacy.messages.some((message) => message.startsWith("Finding outcomes:")), false);
  // The fail-closed side must not regress: an incomplete enumeration is an
  // UNCERTAIN prior even when this run's own finding would otherwise post a
  // `reported` event, so no artifact is produced.
  const postable = { file: "a.ts", line: 2, severity: "major", category: "bug", message: "unchecked null deref" };
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";
  const incompletePosting = await publishReview(
    { ...input, findings: [postable] },
    { ...base, listManagedInlineComments: async () => ({ supported: true, complete: false, comments: [] }) } as never,
    { diffText: diff },
  );
  assert.equal(incompletePosting.status, "published");
  assert.equal(incompletePosting.outcomes, undefined);
  // The same finding with a COMPLETE enumeration does produce the artifact, so
  // the assertion above is about the enumeration, not about posting.
  const completePosting = await publishReview(
    { ...input, findings: [postable] },
    { ...base, listManagedInlineComments: async () => ({ supported: true, complete: true, comments: [] }) } as never,
    { diffText: diff },
  );
  assert.deepEqual(parseOutcomeLedger(completePosting.outcomes!)!.events.map((event) => event.kind), ["reported"]);
});

test("#1027 publishWith writes the artifact on a repository with no prior review at all", async () => {
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { publishWith } = await import("../src/run/entrypoints.js");
  const currentRecord = findingRecord({ file: "a.ts", line: 2 });
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";
  // A completed enumeration that finds NO managed review of ours proves the
  // prior set is empty — a positive reading, not an uncertain one. The
  // first-ever publication on a repository must still write the artifact.
  const api = { ...outcomesFake({ platform: "forgejo", comments: [] }), listReviews: async () => [] };
  const seam = { api, platform: "forgejo", diffProvider: async () => diff };
  const runDir = mkdtempSync(join(tmpdir(), "outcomes-empty-prior-"));
  try {
    const exit = await publishWith(publishInputFor({ findings: [currentRecord] }) as never, seam as never, runDir);
    assert.equal(exit, 0);
    const artifact = join(runDir, "finding-outcomes.json");
    assert.equal(existsSync(artifact), true);
    const ledger = parseOutcomeLedger(readFileSync(artifact, "utf8"))!;
    assert.deepEqual(ledger.events.map((event) => event.kind), ["reported"]);
    assert.equal(ledger.aggregate.unique_findings, 1);
    assert.equal(ledger.aggregate.open, 1);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("#1027 publishWith writes the artifact into the run dir; nothing without a run dir", async () => {
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { publishWith } = await import("../src/run/entrypoints.js");
  const MARKER = "<!-- ai-pr-review -->";
  const digest = findingIdentityFromRecord(findingRecord())!;
  const priorBody = `**Major (bug):** unchecked null deref\n\n_Automated finding from AI PR review._\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`;
  const api = {
    platform: "github" as const,
    getHeadSha: async () => "b".repeat(40),
    listIssueComments: async () => [],
    upsertStickyComment: async () => ({ ok: true, commentId: 5, updatedAt: "now" }),
    listReviews: async () => [{ id: 500, body: `${MARKER}\nreview`, user: { login: "bot" }, state: "COMMENT" }],
    listManagedInlineComments: async () => ({
      supported: true,
      complete: true,
      comments: [{ id: 77, reviewId: 500, body: priorBody, path: "a.ts", line: 2, user: { login: "bot" } }],
    }),
    retireInlineComment: async () => true,
    createReview: async () => ({ ok: true, reviewId: 1000 }),
    dismissReview: async () => true,
    minimizedReviewIds: async () => [],
    minimizeReview: async () => true,
    unresolvedSupersededThreads: async () => ({ ok: true, threads: [], hasNextPage: false }),
    resolveThread: async () => true,
    removeLabel: async () => true,
    requestReviewers: async () => ({ supported: true, ok: true, requestedUsers: [], requestedTeams: [] }),
    collaboratorPermission: async () => null,
    resolveTrustedOwner: async () => ({ identity: { kind: "login" as const, login: "bot" }, reason: "user-login" }),
    reviewCommentFeedback: async () => ({ supported: true, complete: true, records: [] }),
    reviewThreadStates: async () => ({ supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] }),
  };
  const input = {
    mode: "review_comment" as const,
    reviewMarkdown: "# review",
    verdict: "request_changes",
    analysisEngine: "test-model",
    baseSha: "base",
    headSha: "b".repeat(40),
    prNumber: "8",
    commentMarker: MARKER,
    requiredChecks: "",
    reviewRoute: "primary",
    escalationReason: "",
    cacheHitRatio: "",
    inlineFindings: true,
    inlineFindingsMax: 5,
    findings: [findingRecord()],
    cleanupPreviousNativeReviews: "false",
    allowApprove: false,
    approveForks: false,
    isForkPr: false,
    upstreamLinkMode: "inert" as const,
    conditionalPresence: { linkedIssue: false, evidenceProvider: false, standards: false, toolHarnessFindings: false, toolHarnessResults: false },
    forgejoPositions: false,
    priorHeadSha: "a".repeat(40),
  };
  const seam = { api, platform: "github", diffProvider: async () => "" };
  const runDir = mkdtempSync(join(tmpdir(), "outcomes-artifact-"));
  try {
    const exit = await publishWith(input as never, seam as never, runDir);
    assert.equal(exit, 0);
    const artifact = join(runDir, "finding-outcomes.json");
    assert.equal(existsSync(artifact), true);
    const ledger = parseOutcomeLedger(readFileSync(artifact, "utf8"))!;
    assert.equal(ledger.schema, FINDING_OUTCOMES_SCHEMA);
    assert.ok(ledger.events.length > 0);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/** A shared fake shaped like the real publish seams, for the #1027
 * publish-level behavior tests. */
function outcomesFake(options: {
  comments?: Array<{ id: number; body: string; user?: { login: string } | null }>;
  stickyBody?: string;
  /** Issue comments (sticky candidates) in the order the forge returns them
   * (oldest-first); `id` defaults to the array position, `user` to the trusted
   * owner — the only author the prior published head may be read from. */
  stickyComments?: Array<{ body: string; id?: number; updated_at?: string; user?: { login: string } | null }>;
  threadStates?: { supported: boolean; complete: boolean; threads: Array<{ threadId: string; resolved: boolean; firstCommentId: string }> } | null;
  feedbackRecords?: Array<{ commentId: string; content: "+1" | "-1"; login: string }>;
  submissionOk?: boolean;
  platform?: "github" | "forgejo";
  /** The head the publication-boundary re-check reports (defaults to B). */
  head?: string;
}): Record<string, unknown> {
  const MARKER = "<!-- ai-pr-review -->";
  const sticky = options.stickyComments !== undefined
    ? options.stickyComments.map((comment, index) => ({
      id: comment.id ?? index + 1,
      ...(comment.updated_at === undefined ? {} : { updated_at: comment.updated_at }),
      body: comment.body,
      user: comment.user === undefined ? { login: "bot" } : comment.user,
    }))
    : options.stickyBody === undefined ? [] : [{ id: 1, body: options.stickyBody, user: { login: "bot" } }];
  return {
    platform: options.platform ?? "github",
    getHeadSha: async () => options.head ?? "b".repeat(40),
    listIssueComments: async () => sticky,
    upsertStickyComment: async () => ({ ok: true, commentId: 5, updatedAt: "now" }),
    listReviews: async () => [{ id: 500, body: `${MARKER}\nreview`, user: { login: "bot" }, state: "COMMENT" }],
    listManagedInlineComments: async () => ({
      supported: true,
      complete: true,
      comments: (options.comments ?? []).map((comment) => ({
        id: comment.id, reviewId: 500, body: comment.body, path: "a.ts", line: 2, user: comment.user ?? { login: "bot" },
      })),
    }),
    retireInlineComment: async () => true,
    createReview: async () => (options.submissionOk === false ? { ok: false, error: "no" } : { ok: true, reviewId: 1000 }),
    dismissReview: async () => true,
    minimizedReviewIds: async () => [],
    minimizeReview: async () => true,
    unresolvedSupersededThreads: async () => ({ ok: true, threads: [], hasNextPage: false }),
    resolveThread: async () => true,
    removeLabel: async () => true,
    requestReviewers: async () => ({ supported: true, ok: true, requestedUsers: [], requestedTeams: [] }),
    collaboratorPermission: async () => null,
    resolveTrustedOwner: async () => ({ identity: { kind: "login", login: "bot" }, reason: "user-login" }),
    authenticatedIdentity: async () => "bot",
    ...(options.threadStates === undefined ? {} : { reviewThreadStates: async () => options.threadStates }),
    ...(options.feedbackRecords === undefined ? {} : {
      reviewCommentFeedback: async () => ({ supported: true, complete: true, records: options.feedbackRecords }),
    }),
  };
}

function publishInputFor(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: "review_comment",
    reviewMarkdown: "# review",
    verdict: "request_changes",
    analysisEngine: "test-model@https://internal.example.lan:4000 (openai)",
    baseSha: "base",
    headSha: "b".repeat(40),
    prNumber: "8",
    commentMarker: "<!-- ai-pr-review -->",
    requiredChecks: "",
    reviewRoute: "primary",
    escalationReason: "",
    cacheHitRatio: "",
    inlineFindings: true,
    inlineFindingsMax: 5,
    findings: [],
    cleanupPreviousNativeReviews: "false",
    allowApprove: false,
    approveForks: false,
    isForkPr: false,
    upstreamLinkMode: "inert",
    conditionalPresence: { linkedIssue: false, evidenceProvider: false, standards: false, toolHarnessFindings: false, toolHarnessResults: false },
    forgejoPositions: false,
    ...overrides,
  };
}

const STICKY_WITH_HEAD = (head: string): string =>
  `<!-- ai-pr-review -->\n<!-- ai-pr-reviewer:{"v":1,"head_sha":"${head}","base_sha":"base","review_result":"findings"} -->\nreview body`;

test("#1027: prior published head comes from the managed sticky comment's metadata marker", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const digest = findingIdentityFromRecord(findingRecord())!;
  const priorBody = `**Major (bug):** unchecked null deref\n\n${INLINE_DISCLAIMER}\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`;
  // The maintainer resolved the thread; the prior head (A) differs from the
  // current head (B), so this is a RESOLVED finding, not a dismissal.
  const api = outcomesFake({
    comments: [{ id: 77, body: priorBody }],
    stickyBody: STICKY_WITH_HEAD("a".repeat(40)),
    threadStates: { supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] },
  });
  const result = await publishReview(publishInputFor({}) as never, api as never, { diffText: "" });
  const ledger = parseOutcomeLedger(result.outcomes!)!;
  assert.equal(ledger.aggregate.resolved, 1, "prior head from the marker proves the head advanced");
  assert.equal(ledger.aggregate.dismissed, 0);
  // Same-head sticky marker: a same-head resolution is a dismissal.
  const sameHead = await publishReview(
    publishInputFor({ headSha: "a".repeat(40) }) as never,
    outcomesFake({
      head: "a".repeat(40),
      comments: [{ id: 77, body: priorBody }],
      stickyBody: STICKY_WITH_HEAD("a".repeat(40)),
      threadStates: { supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] },
    }) as never,
    { diffText: "" },
  );
  assert.equal(parseOutcomeLedger(sameHead.outcomes!)!.aggregate.dismissed, 1);
  // No sticky marker at all: the head is unprovable, so resolution claims
  // nothing about code and records an explicit head-unverified dismissal.
  const unknownHead = await publishReview(
    publishInputFor({}) as never,
    outcomesFake({
      comments: [{ id: 77, body: priorBody }],
      threadStates: { supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] },
    }) as never,
    { diffText: "" },
  );
  const unknownLedger = parseOutcomeLedger(unknownHead.outcomes!)!;
  assert.equal(unknownLedger.aggregate.dismissed, 1);
  assert.equal(unknownLedger.events.find((event) => event.kind === "dismissed")!.reason, "thread_resolved_head_unverified");
});

test("#1027: the prior published head is read only from an OWNED managed sticky comment", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const digest = findingIdentityFromRecord(findingRecord())!;
  const priorBody = `**Major (bug):** unchecked null deref\n\n${INLINE_DISCLAIMER}\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`;
  const resolvedThread = { supported: true as const, complete: true as const, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] };
  const run = (stickyComments: Array<{ body: string; id?: number; updated_at?: string; user?: { login: string } }>) =>
    publishReview(
      publishInputFor({}) as never,
      outcomesFake({ comments: [{ id: 77, body: priorBody }], stickyComments, threadStates: resolvedThread }) as never,
      { diffText: "" },
    );
  // A foreign contributor's marker-shaped sticky must not move the head. The
  // forged one comes FIRST and claims the CURRENT head, which would have made
  // the prior head equal and turned the resolution into a dismissal.
  const owned = await run([
    { body: STICKY_WITH_HEAD("b".repeat(40)), user: { login: "pr-author" } },
    { body: STICKY_WITH_HEAD("a".repeat(40)) },
  ]);
  const ownedLedger = parseOutcomeLedger(owned.outcomes!)!;
  assert.equal(ownedLedger.aggregate.resolved, 1, "the head comes from the owned sticky");
  assert.equal(ownedLedger.aggregate.dismissed, 0);
  // Only a foreign sticky: the head is unprovable, so a resolved thread is an
  // explicit head-unverified dismissal — never a `resolved` code claim.
  const foreignOnly = await run([{ body: STICKY_WITH_HEAD("a".repeat(40)), user: { login: "pr-author" } }]);
  const foreignLedger = parseOutcomeLedger(foreignOnly.outcomes!)!;
  assert.equal(foreignLedger.events.some((event) => event.kind === "resolved"), false);
  assert.equal(foreignLedger.aggregate.dismissed, 1);
  assert.equal(foreignLedger.events.find((event) => event.kind === "dismissed")!.reason, "thread_resolved_head_unverified");
  // Two OWNED stickies that disagree: the NEWEST owned publication is the
  // authoritative one, exactly as the sticky upsert picks its patch target —
  // the older one is history, not a competing candidate (requiring global
  // agreement would leave a repo carrying a legacy sticky unable to resolve
  // anything, ever). The OLDER candidate carries the CURRENT head here, so
  // picking it by mistake yields a dismissal, not a resolution: the two
  // candidate orders are distinguishable.
  const twoOwned = await run([
    { body: STICKY_WITH_HEAD("b".repeat(40)) },
    { body: STICKY_WITH_HEAD("a".repeat(40)) },
  ]);
  const twoOwnedLedger = parseOutcomeLedger(twoOwned.outcomes!)!;
  assert.equal(twoOwnedLedger.aggregate.resolved, 1, "the newest owned sticky is authoritative");
  assert.equal(twoOwnedLedger.aggregate.dismissed, 0);
  // `updated_at` is the primary key of that selection, ahead of the id and the
  // list order: the LIVE publication here is the second comment (a later run
  // re-published the sticky, so its `updated_at` is the newest) and it carries
  // the current head, while the older comment still shows the previous head. A
  // first-in-list or id-first selection reads the stale one and would claim the
  // head advanced.
  const newestByUpdate = await run([
    { body: STICKY_WITH_HEAD("a".repeat(40)), id: 1, updated_at: "2026-10-01T00:00:00Z" },
    { body: STICKY_WITH_HEAD("b".repeat(40)), id: 2, updated_at: "2026-10-05T00:00:00Z" },
  ]);
  const editedLedger = parseOutcomeLedger(newestByUpdate.outcomes!)!;
  assert.equal(editedLedger.aggregate.dismissed, 1, "updated_at decides over id and list order");
  assert.equal(editedLedger.aggregate.resolved, 0);
  // An unusable head on the newest owned candidate fails closed instead of
  // falling back to an older comment.
  const unusableNewest = await run([
    { body: STICKY_WITH_HEAD("a".repeat(40)) },
    { body: "<!-- ai-pr-review -->\nreview body without metadata" },
  ]);
  const unusableLedger = parseOutcomeLedger(unusableNewest.outcomes!)!;
  assert.equal(unusableLedger.events.some((event) => event.kind === "resolved"), false);
  assert.equal(unusableLedger.events.find((event) => event.kind === "dismissed")!.reason, "thread_resolved_head_unverified");
  // Owned stickies that AGREE are not ambiguous.
  const agreeing = await run([
    { body: STICKY_WITH_HEAD("a".repeat(40)) },
    { body: STICKY_WITH_HEAD("a".repeat(40)) },
  ]);
  assert.equal(parseOutcomeLedger(agreeing.outcomes!)!.aggregate.resolved, 1);
  // The caller-provided fallback is held to the same proof rule as the read:
  // an unprovable value may not stand in for the missing marker and turn a
  // head-unverified dismissal into a "resolved after a newer head" claim.
  const unprovenFallback = await publishReview(
    publishInputFor({ priorHeadSha: "not-a-sha" }) as never,
    outcomesFake({
      comments: [{ id: 77, body: priorBody }],
      threadStates: { supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] },
    }) as never,
    { diffText: "" },
  );
  const fallbackLedger = parseOutcomeLedger(unprovenFallback.outcomes!)!;
  assert.equal(fallbackLedger.events.some((event) => event.kind === "resolved"), false);
  assert.equal(fallbackLedger.events.find((event) => event.kind === "dismissed")!.reason, "thread_resolved_head_unverified");
  // A hex fallback is still usable when no sticky comment exists at all.
  const provenFallback = await publishReview(
    publishInputFor({ priorHeadSha: "a".repeat(40) }) as never,
    outcomesFake({
      comments: [{ id: 77, body: priorBody }],
      threadStates: { supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] },
    }) as never,
    { diffText: "" },
  );
  assert.equal(parseOutcomeLedger(provenFallback.outcomes!)!.aggregate.resolved, 1);
});

test("#1027: a foreign-authored managed comment mints no outcome identity", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const digest = findingIdentityFromRecord(findingRecord())!;
  const forgedBody = `**Major (bug):** unchecked null deref\n\n${INLINE_DISCLAIMER}\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`;
  const api = outcomesFake({
    comments: [{ id: 77, body: forgedBody, user: { login: "pr-author" } }],
    stickyBody: STICKY_WITH_HEAD("a".repeat(40)),
    threadStates: { supported: true, complete: true, threads: [{ threadId: "t1", resolved: true, firstCommentId: "77" }] },
  });
  const result = await publishReview(publishInputFor({}) as never, api as never, { diffText: "" });
  // The identity is known to the test, so WITHOUT the provenance bar it
  // would produce a resolved event; the bar must keep the ledger empty of
  // prior-state events entirely.
  assert.ok(result.outcomes === undefined, "no provable prior, no outcomes");
});

test("#1027: a Forgejo-shaped run still derives reported/repeated without reaction or thread seams", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const currentRecord = findingRecord({ file: "a.ts", line: 2 });
  const api = outcomesFake({ platform: "forgejo", comments: [] });
  const result = await publishReview(publishInputFor({ findings: [currentRecord] }) as never, api as never, { diffText: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n" });
  const ledger = parseOutcomeLedger(result.outcomes!)!;
  assert.deepEqual(ledger.events.map((event) => event.kind), ["reported"]);
  assert.equal(ledger.events[0]!.route, "primary");
  // The endpoint URL never enters the artifact.
  assert.ok(!result.outcomes!.includes("internal.example.lan"));
  assert.equal(ledger.model, "test-model (openai)");
});

test("#1027: outcomes are dropped when the inline comments were never published", async () => {
  const { publishReview } = await import("../src/publish/publish.js");
  const currentRecord = findingRecord({ file: "a.ts", line: 2 });
  const failed = await publishReview(
    publishInputFor({ findings: [currentRecord], submissionOk: false }) as never,
    outcomesFake({ comments: [], submissionOk: false }) as never,
    { diffText: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n" },
  );
  assert.equal(failed.status, "published");
  assert.equal(failed.outcomes, undefined);
  // Comment mode never publishes inline findings — no outcomes either.
  const commentMode = await publishReview(
    publishInputFor({ mode: "comment", findings: [currentRecord] }) as never,
    outcomesFake({ comments: [] }) as never,
    { diffText: "" },
  );
  assert.equal(commentMode.outcomes, undefined);
});

test("#1027 reconcile: lost history reads the LATEST status-bearing ledger event", () => {
  const identity = "a".repeat(64);
  const T1 = "2026-10-01T00:00:00.000Z";
  const T2 = "2026-10-02T00:00:00.000Z";
  const ledgerEvent = (kind: OutcomeEvent["kind"], at: string): OutcomeEvent => ({
    finding_id: identity,
    kind,
    at,
    head_sha: HEAD_A,
    route: null,
    model: null,
    provenance: kind === "reported" || kind === "repeated" ? "current-review" : "forge-thread",
  });
  const unknownIds = (events: OutcomeEvent[]): string[] =>
    events.filter((event) => event.kind === "unknown").map((event) => event.finding_id);
  const derive = (priorLedger: OutcomeEvent[]): OutcomeEvent[] =>
    deriveOutcomeEvents({ postedIdentities: [], prior: [], priorHeadSha: null, currentHeadSha: HEAD_B, ...META, priorLedger });
  // Reported, then resolved: the finding was accounted for, so its absence
  // from this run is NOT lost history.
  assert.deepEqual(unknownIds(derive([ledgerEvent("reported", T1), ledgerEvent("resolved", T2)])), []);
  // Same history in reversed array order: the timestamp decides, not the index.
  assert.deepEqual(unknownIds(derive([ledgerEvent("resolved", T2), ledgerEvent("reported", T1)])), []);
  // Still open at the latest status — exactly one unknown, either order.
  assert.deepEqual(unknownIds(derive([ledgerEvent("reported", T1), ledgerEvent("still_open", T2)])), [identity]);
  assert.deepEqual(unknownIds(derive([ledgerEvent("still_open", T2), ledgerEvent("reported", T1)])), [identity]);
  // A dismissal before the run is closed, not lost either.
  assert.deepEqual(unknownIds(derive([ledgerEvent("dismissed", T1), ledgerEvent("reported", T2)])), [identity]);
  // Equal instants fall back to array order (last wins).
  assert.deepEqual(unknownIds(derive([ledgerEvent("reported", AT), ledgerEvent("resolved", AT)])), []);
  assert.deepEqual(unknownIds(derive([ledgerEvent("resolved", AT), ledgerEvent("reported", AT)])), [identity]);
  // Instants compare as instants: `2026-10-01T23:00:00-05:00` IS 04:00Z on the
  // 2nd, so the resolution really is the latest status and nothing is lost —
  // even though its text sorts BEFORE the earlier-in-the-day UTC instant.
  assert.deepEqual(unknownIds(derive([
    ledgerEvent("reported", "2026-10-02T01:00:00Z"),
    ledgerEvent("resolved", "2026-10-01T23:00:00-05:00"),
  ])), []);
});

test("#1027 aggregate: adjudication counts the LATEST label per finding, exactly once", () => {
  const identity = "b".repeat(64);
  const T1 = "2026-10-01T00:00:00.000Z";
  const T2 = "2026-10-02T00:00:00.000Z";
  const adjudicated = (findingId: string, label: AdjudicationLabel, at: string): OutcomeEvent => ({
    finding_id: findingId,
    kind: "adjudication",
    at,
    head_sha: null,
    route: null,
    model: null,
    provenance: "operator",
    label,
    actor: "maintainer",
  });
  // Corrected over time: false_positive@t1 → valid@t2 is ONE finding, and the
  // correction replaces the label it corrects (never 50% precision).
  const corrected = aggregateOutcomeEvents([
    adjudicated(identity, "confirmed_false_positive", T1),
    adjudicated(identity, "confirmed_valid_defect", T2),
  ]);
  assert.equal(corrected.unique_findings, 1);
  assert.equal(corrected.adjudicated.confirmed_valid_defect, 1);
  assert.equal(corrected.adjudicated.confirmed_false_positive, 0);
  assert.equal(corrected.adjudicated.precision, 1);
  // Out-of-order array: the timestamp decides.
  assert.equal(
    aggregateOutcomeEvents([
      adjudicated(identity, "confirmed_valid_defect", T2),
      adjudicated(identity, "confirmed_false_positive", T1),
    ]).adjudicated.precision,
    1,
  );
  // Two identical labels for one finding are still one finding.
  const duplicated = aggregateOutcomeEvents([
    adjudicated(identity, "confirmed_valid_defect", AT),
    adjudicated(identity, "confirmed_valid_defect", AT),
  ]);
  assert.equal(duplicated.unique_findings, 1);
  assert.equal(duplicated.adjudicated.confirmed_valid_defect, 1);
  assert.equal(duplicated.adjudicated.precision, 1);
  // Distinct findings still contribute one label each.
  assert.equal(
    aggregateOutcomeEvents([
      adjudicated(identity, "confirmed_valid_defect", AT),
      adjudicated("c".repeat(64), "confirmed_false_positive", AT),
    ]).adjudicated.precision,
    0.5,
  );
  // Resolution and reactions move status/reaction counts, never the
  // adjudicated numbers.
  const noisy = aggregateOutcomeEvents([
    adjudicated(identity, "confirmed_valid_defect", AT),
    { finding_id: identity, kind: "resolved", at: AT, head_sha: HEAD_B, route: null, model: null, provenance: "forge-thread" },
    { finding_id: identity, kind: "feedback", at: AT, head_sha: null, route: null, model: null, provenance: "forge-reaction", signal: "not_helpful", count: 5, trusted: false },
  ]);
  assert.equal(noisy.resolved, 1);
  assert.equal(noisy.reactions.not_helpful, 5);
  assert.equal(noisy.adjudicated.confirmed_valid_defect, 1);
  assert.equal(noisy.adjudicated.confirmed_false_positive, 0);
  assert.equal(noisy.adjudicated.precision, 1);
  // Instants are compared as instants, not as raw text: an offset-bearing
  // timestamp later in the day must still win over an earlier UTC one.
  const offsetCorrected = aggregateOutcomeEvents([
    // 2026-10-01T23:00:00-05:00 IS 2026-10-02T04:00Z, so this correction is the
    // LATER event even though its text sorts BEFORE the 01:00Z one.
    adjudicated(identity, "confirmed_valid_defect", "2026-10-01T23:00:00-05:00"),
    adjudicated(identity, "confirmed_false_positive", "2026-10-02T01:00:00Z"),
  ]);
  assert.equal(offsetCorrected.adjudicated.confirmed_valid_defect, 1);
  assert.equal(offsetCorrected.adjudicated.precision, 1);
});

test("#1027: the identity marker never reaches the review-thread corpus or the extracted finding fields", async () => {
  const { normalizeThread, renderReviewThreads, enforcementView } = await import("../src/context/review-threads.js");
  const digest = findingIdentityFromRecord(findingRecord())!;
  const thread = normalizeThread({
    thread_id: "PRRT_1",
    path: "src/app.ts",
    line: 3,
    original_line: 3,
    resolved: false,
    comments: [
      {
        id: 1,
        user: "bot",
        created_at: "2026-10-01T00:00:00Z",
        body: `**Major (bug):** unchecked null deref\n\n${INLINE_DISCLAIMER}\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`,
      },
      { id: 2, user: "maintainer", created_at: "2026-10-02T00:00:00Z", body: "Fixed in the latest push." },
    ],
  })!;
  assert.ok(thread !== null);
  const [markdown] = renderReviewThreads([thread]);
  assert.ok(!markdown.includes("pr-reviewer:finding-id"), "the marker is action state, never corpus content");
  assert.ok(markdown.includes("unchecked null deref"), "the finding content still renders");
  const view = enforcementView([thread]);
  assert.equal(view[0]!.message, "unchecked null deref");
  assert.equal(view[0]!.severity, "major");
  assert.equal(view[0]!.category, "bug");
});

test("#1027: aggregate reads latest state by TIMESTAMP, not array position", () => {
  const identity = "a".repeat(64);
  const events: OutcomeEvent[] = [
    // The newer run re-reported the finding; the older run had resolved it.
    { finding_id: identity, kind: "repeated", at: "2026-10-10T00:00:00.000Z", head_sha: null, route: null, model: null, provenance: "current-review" },
    { finding_id: identity, kind: "resolved", at: "2026-10-01T00:00:00.000Z", head_sha: null, route: null, model: null, provenance: "forge-thread" },
  ];
  assert.equal(aggregateOutcomeEvents(events).open, 1);
  assert.equal(aggregateOutcomeEvents(events).resolved, 0);
});

test("#1027: lenient timestamps and empty head shas fail closed", () => {
  const base = { finding_id: "a".repeat(64), kind: "reported" as const, at: null, head_sha: null, route: null, model: null, provenance: "current-review" as const };
  assert.equal(normalizeOutcomeEvent({ ...base, at: "0" })!.at, null);
  assert.equal(normalizeOutcomeEvent({ ...base, at: "2026-13-45T00:00:00Z" })!.at, null);
  assert.equal(normalizeOutcomeEvent({ ...base, head_sha: "" })!.head_sha, null);
  assert.equal(normalizeOutcomeEvent({ ...base, head_sha: "ZZZ" })!.head_sha, null);
});
