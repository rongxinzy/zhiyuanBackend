import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyTurnstile } from '../src/turnstile.ts';

describe('Turnstile validation', () => {
  it('requires success, the expected hostname, and the expected action', async () => {
    const validFetcher: typeof fetch = async () =>
      Response.json({ success: true, hostname: 'account.rongxzyai.com', action: 'login-email-challenge' });
    const wrongHostFetcher: typeof fetch = async () =>
      Response.json({ success: true, hostname: 'attacker.example', action: 'login-email-challenge' });

    assert.equal(
      await verifyTurnstile(
        'secret',
        'token',
        '192.0.2.1',
        'account.rongxzyai.com',
        'login-email-challenge',
        validFetcher,
      ),
      true,
    );
    assert.equal(
      await verifyTurnstile(
        'secret',
        'token',
        null,
        'account.rongxzyai.com',
        'login-email-challenge',
        wrongHostFetcher,
      ),
      false,
    );
  });

  it('fails closed when siteverify is unavailable', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('unavailable');
    };
    assert.equal(
      await verifyTurnstile('secret', 'token', null, 'account.rongxzyai.com', 'login-email-challenge', fetcher),
      false,
    );
  });
});
