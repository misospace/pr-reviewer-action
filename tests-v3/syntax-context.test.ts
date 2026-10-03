import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntaxContext } from "../src/context/syntax/syntax-context.js";

function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "syntax-context-test-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

test("buildSyntaxContext finds the enclosing declaration, a same-file definition, and a caller", async () => {
  const root = fixtureRepo({
    "pkg/core.py": `import threading

_LOCK = threading.RLock()
_CACHE = None


def fetch_remote():
    return "value"


def get_value():
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    with _LOCK:
        _CACHE = fetch_remote()
    return _CACHE
`,
    "pkg/consumer.py": `from pkg.core import get_value


def prewarm():
    return get_value()
`,
  });
  const diff = `diff --git a/pkg/core.py b/pkg/core.py
index 1111111..2222222 100644
--- a/pkg/core.py
+++ b/pkg/core.py
@@ -12,4 +12,6 @@ def get_value():
     global _CACHE
     if _CACHE is not None:
         return _CACHE
+    with _LOCK:
+        _CACHE = fetch_remote()
     return _CACHE
`;
  const result = await buildSyntaxContext(diff, root, {});
  const file = result.files.find((f) => f.path === "pkg/core.py");
  assert.ok(file, "core.py should be present in the result");
  assert.equal(file!.supported, true);

  assert.ok(file!.enclosingDeclarations.some((d) => d.name === "get_value"), "should find the enclosing get_value() declaration");

  assert.ok(
    file!.definitions.some((d) => d.identifier === "fetch_remote" && d.name === "fetch_remote"),
    "should find the same-file definition of fetch_remote referenced on the added line",
  );

  assert.ok(
    file!.callers.some((c) => c.identifier === "get_value" && c.path === "pkg/consumer.py"),
    "should find the cross-file caller of get_value in pkg/consumer.py",
  );
});

test("buildSyntaxContext degrades an unsupported language to supported: false without throwing", async () => {
  const root = fixtureRepo({
    "script.rb": "def foo\n  bar\nend\n",
  });
  const diff = `diff --git a/script.rb b/script.rb
index 1111111..2222222 100644
--- a/script.rb
+++ b/script.rb
@@ -1,2 +1,3 @@
 def foo
+  baz
   bar
`;
  const result = await buildSyntaxContext(diff, root, {});
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.supported, false);
  assert.equal(result.files[0]!.language, null);
});

test("buildSyntaxContext degrades a missing file (deleted/renamed away) without throwing", async () => {
  const root = fixtureRepo({});
  const diff = `diff --git a/gone.py b/gone.py
index 1111111..2222222 100644
--- a/gone.py
+++ b/gone.py
@@ -1,1 +1,2 @@
 x = 1
+y = 2
`;
  const result = await buildSyntaxContext(diff, root, {});
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.supported, false);
  assert.ok(result.files[0]!.parseError !== null);
});

test("buildSyntaxContext enforces the byte budget and reports truncation", async () => {
  const bigFunctionLines: string[] = ["def get_value():"];
  for (let i = 0; i < 2000; i++) bigFunctionLines.push(`    x_${i} = ${i}  # padding to blow the byte budget`);
  bigFunctionLines.push("    with _LOCK:");
  bigFunctionLines.push("        return fetch_remote()");
  const source = `${bigFunctionLines.join("\n")}\n`;
  const root = fixtureRepo({ "big.py": source });
  const lastLine = bigFunctionLines.length;
  const diff = `diff --git a/big.py b/big.py
index 1111111..2222222 100644
--- a/big.py
+++ b/big.py
@@ -${lastLine - 1},2 +${lastLine - 1},2 @@
+    with _LOCK:
+        return fetch_remote()
`;
  const result = await buildSyntaxContext(diff, root, { maxBytes: 500, maxDeclarationTextBytes: 100_000 });
  assert.equal(result.truncated, true);
  assert.ok(result.reasons.includes("byte_budget"));
  // The budget is a stop-adding-more threshold, not a hard per-item clip:
  // once a single declaration's text (bounded separately by
  // maxDeclarationTextBytes) pushes bytesUsed past maxBytes, the loop
  // stops rather than silently continuing — but that one item is not
  // truncated to fit exactly. bytesUsed > maxBytes proves it stopped.
  assert.ok(result.bytesUsed > 500, "byte budget threshold should have been crossed, triggering truncation");
});
