# Model Pool provider compatibility

Last verified: 2026-09-08

This matrix records protocol evidence for admitting a provider into a ZhiYuan logical-model route. A provider is added only to protocol routes it has passed. Credentials and physical model names remain server-side.

| Provider | OpenAI chat | Anthropic Messages | Streaming | Tool calling | Current admission |
| --- | --- | --- | --- | --- | --- |
| TokenRouter GLM 5.3 Free | Pass through Worker egress | Not tested | Pass | Pass | First Chat/Work node via four Worker-secret aliases; AI Gateway custom-provider response is unusable |
| Groq | Pass | Unsupported by the documented API | Pass | Pass | Chat/Work keyed fallback through four AI Gateway aliases |
| OpenRouter MiniMax M3 Free | Pass | Pass | Pass for both protocols | Not admitted for Work | First AI Gateway Chat fallback through six aliases |
| Kimi K2.7 Code standard (`kimi-for-coding`) | Pass | Documented; not tested | Pass | Pass | Late Chat/Work fallback via `custom-kimi-code`; K3 and HighSpeed are intentionally excluded to conserve quota |
| Workers AI | Pass | Not supported by Cloudflare `/ai/v1/messages` | Pass | Pass for admitted Work models | Low-cost Chat fallback and tool-capable Work fallback |
| Agnes 2.5 Flash | Pass via Cloudflare → authenticated Vercel relay | Not tested | Pass with usage and DONE | Pass non-streaming and streaming | Chat/Work fallback using one verified key; direct Cloudflare egress remains excluded |

## Agens Vercel relay evidence and boundary

The `iad1` Vercel Node.js relay calls `agnes-2.5-flash` using the second supplied key. The first key returned 401 and is not provisioned. Local and Vercel requests succeeded with the same valid key; this does not establish that every Cloudflare IP is blocked or every Agens key is healthy.

- Direct relay tests passed non-streaming required tool calls and streamed tool calls with usage and `[DONE]`.
- An Agens-only staging KV route passed Cloudflare streamed tool calling, logical-model rewriting and usage. No alternative provider was present to mask a failure.
- The guest suite passed non-streaming Chat, Work tool calling and SSE/usage through the staging route containing an intentionally invalid relay alias followed by the valid Agens alias. The invalid alias's separate test health scope was then removed from KV.
- One earlier ordinary SSE request returned 502; subsequent direct and Cloudflare SSE tests passed. Agens remains best-effort capacity behind existing preferred providers, with existing fallbacks after it. This is admission evidence, not a load test or availability SLA.
- Relay 401/403/429/5xx signals and quota headers are preserved for Cloudflare's health scheduler; upstream error bodies are sanitized. There is no IP rotation or retry inside the relay.

Deployment, key rotation and rollback instructions live in [services/agens-relay](../../services/agens-relay/README.md). No frontend changes or new public model IDs are required.

## Kimi Code evidence and boundary

The configured `sk-kimi-` credential was tested with the OpenAI-compatible standard `kimi-for-coding` model (Kimi K2.7 Code). This is the baseline-consumption K2.7 option; the HighSpeed variant consumes about three times the quota, and K3 is intentionally not configured.

- Direct non-streaming inference against `https://api.kimi.com/coding/v1/chat/completions` returned a valid completion and token usage.
- Cloudflare AI Gateway custom provider `custom-kimi-code` passed non-streaming inference, required tool calling, and streaming through a dedicated staging Dynamic Route.
- Direct `fetch` from the Model Pool Worker to the Kimi origin returned HTTP 403, so Kimi is admitted only through the AI Gateway custom-provider path.
- Kimi streaming emits a final usage-only event without a `model` field. The smoke test accepts provider summary events without a model while still requiring every present model identity to be rewritten to `zhiyuan-free`.

This credential belongs to Kimi Code membership. Kimi documents Kimi Code for coding tools and directs product integrations to the usage-billed Kimi Platform. Treat this node as best-effort fallback capacity and replace it with a Kimi Platform credential before relying on it as general production capacity.

References:

- <https://www.kimi.com/code/docs/en/>
- <https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/>

## TokenRouter evidence and boundary

Four TokenRouter credentials are configured as independent aliases. Direct local probes were inconsistent: GLM 5.3 Free passed required tool calling on one key, while another key returned quota exhaustion and two requests timed out. This is why the provider is admitted only behind per-key health state and bounded retries.

Cloudflare AI Gateway's `custom-tokenrouter` endpoint reaches the origin and returns TokenRouter request IDs, but returns an empty HTTP 200 HTML response for both BYOK and explicit authorization. The same request through the staging Model Pool Worker returns valid OpenAI JSON; guest Chat, Work tool calling, streaming, logical-model rewriting, and usage smoke tests pass. TokenRouter therefore uses direct Worker egress until its AI Gateway response compatibility changes.

## OpenRouter Anthropic evidence

The configured OpenRouter credential was tested directly against `POST https://openrouter.ai/api/v1/messages` with `minimax/minimax-m3:free`:

- Non-streaming response returned an Anthropic `message` with `input_tokens` and `output_tokens`.
- Forced tool selection returned an Anthropic `tool_use` block for the requested function.
- Streaming returned `message_start`, incremental events, `message_stop`, and final token usage.
- The credential remained local and was passed to curl through a temporary `0600` header file; it was not printed or committed.

OpenRouter documents the native endpoint and model fallbacks at:

- <https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages>
- <https://openrouter.ai/docs/guides/routing/model-fallbacks>

## Cloudflare activation boundary

Cloudflare's native REST API supports Anthropic-format `POST /ai/v1/messages`, but it does not support Dynamic Routes. Dynamic Routes remain callable only through the OpenAI-compatible `/compat/chat/completions` endpoint. Therefore `free-agent-anthropic` must remain inactive until one of these conditions is met:

1. Cloudflare adds Dynamic Routing to the native Messages API.
2. The architecture explicitly approves an OpenRouter-native route as an interim exception.
3. The architecture explicitly approves a protocol adapter outside the current V1 boundary.

References:

- <https://developers.cloudflare.com/ai-gateway/usage/rest-api/>
- <https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/>
