import test from "node:test";
import assert from "node:assert/strict";
import { extractCitationLocations, parseCitationLocation } from "../src/enforcement/citations.js";

// #1681 r6: the ONE citation grammar shared by the requirement trace, thread
// settlement and human-review settlement. Parsing accepts the grammar; it
// never proves existence — that stays with the exact-head resolver.

test("parseCitationLocation accepts every documented form and takes the head-side first line", () => {
  assert.deepEqual(parseCitationLocation("src/a.ts"), { file: "src/a.ts", line: 1 });
  assert.deepEqual(parseCitationLocation("src/a.ts:12"), { file: "src/a.ts", line: 12 });
  assert.deepEqual(parseCitationLocation("src/a.ts:12-30"), { file: "src/a.ts", line: 12 });
  assert.deepEqual(parseCitationLocation("src/a.ts:12-30:2"), { file: "src/a.ts", line: 12 });
  assert.deepEqual(parseCitationLocation("src/a.ts:+206-232:1"), { file: "src/a.ts", line: 206 });
  assert.deepEqual(parseCitationLocation("src/a.ts:+5"), { file: "src/a.ts", line: 5 });
  assert.deepEqual(parseCitationLocation("  tests/x.test.ts:+1-303:1  "), { file: "tests/x.test.ts", line: 1 });
});

test("parseCitationLocation rejects anything that names no head location", () => {
  for (const ref of [
    null,
    undefined,
    42,
    "",
    "   ",
    "the behavior looks fixed",
    "http://example.com/a.ts:80",
    "https://x/y:80",
    "src/a.ts:0",
    "src/a.ts:-12", // the base-side anchor is not a head location
    "src/a.ts:+232-206:1", // reversed range
    "src/a.ts:+0",
    "line 12", // no path
    "src\n/a.ts", // control bytes are rejected at the parse door (#252)
    "src/a.ts\u0000:1",
  ]) {
    assert.equal(parseCitationLocation(ref), null, JSON.stringify(ref));
  }
  // A bare token with no colon stays file-level provenance (a `Makefile`
  // ref is legitimate); a tool-call id reaching the location channel is
  // rejected by checkout resolution, not by the grammar.
  assert.deepEqual(parseCitationLocation("call-7"), { file: "call-7", line: 1 });
});

test("extractCitationLocations finds citations in prose without inventing locations", () => {
  assert.deepEqual(
    extractCitationLocations("fixed in src/a.ts:12; also src/b.ts:+206-232:2 covers the fold"),
    [{ file: "src/a.ts", line: 12 }, { file: "src/b.ts", line: 206 }],
  );
  // The historical lexical `path … line N` form is a candidate too.
  assert.deepEqual(
    extractCitationLocations("README.md line 12 shows it is handled"),
    [{ file: "README.md", line: 12 }],
  );
  // Directory-qualified bare paths are file-level provenance; bare names are not.
  assert.deepEqual(extractCitationLocations("see src/enforcement/threads.ts for the seam"), [{ file: "src/enforcement/threads.ts", line: 1 }]);
  assert.deepEqual(extractCitationLocations("the author replied that it is fine now"), []);
  assert.deepEqual(extractCitationLocations("e.g. we adjusted the guard"), []);
  // Sentence punctuation around a citation does not break it.
  assert.deepEqual(extractCitationLocations("(src/a.ts:12), done."), [{ file: "src/a.ts", line: 12 }]);
  // A URL is never a code citation.
  assert.deepEqual(extractCitationLocations("see https://example.com/x.ts"), []);
  assert.deepEqual(extractCitationLocations(null), []);
  assert.deepEqual(extractCitationLocations("   "), []);
});

test("extraction is bounded, de-duplicated, and order preserving", () => {
  const many = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts:${i + 1}`).join(" ");
  const found = extractCitationLocations(many);
  assert.ok(found.length <= 16, `bounded: ${found.length}`);
  assert.deepEqual(found[0], { file: "src/f0.ts", line: 1 });
  const dup = extractCitationLocations("src/a.ts:1 then src/a.ts:1 again src/a.ts:2");
  assert.deepEqual(dup, [{ file: "src/a.ts", line: 1 }, { file: "src/a.ts", line: 2 }]);
});
