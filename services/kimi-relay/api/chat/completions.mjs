import { createRelay } from '../../relay.mjs';

export default {
  fetch(request) {
    return createRelay({ token: process.env.KIMI_RELAY_TOKEN, apiKey: process.env.KIMI_API_KEY })(request);
  },
};
