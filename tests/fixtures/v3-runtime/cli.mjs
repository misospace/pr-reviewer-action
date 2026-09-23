import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function apiPath(platform, repository) {
  const segments = typeof repository === 'string' ? repository.split('/') : [];
  if (segments.length !== 2 || segments.some((segment) =>
    !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('Invalid repository');
  }
  if (platform === 'github') return `/repos/${repository}`;
  if (platform === 'forgejo') return `/api/v1/repos/${repository}`;
  throw new Error('Unknown platform');
}

export async function getRepository({ platform, repository, server, token, request = fetch }) {
  const url = new URL(apiPath(platform, repository), server);
  const response = await request(url, {
    headers: { Authorization: platform === 'forgejo' ? `token ${token}` : `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Repository lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  return { fullName: data.full_name };
}

export function run(file, args, { cwd, env, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const group = process.platform !== 'win32' ? -child.pid : child.pid;
    let timeoutTimer;
    let forceTimer;
    const signal = (name) => {
      try { process.kill(group, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const cleanup = () => { clearTimeout(timeoutTimer); clearTimeout(forceTimer); };
    timeoutTimer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, timeoutMs);
    forceTimer = setTimeout(() => { if (!settled) signal('SIGKILL'); }, timeoutMs + 500);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code, exitSignal) => {
      settled = true;
      cleanup();
      resolve({ code, exitSignal, stdout, stderr, timedOut });
    });
  });
}

export function resolveSpikeContext(env = process.env) {
  const requested = env.SPIKE_PLATFORM;
  if (requested !== undefined && requested !== '' && requested !== 'github' && requested !== 'forgejo') {
    throw new Error(`Unknown SPIKE_PLATFORM '${requested}' (closed set: github, forgejo)`);
  }
  return {
    server: env.GITHUB_API_URL || env.GITHUB_SERVER_URL,
    platform: requested === 'forgejo' ? 'forgejo' : 'github',
  };
}

export async function main({ actionPath, workspace, input, outputFile, summaryFile, eventPath, repository, server, token, mode, platform }) {
  if (input !== 'kebab-value') throw new Error('Kebab input mismatch');
  const marker = (await readFile(join(actionPath, 'marker.txt'), 'utf8')).trim();
  if (marker !== 'bundled-action-file') throw new Error('Action path mismatch');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const identity = event.pull_request?.number ?? event.number ?? event.repository?.full_name;
  if (!repository || !identity) throw new Error('Missing event identity');
  const git = await run('git', ['rev-parse', '--show-toplevel'], {
    cwd: workspace, env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (git.code !== 0 || git.stdout.trim() !== workspace || git.stderr) throw new Error(`Workspace git failed: ${git.stderr}`);
  const repo = await getRepository({ platform: platform ?? 'github', repository, server, token });
  if (repo.fullName !== repository) throw new Error('Platform response mismatch');

  // A group-scoped TERM reaches both the shell and its grandchild.
  const hung = await run('sh', ['-c', 'sleep 90 & echo "grandchild=$!"; wait'], {
    cwd: workspace, env: { PATH: process.env.PATH }, timeoutMs: 250,
  });
  const grandchild = Number(hung.stdout.match(/grandchild=(\d+)/)?.[1]);
  if (!hung.timedOut || hung.code === 0 || !grandchild) throw new Error('Hung process survived timeout');
  try {
    process.kill(grandchild, 0);
    // Linux may leave a terminated, adopted grandchild as a zombie briefly.
    const state = (await readFile(`/proc/${grandchild}/stat`, 'utf8')).split(' ')[2];
    if (state !== 'Z') throw new Error('Grandchild is still running');
    console.log('spike: grandchild terminated; adopted zombie observed');
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
    console.log('spike: grandchild terminated and no longer exists');
  }
  await appendFile(outputFile, `test-kebab-output=${mode}-passed\n`);
  await appendFile(summaryFile, `### v3 runtime ${mode}\nInput, event, API, git, timeout checked.\n`);
  if (!(await readFile(summaryFile, 'utf8')).includes(`### v3 runtime ${mode}`)) throw new Error('Step summary missing');
  console.log(`spike ${mode}: node ${process.version}, input/output, action path, workspace, event ${identity}, API, git argv, timeout passed`);
}

export async function runWithFinalizer(options, execute = main) {
  try {
    await execute(options);
    if (options.fail) throw new Error('intentional spike failure');
  } finally {
    await writeFile(join(process.env.RUNNER_TEMP, `v3-${options.mode}-${options.fail ? 'failure' : 'success'}-finalized`), 'finalized\n');
    console.log(`spike ${options.mode}: finalizer ran`);
  }
}
