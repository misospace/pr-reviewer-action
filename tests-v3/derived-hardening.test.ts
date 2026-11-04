/** #1449: the derived-obligation contract, hardened.
 *
 * The first #1449 pass made the derived rows part of the review-owned
 * obligation contract. These are the hardening findings on that pass, each
 * pinned here:
 *
 *  (F1) a derived row whose derivation declared NO usable location could
 *       never be discharged — a permanent approve block. It now discharges
 *       on a satisfied disposition whose rationale names a PATH-LIKE token.
 *  (F2) an anchor that does not look like a location is not usable: the
 *       derivation is model output over untrusted PR content, so a trivial
 *       anchor (`a:b`) must never discharge a row.
 *  (F3) the anchor rule ignored the answer's POLARITY: a "satisfied"
 *       rationale that says the obligation FAILS discharged the row. The
 *       guard applies to derived rows only.
 *  (F4) the published derived section's prose was false for an `unmet` row
 *       (a counterexample the reviewer DID find).
 *  (F5) the row id was derived in two places — now ONE id function.
 *  (F6) the resolver did not bound the number of rows.
 *  (F7) the disclosure under-reported the state: the reason was null in the
 *       common case (coverage complete, rows undischarged).
 *  (F8) the derived rows were invisible to the tool loop's enforced
 *       evidence window, so the calls that could discharge them were
 *       REFUSED inside the reserved window and they reserved no budget.
 *  (F9) the verdict-producing instructions never mentioned derived rows, so
 *       the collapsed-verdict path could never discharge one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";
import {
  applyReviewObligationEnforcement,
  foldObligationDispositions,
  type ReviewObligation,
} from "../src/enforcement/review-obligations.js";
import { anchorAdmissionTokens } from "../src/enforcement/review-obligations.js";
import {
  anchorCoveredBy,
  derivedObligationStateReason,
  namesPathLikeToken,
  rationaleAssertsFailure,
  resolveDerivedObligations,
  type DerivedObligationResolution,
  type DerivedObligationRow,
} from "../src/enforcement/derived-obligations.js";
import { derivedObligationId, MAX_DERIVED_OBLIGATIONS } from "../src/derived/types.js";
import { DERIVED_FRAMING, renderDerivedSection } from "../src/derived/render.js";
import { Conversation } from "../src/model/conversation.js";
import { adaptiveLoopBudgets, driveToolLoop } from "../src/tools/loop.js";
import { OPENAI_VERDICT_JSON_SCHEMA } from "../src/model/request.js";
import { OPENAI_VERDICT_JSON_SCHEMA as CONVERSATION_VERDICT_JSON_SCHEMA, VERDICT_USER_INSTRUCTION } from "../src/model/conversation.js";
import {
  computeRequiredEvidenceReservation,
  derivedAdmissionRows,
  derivedEvidenceRows,
  runToolHarness,
  type HarnessDeps,
} from "../src/tools/harness.js";

// ── fixtures ────────────────────────────────────────────────────────────

const OBLIGATION = "every producer places the generation identity before the dedupe hash";
const LOCATIONS = ["src/ingress/reconcile.ts:mintFoundJob", "src/jobs/generation.ts:generationId"];

/** The pre-pass artifact as the engine writes it for a complete run. */
const derivedArtifact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: "ok",
  error_kind: null,
  error: null,
  diff_source: "full",
  diff_clipped: false,
  input_complete: true,
  method: "model",
  obligations: [
    {
      obligation: OBLIGATION,
      change: "added the identity to the HTTP producer only",
      topology: "identity",
      paths: LOCATIONS,
      pathsTruncated: false,
      basis: "the dedupe hash reads the generation id",
    },
  ],
  truncated: false,
  errors: [],
  section_bytes: 512,
  ...overrides,
});

/** The engine's row shape for one derived row. */
const derivedObligation = (row: DerivedObligationRow): ReviewObligation => ({
  id: row.id,
  source: "derived",
  text: row.text,
  status: "unresolved",
  cause: null,
  anchors: row.anchors,
});

/** The engine's rows for a resolution (derived rows + the coverage marker). */
const engineRows = (resolution: DerivedObligationResolution): ReviewObligation[] => {
  const rows = resolution.rows.map(derivedObligation);
  if (resolution.coverage === "incomplete") {
    rows.push({ id: "derived-coverage", source: "derived", text: "coverage unavailable", status: "unresolved", cause: "derivation-incomplete" });
  }
  return rows;
};

