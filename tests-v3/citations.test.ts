import test from "node:test";
import assert from "node:assert/strict";
import { citationNamesExplicitLine, extractCitationLocations, parseCitationLocation } from "../src/enforcement/citations.js";

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
  // Round 7: dot-prefixed repository roots are ordinary paths, at the parse
  // door and not just through the keyword form.
  assert.deepEqual(parseCitationLocation(".github/workflows/ci.yml:12"), { file: ".github/workflows/ci.yml", line: 12 });
  assert.deepEqual(parseCitationLocation(".github/workflows/ci.yml"), { file: ".github/workflows/ci.yml", line: 1 });
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
    "src/a.ts:232-206", // reversed plain range: malformed, not a citation
    "src/a.ts:+232-206:1", // reversed range
    "src/a.ts:+0",
    "line 12", // no path
    "src\n/a.ts", // control bytes are rejected at the parse door (#252)
    "src/a.ts\u0000:1",
    // Round 7: model citations are REPOSITORY-RELATIVE. Absolute,
    // drive-shaped and traversal spellings are refused by the grammar, not
    // left to happen to fail on one runner's checkout layout.
    "/tmp/foo.ts:12",
    "/C:/foo.ts:12",
    "C:/foo.ts:12",
    "C:\\foo.ts:12",
    "../foo.ts:1",
    "../foo.ts",
    "src/../../foo.ts:1",
    "/abs/path/../foo.ts:1",
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
  // Pathological length cites nothing: the shipped channels cap evidence far
  // below this, and the prose scan is quadratic on adversarial input.
  assert.deepEqual(extractCitationLocations(`${"a".repeat(9000)}.ts:12`), []);
});

test("#1681 r7: prose extraction shares the canonical grammar — every structured form is discoverable", () => {
  // One grammar authority: anything parseCitationLocation accepts as a
  // structured ref must also be found when embedded in ordinary prose,
  // or the two channels drift back into the round-6 bug class.
  const forms: Array<[string, { file: string; line: number }]> = [
    ["README.md", { file: "README.md", line: 1 }],
    ["README.md:12", { file: "README.md", line: 12 }],
    ["README.md:12-18", { file: "README.md", line: 12 }],
    [".github/workflows/ci.yml:12", { file: ".github/workflows/ci.yml", line: 12 }],
    ["src/a.ts:+206-232:1", { file: "src/a.ts", line: 206 }],
    ["tests/x.test.ts:+1-303:1", { file: "tests/x.test.ts", line: 1 }],
  ];
  for (const [ref, expected] of forms) {
    assert.deepEqual(parseCitationLocation(ref), expected, `structured: ${ref}`);
    assert.deepEqual(
      extractCitationLocations(`Fixed in ${ref}, and the follow-up landed after it.`),
      [expected],
      `prose: ${ref}`,
    );
  }
  // Two refs in one sentence, order preserved; absolute/traversal refs cite
  // nothing even inside prose.
  assert.deepEqual(
    extractCitationLocations("Fixed in README.md:12, and .github/workflows/ci.yml:+40-44:2."),
    [{ file: "README.md", line: 12 }, { file: ".github/workflows/ci.yml", line: 40 }],
  );
  assert.deepEqual(extractCitationLocations("proof: /tmp/foo.ts:12 and ../foo.ts:3"), []);
});

test("#1681 r7: prose discovery stays conservative — URLs, tool ids and bare line numbers cite nothing", () => {
  assert.deepEqual(extractCitationLocations("https://example.com/x.ts:80"), [], "a URL is never a code citation");
  assert.deepEqual(extractCitationLocations("see the tool output call-7 for details"), [], "a tool id is not code evidence");
  assert.deepEqual(extractCitationLocations("line 12 proves it"), [], "a line without a path is not a location");
  // parse → syntax only; resolve → provenance truth. A path that exists
  // nowhere still PARSES (the same grammar the structured channel uses) —
  // the exact-head resolver, not the extractor, is what rejects it.
  assert.deepEqual(parseCitationLocation("src/does-not-exist.ts:999"), { file: "src/does-not-exist.ts", line: 999 });
  assert.deepEqual(extractCitationLocations("src/does-not-exist.ts:999"), [{ file: "src/does-not-exist.ts", line: 999 }]);
});

test("#1835 round 4: the canonical explicit-line distinction covers every line-specific spelling", () => {
  // A bare path is file-level; `path:LINE`, `path:LINE-END` and BOTH
  // diff-anchor spellings are line-specific. The anchor's `:` is followed
  // by `+`, which a digit probe misreads as file-level — the distinction is
  // the grammar's own regexes, never a second probe.
  for (const lineSpecific of ["src/a.ts:12", "src/a.ts:12-30", "src/a.ts:+4-9", "src/a.ts:+4", "src/a.ts:+4-9:2"]) {
    assert.equal(citationNamesExplicitLine(lineSpecific), true, lineSpecific);
  }
  for (const fileLevel of ["src/a.ts", "docs/inputs.md", "not a citation", "/etc/passwd:1", "src/a.ts:0"]) {
    assert.equal(citationNamesExplicitLine(fileLevel), false, fileLevel);
  }
});
