import type { CatalogEnv } from './env';
import { ModelScopeHttpError } from './modelScope';

type TokenEntry = { id: string; token: string };
type TokenLease = TokenEntry & { leaseId: string; slot: number };
type TokenOutcome = 'success' | 'unauthorized' | 'rate_limited' | 'server_error';

const TOKEN_LEASE_MS = 30_000;
const TOKEN_ACQUIRE_WAIT_MS = 20_000;
const TOKEN_ACQUIRE_POLL_MIN_MS = 250;
const TOKEN_ACQUIRE_POLL_MAX_MS = 1_000;
const MAX_CONCURRENT_LEASES_PER_TOKEN = 2;
const SERVER_ERROR_COOLDOWN_MS = 10_000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000;
const CIRCUIT_BREAKER_FAILURES = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 60;
const MAX_UPSTREAM_ATTEMPTS = 2;

export function parseTokens(raw: string | null | undefined): TokenEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const values = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { tokens?: unknown[] }).tokens)
        ? (parsed as { tokens: unknown[] }).tokens
        : [];
    const tokens = values
      .map((entry, index): TokenEntry | null => {
        if (typeof entry === 'string' && entry.trim()) {
          return { id: `token-${index + 1}`, token: entry.trim() };
        }
        if (!entry || typeof entry !== 'object') return null;
        const value = entry as { id?: unknown; token?: unknown };
        if (typeof value.token !== 'string' || !value.token.trim()) return null;
        const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `token-${index + 1}`;
        return { id: id.slice(0, 96), token: value.token.trim() };
      })
      .filter((entry): entry is TokenEntry => Boolean(entry));
    const seen = new Set<string>();
    return tokens.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  } catch {
    return [];
  }
}

async function tokenBundle(env: CatalogEnv): Promise<TokenEntry[]> {
  const secretStoreValue = env.MODEL_SCOPE_TOKEN_BUNDLE
    ? await env.MODEL_SCOPE_TOKEN_BUNDLE.get()
    : null;
  return parseTokens(secretStoreValue ?? env.MODELSCOPE_TOKEN_BUNDLE);
}

