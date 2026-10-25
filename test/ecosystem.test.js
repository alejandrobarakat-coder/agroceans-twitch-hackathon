'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AgroExplorerClient, MatrixReportsClient, EcosystemReader, TwitchWebhook, JsonApi } = require('../src/ecosystem');
const txid = 'a'.repeat(64), blockhash = 'b'.repeat(64);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('explorer retrieves genuine-format summary and raw transaction, preserving conflicts', async () => {
  const calls = [];
  const api = new AgroExplorerClient('https://example.test/', async (url, options) => {
    calls.push([url.pathname, options]);
    return json(url.pathname === '/ext/summary' ? { data: [{ blockcount: 42 }] } : { txid, confirmations: 6, blockhash, vout: [] });
  });
  assert.equal((await api.summary()).blockHeight, 42);
  assert.equal((await api.transaction(txid)).status, 'confirmed');
  assert.ok(calls.every(([,o]) => o.redirect === 'error' && !o.body && !o.headers.Authorization));
  await assert.rejects(api.transaction('../wallet'), /transaction ID/);
  const conflict = new AgroExplorerClient('https://example.test/', async () => json({ txid, vout: [], confirmations: -1 }));
  assert.equal((await conflict.transaction(txid)).status, 'conflicted');
});
test('transaction identity mismatch and confirmations without block rejected', async () => {
  const api = new AgroExplorerClient('https://example.test/', async () => json({ txid: blockhash, confirmations: 5, vout: [] }));
  await assert.rejects(api.transaction(txid), /binding/);
  api.api.fetcher = async () => json({ txid, confirmations: 5, vout: [] });
  await assert.rejects(api.transaction(txid), /block hash/);
});
test('Matrix tracking exposes consented status only, never assumes approval or ownership', async () => {
  const api = new MatrixReportsClient('https://example.test/', 'test-session', async (url, options) => {
    assert.equal(url.searchParams.get('r'), 'agro_impact/report/tracking');
    assert.equal(options.headers.Cookie, 'test-session');
    return json({ ok: true, reports: [{ folio: 'allowed', title: 'private title', photos: ['private'], stamp: { status: 'confirmed', txid, receiver: 'private-address', reward: { amount_agro: '0.1', txid, status: 'confirmed', destination: 'private-address' } } }, { folio: 'not-consented' }] });
  });
  const rows = await api.tracking(['allowed']);
  assert.equal(rows.length, 1); assert.equal(rows[0].approval, 'not exposed by tracking API');
  assert.equal(rows[0].reward.amountAgro, '0.1'); assert.ok(!JSON.stringify(rows).includes('private'));
});
test('HTTP client rejects login HTML, failures, non-HTTPS and oversized bodies', async () => {
  assert.throws(() => new JsonApi('http://example.test/'), /HTTPS/);
  const api = new JsonApi('https://example.test/', async () => new Response('<html>login</html>'));
  await assert.rejects(api.get('tracking'), /authentication/);
  api.fetcher = async () => json({ error: 'NO' });
  await assert.rejects(api.get('tracking'), /Invalid/);
  api.fetcher = async () => json({ data: 'x'.repeat(2000000) });
  await assert.rejects(api.get('tracking'), /too large/);
});
test('reader retains independent successes and reports unavailable services', async () => {
  const reader = new EcosystemReader({ explorer: { summary: async () => ({ blockHeight: 42 }), transaction: async () => { throw Error(); } }, reports: { tracking: async () => { throw Error(); } }, folios: ['a'], transactionIds: [txid] });
  const snapshot = await reader.refresh();
  assert.equal(snapshot.chain.blockHeight, 42); assert.equal(snapshot.errors.length, 2); assert.equal(snapshot.simulated, false);
});
function event(secret, body, overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const headers = { 'twitch-eventsub-message-id': 'opaque/event/id', 'twitch-eventsub-message-timestamp': new Date().toISOString(), 'twitch-eventsub-message-type': 'notification', ...overrides };
  headers['twitch-eventsub-message-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(headers['twitch-eventsub-message-id']).update(headers['twitch-eventsub-message-timestamp']).update(rawBody).digest('hex');
  return { headers, rawBody };
}
test('Twitch authenticates raw bytes, broadcaster and subscription; handles challenges', () => {
  const secret = 's'.repeat(64);
  const api = new TwitchWebhook({ secret, broadcasterId: '123', subscriptionIds: ['sub'] });
  const payload = { subscription: { id: 'sub', type: 'channel.chat.message', version: '1', status: 'enabled', condition: { broadcaster_user_id: '123' } }, event: { broadcaster_user_id: '123', chatter_user_id: '456' } };
  assert.equal(api.verify(event(secret, payload)).twitchId, '456');
  const forged = event(secret, payload); forged.rawBody = Buffer.from('{}');
  assert.throws(() => api.verify(forged), /signature/);
  assert.throws(() => api.verify(event(secret, { ...payload, subscription: { ...payload.subscription, id: 'unapproved' } })), /subscription/);
  assert.throws(() => api.verify(event(secret, payload, { 'twitch-eventsub-message-timestamp': new Date(0).toISOString() })), /timestamp/);
  assert.equal(api.verify(event(secret, { ...payload, challenge: 'challenge' }, { 'twitch-eventsub-message-type': 'webhook_callback_verification' })).challenge, 'challenge');
});
