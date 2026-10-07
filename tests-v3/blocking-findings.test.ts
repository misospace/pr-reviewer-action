import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKING_ANNOTATION_LIMIT,
  blockingGateSummary,
  escapeWorkflowData,
  escapeWorkflowProperty,
  renderBlockingAnnotations,
} from "../src/run/blocking-findings.js";
import { failOnRequestChanges } from "../src/run/action.js";

function withDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "v3-blocking-"));
  return { dir, cleanup: (): void => { rmSync(dir, { recursive: true, force: true }); } };
}

test("property escaping is percent-first, so an encoded sequence is never re-encoded", () => {
  assert.equal(escapeWorkflowProperty("%3A"), "%253A");
  assert.equal(escapeWorkflowProperty(":,"), "%3A%2C");
  assert.equal(escapeWorkflowProperty("a/b: c, d"), "a/b%3A c%2C d");
  assert.equal(escapeWorkflowProperty("line1\nline2"), "line1%0Aline2");
});

test("data escaping handles only percent, CR, and LF (percent first)", () => {
  assert.equal(escapeWorkflowData("%0A"), "%250A");
  assert.equal(escapeWorkflowData("a\nb\rc%d"), "a%0Ab%0Dc%25d");
  assert.equal(escapeWorkflowData("x:y,z"), "x:y,z");
});

test("#252 adversarial boundary: a hostile message cannot forge a second command", () => {
  // The hostile token itself: a raw newline promoting a forged `::error::`
  // line, a literal `%2C`, and backtick/link Markdown that would close a
  // fence. It must come out as ONE line that starts as our own command.
  const message = "first\n::error::forged line with %2C and `code` [link](https://evil.example)";
  const lines = renderBlockingAnnotations([
    { severity: "major", file: "prometheus/x.yml", line: 12, message },
  ]);
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.ok(!line.includes("\n"), `no raw newline: ${line}`);
  assert.ok(!line.includes("\r"), `no raw CR: ${line}`);
  assert.ok(line.startsWith("::error file="), `the annotation is our command, not the forged one: ${line}`);
  // The only `%` the input had (inside the literal `%2C`) is now `%252C`.
  assert.ok(line.includes("%252C"), line);
  assert.ok(!line.includes("%2C and"), line);
  // The forged delimiter survives only as inert data after our own `::`
  // boundary, and the backtick/link payload is unescaped inert text.
  assert.ok(line.includes("::[major] first ::error::forged line with %252C and `code` [link](https://evil.example)"), line);
});

test("a hostile file value escapes its colons and commas in the property", () => {
  const lines = renderBlockingAnnotations([
    { severity: "blocker", file: "a:b/c, d.ts", line: 7, message: "m" },
  ]);
  assert.deepEqual(lines, ["::error file=a%3Ab/c%2C d.ts,line=7::[blocker] m"]);
});

test("only blocker and major render, blockers before majors, in input order", () => {
  const findings = [
    { severity: "minor", file: "a.ts", line: 1, message: "minor" },
    { severity: "major", file: "m1.ts", line: 1, message: "major one" },
    { severity: "blocker", file: "b1.ts", line: 2, message: "blocker one" },
    { severity: "info", file: "i.ts", line: 3, message: "info" },
    { severity: "major", file: "m2.ts", line: 4, message: "major two" },
    { severity: "blocker", file: "b2.ts", line: 5, message: "blocker two" },
  ];
  assert.deepEqual(renderBlockingAnnotations(findings), [
    "::error file=b1.ts,line=2::[blocker] blocker one",
    "::error file=b2.ts,line=5::[blocker] blocker two",
    "::error file=m1.ts,line=1::[major] major one",
    "::error file=m2.ts,line=4::[major] major two",
  ]);
});

test("annotations are capped at the limit, stably, and honor an explicit cap", () => {
  assert.equal(BLOCKING_ANNOTATION_LIMIT, 10);
  const majors = Array.from({ length: 12 }, (_, i) => ({
    severity: "major", file: `f${i}.ts`, line: i + 1, message: `m${i}`,
  }));
  const lines = renderBlockingAnnotations(majors);
  assert.equal(lines.length, 10);
  assert.ok(lines[0]!.includes("file=f0.ts,line=1::[major] m0"));
  assert.ok(lines[9]!.includes("file=f9.ts,line=10::[major] m9"));
  assert.ok(!lines.some((line) => line.includes("f10.")), "the eleventh finding must not leak past the cap");
  assert.equal(renderBlockingAnnotations(majors, 3).length, 3);
});

test("a finding without a usable file produces no annotation", () => {
  const findings = [
    { severity: "blocker", file: "", line: 1, message: "empty file" },
    { severity: "blocker", line: 1, message: "missing file" },
    { severity: "blocker", file: "../x", line: 1, message: "traversal" },
    { severity: "blocker", file: "/abs/x", line: 1, message: "absolute" },
    { severity: "blocker", file: "a/../../x", line: 2, message: "nested traversal" },
    { severity: "major", file: "ok.ts", line: 3, message: "kept" },
  ];
  assert.deepEqual(renderBlockingAnnotations(findings), ["::error file=ok.ts,line=3::[major] kept"]);
});

