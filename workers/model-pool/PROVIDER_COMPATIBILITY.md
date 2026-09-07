# Model Pool provider compatibility

Last verified: 2026-09-07

This matrix records protocol evidence for admitting a provider into a ZhiYuan logical-model route. A provider is added only to protocol routes it has passed. Credentials and physical model names remain server-side.

| Provider | OpenAI chat | Anthropic Messages | Streaming | Tool calling | Current admission |
| --- | --- | --- | --- | --- | --- |
| Groq | Pass | Unsupported by the documented API | Pass | Pass | `free-agent-openai` |
| OpenRouter | Pass | Pass | Pass for both protocols | Pass for both protocols | `free-agent-openai`; Anthropic-qualified but not activated |
| Kimi Code | Pass | Documented; not tested | Pass | Pass | `free-agent-openai` third fallback via `custom-kimi-code` |
| Workers AI | Pass | Not supported by Cloudflare `/ai/v1/messages` | Pass | Pass | Final OpenAI fallback |
| Agnes | Blocked by origin HTTP 1015 | Not tested | Not tested | Not tested | Excluded |

## Kimi Code evidence and boundary

The configured `sk-kimi-` credential was tested with the OpenAI-compatible `kimi-for-coding` model:

- Direct non-streaming inference against `https://api.kimi.com/coding/v1/chat/completions` returned a valid completion and token usage.
- Cloudflare AI Gateway custom provider `custom-kimi-code` passed non-streaming inference, required tool calling, and streaming through a dedicated staging Dynamic Route.
- Direct `fetch` from the Model Pool Worker to the Kimi origin returned HTTP 403, so Kimi is admitted only through the AI Gateway custom-provider path.
- Kimi streaming emits a final usage-only event without a `model` field. The smoke test accepts provider summary events without a model while still requiring every present model identity to be rewritten to `zhiyuan-free`.

This credential belongs to Kimi Code membership. Kimi documents Kimi Code for coding tools and directs product integrations to the usage-billed Kimi Platform. Treat this node as best-effort fallback capacity and replace it with a Kimi Platform credential before relying on it as general production capacity.

References:

- <https://www.kimi.com/code/docs/en/>
- <https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/>

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
