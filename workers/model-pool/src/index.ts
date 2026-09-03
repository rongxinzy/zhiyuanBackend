import { DurableObject } from 'cloudflare:workers';

interface DirectTestRoute {
  enabled: boolean;
  mode: 'direct-test';
  protocol: 'openai';
  upstreamBaseUrl: string;
  upstreamModel: string;
}

interface WorkersAiTestRoute {
  enabled: boolean;
  gatewayId: string;
  mode: 'workers-ai-test';
  protocol: 'openai';
  upstreamModel: typeof WorkersAiModel.Free;
}

type RouteConfig = DirectTestRoute | WorkersAiTestRoute;

const ApiPath = {
  ChatCompletions: '/v1/chat/completions',
  Health: '/health',
  Models: '/v1/models',
} as const;

const LogicalModel = {
  Free: 'zhiyuan-free',
} as const;

const RouteMode = {
  DirectTest: 'direct-test',
  WorkersAiTest: 'workers-ai-test',
} as const;

const WorkersAiModel = {
  Free: '@cf/openai/gpt-oss-20b',
} as const;

const RouteKey = {
  Free: `route:${LogicalModel.Free}`,
} as const;

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export class UserQuota extends DurableObject<Env> {
  async reserveRequest(limit: number): Promise<{ allowed: boolean; remaining: number }> {
    const date = new Date().toISOString().slice(0, 10);
    const key = `requests:${date}`;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;

    if (current >= limit) return { allowed: false, remaining: 0 };

    const next = current + 1;
    await this.ctx.storage.put(key, next);
    return { allowed: true, remaining: Math.max(0, limit - next) };
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

function secretsMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  return actualBytes.byteLength === expectedBytes.byteLength &&
    crypto.subtle.timingSafeEqual(actualBytes, expectedBytes);
}

function isRouteConfig(value: unknown): value is RouteConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  if (route.enabled !== true || route.protocol !== 'openai') return false;

  if (route.mode === RouteMode.WorkersAiTest) {
    return (
      typeof route.gatewayId === 'string' &&
      route.gatewayId.length > 0 &&
      route.upstreamModel === WorkersAiModel.Free
    );
  }

  if (
    route.mode !== RouteMode.DirectTest ||
    typeof route.upstreamBaseUrl !== 'string' ||
    typeof route.upstreamModel !== 'string'
  ) return false;

  try {
    return new URL(route.upstreamBaseUrl).protocol === 'https:' && route.upstreamModel.length > 0;
  } catch {
    return false;
  }
}

async function loadFreeRoute(env: Env): Promise<RouteConfig | null> {
  const value = await env.MODEL_CONFIG.get<unknown>(RouteKey.Free, 'json');
  return isRouteConfig(value) ? value : null;
}

function dailyRequestLimit(env: Env): number {
  const value = Number.parseInt(env.TEST_DAILY_REQUEST_LIMIT, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 100;
}

function rewriteResponseModel(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return typeof body.model === 'string' ? { ...body, model: LogicalModel.Free } : body;
}

function rewriteSseLine(line: string): string {
  if (!line.startsWith('data:')) return line;

  const data = line.slice('data:'.length).trimStart();
  if (!data || data === '[DONE]') return line;

  try {
    return `data: ${JSON.stringify(rewriteResponseModel(JSON.parse(data)))}`;
  } catch {
    return line;
  }
}

function rewriteSseModel(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
      },
      flush(controller) {
        buffered += decoder.decode();
        if (buffered) controller.enqueue(encoder.encode(rewriteSseLine(buffered)));
      },
    }),
  );
}

async function rewriteUpstreamResponse(upstreamResponse: Response): Promise<BodyInit | null> {
  if (!upstreamResponse.body) return null;

  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) return rewriteSseModel(upstreamResponse.body);

  if (contentType.includes('application/json')) {
    const value: unknown = await upstreamResponse.json();
    return JSON.stringify(rewriteResponseModel(value));
  }

  return upstreamResponse.body;
}

