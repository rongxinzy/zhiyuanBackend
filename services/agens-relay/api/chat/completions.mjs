import { createRelay } from '../../relay.mjs';
import { parseCredentials } from '../../credentials.mjs';

export default {
  fetch(request) {
    let credentials;
    try {
      credentials = parseCredentials(process.env.AGENS_POOL_CREDENTIALS);
    } catch {
      return Response.json({ error: { code: 'relay_unconfigured' } }, { status: 503 });
    }
    return createRelay({
      token: process.env.AGENS_RELAY_TOKEN,
      apiKey: process.env.AGENS_API_KEY,
      credentials,
    })(request);
  },
};
