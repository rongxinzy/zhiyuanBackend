const FinishReason = { ContentFilter: 'content_filter' } as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// Reasoning alone is not a deliverable answer. Refusals are valid answers: do not
// retry them across providers to bypass a supplier's safety decision.
export function validateCompletion(value: unknown): void {
  if (!record(value) || 'error' in value || !Array.isArray(value.choices) || !value.choices.length)
    throw new Error('Invalid upstream completion');
  for (const choice of value.choices) {
    if (!record(choice)) throw new Error('Invalid upstream completion choice');
    if (choice.finish_reason === FinishReason.ContentFilter) continue;
    if (!record(choice.message)) throw new Error('Invalid upstream completion choice');
    const message = choice.message;
    const calls = message.tool_calls;
    if (
      calls !== undefined &&
      calls !== null &&
      (!Array.isArray(calls) ||
        !calls.every(
          call =>
            record(call) &&
            text(call.id) &&
            record(call.function) &&
            text(call.function.name) &&
            typeof call.function.arguments === 'string',
        ))
    )
      throw new Error('Invalid upstream tool calls');
    if (
      !text(message.content) &&
      !text(message.refusal) &&
      !(Array.isArray(calls) && calls.length > 0)
    )
      throw new Error('Empty upstream completion');
  }
}
