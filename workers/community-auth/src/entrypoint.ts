import { WorkerEntrypoint } from 'cloudflare:workers';

import handler from './index.ts';
import { validateAccessToken } from './oauth.ts';

export default handler;

export class AuthService extends WorkerEntrypoint<Env> {
  async authenticate(accessToken: string): Promise<{ userId: string; expiresAt: number } | null> {
    const identity = await validateAccessToken(
      this.env.SESSION_SIGNING_KEY,
      accessToken,
      Math.floor(Date.now() / 1000),
    );
    return identity ? { userId: identity.userId, expiresAt: identity.expiresAt } : null;
  }
}