async function syncTokenRows(env: CatalogEnv, tokens: TokenEntry[]): Promise<void> {
  if (!tokens.length) return;
  const now = new Date().toISOString();
  await env.DB.batch(
    tokens.map(({ id }) =>
      env.DB.prepare(
        `INSERT INTO modelscope_pool_tokens(token_id, status, updated_at)
         VALUES (?, 'active', ?)
         ON CONFLICT(token_id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).bind(id, now),
    ),
  );
}

function rowChanges(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

async function acquireToken(
  env: CatalogEnv,
  tokens: TokenEntry[],
  excludedIds: Set<string>,
): Promise<TokenLease | null> {
  if (!tokens.length) return null;
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + TOKEN_LEASE_MS).toISOString();
  const exclusions = [...excludedIds];
  const exclusionSql = exclusions.length
    ? `AND p.token_id NOT IN (${exclusions.map(() => '?').join(', ')})`
    : '';
  const candidates = await env.DB.prepare(
    `SELECT p.token_id FROM modelscope_pool_tokens p
     WHERE p.status = 'active' AND (p.cooldown_until IS NULL OR p.cooldown_until < ?)
       ${exclusionSql}
     ORDER BY p.last_used_at IS NOT NULL, p.last_used_at ASC LIMIT 4`,
  )
    .bind(now, ...exclusions)
    .all<{ token_id: string }>();

  for (const candidate of candidates.results) {
    const entry = tokens.find((token) => token.id === candidate.token_id);
    if (!entry) continue;
    for (let slot = 1; slot <= MAX_CONCURRENT_LEASES_PER_TOKEN; slot += 1) {
      const leaseId = crypto.randomUUID();
      const claimed = await env.DB.prepare(
        `INSERT INTO modelscope_token_lease_slots(token_id, slot, lease_id, leased_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token_id, slot) DO UPDATE SET
           lease_id = excluded.lease_id,
           leased_until = excluded.leased_until
         WHERE modelscope_token_lease_slots.leased_until < ?`,
      )
        .bind(entry.id, slot, leaseId, leaseUntil, now)
        .run();
      if (!claimed.success || rowChanges(claimed) !== 1) continue;
      await env.DB.prepare(
        'UPDATE modelscope_pool_tokens SET last_used_at = ?, updated_at = ? WHERE token_id = ?',
      )
        .bind(now, now, entry.id)
        .run();
      return { ...entry, leaseId, slot };
    }
  }
  return null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireTokenWithWait(
  env: CatalogEnv,
  tokens: TokenEntry[],
  excludedIds: Set<string>,
): Promise<TokenLease | null> {
  const deadline = Date.now() + TOKEN_ACQUIRE_WAIT_MS;
  let delay = TOKEN_ACQUIRE_POLL_MIN_MS;
  do {
    const lease = await acquireToken(env, tokens, excludedIds);
    if (lease) return lease;
    if (excludedIds.size >= tokens.length || Date.now() >= deadline) return null;
    await wait(delay);
    delay = Math.min(TOKEN_ACQUIRE_POLL_MAX_MS, Math.round(delay * 1.5));
  } while (Date.now() < deadline);
  return null;
}

async function releaseToken(
  env: CatalogEnv,
  lease: TokenLease,
  outcome: TokenOutcome,
  retryAfter?: number,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const rateLimitCooldown = new Date(
    now.getTime() + (retryAfter ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS) * 1000,
  ).toISOString();
  const serverCooldown = new Date(now.getTime() + SERVER_ERROR_COOLDOWN_MS).toISOString();
  const circuitCooldown = new Date(now.getTime() + CIRCUIT_BREAKER_COOLDOWN_MS).toISOString();
  const status = outcome === 'unauthorized' ? 'disabled' : 'active';
  const cooldown =
    outcome === 'rate_limited'
      ? rateLimitCooldown
      : outcome === 'server_error'
        ? serverCooldown
        : null;
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM modelscope_token_lease_slots WHERE token_id = ? AND slot = ? AND lease_id = ?',
    ).bind(lease.id, lease.slot, lease.leaseId),
    env.DB.prepare(
      `UPDATE modelscope_pool_tokens SET
         status = ?,
         cooldown_until = CASE
           WHEN ? = 'server_error' AND consecutive_failures + 1 >= ? THEN ?
           ELSE ?
         END,
         consecutive_failures = CASE WHEN ? = 'success' THEN 0 ELSE consecutive_failures + 1 END,
         updated_at = ?
       WHERE token_id = ?`,
    ).bind(
      status,
      outcome,
      CIRCUIT_BREAKER_FAILURES,
      circuitCooldown,
      cooldown,
      outcome,
      nowIso,
      lease.id,
    ),
  ]);
}

function outcomeFor(error: unknown): TokenOutcome {
  const status = error instanceof ModelScopeHttpError ? error.status : 503;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'server_error';
}

function shouldSwitchToken(error: unknown): boolean {
  const status = error instanceof ModelScopeHttpError ? error.status : 503;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

export async function withModelScope<T>(
  env: CatalogEnv,
  operation: (token?: string) => Promise<T>,
): Promise<T> {
  const tokens = await tokenBundle(env);
  if (!tokens.length) return operation(undefined);
  await syncTokenRows(env, tokens);

  const attemptedIds = new Set<string>();
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    const lease = await acquireTokenWithWait(env, tokens, attemptedIds);
    if (!lease) break;
    attemptedIds.add(lease.id);
    try {
      const result = await operation(lease.token);
      await releaseToken(env, lease, 'success');
      return result;
    } catch (error) {
      lastError = error;
      await releaseToken(
        env,
        lease,
        outcomeFor(error),
        error instanceof ModelScopeHttpError ? error.retryAfterSeconds : undefined,
      );
      if (!shouldSwitchToken(error)) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new ModelScopeHttpError(503);
}
