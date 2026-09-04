export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

const EmptyTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
};

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function extractTokenUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EmptyTokenUsage;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return EmptyTokenUsage;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: nonNegativeInteger(record.prompt_tokens ?? record.input_tokens),
    outputTokens: nonNegativeInteger(record.completion_tokens ?? record.output_tokens),
  };
}

export function mergeTokenUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(current.inputTokens, next.inputTokens),
    outputTokens: Math.max(current.outputTokens, next.outputTokens),
  };
}
