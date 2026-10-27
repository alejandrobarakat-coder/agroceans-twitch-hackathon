'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChessSession } = require('../src/chess-session');
const { TwitchStorage, digest } = require('../src/twitch-storage');
const { commandEnvelope, routeCommand } = require('../src/command-router');
const { createChessDemo } = require('../src/chess-demo');
const { createPlanetFeed } = require('../src/planet-feed');
const { createJudgeDemos } = require('../src/judge-demos');

function createJudgeSimulator({ env = {}, directory = path.resolve(__dirname, '../var/judge-simulation'), presentationOptions = {} } = {}) {
  const enabled = env.JUDGE_DEMOS_ENABLED === 'true';
  const chessSession = enabled && env.CHESS_SESSION_ENABLED === 'true' ? new ChessSession({ directory: path.join(directory, 'chess'), broadcasterId: '0', sessionId: 'judge-chess-simulation' }) : null;
  const planetStorage = enabled && env.PLANET_DEMO_ENABLED === 'true' ? new TwitchStorage(path.join(directory, 'planet')) : null;
  function planetState() {
    const value = planetStorage.read('participation.json', { version: 1, revision: 0, routing: {}, participants: {}, reports: [] });
    if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.reports) || value.reports.length > 50 || !value.participants || !value.routing) throw Error('Invalid local simulation');
    return value;
  }
  function simulatedPlanet() {
    if (!planetStorage) return { type: 'planet.snapshot', domain: 'planet', enabled: false, status: 'disabled', reports: [], revision: 0, simulated: false };
    return planetStorage.transaction(() => {
      const state = planetState();
      return { type: 'planet.snapshot', domain: 'planet', enabled: true, status: 'simulation', reports: state.reports, revision: state.revision,
        simulated: true, source: 'local simulation; no Matrix retrieval', demoParticipation: { commands: state.routing.planet?.commands || 0, uniqueParticipants: Object.keys(state.participants).length } };
    });
  }
  const chess = createChessDemo({ snapshot: () => chessSession?.snapshot(), mode: 'simulation' });
  const planet = createPlanetFeed({ reports: planetStorage ? { snapshot: simulatedPlanet } : null,
    participation: () => ({ commands: 0, uniqueParticipants: 0, lastEventAt: null }),
    health: () => ({ connected: false, subscription: 'disabled' }), authorize: () => false });
  const judges = createJudgeDemos({ enabled, chess: () => chess.snapshot(), planet: () => planet.snapshot(), ...presentationOptions });
  function publish(event) { chess.publish(event); planet.publish(event); judges.publish(event); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (judges.handle(req, res, url) || chess.handle(req, res, url) || await planet.handle(req, res, url)) return;
      res.writeHead(404); res.end('Not found');
    } catch { if (!res.headersSent) res.writeHead(503); res.end('Local presentation unavailable'); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('close', () => { judges.close(); chess.close(); planet.close(); });
  function input(line) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'chess') {
      if (!chessSession) throw Error('Chess simulation disabled');
      const move = parts.slice(1).join(' ');
      const envelope = commandEnvelope({ broadcaster_user_id: '0', chatter_user_id: '1', message_id: crypto.randomUUID(), message: { text: move.startsWith('!') ? move : '!move ' + move } }, { broadcasterId: '0', timestamp: Date.now() });
      if (!envelope || envelope.domain !== 'chess') throw Error('Invalid chess command');
      const event = { ...chessSession.apply(envelope, { expectedPly: chessSession.snapshot().ply }).event, simulated: true, verified: false };
      publish(event); return event;
    }
    if (parts[0] !== 'planet' || !planetStorage) throw Error('Planet simulation disabled or unknown command');
    const id = parts[2] || 'viewer';
    if (parts.length > 3 || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw Error('Invalid simulation identifier');
    const event = planetStorage.transaction(() => {
      const state = planetState();
      if (parts[1] === '!ocean') {
        const actor = BigInt('0x' + digest('planet-demo:' + id).slice(0, 12)).toString();
        const envelope = commandEnvelope({ broadcaster_user_id: '1', chatter_user_id: actor, message_id: crypto.randomUUID(), message: { text: '!ocean' } }, { broadcasterId: '1', timestamp: Date.now() });
        const routed = routeCommand(state.routing, envelope, '1');
        state.routing = routed.state; state.participants[envelope.participantId] = true;
      } else if (parts[1] === 'report') {
        const folio = 'demo:planet:' + id;
        if (state.reports.some(report => report.folio === folio)) return { type: 'planet.duplicate', domain: 'planet', simulated: true, verified: false };
        if (state.reports.length >= 50) throw Error('Simulation capacity');
        state.reports.push({ folio, publicUrl: null, stamp: null, simulated: true });
      } else throw Error('Invalid planet command');
      state.revision++; planetStorage.write('participation.json', state);
      return { type: parts[1] === '!ocean' ? 'ocean_participant' : 'planet.report', domain: 'planet', simulated: true, verified: false };
    });
    publish(event); return event;
  }
  return { server, input };
}
if (require.main === module) {
  const { server, input } = createJudgeSimulator({ env: process.env });
  const port = Number(process.env.PORT || 8878);
  server.listen(port, '127.0.0.1', () => {
    console.log(`SIMULATED local judges: http://127.0.0.1:${port}/judge/chess · /judge/planet · /editorial`);
    console.log('Input: chess e2e4 | planet !ocean viewer1 | planet report sample1. No live Twitch or financial calls.');
  });
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    try { console.log('SIMULATED · ' + input(line).type); } catch { console.log('Input disabled, invalid or unavailable.'); }
  });
}
module.exports = { createJudgeSimulator };
