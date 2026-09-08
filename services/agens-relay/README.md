# Agens relay

The Model Pool's existing direct-provider adapter calls this authenticated Vercel Node.js function. Desktop clients continue using `https://model.rongxzyai.com/v1/chat/completions` and `zhiyuan-free`; authentication, guest/account quotas, usage accounting, conversation affinity and failover remain in Cloudflare.

## Boundaries

- Only `POST /api/chat/completions`; fixed upstream `https://apihub.agnes-ai.com/v1/chat/completions`, redirects forbidden.
- Only `agnes-2.5-flash`. No caller-selected upstream or model. JSON request limit 1 MiB; output capped at 16,384 tokens (Cloudflare retains the tighter 4,096 Chat ceiling).
- Vercel holds `AGENS_API_KEY` and `AGENS_RELAY_TOKEN`. Cloudflare holds only `AGENS_RELAY_TOKEN` for this provider. No provider key, prompt or response logging in relay code.
- The production alias is `https://zhiyuan-agens-relay.vercel.app/api`. Unique preview/deployment URLs can be protected by Vercel SSO; do not disable deployment protection to use them.
- SSE and JSON success bodies stream with backpressure. Consumer cancellation aborts upstream; Vercel cancellation is enabled. Overall upstream timeout 55 seconds, Vercel function limit 60 seconds, Model Pool node deadline 60 seconds.
- No relay retries. HTTP 401/402/403/408/429/5xx and quota headers reach the existing Cloudflare health scheduler; upstream error bodies are replaced with generic JSON. Wrong relay credentials also produce 401.
- A failed request before response headers can fall back. A stream already sent to the client cannot switch providers seamlessly; it fails in place. Deadline limits apply to the whole stream, not just time to first token.
- One verified provider key is currently provisioned (`key-2`); the other supplied key returned 401 and is excluded. Chat and Work share one health/quota scope. Do not add multiple relay aliases backed by the same key as independent capacity.
- Vercel is a fixed egress hop, not an IP rotation service. Respect provider quotas and access policy; 429/403 triggers cooldown rather than egress rotation. This adds Vercel invocation/bandwidth cost and is not a guarantee of future provider availability.

## Deploy

No runtime dependencies or download/build step. Tests run from the repository root:

```sh
npm run test:agens-relay
npm run test:model-pool
npm run check:model-pool
```

Deploy with `node services/agens-relay/deploy.mjs`. Required environment variables contain file paths/identifiers, never secret values:

| Variable | Meaning |
| --- | --- |
| `VERCEL_TOKEN_FILE` | Private file with Vercel management token |
| `RELAY_TOKEN_FILE` | Private file with random relay token (at least 32 characters); reuse on redeploy |
| `AGENS_KEY_FILE` | Private whitespace-separated provider key file |
| `AGENS_KEY_INDEX` | Zero-based index of verified key (currently 1) |
| `VERCEL_TEAM_ID` | Target Vercel team ID |
| `DEPLOYMENT_STATE_FILE` | Private output file for deployment ID and URL |

The script uploads only four named runtime/config files, never the surrounding repository or key files. Credentials are deployment environment variables; redeploys must supply them again. Poll Vercel deployment state until READY and test the production alias before updating Cloudflare.

Provision `AGENS_RELAY_TOKEN` with Wrangler `secret put` via stdin in staging and production. Never place credentials in KV, Git, command arguments or issue/PR output. The Wrangler secret update activates the binding without a source redeploy; no Worker application code changes are required for this node.

Back up each environment's live `route:zhiyuan-free` before edits. Add only the Agens nodes from `workers/model-pool/cloudflare/provider-pool.route.json`; retain unrelated live edits. Stage an Agens-only route to prove the full egress path, run guest Chat/Work/SSE smoke, then restore normal ordering. Allow KV propagation before drawing conclusions. Production keeps TokenRouter/OpenRouter or Groq ahead of Agens and existing Workers AI/Kimi fallbacks behind it.

Rollback: remove the two nodes with `poolId: agens` from the live KV document, preserving all other entries. Leave the secret in place while old KV caches drain. If rotating the relay token, deploy a new relay project/alias plus a new Worker secret binding and switch KV atomically at the route level; overwriting one side first briefly causes 401 and may quarantine the alias for 24 hours. Use a new alias ID after correcting invalid credentials or wait for the existing quarantine to expire.

Vercel runtime and cancellation reference: https://vercel.com/docs/functions/functions-api-reference
