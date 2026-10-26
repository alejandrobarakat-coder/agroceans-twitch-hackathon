'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TwitchStorage, TwitchFault } = require('../src/twitch-storage');
const { TwitchClient, TwitchTokens, REQUIRED } = require('../src/twitch-client');
const { TwitchChat, createTwitchChat, CALLBACK } = require('../src/twitch-chat');
const { run } = require('../scripts/twitch-eventsub');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '../var-chat-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oauth = path.join(root, 'oauth'); fs.mkdirSync(oauth, { mode: 0o700 });
  const credentialsFile = path.join(oauth, 'credentials.json');
  const original = JSON.stringify({ access_token: 'fixture-user-token', refresh_token: 'fixture-refresh-token', scope: REQUIRED, expires_at: Date.now() + 3600000 });
  fs.writeFileSync(credentialsFile, original, { mode: 0o600 });
  const storage = new TwitchStorage(path.join(root, 'chat'));
  let time = Date.now(), chat; const now = () => time;
  const published = [], calls = []; let remote = [], created;
  const config = { validationStatus: 200, refreshStatus: 200, scopes: [...REQUIRED], user: '123', client: 'fixture-client', registrationStatus: 202, challenge: true, ...options };
  async function fetchImpl(url, request) {
    calls.push({ url, method: request.method || 'GET' });
    assert.equal(request.redirect, 'error'); assert.ok(request.signal instanceof AbortSignal);
    if (config.transportError) throw Error('fixture-user-token fixture-secret');
    if (url === 'https://id.twitch.tv/oauth2/validate') {
      if (request.headers.Authorization === 'OAuth fixture-user-token' && config.validationStatus !== 200) return json({}, config.validationStatus);
      return json({ client_id: config.client, user_id: config.user, scopes: config.scopes, expires_in: config.expiresIn ?? 3600 });
    }
    if (url === 'https://id.twitch.tv/oauth2/token') {
      assert.equal(request.method, 'POST'); assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(request.body.get('client_id'), 'fixture-client'); assert.equal(request.body.get('client_secret'), 'fixture-secret');
      if (request.body.get('grant_type') === 'refresh_token') {
        if (config.refreshStatus !== 200) return json({}, config.refreshStatus);
        assert.equal(request.body.get('refresh_token'), 'fixture-refresh-token');
        return json({ access_token: 'fixture-rotated-user', refresh_token: 'fixture-rotated-refresh', expires_in: 3600, token_type: 'bearer', scope: REQUIRED });
      }
      assert.equal(request.body.get('grant_type'), 'client_credentials');
      return json({ access_token: 'fixture-app-token', token_type: 'bearer', expires_in: 3600 });
    }
    const endpoint = new URL(url); assert.equal(endpoint.origin + endpoint.pathname, 'https://api.twitch.tv/helix/eventsub/subscriptions');
    assert.equal(request.headers.Authorization, 'Bearer fixture-app-token');
    assert.equal(request.headers['Client-Id'], 'fixture-client');
    if (request.method === 'GET') {
      if (config.listStatus) return json({}, config.listStatus);
      return json({ data: remote, pagination: {} });
    }
    if (request.method === 'DELETE') { remote = remote.filter(sub => sub.id !== endpoint.searchParams.get('id')); return new Response(null, { status: 204 }); }
    assert.equal(request.method, 'POST');
    const body = JSON.parse(request.body); created = { id: 'subscription-fixture', status: 'webhook_callback_verification_pending', ...body };
    const pending = storage.transaction(() => storage.read('chat-state.json').registration);
    assert.equal(pending.secret, body.transport.secret); assert.equal(pending.apiConfirmed, false);
    assert.equal(body.condition.broadcaster_user_id, '123'); assert.equal(body.condition.user_id, '123');
    assert.equal(body.transport.callback, CALLBACK);
    if (config.registrationStatus !== 202) return json({}, config.registrationStatus);
    if (config.challenge) {
      const result = config.challengeHttp ? await config.challengeHttp(signed(created, 'webhook_callback_verification', { challenge: 'fixture-challenge' }))
        : chat.receive(signed(created, 'webhook_callback_verification', { challenge: 'fixture-challenge' }));
      assert.equal(result.status, 200); assert.equal(result.body, 'fixture-challenge');
    }
    remote = [{ ...created, status: config.challenge ? 'enabled' : 'webhook_callback_verification_pending' }];
    return json({ data: [created] }, 202);
  }
  const client = new TwitchClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', fetchImpl });
  const tokens = new TwitchTokens({ client, storage, credentialsFile, broadcasterId: '123', readerId: '123', now });
  function makeChat() { return new TwitchChat({ client, tokens, storage, broadcasterId: '123', readerId: '123', now, publish: event => published.push(event), refreshEnabled: !!options.refreshEnabled }); }
  chat = makeChat();
  function signed(sub, type = 'notification', extra = {}, headerOverrides = {}) {
    const record = storage.transaction(() => storage.read('chat-state.json').registration);
    const rawBody = Buffer.from(JSON.stringify({ subscription: sub, ...extra }));
    const headers = { 'twitch-eventsub-message-id': crypto.randomUUID(), 'twitch-eventsub-message-timestamp': new Date(time).toISOString(), 'twitch-eventsub-message-type': type, ...headerOverrides };
    headers['twitch-eventsub-message-signature'] = 'sha256=' + crypto.createHmac('sha256', record.secret).update(headers['twitch-eventsub-message-id']).update(headers['twitch-eventsub-message-timestamp']).update(rawBody).digest('hex');
    return { rawBody, headers };
  }
  function message(text = '!ocean', messageId = 'message-fixture', overrides = {}, headers) {
    const sub = { ...created, status: 'enabled' };
    return signed(sub, 'notification', { event: { broadcaster_user_id: '123', chatter_user_id: '456', message_id: messageId, message: { text }, ...overrides } }, headers);
  }
  return { root, storage, client, tokens, chat, calls, config, published, credentialsFile, original, now, signed, message, makeChat,
    sub: () => created, remote: () => remote, setRemote: value => { remote = value; }, advance: ms => { time += ms; },
    async ready() { await chat.register(); assert.equal(chat.health().twitchConnected, false); await chat.reconcile(); assert.equal(chat.health().twitchConnected, true); } };
}

