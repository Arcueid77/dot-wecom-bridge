# 配置与使用

需要 Node.js `>=24.15` 且 `<25`，并安装锁定的依赖：

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

## 准备智能机器人

企业管理员在[企业微信管理后台](https://work.weixin.qq.com/)的智能机器人设置中创建或复用一个支持长连接的机器人，保存 Bot ID、Secret，并让本人在可使用范围内与机器人单聊。长连接主动连接企业微信官方服务器，不需要在桥服务器上开放入站 Webhook。

由管理员在受保护位置准备私有 JSON：

```json
{
  "botId": "智能机器人的 Bot ID",
  "secret": "智能机器人的 Secret",
  "ownerId": "本人企业微信 userid",
  "conversationId": "与 ownerId 完全相同的 userid"
}
```

企业微信智能机器人单聊以本人 `userid` 标识会话，所以两处填写同一个值。它们应来自已有部署资料、企业后台或该机器人的真实单聊事件；桥不会自动绑定第一个发消息的人，也不会记录原始事件用于查身份。不要把群聊 `chatid` 或显示名称填到这里，不要把真实凭据提交到 Git 或聊天中。

本版只连接官方公共服务 `wss://openws.work.weixin.qq.com`。企业微信私有化部署、自建应用回调、群机器人 Webhook 和群聊不在此入口支持范围内。

## 配置桥

私有文件建议放到 `/var/lib/dot-bridge/private/`，由最终服务用户持有；目录 `0700`、文件 `0600`。数据目录与锁目录也由该用户持有。私有文件必须是普通文件，不能用符号链接或硬链接，也不要通过放宽权限解决启动拒绝。Windows 使用共享 core 的用户专用 ACL 设置。

`wecom.env` 的示例：

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8791
WECOM_TRANSPORT=websocket
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/wecom.service-key
WECOM_CREDENTIALS_FILE=/var/lib/dot-bridge/private/wecom.credentials.json
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/wecom.storage-key
DATABASE_PATH=/var/lib/dot-bridge/data/wecom/messages.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/data/locks
CALLBACK_TRANSPORT_MODE=standard
CALLBACK_HOSTS=替换为原dot真实订阅回调的精确域名
```

部署人员需要安全准备独立的服务 key 和存储 key。存储 key 是 32 字节的标准 Base64 编码，并且必须与原数据库和备份一起保留；服务 key 不得与路由器或其他渠道共用。`CALLBACK_HOSTS` 使用原 dot 实际订阅地址的精确域名。

在仓库目录启动：

```sh
node --env-file=/var/lib/dot-bridge/private/wecom.env scripts/run-live.js --confirm-live
```

生产环境使用总仓库配置 systemd。MCP 端口只监听 loopback，官方 Secure MCP Tunnel 指向总仓库聚合路由器，路由器再访问本渠道。需要检查目录但不接入企业微信时，改用 `scripts/run-readiness.js`：operation 为 `readiness`、`WECOM_TRANSPORT=disabled`，移除 provider credentials、storage key、database 变量，只提供本渠道独立的 service key。

## 使用原 dot

按[总仓库运行说明](https://github.com/Arcueid77/dot-bridge/blob/dev/unified-distribution/docs/operations.md)连接 Tunnel，在原来的 dot 中刷新插件并建立 `wecom.message.created` 的真实事件订阅。工具目录会提供 `get_wecom_message`、`reply_to_wecom`、`get_wecom_reply_status` 和 `check_wecom_setup`。先取得真实回调地址，再配置和确认精确域名。

完成后，从本人绑定的企业微信私聊发一条独特的文字，确认原 dot 收到且原私聊只回复一次。普通文字和平台附带的语音转写会交给 dot；附件只提示类型，不会传递下载 URL、解密 key 或原始二进制内容。

每条最终回复最多 6,826 个字符，作为一条结束的流式消息发送。桥会等待对应回复回执；超时或断线会保留“结果不明”，不会自动重发，也不会改走主动群发接口。

同一 Bot ID 只运行一个消费者。若状态显示被其他连接接管，先检查并停止重复实例，再重启目标实例。网络断线可自动恢复；连续五次认证被拒后会停止重连，需要先修正配置再重启。迁移时先停旧实例，保留原数据库、存储 key 和订阅状态。
