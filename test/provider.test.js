import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createProvider } from '../src/provider.js';

const credentials = { botId: 'fixture-bot', secret: 'fixture-secret', ownerId: 'fixture-owner', conversationId: 'fixture-owner' };

function sockets() {
  const instances = [];
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.sent = []; this.readyState = 0; instances.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    receive(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
    send(raw, callback) { this.sent.push(JSON.parse(raw)); queueMicrotask(() => callback?.()); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    authenticate(errcode = 0) {
      this.open();
      const request = this.sent.find(frame => frame.cmd === 'aibot_subscribe');
      this.receive({ headers: request.headers, errcode, errmsg: 'Fixture server result' });
    }
  }
  return { Socket, instances };
}

async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture condition timed out.'); await delay(2); }
}

function message(overrides = {}, reqId = 'fixture-req') {
  return {
    cmd: 'aibot_msg_callback', headers: { req_id: reqId },
    body: { msgid: 'fixture-message', aibotid: credentials.botId, chattype: 'single',
      from: { userid: credentials.ownerId }, create_time: 1_700_000_000,
      msgtype: 'text', text: { content: 'Fixture question' }, ...overrides },
  };
}

test('fixed official endpoint authenticates before accepting private text', async t => {
  const { Socket, instances } = sockets();
  const messages = [];
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async event => { messages.push(event); } });
  t.after(() => provider.stop());
  await provider.start();
  assert.equal(instances.length, 1);
  const socket = instances[0];
  assert.equal(socket.url, 'wss://openws.work.weixin.qq.com');
  assert.equal(socket.options.followRedirects, false);
  assert.equal(socket.options.rejectUnauthorized, true);
  assert.equal(socket.options.maxPayload, 1024 * 1024);
  socket.receive(message());
  assert.equal(messages.length, 0);
  assert.equal(provider.status().connected, false);
  socket.authenticate();
  assert.deepEqual(socket.sent[0].body, { bot_id: credentials.botId, secret: credentials.secret });
  assert.equal(provider.status().connected, true);
  socket.receive(message());
  await until(() => messages.length === 1);
  assert.deepEqual(messages[0], {
    id: 'fixture-message', senderId: credentials.ownerId, conversationId: credentials.ownerId,
    text: 'Fixture question', attachments: [], timestamp: 1_700_000_000_000,
    replyContext: { reqId: 'fixture-req' },
  });
  // Ordinary callback ingestion sends no premature reply/consumer ACK frame.
  assert.equal(socket.sent.length, 1);
});

test('owner, bot, group and bounds guards reject unrelated messages', async t => {
  const { Socket, instances } = sockets();
  let delivered = 0;
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async () => { delivered++; } });
  t.after(() => provider.stop()); await provider.start(); instances[0].authenticate();
  for (const patch of [{ from: { userid: 'other-owner' } }, { aibotid: 'other-bot' },
    { chattype: 'group', chatid: credentials.ownerId }, { msgid: '' }, { text: { content: 'x'.repeat(20_001) } },
    { msgtype: 'event' }]) instances[0].receive(message(patch));
  await delay(5);
  assert.equal(delivered, 0);
  assert.throws(() => createProvider({ credentials: { ...credentials, conversationId: 'group-chat' }, onMessage: async () => {} }), /private/u);
});

test('platform voice transcript and mixed attachments expose metadata only', async t => {
  const { Socket, instances } = sockets();
  const received = [];
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async event => { received.push(event); } });
  t.after(() => provider.stop()); await provider.start(); instances[0].authenticate();
  instances[0].receive(message({ msgtype: 'voice', voice: { content: 'Platform transcript' } }));
  instances[0].receive(message({ msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: 'Fixture caption' } },
    { msgtype: 'image', image: { url: 'https://evil.example', aeskey: 'do-not-forward' } },
  ] } }));
  await until(() => received.length === 2);
  assert.equal(received[0].text, 'Platform transcript');
  assert.deepEqual(received[0].attachments, [{ kind: 'audio' }]);
  assert.equal(received[1].text, 'Fixture caption');
  assert.deepEqual(received[1].attachments, [{ kind: 'image' }]);
  assert.equal(JSON.stringify(received).includes('evil.example'), false);
  assert.equal(JSON.stringify(received).includes('aeskey'), false);
});

test('final reply retains callback req_id, uses stable stream id and requires matching success ACK', async t => {
  const { Socket, instances } = sockets();
  const received = [];
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async event => { received.push(event); } });
  t.after(() => provider.stop()); await provider.start(); const socket = instances[0]; socket.authenticate();
  socket.receive(message()); await until(() => received.length === 1);
  let settled = false;
  const reply = provider.sendReply({ message: received[0], text: 'Fixture reply', idempotencyKey: 'fixture-idempotency' }).then(value => { settled = true; return value; });
  const frame = socket.sent.at(-1);
  assert.equal(frame.cmd, 'aibot_respond_msg');
  assert.equal(frame.headers.req_id, 'fixture-req');
  assert.equal(frame.body.msgtype, 'stream');
  assert.equal(frame.body.stream.content, 'Fixture reply');
  assert.equal(frame.body.stream.finish, true);
  assert.match(frame.body.stream.id, /^dotbridge_[a-f0-9]{32}$/u);
  socket.receive({ headers: { req_id: 'other-req' }, errcode: 0 });
  await delay(5); assert.equal(settled, false);
  socket.receive({ headers: { req_id: 'fixture-req' }, errcode: 0 });
  assert.deepEqual(await reply, {});
  const second = provider.sendReply({ message: received[0], text: 'Fixture reply', idempotencyKey: 'fixture-idempotency' });
  assert.equal(socket.sent.at(-1).body.stream.id, frame.body.stream.id);
  socket.receive({ headers: { req_id: 'fixture-req' }, errcode: 400, errmsg: 'fixture-secret must not escape' });
  await assert.rejects(second, error => error.message === 'WeCom reply acknowledgement was not confirmed.');
});