test('registration persists pending intent before a signed challenge arriving before API response', async t => {
  const f = fixture(t); await f.ready();
  const record = f.storage.transaction(() => f.storage.read('chat-state.json').registration);
  assert.equal(record.apiConfirmed, true); assert.equal(record.challenged, true); assert.equal(record.id, f.sub().id);
  assert.equal(f.chat.health().twitchSubscriptionStatus, 'enabled');
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
  assert.equal(fs.statSync(f.storage.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.storage.directory, 'chat-state.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(f.chat.health()).includes(record.secret));
  await f.chat.register(); assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.includes('/helix/')).length, 1);
});

test('commands publish safe participation only, with durable logical/delivery and unique-participant deduplication', async t => {
  const f = fixture(t); await f.ready();
  const command = f.message(' !OcEaN '); assert.equal(f.chat.receive(command).status, 204);
  assert.equal(f.chat.receive(command).status, 204);
  assert.equal(f.chat.receive(f.message('!ocean')).status, 204); // new delivery, same logical message
  f.chat.receive(f.message('hello <script>secret</script>', 'ordinary'));
  f.chat.receive(f.message('!ocean now', 'extra-words'));
  f.chat.receive(f.message('!ocean', 'second'));
  f.chat.receive(f.message('!ocean', 'third', { chatter_user_id: '789' }));
  assert.equal(f.published.length, 3);
  assert.deepEqual(f.chat.snapshot(), { commands: 3, uniqueParticipants: 2, lastEventAt: f.now() });
  assert.ok(f.published.every(event => event.type === 'twitch_participation' && event.verified && event.simulated === false));
  assert.doesNotMatch(JSON.stringify(f.published), /fixture-user-token|fixture-secret|chatter_user_id|"456"|"789"|<script|rewardUnits|address/);
  const restarted = f.makeChat(); assert.equal(restarted.health().twitchConnected, false);
  await restarted.reconcile(); assert.equal(restarted.health().twitchConnected, true);
  assert.equal(restarted.receive(command).status, 204); assert.equal(restarted.snapshot().commands, 3);
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
});

