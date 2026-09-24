import test from "node:test";
import assert from "node:assert/strict";
import { classifyPr, PR_KINDS, RISK_FLAGS } from "../src/classification/classify.js";
import { selectSpecialistRoles, SPECIALIST_ROLES_ORDER, SUMMARY_FILE_CAP } from "../src/classification/role-selection.js";
import { canonicalChangedFile, normalizeLinkedIssues } from "../src/context/index.js";

function files(...names: string[]) {
  return names.map((name) => canonicalChangedFile({ filename: name }));
}

// ── pr_kind precedence (#675 port of pr_reviewer/classifier.py) ───────────

test("digest-only lockfile PRs classify as renovate_digest_only", () => {
  const result = classifyPr({ prFiles: files("package-lock.json", "yarn.lock"), diffText: "- #68f3a9\n+ #9b384d\n" });
  assert.equal(result.pr_kind, "renovate_digest_only");
  assert.deepEqual(result.risk_flags, []);
  assert.deepEqual(result.must_check, ["verify no functional changes beyond lockfile hashes"]);
});

test("a version bump defeats the digest-only rule", () => {
  const result = classifyPr({ prFiles: files("package-lock.json"), diffText: '"version": "4.18.0"' });
  assert.equal(result.pr_kind, "dependency_upgrade");
});

test("mixed PRs (code + lockfile) are never digest-only", () => {
  const result = classifyPr({ prFiles: files("package-lock.json", "src/app.py"), diffText: "" });
  // Not digest-only: the dependency lane still applies.
  assert.equal(result.pr_kind, "dependency_upgrade");
});

test("a YAML version line on a changed line defeats digest-only", () => {
  const result = classifyPr({ prFiles: files("yarn.lock"), diffText: "context version: 1.0.0\n+appVersion: 2.0.0\n" });
  assert.equal(result.pr_kind, "dependency_upgrade");
});

test("k8s manifests beat dependency files", () => {
  const result = classifyPr({ prFiles: files("k8s/deployment.yaml", "requirements.txt") });
  assert.equal(result.pr_kind, "k8s_manifest");
});

test("secret handling precedes auth", () => {
  const result = classifyPr({ prFiles: files("src/secret_handler.py") });
  assert.equal(result.pr_kind, "secret_handling_changes");
});

test("auth patterns cover non-Python ecosystems", () => {
  assert.equal(classifyPr({ prFiles: files("src/auth/login.ts") }).pr_kind, "auth_changes");
  assert.equal(classifyPr({ prFiles: files("src/AuthController.java") }).pr_kind, "auth_changes");
});

test("bare route.ts (Next.js handler name) is not a public route; routes.ts is", () => {
  assert.equal(classifyPr({ prFiles: files("src/app/api/x/route.ts") }).pr_kind, "app_code");
  assert.equal(classifyPr({ prFiles: files("src/routes.ts") }).pr_kind, "public_route_changes");
});

test("path handling can match diff content only", () => {
  const result = classifyPr({ prFiles: files("src/app/store.py"), diffText: "+target = os.path.join(base, p)\n" });
  assert.equal(result.pr_kind, "path_handling_changes");
});

test("the default kind is app_code", () => {
  assert.equal(classifyPr({ prFiles: files("src/anything.go") }).pr_kind, "app_code");
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
  assert.deepEqual(result.risk_flags, [
    "linked_security_issue",
    "linked_audit_issue",
    "linked_priority_p1",
    "linked_priority_p0",
  ]);
});

test("Linear priority only escalates on the integer values 1 and 2", () => {
  for (const [priority, expected] of [[0, []], [1, ["linked_priority_p0"]], [2, ["linked_priority_p1"]], [3, []], [4, []]] as const) {
    const result = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ source: "linear", priority }]) });
    assert.deepEqual(result.risk_flags, expected, `priority ${priority}`);
  }
  // A GitHub issue carrying a native priority field must NOT escalate.
  const github = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ priority: 1 }]) });
  assert.deepEqual(github.risk_flags, []);
});

