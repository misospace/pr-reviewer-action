import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRequirementTrace } from "../src/enforcement/requirement-trace.js";
import { USER_MESSAGE_BASE } from "../src/prompt/user-message.js";
import { VERDICT_USER_INSTRUCTION } from "../src/model/conversation.js";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "trace-wire-"));
}

function writeFile(workspace: string, relPath: string, lines: readonly string[]): void {
  mkdirSync(join(workspace, ...relPath.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(workspace, relPath), `${lines.join("\n")}\n`);
}

function ledgerWith(entries: Array<{ id: string; text: string; kind: string; provenance?: Array<{ source: string }> }>): unknown {
  return { requirements: entries };
}

function wireClaim(requirement_id: string, status: string, evidence: unknown[] = []): unknown {
  return { requirement_id, status, evidence };
}

test("wire satisfied with a valid file ref is evidenced advisory and absent from unresolved summaries", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/a.ts", ["one", "two", "three"]);
    const trace = validateRequirementTrace(
      [wireClaim("req-a", "satisfied", [{ kind: "file", ref: "src/a.ts:3" }])],
      ledgerWith([{ id: "req-a", text: "The renderer must display the result.", kind: "acceptance" }]), workspace,
    );
    assert.deepEqual(trace.rows[0]?.enforcement, [{ file: "src/a.ts", line: 3 }]);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.resolution, "evidenced");
    assert.equal(trace.rows[0]?.materiality, "advisory");
    assert.deepEqual(trace.summary.unresolved_material, []);
    assert.deepEqual(trace.summary.unresolved_advisory, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("wire satisfied with a missing file ref downgrades to a material unresolved row", () => {
  const workspace = makeWorkspace();
  try {
    const trace = validateRequirementTrace(
      [wireClaim("req-ghost", "satisfied", [{ kind: "file", ref: "src/ghost.ts:1" }])],
      ledgerWith([{ id: "req-ghost", text: "The renderer must display the result.", kind: "acceptance" }]), workspace,
    );
    const row = trace.rows[0]!;
    assert.equal(row.disposition, "unverifiable");
    assert.ok(row.notes.includes("downgraded-no-valid-enforcement-location"));
    assert.equal(row.materiality, "material");
    assert.deepEqual(trace.summary.unresolved_material, ["req-ghost"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tool evidence is disclosure only and cannot satisfy an enforcement citation", () => {
  const workspace = makeWorkspace();
  try {
    const trace = validateRequirementTrace(
      [wireClaim("req-tool", "satisfied", [{ kind: "tool", ref: "call-7" }])],
      ledgerWith([{ id: "req-tool", text: "The renderer must display the result.", kind: "acceptance" }]), workspace,
    );
    assert.deepEqual(trace.rows[0]?.enforcement, []);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.ok(trace.rows[0]?.notes.includes("downgraded-no-valid-enforcement-location"));
    assert.deepEqual(trace.summary.unresolved_material, ["req-tool"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("unknown wire claims preserve evidence detail as reason and missing detail gets missing-reason", () => {
  const workspace = makeWorkspace();
  try {
    const ledger = ledgerWith([
      { id: "req-unknown-detail", text: "The renderer must display the result.", kind: "acceptance" },
      { id: "req-unknown-empty", text: "The worker must advance the state.", kind: "acceptance" },
    ]);
    const trace = validateRequirementTrace([
      wireClaim("req-unknown-detail", "unknown", [{ kind: "tool", ref: "call-8", detail: "No result was available." }]),
      wireClaim("req-unknown-empty", "unknown"),
    ], ledger, workspace);
    assert.equal(trace.rows[0]?.disposition, "unverifiable");
    assert.equal(trace.rows[0]?.reason, "No result was available.");
    assert.equal(trace.rows[0]?.materiality, "material");
    assert.equal(trace.rows[1]?.disposition, "unverifiable");
    assert.ok(trace.rows[1]?.notes.includes("missing-reason"));
    assert.equal(trace.rows[1]?.materiality, "material");
    assert.deepEqual(trace.summary.unresolved_material, ["req-unknown-detail", "req-unknown-empty"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("violated wire claims carry a bounded, control-character-clean reason into unmet summary", () => {
  const workspace = makeWorkspace();
  try {
    const detail = `not\nvalid\u0000 ${"x".repeat(400)}`;
    const trace = validateRequirementTrace(
      [wireClaim("req-violated", "violated", [{ kind: "ci", ref: "run-2", detail }])],
      ledgerWith([{ id: "req-violated", text: "The worker must advance the state.", kind: "acceptance" }]), workspace,
    );
    const row = trace.rows[0]!;
    assert.equal(row.disposition, "unmet");
    assert.equal(row.resolution, "unmet_claimed");
    assert.equal(row.materiality, "material");
    assert.deepEqual(trace.summary.unmet_claimed, ["req-violated"]);
    assert.equal(row.reason.length, 300);
    assert.ok(!/[\x00-\x1f\x7f]/.test(row.reason));
    assert.ok(row.reason.startsWith("not valid"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("two requirements may both cite the same valid file line", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/shared.ts", ["one", "shared observation"]);
    const trace = validateRequirementTrace([
      wireClaim("req-one", "satisfied", [{ kind: "file", ref: "src/shared.ts:2" }]),
      wireClaim("req-two", "satisfied", [{ kind: "file", ref: "src/shared.ts:2" }]),
    ], ledgerWith([
      { id: "req-one", text: "The service must report the state.", kind: "acceptance" },
      { id: "req-two", text: "The service must expose the state.", kind: "acceptance" },
    ]), workspace);
    assert.equal(trace.rows.length, 2);
    for (const row of trace.rows) {
      assert.equal(row.disposition, "met");
      assert.equal(row.resolution, "evidenced");
      assert.equal(row.materiality, "advisory");
    }
    assert.deepEqual(trace.summary.unresolved_material, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("wire refs parse line ranges, reject whitespace prose, and reject URL-shaped locations", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/a.ts", ["one", "two", "three", "four", "five"]);
    const trace = validateRequirementTrace([
      wireClaim("req-range", "satisfied", [{ kind: "diff", ref: "src/a.ts:5-9" }]),
      wireClaim("req-prose", "satisfied", [{ kind: "file", ref: "not a path" }]),
      wireClaim("req-url", "satisfied", [{ kind: "file", ref: "https://x/y:80" }]),
    ], ledgerWith([
      { id: "req-range", text: "The service must report the state.", kind: "acceptance" },
      { id: "req-prose", text: "The service must expose the state.", kind: "acceptance" },
      { id: "req-url", text: "The service must preserve the state.", kind: "acceptance" },
    ]), workspace);
    assert.deepEqual(trace.rows[0]?.enforcement, [{ file: "src/a.ts", line: 5 }]);
    assert.equal(trace.rows[0]?.disposition, "met");
    for (const row of trace.rows.slice(1)) {
      assert.equal(row.disposition, "unverifiable");
      assert.ok(row.notes.includes("downgraded-no-valid-enforcement-location"));
    }
    assert.deepEqual(trace.rows[1]?.enforcement, []);
    // #1681 r6: URL-shaped refs name no repository location and are rejected
    // at the parse door of the one citation grammar — they are not even
    // retained as a bare-path candidate anymore.
    assert.deepEqual(trace.rows[2]?.enforcement, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("additive disposition and citations retain precedence; an unrecognized wire status is invalid", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/a.ts", ["one"]);
    const trace = validateRequirementTrace([
      { requirement_id: "req-additive", disposition: "met", status: "violated", enforcement: [{ file: "src/a.ts", line: 1 }] },
      wireClaim("req-garbage", "maybe", [{ kind: "file", ref: "src/a.ts:1" }]),
    ], ledgerWith([
      { id: "req-additive", text: "The service must report the state.", kind: "acceptance" },
      { id: "req-garbage", text: "The service must expose the state.", kind: "acceptance" },
    ]), workspace);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.equal(trace.rows[0]?.resolution, "evidenced");
    assert.deepEqual(trace.rows[0]?.enforcement, [{ file: "src/a.ts", line: 1 }]);
    assert.equal(trace.rows[1]?.disposition, "unverifiable");
    assert.ok(trace.rows[1]?.notes.includes("disposition-invalid"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("test evidence serves both citation lists, while a file-only claim cannot fulfill an explicit test demand", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/gate.ts", ["export const gate = true;"]);
    writeFile(workspace, "tests/gate.test.ts", ["assert.equal(gate, true);"]);
    const trace = validateRequirementTrace([
      wireClaim("req-test", "satisfied", [{ kind: "test", ref: "tests/gate.test.ts:1" }]),
      wireClaim("req-file-only", "satisfied", [{ kind: "file", ref: "src/gate.ts:1" }]),
    ], ledgerWith([
      { id: "req-test", text: "The gate must validate the token and must be covered by a regression test.", kind: "acceptance" },
      { id: "req-file-only", text: "The gate must validate the token and must be covered by a regression test.", kind: "acceptance" },
    ]), workspace);
    assert.deepEqual(trace.rows[0]?.enforcement, [{ file: "tests/gate.test.ts", line: 1 }]);
    assert.deepEqual(trace.rows[0]?.test, [{ file: "tests/gate.test.ts", line: 1 }]);
    assert.equal(trace.rows[0]?.disposition, "met");
    assert.deepEqual(trace.rows[1]?.enforcement, [{ file: "src/gate.ts", line: 1 }]);
    assert.deepEqual(trace.rows[1]?.test, []);
    assert.equal(trace.rows[1]?.disposition, "unverifiable");
    assert.ok(trace.rows[1]?.notes.includes("downgraded-no-valid-test-location"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("wire non-code claims preserve reported unmet but cannot self-certify documentation", () => {
  const workspace = makeWorkspace();
  try {
    const trace = validateRequirementTrace([
      wireClaim("req-external", "violated", [{ kind: "tool", ref: "check-1", detail: "External workflow is not green." }]),
      wireClaim("req-doc", "satisfied", [{ kind: "file", ref: "README.md:1" }]),
    ], ledgerWith([
      { id: "req-external", text: "Whether the unrelated pull request #42 will merge successfully after this change.", kind: "acceptance" },
      { id: "req-doc", text: "The PR description must document the new `--no-cache` flag", kind: "acceptance" },
    ]), workspace);
    assert.equal(trace.rows[0]?.proof, "external_state");
    assert.equal(trace.rows[0]?.disposition, "unmet");
    assert.equal(trace.rows[0]?.resolution, "unmet_claimed");
    assert.ok(trace.rows[0]?.notes.includes("non-code-reported-unmet"));
    assert.equal(trace.rows[0]?.reason, "External workflow is not green.");
    assert.equal(trace.rows[1]?.proof, "documentation");
    assert.equal(trace.rows[1]?.disposition, "pending");
    assert.equal(trace.rows[1]?.resolution, "pending");
    assert.equal(trace.rows[1]?.materiality, "advisory");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("three satisfied acceptance rows leave no material gaps; absent coverage remains 3/3 not traced", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/acceptance.ts", ["one", "two", "three"]);
    const ledger = ledgerWith([
      { id: "req-accept-a", text: "The service must accept the first input.", kind: "acceptance" },
      { id: "req-accept-b", text: "The service must accept the second input.", kind: "acceptance" },
      { id: "req-accept-c", text: "The service must accept the third input.", kind: "acceptance" },
    ]);
    const covered = validateRequirementTrace([
      wireClaim("req-accept-a", "satisfied", [{ kind: "file", ref: "src/acceptance.ts:1" }]),
      wireClaim("req-accept-b", "satisfied", [{ kind: "file", ref: "src/acceptance.ts:2" }]),
      wireClaim("req-accept-c", "satisfied", [{ kind: "file", ref: "src/acceptance.ts:3" }]),
    ], ledger, workspace);
    assert.deepEqual(covered.summary.unresolved_material, []);
    assert.equal(covered.incomplete, false);

    const uncovered = validateRequirementTrace(null, ledger, workspace);
    assert.deepEqual(uncovered.summary.unresolved_material, ["req-accept-a", "req-accept-b", "req-accept-c"]);
    assert.equal(uncovered.rows.length, 3);
    assert.ok(uncovered.rows.every((row) => row.notes.includes("not-traced-by-reviewer")));
    assert.equal(uncovered.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1660 review: an out-of-scope wire claim keeps the reported-unmet contract in both reason shapes", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/unrelated/widget.ts", ["export const widget = () => 1;"]);
    const ledger = ledgerWith([
      { id: "req-posting", text: "The changelog must be posted to the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
      { id: "req-banner", text: "The banner must be announced in the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
    ]);
    const scope = {
      paths: ["src/unrelated/widget.ts"],
      fileLines: [{ path: "src/unrelated/widget.ts", lines: ["+ export const widget = () => 1;"] }],
    };
    const trace = validateRequirementTrace([
      wireClaim("req-posting", "violated", [{ kind: "file", ref: "src/unrelated/widget.ts:1", detail: "no changelog posting exists yet" }]),
      wireClaim("req-banner", "violated", []),
    ], ledger, workspace, "+ export const widget = () => 1;", scope);
    const posted = trace.rows.find((row) => row.requirement_id === "req-posting");
    const banner = trace.rows.find((row) => row.requirement_id === "req-banner");
    // A wire gap claim WITH a detail is the reviewer's disclosed gap on a
    // scope-settled row: material unmet_claimed + the trusted disclosure note.
    assert.equal(posted?.disposition, "unmet");
    assert.equal(posted?.resolution, "unmet_claimed");
    assert.equal(posted?.materiality, "material");
    assert.ok(posted?.notes.includes("out-of-scope-reported-unmet"));
    assert.equal(posted?.reason, "no changelog posting exists yet");
    // A reason-less wire `violated` is NOT a gap claim: advisory not_applicable,
    // exactly like a reason-less additive `unmet`.
    assert.equal(banner?.disposition, "not_applicable");
    assert.equal(banner?.resolution, "not_applicable");
    assert.equal(banner?.materiality, "advisory");
    assert.ok(banner?.notes.includes("out-of-scope"));
    // Both stay OUT of the seam: the scope marker keeps the disposition clear.
    assert.deepEqual(trace.summary.unmet_claimed, ["req-posting"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1660 review #252: traversal and absolute-path wire refs are rejected at the fold, never read", () => {
  const parent = mkdempOrThrow();
  try {
    const workspace = join(parent, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(parent, "secret.txt"), "do not cite me\n");
    const trace = validateRequirementTrace([
      wireClaim("req-trav", "satisfied", [{ kind: "file", ref: "../secret.txt:1" }]),
      wireClaim("req-abs", "satisfied", [{ kind: "file", ref: `${join(parent, "secret.txt")}:1` }]),
    ], ledgerWith([
      { id: "req-trav", text: "The renderer must display the result.", kind: "acceptance" },
      { id: "req-abs", text: "The service must expose the status endpoint.", kind: "acceptance" },
    ]), workspace);
    // Both degrade to material rows — the citation never resolves, and the
    // out-of-workspace content is never credited (shared workspaceRegularFile
    // containment, #805, enforced at validation time).
    for (const id of ["req-trav", "req-abs"]) {
      const row = trace.rows.find((candidate) => candidate.requirement_id === id)!;
      assert.equal(row.disposition, "unverifiable", id);
      assert.ok(row.notes.includes("downgraded-no-valid-enforcement-location"), id);
      assert.equal(row.materiality, "material", id);
    }
    assert.deepEqual(trace.summary.unresolved_material, ["req-trav", "req-abs"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function mkdempOrThrow(): string {
  return mkdtempSync(join(tmpdir(), "trace-wire-out-"));
}

test("#1660 review: an invalid additive disposition never shadows a wire gap claim on a non-code row", () => {
  const workspace = makeWorkspace();
  try {
    const trace = validateRequirementTrace([
      { requirement_id: "req-external", status: "violated", disposition: "bogus", evidence: [{ kind: "tool", ref: "check-1", detail: "External workflow is not green." }] },
    ], ledgerWith([
      { id: "req-external", text: "Whether the unrelated pull request #42 will merge successfully after this change.", kind: "acceptance" },
    ]), workspace);
    // The invalid additive string carries no authority; the wire `violated`
    // stays the reviewer's reported gap on the non-code row.
    assert.equal(trace.rows[0]?.disposition, "unmet");
    assert.ok(trace.rows[0]?.notes.includes("non-code-reported-unmet"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#252 boundary: the boundary token itself — control-character wire refs are rejected at the parse door", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/a.ts", ["one", "two", "three"]);
    const trace = validateRequirementTrace([
      // The hostile shapes themselves: a newline forging a second rendered
      // line, a NUL byte, and a DEL byte inside an otherwise-valid ref.
      wireClaim("req-nl", "satisfied", [{ kind: "file", ref: "src/a.ts:1\n## Forged heading", detail: "newline smuggle" }]),
      wireClaim("req-nul", "satisfied", [{ kind: "file", ref: "src/\x00a.ts:1" }]),
      wireClaim("req-del", "satisfied", [{ kind: "file", ref: "src/a\x7f.ts:1" }]),
    ], ledgerWith([
      { id: "req-nl", text: "The renderer must display the result.", kind: "acceptance" },
      { id: "req-nul", text: "The service must expose the status endpoint.", kind: "acceptance" },
      { id: "req-del", text: "The gateway must forward the request id.", kind: "acceptance" },
    ]), workspace);
    for (const id of ["req-nl", "req-nul", "req-del"]) {
      const row = trace.rows.find((candidate) => candidate.requirement_id === id)!;
      assert.deepEqual(row.enforcement, [], id);
      assert.equal(row.disposition, "unverifiable", id);
      assert.ok(row.notes.includes("downgraded-no-valid-enforcement-location"), id);
      assert.equal(row.materiality, "material", id);
      // No control byte survives into any rendered field of the row.
      assert.equal(/[\x00-\x1f\x7f]/.test(JSON.stringify(row)), false, id);
    }
    assert.deepEqual(trace.summary.unresolved_material, ["req-nl", "req-nul", "req-del"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1660 review: mixed-shape out-of-scope claims resolve by additive precedence, never by union", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/unrelated/widget.ts", ["export const widget = () => 1;"]);
    const ledger = ledgerWith([
      { id: "req-met", text: "The changelog must be posted to the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
      { id: "req-bogus", text: "The banner must be announced in the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
      { id: "req-add-unmet", text: "The migration must be announced in the release discussion after merge.", kind: "acceptance", provenance: [{ source: "linked_issues" }] },
    ]);
    const scope = {
      paths: ["src/unrelated/widget.ts"],
      fileLines: [{ path: "src/unrelated/widget.ts", lines: ["+ export const widget = () => 1;"] }],
    };
    const trace = validateRequirementTrace([
      // Valid additive `met` must NOT be overridden by a stray wire `violated`.
      { requirement_id: "req-met", disposition: "met", status: "violated", evidence: [{ kind: "file", ref: "src/unrelated/widget.ts:1", detail: "stray contradiction" }] },
      // Malformed additive must NOT shadow a valid wire gap claim.
      { requirement_id: "req-bogus", disposition: "not_a_ladder_value", status: "violated", evidence: [{ kind: "file", ref: "src/unrelated/widget.ts:1", detail: "no banner announcement exists" }] },
      // Valid additive `unmet` with a reason stays the gap claim even beside a wire `satisfied`.
      { requirement_id: "req-add-unmet", disposition: "unmet", reason: "no migration announcement exists", status: "satisfied", evidence: [] },
    ], ledger, workspace, "+ export const widget = () => 1;", scope);
    const met = trace.rows.find((row) => row.requirement_id === "req-met");
    const bogus = trace.rows.find((row) => row.requirement_id === "req-bogus");
    const addUnmet = trace.rows.find((row) => row.requirement_id === "req-add-unmet");
    assert.equal(met?.disposition, "not_applicable", "the additive `met` wins: no unmet_claimed from the wire contradiction");
    assert.equal(met?.materiality, "advisory");
    assert.equal(bogus?.disposition, "unmet", "the malformed additive falls to the wire `violated`");
    assert.equal(bogus?.resolution, "unmet_claimed");
    assert.equal(bogus?.materiality, "material");
    assert.equal(bogus?.reason, "no banner announcement exists");
    assert.ok(bogus?.notes.includes("out-of-scope-reported-unmet"));
    assert.equal(addUnmet?.disposition, "unmet", "the valid additive `unmet` keeps the gap claim over a wire `satisfied`");
    assert.equal(addUnmet?.resolution, "unmet_claimed");
    assert.deepEqual(trace.summary.unmet_claimed, ["req-bogus", "req-add-unmet"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1660 review: the coverage instruction demands semantic adequacy, never citation existence", () => {
  for (const [name, text] of [
    ["USER_MESSAGE_BASE", USER_MESSAGE_BASE],
    ["VERDICT_USER_INSTRUCTION", VERDICT_USER_INSTRUCTION],
  ] as const) {
    // `satisfied` is a judgement that the required behavior HOLDS, and a
    // location or test citation is evidence identification, not proof.
    assert.ok(text.includes("supports that the required behavior actually holds"), name);
    assert.ok(text.includes("does not establish semantic correctness by itself"), name);
    // `violated` needs a supported counterexample or failure evidence.
    assert.ok(text.includes("supported counterexample or evidence that the requirement is not met"), name);
    // `unknown` explicitly covers located-but-adequacy-unestablished.
    assert.ok(text.includes("cannot establish its adequacy"), name);
    // #1724: an unknown row owes its explanation — the organic #1720 failure
    // was a bare wire `unknown` with a file ref and no detail, which the fold
    // could only report as `missing-reason`. The contract must teach the
    // explanation floor, and must never demand new tests for the positive
    // side (pre-existing current-head evidence is valid).
    assert.ok(text.includes("an unknown row must carry an evidence detail naming the exact behavior you could not verify"), name);
    assert.ok(text.includes("no test is required beyond what the requirement text itself demands"), name);
    // The shared-observation allowance survives (no per-requirement budget).
    assert.ok(text.includes("One genuine observation may support several requirements; cite it for each."), name);
    // The old locate-meets-satisfied wording must not return.
    assert.equal(text.includes("located the enforcing implementation"), false, name);
    // The vocabulary itself is unchanged: the fold consumes exactly these.
    for (const status of ["satisfied", "violated", "unknown"]) assert.ok(text.includes(status), `${name}:${status}`);
  }
});

// ---------------------------------------------------------------------------
// #1681 r6: ONE citation grammar across the corpus and every validator. The
// reviewer sees the corpus PR-Diff section's hunk anchors (`path:+START-END`,
// new-side numbering IS head numbering) and may cite the evidence exactly as
// acquired; the deterministic layer normalizes that grammar into a head
// location BEFORE provenance validation, so a legitimately acquired citation
// never downgrades for syntax alone. Nonexistent and out-of-range anchors
// still fail exactly like a fake plain ref.
// ---------------------------------------------------------------------------

test("#1681 r6: a satisfied row citing the corpus diff-anchor form stays met/evidenced", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/enforcement/threads.ts", Array.from({ length: 640 }, (_, i) => `line ${i + 1}`));
    const trace = validateRequirementTrace(
      [wireClaim("req-anchor", "satisfied", [
        { kind: "diff", ref: "src/enforcement/threads.ts:+206-232:1", detail: null },
      ])],
      ledgerWith([{ id: "req-anchor", text: "The settlement must ground fixed claims at head.", kind: "acceptance" }]),
      workspace,
    );
    const row = trace.rows[0]!;
    assert.deepEqual(row.enforcement, [{ file: "src/enforcement/threads.ts", line: 206 }], "the anchor normalizes to the first head-side line");
    assert.equal(row.disposition, "met", "no downgraded-no-valid-enforcement-location for a resolvable anchor");
    assert.equal(row.resolution, "evidenced");
    assert.equal(row.materiality, "advisory");
    assert.ok(!row.notes.includes("downgraded-no-valid-enforcement-location"));
    assert.deepEqual(trace.summary.unresolved_material, [], "a cited anchor never enters unresolved_material");
    assert.equal(trace.incomplete, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1681 r6: plain range refs keep an ordinal suffix parsed as the entry index, not a path", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/model/request.ts", Array.from({ length: 200 }, (_, i) => `line ${i + 1}`));
    const trace = validateRequirementTrace(
      [wireClaim("req-ordinal", "satisfied", [
        { kind: "file", ref: "src/model/request.ts:120-126:2", detail: null },
      ])],
      ledgerWith([{ id: "req-ordinal", text: "The schema pins exact N per run.", kind: "acceptance" }]),
      workspace,
    );
    const row = trace.rows[0]!;
    assert.deepEqual(row.enforcement, [{ file: "src/model/request.ts", line: 120 }]);
    assert.equal(row.disposition, "met");
    assert.deepEqual(trace.summary.unresolved_material, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1681 r6: anchor refs to nonexistent files and out-of-range lines still fail provenance", () => {
  const workspace = makeWorkspace();
  try {
    writeFile(workspace, "src/enforcement/threads.ts", ["one", "two", "three"]);
    const trace = validateRequirementTrace(
      [
        wireClaim("req-ghost-anchor", "satisfied", [{ kind: "diff", ref: "src/does-not-exist.ts:+206-232:1", detail: null }]),
        wireClaim("req-past-eof", "satisfied", [{ kind: "diff", ref: "src/enforcement/threads.ts:+206-232:1", detail: null }]),
        wireClaim("req-reversed", "satisfied", [{ kind: "diff", ref: "src/enforcement/threads.ts:+232-206:1", detail: null }]),
      ],
      ledgerWith([
        { id: "req-ghost-anchor", text: "The settlement must ground fixed claims at head.", kind: "acceptance" },
        { id: "req-past-eof", text: "The settlement must ground fixed claims at head.", kind: "acceptance" },
        { id: "req-reversed", text: "The settlement must ground fixed claims at head.", kind: "acceptance" },
      ]),
      workspace,
    );
    for (const id of ["req-ghost-anchor", "req-past-eof", "req-reversed"]) {
      const row = trace.rows.find((r) => r.requirement_id === id)!;
      assert.equal(row.disposition, "unverifiable", `${id}: a broken anchor never survives on syntax alone`);
      assert.ok(row.notes.includes("downgraded-no-valid-enforcement-location"), id);
      assert.equal(row.materiality, "material", id);
    }
    assert.deepEqual(trace.summary.unresolved_material, ["req-ghost-anchor", "req-past-eof", "req-reversed"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
