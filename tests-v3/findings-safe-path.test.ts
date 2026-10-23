import test from "node:test";
import assert from "node:assert/strict";
import { safePath } from "../src/findings/safe-path.js";

// #1163: the conformance table for the ONE `safePath` predicate shared by
// the finding-path gates (`src/publish/inline-findings.ts`,
// `src/run/blocking-findings.ts`, `src/outcomes/identity.ts`). Pinning the
// shared implementation here is what keeps the next edge case from being
// fixed in one copy and missed in the others: the three call sites import
// this exact function, so this table is their contract.

test("#1163: unanchorable paths fail closed — empty, absolute, and every traversal shape", () => {
  for (const path of [
    undefined, null, 42, {}, [], "",
    "/", "/abs/path.ts", "../traversal.ts",
    "src/../secrets.env", "..", "a/..", "a/../..", "x/../",
  ]) {
    assert.equal(safePath(path), false, `path: ${JSON.stringify(path)}`);
  }
});

test("#1163: NUL-bearing paths fail closed — NUL is illegal in any POSIX path component", () => {
  for (const path of ["a\u0000.ts", "a\u0000b/x.ts", "\u0000", "a/b\u0000", "a.ts\u0000suffix"]) {
    assert.equal(safePath(path), false, `path: ${JSON.stringify(path)}`);
  }
});

test("#1163: ordinary repository-relative paths stay anchors, including symlink-shaped ones", () => {
  for (const path of ["a.ts", "src/app.ts", "a/b/c/d.ts", "a..b/c.ts", "..a.ts", "a/..b.ts", "link/real.ts"]) {
    assert.equal(safePath(path), true, `path: ${JSON.stringify(path)}`);
  }
});
