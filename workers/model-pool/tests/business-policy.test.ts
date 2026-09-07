import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateModelAccess,
  ModelAccessDecision,
  ModelAccessDenialCode,
  ModelPoolIdentityKind,
  resolveDefaultPlanId,
  type ModelAccessSnapshot,
} from '../src/business-policy.ts';

const activeSnapshot: ModelAccessSnapshot = {
  user_status: 'active',
  daily_request_limit: 100,
  daily_token_limit: 100_000,
  monthly_token_limit: 3_000_000,
  model_enabled: 1,
  entitlement_enabled: 1,
  entitlement_expires_at: null,
  route_enabled: 1,
  openai_route: 'free-agent-openai',
  chat_openai_route: 'free-chat-openai',
  work_openai_route: 'free-work-openai',
};

test('assigns separate default plans to guest and account identities', () => {
  assert.equal(resolveDefaultPlanId(ModelPoolIdentityKind.Guest), 'guest');
  assert.equal(resolveDefaultPlanId(ModelPoolIdentityKind.User), 'free');
});

test('returns the plan limits and route for an entitled active user', () => {
  assert.deepEqual(evaluateModelAccess(activeSnapshot, 'user-1'), {
    decision: ModelAccessDecision.Allowed,
    policy: {
      dailyRequestLimit: 100,
      dailyTokenLimit: 100_000,
      monthlyTokenLimit: 3_000_000,
      chatOpenAiRoute: 'free-chat-openai',
      workOpenAiRoute: 'free-work-openai',
      userId: 'user-1',
    },
  });
});

test('denies suspended accounts', () => {
  assert.deepEqual(evaluateModelAccess({ ...activeSnapshot, user_status: 'suspended' }, 'user-1'), {
    decision: ModelAccessDecision.Denied,
    code: ModelAccessDenialCode.AccountDisabled,
  });
});

test('denies disabled and expired entitlements', () => {
  assert.deepEqual(
    evaluateModelAccess({ ...activeSnapshot, entitlement_enabled: 0 }, 'user-1'),
    {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.EntitlementRequired,
    },
  );
  assert.deepEqual(
    evaluateModelAccess(
      { ...activeSnapshot, entitlement_expires_at: '2026-09-03T00:00:00.000Z' },
      'user-1',
      new Date('2026-09-04T00:00:00.000Z'),
    ),
    {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.EntitlementRequired,
    },
  );
  assert.deepEqual(
    evaluateModelAccess({ ...activeSnapshot, entitlement_expires_at: 'invalid' }, 'user-1'),
    {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.EntitlementRequired,
    },
  );
});

test('denies disabled logical models and route mappings', () => {
  for (const snapshot of [
    { ...activeSnapshot, model_enabled: 0 },
    { ...activeSnapshot, route_enabled: 0 },
    {
      ...activeSnapshot,
      openai_route: null,
      chat_openai_route: null,
      work_openai_route: null,
    },
  ]) {
    assert.deepEqual(evaluateModelAccess(snapshot, 'user-1'), {
      decision: ModelAccessDecision.Denied,
      code: ModelAccessDenialCode.ModelUnavailable,
    });
  }
});
