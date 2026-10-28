/** #764: the provider boundary is INTERRUPTIBLY BOUNDED.
 *
 * The provider seam is public: `registerSyntaxProvider` exists so a
 * parser-backed provider can be registered later. A provider is therefore
 * UNTRUSTED code as far as the wall-clock bound is concerned, and a bound
 * that is only checked before and after a provider call does not bound it:
 * a provider that blocks in `declarations`, `identifiersOnLine` or
 * `classify` — even SYNCHRONOUSLY, even forever — would hold the review
 * past the advertised cap.
 *
 * Every provider therefore runs in an isolated worker thread, and the
 * parent terminates the worker when a call exceeds its bound. These
 * regressions prove the bound holds:
 *   - a provider that blocks FOREVER cannot outlive the bound;
 *   - a provider that is SLOW BUT RETURNS is bounded the same way;
 *   - the TIMEOUT kills the worker (not the build's end);
 *   - a provider whose LOAD hangs is bounded the same way;
 *   - a worker that EXITS is a recorded failure, not a hang;
 *   - a provider that keeps failing is disabled for the rest of the build;
 *   - the built-in provider still works end to end through the worker;
 *   - an unknown provider id still degrades to the built-in one, safely.
 *
 * Every test that waits for a bound wraps the call in a race against a
 * generous timer, so a regression FAILS the test instead of hanging the
 * suite. */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  buildSyntaxContext,
  createProviderHost,
  MAX_SYNTAX_SECONDS,
  MAX_SYNTAX_WORKER_CACHED_FILES,
  registerSyntaxProvider,
  resolveSyntaxProvider,
} from "../src/context/syntax/index.js";
import { detectLanguage } from "../src/context/change-anchors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A temporary workspace holding the given files. */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "syntax-provider-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

/** The change-anchor artifact of one changed file. */
function anchors(path: string, changedLines: [number, number][]): unknown {
  return {
    version: 1,
    files: [{ path, language: detectLanguage(path), symbols: [], imports: [], identifiers: [], changed_lines: changedLines }],
    anchors: [],
    truncated: false,
  };
}

/** Await a promise, but never longer than `ms`: null when the promise did
 * not settle in time. A regression that hangs therefore fails the test
 * instead of hanging the suite. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The fixture module the worker loads. */
function fixture(name: string): string {
  return join(__dirname, "fixtures", name);
}

/** How long to wait for a terminated worker to fall silent. */
const WORKER_SETTLE_MS = 400;

// ---------------------------------------------------------------------------
// The regressions
// ---------------------------------------------------------------------------

test("a provider that blocks forever cannot outlive the wall-clock bound", async () => {
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const heartbeat = join(root, "heartbeat");
  registerSyntaxProvider("blocking", {
    id: "blocking",
    loader: { kind: "module", module: fixture("syntax-provider-blocking.js"), options: { heartbeat } },
  });

  const started = Date.now();
  const context = await withDeadline(
    buildSyntaxContext({
      workspace: root,
      anchors: anchors("src/app.py", [[2, 2]]),
      providerRegistration: resolveSyntaxProvider("blocking").registration,
      // The bound is the module constant; this only NARROWS it, so the
      // regression runs in milliseconds instead of seconds.
      maxSeconds: 0.25,
    }),
    10_000,
  );
  const elapsed = Date.now() - started;

  assert.ok(context !== null, `the build did not settle within 10s (it took ${elapsed}ms)`);
  assert.ok(elapsed < 1_000, `the build took ${elapsed}ms — the bound did not stop the blocking provider`);
  // The degradation is VISIBLE: the artifact says the collection was cut
  // short and why. The bound that bit is the PER-CALL ceiling, not the
  // wall-clock deadline: the artifact must not misreport it.
  assert.equal(context.truncated, true);
  assert.equal(context.truncatedReason, "provider call timeout");
  assert.ok(context.errors.length > 0, "the provider failure is recorded");
  assert.ok(
    context.notes.some((note) => note.includes("provider call timeout")),
    "the per-call timeout is recorded in the notes",
  );
  assert.ok(
    !context.notes.some((note) => note.includes("wall-clock bound")),
    "the wall-clock deadline did not expire and must not be named",
  );
  assert.ok(
    context.notes.some((note) => note.includes("ms bound") && note.includes("the per-call ceiling is 5000ms")),
    "the note names the per-call bound that expired",
  );

  // The worker is gone: a worker that outlived the build would keep
  // writing its heartbeat.
  const beat = readFileSync(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, WORKER_SETTLE_MS));
  assert.equal(readFileSync(heartbeat, "utf8"), beat, "the provider's worker outlived the build");
});

