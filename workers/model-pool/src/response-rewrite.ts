import { extractTokenUsage, mergeTokenUsage, type TokenUsage } from './usage.ts';

const MAX_SSE_BUFFERED_CHARACTERS = 1_048_576;

function rewriteResponseModel(value: unknown, logicalModel: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return typeof body.model === 'string' ? { ...body, model: logicalModel } : body;
}

function rewriteSseLine(
  line: string,
  logicalModel: string,
  observeUsage: (usage: TokenUsage) => void,
  observeTerminal: () => void,
): string {
  if (!line.startsWith('data:')) return line;

  const data = line.slice('data:'.length).trim();
  if (!data) return line;
  if (data === '[DONE]') {
    observeTerminal();
    return line;
  }

  try {
    const value: unknown = JSON.parse(data);
    if (
      value &&
      typeof value === 'object' &&
      'choices' in value &&
      Array.isArray(value.choices) &&
      value.choices.some(
        choice =>
          choice &&
          typeof choice === 'object' &&
          typeof choice.finish_reason === 'string' &&
          choice.finish_reason.length > 0,
      )
    )
      observeTerminal();
    observeUsage(extractTokenUsage(value));
    return `data: ${JSON.stringify(rewriteResponseModel(value, logicalModel))}`;
  } catch {
    throw new Error('Malformed upstream SSE event');
  }
}

function rewriteSseModel(
  body: ReadableStream<Uint8Array>,
  logicalModel: string,
  reportUsage: (usage: TokenUsage) => void,
  reportFailure: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let completed = false;
  let cancelled = false;
  let terminal = false;
  const observeTerminal = () => {
    terminal = true;
  };
  const observeUsage = (next: TokenUsage) => {
    usage = mergeTokenUsage(usage, next);
  };
  const complete = () => {
    if (completed) return;
    completed = true;
    reportUsage(usage);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (cancelled) return;
          if (done) {
            buffered += decoder.decode();
            if (buffered) {
              controller.enqueue(
                encoder.encode(
                  rewriteSseLine(buffered, logicalModel, observeUsage, observeTerminal),
                ),
              );
            }
            complete();
            if (!terminal) throw new Error('Upstream stream ended without a terminal event');
            controller.close();
            reader.releaseLock();
            return;
          }

          buffered += decoder.decode(value, { stream: true });
          if (buffered.length > MAX_SSE_BUFFERED_CHARACTERS)
            throw new Error('Upstream SSE buffer exceeds limit');
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          if (lines.length > 0) {
            controller.enqueue(
              encoder.encode(
                `${lines
                  .map(line => rewriteSseLine(line, logicalModel, observeUsage, observeTerminal))
                  .join('\n')}\n`,
              ),
            );
            return;
          }
        }
      } catch (error) {
        if (cancelled) return;
        reportFailure();
        complete();
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      complete();
      await reader.cancel(reason);
    },
  });
}

export async function rewriteUpstreamResponse(
  upstreamResponse: Response,
  logicalModel: string,
  reportUsage: (usage: TokenUsage) => void,
  reportFailure: () => void = () => undefined,
): Promise<BodyInit | null> {
  if (!upstreamResponse.body) {
    reportUsage({ inputTokens: 0, outputTokens: 0 });
    return null;
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return rewriteSseModel(upstreamResponse.body, logicalModel, reportUsage, reportFailure);
  }

  if (contentType.includes('application/json')) {
    const value: unknown = await upstreamResponse.json();
    reportUsage(extractTokenUsage(value));
    return JSON.stringify(rewriteResponseModel(value, logicalModel));
  }

  reportUsage({ inputTokens: 0, outputTokens: 0 });
  return upstreamResponse.body;
}
