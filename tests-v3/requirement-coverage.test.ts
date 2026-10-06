import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRequirementCoverageFixture } from "../src/enforcement/fixture.js";

function runFixture(cases: Array<{ name: string; coverage: unknown; ledger: unknown }>): Record<string, Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "requirement-coverage-"));
  try {
    const path = join(dir, "coverage.json");
    writeFileSync(path, JSON.stringify({ contract: "requirement-coverage/v1", cases }));
    const result = runRequirementCoverageFixture(path);
    assert.equal(result.ok, true, result.stderr);
    return Object.fromEntries(
      Object.entries(result.values ?? {}).map(([name, value]) => [name, JSON.parse(value) as Record<string, unknown>]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("requirement coverage fixture degrades unavailable and malformed ledgers visibly", () => {
  const requestId = "req-111122223333";
  const artifacts = runFixture([
    { name: "unavailable", ledger: null, coverage: [] },
    {
      name: "malformed",
      ledger: { requirements: "not-a-list" },
      coverage: [{ requirement_id: requestId, status: "satisfied", evidence: [{ kind: "test", ref: "tests/a.test.ts", detail: "passed" }] }],
    },
  ]);

  assert.deepEqual((artifacts.unavailable!.errors as string[]), ["ledger-unavailable"]);
  assert.deepEqual((artifacts.malformed!.coverage as Array<{ credited: boolean }>), []);
  assert.deepEqual((artifacts.malformed!.errors as string[]), ["ledger-unavailable", `dropped-coverage-${requestId}`]);
});

test("malformed claims and unusable evidence do not throw or receive credit", () => {
  const requestId = "req-a1b2c3d4e5f6";
  const [artifact] = Object.values(runFixture([{
    name: "malformed-claims",
    ledger: { requirements: [
      { id: requestId, text: "The requirement", kind: "normative", verification_required: false },
      { id: "req-abcdef123456", text: "Another requirement", kind: "normative", verification_required: false },
    ] },
    coverage: [
      { requirement_id: 3, status: "satisfied", evidence: [] },
      {
        requirement_id: requestId,
        status: "satisfied",
        evidence: [
          { kind: "test", ref: 42, detail: null },
          { kind: "not-an-evidence-kind", ref: "src/a.ts", detail: "looks relevant" },
        ],
      },
      { requirement_id: "req-abcdef123456", status: "done", evidence: [] },
    ],
  }])) as Record<string, unknown>[];

  assert.ok(artifact);
  assert.deepEqual(artifact.errors, ["dropped-coverage-3"]);
  const row = (artifact.coverage as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.status, "unknown");
  assert.equal(row.credited, false);
  assert.deepEqual(row.evidence, [{ kind: "test", ref: "", detail: "" }]);
  assert.ok((row.notes as string[]).includes("dropped-evidence-invalid-kind"));
  assert.ok((row.notes as string[]).includes("downgraded-no-concrete-evidence"));
});

test("not_applicable claims are downgraded to uncredited unknown without scope proof", () => {
  const requestId = "req-112233445566";
  const [artifact] = Object.values(runFixture([{
    name: "not-applicable",
    ledger: { requirements: [{ id: requestId, text: "Applies to changed files", verification_required: false }] },
    coverage: [{ requirement_id: requestId, status: "not_applicable", evidence: [{ kind: "diff", ref: "src/a.ts", detail: "outside the change" }] }],
  }])) as Record<string, unknown>[];

  assert.ok(artifact);
  const row = (artifact.coverage as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.status, "unknown");
  assert.equal(row.credited, false);
  assert.ok((row.notes as string[]).includes("downgraded-na-without-deterministic-scope-proof"));
});

test("coverage and evidence caps are visible in the serialized artifact", () => {
  const requirements = Array.from({ length: 66 }, (_, index) => ({
    id: `req-${index.toString(16).padStart(12, "0")}`,
    text: `Requirement ${index}`,
    verification_required: false,
  }));
  const [artifact] = Object.values(runFixture([{
    name: "coverage-cap",
    ledger: { requirements },
    coverage: [{
      requirement_id: requirements[0]!.id,
      status: "satisfied",
      evidence: Array.from({ length: 10 }, (_, index) => ({ kind: "test", ref: `tests/${index}`, detail: "proof" })),
    }],
  }])) as Record<string, unknown>[];

  assert.ok(artifact);
  const rows = artifact.coverage as Array<Record<string, unknown>>;
  assert.equal(rows.length, 64);
  assert.equal((artifact.summary as Record<string, number>).total, 64);
  assert.deepEqual(artifact.errors, ["coverage-truncated-2"]);
  assert.equal((rows[0]!.evidence as unknown[]).length, 8);
  assert.ok((rows[0]!.notes as string[]).includes("evidence-truncated"));
});
