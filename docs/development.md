# Provider development

This provider implements the official public WeCom smart-bot WebSocket protocol,
not the legacy application webhook protocol. Core owns encrypted persistence,
single-owner authorization, subscriptions and durable final-reply state.

Authentication must succeed before a callback is ingested. The callback handler
awaits core ingestion; the official protocol has no independent consumer ACK for
`aibot_msg_callback`. A transport reconnect cannot itself guarantee that WeCom will
redeliver a callback interrupted before ingestion. No callback is locally marked
handled before core has accepted it.

Final text is sent once with the original callback `req_id` and a stable hashed
stream ID; success requires a matching successful ACK. There is no automatic
retry, alternate-recipient API or proactive-send fallback. Reply size is bounded
conservatively in channel metadata and checked again against the documented
20,480 UTF-8 byte stream limit. Network reconnects have exponential backoff;
another-instance `disconnected_event` stops reconnecting to avoid an eviction
loop. Five consecutive explicit authentication failures stop reconnecting.

The endpoint is fixed, `ws` is pinned, TLS verification stays enabled, redirects
are disabled, and incoming frames are limited to 1 MiB. No media URL or aeskey is
persisted, downloaded or passed to dot.

References consulted on 2026-10-19:

- [Official WeCom smart-bot Node SDK](https://github.com/WecomTeam/aibot-node-sdk)
- [Official WebSocket protocol implementation](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/ws.ts)
- [Official message types](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/types/message.ts)
- [Official stream reply types and size limit](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/types/api.ts)
- [cc-connect WeCom transport at the research revision](https://github.com/chenhg5/cc-connect/blob/2dec7173bdd44ec598c3c7e5c7ff00407acfdedf/platform/wecom/websocket.go)

Run `npm run check` and `npm test`. Synthetic fixtures cover authentication,
identity/chat guards, metadata/transcripts, matching reply ACKs, uncertain sends,
reconnects, heartbeat expiry, displaced consumers, authentication rejection and
shutdown. They do not connect real enterprise accounts or prove original-dot
end-to-end delivery.
