import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function sarifFile(text: string): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "fixture-scanner" } }, results: [{ ruleId: "R1", level: "error", message: { text } }] }],
  });
}

// #1531: the phase run directory (where artifacts persist, under RUNNER_TEMP)
// and the reviewed workspace (GITHUB_WORKSPACE) are distinct on every
// production path. The documented `evidence-providers-file` value is a
// repository path, so the config must load from the workspace.
test("#1531: a relative evidence-providers-file loads from the reviewed workspace, not the phase run dir", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "evidence-rundir-"));
  const reviewed = mkdtempSync(join(tmpdir(), "evidence-reviewed-"));
  try {
    mkdirSync(join(reviewed, ".github"), { recursive: true });
    writeFileSync(join(reviewed, ".github", "pr-review-providers.json"), JSON.stringify({ providers: [{ id: "workspace-provider", command: ["unused"] }] }));
    mkdirSync(join(reviewed, "reports"), { recursive: true });
    writeFileSync(join(reviewed, "reports", "scan.sarif"), sarifFile("workspace sarif finding"));
    // The decoy sits at the same relative path under the run dir: the old
    // cwd-based resolution would have loaded (and invoked) this one instead.
    mkdirSync(join(runDir, ".github"), { recursive: true });
    writeFileSync(join(runDir, ".github", "pr-review-providers.json"), JSON.stringify({ providers: [{ id: "rundir-decoy", command: ["unused"] }] }));

    const invoked: string[] = [];
    const outcome = await runEvidenceProvidersPhase({
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_WORKSPACE: reviewed,
        EVIDENCE_PROVIDERS_FILE: ".github/pr-review-providers.json",
        SARIF_FILES: "reports/scan.sarif",
      },
      cwd: runDir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async (provider) => {
        const id = (provider as { id: string }).id;
        invoked.push(id);
        return providerEntry(id);
      },
    });

    assert.equal(outcome, "ran");
    assert.deepEqual(invoked, ["workspace-provider"], "the config loads from the workspace; the run-dir decoy never fires");
    const artifact = JSON.parse(readFileSync(join(runDir, "evidence-providers.json"), "utf8")) as {
      error?: string;
      config_path: string;
      provider_count: number;
      providers: Array<{ id: string; kind?: string; status: string; findings: Array<{ message: string }> }>;
    };
    assert.equal(artifact.error, undefined);
    assert.equal(artifact.config_path, ".github/pr-review-providers.json");
    assert.equal(artifact.provider_count, 2);
    assert.equal(artifact.providers[0]!.id, "workspace-provider");
    assert.equal(artifact.providers[1]!.kind, "sarif");
    assert.equal(artifact.providers[1]!.status, "ok", "the SARIF read is workspace-rooted while the phase runs in the run dir");
    assert.deepEqual(artifact.providers[1]!.findings.map((finding) => finding.message), ["workspace sarif finding [R1]"]);
    assert.equal(existsSync(join(reviewed, "evidence-providers.json")), false, "artifacts stay in the phase run dir, never the checkout");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(reviewed, { recursive: true, force: true });
  }
});

test("#1531: an absolute evidence-providers-file keeps its operator-path semantics", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "evidence-rundir-"));
  const reviewed = mkdtempSync(join(tmpdir(), "evidence-reviewed-"));
  const operator = mkdtempSync(join(tmpdir(), "evidence-operator-"));
  try {
    const configPath = join(operator, "pr-review-providers.json");
    writeFileSync(configPath, JSON.stringify({ providers: [{ id: "operator-provider", command: ["unused"] }] }));

    const invoked: string[] = [];
    const outcome = await runEvidenceProvidersPhase({
      env: { PATH: process.env.PATH ?? "", GITHUB_WORKSPACE: reviewed, EVIDENCE_PROVIDERS_FILE: configPath },
      cwd: runDir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async (provider) => {
        const id = (provider as { id: string }).id;
        invoked.push(id);
        return providerEntry(id);
      },
    });

    assert.equal(outcome, "ran");
    assert.deepEqual(invoked, ["operator-provider"], "the absolute path is read verbatim, outside both the run dir and the workspace");
    const artifact = JSON.parse(readFileSync(join(runDir, "evidence-providers.json"), "utf8")) as { error?: string };
    assert.equal(artifact.error, undefined);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(reviewed, { recursive: true, force: true });
    rmSync(operator, { recursive: true, force: true });
  }
});

