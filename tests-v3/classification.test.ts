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

test("path handling can match diff content only (#749: untrusted input flow)", () => {
  const result = classifyPr({ prFiles: files("src/app/store.py"), diffText: '+target = os.path.join(base, request.args["p"])\n' });
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

  const diffOnly = classifyPr({ prFiles: files("src/store.py"), diffText: "+x = pathlib.Path(userInput)\n" });
  assert.deepEqual(diffOnly.riskFlagsWithFiles["path_handling_changes"], []);

  // Linked flags never appear in the file attribution map.
  const linked = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "security" }] }]) });
  assert.equal(linked.riskFlagsWithFiles["linked_security_issue"], undefined);
});

test("route signals exclude content-only matches (#159)", () => {
  const result = classifyPr({ prFiles: files("src/store.py"), diffText: "+p = pathlib.Path(userInput)\n" });
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

  // Specifier neutralization is literal-scoped, not line-scoped: a real
  // traversal on the same source line as a require/import specifier still
  // fires, with the flag and the path must_check items.
  const mixed = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "src/app.ts" })],
    diffText: '+const x = require("../lib"); fs.readFile("../../etc/passwd");\n'
      + '+import { a } from "../lib"; fs.readFile("../../etc/shadow");\n'
      + '+import { runProcess } from "../runtime/subprocess.js";\n',
    linkedIssues: [],
  });
  assert.equal(mixed.prKind, "path_handling_changes");
  assert.ok(mixed.riskFlags.includes("path_handling_changes"));
  assert.ok(mixed.mustCheck.includes("review for path traversal vulnerabilities"));
  assert.ok(mixed.mustCheck.includes("test with edge-case paths (null bytes, symlinks)"));
  const prose = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "README.md" })],
    diffText: "+The helper sanitizes all user-provided paths before use.\n",
    linkedIssues: [],
  });
  assert.equal(prose.prKind, "app_code");
});

// ── Path-handling signal model (#749) ─────────────────────────────────────

test("#749: trusted repo-root scaffolding (the PR #748 false positive) does not classify path handling", () => {
  const prFiles = [
    canonicalChangedFile({ filename: "scripts/fork_review_gate.py" }),
    canonicalChangedFile({ filename: "tests/test_gate.py" }),
  ];
  const diff = [
    "+from pathlib import Path",
    "+",
    "+_ROOT = Path(__file__).resolve().parent.parent",
    "+sys.path.insert(0, str(_ROOT))",
  ].join("\n");
  const result = classifyPr({ prFiles, diffText: diff, linkedIssues: normalizeLinkedIssues([]) });
  assert.notEqual(result.prKind, "path_handling_changes");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
  assert.ok(!result.mustCheck.some((c) => c.includes("path traversal")));
  assert.ok(!result.mustCheck.some((c) => c.includes("edge-case paths")));
  assert.equal(result.pathHandlingProvenance.fired, false);
  assert.deepEqual(result.pathHandlingProvenance.signals, []);
});

test("#749: Node/TS trusted-anchor joins with ../ literals are trusted bookkeeping", () => {
  const diff = [
    '+const templates = path.resolve(__dirname, "../templates");',
    "+export const ROOT = Path(__file__).resolve().parent.parent;",
    '+const dataFile = os.path.join(os.path.dirname(__file__), "data.json");',
  ].join("\n");
  const result = classifyPr({ prFiles: files("src/app.ts"), diffText: diff, linkedIssues: [] });
  assert.notEqual(result.prKind, "path_handling_changes");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
});

test("#749: anchor joins with demonstrably static arguments are trusted bookkeeping", () => {
  // Quoted literals are static data even when a directory name contains a
  // word from the untrusted vocabulary ("uploads").
  const diff = [
    '+const uploadsDir = path.join(__dirname, "uploads");',
    '+const up = os.path.join(__dirname, "../uploads");',
    '+const tpl = path.resolve(__dirname, `templates`, "base.html");',
  ].join("\n");
  const result = classifyPr({ prFiles: files("src/app.ts"), diffText: diff, linkedIssues: [] });
  assert.notEqual(result.prKind, "path_handling_changes");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
});

