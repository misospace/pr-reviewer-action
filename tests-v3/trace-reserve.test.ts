import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeTraceEvidenceReservation,
  runToolHarness,
  traceAdmissionRows,
  type HarnessDeps,
  type HarnessResult,
} from "../src/tools/harness.js";
import {
  TRACE_EVIDENCE_TOOLS,
  TRACE_PLAN_ARTIFACT,
  TRACE_PLAN_CANDIDATES_ARTIFACT,
  TRACE_PLAN_VERSION,
} from "../src/requirements/trace-plan.js";

/**
 * #1506 (part 3): the requirement-trace budget reservation.
 *
 * The merge-gating requirement evidence must not starve behind optional
 * broad claim-falsification / adversarial exploration: the in-scope
 * code-verifiable rows hold a bounded tail of the request budget, the tail is
 * enforced only for repository read/search calls that plausibly discharge an
 * unresolved row, and it is released as soon as the rows are discharged.
 */

interface Workspace {
  root: string;
  deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps;
}

function workspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trace-reserve-test-"));
  const env: Record<string, string> = {
    REPO: "o/r",
    AI_BASE_URL: "http://model.test/v1",
    AI_MODEL: "m1",
    AI_API_KEY: "k",
    AI_STREAM: "false",
    SYSTEM_PROMPT: "You are the reviewer.",
  };
  const base: HarnessDeps = {
    env,
    cwd: root,
    readText: (name) => {
      try {
        return fs.readFileSync(path.join(root, name), "utf8");
      } catch {
        return null;
      }
    },
    exists: (name) => fs.existsSync(path.join(root, name)),
    writeArtifact: (name, text) => {
      fs.writeFileSync(path.join(root, name), text);
    },
    deleteArtifact: (name) => fs.rmSync(path.join(root, name), { force: true }),
    transport: async () => {
      throw new Error("no scripted transport");
    },
    timeFn: () => 0,
  };
  return {
    root,
    deps: (overrides: Partial<HarnessDeps> = {}) => ({
      ...base,
      ...overrides,
      env: { ...env, ...(overrides.env ?? {}) },
    }),
  };
}

const openAiText = (content: string) => ({ choices: [{ message: { content } }] });
const openAiCall = (id: string, name: string, args: string) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const validVerdict = (verdict = "approve") => openAiText(
  JSON.stringify({ verdict, review_markdown: "## Review\nLooks fine.", findings: [] }),
);

interface RequirementRow {
  id: string;
  text: string;
  path: string;
}

/**
 * The in-scope requirement rows. Every row is a structural-state requirement
 * that names a distinct repository file (a config path with one quoted
 * literal — the shape `structuralStateClaim` accepts), and every row carries
 * a distinct vocabulary, so one evidence read discharges exactly one row and
 * an unrelated read discharges none. Runtime-behaviour and distributed rows
 * owe MORE than one read — #1519 covers those below.
 */
const REQUIREMENTS: readonly RequirementRow[] = [
  { id: "req-000000000001", text: "The `config/lease-renewal.yaml` file must contain `tenant-entitlement-guard`.", path: "config/lease-renewal.yaml" },
  { id: "req-000000000002", text: "The `config/audit-trail.yaml` file must contain `tamper-evident-digest`.", path: "config/audit-trail.yaml" },
  { id: "req-000000000003", text: "The `config/billing-invoice.yaml` file must contain `ledger-balance`.", path: "config/billing-invoice.yaml" },
  { id: "req-000000000004", text: "The `config/cache-eviction.yaml` file must contain `pinned-entry`.", path: "config/cache-eviction.yaml" },
  { id: "req-000000000005", text: "The `config/auth-token.yaml` file must contain `signing-key-rotation`.", path: "config/auth-token.yaml" },
  { id: "req-000000000006", text: "The `config/queue-redelivery.yaml` file must contain `delivery-ordering`.", path: "config/queue-redelivery.yaml" },
  { id: "req-000000000007", text: "The `config/search-index.yaml` file must contain `analyzer-version`.", path: "config/search-index.yaml" },
  { id: "req-000000000008", text: "The `config/export-csv.yaml` file must contain `embedded-separator`.", path: "config/export-csv.yaml" },
  { id: "req-000000000009", text: "The `config/import-json.yaml` file must contain `duplicate-key`.", path: "config/import-json.yaml" },
  { id: "req-000000000010", text: "The `config/notify-email.yaml` file must contain `opt-out-flag`.", path: "config/notify-email.yaml" },
];