test('uncertain reply is not retried after ACK timeout or reconnect', async t => {
  const { Socket, instances } = sockets();
  const received = [];
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { requestTimeoutMs: 20, reconnectMs: 5 },
    onMessage: async event => { received.push(event); },
  });
  t.after(() => provider.stop()); await provider.start(); const socket = instances[0]; socket.authenticate();
  socket.receive(message()); await until(() => received.length === 1);
  await assert.rejects(provider.sendReply({ message: received[0], text: 'Fixture reply', idempotencyKey: 'fixture-one' }), /not confirmed/u);
  assert.equal(socket.sent.filter(frame => frame.cmd === 'aibot_respond_msg').length, 1);
  const pending = provider.sendReply({ message: received[0], text: 'Fixture reply', idempotencyKey: 'fixture-two' });
  const rejected = assert.rejects(pending, /not confirmed/u);
  socket.terminate(); await rejected;
  await until(() => instances.length === 2); instances[1].authenticate();
  await delay(10);
  assert.equal(instances[1].sent.filter(frame => frame.cmd === 'aibot_respond_msg').length, 0);
});

test('oversize text and unrelated stored recipient are rejected before send', async t => {
  const { Socket, instances } = sockets();
  const received = [];
  const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async event => { received.push(event); } });
  t.after(() => provider.stop()); await provider.start(); const socket = instances[0]; socket.authenticate();
  socket.receive(message()); await until(() => received.length === 1);
  await assert.rejects(provider.sendReply({ message: received[0], text: '汉'.repeat(7000), idempotencyKey: 'fixture-key' }));
  await assert.rejects(provider.sendReply({ message: { ...received[0], conversationId: 'other-chat' }, text: 'Fixture reply', idempotencyKey: 'fixture-key' }));
  assert.equal(socket.sent.length, 1);
});

test('another instance disconnect event stops reconnect rather than fighting it', async t => {
  const { Socket, instances } = sockets();
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { reconnectMs: 5 }, onMessage: async () => {} });
  t.after(() => provider.stop()); await provider.start(); instances[0].authenticate();
  instances[0].receive({ cmd: 'aibot_event_callback', headers: { req_id: 'fixture-disconnect' }, body: { event: { eventtype: 'disconnected_event' } } });
  await delay(20);
  assert.equal(instances.length, 1);
  assert.deepEqual(provider.status(), { connected: false, displaced: true, authenticationFailed: false });
});

test('missing heartbeat ACK closes stale connection and stop clears reconnect timers', async t => {
  const { Socket, instances } = sockets();
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { heartbeatIntervalMs: 5, reconnectMs: 1000 }, onMessage: async () => {} });
  t.after(() => provider.stop()); await provider.start(); const socket = instances[0]; socket.authenticate();
  await until(() => socket.readyState === 3);
  assert.equal(socket.sent.filter(frame => frame.cmd === 'ping').length, 2);
  await provider.stop(); await delay(20); assert.equal(instances.length, 1);
});

test('ingestion failure disconnects without creating a reply or local dedup marker', async t => {
  const { Socket, instances } = sockets();
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { reconnectMs: 1000 },
    onMessage: async () => { throw new Error('Private fixture diagnostic'); },
  });
  t.after(() => provider.stop()); await provider.start(); const socket = instances[0]; socket.authenticate();
  socket.receive(message()); await until(() => socket.readyState === 3);
  assert.equal(socket.sent.length, 1);
});

test('repeated rejected authentication stops at five attempts and exposes booleans only', async t => {
  const { Socket, instances } = sockets();
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { reconnectMs: 2 }, onMessage: async () => {} });
  t.after(() => provider.stop()); await provider.start();
  for (let count = 1; count <= 5; count++) {
    await until(() => instances.length === count); instances[count - 1].authenticate(40001);
  }
  await delay(30);
  assert.equal(instances.length, 5);
  assert.deepEqual(provider.status(), { connected: false, displaced: false, authenticationFailed: true });
  await provider.stop(); await assert.rejects(provider.start(), /stopped/u);
});

test('external cancellation terminates an opening handshake', async () => {
  const { Socket, instances } = sockets();
  const controller = new AbortController();
  const provider = createProvider({ credentials, WebSocket: Socket, signal: controller.signal, onMessage: async () => {} });
  await provider.start(); controller.abort(); await provider.stop();
  assert.equal(instances[0].readyState, 3);
  assert.equal(provider.status().connected, false);
});
