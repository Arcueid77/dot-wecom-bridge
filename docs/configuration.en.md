# Configure WeCom

[中文](configuration.md) · [English](configuration.en.md)

Use Node.js >=24.15 and <25 and install with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`.

## Smart bot and owner pairing

An enterprise administrator creates/reuses a smart bot in [WeCom administration](https://work.weixin.qq.com/), chooses **API mode → long connection**, saves the Bot ID/Secret, and permits the owner DM. The adapter connects to `wss://openws.work.weixin.qq.com`.

Stop the old consumer. Save `botId` and the long-connection `secret` in protected `app.json`, then run as the final service account:

```sh
node scripts/pair-owner.js \
  --app-credentials-file /var/lib/dot-bridge/private/wecom/app.json \
  --output /var/lib/dot-bridge/private/wecom/credentials.json \
  --confirm-stopped --confirm-private-storage
```

Send the complete temporary `dotbridge-pair:…` phrase in the owner DM within five minutes. The destination must not exist. A verified match saves the credentials and exits. Keep an existing binding during upgrades.

The full JSON contains `botId`, `secret`, `ownerId`, and matching `conversationId`. Both owner fields use this bot's actual `from.userid`, including the enterprise-scoped encrypted value when the platform supplies one. Phrase pairing avoids copying a different bot's or directory's identifier.

## Private configuration

Linux directories are 0700 and files 0600, owned by the runtime account; Windows uses private ACLs. Data/lock directories belong to that user. Use independent backend/router service keys and keep each original storage key with its database.

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8802
WECOM_TRANSPORT=websocket
WECOM_CREDENTIALS_FILE=/var/lib/dot-bridge/private/wecom/credentials.json
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/wecom/service-key
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/wecom/storage-key
DATABASE_PATH=/var/lib/dot-bridge/wecom/bridge.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/locks
CALLBACK_TRANSPORT_MODE=standard
CALLBACK_HOSTS=REPLACE_WITH_APPROVED_CALLBACK_HOST
```

8802 is an explicit combination example; the built-in component port is 8791. Choose a free port and keep MCP on loopback.

```sh
node --env-file=/var/lib/dot-bridge/private/wecom.env scripts/run-live.js --confirm-live
```

Use the unified router/service entry for persistent operation. Provider-disabled checks use `scripts/run-readiness.js`, operation `readiness`, `WECOM_TRANSPORT=disabled`, and only the independent service key; remove provider/storage/database variables.

## Original-dot subscription and media

Refresh the original plugin and reuse/renew `wecom.message.created` with `conversation=owner`. Approve the real callback's exact hostname in `CALLBACK_HOSTS`. The public routed diagnostic tool is `check_wecom_readiness`; the direct backend uses `check_wecom_setup`. `dotbridge status` handles the mapping.

Verify one source DM returns once. Text and platform voice transcripts go to the original dot; images/files are read on demand. [Media](media.en.md) lists expiry and formats. Long text above 6,826 characters or 20,480 UTF-8 bytes is sent as complete `answer.txt`, up to 20,000 characters total.

Keep one connection per Bot ID. A takeover event stops reconnecting; resolve duplicates before restarting. Five consecutive authentication rejections require corrected configuration before a restart. Preserve the original database, storage key, subscriptions and uncertain results when migrating.