function writePlan(root: string, rows: readonly RequirementRow[]): void {
  fs.writeFileSync(path.join(root, TRACE_PLAN_ARTIFACT), JSON.stringify({
    version: TRACE_PLAN_VERSION,
    rows: rows.map((row) => ({
      id: row.id,
      text: row.text,
      kind: "acceptance",
      seams: [],
      code_verifiable: true,
      proof_shape: "structural",
      required_attempts: 1,
    })),
  }) + "\n");
}

function writeWorkspaceFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeCorpus(root: string): void {
  writeWorkspaceFile(root, "review-corpus.truncated.md", "# PR Diff\n+ change\n");
}

function writeRequirementFiles(root: string, rows: readonly RequirementRow[]): void {
  for (const row of rows) {
    writeWorkspaceFile(root, row.path, `// ${row.id}\nexport const value = 1;\n`);
  }
}

interface HarnessRun {
  result: HarnessResult;
  logs: string[];
  calls: Array<{ tool: string; status: string }>;
  budget: Record<string, unknown>;
  payloads: unknown[];
}

async function runHarness(
  root: string,
  deps: (overrides?: Partial<HarnessDeps>) => HarnessDeps,
  options: {
    env?: Record<string, string>;
    turns: number;
    call: (turn: number) => { name: string; args: Record<string, unknown> };
  },
): Promise<HarnessRun> {
  const logs: string[] = [];
  const payloads: unknown[] = [];
  let turn = 0;
  const { result } = await runToolHarness(deps({
    env: options.env ?? {},
    log: (line: string) => logs.push(line),
    transport: async (...args: unknown[]) => {
      const payload = args[2];
      payloads.push(payload);
      turn += 1;
      if (turn > options.turns) return validVerdict();
      const call = options.call(turn);
      return openAiCall(`c${turn}`, call.name, JSON.stringify(call.args));
    },
  }));
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "tool-harness.json"), "utf8")) as Record<string, unknown>;
  const telemetry = (artifact.tool_loop_telemetry ?? {}) as { budget?: Record<string, unknown> };
  return {
    result,
    logs,
    payloads,
    calls: (artifact.tool_calls ?? []) as Array<{ tool: string; status: string }>,
    budget: telemetry.budget ?? {},
  };
}

test("#1506: the trace reserve is sized by the rows' total admitted-read demand and bounded by the budget", () => {
  // The argument is the TOTAL demand (#1519): a runtime row owes two reads
  // and a distributed row two per seam, so the caller sums requiredAttempts
  // over the rows — the bound is still half the request budget.
  assert.equal(computeTraceEvidenceReservation(3, 24), 3);
  assert.equal(computeTraceEvidenceReservation(0, 24), 0);
  assert.equal(computeTraceEvidenceReservation(30, 24), 12);
  assert.equal(computeTraceEvidenceReservation(30, 1), 0);
  assert.equal(computeTraceEvidenceReservation(-4, 24), 0);
  assert.equal(computeTraceEvidenceReservation(3, 0), 0);
});

test("#1506: three code-verifiable rows reserve three requests and the ordinary ceiling is unchanged", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  writePlan(root, REQUIREMENTS.slice(0, 3));
  writeRequirementFiles(root, REQUIREMENTS.slice(0, 3));
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "24" },
    turns: 1,
    call: () => ({ name: "read_file", args: { path: REQUIREMENTS[0]!.path } }),
  });
  assert.equal(run.budget.required_evidence_requests_hint, 3);
  assert.equal(run.result.tool_request_budget, 24);
  assert.ok(run.logs.some((line) => line.includes("requirement-trace reserve: 3 tool request(s), 3 requirement(s)")));
});

test("#1506: a large claims-to-falsify workload cannot consume the trace reservation", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  fs.writeFileSync(
    path.join(root, "claim-falsification.md"),
    "# Claims to Falsify\n\n" + Array.from({ length: 12 }, (_, index) => `- The change claims behaviour ${index + 1}.`).join("\n") + "\n",
  );
  const rows = REQUIREMENTS.slice(0, 3);
  writePlan(root, rows);
  writeRequirementFiles(root, rows);
  for (let index = 1; index <= 9; index += 1) {
    writeWorkspaceFile(root, `docs/claims-${index}.md`, `claim ${index}\n`);
  }
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "8" },
    turns: 8,
    call: (turn) => ({ name: "read_file", args: { path: `docs/claims-${turn}.md` } }),
  });
  // Three rows hold three requests of the eight-request budget.
  assert.equal(run.budget.required_evidence_requests_hint, 3);
  // The claims workload spent everything BUT the reserved tail.
  assert.equal(run.result.executed_request_count, 5);
  assert.equal(run.result.tool_request_budget, 8);
  // The reserved tail was enforced: the calls that targeted no unresolved
  // row were refused, and the window never released.
  assert.ok((run.budget.required_evidence_refusals as number) > 0);
  assert.equal(run.budget.required_evidence_released, false);
  assert.deepEqual(run.budget.required_evidence_credits, []);
});

