import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { ACTION_GATES, UNCOVERED_GATE_SUBJECTS } from "../src/enforcement/action-gates.js";
import { createActionSourceReader, MAX_ACTION_SOURCE_BYTES, resolveActionSourceRoot } from "../src/enforcement/action-source.js";
import { ACTION_SOURCE_FILES } from "../.v3-generated/action-source.generated.js";

/**
 * #1238: the registry of the executing action's own deterministic gates.
 * These guards keep it honest: a gate the source does not implement must
 * never be cited, because a citation is what lets the boundary refute a
 * gate-absence claim.
 */

/** This repository — the action's own source tree in a checkout. */
const REPO_ROOT = resolve(__dirname, "..", "..");
/** The implementation the registry cites — embedded in the bundle. */
const IMPLEMENTATION = "src/precheck/decide.ts";

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

test("#1240 the witness serves the executing action's own embedded implementation", async () => {
  // The witness bytes are embedded in the executing bundle, so the reader
  // serves the implementation that actually runs — not whatever a tree on
  // disk happens to hold.
  const read = createActionSourceReader();
  const result = await read(IMPLEMENTATION);
  assert.equal(result.status, "ok");
  const text = result.status === "ok" ? result.text : "";
  assert.equal(text, ACTION_SOURCE_FILES.get(IMPLEMENTATION));
  const marker = ACTION_GATES.find((gate) => gate.implementation === IMPLEMENTATION)?.marker ?? "";
  assert.ok(text.includes(marker), "the served bytes must carry the registry's marker");
  // Every other path is unavailable: the witness serves the embedded
  // implementation and nothing else — no unknown file, no traversal, no
  // absolute path.
  for (const other of [
    "no-such-file.ts",
    "../src/precheck/decide.ts",
    "src/precheck/../precheck/decide.ts",
    resolve(REPO_ROOT, IMPLEMENTATION),
    "/etc/passwd",
  ]) {
    const refused = await read(other);
    assert.equal(refused.status, "unavailable", `path ${other} must not be served`);
  }
});

test("#1240 every registry implementation path is embedded in the witness", async () => {
  const read = createActionSourceReader();
  for (const gate of ACTION_GATES) {
    const result = await read(gate.implementation);
    assert.equal(result.status, "ok", `gate ${gate.id} implementation must be embedded`);
    const text = result.status === "ok" ? result.text : "";
    assert.ok(
      text.includes(gate.marker),
      `gate ${gate.id} claims marker ${JSON.stringify(gate.marker)} that the embedded ${gate.implementation} does not contain`,
    );
  }
});

test("#1240 the witness is unaffected by an intermediate-symlink swap in the action tree", async () => {
  // The witness bytes live in the executing bundle, so the action's install
  // tree cannot influence them: swapping an intermediate directory for a
  // symlink that escapes the root still serves exactly the embedded bytes.
  // The filesystem reader this replaced proved containment and then opened
  // the file in separate steps, so a swap between them walked the read out
  // of the action root.
  const root = mkdtempSync(resolve(tmpdir(), "action-source-"));
  const outside = mkdtempSync(resolve(tmpdir(), "action-outside-"));
  try {
    writeFileSync(resolve(root, "action.yml"), "name: pr-reviewer-action\n", "utf8");
    mkdirSync(resolve(root, "src/precheck"), { recursive: true });
    writeFileSync(resolve(root, "src/precheck/decide.ts"), 'skip_reason: "pr-draft"\n', "utf8");
    // Attacker-controlled bytes live OUTSIDE the action tree; each swap
    // points an intermediate component at them.
    mkdirSync(resolve(outside, "precheck"), { recursive: true });
    writeFileSync(resolve(outside, "precheck/decide.ts"), "attacker controlled bytes\n", "utf8");
    mkdirSync(resolve(outside, "src/precheck"), { recursive: true });
    writeFileSync(resolve(outside, "src/precheck/decide.ts"), "attacker controlled bytes\n", "utf8");
    const read = createActionSourceReader({ root });
    for (const intermediate of ["src/precheck", "src"]) {
      rmSync(resolve(root, intermediate), { recursive: true, force: true });
      symlinkSync(resolve(outside, basename(intermediate)), resolve(root, intermediate));
      const result = await read(IMPLEMENTATION);
      assert.equal(result.status, "ok", `the ${intermediate} swap must not make the witness unavailable`);
      const text = result.status === "ok" ? result.text : "";
      assert.equal(
        text,
        ACTION_SOURCE_FILES.get(IMPLEMENTATION),
        `the ${intermediate} swap must not change the served bytes`,
      );
      assert.ok(!text.includes("attacker"), "no byte from outside the action may ever be served");
      // A path that is not embedded stays unavailable even when the tree
      // now resolves it to a real file.
      const missing = await read("src/precheck/not-embedded.ts");
      assert.equal(missing.status, "unavailable");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("#1240 the witness needs no action tree at all", async () => {
  // The bytes are embedded in the bundle: a root that does not exist
  // changes nothing about what is served.
  const read = createActionSourceReader({ root: resolve(tmpdir(), "action-source-absent-root") });
  const result = await read(IMPLEMENTATION);
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" ? result.text : "", ACTION_SOURCE_FILES.get(IMPLEMENTATION));
});

test("#1238 a root inside the reviewed workspace refuses every read", async () => {
  // The reviewed repository's bytes are PR-controlled: a root inside it
  // must never decide a refutation (the `uses: ./` shape).
  const workspace = mkdtempSync(resolve(tmpdir(), "action-workspace-"));
  try {
    const root = resolve(workspace, "action");
    mkdirSync(root, { recursive: true });
    const read = createActionSourceReader({ root, workspaceRoot: workspace });
    const result = await read(IMPLEMENTATION);
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" ? result.reason : "", "root-inside-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("#1238 a root that is the reviewed workspace itself refuses every read", async () => {
  const workspace = mkdtempSync(resolve(tmpdir(), "action-workspace-"));
  try {
    const read = createActionSourceReader({ root: workspace, workspaceRoot: workspace });
    const result = await read(IMPLEMENTATION);
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
    const link = resolve(outside, "linked-action");
    symlinkSync(real, link);
    const read = createActionSourceReader({ root: link, workspaceRoot: workspace });
    const result = await read(IMPLEMENTATION);
    assert.equal(result.status, "unavailable");
    assert.equal(result.status === "unavailable" ? result.reason : "", "root-inside-workspace");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("#1240 the reader refuses a path carrying a NUL byte", async () => {
  // A NUL byte can never name an embedded file, and refusing it explicitly
  // keeps the refusal visible instead of folding it into "not found".
  const read = createActionSourceReader();
  for (const bad of ["src/precheck/decide.ts\0.png", "src/precheck\0/decide.ts", "\0", "src/precheck/decide.ts\0"]) {
    const result = await read(bad);
    assert.equal(result.status, "unavailable", `path ${JSON.stringify(bad)} must not be served`);
    assert.equal(result.status === "unavailable" ? result.reason : "", "invalid-path");
  }
});

test("#1240 the embedded witness stays within the action-source byte cap", () => {
  assert.equal(MAX_ACTION_SOURCE_BYTES, 1024 * 1024);
  for (const [path, text] of ACTION_SOURCE_FILES) {
    assert.ok(
      Buffer.byteLength(text, "utf8") <= MAX_ACTION_SOURCE_BYTES,
      `${path} must stay within the reader's byte cap`,
    );
  }
});
