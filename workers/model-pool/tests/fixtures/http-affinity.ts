import worker from '../../src/index.ts';
import { ModelPoolIdentityKind } from '../../src/business-policy.ts';
import {
  ModelPoolHeader,
  ModelPoolWorkload,
  ProviderNodeKind,
  RouteMode,
} from '../../src/routing.ts';

export async function exerciseHttpAffinity(env: Env, ctx: ExecutionContext) {
  const userId = crypto.randomUUID();
  const calls: string[] = [];
  let enter: () => void = () => undefined;
  let unblock: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  const blocked = new Promise<void>(resolve => {
    unblock = resolve;
  });
  let hold = true;
  let reject = false;
  let primaryResponse = () => new Response(null, { status: 503 });
  const primary = '@cf/test/primary';
  const fallback = '@cf/test/fallback';
  const nodes = [primary, fallback].map((model, index) => ({
    id: `node-${index}`,
    model,
    kind: ProviderNodeKind.WorkersAi,
  }));
  const workload = { name: 'test-route', maxOutputTokens: 1024, nodes };
  const snapshot = {
    user_status: 'active',
    daily_request_limit: 10,
    daily_token_limit: null,
    monthly_token_limit: null,
    model_enabled: 1,
    entitlement_enabled: 1,
    entitlement_expires_at: null,
    route_enabled: 1,
    openai_route: 'test-route',
    chat_openai_route: 'test-route',
    work_openai_route: 'test-route',
  };
  // External bindings are test doubles; quota/session DOs and the HTTP handler are real.
  const testEnv = {
    ...env,
    ENVIRONMENT: 'production',
    AUTH_SERVICE: { authenticate: async () => ({ userId, kind: ModelPoolIdentityKind.User }) },
    MODEL_CONFIG: {
      get: async () => ({
        enabled: true,
        gatewayId: 'test',
        mode: RouteMode.ProviderPool,
        protocol: 'openai',
        routes: { [ModelPoolWorkload.Chat]: workload, [ModelPoolWorkload.Work]: workload },
      }),
    },
    DB: {
      prepare: () => ({
        bind() {
          return this;
        },
        first: async () => snapshot,
        run: async () => ({}),
      }),
    },
    AI: {
      run: async (model: string) => {
        calls.push(model);
        if (reject) return Response.json({ error: 'rejected' }, { status: 400 });
        if (model === primary) return primaryResponse();
        if (hold) {
          hold = false;
          enter();
          await blocked;
        }
        return Response.json({
          model,
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    },
  } as unknown as Env;
  const request = (
    mode: ModelPoolWorkload = ModelPoolWorkload.Chat,
    conversationId = 'session-1',
  ) =>
    new Request('https://test/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        [ModelPoolHeader.ConversationId]: conversationId,
        [ModelPoolHeader.Workload]: mode,
      },
      body: JSON.stringify({
        model: 'zhiyuan-free',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
  const firstPending = worker.fetch(request(), testEnv, ctx);
  await Promise.race([
    entered,
    firstPending.then(async response => {
      throw new Error(
        `First request returned before reaching upstream: ${response.status} ${await response.text()}`,
      );
    }),
  ]);
  const busy = await worker.fetch(request(), testEnv, ctx);
  unblock();
  const first = await firstPending;
  const second = await worker.fetch(request(), testEnv, ctx);
  const chatCalls = [...calls];
  await worker.fetch(request(ModelPoolWorkload.Work), testEnv, ctx);
  const workCalls = calls.slice(chatCalls.length);
  reject = true;
  const rejected = await worker.fetch(request(), testEnv, ctx);
  const user = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(userId));
  const key = JSON.stringify(['zhiyuan-free', ModelPoolWorkload.Chat, 'session-1']);
  const stored = await user.beginSession(key);
  if (stored) await user.releaseSession(key, stored.token);
  reject = false;
  const recovery: Array<{ status: number; calls: string[]; content: string }> = [];
  for (const respond of [
    () => Response.json({ error: 'model unavailable' }, { status: 404 }),
    () => Response.json({ choices: [] }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
  ]) {
    primaryResponse = respond;
    const start = calls.length;
    const response = await worker.fetch(
      request(ModelPoolWorkload.Chat, crypto.randomUUID()),
      testEnv,
      ctx,
    );
    const value = await response.json<{ choices: Array<{ message: { content: string } }> }>();
    recovery.push({
      status: response.status,
      calls: calls.slice(start),
      content: value.choices[0].message.content,
    });
  }
  return {
    first: first.status,
    second: second.status,
    busy: busy.status,
    retryAfter: busy.headers.get('retry-after'),
    remaining: second.headers.get('x-zhiyuan-quota-remaining'),
    chatCalls,
    workCalls,
    rejected: rejected.status,
    storedModel: stored?.binding?.model,
    recovery,
  };
}
