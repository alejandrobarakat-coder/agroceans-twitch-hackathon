const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createTwitchOAuth } = require('./twitch-oauth');
const { createTwitchUserOAuth } = require('./twitch-user-oauth');
const { TwitchStorage } = require('./twitch-storage');
const { RewardEngine } = require('./integration');
const { AgroExplorerClient, EcosystemReader } = require('./ecosystem');
const { createPlanetReports } = require('./planet-reports');
const { createPlanetFeed } = require('./planet-feed');
const { createTwitchChat, eventSubHandler } = require('./twitch-chat');
const { createChessDemo } = require('./chess-demo');
const { createJudgeDemos } = require('./judge-demos');
function createBridge({ env = process.env, twitchFactory = createTwitchChat, chessDemoOptions = {}, planetReportsFactory = createPlanetReports } = {}) {
  const clients = new Set();
  let chessDemo;
  let planetFeed;
  let judgeDemos;
  let ecosystemSnapshot = null;
  let twitchUserOAuth;

  let stats = {
    participants: 0,
    missions: 0,
    stamps: 0,
    agro: 0
  };

  function broadcast(event) {
    chessDemo?.publish(event);
    planetFeed?.publish(event);
    judgeDemos?.publish(event);
    if (event.type === 'planet.unavailable' && ecosystemSnapshot) ecosystemSnapshot = { ...ecosystemSnapshot, reports: [], transactions: [] };
    if (event.type?.startsWith('planet.')) return;
    if (event.domain === 'chess' || event.type?.startsWith('chess.')) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of clients) {
      client.write(payload);
    }
  }

  const list = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
  let refreshPending = null;
  const planetReports = planetReportsFactory({ env, publish: broadcast });
  const reader = env.AGRO_EXPLORER_URL ? new EcosystemReader({
    explorer: new AgroExplorerClient(env.AGRO_EXPLORER_URL),
    // Tracking alone includes private reports. Only the public-gated Stage 4
    // reader may supply reports to the legacy ecosystem view.
    reports: planetReports ? { tracking: async () => (await planetReports.refresh()).reports } : null,
    folios: list(env.AGRO_PUBLIC_REPORT_FOLIOS),
    transactionIds: list(env.AGRO_PUBLIC_TRANSACTION_IDS)
  }) : null;
  const twitchChat = env.TWITCH_EVENTS_ENABLED === 'true' ? twitchFactory({ env, publish: broadcast, observeChat: message => twitchUserOAuth?.observeChat(message) }) : null;
  chessDemo = createChessDemo({
    snapshot: () => env.CHESS_SESSION_ENABLED === 'true' ? twitchChat?.chessSnapshot?.() : null,
    health: () => twitchChat?.health() || { twitchConnected: false, twitchSubscriptionStatus: 'disabled' },
    ...chessDemoOptions
  });
  const twitchIngress = eventSubHandler(twitchChat);
  planetFeed = createPlanetFeed({ reports: planetReports, authorize: authenticated,
    participation: () => twitchChat ? twitchChat.snapshot() : { commands: 0, uniqueParticipants: 0, lastEventAt: null },
    health: () => {
      const value = twitchChat?.health();
      return { connected: value?.twitchConnected === true, subscription: value?.twitchSubscriptionStatus || 'disabled' };
    }
  });
  judgeDemos = createJudgeDemos({ enabled: env.JUDGE_DEMOS_ENABLED === 'true',
    chess: () => chessDemo.snapshot(), planet: () => planetFeed.snapshot() });
  let engine;
  let integrationClients;
  if (env.AGRO_INTEGRATION_MODULE) {
    const modulePath = path.resolve(env.AGRO_INTEGRATION_MODULE);
    const root = path.resolve(__dirname, '..') + path.sep;
    if (!modulePath.startsWith(root)) throw new Error('Adapter module must be inside this repository');
    integrationClients = require(modulePath);
    engine = new RewardEngine({
      directory: path.resolve(__dirname, '../var/integration'), clients: integrationClients,
      enabled: env.AGRO_REAL_PAYMENTS_ENABLED === 'true',
      authorized: env.AGRO_PAYMENT_AUTHORIZATION === 'I_AUTHORIZE_REAL_PAYMENTS',
      maxRewardUnits: env.AGRO_MAX_REWARD_UNITS || '0',
      dailyLimitUnits: env.AGRO_DAILY_LIMIT_UNITS || '0', publish: broadcast
    });
  }
  function authenticated(req) {
    const expected = env.AGRO_OPERATOR_TOKEN;
    const actual = req.headers.authorization || '';
    return expected && expected.length >= 32 && Buffer.byteLength(actual) === Buffer.byteLength('Bearer ' + expected) &&
      crypto.timingSafeEqual(Buffer.from(actual), Buffer.from('Bearer ' + expected));
  }
  twitchUserOAuth = createTwitchUserOAuth({
    storage: new TwitchStorage(path.resolve(__dirname, '../var/twitch-user-identities')),
    broadcasterId: env.TWITCH_BROADCASTER_ID,
    clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET
  });
  const twitchOAuth = createTwitchOAuth({
    clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET,
    scopes: env.TWITCH_OAUTH_SCOPES || '', authorize: authenticated,
    bootstrapEnabled: env.TWITCH_OAUTH_BOOTSTRAP_ENABLED === 'true',
    pairingEnabled: env.TWITCH_OAUTH_PAIRING_ENABLED === 'true'
  });
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('Body too large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (chessDemo.handle(req, res, url)) return;
    if (judgeDemos.handle(req, res, url)) return;
    if (await planetFeed.handle(req, res, url)) return;

    if (url.pathname === '/planet/chain-proofs') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        return res.end('Method not allowed');
      }
      try {
        const policy = JSON.parse(fs.readFileSync(
          path.join(__dirname, '../var/planet-policy/approved-reports.json'), 'utf8'));
        const proof = JSON.parse(fs.readFileSync(
          path.join(__dirname, '../var/planet-policy/confirmed-chain-proofs.json'), 'utf8'));

        if (proof.schema !== 'agroceans.public-chain-proof.v1' ||
            proof.simulated !== false ||
            !Array.isArray(proof.reports) ||
            !Array.isArray(policy.reports)) throw Error('Invalid proof');

        const allowed = new Map(policy.reports.map(r => [r.folio, r.postId]));
        const tx = x => typeof x === 'string' && /^[a-fA-F0-9]{64}$/.test(x);
        const valid = x => x &&
          allowed.has(x.folio) &&
          allowed.get(x.folio) === x.postId &&
          x.stamp?.status === 'confirmed' &&
          x.reward?.status === 'confirmed' &&
          tx(x.stamp.txid) && tx(x.reward.txid) &&
          Number.isInteger(x.stamp.confirmations) &&
          Number.isInteger(x.reward.confirmations) &&
          x.stamp.confirmations >= 6 &&
          x.reward.confirmations >= 6;

        const reports = proof.reports.filter(valid).map(x => ({
          folio: x.folio,
          postId: x.postId,
          stamp: {
            status: 'confirmed',
            categoryCode: x.stamp.categoryCode,
            txid: x.stamp.txid,
            confirmations: x.stamp.confirmations
          },
          reward: {
            status: 'confirmed',
            txid: x.reward.txid,
            confirmations: x.reward.confirmations
          }
        }));

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify({
          schema: proof.schema,
          simulated: false,
          generatedAt: proof.generatedAt,
          reports
        }));
      } catch {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify({
          error: 'Chain proof unavailable'
        }));
      }
    }

    if (await twitchUserOAuth(req, res, url)) return;
    if (await twitchOAuth(req, res, url)) return;
    if (await twitchIngress(req, res, url)) return;
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
    // Public hackathon pages: explicit allowlist, no directory browsing.
    const publicPages = {
      '/pinche-live': 'pinche-live.html',
      '/': 'index.html',
      '/overlay.html': 'overlay.html',
      '/planet/reports': 'planet-reports.html',
      '/planet/proofs': 'planet-proofs.html',
      '/chess-replays.json': 'chess-replays.json',
      '/chess.html': 'chess.html',
      '/chess.css': 'chess.css',
      '/chess.js': 'chess.js',
      '/editorial.html': 'editorial.html',
      '/judge-chess.html': 'judge-chess.html',
      '/judge-planet.html': 'judge-planet.html',
      '/judges.css': 'judges.css',
      '/judges.js': 'judges.js'
    };
    if ((req.method === 'GET' || req.method === 'HEAD') &&
        Object.prototype.hasOwnProperty.call(publicPages, url.pathname)) {
      const filename = publicPages[url.pathname];
      const file = path.join(__dirname, '../public', filename);
      const contentType = filename.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : filename.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
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
        ...(twitchChat ? twitchChat.health() : { twitchConnected: false, twitchIngressConfigured: false, twitchSubscriptionStatus: 'disabled' }),
        blockchainConnected: Boolean(ecosystemSnapshot?.chain),
        blockchainObservedAt: ecosystemSnapshot?.chain?.observedAt || null
      }));
    }

    if (url.pathname === '/events') {
      let liveTwitch;
      try {
        liveTwitch = twitchChat ? twitchChat.snapshot() : { commands: 0, uniqueParticipants: 0, lastEventAt: null };
      }
      catch { res.writeHead(503); return res.end('Twitch snapshot temporarily unavailable'); }
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
        ecosystem: ecosystemSnapshot,
        liveTwitch,
        twitchStatus: twitchChat ? twitchChat.health() : { twitchConnected: false, twitchSubscriptionStatus: 'disabled' }
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

      const expectedToken = env.AGRO_DEMO_TOKEN;
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
  server.on('listening', () => twitchChat?.start());

  server.on('close', () => { twitchChat?.stop(); chessDemo.close(); planetFeed.close(); judgeDemos.close(); });
  return server;
}

const server = createBridge();
if (require.main === module) server.listen(Number(process.env.PORT || 8766), '127.0.0.1', () => {
  console.log('AgroCeans demo bridge listening on loopback');
});
module.exports = { server, createBridge };