test("#749: one-hop def/use into trusted-anchor constructions still fires", () => {
  const cases: [string, string][] = [
    ["path.resolve", "+name = request.args['path']\n+target = path.resolve(__dirname, name)\n"],
    ["os.path.join dirname", "+name = request.args['path']\n+target = os.path.join(os.path.dirname(__file__), name)\n"],
    ["pathlib joinpath", "+name = request.args['path']\n+out = Path(__file__).resolve().parent.joinpath(name)\n"],
  ];
  for (const [label, diff] of cases) {
    const result = classifyPr({ prFiles: files("src/app.py"), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", label);
    assert.ok(
      result.pathHandlingProvenance.signals.some((s) => s.signal === "untrusted_source_join"),
      `${label}: expected an untrusted_source_join signal`,
    );
  }
});

test("#749: adjacency is not flow — unrelated request line near a constant join stays clean", () => {
  const result = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+request_id = request.args['id']\n+target = os.path.join(base, 'static')\n",
    linkedIssues: [],
  });
  assert.equal(result.prKind, "app_code");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
  assert.equal(result.pathHandlingProvenance.fired, false);
  assert.deepEqual(result.pathHandlingProvenance.signals, []);

  // An untrusted token nearby without an assignment target yields no edge.
  const noAssignment = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+log.info('request received: %s', sid)\n+target = os.path.join(base, 'static')\n",
    linkedIssues: [],
  });
  assert.equal(noAssignment.prKind, "app_code");

  // A static string literal containing untrusted vocabulary is data.
  const quoted = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+target = os.path.join(base, "request")\n',
    linkedIssues: [],
  });
  assert.equal(quoted.prKind, "app_code");

  // An adjacent assignment from a NON-untrusted source is no edge either.
  const nonUntrusted = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+title = config['title']\n+templates = path.resolve(__dirname, title)\n",
    linkedIssues: [],
  });
  assert.equal(nonUntrusted.prKind, "app_code");
  assert.equal(nonUntrusted.pathHandlingProvenance.fired, false);
});

test("#749: lexical hygiene — assignment LHS and quoted words are not operands", () => {
  // Same-line detection inspects the construction EXPRESSION: the LHS being
  // bound (`request_cache_path`) is not an untrusted operand.
  const lhs = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+request_cache_path = os.path.join(BASE, "static")\n',
    linkedIssues: [],
  });
  assert.equal(lhs.prKind, "app_code");
  assert.equal(lhs.pathHandlingProvenance.fired, false);

  // `label = "request"` is a static quoted word: the adjacent one-hop check
  // reads the assignment and tests the quote-stripped RHS — no edge.
  const quotedAdjacent = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+label = "request"\n+target = path.resolve(__dirname, label)\n',
    linkedIssues: [],
  });
  assert.equal(quotedAdjacent.prKind, "app_code");
  assert.equal(quotedAdjacent.pathHandlingProvenance.fired, false);

  // `file.filename` is the reason an upload join fires — not upload
  // vocabulary in the target or directory name.
  const filenameOperand = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+dest = os.path.join(base, file.filename)\n",
    linkedIssues: [],
  });
  assert.equal(filenameOperand.prKind, "path_handling_changes");
  assert.ok(filenameOperand.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));

  // Without an untrusted operand, upload vocabulary alone never fires.
  const uploadVocab = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+upload_path = os.path.join(UPLOAD_DIR, 'static')\n",
    linkedIssues: [],
  });
  assert.equal(uploadVocab.prKind, "app_code");
  assert.equal(uploadVocab.pathHandlingProvenance.fired, false);

  // An upload-named OPERAND fires through the one-hop def/use edge.
  const uploadFlow = classifyPr({
    prFiles: files("src/app.ts"),
    diffText: "+const uploadName = req.query.name;\n+const dest = path.join(__dirname, uploadName);\n",
    linkedIssues: [],
  });
  assert.equal(uploadFlow.prKind, "path_handling_changes");
  assert.ok(uploadFlow.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));
});

