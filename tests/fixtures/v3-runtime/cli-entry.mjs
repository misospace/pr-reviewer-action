import { runWithFinalizer } from './cli.mjs';

const token = process.env.SPIKE_TOKEN;
console.log('::add-mask::' + token);
console.log('::add-mask::v3-spike-mask-probe');
console.log('mask probe: v3-spike-mask-probe');
await runWithFinalizer({
  actionPath: new URL('.', import.meta.url).pathname,
  workspace: process.env.GITHUB_WORKSPACE,
  input: process.env.SPIKE_INPUT,
  outputFile: process.env.GITHUB_OUTPUT,
  summaryFile: process.env.GITHUB_STEP_SUMMARY,
  eventPath: process.env.GITHUB_EVENT_PATH,
  repository: process.env.GITHUB_REPOSITORY,
  server: process.env.GITHUB_API_URL,
  token,
  mode: 'composite',
  fail: process.env.SPIKE_FAIL === 'true',
});
