import WebSocketClient from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { aesKey, imageMime, mediaName, mediaUrl, readEncryptedMedia, validateMediaReply } from './media.js';
import {channel} from './channel.js';

const ENDPOINT = 'wss://openws.work.weixin.qq.com';
const MAX_FRAME = 1024 * 1024;

function validString(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value);
}

function authorizeSend(authorize) {
  if (authorize === undefined) return;
  if (typeof authorize !== 'function') throw new Error('WeCom send authorization is invalid.');
  const result = authorize();
  if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  if (result !== undefined) throw new Error('WeCom send authorization must be synchronous.');
}

function required(value, limit = 512) {
  if (!validString(value, limit)) throw new Error('WeCom credentials are incomplete or invalid.');
  return value;
}

function messageContent(body) {
  const attachments = [];
  const mediaRefs = [];
  function add(part) {
    if (attachments.length >= 10) return;
    const kind = part.msgtype === 'voice' ? 'audio' : part.msgtype;
    const info = part[part.msgtype] ?? {};
    const attachment = { kind };
    if (mediaName(info.filename)) attachment.name = info.filename;
    attachments.push(attachment);
    let reference = null;
    if (['image', 'file'].includes(kind)) {
      try {
        const url = mediaUrl(info.url);
        aesKey(info.aeskey).fill(0);
        reference = { url, aeskey: info.aeskey, expiresAt: Date.now() + 5 * 60_000 };
      } catch { /* Preserve safe metadata when a resource cannot be read. */ }
    }
    mediaRefs.push(reference);
  }
  let text = '';
  if (body.msgtype === 'text') text = body.text?.content;
  else if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    const texts = [];
    for (const part of body.mixed.msg_item.slice(0, 100)) {
      if (part?.msgtype === 'text' && typeof part.text?.content === 'string') texts.push(part.text.content);
      else if (['image', 'file', 'video', 'voice'].includes(part?.msgtype)) {
        add(part);
      }
    }
    text = texts.join('\n');
  } else if (['image', 'file', 'video', 'voice'].includes(body.msgtype)) {
    add(body);
    // This is the platform-provided transcript, not downloaded audio.
    if (body.msgtype === 'voice') text = body.voice?.content ?? body.voice?.text;
  } else return null;
  if (typeof text !== 'string') text = '';
  if (text.length > 20_000 || (!text.trim() && attachments.length === 0)) return null;
  return { text, attachments, mediaRefs };
}