const base = (overrides: Record<string, unknown> = {}): ReviewArtifact => (
  { verdict: "approve", review_markdown: "review", findings: [], ...overrides } as ReviewArtifact
);

// ── (F1) a row with no usable anchor ────────────────────────────────────

test("#1449: a derived row with no usable anchor discharges on a path-like rationale", () => {
  // The derivation named nothing checkable: the artifact's only path is a
  // trivial `a:b` (dropped by the location rule), so the row has NO anchor.
  const resolution = resolveDerivedObligations(derivedArtifact({
    obligations: [{ obligation: OBLIGATION, topology: "identity", paths: ["a:b"] }],
  }), true);
  assert.deepEqual(resolution.rows[0]!.anchors, [], "a trivial anchor is not a location");
  const rows = engineRows(resolution);
  // A satisfied rationale that NAMES a path-like token discharges it: the
  // reviewer cited a file it checked.
  const grounded = foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions" },
  ]);
  assert.equal(grounded[0]!.status, "satisfied");
  assert.equal(grounded[0]!.cause, null);
  // A rationale that names no path-like token does NOT: the derivation that
  // named nothing must not brick the review, but the reviewer must still say
  // WHICH file it checked.
  const ungrounded = foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: "the mint site places the identity before hashing" },
  ]);
  assert.equal(ungrounded[0]!.status, "unresolved");
  // No rationale at all is still unresolved.
  assert.equal(foldObligationDispositions(rows, [{ check: "derived-1", status: "satisfied" }])[0]!.status, "unresolved");
});

test("#1449: the path-like definition is one shared helper", () => {
  // Path-like: a "/" OR a last dot-segment shaped like a file extension.
  assert.equal(namesPathLikeToken("src/ingress/reconcile.ts:mintFoundJob"), true);
  assert.equal(namesPathLikeToken("package.json"), true);
  assert.equal(namesPathLikeToken("checked reconcile.ts"), true);
  // Not path-like: a bare word, a trivial anchor, prose.
  assert.equal(namesPathLikeToken("a:b"), false);
  assert.equal(namesPathLikeToken("a"), false);
  assert.equal(namesPathLikeToken("the mint site places the identity"), false);
  assert.equal(namesPathLikeToken(""), false);
});

// ── (F2) only location-like anchors are usable ──────────────────────────

test("#1449: an anchor that does not look like a location is dropped by the resolver", () => {
  const resolution = resolveDerivedObligations(derivedArtifact({
    obligations: [{
      obligation: OBLIGATION,
      topology: "identity",
      paths: ["a:b", "a", "src/ingress/reconcile.ts:mintFoundJob", "package.json", "src/jobs/generation.ts:generationId"],
    }],
  }), true);
  assert.deepEqual(
    resolution.rows[0]!.anchors,
    ["src/ingress/reconcile.ts:mintFoundJob", "package.json", "src/jobs/generation.ts:generationId"],
    "only location-like anchors survive",
  );
});

test("#1449: a rationale naming only a trivial anchor does not discharge the row", () => {
  const resolution = resolveDerivedObligations(derivedArtifact({
    obligations: [{ obligation: OBLIGATION, topology: "identity", paths: ["a:b"] }],
  }), true);
  const rows = engineRows(resolution);
  const folded = foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: "checked a:b and the invariant holds" },
  ]);
  assert.equal(folded[0]!.status, "unresolved");
});

// ── (F3) the polarity guard ─────────────────────────────────────────────

