'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Chess } = require('chess.js');
const { parseFen, createDemo } = require('../public/chess');
class Element {
  constructor() { this.children = []; this.attributes = {}; this.textContent = ''; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  set innerHTML(value) { throw Error('Unsafe HTML sink: ' + value); }
}
function data(moves = [], extra = {}) {
  const board = new Chess(); const history = moves.map((uci, index) => {
    const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    return { ply: index + 1, san: move.san, uci, from: move.from, to: move.to };
  });
  return { enabled: true, source: 'twitch', simulated: false, twitch: { connected: true, subscription: 'enabled' },
    match: { sessionId: 'test', ply: moves.length, commands: moves.length, fen: board.fen(), pgn: board.pgn(),
      turn: board.turn(), history, lastMove: history.at(-1), terminal: false, ...extra } };
}
function fixture(initial = data()) {
  const nodes = new Map(); let stream, snapshot = initial, requests = 0;
  const html = fs.readFileSync(path.join(__dirname, '../public/chess.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());
  const document = { getElementById: id => { assert.ok(nodes.has(id), 'missing HTML id ' + id); return nodes.get(id); }, createElement: () => new Element() };
  class Stream {
    constructor(url) { assert.equal(url, '/chess/events'); stream = this; this.handlers = {}; }
    addEventListener(type, callback) { this.handlers[type] = callback; }
    emit(type, payload) { this.handlers[type]({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) }); }
    close() { this.closed = true; }
  }
  const demo = createDemo({ document, EventSource: Stream, fetch: async (url, options) => {
    assert.equal(url, '/chess/snapshot'); assert.equal(options.cache, 'no-store'); requests++;
    return { ok: true, json: async () => snapshot };
  } });
  return { demo, node: id => nodes.get(id), stream: () => stream, setSnapshot: value => { snapshot = value; }, requests: () => requests };
}

test('FEN renderer accepts exact 64-square positions and rejects malformed input', () => {
  const cells = parseFen(new Chess().fen()); assert.equal(cells.length, 64);
  assert.equal(cells[0].square, 'a8'); assert.equal(cells[0].piece, 'r'); assert.equal(cells.at(-1).square, 'h1');
  for (const fen of ['', '<script>', '9/8/8/8/8/8/8/8 w - - 0 1', '8/8/8/8/8/8/8/7 w - - 0 1', '8/8/8/8/8/8/8/8 x - - 0 1']) assert.throws(() => parseFen(fen));
});

test('board, turn, last move and history follow server snapshots only', async () => {
  const f = fixture(); await f.demo.start();
  assert.equal(f.node('board').children.length, 64);
  assert.equal(f.node('board').children.filter(square => square.children[0].textContent).length, 32);
  assert.equal(f.node('turn').textContent, 'White to move');
  f.stream().emit('move', data(['e2e4']));
  assert.equal(f.node('turn').textContent, 'Black to move');
  assert.equal(f.node('lastMove').textContent, 'Last move: e4 · e2e4');
  assert.equal(f.node('history').children.length, 1);
  assert.equal(f.node('board').children.filter(square => square.className.includes(' last')).length, 2);
  const e4 = f.node('board').children.find(square => square.attributes['aria-label'] === 'e4 White pawn'); assert.ok(e4);
  f.stream().emit('snapshot', data()); assert.equal(f.node('turn').textContent, 'Black to move'); // stale response ignored
  f.demo.close(); assert.equal(f.stream().closed, true);
});

test('server text uses textContent even for markup-shaped values', async () => {
  const payload = data(['e2e4'], { sessionId: '<img src=x onerror=alert(1)>', pgn: '<script>alert(1)</script>' });
  payload.match.history[0].san = '<svg onload=alert(1)>';
  const f = fixture(payload); await f.demo.start();
  assert.equal(f.node('pgn').textContent, payload.match.pgn);
  assert.equal(f.node('session').textContent, 'Session ' + payload.match.sessionId);
  assert.match(f.node('history').children[0].textContent, /<svg/);
});

test('disconnect retains board, reconnect recovers snapshot, and transport is not Twitch status', async () => {
  const f = fixture(data(['e2e4'])); await f.demo.start();
  f.stream().onerror(); assert.match(f.node('transport').textContent, /disconnected/);
  assert.equal(f.node('board').children.length, 64);
  f.stream().onopen();
  const recovered = data(['e2e4', 'e7e5']); recovered.twitch = { connected: false, subscription: 'revoked' };
  f.stream().emit('snapshot', recovered);
  assert.equal(f.node('history').children.length, 2); assert.equal(f.node('turn').textContent, 'White to move');
  assert.match(f.node('twitch').textContent, /not connected.*revoked/);
  f.setSnapshot(recovered); f.stream().emit('move', '{bad json');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests(), 2);
  assert.equal(f.node('board').children.length, 64);
});

test('simulation, terminal result and disabled session remain explicit', async () => {
  const packet = data(['f2f3', 'e7e5', 'g2g4', 'd8h4'], { terminal: true, result: '0-1', reason: 'checkmate' });
  packet.source = 'simulation'; packet.simulated = true;
  const f = fixture(packet); await f.demo.start();
  assert.match(f.node('source').textContent, /^SIMULATED/); assert.equal(f.node('turn').textContent, 'Match finished');
  assert.equal(f.node('result').textContent, '0-1 · checkmate');
  f.stream().emit('snapshot', { enabled: false, match: null });
  assert.equal(f.node('source').textContent, 'Chess disabled'); assert.equal(f.node('board').children.length, 0);
  assert.equal(f.node('history').children.length, 0); assert.equal(f.node('pgn').textContent, '');
});
