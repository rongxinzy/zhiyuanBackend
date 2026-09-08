import { DurableObject } from 'cloudflare:workers';

import type { ProviderObservation } from './provider-observation.ts';
import { calculateCandidateScore, calculateCapacityFactor } from './provider-scoring.ts';
import type { KeyedProviderNode } from './routing.ts';

export const ProviderHealthState = {
  Cooldown: 'cooldown',
  Exhausted: 'exhausted',
  Healthy: 'healthy',
  Invalid: 'invalid',
} as const;

export interface ProviderLease {
  alias: string;
  candidateId: string;
  leaseId: string;
  quotaScopeId: string;
}

interface CandidateHealthRow extends Record<string, SqlStorageValue> {
  candidate_id: string;
  consecutive_failures: number;
  cooldown_until: number;
  state: string;
}

interface ScopeHealthRow extends Record<string, SqlStorageValue> {
  limit_requests: number | null;
  limit_tokens: number | null;
  quota_scope_id: string;
  remaining_requests: number | null;
  remaining_tokens: number | null;
  reset_requests_at: number | null;
  reset_tokens_at: number | null;
}

interface InflightRow extends Record<string, SqlStorageValue> {
  candidate_id: string;
  inflight: number;
}

const LEASE_TTL_MS = 3 * 60_000;
const INVALID_RECHECK_MS = 24 * 60 * 60_000;
const DEFAULT_EXHAUSTED_COOLDOWN_MS = 60 * 60_000;
const MAX_TRANSIENT_COOLDOWN_MS = 5 * 60_000;

