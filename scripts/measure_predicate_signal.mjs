#!/usr/bin/env node
/**
 * Launcher for `scripts/measure_predicate_signal.ts` (#1347): bundles the
 * measurement with esbuild's JS API — so the shipped production shape is
 * imported from the working-tree source, never re-implemented — writes the
 * bundle to a fresh private temp directory, and
 * requires it. No credentials are involved, so unlike
 * `scripts/confidence_bridge.mjs` there is no user-cache reuse; every run
 * bundles fresh. Quiet by design; the measurement prints its JSON report on
 * stdout. Tooling, not part of the action.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "measure_predicate_signal.ts");

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  logLevel: "silent",
  write: false,
});

const dir = mkdtempSync(path.join(os.tmpdir(), "predicate-signal-measure-"));
const bundlePath = path.join(dir, "measure_predicate_signal.cjs");
writeFileSync(bundlePath, result.outputFiles[0].contents, { mode: 0o600 });
try {
  const require = createRequire(import.meta.url);
  require(bundlePath);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
