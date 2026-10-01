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
  return names.map((name) => canonicalChangedFile({ filename: name, status: "modified" }));
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

// ── image digest refreshes (#909) ─────────────────────────────────────────
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/** A modified image manifest with the platform's line totals, as production
 * supplies them (the completeness reconciliation reads both). */
function digestFile(name: string, additions: number, deletions: number) {
  return canonicalChangedFile({ filename: name, status: "modified", additions, deletions });
}

test("image-digest-only manifest PRs classify as image_digest_only", () => {
  // A HelmRelease `tag:` line: repository and tag unchanged, digest refreshed.
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1)],
    authoritativeChangedFiles: 1,
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "image_digest_only");
  assert.deepEqual(result.riskFlags, []);
  assert.deepEqual(result.mustCheck, ["verify only image digests changed; repository and tag unchanged"]);
});

test("image_digest_only covers compose image: and Dockerfile FROM forms", () => {
  const compose = classifyPr({
    prFiles: [digestFile("docker-compose.yml", 1, 1)],
    authoritativeChangedFiles: 1,
    diffText: `-    image: ghcr.io/o/app:v1@sha256:${DIGEST_A}\n+    image: ghcr.io/o/app:v1@sha256:${DIGEST_B}\n`,
  });
  assert.equal(compose.prKind, "image_digest_only");

  const dockerfile = classifyPr({
    prFiles: [digestFile("Dockerfile", 1, 1)],
    authoritativeChangedFiles: 1,
    diffText: `-FROM node:20@sha256:${DIGEST_A} AS build\n+FROM node:20@sha256:${DIGEST_B} AS build\n`,
  });
  assert.equal(dockerfile.prKind, "image_digest_only");
});

test("a repository or tag change is not image_digest_only", () => {
  const tagChange = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText: `-    tag: 1.2.3@sha256:${DIGEST_A}\n+    tag: 1.2.4@sha256:${DIGEST_B}\n`,
  });
  assert.equal(tagChange.prKind, "k8s_manifest");

  const repoChange = classifyPr({
    prFiles: files("docker-compose.yml"),
    diffText: `-    image: ghcr.io/o/old:v1@sha256:${DIGEST_A}\n+    image: ghcr.io/o/new:v1@sha256:${DIGEST_B}\n`,
  });
  assert.equal(repoChange.prKind, "app_code");
});

test("a mixed diff keeps the current classification (digest + other change)", () => {
  const result = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText:
      `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n` +
      "-  replicas: 3\n+  replicas: 5\n",
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a per-hunk mixed diff is not image_digest_only", () => {
  // First hunk is a clean digest refresh; the second (separate hunk) changes a
  // non-image line. The per-block boundary must not let the first hunk stand in
  // for the whole PR.
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 2, 2)],
    authoritativeChangedFiles: 1,
    diffText:
      "diff --git a/k8s/lemonade.yaml b/k8s/lemonade.yaml\n" +
      "@@ -9,1 +9,1 @@\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n` +
      "@@ -20,1 +20,1 @@\n" +
      "-  replicas: 3\n" +
      "+  replicas: 5\n",
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a digest change outside a YAML/Dockerfile manifest is not image_digest_only", () => {
  const result = classifyPr({
    prFiles: files("scripts/pin.txt"),
    diffText: `-image: ghcr.io/o/app:v1@sha256:${DIGEST_A}\n+image: ghcr.io/o/app:v1@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "app_code");
});

test("a multi-image digest refresh keeps each image's repository/tag in place", () => {
  const result = classifyPr({
    prFiles: [digestFile("k8s/leaves.yaml", 2, 2)],
    authoritativeChangedFiles: 1,
    diffText:
      `-    image: ghcr.io/o/api:v1@sha256:${DIGEST_A}\n` +
      `-    image: ghcr.io/o/worker:v1@sha256:${DIGEST_B}\n` +
      `+    image: ghcr.io/o/api:v1@sha256:${"c".repeat(64)}\n` +
      `+    image: ghcr.io/o/worker:v1@sha256:${"d".repeat(64)}\n`,
  });
  assert.equal(result.prKind, "image_digest_only");
});

test("swapping which digest belongs to which image is not image_digest_only", () => {
  // The ref multiset is unchanged, but the images swapped digests — that is a
  // functional change, not a digest refresh.
  const result = classifyPr({
    prFiles: files("k8s/leaves.yaml"),
    diffText:
      `-    image: ghcr.io/o/api:v1@sha256:${DIGEST_A}\n` +
      `-    image: ghcr.io/o/worker:v1@sha256:${DIGEST_B}\n` +
      `+    image: ghcr.io/o/worker:v1@sha256:${"c".repeat(64)}\n` +
      `+    image: ghcr.io/o/api:v1@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a realistic hunk with context lines still classifies as image_digest_only", () => {
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1)],
    authoritativeChangedFiles: 1,
    diffText:
      "diff --git a/k8s/lemonade.yaml b/k8s/lemonade.yaml\n" +
      "@@ -9,7 +9,7 @@ spec:\n" +
      "   image:\n" +
      "     repository: ghcr.io/o/lemonade\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n` +
      "     pullPolicy: IfNotPresent\n",
  });
  assert.equal(result.prKind, "image_digest_only");
});

