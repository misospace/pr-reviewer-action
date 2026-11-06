import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

// #1456: the generated-asset directory is cleared by the build entry point
// (scripts/clean-generated-assets.mjs) before the generators run. A compiled
// shadow next to a source asset wins esbuild's module resolution, so the
// bundle would carry stale bytes; refuse to build when one survived.
if (existsSync('.v3-generated')) {
  for (const entry of readdirSync('.v3-generated')) {
    if (!entry.endsWith('.ts')) {
      throw new Error(`.v3-generated/${entry} is not a source asset; a compiled shadow would shadow it during bundling`);
    }
  }
}

const output = await build({
  entryPoints: ['src/index.ts'],
  tsconfig: 'tsconfig.build.json',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/index.js',
  sourcemap: false,
  legalComments: 'none',
  minify: true,
  metafile: false,
  write: false,
});
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', output.outputFiles[0].contents);
