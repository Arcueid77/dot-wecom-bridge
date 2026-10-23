import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createEnrollmentProvider, createProvider } from '../src/provider.js';
import { createPairingChallenge } from '@dot-bridge/core/channels/pairing.js';

test('WeCom enrollment accepts only authenticated original text in this bot private chat', async t => {
  const credentials = { botId: 'fixture-bot', secret: 'fixture-secret' };
  assert.throws(() => createProvider({ credentials, onMessage: async () => {} }), /credentials/u);
  assert.throws(() => createEnrollmentProvider({ credentials, onPairingMessage: async () => {} }), /stopped/u);
  let socket;
  class Socket extends EventEmitter {
    constructor() { super(); socket = this; this.readyState = 1; this.sent = []; }
    send(raw, callback) { this.sent.push(JSON.parse(raw)); callback?.(); }
    terminate() { this.emit('close'); }
    receive(body) { this.emit('message', Buffer.from(JSON.stringify(body))); }
  }
  const candidates = [];
  const challenge = createPairingChallenge();
  const provider = createEnrollmentProvider({ credentials, confirmStopped: true, WebSocket: Socket, onPairingMessage: async value => { candidates.push(value); challenge.accept(value); } });
  t.after(() => provider.stop()); await provider.start(); socket.emit('open');
  const callback = extra => ({ cmd: 'aibot_msg_callback', headers: { req_id: 'fixture-request' }, body: {
    aibotid: credentials.botId, chattype: 'single', msgid: 'fixture-message', from: { userid: 'fixture-owner' },
    msgtype: 'text', text: { content: challenge.phrase }, create_time: Math.floor(Date.now() / 1000), ...extra,
  } });
  socket.receive(callback({})); assert.equal(candidates.length, 0);
  socket.receive({ headers: socket.sent[0].headers, errcode: 0 });
  for (const invalid of [{ aibotid: 'other' }, { chattype: 'group' }, { from: { userid: '' } },
    { from: { userid: credentials.botId } }, { from: { userid: 'fixture-user', bot: true } },
    { msgtype: 'voice' }, { forwarded: true }, { quote: {} }]) socket.receive(callback(invalid));
  socket.receive(callback({})); await delay(5);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ownerId, candidates[0].conversationId);
  assert.deepEqual(challenge.result(), { ownerId: 'fixture-owner', conversationId: 'fixture-owner' });
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['conversationId', 'ownerId', 'text', 'timestamp']);
  assert.equal(socket.sent.length, 1);
  assert.equal(provider.sendReply, undefined);
  assert.equal(provider.sendMediaReply, undefined);
});

test('pairing CLI refuses missing private-storage confirmation before reading app credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/pair-owner.js', '--app-credentials-file', 'not-read.json', '--output', 'not-created.json', '--confirm-stopped'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /No private files were read/u);
  assert.equal(result.stderr, '');
});
