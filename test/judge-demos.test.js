'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Chess } = require('chess.js');
const { createJudgeSimulator } = require('../scripts/judge-demos');
const { createJudgeDemos, chessView, planetView } = require('../src/judge-demos');
const { createBridge } = require('../src/server');
const active = { JUDGE_DEMOS_ENABLED: 'true', CHESS_SESSION_ENABLED: 'true', PLANET_DEMO_ENABLED: 'true' };
async function fixture(t, options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(__dirname, '../var-judges-test-'));
  const demo = createJudgeSimulator({ env: options.env || active, directory, presentationOptions: options.presentationOptions });
  await new Promise((resolve, reject) => { demo.server.once('error', reject); demo.server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + demo.server.address().port, controllers = [];
  let stopped = false;
  async function stop() { if (stopped) return; stopped = true; controllers.forEach(controller => controller.abort()); demo.server.closeAllConnections(); await new Promise(resolve => demo.server.close(resolve)); }
  t.after(async () => { await stop(); if (!options.directory) fs.rmSync(directory, { recursive: true, force: true }); });
  const snapshot = async domain => { const response = await fetch(base + (domain === 'editorial' ? '/editorial' : '/judge/' + domain) + '/snapshot'); assert.equal(response.status, 200); return response.json(); };
  async function events(domain) {
    const controller = new AbortController(); controllers.push(controller);
    const prefix = domain === 'editorial' ? '/editorial' : '/judge/' + domain;
    const response = await fetch(base + prefix + '/events', { signal: controller.signal });
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    return { response, close: () => controller.abort(), async next() {
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        while (true) {
          const i = buffer.indexOf('\n\n');
          if (i >= 0) {
            const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) return { name: frame.split('\n').find(line => line.startsWith('event: '))?.slice(7), data: JSON.parse(data.slice(6)) }; continue;
          }
          const part = await reader.read(); if (part.done) throw Error('Stream ended'); buffer += decoder.decode(part.value, { stream: true });
        }
      } finally { clearTimeout(timer); }
    } };
  }
  return { ...demo, base, snapshot, events, directory, stop };
}

