import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRouteConfig, RouteMode, ProviderNodeKind } from '../../workers/model-pool/src/routing.ts';
import { MODEL } from './relay.mjs';

test('production route shares one Agens key health scope and preserves workload ceilings', async () => {
  const route: unknown = JSON.parse(await readFile(new URL('../../workers/model-pool/cloudflare/provider-pool.route.json', import.meta.url), 'utf8'));
  assert.ok(isRouteConfig(route));
  assert.equal(route.mode, RouteMode.ProviderPool);
  if (route.mode !== RouteMode.ProviderPool) return;
  assert.equal(route.routes.chat.maxOutputTokens, 4096);
  assert.equal(route.routes.work.maxOutputTokens, 16384);
  const nodes = [route.routes.chat, route.routes.work].map(workload => {
    const index = workload.nodes.findIndex(node => node.id.startsWith('agens-'));
    assert.ok(index > 0 && index < workload.nodes.length - 1);
    const node = workload.nodes[index];
    assert.equal(node.kind, ProviderNodeKind.Direct);
    if (node.kind !== ProviderNodeKind.Direct) throw new Error('Expected direct relay');
    assert.equal(node.model, MODEL);
    assert.equal(node.baseUrl, 'https://zhiyuan-agens-relay-v2.vercel.app/api');
    assert.equal(node.maxAliasAttempts, 1);
    assert.equal(node.aliases[0].secretBinding, 'AGENS_RELAY_TOKEN_V2');
    assert.equal(node.aliases[0].id, 'key-2');
    assert.equal(node.aliases[0].quotaScopeId, 'agens-key-2');
    return node;
  });
  assert.equal(nodes[0].poolId, nodes[1].poolId);
  assert.deepEqual(nodes[0].aliases, nodes[1].aliases);
});
