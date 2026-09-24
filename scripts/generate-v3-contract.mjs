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
