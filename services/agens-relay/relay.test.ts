import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, MODEL, MAX_BODY_BYTES } from './relay.mjs';
import { parseCredentials } from './credentials.mjs';

const token = 'test-relay-token';
const apiKey = 'test-provider-key';
function request(body = {}, headers = {}, signal?: AbortSignal) {
  return new Request('https://relay.example/api/chat/completions', {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'OK' }], ...body }),
  });
}

test('internal credentials select one key without relay-side failover', async () => {
  const second = { token: 'second-private-relay-token-32-characters', apiKey: 'second-provider-key' };
  const credentials = parseCredentials(JSON.stringify([second]));
  const calls: string[] = [];
  const relay = createRelay({ token, apiKey, credentials, fetcher: async (_url: string, init: RequestInit) => {
    calls.push(new Headers(init.headers).get('authorization')!);
    return new Response(null, { status: 429 });
  } });
  assert.equal((await relay(request({}, { authorization: `Bearer ${second.token}` }))).status, 429);
  assert.deepEqual(calls, [`Bearer ${second.apiKey}`]);
  assert.equal((await relay(request())).status, 429);
  assert.deepEqual(calls, [`Bearer ${second.apiKey}`, `Bearer ${apiKey}`]);
  assert.equal((await relay(request({}, { authorization: 'Bearer unknown' }))).status, 401);
  assert.equal(calls.length, 2);
  assert.deepEqual(parseCredentials(undefined), []);
  for (const input of ['{', '{}', '[{}]', JSON.stringify([second, second])])
    assert.throws(() => parseCredentials(input));
});

test('authentication, model and size validation never reach upstream', async () => {
  const relay = createRelay({ token, apiKey, fetcher: () => assert.fail('Unexpected fetch') });
  assert.equal((await relay(request({}, { authorization: 'Bearer bad' }))).status, 401);
  assert.equal((await relay(request({ model: 'other' }))).status, 400);
  assert.equal((await relay(request({ extra: 'x'.repeat(MAX_BODY_BYTES) }))).status, 413);
  assert.equal((await relay(request({ max_tokens: -1 }))).status, 400);
  assert.equal((await createRelay({ token, apiKey: '' })(request())).status, 503);
});

test('fixed origin, private upstream auth, tool payload and output cap', async () => {
  const tools = [{ type: 'function', function: { name: 'clock' } }];
  const relay = createRelay({ token, apiKey, fetcher: async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://apihub.agnes-ai.com/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${apiKey}`);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.tools, tools);
    assert.equal(body.max_tokens, 16384);
    assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.n, undefined);
    return Response.json({ choices: [] });
  } });
  assert.equal((await relay(request({ tools, n: 10, max_tokens: 99999 }))).status, 200);
});

test('preserves failure and quota signals without leaking provider body or cookies', async () => {
  for (const status of [401, 403, 429, 503]) {
    const relay = createRelay({ token, apiKey, fetcher: async () => new Response(apiKey, {
      status, headers: { 'retry-after': '20', 'x-ratelimit-remaining-requests': '0', 'set-cookie': 'private' },
    }) });
    const response = await relay(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '20');
    assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '0');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.ok(!(await response.text()).includes(apiKey));
  }
});

test('SSE forwards the first chunk without buffering and cancels upstream', async () => {
  let cancelled = false;
  let upstreamSignal: AbortSignal | undefined;
  const relay = createRelay({ token, apiKey, fetcher: async (_url: string, init: RequestInit) => {
    upstreamSignal = init.signal ?? undefined;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = await relay(request({ stream: true }));
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(upstreamSignal?.aborted, true);
});

test('upstream failures and unexpected content types become retryable errors', async () => {
  const failed = createRelay({ token, apiKey, fetcher: async () => { throw new Error(apiKey); } });
  assert.equal((await failed(request())).status, 502);
  const html = createRelay({ token, apiKey, fetcher: async () => new Response('<html>') });
  assert.equal((await html(request())).status, 502);
});

test('forwards client cancellation and bounds upstream waiting', async () => {
  const disconnected = new AbortController();
  disconnected.abort();
  const relay = createRelay({ token, apiKey, fetcher: async (_url: string, init: RequestInit) => {
    assert.equal(init.signal?.aborted, true);
    init.signal!.throwIfAborted();
  } });
  assert.equal((await relay(request({}, {}, disconnected.signal))).status, 504);
  const slow = createRelay({ token, apiKey, timeoutMs: 5, fetcher: (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Timeout not enforced')), 1000);
    init.signal!.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal!.reason);
    }, { once: true });
  }) });
  assert.equal((await slow(request())).status, 504);
});

test('streams all frames including usage and DONE byte-for-byte', async () => {
  const frames = 'data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
  const relay = createRelay({ token, apiKey, fetcher: async () => new Response(frames, {
    headers: { 'content-type': 'text/event-stream' },
  }) });
  assert.equal(await (await relay(request({ stream: true }))).text(), frames);
});
