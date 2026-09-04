import assert from 'node:assert/strict';
import test from 'node:test';

import { extractTokenUsage, mergeTokenUsage } from '../src/usage.ts';

test('extracts OpenAI token usage', () => {
  assert.deepEqual(
    extractTokenUsage({ usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }),
    { inputTokens: 12, outputTokens: 7 },
  );
});

test('accepts Anthropic-style usage field names for future protocol support', () => {
  assert.deepEqual(extractTokenUsage({ usage: { input_tokens: 9, output_tokens: 4 } }), {
    inputTokens: 9,
    outputTokens: 4,
  });
});

test('ignores malformed and negative usage values', () => {
  assert.deepEqual(extractTokenUsage({ usage: { prompt_tokens: -1, completion_tokens: '8' } }), {
    inputTokens: 0,
    outputTokens: 0,
  });
});

test('keeps the greatest cumulative usage observed across stream chunks', () => {
  assert.deepEqual(
    mergeTokenUsage(
      { inputTokens: 10, outputTokens: 2 },
      { inputTokens: 10, outputTokens: 8 },
    ),
    { inputTokens: 10, outputTokens: 8 },
  );
});
