# ZhiYuan Model Pool infrastructure

This directory owns the Cloudflare resources for the ZhiYuan Model Pool business layer. The Worker, D1, KV, and Durable Object are isolated from the existing community authentication service.

## Environments

| Environment | Worker | D1 | KV |
| --- | --- | --- | --- |
| Production | `zhiyuan-model-pool` | `zhiyuan-model-pool` | `zhiyuan-model-pool-config` |
| Staging | `zhiyuan-model-pool-staging` | `zhiyuan-model-pool-staging` | `zhiyuan-model-pool-config-staging` |

The `UserQuota` SQLite Durable Object namespace is provisioned by the first deployment of each Worker environment.

## Commands

Run from the `zhiyuanBackend` repository root:

```bash
npm run types:model-pool
npm run check:model-pool
npm run migrate:model-pool:staging
npm run deploy:model-pool:staging
npm run migrate:model-pool
npm run deploy:model-pool
```

The deployed test slice exposes `GET /health`, `GET /v1/models`, and `POST /v1/chat/completions`. Model endpoints require `MODEL_POOL_TEST_TOKEN`; the provider key is stored only as the `UPSTREAM_API_KEY` Worker secret. `zhiyuan-free` is resolved through KV and daily request admission is serialized by `UserQuota`.

The cloud test route uses `mode: workers-ai-test` and calls Workers AI through the `default` AI Gateway. It validates authentication, logical-model rewriting, quota, gateway observability, streaming, and tool calls without exposing an external provider key. The `mode: direct-test` route remains available only for local provider diagnostics and must not be exposed as a public model service.

D1 marks `zhiyuan-free` active and records `default` as its OpenAI route. KV contains the test route's runtime model selection; D1 remains the business metadata source for the later user, plan, and entitlement implementation.

For an operator smoke test, store the bearer token in `workers/model-pool/.test-token` with file mode `0600`. The path is ignored by Git. Rotate the deployed `MODEL_POOL_TEST_TOKEN` secret whenever this local token is replaced.

## AI Gateway boundary

Wrangler does not currently expose AI Gateway or Dynamic Route management commands. Create the Gateway, stored provider credentials, and Dynamic Routes through the Cloudflare dashboard or through the REST API with a dedicated Cloudflare API token that has `AI Gateway - Read` and `AI Gateway - Edit`. Wrangler OAuth tokens are not used as long-lived project credentials.

Cloudflare Dynamic Routes currently run through the OpenAI-compatible `/compat/chat/completions` endpoint. Do not mark the Anthropic route mapping active until Cloudflare supports Dynamic Routes on the Anthropic-native endpoint or the architecture explicitly chooses a protocol adapter.
