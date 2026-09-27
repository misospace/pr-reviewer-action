/** Fixture CLI for the evidence-providers and sarif parity boundaries
 * (#706 PR 5a): `node dist/index.js evidence-providers-fixture <fixture>`.
 * Materializes the fixture workspace exactly like
 * tests/parity_runners/v2_evidence_providers.py, runs the full v3 phase
 * (fork gate → providers → SARIF → artifacts, with the failure fallback)
 * under a frozen clock, and prints `{ok, values}` with the artifact bytes. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runEvidenceProvidersPhase } from "./orchestrate.js";
import { decodeUtf8Strict, pyJsonDumps, pyJsonLoads } from "./pyjson.js";
import { normalizeSarif } from "./sarif.js";

interface EvidenceFixture {
  files?: Record<string, string>;
  files_b64?: Record<string, string>;
  config?: unknown;
  generate?: Array<{ path: string; bytes: number; fill?: string; prefix?: string }>;
  env?: Record<string, string>;
  fork?: { is_fork_pr?: string; enable_for_forks?: string };
  normalize?: string[];
}

function write(workspace: string, rel: string, data: Buffer): void {
  const target = join(workspace, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

function materialize(fixture: EvidenceFixture, workspace: string): void {
  for (const [rel, text] of Object.entries(fixture.files ?? {})) write(workspace, rel, Buffer.from(text, "utf8"));
  for (const [rel, blob] of Object.entries(fixture.files_b64 ?? {})) write(workspace, rel, Buffer.from(blob, "base64"));
  if ("config" in fixture) write(workspace, "providers.json", Buffer.from(`${pyJsonDumps(pyJsonLoads(JSON.stringify(fixture.config)))}\n`, "utf8"));
  for (const spec of fixture.generate ?? []) {
    const prefix = Buffer.from(spec.prefix ?? "", "utf8");
    const fill = Buffer.from(spec.fill ?? " ", "utf8");
    const body = Buffer.concat([prefix, Buffer.alloc(Math.max(spec.bytes - prefix.length, 0), fill)]);
    write(workspace, spec.path, body.subarray(0, spec.bytes));
  }
}

export async function runEvidenceProvidersFixture(fixturePath: string): Promise<{ ok: boolean; values?: Record<string, string>; stderr?: string }> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as EvidenceFixture;
  const workspace = mkdtempSync(join(tmpdir(), "v3-evidence-"));
  try {
    materialize(fixture, workspace);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: workspace,
      GITHUB_WORKSPACE: workspace,
      ...(fixture.env ?? {}),
    };
    await runEvidenceProvidersPhase({
      env,
      cwd: workspace,
      clock: () => 1_000_000,
      log: () => undefined,
      isForkPr: fixture.fork?.is_fork_pr ?? "false",
      enableForForks: fixture.fork?.enable_for_forks ?? "false",
    });
    const values: Record<string, string> = {
      json: readFileSync(join(workspace, "evidence-providers.json"), "utf8"),
      markdown: readFileSync(join(workspace, "evidence-providers.md"), "utf8"),
    };
    if (fixture.normalize && fixture.normalize.length > 0) {
      const artifacts = fixture.normalize.map((rel) => normalizeSarif(pyJsonLoads(decodeUtf8Strict(readFileSync(join(workspace, rel)), true))));
      values.normalized = pyJsonDumps(artifacts);
    }
    return { ok: true, values };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