test("#1506: a call that discharges the requirement evidence credits the row and releases the window", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const rows = REQUIREMENTS.slice(0, 1);
  writePlan(root, rows);
  writeRequirementFiles(root, rows);
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "8" },
    turns: 2,
    call: (turn) => ({
      name: "read_file",
      args: { path: turn === 1 ? rows[0]!.path : "docs/claims-1.md" },
    }),
  });
  assert.deepEqual(run.budget.required_evidence_credits, [`trace:${rows[0]!.id}`]);
  assert.equal(run.budget.required_evidence_released, true);
  assert.equal(run.budget.required_evidence_refusals, 0);
});

test("#1506/#1627: once the trace row is discharged the loop stops settled — the remaining budget is not explored", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const rows = REQUIREMENTS.slice(0, 1);
  writePlan(root, rows);
  writeRequirementFiles(root, rows);
  writeWorkspaceFile(root, "docs/claims-1.md", "claim 1\n");
  writeWorkspaceFile(root, "docs/claims-2.md", "claim 2\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "8" },
    turns: 3,
    call: (turn) => ({
      name: "read_file",
      args: { path: turn === 1 ? rows[0]!.path : `docs/claims-${turn - 1}.md` },
    }),
  });
  // #1627: the discharging read settles the obligation surface, so the loop
  // ends there — the rounds the released window used to leave open for
  // optional exploration are not spent anymore.
  assert.deepEqual(run.calls.map((call) => call.tool), ["read_file"]);
  assert.equal(run.result.executed_request_count, 1);
  assert.equal(run.result.stop_reason, "obligations-settled");
  assert.equal(run.budget.required_evidence_refusals, 0);
  assert.equal(run.budget.required_evidence_released, true);
  assert.equal(run.budget.required_evidence_settled_stop, true);
});

test("#1519 (review): a runtime row discharges only on its evidence CATEGORIES — enforcement read, then a TEST read", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  // A runtime-behaviour requirement (a vetoed behavioural verb, no
  // structural parse): the validator demands an enforcement location AND a
  // matching regression test, so the discharge must distinguish the
  // categories — two arbitrary matching reads must never suffice.
  const row = {
    id: "req-000000000001",
    text: "The loader must verify the tenant entitlement recorded in `config/lease-renewal.yaml`.",
    path: "config/lease-renewal.yaml",
  };
  fs.writeFileSync(path.join(root, TRACE_PLAN_ARTIFACT), JSON.stringify({
    version: TRACE_PLAN_VERSION,
    rows: [{ id: row.id, text: row.text, kind: "acceptance", seams: [], code_verifiable: true, proof_shape: "runtime", required_attempts: 2 }],
  }) + "\n");
  writeRequirementFiles(root, [row]);
  writeWorkspaceFile(root, "docs/lease-renewal-notes.md", "notes\n");
  writeWorkspaceFile(root, "tests/lease-renewal.test.ts", "test;\n");
  const run = await runHarness(root, deps, {
    // Budget 2 → the trace reserve is min(2, floor(2/2)) = 1: the window is
    // already open for the second call, so the refusal is observable.
    env: { TOOL_MAX_REQUESTS: "2" },
    turns: 3,
    call: (turn) => {
      if (turn === 1) return { name: "read_file", args: { path: row.path } };
      if (turn === 2) return { name: "read_file", args: { path: "docs/lease-renewal-notes.md" } };
      return { name: "read_file", args: { path: "tests/lease-renewal.test.ts" } };
    },
  });
  // The first read covered the ENFORCEMENT slot only: the row stayed active
  // (the enforcement read alone never discharged it — that is the review
  // finding). The second read names the requirement's vocabulary too, but it
  // is NOT a test read and the enforcement slot is already met, so it cannot
  // advance an unmet slot: it was REFUSED in-window without spending budget.
  assert.equal(run.budget.required_evidence_refusals, 1);
  // The refusal proves the row was still active AND names the unmet slot:
  // one test read owed, not a generic read count.
  assert.match(JSON.stringify(run.payloads), new RegExp(row.id));
  assert.match(JSON.stringify(run.payloads), /1 test read owed/);
  // The row discharged only when the model read a TEST path — the missing
  // category.
  assert.deepEqual(run.calls.map((call) => call.tool), ["read_file", "read_file"]);
  assert.deepEqual(run.budget.required_evidence_credits, [`trace:${row.id}`]);
  assert.equal(run.budget.required_evidence_released, true);
  // The refused docs read spent nothing: the enforcement read and the test
  // read are all the budget saw.
  assert.equal(run.result.executed_request_count, 2);
});

