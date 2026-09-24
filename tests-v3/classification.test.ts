import test from "node:test";
import assert from "node:assert/strict";
import { classifyPr, PR_KINDS, RISK_FLAGS } from "../src/classification/classify.js";
import {
  classificationFromArtifact,
  selectSpecialistRoles,
  selectionToArtifact,
  SPECIALIST_ROLES_ORDER,
  SUMMARY_FILE_CAP,
} from "../src/classification/role-selection.js";
import { classificationToArtifact } from "../src/classification/classify.js";
import { canonicalChangedFile, normalizeLinkedIssues } from "../src/context/index.js";

function files(...names: string[]) {
  return names.map((name) => canonicalChangedFile({ filename: name }));
}

// ── pr_kind precedence (#675 port of pr_reviewer/classifier.py) ───────────

test("digest-only lockfile PRs classify as renovate_digest_only", () => {
  const result = classifyPr({ prFiles: files("package-lock.json", "yarn.lock"), diffText: "- #68f3a9\n+ #9b384d\n" });
  assert.equal(result.prKind, "renovate_digest_only");
  assert.deepEqual(result.riskFlags, []);
  assert.deepEqual(result.mustCheck, ["verify no functional changes beyond lockfile hashes"]);
});

test("a version bump defeats the digest-only rule", () => {
  const result = classifyPr({ prFiles: files("package-lock.json"), diffText: '"version": "4.18.0"' });
  assert.equal(result.prKind, "dependency_upgrade");
});

test("mixed PRs (code + lockfile) are never digest-only", () => {
  const result = classifyPr({ prFiles: files("package-lock.json", "src/app.py"), diffText: "" });
  // Not digest-only: the dependency lane still applies.
  assert.equal(result.prKind, "dependency_upgrade");
});

test("a YAML version line on a changed line defeats digest-only", () => {
  const result = classifyPr({ prFiles: files("yarn.lock"), diffText: "context version: 1.0.0\n+appVersion: 2.0.0\n" });
  assert.equal(result.prKind, "dependency_upgrade");
});

test("k8s manifests beat dependency files", () => {
  const result = classifyPr({ prFiles: files("k8s/deployment.yaml", "requirements.txt") });
  assert.equal(result.prKind, "k8s_manifest");
});

test("secret handling precedes auth", () => {
  const result = classifyPr({ prFiles: files("src/secret_handler.py") });
  assert.equal(result.prKind, "secret_handling_changes");
});

test("auth patterns cover non-Python ecosystems", () => {
  assert.equal(classifyPr({ prFiles: files("src/auth/login.ts") }).prKind, "auth_changes");
  assert.equal(classifyPr({ prFiles: files("src/AuthController.java") }).prKind, "auth_changes");
});

test("bare route.ts (Next.js handler name) is not a public route; routes.ts is", () => {
  assert.equal(classifyPr({ prFiles: files("src/app/api/x/route.ts") }).prKind, "app_code");
  assert.equal(classifyPr({ prFiles: files("src/routes.ts") }).prKind, "public_route_changes");
});

test("path handling can match diff content only", () => {
  const result = classifyPr({ prFiles: files("src/app/store.py"), diffText: "+target = os.path.join(base, p)\n" });
  assert.equal(result.prKind, "path_handling_changes");
});

test("the default kind is app_code", () => {
  assert.equal(classifyPr({ prFiles: files("src/anything.go") }).prKind, "app_code");
  assert.ok(PR_KINDS.includes("app_code"));
  assert.ok(RISK_FLAGS.includes("linked_security_issue"));
});

// ── Risk flags and attribution ────────────────────────────────────────────

test("linked issue labels flip flags in table order; Linear priority maps onto synthetic labels", () => {
  const issues = normalizeLinkedIssues([
    { source: "github", labels: [{ name: "Security" }, { name: "audit" }] },
    { source: "linear", priority: 2, labels: [] },
    { source: "linear", priority: 1, labels: [] },
  ]);
  const result = classifyPr({ prFiles: files("src/a.py"), linkedIssues: issues });
  assert.deepEqual(result.riskFlags, [
    "linked_security_issue",
    "linked_audit_issue",
    "linked_priority_p1",
    "linked_priority_p0",
  ]);
});

