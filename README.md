# ZhiYuan AnySearch Gateway

Cloudflare Worker that exposes an authenticated AnySearch endpoint to ZhiYuan Agents. Each stored AnySearch key is one independent account and one flat pool member. Raw keys are AES-GCM encrypted before entering D1; neither keys nor search queries are written to logs.

## Endpoints

- `GET /health`
- `POST /v1/search` — `Authorization: Bearer $AGENT_GATEWAY_TOKEN`
- `POST /admin/keys` — `Authorization: Bearer $ADMIN_TOKEN`; JSON: `{ "label": "account-a", "key": "as_sk_...", "max_concurrency": 2 }`
- `GET /admin/keys` — returns metadata only
- `PATCH /admin/keys/:id` — JSON: `{ "status": "active|cooldown|exhausted|disabled" }`

Search accepts `query`, `max_results` (1-20), `tag`, `zone`, `language`, and `params`. It returns AnySearch's JSON response plus `gateway_request_id`.

## Production setup

1. Create the D1 database and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`.
2. Set all three secrets using `wrangler secret put`: `POOL_ENCRYPTION_KEY` (base64-encoded 32 random bytes), `ADMIN_TOKEN`, and `AGENT_GATEWAY_TOKEN`.
3. Apply migrations and deploy. The configured custom domain is `search.rongxzyai.com`.
4. Add each AnySearch key through `/admin/keys`; never commit it to this repository or config file.

`/v1/search` leases a key slot from D1, retries once only for an upstream 5xx/network failure, and marks keys disabled (401/403), exhausted (402), or temporarily cooled down (429). The first Chat/Agent integration should invoke this endpoint only from Electron main process or a server-side component—not from a renderer/browser bundle.