test("file-based flags attribute triggering files; diff-only matches attribute an empty list", () => {
  const attributed = classifyPr({ prFiles: files("src/middleware/auth.ts", "readme.md") });
  assert.deepEqual(attributed.risk_flags_with_files["auth_changes"], ["src/middleware/auth.ts"]);

  const diffOnly = classifyPr({ prFiles: files("src/store.py"), diffText: "+x = pathlib.Path(p)\n" });
  assert.deepEqual(diffOnly.risk_flags_with_files["path_handling_changes"], []);

  // Linked flags never appear in the file attribution map.
  const linked = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "security" }] }]) });
  assert.equal(linked.risk_flags_with_files["linked_security_issue"], undefined);
});

test("route signals exclude content-only matches (#159)", () => {
  const result = classifyPr({ prFiles: files("src/store.py"), diffText: "+p = pathlib.Path(q)\n" });
  assert.deepEqual(result.route_signals, []);
  assert.ok(result.risk_flags.includes("path_handling_changes"));

  const fileBacked = classifyPr({ prFiles: files("static/app.js") });
  assert.deepEqual(fileBacked.route_signals, ["file_serving_changes"]);

  const linkedOnly = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "security" }] }]) });
  assert.deepEqual(linkedOnly.route_signals, ["linked_security_issue"]);
});

test("must_check is the deduplicated union of kind and flag checklists", () => {
  const result = classifyPr({ prFiles: files("k8s/deployment.yaml"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "priority/p0" }] }]) });
  assert.deepEqual(result.must_check, [
    "validate manifest against target cluster version",
    "check for resource quota / limit changes",
    "treat as critical — verify all changes thoroughly",
  ]);
});

test("changed_files_summary is capped and linked labels keep case and order", () => {
  const many = Array.from({ length: 60 }, (_, i) => `f${i}.py`);
  const result = classifyPr({ prFiles: files(...many) });
  assert.equal(result.changed_files_summary.length, 50);

  const labels = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "Bug" }, { name: "bug" }, { name: "Bug" }] }]) });
  assert.deepEqual(labels.linked_issue_labels, ["Bug", "bug"]);
});

// ── Linked-metadata uncertainty (#633) ────────────────────────────────────

test("metadata fetch failures become bounded uncertainty reasons", () => {
  const result = classifyPr({
    prFiles: files("a.py"),
    metadataStatus: { github_fetch_failures: ["o/r#1"], linear_fetch_failures: ["TEAM-2"], linear_known_disabled: false },
  });
  assert.equal(result.linked_metadata_uncertain, true);
  assert.deepEqual(result.linked_metadata_uncertainty, [
    "github linked issue o/r#1 fetch failed",
    "linear TEAM-2 lookup failed",
  ]);
});

test("known-disabled Linear is not uncertainty and unusable status degrades quietly", () => {
  const disabled = classifyPr({ prFiles: files("a.py"), metadataStatus: { linear_known_disabled: true } });
  assert.equal(disabled.linked_metadata_uncertain, false);

  for (const garbage of [null, "x", 42, [], undefined]) {
    const result = classifyPr({ prFiles: files("a.py"), metadataStatus: garbage });
    assert.equal(result.linked_metadata_uncertain, false);
    assert.deepEqual(result.linked_metadata_uncertainty, []);
  }
});

test("uncertainty reasons reject control characters and cap length", () => {
  const result = classifyPr({
    prFiles: files("a.py"),
    metadataStatus: { github_fetch_failures: ["bad\u0007ref", "x".repeat(500)] },
  });
  assert.deepEqual(result.linked_metadata_uncertainty, [`github linked issue ${"x".repeat(200)} fetch failed`]);
});

// ── Specialist role selection (#633 port) ─────────────────────────────────

test("lane tables select roles from kind and flags", () => {
  const security = selectSpecialistRoles({ pr_kind: "app_code", risk_flags: ["linked_security_issue"], changed_files_summary: ["a.py"] });
  // app_code is the correctness lane's substantive catch-all.
  assert.deepEqual(security.selected_roles, ["correctness", "security"]);
  const multiple = selectSpecialistRoles({ pr_kind: "dependency_upgrade", risk_flags: ["linked_priority_p1"], changed_files_summary: [] });
  assert.deepEqual(multiple.selected_roles, ["correctness", "tests"]);
});