test("Linear priority only escalates on the integer values 1 and 2", () => {
  for (const [priority, expected] of [[0, []], [1, ["linked_priority_p0"]], [2, ["linked_priority_p1"]], [3, []], [4, []]] as const) {
    const result = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ source: "linear", priority }]) });
    assert.deepEqual(result.riskFlags, expected, `priority ${priority}`);
  }
  // A GitHub issue carrying a native priority field must NOT escalate.
  const github = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ priority: 1 }]) });
  assert.deepEqual(github.riskFlags, []);
});

test("file-based flags attribute triggering files; diff-only matches attribute an empty list", () => {
  const attributed = classifyPr({ prFiles: files("src/middleware/auth.ts", "readme.md") });
  assert.deepEqual(attributed.riskFlagsWithFiles["auth_changes"], ["src/middleware/auth.ts"]);

  const diffOnly = classifyPr({ prFiles: files("src/store.py"), diffText: "+x = pathlib.Path(p)\n" });
  assert.deepEqual(diffOnly.riskFlagsWithFiles["path_handling_changes"], []);

  // Linked flags never appear in the file attribution map.
  const linked = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "security" }] }]) });
  assert.equal(linked.riskFlagsWithFiles["linked_security_issue"], undefined);
});

test("route signals exclude content-only matches (#159)", () => {
  const result = classifyPr({ prFiles: files("src/store.py"), diffText: "+p = pathlib.Path(q)\n" });
  assert.deepEqual(result.routeSignals, []);
  assert.ok(result.riskFlags.includes("path_handling_changes"));

  const fileBacked = classifyPr({ prFiles: files("static/app.js") });
  assert.deepEqual(fileBacked.routeSignals, ["file_serving_changes"]);

  const linkedOnly = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "security" }] }]) });
  assert.deepEqual(linkedOnly.routeSignals, ["linked_security_issue"]);
});

test("must_check is the deduplicated union of kind and flag checklists", () => {
  const result = classifyPr({ prFiles: files("k8s/deployment.yaml"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "priority/p0" }] }]) });
  assert.deepEqual(result.mustCheck, [
    "validate manifest against target cluster version",
    "check for resource quota / limit changes",
    "treat as critical — verify all changes thoroughly",
  ]);
});

test("changed_files_summary is capped and linked labels keep case and order", () => {
  const many = Array.from({ length: 60 }, (_, i) => `f${i}.py`);
  const result = classifyPr({ prFiles: files(...many) });
  assert.equal(result.changedFilesSummary.length, 50);

  const labels = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "Bug" }, { name: "bug" }, { name: "Bug" }] }]) });
  assert.deepEqual(labels.linkedIssueLabels, ["Bug", "bug"]);
});

// ── Linked-metadata uncertainty (#633) ────────────────────────────────────

test("metadata fetch failures become bounded uncertainty reasons", () => {
  const result = classifyPr({
    prFiles: files("a.py"),
    metadataStatus: { github_fetch_failures: ["o/r#1"], linear_fetch_failures: ["TEAM-2"], linear_known_disabled: false },
  });
  assert.equal(result.linkedMetadataUncertain, true);
  assert.deepEqual(result.linkedMetadataUncertainty, [
    "github linked issue o/r#1 fetch failed",
    "linear TEAM-2 lookup failed",
  ]);
});

test("known-disabled Linear is not uncertainty and unusable status degrades quietly", () => {
  const disabled = classifyPr({ prFiles: files("a.py"), metadataStatus: { linear_known_disabled: true } });
  assert.equal(disabled.linkedMetadataUncertain, false);

  for (const garbage of [null, "x", 42, [], undefined]) {
    const result = classifyPr({ prFiles: files("a.py"), metadataStatus: garbage });
    assert.equal(result.linkedMetadataUncertain, false);
    assert.deepEqual(result.linkedMetadataUncertainty, []);
  }
});

test("uncertainty reasons reject control characters and cap length", () => {
  const result = classifyPr({
    prFiles: files("a.py"),
    metadataStatus: { github_fetch_failures: ["bad\u0007ref", "x".repeat(500)] },
  });
  assert.deepEqual(result.linkedMetadataUncertainty, [`github linked issue ${"x".repeat(200)} fetch failed`]);
});

