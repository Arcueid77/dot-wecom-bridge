import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createProvider } from '../src/provider.js';
import { channel } from '../src/channel.js';
import { MAX_MEDIA, mediaUrl } from '../src/media.js';

const credentials = { botId: 'fixture-bot', secret: 'fixture-secret', ownerId: 'fixture-owner', conversationId: 'fixture-owner' };
const png = Buffer.from('89504e470d0a1a0a0000000049454e44', 'hex');
const key = Buffer.alloc(32, 7);
const url = 'https://wework.qpic.cn/wwpic3az/123_fixture/0';
const amr = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.from([4]), Buffer.alloc(12)]);
const media = (type = 'image') => ({ type, data: type === 'image' ? png : type === 'audio' ? amr : Buffer.from('fixture document'),
  mimeType: type === 'image' ? 'image/png' : type === 'audio' ? 'audio/amr' : 'text/plain', name: `fixture.${type === 'image' ? 'png' : type === 'audio' ? 'amr' : 'txt'}` });
function encrypt(data) {
  const pad = 32 - data.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([data, Buffer.alloc(pad, pad)])), cipher.final()]);
}
function stored(kind = 'image') {
  return { senderId: credentials.ownerId, conversationId: credentials.ownerId, attachments: [{ kind, name: 'fixture.bin' }],
    replyContext: { reqId: 'fixture-request', mediaRefs: [{ url, aeskey: key.toString('base64'), expiresAt: Date.now() + 60_000 }] } };
}
function sockets({ acknowledge = true, failAt, ignoreAt } = {}) {
  const instances = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; instances.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    receive(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
    send(raw, callback) {
      const frame = JSON.parse(raw); this.sent.push(frame);
      queueMicrotask(() => {
        callback?.();
        if (!acknowledge || frame.cmd === ignoreAt) return;
        const body = frame.cmd === 'aibot_upload_media_init' ? { upload_id: 'fixture-upload' } :
          frame.cmd === 'aibot_upload_media_finish' ? { media_id: 'fixture-media', type: this.sent.find(item => item.cmd === 'aibot_upload_media_init').body.type } : {};
        this.receive({ headers: frame.headers, errcode: frame.cmd === failAt ? 400 : 0, body });
      });
    }
    terminate() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } }
  }
  return { Socket, instances };
}
async function until(check) {
  const end = Date.now() + 1500;
  while (!check()) { if (Date.now() > end) throw new Error('Fixture timeout.'); await delay(1); }
}

test('WeCom advertises raw image/file reads and AMR/image/file replies, but not raw incoming voice', () => {
  assert.deepEqual(channel.media, { read: ['image', 'file'], reply: ['image', 'audio', 'file'] });
  assert.equal(channel.maxMediaReplyText, 0);
});

test('authenticated callbacks retain media references privately and voice remains a transcript', async t => {
  const { Socket, instances } = sockets();
  const received = [];
  let fetches = 0;
  const provider = createProvider({ credentials, WebSocket: Socket, fetch: async () => { fetches++; throw Error(); }, onMessage: async value => { received.push(value); } });
  t.after(() => provider.stop()); await provider.start(); instances[0].open(); await until(() => provider.status().connected);
  const callback = body => ({ cmd: 'aibot_msg_callback', headers: { req_id: 'fixture-request' }, body: {
    msgid: 'fixture-message', aibotid: credentials.botId, chattype: 'single', from: { userid: credentials.ownerId }, ...body,
  } });
  instances[0].receive(callback({ msgtype: 'mixed', mixed: { msg_item: [
    { msgtype: 'text', text: { content: 'caption' } }, { msgtype: 'image', image: { url, aeskey: key.toString('base64') } },
  ] } }));
  instances[0].receive(callback({ msgtype: 'voice', voice: { content: 'Platform transcription' } }));
  await until(() => received.length === 2);
  assert.equal(fetches, 0);
  assert.deepEqual(received[0].attachments, [{ kind: 'image' }]);
  assert.equal(received[0].replyContext.mediaRefs[0].url, url);
  assert.equal(received[1].text, 'Platform transcription');
  assert.deepEqual(received[1].replyContext.mediaRefs, [null]);
});

