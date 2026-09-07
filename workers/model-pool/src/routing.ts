export const ModelPoolWorkload = {
  Chat: 'chat',
  Work: 'work',
} as const;

export type ModelPoolWorkload =
  (typeof ModelPoolWorkload)[keyof typeof ModelPoolWorkload];

export const ModelPoolHeader = {
  ConversationId: 'x-zhiyuan-conversation-id',
  Workload: 'x-zhiyuan-workload',
} as const;

export const RouteMode = {
  AiGateway: 'ai-gateway',
  DirectTest: 'direct-test',
  ProviderPool: 'provider-pool',
  WorkersAiTest: 'workers-ai-test',
} as const;

export const ProviderNodeKind = {
  Direct: 'direct',
  Gateway: 'gateway',
  WorkersAi: 'workers-ai',
} as const;

export interface ProviderAlias {
  id: string;
  quotaScopeId: string;
  weight: number;
}

export interface DirectTestRoute {
  enabled: boolean;
  mode: typeof RouteMode.DirectTest;
  protocol: 'openai';
  upstreamBaseUrl: string;
  upstreamModel: string;
}

export interface AiGatewayRoute {
  enabled: boolean;
  gatewayId: string;
  mode: typeof RouteMode.AiGateway;
  protocol: 'openai';
  routeName: string;
}

export interface WorkersAiTestRoute {
  enabled: boolean;
  gatewayId: string;
  mode: typeof RouteMode.WorkersAiTest;
  protocol: 'openai';
  upstreamModel: string;
}

export interface GatewayProviderNode {
  aliases: ProviderAlias[];
  id: string;
  kind: typeof ProviderNodeKind.Gateway;
  maxAliasAttempts: number;
  model: string;
  poolId: string;
  provider: string;
  timeoutMs: number;
}

export interface DirectProviderNode {
  aliases: Array<
    ProviderAlias & {
      secretBinding: string;
    }
  >;
  baseUrl: string;
  id: string;
  kind: typeof ProviderNodeKind.Direct;
  maxAliasAttempts: number;
  model: string;
  poolId: string;
  timeoutMs: number;
}

export interface WorkersAiProviderNode {
  id: string;
  kind: typeof ProviderNodeKind.WorkersAi;
  model: string;
}

export type KeyedProviderNode = DirectProviderNode | GatewayProviderNode;
export type ProviderNode = KeyedProviderNode | WorkersAiProviderNode;

export interface WorkloadRoute {
  maxOutputTokens: number;
  name: string;
  nodes: ProviderNode[];
}

export interface ProviderPoolRoute {
  enabled: boolean;
  gatewayId: string;
  mode: typeof RouteMode.ProviderPool;
  protocol: 'openai';
  routes: Record<ModelPoolWorkload, WorkloadRoute>;
}

export type RouteConfig =
  | AiGatewayRoute
  | DirectTestRoute
  | ProviderPoolRoute
  | WorkersAiTestRoute;

const ROUTE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAlias(value: unknown): value is ProviderAlias {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const alias = value as Record<string, unknown>;
  return (
    typeof alias.id === 'string' &&
    IDENTIFIER_PATTERN.test(alias.id) &&
    typeof alias.quotaScopeId === 'string' &&
    IDENTIFIER_PATTERN.test(alias.quotaScopeId) &&
    typeof alias.weight === 'number' &&
    Number.isFinite(alias.weight) &&
    alias.weight > 0 &&
    alias.weight <= 100
  );
}

function hasValidKeyedNodeOptions(node: Record<string, unknown>): boolean {
  return (
    Array.isArray(node.aliases) &&
    node.aliases.length > 0 &&
    node.aliases.every(isAlias) &&
    typeof node.timeoutMs === 'number' &&
    Number.isSafeInteger(node.timeoutMs) &&
    node.timeoutMs >= 1_000 &&
    node.timeoutMs <= 120_000 &&
    typeof node.maxAliasAttempts === 'number' &&
    Number.isSafeInteger(node.maxAliasAttempts) &&
    node.maxAliasAttempts >= 1 &&
    node.maxAliasAttempts <= node.aliases.length
  );
}

function isProviderNode(value: unknown): value is ProviderNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  if (
    typeof node.id !== 'string' ||
    !IDENTIFIER_PATTERN.test(node.id) ||
    !isNonEmptyString(node.model)
  ) return false;

  if (node.kind === ProviderNodeKind.WorkersAi) return node.model.startsWith('@cf/');
  if (!hasValidKeyedNodeOptions(node)) return false;
  if (typeof node.poolId !== 'string' || !IDENTIFIER_PATTERN.test(node.poolId)) return false;
  if (node.kind === ProviderNodeKind.Gateway) return isNonEmptyString(node.provider);
  if (node.kind !== ProviderNodeKind.Direct || !isNonEmptyString(node.baseUrl)) return false;
  try {
    if (new URL(node.baseUrl).protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return (node.aliases as Array<Record<string, unknown>>).every(
    alias =>
      typeof alias.secretBinding === 'string' &&
      /^[A-Z][A-Z0-9_]{0,126}[A-Z0-9]$/.test(alias.secretBinding),
  );
}

function isWorkloadRoute(value: unknown): value is WorkloadRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return (
    typeof route.name === 'string' &&
    ROUTE_NAME_PATTERN.test(route.name) &&
    typeof route.maxOutputTokens === 'number' &&
    Number.isSafeInteger(route.maxOutputTokens) &&
    route.maxOutputTokens >= 1 &&
    route.maxOutputTokens <= 131_072 &&
    Array.isArray(route.nodes) &&
    route.nodes.length > 0 &&
    route.nodes.every(isProviderNode)
  );
}

export function isRouteConfig(value: unknown): value is RouteConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  if (route.enabled !== true || route.protocol !== 'openai') return false;

  if (route.mode === RouteMode.AiGateway) {
    return (
      isNonEmptyString(route.gatewayId) &&
      typeof route.routeName === 'string' &&
      ROUTE_NAME_PATTERN.test(route.routeName)
    );
  }

  if (route.mode === RouteMode.ProviderPool) {
    if (!isNonEmptyString(route.gatewayId)) return false;
    if (!route.routes || typeof route.routes !== 'object' || Array.isArray(route.routes)) {
      return false;
    }
    const routes = route.routes as Record<string, unknown>;
    return (
      isWorkloadRoute(routes[ModelPoolWorkload.Chat]) &&
      isWorkloadRoute(routes[ModelPoolWorkload.Work])
    );
  }

  if (route.mode === RouteMode.WorkersAiTest) {
    return isNonEmptyString(route.gatewayId) && isNonEmptyString(route.upstreamModel);
  }

  if (
    route.mode !== RouteMode.DirectTest ||
    !isNonEmptyString(route.upstreamBaseUrl) ||
    !isNonEmptyString(route.upstreamModel)
  ) return false;

  try {
    return new URL(route.upstreamBaseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveRequestWorkload(
  request: Request,
  body: Record<string, unknown>,
): ModelPoolWorkload {
  const header = request.headers.get(ModelPoolHeader.Workload);
  if (header === ModelPoolWorkload.Chat || header === ModelPoolWorkload.Work) return header;
  return Array.isArray(body.tools) && body.tools.length > 0
    ? ModelPoolWorkload.Work
    : ModelPoolWorkload.Chat;
}

export function resolveConversationId(request: Request): string {
  const value = request.headers.get(ModelPoolHeader.ConversationId)?.trim();
  return value && IDENTIFIER_PATTERN.test(value) ? value : crypto.randomUUID();
}
