# Model Pool provider compatibility

Last verified: 2026-09-04

This matrix records protocol evidence for admitting a provider into a ZhiYuan logical-model route. A provider is added only to protocol routes it has passed. Credentials and physical model names remain server-side.

| Provider | OpenAI chat | Anthropic Messages | Streaming | Tool calling | Current admission |
| --- | --- | --- | --- | --- | --- |
| Groq | Pass | Unsupported by the documented API | Pass | Pass | `free-agent-openai` |
| OpenRouter | Pass | Pass | Pass for both protocols | Pass for both protocols | `free-agent-openai`; Anthropic-qualified but not activated |
| Workers AI | Pass | Not supported by Cloudflare `/ai/v1/messages` | Pass | Pass | Final OpenAI fallback |
| Agnes | Blocked by origin HTTP 1015 | Not tested | Not tested | Not tested | Excluded |

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
