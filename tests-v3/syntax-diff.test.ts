import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/context/syntax/diff.js";

const SAMPLE_DIFF = `diff --git a/pkg/foo.py b/pkg/foo.py
index 1111111..2222222 100644
--- a/pkg/foo.py
+++ b/pkg/foo.py
@@ -10,6 +10,8 @@ def unrelated():
 def get_value():
     if cache is not None:
         return cache
+    with LOCK:
+        return fetch()
     return fetch()

 def other():
`;

test("parseUnifiedDiff recovers the new-file path and added-line numbers", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);
  assert.equal(files.length, 1);
  const file = files[0]!;
  assert.equal(file.path, "pkg/foo.py");
  assert.equal(file.hunks.length, 1);
  const hunk = file.hunks[0]!;
  // Hunk new-range starts at line 10; two lines were added after the
  // "if cache is not None: return cache" context lines (lines 10-12), so
  // the added lines land at 13 and 14.
  assert.deepEqual(hunk.addedLines, [13, 14]);
  assert.equal(hunk.startLine, 10);
  assert.ok(hunk.endLine >= 14);
});

test("parseUnifiedDiff skips deleted files (no new-side lines)", () => {
  const deletion = `diff --git a/old.py b/old.py
deleted file mode 100644
index 1111111..0000000
--- a/old.py
+++ /dev/null
@@ -1,3 +0,0 @@
-line one
-line two
-line three
`;
  const files = parseUnifiedDiff(deletion);
  assert.equal(files.length, 0);
});

test("parseUnifiedDiff handles multiple hunks and multiple files", () => {
  const multi = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 line1
+added1
 line2
@@ -10,2 +11,3 @@
 line10
+added2
 line11
diff --git a/b.go b/b.go
index 1111111..2222222 100644
--- a/b.go
+++ b/b.go
@@ -1,1 +1,2 @@
 line1
+added3
`;
  const files = parseUnifiedDiff(multi);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.path, "a.ts");
  assert.equal(files[0]!.hunks.length, 2);
  assert.equal(files[1]!.path, "b.go");
  assert.deepEqual(files[1]!.hunks[0]!.addedLines, [2]);
});