test("#1449: a satisfied rationale that asserts a failure does not discharge a derived row", () => {
  const rows = engineRows(resolveDerivedObligations(derivedArtifact(), true));
  const markers = [
    "fails", "failed", "failing", "violates", "violated", "breaches", "counterexample",
    "not satisfied", "does not satisfy", "doesn't satisfy", "do not satisfy",
    // #1449 (second round): the equivalent negative phrasings the bare-word
    // list missed — each one is an unambiguous assertion that the
    // obligation did NOT hold.
    "violation", "breached", "counterexamples",
    "does not hold", "do not hold", "doesn't hold",
    "cannot hold", "can not hold", "can't hold",
    "is not met", "are not met", "not met",
    "missing",
    "does not place", "do not place", "doesn't place",
    "does not include", "doesn't include",
    "never place", "never places",
    "never hash", "never hashes",
    "never pass", "never passes",
    "broken",
  ];
  for (const marker of markers) {
    const rationale = `src/ingress/reconcile.ts:mintFoundJob — the invariant ${marker} here`;
    const folded = foldObligationDispositions(rows, [{ check: "derived-1", status: "satisfied", rationale }]);
    assert.equal(folded[0]!.status, "unresolved", marker);
    assert.equal(rationaleAssertsFailure(rationale), true, marker);
  }
  // An ordinary rationale discharges it.
  const ordinary = foldObligationDispositions(rows, [
    { check: "derived-1", status: "satisfied", rationale: "src/ingress/reconcile.ts:mintFoundJob places the identity before hashing" },
  ]);
  assert.equal(ordinary[0]!.status, "satisfied");
  assert.equal(rationaleAssertsFailure("src/ingress/reconcile.ts:mintFoundJob places the identity before hashing"), false);
});

test("#1449: the failure-assertion guard is negation-aware — a negated marker is a positive answer", () => {
  const rows = engineRows(resolveDerivedObligations(derivedArtifact(), true));
  // A NEGATED marker reports that the obligation HOLDS: it must never
  // withhold the row (no false withholding).
  const positive = [
    "src/ingress/reconcile.ts:mintFoundJob — no counterexample found",
    "src/ingress/reconcile.ts:mintFoundJob — the obligation is not violated here",
    "src/ingress/reconcile.ts:mintFoundJob — no missing evidence",
  ];
  for (const rationale of positive) {
    assert.equal(rationaleAssertsFailure(rationale), false, rationale);
    const folded = foldObligationDispositions(rows, [{ check: "derived-1", status: "satisfied", rationale }]);
    assert.equal(folded[0]!.status, "satisfied", rationale);
  }
  // The same phrasings ASSERTED still refuse the row.
  const negative = [
    "src/ingress/reconcile.ts:mintFoundJob — the invariant does not hold here",
    "src/ingress/reconcile.ts:mintFoundJob — the invariant is not met here",
    "src/ingress/reconcile.ts:mintFoundJob — the invariant is broken here",
    "src/ingress/reconcile.ts:mintFoundJob — never places the identity before hashing",
    "src/ingress/reconcile.ts:mintFoundJob — the identity is missing before the hash",
  ];
  for (const rationale of negative) {
    assert.equal(rationaleAssertsFailure(rationale), true, rationale);
    const folded = foldObligationDispositions(rows, [{ check: "derived-1", status: "satisfied", rationale }]);
    assert.equal(folded[0]!.status, "unresolved", rationale);
  }
});

test("#1449: the coverage marker is undischargeable in EVERY status", () => {
  // The synthetic coverage marker is a state of the world, not a check the
  // reviewer performed: no disposition may discharge it, and none may
  // RE-LABEL it (an `unmet` answer would claim the check failed).
  const resolution = resolveDerivedObligations(derivedArtifact({ status: "error", obligations: [] }), true);
  const rows = engineRows(resolution);
  for (const status of ["satisfied", "unmet", "not_applicable", "unresolved", "whatever"]) {
    const folded = foldObligationDispositions(rows, [{
      check: "derived-coverage",
      status,
      rationale: "src/ingress/reconcile.ts:mintFoundJob places forgeIntegration into buildOptions",
    }]);
    assert.equal(folded.length, 1, status);
    assert.equal(folded[0]!.status, "unresolved", status);
    assert.equal(folded[0]!.cause, "derivation-incomplete", status);
  }
  // The marker is never a defect claim either: the gate fires, but no
  // finding is synthesized.
  const artifact = base({ verdict: "approve", review_markdown: "" });
  applyReviewObligationEnforcement(artifact, rows);
  assert.equal(artifact.verdict, "request_changes");
  assert.deepEqual(artifact.findings, []);
});

