import { ProviderPool, UserQuota } from '../../src/index.ts';
import { ProviderNodeKind } from '../../src/routing.ts';
import { bindSession } from '../../src/session-affinity.ts';
import { observationFromResponse } from '../../src/provider-observation.ts';
import { exerciseHttpAffinity } from './http-affinity.ts';

export { ProviderPool, UserQuota };

// Test-only entrypoint. No real provider, credential, or production binding is used.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === '/http')
      return Response.json(await exerciseHttpAffinity(env, ctx));
    const pool = env.PROVIDER_POOL.get(env.PROVIDER_POOL.idFromName(new URL(request.url).pathname));
    const node = {
      kind: ProviderNodeKind.Direct,
      id: 'test',
      model: 'small',
      poolId: 'test-pool',
      baseUrl: 'https://example.invalid/v1',
      timeoutMs: 1000,
      maxAliasAttempts: 2,
      aliases: [1, 2].map(index => ({
        id: `key-${index}`,
        weight: 1,
        quotaScopeId: `account-${index}`,
        secretBinding: `TEST_KEY_${index}`,
      })),
    };
    const now = Date.now();
    const first = await pool.acquire(node, 'session', [], now, 'key-1');
    if (!first) throw new Error('Missing initial lease');
    const sticky = await pool.acquire(node, 'other-score', [], now, first.alias);
    const excluded = await pool.acquire(node, 'session', [first.candidateId], now, first.alias);
    await pool.report(
      first,
      observationFromResponse(new Response(null, { status: 401 }), now),
      now,
    );
    const migrated = await pool.acquire(node, 'session', [], now, first.alias);
    const user = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(new URL(request.url).pathname));
    const [selectionA, selectionB] = await Promise.all([
      user.beginSession('chat:s'),
      user.beginSession('chat:s'),
    ]);
    const selection = selectionA ?? selectionB;
    if (!selection || !migrated) throw new Error('Missing migration selection');
    const binding = bindSession('gateway', node, migrated.alias);
    await user.finishSession('chat:s', selection.token, binding);
    const next = await user.beginSession('chat:s');
    if (next) await user.releaseSession('chat:s', next.token);
    // Exhausting the remaining account must not be bypassed by sticky preference.
    await pool.report(
      migrated,
      observationFromResponse(
        new Response(null, {
          status: 200,
          headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '60s' },
        }),
        now,
      ),
      now,
    );
    const exhausted = await pool.acquire(node, 'session', [], now, migrated.alias);
    const recovered = await pool.acquire(node, 'session', [], now + 60_001, migrated.alias);
    return Response.json({
      first: first.alias,
      sticky: sticky?.alias,
      excluded: excluded?.alias,
      migrated: migrated.alias,
      selectedCount: Number(Boolean(selectionA)) + Number(Boolean(selectionB)),
      storedAlias: next?.binding?.alias,
      exhausted,
      recovered: recovered?.alias,
    });
  },
};
