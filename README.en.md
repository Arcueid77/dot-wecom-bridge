# WeCom for DotBridge

[中文](README.md) · [English](README.en.md)

Use the original ChatGPT dot from the bound owner's WeCom smart-bot DM. This adapter uses **API mode → long connection**, with shared runtime/authentication in `dot-bridge-core` and installation through the [unified distribution](https://github.com/Arcueid77/dot-bridge).

Use Node.js >=24.15 and <25. A continuously available Linux or Windows host can run the backend; Linux provides systemd. macOS is unverified; trials and feedback are welcome.

## Setup

An enterprise administrator creates or reuses a smart bot supporting long connection, obtains its Bot ID/Secret and permits the owner to DM it. Complete the [owner phrase pairing and configuration](docs/configuration.en.md). The pairing records the user identifier actually supplied by this bot's official callbacks.

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --env-file=/var/lib/dot-bridge/private/wecom.env scripts/run-live.js --confirm-live
```

Use the unified router/service entry for persistent operation. Refresh the existing Tunnel and reuse/renew `wecom.message.created` with `conversation=owner`. Keep credentials private and stop the old consumer first. A takeover notification stops reconnect attempts so the operator can resolve duplicate instances.

## Messaging and media

Receive text, images and files. Incoming voice uses WeCom's transcript. Replies support text, images, existing AMR audio and files. Each source selects one final reply. Complete answers are at most 20,000 characters; above 6,826 native characters or 20,480 UTF-8 bytes, the full answer is delivered as `answer.txt`.

Attachments are at most 5 MiB; AMR replies at most 2 MiB. Media has no extra caption. Reuse a received image/file by source index. Protected Linux processing adds PDF/Office excerpts and optional transcription where raw audio is actually available. See [media formats and expiry](docs/media.en.md).

Preserve binding, the original storage key, database, subscriptions and uncertain outcomes. Account/platform connection and original-dot subscription are separate state layers.

## Owner notifications

Explicit `DOT_BRIDGE_OUTBOUND=owner-text` enables bound-owner text and saved reminders, up to 2,000 characters. Repeating reminders need an end date. Use the original dot's existing tools and retain its event task. See [scheduled messages](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.en.md).

Source/protocol evidence and the remaining real-account acceptance are recorded in [development](docs/development.md).

## Choices, uploads and reminder management

Numbered text choices let the user answer with a selection. A dot environment with programmatic file access can upload generated media in bounded encrypted chunks, verify its size and SHA-256, then submit the source-bound final reply. Files are limited to 5 MiB and this provider's supported media types and formats.

Literal reminders support weekdays, fixed intervals, pause, resume and delivery history. Check `check_wecom_outbound` before use and supply the saved reminder ID and current revision. Resuming skips old paused occurrences.


## Tasks, consecutive messages and speech

Task tools return a source-bound reference, passive deadline and remaining seconds. The original dot can save one complete text result. The paired owner can use `/tasks` and `/result reference` in the original DM. Source retention applies, and ambiguous delivery stays uncertain.

The protected interaction policy accepts `queue`, for example `{"mode":"batch","window_ms":750,"max_messages":5}`. Modes are `independent`, `serial` and `batch`, defaulting to independent. A batch retains every source and replies through the last source as its anchor. Attachments, quotes and work already started are handled separately, with the existing conversation/member isolation.

Linux operators can install eSpeak NG and the protected audio runtime, then set `DOT_BRIDGE_SPEECH_SYNTHESIS=local-espeak` and `DOT_BRIDGE_SPEECH_VOICE=zh`. The original dot uses `check_wecom_speech` and `reply_wecom_speech`, limited to 2000 characters and 120 seconds. The full text is also retained in the task record.

An explicitly rejected one-time proactive send can be retried after owner confirmation using `retry_wecom_outbound`, its original ID and current revision. The per-channel proactive switch still applies. Recurring reminders keep their edit/resume flow. Hosted-dot stop, reset and approvals use the original platform controls.

## Groups and native reply streams

`DOT_BRIDGE_INTERACTION_POLICY_FILE` configures selected groups, membership and triggers using the shared fields. The long-connection smart bot handles group messages actually delivered by WeCom; enterprise configuration controls that reception scope. Use the original dot's single `conversation=configured` subscription. Context follows the conversation and member policy.

A native stream can show a processing cue, update with genuinely generated content and finish or cancel the same stream. A final media reply closes that cue before sending its single attachment. Synthesized speech is delivered as a WAV file.