test('strict HMAC, freshness, reader, channel, transport and subscription checks remain enforced', async t => {
  const f = fixture(t); await f.ready();
  const valid = f.message();
  const badSignature = { ...valid, headers: { ...valid.headers, 'twitch-eventsub-message-signature': 'sha256=' + '0'.repeat(64) } };
  const tampered = { ...valid, rawBody: Buffer.from('{}') };
  for (const request of [badSignature, tampered,
    f.message('!ocean', 'a', {}, { 'twitch-eventsub-message-timestamp': new Date(f.now() - 300001).toISOString() }),
    f.message('!ocean', 'b', {}, { 'twitch-eventsub-message-timestamp': new Date(f.now() + 300001).toISOString() }),
    f.message('!ocean', 'c', { source_broadcaster_user_id: '999' }),
    f.message('!ocean', 'd', { broadcaster_user_id: '999' })]) assert.throws(() => f.chat.receive(request), TwitchFault);
  for (const sub of [{ ...f.sub(), id: 'unknown' }, { ...f.sub(), condition: { broadcaster_user_id: '123', user_id: '999' } },
    { ...f.sub(), transport: { method: 'websocket' } }, { ...f.sub(), type: 'channel.follow' }]) {
    assert.throws(() => f.chat.receive(f.signed(sub, 'notification', { event: {} })), TwitchFault);
  }
  assert.deepEqual(f.chat.snapshot(), { commands: 0, uniqueParticipants: 0, lastEventAt: null });
});

test('pending registration, failed create and challenge expiry cannot authorize notifications', async t => {
  const f = fixture(t, { challenge: false }); await f.chat.register();
  assert.equal(f.chat.health().twitchSubscriptionStatus, 'pending');
  assert.throws(() => f.chat.receive(f.message()), TwitchFault);
  f.advance(300001);
  assert.throws(() => f.chat.receive(f.signed(f.sub(), 'webhook_callback_verification', { challenge: 'fixture-challenge' })), TwitchFault);
  assert.equal(f.chat.health().twitchSubscriptionStatus, 'registration_expired');
  const g = fixture(t, { registrationStatus: 503 });
  await assert.rejects(g.chat.register(), { category: 'provider_unavailable' });
  await assert.rejects(g.chat.register(), { category: 'pending_registration_requires_review' });
  assert.equal(g.calls.filter(call => call.method === 'POST' && call.url.includes('/helix/')).length, 1);
});

test('signed revocation is durable, replay-safe and cannot be reversed by delayed reconciliation', async t => {
  const f = fixture(t); await f.ready();
  const revoke = f.signed({ ...f.sub(), status: 'authorization_revoked' }, 'revocation');
  assert.equal(f.chat.receive(revoke).status, 204); assert.equal(f.chat.receive(revoke).status, 204);
  await f.chat.reconcile(); assert.equal(f.chat.health().twitchSubscriptionStatus, 'revoked');
  assert.equal(f.chat.health().twitchConnected, false);
  assert.throws(() => f.chat.receive(f.message()), TwitchFault);
  assert.equal(f.published.length, 1); assert.equal(f.published[0].type, 'twitch_revoked');
  assert.equal(f.makeChat().health().twitchSubscriptionStatus, 'revoked');
});

test('preflight reports missing permissions and rejects mismatched identities without overwriting credentials', async t => {
  for (const options of [{ scopes: [] }, { user: '999' }, { client: 'wrong-client' }, { expiresIn: 0 }]) {
    const f = fixture(t, options);
    await assert.rejects(f.tokens.check(), { category: options.scopes ? 'missing_permissions' : options.expiresIn === 0 ? 'invalid_response' : 'identity_mismatch' });
    if (options.scopes) assert.deepEqual(f.tokens.health().missingPermissions, REQUIRED);
    assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(f.chat.health().twitchConnected, false);
  }
});

