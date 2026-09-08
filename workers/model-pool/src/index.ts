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
import { ProviderPool } from './provider-pool.ts';
import { observationFromResponse, shouldTryNextProvider } from './provider-observation.ts';
import { rewriteUpstreamResponse } from './response-rewrite.ts';
import {
  isRouteConfig,
  ModelPoolWorkload,
  ProviderNodeKind,
  resolveConversationId,
  resolveRequestWorkload,
  RouteMode,
  type AiGatewayRoute,
  type DirectProviderNode,
  type DirectTestRoute,
  type GatewayProviderNode,
  type ProviderPoolRoute,
  type RouteConfig,
} from './routing.ts';
import type { TokenUsage } from './usage.ts';
import {
  bindSession,
  orderSessionNodes,
  preferredAlias,
  SessionAffinityStore,
  type SessionBinding,
} from './session-affinity.ts';

const ApiPath = {
  ChatCompletions: '/v1/chat/completions',
  Health: '/health',
  Models: '/v1/models',
} as const;

const LogicalModel = {
  Free: 'zhiyuan-free',
} as const;

const WorkersAiModel = {
  Free: '@cf/openai/gpt-oss-20b',
} as const;

const RouteKey = {
  Free: `route:${LogicalModel.Free}`,
} as const;

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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
  private readonly sessions: SessionAffinityStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sessions = new SessionAffinityStore(ctx.storage.sql);
  }

  beginSession(key: string) {
    return this.sessions.begin(key);
  }
  finishSession(key: string, token: string, binding: SessionBinding) {
    return this.sessions.finish(key, token, binding);
  }
  releaseSession(key: string, token: string) {
    this.sessions.release(key, token);
  }

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

async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<AuthenticatedUser | Response> {
  const token = bearerToken(request);
  if (!token)
    return errorResponse('unauthorized', 'A valid ZhiYuan account session is required.', 401);

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
    return errorResponse(
      'authentication_unavailable',
      'Account authentication is temporarily unavailable.',
      503,
    );
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
  model: string,
  request: Request,
  env: Env,
): Promise<Response> {
  body.model = model;
  return (await env.AI.run(model, body as ChatCompletionsMessagesInput, {
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
  })) as unknown as Response;
}

interface RoutedResponse {
  sessionBinding?: SessionBinding;
  rejectLease?: () => Promise<void>;
  releaseLease?: () => Promise<void>;
  response: Response;
}

function failedProviderObservation() {
  return {
    status: 503,
    retryAfterMs: null,
    limitRequests: null,
    remainingRequests: null,
    resetRequestsAt: null,
    limitTokens: null,
    remainingTokens: null,
    resetTokensAt: null,
  };
}

async function runGatewayProvider(
  body: Record<string, unknown>,
  route: ProviderPoolRoute,
  node: GatewayProviderNode,
  request: Request,
  env: Env,
  affinityKey: string,
  binding: SessionBinding | null,
): Promise<RoutedResponse | null> {
  const poolId = env.PROVIDER_POOL.idFromName(`${route.gatewayId}:${node.poolId}`);
  const pool = env.PROVIDER_POOL.get(poolId);
  const excludedCandidateIds: string[] = [];
  const gatewayUrl = await env.AI.gateway(route.gatewayId).getUrl(node.provider);
  const upstreamUrl = new URL('chat/completions', `${gatewayUrl.replace(/\/$/, '')}/`);

  for (let attempt = 0; attempt < node.maxAliasAttempts; attempt += 1) {
    request.signal.throwIfAborted();
    const lease = await pool.acquire(
      node,
      affinityKey,
      excludedCandidateIds,
      Date.now(),
      preferredAlias(route.gatewayId, node, binding),
    );
    if (!lease) return null;
    excludedCandidateIds.push(lease.candidateId);

    let response: Response;
    try {
      response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          accept: request.headers.get('accept') ?? 'application/json',
          'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`,
          'cf-aig-byok-alias': lease.alias,
          'content-type': 'application/json',
          'user-agent': 'ZhiYuanModelPool/1.0',
        },
        body: JSON.stringify({ ...body, model: node.model }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(node.timeoutMs)]),
      });
    } catch (error) {
      if (request.signal.aborted) {
        await pool.release(lease.leaseId);
        throw error;
      }
      await pool.report(lease, failedProviderObservation());
      console.warn(`[ModelPool] provider ${node.id} request attempt failed:`, error);
      continue;
    }

    const observation = observationFromResponse(response);
    if (response.ok) {
      await pool.observe(lease, observation);
      return {
        response,
        sessionBinding: bindSession(route.gatewayId, node, lease.alias),
        rejectLease: () => pool.report(lease, failedProviderObservation()),
        releaseLease: () => pool.release(lease.leaseId),
      };
    }

    await pool.report(lease, observation);
    if (!shouldTryNextProvider(response.status)) return { response };
    console.warn(`[ModelPool] provider ${node.id} returned HTTP ${response.status}`);
    await response.body?.cancel();
  }
  return null;
}

