'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChessSession } = require('../src/chess-session');
const { commandEnvelope } = require('../src/command-router');
const { createChessDemo } = require('../src/chess-demo');

// Explicit local simulation, using a separate file from the live Twitch session.
// No OAuth, Twitch requests, planet state, financial clients or browser writes.
function createLocalDemo({ env = {}, directory = path.resolve(__dirname, '../var/chess-browser-simulation') } = {}) {
  const session = env.CHESS_SESSION_ENABLED === 'true' ? new ChessSession({ directory, broadcasterId: '0', sessionId: 'local-simulation' }) : null;
  const demo = createChessDemo({ snapshot: () => session?.snapshot(), mode: 'simulation' });
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!demo.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end('Not found'); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('close', () => demo.close());
  function move(text) {
    if (!session) throw Error('Chess disabled');
    const input = text.trim();
    const envelope = commandEnvelope({ broadcaster_user_id: '0', chatter_user_id: '1', message_id: crypto.randomUUID(),
      message: { text: input.startsWith('!') ? input : '!move ' + input } }, { broadcasterId: '0', timestamp: Date.now() });
    if (!envelope || envelope.domain !== 'chess') throw Error('Invalid chess command');
    const outcome = session.apply(envelope, { expectedPly: session.snapshot().ply });
    const event = { ...outcome.event, simulated: true, verified: false };
    demo.publish(event); return event;
  }
  return { server, move };
}
if (require.main === module) {
  const { server, move } = createLocalDemo({ env: process.env });
  const port = Number(process.env.PORT || 8877);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local SIMULATED chess viewer: http://127.0.0.1:${port}/chess`);
    console.log('Chess requires CHESS_SESSION_ENABLED=true. Enter UCI moves in this terminal; Ctrl+C stops this local process.');
  });
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    try { const event = move(line); console.log('SIMULATED · ' + (event.san || event.rejection)); }
    catch { console.log('Command unavailable or invalid.'); }
  });
}
module.exports = { createLocalDemo };
