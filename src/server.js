const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 8766;
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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
      mode: 'simulation',
      twitchConnected: false,
      blockchainConnected: false
    }));
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    clients.add(res);
    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      stats
    })}\n\n`);

    req.on('close', () => clients.delete(res));
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

server.listen(PORT, HOST, () => {
  console.log(`AgroCeans demo bridge: http://${HOST}:${PORT}`);
});
