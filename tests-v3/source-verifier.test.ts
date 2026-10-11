import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHeadSourceReader } from "../src/enforcement/source-verifier.js";
import { applyBlockerVerification } from "../src/enforcement/blocker-verification.js";
import type { ArtifactFinding } from "../src/enforcement/artifact.js";

function finding(overrides: Partial<ArtifactFinding> = {}): ArtifactFinding {
  return {
    severity: "blocker",
    category: "bug",
    file: "src/literal.ts",
    line: 1,
    message: "finding",
    ...overrides,
  };
}

const revision = "a".repeat(40);

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("source reader rejects missing revision and unsafe paths", async () => {
  const invalidRevision = createHeadSourceReader({ workspace: "/tmp", revision: null, execFile: () => { throw new Error("must not execute"); } });
  assert.deepEqual(await invalidRevision("src/a.ts"), { status: "unavailable", reason: "no-exact-revision" });
  const invalidPath = createHeadSourceReader({ workspace: "/tmp", revision, execFile: () => { throw new Error("must not execute"); } });
  for (const hostile of ["../etc/passwd", "/etc/passwd", "-foo", "--help", "a/../../b", "a\0b", ""]) {
    assert.deepEqual(await invalidPath(hostile), { status: "unavailable", reason: "path-invalid" }, `expected ${JSON.stringify(hostile)} to be rejected`);
  }
});

test("source reader maps execution failures to bounded reasons", async () => {
  const error = (properties: Record<string, unknown>) => Object.assign(new Error("failed"), properties);
  const reader = (failure: Error) => createHeadSourceReader({
    workspace: "/tmp", revision, execFile: () => { throw failure; },
  });
  assert.deepEqual(await reader(error({ code: "ENOENT" }))("src/a.ts"), { status: "unavailable", reason: "read-failed" });
  assert.deepEqual(await reader(error({ code: "ENOBUFS" }))("src/a.ts"), { status: "unavailable", reason: "too-large" });
  assert.deepEqual(await reader(error({ message: "output too large" }))("src/a.ts"), { status: "unavailable", reason: "too-large" });
  assert.deepEqual(await reader(error({ status: 128 }))("src/a.ts"), { status: "unavailable", reason: "not-found" });
});

test("source reader returns exact committed git content and provenance", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = 'const marker = "⟦redacted:credential⟧";\n';
    fs.writeFileSync(file, text);
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);
    const read = createHeadSourceReader({ workspace, revision: sha });

    const result = await read("src/literal.ts");
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.text, text);
      assert.equal(result.provenance.representation, "committed_source");
      assert.equal(result.provenance.revision, sha);
      assert.match(result.text, /⟦redacted:credential⟧/);
    }
    assert.deepEqual(await read("src/unknown.ts"), { status: "unavailable", reason: "not-found" });
    assert.deepEqual(await createHeadSourceReader({ workspace, revision: "bogus" })("src/literal.ts"), {
      status: "unavailable", reason: "no-exact-revision",
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// #1016 (review pass, hypothesis the reviewer raised): if the source safe-
// redactor (`redactSourceTextDetailed`) ever redacted a real committed
// `⟦redacted:credential⟧` literal, the marker would no longer match and
// the boundary would spuriously `refuted` a real finding. The current
// masker does not redact this literal (it only REDACTs credentials INTO
// this marker), so the committed-marker path stays `grounded`. This
// real-git round-trip pins the positive path so a future masker change
// cannot silently regress it.
test("source-verifier + boundary: committed marker stays grounded through the real git reader", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = 'const marker = "⟦redacted:credential⟧";\n';
    fs.writeFileSync(file, text);
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);

    const readSource = createHeadSourceReader({ workspace, revision: sha });
    const findings = [finding({ message: "value is [REDACTED]", file: "src/literal.ts" })];
    const result = await applyBlockerVerification(findings, { readSource, expectedRevision: sha });
    assert.equal(result.demoted, 0, "committed marker must stay grounded after redaction");
    assert.equal(findings[0]!.grounding_status, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