test("#1519 (review): a distributed row tracks enforcement AND test coverage per seam", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const structuralRow = REQUIREMENTS[0]!;
  const distributedRow = {
    id: "req-000000000002",
    text: "The `secrets/audit-trail.toml` digest must verify the tamper-evident seal.",
    path: "secrets/audit-trail.toml",
  };
  fs.writeFileSync(path.join(root, TRACE_PLAN_ARTIFACT), JSON.stringify({
    version: TRACE_PLAN_VERSION,
    rows: [
      { id: structuralRow.id, text: structuralRow.text, kind: "acceptance", seams: [], code_verifiable: true, proof_shape: "structural", required_attempts: 1 },
      {
        id: distributedRow.id,
        text: distributedRow.text,
        kind: "acceptance",
        // #1519 (review): the plan rows carry seam objects with the trusted
        // owner/test glob patterns, not name-only strings.
        seams: [
          { name: "control-plane", owners: ["src/control/*"], tests: ["tests/control/*"] },
          { name: "worker", owners: ["src/worker/*"], tests: ["tests/worker/*"] },
        ],
        code_verifiable: true,
        proof_shape: "distributed",
        required_attempts: 4,
      },
    ],
  }) + "\n");
  writeRequirementFiles(root, [structuralRow, distributedRow]);
  writeWorkspaceFile(root, "docs/claims-1.md", "claim 1\n");
  writeWorkspaceFile(root, "src/control/plane.ts", "export {};\n");
  writeWorkspaceFile(root, "src/worker/worker.ts", "export {};\n");
  writeWorkspaceFile(root, "tests/control/control.test.ts", "test;\n");
  writeWorkspaceFile(root, "tests/worker/worker.test.ts", "test;\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "8" },
    turns: 6,
    call: (turn) => {
      if (turn === 1) return { name: "read_file", args: { path: structuralRow.path } };
      // Seam control-plane: enforcement, then the worker seam's test read.
      if (turn === 2) return { name: "read_file", args: { path: "src/control/plane.ts" } };
      if (turn === 3) return { name: "read_file", args: { path: "tests/worker/worker.test.ts" } };
      if (turn === 4) return { name: "read_file", args: { path: "tests/control/control.test.ts" } };
      // A read that matches NO unmet slot of the distributed row (no
      // vocabulary, non-test): refused in-window, never a discharge.
      if (turn === 5) return { name: "read_file", args: { path: "docs/claims-1.md" } };
      return { name: "read_file", args: { path: "src/worker/worker.ts" } };
    },
  });
  // #1519: the reserve is sized by the rows' TOTAL admitted-read demand
  // (1 structural + 4 distributed = 5), not one request per row — the
  // window must not open while a row still owes slots it could no longer
  // spend; here the half-budget cap (floor(8/2)) bounds it to 4.
  assert.equal(run.budget.required_evidence_requests_hint, 4);
  // The claims read was refused: three seam slots were met, the worker
  // enforcement slot was not, and the claims read matches none of them.
  assert.equal(run.budget.required_evidence_refusals, 1);
  assert.deepEqual(run.budget.required_evidence_credits, [`trace:${structuralRow.id}`, `trace:${distributedRow.id}`]);
  assert.equal(run.budget.required_evidence_released, true);
  // Five reads executed: the refused claims read spent nothing.
  assert.equal(run.result.executed_request_count, 5);
});