test("changing the YAML key or indentation around a digest is not image_digest_only", () => {
  const keyChange = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+    image: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(keyChange.prKind, "k8s_manifest");

  const indentChange = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+      tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(indentChange.prKind, "k8s_manifest");
});

test("changing Dockerfile platform or stage around a digest is not image_digest_only", () => {
  const platform = classifyPr({
    prFiles: files("Dockerfile"),
    diffText: `-FROM --platform=linux/amd64 node:20@sha256:${DIGEST_A} AS build\n+FROM --platform=linux/arm64 node:20@sha256:${DIGEST_B} AS build\n`,
  });
  assert.equal(platform.prKind, "app_code");

  const stage = classifyPr({
    prFiles: files("Dockerfile"),
    diffText: `-FROM node:20@sha256:${DIGEST_A} AS build\n+FROM node:20@sha256:${DIGEST_B} AS runtime\n`,
  });
  assert.equal(stage.prKind, "app_code");
});

test("relocating an image reference between files is not image_digest_only", () => {
  const result = classifyPr({
    prFiles: files("k8s/a.yaml", "k8s/b.yaml"),
    diffText:
      "diff --git a/k8s/a.yaml b/k8s/a.yaml\n" +
      "@@ -1 +0,0 @@\n" +
      `-    image: ghcr.io/o/api:v1@sha256:${DIGEST_A}\n` +
      "diff --git a/k8s/b.yaml b/k8s/b.yaml\n" +
      "@@ -0,0 +1 @@\n" +
      `+    image: ghcr.io/o/api:v1@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("relocating an image reference between hunks is not image_digest_only", () => {
  const result = classifyPr({
    prFiles: files("k8s/a.yaml"),
    diffText:
      "diff --git a/k8s/a.yaml b/k8s/a.yaml\n" +
      "@@ -1 +0,0 @@\n" +
      `-    image: ghcr.io/o/api:v1@sha256:${DIGEST_A}\n` +
      "@@ -10,0 +10 @@\n" +
      `+    image: ghcr.io/o/api:v1@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a renamed manifest with an otherwise digest-only hunk is not image_digest_only", () => {
  const renamed = canonicalChangedFile({ filename: "k8s/b.yaml", status: "renamed" });
  const result = classifyPr({
    prFiles: [renamed],
    diffText:
      "diff --git a/k8s/a.yaml b/k8s/b.yaml\n" +
      "similarity index 90%\n" +
      "rename from k8s/a.yaml\n" +
      "rename to k8s/b.yaml\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a mode change around a digest is not image_digest_only", () => {
  const result = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText:
      "diff --git a/k8s/lemonade.yaml b/k8s/lemonade.yaml\n" +
      "old mode 100644\n" +
      "new mode 100755\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a truncation marker around a digest-only hunk is not image_digest_only", () => {
  const result = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText:
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n` +
      "…[diff truncated to fit context budget]\n",
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("image_digest_only reads the full diff, not the truncated context diff", () => {
  const truncated =
    `-    tag: latest@sha256:${DIGEST_A}\n` +
    `+    tag: latest@sha256:${DIGEST_B}\n` +
    "…[diff truncated to fit context budget]\n";
  // The complete diff has no hidden changes: still digest-only.
  const clean = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1)],
    authoritativeChangedFiles: 1,
    diffText: truncated,
    fullDiffText: `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(clean.prKind, "image_digest_only");

  // The complete diff hides a functional change behind the truncation marker:
  // the visible hunk alone would have been digest-only.
  const hidden = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    diffText: truncated,
    fullDiffText:
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n` +
      "-  replicas: 3\n" +
      "+  replicas: 5\n",
  });
  assert.equal(hidden.prKind, "k8s_manifest");
});

test("a file list shorter than the authoritative changed_files count is not image_digest_only", () => {
  // changed_files=2 but only one file was supplied (e.g. the single-page list
  // was capped): the evidence is incomplete.
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1)],
    authoritativeChangedFiles: 2,
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("line totals that disagree with the diff are not image_digest_only", () => {
  // Metadata claims 2 additions / 2 deletions; the diff has one digest pair.
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 2, 2)],
    authoritativeChangedFiles: 1,
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("missing line metadata is not image_digest_only", () => {
  // additions/deletions are absent (null), so completeness cannot be proven.
  const result = classifyPr({
    prFiles: files("k8s/lemonade.yaml"),
    authoritativeChangedFiles: 1,
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("complete evidence with matching counts and pure digests is image_digest_only", () => {
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1)],
    authoritativeChangedFiles: 1,
    diffText: `-    tag: latest@sha256:${DIGEST_A}\n+    tag: latest@sha256:${DIGEST_B}\n`,
  });
  assert.equal(result.prKind, "image_digest_only");
});

test("a binary sibling manifest defeats image_digest_only", () => {
  // File A is a clean digest refresh (+1/-1); file B is a modified binary that
  // contributes no +/- lines. Without the binary/zero-line guard the aggregate
  // line totals still match, so the kind would fire on a hidden change.
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1), digestFile("k8s/opaque.yaml", 0, 0)],
    authoritativeChangedFiles: 2,
    diffText:
      "diff --git a/k8s/lemonade.yaml b/k8s/lemonade.yaml\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n` +
      "diff --git a/k8s/opaque.yaml b/k8s/opaque.yaml\n" +
      "Binary files a/k8s/opaque.yaml and b/k8s/opaque.yaml differ\n",
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a GIT binary patch marker defeats image_digest_only", () => {
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1), digestFile("k8s/opaque.yaml", 0, 0)],
    authoritativeChangedFiles: 2,
    diffText:
      "diff --git a/k8s/lemonade.yaml b/k8s/lemonade.yaml\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n` +
      "diff --git a/k8s/opaque.yaml b/k8s/opaque.yaml\n" +
      "GIT binary patch\n",
  });
  assert.equal(result.prKind, "k8s_manifest");
});

test("a zero-line modified manifest defeats image_digest_only", () => {
  // No binary marker, but a participating file reports +0/-0: it cannot be a
  // digest refresh and must fail closed.
  const result = classifyPr({
    prFiles: [digestFile("k8s/lemonade.yaml", 1, 1), digestFile("k8s/opaque.yaml", 0, 0)],
    authoritativeChangedFiles: 2,
    diffText:
      "diff --git a/k8s/lemonade.yaml b/k8s/lemonade.yaml\n" +
      `-    tag: latest@sha256:${DIGEST_A}\n` +
      `+    tag: latest@sha256:${DIGEST_B}\n`,
  });
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
  // The new digest kind sits between the lockfile digest kind and the
  // dependency kind, ahead of k8s_manifest (#909). Pin the documented order so
  // an accidental reorder is caught here rather than only at a parity boundary.
  assert.deepEqual(PR_KINDS.slice(0, 3), ["renovate_digest_only", "image_digest_only", "dependency_upgrade"]);
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

// The run seam passes buildLinkedIssueContext's raw collection through
// normalizeLinkedIssues before classifyPr: GitHub refs carry no `source`
// field and only carry `labels` when their fetch succeeded, and a projected
// label may have no name. The boundary turns all of that into canonical
// entries, so the classifier stays behind its canonical typed input.

test("the run seam's raw linked-issue shapes normalize before classification", () => {
  const result = classifyPr({
    prFiles: files("src/a.py"),
    linkedIssues: normalizeLinkedIssues([
      { ref: "o/r#824", repo: "o/r", number: 824, labels: [{ name: "Security" }, { name: "audit" }] },
      { ref: "o/r#9", repo: "o/r", number: 9 },
      { ref: "o/r#10", repo: "o/r", number: 10, labels: [{}] },
    ]),
  });
  assert.deepEqual(result.riskFlags, ["linked_security_issue", "linked_audit_issue"]);
  assert.deepEqual(result.linkedIssueLabels, ["Security", "audit"]);
});

test("file-based flags attribute triggering files; diff-only matches attribute an empty list", () => {
  const attributed = classifyPr({ prFiles: files("src/middleware/auth.ts", "readme.md") });
  assert.deepEqual(attributed.riskFlagsWithFiles["auth_changes"], ["src/middleware/auth.ts"]);

  const diffOnly = classifyPr({ prFiles: files("src/store.py"), diffText: "+x = pathlib.Path(user_input)\n" });
  assert.deepEqual(diffOnly.riskFlagsWithFiles["path_handling_changes"], []);

  // Linked flags never appear in the file attribution map.
  const linked = classifyPr({ prFiles: files("a.py"), linkedIssues: normalizeLinkedIssues([{ labels: [{ name: "security" }] }]) });
  assert.equal(linked.riskFlagsWithFiles["linked_security_issue"], undefined);
});

test("route signals exclude content-only matches (#159)", () => {
  const result = classifyPr({ prFiles: files("src/store.py"), diffText: "+p = pathlib.Path(user_input)\n" });
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

  // Continuation lines are scanned only through the closing paren: a
  // trailing comment after the closer cannot donate a token.
  const multilineComment = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+target = os.path.join(\n+    BASE,\n+)  # request cache path\n",
    linkedIssues: [],
  });
  assert.equal(multilineComment.prKind, "app_code");
  assert.equal(multilineComment.pathHandlingProvenance.fired, false);

  // Nor can a sibling statement after the closer.
  const multilineSibling = classifyPr({
    prFiles: files("src/app.ts"),
    diffText: '+const target = path.join(\n+  BASE,\n+); audit(request.id);\n',
    linkedIssues: [],
  });
  assert.equal(multilineSibling.prKind, "app_code");
  assert.equal(multilineSibling.pathHandlingProvenance.fired, false);

  // A comment on the open-call head line is likewise excluded.
  const headComment = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+target = os.path.join(  # request cache\n+    BASE,\n+)\n",
    linkedIssues: [],
  });
  assert.equal(headComment.prKind, "app_code");
  assert.equal(headComment.pathHandlingProvenance.fired, false);

  // Nested parens are tracked: a nested call closing mid-list never ends
  // the scan while outer operands (a later untrusted argument) remain.
  const nested = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+target = os.path.join(\n+    os.path.dirname(__file__),\n+    request.args['name'],\n+)\n",
    linkedIssues: [],
  });
  assert.equal(nested.prKind, "path_handling_changes");
  assert.ok(nested.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));

  // The opening line's REMAINDER contributes its paren balance to the
  // initial depth: the nested `foo(` means the `safe)` closer must not
  // terminate the scan before the later untrusted operand.
  const remainder = classifyPr({
    prFiles: files("src/app.py"),
    diffText: "+target = os.path.join(foo(\n+    safe), request.args['x']\n+)\n",
    linkedIssues: [],
  });
  assert.equal(remainder.prKind, "path_handling_changes");
  assert.ok(remainder.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));

  // Forged/hostile anchors cannot launder operands: an anchor call whose
  // later arguments reach untrusted input is refused neutralization and
  // fires (adversarial-boundary convention, #252).
  const forged = classifyPr({
    prFiles: files("src/app.ts"),
    diffText: '+const p = path.resolve(import.meta.url, request.args["f"]);\n',
    linkedIssues: [],
  });
  assert.equal(forged.prKind, "path_handling_changes");
  assert.ok(forged.pathHandlingProvenance.signals.some(
    (s) => s.signal === "untrusted_source_join",
  ));
});