async function runDirectProvider(
  body: Record<string, unknown>,
  route: ProviderPoolRoute,
  node: DirectProviderNode,
  request: Request,
  env: Env,
  affinityKey: string,
  binding: SessionBinding | null,
): Promise<RoutedResponse | null> {
  const poolId = env.PROVIDER_POOL.idFromName(`${route.gatewayId}:${node.poolId}`);
  const pool = env.PROVIDER_POOL.get(poolId);
  const excludedCandidateIds: string[] = [];
  const upstreamUrl = new URL('chat/completions', `${node.baseUrl.replace(/\/$/, '')}/`);

  for (let attempt = 0; attempt < node.maxAliasAttempts; attempt += 1) {
    request.signal.throwIfAborted();
    const lease = await pool.acquire(
      node,
      affinityKey,
      excludedCandidateIds,
      Date.now(),
      preferredAlias(route.gatewayId, node, binding),
    );
    if (!lease) return null;
    excludedCandidateIds.push(lease.candidateId);
    const alias = node.aliases.find(candidate => candidate.id === lease.alias);
    const secret = alias ? (env as unknown as Record<string, unknown>)[alias.secretBinding] : null;
    if (typeof secret !== 'string' || !secret) {
      await pool.report(lease, { ...failedProviderObservation(), status: 401 });
      console.error(`[ModelPool] provider ${node.id} secret binding is unavailable`);
      continue;
    }

    let response: Response;
    try {
      response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          accept: request.headers.get('accept') ?? 'application/json',
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'user-agent': 'ZhiYuanModelPool/1.0',
        },
        body: JSON.stringify({ ...body, model: node.model }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(node.timeoutMs)]),
      });
    } catch (error) {
      if (request.signal.aborted) {
        await pool.release(lease.leaseId);
        throw error;
      }
      await pool.report(lease, failedProviderObservation());
      console.warn(`[ModelPool] provider ${node.id} request attempt failed:`, error);
      continue;
    }

    const observation = observationFromResponse(response);
    if (response.ok) {
      await pool.observe(lease, observation);
      return {
        response,
        sessionBinding: bindSession(route.gatewayId, node, lease.alias),
        rejectLease: () => pool.report(lease, failedProviderObservation()),
        releaseLease: () => pool.release(lease.leaseId),
      };
    }

    await pool.report(lease, observation);
    if (!shouldTryNextProvider(response.status)) return { response };
    console.warn(`[ModelPool] provider ${node.id} returned HTTP ${response.status}`);
    await response.body?.cancel();
  }
  return null;
}

async function runProviderPool(
  body: Record<string, unknown>,
  route: ProviderPoolRoute,
  request: Request,
  env: Env,
  workload: ModelPoolWorkload,
  conversationId: string,
  binding: SessionBinding | null,
): Promise<RoutedResponse> {
  const workloadRoute = route.routes[workload];
  for (const node of orderSessionNodes(route.gatewayId, workloadRoute.nodes, binding)) {
    request.signal.throwIfAborted();
    if (node.kind === ProviderNodeKind.WorkersAi) {
      try {
        const response = await runWorkersAi(body, route.gatewayId, node.model, request, env);
        if (response.ok)
          return { response, sessionBinding: bindSession(route.gatewayId, node, null) };
        if (!shouldTryNextProvider(response.status)) return { response };
        console.warn(`[ModelPool] Workers AI node ${node.id} returned HTTP ${response.status}`);
        await response.body?.cancel();
      } catch (error) {
        if (request.signal.aborted) throw error;
        console.warn(`[ModelPool] Workers AI node ${node.id} request failed:`, error);
      }
      continue;
    }

    const result =
      node.kind === ProviderNodeKind.Direct
        ? await runDirectProvider(
            body,
            route,
            node,
            request,
            env,
            `${workload}:${conversationId}`,
            binding,
          )
        : await runGatewayProvider(
            body,
            route,
            node,
            request,
            env,
            `${workload}:${conversationId}`,
            binding,
          );
    if (result) return result;
  }
  throw new Error(`No ${workload} provider is currently available`);
}

