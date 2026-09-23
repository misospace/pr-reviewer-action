import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const parsed = parse(readFileSync('contracts/action-v3.yml', 'utf8'));
mkdirSync('.v3-generated', { recursive: true });
const generated = `// Generated from contracts/action-v3.yml; do not edit.\nexport const V3_CONTRACT = ${JSON.stringify(parsed, null, 2)} as const;\n`;
writeFileSync('.v3-generated/contract.generated.ts', generated);
