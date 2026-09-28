import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunWorkspace } from "../src/run/workspace.js";

/** The workspace bus's core invariant (#809 review): in-memory state is
 * authoritative — a stage can never observe a stale file left by a previous
 * run through the bus, and a refused disk write never corrupts the value a
 * downstream stage reads. */

test("a stage overwrites a stale file's value: the bus serves the new write, not the disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-ws-test-"));
  try {
    // Stale artifact from a "previous run" on a reused workspace.
    writeFileSync(join(dir, "tool-harness.json"), '{"mode":"native_loop","rounds":9}');
    const ws = new RunWorkspace(dir, true);
    ws.write("tool-harness.json", '{"mode":"off"}');
    assert.equal(ws.readText("tool-harness.json"), '{"mode":"off"}', "the bus serves this run's write");
    assert.ok(existsSync(join(dir, "tool-harness.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace escape is refused: the disk mirror is dropped, the bus value survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-ws-refused-"));
  try {
    const ws = new RunWorkspace(dir, true);
    ws.write("../escape.txt", "bus value");
    assert.equal(ws.readText("../escape.txt"), "bus value", "the bus value survives the refused mirror");
    assert.ok(ws.persistFailures.includes("../escape.txt"), "the refusal is reported, not dropped");
    assert.ok(!existsSync(join(dir, "..", "escape.txt")), "nothing was written outside the workspace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persist=false keeps the bus pure: nothing touches the disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-ws-mem-"));
  try {
    const ws = new RunWorkspace(dir, false);
    ws.write("classification.json", "{}");
    assert.equal(ws.isFile("classification.json"), true);
    assert.equal(existsSync(join(dir, "classification.json")), false, "no disk mirror in memory-only mode");
    assert.deepEqual([...ws.persistFailures], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
