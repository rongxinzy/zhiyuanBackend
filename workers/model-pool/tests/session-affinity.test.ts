import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  SessionAffinityStore,
  SessionAffinityPolicy,
  bindSession,
  orderSessionNodes,
  preferredAlias,
} from '../src/session-affinity.ts';
import { ProviderNodeKind, type DirectProviderNode } from '../src/routing.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  // Exercise the production SQL against real SQLite; only the cursor adapter is mocked.
  const sql = {
    exec(query: string, ...args: (string | number | null)[]) {
      if (query.includes('CREATE TABLE')) {
        db.exec(query);
        return;
      }
      const rows = db.prepare(query).all(...args);
      return {
        toArray: () => rows,
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
      };
    },
  } as unknown as SqlStorage;
  return { db, sql, store: new SessionAffinityStore(sql) };
}

const node: DirectProviderNode = {
  kind: ProviderNodeKind.Direct,
  id: 'primary',
  model: 'small',
  poolId: 'pool',
  baseUrl: 'https://example.com/v1',
  timeoutMs: 1000,
  maxAliasAttempts: 2,
  aliases: [{ id: 'key-1', quotaScopeId: 'account-1', secretBinding: 'KEY_1', weight: 1 }],
};
const binding = bindSession('gateway', node, 'key-1');

test('persists across store reconstruction and fences concurrent selectors', t => {
  const { db, sql, store } = database();
  t.after(() => db.close());
  const first = store.begin('chat:session', 100)!;
  assert.equal(first.binding, null);
  assert.equal(store.begin('chat:session', 101), null);
  assert.ok(store.finish('chat:session', first.token, binding, 102));
  const next = new SessionAffinityStore(sql).begin('chat:session', 103)!;
  assert.deepEqual(next.binding, binding);
  store.release('chat:session', first.token);
  assert.equal(store.begin('chat:session', 104), null);
  store.release('chat:session', next.token);
  assert.deepEqual(store.begin('chat:session', 105)?.binding, binding);
});

test('failed selections retain previous binding; successful failover becomes sticky', t => {
  const { db, store } = database();
  t.after(() => db.close());
  const first = store.begin('chat:s', 100)!;
  store.finish('chat:s', first.token, binding, 101);
  const failed = store.begin('chat:s', 102)!;
  store.release('chat:s', failed.token);
  const retry = store.begin('chat:s', 103)!;
  assert.deepEqual(retry.binding, binding);
  const fallback = bindSession('gateway', { ...node, id: 'fallback' }, 'key-1');
  store.finish('chat:s', retry.token, fallback, 104);
  assert.deepEqual(store.begin('chat:s', 105)?.binding, fallback);
});

test('expired selectors cannot overwrite a new selection and idle bindings expire', t => {
  const { db, store } = database();
  t.after(() => db.close());
  const old = store.begin('s', 100)!;
  const now = 100 + SessionAffinityPolicy.SelectionLeaseMs;
  const fresh = store.begin('s', now)!;
  assert.equal(store.finish('s', old.token, binding, now + 1), false);
  assert.ok(store.finish('s', fresh.token, binding, now + 2));
  assert.equal(store.begin('s', now + 2 + SessionAffinityPolicy.IdleTtlMs)?.binding, null);
});

test('user stores and workload session keys do not share bindings', t => {
  const userA = database();
  const userB = database();
  t.after(() => {
    userA.db.close();
    userB.db.close();
  });
  const first = userA.store.begin('chat:s', 100)!;
  userA.store.finish('chat:s', first.token, binding, 101);
  assert.equal(userA.store.begin('work:s', 102)?.binding, null);
  assert.equal(userB.store.begin('chat:s', 102)?.binding, null);
});

test('bounded storage rejects new sessions without evicting existing bindings', t => {
  const { db, store } = database();
  t.after(() => db.close());
  for (let i = 0; i < SessionAffinityPolicy.MaximumSessionsPerUser; i++) {
    const selection = store.begin(String(i), 100)!;
    store.finish(String(i), selection.token, binding, 101);
  }
  assert.equal(store.begin('extra', 102), null);
  assert.deepEqual(store.begin('0', 102)?.binding, binding);
  assert.ok(store.begin('extra', 102 + SessionAffinityPolicy.IdleTtlMs));
});

test('bound node wins over priority, then same model, without mutating configuration', () => {
  const cheap = { ...node, id: 'cheap', model: 'other' };
  const fallback = { ...node, id: 'fallback' };
  const nodes = [cheap, fallback, node];
  assert.deepEqual(orderSessionNodes('gateway', nodes, null), nodes);
  assert.deepEqual(orderSessionNodes('gateway', nodes, binding), [node, fallback, cheap]);
  assert.deepEqual(nodes, [cheap, fallback, node]);
});

test('egress, model, account or credential binding changes invalidate key preference', () => {
  assert.equal(preferredAlias('gateway', node, binding), 'key-1');
  for (const changed of [
    { ...node, baseUrl: 'https://new.example.com/v1' },
    { ...node, model: 'other' },
    { ...node, aliases: [] },
    { ...node, aliases: [{ ...node.aliases[0], quotaScopeId: 'new-account' }] },
    { ...node, aliases: [{ ...node.aliases[0], secretBinding: 'KEY_2' }] },
  ])
    assert.equal(preferredAlias('gateway', changed, binding), null);
});
