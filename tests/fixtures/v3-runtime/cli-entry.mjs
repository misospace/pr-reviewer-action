import { resolveSpikeContext, runWithFinalizer } from './cli.mjs';
import { fileURLToPath } from 'node:url';

const token = process.env.SPIKE_TOKEN;
console.log('::add-mask::' + token);
console.log('::add-mask::v3-spike-mask-probe');
console.log('mask probe: v3-spike-mask-probe');
await runWithFinalizer({
  actionPath: fileURLToPath(new URL('.', import.meta.url)),
  workspace: process.env.GITHUB_WORKSPACE,
  input: process.env.SPIKE_INPUT,
  outputFile: process.env.GITHUB_OUTPUT,
  summaryFile: process.env.GITHUB_STEP_SUMMARY,
  eventPath: process.env.GITHUB_EVENT_PATH,
  repository: process.env.GITHUB_REPOSITORY,
  token,
  mode: 'composite',
  fail: process.env.SPIKE_FAIL === 'true',
  ...resolveSpikeContext(process.env),
});
