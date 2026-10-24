import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { ACTION_GATES, UNCOVERED_GATE_SUBJECTS } from "../src/enforcement/action-gates.js";
import { createActionSourceReader, MAX_ACTION_SOURCE_BYTES, resolveActionSourceRoot } from "../src/enforcement/action-source.js";

/**
 * #1238: the registry of the executing action's own deterministic gates.
 * These guards keep it honest: a gate the source does not implement must
 * never be cited, because a citation is what lets the boundary refute a
 * gate-absence claim.
 */

/** This repository — the action's own source tree in a checkout. */
const REPO_ROOT = resolve(__dirname, "..", "..");

test("every registered gate is implemented by the file it cites", () => {
  assert.ok(ACTION_GATES.length > 0, "the registry must not be empty");
  for (const gate of ACTION_GATES) {
    const source = readFileSync(resolve(REPO_ROOT, gate.implementation), "utf8");
    assert.ok(
      source.includes(gate.marker),
      `gate ${gate.id} claims marker ${JSON.stringify(gate.marker)} that ${gate.implementation} does not contain`,
    );
  }
});

test("registered gates cite repo-relative implementation paths", () => {
  for (const gate of ACTION_GATES) {
    assert.ok(!isAbsolute(gate.implementation), `gate ${gate.id} must cite a repo-relative path`);
    assert.ok(!gate.implementation.split("/").includes(".."), `gate ${gate.id} must not cite a traversing path`);
    assert.ok(gate.implementation.startsWith("src/"), `gate ${gate.id} must cite the action's own source tree`);
  }
});

test("gate ids are unique", () => {
  const ids = ACTION_GATES.map((gate) => gate.id);
  assert.equal(new Set(ids).size, ids.length, "gate ids must be unique");
});

test("gate subjects are lowercase word lists, not regular expressions", () => {
  // #1238: the scan matches subjects token-exactly. A shared RegExp would
  // carry `lastIndex` state between sentences, so the vocabulary stays a
  // plain word list.
  for (const gate of ACTION_GATES) {
    assert.ok(gate.subjects.length > 0, `gate ${gate.id} must name at least one subject`);
    for (const subject of gate.subjects) {
      assert.match(subject, /^[a-z][a-z0-9]*$/, `gate ${gate.id} subject ${JSON.stringify(subject)} must be a lowercase word`);
    }
  }
  for (const subject of UNCOVERED_GATE_SUBJECTS) {
    assert.match(subject, /^[a-z][a-z0-9]*$/, `uncovered subject ${JSON.stringify(subject)} must be a lowercase word`);
  }
});

test("every gate behavior the scan can name is covered or explicitly uncovered", () => {
  // The nouns the gate-absence scan can name (mirroring its behavior
  // vocabulary): each must be either decidable from the registry or listed
  // as uncovered, so a claim can never fall through undecided by accident
  // and no registered subject can overlap an uncovered one.
  for (const behavior of ["draft", "label", "dedupe", "fingerprint"]) {
    const covered = ACTION_GATES.filter((gate) => gate.subjects.includes(behavior));
    const uncovered = UNCOVERED_GATE_SUBJECTS.filter((subject) => subject === behavior);
    assert.equal(
      (covered.length > 0 ? 1 : 0) + (uncovered.length > 0 ? 1 : 0),
      1,
      `gate behavior "${behavior}" must be either covered by the registry or explicitly uncovered`,
    );
  }
});

test("the action source root follows GITHUB_ACTION_PATH and falls back to the bundle location", () => {
  assert.equal(resolveActionSourceRoot({ GITHUB_ACTION_PATH: "/opt/actions/pr-reviewer" }), "/opt/actions/pr-reviewer");
  // A relative or empty value is not a usable root: the fallback (the
  // shipped bundle's own location) applies instead.
  const fallback = resolveActionSourceRoot({ GITHUB_ACTION_PATH: "relative/path" });
  assert.ok(isAbsolute(fallback));
  assert.notEqual(fallback, resolve("relative/path"));
  assert.ok(isAbsolute(resolveActionSourceRoot({})));
});

