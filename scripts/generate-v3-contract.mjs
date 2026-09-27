import { readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

const parsed = parse(readFileSync('contracts/action-v3.yml', 'utf8'));
mkdirSync('.v3-generated', { recursive: true });
// .v3-generated is fully generated and gitignored; clear it first so stale
// leftovers (e.g. a CJS contract.generated.js from an older generator) can
// never shadow the freshly written .ts during esbuild module resolution —
// that divergence makes the CI rebuild differ from the committed bundle.
if (existsSync('.v3-generated')) {
  for (const entry of readdirSync('.v3-generated')) {
    rmSync(`.v3-generated/${entry}`, { recursive: true, force: true });
  }
}
const generated = `// Generated from contracts/action-v3.yml; do not edit.\nexport const V3_CONTRACT = ${JSON.stringify(parsed, null, 2)} as const;\n`;
writeFileSync('.v3-generated/contract.generated.ts', generated);

// #706 PR 4: the bundled system prompt and its fragments ship inside dist the
// same way the contract does, so `dist/index.js` never reads scripts/ at
// runtime (a consumer's checkout is the cwd, not this repository). Raw file
// text is embedded unmodified; bash-equivalent trailing-newline stripping
// happens at use in src/prompt/system-prompt.ts.
const fragmentDir = 'scripts/prompt_fragments';
const fragments = Object.fromEntries(
  readdirSync(fragmentDir)
    .filter((name) => name.endsWith('.txt'))
    .sort()
    .map((name) => [name.slice(0, -'.txt'.length), readFileSync(`${fragmentDir}/${name}`, 'utf8')]),
);
const promptAssets = [
  '// Generated from scripts/default_system_prompt.txt and scripts/prompt_fragments/*.txt; do not edit.',
  `export const DEFAULT_SYSTEM_PROMPT_TEXT: string = ${JSON.stringify(readFileSync('scripts/default_system_prompt.txt', 'utf8'))};`,
  `export const PROMPT_FRAGMENT_TEXTS: Readonly<Record<string, string>> = ${JSON.stringify(fragments, null, 2)};`,
  '',
].join('\n');
writeFileSync('.v3-generated/prompt-assets.generated.ts', promptAssets);
