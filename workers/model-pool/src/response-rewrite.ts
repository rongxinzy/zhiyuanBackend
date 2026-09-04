import { extractTokenUsage, mergeTokenUsage, type TokenUsage } from './usage.ts';

function rewriteResponseModel(value: unknown, logicalModel: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  return typeof body.model === 'string' ? { ...body, model: logicalModel } : body;
}

function rewriteSseLine(
  line: string,
  logicalModel: string,
  observeUsage: (usage: TokenUsage) => void,
): string {
  if (!line.startsWith('data:')) return line;

  const data = line.slice('data:'.length).trimStart();
  if (!data || data === '[DONE]') return line;

  try {
    const value: unknown = JSON.parse(data);
    observeUsage(extractTokenUsage(value));
    return `data: ${JSON.stringify(rewriteResponseModel(value, logicalModel))}`;
  } catch {
    return line;
  }
}

function rewriteSseModel(
  body: ReadableStream<Uint8Array>,
  logicalModel: string,
  reportUsage: (usage: TokenUsage) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let completed = false;
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
          if (done) {
            buffered += decoder.decode();
            if (buffered) {
              controller.enqueue(
                encoder.encode(rewriteSseLine(buffered, logicalModel, observeUsage)),
              );
            }
            complete();
            controller.close();
            return;
          }

          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          if (lines.length > 0) {
            controller.enqueue(
              encoder.encode(
                `${lines
                  .map(line => rewriteSseLine(line, logicalModel, observeUsage))
                  .join('\n')}\n`,
              ),
            );
            return;
          }
        }
      } catch (error) {
        complete();
        controller.error(error);
      }
    },
    async cancel(reason) {
      complete();
      await reader.cancel(reason);
    },
  });
}

export async function rewriteUpstreamResponse(
  upstreamResponse: Response,
  logicalModel: string,
  reportUsage: (usage: TokenUsage) => void,
): Promise<BodyInit | null> {
  if (!upstreamResponse.body) {
    reportUsage({ inputTokens: 0, outputTokens: 0 });
    return null;
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return rewriteSseModel(upstreamResponse.body, logicalModel, reportUsage);
  }

  if (contentType.includes('application/json')) {
    const value: unknown = await upstreamResponse.json();
    reportUsage(extractTokenUsage(value));
    return JSON.stringify(rewriteResponseModel(value, logicalModel));
  }

  reportUsage({ inputTokens: 0, outputTokens: 0 });
  return upstreamResponse.body;
}