test('refresh is explicit, serialized and private; original OAuth credentials stay unchanged', async t => {
  const f = fixture(t, { validationStatus: 401 });
  await assert.rejects(f.tokens.check(), { category: 'credentials_rejected' });
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 0);
  const results = await Promise.all(Array.from({ length: 10 }, () => f.tokens.check({ refresh: true })));
  assert.ok(results.every(result => result.status === 'valid'));
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
  const rotatedFile = path.join(f.storage.directory, 'user-session.json'); assert.equal(fs.statSync(rotatedFile).mode & 0o777, 0o600);
  const next = new TwitchTokens({ client: f.client, storage: f.storage, broadcasterId: '123', readerId: '123', credentialsFile: f.credentialsFile, now: f.now });
  await next.check(); assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.doesNotMatch(JSON.stringify(f.chat.health()), /fixture-rotated|fixture-user-token|fixture-secret/);
});

test('failed refresh, transient provider failure and expired validation fail closed', async t => {
  const f = fixture(t, { validationStatus: 401, refreshStatus: 400 });
  await assert.rejects(f.tokens.check({ refresh: true }), { category: 'request_rejected' });
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
  const g = fixture(t); await g.ready(); g.config.transportError = true;
  await assert.rejects(g.chat.reconcile(), { category: 'transport_failure' });
  assert.equal(g.chat.health().twitchConnected, false);
  assert.throws(() => g.chat.receive(g.message()), { category: 'credentials_not_validated' });
  g.config.transportError = false; await g.chat.reconcile(); assert.equal(g.chat.health().twitchConnected, true);
  g.advance(3600001); assert.equal(g.tokens.health().status, 'expired'); assert.equal(g.chat.health().twitchConnected, false);
});

test('private storage rejects permissive files, symlinks and concurrent refresh ownership', async t => {
  const f = fixture(t); fs.chmodSync(f.credentialsFile, 0o644);
  await assert.rejects(f.tokens.check(), { category: 'credentials_unavailable' });
  fs.chmodSync(f.credentialsFile, 0o600);
  const release = f.storage.lease('tokens');
  await assert.rejects(f.tokens.check(), { category: 'storage_busy' }); release();
  fs.renameSync(f.credentialsFile, f.credentialsFile + '.real'); fs.symlinkSync(f.credentialsFile + '.real', f.credentialsFile);
  await assert.rejects(f.tokens.check(), { category: 'credentials_unavailable' });
});

test('operator commands reject noninteractive mutations and cancellation without provider calls', async t => {
  const f = fixture(t); let output = '';
  for (const command of ['register', 'remove', 'refresh']) {
    await assert.rejects(run({ args: [command], chat: f.chat, input: { isTTY: false }, output: { isTTY: false } }), { category: 'private_terminal_required' });
    await assert.rejects(run({ args: [command], chat: f.chat, input: { isTTY: true }, output: { isTTY: true }, confirm: async () => 'no' }), { category: 'operation_cancelled' });
  }
  assert.equal(f.calls.length, 0);
  await run({ args: ['register'], chat: f.chat, input: { isTTY: true }, output: { isTTY: true, write: data => { output += data; } }, confirm: async () => 'REGISTER' });
  assert.doesNotMatch(output, /fixture-secret|fixture-app-token|fixture-user-token|subscription-fixture|123/);
  await f.chat.reconcile(); await f.chat.remove(); assert.equal(f.remote().length, 0);
  assert.equal(f.chat.health().twitchSubscriptionStatus, 'revoked');
});

test('chat activation requires explicit payment kill switch and matching broadcaster/reader identity', () => {
  for (const env of [{}, { AGRO_REAL_PAYMENTS_ENABLED: 'true' }]) assert.throws(() => createTwitchChat({ env }), { category: 'payments_must_be_disabled' });
  assert.throws(() => createTwitchChat({ env: { AGRO_REAL_PAYMENTS_ENABLED: 'false', TWITCH_BROADCASTER_ID: '123', TWITCH_CHAT_READER_ID: '999' } }), { category: 'reader_must_be_broadcaster' });
});