test("#749: adversarial-review regressions (lexer, nesting, division, vocab bounds)", () => {
  const positives: [string, string, string][] = [
    // The static-literal lexer pairs quotes correctly: the span between two
    // adjacent quotes must not swallow `, request.args[`.
    ["f-string adjacent quotes", "+ target = os.path.join(base, f'{x}', request.args['p'])\n", "src/app.py"],
    // Balanced-paren extraction has no nesting-depth limit.
    ["4-level nesting", "+ x = os.path.join(os.path.dirname(os.path.realpath(os.path.join(BASE, 'safe'))), request.args['p'])\n", "src/app.py"],
    // `/` is pathlib's path-join operator; the chain refuses neutralization
    // so the Path( head survives and the scan extends through the division.
    ["pathlib division", "+ x = Path(__file__).parent / request.args['p']\n", "src/app.py"],
    ["pathlib division non-anchor", "+ p = Path(BASE) / request.args['x']\n", "src/app.py"],
    ["pathlib division one-hop", "+name = request.args['p']\n+x = Path(__file__).parent / name\n", "src/app.py"],
    // Express bracket access: `req` is a request object in either form.
    ["req bracket access", "+ const target = path.join(base, req['path']);\n", "src/app.ts"],
    // Typed annotations are idiomatic, not exotic lvalues.
    ["typed annotation", "+ name: str = request.args['p']\n+ x = os.path.join(base, name)\n", "src/app.py"],
    ["typed const TS", "+ const n: string = request.query.x;\n+ const t = path.join(base, n);\n", "src/app.ts"],
    // The continuation cap is a boundedness horizon, not a precision filter.
    ["4+ operand multiline", "+ x = os.path.join(\n+     BASE,\n+     'a',\n+     'b',\n+     request.args['p'],\n+ )\n", "src/app.py"],
    ["deep nested multiline", "+ x = os.path.join(\n+     os.path.dirname(\n+         os.path.realpath(__file__),\n+     ),\n+     request.args['p'],\n+ )\n", "src/app.py"],
    // `user_`-prefixed identifiers stay sources.
    ["user_id operand", "+ x = os.path.join(base, user_id)\n", "src/app.py"],
  ];
  for (const [label, diff, filename] of positives) {
    const result = classifyPr({ prFiles: files(filename), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", label);
    assert.ok(result.riskFlags.includes("path_handling_changes"), label);
    assert.ok(
      result.pathHandlingProvenance.signals.some((s) => s.signal === "untrusted_source_join"),
      `${label}: expected untrusted_source_join`,
    );
  }

  // Word-bounded source vocabulary: benign identifier near-misses are not
  // untrusted sources, and a trusted pathlib division stays clean.
  for (const operand of ["requester_id", "username", "queryset", "payloads", "params_dict", "userdata"]) {
    const result = classifyPr({ prFiles: files("src/app.py"), diffText: `+ x = os.path.join(base, ${operand})\n`, linkedIssues: [] });
    assert.equal(result.prKind, "app_code", operand);
    assert.equal(result.pathHandlingProvenance.fired, false, operand);
  }
  const trustedDivision = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+ x = Path(__file__).parent / "static"\n',
    linkedIssues: [],
  });
  assert.equal(trustedDivision.prKind, "app_code");
  assert.equal(trustedDivision.pathHandlingProvenance.fired, false);
});

