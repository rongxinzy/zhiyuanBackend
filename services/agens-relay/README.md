# Agens relay

The Model Pool's existing direct-provider adapter calls this authenticated Vercel Node.js function. Desktop clients continue using `https://model.rongxzyai.com/v1/chat/completions` and `zhiyuan-free`; authentication, guest/account quotas, usage accounting, conversation affinity and failover remain in Cloudflare.

## Boundaries

- Only `POST /api/chat/completions`; fixed upstream `https://apihub.agnes-ai.com/v1/chat/completions`, redirects forbidden.
- Only `agnes-2.5-flash`. No caller-selected upstream or model. JSON request limit 1 MiB; output capped at 16,384 tokens (Cloudflare retains the tighter 4,096 Chat ceiling).
- Vercel holds `AGENS_API_KEY` / `AGENS_RELAY_TOKEN` for the existing alias and sensitive `AGENS_POOL_CREDENTIALS` for additional `{token, apiKey}` pairs. Each Cloudflare alias holds its own internal token only. The relay maps that token to exactly one supplier key; key selection, affinity and failover remain in Cloudflare. No provider key, prompt or response logging in relay code.
- The production alias is `https://zhiyuan-agens-relay-v2.vercel.app/api`. The original `zhiyuan-agens-relay` instance and `AGENS_RELAY_TOKEN` binding remain available for rollback. Unique preview/deployment URLs can be protected by Vercel SSO; do not disable deployment protection to use them.
- SSE and JSON success bodies stream with backpressure. Consumer cancellation aborts upstream; Vercel cancellation is enabled. Overall relay timeout is 175 seconds and Vercel function limit is 180 seconds. The Worker applies a first-useful-event deadline, a 30-second idle timeout and a 150-second total attempt limit; see `workers/model-pool/SESSION-AFFINITY.md`.
- No relay retries. HTTP 401/402/403/408/429/5xx and quota headers reach the existing Cloudflare health scheduler; upstream error bodies are replaced with generic JSON. Wrong relay credentials also produce 401.
- A failed request before response headers can fall back. A stream already sent to the client cannot switch providers seamlessly; it fails in place. Deadline limits apply to the whole stream, not just time to first token.
- Provisioned aliases are `key-2`, `key-3`, and `key-4`; the first supplied key remains excluded after its earlier 401. New keys 3/4 passed local and Vercel inference during provisioning; key 2 returned 401 on the latest relay probe and remains subject to the existing circuit breaker. Chat and Work share each key's health/quota identity. Distinct keys do not prove distinct account allowances; consolidate quota scopes if supplier account metadata establishes shared limits. Never duplicate the same key as independent capacity.
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
| `AGENS_KEY_FILE` | Private whitespace-separated provider key file (currently `.agnes`) |
| `AGENS_KEY_INDEX` | Zero-based index of verified key (currently 1) |
| `POOL_CREDENTIALS_FILE` | Optional private JSON file for additional token/key pairs; never put its contents in arguments |
| `VERCEL_TEAM_ID` | Target Vercel team ID |
| `DEPLOYMENT_STATE_FILE` | Private output file for deployment ID and URL |

The script uploads only five named runtime/config files, never the surrounding repository or key files. Always supply credentials explicitly through the script; do not rely on `deploymentId` to inherit deployment-only variables when uploading replacement files. The v2 project retains credentials as sensitive production project variables. Poll Vercel deployment state until READY and test the production alias before updating Cloudflare. The private rotation token and additional credential mapping are retained outside Git under `/Users/krli/.config/zhiyuan-model-pool/`.

Provision `AGENS_RELAY_TOKEN_V2` with Wrangler `secret put` via stdin in staging and production. Never place credentials in KV, Git, command arguments or issue/PR output. The Wrangler secret update activates the binding without a source redeploy; no Worker application code changes are required for this node. Preserve the provider alias and quota scope during internal-token rotation because the underlying provider key has not changed.

Back up each environment's live `route:zhiyuan-free` before edits. Add only the Agens nodes from `workers/model-pool/cloudflare/provider-pool.route.json`; retain unrelated live edits. Stage an Agens-only route to prove the full egress path, run guest Chat/Work/SSE smoke, then restore normal ordering. Allow KV propagation before drawing conclusions. Production keeps TokenRouter/OpenRouter or Groq ahead of Agens and existing Workers AI/Kimi fallbacks behind it.

Rollback: remove the two nodes with `poolId: agens` from the live KV document, preserving all other entries. Leave the secret in place while old KV caches drain. If rotating the relay token, deploy a new relay project/alias plus a new Worker secret binding and switch KV atomically at the route level; overwriting one side first briefly causes 401 and may quarantine the alias for 24 hours. Use a new alias ID after correcting invalid credentials or wait for the existing quarantine to expire.

Vercel runtime and cancellation reference: https://vercel.com/docs/functions/functions-api-reference
