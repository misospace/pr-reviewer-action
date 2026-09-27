import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAILURE_FALLBACK_JSON,
  FAILURE_FALLBACK_MARKDOWN,
  FORK_SKIP_JSON,
  FORK_SKIP_MARKDOWN,
  PyFloat,
  evidenceForkGateApplies,
  headTailCap,
  runEvidenceProvidersPhase,
  type EvidenceProviderEntry,
} from "../src/evidence/index.js";

function workspace(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "v3-evidence-orch-"));
  if (config !== undefined) writeFileSync(join(dir, "providers.json"), JSON.stringify(config));
  return dir;
}

function artifacts(dir: string): { json: string; md: string } {
  return {
    json: readFileSync(join(dir, "evidence-providers.json"), "utf8"),
    md: readFileSync(join(dir, "evidence-providers.md"), "utf8"),
  };
}

const baseEnv = (dir: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", HOME: dir, EVIDENCE_PROVIDERS_FILE: "providers.json" });

function stubEntry(id: string, overrides: Partial<EvidenceProviderEntry> = {}): EvidenceProviderEntry {
  return {
    id, status: "ok", command: id, duration_sec: new PyFloat(0), exit_code: 0, provider_severity: "info", findings: [],
    stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false, output_format: "text", ...overrides,
  };
}

test("fork gate: exact 'true' fork flag, case-insensitive override", () => {
  assert.equal(evidenceForkGateApplies("true", "false"), true);
  assert.equal(evidenceForkGateApplies("true", ""), true);
  assert.equal(evidenceForkGateApplies("true", "TRUE"), false);
  assert.equal(evidenceForkGateApplies("True", "false"), false, "the precheck emits lowercase; anything else is not a fork signal here");
  assert.equal(evidenceForkGateApplies(false, false), false);
});

test("fork-gated phase writes the skip artifacts and runs nothing", async () => {
  const dir = workspace({ providers: [{ id: "x", command: ["printf", "no"] }] });
  let ran = 0;
  const outcome = await runEvidenceProvidersPhase({
    env: baseEnv(dir), cwd: dir, isForkPr: "true", enableForForks: "false",
    runProvider: async () => { ran += 1; return stubEntry("x"); },
  });
  assert.equal(outcome, "skipped");
  assert.equal(ran, 0);
  assert.deepEqual(artifacts(dir), { json: FORK_SKIP_JSON, md: FORK_SKIP_MARKDOWN });
});

test("an uncaught provider failure yields the harvest fallback artifacts", async () => {
  const dir = workspace({ providers: [{ id: "a", command: ["definitely-not-a-real-binary-706"] }] });
  const lines: string[] = [];
  const outcome = await runEvidenceProvidersPhase({ env: baseEnv(dir), cwd: dir, isForkPr: "false", enableForForks: "false", log: (line) => lines.push(line) });
  assert.equal(outcome, "failed");
  assert.deepEqual(artifacts(dir), { json: FAILURE_FALLBACK_JSON, md: FAILURE_FALLBACK_MARKDOWN });
  assert.match(lines.join("\n"), /Evidence provider execution failed/);
});

test("a lone surrogate in a finding cannot be written: v2's UnicodeEncodeError path → fallback", async () => {
  const dir = workspace({ providers: [{ id: "s", command: ["printf", "%s", '{"message": "\\ud800"}'] }] });
  const outcome = await runEvidenceProvidersPhase({ env: baseEnv(dir), cwd: dir, isForkPr: "false", enableForForks: "false", log: () => undefined });
  assert.equal(outcome, "failed");
  assert.equal(artifacts(dir).md, FAILURE_FALLBACK_MARKDOWN);
});

test("not configured writes an empty markdown file (corpus [ -s ] gate)", async () => {
  const dir = workspace();
  const outcome = await runEvidenceProvidersPhase({ env: { PATH: process.env.PATH ?? "" }, cwd: dir, isForkPr: "false", enableForForks: "false" });
  assert.equal(outcome, "ran");
  const { json, md } = artifacts(dir);
  assert.equal(md, "");
  assert.equal(json, '{\n  "configured": false,\n  "config_path": "",\n  "sarif_files": [],\n  "has_blocker": false,\n  "providers": []\n}\n');
});

test("the pool is bounded by EVIDENCE_PROVIDER_PARALLELISM and keeps config order", async () => {
  const providers = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, command: ["x"], delay: 60 - i * 8 }));
  const dir = workspace({ providers });
  let active = 0;
  let peak = 0;
  const finished: string[] = [];
  await runEvidenceProvidersPhase({
    env: { ...baseEnv(dir), EVIDENCE_PROVIDER_PARALLELISM: "3" }, cwd: dir, isForkPr: "false", enableForForks: "false",
    runProvider: async (provider, options) => {
      const spec = provider as { id: string; delay: number };
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { setTimeout(resolve, spec.delay); });
      active -= 1;
      finished.push(spec.id);
      assert.equal(options.index, Number(spec.id.slice(1)) + 1);
      return stubEntry(spec.id);
    },
  });
  assert.equal(peak, 3);
  assert.notDeepEqual(finished, providers.map((p) => p.id), "completion order differs from config order");
  const summary = JSON.parse(artifacts(dir).json) as { providers: Array<{ id: string }> };
  assert.deepEqual(summary.providers.map((p) => p.id), providers.map((p) => p.id));
});

test("markdown is redacted once more after rendering (adversarial: secrets in ids and commands)", async () => {
  const dir = workspace({ providers: [{ id: "token=abcdefgh12345678", command: ["printf", "api_key=zzzzzzzzzzzz"] }] });
  await runEvidenceProvidersPhase({
    env: baseEnv(dir), cwd: dir, isForkPr: "false", enableForForks: "false",
    runProvider: async (provider) => stubEntry((provider as { id: string }).id, { command: "printf api_key=zzzzzzzzzzzz", stderr: "Bearer abcdefghijklmnopqrstuvwxyz" }),
  });
  const { md } = artifacts(dir);
  assert.equal(md.includes("abcdefgh12345678"), false);
  assert.equal(md.includes("zzzzzzzzzzzz"), false);
  assert.equal(md.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(md, /\[REDACTED\]/);
});

test("headTailCap keeps 60% head + tail and never splits a UTF-8 sequence", () => {
  assert.equal(headTailCap("short", 100), "short");
  const text = "é".repeat(50) + "TAIL";
  const capped = headTailCap(text, 21);
  assert.equal(capped, `${"é".repeat(6)}\n…[middle truncated]…\n${"é".repeat(2)}TAIL`);
  assert.equal(capped.includes("�"), false);
});