test("#1519 (review): a seam with no declared test patterns discharges its test slot via a seam-name test read", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const distributedRow = {
    id: "req-000000000001",
    text: "The renewal pipeline must gate every tenant handoff.",
    path: "src/renewal/pipeline.ts",
  };
  fs.writeFileSync(path.join(root, TRACE_PLAN_ARTIFACT), JSON.stringify({
    version: TRACE_PLAN_VERSION,
    rows: [{
      id: distributedRow.id,
      text: distributedRow.text,
      kind: "acceptance",
      // The `alpha` seam declares NO test patterns: the validator itself
      // has no empty-pattern tolerance (such a seam can never validate),
      // but the loop's seam-name fallback keeps the row dischargeable so
      // the reserve can never be pinned by an uncoverable seam.
      seams: [
        { name: "alpha", owners: ["src/alpha/*"], tests: [] },
        { name: "beta", owners: ["src/beta/*"], tests: ["tests/beta/*"] },
      ],
      code_verifiable: true,
      proof_shape: "distributed",
      required_attempts: 4,
    }],
  }) + "\n");
  writeWorkspaceFile(root, "src/alpha/gate.ts", "export {};\n");
  writeWorkspaceFile(root, "src/beta/gate.ts", "export {};\n");
  writeWorkspaceFile(root, "src/renewal/pipeline.ts", "export {};\n");
  writeWorkspaceFile(root, "tests/alpha-renewal.test.ts", "test;\n");
  writeWorkspaceFile(root, "tests/beta/beta.test.ts", "test;\n");
  writeWorkspaceFile(root, "tests/other/other.test.ts", "test;\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "4" },
    turns: 5,
    call: (turn) => {
      if (turn === 1) return { name: "read_file", args: { path: "src/alpha/gate.ts" } };
      if (turn === 2) return { name: "read_file", args: { path: "src/beta/gate.ts" } };
      // A test read matching NEITHER seam (beta's patterns do not match it
      // and it does not mention any seam name): refused in-window.
      if (turn === 3) return { name: "read_file", args: { path: "tests/other/other.test.ts" } };
      // The alpha seam's test slot is discharged by a test read that mentions
      // the seam name (its tests list is empty).
      if (turn === 4) return { name: "read_file", args: { path: "tests/alpha-renewal.test.ts" } };
      return { name: "read_file", args: { path: "tests/beta/beta.test.ts" } };
    },
  });
  assert.equal(run.budget.required_evidence_refusals, 1);
  assert.deepEqual(run.budget.required_evidence_credits, [`trace:${distributedRow.id}`]);
  assert.equal(run.budget.required_evidence_released, true);
  assert.equal(run.result.executed_request_count, 4);
});

test("#1519 (review): seam with UNMATCHABLE test globs still discharges its test slot via a vocabulary test read", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const distributedRow = {
    id: "req-000000000002",
    text: "The renewal pipeline must gate every tenant handoff.",
    path: "src/renewal/pipeline.ts",
  };
  fs.writeFileSync(path.join(root, TRACE_PLAN_ARTIFACT), JSON.stringify({
    version: TRACE_PLAN_VERSION,
    rows: [{
      id: distributedRow.id,
      text: distributedRow.text,
      kind: "acceptance",
      // The `beta` seam declares test globs that match NO real file
      // (config drift: the test tree was renamed). A non-empty but
      // unmatchable tests list must never pin the reserve: the loop's
      // vocabulary fallback credits the test slot when a test read names
      // the requirement's own vocabulary, and the row discharges.
      seams: [
        { name: "alpha", owners: ["src/alpha/*"], tests: ["tests/alpha/*"] },
        { name: "beta", owners: ["src/beta/*"], tests: ["tests/renamed/*"] },
      ],
      code_verifiable: true,
      proof_shape: "distributed",
      required_attempts: 4,
    }],
  }) + "\n");
  writeWorkspaceFile(root, "src/alpha/gate.ts", "export {};\n");
  writeWorkspaceFile(root, "src/beta/gate.ts", "export {};\n");
  writeWorkspaceFile(root, "src/renewal/pipeline.ts", "export {};\n");
  writeWorkspaceFile(root, "tests/alpha/alpha.test.ts", "test;\n");
  writeWorkspaceFile(root, "tests/renewal-gate.test.ts", "test;\n");
  writeWorkspaceFile(root, "tests/other/other.test.ts", "test;\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "6" },
    turns: 5,
    call: (turn) => {
      if (turn === 1) return { name: "read_file", args: { path: "src/alpha/gate.ts" } };
      if (turn === 2) return { name: "read_file", args: { path: "src/beta/gate.ts" } };
      if (turn === 3) return { name: "read_file", args: { path: "tests/alpha/alpha.test.ts" } };
      // A test read matching NO unmet slot (beta's globs do not match it
      // and it names no requirement vocabulary): refused in-window.
      if (turn === 4) return { name: "read_file", args: { path: "tests/other/other.test.ts" } };
      // A test read that names the row's own vocabulary credits the beta
      // seam's unmet test slot through the fallback: the row discharges.
      return { name: "read_file", args: { path: "tests/renewal-gate.test.ts" } };
    },
  });
  assert.equal(run.budget.required_evidence_refusals, 1);
  assert.deepEqual(run.budget.required_evidence_credits, [`trace:${distributedRow.id}`]);
  assert.equal(run.budget.required_evidence_released, true);
  // Four reads executed; the refused unrelated test read spent nothing.
  assert.equal(run.result.executed_request_count, 4);
});
test("#1506: the trace admission is restricted to repository read/search tools", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const rows = REQUIREMENTS.slice(0, 1);
  writePlan(root, rows);
  writeRequirementFiles(root, rows);
  writeWorkspaceFile(root, "docs/notes.md", "notes\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "2" },
    turns: 3,
    call: (turn) => {
      if (turn === 1) return { name: "read_file", args: { path: "docs/notes.md" } };
      if (turn === 2) return { name: "gh_api", args: { endpoint: `repos/o/r/contents/${rows[0]!.path}` } };
      return { name: "read_file", args: { path: rows[0]!.path } };
    },
  });
  // The forge call named the requirement's target but was REFUSED: it is not
  // a repository read, so it never discharges a requirement row.
  assert.deepEqual(run.calls.map((call) => call.tool), ["read_file", "read_file"]);
  assert.ok((run.budget.required_evidence_refusals as number) > 0);
  // The repository read for the same target DID discharge the row.
  assert.deepEqual(run.budget.required_evidence_credits, [`trace:${rows[0]!.id}`]);
});

