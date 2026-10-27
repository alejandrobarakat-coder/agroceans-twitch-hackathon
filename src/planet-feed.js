'use strict';
function createPlanetFeed({ reports, participation, health, authorize, maxConnections = 20, maxPerAddress = 4 }) {
  const clients = new Map();
  function snapshot() {
    return { ...(reports ? reports.snapshot() : { type: 'planet.snapshot', domain: 'planet', enabled: false, status: 'disabled', reports: [], revision: 0, simulated: false }),
      liveTwitch: participation(), twitch: health() };
  }
  function remove(res) { const entry = clients.get(res); if (entry) { clearInterval(entry.timer); clients.delete(res); } }
  function write(res, name, value) {
    if (!res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)) { remove(res); res.destroy(); }
  }
  function publish(event) {
    if (!clients.size) return;
    const report = ['planet.report', 'planet.snapshot', 'planet.unavailable'].includes(event?.type);
    const participationEvent = event?.type === 'twitch_participation' && event.command === '!ocean';
    const simulation = event?.type === 'ocean_participant' && event.simulated === true;
    const status = ['twitch_status', 'twitch_revoked'].includes(event?.type);
    if (!report && !participationEvent && !simulation && !status) return;
    try {
      const data = snapshot();
      const name = report ? event.type === 'planet.report' ? 'report' : 'snapshot' : status ? 'status' : 'participation';
      const packet = { ...data, type: report ? event.type : simulation ? 'planet.simulation' : participationEvent ? 'planet.participation' : 'planet.status',
        ...(event.eventId ? { eventId: event.eventId, report: event.report } : {}), ...(simulation ? { simulated: true } : {}) };
      for (const res of clients.keys()) write(res, name, packet);
    } catch { for (const res of clients.keys()) { remove(res); res.destroy(); } }
  }
  async function handle(req, res, url) {
    if (!['/planet/snapshot', '/planet/events', '/planet/refresh'].includes(url.pathname)) return false;
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/planet/refresh') {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end('POST required'); return true; }
      if (!reports || !authorize(req)) { res.writeHead(403); res.end('Forbidden'); return true; }
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
        req.resume(); res.writeHead(400); res.end('Refresh accepts no report input'); return true;
      }
      try { const value = await reports.refresh(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
      catch { res.writeHead(502); res.end('Public report refresh unavailable'); }
      return true;
    }
    const stream = url.pathname === '/planet/events';
    if (req.method !== 'GET' && !(req.method === 'HEAD' && !stream)) {
      res.writeHead(405, { Allow: stream ? 'GET' : 'GET, HEAD' }); res.end('Read-only route'); return true;
    }
    const address = req.socket.remoteAddress;
    if (stream && (clients.size >= maxConnections || [...clients.values()].filter(row => row.address === address).length >= maxPerAddress)) {
      res.writeHead(429, { 'Retry-After': '5' }); res.end('Planet stream connection limit'); return true;
    }
    let data;
    try { data = snapshot(); } catch { res.writeHead(503); res.end('Planet snapshot unavailable'); return true; }
    if (!stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const timer = setInterval(() => { if (!res.write(': planet heartbeat\n\n')) { remove(res); res.destroy(); } }, 15000);
    timer.unref(); clients.set(res, { address, timer }); res.on('close', () => remove(res));
    res.write('retry: 2000\n\n'); write(res, 'snapshot', data); return true;
  }
  return { handle, publish, snapshot, close() { for (const res of clients.keys()) { remove(res); res.destroy(); } } };
}
module.exports = { createPlanetFeed };