test('downloads and decrypts images and files using the per-file key, without bot secrets', async t => {
  for (const kind of ['image', 'file']) {
    const data = kind === 'image' ? png : Buffer.from('fixture document data');
    let options;
    const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async (target, init) => {
      assert.equal(target, url); options = init; return new Response(encrypt(data));
    } });
    t.after(() => provider.stop());
    const result = await provider.readAttachment({ message: stored(kind), attachmentIndex: 0 });
    assert.deepEqual(result.data, data);
    assert.equal(result.mimeType, kind === 'image' ? 'image/png' : 'application/octet-stream');
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
  }
});

test('rejects expired resources, unauthorized bindings, SSRF URLs and malformed keys before network', async t => {
  let count = 0;
  const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async () => { count++; throw new Error(); } });
  t.after(() => provider.stop());
  for (const target of ['http://wework.qpic.cn/wwpic3az/a/0', 'https://wework.qpic.cn.evil.test/wwpic3az/a/0',
    'https://wework.qpic.cn@evil.test/wwpic/a/0', 'https://wework.qpic.cn:444/wwpic/a/0',
    'https://127.0.0.1/wwpic/a/0', 'https://qyapi.weixin.qq.com/cgi-bin/gettoken', 'https://wework.qpic.cn/wwpic/a/0#x']) assert.throws(() => mediaUrl(target));
  for (const patch of [{ url: 'https://evil.test/private' }, { aeskey: 'not-a-key' }, { expiresAt: 1 }]) {
    const message = stored(); Object.assign(message.replyContext.mediaRefs[0], patch);
    await assert.rejects(provider.readAttachment({ message, attachmentIndex: 0 }));
  }
  await assert.rejects(provider.readAttachment({ message: { ...stored(), senderId: 'other-owner' }, attachmentIndex: 0 }));
  await assert.rejects(provider.readAttachment({ message: stored('audio'), attachmentIndex: 0 }));
  await assert.rejects(provider.readAttachment({ message: stored(), attachmentIndex: -1 }));
  assert.equal(count, 0);
});

test('rejects oversized, redirected and corrupt encrypted bodies with sanitized errors', async t => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    new Response('x', { headers: { 'content-length': String(MAX_MEDIA + 33) } }), new Response(Buffer.alloc(MAX_MEDIA + 33)),
    new Response(Buffer.alloc(32)), new Response(Buffer.alloc(17))]) {
    const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async () => response });
    t.after(() => provider.stop());
    await assert.rejects(provider.readAttachment({ message: stored(), attachmentIndex: 0 }), error => error.message === 'WeCom media download or decryption failed.');
  }
});

test('uploads all three media types with matching ACKs and replies to the original callback once', async t => {
  for (const type of ['image', 'audio', 'file']) {
    const { Socket, instances } = sockets();
    const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async () => {} });
    t.after(() => provider.stop()); await provider.start(); instances[0].open(); await until(() => provider.status().connected);
    await provider.sendMediaReply({ message: stored(), media: media(type), idempotencyKey: 'fixture-reply' });
    const requests = instances[0].sent.filter(frame => frame.cmd !== 'aibot_subscribe');
    assert.deepEqual(requests.map(item => item.cmd), ['aibot_upload_media_init', 'aibot_upload_media_chunk', 'aibot_upload_media_finish', 'aibot_respond_msg']);
    assert.equal(requests[0].body.type, type === 'audio' ? 'voice' : type);
    assert.equal(requests[1].body.chunk_index, 0);
    assert.deepEqual(Buffer.from(requests[1].body.base64_data, 'base64'), media(type).data);
    assert.equal(requests.at(-1).headers.req_id, 'fixture-request');
    assert.equal(requests.at(-1).body.msgtype, type === 'audio' ? 'voice' : type);
    assert.equal(JSON.stringify(requests).includes(credentials.ownerId), false);
  }
});

