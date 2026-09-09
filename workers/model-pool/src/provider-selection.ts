import { ModelPoolWorkload, ProviderNodeKind, type ProviderNode } from './routing.ts';
import { SelectionBudget, SelectionBudgetExceededError } from './upstream-timing.ts';

export const FallbackPolicy = {
  PoolId: 'kimi',
  ChatReserveMs: 15_000,
  WorkReserveMs: 25_000,
} as const;

// Nodes arrive in session-affinity order. Reserve time for the first configured
// Kimi node without forcing successful sticky/free traffic onto a paid provider.
export async function selectProvider<T>(
  nodes: readonly ProviderNode[],
  workload: ModelPoolWorkload,
  signal: AbortSignal,
  attempt: (node: ProviderNode, budget: SelectionBudget) => Promise<T | null>,
): Promise<T> {
  const started = Date.now();
  const overall = new SelectionBudget(workload, started);
  const pending = [...nodes];
  let fallback = pending.find(
    node => node.kind !== ProviderNodeKind.WorkersAi && node.poolId === FallbackPolicy.PoolId,
  );
  const reserve =
    workload === ModelPoolWorkload.Chat
      ? FallbackPolicy.ChatReserveMs
      : FallbackPolicy.WorkReserveMs;
  while (pending.length) {
    signal.throwIfAborted();
    overall.remaining();
    if (fallback && Date.now() >= overall.deadline - reserve) {
      pending.splice(pending.indexOf(fallback), 1);
      pending.unshift(fallback);
    }
    const node = pending.shift()!;
    const protectedAttempt = node === fallback;
    if (protectedAttempt) fallback = undefined;
    const budget = new SelectionBudget(workload, started, {
      deadline: fallback ? overall.deadline - reserve : overall.deadline,
      attemptMs: protectedAttempt ? overall.deadline - started : overall.attemptMs,
    });
    try {
      const result = await attempt(node, budget);
      if (result !== null) return result;
    } catch (error) {
      signal.throwIfAborted();
      // Exhausting the ordinary phase must advance to the reserved fallback,
      // including when the deadline expires between alias acquisition and fetch.
      if (!(error instanceof SelectionBudgetExceededError)) throw error;
    }
  }
  throw new Error(`No ${workload} provider is currently available`);
}