test("#749: operands only — comments, sibling statements, and bare filename identifiers cannot donate tokens", () => {
  // Trailing comment after a static join: `request` in prose is not input.
  const comment = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+target = os.path.join(BASE, "static")  # request cache path\n',
    linkedIssues: [],
  });
  assert.equal(comment.prKind, "app_code");
  assert.equal(comment.pathHandlingProvenance.fired, false);

  // A sibling statement after the join is outside the construction's
  // operands: `audit(request.id)` must not make the static join fire.
  const sibling = classifyPr({
    prFiles: files("src/app.ts"),
    diffText: '+const target = path.join(BASE, "static"); audit(request.id);\n',
    linkedIssues: [],
  });
  assert.equal(sibling.prKind, "app_code");
  assert.equal(sibling.pathHandlingProvenance.fired, false);

  // A BARE `filename` identifier is not a source: a trusted constant named
  // filename propagated into a path is bookkeeping.
  const bareFilename = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+filename = "config.json"\n+dest = os.path.join(BASE, filename)\n',
    linkedIssues: [],
  });
  assert.equal(bareFilename.prKind, "app_code");
  assert.equal(bareFilename.pathHandlingProvenance.fired, false);

  // The `.filename` attribute-access shape still fires — and proves
  // `file.filename` is the reason, not upload vocabulary in the target.
  const attrFilename = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+dest = os.path.join(base, file.filename)\n",
    linkedIssues: [],
  });
  assert.equal(attrFilename.prKind, "path_handling_changes");
  assert.ok(attrFilename.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));

  // A formatted multi-line join keeps its operand surface: the open call
  // accumulates its continuation lines (bounded).
  const multiline = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+target = os.path.join(\n+    BASE,\n+    request.args['p'],\n+)\n",
    linkedIssues: [],
  });
  assert.equal(multiline.prKind, "path_handling_changes");
  assert.ok(multiline.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));
});

test("#749: anchor + untrusted operand refuses neutralization and fires", () => {
  const cases: [string, string][] = [
    ["request.args", '+target = os.path.join(__dirname, request.args["path"])\n'],
    ["req.query", '+const p = path.resolve(__dirname, req.query.path);\n'],
    ["user input", '+dest = os.path.join(__dirname, user_supplied_name)\n'],
    ["req.query operand", '+const dest = path.join(__dirname, req.query.name);\n'],
    ["argv", '+const target = path.resolve(__dirname, process.argv[2]);\n'],
    ["pathlib joinpath", '+out = Path(__file__).resolve().parent.joinpath(user_name)\n'],
    ["interpolated literal", '+dest = path.join(__dirname, f"{user_path}")\n'],
  ];
  for (const [label, diff] of cases) {
    const result = classifyPr({ prFiles: files("src/app.ts"), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", label);
    assert.ok(result.riskFlags.includes("path_handling_changes"), label);
    assert.ok(
      result.pathHandlingProvenance.signals.some((s) => s.signal === "untrusted_source_join"),
      `${label}: expected an untrusted_source_join signal`,
    );
  }
});

test("#749: pathlib import with a constant path and constant joins are not path handling", () => {
  const constant = classifyPr({
    prFiles: files("src/config.py"),
    diffText: "+CONFIG = Path('/etc/myapp/config.yaml')\n",
    linkedIssues: [],
  });
  assert.equal(constant.prKind, "app_code");

  const join = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+layout = os.path.join(base, 'templates')\n",
    linkedIssues: [],
  });
  assert.equal(join.prKind, "app_code");
});

test("#749: traversal literals in test files are discounted but stay visible in provenance", () => {
  const diff = [
    "diff --git a/tests/test_gate.py b/tests/test_gate.py",
    "+++ b/tests/test_gate.py",
    "+HOSTILE = ('../../etc/passwd',)",
  ].join("\n");
  const result = classifyPr({
    prFiles: [canonicalChangedFile({ filename: "tests/test_gate.py" })],
    diffText: diff,
    linkedIssues: [],
  });
  assert.equal(result.prKind, "app_code");
  assert.ok(!result.riskFlags.includes("path_handling_changes"));
  assert.ok(result.pathHandlingProvenance.discounted.some(
    (s) => s.signal === "traversal_literal" && s.source === "diff_test_file"
      && s.files.includes("tests/test_gate.py"),
  ));
});

