import { writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const output = await build({
  entryPoints: ['src/index.ts'],
  tsconfig: 'tsconfig.build.json',
  bundle: true,
  platform: 'node',
  target: 'node24',
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