test("#749: keyword-prefix identifiers and division operand isolation", () => {
  // Declaration keywords must be separate tokens: `value`, `variable`,
  // `constant`, `localpath` are plain identifiers — the one-hop target is
  // the full name, not a keyword+suffix fragment.
  for (const name of ["value", "variable", "constant", "localpath", "values", "ours", "mything"]) {
    const result = classifyPr({
      prFiles: files("src/app.py"),
      diffText: `+${name} = request.args['p']\n+target = os.path.join(base, ${name})\n`,
      linkedIssues: [],
    });
    assert.equal(result.prKind, "path_handling_changes", name);
    assert.ok(
      result.pathHandlingProvenance.signals.some((s) => s.signal === "untrusted_source_join"),
      `${name}: expected untrusted_source_join`,
    );
  }
  // Real declaration keywords still work.
  const keyword = classifyPr({
    prFiles: files("src/app.ts"),
    diffText: "+const n = request.args['p'];\n+const t = path.join(base, n);\n",
    linkedIssues: [],
  });
  assert.equal(keyword.prKind, "path_handling_changes");

  // The `/` division operand ends at the statement boundary: a sibling
  // expression cannot donate untrusted tokens to a static division.
  const sibling = classifyPr({
    prFiles: files("src/app.py"),
    diffText: '+x = Path(BASE) / "static"; audit(request.id)\n',
    linkedIssues: [],
  });
  assert.equal(sibling.prKind, "app_code");
  assert.equal(sibling.pathHandlingProvenance.fired, false);

  // Operand shapes that must still fire: direct, chained division, and an
  // operand inside an enclosing call.
  for (const diff of [
    '+x = Path(BASE) / request.args["p"]\n',
    '+x = Path(BASE) / "static" / request.args["p"]\n',
    "+foo(Path(BASE) / request.args['p'])\n",
  ]) {
    const result = classifyPr({ prFiles: files("src/app.py"), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", diff);
  }
});

test("#749: division sibling expressions cannot donate; nested operand expressions fire", () => {
  // The division operand ends at the operand's own nesting level: a sibling
  // expression after a top-level `,`/`;` — tuple, list, dict, call argument,
  // or statement sequence — is not part of the path-division expression.
  for (const diff of [
    '+x = (Path(BASE) / "static", request.id)\n',
    '+x = [Path(BASE) / "static", request.id]\n',
    '+x = {"path": Path(BASE) / "static", "audit": request.id}\n',
    '+foo(Path(BASE) / "static", request.id)\n',
    '+render(Path(BASE) / "static", {"id": request.id})\n',
    '+d = {"a": 1, "b": Path(BASE) / "static", "c": request.id}\n',
    '+foo((Path(BASE) / "static", request.id))\n',
    '+x = Path(BASE) / "static"; y = request.args["p"]\n',
    '+x = Path(BASE) / a[0], request.args["p"]\n',
  ]) {
    const result = classifyPr({ prFiles: files("src/app.py"), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "app_code", diff);
    assert.equal(result.pathHandlingProvenance.fired, false, diff);
  }
  // Delimiters nested inside the operand itself — call, subscript, attribute
  // chain, container, string interpolation — do not terminate the scan.
  for (const diff of [
    '+x = Path(BASE) / transform(request.args["p"])\n',
    '+x = Path(BASE) / parts[request.args["i"]]\n',
    '+x = Path(BASE) / obj.attr[request.args["i"]]\n',
    '+d = {"a": 1, "b": Path(BASE) / request.args["p"]}\n',
    "+x = Path(BASE) / f\"{request.args['p']}\"\n",
    "+x = Path(BASE) / (request.args['p'])\n",
    '+x = Path(BASE) / {"k": request.args["p"]}\n',
    '+x = parts[Path(BASE) / request.args["i"]]\n',
  ]) {
    const result = classifyPr({ prFiles: files("src/app.py"), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", diff);
  }
});

test("#749: lexical material classes need executable context", () => {
  // Comments and string contents are prose, not executable code.
  const proseNegatives: [string, string][] = [
    ["+# sanitize_path handles configured paths\n", "src/app.py"],
    ["+x = 1  # sanitize_path later\n", "src/app.py"],
    ["+x = 1  # the filepath is logged\n", "src/app.py"],
    ["+// sanitize_path helper\n", "src/app.ts"],
    ["+const x = 1; // pathname docs\n", "src/app.ts"],
    ['+log.info("sanitize_path ran")\n', "src/app.py"],
    ['+log.info("filepath is shown")\n', "src/app.py"],
    ['+log.info(f"sanitize_path ran for {x}")\n', "src/app.py"],
    ['+_ROOT = Path(__file__).resolve()  # like abspath\n', "src/app.py"],
    // Documentation-only files carry no executable context.
    ["+Use sanitize_path before opening files.\n", "docs/guide.md"],
    ["+The `filepath` value is displayed to the user.\n", "docs/guide.md"],
    ["+The pathname field is informational.\n", "docs/ref.rst"],
    ["+Run sanitize_path first.\n", "NOTES.txt"],
    ["+Use sanitize_path before opening files.\n", "README.md"],
  ];
  for (const [diff, filename] of proseNegatives) {
    const result = classifyPr({ prFiles: files(filename), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "app_code", diff);
    assert.equal(result.pathHandlingProvenance.fired, false, diff);
  }
  // Paired controls: the EXACT vocabulary that is prose in comments and docs
  // is a real signal in executable source.
  const codePositives: [string, string][] = [
    ["+def sanitize_path(p):\n    return os.path.commonpath([p])\n", "src/app.py"],
    ['+filepath = request.args["path"]\n', "src/app.py"],
    ["+p = commonpath([base, user_input])\n", "src/app.py"],
    ['+p = os.path.realpath(request.args["p"])\n', "src/app.py"],
    ["+function sanitizePath(p) {}\n", "src/app.ts"],
    ["+x = sanitize_path(p)  # filepath helper\n", "src/app.py"],
    ["+if is_relative_to(base, p):\n    pass\n", "src/app.py"],
  ];
  for (const [diff, filename] of codePositives) {
    const result = classifyPr({ prFiles: files(filename), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", diff);
  }
  // Other classes keep their existing semantics: traversal literals and
  // archive operations are meaningful even in comments and docs.
  const preserved: [string, string][] = [
    ["+# blocks ../traversal\n", "src/app.py"],
    ["+see ../etc/passwd\n", "README.md"],
    ["+# uses extractall\n", "src/app.py"],
  ];
  for (const [diff, filename] of preserved) {
    const result = classifyPr({ prFiles: files(filename), diffText: diff, linkedIssues: [] });
    assert.equal(result.prKind, "path_handling_changes", diff);
  }
});

test("#871: a bare `pathname` is a WHATWG URL component, not a path variable, unless the file also touches a filesystem/path-construction API", () => {
  // Negative: URL .pathname in a network/URL-only file (#854's shape) never
  // fires path_handling_changes — the file never calls a filesystem/path API
  // at all, so `pathname` here is exactly as likely to be `url.pathname` as
  // a filesystem path.
  const urlOnly = [
    "+const pathname = base.pathname.replace(/\\/+$/, \"\") + \"/xrpc/\" + nsid;\n",
    "+const url = new URL(pathname, base);\n",
    "+const p2 = new URL(req.url).pathname;\n",
    "+const p3 = window.location.pathname;\n",
  ];
  for (const diff of urlOnly) {
    const result = classifyPr({ prFiles: files("src/platform/client.ts"), diffText: diff, linkedIssues: [] });
    assert.notEqual(result.prKind, "path_handling_changes", diff);
    assert.equal(result.pathHandlingProvenance.fired, false, diff);
  }

  // Positive: the SAME `.pathname` reaching a real filesystem/path-
  // construction call in the same file DOES fire — an untrusted URL
  // component reaching the filesystem is real path handling. Fires via
  // untrusted_source_join (pathname is now an untrusted-source pattern,
  // scoped to construction-call operands) even without other fs evidence
  // in the file.
  const reachesFs = classifyPr({
    prFiles: files("src/platform/serve.ts"),
    diffText: '+const dest = path.join(root, url.pathname);\n',
    linkedIssues: [],
  });
  assert.equal(reachesFs.prKind, "path_handling_changes");
  assert.ok(reachesFs.pathHandlingProvenance.signals.some((s) => s.signal === "untrusted_source_join"));

  // Positive: `pathname` co-occurring with genuine fs/path-construction API
  // usage elsewhere in the same file also fires the identifier class, even
  // when the pathname reference itself is a separate line/statement.
  const coOccurs = classifyPr({
    prFiles: files("src/platform/serve.ts"),
    diffText: [
      "+const pathname = url.pathname;\n",
      '+fs.readFile(path.join(ROOT, "static.txt"), cb);\n',
    ].join(""),
    linkedIssues: [],
  });
  assert.equal(coOccurs.prKind, "path_handling_changes");
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

test("#749: provenance buckets are capped (signals and files-per-signal)", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `+a${i} = os.path.join(base, request.args['p'])`);
  const result = classifyPr({ prFiles: files("src/app.py"), diffText: `${lines.join("\n")}\n`, linkedIssues: [] });
  assert.ok(result.pathHandlingProvenance.signals.length <= 8);

  // MAX_PATH_FILES: one signal bucket attributes at most 8 files even when
  // more changed files carry the vocabulary.
  const manyFiles = classifyPr({
    prFiles: Array.from({ length: 10 }, (_, i) => canonicalChangedFile({ filename: `src/filepath_${i}.py` })),
    diffText: "",
    linkedIssues: [],
  });
  const filenameSignals = manyFiles.pathHandlingProvenance.signals.filter((s) => s.source === "filename");
  assert.equal(filenameSignals.length, 1);
  assert.equal(filenameSignals[0]?.files.length, 8);
});

test("#749: headerless diffs degrade conservatively", () => {
  const diff = "+HOSTILE = '../../etc/passwd'\n";
  // Tests-only changed file set: the whole headerless diff is test content.
  const testsOnly = classifyPr({ prFiles: files("tests/test_x.py"), diffText: diff, linkedIssues: [] });
  assert.equal(testsOnly.prKind, "app_code");
  // Any non-test changed file fires conservatively — unknown attribution
  // keeps scrutiny, never drops it.
  const withProduction = classifyPr({ prFiles: files("src/x.py"), diffText: diff, linkedIssues: [] });
  assert.equal(withProduction.prKind, "path_handling_changes");
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

test("image-digest-only with no flags selects zero roles via the documented gate", () => {
  const selection = selectFromArtifact({ pr_kind: "image_digest_only", risk_flags: [], changed_files_summary: ["k8s/lemonade.yaml"] });
  assert.deepEqual(selection.selectedRoles, []);
  assert.deepEqual(selection.skippedRoles, SPECIALIST_ROLES_ORDER);
  assert.match(selection.zeroSelectionReason, /image-digest-only change/);
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
