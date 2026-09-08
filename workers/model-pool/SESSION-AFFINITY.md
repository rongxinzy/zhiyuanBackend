# Session affinity and key allocation

## Routing contract

- `x-zhiyuan-conversation-id` must remain stable across turns and authentication retries. Missing/invalid IDs retain the existing request-local behavior and cannot provide cross-request affinity.
- The authenticated user's existing SQLite `UserQuota` Durable Object owns bindings keyed by `[logical model, Chat/Work workload, conversation ID]`. The binding stores the exact node/model/egress and key alias/account/secret-binding identity, never credentials or messages.
- First allocation preserves configured free-first provider priority. Within a provider, weighted rendezvous scoring incorporates configured key weight, reported remaining capacity and active leases. A final hash avalanche removes the correlated rankings of adjacent key aliases.
- Subsequent requests prefer the bound node and eligible key regardless of load-score changes. Health cooldowns, exhausted quota scopes and excluded attempts still take precedence. Failover tries another eligible key, then another node with the same model, then configured fallbacks. A successful fallback replaces the binding; subsequent turns do not jump back to the first provider.
- Changed model/egress/account/secret-binding identities invalidate key preference. Idle bindings expire after 24 hours; a user may retain at most 1,024 active session records. Cleanup runs on access.

## Concurrency and failure boundaries

- A fenced, five-minute selection lease serializes route selection for one user/session/workload, not the whole stream or every session of a user. A concurrent selector receives HTTP 503 with `Retry-After: 2` before request quota is charged. Reaching the session-record cap also rejects new selections until records expire; existing sessions remain available.
- Bindings commit after a useful SSE event has been received and response rewriting is initialized (after JSON parsing for non-stream responses, before streaming bytes are delivered). HTTP errors, canceled selections and failed initialization do not replace a binding. A stale selection cannot overwrite a newer one. A post-inference binding failure uses `session_selection_failed`, never the safely retryable `session_busy` code.
- Provider leases remain active until stream accounting completes. Once streaming has begun, this change does not retry/replay partial output, replay tools, or guarantee recovery from truncated SSE. Affinity does not store conversation content or guarantee provider-side prompt cache hits.
- Affinity is intentionally stronger than load balancing for healthy existing sessions. New sessions and migrations absorb load shifts; this is not a strict per-key concurrency/RPM ceiling, nor a promise of equal token volume across keys.

## Stream reliability

- Provider selection shares a 30-second Chat / 45-second Work budget. An individual attempt waits at most 8 / 12 seconds (or the smaller configured timeout / remaining budget) for the first useful content, reasoning, tool or terminal event. Headers, role-only frames and heartbeat comments do not satisfy that deadline. These are initial policy values, not measured production latency guarantees; authentication and business-policy lookup precede this budget.
- A first-event timeout advances to the next provider node instead of spending the shared budget on another alias at the same slow node. Authentication and quota rejections retain eligible-key failover.
- After useful output, the short timer is cleared. Streams have a 30-second idle timeout and a 150-second total attempt limit. Body reads for HTTP errors are also bounded. The first-event preamble is capped at 64 KiB and SSE buffering at 1 MiB.
- Missing terminal events and malformed SSE fail the stream. Usage already observed is recorded; failed keyed streams are reported to provider health, while user cancellation only releases resources. No partial stream is automatically replayed.
- Desktop Chat retries only `session_busy` before inference, at most twice, honoring Retry-After up to three seconds and canceling backoff when stopped. Unknown 503s and `session_selection_failed` are not retried. EOF without termination is surfaced as interruption, length termination is distinct, and canceled/closed renderer streams detach listeners and ignore late callbacks.
- Agens relay must be republished with its 175-second safety deadline and Vercel maxDuration 180 seconds, so it does not cut off the Worker's 150-second attempt first. Confirm Fluid Compute / allowed duration during deployment; see https://vercel.com/docs/functions/configuring-functions/duration. No project setting, subscription, deployment or quota was changed by this patch. Deploy the relay update before the Worker update to remove the old 55-second cutoff.

## Validation and rollout

`npm run test:model-pool` includes SQLite persistence/fencing/expiry/isolation tests, deterministic 10,000-session distribution checks, and local Wrangler/workerd tests against the real Durable Object RPC and SQL implementations. The runtime fixture has no production bindings or credentials and makes no inference calls.

The desktop Chat IPC must send `conversationId: chatId` separately from its per-request stream ID. The agent runtime already sends its stable session ID. Deploy the backend through the existing Worker release workflow; the desktop change requires the normal application release. No new Cloudflare namespace or migration tag is needed because both existing classes use SQLite storage already.

Measured equal-weight distribution (10,000 independent new sessions): four keys `2544, 2514, 2509, 2433`; six keys `1693, 1660, 1670, 1603, 1641, 1733`. With weights 1:2:3: `1724, 3386, 4890`. With one of three equal keys carrying nine in-flight leases: `477, 4795, 4728`. These are deterministic allocation tests, not production throughput measurements.
