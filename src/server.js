const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { RewardEngine } = require('./integration');
const { AgroExplorerClient, MatrixReportsClient, EcosystemReader, TwitchWebhook } = require('./ecosystem');
const PORT = Number(process.env.PORT || 8766);
const HOST = '127.0.0.1';
const clients = new Set();

let stats = {
  participants: 0,
  missions: 0,
  stamps: 0,
  agro: 0
};

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const client of clients) {
    client.write(payload);
  }
}

const list = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
let ecosystemSnapshot = null;
let refreshPending = null;
const reader = process.env.AGRO_EXPLORER_URL ? new EcosystemReader({
  explorer: new AgroExplorerClient(process.env.AGRO_EXPLORER_URL),
  reports: process.env.AGRO_MATRIX_SESSION_COOKIE && process.env.AGRO_MATRIX_URL
    ? new MatrixReportsClient(process.env.AGRO_MATRIX_URL, process.env.AGRO_MATRIX_SESSION_COOKIE) : null,
  folios: list(process.env.AGRO_PUBLIC_REPORT_FOLIOS),
  transactionIds: list(process.env.AGRO_PUBLIC_TRANSACTION_IDS)
}) : null;
let twitchWebhook = null;
let twitchStore = null;
if (process.env.TWITCH_EVENTS_ENABLED === 'true') {
  twitchWebhook = new TwitchWebhook({ secret: process.env.TWITCH_EVENTSUB_SECRET,
    broadcasterId: process.env.TWITCH_BROADCASTER_ID, subscriptionIds: list(process.env.TWITCH_SUBSCRIPTION_IDS) });
  twitchStore = new RewardEngine({ directory: path.resolve(__dirname, '../var/twitch'), clients: {}, publish: broadcast });
}
let engine;
let integrationClients;
if (process.env.AGRO_INTEGRATION_MODULE) {
  const modulePath = path.resolve(process.env.AGRO_INTEGRATION_MODULE);
  const root = path.resolve(__dirname, '..') + path.sep;
  if (!modulePath.startsWith(root)) throw new Error('Adapter module must be inside this repository');
  integrationClients = require(modulePath);
  engine = new RewardEngine({
    directory: path.resolve(__dirname, '../var/integration'), clients: integrationClients,
    enabled: process.env.AGRO_REAL_PAYMENTS_ENABLED === 'true',
    authorized: process.env.AGRO_PAYMENT_AUTHORIZATION === 'I_AUTHORIZE_REAL_PAYMENTS',
    maxRewardUnits: process.env.AGRO_MAX_REWARD_UNITS || '0',
    dailyLimitUnits: process.env.AGRO_DAILY_LIMIT_UNITS || '0', publish: broadcast
  });
}
function authenticated(req) {
  const expected = process.env.AGRO_OPERATOR_TOKEN;
  const actual = req.headers.authorization || '';
  return expected && expected.length >= 32 && Buffer.byteLength(actual) === Buffer.byteLength('Bearer ' + expected) &&
    crypto.timingSafeEqual(Buffer.from(actual), Buffer.from('Bearer ' + expected));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/twitch/eventsub' && req.method === 'POST') {
    if (!twitchWebhook) { res.writeHead(503); return res.end('Twitch ingress disabled'); }
    try {
      const result = twitchWebhook.verify({ headers: req.headers, rawBody: await body(req) });
      if (result.kind === 'challenge') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(result.challenge); }
      if (result.kind === 'revocation') { twitchWebhook = null; broadcast({ type: 'twitch_revoked', simulated: false }); }
      else if (!twitchStore.state.replay[result.id]) await twitchStore.twitch(result);
      res.writeHead(204); return res.end();
    } catch { res.writeHead(403); return res.end('Event rejected'); }
  }
  if (url.pathname === '/integration/refresh' && req.method === 'POST') {
    if (!reader || !authenticated(req)) { res.writeHead(403); return res.end('Forbidden'); }
    // Coalesce concurrent refreshes; explicit refresh avoids an unsolicited production poll loop.
    try {
      if (!refreshPending) refreshPending = reader.refresh().finally(() => { refreshPending = null; });
      ecosystemSnapshot = await refreshPending; broadcast(ecosystemSnapshot);
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(ecosystemSnapshot));
    } catch { res.writeHead(502); return res.end('Read-only integration unavailable'); }
  }
  if (req.method === 'POST' && ['/integration/reward', '/integration/reconcile', '/integration/twitch'].includes(url.pathname)) {
    if (!engine || !authenticated(req)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      const raw = await body(req);
      let result;
      if (url.pathname === '/integration/twitch') {
        // Deployment client validates Twitch signature, message type, subscription and broadcaster.
        const event = await integrationClients.twitch.verifyEvent({ headers: req.headers, rawBody: raw });
        result = await engine.twitch(event);
      } else {
        const input = JSON.parse(raw.toString('utf8'));
        result = url.pathname === '/integration/reward' ? await engine.reward(input) : await engine.reconcile(input.key);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(result));
    } catch { res.writeHead(409); return res.end(JSON.stringify({ error: 'Request rejected; inspect integration audit and provider records before retrying' })); }
  }
  if (url.pathname === '/overlay') {
    const file = path.join(__dirname, '../public/overlay.html');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (url.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json'
    });
    return res.end(JSON.stringify({
      ok: true,
      mode: engine ? 'integration-configured' : 'simulation',
      realPaymentsEnabled: Boolean(engine?.enabled),
      twitchConnected: false,
      blockchainConnected: Boolean(ecosystemSnapshot?.chain),
      blockchainObservedAt: ecosystemSnapshot?.chain?.observedAt || null,
      twitchIngressConfigured: Boolean(twitchWebhook)
    }));
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    clients.add(res);
    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      stats,
      rewards: engine ? engine.snapshot() : [],
      ecosystem: ecosystemSnapshot
    })}\n\n`);

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    return;
  }

  if (url.pathname === '/demo/ocean' && req.method === 'POST') {
    const remote = req.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1') {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const expectedToken = process.env.AGRO_DEMO_TOKEN;
    if (!expectedToken ||
        req.headers['x-demo-token'] !== expectedToken) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    stats.participants += 1;

    const event = {
      id: crypto.randomUUID(),
      type: 'ocean_participant',
      username: `demo_viewer_${stats.participants}`,
      command: '!ocean',
      simulated: true,
      timestamp: new Date().toISOString(),
      stats: { ...stats }
    };

    broadcast(event);

    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    return res.end(JSON.stringify(event));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
if (require.main === module) server.listen(PORT, HOST, () => {
  console.log(`AgroCeans demo bridge: http://${HOST}:${PORT}`);
});

module.exports = { server };