test("cross-directory ESM imports and doc prose are not path handling (#679 false positive)", () => {
  const prFiles = [
    canonicalChangedFile({ filename: "src/runtime/subprocess.ts" }),
    canonicalChangedFile({ filename: "src/gates/gates.ts" }),
    canonicalChangedFile({ filename: "AGENTS.md" }),
  ];
  const importDiff = [
    "+import { runProcess } from \"../runtime/subprocess.js\";",
    "+} from \"../gates/gates.js\";",
    "+const child = spawn(options.file, options.args ?? [], { detached: true });",
    "+- **`src/runtime/`** — operators must sanitize any configured paths before they reach a child process.",
  ].join("\n");
  const result = classifyPr({ prFiles, diffText: importDiff, linkedIssues: normalizeLinkedIssues([]) });
  assert.equal(result.prKind, "app_code");
  assert.deepEqual(result.riskFlags, []);

  // A bare `from "..."` continuation line and dynamic/require specifiers are
  // module resolution too.
  const specifiers = [
    '+const mod = require("../lib/util.js");',
    '+await import("../lib/lazy.js");',
  ].join("\n");
  assert.equal(classifyPr({ prFiles, diffText: specifiers, linkedIssues: [] }).prKind, "app_code");
});

test("traversal literals outside module specifiers still classify path handling", () => {
  const result = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "src/app.py" })],
    diffText: "+with open('../../etc/passwd') as fh:\n+    print(fh.read())\n",
    linkedIssues: normalizeLinkedIssues([]),
  });
  assert.equal(result.prKind, "path_handling_changes");
  assert.ok(result.riskFlags.includes("path_handling_changes"));
  assert.ok(result.mustCheck.includes("test with edge-case paths (null bytes, symlinks)"));

  // Identifier-shaped code still fires; prose with spaces does not.
  const code = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "src/x.py" })],
    diffText: "+def sanitize_path(p):\n",
    linkedIssues: [],
  });
  assert.equal(code.prKind, "path_handling_changes");
  const prose = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "README.md" })],
    diffText: "+The helper sanitizes all user-provided paths before use.\n",
    linkedIssues: [],
  });
  assert.equal(prose.prKind, "app_code");
});

// ── Specialist role selection (#633 port) ─────────────────────────────────

test("lane tables select roles from kind and flags", () => {
  const security = selectFromArtifact({ pr_kind: "app_code", risk_flags: ["linked_security_issue"], changed_files_summary: ["a.py"] });
  // app_code is the correctness lane's substantive catch-all.
  assert.deepEqual(security.selectedRoles, ["correctness", "security"]);
  const multiple = selectFromArtifact({ pr_kind: "dependency_upgrade", risk_flags: ["linked_priority_p1"], changed_files_summary: [] });
  assert.deepEqual(multiple.selectedRoles, ["correctness", "tests"]);
});

test("digest-only with no flags selects zero roles via the documented gate", () => {
  const selection = selectFromArtifact({ pr_kind: "renovate_digest_only", risk_flags: [], changed_files_summary: ["package-lock.json"] });
  assert.deepEqual(selection.selectedRoles, []);
  assert.deepEqual(selection.skippedRoles, SPECIALIST_ROLES_ORDER);
  assert.match(selection.zeroSelectionReason, /digest-only lockfile change/);
});

test("docs/meta-only app_code PRs select zero roles; workflows keep correctness", () => {
  const docs = selectFromArtifact({ pr_kind: "app_code", risk_flags: [], changed_files_summary: ["docs/a.md", ".github/dependabot.yml", "LICENSE"] });
  assert.deepEqual(docs.selectedRoles, []);

  const workflows = selectFromArtifact({ pr_kind: "app_code", risk_flags: [], changed_files_summary: [".github/workflows/ci.yaml"] });
  assert.deepEqual(workflows.selectedRoles, ["correctness"]);
});

