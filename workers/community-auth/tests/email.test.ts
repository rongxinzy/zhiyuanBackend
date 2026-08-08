import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLoginEmail, ResendError, sendWithResend } from '../src/email.ts';

describe('Resend integration', () => {
  it('sends both text and HTML with a stable idempotency key', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ id: 'email_123' });
    };

    const message = buildLoginEmail('知远 <login@example.com>', 'user@example.com', '012345');
    const result = await sendWithResend('secret', 'login-code/challenge', message, fetcher);

    assert.deepEqual(result, { id: 'email_123' });
    assert.equal(capturedUrl, 'https://api.resend.com/emails');
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get('authorization'), 'Bearer secret');
    assert.equal(headers.get('idempotency-key'), 'login-code/challenge');
    assert.match(String(capturedInit?.body), /012345/u);
  });

  it('marks transport failures as potentially delivered', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('network unavailable');
    };

    await assert.rejects(
      sendWithResend('secret', 'login-code/challenge', buildLoginEmail('a@example.com', 'b@example.com', '123456'), fetcher),
      (error: unknown) => error instanceof ResendError && error.deliveryMayHaveSucceeded,
    );
  });

  it('marks explicit Resend rejections as not delivered', async () => {
    const fetcher: typeof fetch = async () => new Response('{"message":"invalid from"}', { status: 422 });

    await assert.rejects(
      sendWithResend('secret', 'login-code/challenge', buildLoginEmail('a@example.com', 'b@example.com', '123456'), fetcher),
      (error: unknown) => error instanceof ResendError && error.status === 422 && !error.deliveryMayHaveSucceeded,
    );
  });

  it('applies a cooldown after a retryable Resend rejection', async () => {
    const fetcher: typeof fetch = async () => new Response('{"message":"busy"}', { status: 503 });

    await assert.rejects(
      sendWithResend('secret', 'login-code/challenge', buildLoginEmail('a@example.com', 'b@example.com', '123456'), fetcher),
      (error: unknown) => error instanceof ResendError && error.status === 503 && error.deliveryMayHaveSucceeded,
    );
  });
});
