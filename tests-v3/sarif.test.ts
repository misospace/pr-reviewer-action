import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PyFloat,
  SARIF_MAX_INPUT_BYTES,
  normalizeSarif,
  pyJsonDumps,
  pyJsonLoads,
  sarifProviderEntry,
  splitSarifPaths,
  workspacePath,
} from "../src/evidence/index.js";

const sarif = (results: unknown[], driver: Record<string, unknown> = { name: "tool" }): unknown => ({
  version: "2.1.0",
  runs: [{ tool: { driver }, results }],
});

test("level → severity mapping, default warning, unknown/non-string → info", () => {
  const out = normalizeSarif(sarif([
    { level: "error", message: { text: "e" } },
    { level: "warning", message: { text: "w" } },
    { level: "note", message: { text: "n" } },
    { level: "none", message: { text: "x" } },
    { message: { text: "default" } },
    { level: " ERROR ", message: { text: "spaced" } },
    { level: "fatal", message: { text: "unknown" } },
    { level: 3, message: { text: "number" } },
  ]));
  assert.deepEqual(out.findings.map((f) => f.severity), ["major", "minor", "info", "info", "minor", "major", "info", "info"]);
  assert.deepEqual(out.errors, []);
});

test("caps count code points, record omitted counts, and dedupe exact duplicates", () => {
  const emoji = "😀".repeat(1005);
  const dup = { ruleId: "R", message: { text: "same" } };
  const out = normalizeSarif(sarif([{ message: { text: emoji } }, dup, dup, { message: { text: "third" } }]), { maxFindings: 2 });
  assert.equal(Array.from(out.findings[0]?.message ?? "").length, 1000);
  assert.equal(out.truncation.omitted_message_chars, 5);
  assert.equal(out.truncation.omitted_findings, 1);
  assert.deepEqual(out.truncation.reasons, ["message_chars_cap", "finding_cap"]);
  assert.equal(out.findings.length, 2);
});

test("float startLine is not an int (v2 isinstance), big ints survive exactly", () => {
  const payload = pyJsonLoads(JSON.stringify(sarif([
    { message: { text: "f" }, locations: [{ physicalLocation: { artifactLocation: { uri: "a" }, region: { startLine: 1 } } }] },
  ])).replace('"startLine":1', '"startLine":12.0'));
  assert.equal(normalizeSarif(payload).findings[0]?.line, null);
  const big = pyJsonLoads('{"version":"2.1.0","runs":[{"results":[{"message":{"text":"b"},"locations":[{"physicalLocation":{"region":{"startLine":123456789012345678901234567890}}}]}]}]}');
  const line = normalizeSarif(big).findings[0]?.line;
  assert.equal(line, 123456789012345678901234567890n);
  assert.match(pyJsonDumps(normalizeSarif(big)), /"line": 123456789012345678901234567890/);
});

test("the errors cap appends one marker and counts the rest", () => {
  const out = normalizeSarif(sarif(Array.from({ length: 103 }, () => 0)));
  assert.equal(out.errors.length, 101);
  assert.equal(out.errors[100], "errors_truncated");
  assert.equal(out.truncation.omitted_errors, 3);
});

function ws(): string {
  return mkdtempSync(join(tmpdir(), "v3-sarif-"));
}

test("workspace path guard: absolute, dot-dot, NUL, and symlink escapes are refused", () => {
  const root = ws();
  const outside = ws();
  writeFileSync(join(outside, "x.sarif"), "{}");
  mkdirSync(join(root, "sub"));
  symlinkSync(outside, join(root, "sub", "escape"));
  writeFileSync(join(root, "ok.sarif"), "{}");
  assert.equal(workspacePath("/etc/passwd", root), null);
  assert.equal(workspacePath("../x.sarif", root), null);
  assert.equal(workspacePath("a/../ok.sarif", root), null);
  assert.equal(workspacePath("ok\u0000.sarif", root), null);
  assert.equal(workspacePath("sub/escape/x.sarif", root), null, "a symlink resolving outside the workspace is refused");
  assert.notEqual(workspacePath("ok.sarif", root), null);
  const entry = sarifProviderEntry(1, "sub/escape/x.sarif", root, 10);
  assert.equal(entry.stderr, "SARIF path must be a workspace-relative path that stays inside the workspace");
  assert.equal(entry.provider_severity, "major");
});

