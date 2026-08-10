import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.ts';
import { normalizeEmail } from '../src/validation.ts';

describe('community auth Worker', () => {
  it('normalizes valid email addresses and rejects malformed values', () => {
    assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
    assert.equal(normalizeEmail('invalid'), null);
    assert.equal(normalizeEmail(null), null);
  });

  it('serves a no-store health response without requiring bindings', async () => {
    const response = await worker.fetch(
      new Request('https://account.example/health'),
      {} as Env,
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'zhiyuan-community-auth' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('serves the same-origin login page with a strict page CSP', async () => {
    const response = await worker.fetch(
      new Request('https://account.example/login'),
      { TURNSTILE_SITEKEY: 'sitekey' } as Env,
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /cf-turnstile/u);
    assert.match(response.headers.get('content-security-policy') ?? '', /challenges\.cloudflare\.com/u);
  });

  it('does not expose unsupported routes', async () => {
    const response = await worker.fetch(
      new Request('https://account.example/v1/auth/email/challenges'),
      {} as Env,
      {} as ExecutionContext,
    );
    assert.equal(response.status, 404);
  });
});