test("#749: the test-file discount never masks a production untrusted surface", () => {
  const diff = [
    "diff --git a/src/upload.py b/src/upload.py",
    "+++ b/src/upload.py",
    "+dest = os.path.join(UPLOAD_DIR, request.args['name'])",
    "diff --git a/tests/test_upload.py b/tests/test_upload.py",
    "+++ b/tests/test_upload.py",
    "+FIXTURE = '../../etc/passwd'",
  ].join("\n");
  const result = classifyPr({
    prFiles: [
      canonicalChangedFile({ filename: "src/upload.py" }),
      canonicalChangedFile({ filename: "tests/test_upload.py" }),
    ],
    diffText: diff,
    linkedIssues: [],
  });
  assert.equal(result.prKind, "path_handling_changes");
  assert.ok(result.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join" && s.files.includes("src/upload.py"),
  ));
});

test("#749: genuine untrusted-path surfaces still fire with class-categorized provenance", () => {
  const cases: [string, string, string][] = [
    ["untrusted join", '+target = os.path.join(base, request.args["path"])\n', "untrusted_source_join"],
    ["upload composition (filename operand)", "+dest = os.path.join(base, file.filename)\n", "untrusted_source_join"],
    ["containment", "+resolved = os.path.realpath(target)\n+if not resolved.startswith(BASE):\n+    abort(400)\n", "path_containment_or_sanitization"],
    ["archive extraction", "+with tarfile.open(archive) as tf:\n+    tf.extractall(dest)\n", "archive_extraction"],
    ["symlink", "+os.symlink(target, link_path)\n", "symlink_sensitive"],
    ["path constructor", "+dest = pathlib.Path(user_input)\n", "untrusted_source_join"],
  ];
  for (const [label, diff, expectedSignal] of cases) {
    const result = classifyPr({ prFiles: files("src/app.py"), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", label);
    assert.ok(result.riskFlags.includes("path_handling_changes"), label);
    assert.ok(result.pathHandlingProvenance.fired, label);
    assert.ok(
      result.pathHandlingProvenance.signals.some((s) => s.signal === expectedSignal),
      `${label}: expected a ${expectedSignal} signal`,
    );
  }
});

test("#749: filename-backed signals route and attribute; test-file filename hits discount", () => {
  const fired = classifyPr({ prFiles: files("src/path_join.py"), diffText: "", linkedIssues: [] });
  assert.equal(fired.prKind, "path_handling_changes");
  assert.deepEqual(fired.riskFlagsWithFiles["path_handling_changes"], ["src/path_join.py"]);
  assert.ok(fired.routeSignals.includes("path_handling_changes"));
  assert.ok(fired.pathHandlingProvenance.signals.some((s) => s.source === "filename"));

  const discounted = classifyPr({ prFiles: files("tests/test_filepath.py"), diffText: "", linkedIssues: [] });
  assert.equal(discounted.prKind, "app_code");
  assert.equal(discounted.pathHandlingProvenance.fired, false);
  assert.ok(discounted.pathHandlingProvenance.discounted.length > 0);
});

test("#749: provenance samples are bounded and control-character-free", () => {
  const hostile = `+x = os.path.join(base, request.args['${"p".repeat(400)}\\x00\\x01\\x02'])\n`;
  const result = classifyPr({ prFiles: files("src/app.py"), diffText: hostile, linkedIssues: [] });
  for (const signal of result.pathHandlingProvenance.signals) {
    assert.ok(signal.samples.length <= 3);
    for (const sample of signal.samples) {
      assert.ok(sample.length <= 160);
      for (const ch of sample) {
        const code = ch.codePointAt(0) ?? 0;
        assert.ok(code >= 0x20 || ch === " ", `control char escaped into sample: ${code}`);
        assert.notEqual(code, 0x7f);
      }
    }
  }
});

test("#749: provenance signal buckets are capped", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `+a${i} = os.path.join(base, request.args['p'])`);
  const result = classifyPr({ prFiles: files("src/app.py"), diffText: `${lines.join("\n")}\n`, linkedIssues: [] });
  assert.ok(result.pathHandlingProvenance.signals.length <= 8);
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
    ["pr_kind", "risk_flags", "risk_flags_with_files", "route_signals", "changed_files_summary", "linked_issue_labels", "must_check", "linked_metadata_uncertain", "linked_metadata_uncertainty", "path_handling_provenance"],
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
