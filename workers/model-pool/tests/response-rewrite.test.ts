import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteUpstreamResponse } from '../src/response-rewrite.ts';
import type { TokenUsage } from '../src/usage.ts';

test('truncated and malformed streams fail instead of reporting normal completion', async () => {
  for (const source of [
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {broken}\n\n',
  ]) {
    let reports = 0;
    const body = await rewriteUpstreamResponse(
      new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
      'zhiyuan-free',
      () => {
        reports++;
      },
    );
    await assert.rejects(new Response(body).text(), /terminal event|Malformed/);
    assert.equal(reports, 1);
  }
});

test('accepts a finish reason at EOF and preserves length termination', async () => {
  const source = 'data: {"choices":[{"finish_reason":"length"}]}\n\n';
  const body = await rewriteUpstreamResponse(
    new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    'zhiyuan-free',
    () => undefined,
  );
  assert.match(await new Response(body).text(), /"finish_reason":"length"/);
});

test('accepts CRLF terminal markers and reports failed streams separately from cancellation', async () => {
  let failures = 0;
  const valid = await rewriteUpstreamResponse(
    new Response('data: [DONE]\r\n\r\n', { headers: { 'content-type': 'text/event-stream' } }),
    'zhiyuan-free',
    () => undefined,
    () => {
      failures++;
    },
  );
  await new Response(valid).text();
  assert.equal(failures, 0);
  const stalled = await rewriteUpstreamResponse(
    new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
    'zhiyuan-free',
    () => undefined,
    () => {
      failures++;
    },
  );
  const reader = (stalled as ReadableStream<Uint8Array>).getReader();
  const pending = reader.read();
  await reader.cancel();
  await pending;
  assert.equal(failures, 0);
  const broken = await rewriteUpstreamResponse(
    new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    'zhiyuan-free',
    () => undefined,
    () => {
      failures++;
    },
  );
  await assert.rejects(new Response(broken).text());
  assert.equal(failures, 1);
});

test('rewrites a JSON response model and reports usage', async () => {
  let usage: TokenUsage | null = null;
  const body = await rewriteUpstreamResponse(
    Response.json({
      model: 'provider/model',
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }),
    'zhiyuan-free',
    value => {
      usage = value;
    },
  );

  assert.deepEqual(JSON.parse(String(body)), {
    model: 'zhiyuan-free',
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });
  assert.deepEqual(usage, { inputTokens: 5, outputTokens: 3 });
});

test('preserves UTF-8 across arbitrary SSE chunks and reports final usage', async () => {
  const source = [
    'data: {"model":"provider/model","choices":[{"delta":{"content":"你好"}}]}\n\n',
    'data: {"model":"provider/model","usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(source);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 61));
      controller.enqueue(bytes.slice(61, 64));
      controller.enqueue(bytes.slice(64));
      controller.close();
    },
  });
  let usage: TokenUsage | null = null;
  const rewritten = await rewriteUpstreamResponse(
    new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    'zhiyuan-free',
    value => {
      usage = value;
    },
  );

  const text = await new Response(rewritten).text();
  assert.match(text, /"model":"zhiyuan-free"/u);
  assert.match(text, /你好/u);
  assert.match(text, /data: \[DONE\]/u);
  assert.deepEqual(usage, { inputTokens: 8, outputTokens: 2 });
});

test('reports observed usage when the downstream consumer cancels', async () => {
  const bytes = new TextEncoder().encode(
    'data: {"usage":{"prompt_tokens":11,"completion_tokens":1}}\n\n',
  );
  let upstreamCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  let usage: TokenUsage | null = null;
  const rewritten = await rewriteUpstreamResponse(
    new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    'zhiyuan-free',
    value => {
      usage = value;
    },
  );
  const reader = (rewritten as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  await reader.cancel();

  assert.equal(upstreamCancelled, true);
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 1 });
});