test("#1449: the polarity guard is derived-only — the #1381 rows keep their rules", () => {
  const required: ReviewObligation[] = [
    { id: "obligation-1", source: "must_check", text: "check one", status: "unresolved", cause: null },
    { id: "obligation-2", source: "trusted_base_guidance", text: "verify the matrix", status: "unresolved", cause: null },
  ];
  // A must_check row discharges on a bare `satisfied` (#750's own rule).
  assert.equal(
    foldObligationDispositions(required, [{ check: "check one", status: "satisfied", rationale: "the invariant fails" }])[0]!.status,
    "satisfied",
  );
  // A trusted_base_guidance row discharges on a non-empty rationale.
  assert.equal(
    foldObligationDispositions(required, [{ check: "verify the matrix", status: "satisfied", rationale: "the invariant fails" }])[1]!.status,
    "satisfied",
  );
});

// ── (F4) the published prose reads the two classes apart ────────────────

test("#1449: the published derived section says what an unmet row means", () => {
  const unmet: ReviewObligation[] = [
    { id: "derived-1", source: "derived", text: OBLIGATION, status: "unmet", cause: null, anchors: LOCATIONS },
  ];
  const artifact = base({ verdict: "approve", review_markdown: "" });
  assert.equal(applyReviewObligationEnforcement(artifact, unmet).applied, true);
  const markdown = artifact.review_markdown as string;
  assert.match(markdown, /## Unresolved Derived Architectural Obligations/);
  // The reviewer performed the check and the obligation did not hold — the
  // counterexample is a finding, so "no defect is claimed" would be false.
  assert.match(markdown, /The reviewer performed the check for one or more derived architectural obligations and the obligation did NOT hold/);
  assert.match(markdown, /the counterexample is reported as a finding under the normal findings rules/);
  assert.ok(!markdown.includes("No defect is claimed here"), "an unmet row is not a coverage marker");
  assert.ok(!markdown.includes("Derived-obligation coverage is incomplete"));
  // No finding is synthesized for it.
  assert.deepEqual(artifact.findings, []);
});

test("#1449: an unresolved derived row keeps the incomplete-coverage wording", () => {
  const unresolved: ReviewObligation[] = [
    { id: "derived-1", source: "derived", text: OBLIGATION, status: "unresolved", cause: "tool-capability", anchors: LOCATIONS },
  ];
  const artifact = base({ verdict: "approve", review_markdown: "" });
  applyReviewObligationEnforcement(artifact, unresolved);
  const markdown = artifact.review_markdown as string;
  assert.match(markdown, /Derived-obligation coverage is incomplete/);
  assert.match(markdown, /No defect is claimed here/);
  assert.match(markdown, /Trusted approval is withheld until the obligation is discharged/);
  assert.ok(!markdown.includes("did NOT hold"));
});

// ── (F5) ONE id derivation ──────────────────────────────────────────────

test("#1449: the row id comes from one shared id function", () => {
  assert.equal(derivedObligationId(0), "derived-1");
  assert.equal(derivedObligationId(3), "derived-4");
  // The resolver's ids ARE that function's output.
  const resolution = resolveDerivedObligations(derivedArtifact({
    obligations: [
      { obligation: OBLIGATION, topology: "identity", paths: LOCATIONS },
      { obligation: "   " },
      { obligation: "second obligation", topology: "ordering", paths: LOCATIONS },
    ],
  }), true);
  assert.deepEqual(resolution.rows.map((row) => row.id), [derivedObligationId(0), derivedObligationId(2)]);
  // The corpus rendering names the SAME ids (the reviewer echoes what it saw).
  const section = renderDerivedSection({
    version: 1,
    obligations: [
      { obligation: OBLIGATION, change: "", topology: "identity", paths: LOCATIONS, pathsTruncated: false, basis: "" },
      { obligation: "second obligation", change: "", topology: "ordering", paths: LOCATIONS, pathsTruncated: false, basis: "" },
    ],
    truncated: false,
    errors: [],
    method: "model",
  });
  assert.match(section, /Obligation derived-1 \[/);
  assert.match(section, /Obligation derived-2 \[/);
});

// ── (F6) the resolver bounds the row count ──────────────────────────────

test("#1449: the resolver caps the derived rows and never renumbers them", () => {
  const many = resolveDerivedObligations(derivedArtifact({
    obligations: Array.from({ length: 9 }, (_v, index) => ({
      obligation: `obligation ${index}`,
      topology: "identity",
      paths: LOCATIONS,
    })),
  }), true);
  assert.equal(many.rows.length, MAX_DERIVED_OBLIGATIONS);
  assert.deepEqual(many.rows.map((row) => row.id), ["derived-1", "derived-2", "derived-3", "derived-4"]);
  // A skipped entry keeps its own index: capping never renumbers a row.
  const skipped = resolveDerivedObligations(derivedArtifact({
    obligations: [
      { obligation: "   " },
      ...Array.from({ length: 9 }, (_v, index) => ({ obligation: `obligation ${index}`, topology: "identity", paths: LOCATIONS })),
    ],
  }), true);
  assert.equal(skipped.rows.length, MAX_DERIVED_OBLIGATIONS);
  assert.deepEqual(skipped.rows.map((row) => row.id), ["derived-2", "derived-3", "derived-4", "derived-5"]);
});

// ── (F7) the disclosure explains the state ──────────────────────────────

test("#1449: the disclosure reason explains the state", () => {
  const complete = resolveDerivedObligations(derivedArtifact(), true);
  const derived: ReviewObligation[] = [
    { id: "derived-1", source: "derived", text: OBLIGATION, status: "unresolved", cause: null, anchors: LOCATIONS },
  ];
  // The coverage is complete but a row stayed open.
  assert.equal(derivedObligationStateReason(complete, derived), "not-discharged");
  // Every row discharged: the state speaks for itself.
  assert.equal(
    derivedObligationStateReason(complete, [{ ...derived[0]!, status: "satisfied" }]),
    null,
  );
  // The coverage never completed: the resolver's closed coverage reason.
  const incomplete = resolveDerivedObligations(derivedArtifact({ status: "error" }), true);
  assert.equal(incomplete.coverage, "incomplete");
  assert.equal(derivedObligationStateReason(incomplete, derived), "derivation-error");
  assert.equal(
    derivedObligationStateReason(resolveDerivedObligations(derivedArtifact({ input_complete: false }), true), derived),
    "input-incomplete",
  );
  assert.equal(
    derivedObligationStateReason(resolveDerivedObligations(derivedArtifact({ truncated: true }), true), derived),
    "obligation-set-truncated",
  );
  // The feature is off: no disclosure at all.
  assert.equal(derivedObligationStateReason(resolveDerivedObligations(derivedArtifact(), false), derived), null);
});

// ── (F8) the derived rows join the enforced evidence window ─────────────

test("#1449: a call naming a derived row's location is admissible inside the reserved window", async () => {
  // The window admits only calls that target a pending row. Without the
  // derived row in the admission set, the very call that could discharge it
  // (the one that opens the flagged file) would be REFUSED inside the
  // reserved window.
  const conversation = new Conversation();
  conversation.addUser("corpus");
  const responses = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "git_status_short", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "git_diff_stat", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: null, tool_calls: [{ id: "c3", type: "function", function: { name: "read_file", arguments: '{"path":"docs/notes.md"}' } }] } }] },
    { choices: [{ message: { content: null, tool_calls: [{ id: "c4", type: "function", function: { name: "read_file", arguments: '{"path":"src/ingress/reconcile.ts"}' } }] } }] },
    { choices: [{ message: { content: "done" } }] },
  ];
  let index = 0;
  const executed: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const outcome = await driveToolLoop(
    conversation,
    async () => responses[index++],
    async (tool: string, args: Record<string, unknown>) => {
      executed.push({ tool, args });
      return { tool, status: "ok", result: {} };
    },
    {
      apiFormat: "openai",
      model: "m",
      budgets: adaptiveLoopBudgets(4, 4, 120),
      timeFn: () => Number.MAX_SAFE_INTEGER / 2,
      reserveForRequiredEvidence: 2,
      requiredEvidence: derivedAdmissionRows(resolveDerivedObligations(derivedArtifact(), true).rows),
    },
  );
  // The call that names the flagged location executed; the unrelated one
  // inside the window was refused without spending budget.
  assert.ok(
    executed.some((call) => call.tool === "read_file" && call.args.path === "src/ingress/reconcile.ts"),
    JSON.stringify(executed),
  );
  assert.ok(!executed.some((call) => call.args.path === "docs/notes.md"), "the unrelated call was refused");
  assert.ok(outcome.requiredEvidenceRefusals >= 1);
  // The row was credited by the call that targeted it.
  assert.deepEqual(outcome.requiredEvidenceCredits, ["derived-1"]);
});