test("the docs/meta gate conservatively refuses to fire at the summary cap", () => {
  const files = Array.from({ length: SUMMARY_FILE_CAP }, (_, i) => `docs/f${i}.md`);
  const selection = selectFromArtifact({ pr_kind: "app_code", risk_flags: [], changed_files_summary: files });
  assert.deepEqual(selection.selectedRoles, ["correctness"]);
  // Unusable entries also keep the gate from firing.
  const unusable = selectFromArtifact({ pr_kind: "app_code", risk_flags: [], changed_files_summary: ["docs/a.md", 42, "  "] });
  assert.deepEqual(unusable.selectedRoles, ["correctness"]);
});

test("malformed, unknown-kind, no-lane, and uncertain classifications all fail conservative", () => {
  for (const garbage of [null, undefined, "x", 42, {}, { pr_kind: "" }, { pr_kind: "   " }]) {
    const selection = selectSpecialistRoles(classificationFromArtifact(garbage));
    assert.deepEqual(selection.selectedRoles, SPECIALIST_ROLES_ORDER);
    assert.equal(selection.classificationAvailable, false);
  }
  const unknown = selectFromArtifact({ pr_kind: "unknown", risk_flags: [], changed_files_summary: [] });
  assert.equal(unknown.classificationAvailable, false);
  assert.deepEqual(unknown.selectedRoles, SPECIALIST_ROLES_ORDER);

  const noLane = selectFromArtifact({ pr_kind: "widget_refactor", risk_flags: [], changed_files_summary: ["src/w.ts"] });
  assert.equal(noLane.classificationAvailable, true);
  assert.deepEqual(noLane.selectedRoles, SPECIALIST_ROLES_ORDER);
  // The fallback REPLACES the per-lane decisions.
  assert.equal(noLane.decisions.length, 3);
  assert.ok(noLane.decisions.every((d) => d.selected));

  const uncertain = selectFromArtifact({
    pr_kind: "app_code",
    risk_flags: [],
    changed_files_summary: ["docs/a.md"],
    linked_metadata_uncertain: true,
    linked_metadata_uncertainty: ["github linked issue o/r#1 fetch failed"],
  });
  assert.deepEqual(uncertain.selectedRoles, SPECIALIST_ROLES_ORDER);
  assert.equal(uncertain.metadataUncertain, true);
  // Uncertainty defeats the trivial gates: a docs-only PR with a failed
  // lookup is NOT proven trivial.
  assert.equal(uncertain.zeroSelectionReason, "");
});

// Deserialization boundary: artifact-shaped input → internal classification.
function selectFromArtifact(raw: unknown) {
  return selectSpecialistRoles(classificationFromArtifact(raw));
}

test("selection artifacts are byte-identical for identical input", () => {
  const input = { pr_kind: "auth_changes", risk_flags: ["auth_changes"], changed_files_summary: ["src/auth.ts"] };
  assert.deepEqual(selectFromArtifact(input), selectFromArtifact(input));
});

test("artifact serializers emit the v2 snake_case schema and round-trip", () => {
  const classification = classifyPr({ prFiles: files("k8s/deployment.yaml"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "priority/p0" }] }]) });
  const artifact = classificationToArtifact(classification);
  assert.deepEqual(
    Object.keys(artifact),
    ["pr_kind", "risk_flags", "risk_flags_with_files", "route_signals", "changed_files_summary", "linked_issue_labels", "must_check", "linked_metadata_uncertain", "linked_metadata_uncertainty"],
  );
  // The deserializer rebuilds an equivalent internal classification from the
  // serialized artifact (camelCase round trip over the snake_case boundary).
  const rebuilt = classificationFromArtifact(JSON.parse(JSON.stringify(artifact)));
  assert.ok(rebuilt !== null);
  assert.equal(rebuilt.prKind, classification.prKind);
  assert.deepEqual(rebuilt.riskFlags, classification.riskFlags);
  assert.deepEqual(rebuilt.mustCheck, classification.mustCheck);

  const selection = selectSpecialistRoles(classification);
  const selectionArtifact = selectionToArtifact(selection);
  assert.deepEqual(
    Object.keys(selectionArtifact),
    ["version", "mode", "classification_available", "pr_kind", "risk_flags", "metadata_uncertain", "metadata_uncertainty_reasons", "selected_roles", "skipped_roles", "decisions", "zero_selection_reason"],
  );
});
