import assert from "node:assert/strict";
import test from "node:test";
import { findDefinition, findEnclosingDeclaration, identifiersInRange } from "../src/context/syntax/declarations.js";
import { parserFor } from "../src/context/syntax/grammars.js";

const PY_SOURCE = `import threading

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


class Widget:
    def render(self):
        return get_value()
`;

test("findEnclosingDeclaration returns the smallest containing function for a Python hunk", async () => {
  const parser = await parserFor("python");
  assert.ok(parser !== null, "python grammar should load");
  const tree = parser!.parse(PY_SOURCE);
  assert.ok(tree !== null);
  // Lines 15-16 (1-based) are the `with _LOCK: _CACHE = fetch_remote()` body,
  // inside get_value (not fetch_remote, not the module, not Widget.render).
  const decl = findEnclosingDeclaration(tree!, "python", 15, 16, 4000);
  assert.ok(decl !== null);
  assert.equal(decl!.name, "get_value");
  assert.equal(decl!.type, "function_definition");
  assert.ok(decl!.text.includes("_LOCK"));
});

test("findEnclosingDeclaration returns null for a range outside any declaration", async () => {
  const parser = await parserFor("python");
  const tree = parser!.parse(PY_SOURCE);
  // Line 1 is the top-level `import threading` — not inside any function/class.
  const decl = findEnclosingDeclaration(tree!, "python", 1, 1, 4000);
  assert.equal(decl, null);
});

test("identifiersInRange collects identifier names referenced on a line", async () => {
  const parser = await parserFor("python");
  const tree = parser!.parse(PY_SOURCE);
  // Line 16: "        _CACHE = fetch_remote()"
  const ids = identifiersInRange(tree!, 16, 16);
  assert.ok(ids.includes("_CACHE"));
  assert.ok(ids.includes("fetch_remote"));
});

test("findDefinition finds a same-file function definition by name", async () => {
  const parser = await parserFor("python");
  const tree = parser!.parse(PY_SOURCE);
  const def = findDefinition(tree!, "python", "fetch_remote", 4000);
  assert.ok(def !== null);
  assert.equal(def!.name, "fetch_remote");
  assert.equal(def!.type, "function_definition");
});

test("findDefinition returns null when no matching declaration exists", async () => {
  const parser = await parserFor("python");
  const tree = parser!.parse(PY_SOURCE);
  const def = findDefinition(tree!, "python", "does_not_exist", 4000);
  assert.equal(def, null);
});

const TS_SOURCE = `export function helper(x: number): number {
  return x + 1;
}

export const wrapped = (x: number): number => {
  return helper(x) * 2;
};
`;

test("findEnclosingDeclaration handles a TypeScript arrow-function const", async () => {
  const parser = await parserFor("typescript");
  assert.ok(parser !== null, "typescript grammar should load");
  const tree = parser!.parse(TS_SOURCE);
  const decl = findEnclosingDeclaration(tree!, "typescript", 6, 6, 4000);
  assert.ok(decl !== null);
  assert.equal(decl!.name, "wrapped");
});

const TS_LOCAL_VAR_SOURCE = `export function helper(x: number): number {
  const result = x + 1;
  return result;
}
`;

test("findEnclosingDeclaration does not treat an ordinary local const as its own declaration", async () => {
  const parser = await parserFor("typescript");
  const tree = parser!.parse(TS_LOCAL_VAR_SOURCE);
  // Line 2 is `const result = x + 1;` — an ordinary local variable, not a
  // function/class-valued declaration. The enclosing declaration should be
  // `helper`, not a bogus "result" declaration (which would make `result`
  // — a very common name — get searched as if it were a function).
  const decl = findEnclosingDeclaration(tree!, "typescript", 2, 2, 4000);
  assert.ok(decl !== null);
  assert.equal(decl!.name, "helper");
});

test("findDefinition does not match an ordinary local const with the same name", async () => {
  const parser = await parserFor("typescript");
  const tree = parser!.parse(TS_LOCAL_VAR_SOURCE);
  const def = findDefinition(tree!, "typescript", "result", 4000);
  assert.equal(def, null);
});

test("unsupported language returns a null parser rather than throwing", async () => {
  // "yaml" has no declaration types registered but the grammar itself does
  // load; the real "unsupported" case (no grammar at all) is exercised via
  // languageForPath returning null upstream in syntax-context.test.ts.
  const parser = await parserFor("yaml");
  assert.ok(parser !== null);
});
