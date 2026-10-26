const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ORIGIN = 'https://twitch.theagrostore.com';
const DIRECTORY = path.resolve(__dirname, '../var/oauth-bootstrap');
const TTL = 120000;
const digest = token => crypto.createHash('sha256').update(token).digest('hex');

function createCapabilityStore({ directory = DIRECTORY, now = Date.now } = {}) {
  async function prepare() {
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    const parent = await fs.lstat(path.dirname(directory));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe bootstrap parent');
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw new Error('Unsafe bootstrap directory');
    }
  }
  return {
    async mint() {
      await prepare();
      const token = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(path.join(directory, `${digest(token)}.json`), JSON.stringify({ expires: now() + TTL }),
        { mode: 0o600, flag: 'wx' });
      return token;
    },
    async consume(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
      await prepare();
      const claimed = path.join(directory, `${digest(token)}.${crypto.randomUUID()}.claimed`);
      try {
        // Atomic rename elects exactly one consumer, including across processes.
        await fs.rename(path.join(directory, `${digest(token)}.json`), claimed);
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      try {
        const stat = await fs.lstat(claimed);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > 128) return false;
        const record = JSON.parse(await fs.readFile(claimed, 'utf8'));
        return Number.isFinite(record.expires) && record.expires > now() && record.expires <= now() + TTL;
      } finally { await fs.unlink(claimed).catch(() => {}); }
    },
    async revokeAll() {
      await prepare();
      for (const name of await fs.readdir(directory)) {
        if (/^[a-f0-9]{64}(\.json|\.[a-f0-9-]{36}\.claimed)$/.test(name)) await fs.unlink(path.join(directory, name)).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
  };
}

function createBootstrap({ enabled = false, store = createCapabilityStore(), now = Date.now } = {}) {
  let windowStart = now();
  let requests = 0;
  return async function handle(req, res, url, begin) {
    if (url.pathname !== '/auth/twitch/bootstrap') return false;
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self' https://id.twitch.tv; base-uri 'none'; frame-ancestors 'none'`);
    const reply = (status, message) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); return true; };
    if (!enabled) return reply(503, 'Browser bootstrap disabled');
    if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
    if (++requests > 30) { res.setHeader('Retry-After', '60'); return reply(429, 'Bootstrap rate limit exceeded'); }
    if (url.search) return reply(400, 'Query parameters are not accepted');
    if (req.method === 'GET') {
      // no-referrer makes navigate-mode form POSTs send Origin: null (Fetch §3.2).
      // Preserve the same-origin form's Origin; fragments never enter Referer.
      // POST/redirect responses retain no-referrer above for the Twitch navigation.
      res.setHeader('Referrer-Policy', 'same-origin');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Connect Twitch</title>
<form method="post" action="/auth/twitch/bootstrap" autocomplete="off"><input type="hidden" name="capability"><button disabled>Continue to Twitch</button></form>
<p id="status">A valid one-time operator link is required.</p>
<script nonce="${nonce}">
'use strict';
const capability = location.hash.slice(1);
history.replaceState(null, '', '/auth/twitch/bootstrap');
if (/^[a-f0-9]{64}$/.test(capability)) {
  document.querySelector('input').value = capability;
  document.querySelector('button').disabled = false;
  document.querySelector('#status').textContent = 'This operator link expires after two minutes and can be used once.';
}
addEventListener('pageshow', event => { if (event.persisted) location.replace('/auth/twitch/bootstrap'); });
</script>`);
      return true;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return reply(405, 'Method not allowed'); }
    if (req.headers.origin !== ORIGIN || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return reply(403, 'Same-origin browser submission required');
    }
    if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return reply(415, 'Form submission required');
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 256) return reply(413, 'Request too large');
        chunks.push(chunk);
      }
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if ([...fields.keys()].length !== 1 || !fields.has('capability') || !await store.consume(fields.get('capability'))) {
        return reply(400, 'Invalid, expired or already used bootstrap link');
      }
      return begin(303);
    } catch { return reply(500, 'Browser bootstrap unavailable'); }
  };
}
module.exports = { createCapabilityStore, createBootstrap, ORIGIN, TTL };