test("the action source reader serves the action's own tree and refuses to leave it", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "action-source-"));
  const outside = mkdtempSync(resolve(tmpdir(), "action-outside-"));
  try {
    // A root is an ACTION checkout: without the manifest the reader
    // refuses every read (#1238 witness-root provenance).
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    writeFileSync(resolve(root, "gate.ts"), 'skip_reason: "pr-draft"\n', "utf8");
    writeFileSync(resolve(outside, "secret.ts"), "secret\n", "utf8");
    // A symlink inside the tree pointing outside it: the file EXISTS and
    // is readable, so only the realpath containment check can reject it.
    symlinkSync(resolve(outside, "secret.ts"), resolve(root, "escape.ts"));
    const read = createActionSourceReader({ root });
    const inside = await read("gate.ts");
    assert.equal(inside.status, "ok");
    assert.equal(inside.status === "ok" ? inside.text : "", 'skip_reason: "pr-draft"\n');
    // Traversal out of the tree, an absolute path, and the escaping symlink
    // are all refused — the reader only ever serves the action's own tree.
    for (const escaping of ["../action-outside-x/secret.ts", resolve(outside, "secret.ts"), "escape.ts"]) {
      const result = await read(escaping);
      assert.equal(result.status, "unavailable", `path ${escaping} must not be served`);
    }
    const missing = await read("no-such-file.ts");
    assert.equal(missing.status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("#1238 a root inside the reviewed workspace refuses every read", () => {
  // The reviewed repository's bytes are PR-controlled: a root inside it
  // must never decide a refutation (the `uses: ./` shape).
  const workspace = mkdtempSync(resolve(tmpdir(), "action-workspace-"));
  try {
    const root = resolve(workspace, "action");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    const read = createActionSourceReader({ root, workspaceRoot: workspace });
    return read("action.yml").then((result) => {
      assert.equal(result.status, "unavailable");
      assert.equal(result.status === "unavailable" ? result.reason : "", "root-inside-workspace");
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1238 a root that is the reviewed workspace itself refuses every read", async () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "action-workspace-"));
  try {
    writeFileSync(resolve(workspace, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    const read = createActionSourceReader({ root: workspace, workspaceRoot: workspace });
    const result = await read("action.yml");
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" ? result.reason : "", "root-inside-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1238 a root that symlinks into the reviewed workspace refuses every read", async () => {
  // The lexical path of a symlinked root lies OUTSIDE the workspace while
  // its bytes live INSIDE it: only the realpath comparison can refuse it.
  const workspace = mkdtempSync(resolve(tmpdir(), "action-workspace-"));
  const outside = mkdtempSync(resolve(tmpdir(), "action-outside-"));
  try {
    const real = resolve(workspace, "action");
    mkdirSync(real, { recursive: true });
    writeFileSync(resolve(real, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    const link = resolve(outside, "linked-action");
    symlinkSync(real, link);
    const read = createActionSourceReader({ root: link, workspaceRoot: workspace });
    const result = await read("action.yml");
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" ? result.reason : "", "root-inside-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("#1238 a root without an action.yml refuses every read", async () => {
  // A root that is not an action checkout cannot be the executing action's
  // own tree: the witness has no provenance and stays unavailable.
  const root = mkdtempSync(resolve(tmpdir(), "action-not-an-action-"));
  try {
    writeFileSync(resolve(root, "gate.ts"), 'skip_reason: "pr-draft"\n', "utf8");
    const read = createActionSourceReader({ root });
    const result = await read("gate.ts");
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" ? result.reason : "", "root-not-an-action");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1238 a missing root refuses every read as a root that is not an action", async () => {
  const root = resolve(tmpdir(), "action-source-absent-root");
  const read = createActionSourceReader({ root });
  const result = await read("gate.ts");
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" ? result.reason : "", "root-not-an-action");
});

test("#1238 the reader refuses a directory and an oversize file inside the tree", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "action-source-"));
  try {
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    writeFileSync(resolve(root, "huge.ts"), Buffer.alloc(MAX_ACTION_SOURCE_BYTES + 1), "utf8");
    const read = createActionSourceReader({ root });
    const directory = await read(".");
    assert.equal(directory.status, "unavailable");
    const oversize = await read("huge.ts");
    assert.equal(oversize.status, "unavailable");
    assert.equal(oversize.status === "unavailable" ? oversize.reason : "", "too-large");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1240 the reader refuses a path carrying a NUL byte", async () => {
  // A NUL byte truncates the path at the OS boundary, so the bytes after
  // it would address a different file than the containment check proved.
  const root = mkdtempSync(resolve(tmpdir(), "action-source-"));
  try {
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    writeFileSync(resolve(root, "gate.ts"), 'skip_reason: "pr-draft"\n', "utf8");
    const read = createActionSourceReader({ root });
    for (const bad of ["gate.ts\0.png", "gate\0.ts", "\0", "gate.ts\0"]) {
      const result = await read(bad);
      assert.equal(result.status, "unavailable", `path ${JSON.stringify(bad)} must not be served`);
      assert.equal(result.status === "unavailable" ? result.reason : "", "invalid-path");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1240 a symlink inside the tree still serves the file it points at", async () => {
  // The read goes through ONE handle opened on the RESOLVED path: a symlink
  // that stays inside the action's own tree is still served, while the
  // O_NOFOLLOW guard refuses a final-component symlink that replaced the
  // file after the realpath check.
  const root = mkdtempSync(resolve(tmpdir(), "action-source-"));
  try {
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    writeFileSync(resolve(root, "gate.ts"), 'skip_reason: "pr-draft"\n', "utf8");
    symlinkSync(resolve(root, "gate.ts"), resolve(root, "link.ts"));
    const read = createActionSourceReader({ root });
    const result = await read("link.ts");
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.text : "", 'skip_reason: "pr-draft"\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #1240: create a FIFO. Node has no `mkfifo` API, so the platform's own
 * `mkfifo` is used; false when the platform has none (Windows), in which
 * case the caller skips the test.
 */
function mkfifoSync(path: string): boolean {
  try {
    execFileSync("mkfifo", [path]);
    return true;
  } catch {
    return false;
  }
}

test("#1240 a FIFO inside the tree is refused as not-a-file, never blocking the read", async (t) => {
  // Opening a FIFO read-only BLOCKS until a writer opens it: without the
  // O_NONBLOCK guard the boundary would hang on a special file inside the
  // action's own tree instead of refusing it. The read must return
  // "not-a-file" — and it must do so promptly, so the assertion races the
  // read against a timer instead of hanging the suite.
  const root = mkdtempSync(resolve(tmpdir(), "action-source-"));
  try {
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    const fifo = resolve(root, "gate.ts");
    if (!mkfifoSync(fifo)) {
      t.skip("this platform has no mkfifo");
      return;
    }
    const read = createActionSourceReader({ root });
    const timeout = new Promise<{ kind: "timeout" }>((resolveTimeout) => {
      setTimeout(() => resolveTimeout({ kind: "timeout" }), 5_000).unref?.();
    });
    const outcome = await Promise.race([
      read("gate.ts").then((value) => ({ kind: "read" as const, value })),
      timeout,
    ]);
    if (outcome.kind === "timeout") assert.fail("the read must not block on a FIFO");
    assert.equal(outcome.value.status, "unavailable");
    assert.equal(outcome.value.status === "unavailable" ? outcome.value.reason : "", "not-a-file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