async function runRoute(
  body: Record<string, unknown>,
  route: RouteConfig,
  request: Request,
  env: Env,
  workload: ModelPoolWorkload,
  conversationId: string,
  binding: SessionBinding | null,
): Promise<RoutedResponse> {
  if (route.mode === RouteMode.ProviderPool) {
    return runProviderPool(body, route, request, env, workload, conversationId, binding);
  }

  if (route.mode === RouteMode.AiGateway) {
    const upstreamResponse = await runAiGateway(body, route, request, env);
    if (upstreamResponse.ok) return { response: upstreamResponse };

    console.warn(
      `[ModelPool] dynamic route returned HTTP ${upstreamResponse.status}; using Workers AI fallback`,
    );
    await upstreamResponse.body?.cancel();
    body.model = WorkersAiModel.Free;
    return {
      response: await runWorkersAi(body, route.gatewayId, WorkersAiModel.Free, request, env),
    };
  }

  body.model = route.upstreamModel;
  return {
    response:
      route.mode === RouteMode.WorkersAiTest
        ? await runWorkersAi(body, route.gatewayId, route.upstreamModel, request, env)
        : await runDirectTest(body, route, request, env),
  };
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
    const access = await resolveModelAccess(env.DB, userId, LogicalModel.Free, identityKind);
    return access.decision === ModelAccessDecision.Allowed
      ? access.policy
      : modelAccessError(access.code);
  } catch (error) {
    console.error('[ModelPool] user policy lookup failed:', error);
    return errorResponse(
      'policy_unavailable',
      'Model access policy is temporarily unavailable.',
      503,
    );
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
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid body');
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
    return errorResponse(
      'model_unavailable',
      'The requested logical model has no active route.',
      503,
    );
  }
  const workload = resolveRequestWorkload(request, body);
  const conversationId = resolveConversationId(request);
  const expectedRoute =
    workload === ModelPoolWorkload.Work ? policy.workOpenAiRoute : policy.chatOpenAiRoute;
  const actualRoute =
    route.mode === RouteMode.ProviderPool
      ? route.routes[workload].name
      : route.mode === RouteMode.AiGateway
        ? route.routeName
        : expectedRoute;
  if (env.ENVIRONMENT === 'production' && actualRoute !== expectedRoute) {
    console.error('[ModelPool] D1 and KV route mappings do not match');
    return errorResponse(
      'model_unavailable',
      'The requested logical model has no active route.',
      503,
    );
  }

  const quotaId = env.USER_QUOTA.idFromName(authentication.userId);
  const quotaStub = env.USER_QUOTA.get(quotaId);
  const sessionKey = JSON.stringify([LogicalModel.Free, workload, conversationId]);
  const selection =
    route.mode === RouteMode.ProviderPool ? await quotaStub.beginSession(sessionKey) : null;
  if (route.mode === RouteMode.ProviderPool && !selection) {
    const response = errorResponse('session_busy', 'Session routing is busy. Retry shortly.', 503);
    response.headers.set('retry-after', '2');
    return response;
  }
  try {
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

    const routeMaxOutputTokens =
      route.mode === RouteMode.ProviderPool ? route.routes[workload].maxOutputTokens : 32_768;
    if (quota.remainingTokens !== null) {
      const configuredMaxTokens =
        typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens)
          ? body.max_tokens
          : routeMaxOutputTokens;
      body.max_tokens = Math.max(
        1,
        Math.min(configuredMaxTokens, quota.remainingTokens, routeMaxOutputTokens),
      );
    } else {
      const configuredMaxTokens =
        typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens)
          ? body.max_tokens
          : routeMaxOutputTokens;
      body.max_tokens = Math.max(1, Math.min(configuredMaxTokens, routeMaxOutputTokens));
    }

    if (body.stream === true) {
      body.stream_options = { include_usage: true };
    }

    let routedResponse: RoutedResponse;
    try {
      routedResponse = await runRoute(
        body,
        route,
        request,
        env,
        workload,
        JSON.stringify([authentication.userId, conversationId]),
        selection?.binding ?? null,
      );
    } catch (error) {
      console.error('[ModelPool] upstream inference failed:', error);
      return errorResponse('upstream_error', 'The model service is temporarily unavailable.', 502);
    }
    const upstreamResponse = routedResponse.response;

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
    let responseBody: BodyInit | null = null;
    try {
      responseBody = await rewriteUpstreamResponse(
        upstreamResponse,
        LogicalModel.Free,
        resolveUsage,
      );
    } catch (error) {
      if (responseBody instanceof ReadableStream) await responseBody.cancel();
      if (request.signal.aborted) await routedResponse.releaseLease?.();
      else await (routedResponse.rejectLease?.() ?? routedResponse.releaseLease?.());
      console.error('[ModelPool] upstream response processing failed:', error);
      return errorResponse(
        'upstream_error',
        'The model service returned an invalid response.',
        502,
      );
    }
    ctx.waitUntil(
      usage.then(async value => {
        try {
          await recordTokenUsage(env, policy, quotaStub, date, value);
        } finally {
          await routedResponse.releaseLease?.();
        }
      }),
    );

    if (selection && routedResponse.sessionBinding) {
      try {
        request.signal.throwIfAborted();
        if (
          !(await quotaStub.finishSession(
            sessionKey,
            selection.token,
            routedResponse.sessionBinding,
          ))
        ) {
          throw new Error('Session selection lease expired');
        }
      } catch (error) {
        // Local selection failure is not evidence of an unhealthy upstream key.
        if (responseBody instanceof ReadableStream) await responseBody.cancel();
        await routedResponse.releaseLease?.();
        console.warn('[ModelPool] session binding could not be committed:', error);
        const response = errorResponse(
          'session_busy',
          'Session routing changed. Retry shortly.',
          503,
        );
        response.headers.set('retry-after', '2');
        return response;
      }
    }

    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers,
    });
  } finally {
    if (selection) await quotaStub.releaseSession(sessionKey, selection.token);
  }
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

export { ProviderPool };
