import { ModelPoolWorkload } from './routing.ts';

export const UpstreamTiming = {
  ChatSelectionMs: 30_000,
  WorkSelectionMs: 45_000,
  ChatAttemptMs: 8_000,
  WorkAttemptMs: 12_000,
  IdleMs: 30_000,
  TotalMs: 150_000,
  MaximumPreambleBytes: 65_536,
} as const;

export class SelectionBudgetExceededError extends Error {
  constructor() {
    super('Provider selection deadline exceeded');
  }
}

export class UpstreamTimeoutError extends Error {
  constructor() {
    super('Upstream response timed out');
  }
}

export class SelectionBudget {
  readonly deadline: number;
  readonly attemptMs: number;
  constructor(workload: ModelPoolWorkload, now = Date.now()) {
    this.deadline =
      now +
      (workload === ModelPoolWorkload.Chat
        ? UpstreamTiming.ChatSelectionMs
        : UpstreamTiming.WorkSelectionMs);
    this.attemptMs =
      workload === ModelPoolWorkload.Chat
        ? UpstreamTiming.ChatAttemptMs
        : UpstreamTiming.WorkAttemptMs;
  }
  remaining(configuredMs = this.attemptMs): number {
    const remaining = Math.min(configuredMs, this.attemptMs, this.deadline - Date.now());
    if (remaining <= 0) throw new SelectionBudgetExceededError();
    return remaining;
  }
}

function usefulEvent(text: string): boolean {
  for (const line of text.split('\n').slice(0, -1)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') return true;
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') throw new Error('Invalid upstream event');
    if ('error' in value) throw new Error('Upstream rejected inference');
    if (!('choices' in value) || !Array.isArray(value.choices)) continue;
    for (const choice of value.choices) {
      if (!choice || typeof choice !== 'object') continue;
      if (choice.finish_reason) return true;
      const delta = choice.delta;
      if (
        delta &&
        typeof delta === 'object' &&
        ((typeof delta.content === 'string' && delta.content.length > 0) ||
          (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
          (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))
      )
        return true;
    }
  }
  return false;
}

// The first-event timer is cleared once inference actually starts, not merely at HTTP headers.
// The returned stream owns cancellation/timers; no request-scoped resources escape globally.
export async function timedUpstream(
  send: (signal: AbortSignal) => Promise<Response>,
  parent: AbortSignal,
  firstEventMs: number,
  expectStream: boolean,
  idleMs = UpstreamTiming.IdleMs,
  totalMs = UpstreamTiming.TotalMs,
): Promise<Response> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  const timeout = () => controller.abort(new UpstreamTimeoutError());
  let timer = setTimeout(timeout, firstEventMs);
  const total = setTimeout(timeout, totalMs);
  parent.addEventListener('abort', abort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(total);
    parent.removeEventListener('abort', abort);
  };
  controller.signal.addEventListener(
    'abort',
    () => {
      cleanup();
      void reader?.cancel(controller.signal.reason).catch(() => undefined);
    },
    { once: true },
  );
  const cancel = async (reason?: unknown) => {
    controller.abort(reason);
    cleanup();
    await reader?.cancel(reason).catch(() => undefined);
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const interrupted = () => {
        controller.signal.removeEventListener('abort', interrupted);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', interrupted, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', interrupted));
    });
  };
  const wrap = (response: Response, prefix: Uint8Array[]) => {
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(timeout, idleMs);
    };
    resetIdle();
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          controller.signal.throwIfAborted();
          if (prefix.length) {
            output.enqueue(prefix.shift()!);
            return;
          }
          const chunk = await wait(reader!.read());
          if (chunk.done) {
            cleanup();
            reader!.releaseLock();
            output.close();
          } else {
            resetIdle();
            output.enqueue(chunk.value);
          }
        } catch (error) {
          await cancel(error);
          output.error(error);
        }
      },
      cancel,
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  try {
    const pending = send(controller.signal);
    // Dispose a late response if a transport ignores cancellation while opening headers.
    void pending
      .then(response => {
        if (controller.signal.aborted) return response.body?.cancel().catch(() => undefined);
      })
      .catch(() => undefined);
    const response = await wait(pending);
    if (!response.ok) {
      if (!response.body) {
        cleanup();
        return response;
      }
      reader = response.body.getReader();
      return wrap(response, []);
    }
    if (
      !response.body ||
      !response.headers
        .get('content-type')
        ?.includes(expectStream ? 'text/event-stream' : 'application/json')
    ) {
      await response.body?.cancel();
      throw new Error('Invalid upstream response type');
    }
    reader = response.body.getReader();
    const prefix: Uint8Array[] = [];
    let size = 0;
    let text = '';
    const decoder = new TextDecoder();
    do {
      const chunk = await wait(reader.read());
      if (chunk.done) throw new Error('Upstream ended before inference started');
      size += chunk.value.byteLength;
      if (size > UpstreamTiming.MaximumPreambleBytes)
        throw new Error('Upstream preamble exceeds limit');
      prefix.push(chunk.value);
      text += decoder.decode(chunk.value, { stream: true });
    } while (expectStream && !usefulEvent(text));
    return wrap(response, prefix);
  } catch (error) {
    await cancel(error);
    throw error;
  }
}
