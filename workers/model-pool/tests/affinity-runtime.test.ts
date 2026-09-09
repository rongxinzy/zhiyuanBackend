import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { unstable_dev } from 'wrangler';

test('real Durable Object RPC honors affinity, health, quota and selection exclusion', async t => {
  const worker = await unstable_dev(
    fileURLToPath(new URL('./fixtures/affinity-worker.ts', import.meta.url)),
    {
      config: fileURLToPath(new URL('./fixtures/wrangler.jsonc', import.meta.url)),
      local: true,
      persist: false,
      port: 0,
      inspectorPort: 0,
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    },
  );
  t.after(() => worker.stop());
  const response = await worker.fetch(`/${crypto.randomUUID()}`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    first: 'key-1',
    sticky: 'key-1',
    excluded: 'key-2',
    migrated: 'key-2',
    selectedCount: 1,
    storedAlias: 'key-2',
    exhausted: null,
    recovered: 'key-2',
  });
  const http = await worker.fetch('/http');
  assert.equal(http.status, 200, await http.clone().text());
  assert.deepEqual(await http.json(), {
    first: 200,
    second: 200,
    busy: 503,
    retryAfter: '2',
    remaining: '8',
    chatCalls: ['@cf/test/primary', '@cf/test/fallback', '@cf/test/fallback'],
    workCalls: ['@cf/test/primary', '@cf/test/fallback'],
    rejected: 400,
    storedModel: '@cf/test/fallback',
    recovery: Array.from({ length: 3 }, () => ({
      status: 200,
      calls: ['@cf/test/primary', '@cf/test/fallback'],
      content: 'hello',
    })),
  });
});