test('mocked HTTP registration challenge, concurrent webhook retries and SSE snapshot recovery', async t => {
  const f = fixture(t); const emitted = f.published;
  const { createBridge } = require('../src/server');
  const server = createBridge({ env: { TWITCH_EVENTS_ENABLED: 'true', AGRO_REAL_PAYMENTS_ENABLED: 'false' },
    twitchFactory: ({ publish }) => {
      f.chat.publish = event => { emitted.push(event); publish(event); };
      return f.chat;
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { f.chat.stop(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async request => {
    const response = await fetch(base + '/twitch/eventsub', { method: 'POST', headers: request.headers, body: request.rawBody });
    return { status: response.status, body: await response.text() };
  };
  f.config.challengeHttp = send;
  await f.chat.maintain();
  await f.ready();
  const stream = await fetch(base + '/events'); const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"commands":0/);
  const request = f.message(); const replies = await Promise.all(Array.from({ length: 10 }, () => send(request)));
  assert.ok(replies.every(response => response.status === 204)); assert.equal(emitted.filter(event => event.type === 'twitch_participation').length, 1);
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /twitch_participation/); assert.match(event, /"commands":1/);
  assert.doesNotMatch(event, /fixture-user-token|fixture-secret|fixture-refresh-token/);
  const health = await (await fetch(base + '/health')).json(); assert.equal(health.realPaymentsEnabled, false); assert.equal(health.twitchConnected, true);
  const bad = { ...request, headers: { ...request.headers, 'twitch-eventsub-message-signature': 'bad' } };
  assert.equal((await send(bad)).status, 403);
  assert.equal((await fetch(base + '/twitch/eventsub')).status, 405);
  await reader.cancel();
  const restart = f.makeChat(); assert.equal(restart.snapshot().commands, 1); assert.equal(restart.health().twitchConnected, false);
  const release = f.storage.lease('state');
  assert.equal((await fetch(base + '/events')).status, 503); release();
});

test('refresh ambiguity is persisted and never blindly retried after a failed provider request', async t => {
  const f = fixture(t, { validationStatus: 401, refreshStatus: 503 });
  await assert.rejects(f.tokens.check({ refresh: true }), { category: 'provider_unavailable' });
  await assert.rejects(f.tokens.check({ refresh: true }), { category: 'refresh_requires_review' });
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
});

test('new OAuth authorization invalidates the separate refreshed session without overwriting either source', async t => {
  const f = fixture(t, { validationStatus: 401 }); await f.tokens.check({ refresh: true });
  const changed = JSON.stringify({ access_token: 'fixture-new-authorization', refresh_token: 'fixture-new-refresh', scope: REQUIRED });
  fs.writeFileSync(f.credentialsFile, changed, { mode: 0o600 });
  const loaded = f.tokens.source(); assert.equal(loaded.credentials.access_token, 'fixture-new-authorization');
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), changed);
});

test('registration identity mismatch cannot substitute an ID learned from the signed challenge', async t => {
  const f = fixture(t);
  const original = f.client.subscriptions.bind(f.client);
  f.client.subscriptions = async (...args) => {
    const response = await original(...args);
    if (args[0] === 'POST') response.data[0].id = 'substituted-id';
    return response;
  };
  await assert.rejects(f.chat.register(), { category: 'subscription_identity_mismatch' });
  const record = f.storage.transaction(() => f.storage.read('chat-state.json').registration);
  assert.equal(record.id, 'subscription-fixture'); assert.equal(record.apiConfirmed, false);
  assert.throws(() => f.chat.receive(f.message()), { category: 'unapproved_subscription' });
});

test('wrong signed challenge and conflicting replay bodies cannot change established identity or counters', async t => {
  const f = fixture(t); await f.ready();
  assert.throws(() => f.chat.receive(f.signed(f.sub(), 'webhook_callback_verification', { challenge: 'changed-challenge' })), { category: 'challenge_mismatch' });
  const first = f.message(); f.chat.receive(first);
  const conflict = f.message('!ocean', 'different', {}, { 'twitch-eventsub-message-id': first.headers['twitch-eventsub-message-id'] });
  assert.throws(() => f.chat.receive(conflict), { category: 'replay_mismatch' });
  assert.equal(f.chat.snapshot().commands, 1);
});

test('subscription registration does not adopt an unmanaged remote callback or delete unrelated subscriptions', async t => {
  const f = fixture(t);
  const other = { id: 'unmanaged', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '123', user_id: '123' }, transport: { method: 'webhook', callback: CALLBACK }, status: 'enabled' };
  f.setRemote([other]); await assert.rejects(f.chat.register(), { category: 'existing_subscription_requires_review' });
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.includes('/helix/')).length, 0);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
});

