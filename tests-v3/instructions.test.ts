import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_INSTRUCTION_FILE_BYTES, MAX_INSTRUCTION_TOTAL_BYTES } from "../src/config/effective-config.js";
import { readInstructionFilesAtRef } from "../src/config/instructions.js";
import { RepositoryConfigError } from "../src/config/repository-config.js";

// ---------------------------------------------------------------------------
// Real temporary git repositories — the trusted-base read is a `git` seam.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function commit(root: string, message: string): string {
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { env: GIT_ENV });
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { env: GIT_ENV }).toString("utf8").trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "instructions-test-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env: GIT_ENV });
  return root;
}

function writeFile(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

test("reads listed files in listed order with exact base-side bytes", () => {
  const root = initRepo();
  writeFile(root, ".pr-reviewer/rules.md", "rule: keep secrets out\n");
  writeFile(root, "docs/standards.md", "café ☕ standard\n");
  const sha = commit(root, "instructions");

  const resolution = readInstructionFilesAtRef(["docs/standards.md", ".pr-reviewer/rules.md"], { ref: sha, workspace: root });
  assert.deepEqual([...resolution.warnings], []);
  assert.deepEqual(resolution.files.map(({ path }) => path), ["docs/standards.md", ".pr-reviewer/rules.md"]);
  assert.ok(resolution.files[0]!.content.equals(Buffer.from("café ☕ standard\n", "utf8")));
  assert.ok(resolution.files[1]!.content.equals(Buffer.from("rule: keep secrets out\n", "utf8")));
});

test("a PR-head edit or addition never affects the base-side read", () => {
  const root = initRepo();
  writeFile(root, ".pr-reviewer/rules.md", "rule: base version\n");
  const baseSha = commit(root, "base instructions");

  // The "PR" rewrites the referenced file on its own branch and adds a
  // new one; reading from the base must return the base bytes only.
  writeFile(root, ".pr-reviewer/rules.md", "rule: weakened by the PR\n");
  writeFile(root, "head-only.md", "injected by the PR\n");
  commit(root, "head weakens its own instructions");

  const resolution = readInstructionFilesAtRef([".pr-reviewer/rules.md", "head-only.md"], { ref: baseSha, workspace: root });
  assert.deepEqual(resolution.files.map(({ path }) => path), [".pr-reviewer/rules.md"]);
  assert.ok(resolution.files[0]!.content.equals(Buffer.from("rule: base version\n", "utf8")));
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, /head-only\.md.*not found at the base ref/);
});

test("a missing file is a per-file fail-conservative skip, never a head-side fallback", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  const sha = commit(root, "seed");
  const resolution = readInstructionFilesAtRef(["absent.md"], { ref: sha, workspace: root });
  assert.deepEqual([...resolution.files], []);
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, /absent\.md.*not found/);
});

test("a tracked symlink is skipped, not read as its link-target string", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  writeFile(root, "real-rules.md", "rule: real\n");
  symlinkSync("real-rules.md", join(root, "linked-rules.md"));
  const sha = commit(root, "seed + symlink");

  const resolution = readInstructionFilesAtRef(["linked-rules.md"], { ref: sha, workspace: root });
  assert.deepEqual([...resolution.files], []);
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, /symlink/);
});

test("absolute paths and '..' segments are refused at the read boundary too", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  const sha = commit(root, "seed");
  const resolution = readInstructionFilesAtRef(["/etc/passwd", "../escape.md"], { ref: sha, workspace: root });
  assert.deepEqual([...resolution.files], []);
  assert.equal(resolution.warnings.length, 2);
  assert.match(resolution.warnings.join("\n"), /absolute or '\.\.' segment/);
});

test("a path with control characters is refused without echoing it", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  const sha = commit(root, "seed");
  const resolution = readInstructionFilesAtRef(["bad\u0000path.md"], { ref: sha, workspace: root });
  assert.deepEqual([...resolution.files], []);
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, /entry 0 refused \(control characters\)/);
  assert.ok(!resolution.warnings[0]!.includes("bad"));
});

test("a file over the per-file cap is skipped; smaller files still read", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  writeFile(root, "big.md", "a".repeat(MAX_INSTRUCTION_FILE_BYTES + 1));
  writeFile(root, "small.md", "fits\n");
  const sha = commit(root, "oversized instruction");

  const resolution = readInstructionFilesAtRef(["big.md", "small.md"], { ref: sha, workspace: root });
  assert.deepEqual(resolution.files.map(({ path }) => path), ["small.md"]);
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, new RegExp(`exceeds the ${MAX_INSTRUCTION_FILE_BYTES}-byte per-file cap`));
});

test("the aggregate cap stops accepting files once the total is exhausted", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  const quarter = "a".repeat(MAX_INSTRUCTION_FILE_BYTES);
  for (const name of ["one.md", "two.md", "three.md", "four.md"]) writeFile(root, name, quarter);
  writeFile(root, "five.md", "x");
  const sha = commit(root, "aggregate cap");

  // Four full-cap files land exactly on MAX_INSTRUCTION_TOTAL_BYTES; the
  // fifth (1 byte) would exceed it and is skipped with a diagnostic.
  const resolution = readInstructionFilesAtRef(["one.md", "two.md", "three.md", "four.md", "five.md"], { ref: sha, workspace: root });
  assert.deepEqual(resolution.files.map(({ path }) => path), ["one.md", "two.md", "three.md", "four.md"]);
  assert.equal(resolution.warnings.length, 1);
  assert.match(resolution.warnings[0]!, new RegExp(`would exceed the ${MAX_INSTRUCTION_TOTAL_BYTES}-byte total instruction cap`));
});

test("an unresolvable ref is a typed read failure, never silent absence", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  commit(root, "seed");
  assert.throws(
    () => readInstructionFilesAtRef(["rules.md"], { ref: "definitely-not-a-ref", workspace: root }),
    (error: unknown) => error instanceof RepositoryConfigError && /could not be resolved/.test(error.message),
  );
});

test("a non-git workspace is a typed read failure, never silent absence", () => {
  const root = mkdtempSync(join(tmpdir(), "instructions-nogit-"));
  assert.throws(() => readInstructionFilesAtRef(["rules.md"], { ref: "HEAD", workspace: root }), RepositoryConfigError);
});

test("an empty instruction list resolves to nothing with no warnings", () => {
  const root = initRepo();
  writeFile(root, "README.md", "seed\n");
  const sha = commit(root, "seed");
  const resolution = readInstructionFilesAtRef([], { ref: sha, workspace: root });
  assert.deepEqual([...resolution.files], []);
  assert.deepEqual([...resolution.warnings], []);
});