test("oversize input is rejected by the bounded read", () => {
  const root = ws();
  writeFileSync(join(root, "big.sarif"), Buffer.alloc(SARIF_MAX_INPUT_BYTES + 1, 0x20));
  const entry = sarifProviderEntry(1, "big.sarif", root, 10);
  assert.equal(entry.status, "error");
  assert.equal(entry.stderr, "Unable to parse SARIF file big.sarif: SARIF input exceeds 10000000 byte limit");
});

test("adversarial: every stored SARIF string is redacted before it reaches the entry", () => {
  const root = ws();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  writeFileSync(join(root, "s.sarif"), JSON.stringify(sarif(
    [{ ruleId: `rule-${secret}`, level: "error", message: { text: `leak password=${secret} [REDACTED]` }, locations: [{ physicalLocation: { artifactLocation: { uri: `api_key=${secret}` }, region: { startLine: 2 } } }] }],
    { name: `tool ${secret}`, version: secret, informationUri: `https://x/?token=${secret}` },
  )));
  const entry = sarifProviderEntry(1, "s.sarif", root, 10);
  const serialized = pyJsonDumps(entry);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.match(entry.findings[0]?.message ?? "", /\[REDACTED\]/);
});

test("splitSarifPaths splits on commas/newlines and strips Python whitespace", () => {
  assert.deepEqual(splitSarifPaths(" a.sarif,,b.sarif\n\u0085c.sarif\u001f \n"), ["a.sarif", "b.sarif", "c.sarif"]);
});

test("pyJsonLoads reproduces CPython's acceptance rules and error text", () => {
  const cases: Array<[string, string]> = [
    ["", "Expecting value: line 1 column 1 (char 0)"],
    ["{", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"],
    ['{"a"', "Expecting ':' delimiter: line 1 column 5 (char 4)"],
    ['{"a":1', "Expecting ',' delimiter: line 1 column 7 (char 6)"],
    ['{"a":1,}', "Illegal trailing comma before end of object: line 1 column 7 (char 6)"],
    ["[1,]", "Illegal trailing comma before end of array: line 1 column 3 (char 2)"],
    ['"abc', "Unterminated string starting at: line 1 column 1 (char 0)"],
    ['"a\\x"', "Invalid \\escape: line 1 column 3 (char 2)"],
    ['"a\\u12"', "Invalid \\uXXXX escape: line 1 column 4 (char 3)"],
    ['"a\u0001"', "Invalid control character at: line 1 column 3 (char 2)"],
    ["01", "Extra data: line 1 column 2 (char 1)"],
    ["1.5e+", "Extra data: line 1 column 4 (char 3)"],
    ["﻿{}", "Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)"],
    ['{"a":1\n\n  x', "Expecting ',' delimiter: line 3 column 3 (char 10)"],
    ['"é\u0002"', "Invalid control character at: line 1 column 3 (char 2)"],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => pyJsonLoads(input), (error: Error) => error.message === message, JSON.stringify(input));
  }
  const value = pyJsonLoads('[NaN, -Infinity, 1.0, 2, {"__proto__": 1, "a": 1, "a": 2}]') as unknown[];
  assert.ok(value[0] instanceof PyFloat && Number.isNaN(value[0].value));
  assert.ok(value[2] instanceof PyFloat && value[2].value === 1);
  assert.equal(value[3], 2);
  assert.deepEqual(Object.keys(value[4] as object), ["__proto__", "a"]);
  assert.equal(Object.getPrototypeOf(value[4]), Object.prototype, "__proto__ stays a data key");
  assert.equal(pyJsonDumps(value), '[\n  NaN,\n  -Infinity,\n  1.0,\n  2,\n  {\n    "__proto__": 1,\n    "a": 2\n  }\n]');
  const deep = "[".repeat(100_000) + "]".repeat(100_000);
  assert.ok(Array.isArray(pyJsonLoads(deep)), "iterative: deep nesting cannot overflow the stack");
  assert.throws(() => pyJsonLoads("1".repeat(4301)), /Exceeds the limit \(4300 digits\)/);
});
