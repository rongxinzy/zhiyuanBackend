import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRouteConfig,
  ModelPoolHeader,
  ModelPoolWorkload,
  ProviderNodeKind,
  resolveRequestWorkload,
  RouteMode,
} from '../src/routing.ts';

const route = {
  enabled: true,
  gatewayId: 'default',
  mode: RouteMode.ProviderPool,
  protocol: 'openai',
  routes: {
    [ModelPoolWorkload.Chat]: {
      maxOutputTokens: 4_096,
      name: 'free-chat-openai',
      nodes: [
        {
          aliases: [{ id: 'default', quotaScopeId: 'openrouter-default', weight: 1 }],
          id: 'openrouter-chat',
          kind: ProviderNodeKind.Gateway,
          maxAliasAttempts: 1,
          model: 'minimax/minimax-m3:free',
          poolId: 'openrouter',
          provider: 'openrouter',
          timeoutMs: 30_000,
        },
      ],
    },
    [ModelPoolWorkload.Work]: {
      maxOutputTokens: 16_384,
      name: 'free-work-openai',
      nodes: [
        {
          id: 'workers-ai-work',
          kind: ProviderNodeKind.WorkersAi,
          model: '@cf/zai-org/glm-4.7-flash',
        },
      ],
    },
  },
} as const;

test('validates a split Chat and Work provider pool route', () => {
  assert.equal(isRouteConfig(route), true);
  assert.equal(
    isRouteConfig({
      ...route,
      routes: {
        ...route.routes,
        [ModelPoolWorkload.Chat]: {
          ...route.routes[ModelPoolWorkload.Chat],
          maxOutputTokens: 0,
        },
      },
    }),
    false,
  );
});

test('accepts only HTTPS direct providers with declared secret bindings', () => {
  const directNode = {
    aliases: [
      {
        id: 'default',
        quotaScopeId: 'tokenrouter-default',
        secretBinding: 'TOKENROUTER_API_KEY_1',
        weight: 1,
      },
    ],
    baseUrl: 'https://api.tokenrouter.com/v1',
    id: 'tokenrouter-chat',
    kind: ProviderNodeKind.Direct,
    maxAliasAttempts: 1,
    model: 'z-ai/glm-5.3-free',
    poolId: 'tokenrouter',
    timeoutMs: 30_000,
  };
  assert.equal(
    isRouteConfig({
      ...route,
      routes: {
        ...route.routes,
        [ModelPoolWorkload.Chat]: {
          ...route.routes[ModelPoolWorkload.Chat],
          nodes: [directNode],
        },
      },
    }),
    true,
  );
  assert.equal(
    isRouteConfig({
      ...route,
      routes: {
        ...route.routes,
        [ModelPoolWorkload.Chat]: {
          ...route.routes[ModelPoolWorkload.Chat],
          nodes: [{ ...directNode, baseUrl: 'http://api.tokenrouter.com/v1' }],
        },
      },
    }),
    false,
  );
});

test('prefers the explicit workload marker over tool inference', () => {
  const explicitChat = new Request('https://example.com', {
    headers: { [ModelPoolHeader.Workload]: ModelPoolWorkload.Chat },
  });
  assert.equal(
    resolveRequestWorkload(explicitChat, { tools: [{ type: 'function' }] }),
    ModelPoolWorkload.Chat,
  );

  const inferredWork = new Request('https://example.com');
  assert.equal(
    resolveRequestWorkload(inferredWork, { tools: [{ type: 'function' }] }),
    ModelPoolWorkload.Work,
  );
});
