import { ProviderNodeKind, type ProviderNode } from './routing.ts';

export const SessionAffinityPolicy = {
  IdleTtlMs: 24 * 60 * 60_000,
  SelectionLeaseMs: 5 * 60_000,
  MaximumSessionsPerUser: 1024,
} as const;

export interface SessionBinding {
  nodeIdentity: string;
  model: string;
  alias: string | null;
  aliasIdentity: string | null;
}

export interface SessionSelection {
  token: string;
  binding: SessionBinding | null;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  binding: string | null;
  token: string | null;
  locked_until: number;
}

export function nodeIdentity(gatewayId: string, node: ProviderNode): string {
  return JSON.stringify([
    gatewayId,
    node.id,
    node.kind,
    node.model,
    node.kind === ProviderNodeKind.WorkersAi ? null : node.poolId,
    node.kind === ProviderNodeKind.Direct
      ? node.baseUrl
      : node.kind === ProviderNodeKind.Gateway
        ? node.provider
        : null,
  ]);
}

function aliasIdentity(node: ProviderNode, aliasId: string | null): string | null {
  if (node.kind === ProviderNodeKind.WorkersAi) return null;
  const alias = node.aliases.find(item => item.id === aliasId);
  return alias
    ? JSON.stringify([
        alias.id,
        alias.quotaScopeId,
        'secretBinding' in alias ? alias.secretBinding : null,
      ])
    : null;
}

export function bindSession(
  gatewayId: string,
  node: ProviderNode,
  alias: string | null,
): SessionBinding {
  return {
    nodeIdentity: nodeIdentity(gatewayId, node),
    model: node.model,
    alias,
    aliasIdentity: aliasIdentity(node, alias),
  };
}

export function preferredAlias(
  gatewayId: string,
  node: ProviderNode,
  binding: SessionBinding | null,
): string | null {
  if (!binding || binding.nodeIdentity !== nodeIdentity(gatewayId, node)) return null;
  return binding.aliasIdentity === aliasIdentity(node, binding.alias) ? binding.alias : null;
}

export function orderSessionNodes(
  gatewayId: string,
  nodes: ProviderNode[],
  binding: SessionBinding | null,
): ProviderNode[] {
  if (!binding) return nodes;
  // Preserve configured order within each tier. New sessions retain free-first routing.
  const tier = (node: ProviderNode) =>
    nodeIdentity(gatewayId, node) === binding.nodeIdentity
      ? 0
      : node.model === binding.model
        ? 1
        : 2;
  return [...nodes].sort((left, right) => tier(left) - tier(right));
}

// Owned by the existing per-user UserQuota DO; no credentials or message content are stored.
// All state transitions are synchronous SQL, so there is no external-I/O critical section.
export class SessionAffinityStore {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS session_affinity (
      session_key TEXT PRIMARY KEY, binding TEXT, token TEXT,
      locked_until INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_session_affinity_expiry ON session_affinity(expires_at);`);
  }

  begin(key: string, now = Date.now()): SessionSelection | null {
    this.sql.exec('DELETE FROM session_affinity WHERE expires_at <= ?', now);
    const row = this.sql
      .exec<SessionRow>(
        'SELECT binding, token, locked_until FROM session_affinity WHERE session_key = ?',
        key,
      )
      .toArray()[0];
    if (row && row.locked_until > now) return null;
    if (
      !row &&
      this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM session_affinity').one()
        .count >= SessionAffinityPolicy.MaximumSessionsPerUser
    )
      return null;
    const token = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO session_affinity (session_key, binding, token, locked_until, expires_at)
      VALUES (?, NULL, ?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET
      token = excluded.token, locked_until = excluded.locked_until, expires_at = excluded.expires_at`,
      key,
      token,
      now + SessionAffinityPolicy.SelectionLeaseMs,
      now + SessionAffinityPolicy.IdleTtlMs,
    );
    return { token, binding: row?.binding ? (JSON.parse(row.binding) as SessionBinding) : null };
  }

  finish(key: string, token: string, binding: SessionBinding | null, now = Date.now()): boolean {
    // Fencing token prevents timed-out selectors from overwriting a newer migration.
    return (
      this.sql
        .exec<{ session_key: string }>(
          `UPDATE session_affinity SET
      binding = ?, token = NULL, locked_until = 0, expires_at = ?
      WHERE session_key = ? AND token = ? AND locked_until > ? RETURNING session_key`,
          binding ? JSON.stringify(binding) : null,
          now + SessionAffinityPolicy.IdleTtlMs,
          key,
          token,
          now,
        )
        .toArray().length === 1
    );
  }

  release(key: string, token: string): void {
    this.sql.exec(
      'UPDATE session_affinity SET token = NULL, locked_until = 0 WHERE session_key = ? AND token = ?',
      key,
      token,
    );
  }
}
