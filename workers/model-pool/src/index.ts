import { DurableObject } from 'cloudflare:workers';

import {
  incrementDailyRequestUsage,
  incrementDailyTokenUsage,
  ModelAccessDecision,
  ModelAccessDenialCode,
  ModelPoolIdentityKind,
  type ModelAccessPolicy,
  resolveModelAccess,
} from './business-policy.ts';
import { rewriteUpstreamResponse } from './response-rewrite.ts';
import type { TokenUsage } from './usage.ts';

interface DirectTestRoute {
  enabled: boolean;
  mode: 'direct-test';
  protocol: 'openai';
  upstreamBaseUrl: string;
  upstreamModel: string;
}

interface AiGatewayRoute {
  enabled: boolean;
  gatewayId: string;
  mode: 'ai-gateway';
  protocol: 'openai';
  routeName: string;
}

interface WorkersAiTestRoute {
  enabled: boolean;
  gatewayId: string;
  mode: 'workers-ai-test';
  protocol: 'openai';
  upstreamModel: typeof WorkersAiModel.Free;
}

type RouteConfig = AiGatewayRoute | DirectTestRoute | WorkersAiTestRoute;

const ApiPath = {
  ChatCompletions: '/v1/chat/completions',
  Health: '/health',
  Models: '/v1/models',
} as const;

const LogicalModel = {
  Free: 'zhiyuan-free',
} as const;

