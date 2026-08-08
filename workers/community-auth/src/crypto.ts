const OTP_SPACE = 1_000_000;
const UINT32_RANGE = 0x1_0000_0000;
const UNBIASED_LIMIT = Math.floor(UINT32_RANGE / OTP_SPACE) * OTP_SPACE;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function randomBase64Url(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toBase64Url(value);
}

export function generateLoginCode(): string {
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value);
  while (value[0] >= UNBIASED_LIMIT);
  return String(value[0] % OTP_SPACE).padStart(6, '0');
}

export function generateChallengeId(): string {
  return crypto.randomUUID();
}

export async function keyedDigest(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${purpose}:${value}`));
  return toBase64Url(new Uint8Array(signature));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}
