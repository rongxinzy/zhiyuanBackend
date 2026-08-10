import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isChallengeId, isLoginCode, verifyEmailChallenge } from '../src/challenge.ts';
import { keyedDigest } from '../src/crypto.ts';

class FakeDatabase {
  status: 'pending' | 'verified' | 'expired' | 'locked' = 'pending';
  expiresAt = 2_000;
  attempts = 0;
  readonly challengeId = '66c22b56-4c52-4a1c-9b53-bc97775b34e4';
  codeDigest = '';

  prepare(query: string): { bind: (...values: unknown[]) => { first: <T>() => Promise<T | null>; run: () => Promise<D1Result> } } {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>() => {
          if (query.includes("SET verification_status = 'verified'")) {
            const [, id, now, digest] = values as [number, string, number, string];
            if (id === this.challengeId && this.status === 'pending' && this.expiresAt > now && digest === this.codeDigest) {
              this.status = 'verified';
              return { id } as T;
            }
            return null;
          }
          if (query.startsWith('SELECT verification_status')) {
            return { verification_status: this.status, expires_at: this.expiresAt } as T;
          }
          if (query.includes('verification_attempts = verification_attempts + 1')) {
            if (this.status !== 'pending') return null;
            this.attempts += 1;
            if (this.attempts >= 5) this.status = 'locked';
            return { verification_status: this.status } as T;
          }
          return null;
        },
        run: async () => ({ success: true, meta: {} }) as D1Result,
      }),
    };
  }
}

describe('email challenge verification', () => {
  it('validates challenge IDs and codes before database work', () => {
    assert.equal(isChallengeId('66c22b56-4c52-4a1c-9b53-bc97775b34e4'), true);
    assert.equal(isChallengeId('not-a-uuid'), false);
    assert.equal(isLoginCode('012345'), true);
    assert.equal(isLoginCode('12345'), false);
  });

  it('verifies a correct code exactly once', async () => {
    const database = new FakeDatabase();
    database.codeDigest = await keyedDigest('pepper', 'otp', `${database.challengeId}:012345`);

    assert.equal(await verifyEmailChallenge(database as unknown as D1Database, 'pepper', database.challengeId, '012345', 1_000), 'verified');
    assert.equal(await verifyEmailChallenge(database as unknown as D1Database, 'pepper', database.challengeId, '012345', 1_000), 'verified');
  });

  it('locks a challenge after five wrong code attempts', async () => {
    const database = new FakeDatabase();
    database.codeDigest = await keyedDigest('pepper', 'otp', `${database.challengeId}:012345`);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(await verifyEmailChallenge(database as unknown as D1Database, 'pepper', database.challengeId, '999999', 1_000), 'invalid');
    }
    assert.equal(await verifyEmailChallenge(database as unknown as D1Database, 'pepper', database.challengeId, '999999', 1_000), 'locked');
  });
});