function createTransport({ credentials, onMessage, signal, fetch = globalThis.fetch, WebSocket = WebSocketClient, timing = {} }, onPairingMessage) {
  if (!credentials || typeof onMessage !== 'function' || typeof fetch !== 'function') throw new Error('WeCom provider configuration is invalid.');
  const botId = required(credentials.botId);
  const secret = required(credentials.secret, 4096);
  const ownerId = onPairingMessage ? undefined : required(credentials.ownerId, 256);
  const conversationId = onPairingMessage ? undefined : required(credentials.conversationId, 256);
  // Official single-chat sending identifies the chat by userid. Keeping one
  // convention avoids accepting a group chat with the same configured owner.
  if (conversationId !== ownerId) throw new Error('WeCom private conversationId must match ownerId.');
  const controller = new AbortController();
  const requestTimeout = timing.requestTimeoutMs ?? 10_000;
  const retryBase = timing.reconnectMs ?? 1000;
  let socket;
  let runner;
  let started = false;
  let stopped = false;
  let connected = false;
  let displaced = false;
  let authenticationFailed = false;
  let failedAuthentications = 0;
  const tasks = new Set();
  const mediaTasks = new Set();
  const pending = new Map();

  function failPending(source) {
    for (const [id, item] of pending) {
      if (item.source === source) {
        clearTimeout(item.timer);
        pending.delete(id);
        item.reject(new Error('WeCom reply acknowledgement was not confirmed.'));
      }
    }
  }

  function abort() {
    controller.abort();
    connected = false;
    if (socket) { failPending(socket); socket.terminate(); }
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  function write(source, frame) {
    if (controller.signal.aborted || source !== socket || source.readyState !== 1) {
      throw new Error('WeCom is disconnected.');
    }
    source.send(JSON.stringify(frame), error => {
      if (error) { failPending(source); source.terminate(); }
    });
  }

  function request(source, reqId, cmd, body) {
    if (!connected || source !== socket || controller.signal.aborted) return Promise.reject(new Error('WeCom is disconnected.'));
    if (pending.size >= 32 || pending.has(reqId)) return Promise.reject(new Error('WeCom reply is already pending.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.get(reqId)?.source !== source) return;
        pending.delete(reqId);
        reject(new Error('WeCom reply acknowledgement was not confirmed.'));
      }, requestTimeout);
      pending.set(reqId, { source, timer, resolve, reject });
      try { write(source, { cmd, headers: { req_id: reqId }, body }); }
      catch {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(new Error('WeCom reply acknowledgement was not confirmed.'));
      }
    });
  }

  function ownMessage(message) {
    if (message?.senderId !== ownerId || message?.conversationId !== conversationId ||
        !validString(message.replyContext?.reqId)) throw new Error('WeCom message binding is invalid.');
  }

  async function track(work) {
    mediaTasks.add(work);
    try { return await work; } finally { mediaTasks.delete(work); }
  }

  async function ingest(frame) {
    const body = frame.body;
    if (!body || typeof body !== 'object' || body.chattype !== 'single' || body.aibotid !== botId ||
        (!onPairingMessage && body.from?.userid !== ownerId) || !validString(body.msgid, 256) || !validString(frame.headers?.req_id)) return;
    if (onPairingMessage) {
      if (body.msgtype === 'text' && validString(body.from?.userid, 256) && body.from.userid !== botId &&
          !body.from.bot && !body.isForward && !body.isForwarded && !body.forwarded && !body.forward && !body.quote) {
        await onPairingMessage({ text: body.text?.content, ownerId: body.from.userid, conversationId: body.from.userid,
          ...(Number.isSafeInteger(body.create_time) ? { timestamp: body.create_time * 1000 } : {}) });
      }
      return;
    }
    const content = messageContent(body);
    if (!content) return;
    const { mediaRefs, ...parts } = content;
    const message = {
      id: body.msgid, senderId: ownerId, conversationId, ...parts,
      replyContext: { reqId: frame.headers.req_id, ...(mediaRefs.length ? { mediaRefs } : {}) },
    };
    if (Number.isSafeInteger(body.create_time) && body.create_time > 0 && Number.isSafeInteger(body.create_time * 1000)) {
      message.timestamp = body.create_time * 1000;
    }
    // The official smart-bot protocol has no separate consumer ACK for this
    // callback. Commit to core before completing our handler; never pre-dedup.
    await onMessage(message);
  }

  async function connection() {
    if (controller.signal.aborted) return;
    await new Promise(resolve => {
      const source = new WebSocket(ENDPOINT, {
        followRedirects: false, maxPayload: MAX_FRAME, handshakeTimeout: requestTimeout,
        perMessageDeflate: false, rejectUnauthorized: true,
      });
      socket = source;
      const subscribeId = `aibot_subscribe_${randomUUID()}`;
      let authenticationTimer;
      let heartbeat;
      let authenticated = false;
      let pingSequence = 0;
      const pings = new Set();

      source.on('open', () => {
        if (controller.signal.aborted) { source.terminate(); return; }
        try {
          write(source, { cmd: 'aibot_subscribe', headers: { req_id: subscribeId }, body: { bot_id: botId, secret } });
          authenticationTimer = setTimeout(() => source.terminate(), requestTimeout);
        } catch { source.terminate(); }
      });
      source.on('error', () => source.terminate());
      source.on('close', () => {
        clearTimeout(authenticationTimer);
        clearInterval(heartbeat);
        failPending(source);
        if (socket === source) { socket = undefined; connected = false; }
        resolve();
      });
      source.on('message', raw => {
        if (controller.signal.aborted || source !== socket || raw.length > MAX_FRAME) return;
        let frame;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (!frame || !validString(frame.headers?.req_id)) return;
        const reqId = frame.headers.req_id;
        if (!frame.cmd) {
          if (reqId === subscribeId && !authenticated) {
            clearTimeout(authenticationTimer);
            if (frame.errcode !== 0) {
              failedAuthentications++;
              authenticationFailed = failedAuthentications >= 5;
              source.terminate();
              return;
            }
            authenticated = true;
            connected = true;
            failedAuthentications = 0;
            heartbeat = setInterval(() => {
              if (pings.size >= 2) { source.terminate(); return; }
              const pingId = `ping_${subscribeId}_${++pingSequence}`;
              pings.add(pingId);
              try { write(source, { cmd: 'ping', headers: { req_id: pingId } }); }
              catch { source.terminate(); }
            }, timing.heartbeatIntervalMs ?? 30_000);
            return;
          }
          if (!authenticated) return;
          if (pings.has(reqId)) {
            if (frame.errcode === 0) pings.clear();
            return;
          }
          const item = pending.get(reqId);
          if (item?.source === source) {
            clearTimeout(item.timer);
            pending.delete(reqId);
            if (frame.errcode === 0) item.resolve(frame.body ?? {});
            else item.reject(new Error('WeCom reply acknowledgement was not confirmed.'));
          }
          return;
        }
        if (!authenticated) return;
        if (frame.cmd === 'aibot_event_callback') {
          if (frame.body?.event?.eventtype === 'disconnected_event') {
            // Another instance took this bot connection. Reconnecting here
            // would repeatedly evict the other instance.
            displaced = true;
            connected = false;
            source.terminate();
          }
          return;
        }
        if (frame.cmd !== 'aibot_msg_callback') return;
        if (tasks.size >= 32) { source.terminate(); return; }
        const task = ingest(frame).catch(() => source.terminate());
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      });
    });
  }

  async function run() {
    let backoff = retryBase;
    while (!controller.signal.aborted && !displaced && !authenticationFailed) {
      const before = Date.now();
      try { await connection(); } catch { /* safe bounded reconnect, no raw logs */ }
      if (controller.signal.aborted || displaced || authenticationFailed) break;
      if (Date.now() - before > 60_000) backoff = retryBase;
      try { await delay(backoff, undefined, { signal: controller.signal }); } catch { break; }
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  const provider = {
    async start() {
      if (stopped) throw new Error('WeCom provider has stopped.');
      if (started) return;
      started = true;
      runner = run();
    },
    async stop() {
      stopped = true;
      abort();
      signal?.removeEventListener('abort', abort);
      await runner;
      await Promise.allSettled([...tasks, ...mediaTasks]);
    },
    status() { return { connected, displaced, authenticationFailed }; },
    async sendOwnerMessage({text, authorize}) {
      if (!connected || controller.signal.aborted || !socket || !ownerId || typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > 2000) throw new Error('WeCom owner text is unavailable.');
      authorizeSend(authorize);
      await request(socket, `outbound_${randomUUID()}`, 'aibot_send_msg', {chatid:conversationId, msgtype:'markdown', markdown:{content:text}});
      return {};
    },
    validateMediaReply,
    async readAttachment({ message, attachmentIndex }) {
      ownMessage(message);
      if (controller.signal.aborted) throw new Error('WeCom provider has stopped.');
      const attachment = message.attachments?.[attachmentIndex];
      const reference = message.replyContext.mediaRefs?.[attachmentIndex];
      if (!Number.isSafeInteger(attachmentIndex) || attachmentIndex < 0 || !['image', 'file'].includes(attachment?.kind) ||
          !reference || !Number.isSafeInteger(reference.expiresAt) || reference.expiresAt <= Date.now()) {
        throw new Error('WeCom attachment is unavailable or its five-minute download window expired.');
      }
      const url = mediaUrl(reference.url);
      aesKey(reference.aeskey).fill(0);
      return track((async () => {
        try {
          const response = await fetch(url, { method: 'GET', redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeout)]),
          });
          const data = await readEncryptedMedia(response, reference.aeskey);
          const mimeType = attachment.kind === 'image' ? imageMime(data) : 'application/octet-stream';
          return { data, mimeType, ...(attachment.name ? { name: attachment.name } : {}) };
        } catch { throw new Error('WeCom media download or decryption failed.'); }
      })());
    },
    async sendMediaReply({ message, media, text, idempotencyKey, authorize }) {
      ownMessage(message);
      validateMediaReply({ media, text });
      if (!validString(idempotencyKey, 1024)) throw new Error('WeCom reply key is invalid.');
      const source = socket;
      const type = media.type === 'audio' ? 'voice' : media.type;
      const chunkSize = 512 * 1024;
      return track((async () => {
        authorizeSend(authorize);
        const init = await request(source, `media_init_${randomUUID()}`, 'aibot_upload_media_init', {
          type, filename: media.name, total_size: media.data.length,
          total_chunks: Math.ceil(media.data.length / chunkSize), md5: createHash('md5').update(media.data).digest('hex'),
        });
        if (!validString(init.upload_id)) throw new Error('WeCom media upload was not confirmed.');
        for (let offset = 0; offset < media.data.length; offset += chunkSize) {
          authorizeSend(authorize);
          await request(source, `media_chunk_${randomUUID()}`, 'aibot_upload_media_chunk', {
            upload_id: init.upload_id, chunk_index: offset / chunkSize,
            base64_data: media.data.subarray(offset, offset + chunkSize).toString('base64'),
          });
        }
        authorizeSend(authorize);
        const result = await request(source, `media_finish_${randomUUID()}`, 'aibot_upload_media_finish', { upload_id: init.upload_id });
        if (!validString(result.media_id) || result.type !== type) throw new Error('WeCom media upload was not confirmed.');
        ownMessage(message);
        authorizeSend(authorize);
        await request(source, message.replyContext.reqId, 'aibot_respond_msg', { msgtype: type, [type]: { media_id: result.media_id } });
        return {};
      })());
    },
    async sendReply({ message, text, idempotencyKey, authorize }) {
      if (!connected || controller.signal.aborted || !socket) throw new Error('WeCom is disconnected.');
      if (message?.senderId !== ownerId || message?.conversationId !== conversationId ||
          !validString(message.replyContext?.reqId) || typeof text !== 'string' || !text.trim() || !text.isWellFormed() ||
          text.length > channel.maxReplyText || Buffer.byteLength(text) > 60000 || !validString(idempotencyKey, 1024)) {
        throw new Error('WeCom reply is invalid or exceeds 20,000 characters.');
      }
      if (text.length > channel.nativeMaxReplyText || Buffer.byteLength(text) > 20480) {
        const data = Buffer.from(text, 'utf8');
        try { return await provider.sendMediaReply({message, media: {type: 'file', data, mimeType: 'text/plain', name: 'answer.txt'}, idempotencyKey, authorize}); }
        finally { data.fill(0); }
      }
      const reqId = message.replyContext.reqId;
      const streamId = `dotbridge_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
      const source = socket;
      authorizeSend(authorize);
      await request(source, reqId, 'aibot_respond_msg', { msgtype: 'stream', stream: { id: streamId, finish: true, content: text } });
      return {};
    },
  };
  return provider;
}

export function createProvider(options) { return createTransport(options); }

export function createEnrollmentProvider(options) {
  if (options?.confirmStopped !== true || typeof options.onPairingMessage !== 'function') throw new Error('WeCom pairing requires confirmation that the old consumer is stopped.');
  const provider = createTransport({ ...options, onMessage: async () => {} }, options.onPairingMessage);
  return { start: provider.start, stop: provider.stop, status: provider.status };
}
