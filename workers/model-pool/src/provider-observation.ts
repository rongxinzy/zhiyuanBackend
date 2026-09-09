export interface ProviderObservation {
  limitRequests: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null;
  resetTokensAt: number | null;
  retryAfterMs: number | null;
  status: number;
}

export function parsePositiveIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseDurationMs(value: string): number | null {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const matches = [...value.matchAll(/([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)/g)];
  if (matches.length === 0) return null;
  const multipliers: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return matches.reduce((total, match) => total + Number(match[1]) * multipliers[match[2]], 0);
}

export function parseResetHeader(headers: Headers, name: string, now = Date.now()): number | null {
  const value = headers.get(name)?.trim();
  if (!value) return null;
  const duration = parseDurationMs(value);
  if (duration !== null) return now + duration;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function observationFromResponse(response: Response, now = Date.now()): ProviderObservation {
  const retryAfter = response.headers.get('retry-after');
  const retryAfterAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  const retryAfterMs = retryAfter
    ? parseDurationMs(retryAfter) ??
      (Number.isFinite(retryAfterAt) ? Math.max(0, retryAfterAt - now) : null)
    : null;
  return {
    status: response.status,
    retryAfterMs,
    limitRequests: parsePositiveIntegerHeader(response.headers, 'x-ratelimit-limit-requests'),
    remainingRequests: parsePositiveIntegerHeader(response.headers, 'x-ratelimit-remaining-requests'),
    resetRequestsAt: parseResetHeader(response.headers, 'x-ratelimit-reset-requests', now),
    limitTokens: parsePositiveIntegerHeader(response.headers, 'x-ratelimit-limit-tokens'),
    remainingTokens: parsePositiveIntegerHeader(response.headers, 'x-ratelimit-remaining-tokens'),
    resetTokensAt: parseResetHeader(response.headers, 'x-ratelimit-reset-tokens', now),
  };
}

export function shouldTryNextProvider(status: number): boolean {
  return status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status >= 500;
}