test("the line property appears only for a positive integer", () => {
  const render = (line: unknown): string[] => {
    const finding: Record<string, unknown> = { severity: "major", file: "f.ts", message: "m" };
    if (line !== undefined) finding.line = line;
    return renderBlockingAnnotations([finding]);
  };
  assert.deepEqual(render(3), ["::error file=f.ts,line=3::[major] m"]);
  for (const bad of [0, -2, 1.5, "3", null]) {
    assert.deepEqual(render(bad), [`::error file=f.ts::[major] m`], `line ${String(bad)} must be omitted`);
  }
  assert.deepEqual(render(undefined), ["::error file=f.ts::[major] m"]);
});

test("a message carrying an API key is masked with redactText's marker before rendering", () => {
  const key = "sk-12345678901234567890";
  const lines = renderBlockingAnnotations([
    { severity: "blocker", file: "f.ts", line: 1, message: `leak: api_key=${key} in env dump` },
  ]);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes(key), lines[0]);
  // The `redactText` heuristic marker (src/context/redact.ts: `REDACTED`).
  assert.ok(lines[0]!.includes("[REDACTED]"), lines[0]);
});

test("an annotation message caps at 300 code points with an ellipsis", () => {
  const lines = renderBlockingAnnotations([
    { severity: "blocker", file: "f.ts", line: 1, message: "é".repeat(350) },
  ]);
  assert.equal(lines[0], `::error file=f.ts,line=1::[blocker] ${"é".repeat(300)}…`);
});

test("the gate summary: count, blockers-first entry, and the one-line message", () => {
  assert.equal(blockingGateSummary([]), "");
  assert.equal(blockingGateSummary(null), "");
  assert.equal(blockingGateSummary("not an array"), "");
  assert.equal(blockingGateSummary([{ severity: "info", file: "a.ts", message: "x" }]), "");
  assert.equal(blockingGateSummary([{ severity: "minor", file: "a.ts", line: 1, message: "minor" }]), "");

  const findings = [
    { severity: "major", file: "b.ts", line: 2, message: "major one" },
    { severity: "blocker", file: "prometheus/x.yml", line: 12, message: "rule is broken" },
    { severity: "minor", file: "c.ts", message: "minor" },
  ];
  assert.equal(blockingGateSummary(findings), "2 blocking finding(s): [blocker] prometheus/x.yml:12 — rule is broken");

  // A file without a line renders as the bare file.
  assert.equal(
    blockingGateSummary([{ severity: "major", file: "b.ts", message: "only a file" }]),
    "1 blocking finding(s): [major] b.ts — only a file",
  );
  // A finding with no usable file still counts, but its entry is severity + message.
  assert.equal(
    blockingGateSummary([
      { severity: "blocker", message: "no location" },
      { severity: "major", file: "b.ts", line: 2, message: "located" },
    ]),
    "2 blocking finding(s): [blocker] no location",
  );
  // A bare blocking record (no message, no file) still produces an entry.
  assert.equal(blockingGateSummary([{ severity: "blocker" }]), "1 blocking finding(s): [blocker]");
});

test("the summary message caps at 200 code points with an ellipsis", () => {
  const summary = blockingGateSummary([
    { severity: "major", file: "f.ts", line: 1, message: "ab".repeat(160) },
  ]);
  assert.equal(summary, `1 blocking finding(s): [major] f.ts:1 — ${"ab".repeat(100)}…`);
});

test("the renderers never throw on hostile or malformed input", () => {
  assert.deepEqual(renderBlockingAnnotations(null), []);
  assert.deepEqual(renderBlockingAnnotations("junk"), []);
  assert.deepEqual(renderBlockingAnnotations(42), []);
  assert.deepEqual(renderBlockingAnnotations({ severity: "blocker" }), []);
  assert.deepEqual(renderBlockingAnnotations([["blocker", "file.ts"]]), []);
  assert.deepEqual(renderBlockingAnnotations([
    null,
    "str",
    42,
    { severity: "blocker", file: "ok.ts", line: 1, message: "kept" },
  ]), ["::error file=ok.ts,line=1::[blocker] kept"]);
  assert.equal(blockingGateSummary(undefined), "");
  assert.equal(blockingGateSummary(Symbol("x")), "");
  assert.equal(blockingGateSummary([undefined, NaN, { severity: null, file: null, line: null, message: null }]), "");
});