test('app-token expiration retries only a GET observation and all provider errors stay sanitized', async t => {
  let minted = 0, reads = 0;
  const client = new TwitchClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', fetchImpl: async (url, request) => {
    if (url.endsWith('/token')) { minted++; return json({ access_token: 'fixture-app-token', token_type: 'bearer' }); }
    reads++; return reads === 1 ? json({ message: 'fixture-secret' }, 401) : json({ data: [], pagination: {} });
  } });
  assert.deepEqual(await client.list(), []); assert.equal(minted, 2); assert.equal(reads, 2);
  const rejected = new TwitchClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', fetchImpl: async (url) => url.endsWith('/token') ? json({ access_token: 'fixture-app-token', token_type: 'bearer' }) : json({ message: 'fixture-secret fixture-app-token' }, 503) });
  await assert.rejects(rejected.list(), error => error.category === 'provider_unavailable' && !error.message.includes('fixture-'));
});

test('maintenance is coalesced, refresh is opt-in, storage contention and revocation stay recoverable', async t => {
  const f = fixture(t); await f.ready();
  const before = f.calls.length;
  await Promise.all([f.chat.maintain(), f.chat.maintain()]);
  assert.equal(f.calls.length - before, 2); // one validation and one subscription list
  const release = f.storage.lease('state');
  const health = await f.chat.maintain(); assert.equal(health.twitchConnected, false); release();
  await f.chat.maintain(); assert.equal(f.chat.health().twitchConnected, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1); // app token only
});

