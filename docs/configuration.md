# 配置与使用

[English](configuration.en.md)

需要 Node.js `>=24.15` 且 `<25`，并安装锁定的依赖：

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

## 准备智能机器人

企业管理员在[企业微信管理后台](https://work.weixin.qq.com/)的智能机器人设置中创建或复用一个支持长连接的机器人，保存 Bot ID、Secret，并让本人在可使用范围内与机器人单聊。长连接主动连接企业微信官方服务器，不需要在桥服务器上开放入站 Webhook。

在机器人配置里选择 **API 模式 → 长连接**。这里需要的是长连接 Secret，不是普通群机器人 Webhook key，也不是自建应用的 Secret。

## 配对本人私聊

推荐用一次性口令配对，自动保存这个机器人实际看到的用户标识：

1. 停止同一 Bot ID 的旧服务和其他消费者。企业微信同一机器人只允许一条有效长连接，新连接会顶掉旧连接。
2. 以最终运行用户，在受保护的 `app.json` 里放 `botId` 和 `secret`，暂时不填用户标识。文件为 `0600`，目录为 `0700`；Windows 使用该用户专用 ACL。
3. 以同一用户运行：

```sh
node scripts/pair-owner.js \
  --app-credentials-file /var/lib/dot-bridge/private/wecom/app.json \
  --output /var/lib/dot-bridge/private/wecom/credentials.json \
  --confirm-stopped --confirm-private-storage
```

4. 五分钟内在本人和机器人的单聊发送完整 `dotbridge-pair:...` 口令。不要发到群聊，不要转发或引用口令。匹配成功才会写入绑定，不会自动认领第一个发消息的人。
5. 保存成功后配对程序自动退出。把 `WECOM_CREDENTIALS_FILE` 指向生成的文件，再启动正式服务。还需要在原 dot 中完成下面的事件订阅。

输出文件必须尚不存在；命令不会覆盖原凭据，不显示用户标识或 Secret。超时后重新运行会生成新的口令。已有核对过的绑定资料时，也可以继续手工配置：

由管理员在受保护位置准备私有 JSON：

```json
{
  "botId": "智能机器人的 Bot ID",
  "secret": "智能机器人的 Secret",
  "ownerId": "本人在此机器人回调中的 from.userid",
  "conversationId": "与 ownerId 完全相同的值"
}
```

企业微信智能机器人单聊以本人在该机器人回调中的 `from.userid` 标识会话，两处必须填写同一个值。按[官方长连接说明](https://developer.work.weixin.qq.com/document/path/101463)，由企业超级管理员创建的机器人收到明文 userid，其他创建者的机器人收到企业主体下的加密 userid。当前桥直接核对此字段，不转换身份；后者不能直接填写通讯录里的明文账号。

绑定值应来自该机器人的已有私有配置，或经本人核对的真实单聊事件。超级管理员创建的机器人可由管理员核对通讯录账号与回调字段是否一致。没有可核对的绑定资料时，使用上面的临时口令配对，或通过获准的私有交接流程取得，不能靠猜测或认领第一条消息完成绑定。桥不会自动绑定第一个发消息的人，也不会记录原始事件用于查身份。不要把群聊 `chatid`、显示名称或另一台机器人的用户标识填到这里，不要把真实凭据提交到 Git 或聊天中。

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
PORT=8802
WECOM_TRANSPORT=websocket
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/wecom.service-key
WECOM_CREDENTIALS_FILE=/var/lib/dot-bridge/private/wecom/credentials.json
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/wecom.storage-key
DATABASE_PATH=/var/lib/dot-bridge/data/wecom/messages.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/data/locks
CALLBACK_TRANSPORT_MODE=standard
CALLBACK_HOSTS=替换为原dot真实订阅回调的精确域名
```

示例显式使用 8802；省略 `PORT` 时组件内置值为 8791。组合部署先选择实际空闲端口。

部署人员需要安全准备独立的服务 key 和存储 key。存储 key 是 32 字节的标准 Base64 编码，并且必须与原数据库和备份一起保留；服务 key 不得与路由器或其他渠道共用。`CALLBACK_HOSTS` 使用原 dot 实际订阅地址的精确域名。

在仓库目录启动：

```sh
node --env-file=/var/lib/dot-bridge/private/wecom.env scripts/run-live.js --confirm-live
```

生产环境使用总仓库配置 systemd。MCP 端口只监听 loopback，官方 Secure MCP Tunnel 指向总仓库聚合路由器，路由器再访问本渠道。需要检查目录但不接入企业微信时，改用 `scripts/run-readiness.js`：operation 为 `readiness`、`WECOM_TRANSPORT=disabled`，移除 provider credentials、storage key、database 变量，只提供本渠道独立的 service key。

## 使用原 dot

按[总仓库运行说明](https://github.com/Arcueid77/dot-bridge/blob/main/docs/operations.md)连接 Tunnel，在原来的 dot 中刷新插件并建立 `wecom.message.created` 的真实事件订阅。工具目录会提供 `get_wecom_message`、`get_wecom_attachment`、`reply_to_wecom`、`reply_wecom_media`、`get_wecom_reply_status` 和 `check_wecom_readiness`。先取得真实回调地址，再配置和确认精确域名。

完成后，从本人绑定的企业微信私聊发一条独特的文字，确认原 dot 收到且原私聊只回复一次。普通文字和平台语音转写会交给 dot；图片与文件可按需读取。附件下载地址和解密 key 保存在服务端私有状态，不会出现在工具结果中。[附件与回复](media.md)列出了格式和时效。

没有回答时，让原 dot 查看 `check_wecom_readiness` 的 `gateway_connected` 与 `subscription_active`。前者为企业微信连接情况，后者为原 dot 的有效订阅。订阅失败时看该工具提供的失败阶段和原因，再处理对应问题，不要反复创建。回调域名配置使用 `CALLBACK_HOSTS`，填写原 dot 真实回调的精确域名。

每条最终回复最多 20,000 字符。6,826 字符且不超过 20,480 UTF-8 字节时，作为一条已完成的文字消息发送；更长的回答以完整 `answer.txt` 文件回复，不截断或分成多次发送。桥会等待对应回复回执；超时或断线会保留“结果不明”，不会自动重发，也不会改走主动群发接口。

同一 Bot ID 只运行一个消费者。若状态显示被其他连接接管，先检查并停止重复实例，再重启目标实例。网络断线可自动恢复；连续五次认证被拒后会停止重连，需要先修正配置再重启。迁移时先停旧实例，保留原数据库、存储 key 和订阅状态。
