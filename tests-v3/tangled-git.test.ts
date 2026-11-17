import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTangledPatchDiff, TangledGitError } from "../src/platform/tangled-git.js";

/**
 * The Tangled Git read surface (#1690): the reviewed diff/files derived
 * from a patch revision's trusted base/head with fixed-argv bounded git
 * commands against the checked-out round. Real git fixtures, no network.
 */

function git(dir: string, args: string[]): string {
  return execFileSync("git", [
    "-c", "commit.gpgsign=false",
    "-c", "user.name=fixture",
    "-c", "user.email=fixture@example.com",
    ...args,
  ], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8").trim();
}

/** A repo whose base commit and head commit differ by one modify, one add,
 * one rename (the file existed at base) and one delete. */
function makeFixture(): { dir: string; baseOid: string; headOid: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "v3-tangled-git-"));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, "dropped.txt"), "delete me\n");
  writeFileSync(join(dir, "added.txt"), "brand new\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const baseOid = git(dir, ["rev-parse", "HEAD"]);

  writeFileSync(join(dir, "README.md"), "hello\nworld\n");
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  writeFileSync(join(dir, "fresh.txt"), "added in the head commit\n");
  git(dir, ["rm", "-q", "dropped.txt"]);
  git(dir, ["mv", "added.txt", "renamed.txt"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "head"]);
  const headOid = git(dir, ["rev-parse", "HEAD"]);
  return { dir, baseOid, headOid, close(): void { rmSync(dir, { recursive: true, force: true }); } };
}

test("the reviewed diff anchors on the trusted base/head oids, not the working tree", async () => {
  const fix = makeFixture();
  try {
    // Dirty the working tree AFTER the head commit: the diff must still be
    // exactly base..head — the workspace tree state is never reviewed.
    writeFileSync(join(fix.dir, "README.md"), "dirty working tree\n");
    const result = readTangledPatchDiff(fix.dir, fix.baseOid, fix.headOid);
    assert.match(result.diff, /hello\n\+world/, "the modified file's hunks are present");
    assert.match(result.diff, /renamed\.txt/, "the renamed file appears in the diff");
    const names = result.files.map((f) => f.filename).sort();
    assert.deepEqual(names, ["README.md", "binary.bin", "dropped.txt", "fresh.txt", "renamed.txt"]);
  } finally {
    fix.close();
  }
});

test("per-file rows carry GitHub-REST-shaped status, counts and patches", () => {
  const fix = makeFixture();
  try {
    const { files } = readTangledPatchDiff(fix.dir, fix.baseOid, fix.headOid);
    const byName = new Map(files.map((f) => [f.filename, f]));
    const readme = byName.get("README.md")!;
    assert.ok(readme, "README.md present");
    assert.equal(readme.status, "modified");
    assert.equal(readme.additions, 1);
    assert.equal(readme.deletions, 0);
    assert.equal(readme.changes, 1);
    assert.match(readme.patch ?? "", /@@ .* @@/, "the modified file carries its hunks");

    const renamed = byName.get("renamed.txt")!;
    assert.equal(renamed.status, "renamed");
    assert.equal(renamed.previous_filename, "added.txt");

    const dropped = byName.get("dropped.txt")!;
    assert.equal(dropped.status, "removed");
    assert.match(dropped.patch ?? "", /delete me/, "the removed file's hunks are present");

    const fresh = byName.get("fresh.txt")!;
    assert.equal(fresh.status, "added");

    const binary = byName.get("binary.bin")!;
    assert.ok(binary, "the binary file is still listed");
    assert.equal(binary.patch, undefined, "a binary file carries no textual patch");
  } finally {
    fix.close();
  }
});

test("object ids are validated before they reach argv", () => {
  const fix = makeFixture();
  try {
    assert.throws(
      () => readTangledPatchDiff(fix.dir, "not-an-oid", fix.headOid),
      (e: unknown) => e instanceof TangledGitError && /base oid/.test(e.message),
    );
    assert.throws(
      () => readTangledPatchDiff(fix.dir, fix.baseOid, "9".repeat(63)),
      (e: unknown) => e instanceof TangledGitError && /head oid/.test(e.message),
    );
  } finally {
    fix.close();
  }
});

test("a checkout without the reviewed objects fails closed", () => {
  const fix = makeFixture();
  try {
    // A 64-hex (SHA-256) head cannot exist in a SHA-1 repo: the object read
    // fails closed with the failing git read named.
    assert.throws(
      () => readTangledPatchDiff(fix.dir, fix.baseOid, `b${"2".repeat(63)}`),
      (e: unknown) => e instanceof TangledGitError && /git diff/.test(e.message),
    );
    // An empty path fails closed too: without the checkout there is no read
    // surface at all.
    assert.throws(
      () => readTangledPatchDiff("", fix.baseOid, fix.headOid),
      (e: unknown) => e instanceof TangledGitError && /workspace/.test(e.message),
    );
  } finally {
    fix.close();
  }
});

test("a SHA-256 repository's 64-hex oids diff cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-tangled-git-sha256-"));
  try {
    git(dir, ["init", "-q", "--object-format=sha256"]);
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const baseOid = git(dir, ["rev-parse", "HEAD"]);
    assert.match(baseOid, /^[0-9a-f]{64}$/, "the fixture repo is SHA-256");
    writeFileSync(join(dir, "README.md"), "hello\nworld\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "head"]);
    const headOid = git(dir, ["rev-parse", "HEAD"]);
    const { diff } = readTangledPatchDiff(dir, baseOid, headOid);
    assert.match(diff, /\+world/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
