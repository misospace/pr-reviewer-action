import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PyFloat, runEvidenceProvidersPhase, type EvidenceProviderEntry } from "../src/evidence/index.js";

function providerEntry(id: string): EvidenceProviderEntry {
  return {
    id,
    status: "ok",
    command: id,
    duration_sec: new PyFloat(0),
    exit_code: 0,
    provider_severity: "info",
    findings: [],
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    output_format: "text",
  };
}

test("provider cap and SARIF entries are reflected in the written evidence artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-artifact-boundaries-"));
  try {
    const configured = Array.from({ length: 26 }, (_, index) => ({ id: `provider-${index + 1}`, command: ["unused"] }));
    writeFileSync(join(dir, "providers.json"), JSON.stringify({ providers: configured }));
    writeFileSync(join(dir, "findings.sarif"), JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "fixture-scanner" } }, results: [{
        ruleId: "R1",
        level: "error",
        message: { text: "SARIF finding" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 7 } } }],
      }] }],
    }));

    const invoked: string[] = [];
    const result = await runEvidenceProvidersPhase({
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GITHUB_WORKSPACE: dir,
        EVIDENCE_PROVIDERS_FILE: "providers.json",
        SARIF_FILES: "findings.sarif",
      },
      cwd: dir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async (provider) => {
        const id = (provider as { id: string }).id;
        invoked.push(id);
        return providerEntry(id);
      },
    });

    assert.equal(result, "ran");
    assert.deepEqual(invoked, configured.slice(0, 25).map((provider) => provider.id));
    const artifact = JSON.parse(readFileSync(join(dir, "evidence-providers.json"), "utf8")) as {
      provider_count: number;
      sarif_files: string[];
      providers: Array<{ id: string; kind?: string; status: string; exit_code: number | null; source?: string; output_format?: string; findings: Array<{ message: string; source: string; file: string; line: number }> }>;
    };
    assert.equal(artifact.provider_count, 26, "25 configured providers plus the SARIF entry");
    assert.deepEqual(artifact.sarif_files, ["findings.sarif"]);
    assert.deepEqual(artifact.providers.slice(0, 25).map((provider) => provider.id), configured.slice(0, 25).map((provider) => provider.id));
    assert.equal(artifact.providers.some((provider) => provider.id === "provider-26"), false);
    const sarifEntry = artifact.providers[25]!;
    assert.equal(sarifEntry.kind, "sarif");
    assert.equal(sarifEntry.status, "ok");
    assert.equal(sarifEntry.exit_code, null);
    assert.equal(sarifEntry.source, "findings.sarif");
    assert.equal(sarifEntry.output_format, "sarif-2.1.0");
    assert.deepEqual(sarifEntry.findings, [{
      severity: "major",
      message: "SARIF finding [R1] (src/a.ts:7)",
      source: "findings.sarif (fixture-scanner)",
      tool_name: "fixture-scanner",
      tool_version: "",
      rule_id: "R1",
      title: "R1",
      file: "src/a.ts",
      line: 7,
      help_uri: "",
    }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
