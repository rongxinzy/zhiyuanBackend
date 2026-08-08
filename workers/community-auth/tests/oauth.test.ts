import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Base64Url } from '../src/crypto.ts';
import { isAuthorizationRequestId, validateAuthorizationInput } from '../src/oauth.ts';

describe('desktop PKCE authorization requests', () => {
  it('accepts only the official desktop redirect and S256 PKCE fields', () => {
    assert.equal(
      validateAuthorizationInput({
        redirect_uri: 'zhiyuan://auth/callback',
        state: 'x'.repeat(43),
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      }),
      true,
    );
    assert.equal(
      validateAuthorizationInput({
        redirect_uri: 'https://example.com/callback',
        state: 'x'.repeat(43),
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      }),
      false,
    );
  });

  it('uses the RFC 7636 S256 derivation', async () => {
    assert.equal(
      await sha256Base64Url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('only accepts UUID authorization request identifiers', () => {
    assert.equal(isAuthorizationRequestId('66c22b56-4c52-4a1c-9b53-bc97775b34e4'), true);
    assert.equal(isAuthorizationRequestId('not-a-request'), false);
  });
});
