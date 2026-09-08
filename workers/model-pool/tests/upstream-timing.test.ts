import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { timedUpstream, SelectionBudget, UpstreamTiming } from '../src/upstream-timing.ts';
import { ModelPoolWorkload } from '../src/routing.ts';

const signal = () => new AbortController().signal;
const event = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('bounds headers and comment-only streams by the first useful event deadline', async () => {
  await assert.rejects(
    timedUpstream(() => new Promise(() => {}), signal(), 15, true),
    /timed out/,
  );
  let cancelled = false;
  const response = sse(
    new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            ': heartbeat\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    timedUpstream(async () => response, signal(), 15, true),
    /timed out/,
  );
  assert.equal(cancelled, true);
});

test('clears first-event timeout while a healthy stream continues, preserving bytes', async () => {
  let output: ReadableStreamDefaultController<Uint8Array>;
  const response = sse(
    new ReadableStream({
      start(c) {
        output = c;
        c.enqueue(event);
      },
    }),
  );
  const result = await timedUpstream(async () => response, signal(), 15, true, 1000, 2000);
  await delay(35);
  output!.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  output!.close();
  assert.equal(await result.text(), new TextDecoder().decode(event) + 'data: [DONE]\n\n');
});

test('idle timeout errors an established stream and cancels the upstream', async () => {
  let cancelled = false;
  const response = sse(
    new ReadableStream({
      start(c) {
        c.enqueue(event);
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const result = await timedUpstream(async () => response, signal(), 100, true, 15, 1000);
  await assert.rejects(result.text(), /timed out/);
  assert.equal(cancelled, true);
});

test('total duration remains bounded and user cancellation propagates', async () => {
  const response = () =>
    sse(
      new ReadableStream({
        start(c) {
          c.enqueue(event);
        },
      }),
    );
  const limited = await timedUpstream(async () => response(), signal(), 100, true, 1000, 15);
  await assert.rejects(limited.text(), /timed out/);
  const controller = new AbortController();
  const cancelled = await timedUpstream(async () => response(), controller.signal, 100, true);
  controller.abort();
  await assert.rejects(cancelled.text(), { name: 'AbortError' });
});

test('rejects invalid MIME types and failed first events before committing the route', async () => {
  await assert.rejects(
    timedUpstream(async () => new Response('<html>error</html>'), signal(), 100, true),
    /response type/,
  );
  await assert.rejects(
    timedUpstream(
      async () =>
        sse(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"error":{"message":"bad"}}\n\n'));
              c.close();
            },
          }),
        ),
      signal(),
      100,
      true,
    ),
    /rejected inference/,
  );
});

test('selection budget is shared across attempts and cannot restart after expiry', () => {
  const chat = new SelectionBudget(ModelPoolWorkload.Chat);
  assert.ok(chat.remaining(120_000) <= UpstreamTiming.ChatAttemptMs);
  assert.equal(chat.remaining(1000), 1000);
  assert.throws(
    () => new SelectionBudget(ModelPoolWorkload.Work, Date.now() - 60_000).remaining(),
    /deadline exceeded/,
  );
});
