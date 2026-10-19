import WebSocketClient from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ENDPOINT = 'wss://openws.work.weixin.qq.com';
const MAX_FRAME = 1024 * 1024;

function validString(value, limit = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/u.test(value);
}

function required(value, limit = 512) {
  if (!validString(value, limit)) throw new Error('WeCom credentials are incomplete or invalid.');
  return value;
}

function messageContent(body) {
  const attachments = [];
  let text = '';
  if (body.msgtype === 'text') text = body.text?.content;
  else if (body.msgtype === 'mixed' && Array.isArray(body.mixed?.msg_item)) {
    const texts = [];
    for (const part of body.mixed.msg_item.slice(0, 100)) {
      if (part?.msgtype === 'text' && typeof part.text?.content === 'string') texts.push(part.text.content);
      else if (['image', 'file', 'video', 'voice'].includes(part?.msgtype)) {
        attachments.push({ kind: part.msgtype === 'voice' ? 'audio' : part.msgtype });
      }
    }
    text = texts.join('\n');
  } else if (['image', 'file', 'video', 'voice'].includes(body.msgtype)) {
    const item = { kind: body.msgtype === 'voice' ? 'audio' : body.msgtype };
    if (validString(body[body.msgtype]?.filename, 255)) item.name = body[body.msgtype].filename;
    attachments.push(item);
    // This is the platform-provided transcript, not downloaded audio.
    if (body.msgtype === 'voice') text = body.voice?.content ?? body.voice?.text;
  } else return null;
  if (typeof text !== 'string') text = '';
  if (text.length > 20_000 || (!text.trim() && attachments.length === 0)) return null;
  return { text, attachments: attachments.slice(0, 10) };
}

export function createProvider({ credentials, onMessage, signal, WebSocket = WebSocketClient, timing = {} }) {
  if (!credentials || typeof onMessage !== 'function') throw new Error('WeCom provider configuration is invalid.');
  const botId = required(credentials.botId);
  const secret = required(credentials.secret, 4096);
  const ownerId = required(credentials.ownerId);
  const conversationId = required(credentials.conversationId);
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

  async function ingest(frame) {
    const body = frame.body;
    if (!body || typeof body !== 'object' || body.chattype !== 'single' || body.aibotid !== botId ||
        body.from?.userid !== ownerId || !validString(body.msgid, 256) || !validString(frame.headers?.req_id)) return;
    const content = messageContent(body);
    if (!content) return;
    const message = {
      id: body.msgid, senderId: ownerId, conversationId, ...content,
      replyContext: { reqId: frame.headers.req_id },
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
            if (frame.errcode === 0) item.resolve({});
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

  return {
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
      await Promise.allSettled([...tasks]);
    },
    status() { return { connected, displaced, authenticationFailed }; },
    async sendReply({ message, text, idempotencyKey }) {
      if (!connected || controller.signal.aborted || !socket) throw new Error('WeCom is disconnected.');
      if (message?.senderId !== ownerId || message?.conversationId !== conversationId ||
          !validString(message.replyContext?.reqId) || typeof text !== 'string' || !text.trim() ||
          text.length > 20_000 || Buffer.byteLength(text) > 20_480 || !validString(idempotencyKey, 1024)) {
        throw new Error('WeCom reply is invalid or exceeds 20,480 UTF-8 bytes.');
      }
      const reqId = message.replyContext.reqId;
      if (pending.size >= 32 || pending.has(reqId)) throw new Error('WeCom reply is already pending.');
      const streamId = `dotbridge_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
      const source = socket;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.get(reqId)?.source !== source) return;
          pending.delete(reqId);
          reject(new Error('WeCom reply acknowledgement was not confirmed.'));
        }, requestTimeout);
        pending.set(reqId, { source, timer, resolve, reject });
        try {
          write(source, {
            cmd: 'aibot_respond_msg', headers: { req_id: reqId },
            body: { msgtype: 'stream', stream: { id: streamId, finish: true, content: text } },
          });
        } catch {
          clearTimeout(timer);
          pending.delete(reqId);
          reject(new Error('WeCom reply acknowledgement was not confirmed.'));
        }
      });
    },
  };
}
