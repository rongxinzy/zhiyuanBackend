import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectProvider, FallbackPolicy } from '../src/provider-selection.ts';
import { isRouteConfig, ModelPoolWorkload, ProviderNodeKind, RouteMode } from '../src/routing.ts';
import { SelectionBudgetExceededError, timedUpstream } from '../src/upstream-timing.ts';

const route = JSON.parse(
  readFileSync(new URL('../cloudflare/provider-pool.route.json', import.meta.url), 'utf8'),
);
if (!isRouteConfig(route) || route.mode !== RouteMode.ProviderPool)
  throw new Error('Invalid fixture');

test('relay keeps the same Kimi quota scope, and gateway rollback retains fallback budget', async t => {
  t.mock.method(Date, 'now', () => 0);
  const node = route.routes[ModelPoolWorkload.Work].nodes.find(node => node.kind !== ProviderNodeKind.WorkersAi && node.poolId === 'kimi');
  assert.ok(node && node.kind === ProviderNodeKind.Direct);
  assert.equal(node.model, 'kimi-for-coding');
  assert.equal(node.aliases[0].quotaScopeId, 'kimi-default');
  assert.equal(node.aliases[0].secretBinding, 'KIMI_RELAY_TOKEN');
  assert.equal(node.aliases[0].id, 'vercel-default');
  const gateway = { ...node, kind: ProviderNodeKind.Gateway, provider: 'custom-kimi-code' };
  await selectProvider([gateway], ModelPoolWorkload.Work, new AbortController().signal,
    async (_node, budget) => { assert.equal(budget.remaining(), 45_000); return true; });
});

for (const workload of Object.values(ModelPoolWorkload)) {
  const nodes = route.routes[workload].nodes;
  test(`${workload}: slow earlier nodes cannot consume the Kimi reserve`, async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const seen: string[] = [];
    const result = await selectProvider(
      nodes,
      workload,
      new AbortController().signal,
      async (node, budget) => {
        seen.push(node.id);
        const remaining = budget.remaining();
        if (node.id === `kimi-${workload}`) {
          assert.equal(
            remaining,
            workload === ModelPoolWorkload.Chat
              ? FallbackPolicy.ChatReserveMs
              : FallbackPolicy.WorkReserveMs,
          );
          return node.id;
        }
        now += remaining;
        // Also covers expiry between alias acquisition and starting another fetch.
        throw new SelectionBudgetExceededError();
      },
    );
    assert.equal(result, `kimi-${workload}`);
    assert.deepEqual(
      seen,
      workload === ModelPoolWorkload.Chat
        ? ['tokenrouter-chat', 'openrouter-chat', 'kimi-chat']
        : ['tokenrouter-work', 'groq-work', 'kimi-work'],
    );
  });

  test(`${workload}: affinity, fast success and unavailable fallback preserve remaining opportunities`, async t => {
    t.mock.method(Date, 'now', () => 0);
    const fallback = nodes.find(node => node.id === `kimi-${workload}`)!;
    const seen: string[] = [];
    const sticky = await selectProvider(
      [fallback, ...nodes.filter(node => node !== fallback)],
      workload,
      new AbortController().signal,
      async (node, budget) => {
        seen.push(node.id);
        assert.equal(budget.remaining(), workload === ModelPoolWorkload.Chat ? 30_000 : 45_000);
        return node.id;
      },
    );
    assert.equal(sticky, fallback.id);
    assert.deepEqual(seen, [fallback.id]);
    const first = await selectProvider(
      nodes,
      workload,
      new AbortController().signal,
      async node => node.id,
    );
    assert.equal(first, nodes[0].id);
    seen.length = 0;
    await assert.rejects(
      selectProvider(nodes, workload, new AbortController().signal, async node => {
        seen.push(node.id);
        return null; // Includes an unavailable/cooldown Kimi key, without spending its reserve.
      }),
      /currently available/,
    );
    assert.deepEqual(
      seen,
      nodes.map(node => node.id),
    );
  });
}

test('routes without Kimi keep the original budget, and cancellation never starts another provider', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const nodes = route.routes[ModelPoolWorkload.Chat].nodes.filter(node => node.id !== 'kimi-chat');
  let attempts = 0;
  await assert.rejects(
    selectProvider(
      nodes,
      ModelPoolWorkload.Chat,
      new AbortController().signal,
      async (_node, budget) => {
        attempts++;
        now += budget.remaining();
        return null;
      },
    ),
    /deadline exceeded/,
  );
  assert.equal(now, 30_000);
  assert.equal(attempts, 4);
  const controller = new AbortController();
  attempts = 0;
  await assert.rejects(
    selectProvider(
      route.routes[ModelPoolWorkload.Chat].nodes,
      ModelPoolWorkload.Chat,
      controller.signal,
      async () => {
        attempts++;
        controller.abort();
        return null;
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(attempts, 1);
});

test('after reserve promotion, unavailable Kimi leaves unattempted nodes in order', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const seen: string[] = [];
  const result = await selectProvider(
    route.routes[ModelPoolWorkload.Chat].nodes,
    ModelPoolWorkload.Chat,
    new AbortController().signal,
    async (node, budget) => {
      seen.push(node.id);
      if (seen.length <= 2) now += budget.remaining();
      if (node.id === 'agens-chat') return node.id;
      return null;
    },
  );
  assert.equal(result, 'agens-chat');
  assert.deepEqual(seen, ['tokenrouter-chat', 'openrouter-chat', 'kimi-chat', 'agens-chat']);
  assert.equal(now, 15_000);
});

test('an established stream failure never replays selection onto Kimi', async () => {
  let attempts = 0;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const signal = new AbortController().signal;
  const selected = await selectProvider(
    route.routes[ModelPoolWorkload.Chat].nodes,
    ModelPoolWorkload.Chat,
    signal,
    async (_node, budget) => {
      attempts++;
      return timedUpstream(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                output = controller;
                controller.enqueue(
                  new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'),
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        signal,
        budget.remaining(),
        true,
      );
    },
  );
  const reader = selected.body!.getReader();
  assert.equal((await reader.read()).done, false);
  output!.error(new Error('Connection lost'));
  await assert.rejects(reader.read(), /Connection lost/);
  assert.equal(attempts, 1);
});