test("#1449: a derived row's admission vocabulary comes from its anchors", () => {
  assert.deepEqual(
    anchorAdmissionTokens(["src/ingress/reconcile.ts:mintFoundJob"])?.sort(),
    ["ingress", "mintfoundjob", "reconcile"],
  );
  // A row with no usable anchor has no vocabulary to admit a call by.
  assert.equal(anchorAdmissionTokens([]), null);
  assert.equal(anchorAdmissionTokens(["a:b"]), null);
  // The stopword set applies, like it does for a prose row.
  assert.equal(anchorAdmissionTokens(["src/with/from/the.ts"]), null);
});

test("#1449: the derived admission vocabulary drops the generic path segments", () => {
  // A generic segment ("src", "main", "utils", ...) names no location in
  // particular: keeping it would make ANY call under that segment
  // admissible inside the reserved window.
  const tokens = anchorAdmissionTokens(["src/main/utils/reconcile.py:doThing"]);
  assert.ok(tokens !== null);
  for (const generic of ["src", "main", "utils"]) {
    assert.ok(!tokens.includes(generic), `${generic} leaked into ${JSON.stringify(tokens)}`);
  }
  // The distinctive segment and the symbol stay.
  assert.ok(tokens.includes("reconcile"), JSON.stringify(tokens));
  assert.ok(tokens.includes("dothing"), JSON.stringify(tokens));
  // The symbol part always stays, even when it is generic.
  const symbol = anchorAdmissionTokens(["src/ingress/reconcile.ts:index"]);
  assert.ok(symbol !== null && symbol.includes("index"), JSON.stringify(symbol));
  // An anchor made of generic segments only contributes NO admission row
  // (the row still forces the verdict while unresolved).
  assert.equal(anchorAdmissionTokens(["src/main/utils/core.py"]), null);
});

