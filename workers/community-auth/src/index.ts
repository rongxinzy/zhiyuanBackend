import { generateChallengeId, generateLoginCode, keyedDigest } from './crypto.ts';
import { isChallengeId, isLoginCode, verifyEmailChallenge } from './challenge.ts';
import { buildLoginEmail, ResendError, sendWithResend } from './email.ts';
import { LOGIN_CSS, LOGIN_JS, loginPage } from './login-page.ts';
import {
  completeAuthorization,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  isAuthorizationRequestId,
  refreshTokens,
  validateAuthorizationInput,
  validateAuthorizationRequest,
  type AuthorizationInput,
  type RefreshInput,
  type TokenInput,
} from './oauth.ts';
import { verifyTurnstile } from './turnstile.ts';
import { normalizeEmail } from './validation.ts';

const CODE_TTL_SECONDS = 10 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;
const MAX_BODY_BYTES = 4_096;

interface ChallengeRequest {
  email?: unknown;
  turnstile_token?: unknown;
  authorization_request_id?: unknown;
}

interface VerificationRequest {
  code?: unknown;
}

function json(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(payload, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function asset(content: string, contentType: string): Response {
  return new Response(content, {
    headers: {
      'cache-control': 'no-store',
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
    },
  });
}

function page(sitekey: string, initialStatus?: string, authorizationRequestId?: string): Response {
  return new Response(loginPage(sitekey, initialStatus, authorizationRequestId), {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; img-src 'self' data:; script-src 'self' https://challenges.cloudflare.com; style-src 'self'",
      'content-type': 'text/html; charset=UTF-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function parseRequest(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function createChallenge(request: Request, env: Env): Promise<Response> {
  const requestBody = (await parseRequest(request)) as ChallengeRequest | null;
  const email = normalizeEmail(requestBody?.email);
  const turnstileToken = typeof requestBody?.turnstile_token === 'string' ? requestBody.turnstile_token : '';
  if (!email || !turnstileToken) return json({ error: 'invalid_request' }, 400);

  const authorizationRequestId = requestBody?.authorization_request_id;
  if (authorizationRequestId !== undefined) {
    if (!isAuthorizationRequestId(authorizationRequestId)) return json({ error: 'invalid_request' }, 400);
    if (!(await validateAuthorizationRequest(env.AUTH_DB, authorizationRequestId, Math.floor(Date.now() / 1000)))) {
      return json({ error: 'login_request_expired' }, 400);
    }
  }

  const remoteIp = request.headers.get('cf-connecting-ip');
  const ipKey = remoteIp ?? 'unknown';
  const ipLimit = await env.IP_RATE_LIMITER.limit({ key: ipKey });
  if (!ipLimit.success) return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429, { 'retry-after': '60' });

  const human = await verifyTurnstile(
    env.TURNSTILE_SECRET_KEY,
    turnstileToken,
    remoteIp,
    env.TURNSTILE_EXPECTED_HOSTNAME,
    env.TURNSTILE_EXPECTED_ACTION,
  );
  if (!human) return json({ error: 'turnstile_failed' }, 400);

  const emailHash = await keyedDigest(env.OTP_PEPPER, 'email', email);
  const emailLimit = await env.EMAIL_RATE_LIMITER.limit({ key: emailHash });
  if (!emailLimit.success) return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429, { 'retry-after': '60' });

  const challengeId = generateChallengeId();
  const code = generateLoginCode();
  const codeDigest = await keyedDigest(env.OTP_PEPPER, 'otp', `${challengeId}:${code}`);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + CODE_TTL_SECONDS;

  const inserted = await env.AUTH_DB.prepare(
    `INSERT INTO email_challenges (
       id, email_normalized, email_hash, code_digest, delivery_status, authorization_request_id, created_at, expires_at
     )
     SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM email_challenges
       WHERE email_hash = ?
         AND created_at > ?
         AND delivery_status IN ('pending', 'sent', 'unknown')
     )
     AND (
       SELECT COUNT(*) FROM email_challenges
       WHERE email_hash = ?
         AND created_at > ?
         AND delivery_status IN ('pending', 'sent', 'unknown')
     ) < ?
     RETURNING id`,
  )
    .bind(
      challengeId,
      email,
      emailHash,
      codeDigest,
      authorizationRequestId ?? null,
      now,
      expiresAt,
      emailHash,
      now - RESEND_COOLDOWN_SECONDS,
      emailHash,
      now - 60 * 60,
      MAX_SENDS_PER_HOUR,
    )
    .first<{ id: string }>();

  if (!inserted) return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429, { 'retry-after': '60' });

  try {
    const result = await sendWithResend(
      env.RESEND_API_KEY,
      `login-code/${challengeId}`,
      buildLoginEmail(env.LOGIN_EMAIL_FROM, email, code),
    );
    await env.AUTH_DB.prepare(
      "UPDATE email_challenges SET delivery_status = 'sent', resend_message_id = ?, sent_at = ? WHERE id = ?",
    )
      .bind(result.id, Math.floor(Date.now() / 1000), challengeId)
      .run();
  } catch (error) {
    const deliveryStatus = error instanceof ResendError && error.deliveryMayHaveSucceeded ? 'unknown' : 'failed';
    await env.AUTH_DB.prepare('UPDATE email_challenges SET delivery_status = ? WHERE id = ?')
      .bind(deliveryStatus, challengeId)
      .run();
    console.error(JSON.stringify({ event: 'login_email_send_failed', challenge_id: challengeId, delivery_status: deliveryStatus }));
    return json({ error: 'email_delivery_unavailable' }, 503, { 'retry-after': '60' });
  }

  console.log(JSON.stringify({ event: 'login_email_sent', challenge_id: challengeId, email_hash: emailHash.slice(0, 16) }));
  return json(
    {
      ok: true,
      challenge_id: challengeId,
      expires_in_seconds: CODE_TTL_SECONDS,
      resend_after_seconds: RESEND_COOLDOWN_SECONDS,
    },
    202,
  );
}

async function verifyChallenge(request: Request, env: Env, challengeId: string): Promise<Response> {
  const requestBody = (await parseRequest(request)) as VerificationRequest | null;
  if (!isChallengeId(challengeId) || !isLoginCode(requestBody?.code)) return json({ error: 'invalid_request' }, 400);

  const result = await verifyEmailChallenge(
    env.AUTH_DB,
    env.OTP_PEPPER,
    challengeId,
    requestBody.code,
    Math.floor(Date.now() / 1000),
  );
  if (result === 'verified') {
    const completion = await completeAuthorization(env.AUTH_DB, env.OTP_PEPPER, challengeId, Math.floor(Date.now() / 1000));
    return json({ ok: true, verified: true, ...completion });
  }
  if (result === 'expired') return json({ error: 'code_expired' }, 400);
  if (result === 'locked') return json({ error: 'code_locked' }, 429);
  return json({ error: 'invalid_code' }, 400);
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'zhiyuan-community-auth' });
  }
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
    const authorizationRequestId = url.searchParams.get('request');
    if (authorizationRequestId && !(await validateAuthorizationRequest(env.AUTH_DB, authorizationRequestId, Math.floor(Date.now() / 1000)))) {
      return page(env.TURNSTILE_SITEKEY, '登录请求已过期，请从知远桌面端重新发起登录。');
    }
    return page(env.TURNSTILE_SITEKEY, undefined, authorizationRequestId ?? undefined);
  }
  if (request.method === 'GET' && url.pathname === '/assets/login.css') return asset(LOGIN_CSS, 'text/css; charset=UTF-8');
  if (request.method === 'GET' && url.pathname === '/assets/login.js') return asset(LOGIN_JS, 'text/javascript; charset=UTF-8');
  if (request.method === 'POST' && url.pathname === '/v1/auth/email/challenges') {
    return createChallenge(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/authorize') {
    const input = (await parseRequest(request)) as AuthorizationInput | null;
    if (!validateAuthorizationInput(input)) return json({ error: 'invalid_authorization_request' }, 400);
    const requestId = await createAuthorizationRequest(env.AUTH_DB, input, Math.floor(Date.now() / 1000));
    return json({ login_url: `https://account.rongxzyai.com/login?request=${encodeURIComponent(requestId)}` }, 201);
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/token') {
    const input = (await parseRequest(request)) as TokenInput | null;
    const tokenSet = await exchangeAuthorizationCode(
      env.AUTH_DB,
      env.OTP_PEPPER,
      env.SESSION_SIGNING_KEY,
      input,
      Math.floor(Date.now() / 1000),
    );
    return tokenSet ? json(tokenSet) : json({ error: 'invalid_grant' }, 400);
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/refresh') {
    const input = (await parseRequest(request)) as RefreshInput | null;
    const tokenSet = await refreshTokens(
      env.AUTH_DB,
      env.OTP_PEPPER,
      env.SESSION_SIGNING_KEY,
      input,
      Math.floor(Date.now() / 1000),
    );
    return tokenSet ? json(tokenSet) : json({ error: 'invalid_grant' }, 400);
  }
  const verificationPath = url.pathname.match(/^\/v1\/auth\/email\/challenges\/([^/]+)\/verify$/u);
  if (request.method === 'POST' && verificationPath) return verifyChallenge(request, env, verificationPath[1]);
  return json({ error: 'not_found' }, 404);
}

export default {
  fetch: handleFetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare('DELETE FROM email_challenges WHERE created_at < ?').bind(cutoff),
      env.AUTH_DB.prepare('DELETE FROM authorization_requests WHERE expires_at < ?').bind(cutoff),
      env.AUTH_DB.prepare('DELETE FROM refresh_sessions WHERE expires_at < ?').bind(cutoff),
    ]);
  },
} satisfies ExportedHandler<Env>;