test("a provider that is slow but returns is bounded the same way", async () => {
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  registerSyntaxProvider("slow", {
    id: "slow",
    loader: { kind: "module", module: fixture("syntax-provider-slow.js"), options: { delayMs: 2_000 } },
  });

  const started = Date.now();
  const context = await withDeadline(
    buildSyntaxContext({
      workspace: root,
      anchors: anchors("src/app.py", [[2, 2]]),
      providerRegistration: resolveSyntaxProvider("slow").registration,
      maxSeconds: 0.25,
    }),
    10_000,
  );
  const elapsed = Date.now() - started;

  assert.ok(context !== null, `the build did not settle within 10s (it took ${elapsed}ms)`);
  assert.ok(elapsed < 1_000, `the build took ${elapsed}ms — the bound did not stop the slow provider`);
  assert.equal(context.truncated, true);
  assert.equal(context.truncatedReason, "provider call timeout");
  assert.ok(context.errors.length > 0, "the provider failure is recorded");
  // The provider's answer arrived too late to be used.
  assert.deepEqual(context.declarations, []);
});

test("the built-in provider still answers through the isolated worker", async () => {
  const root = workspace({
    "src/app.py": "from lib.helpers import compute\n\ndef handle(items):\n    return compute(items)\n",
    "src/caller.py": "from app import handle\n\ndef go(items):\n    return handle(items)\n",
    "lib/helpers.py": "def compute(items):\n    return sum(items)\n",
  });
  const context = await buildSyntaxContext({
    workspace: root,
    anchors: anchors("src/app.py", [[4, 4]]),
  });

  assert.deepEqual(context.errors, []);
  assert.equal(context.providerId, "structural");
  assert.equal(context.truncated, false);
  // The declaration the change touches.
  assert.equal(context.declarations.length, 1);
  assert.equal(context.declarations[0]?.name, "handle");
  assert.equal(context.declarations[0]?.path, "src/app.py");
  assert.equal(context.declarations[0]?.body, "def handle(items):\n    return compute(items)");
  // The definition of an identifier the changed line references.
  const definition = context.definitions.find((entry) => entry.name === "compute");
  assert.ok(definition, "the definition is found through the worker");
  assert.equal(definition?.path, "lib/helpers.py");
  assert.equal(definition?.line, 1);
  // The caller outside the diff.
  assert.deepEqual(context.callers.map((caller) => [caller.path, caller.line]), [["src/caller.py", 4]]);
  assert.equal(context.callers[0]?.usage, "call");
});

test("an unknown provider id degrades to the built-in one through the worker", async () => {
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const resolution = resolveSyntaxProvider("tree-sitter");
  assert.equal(resolution.fallback, true);
  assert.ok((resolution.reason ?? "").includes("tree-sitter"));

  const context = await buildSyntaxContext({
    workspace: root,
    anchors: anchors("src/app.py", [[2, 2]]),
    providerRegistration: resolution.registration,
    providerFallback: resolution.fallback,
    providerFallbackReason: resolution.reason,
  });

  assert.deepEqual(context.errors, []);
  assert.equal(context.providerId, "structural");
  assert.equal(context.providerFallback, true);
  assert.ok((context.providerFallbackReason ?? "").includes("tree-sitter"));
  // The built-in provider ran through the worker and answered.
  assert.equal(context.declarations.length, 1);
  assert.equal(context.declarations[0]?.name, "handle");
});