test("#1506: the requirement evidence is gathered before the claims exploration and the budget is not exhausted", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  writePlan(root, REQUIREMENTS);
  writeRequirementFiles(root, REQUIREMENTS);
  writeWorkspaceFile(root, "docs/claims-audit.md", "claim audit\n");
  fs.writeFileSync(
    path.join(root, "pr.json"),
    JSON.stringify({
      number: 7,
      title: "Guard the renewal path",
      body: [
        "## Traceability",
        "",
        "| Requirement | File |",
        "| --- | --- |",
        `| ${REQUIREMENTS[0]!.id} | \`${REQUIREMENTS[0]!.path}\` |`,
        `| ${REQUIREMENTS[1]!.id} | \`${REQUIREMENTS[1]!.path}\` |`,
        "",
      ].join("\n"),
    }) + "\n",
  );
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "24" },
    turns: 1,
    call: (turn) => ({ name: "read_file", args: { path: REQUIREMENTS[turn - 1]!.path } }),
  });
  // The verdict was reached with the requirement evidence in hand — and the
  // #1627 settled stop ended the loop the round the surface settled. (The
  // rows share the requirement files' path vocabulary, so the first
  // requirement read credits every row — the pre-#1627 loop kept exploring
  // the remaining rounds on optional claims reads anyway; those rounds are
  // exactly the spend the settled stop removes.)
  assert.equal(run.result.native_loop_verdict_produced, true);
  assert.equal(run.budget.required_evidence_requests_hint, 10);
  // Every in-scope code-verifiable row was credited — including the eight the
  // pull request never claimed.
  assert.deepEqual(run.budget.required_evidence_credits, REQUIREMENTS.map((row) => `trace:${row.id}`));
  assert.equal(run.budget.required_evidence_released, true);
  assert.equal(run.budget.required_evidence_settled_stop, true);
  assert.equal(run.budget.required_evidence_refusals, 0);
  // The evidence call came first; the loop then stopped settled instead of
  // spending the released budget on optional exploration.
  assert.deepEqual(run.calls.map((call) => call.tool), ["read_file"]);
  // The run did not have to exhaust the budget to discover the missing rows.
  assert.equal(run.result.executed_request_count, 1);
  assert.equal(run.result.tool_request_budget, 24);
  assert.notEqual(run.result.stop_reason, "tool-call-budget-exhausted");
});

