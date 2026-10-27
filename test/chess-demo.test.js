'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ChessSession } = require('../src/chess-session');
const { commandEnvelope } = require('../src/command-router');
const { createBridge } = require('../src/server');
const { createChessDemo } = require('../src/chess-demo');
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '../var-chess-http-'));
  const config = { directory: path.join(root, 'chess'), broadcasterId: '123' };
  const session = new ChessSession(config);
  let publish, sequence = 0;
  const counters = { commands: 0, uniqueParticipants: 0, lastEventAt: null };
  const state = { twitchConnected: false, twitchSubscriptionStatus: 'pending' };
  const server = createBridge({ env: { TWITCH_EVENTS_ENABLED: 'true', CHESS_SESSION_ENABLED: options.enabled === false ? 'false' : 'true', AGRO_REAL_PAYMENTS_ENABLED: 'false' },
    twitchFactory: args => {
      publish = args.publish;
      return { start() {}, stop() {}, snapshot: () => counters, health: () => state, chessSnapshot: () => session.snapshot() };
    }, chessDemoOptions: { ...options.demo } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const controllers = [];
  t.after(async () => {
    controllers.forEach(controller => controller.abort()); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function events(route = '/chess/events', headers = {}) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(base + route, { signal: controller.signal, headers });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    return { response, close: () => controller.abort(), async next() {
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
          const chunk = await reader.read(); if (chunk.done) throw Error('SSE ended'); buffer += decoder.decode(chunk.value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    } };
  }
  function move(uci, simulated = false) {
    sequence++;
    const envelope = commandEnvelope({ broadcaster_user_id: '123', chatter_user_id: '456', message_id: String(sequence), message: { text: '!move ' + uci } }, { broadcasterId: '123', timestamp: sequence });
    const outcome = session.apply(envelope, { expectedPly: session.snapshot().ply });
    publish({ ...outcome.event, simulated }); return outcome.event;
  }
  return { base, session, config, events, move, publish: event => publish(event), counters, state };
}

test('isolated static routes, security policy and read-only authoritative snapshots', async t => {
  const f = await fixture(t);
  for (const route of ['/chess', '/chess/', '/chess/app.js', '/chess/style.css']) {
    const response = await fetch(f.base + route);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok((await response.text()).length > 100);
  }
  const initial = await (await fetch(f.base + '/chess/snapshot?fen=untrusted&pgn=fake')).json();
  assert.equal(initial.match.ply, 0); assert.equal(initial.match.history.length, 0);
  const before = f.session.snapshot();
  for (const route of ['/chess', '/chess/snapshot', '/chess/events', '/chess/app.js']) {
    const response = await fetch(f.base + route, { method: 'POST', body: '{"fen":"fake"}' }); assert.equal(response.status, 405);
  }
  assert.deepEqual(f.session.snapshot(), before);
  assert.equal((await fetch(f.base + '/chess/snapshot', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(f.base + '/chess/move', { method: 'POST' })).status, 404);
});

test('disabled by default, no board exposed from an enabled dependency without flag', async t => {
  const f = await fixture(t, { enabled: false });
  const response = await (await fetch(f.base + '/chess/snapshot')).json();
  assert.equal(response.enabled, false); assert.equal(response.match, null);
  const stream = await f.events(); assert.equal((await stream.next()).data.enabled, false);
  f.move('e2e4');
  f.publish({ type: 'twitch_status' });
  assert.equal((await stream.next()).name, 'status'); // no move escapes disabled mode
  assert.equal((await fetch(f.base + '/chess')).status, 200);
});

test('accepted moves, result events and reconnect snapshots use committed chess history', async t => {
  const f = await fixture(t);
  const stream = await f.events(); assert.equal((await stream.next()).data.match.ply, 0);
  assert.equal(stream.response.headers.get('x-accel-buffering'), 'no');
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    f.move(uci);
    const packet = await stream.next(); assert.equal(packet.name, 'move'); assert.equal(packet.data.match.lastMove.uci, uci);
    assert.equal(packet.data.simulated, false); assert.equal(packet.data.source, 'twitch');
    assert.equal(packet.data.match.history.length, packet.data.match.ply);
  }
  const result = await stream.next(); assert.equal(result.name, 'result');
  assert.equal(result.data.match.result, '0-1'); assert.equal(result.data.match.reason, 'checkmate');
  const recovered = new ChessSession(f.config); assert.equal(recovered.snapshot().fen, result.data.match.fen);
  const reconnect = await f.events('/chess/events', { 'Last-Event-ID': 'stale-id' });
  const snapshot = await reconnect.next(); assert.equal(snapshot.name, 'snapshot');
  assert.deepEqual(snapshot.data.match, result.data.match);
  assert.doesNotMatch(JSON.stringify(snapshot.data), /participantId|receipts|broadcasterId|rewardUnits/);
});

test('chess and planet streams and counters remain isolated', async t => {
  const f = await fixture(t);
  const chess = await f.events(), planet = await f.events('/events');
  await chess.next(); const initialPlanet = (await planet.next()).data;
  assert.equal(initialPlanet.chess, undefined);
  f.publish({ type: 'twitch_participation', domain: 'planet', simulated: false, liveTwitch: f.counters });
  assert.equal((await planet.next()).data.type, 'twitch_participation');
  f.move('e2e4'); assert.equal((await chess.next()).name, 'move'); // no planet packet preceded it
  f.publish({ type: 'ocean_participant', simulated: true });
  assert.equal((await planet.next()).data.type, 'ocean_participant'); // no chess packet preceded it
  assert.deepEqual(f.counters, { commands: 0, uniqueParticipants: 0, lastEventAt: null });
  f.state.twitchConnected = true; f.state.twitchSubscriptionStatus = 'enabled'; f.publish({ type: 'twitch_status' });
  assert.equal((await chess.next()).data.twitch.connected, true);
});

test('simulation is explicit and mismatched sources never share a chess stream', async t => {
  const f = await fixture(t, { demo: { mode: 'simulation' } });
  const stream = await f.events(); const initial = await stream.next();
  assert.equal(initial.data.source, 'simulation'); assert.equal(initial.data.simulated, true);
  f.move('e2e4', false); // deliberately mismatched provenance is not published
  f.move('e7e5', true);
  const packet = await stream.next(); assert.equal(packet.data.match.ply, 2); assert.equal(packet.data.simulated, true);
});

test('connection limits return retryable 429 and release disconnected slots', async t => {
  const f = await fixture(t, { demo: { maxConnections: 2, maxPerAddress: 1, heartbeatMs: 20 } });
  const first = await f.events(); await first.next();
  assert.equal((await first.next()).name, 'status');
  const limited = await fetch(f.base + '/chess/events'); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '5');
  first.close();
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    const candidate = await f.events(); response = candidate.response;
    if (response.status === 200) { await candidate.next(); break; }
    candidate.close();
  }
  assert.equal(response.status, 200);
});

test('storage failures are sanitized without dropping the server', async t => {
  const f = await fixture(t);
  f.session.snapshot = () => { throw Error('private token details'); };
  for (const route of ['/chess/snapshot', '/chess/events']) {
    const response = await fetch(f.base + route); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private token/);
  }
  assert.equal((await fetch(f.base + '/health')).status, 200);
});

