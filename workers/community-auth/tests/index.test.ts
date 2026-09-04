import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.ts';
import { validateAccessToken } from '../src/oauth.ts';
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

  it('rejects malformed guest token requests before using bindings', async () => {
    const response = await worker.fetch(
      new Request('https://account.example/v1/auth/guest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installation_id: 'invalid' }),
      }),
      {} as Env,
      {} as ExecutionContext,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  });

  it('issues a signed guest token after source-IP admission', async () => {
    const response = await worker.fetch(
      new Request('https://account.example/v1/auth/guest', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '192.0.2.1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ installation_id: 'a3fa9f42-9720-4716-b85d-8e4d8ae07a82' }),
      }),
      {
        GUEST_TOKEN_RATE_LIMITER: { limit: async () => ({ success: true }) },
        SESSION_SIGNING_KEY: 'test-signing-key',
      } as Env,
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    assert.equal(payload.expires_in, 15 * 60);
    assert.equal(typeof payload.access_token, 'string');
    assert.deepEqual(
      await validateAccessToken(
        'test-signing-key',
        payload.access_token as string,
        Math.floor(Date.now() / 1000),
      ),
      {
        userId: 'guest:a3fa9f42-9720-4716-b85d-8e4d8ae07a82',
        expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
        kind: 'guest',
      },
    );
  });
});
