export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface ResendResult {
  id: string;
}

export class ResendError extends Error {
  readonly status: number;
  readonly deliveryMayHaveSucceeded: boolean;

  constructor(
    message: string,
    status: number,
    deliveryMayHaveSucceeded: boolean,
  ) {
    super(message);
    this.name = 'ResendError';
    this.status = status;
    this.deliveryMayHaveSucceeded = deliveryMayHaveSucceeded;
  }
}

export function buildLoginEmail(from: string, to: string, code: string): ResendMessage {
  return {
    from,
    to,
    subject: '你的知远登录验证码',
    text: `你的知远登录验证码是：${code}\n\n验证码 10 分钟内有效。若非本人操作，请忽略此邮件。`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#171717"><p>你的知远登录验证码是：</p><p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0">${code}</p><p style="color:#666">验证码 10 分钟内有效。若非本人操作，请忽略此邮件。</p></div>`,
  };
}

export async function sendWithResend(
  apiKey: string,
  idempotencyKey: string,
  message: ResendMessage,
  fetcher: typeof fetch = fetch,
): Promise<ResendResult> {
  let response: Response;
  try {
    response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(message),
    });
  } catch (error) {
    throw new ResendError(error instanceof Error ? error.message : 'Resend request failed', 0, true);
  }

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    const shouldApplyCooldown = response.status === 429 || response.status >= 500;
    throw new ResendError(`Resend rejected the message: ${details}`, response.status, shouldApplyCooldown);
  }

  const payload: unknown = await response.json();
  if (!isResendResult(payload)) throw new ResendError('Resend returned an invalid response', 502, true);
  return payload;
}

function isResendResult(value: unknown): value is ResendResult {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}
