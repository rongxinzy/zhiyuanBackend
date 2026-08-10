import { generateChallengeId, keyedDigest, randomBase64Url, sha256Base64Url, toBase64Url } from './crypto.ts';

const AUTHORIZATION_TTL_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DESKTOP_REDIRECT_URI = 'zhiyuan://auth/callback';
const DESKTOP_AUDIENCE = 'zhiyuan-desktop';
const ISSUER = 'https://account.rongxzyai.com';

export interface AuthorizationInput {
  redirect_uri?: unknown;
  state?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
}

export interface TokenInput {
  grant_type?: unknown;
  code?: unknown;
  code_verifier?: unknown;
  redirect_uri?: unknown;
}

export interface RefreshInput {
  grant_type?: unknown;
  refresh_token?: unknown;
}

interface AuthorizationRequest {
  id: string;
  code_challenge: string;
  redirect_uri: string;
  state: string;
  expires_at: number;
  user_id: string | null;
  authorization_code_digest: string | null;
  authorization_code_expires_at: number | null;
  authorization_code_used_at: number | null;
}

interface ChallengeIdentity {
  email_normalized: string;
  authorization_request_id: string | null;
}

interface UserRow {
  id: string;
  email_normalized: string;
}

interface RefreshSession {
  id: string;
  user_id: string;
  expires_at: number;
}

export interface UserIdentity {
  id: string;
  email: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: UserIdentity;
}

function isString(value: unknown, min: number, max: number, pattern?: RegExp): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && (!pattern || pattern.test(value));
}

export function isAuthorizationRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value);
}

export function validateAuthorizationInput(input: AuthorizationInput | null): input is Required<AuthorizationInput> {
  return Boolean(
    input &&
      input.redirect_uri === DESKTOP_REDIRECT_URI &&
      input.code_challenge_method === 'S256' &&
      isString(input.state, 16, 128, /^[A-Za-z0-9._~-]+$/u) &&
      isString(input.code_challenge, 43, 128, /^[A-Za-z0-9_-]+$/u),
  );
}