test("#1506: a run without a trace plan keeps the pre-change admission set and reserve", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  writeWorkspaceFile(root, "docs/claims-1.md", "claim 1\n");
  writeWorkspaceFile(root, "docs/claims-2.md", "claim 2\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "8" },
    turns: 2,
    call: (turn) => ({ name: "read_file", args: { path: `docs/claims-${turn}.md` } }),
  });
  assert.equal(run.budget.required_evidence_requests_hint, 0);
  assert.equal(run.budget.required_evidence_required, 0);
  assert.equal(run.budget.required_evidence_released, true);
  assert.deepEqual(run.budget.required_evidence_credits, []);
  assert.equal(run.budget.required_evidence_refusals, 0);
  assert.ok(!run.logs.some((line) => line.includes("requirement-trace reserve")));
  assert.equal(run.result.executed_request_count, 2);
  // The candidates artifact the harness authored carries no trace row.
  const candidates = JSON.parse(fs.readFileSync(path.join(root, TRACE_PLAN_CANDIDATES_ARTIFACT), "utf8")) as {
    injected: boolean;
    rows: unknown[];
  };
  assert.equal(candidates.injected, false);
  assert.deepEqual(candidates.rows, []);
});

test("#1506: a plan that was never injected keeps the pre-change admission set and reserve", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const rows = REQUIREMENTS.slice(0, 3);
  writePlan(root, rows);
  writeRequirementFiles(root, rows);
  writeWorkspaceFile(root, "docs/claims-1.md", "claim 1\n");
  // A corpus budget too small for the trace section: the planner never saw
  // the plan, so nothing may be reserved for it.
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "8", TOOL_CORPUS_MAX_BYTES: "2400" },
    turns: 1,
    call: () => ({ name: "read_file", args: { path: "docs/claims-1.md" } }),
  });
  const candidates = JSON.parse(fs.readFileSync(path.join(root, TRACE_PLAN_CANDIDATES_ARTIFACT), "utf8")) as {
    injected: boolean;
    rows: unknown[];
  };
  // The plan carried rows, but the planner never saw them: a section that was
  // not injected gates nothing and reserves nothing.
  assert.equal(candidates.injected, false);
  assert.deepEqual(candidates.rows, []);
  assert.equal(run.budget.required_evidence_requests_hint, 0);
  assert.equal(run.budget.required_evidence_required, 0);
  assert.deepEqual(run.budget.required_evidence_credits, []);
  assert.ok(!run.logs.some((line) => line.includes("requirement-trace reserve")));
});

test("#1506: the reserved-window notes name the Requirement Trace Plan section and the outstanding requirements", async () => {
  const { root, deps } = workspace();
  writeCorpus(root);
  const rows = REQUIREMENTS.slice(0, 1);
  writePlan(root, rows);
  writeRequirementFiles(root, rows);
  writeWorkspaceFile(root, "docs/claims-1.md", "claim 1\n");
  writeWorkspaceFile(root, "docs/claims-2.md", "claim 2\n");
  writeWorkspaceFile(root, "docs/claims-3.md", "claim 3\n");
  const run = await runHarness(root, deps, {
    env: { TOOL_MAX_REQUESTS: "3" },
    turns: 4,
    call: (turn) => ({ name: "read_file", args: { path: `docs/claims-${turn}.md` } }),
  });
  // The FIRST request already carries the priority note, and it points at the
  // section the requirement rows actually live in.
  const first = JSON.stringify(run.payloads[0]);
  assert.match(first, /Requirement Trace Plan section/);
  // The window note names the outstanding requirement ids and the tools that
  // can discharge them.
  const window = JSON.stringify(run.payloads.slice(1)).replace(/\\n/g, " ");
  assert.match(window, /Requirement Trace Plan section/);
  assert.match(window, new RegExp(rows[0]!.id));
  assert.match(window, /read_file/);
  // The refusal told the model what the reserved tail owes and where the
  // requirement is listed.
  const refusals = JSON.stringify(run.calls) + JSON.stringify(run.payloads);
  assert.match(refusals, /Reserved requirement-evidence budget/);
});

