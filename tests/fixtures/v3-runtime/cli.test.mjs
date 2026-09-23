import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiPath, getRepository, run } from './cli.mjs';

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
  assert.throws(() => apiPath('forgejo', '../oops'));
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