test("the wall-clock bound is a module constant that configuration can only narrow", async () => {
  // The bound itself is `MAX_SYNTAX_SECONDS`; the option may only NARROW
  // it. A larger value is silently clamped, never honoured: the expiry
  // note names the CLAMPED bound.
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const marker = join(root, "expiry.marker");
  const context = await buildSyntaxContext({
    workspace: root,
    anchors: anchors("src/app.py", [[2, 2]]),
    providerRegistration: {
      id: "expiring",
      loader: {
        kind: "module",
        module: fixture("syntax-provider-expiring.js"),
        options: { marker },
      },
    },
    maxSeconds: MAX_SYNTAX_SECONDS * 10,
    monotonic: () => (existsSync(marker) ? 100 : 0),
  });

  assert.equal(context.truncated, true);
  assert.equal(context.truncatedReason, "deadline");
  const note = context.notes.find((entry) => entry.includes("wall-clock bound")) ?? "";
  assert.ok(note.includes(`wall-clock bound of ${MAX_SYNTAX_SECONDS}s`), `the clamped bound is named in "${note}"`);
});

test("a provider that cannot even be loaded degrades the stage", async () => {
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const context = await buildSyntaxContext({
    workspace: root,
    anchors: anchors("src/app.py", [[2, 2]]),
    providerRegistration: {
      id: "missing",
      loader: { kind: "module", module: join(root, "does-not-exist.js") },
    },
  });
  assert.ok(context.errors.length > 0, "the load failure is recorded");
  assert.equal(context.providerId, "missing");
  assert.deepEqual(context.declarations, []);
  // The failure reaches the PUBLISHED artifact, so it must not carry the
  // runner's own absolute paths: the module's base name and the first
  // line of the cause only.
  const failure = context.errors.join(" ");
  assert.ok(!failure.includes(root), `the workspace path leaked into "${failure}"`);
  assert.ok(!failure.includes("Require stack"), `the require stack leaked into "${failure}"`);
  assert.ok(failure.includes("does-not-exist.js"), `the module is named in "${failure}"`);
});

test("a provider module whose LOAD hangs forever is bounded", async () => {
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const started = Date.now();
  const context = await withDeadline(
    buildSyntaxContext({
      workspace: root,
      anchors: anchors("src/app.py", [[2, 2]]),
      providerRegistration: {
        id: "load-hang",
        loader: { kind: "module", module: fixture("syntax-provider-load-hang.js") },
      },
      maxSeconds: 0.25,
    }),
    10_000,
  );
  const elapsed = Date.now() - started;

  assert.ok(context !== null, `the build did not settle within 10s (it took ${elapsed}ms)`);
  assert.ok(elapsed < 1_000, `the build took ${elapsed}ms — a hanging load was not bounded`);
  // The degradation is VISIBLE and names the bound that bit.
  assert.equal(context.truncated, true);
  assert.equal(context.truncatedReason, "provider call timeout");
  assert.ok(context.errors.length > 0, "the hanging load is recorded");
  assert.deepEqual(context.declarations, []);
});

test("a worker that exits at load time is a failure, not a hang", async () => {
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const started = Date.now();
  const context = await withDeadline(
    buildSyntaxContext({
      workspace: root,
      anchors: anchors("src/app.py", [[2, 2]]),
      providerRegistration: {
        id: "exiting",
        loader: { kind: "module", module: fixture("syntax-provider-exiting.js") },
      },
      maxSeconds: 0.25,
    }),
    10_000,
  );
  const elapsed = Date.now() - started;

  assert.ok(context !== null, `the build did not settle within 10s (it took ${elapsed}ms)`);
  assert.ok(elapsed < 1_000, `the build took ${elapsed}ms — the exit was not noticed`);
  // The exit is a FAILURE, recorded as such: the build must not wait for
  // an answer that will never come.
  assert.ok(context.errors.length > 0, "the exit is recorded");
  assert.ok(
    context.errors.some((error) => error.includes("exited")),
    `the exit is named in ${JSON.stringify(context.errors)}`,
  );
  assert.deepEqual(context.declarations, []);
});

