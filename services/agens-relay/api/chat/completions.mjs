import { createRelay } from '../../relay.mjs';

export default {
  fetch(request) {
    return createRelay({
      token: process.env.AGENS_RELAY_TOKEN,
      apiKey: process.env.AGENS_API_KEY,
    })(request);
  },
};
