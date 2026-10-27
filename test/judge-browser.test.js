'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Chess } = require('chess.js');
const { chessView, planetView } = require('../src/judge-demos');
const { createPresentation } = require('../public/judges');
class Element {
  constructor() { this.children = []; this.attributes = {}; this.textContent = ''; }
  append(value) { this.children.push(value); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  set innerHTML(value) { throw Error('Unsafe HTML sink ' + value); }
}
function chess(moves = []) {
  const board = new Chess(); for (const uci of moves) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  return { ...chessView({ enabled: true, simulated: true, match: { sessionId: 'judge', pgn: board.pgn(), fen: board.fen(), ply: moves.length, commands: moves.length }, twitch: { connected: false, subscription: 'disabled' } }), instanceId: 'one', revision: moves.length + 1 };
}
function planet(commands = 0) {
  return { ...planetView({ enabled: true, simulated: true, status: 'simulation', revision: 1,
    liveTwitch: { commands: 0, uniqueParticipants: 0 }, demoParticipation: { commands, uniqueParticipants: commands ? 1 : 0 },
    reports: [{ folio: 'demo:planet:sample', stamp: null, simulated: true }], twitch: { connected: false, subscription: 'disabled' } }), instanceId: 'one', revision: commands + 1 };
}
function fixture(page, initial) {
  const nodes = new Map(); let stream, data = initial, requests = 0, held;
  const filename = page === 'editorial' ? 'editorial.html' : 'judge-' + page + '.html';
  const html = fs.readFileSync(path.join(__dirname, '../public', filename), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());
  const document = { getElementById: id => nodes.get(id), createElement: () => new Element() };
  const base = page === 'editorial' ? '/editorial' : '/judge/' + page;
  class Stream {
    constructor(url) { assert.equal(url, base + '/events'); this.listeners = {}; stream = this; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    emit(name, value) { this.listeners[name]({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
    close() { this.closed = true; }
  }
  const demo = createPresentation({ page, document, EventSource: Stream, fetch: async (url, options) => {
    assert.equal(url, base + '/snapshot'); assert.equal(options.cache, 'no-store'); requests++;
    return { ok: true, json: async () => held ? await held : data };
  } });
  return { demo, node: id => nodes.get(id), stream: () => stream, set: value => { data = value; }, requests: () => requests,
    pause() { let release; held = new Promise(resolve => { release = resolve; }); return value => { release(value); held = null; }; } };
}

test('chess judge renders authoritative board, turn and history and ignores older snapshots', async () => {
  const f = fixture('chess', chess()); await f.demo.start(); assert.equal(f.node('board').children.length, 64);
  f.stream().emit('update', chess(['e2e4'])); assert.equal(f.node('turn').textContent, 'Black to move');
  assert.equal(f.node('history').children.length, 1); assert.match(f.node('source').textContent, /SIMULATED/);
  assert.equal(f.node('board').children.filter(square => square.className.includes(' last')).length, 2);
  f.stream().emit('snapshot', chess()); assert.equal(f.node('turn').textContent, 'Black to move');
  f.demo.close(); assert.equal(f.stream().closed, true);
});

test('Planet judge keeps simulated counters distinct, shows missing STAMP and uses safe text nodes', async () => {
  const data = structuredClone(planet(3)); data.mission.title = '<img src=x onerror=alert(1)>'; data.reports[0].folio = '<script>alert(1)</script>';
  const f = fixture('planet', data); await f.demo.start();
  assert.equal(f.node('mission-title').textContent, data.mission.title);
  assert.match(f.node('live-counters').textContent, /^0 real/); assert.match(f.node('simulated-counters').textContent, /^3 simulated/);
  assert.match(f.node('reports').children[0].children[0].textContent, /<script>/);
  assert.match(f.node('reports').children[0].children[1].textContent, /STAMP not available/);
  assert.match(f.node('video').textContent, /not a Twitch video stream/);
});

test('disconnect clears public reports; reconnect and server restart restore only fresh snapshots', async () => {
  const f = fixture('planet', planet(2)); await f.demo.start();
  f.stream().onerror(); assert.equal(f.node('reports').children.length, 0); assert.match(f.node('transport').textContent, /disconnected/);
  f.stream().onopen(); assert.match(f.node('transport').textContent, /video status is separate/);
  assert.match(f.node('twitch').textContent, /not connected/);
  const fresh = { ...planet(0), instanceId: 'new-server' }; f.stream().emit('snapshot', fresh);
  assert.equal(f.node('reports').children.length, 1); assert.match(f.node('simulated-counters').textContent, /^0 simulated/);
  f.set(planet(4)); f.stream().emit('update', '{bad json'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests(), 2); assert.match(f.node('simulated-counters').textContent, /^4 simulated/);
});

test('editorial projects separate chess and planet panels with video unobserved', async () => {
  const c = chess(['e2e4']), p = planet(1);
  const packet = { domain: 'editorial', instanceId: 'one', revision: 1, video: c.video, chess: c, planet: p };
  const f = fixture('editorial', packet); await f.demo.start();
  assert.equal(f.node('editorial-board').children.length, 64); assert.match(f.node('chess-summary').textContent, /1 legal moves.*Black to move/);
  assert.match(f.node('planet-summary').textContent, /0 real commands.*1 simulated/);
  assert.match(f.node('chess-source').textContent, /SIMULATED/); assert.match(f.node('planet-source').textContent, /SIMULATED/);
  assert.match(f.node('video').textContent, /not monitored/);
});

test('a delayed recovery response cannot overwrite a newer SSE snapshot after restart', async () => {
  const f = fixture('planet', planet(2)); await f.demo.start();
  const release = f.pause(); f.stream().emit('update', '{bad json');
  await new Promise(resolve => setImmediate(resolve));
  f.stream().emit('snapshot', { ...planet(9), instanceId: 'new-server' });
  release(planet(2)); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.node('simulated-counters').textContent, /^9 simulated/);
});

test('closing while the initial snapshot is pending cannot leave a new SSE client open', async () => {
  const f = fixture('planet', planet()); const release = f.pause(); const starting = f.demo.start();
  await new Promise(resolve => setImmediate(resolve));
  f.demo.close(); release(planet()); await starting; assert.equal(f.stream(), undefined);
});
