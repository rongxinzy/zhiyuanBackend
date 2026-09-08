export interface ProviderCapacity {
  limit_requests: number | null;
  limit_tokens: number | null;
  remaining_requests: number | null;
  remaining_tokens: number | null;
  reset_requests_at: number | null;
  reset_tokens_at: number | null;
}

function routingHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // Avalanche the full hash: adjacent alias suffixes otherwise produce correlated ranks.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function calculateCapacityFactor(scope: ProviderCapacity | undefined, now: number): number {
  if (!scope) return 1;
  const requestReset = scope.reset_requests_at ?? 0;
  const tokenReset = scope.reset_tokens_at ?? 0;
  const requestRatio =
    requestReset > now || scope.remaining_requests !== 0
      ? scope.limit_requests && scope.remaining_requests !== null
        ? scope.remaining_requests / scope.limit_requests
        : 1
      : 1;
  const tokenRatio =
    tokenReset > now || scope.remaining_tokens !== 0
      ? scope.limit_tokens && scope.remaining_tokens !== null
        ? scope.remaining_tokens / scope.limit_tokens
        : 1
      : 1;
  return Math.max(0.01, Math.min(1, requestRatio, tokenRatio));
}

export function calculateCandidateScore(
  affinityKey: string,
  candidateId: string,
  weight: number,
  capacity: number,
  inflight: number,
): number {
  const affinity = (routingHash(JSON.stringify([affinityKey, candidateId])) + 0.5) / 0x1_0000_0000;
  return (weight * capacity) / (-Math.log(affinity) * (inflight + 1));
}
