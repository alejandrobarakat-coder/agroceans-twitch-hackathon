'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Chess } = require('chess.js');
const DISABLED = { twitchConnected: false, twitchSubscriptionStatus: 'disabled' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function createChessDemo({ snapshot, health = () => DISABLED, mode = 'twitch', maxConnections = 20,
  maxPerAddress = 4, heartbeatMs = 15000 } = {}) {
  if (!['twitch', 'simulation'].includes(mode)) throw Error('Invalid chess source mode');
  const clients = new Map();
  function status() {
    const value = health() || DISABLED;
    return { connected: value.twitchConnected === true, subscription: String(value.twitchSubscriptionStatus || 'disabled').slice(0, 80) };
  }
  function current() {
    const value = snapshot?.();
    if (!value) return { type: 'chess.snapshot', enabled: false, match: null, source: 'disabled', simulated: false, twitch: status() };
    const board = new Chess();
    board.loadPgn(value.pgn);
    if (board.fen() !== value.fen) throw Error('Inconsistent authoritative chess export');
    const history = board.history({ verbose: true }).map((move, index) => ({
      ply: index + 1, san: move.san, uci: move.from + move.to + (move.promotion || ''), from: move.from, to: move.to
    }));
    // Allowlist exported fields: private receipts, participant hashes and raw chat
    // never reach the browser, even if a snapshot implementation adds fields.
    const match = { sessionId: value.sessionId, ply: value.ply, commands: value.commands,
      fen: value.fen, pgn: value.pgn, turn: value.turn, check: value.check === true,
      terminal: value.terminal === true, reason: value.reason, result: value.result,
      history, lastMove: history.at(-1) || null };
    return { type: 'chess.snapshot', enabled: true, source: mode, simulated: mode === 'simulation', match, twitch: status() };
  }
  function remove(res) {
    const client = clients.get(res);
    if (client) { clearInterval(client.timer); clients.delete(res); }
  }
  function write(res, event, data) {
    // Disconnect a slow consumer instead of accumulating an unbounded queue.
    if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) { remove(res); res.destroy(); }
  }
  function publish(event) {
    if (!clients.size) return;
    const chess = event?.domain === 'chess' || event?.type?.startsWith('chess.');
    if (!chess && !['twitch_status', 'twitch_revoked'].includes(event?.type)) return;
    try {
      const data = current();
      if (chess && event.type !== 'chess.move') return;
      if (chess && !data.enabled) return;
      if (chess && (event.simulated === true) !== data.simulated) return; // never mix sources
      const kind = chess ? 'move' : 'status';
      const payload = { ...data, type: chess ? 'chess.move' : 'chess.status' };
      for (const res of clients.keys()) {
        write(res, kind, payload);
        if (chess && data.match?.terminal && clients.has(res)) write(res, 'result', { ...data, type: 'chess.result' });
      }
    } catch { for (const res of clients.keys()) { remove(res); res.destroy(); } }
  }
  function handle(req, res, url) {
    if (!['/chess', '/chess/', '/chess/app.js', '/chess/style.css', '/chess/snapshot', '/chess/events'].includes(url.pathname)) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const stream = url.pathname === '/chess/events';
    if (req.method !== 'GET' && !(req.method === 'HEAD' && !stream)) {
      res.writeHead(405, { Allow: stream ? 'GET' : 'GET, HEAD' }); res.end('Read-only route'); return true;
    }
    const files = { '/chess': ['chess.html', 'text/html'], '/chess/': ['chess.html', 'text/html'],
      '/chess/app.js': ['chess.js', 'text/javascript'], '/chess/style.css': ['chess.css', 'text/css'] };
    if (files[url.pathname]) {
      const [filename, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(path.join(__dirname, '../public', filename)).pipe(res);
      return true;
    }
    const address = req.socket.remoteAddress;
    if (stream && (clients.size >= maxConnections || [...clients.values()].filter(client => client.address === address).length >= maxPerAddress)) {
      res.writeHead(429, { 'Retry-After': '5' }); res.end('Chess stream connection limit'); return true;
    }
    let data;
    try { data = current(); } catch { res.writeHead(503); res.end('Chess snapshot temporarily unavailable'); return true; }
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // Every connection receives current state, regardless of Last-Event-ID. This
    // recovers missed events and commit/publication gaps without a replay queue.
    const timer = setInterval(() => {
      try { write(res, 'status', { type: 'chess.status', twitch: status() }); }
      catch { remove(res); res.destroy(); }
    }, heartbeatMs);
    timer.unref(); clients.set(res, { address, timer });
    res.write('retry: 2000\n\n');
    write(res, 'snapshot', data);
    res.on('close', () => remove(res));
    return true;
  }
  return { handle, publish, snapshot: current, close() { for (const res of clients.keys()) { remove(res); res.destroy(); } } };
}
module.exports = { createChessDemo };