test("#1449: the anchor's path and symbol match on identifier boundaries", () => {
  // "getUser" is a DIFFERENT symbol than "get": a rationale that names it
  // never reached the flagged location.
  assert.equal(anchorCoveredBy("src/db.ts:getUser places the identity", "src/db.ts:get"), false);
  assert.equal(anchorCoveredBy("src/db.ts:get places the identity", "src/db.ts:get"), true);
  // The path part matches on boundaries too: "src/a.ts" is not "src/a.tsx".
  assert.equal(anchorCoveredBy("src/a.tsx:get places the identity", "src/a.ts:get"), false);
  assert.equal(anchorCoveredBy("src/a.ts:get places the identity", "src/a.ts:get"), true);
});

test("#1449: an extension-less repository file is a location", () => {
  // A `Makefile`, `LICENSE` or `README` is a real file a reviewer can
  // check, but it carries no extension — so a row whose only anchor was
  // one of them could never be discharged by a rationale citing it.
  const names = [
    "Makefile", "Dockerfile", "LICENSE", "README", "CHANGELOG", "CODEOWNERS",
    "Gemfile", "Rakefile", "Procfile", "justfile", "BUILD", "WORKSPACE",
  ];
  for (const name of names) {
    assert.equal(namesPathLikeToken(`I checked the ${name} at head`), true, name);
  }
  // The resolver keeps such an anchor usable.
  const resolution = resolveDerivedObligations(derivedArtifact({
    obligations: [{ obligation: OBLIGATION, topology: "identity", paths: ["Makefile"] }],
  }), true);
  assert.deepEqual(resolution.rows[0]!.anchors, ["Makefile"]);
  // ... and a rationale citing it discharges the row.
  const folded = foldObligationDispositions(engineRows(resolution), [
    { check: "derived-1", status: "satisfied", rationale: "the Makefile target builds the image" },
  ]);
  assert.equal(folded[0]!.status, "satisfied");
  // The other shapes keep their own rules: a bare word is still not a
  // location.
  assert.equal(namesPathLikeToken("the mint site places the identity"), false);
  assert.equal(namesPathLikeToken("a:b"), false);
  // The Bazel-style workspace files are locations only in their canonical
  // spelling: the lowercase words are ordinary English, so a rationale that
  // merely says "the build" must not pass as a cited location.
  assert.equal(namesPathLikeToken("the build passes"), false);
  assert.equal(namesPathLikeToken("the workspace is clean"), false);
});

