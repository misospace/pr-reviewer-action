import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStandardsFileAtRef,
  resolveStandardsFileAtRef,
  StandardsFileRefError,
} from "../src/context/standards-file-ref.js";
import { DEFAULT_STANDARDS_FILE_CANDIDATES } from "../src/context/standards-file.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "standards-ref-test-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: GIT_ENV });
  return root;
}

function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}

function write(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text);
}

test("readStandardsFileAtRef reads AGENTS.md content at the base ref, ignoring the working tree", () => {
  const root = initRepo();
  write(root, "AGENTS.md", "# Rules\n- no eval()\n");
  const baseSha = commit(root, "base standards");

  // Head "PR" drops the rule on its own branch.
  write(root, "AGENTS.md", "# Rules\n(rules removed)\n");
  commit(root, "head drops the rule");

  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, "AGENTS.md");
  assert.equal(Buffer.from(result.content ?? new Uint8Array(0)).toString("utf8"), "# Rules\n- no eval()\n");
});

test("a higher-priority candidate the head adds is not seen at the base ref", () => {
  const root = initRepo();
  write(root, "AGENTS.md", "# Rules\n- no eval()\n");
  const baseSha = commit(root, "base standards");

  // Head adds a higher-priority candidate file (ai-review-rules.md is only
  // in the candidate list after AGENTS.md, but this demonstrates the head's
  // addition of ANY new candidate file is simply invisible at the base ref).
  write(root, ".github/ai-review-rules.md", "# Rules\n(anything goes)\n");
  commit(root, "head adds a new rules file");

  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, "AGENTS.md");
  assert.equal(Buffer.from(result.content ?? new Uint8Array(0)).toString("utf8"), "# Rules\n- no eval()\n");
});

test("candidate order at the base ref: AGENTS.md wins over CLAUDE.md even if CLAUDE.md only exists at head", () => {
  const root = initRepo();
  write(root, "AGENTS.md", "base rules\n");
  const baseSha = commit(root, "base");
  write(root, "CLAUDE.md", "head-only rules\n");
  commit(root, "head adds CLAUDE.md");

  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, "AGENTS.md");
});

test("glob candidates resolve against the base ref tree, not the working tree", () => {
  const root = initRepo();
  write(root, "docs/AGENTS-a.md", "a-rules\n");
  const baseSha = commit(root, "base");
  write(root, "docs/AGENTS-0.md", "should not be seen (head-only, sorts first)\n");
  commit(root, "head adds an earlier-sorting match");

  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: "docs/AGENTS-*.md",
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, "docs/AGENTS-a.md");
});

test("a tracked symlink standards file is refused, exactly like the workspace-fs containment guard", () => {
  const root = initRepo();
  write(root, "secret-outside.md", "should never be read\n");
  try {
    symlinkSync(join(root, "secret-outside.md"), join(root, "AGENTS.md"));
  } catch {
    return; // symlinks unsupported on this platform/filesystem; skip.
  }
  const baseSha = commit(root, "tracked symlink");

  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, null);
  assert.equal(result.content, null);
});

test("no candidate matches at the base ref: resolved and content are both null", () => {
  const root = initRepo();
  write(root, "README.md", "nothing here\n");
  const baseSha = commit(root, "no standards");

  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, null);
  assert.equal(result.content, null);
});

test("an empty ref throws StandardsFileRefError rather than silently resolving anything", () => {
  const root = initRepo();
  write(root, "AGENTS.md", "rules\n");
  commit(root, "base");
  assert.throws(() => resolveStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: "",
    workspace: root,
  }), StandardsFileRefError);
});

test("an unresolvable ref in a real git repo yields no standards, not a thrown error (matches repository-config's permissive per-candidate treatment)", () => {
  const root = initRepo();
  write(root, "AGENTS.md", "rules\n");
  commit(root, "base");
  const result = readStandardsFileAtRef({
    standardsFile: "",
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: "not-a-real-ref",
    workspace: root,
  });
  assert.equal(result.resolved, null);
  assert.equal(result.content, null);
});

test("an operator-owned absolute standards-file outside the repository is read directly from disk", () => {
  const root = initRepo();
  write(root, "README.md", "seed\n");
  const baseSha = commit(root, "base");
  const outside = mkdtempSync(join(tmpdir(), "standards-ref-external-"));
  write(outside, "OPERATOR-STANDARDS.md", "operator rules\n");

  const result = readStandardsFileAtRef({
    standardsFile: join(outside, "OPERATOR-STANDARDS.md"),
    candidates: DEFAULT_STANDARDS_FILE_CANDIDATES,
    ref: baseSha,
    workspace: root,
  });
  assert.equal(result.resolved, join(outside, "OPERATOR-STANDARDS.md"));
  assert.equal(Buffer.from(result.content ?? new Uint8Array(0)).toString("utf8"), "operator rules\n");
});