test('large files use bounded consecutive chunks and never send after a failed upload', async t => {
  for (const failAt of [undefined, 'aibot_upload_media_chunk']) {
    const { Socket, instances } = sockets({ failAt });
    const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async () => {} });
    t.after(() => provider.stop()); await provider.start(); instances[0].open(); await until(() => provider.status().connected);
    const work = provider.sendMediaReply({ message: stored(), media: { ...media('file'), data: Buffer.alloc(512 * 1024 + 10, 1) }, idempotencyKey: 'fixture-key' });
    if (failAt) {
      await assert.rejects(work, /not confirmed/u);
      assert.equal(instances[0].sent.filter(frame => frame.cmd === 'aibot_respond_msg').length, 0);
    } else {
      await work;
      const chunks = instances[0].sent.filter(frame => frame.cmd === 'aibot_upload_media_chunk');
      assert.deepEqual(chunks.map(frame => frame.body.chunk_index), [0, 1]);
      assert.deepEqual(chunks.map(frame => Buffer.from(frame.body.base64_data, 'base64').length), [512 * 1024, 10]);
    }
  }
});

test('caption, wrong content types and oversized voices fail before uploading; uncertain final sends never retry', async t => {
  const { Socket, instances } = sockets({ ignoreAt: 'aibot_respond_msg' });
  const provider = createProvider({ credentials, WebSocket: Socket, timing: { requestTimeoutMs: 25 }, onMessage: async () => {} });
  t.after(() => provider.stop()); await provider.start(); instances[0].open(); await until(() => provider.status().connected);
  for (const invalid of [{ media: media(), text: 'caption' }, { media: { ...media(), mimeType: 'image/jpeg' } },
    { media: { ...media('audio'), data: Buffer.alloc(2 * 1024 * 1024 + 1) } },
    { media: { ...media('audio'), data: Buffer.from('#!AMR\n') } },
    { media: { ...media('audio'), data: amr.subarray(0, -1) } },
    { media: { ...media('audio'), data: Buffer.concat([Buffer.from('#!AMR\n'), Buffer.from([0xff])]) } },
    { media: { ...media('file'), name: '../private' } }]) {
    assert.throws(() => provider.validateMediaReply(invalid));
  }
  assert.equal(instances[0].sent.length, 1);
  await assert.rejects(provider.sendMediaReply({ message: stored(), media: media(), idempotencyKey: 'fixture-key' }), /not confirmed/u);
  await delay(35);
  assert.equal(instances[0].sent.filter(frame => frame.cmd === 'aibot_respond_msg').length, 1);
});

test('shutdown cancels an outstanding media download and waits for it', async () => {
  let started = false;
  let aborted = false;
  const provider = createProvider({ credentials, onMessage: async () => {}, fetch: async (_target, options) => new Promise((_resolve, reject) => {
    started = true;
    options.signal.addEventListener('abort', () => { aborted = true; reject(Error('private')); }, { once: true });
  }) });
  const work = assert.rejects(provider.readAttachment({ message: stored(), attachmentIndex: 0 }), /download/u);
  await until(() => started); await provider.stop(); await work;
  assert.equal(aborted, true);
});

test('revocation interrupts every upload stage and the final send; authorization cannot be asynchronous', async t => {
  for (const revokeAt of [1, 2, 3, 4]) {
    const { Socket, instances } = sockets();
    const provider = createProvider({ credentials, WebSocket: Socket, onMessage: async () => {} });
    t.after(() => provider.stop()); await provider.start(); instances[0].open(); await until(() => provider.status().connected);
    let checks = 0;
    await assert.rejects(provider.sendMediaReply({ message: stored(), media: media(), idempotencyKey: 'fixture-reply',
      authorize: () => { if (++checks === revokeAt) throw new Error('revoked'); },
    }), /revoked/u);
    assert.equal(instances[0].sent.length, revokeAt);
    assert.equal(instances[0].sent.some(frame => frame.cmd === 'aibot_respond_msg'), false);
    await assert.rejects(provider.sendReply({ message: stored(), text: 'fixture', idempotencyKey: 'fixture-text', authorize: async () => {} }), /synchronous/u);
    assert.equal(instances[0].sent.length, revokeAt);
  }
});