test("#1449: the derived rows join the admission set, and the feature off changes nothing", () => {
  const rows = resolveDerivedObligations(derivedArtifact(), true).rows;
  const admission = derivedAdmissionRows(rows);
  assert.equal(admission.length, 1);
  assert.equal(admission[0]!.id, "derived-1");
  assert.ok(admission[0]!.tokens.includes("reconcile"));
  assert.equal(admission[0]!.obligation, undefined, "a derived row is a prose row");
  // A row with no usable anchor contributes NO admission row.
  const anchorless = resolveDerivedObligations(derivedArtifact({
    obligations: [{ obligation: OBLIGATION, topology: "identity", paths: ["a:b"] }],
  }), true).rows;
  assert.deepEqual(derivedAdmissionRows(anchorless), []);
  // The rows count toward the reserved-window size exactly like the other
  // prose rows — and a derived row makes the window STRICTLY larger than
  // the #1381 row alone (the pre-fix assertion compared 1 with 1 and was
  // vacuous).
  assert.ok(
    computeRequiredEvidenceReservation(2, 24) > computeRequiredEvidenceReservation(1, 24),
    "a derived row must enlarge the reserved window",
  );
  // With the feature off the artifact contributes no row at all.
  assert.deepEqual(derivedEvidenceRows(() => JSON.stringify(derivedArtifact()), false), []);
  assert.deepEqual(derivedAdmissionRows(derivedEvidenceRows(() => JSON.stringify(derivedArtifact()), false)), []);
});

/** The harness's own workspace, so the loop can be driven end to end. */
function harnessWorkspace(): { root: string; deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v3-derived-harness-"));
  const env: Record<string, string> = {
    REPO: "o/r",
    AI_BASE_URL: "http://model.test/v1",
    AI_MODEL: "m1",
    AI_API_KEY: "k",
    AI_STREAM: "false",
  };
  const base: HarnessDeps = {
    env,
    cwd: root,
    readText: (name) => {
      try {
        return fs.readFileSync(path.join(root, name), "utf8");
      } catch {
        return null;
      }
    },
    exists: (name) => fs.existsSync(path.join(root, name)),
    writeArtifact: (name, text) => fs.writeFileSync(path.join(root, name), text),
    deleteArtifact: (name) => fs.rmSync(path.join(root, name), { force: true }),
    transport: async () => ({ choices: [{ message: { content: "no tools needed here" } }] }),
    timeFn: () => 0,
    renderSpecialistLeads: () => "",
  };
  return {
    root,
    deps: (overrides: Partial<HarnessDeps> = {}) => ({ ...base, ...overrides, env: { ...env, ...(overrides.env ?? {}) } }),
  };
}

test("#1449: the harness tracks the derived rows in the enforced window", async () => {
  const run = async (derived: boolean): Promise<Record<string, unknown>> => {
    const { root, deps } = harnessWorkspace();
    fs.writeFileSync(path.join(root, "review-corpus.truncated.md"), "# PR Diff\n+ change\n");
    // The harness authors its own candidates artifact from the
    // classification's must_check items, so the #1381 row is present
    // whichever way the run is wired.
    fs.writeFileSync(path.join(root, "classification.json"), JSON.stringify({
      pr_kind: "app_code",
      must_check: ["Confirm the migration path for the changed schema tables."],
    }));
    fs.writeFileSync(path.join(root, "derived-obligations.json"), JSON.stringify(derivedArtifact()));
    await runToolHarness(deps({ env: derived ? { DERIVED_OBLIGATIONS: "true" } : {} }));
    const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.json"), "utf8")) as {
      tool_loop_telemetry?: { budget?: Record<string, unknown> };
    };
    fs.rmSync(root, { recursive: true, force: true });
    return (artifact.tool_loop_telemetry?.budget ?? {}) as Record<string, unknown>;
  };
  // The feature on: the derived row joins the tracked rows (the #1381 row
  // plus the derived one), and the reservation counts it.
  const enabled = await run(true);
  assert.equal(enabled.required_evidence_required, 2);
  assert.equal(enabled.required_evidence_requests_hint, 2);
  // The feature off: the admission set and the reservation are unchanged.
  const off = await run(false);
  assert.equal(off.required_evidence_required, 1);
  assert.equal(off.required_evidence_requests_hint, 1);
  // The reserved window with the derived row present is STRICTLY larger
  // than with only the #1381 row present.
  assert.ok(
    Number(enabled.required_evidence_requests_hint) > Number(off.required_evidence_requests_hint),
    `reserved window ${enabled.required_evidence_requests_hint} is not larger than ${off.required_evidence_requests_hint}`,
  );
});