test('slow chess consumers are disconnected instead of buffering unbounded data', () => {
  const demo = createChessDemo({ maxConnections: 1 });
  const res = new EventEmitter(); res.setHeader = () => {}; res.writeHead = () => {}; res.write = () => false;
  let destroyed = false; res.destroy = () => { destroyed = true; res.emit('close'); };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(demo.handle(req, res, new URL('http://localhost/chess/events')), true); assert.equal(destroyed, true);
  const second = { ...res, setHeader() {}, writeHead(code) { assert.equal(code, 200); }, write() { return true; }, on() {}, destroy() {} };
  demo.handle(req, second, new URL('http://localhost/chess/events')); demo.close();
});

test('global chess connection cap applies across different socket addresses', () => {
  const demo = createChessDemo({ maxConnections: 1, maxPerAddress: 4 });
  function response() {
    const res = new EventEmitter(); res.setHeader = () => {}; res.writeHead = code => { res.status = code; };
    res.write = () => true; res.end = () => {}; res.destroy = () => res.emit('close'); return res;
  }
  const first = response(), second = response();
  demo.handle({ method: 'GET', socket: { remoteAddress: 'first' } }, first, new URL('http://localhost/chess/events'));
  demo.handle({ method: 'GET', socket: { remoteAddress: 'second' } }, second, new URL('http://localhost/chess/events'));
  assert.equal(first.status, 200); assert.equal(second.status, 429); demo.close();
});

test('standalone local simulation is opt-in, read-only over HTTP and uses separate storage', async t => {
  const { createLocalDemo } = require('../scripts/chess-demo');
  const root = fs.mkdtempSync(path.join(__dirname, '../var-local-chess-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const disabled = createLocalDemo({ directory: path.join(root, 'disabled') });
  assert.throws(() => disabled.move('e2e4'), /disabled/);
  assert.equal(fs.existsSync(path.join(root, 'disabled')), false);
  const { server, move } = createLocalDemo({ env: { CHESS_SESSION_ENABLED: 'true' }, directory: path.join(root, 'simulation') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const event = move('e2e4'); assert.equal(event.simulated, true); assert.equal(event.verified, false);
  assert.equal(event.type, 'chess.move');
  const snapshot = await (await fetch(base + '/chess/snapshot')).json();
  assert.equal(snapshot.source, 'simulation'); assert.equal(snapshot.match.ply, 1);
  assert.equal((await fetch(base + '/chess/snapshot', { method: 'POST', body: 'e7e5' })).status, 405);
  assert.equal((await fetch(base + '/events')).status, 404); // planet routes don't exist here
});
