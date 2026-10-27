'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBridge } = require('../src/server');
const { PublicMatrixReportsClient, PlanetReports } = require('../src/planet-reports');
const token = 'fixture-operator-token-32-characters-minimum';
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '../var-planet-http-'));
  let store, broadcast, calls = 0;
  const raw = { login: false, published: true, reports: [{ folio: 'impact:public', title: 'PRIVATE_TITLE',
    stamp: { status: 'pending', reference: 'stamp:existing', receiver: 'PRIVATE_ADDRESS', reward: { amount_agro: '0.1' } } }] };
  const client = new PublicMatrixReportsClient({ base: 'https://matrix.example.test/', cookie: 'PRIVATE_SESSION', fetchImpl: async (url, request) => {
    calls++; assert.equal(request.method || 'GET', 'GET');
    if (url.searchParams.get('r') === 'post/post/view') {
      assert.equal(request.headers.Cookie, undefined);
      return new Response(raw.published ? '<article>AgroCeans reference: impact:public</article>' : '<html>Login</html>', { headers: { 'content-type': 'text/html' } });
    }
    return raw.login ? new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }) :
      new Response(JSON.stringify({ ok: true, reports: raw.reports }), { headers: { 'content-type': 'application/json' } });
  } });
  const counts = { commands: 0, uniqueParticipants: 0, lastEventAt: null };
  const realFetch = global.fetch;
  if (options.explorer) global.fetch = async (url, request) => new URL(url).hostname === 'explorer.example.test' ?
    new Response(JSON.stringify({ data: [{ blockcount: 100 }] }), { headers: { 'content-type': 'application/json' } }) : realFetch(url, request);
  let server;
  try {
    server = createBridge({ env: { AGRO_OPERATOR_TOKEN: token, TWITCH_EVENTS_ENABLED: 'true', AGRO_REAL_PAYMENTS_ENABLED: 'false',
      ...(options.explorer ? { AGRO_EXPLORER_URL: 'https://explorer.example.test/' } : {}) },
      planetReportsFactory: ({ publish }) => {
        store = new PlanetReports({ directory: path.join(root, 'planet'), policy: { version: 1, reports: [{ folio: 'impact:public', postId: '8' }] }, client, publish }); return store;
      },
      twitchFactory: ({ publish }) => {
        broadcast = publish;
        return { start() {}, stop() {}, snapshot: () => counts, health: () => ({ twitchConnected: true, twitchSubscriptionStatus: 'enabled' }) };
      } });
  } finally { global.fetch = realFetch; }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port, controllers = [];
  t.after(async () => {
    controllers.forEach(controller => controller.abort()); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  });
  async function events(route) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(base + route, { signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    return { async next() {
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary !== -1) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) return { name: frame.split('\n').find(line => line.startsWith('event: '))?.slice(7), data: JSON.parse(data.slice(6)) };
            continue;
          }
          const part = await reader.read(); if (part.done) throw Error('SSE ended'); buffer += decoder.decode(part.value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    } };
  }
  const refresh = (route = '/planet/refresh', auth = token, body) => fetch(base + route, {
    method: 'POST', headers: auth ? { Authorization: 'Bearer ' + auth } : {}, ...(body === undefined ? {} : { body }) });
  function ocean() { counts.commands++; counts.uniqueParticipants = 1; broadcast({ type: 'twitch_participation', domain: 'planet', command: '!ocean', verified: true, simulated: false, liveTwitch: counts }); }
  return { base, store, raw, events, refresh, ocean, broadcast: event => broadcast(event), calls: () => calls };
}

