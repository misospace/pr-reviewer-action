import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiPath, getRepository, resolveSpikeContext, run, runWithFinalizer } from './cli.mjs';

test('platform routing and authentication stay in the adapter', async () => {
  for (const [platform, path, auth] of [
    ['github', '/repos/owner/repo', 'Bearer secret'],
    ['forgejo', '/api/v1/repos/owner/repo', 'token secret'],
  ]) {
    const repo = await getRepository({ platform, repository: 'owner/repo', server: 'https://example.test', token: 'secret',
      request: async (url, options) => {
        assert.equal(url.pathname, path);
        assert.equal(options.headers.Authorization, auth);
        return { ok: true, json: async () => ({ full_name: 'owner/repo' }) };
      },
    });
    assert.equal(repo.fullName, 'owner/repo');
  }
  assert.throws(() => apiPath('other', 'owner/repo'));
});

test('spike context defaults to github and switches server/platform for forgejo', () => {
  assert.deepEqual(resolveSpikeContext({ GITHUB_API_URL: 'https://api.test' }),
    { server: 'https://api.test', platform: 'github' });
  assert.deepEqual(resolveSpikeContext({ GITHUB_SERVER_URL: 'https://forgejo.test', SPIKE_PLATFORM: 'forgejo' }),
    { server: 'https://forgejo.test', platform: 'forgejo' });
  assert.deepEqual(resolveSpikeContext({ SPIKE_PLATFORM: 'github' }),
    { server: undefined, platform: 'github' });
  assert.deepEqual(resolveSpikeContext({ GITHUB_API_URL: 'https://api.test', GITHUB_SERVER_URL: 'https://forgejo.test' }),
    { server: 'https://api.test', platform: 'github' });
  assert.deepEqual(resolveSpikeContext({ GITHUB_API_URL: 'https://api.test', SPIKE_PLATFORM: 'forgejo' }),
    { server: 'https://api.test', platform: 'forgejo' });
  assert.deepEqual(resolveSpikeContext({ GITHUB_SERVER_URL: 'https://forgejo.test', SPIKE_PLATFORM: '' }),
    { server: 'https://forgejo.test', platform: 'github' });
  for (const unknown of ['gitea', 'forgejo-ee', 'GitHub']) {
    assert.throws(() => resolveSpikeContext({ SPIKE_PLATFORM: unknown }), /Unknown SPIKE_PLATFORM/, unknown);
  }
  for (const badServer of ['not-a-url', 'ftp://example.test', 'http://host:31095/api\nEVIL', 'http://host\u0000/']) {
    assert.throws(() => resolveSpikeContext({ GITHUB_API_URL: badServer }), /Unusable server URL/, badServer);
  }
  for (const okServer of ['http://host.docker.internal:31095', 'https://api.github.com', 'http://host:31095/']) {
    assert.equal(resolveSpikeContext({ GITHUB_API_URL: okServer }).server, okServer, okServer);
  }
});

test('repository components remain literal URL path segments', () => {
  for (const repository of ['owner/repo', '.owner/repo', 'owner/.github']) {
    const path = apiPath('github', repository);
    assert.equal(new URL(path, 'https://example.test').pathname, path);
  }
  for (const repository of [
    './repo', 'owner/.', '../repo', 'owner/..', 'owner/../repo',
    '/repo', 'owner/', 'owner/repo/extra',
    'owner/%2e%2e', 'owner/%2F', 'owner/repo\0', 'owner/repo\n',
  ]) {
    assert.throws(() => apiPath('github', repository), /Invalid repository/, repository);
  }
});

test('argv execution captures stderr and timeout reaps the leader', async () => {
  const result = await run(process.execPath, ['-e', 'console.error("error");console.log("ok")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'ok');
  assert.equal(result.stderr.trim(), 'error');
  const hung = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
  assert.equal(hung.timedOut, true);
  assert.notEqual(hung.code, 0);
});

test('a timed-out POSIX child and grandchild are terminated', { skip: process.platform === 'win32' }, async () => {
  const hung = await run('sh', ['-c', 'sleep 90 & echo "grandchild=$!"; wait'], {
    env: { PATH: process.env.PATH }, timeoutMs: 300,
  });
  const grandchild = Number(hung.stdout.match(/grandchild=(\d+)/)?.[1]);
  assert.ok(grandchild, `missing grandchild PID: ${hung.stdout}`);
  assert.equal(hung.timedOut, true);
  assert.notEqual(hung.code, 0);

  for (let attempt = 0; attempt < 10; attempt++) {
    const status = await run('ps', ['-o', 'stat=', '-p', String(grandchild)], {
      env: { PATH: process.env.PATH },
    });
    if (status.code !== 0 || status.stdout.trim().startsWith('Z')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`grandchild ${grandchild} still running after group timeout`);
});

test('an intentional failure still runs the finalizer', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'v3-runtime-finalizer-'));
  const originalTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = temp;
  try {
    await assert.rejects(
      runWithFinalizer({ mode: 'unit', fail: true }, async () => {}),
      /intentional spike failure/,
    );
    assert.equal(await readFile(join(temp, 'v3-unit-failure-finalized'), 'utf8'), 'finalized\n');
  } finally {
    if (originalTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = originalTemp;
    await rm(temp, { recursive: true, force: true });
  }
});