test("digest-only with no flags selects zero roles via the documented gate", () => {
  const selection = selectSpecialistRoles({ pr_kind: "renovate_digest_only", risk_flags: [], changed_files_summary: ["package-lock.json"] });
  assert.deepEqual(selection.selected_roles, []);
  assert.deepEqual(selection.skipped_roles, SPECIALIST_ROLES_ORDER);
  assert.match(selection.zero_selection_reason, /digest-only lockfile change/);
});

test("docs/meta-only app_code PRs select zero roles; workflows keep correctness", () => {
  const docs = selectSpecialistRoles({ pr_kind: "app_code", risk_flags: [], changed_files_summary: ["docs/a.md", ".github/dependabot.yml", "LICENSE"] });
  assert.deepEqual(docs.selected_roles, []);

  const workflows = selectSpecialistRoles({ pr_kind: "app_code", risk_flags: [], changed_files_summary: [".github/workflows/ci.yaml"] });
  assert.deepEqual(workflows.selected_roles, ["correctness"]);
});

test("the docs/meta gate conservatively refuses to fire at the summary cap", () => {
  const files = Array.from({ length: SUMMARY_FILE_CAP }, (_, i) => `docs/f${i}.md`);
  const selection = selectSpecialistRoles({ pr_kind: "app_code", risk_flags: [], changed_files_summary: files });
  assert.deepEqual(selection.selected_roles, ["correctness"]);
  // Unusable entries also keep the gate from firing.
  const unusable = selectSpecialistRoles({ pr_kind: "app_code", risk_flags: [], changed_files_summary: ["docs/a.md", 42, "  "] });
  assert.deepEqual(unusable.selected_roles, ["correctness"]);
});

test("malformed, unknown-kind, no-lane, and uncertain classifications all fail conservative", () => {
  for (const garbage of [null, undefined, "x", 42, {}, { pr_kind: "" }, { pr_kind: "   " }]) {
    const selection = selectSpecialistRoles(garbage);
    assert.deepEqual(selection.selected_roles, SPECIALIST_ROLES_ORDER);
    assert.equal(selection.classification_available, false);
  }
  const unknown = selectSpecialistRoles({ pr_kind: "unknown", risk_flags: [], changed_files_summary: [] });
  assert.equal(unknown.classification_available, false);
  assert.deepEqual(unknown.selected_roles, SPECIALIST_ROLES_ORDER);

  const noLane = selectSpecialistRoles({ pr_kind: "widget_refactor", risk_flags: [], changed_files_summary: ["src/w.ts"] });
  assert.equal(noLane.classification_available, true);
  assert.deepEqual(noLane.selected_roles, SPECIALIST_ROLES_ORDER);
  // The fallback REPLACES the per-lane decisions.
  assert.equal(noLane.decisions.length, 3);
  assert.ok(noLane.decisions.every((d) => d.selected));

  const uncertain = selectSpecialistRoles({
    pr_kind: "app_code",
    risk_flags: [],
    changed_files_summary: ["docs/a.md"],
    linked_metadata_uncertain: true,
    linked_metadata_uncertainty: ["github linked issue o/r#1 fetch failed"],
  });
  assert.deepEqual(uncertain.selected_roles, SPECIALIST_ROLES_ORDER);
  assert.equal(uncertain.metadata_uncertain, true);
  // Uncertainty defeats the trivial gates: a docs-only PR with a failed
  // lookup is NOT proven trivial.
  assert.equal(uncertain.zero_selection_reason, "");
});

test("selection artifacts are byte-identical for identical input", () => {
  const input = { pr_kind: "auth_changes", risk_flags: ["auth_changes"], changed_files_summary: ["src/auth.ts"] };
  assert.deepEqual(selectSpecialistRoles(input), selectSpecialistRoles(input));
});
