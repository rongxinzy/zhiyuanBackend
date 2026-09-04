export const ModelAccessDecision = {
  Allowed: 'allowed',
  Denied: 'denied',
} as const;

export const ModelAccessDenialCode = {
  AccountDisabled: 'account_disabled',
  EntitlementRequired: 'entitlement_required',
  ModelUnavailable: 'model_unavailable',
} as const;

const DefaultPlan = {
  Id: 'free',
} as const;

interface UserRecord {
  id: string;
}

export interface ModelAccessSnapshot {
  user_status: string;
  daily_request_limit: number | null;
  daily_token_limit: number | null;
  monthly_token_limit: number | null;
  model_enabled: number | null;
  entitlement_enabled: number | null;
  entitlement_expires_at: string | null;
  route_enabled: number | null;
  openai_route: string | null;
}

export interface ModelAccessPolicy {
  dailyRequestLimit: number | null;
  dailyTokenLimit: number | null;
  monthlyTokenLimit: number | null;
  openAiRoute: string;
  userId: string;
}

export type ModelAccessResult =
  | {
      decision: typeof ModelAccessDecision.Allowed;
      policy: ModelAccessPolicy;
    }
  | {
      code: (typeof ModelAccessDenialCode)[keyof typeof ModelAccessDenialCode];
      decision: typeof ModelAccessDecision.Denied;
    };

export function evaluateModelAccess(
  row: ModelAccessSnapshot | null,
  userId: string,
  now = new Date(),
): ModelAccessResult {
  if (!row || row.user_status !== 'active') {
    return {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.AccountDisabled,
    };
  }

  const entitlementExpiry =
    row.entitlement_expires_at === null ? null : Date.parse(row.entitlement_expires_at);
  const entitlementExpired =
    entitlementExpiry !== null &&
    (!Number.isFinite(entitlementExpiry) || entitlementExpiry <= now.getTime());
  if (row.entitlement_enabled !== 1 || entitlementExpired) {
    return {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.EntitlementRequired,
    };
  }

  if (row.model_enabled !== 1 || row.route_enabled !== 1 || !row.openai_route) {
    return {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.ModelUnavailable,
    };
  }

  return {
    decision: ModelAccessDecision.Allowed,
    policy: {
      dailyRequestLimit: row.daily_request_limit,
      dailyTokenLimit: row.daily_token_limit,
      monthlyTokenLimit: row.monthly_token_limit,
      openAiRoute: row.openai_route,
      userId,
    },
  };
}

async function provisionFreeUser(
  database: D1Database,
  userId: string,
  logicalModelId: string,
): Promise<void> {
  const existing = await database
    .prepare('SELECT id FROM users WHERE id = ?1')
    .bind(userId)
    .first<UserRecord>();
  if (existing) return;

  await database.batch([
    database
      .prepare(
        `INSERT INTO users (id, status, plan_id)
         VALUES (?1, 'active', ?2)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(userId, DefaultPlan.Id),
    database
      .prepare(
        `INSERT INTO entitlements (user_id, logical_model_id, enabled)
         VALUES (?1, ?2, 1)
         ON CONFLICT(user_id, logical_model_id) DO NOTHING`,
      )
      .bind(userId, logicalModelId),
  ]);
}

export async function resolveModelAccess(
  database: D1Database,
  userId: string,
  logicalModelId: string,
  now = new Date(),
): Promise<ModelAccessResult> {
  await provisionFreeUser(database, userId, logicalModelId);

  const row = await database
    .prepare(
      `SELECT
         users.status AS user_status,
         plans.daily_request_limit,
         plans.daily_token_limit,
         plans.monthly_token_limit,
         logical_models.enabled AS model_enabled,
         entitlements.enabled AS entitlement_enabled,
         entitlements.expires_at AS entitlement_expires_at,
         route_mappings.enabled AS route_enabled,
         route_mappings.openai_route
       FROM users
       JOIN plans ON plans.id = users.plan_id
       LEFT JOIN logical_models ON logical_models.id = ?2
       LEFT JOIN entitlements
         ON entitlements.user_id = users.id
        AND entitlements.logical_model_id = ?2
       LEFT JOIN route_mappings ON route_mappings.logical_model_id = ?2
       WHERE users.id = ?1`,
    )
    .bind(userId, logicalModelId)
    .first<ModelAccessSnapshot>();

  return evaluateModelAccess(row, userId, now);
}

export async function incrementDailyRequestUsage(
  database: D1Database,
  userId: string,
  logicalModelId: string,
  usageDate: string,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO usage_daily (
         user_id, usage_date, logical_model_id, request_count, input_tokens, output_tokens
       ) VALUES (?1, ?2, ?3, 1, 0, 0)
       ON CONFLICT(user_id, usage_date, logical_model_id) DO UPDATE SET
         request_count = request_count + 1,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(userId, usageDate, logicalModelId)
    .run();
}

export async function incrementDailyTokenUsage(
  database: D1Database,
  userId: string,
  logicalModelId: string,
  usageDate: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  if (inputTokens === 0 && outputTokens === 0) return;
  await database
    .prepare(
      `INSERT INTO usage_daily (
         user_id, usage_date, logical_model_id, request_count, input_tokens, output_tokens
       ) VALUES (?1, ?2, ?3, 0, ?4, ?5)
       ON CONFLICT(user_id, usage_date, logical_model_id) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(userId, usageDate, logicalModelId, inputTokens, outputTokens)
    .run();
}