test("failOnRequestChanges: blocking verdict fails, annotations precede the gate line, pointer reaches the summary", () => {
  const { dir, cleanup } = withDir();
  const summaryFile = join(dir, "step-summary.md");
  writeFileSync(summaryFile, "");
  const originalWrite = process.stdout.write;
  const captured: string[] = [];
  process.stdout.write = (((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as unknown) as typeof process.stdout.write;
  try {
    const findings = JSON.stringify([
      { severity: "blocker", file: "prometheus/x.yml", line: 12, message: "alert rule is broken" },
      { severity: "minor", file: "y.ts", line: 1, message: "not blocking" },
    ]);
    const pointer = "The verdict was carried from the review of abc123; its findings are in that run's step summary.";
    const code = failOnRequestChanges(
      { FAIL_ON_REQUEST_CHANGES: "true", GITHUB_STEP_SUMMARY: summaryFile },
      "request_changes",
      findings,
      pointer,
    );
    assert.equal(code, 1);
    const out = captured.join("");
    const annotation = "::error file=prometheus/x.yml,line=12::[blocker] alert rule is broken\n";
    const gate = "::error::fail-on-request-changes=true and the final verdict is request_changes: "
      + "1 blocking finding(s): [blocker] prometheus/x.yml:12 — alert rule is broken "
      + `${pointer}\n`;
    // The annotation lands FIRST (it is what the check and Files tab show),
    // the gate line after it, and nothing else was written.
    assert.equal(out, annotation + gate, out);
    // The (otherwise empty) step summary gained the one-line pointer.
    assert.equal(readFileSync(summaryFile, "utf8"), `**AI PR Review failed:** fail-on-request-changes=true and the final verdict is request_changes: 1 blocking finding(s): [blocker] prometheus/x.yml:12 — alert rule is broken ${pointer}\n`);
  } finally {
    process.stdout.write = originalWrite;
    cleanup();
  }
});

test("failOnRequestChanges: no findings and no pointer — the gate says so and writes no summary", () => {
  const { dir, cleanup } = withDir();
  const summaryFile = join(dir, "step-summary.md");
  writeFileSync(summaryFile, "");
  const originalWrite = process.stdout.write;
  const captured: string[] = [];
  process.stdout.write = (((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as unknown) as typeof process.stdout.write;
  try {
    const code = failOnRequestChanges(
      { FAIL_ON_REQUEST_CHANGES: "true", GITHUB_STEP_SUMMARY: summaryFile },
      "request_changes",
    );
    assert.equal(code, 1);
    assert.equal(captured.join(""), "::error::fail-on-request-changes=true and the final verdict is request_changes: no blocking finding with a location was recorded\n");
    assert.equal(readFileSync(summaryFile, "utf8"), "");
  } finally {
    process.stdout.write = originalWrite;
    cleanup();
  }
});

test("failOnRequestChanges: malformed findings degrade to no findings, and an unparseable pointer stays one line", () => {
  const originalWrite = process.stdout.write;
  const captured: string[] = [];
  process.stdout.write = (((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as unknown) as typeof process.stdout.write;
  try {
    assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", "{not json"), 1);
    assert.equal(captured.join(""), "::error::fail-on-request-changes=true and the final verdict is request_changes: no blocking finding with a location was recorded\n");
    captured.length = 0;
    // A pointer with a raw newline must not split the command line.
    assert.equal(failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: "true" }, "request_changes", "[]", "p1\np2"), 1);
    assert.equal(captured.join(""), "::error::fail-on-request-changes=true and the final verdict is request_changes: no blocking finding with a location was recorded p1 p2\n");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("failOnRequestChanges: a non-blocking verdict never fails the step", () => {
  const originalWrite = process.stdout.write;
  const captured: string[] = [];
  process.stdout.write = (((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as unknown) as typeof process.stdout.write;
  try {
    assert.equal(failOnRequestChanges(
      { FAIL_ON_REQUEST_CHANGES: "true" },
      "approve",
      JSON.stringify([{ severity: "blocker", file: "a.ts", line: 1, message: "x" }]),
      "pointer",
    ), 0);
    assert.equal(captured.join(""), "Final verdict is 'approve'; not blocking (fail-on-request-changes=true).\n");
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("failOnRequestChanges: the disabled gate returns 0 and writes no ::error at all", () => {
  const { dir, cleanup } = withDir();
  const summaryFile = join(dir, "step-summary.md");
  writeFileSync(summaryFile, "");
  const originalWrite = process.stdout.write;
  const captured: string[] = [];
  process.stdout.write = (((chunk: unknown) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  }) as unknown) as typeof process.stdout.write;
  try {
    const findings = JSON.stringify([{ severity: "blocker", file: "a.ts", line: 1, message: "x" }]);
    for (const flag of ["false", "FALSE", undefined]) {
      captured.length = 0;
      const code = failOnRequestChanges({ FAIL_ON_REQUEST_CHANGES: flag }, "request_changes", findings, "pointer");
      assert.equal(code, 0);
      assert.equal(captured.length, 0, `flag ${String(flag)} must be silent`);
    }
    assert.equal(readFileSync(summaryFile, "utf8"), "");
  } finally {
    process.stdout.write = originalWrite;
    cleanup();
  }
});
