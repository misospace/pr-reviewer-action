#!/usr/bin/env node
/**
 * #1074: launcher for the confidence-calibration pilot bridge, usable from
 * the Python driver as:
 *
 *   node scripts/confidence_bridge.mjs <subcommand> <infile>
 *
 * Bundles `scripts/confidence_bridge.ts` with esbuild's JS API into a cache
 * file under the USER'S PRIVATE cache directory
 * (`$HOME/.cache/pr-reviewer-action/confidence-bridge-cache/`) whose name
 * embeds a sha256 over the FULL transitive local import graph (every
 * resolved module's bytes, plus unresolved relative specifiers as text) and
 * the esbuild version, so a stale bundle can never be loaded after the
 * bridge source OR any imported production module changes. Then loads the
 * CJS bundle and invokes its CLI with the caller's argv. Quiet by design: no
 * output of its own beyond what the bridge itself prints (result JSON on
 * stdout, a redacted failure line on stderr).
 *
 * The cache directory is per-user and mode 0700 by construction: a shared,
 * world-writable directory with a predictable, content-derived name would
 * let a local user pre-create the bundle path and have their code executed
 * with the pilot's credentials in the environment. A symlinked cache path,
 * a failed permission fix, or an unavailable home directory falls back to a
 * FRESH private directory (mkdtemp, mode 0700) — never to a shared one.
 *
 * Deliberately kept small: it is pilot tooling, not part of the action.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSource = path.join(here, "confidence_bridge.ts");

// Resolve a relative ESM specifier the way esbuild does for this repo's
// NodeNext-style sources ("./x.js" specs pointing at ".ts" files).
function resolveLocalModule(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  // Candidate order mirrors esbuild: a "./x.js" specifier bundles the literal
  // x.js when it exists and only then falls back to the NodeNext x.ts/x.tsx
  // rewrite; extensionless specifiers try .tsx before .ts.
  const candidates = /\.(js|mjs|cjs)$/.test(specifier)
    ? [base, base.replace(/\.(js|cjs|mjs)$/, ".ts"), base.replace(/\.(js|cjs|mjs)$/, ".tsx")]
    : [`${base}.tsx`, `${base}.ts`, base, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not a readable file; try the next candidate */
    }
  }
  return null;
}

// Collect the transitive closure of local imports and hash every file's
// bytes, in sorted order. Unresolvable relative specifiers (esbuild would
// fail on them too) still enter the digest as text so a specifier that
// later gains a target cannot silently reuse an old bundle.
function bundleDigestOf(entry) {
  const seen = new Set();
  const pending = [entry];
  const unresolved = [];
  // Static re-export/import forms plus the runtime forms esbuild also
  // bundles: dynamic import("./x.js") and require("./x.js").
  const specifier = String.raw`\.{1,2}\/[^"'\s]+`;
  const importRe = new RegExp(
    `(?:^|[\\s;])(?:import|export)\\b[^;]*?\\bfrom\\s*["'](${specifier})["']`
    + `|(?:^|[\\s;])import\\s*["'](${specifier})["']`
    + `|\\b(?:import|require)\\s*\\(\\s*["'](${specifier})["']`,
    "g",
  );
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const target = resolveLocalModule(file, specifier);
      if (target === null) unresolved.push(`${file} -> ${specifier}`);
      else if (!seen.has(target)) pending.push(target);
    }
  }
  const hash = createHash("sha256");
  for (const file of [...seen].sort()) hash.update(file).update(readFileSync(file));
  for (const miss of unresolved.sort()) hash.update(`unresolved:${miss}`);
  return hash;
}

const esbuildVersion = typeof esbuild.version === "string" ? esbuild.version : "unknown";

/** The private cache directory for the bundled bridge.
 *
 * Preferred: the current user's own cache directory, created 0700 and
 * re-chmod'ed (a pre-existing directory could be world-writable). A
 * symlink at the cache path would redirect the bundle — and the pilot's
 * credentials — into an attacker-controlled directory, so it is refused.
 * Fallback (symlinked path, failed permission fix, no home directory): a
 * FRESH private directory from mkdtemp (mode 0700 by default). There is
 * deliberately no shared/world-writable fallback. */
function resolveCacheDir() {
  const home = os.homedir();
  if (typeof home === "string" && home !== "") {
    const dir = path.join(home, ".cache", "pr-reviewer-action", "confidence-bridge-cache");
    try {
      const existing = lstatSync(dir, { throwIfNoEntry: false });
      if (existing !== undefined && existing.isSymbolicLink()) {
        return mkdtempSync(path.join(os.tmpdir(), "confidence-bridge-"));
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      return dir;
    } catch {
      return mkdtempSync(path.join(os.tmpdir(), "confidence-bridge-"));
    }
  }
  return mkdtempSync(path.join(os.tmpdir(), "confidence-bridge-"));
}

// The launcher's own bytes enter the digest too, so editing the esbuild
// build options below invalidates the cache alongside graph and toolchain.
const digest = bundleDigestOf(bridgeSource)
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(esbuildVersion)
  .digest("hex")
  .slice(0, 16);
const cacheDir = resolveCacheDir();
const bundlePath = path.join(cacheDir, `confidence-bridge-${digest}.cjs`);

if (!existsSync(bundlePath)) {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
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
  // bundle under the cache name. The temp file is created fresh per launch,
  // so the 0600 mode applies: the bundle carries no credential, but it is
  // the pilot's own code and stays private to its user.
  const tmpPath = `${bundlePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, result.outputFiles[0].contents, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best effort: the mode option already applies to a fresh temp file */
  }
  renameSync(tmpPath, bundlePath);
}

// The bundled bridge reads its subcommand and input path from argv; rebuild
// argv so it sees [node, confidence_bridge, <subcommand>, <infile>].
process.argv = [process.argv[0], "confidence_bridge", ...process.argv.slice(2)];
const require = createRequire(import.meta.url);
require(bundlePath);
