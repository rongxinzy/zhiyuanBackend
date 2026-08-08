import { keyedDigest } from './crypto.ts';

const MAX_VERIFICATION_ATTEMPTS = 5;

export type VerificationResult = 'verified' | 'expired' | 'locked' | 'invalid';

interface ChallengeState {
  verification_status: 'pending' | 'verified' | 'expired' | 'locked';
  expires_at: number;
}

export function isChallengeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function isLoginCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/u.test(value);
}

export async function verifyEmailChallenge(
  database: D1Database,
  pepper: string,
  challengeId: string,
  code: string,
  now: number,
): Promise<VerificationResult> {
  const codeDigest = await keyedDigest(pepper, 'otp', `${challengeId}:${code}`);
  const verified = await database
    .prepare(
      `UPDATE email_challenges
       SET verification_status = 'verified', verified_at = ?
       WHERE id = ?
         AND verification_status = 'pending'
         AND delivery_status IN ('sent', 'unknown')
         AND expires_at > ?
         AND code_digest = ?
       RETURNING id`,
    )
    .bind(now, challengeId, now, codeDigest)
    .first<{ id: string }>();
  if (verified) return 'verified';

  const state = await database
    .prepare('SELECT verification_status, expires_at FROM email_challenges WHERE id = ?')
    .bind(challengeId)
    .first<ChallengeState>();
  if (!state) return 'invalid';
  if (state.verification_status === 'verified') return 'verified';
  if (state.verification_status === 'locked') return 'locked';

  if (state.expires_at <= now) {
    await database
      .prepare("UPDATE email_challenges SET verification_status = 'expired' WHERE id = ? AND verification_status = 'pending'")
      .bind(challengeId)
      .run();
    return 'expired';
  }

  const attempts = await database
    .prepare(
      `UPDATE email_challenges
       SET verification_attempts = verification_attempts + 1,
           verification_status = CASE
             WHEN verification_attempts + 1 >= ? THEN 'locked'
             ELSE verification_status
           END
       WHERE id = ? AND verification_status = 'pending'
       RETURNING verification_status`,
    )
    .bind(MAX_VERIFICATION_ATTEMPTS, challengeId)
    .first<{ verification_status: ChallengeState['verification_status'] }>();
  return attempts?.verification_status === 'locked' ? 'locked' : 'invalid';
}
