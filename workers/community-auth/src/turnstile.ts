interface TurnstileResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null,
  expectedHostname: string,
  expectedAction: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const body = new FormData();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!response.ok) return false;
    const payload: TurnstileResponse = await response.json();
    return payload.success === true && payload.hostname === expectedHostname && payload.action === expectedAction;
  } catch {
    return false;
  }
}