export async function createAuthorizationRequest(database: D1Database, input: Required<AuthorizationInput>, now: number): Promise<string> {
  const id = generateChallengeId();
  await database
    .prepare(
      `INSERT INTO authorization_requests (id, redirect_uri, state, code_challenge, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.redirect_uri, input.state, input.code_challenge, now, now + AUTHORIZATION_TTL_SECONDS)
    .run();
  return id;
}

export async function validateAuthorizationRequest(database: D1Database, id: string, now: number): Promise<boolean> {
  if (!isAuthorizationRequestId(id)) return false;
  const request = await database
    .prepare('SELECT id FROM authorization_requests WHERE id = ? AND expires_at > ? AND authorization_code_used_at IS NULL')
    .bind(id, now)
    .first<{ id: string }>();
  return Boolean(request);
}

export async function completeAuthorization(
  database: D1Database,
  pepper: string,
  challengeId: string,
  now: number,
): Promise<{ redirect_to: string } | null> {
  const challenge = await database
    .prepare(
      `SELECT email_normalized, authorization_request_id
       FROM email_challenges
       WHERE id = ? AND verification_status = 'verified'`,
    )
    .bind(challengeId)
    .first<ChallengeIdentity>();
  if (!challenge?.authorization_request_id) return null;

  const request = await database
    .prepare(
      `SELECT id, code_challenge, redirect_uri, state, expires_at, user_id,
              authorization_code_digest, authorization_code_expires_at, authorization_code_used_at
       FROM authorization_requests WHERE id = ?`,
    )
    .bind(challenge.authorization_request_id)
    .first<AuthorizationRequest>();
  if (!request || request.expires_at <= now || request.authorization_code_used_at) return null;

  const user = await database
    .prepare(
      `INSERT INTO users (id, email_normalized, created_at, last_login_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email_normalized) DO UPDATE SET last_login_at = excluded.last_login_at
       RETURNING id, email_normalized`,
    )
    .bind(generateChallengeId(), challenge.email_normalized, now, now)
    .first<UserRow>();
  if (!user) throw new Error('user_upsert_failed');

  const code = `${request.id}.${randomBase64Url(32)}`;
  const digest = await keyedDigest(pepper, 'authorization-code', code);
  const saved = await database
    .prepare(
      `UPDATE authorization_requests
       SET user_id = ?, authorization_code_digest = ?, authorization_code_expires_at = ?
       WHERE id = ? AND expires_at > ? AND authorization_code_used_at IS NULL
       RETURNING id`,
    )
    .bind(user.id, digest, now + AUTHORIZATION_CODE_TTL_SECONDS, request.id, now)
    .first<{ id: string }>();
  if (!saved) return null;

  const redirect = new URL(request.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', request.state);
  return { redirect_to: redirect.toString() };
}

function parseAuthorizationCode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/iu.test(value);
}

export async function exchangeAuthorizationCode(
  database: D1Database,
  pepper: string,
  signingKey: string,
  input: TokenInput | null,
  now: number,
): Promise<TokenSet | null> {
  if (
    !input ||
    input.grant_type !== 'authorization_code' ||
    input.redirect_uri !== DESKTOP_REDIRECT_URI ||
    !parseAuthorizationCode(input.code) ||
    !isString(input.code_verifier, 43, 128, /^[A-Za-z0-9._~-]+$/u)
  ) {
    return null;
  }
  const requestId = input.code.slice(0, 36);
  const request = await database
    .prepare(
      `SELECT id, code_challenge, redirect_uri, state, expires_at, user_id,
              authorization_code_digest, authorization_code_expires_at, authorization_code_used_at
       FROM authorization_requests WHERE id = ?`,
    )
    .bind(requestId)
    .first<AuthorizationRequest>();
  const expectedDigest = await keyedDigest(pepper, 'authorization-code', input.code);
  if (
    !request ||
    !request.user_id ||
    !request.authorization_code_digest ||
    request.redirect_uri !== input.redirect_uri ||
    request.authorization_code_expires_at === null ||
    request.authorization_code_expires_at <= now ||
    request.authorization_code_used_at ||
    (await sha256Base64Url(input.code_verifier)) !== request.code_challenge ||
    expectedDigest !== request.authorization_code_digest
  ) {
    return null;
  }
  const used = await database
    .prepare(
      `UPDATE authorization_requests SET authorization_code_used_at = ?
       WHERE id = ? AND authorization_code_digest = ? AND authorization_code_used_at IS NULL AND authorization_code_expires_at > ?
       RETURNING user_id`,
    )
    .bind(now, request.id, expectedDigest, now)
    .first<{ user_id: string }>();
  if (!used) return null;
  const user = await database.prepare('SELECT id, email_normalized FROM users WHERE id = ?').bind(used.user_id).first<UserRow>();
  if (!user) return null;
  return issueTokens(database, pepper, signingKey, user, now);
}

export async function refreshTokens(
  database: D1Database,
  pepper: string,
  signingKey: string,
  input: RefreshInput | null,
  now: number,
): Promise<TokenSet | null> {
  if (!input || input.grant_type !== 'refresh_token' || !isString(input.refresh_token, 43, 128, /^[A-Za-z0-9_-]+$/u)) return null;
  const digest = await keyedDigest(pepper, 'refresh-token', input.refresh_token);
  const session = await database
    .prepare('SELECT id, user_id, expires_at FROM refresh_sessions WHERE token_digest = ? AND revoked_at IS NULL')
    .bind(digest)
    .first<RefreshSession>();
  if (!session || session.expires_at <= now) return null;
  const revoked = await database
    .prepare('UPDATE refresh_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING user_id')
    .bind(now, session.id)
    .first<{ user_id: string }>();
  if (!revoked) return null;
  const user = await database.prepare('SELECT id, email_normalized FROM users WHERE id = ?').bind(revoked.user_id).first<UserRow>();
  if (!user) return null;
  return issueTokens(database, pepper, signingKey, user, now);
}

async function issueTokens(database: D1Database, pepper: string, signingKey: string, user: UserRow, now: number): Promise<TokenSet> {
  const refreshToken = randomBase64Url(32);
  const refreshDigest = await keyedDigest(pepper, 'refresh-token', refreshToken);
  const refreshId = generateChallengeId();
  await database
    .prepare('INSERT INTO refresh_sessions (id, user_id, token_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(refreshId, user.id, refreshDigest, now, now + REFRESH_TOKEN_TTL_SECONDS)
    .run();
  return {
    access_token: await signAccessToken(signingKey, user, now),
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user: { id: user.id, email: user.email_normalized },
  };
}

async function signAccessToken(signingKey: string, user: UserRow, now: number): Promise<string> {
  const header = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ iss: ISSUER, aud: DESKTOP_AUDIENCE, sub: user.id, email: user.email_normalized, iat: now, exp: now + ACCESS_TOKEN_TTL_SECONDS, jti: generateChallengeId() }),
    ),
  );
  const signature = await keyedDigest(signingKey, 'jwt', `${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}