test('refresh is operator-authorized and accepts no client-supplied reports', async t => {
  const f = await fixture(t);
  assert.equal((await f.refresh('/planet/refresh', null)).status, 403);
  assert.equal((await f.refresh('/planet/refresh', 'wrong')).status, 403);
  assert.equal((await fetch(f.base + '/planet/refresh')).status, 405);
  assert.equal((await f.refresh('/planet/refresh', token, '{"reports":[]}')).status, 400);
  assert.equal(f.calls(), 0);
  assert.equal((await fetch(f.base + '/planet/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await f.refresh()).status, 200);
  const response = await fetch(f.base + '/planet/snapshot?folio=private');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = await response.json(); assert.equal(snapshot.reports.length, 1);
  assert.equal(snapshot.reports[0].stamp.reference, 'stamp:existing');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|reward|receiver|title/);
});

test('Planet SSE deduplicates reports, reconnects to snapshots and preserves ocean participation', async t => {
  const f = await fixture(t); const stream = await f.events('/planet/events');
  assert.equal((await stream.next()).data.reports.length, 0);
  assert.equal((await f.refresh()).status, 200);
  assert.equal((await stream.next()).name, 'snapshot');
  const event = await stream.next(); assert.equal(event.name, 'report'); assert.match(event.data.eventId, /^[a-f0-9]{64}$/);
  assert.equal((await f.refresh()).status, 200); f.ocean();
  const participation = await stream.next(); assert.equal(participation.name, 'participation'); assert.equal(participation.data.liveTwitch.commands, 1);
  const reconnect = await f.events('/planet/events'); const current = await reconnect.next();
  assert.equal(current.name, 'snapshot'); assert.equal(current.data.reports.length, 1); assert.equal(current.data.liveTwitch.commands, 1);
});

test('chess, planet and legacy streams remain isolated and do not carry financial records', async t => {
  const f = await fixture(t); const planet = await f.events('/planet/events'), chess = await f.events('/chess/events'), legacy = await f.events('/events');
  await planet.next(); await chess.next(); await legacy.next();
  f.broadcast({ type: 'chess.move', domain: 'chess', simulated: false });
  f.broadcast({ type: 'reward', actionId: 'FINANCIAL_RECORD' });
  f.ocean();
  const p = await planet.next(); assert.equal(p.name, 'participation'); assert.doesNotMatch(JSON.stringify(p), /chess|FINANCIAL/);
  f.broadcast({ type: 'twitch_status' }); assert.equal((await chess.next()).name, 'status');
  await f.refresh(); assert.equal((await planet.next()).name, 'status');
  assert.equal((await planet.next()).name, 'snapshot'); assert.equal((await planet.next()).name, 'report');
  const marker = await f.events('/chess/events'); assert.equal((await marker.next()).data.match, null);
});

test('failed public revalidation hides both Planet and legacy cached report snapshots', async t => {
  const f = await fixture(t, { explorer: true });
  const integration = await f.refresh('/integration/refresh'); assert.equal(integration.status, 200);
  const data = await integration.json(); assert.equal(data.reports.length, 1); assert.equal(data.chain.blockHeight, 100);
  f.raw.published = false; assert.equal((await f.refresh()).status, 502);
  const planet = await (await fetch(f.base + '/planet/snapshot')).json(); assert.deepEqual(planet.reports, []); assert.equal(planet.status, 'unavailable');
  const legacy = await f.events('/events'); assert.deepEqual((await legacy.next()).data.ecosystem.reports, []);
});

test('read-only report paths never invoke issuance, wallet, STAMP or payment adapters', async t => {
  const f = await fixture(t); let calls = 0; const restore = [];
  for (const Class of Object.values(require('../src/integration'))) {
    for (const name of Object.getOwnPropertyNames(Class.prototype).filter(name => name !== 'constructor')) {
      const original = Class.prototype[name]; Class.prototype[name] = () => { calls++; throw Error('financial tripwire'); };
      restore.push(() => { Class.prototype[name] = original; });
    }
  }
  try {
    assert.equal((await f.refresh()).status, 200);
    assert.equal((await f.refresh()).status, 200); f.ocean();
    assert.equal((await fetch(f.base + '/planet/snapshot')).status, 200);
    f.raw.login = true; assert.equal((await f.refresh()).status, 502);
    assert.equal(calls, 0);
  } finally { restore.forEach(fn => fn()); }
});

test('default Planet routes expose no reports and cannot trigger upstream reads', async t => {
  const server = createBridge({ env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const snapshot = await (await fetch(base + '/planet/snapshot')).json();
  assert.equal(snapshot.enabled, false); assert.deepEqual(snapshot.reports, []);
  assert.equal((await fetch(base + '/planet/refresh', { method: 'POST' })).status, 403);
});
