import { runWithFinalizer } from '../cli.mjs';
import { fileURLToPath } from 'node:url';

const token = process.env.INPUT_TOKEN;
console.log('::add-mask::' + token);
console.log('::add-mask::v3-spike-mask-probe');
console.log('mask probe: v3-spike-mask-probe');
await runWithFinalizer({
  actionPath: fileURLToPath(new URL('..', import.meta.url)),
  workspace: process.env.GITHUB_WORKSPACE,
  input: process.env['INPUT_TEST-KEBAB-INPUT'],
  outputFile: process.env.GITHUB_OUTPUT,
  summaryFile: process.env.GITHUB_STEP_SUMMARY,
  eventPath: process.env.GITHUB_EVENT_PATH,
  repository: process.env.GITHUB_REPOSITORY,
  server: process.env.GITHUB_API_URL,
  token,
  mode: 'native',
  fail: process.env.INPUT_FAIL === 'true',
});
