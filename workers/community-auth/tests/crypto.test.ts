import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateLoginCode, keyedDigest } from '../src/crypto.ts';

describe('login code cryptography', () => {
  it('generates fixed-width numeric login codes', () => {
    for (let index = 0; index < 100; index += 1) assert.match(generateLoginCode(), /^\d{6}$/u);
  });

  it('domain-separates keyed digests', async () => {
    const email = await keyedDigest('test-secret', 'email', 'user@example.com');
    const otp = await keyedDigest('test-secret', 'otp', 'user@example.com');
    assert.notEqual(email, otp);
    assert.equal(email, await keyedDigest('test-secret', 'email', 'user@example.com'));
  });
});
