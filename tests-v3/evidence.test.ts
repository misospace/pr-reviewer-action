import test from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROVIDER_FINDINGS,
  normalizeSeverity,
  parseProviderFindings,
  runEvidenceProvider,
  severityRank,
  type ProviderSpec,
} from "../src/evidence/index.js";
import { runProcess } from "../src/runtime/index.js";

const ambientBase: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

test("severity normalization maps aliases and defaults to info", () => {
  assert.equal(normalizeSeverity("BLOCKER"), "blocker");
  assert.equal(normalizeSeverity("Warning"), "warning");
  assert.equal(normalizeSeverity("minor"), "minor");
  assert.equal(normalizeSeverity("critical"), "info");
  assert.equal(normalizeSeverity(undefined), "info");
  assert.equal(normalizeSeverity(42), "info");
  assert.equal(severityRank("blocker"), 3);
  assert.equal(severityRank("major"), 2);
  assert.equal(severityRank("warning"), 2);
  assert.equal(severityRank("info"), 1);
});

test("parseProviderFindings handles dicts, strings, sources, and the fallback message", () => {
  const { providerSeverity, findings } = parseProviderFindings({
    severity: "major",
    findings: [
      { message: "m1", severity: "warning" },
      { summary: "m2", sources: ["a", "b"] },
      "bare string finding",
      { no_message: true },
      { title: "m3" },
    ],
  });
  assert.equal(providerSeverity, "major");
  assert.deepEqual(findings, [
    { severity: "warning", message: "m1", source: "" },
    { severity: "info", message: "m2", source: "a, b" },
    { severity: "info", message: "bare string finding", source: "" },
    { severity: "info", message: "m3", source: "" },
  ]);

  const fallback = parseProviderFindings({ severity: "minor", message: "only message" });
  assert.deepEqual(fallback.findings, [{ severity: "minor", message: "only message", source: "" }]);
  assert.equal(fallback.providerSeverity, "minor");

  assert.deepEqual(parseProviderFindings("not an object"), { providerSeverity: "info", findings: [] });
});

test("finding severity escalates the provider severity; findings capped at 40", () => {
  const escalated = parseProviderFindings({
    severity: "info",
    findings: Array.from({ length: 45 }, (_, i) => ({ message: `f${i}`, severity: i === 0 ? "blocker" : "info" })),
  });
  assert.equal(escalated.providerSeverity, "blocker");
  assert.equal(escalated.findings.length, MAX_PROVIDER_FINDINGS);
});

test("argv provider: exact stdout preserved, status ok", async () => {
  const entry = await runEvidenceProvider(
    { id: "p1", command: ["printf", "héllo→bytes"] },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.exit_code, 0);
  assert.equal(entry.stdout, "héllo→bytes");
  assert.equal(entry.output_format, "text");
  assert.equal(entry.command, "printf 'héllo→bytes'", "conservative quoting wraps non-ASCII args");
});

test("argv recording escapes embedded single quotes (display-only, never executed)", async () => {
  const entry = await runEvidenceProvider(
    { id: "p1q", command: ["printf", "it's here"] },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.stdout, "it's here");
  // POSIX single-quote escape: close the quote, insert an escaped one,
  // reopen. The recorded command is display-only.
  assert.equal(entry.command, "printf 'it'\\''s here'");
});

test("hostile finding messages are stored opaquely (no fence or control reinterpretation)", () => {
  const hostile = {
    severity: "major",
    findings: [
      { message: "```\nnot a fence\n```", severity: "blocker" },
      { message: "bad\u0007bell\u001bescape", source: "a\tpy" },
      { message: "trailing backticks ```` `` `", severity: "warning" },
    ],
  };
  const findings = parseProviderFindings(hostile).findings;
  assert.equal(findings.length, 3);
  // Findings are opaque data at this layer: control characters and backtick
  // runs pass through verbatim; fence safety is the downstream corpus
  // renderer's contract.
  assert.equal(findings[0]?.message, "```\nnot a fence\n```");
  assert.equal(findings[1]?.message, "bad\u0007bell\u001bescape");
  assert.equal(findings[1]?.source, "a\tpy");
  assert.equal(findings[2]?.message, "trailing backticks ```` `` `");
});

test("JSON provider output parses into normalized findings", async () => {
  const payload = JSON.stringify({
    severity: "major",
    findings: [
      { message: "sql injection", severity: "blocker", source: "app.py:10" },
      { message: "naming", severity: "minor" },
    ],
  });
  const entry = await runEvidenceProvider(
    { id: "p2", command: ["printf", "%s", payload] },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.output_format, "json");
  assert.equal(entry.provider_severity, "blocker");
  assert.deepEqual(entry.findings, [
    { severity: "blocker", message: "sql injection", source: "app.py:10" },
    { severity: "minor", message: "naming", source: "" },
  ]);
});

test("shell-string commands run via bash -lc with the raw command recorded", async () => {
  const entry = await runEvidenceProvider(
    { id: "p3", command: "echo shell-string-ok" },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.stdout.trim(), "shell-string-ok");
  assert.equal(entry.command, "echo shell-string-ok");
});

test("missing command is an invalid entry, never a throw", async () => {
  const entry = await runEvidenceProvider({ id: "p4" }, { ambientEnv: ambientBase });
  assert.equal(entry.status, "invalid");
  assert.match(entry.stderr, /Missing required field: command/);
});