test("#1506: the candidates artifact is parsed defensively and never partially trusted", () => {
  assert.deepEqual(traceAdmissionRows(null), []);
  assert.deepEqual(traceAdmissionRows(""), []);
  assert.deepEqual(traceAdmissionRows("not json"), []);
  assert.deepEqual(traceAdmissionRows(JSON.stringify([])), []);
  assert.deepEqual(traceAdmissionRows(JSON.stringify({ version: 2, injected: true, rows: [] })), []);
  assert.deepEqual(traceAdmissionRows(JSON.stringify({ version: TRACE_PLAN_VERSION, injected: false, rows: [] })), []);
  assert.deepEqual(traceAdmissionRows(JSON.stringify({ version: TRACE_PLAN_VERSION, injected: true, rows: "nope" })), []);
  // A non-conforming row invalidates the whole artifact — never a partial trust.
  const validRow = { id: "req-1", text: "The `src/a.ts` guard must hold.", kind: "acceptance", seams: [], code_verifiable: true, proof_shape: "runtime", required_attempts: 2 };
  assert.deepEqual(traceAdmissionRows(JSON.stringify({
    version: TRACE_PLAN_VERSION,
    injected: true,
    rows: [validRow, { id: 7 }],
  })), []);
  // A row whose evidence demand does not cohere is refused too (#1519).
  for (const broken of [
    { ...validRow, required_attempts: 1 },
    { ...validRow, required_attempts: "2" },
    { ...validRow, proof_shape: "bogus" },
    { ...validRow, code_verifiable: false },
    // #1519 (review, round 2): the parse re-derives the demand from the row
    // text, so a corrupted artifact that labels a runtime requirement as a
    // one-attempt structural row fails closed — it can never discharge on
    // one arbitrary read and release a reserve the validator would refuse.
    { ...validRow, proof_shape: "structural", required_attempts: 1 },
  ]) {
    assert.deepEqual(traceAdmissionRows(JSON.stringify({
      version: TRACE_PLAN_VERSION,
      injected: true,
      rows: [broken],
    })), []);
  }
  // A documentation-only row is not an admission row.
  assert.deepEqual(traceAdmissionRows(JSON.stringify({
    version: TRACE_PLAN_VERSION,
    injected: true,
    rows: [{ ...validRow, code_verifiable: false, proof_shape: "non-code", required_attempts: 0 }],
  })), []);
  // A row with no targetable vocabulary is no admission row either.
  assert.deepEqual(traceAdmissionRows(JSON.stringify({
    version: TRACE_PLAN_VERSION,
    injected: true,
    rows: [{ ...validRow, text: "must" }],
  })), []);
  // A structural-state row carries its one-read demand onto the admission row.
  const structural = traceAdmissionRows(JSON.stringify({
    version: TRACE_PLAN_VERSION,
    injected: true,
    rows: [{ id: "req-2", text: "The `config/settings.yaml` file must contain `metrics-enabled`.", kind: "acceptance", seams: [], code_verifiable: true, proof_shape: "structural", required_attempts: 1 }],
  }));
  assert.equal(structural.length, 1);
  assert.equal(structural[0]!.requiredAttempts, 1);
  assert.equal(structural[0]!.proofShape, "structural");
  assert.deepEqual(structural[0]!.seams, []);
  const rows = traceAdmissionRows(JSON.stringify({
    version: TRACE_PLAN_VERSION,
    injected: true,
    rows: [validRow],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "trace:req-1");
  assert.equal(rows[0]!.trace, true);
  assert.equal(rows[0]!.requiredAttempts, 2);
  // #1519 (review): the row carries the proof shape and the FULL seam
  // objects, so the loop's slot attribution matches the validator's.
  assert.equal(rows[0]!.proofShape, "runtime");
  assert.deepEqual(rows[0]!.seams, []);
  assert.deepEqual(rows[0]!.tools, TRACE_EVIDENCE_TOOLS);
  const distributed = traceAdmissionRows(JSON.stringify({
    version: TRACE_PLAN_VERSION,
    injected: true,
    rows: [{
      ...validRow,
      proof_shape: "distributed",
      required_attempts: 4,
      seams: [
        { name: "control-plane", owners: ["src/control/*"], tests: ["tests/control/*"] },
        { name: "worker", owners: ["src/worker/*"], tests: [] },
      ],
    }],
  }));
  assert.equal(distributed.length, 1);
  assert.equal(distributed[0]!.proofShape, "distributed");
  assert.equal(distributed[0]!.requiredAttempts, 4);
  assert.deepEqual(distributed[0]!.seams, [
    { name: "control-plane", owners: ["src/control/*"], tests: ["tests/control/*"] },
    { name: "worker", owners: ["src/worker/*"], tests: [] },
  ]);
  assert.ok(rows[0]!.tokens.includes("src/a.ts"));
});

test("#1506: the trace tool allow-list is a closed set of repository read/search tools", () => {
  assert.deepEqual([...TRACE_EVIDENCE_TOOLS].sort(), [
    "find_files",
    "git_blame",
    "git_grep",
    "git_log",
    "list_tree",
    "read_file",
  ]);
  for (const forbidden of ["gh_api", "web_fetch", "web_search", "run_command", "read_skill", "repo_contents"]) {
    assert.ok(!TRACE_EVIDENCE_TOOLS.includes(forbidden), forbidden);
  }
});
