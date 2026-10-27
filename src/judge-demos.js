'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Chess } = require('chess.js');
const check = ok => { if (!ok) throw Error('Invalid presentation source'); };
const text = (value, max = 200) => { check(typeof value === 'string' && value.length <= max); return value; };
const count = value => { check(Number.isSafeInteger(value) && value >= 0); return value; };
const identities = Object.freeze({ chess: { id: 'pinche-chess', title: 'Pinche Chess — Twitch Plays Chess' }, planet: { id: 'agroceans-planet', title: 'AgroCeans — Twitch for Planet' } });
const mission = Object.freeze({ id: 'planet-public-reports', title: 'Document environmental action', description: 'Participate with !ocean. Explore allowlisted public reports and their existing STAMP references. Chat is participation, not proof of environmental action.' });
const video = Object.freeze({ status: 'not_observed', label: 'Video broadcast is not monitored by this bridge. SSE is application data, not a Twitch video stream.' });
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function twitch(value = {}) {
  const subscription = ['disabled', 'enabled', 'pending', 'unknown', 'missing', 'revoked', 'unregistered', 'registration_expired', 'storage_unavailable'].includes(value.subscription) ? value.subscription : 'unknown';
  return { connected: value.connected === true && subscription === 'enabled', subscription };
}
function chessView(value) {
  const base = { type: 'judge.chess.snapshot', domain: 'chess', identity: identities.chess, video, twitch: twitch(value?.twitch),
    enabled: value?.enabled === true, simulated: value?.simulated === true, source: value?.simulated === true ? 'simulation' : value?.enabled ? 'twitch' : 'disabled' };
  if (!base.enabled) return { ...base, match: null, counters: { commands: 0, acceptedMoves: 0 } };
  const m = value.match; check(m && typeof m.fen === 'string' && typeof m.pgn === 'string' && m.pgn.length <= 100000);
  const board = new Chess(); board.loadPgn(m.pgn); check(board.fen() === m.fen);
  board.removeComments();
  for (const key of Object.keys(board.getHeaders())) if (!['FEN', 'SetUp', 'Result'].includes(key)) board.removeHeader(key);
  const reason = board.isCheckmate() ? 'checkmate' : board.isStalemate() ? 'stalemate' : board.isInsufficientMaterial() ? 'insufficient_material' : board.isThreefoldRepetition() ? 'threefold_repetition' : board.isDrawByFiftyMoves() ? 'fifty_move_rule' : null;
  const result = reason === 'checkmate' ? board.turn() === 'w' ? '0-1' : '1-0' : reason ? '1/2-1/2' : '*';
  board.setHeader('Result', result);
  const history = board.history({ verbose: true }).map((move, i) => ({ ply: i + 1, san: move.san, uci: move.from + move.to + (move.promotion || ''), from: move.from, to: move.to }));
  check(count(m.ply) === history.length);
  check(/^[A-Za-z0-9_-]{1,80}$/.test(m.sessionId) && count(m.commands) >= history.length);
  const match = { sessionId: m.sessionId, fen: board.fen(), pgn: board.pgn(), ply: history.length,
    turn: board.turn(), check: board.isCheck(), terminal: Boolean(reason), result,
    reason, history, lastMove: history.at(-1) || null };
  return { ...base, match, counters: { commands: count(m.commands), acceptedMoves: history.length } };
}
function planetView(value) {
  check(value && Array.isArray(value.reports) && value.reports.length <= 50);
  const simulated = value.simulated === true;
  const reports = value.reports.map(row => {
    check(row && typeof row.folio === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/.test(row.folio));
    check((row.simulated === true) === simulated);
    let publicUrl = null;
    if (!simulated) {
      const url = new URL(row.publicUrl);
      check(url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
        url.searchParams.get('r') === 'post/post/view' && /^[1-9][0-9]{0,17}$/.test(url.searchParams.get('id')) &&
        [...url.searchParams.keys()].length === 2); publicUrl = url.href;
    }
    let stamp = null;
    if (row.stamp) {
      // Simulations never display an invented STAMP reference or transaction.
      check(!simulated);
      const s = row.stamp;
      const reference = s.reference == null ? null : text(s.reference, 200);
      check(reference === null || /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(reference));
      check(s.transactionId == null || /^[a-f0-9]{64}$/i.test(s.transactionId));
      stamp = { status: text(s.status, 80), reference, transactionId: s.transactionId || null,
        verification: 'Service-reported STAMP status; no environmental or on-chain verification claimed.' };
    }
    return { folio: row.folio, publicUrl, stamp, simulated };
  });
  const live = value.liveTwitch || {}, demo = value.demoParticipation || {};
  return { type: 'judge.planet.snapshot', domain: 'planet', identity: identities.planet, mission, video,
    enabled: value.enabled === true, source: simulated ? 'simulation' : 'public reports / Twitch participation', simulated,
    status: text(value.status || 'disabled', 80), reports, reportRevision: count(value.revision || 0),
    counters: { publicReports: simulated ? 0 : reports.length, simulatedReports: simulated ? reports.length : 0,
      liveCommands: count(live.commands || 0), liveParticipants: count(live.uniqueParticipants || 0),
      simulatedCommands: count(demo.commands || 0), simulatedParticipants: count(demo.uniqueParticipants || 0) },
    twitch: twitch(value.twitch), observedAt: value.observedAt ? text(value.observedAt, 80) : null };
}

