# Kimi relay

Cloudflare calls `https://zhiyuan-kimi-relay.vercel.app/api/chat/completions` with the private `KIMI_RELAY_TOKEN` Worker secret. Vercel alone holds `KIMI_API_KEY`; both values are persisted as sensitive production project variables. No desktop changes are needed.

The only allowed upstream is `https://api.kimi.com/coding/v1/chat/completions`, with model `kimi-for-coding` and honest `ZhiYuanModelPool/1.0` User-Agent. No caller-selected origin, redirects, K3 or HighSpeed. The relay limits request JSON to 1 MiB and output to 16,384 tokens; the Worker retains the lower Chat ceiling. SSE passes through with backpressure and cancellation. The relay has no retries, a 175-second deadline, and Vercel maxDuration 180 seconds. Error bodies are sanitized; HTTP status and quota headers remain available to the scheduler.

The `kimi` pool stays in its existing workload position. `vercel-default` is a new egress health identity, avoiding the old gateway's confirmed WAF-failure cooldown; `kimi-default` remains the same quota scope because this is the same supplier key, not additional capacity. Session affinity migrates after success. Fallback budgeting recognizes the `kimi` pool for both gateway and direct nodes, retaining the 15-second Chat / 25-second Work reserve.

Run `npm run test:kimi-relay`, `npm run test:model-pool`, and `npm run check:model-pool` before deployment. `node services/kimi-relay/deploy.mjs` uploads four explicit files. Supply these environment variables as paths/identifiers, never secret values:

- `VERCEL_TOKEN_FILE`: Vercel management token file.
- `RELAY_TOKEN_FILE`: existing private internal token file; production uses `/Users/krli/.config/zhiyuan-model-pool/kimi-relay.token`.
- `KIMI_KEY_FILE`: supplier credential file.
- `VERCEL_TEAM_ID`: target team.
- `DEPLOYMENT_STATE_FILE`: private deployment metadata output path.

Wait for READY, test unauthenticated rejection, then deploy the budget-aware Worker before switching KV. Back up each environment's live route and replace only the two Kimi nodes. Verify an isolated Kimi-only staging route with non-stream Chat, required tool calls, SSE and usage before restoring the full pool and switching production. Probe with at least 512 output tokens to avoid mistaking reasoning-only truncation for transport failure. Keep the prior AI Gateway config/credential for rollback; restoring the previous Kimi nodes does not require a database migration.

Kimi Code membership usage remains subject to the supplier's plan scope. A successful egress test is not a production availability SLA or evidence of permission to redistribute membership capacity.
