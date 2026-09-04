import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { keyedDigest, toBase64Url } from '../src/crypto.ts';
import { validateAccessToken } from '../src/oauth.ts';

const SIGNING_KEY = 'test-signing-key';
const NOW = 1_800_000_000;
const USER_ID = '66c22b56-4c52-4a1c-9b53-bc97775b34e4';
const TOKEN_ID = 'a3fa9f42-9720-4716-b85d-8e4d8ae07a82';

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
  const encoder = new TextEncoder();
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        iss: 'https://account.rongxzyai.com',
        aud: 'zhiyuan-desktop',
        sub: USER_ID,
        email: 'user@example.com',
        iat: NOW,
        exp: NOW + 15 * 60,
        jti: TOKEN_ID,
        ...overrides,
      }),
    ),
  );
  const signature = await keyedDigest(SIGNING_KEY, 'jwt', `${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

describe('access token validation', () => {
  it('returns the authenticated identity for a valid token', async () => {
    assert.deepEqual(await validateAccessToken(SIGNING_KEY, await token(), NOW + 1), {
      userId: USER_ID,
      email: 'user@example.com',
      expiresAt: NOW + 15 * 60,
    });
  });

  it('rejects expired, mis-scoped, malformed, and tampered tokens', async () => {
    assert.equal(await validateAccessToken(SIGNING_KEY, await token({ exp: NOW }), NOW), null);
    assert.equal(await validateAccessToken(SIGNING_KEY, await token({ aud: 'another-client' }), NOW), null);
    assert.equal(await validateAccessToken(SIGNING_KEY, 'not-a-token', NOW), null);

    const valid = await token();
    assert.equal(await validateAccessToken(SIGNING_KEY, `${valid.slice(0, -1)}x`, NOW), null);
  });
});
