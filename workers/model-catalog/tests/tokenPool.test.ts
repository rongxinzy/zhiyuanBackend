import { describe, expect, it } from 'vitest';

import type { CatalogEnv } from '../src/env';
import { withModelScope } from '../src/tokenPool';

type Lease = { leaseId: string; leasedUntil: string };

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes('SELECT p.token_id FROM modelscope_pool_tokens')) {
      return { results: [{ token_id: 'primary' }] as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    if (this.sql.includes('INSERT INTO modelscope_token_lease_slots')) {
      const [tokenId, slot, leaseId, leasedUntil, now] = this.values as [
        string,
        number,
        string,
        string,
        string,
      ];
      const key = `${tokenId}:${slot}`;
      const existing = this.database.leases.get(key);
      if (existing && existing.leasedUntil >= now) {
        return { success: true, meta: { changes: 0 } };
      }
      this.database.leases.set(key, { leaseId, leasedUntil });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes('DELETE FROM modelscope_token_lease_slots')) {
      const [tokenId, slot, leaseId] = this.values as [string, number, string];
      const key = `${tokenId}:${slot}`;
      if (this.database.leases.get(key)?.leaseId === leaseId) {
        this.database.leases.delete(key);
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  readonly leases = new Map<string, Lease>();

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function environment(database: FakeD1): CatalogEnv {
  return {
    DB: database,
    MODELSCOPE_TOKEN_BUNDLE: JSON.stringify({
      tokens: [{ id: 'primary', token: 'modelscope-secret' }],
    }),
  } as unknown as CatalogEnv;
}

describe('ModelScope Worker token pool', () => {
  it('allows two safe concurrent leases and queues the next request instead of returning 503', async () => {
    const database = new FakeD1();
    const env = environment(database);
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const releases: Array<() => void> = [];

    const operation = async (token?: string): Promise<string> => {
      expect(token).toBe('modelscope-secret');
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return `result-${started}`;
    };

    const requests = [
      withModelScope(env, operation),
      withModelScope(env, operation),
      withModelScope(env, operation),
    ];

    while (started < 2) await Promise.resolve();
    expect(started).toBe(2);
    expect(maxActive).toBe(2);
    releases.splice(0).forEach((release) => release());

    while (started < 3) await new Promise((resolve) => setTimeout(resolve, 20));
    releases.splice(0).forEach((release) => release());

    await expect(Promise.all(requests)).resolves.toHaveLength(3);
    expect(maxActive).toBe(2);
    expect(database.leases.size).toBe(0);
  });
});