const RouteMode = {
  AiGateway: 'ai-gateway',
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
const DYNAMIC_ROUTE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

interface AuthenticatedUser {
  kind: ModelPoolIdentityKind;
  userId: string;
}

interface AuthServiceBinding {
  authenticate(
    accessToken: string,
  ): Promise<{ userId: string; expiresAt: number; kind: ModelPoolIdentityKind } | null>;
}

interface QuotaLimits {
  dailyRequests: number | null;
  dailyTokens: number | null;
  monthlyTokens: number | null;
}

const QuotaDenialReason = {
  DailyRequests: 'daily_requests',
  DailyTokens: 'daily_tokens',
  MonthlyTokens: 'monthly_tokens',
} as const;

interface RequestQuotaResult {
  allowed: boolean;
  reason?: (typeof QuotaDenialReason)[keyof typeof QuotaDenialReason];
  remainingRequests: number | null;
  remainingTokens: number | null;
}

export class UserQuota extends DurableObject<Env> {
  async reserveRequest(limits: QuotaLimits, date: string): Promise<RequestQuotaResult> {
    const month = date.slice(0, 7);
    const requestKey = `requests:${date}`;
    const dailyTokenKey = `tokens:${date}`;
    const monthlyTokenKey = `tokens:${month}`;
    const [currentRequests, currentDailyTokens, currentMonthlyTokens] = await Promise.all([
      this.ctx.storage.get<number>(requestKey),
      this.ctx.storage.get<number>(dailyTokenKey),
      this.ctx.storage.get<number>(monthlyTokenKey),
    ]);
    const requests = currentRequests ?? 0;
    const dailyTokens = currentDailyTokens ?? 0;
    const monthlyTokens = currentMonthlyTokens ?? 0;
    const remainingTokens = Math.min(
      limits.dailyTokens === null ? Number.POSITIVE_INFINITY : limits.dailyTokens - dailyTokens,
      limits.monthlyTokens === null
        ? Number.POSITIVE_INFINITY
        : limits.monthlyTokens - monthlyTokens,
    );
    const normalizedRemainingTokens = Number.isFinite(remainingTokens)
      ? Math.max(0, remainingTokens)
      : null;

    if (limits.dailyRequests !== null && requests >= limits.dailyRequests) {
      return {
        allowed: false,
        reason: QuotaDenialReason.DailyRequests,
        remainingRequests: 0,
        remainingTokens: normalizedRemainingTokens,
      };
    }
    if (limits.dailyTokens !== null && dailyTokens >= limits.dailyTokens) {
      return {
        allowed: false,
        reason: QuotaDenialReason.DailyTokens,
        remainingRequests:
          limits.dailyRequests === null ? null : Math.max(0, limits.dailyRequests - requests),
        remainingTokens: 0,
      };
    }
    if (limits.monthlyTokens !== null && monthlyTokens >= limits.monthlyTokens) {
      return {
        allowed: false,
        reason: QuotaDenialReason.MonthlyTokens,
        remainingRequests:
          limits.dailyRequests === null ? null : Math.max(0, limits.dailyRequests - requests),
        remainingTokens: 0,
      };
    }

    const next = requests + 1;
    await this.ctx.storage.put(requestKey, next);
    return {
      allowed: true,
      remainingRequests:
        limits.dailyRequests === null ? null : Math.max(0, limits.dailyRequests - next),
      remainingTokens: normalizedRemainingTokens,
    };
  }

  async recordTokens(usage: TokenUsage, date: string): Promise<void> {
    const totalTokens = usage.inputTokens + usage.outputTokens;
    if (totalTokens === 0) return;
    const month = date.slice(0, 7);
    const dailyTokenKey = `tokens:${date}`;
    const monthlyTokenKey = `tokens:${month}`;
    const [dailyTokens, monthlyTokens] = await Promise.all([
      this.ctx.storage.get<number>(dailyTokenKey),
      this.ctx.storage.get<number>(monthlyTokenKey),
    ]);
    await this.ctx.storage.put({
      [dailyTokenKey]: (dailyTokens ?? 0) + totalTokens,
      [monthlyTokenKey]: (monthlyTokens ?? 0) + totalTokens,
    });
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
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actualBytes.byteLength; index += 1) {
    difference |= actualBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthenticatedUser | Response> {
  const token = bearerToken(request);
  if (!token) return errorResponse('unauthorized', 'A valid ZhiYuan account session is required.', 401);

  if (env.ENVIRONMENT === 'staging' && secretsMatch(token, env.MODEL_POOL_TEST_TOKEN)) {
    return { userId: 'staging-test-user', kind: ModelPoolIdentityKind.User };
  }

  try {
    const authService = env.AUTH_SERVICE as unknown as AuthServiceBinding;
    const identity = await authService.authenticate(token);
    return identity
      ? { userId: identity.userId, kind: identity.kind }
      : errorResponse('unauthorized', 'A valid ZhiYuan account session is required.', 401);
  } catch (error) {
    console.error('[ModelPool] account authentication failed:', error);
    return errorResponse('authentication_unavailable', 'Account authentication is temporarily unavailable.', 503);
  }
}

function isRouteConfig(value: unknown): value is RouteConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  if (route.enabled !== true || route.protocol !== 'openai') return false;

  if (route.mode === RouteMode.AiGateway) {
    return (
      typeof route.gatewayId === 'string' &&
      route.gatewayId.length > 0 &&
      typeof route.routeName === 'string' &&
      DYNAMIC_ROUTE_NAME_PATTERN.test(route.routeName)
    );
  }

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

async function runAiGateway(
  body: Record<string, unknown>,
  route: AiGatewayRoute,
  request: Request,
  env: Env,
): Promise<Response> {
  body.model = `dynamic/${route.routeName}`;
  return env.AI.gateway(route.gatewayId).run(
    {
      provider: 'compat',
      endpoint: 'chat/completions',
      headers: {},
      query: body,
    },
    { signal: request.signal },
  );
}

async function runWorkersAi(
  body: Record<string, unknown>,
  gatewayId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  return env.AI.run(WorkersAiModel.Free, body as ChatCompletionsMessagesInput, {
    gateway: {
      id: gatewayId,
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
  if (route.mode === RouteMode.AiGateway) {
    const upstreamResponse = await runAiGateway(body, route, request, env);
    if (upstreamResponse.ok) return upstreamResponse;

    console.warn(
      `[ModelPool] dynamic route returned HTTP ${upstreamResponse.status}; using Workers AI fallback`,
    );
    await upstreamResponse.body?.cancel();
    body.model = WorkersAiModel.Free;
    return runWorkersAi(body, route.gatewayId, request, env);
  }

  body.model = route.upstreamModel;
  return route.mode === RouteMode.WorkersAiTest
    ? runWorkersAi(body, route.gatewayId, request, env)
    : runDirectTest(body, route, request, env);
}

function modelAccessError(code: string): Response {
  if (code === ModelAccessDenialCode.AccountDisabled) {
    return errorResponse('account_disabled', 'The ZhiYuan account cannot use model services.', 403);
  }
  if (code === ModelAccessDenialCode.EntitlementRequired) {
    return errorResponse(
      'entitlement_required',
      'The account is not entitled to use the requested logical model.',
      403,
    );
  }
  return errorResponse('model_unavailable', 'The requested logical model is unavailable.', 503);
}

async function loadAccessPolicy(
  env: Env,
  userId: string,
  identityKind: ModelPoolIdentityKind,
): Promise<ModelAccessPolicy | Response> {
  try {
    const access = await resolveModelAccess(
      env.DB,
      userId,
      LogicalModel.Free,
      identityKind,
    );
    return access.decision === ModelAccessDecision.Allowed
      ? access.policy
      : modelAccessError(access.code);
  } catch (error) {
    console.error('[ModelPool] user policy lookup failed:', error);
    return errorResponse('policy_unavailable', 'Model access policy is temporarily unavailable.', 503);
  }
}

function usageDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function recordRequestUsage(
  env: Env,
  policy: ModelAccessPolicy,
  date: string,
): Promise<void> {
  try {
    await incrementDailyRequestUsage(env.DB, policy.userId, LogicalModel.Free, date);
  } catch (error) {
    console.error('[ModelPool] request usage recording failed:', error);
  }
}

async function recordTokenUsage(
  env: Env,
  policy: ModelAccessPolicy,
  quota: DurableObjectStub<UserQuota>,
  date: string,
  usage: TokenUsage,
): Promise<void> {
  try {
    await Promise.all([
      quota.recordTokens(usage, date),
      incrementDailyTokenUsage(
        env.DB,
        policy.userId,
        LogicalModel.Free,
        date,
        usage.inputTokens,
        usage.outputTokens,
      ),
    ]);
  } catch (error) {
    console.error('[ModelPool] token usage recording failed:', error);
  }
}

async function proxyChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authentication = await authenticateRequest(request, env);
  if (authentication instanceof Response) return authentication;

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

  const policy = await loadAccessPolicy(env, authentication.userId, authentication.kind);
  if (policy instanceof Response) return policy;

  const route = await loadFreeRoute(env);
  if (!route) {
    return errorResponse('model_unavailable', 'The requested logical model has no active route.', 503);
  }
  if (
    env.ENVIRONMENT === 'production' &&
    route.mode === RouteMode.AiGateway &&
    route.routeName !== policy.openAiRoute
  ) {
    console.error('[ModelPool] D1 and KV route mappings do not match');
    return errorResponse('model_unavailable', 'The requested logical model has no active route.', 503);
  }

  const quotaId = env.USER_QUOTA.idFromName(authentication.userId);
  const quotaStub = env.USER_QUOTA.get(quotaId);
  const date = usageDate();
  const quota = await quotaStub.reserveRequest(
    {
      dailyRequests: policy.dailyRequestLimit,
      dailyTokens: policy.dailyTokenLimit,
      monthlyTokens: policy.monthlyTokenLimit,
    },
    date,
  );
  if (!quota.allowed) {
    return errorResponse('quota_exceeded', 'The free model quota has been exhausted.', 429);
  }
  ctx.waitUntil(recordRequestUsage(env, policy, date));

  if (quota.remainingTokens !== null) {
    const configuredMaxTokens =
      typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens)
        ? body.max_tokens
        : 32_768;
    body.max_tokens = Math.max(1, Math.min(configuredMaxTokens, quota.remainingTokens));
  }

  if (body.stream === true) {
    body.stream_options = { include_usage: true };
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
  if (quota.remainingRequests !== null) {
    headers.set('x-zhiyuan-quota-remaining', String(quota.remainingRequests));
  }
  if (quota.remainingTokens !== null) {
    headers.set('x-zhiyuan-token-quota-remaining', String(quota.remainingTokens));
  }

  let resolveUsage: (usage: TokenUsage) => void = () => undefined;
  const usage = new Promise<TokenUsage>(resolve => {
    resolveUsage = resolve;
  });
  const responseBody = await rewriteUpstreamResponse(
    upstreamResponse,
    LogicalModel.Free,
    resolveUsage,
  );
  ctx.waitUntil(usage.then(value => recordTokenUsage(env, policy, quotaStub, date, value)));

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === ApiPath.Health) {
      return json({
        service: 'zhiyuan-model-pool',
        environment: env.ENVIRONMENT,
        status: 'ok',
      });
    }

    if (request.method === 'GET' && url.pathname === ApiPath.Models) {
      const authentication = await authenticateRequest(request, env);
      if (authentication instanceof Response) return authentication;

      const policy = await loadAccessPolicy(env, authentication.userId, authentication.kind);
      if (policy instanceof Response) {
        return policy.status === 403 ? json({ object: 'list', data: [] }) : policy;
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
      return proxyChatCompletions(request, env, ctx);
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