function createJudgeDemos({ enabled = false, chess, planet, maxConnections = 20, maxPerAddress = 4, heartbeatMs = 15000 } = {}) {
  const instanceId = crypto.randomUUID(), caches = new Map(), clients = new Map();
  function snapshot(domain) {
    let data;
    if (domain === 'chess') data = chessView(chess());
    else if (domain === 'planet') data = planetView(planet());
    else {
      const c = snapshot('chess'), p = snapshot('planet');
      // Editorial summaries are explicit projections of sanitized domain views.
      data = { type: 'editorial.snapshot', domain: 'editorial', identity: { id: 'pinche-tulum-live', title: 'Pinche Tulum LIVE', host: 'Alejandro Barakat' }, video,
        chess: { identity: c.identity, enabled: c.enabled, source: c.source, simulated: c.simulated, twitch: c.twitch, counters: c.counters,
          match: c.match ? { fen: c.match.fen, turn: c.match.turn, lastMove: c.match.lastMove, terminal: c.match.terminal, result: c.match.result } : null },
        planet: { identity: p.identity, mission: p.mission, enabled: p.enabled, source: p.source, simulated: p.simulated, status: p.status,
          twitch: p.twitch, counters: p.counters, reports: p.reports } };
    }
    const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const old = caches.get(domain), revision = old ? old.revision + Number(old.hash !== hash) : 1;
    caches.set(domain, { hash, revision }); return { ...data, instanceId, revision };
  }
  function remove(res) { const entry = clients.get(res); if (entry) { clearInterval(entry.timer); clients.delete(res); } }
  function send(res, name, data) {
    const entry = clients.get(res); if (entry) entry.revision = data.revision;
    if (!res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)) { remove(res); res.destroy(); }
  }
  function update(domain) {
    const targets = [...clients].filter(([, row]) => row.domain === domain); if (!targets.length) return;
    try { const data = snapshot(domain); for (const [res, row] of targets) if (row.revision !== data.revision) send(res, 'update', data); }
    catch { for (const [res] of targets) { remove(res); res.destroy(); } }
  }
  function publish(event) {
    if (!enabled) return;
    const c = ['chess.move', 'chess.rejected'].includes(event?.type) && event.domain === 'chess';
    const p = ['planet.report', 'planet.snapshot', 'planet.unavailable'].includes(event?.type) ||
      (event?.type === 'twitch_participation' && event.command === '!ocean') || (event?.type === 'ocean_participant' && event.simulated === true);
    const status = ['twitch_status', 'twitch_revoked'].includes(event?.type);
    if (!c && !p && !status) return;
    if (c || status) update('chess'); if (p || status) update('planet'); update('editorial');
  }
  function handle(req, res, url) {
    const routes = { '/judge/chess': ['judge-chess.html', 'text/html'], '/judge/planet': ['judge-planet.html', 'text/html'],
      '/editorial': ['editorial.html', 'text/html'], '/judge/app.js': ['judges.js', 'text/javascript'], '/judge/style.css': ['judges.css', 'text/css'] };
    const match = url.pathname.match(/^\/(judge\/(chess|planet)|editorial)\/(snapshot|events)$/);
    if (!routes[url.pathname] && !match) return false;
    if (!enabled) { res.writeHead(404); res.end('Judge presentations disabled'); return true; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    const stream = match?.[3] === 'events';
    if (req.method !== 'GET' && !(req.method === 'HEAD' && !stream)) { res.writeHead(405, { Allow: stream ? 'GET' : 'GET, HEAD' }); res.end('Read-only presentation'); return true; }
    if (routes[url.pathname]) {
      const [filename, type] = routes[url.pathname]; res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(path.join(__dirname, '../public', filename)).pipe(res); return true;
    }
    const domain = match[2] || 'editorial', address = req.socket.remoteAddress;
    const group = [...clients.values()].filter(row => row.domain === domain);
    if (stream && (group.length >= maxConnections || group.filter(row => row.address === address).length >= maxPerAddress)) {
      res.writeHead(429, { 'Retry-After': '5' }); res.end('Presentation connection limit'); return true;
    }
    let data; try { data = snapshot(domain); } catch { res.writeHead(503); res.end('Presentation snapshot unavailable'); return true; }
    if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const timer = setInterval(() => {
      // One client per group refreshes shared state; avoid replaying a whole
      // match once per viewer on each heartbeat.
      if ([...clients.values()].find(row => row.domain === domain) === clients.get(res)) update(domain);
      if (clients.has(res) && !res.write(': presentation heartbeat\n\n')) { remove(res); res.destroy(); }
    }, heartbeatMs);
    timer.unref(); clients.set(res, { domain, address, timer, revision: 0 }); res.on('close', () => remove(res));
    res.write('retry: 2000\n\n'); send(res, 'snapshot', data); return true;
  }
  return { handle, publish, close() { for (const res of clients.keys()) { remove(res); res.destroy(); } } };
}
module.exports = { createJudgeDemos, chessView, planetView };