test("#1449: the engine and the harness read the derived gate the same way", () => {
  // The gate was parsed two different ways — the engine lowercased the
  // value, the harness trimmed and lowercased it — so a padded or
  // mixed-case value could mean "on" for one reader and "off" for the
  // other. Every reader must normalize it identically.
  const gateLines = (file: string): string[] => fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8")
    .split("\n")
    .filter((line) => line.includes("DERIVED_OBLIGATIONS") && line.includes('=== "true"'));
  for (const file of ["engine/review.ts", "tools/harness.ts", "precheck/fingerprint.ts"]) {
    const lines = gateLines(file);
    assert.ok(lines.length > 0, `no derived gate read in ${file}`);
    for (const line of lines) {
      assert.match(line, /\.trim\(\)\.toLowerCase\(\) === "true"/, `${file}: ${line.trim()}`);
    }
  }
});

// ── (F9) the verdict instructions know about derived rows ───────────────

test("#1449: the verdict instruction asks for the derived dispositions", () => {
  assert.match(VERDICT_USER_INSTRUCTION, /derived architectural obligation row is present \(id 'derived-<n>'\)/);
  assert.match(VERDICT_USER_INSTRUCTION, /one disposition per such row by echoing the row id/);
  assert.match(VERDICT_USER_INSTRUCTION, /a satisfied derived row's rationale must name one of that row's listed locations/);
});

test("#1449: the verdict schema describes the derived dispositions without changing its shape", () => {
  const schema = (OPENAI_VERDICT_JSON_SCHEMA as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema;
  const dispositions = schema.properties as Record<string, Record<string, unknown>>;
  const node = dispositions.required_check_dispositions as {
    type: unknown;
    description?: string;
    items: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
  };
  assert.match(node.description ?? "", /derived architectural obligation rows by their row id \('derived-<n>'\)/);
  assert.match(node.description ?? "", /a satisfied derived row's rationale must name one of that row's listed locations/);
  // The SHAPE is untouched: same type, same item properties, same enum, same
  // required list.
  assert.deepEqual(node.type, ["array", "null"]);
  assert.deepEqual(Object.keys(node.items.properties), ["check", "status", "rationale"]);
  assert.deepEqual(
    (node.items.properties.status as { enum: string[] }).enum,
    ["satisfied", "not_applicable", "unresolved", "unmet"],
  );
  assert.deepEqual(node.items.required, ["check", "status", "rationale"]);
  assert.equal(node.items.additionalProperties, false);
  // The two schema copies stay in lockstep.
  const conversationSchema = (CONVERSATION_VERDICT_JSON_SCHEMA as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema;
  assert.deepEqual(
    (conversationSchema.properties as Record<string, unknown>).required_check_dispositions,
    node,
  );
});

test("#1449: the corpus section asks for the structured disposition too", () => {
  assert.match(DERIVED_FRAMING, /Emit one structured disposition per obligation in 'required_check_dispositions'/);
  assert.match(DERIVED_FRAMING, /echoing the row id \(derived-<n>\)/);
  assert.match(DERIVED_FRAMING, /a satisfied obligation's rationale must name one of that row's listed locations/);
});

// ── the anchor rule itself is unchanged where it was already right ──────

test("#1449: the anchor rule still needs the symbol AND the path", () => {
  assert.equal(anchorCoveredBy("read src/ingress/reconcile.ts:mintFoundJob at head", "src/ingress/reconcile.ts:mintFoundJob"), true);
  assert.equal(anchorCoveredBy("read src/ingress/reconcile.ts at head", "src/ingress/reconcile.ts:mintFoundJob"), false);
  assert.equal(anchorCoveredBy("anything", ""), false);
});