test("provider timeout terminates the whole tree, exit_code stays null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-evidence-"));
  const gcPidFile = join(dir, "gc.pid");
  const entry = await runEvidenceProvider(
    {
      id: "p5",
      command: `sleep 30 & echo $! > '${gcPidFile}'; sleep 60`,
      timeout_sec: 1,
    },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "timeout");
  assert.equal(entry.exit_code, null);
  assert.ok(entry.duration_sec >= 1 && entry.duration_sec < 20, `duration ${entry.duration_sec}`);

  // The backgrounded grandchild must be gone too (v2 killed only the leader).
  for (let i = 0; i < 100; i++) {
    const raw = readPidFile(gcPidFile);
    if (raw !== null) {
      const pid = Number.parseInt(raw, 10);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, "grandchild must not survive the provider timeout");
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("grandchild pid file never appeared");
});

test("credential canary absent from the provider child env; GH_TOKEN kept", async () => {
  const ambient: NodeJS.ProcessEnv = {
    ...ambientBase,
    AI_API_KEY: "SENTINEL-AI-KEY",
    LINEAR_API_KEY: "SENTINEL-LINEAR-KEY",
    TOOL_MCP_TOKEN: "SENTINEL-MCP-TOKEN",
    GH_TOKEN: "SENTINEL-GH-TOKEN",
    MY_PROVIDER_EXTRA: "explicitly-widened",
  };
  const entry = await runEvidenceProvider(
    { id: "p6", command: [execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"] },
    { ambientEnv: ambient },
  );
  const observed = JSON.parse(entry.stdout) as Record<string, string>;
  assert.equal(observed.AI_API_KEY, undefined);
  assert.equal(observed.LINEAR_API_KEY, undefined);
  assert.equal(observed.TOOL_MCP_TOKEN, undefined);
  assert.equal(observed.GH_TOKEN, "SENTINEL-GH-TOKEN");
  assert.equal(observed.MY_PROVIDER_EXTRA, undefined, "widening requires the explicit allowEnv seam");

  const widened = await runEvidenceProvider(
    { id: "p7", command: [execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"] },
    { ambientEnv: ambient, allowEnv: ["MY_PROVIDER_EXTRA"] },
  );
  const widenedEnv = JSON.parse(widened.stdout) as Record<string, string>;
  assert.equal(widenedEnv.MY_PROVIDER_EXTRA, "explicitly-widened");
});

test("output beyond max_output_bytes truncates with the flag set", async () => {
  const entry = await runEvidenceProvider(
    { id: "p8", command: "seq 1 10000", max_output_bytes: 512, timeout_sec: 15 },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "ok");
  assert.equal(entry.stdout_truncated, true);
  assert.ok(entry.stdout.length <= 512, `stdout ${entry.stdout.length} > 512`);
});

test("injected redact seam masks captured output before JSON parsing", async () => {
  const payload = JSON.stringify({ severity: "major", message: "token SECRET leaked" });
  const entry = await runEvidenceProvider(
    { id: "p9", command: ["printf", "%s", payload] },
    {
      ambientEnv: ambientBase,
      redact: (text) => text.replaceAll("SECRET", "***"),
    },
  );
  assert.equal(entry.stdout.includes("SECRET"), false);
  assert.equal(entry.findings[0]?.message, "token *** leaked");
});

test("nonzero exit is an error entry with stderr captured", async () => {
  const entry = await runEvidenceProvider(
    { id: "p10", command: ["bash", "-c", "echo boom >&2; exit 4"] },
    { ambientEnv: ambientBase },
  );
  assert.equal(entry.status, "error");
  assert.equal(entry.exit_code, 4);
  assert.equal(entry.stderr, "boom\n");
});

test("per-provider timeout/max_output overrides parse from config shapes", async () => {
  const spec: ProviderSpec = { id: "p11", command: "true", timeout_sec: "7", max_output_bytes: "1000" };
  // String config values coerce like v2's int() handling; the probe here is
  // that malformed values fall back instead of throwing.
  const entry = await runEvidenceProvider(
    { ...spec, timeout_sec: "not-a-number", max_output_bytes: "also-bad" },
    { ambientEnv: ambientBase, timeoutSec: 5, maxOutputBytes: 4096 },
  );
  assert.equal(entry.status, "ok");
});

test("provider launch fail-closes when pgrep is unavailable (no silent group-only cleanup)", async () => {
  // Child probe with a PATH that has no pgrep: the evidence path reaches
  // runProcess directly (no gate preflight ahead of it), so the shared
  // boundary in runProcess must refuse the launch.
  const dir = mkdtempSync(join(tmpdir(), "v3-ev-nopgrep-"));
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "probe.cjs");
  const buildDir = join(process.cwd(), ".test-build", "src", "evidence");
  writeFileSync(
    scriptPath,
    `
    const path = require('path');
    const { runEvidenceProvider } = require(path.join(${JSON.stringify(buildDir)}, 'providers.js'));
    runEvidenceProvider(
      { id: 'probe', command: ['printf', 'should-never-run'] },
      { ambientEnv: { PATH: ${JSON.stringify(dir)}, HOME: '' } },
    ).then((entry) => {
      process.stdout.write(JSON.stringify(entry), () => process.exit(0));
    });
  `,
  );
  const handle = runProcess({
    file: execPath,
    args: [scriptPath],
    env: { PATH: dir, HOME: ambientBase.HOME ?? "" },
    timeoutMs: 20_000,
  });
  const probeResult = await handle.result;
  assert.equal(probeResult.status, "exited");
  const entry = JSON.parse(probeResult.stdout.toString("utf8")) as {
    status: string;
    stderr: string;
    stdout: string;
    exit_code: number | null;
  };
  assert.equal(entry.status, "error", "launch must be refused, not degraded to group-only cleanup");
  assert.match(entry.stderr, /pgrep is required/);
  assert.equal(entry.stdout, "", "the provider workload must never run");
  assert.equal(entry.exit_code, null);
});

function readPidFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
