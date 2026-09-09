import { timingSafeEqual } from 'node:crypto';

export const MODEL = 'agnes-2.5-flash';
export const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM = 'https://apihub.agnes-ai.com/v1/chat/completions';
const FORWARDED_HEADERS = [
  'retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests', 'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens',
];

function error(status, code, headers = {}) {
  return Response.json({ error: { code, message: code } }, {
    status, headers: { 'cache-control': 'no-store', ...headers },
  });
}

function authorized(request, token) {
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new RangeError('Request too large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Missing body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError('Request too large');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

// Dependency injection keeps tests offline; callers cannot select the upstream URL.
export function createRelay({ token, apiKey, credentials = [], fetcher = fetch, timeoutMs = 175_000 }) {
  const keys = [...credentials];
  if (token && apiKey) keys.push({ token, apiKey });
  return async request => {
    if (keys.length === 0) return error(503, 'relay_unconfigured');
    const selected = keys.find(key => authorized(request, key.token));
    if (!selected) return error(401, 'unauthorized');
    if (request.method !== 'POST') return error(405, 'method_not_allowed', { allow: 'POST' });
    let body;
    try {
      body = await readBody(request);
    } catch (cause) {
      return error(cause instanceof RangeError ? 413 : 400, 'invalid_request');
    }
    if (!body || Array.isArray(body) || body.model !== MODEL ||
        !Array.isArray(body.messages) || body.messages.length === 0 ||
        (body.stream !== undefined && typeof body.stream !== 'boolean')) {
      return error(400, 'invalid_request');
    }
    // Do not let alternate output parameters bypass the Model Pool output cap.
    const requested = body.max_tokens ?? body.max_completion_tokens ?? 4096;
    if (!Number.isSafeInteger(requested) || requested <= 0) return error(400, 'invalid_request');
    body.max_tokens = Math.min(requested, 16_384);
    delete body.max_completion_tokens;
    delete body.n;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      request.signal, controller.signal, AbortSignal.timeout(timeoutMs),
    ]);
    let upstream;
    try {
      upstream = await fetcher(UPSTREAM, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          authorization: `Bearer ${selected.apiKey}`, 'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      return error(signal.aborted ? 504 : 502, 'upstream_unavailable');
    }
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const name of FORWARDED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      // Preserve status for the Cloudflare per-key circuit breaker, not HTML/errors containing secrets.
      return error(upstream.status, 'upstream_rejected', Object.fromEntries(headers));
    }
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.body || !(body.stream
      ? contentType.includes('text/event-stream')
      : contentType.includes('application/json'))) {
      await upstream.body?.cancel();
      return error(502, 'invalid_upstream_response');
    }
    headers.set('content-type', contentType);
    const reader = upstream.body.getReader();
    const stream = new ReadableStream({
      async pull(output) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            reader.releaseLock();
            output.close();
          } else output.enqueue(value);
        } catch (cause) {
          controller.abort();
          reader.releaseLock();
          output.error(cause);
        }
      },
      async cancel(reason) {
        controller.abort();
        await reader.cancel(reason);
        reader.releaseLock();
      },
    });
    return new Response(stream, { status: upstream.status, headers });
  };
}
