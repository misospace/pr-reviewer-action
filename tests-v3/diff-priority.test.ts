/** Unit tests for the diff-priority port (src/corpus/diff-priority.ts). The
 * cross-implementation contract is pinned byte-for-byte by the parity
 * harness (tests/fixtures/parity/diff-priority/); these pin the invariants
 * that must hold for ANY input: budget never exceeded, source chunks survive
 * ahead of bulk/generated ones, clips land on line boundaries, sub-minimum
 * chunks are omitted rather than stubbed, and the manifest is bounded. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DIFF_MARKER,
  MIN_CHUNK_BYTES,
  prioritizeDiff,
  rankPath,
  splitChunks,
  truncatePlain,
} from "../src/corpus/index.js";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const dec = (data: Uint8Array): string => Buffer.from(data).toString("utf8");

function chunk(path: string, lines: number, width = 40, dels = 0): string {
  const body = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${dels} +1,${lines} @@`,
  ];
  for (let i = 0; i < dels; i += 1) body.push(`-${"x".repeat(width)}`);
  for (let i = 0; i < lines; i += 1) body.push(`+${String(i).padStart(4, "0")} ${"y".repeat(width)}`);
  return `${body.join("\n")}\n`;
}

function emittedPaths(out: Uint8Array): string[] {
  return dec(out)
    .split("\n")
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => line.split(" b/", 2)[1] as string);
}

function manifest(out: Uint8Array): string[] {
  const text = dec(out);
  const at = text.indexOf("Files omitted from this diff (");
  if (at < 0) return [];
  return text
    .slice(at)
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- ") && !line.startsWith("- … and "));
}

test("fast path returns the input verbatim", () => {
  const diff = enc(chunk("a.py", 5) + chunk("b.json", 5));
  assert.equal(prioritizeDiff(diff, diff.length), diff);
  assert.deepEqual(prioritizeDiff(diff, diff.length + 1), diff);
});

test("header-less input falls back to truncate_clean semantics", () => {
  const data = enc("line1\nline2\nline3\n".repeat(100));
  const out = prioritizeDiff(data, 100);
  assert.deepEqual(out, truncatePlain(data, 100));
  assert.ok(dec(out).endsWith(`\n${dec(DEFAULT_DIFF_MARKER)}\n`));
  assert.ok(out.length <= 100);
  assert.deepEqual(truncatePlain(enc("abc"), 2), enc(".."));
  assert.deepEqual(truncatePlain(enc("abc"), 0), enc(""));
});

test("splitChunks separates preamble and per-file chunks", () => {
  const pre = "preamble line\n";
  const diff = enc(pre + chunk("src/a.py", 2) + chunk("docs/b.md", 3));
  const [preamble, chunks] = splitChunks(diff);
  assert.equal(dec(preamble), pre);
  assert.deepEqual(chunks.map(([path]) => dec(path)), ["src/a.py", "docs/b.md"]);
  assert.equal(chunks.reduce((n, [, data]) => n + data.length, 0), diff.length - preamble.length);
});

test("rankPath classifies by path and size", () => {
  const none = new Set<string>();
  assert.equal(rankPath(enc("src/app.py"), 100, none), 0);
  assert.equal(rankPath(enc("small.json"), 100, none), 0);
  assert.equal(rankPath(enc("data/big.json"), 40 * 1024, none), 2);
  assert.equal(rankPath(enc("tests/fixtures/x.py"), 10, none), 2);
  assert.equal(rankPath(enc("a/testdata/b.go"), 10, none), 2);
  assert.equal(rankPath(enc("package-lock.json"), 10, none), 3);
  assert.equal(rankPath(enc("Cargo.lock"), 10, none), 3);
  assert.equal(rankPath(enc("app.min.js"), 10, none), 3);
  assert.equal(rankPath(enc("dist/index.js"), 10, none), 3);
  assert.equal(rankPath(enc("x/__snapshots__/y.snap"), 10, none), 3);
  assert.equal(rankPath(enc("api.generated.ts"), 10, none), 3);
  assert.equal(rankPath(enc("Build/thing.py"), 10, none), 3);
  assert.equal(rankPath(enc("src/schema.py"), 10, new Set(["src/schema.py"])), 3);
});

test("source survives ahead of a large fixture blob and the trailer lists it", () => {
  const blob = chunk("a/fixtures/corpus.json", 3000);
  const code = chunk("z/logic.py", 20);
  const out = prioritizeDiff(enc(blob + code), 4000);
  assert.ok(out.length <= 4000);
  assert.deepEqual(emittedPaths(out), ["z/logic.py", "a/fixtures/corpus.json"]);
  assert.ok(dec(out).includes(code));
  assert.deepEqual(manifest(out), ["- a/fixtures/corpus.json (+3000/-0) clipped"]);
});

test("water-filling shares a rank's budget fairly", () => {
  const out = prioritizeDiff(enc(chunk("a.py", 400) + chunk("b.py", 100) + chunk("c.py", 5)), 8000);
  assert.ok(out.length <= 8000);
  assert.deepEqual(emittedPaths(out), ["a.py", "b.py", "c.py"]);
  assert.deepEqual(manifest(out), ["- a.py (+400/-0) clipped", "- b.py (+100/-0) clipped"]);
  const text = dec(out);
  const sizes = ["a.py", "b.py"].map((path) => {
    const start = text.indexOf(`diff --git a/${path}`);
    return text.indexOf("…[file diff clipped: ", start) - start;
  });
  assert.ok(Math.abs((sizes[0] as number) - (sizes[1] as number)) < 100);
});

test("clips land on a line boundary and never split multibyte characters", () => {
  const wide = Array.from({ length: 200 }, () => `+${"é".repeat(30)}`).join("\n");
  const diff = enc(`diff --git a/u.py b/u.py\n--- a/u.py\n+++ b/u.py\n@@ -0,0 +1,200 @@\n${wide}\n${chunk("v.py", 200)}`);
  const out = prioritizeDiff(diff, 5000);
  assert.ok(out.length <= 5000);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(out));
  const text = dec(out);
  const note = text.indexOf("…[file diff clipped: ");
  assert.ok(note > 0);
  assert.equal(text[note - 1], "\n");
});

test("chunks below the minimum are omitted, not stubbed", () => {
  let many = "";
  for (let i = 0; i < 20; i += 1) many += chunk(`f${i}.py`, 30);
  const out = prioritizeDiff(enc(many), 3000);
  assert.ok(out.length <= 3000);
  const kept = emittedPaths(out);
  const text = dec(out);
  for (const path of kept) {
    const start = text.indexOf(`diff --git a/${path}`);
    const next = text.indexOf("\ndiff --git ", start);
    const end = next >= 0 ? next + 1 : text.indexOf(dec(DEFAULT_DIFF_MARKER));
    assert.ok(Buffer.byteLength(text.slice(start, end)) >= MIN_CHUNK_BYTES);
  }
  const omitted = manifest(out).filter((line) => line.endsWith("omitted"));
  assert.ok(omitted.length > 0);
  assert.equal(kept.length + omitted.length, 20);
});

test("manifest caps at 200 lines and counts every listed file", () => {
  let many = "";
  for (let i = 0; i < 260; i += 1) many += chunk(`dir/file${String(i).padStart(3, "0")}.py`, 3);
  const out = prioritizeDiff(enc(many), 20000);
  assert.ok(out.length <= 20000);
  const text = dec(out);
  const header = Number(text.split("Files omitted from this diff (", 2)[1]?.split(")", 1)[0]);
  const more = text.split("\n").filter((line) => line.startsWith("- … and "));
  assert.equal(manifest(out).length, 200);
  assert.equal(more.length, 1);
  assert.equal(header, 200 + Number((more[0] as string).split(" and ", 2)[1]?.split(" ", 1)[0]));
});

test("generated paths and lockfiles rank last; leftover budget flows down", () => {
  const code = chunk("a.py", 5);
  const lock = chunk("yarn.lock", 300);
  const blob = chunk("x/fixtures/y.json", 300);
  const out = prioritizeDiff(enc(code + lock + blob), 20000);
  assert.deepEqual(emittedPaths(out), ["a.py", "x/fixtures/y.json", "yarn.lock"]);
  const gen = prioritizeDiff(enc(chunk("schema.py", 200) + chunk("main.py", 200)), Buffer.byteLength(chunk("main.py", 200)) + 3000, {
    generated: new Set(["schema.py"]),
  });
  assert.deepEqual(emittedPaths(gen), ["main.py", "schema.py"]);
});

test("tiny budgets mirror the truncate_clean sentinel; custom marker is honoured", () => {
  const diff = enc(chunk("a.py", 50));
  assert.deepEqual(prioritizeDiff(diff, 3), enc("..."));
  assert.deepEqual(prioritizeDiff(diff, 1), enc("."));
  assert.deepEqual(prioritizeDiff(diff, 0), enc(""));
  const out = prioritizeDiff(enc(chunk("a.py", 500) + chunk("b.py", 500)), 4000, { marker: enc("CUT") });
  assert.ok(dec(out).includes("\nCUT\nFiles omitted from this diff ("));
  assert.ok(!dec(out).includes(dec(DEFAULT_DIFF_MARKER)));
});

test("output is deterministic", () => {
  let diff = "";
  for (let i = 0; i < 30; i += 1) diff += chunk(`p${i}/f${i}.py`, 50 + i);
  diff += chunk("big/fixtures/z.json", 2000);
  const first = prioritizeDiff(enc(diff), 12000);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(prioritizeDiff(enc(diff), 12000), first);
});