async function runDirectTest(
  body: Record<string, unknown>,
  route: DirectTestRoute,
  request: Request,
  env: Env,
): Promise<Response> {
  const upstreamUrl = new URL('chat/completions', `${route.upstreamBaseUrl.replace(/\/$/, '')}/`);
  return fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      accept: request.headers.get('accept') ?? 'application/json',
      authorization: `Bearer ${env.UPSTREAM_API_KEY}`,
      'content-type': 'application/json',
      'user-agent': 'ZhiYuanModelPool/1.0',
    },
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

async function runWorkersAiTest(
  body: Record<string, unknown>,
  route: WorkersAiTestRoute,
  request: Request,
  env: Env,
): Promise<Response> {
  return env.AI.run(WorkersAiModel.Free, body as ChatCompletionsMessagesInput, {
    gateway: {
      id: route.gatewayId,
      collectLog: true,
      metadata: {
        environment: env.ENVIRONMENT,
        logicalModel: LogicalModel.Free,
      },
    },
    returnRawResponse: true,
    signal: request.signal,
  });
}

async function runRoute(
  body: Record<string, unknown>,
  route: RouteConfig,
  request: Request,
  env: Env,
): Promise<Response> {
  body.model = route.upstreamModel;
  return route.mode === RouteMode.WorkersAiTest
    ? runWorkersAiTest(body, route, request, env)
    : runDirectTest(body, route, request, env);
}

async function proxyChatCompletions(request: Request, env: Env): Promise<Response> {
  if (!secretsMatch(bearerToken(request), env.MODEL_POOL_TEST_TOKEN)) {
    return errorResponse('unauthorized', 'A valid Model Pool access token is required.', 401);
  }

  const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    return errorResponse('request_too_large', 'The request body exceeds the allowed size.', 413);
  }

  let body: Record<string, unknown>;
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid body');
    body = value as Record<string, unknown>;
  } catch {
    return errorResponse('invalid_request', 'The request body must be a JSON object.', 400);
  }

  if (body.model !== LogicalModel.Free) {
    return errorResponse('model_not_found', 'The requested logical model is unavailable.', 404);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse('invalid_request', 'The request must include at least one message.', 400);
  }

  const route = await loadFreeRoute(env);
  if (!route) {
    return errorResponse('model_unavailable', 'The requested logical model has no active route.', 503);
  }

  const quotaId = env.USER_QUOTA.idFromName('model-pool-test-user');
  const quota = await env.USER_QUOTA.get(quotaId).reserveRequest(dailyRequestLimit(env));
  if (!quota.allowed) {
    return errorResponse('quota_exceeded', 'The daily request quota has been exhausted.', 429);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await runRoute(body, route, request, env);
  } catch (error) {
    console.error('[ModelPool] upstream inference failed:', error);
    return errorResponse('upstream_error', 'The model service is temporarily unavailable.', 502);
  }

  const headers = new Headers();
  headers.set('cache-control', 'no-store');
  headers.set('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json');
  headers.set('x-zhiyuan-quota-remaining', String(quota.remaining));

  return new Response(await rewriteUpstreamResponse(upstreamResponse), {
    status: upstreamResponse.status,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === ApiPath.Health) {
      return json({
        service: 'zhiyuan-model-pool',
        environment: env.ENVIRONMENT,
        status: 'ok',
      });
    }

    if (request.method === 'GET' && url.pathname === ApiPath.Models) {
      if (!secretsMatch(bearerToken(request), env.MODEL_POOL_TEST_TOKEN)) {
        return errorResponse('unauthorized', 'A valid Model Pool access token is required.', 401);
      }

      const route = await loadFreeRoute(env);
      return json({
        object: 'list',
        data: route
          ? [
              {
                id: LogicalModel.Free,
                object: 'model',
                owned_by: 'zhiyuan',
              },
            ]
          : [],
      });
    }

    if (request.method === 'POST' && url.pathname === ApiPath.ChatCompletions) {
      return proxyChatCompletions(request, env);
    }

    return json(
      {
        error: {
          code: 'not_implemented',
          message: 'The ZhiYuan Model Pool API is not implemented yet.',
        },
      },
      501,
    );
  },
} satisfies ExportedHandler<Env>;
