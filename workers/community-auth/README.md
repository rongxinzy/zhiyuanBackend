# Community auth Worker

This Worker is the official optional account boundary for the open-source desktop app. It does not gate any desktop feature. The desktop app uses PKCE and an allowlisted `zhiyuan://auth/callback` redirect; browser code never receives a long-lived desktop token.

## Public API

- `GET /` or `GET /login` — official passwordless login page
- `GET /health`
- `POST /v1/auth/email/challenges`
- `POST /v1/auth/email/challenges/:challenge_id/verify`
- `POST /v1/auth/authorize` — creates a short-lived desktop PKCE authorization request
- `POST /v1/auth/token` — exchanges a one-time authorization code and PKCE verifier
- `POST /v1/auth/refresh` — rotates a refresh token

The challenge body is JSON:

```json
{
  "email": "user@example.com",
  "turnstile_token": "browser-widget-token"
}
```

Successful requests return `202` with a challenge ID. Codes expire after 10 minutes. The Turnstile widget must use the action `login-email-challenge`; the Worker verifies both that action and the expected hostname. The endpoint also has Cloudflare rate-limit bindings, a transactional D1 cooldown, and a five-emails-per-hour limit. Neither plaintext email addresses nor codes are written to logs.

`verify` accepts `{ "code": "123456" }`. A challenge is single-use, expires after 10 minutes, and locks after five unsuccessful attempts. When it belongs to a valid authorization request, verification creates the account if needed and returns a 60-second, one-time authorization code through the allowlisted desktop callback. Refresh tokens are stored only as HMAC digests in D1 and are rotated on use.

## Provisioning

1. Verify `auth.rongxzyai.com` in Resend and keep its SPF and DKIM records active.
2. Create a Turnstile widget for `account.rongxzyai.com`.
3. Create the D1 database and place its `database_id` in `wrangler.jsonc`.
4. Configure `RESEND_API_KEY`, `OTP_PEPPER`, `TURNSTILE_SECRET_KEY`, and `SESSION_SIGNING_KEY` with `wrangler secret put`.
5. Apply the checked-in D1 migrations, then deploy.

The local `.resend` file is ignored by Git and is only intended as an input to `wrangler secret put RESEND_API_KEY`.
