import assert from 'node:assert/strict';
import test from 'node:test';

import {
  observationFromResponse,
  parsePositiveIntegerHeader,
  parseResetHeader,
  shouldTryNextProvider,
} from '../src/provider-observation.ts';
import {
  calculateCandidateScore,
  calculateCapacityFactor,
} from '../src/provider-scoring.ts';

test('parses provider quota headers for dynamic weighting', () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  const headers = new Headers({
    'retry-after': '120',
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-limit-tokens': '6000',
    'x-ratelimit-remaining-requests': '321',
    'x-ratelimit-remaining-tokens': '4567',
    'x-ratelimit-reset-requests': '2m',
    'x-ratelimit-reset-tokens': '30s',
  });
  const observation = observationFromResponse(new Response(null, { status: 429, headers }), now);

  assert.equal(observation.remainingRequests, 321);
  assert.equal(observation.remainingTokens, 4567);
  assert.equal(observation.resetRequestsAt, now + 120_000);
  assert.equal(observation.resetTokensAt, now + 30_000);
  assert.equal(observation.retryAfterMs, 120_000);
});

test('accepts HTTP dates and rejects malformed quota values', () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  const headers = new Headers({
    'x-limit': '-1',
    'x-reset': 'Sun, 07 Sep 2026 00:05:00 GMT',
  });
  assert.equal(parsePositiveIntegerHeader(headers, 'x-limit'), null);
  assert.equal(parseResetHeader(headers, 'x-reset', now), now + 300_000);
});

test('retries authentication, quota, throttling, and upstream failures only', () => {
  for (const status of [401, 402, 403, 408, 429, 500, 503]) {
    assert.equal(shouldTryNextProvider(status), true);
  }
  for (const status of [400, 404, 409, 422]) {
    assert.equal(shouldTryNextProvider(status), false);
  }
});

test('weights candidates by remaining provider capacity and inflight requests', () => {
  const now = Date.parse('2026-09-07T00:00:00Z');
  const highCapacity = calculateCapacityFactor(
    {
      limit_requests: 1000,
      limit_tokens: 10_000,
      remaining_requests: 900,
      remaining_tokens: 8_000,
      reset_requests_at: now + 60_000,
      reset_tokens_at: now + 60_000,
    },
    now,
  );
  const lowCapacity = calculateCapacityFactor(
    {
      limit_requests: 1000,
      limit_tokens: 10_000,
      remaining_requests: 100,
      remaining_tokens: 500,
      reset_requests_at: now + 60_000,
      reset_tokens_at: now + 60_000,
    },
    now,
  );

  assert.equal(highCapacity, 0.8);
  assert.equal(lowCapacity, 0.05);
  assert.ok(
    calculateCandidateScore('conversation-1', 'candidate-1', 1, highCapacity, 0) >
      calculateCandidateScore('conversation-1', 'candidate-1', 1, lowCapacity, 0),
  );
  assert.ok(
    calculateCandidateScore('conversation-1', 'candidate-1', 1, highCapacity, 0) >
      calculateCandidateScore('conversation-1', 'candidate-1', 1, highCapacity, 3),
  );
});