test("a provider that always throws is disabled after repeated failures", async () => {
  const root = workspace({
    "src/one.py": "def one():\n    return 1\n",
    "src/two.py": "def two():\n    return 2\n",
    "src/three.py": "def three():\n    return 3\n",
  });
  const context = await buildSyntaxContext({
    workspace: root,
    anchors: {
      version: 1,
      files: [
        { path: "src/one.py", language: detectLanguage("src/one.py"), symbols: [], imports: [], identifiers: [], changed_lines: [[1, 2]] },
        { path: "src/two.py", language: detectLanguage("src/two.py"), symbols: [], imports: [], identifiers: [], changed_lines: [[1, 2]] },
        { path: "src/three.py", language: detectLanguage("src/three.py"), symbols: [], imports: [], identifiers: [], changed_lines: [[1, 2]] },
      ],
      anchors: [],
      truncated: false,
    },
    providerRegistration: {
      id: "throwing",
      loader: { kind: "module", module: fixture("syntax-provider-throwing.js") },
    },
  });
  // The provider fails every call, so it is disabled for the rest of the
  // build and the artifact says so.
  assert.ok(
    context.errors.some((error) => error.includes("syntax provider disabled after repeated failures")),
    `the failure cap is recorded in ${JSON.stringify(context.errors)}`,
  );
  assert.ok(
    context.errors.every((error) => error.length <= 300),
    "the recorded errors stay bounded",
  );
});

test("#252 adversarial: a path that tries to leave the workspace is refused BY THE WORKER", async () => {
  // The boundary token itself: the worker's reader is the only thing that
  // touches the filesystem, so a traversal or an absolute path must be
  // refused THERE — not merely by the builder's own path handling.
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const outsideDir = mkdtempSync(join(tmpdir(), "syntax-provider-outside-"));
  const outside = join(outsideDir, "secret.py");
  writeFileSync(outside, "def secret():\n    return 1\n");

  const host = await createProviderHost({
    registration: { id: "structural", loader: { kind: "builtin" } },
    workspace: root,
    timeoutMs: 2_000,
  });
  try {
    assert.deepEqual(await host.declarations(`../${basename(outsideDir)}/secret.py`), [], "a traversal path is refused");
    assert.deepEqual(await host.declarations(outside), [], "an absolute path is refused");
    assert.deepEqual(await host.declarations(".git/config"), [], "a .git component is refused");
    // The control: a readable file inside the workspace IS answered.
    const declarations = await host.declarations("src/app.py");
    assert.deepEqual(declarations.map((declaration) => declaration.name), ["handle"]);
  } finally {
    await host.close();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("the registry key is the id the artifact reports", async () => {
  // A registration whose OWN id differs from the key it was registered
  // under must not report an id the operator never asked for: the artifact
  // names the provider it was RESOLVED under.
  registerSyntaxProvider("ts", {
    id: "tree-sitter",
    loader: { kind: "module", module: fixture("syntax-provider-throwing.js") },
  });
  const resolution = resolveSyntaxProvider("ts");
  assert.equal(resolution.fallback, false);
  assert.equal(resolution.registration.id, "ts");

  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const context = await buildSyntaxContext({
    workspace: root,
    anchors: anchors("src/app.py", [[2, 2]]),
    providerRegistration: resolution.registration,
    providerFallback: resolution.fallback,
    providerFallbackReason: resolution.reason,
  });
  assert.equal(context.providerId, "ts");
});

test("the worker's parsed-file cache holds ONE file", () => {
  // The candidate phase holds one file at a time, so the worker's cache
  // must not retain a parsed form of every file it was handed: the
  // documented "one file at a time" memory property depends on it.
  assert.equal(MAX_SYNTAX_WORKER_CACHED_FILES, 1);
});

test("the timeout TERMINATES the worker, not the build's end", async () => {
  // The host is NOT closed while this is checked: only the TIMEOUT can have
  // killed the worker, because `close()` is what terminates it otherwise.
  // A regression that dropped the termination from the timeout path would
  // leave the worker running — and its heartbeat advancing — until the
  // build ended.
  const root = workspace({
    "src/app.py": "def handle(item):\n    return item\n",
  });
  const heartbeat = join(root, "heartbeat");
  const host = await createProviderHost({
    registration: {
      id: "blocking",
      loader: { kind: "module", module: fixture("syntax-provider-blocking.js"), options: { heartbeat } },
    },
    workspace: root,
    timeoutMs: 250,
  });
  try {
    await assert.rejects(
      () => host.declarations("src/app.py"),
      /exceeded its 250ms bound/,
      "the call is rejected when the bound expires",
    );
    // The worker is dead: its heartbeat stopped advancing.
    const beat = readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, WORKER_SETTLE_MS));
    assert.equal(readFileSync(heartbeat, "utf8"), beat, "the timed-out worker was not terminated");
  } finally {
    await host.close();
  }
});
