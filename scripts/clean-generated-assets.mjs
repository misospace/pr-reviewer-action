#!/usr/bin/env node
// #1456: the generated-asset directory belongs to the build entry point.
//
// `.v3-generated/` is cleared before the generators run, so a bundle can never
// carry a stale asset. A compiled shadow (a leftover .js next to a source
// asset) wins esbuild's module resolution and would be embedded silently, and
// the asset of a generator that stopped running would be embedded silently
// too. The generators themselves never delete an asset they do not own: the
// node suite runs a generator in the repository root, and a whole-directory
// wipe there deleted the action-source asset the Python suite compiles
// against right after ("Cannot find module
// '../.v3-generated/action-source.generated.js'").
//
// The path is relative to the working directory, like the contract
// generator's inputs, and npm runs every script at the package root.
import { rmSync } from 'node:fs';

rmSync('.v3-generated', { recursive: true, force: true });