export class ProviderPool extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS candidate_health (
          candidate_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          cooldown_until INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS scope_health (
          quota_scope_id TEXT PRIMARY KEY,
          limit_requests INTEGER,
          remaining_requests INTEGER,
          reset_requests_at INTEGER,
          limit_tokens INTEGER,
          remaining_tokens INTEGER,
          reset_tokens_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS leases (
          lease_id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_leases_candidate
          ON leases(candidate_id, expires_at);
      `);
    });
  }

  async acquire(
    node: KeyedProviderNode,
    affinityKey: string,
    excludedCandidateIds: string[],
    now = Date.now(),
    preferredAlias: string | null = null,
  ): Promise<ProviderLease | null> {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE expires_at <= ?', now);
    const healthRows = this.ctx.storage.sql
      .exec<CandidateHealthRow>('SELECT * FROM candidate_health')
      .toArray();
    const scopeRows = this.ctx.storage.sql
      .exec<ScopeHealthRow>('SELECT * FROM scope_health')
      .toArray();
    const inflightRows = this.ctx.storage.sql
      .exec<InflightRow>(
        `SELECT candidate_id, COUNT(*) AS inflight
         FROM leases
         WHERE expires_at > ?
         GROUP BY candidate_id`,
        now,
      )
      .toArray();
    const health = new Map(healthRows.map(row => [row.candidate_id, row]));
    const scopes = new Map(scopeRows.map(row => [row.quota_scope_id, row]));
    const inflight = new Map(inflightRows.map(row => [row.candidate_id, row.inflight]));
    const excluded = new Set(excludedCandidateIds);

    const ranked = node.aliases.flatMap(alias => {
      const candidateId = `${node.poolId}:${alias.id}`;
      if (excluded.has(candidateId)) return [];
      const candidate = health.get(candidateId);
      if (candidate && candidate.cooldown_until > now) return [];
      const scope = scopes.get(alias.quotaScopeId);
      if (
        scope &&
        ((scope.remaining_requests === 0 && (scope.reset_requests_at ?? now + 1) > now) ||
          (scope.remaining_tokens === 0 && (scope.reset_tokens_at ?? now + 1) > now))
      )
        return [];
      const active = inflight.get(candidateId) ?? 0;
      const score = calculateCandidateScore(
        affinityKey,
        candidateId,
        alias.weight,
        calculateCapacityFactor(scope, now),
        active,
      );
      return [{ alias, candidateId, score }];
    });
    ranked.sort((left, right) => right.score - left.score);
    // Affinity only bypasses load scoring, never health or quota eligibility.
    const selected = ranked.find(candidate => candidate.alias.id === preferredAlias) ?? ranked[0];
    if (!selected) return null;

    const leaseId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO leases (lease_id, candidate_id, expires_at) VALUES (?, ?, ?)',
      leaseId,
      selected.candidateId,
      now + LEASE_TTL_MS,
    );
    return {
      alias: selected.alias.id,
      candidateId: selected.candidateId,
      leaseId,
      quotaScopeId: selected.alias.quotaScopeId,
    };
  }

  observe(lease: ProviderLease, observation: ProviderObservation, now = Date.now()): void {
    const existing = this.ctx.storage.sql
      .exec<CandidateHealthRow>(
        'SELECT * FROM candidate_health WHERE candidate_id = ?',
        lease.candidateId,
      )
      .toArray()[0];
    const previousFailures = existing?.consecutive_failures ?? 0;
    let state: (typeof ProviderHealthState)[keyof typeof ProviderHealthState] =
      ProviderHealthState.Healthy;
    let failures = 0;
    let cooldownUntil = 0;

    if (observation.status === 401) {
      state = ProviderHealthState.Invalid;
      failures = previousFailures + 1;
      cooldownUntil = now + INVALID_RECHECK_MS;
    } else if (observation.status === 402 || observation.status === 403) {
      state = ProviderHealthState.Exhausted;
      failures = previousFailures + 1;
      cooldownUntil =
        observation.retryAfterMs !== null
          ? now + observation.retryAfterMs
          : Math.max(
              observation.resetRequestsAt ?? 0,
              observation.resetTokensAt ?? 0,
              now + DEFAULT_EXHAUSTED_COOLDOWN_MS,
            );
    } else if (
      observation.status === 429 ||
      observation.status === 408 ||
      observation.status >= 500
    ) {
      state = ProviderHealthState.Cooldown;
      failures = previousFailures + 1;
      const exponential = Math.min(MAX_TRANSIENT_COOLDOWN_MS, 5_000 * 2 ** Math.min(failures, 6));
      cooldownUntil = now + (observation.retryAfterMs ?? exponential);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO candidate_health (
         candidate_id, state, consecutive_failures, cooldown_until, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(candidate_id) DO UPDATE SET
         state = excluded.state,
         consecutive_failures = excluded.consecutive_failures,
         cooldown_until = excluded.cooldown_until,
         updated_at = excluded.updated_at`,
      lease.candidateId,
      state,
      failures,
      cooldownUntil,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO scope_health (
         quota_scope_id, limit_requests, remaining_requests, reset_requests_at,
         limit_tokens, remaining_tokens, reset_tokens_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(quota_scope_id) DO UPDATE SET
         limit_requests = COALESCE(excluded.limit_requests, scope_health.limit_requests),
         remaining_requests = COALESCE(excluded.remaining_requests, scope_health.remaining_requests),
         reset_requests_at = COALESCE(excluded.reset_requests_at, scope_health.reset_requests_at),
         limit_tokens = COALESCE(excluded.limit_tokens, scope_health.limit_tokens),
         remaining_tokens = COALESCE(excluded.remaining_tokens, scope_health.remaining_tokens),
         reset_tokens_at = COALESCE(excluded.reset_tokens_at, scope_health.reset_tokens_at),
         updated_at = excluded.updated_at`,
      lease.quotaScopeId,
      observation.limitRequests,
      observation.remainingRequests,
      observation.remainingRequests === 0 && observation.resetRequestsAt === null
        ? now + DEFAULT_EXHAUSTED_COOLDOWN_MS
        : observation.resetRequestsAt,
      observation.limitTokens,
      observation.remainingTokens,
      observation.remainingTokens === 0 && observation.resetTokensAt === null
        ? now + DEFAULT_EXHAUSTED_COOLDOWN_MS
        : observation.resetTokensAt,
      now,
    );
  }

  release(leaseId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM leases WHERE lease_id = ?', leaseId);
  }

  report(lease: ProviderLease, observation: ProviderObservation, now = Date.now()): void {
    this.observe(lease, observation, now);
    this.release(lease.leaseId);
  }
}