// Review follow-up (#1533): edge-case path shapes for the workspace-rooted
// config resolution. The input is operator-only, so these pin the behavior
// rather than add a hardening rail: symlinks are followed, NUL bytes fail
// closed as "not found" without crashing the phase.
test("#1531: a symlinked config and a symlinked workspace both resolve through to the real tree", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "evidence-rundir-"));
  const realCheckout = mkdtempSync(join(tmpdir(), "evidence-checkout-"));
  const linked = mkdtempSync(join(tmpdir(), "evidence-linked-"));
  const operatorStore = mkdtempSync(join(tmpdir(), "evidence-store-"));
  try {
    // A symlinked GITHUB_WORKSPACE (safeRealpath'd by the phase) still roots
    // relative configs at the real checkout.
    const workspaceLink = join(linked, "workspace");
    symlinkSync(realCheckout, workspaceLink, "dir");
    mkdirSync(join(realCheckout, ".github"), { recursive: true });
    // The config itself is a symlink leaving the checkout, as an operator
    // bind from a mounted store would be; readFileSync follows it.
    const storeConfig = join(operatorStore, "pr-review-providers.json");
    writeFileSync(storeConfig, JSON.stringify({ providers: [{ id: "linked-provider", command: ["unused"] }] }));
    symlinkSync(storeConfig, join(realCheckout, ".github", "pr-review-providers.json"), "file");

    const invoked: string[] = [];
    const outcome = await runEvidenceProvidersPhase({
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_WORKSPACE: workspaceLink,
        EVIDENCE_PROVIDERS_FILE: ".github/pr-review-providers.json",
      },
      cwd: runDir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async (provider) => {
        invoked.push((provider as { id: string }).id);
        return providerEntry((provider as { id: string }).id);
      },
    });

    assert.equal(outcome, "ran");
    assert.deepEqual(invoked, ["linked-provider"], "symlinks are followed through the workspace-realpath'd root");
    const artifact = JSON.parse(readFileSync(join(runDir, "evidence-providers.json"), "utf8")) as { error?: string };
    assert.equal(artifact.error, undefined);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(realCheckout, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
    rmSync(operatorStore, { recursive: true, force: true });
  }
});

test("#1531: a NUL byte in evidence-providers-file fails closed as not found", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "evidence-rundir-"));
  const reviewed = mkdtempSync(join(tmpdir(), "evidence-reviewed-"));
  try {
    const invoked: string[] = [];
    const outcome = await runEvidenceProvidersPhase({
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_WORKSPACE: reviewed,
        EVIDENCE_PROVIDERS_FILE: "providers\u0000.json",
      },
      cwd: runDir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async (provider) => {
        invoked.push((provider as { id: string }).id);
        return providerEntry((provider as { id: string }).id);
      },
    });

    assert.equal(outcome, "ran", "the phase reports the missing config instead of crashing");
    assert.deepEqual(invoked, []);
    const artifact = JSON.parse(readFileSync(join(runDir, "evidence-providers.json"), "utf8")) as { error?: string };
    assert.equal(artifact.error, "Config file not found: providers\u0000.json");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(reviewed, { recursive: true, force: true });
  }
});

test("#1531: negative evidence is classified against the reviewed workspace boundary", async () => {
  // A parent dir that makes the run dir a sibling: a path that exists under
  // the run dir must still classify as missing, because the workspace is the
  // boundary the phase reports against.
  const parent = mkdtempSync(join(tmpdir(), "evidence-parent-"));
  const runDir = join(parent, "run");
  mkdirSync(runDir);
  const reviewed = mkdtempSync(join(tmpdir(), "evidence-reviewed-"));
  try {
    writeFileSync(join(runDir, "providers.json"), JSON.stringify({ providers: [{ id: "rundir-only", command: ["unused"] }] }));
    mkdirSync(join(runDir, "reports"), { recursive: true });
    writeFileSync(join(runDir, "reports", "scan.sarif"), sarifFile("run-dir sarif finding"));

    const invoked: string[] = [];
    const outcome = await runEvidenceProvidersPhase({
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_WORKSPACE: reviewed,
        EVIDENCE_PROVIDERS_FILE: "providers.json",
        SARIF_FILES: "reports/scan.sarif",
      },
      cwd: runDir,
      isForkPr: "false",
      enableForForks: "false",
      log: () => undefined,
      runProvider: async (provider) => {
        invoked.push((provider as { id: string }).id);
        return providerEntry((provider as { id: string }).id);
      },
    });

    assert.equal(outcome, "ran");
    assert.deepEqual(invoked, [], "the run-dir config is never consulted");
    const artifact = JSON.parse(readFileSync(join(runDir, "evidence-providers.json"), "utf8")) as {
      error?: string;
      providers: Array<{ kind?: string; status: string; provider_severity: string; stderr: string }>;
    };
    assert.equal(artifact.error, "Config file not found: providers.json");
    const sarifEntry = artifact.providers.find((entry) => entry.kind === "sarif");
    assert.ok(sarifEntry);
    assert.equal(sarifEntry.status, "error", "the SARIF negative anchors on the workspace, not the cwd where the file exists");
    assert.equal(sarifEntry.provider_severity, "major");
    assert.match(sarifEntry.stderr, /SARIF file not found/);
    const md = readFileSync(join(runDir, "evidence-providers.md"), "utf8");
    assert.match(md, /Evidence providers config was not found: `providers\.json`/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(reviewed, { recursive: true, force: true });
  }
});