test('Twitch-only integration has no financial adapter dependencies and never changes reward state', async t => {
  const f = fixture(t); const rewardFile = path.join(f.root, 'existing-rewards.json');
  const before = '{"amount_agro":"0.1","status":"untouched"}'; fs.writeFileSync(rewardFile, before);
  for (const name of ['twitch-chat.js', 'twitch-client.js', 'twitch-storage.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
    assert.doesNotMatch(source, /require\(['"]\.\/integration|\.reward\(|requestReward|ensureRecord|sendtoaddress|agrocoin-api/);
  }
  await f.ready(); f.chat.receive(f.message()); f.chat.receive(f.message());
  f.chat.receive(f.signed({ ...f.sub(), status: 'authorization_revoked' }, 'revocation'));
  assert.equal(fs.readFileSync(rewardFile, 'utf8'), before);
  assert.ok(f.calls.every(call => new URL(call.url).hostname === 'id.twitch.tv' || new URL(call.url).hostname === 'api.twitch.tv'));
});

test('challenge after the create response is accepted only for the pinned subscription', async t => {
  const f = fixture(t, { challenge: false }); await f.chat.register();
  const challenge = f.signed(f.sub(), 'webhook_callback_verification', { challenge: 'late-challenge' });
  assert.equal(f.chat.receive(challenge).status, 200); assert.equal(f.chat.receive(challenge).status, 200);
  f.setRemote([{ ...f.sub(), status: 'enabled' }]); await f.chat.reconcile();
  assert.equal(f.chat.health().twitchConnected, true);
});

test('rotation survives a validation outage after the replacement tokens have been received', async t => {
  const f = fixture(t, { validationStatus: 401 });
  const validate = f.client.validate.bind(f.client);
  f.client.validate = token => token === 'fixture-rotated-user' ? Promise.reject(new TwitchFault('transport_failure')) : validate(token);
  await assert.rejects(f.tokens.check({ refresh: true }), { category: 'transport_failure' });
  assert.equal(f.tokens.source().credentials.access_token, 'fixture-rotated-user');
  assert.equal(fs.readFileSync(f.credentialsFile, 'utf8'), f.original);
  f.client.validate = validate; await f.tokens.check({ refresh: true });
  assert.equal(f.calls.filter(call => call.url.endsWith('/token')).length, 1);
});

test('capacity bounds, malformed bodies and corrupt private records fail closed without counter changes', async t => {
  const f = fixture(t); await f.ready();
  assert.throws(() => f.chat.receive({ headers: {}, rawBody: Buffer.alloc(16385) }), TwitchFault);
  const before = f.chat.snapshot();
  f.storage.transaction(() => {
    const state = f.storage.read('chat-state.json');
    state.commands = Number.MAX_SAFE_INTEGER; f.storage.write('chat-state.json', state);
  });
  assert.throws(() => f.chat.receive(f.message()), { category: 'chat_capacity' });
  assert.equal(f.chat.snapshot().commands, Number.MAX_SAFE_INTEGER); assert.equal(f.published.length, 0);
  f.storage.transaction(() => { const state = f.storage.read('chat-state.json'); state.commands = before.commands; f.storage.write('chat-state.json', state); });
  assert.equal(f.chat.receive(f.message()).status, 204);
  const file = path.join(f.storage.directory, 'chat-state.json'); fs.chmodSync(file, 0o644);
  assert.equal(f.chat.health().twitchConnected, false); assert.equal(f.chat.health().twitchSubscriptionStatus, 'storage_unavailable');
});

test('separate process delivery persists one counter update and the original process deduplicates it', async t => {
  const { spawnSync } = require('node:child_process');
  const f = fixture(t); await f.ready(); const request = f.message();
  const input = path.join(f.root, 'signed-fixture.json');
  fs.writeFileSync(input, JSON.stringify({ headers: request.headers, body: request.rawBody.toString('base64'), now: f.now(), directory: f.storage.directory }), { mode: 0o600 });
  const script = `const fs=require('node:fs'); const {TwitchChat}=require('./src/twitch-chat'); const {TwitchStorage}=require('./src/twitch-storage'); const data=JSON.parse(fs.readFileSync(process.argv[1])); const chat=new TwitchChat({client:{},tokens:{health:()=>({status:'valid',missingPermissions:[]})},storage:new TwitchStorage(data.directory),broadcasterId:'123',readerId:'123',now:()=>data.now}); chat.receive({headers:data.headers,rawBody:Buffer.from(data.body,'base64')}); process.stdout.write(String(chat.snapshot().commands));`;
  const child = spawnSync(process.execPath, ['-e', script, input], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.ifError(child.error); assert.equal(child.status, 0); assert.equal(child.stdout, '1');
  assert.equal(f.chat.receive(request).status, 204); assert.equal(f.chat.snapshot().commands, 1); assert.equal(f.published.length, 0);
});

test('overlay consumes live snapshots without mixing simulation counts or exposing raw chat', () => {
  const vm = require('node:vm');
  const elements = new Map();
  function element() { return { textContent: '', children: [], prepend(value) { this.children.unshift(value); }, append(value) { this.children.push(value); }, replaceChildren() { this.children = []; } }; }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
  let source;
  const EventSource = function (url) { assert.equal(url, '/events'); source = this; };
  const html = fs.readFileSync(path.join(__dirname, '../public/overlay.html'), 'utf8');
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document, EventSource });
  source.onmessage({ data: JSON.stringify({ type: 'snapshot', stats: { participants: 99 }, liveTwitch: { commands: 3, uniqueParticipants: 2 }, twitchStatus: { twitchConnected: true, twitchSubscriptionStatus: 'enabled' } }) });
  assert.equal(elements.get('participants').textContent, 99); assert.equal(elements.get('liveCommands').textContent, 3);
  assert.equal(elements.get('liveParticipants').textContent, 2); assert.match(elements.get('twitchStatus').textContent, /Ready for chat/);
  source.onmessage({ data: JSON.stringify({ type: 'ocean_participant', username: 'demo', simulated: true, stats: { participants: 100 } }) });
  assert.equal(elements.get('liveCommands').textContent, 3);
  source.onmessage({ data: JSON.stringify({ type: 'twitch_participation', liveTwitch: { commands: 4, uniqueParticipants: 2 } }) });
  assert.equal(elements.get('liveCommands').textContent, 4); assert.match(elements.get('activity').children[0].textContent, /no payout/);
  source.onmessage({ data: JSON.stringify({ type: 'twitch_revoked' }) });
  assert.equal(elements.get('twitchStatus').textContent, 'Twitch subscription revoked');
});
