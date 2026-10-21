#!/usr/bin/env node
/**
 * #1074: launcher for the confidence-calibration pilot bridge, usable from
 * the Python driver as:
 *
 *   node scripts/confidence_bridge.mjs <subcommand> <infile>
 *
 * Bundles `scripts/confidence_bridge.ts` with esbuild's JS API into a cache
 * file under os.tmpdir()/confidence-bridge-cache/ whose name embeds a sha256
 * of the bridge source bytes plus the esbuild version, so a stale bundle can
 * never be loaded after the source changes. Then loads the CJS bundle and
 * invokes its CLI with the caller's argv. Quiet by design: no output of its
 * own beyond what the bridge itself prints (result JSON on stdout, a
 * redacted failure line on stderr).
 *
 * Deliberately kept small: it is pilot tooling, not part of the action.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSource = path.join(here, "confidence_bridge.ts");
const sourceBytes = readFileSync(bridgeSource);
const esbuildVersion = typeof esbuild.version === "string" ? esbuild.version : "unknown";
const digest = createHash("sha256").update(sourceBytes).update(esbuildVersion).digest("hex").slice(0, 16);
const cacheDir = path.join(os.tmpdir(), "confidence-bridge-cache");
const bundlePath = path.join(cacheDir, `confidence-bridge-${digest}.cjs`);

if (!existsSync(bundlePath)) {
  mkdirSync(cacheDir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [bridgeSource],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    logLevel: "silent",
    write: false,
  });
  // Write-then-rename so two concurrent launches never observe a half-written
  // bundle under the shared cache name.
  const tmpPath = `${bundlePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, result.outputFiles[0].contents);
  renameSync(tmpPath, bundlePath);
}

// The bundled bridge reads its subcommand and input path from argv; rebuild
// argv so it sees [node, confidence_bridge, <subcommand>, <infile>].
process.argv = [process.argv[0], "confidence_bridge", ...process.argv.slice(2)];
const require = createRequire(import.meta.url);
require(bundlePath);