test('new judge/editorial routes are disabled by default and legacy endpoints retain behavior', async t => {
  const local = await fixture(t, { env: {} });
  for (const route of ['/judge/chess', '/judge/planet', '/editorial', '/editorial/snapshot', '/judge/planet/events', '/judge/app.js']) assert.equal((await fetch(local.base + route)).status, 404);
  assert.throws(() => local.input('chess e2e4'), /disabled/); assert.throws(() => local.input('planet !ocean viewer'), /disabled/);
  assert.equal(fs.readdirSync(local.directory).length, 0);
  const server = createBridge({ env: {} }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/judge/chess')).status, 404);
  assert.equal((await fetch(base + '/chess')).status, 200);
  assert.equal((await (await fetch(base + '/planet/snapshot')).json()).enabled, false);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('distinct responsive accessible pages are read-only and use restrictive same-origin assets', async t => {
  const f = await fixture(t);
  for (const [route, title] of [['/judge/chess', 'Pinche Chess'], ['/judge/planet', 'AgroCeans'], ['/editorial', 'Alejandro Barakat']]) {
    const response = await fetch(f.base + route); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await response.text(); assert.match(html, new RegExp(title)); assert.match(html, /name="viewport"/); assert.match(html, /class="skip"/); assert.match(html, /aria-label=/);
    assert.equal((await fetch(f.base + route, { method: 'POST', body: '{"fen":"fake"}' })).status, 405);
    assert.equal((await fetch(f.base + route + '/snapshot', { method: 'POST', body: '!ocean' })).status, 405);
  }
  assert.equal((await fetch(f.base + '/judge/app.js')).status, 200); assert.equal((await fetch(f.base + '/judge/style.css')).status, 200);
});

test('chess and planet maintain separate identities, counters, persistent state and legal history', async t => {
  const f = await fixture(t);
  const before = await f.snapshot('planet');
  f.input('chess e2e4'); f.input('chess e7e5');
  const chess = await f.snapshot('chess'); assert.equal(chess.match.ply, 2); assert.equal(chess.match.turn, 'w');
  assert.deepEqual(chess.match.history.map(move => move.uci), ['e2e4', 'e7e5']);
  assert.deepEqual((await f.snapshot('planet')).counters, before.counters);
  const chessBytes = fs.readFileSync(path.join(f.directory, 'chess/session.json'), 'utf8');
  f.input('planet !ocean viewer1'); f.input('planet !ocean viewer1'); f.input('planet !ocean viewer2'); f.input('planet report sample1'); f.input('planet report sample1');
  const planet = await f.snapshot('planet'); assert.notEqual(chess.identity.id, planet.identity.id);
  assert.equal(planet.counters.liveCommands, 0); assert.equal(planet.counters.simulatedCommands, 3); assert.equal(planet.counters.simulatedParticipants, 2);
  assert.equal(planet.counters.publicReports, 0); assert.equal(planet.counters.simulatedReports, 1); assert.equal(planet.reports[0].stamp, null);
  assert.equal(fs.readFileSync(path.join(f.directory, 'chess/session.json'), 'utf8'), chessBytes);
  assert.equal(chess.twitch.connected, false); assert.equal(planet.twitch.connected, false);
  assert.equal(chess.simulated, true); assert.equal(planet.simulated, true); assert.equal(chess.video.status, 'not_observed');
});

test('domain SSE updates are isolated while the read-only editorial sees both projections', async t => {
  const f = await fixture(t); const chess = await f.events('chess'), planet = await f.events('planet'), editorial = await f.events('editorial');
  await chess.next(); await planet.next(); await editorial.next();
  f.input('chess e2e4'); assert.equal((await chess.next()).data.domain, 'chess');
  assert.equal((await editorial.next()).data.chess.match.lastMove.uci, 'e2e4');
  f.input('planet !ocean viewer1');
  const p = await planet.next(); assert.equal(p.data.domain, 'planet'); assert.equal(p.data.counters.simulatedCommands, 1);
  assert.equal((await editorial.next()).data.planet.counters.simulatedCommands, 1);
  f.input('chess e7e5'); assert.equal((await chess.next()).data.match.ply, 2); // no planet update leaked before it
});

test('reconnect and restart recover committed snapshots with new instance identity', async t => {
  const f = await fixture(t); f.input('chess e2e4'); f.input('planet !ocean viewer'); f.input('planet report sample');
  const before = await f.snapshot('editorial');
  const stream = await f.events('chess'); const first = await stream.next(); assert.equal(first.data.match.ply, 1); stream.close();
  f.input('chess e7e5'); const reconnect = await f.events('chess'); assert.equal((await reconnect.next()).data.match.ply, 2);
  await f.stop();
  const recovered = await fixture(t, { directory: f.directory });
  const after = await recovered.snapshot('editorial');
  assert.notEqual(after.instanceId, before.instanceId); assert.equal(after.chess.counters.acceptedMoves, 2);
  assert.deepEqual(after.planet.counters, before.planet.counters);
  await recovered.stop(); // original fixture owns removal of the shared directory
});

test('sanitization drops raw fields, private PGN tags and forged verification/result metadata', () => {
  const board = new Chess(); board.move('e4'); board.setHeader('White', 'PRIVATE_WALLET'); board.setHeader('Event', 'PRIVATE_TOKEN'); board.setComment('PRIVATE_COMMENT');
  const c = chessView({ enabled: true, simulated: false, match: { sessionId: 'chess', pgn: board.pgn(), fen: board.fen(), ply: 1, commands: 1,
    terminal: true, result: 'FORGED', reason: 'PRIVATE_REASON', history: [{ san: 'PRIVATE_CHAT' }], wallet: 'PRIVATE' }, twitch: { connected: true, subscription: 'enabled', access_token: 'PRIVATE' } });
  assert.doesNotMatch(JSON.stringify(c), /PRIVATE|FORGED/); assert.equal(c.match.terminal, false); assert.equal(c.match.lastMove.san, 'e4');
  const p = planetView({ enabled: true, simulated: false, status: 'ready', revision: 1, liveTwitch: { commands: 2, uniqueParticipants: 1, rawChat: 'PRIVATE' },
    reports: [{ folio: 'public', publicUrl: 'https://matrix.example.test/index.php?r=post%2Fpost%2Fview&id=7', simulated: false,
      title: 'PRIVATE', photos: ['PRIVATE'], stamp: { status: 'confirmed', reference: 'stamp:existing', transactionId: 'a'.repeat(64), verified: true, receiver: 'PRIVATE', verification: 'FORGED' }, reward: { amount: 'PRIVATE' } }], twitch: { connected: false, subscription: 'revoked' } });
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE|FORGED|reward|receiver|photos/); assert.equal(p.reports[0].stamp.reference, 'stamp:existing');
  assert.match(p.reports[0].stamp.verification, /no environmental or on-chain/);
  assert.throws(() => planetView({ ...p, reports: [{ ...p.reports[0], publicUrl: 'javascript:alert(1)' }] }));
  assert.throws(() => planetView({ ...p, simulated: true, reports: [{ ...p.reports[0], simulated: true }] }));
});

test('per-domain client limits, cleanup and slow-consumer eviction are enforced', () => {
  const judge = createJudgeDemos({ enabled: true, chess: () => ({ enabled: false }), planet: () => ({ reports: [], simulated: false }), maxConnections: 1 });
  function response(slow = false) {
    const res = new EventEmitter(); res.setHeader = () => {}; res.writeHead = code => { res.status = code; };
    res.write = () => !slow; res.end = () => {}; res.destroy = () => res.emit('close'); return res;
  }
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const first = response(), limited = response(), planet = response();
  judge.handle(req, first, new URL('http://localhost/judge/chess/events'));
  judge.handle(req, limited, new URL('http://localhost/judge/chess/events')); assert.equal(limited.status, 429);
  judge.handle(req, planet, new URL('http://localhost/judge/planet/events')); assert.equal(planet.status, 200);
  first.emit('close'); const slow = response(true);
  judge.handle(req, slow, new URL('http://localhost/judge/chess/events'));
  const after = response(); judge.handle(req, after, new URL('http://localhost/judge/chess/events')); assert.equal(after.status, 200); judge.close();
});

test('judge projections, local commands and editorial routes never invoke financial adapters', async t => {
  const f = await fixture(t); let calls = 0; const restore = [];
  for (const Class of Object.values(require('../src/integration'))) for (const name of Object.getOwnPropertyNames(Class.prototype).filter(name => name !== 'constructor')) {
    const original = Class.prototype[name]; Class.prototype[name] = () => { calls++; throw Error('financial tripwire'); }; restore.push(() => { Class.prototype[name] = original; });
  }
  try {
    f.input('chess e2e4'); f.input('planet !ocean viewer'); f.input('planet report sample');
    for (const domain of ['chess', 'planet', 'editorial']) assert.ok(await f.snapshot(domain));
    assert.equal(calls, 0);
  } finally { restore.forEach(fn => fn()); }
});

test('presentation GETs use the shared bridge public snapshots without ingestion or side effects', async t => {
  const board = new Chess(); let refreshes = 0;
  const report = { folio: 'impact:public', publicUrl: 'https://matrix.example.test/index.php?r=post%2Fpost%2Fview&id=9',
    simulated: false, stamp: { status: 'confirmed', reference: 'stamp:original', transactionId: 'a'.repeat(64) }, photos: ['PRIVATE'] };
  const server = createBridge({ env: { JUDGE_DEMOS_ENABLED: 'true', TWITCH_EVENTS_ENABLED: 'true', CHESS_SESSION_ENABLED: 'true', AGRO_REAL_PAYMENTS_ENABLED: 'false' },
    twitchFactory: () => ({ start() {}, stop() {}, snapshot: () => ({ commands: 7, uniqueParticipants: 3 }),
      health: () => ({ twitchConnected: true, twitchSubscriptionStatus: 'enabled' }),
      chessSnapshot: () => ({ sessionId: 'bridge-match', fen: board.fen(), pgn: board.pgn(), ply: 0, commands: 0, terminal: false, result: '*', reason: null }) }),
    planetReportsFactory: () => ({ snapshot: () => ({ reports: [report], enabled: true, revision: 1, status: 'ready', simulated: false }), refresh: async () => { refreshes++; throw Error('must not ingest from a judge GET'); } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const c = await (await fetch(base + '/judge/chess/snapshot')).json(), p = await (await fetch(base + '/judge/planet/snapshot')).json();
  assert.equal(c.counters.commands, 0); assert.equal(c.match.ply, 0); assert.equal(p.counters.liveCommands, 7);
  assert.equal(p.reports[0].stamp.reference, 'stamp:original'); assert.equal(p.reports[0].stamp.status, 'confirmed');
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE|photos/); assert.equal(p.simulated, false);
  const e = await (await fetch(base + '/editorial/snapshot')).json(); assert.equal(e.planet.counters.liveParticipants, 3); assert.equal(e.chess.twitch.connected, true);
  assert.equal(e.video.status, 'not_observed'); assert.equal(refreshes, 0);
});

test('corrupt chess state fails closed for chess/editorial while Planet remains available', async t => {
  const f = await fixture(t); f.input('chess e2e4'); f.input('planet !ocean viewer');
  const filename = path.join(f.directory, 'chess/session.json'), original = fs.readFileSync(filename, 'utf8');
  fs.writeFileSync(filename, '{broken PRIVATE_DATA');
  for (const route of ['/judge/chess/snapshot', '/editorial/snapshot']) {
    const response = await fetch(f.base + route); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE_DATA/);
  }
  assert.equal((await f.snapshot('planet')).counters.simulatedCommands, 1);
  fs.writeFileSync(filename, original); assert.equal((await f.snapshot('chess')).match.ply, 1);
});
