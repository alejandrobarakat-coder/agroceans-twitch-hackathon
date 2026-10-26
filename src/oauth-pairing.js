const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'https://twitch.theagrostore.com';
const ENTRY = '/auth/twitch/connect';
const COOKIE = '__Host-twitch-pairing';
const TTL = 5 * 60 * 1000;
const DIRECTORY = path.resolve(__dirname, '../var/oauth-pairing');
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const random = () => crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => valid(a) && valid(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// All operations inside the cross-process lock are synchronous, with no network
// or user interaction. A crash leaves a lock: fail closed, never steal it by age.
function createPairingStore({ directory = DIRECTORY, now = Date.now, limit = 100 } = {}) {
  function privateDirectory(target) {
    fs.mkdirSync(target, { mode: 0o700 });
  }
  function checkDirectory(target) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw Error('Unsafe pairing directory');
    }
  }
  function transaction(fn) {
    // The repository's var parent is not a public static directory.
    const parent = path.dirname(directory);
    try { privateDirectory(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw Error('Unsafe pairing parent');
    try { privateDirectory(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkDirectory(directory);
    const lock = path.join(directory, '.lock');
    privateDirectory(lock);
    try { return fn(); } finally { fs.rmdirSync(lock); }
  }
  const file = id => path.join(directory, `${id}.json`);
  function read(id) {
    if (!valid(id)) return null;
    let fd;
    try {
      fd = fs.openSync(file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 1024) throw Error('Unsafe pairing record');
      const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!valid(record.binding) || !/^[a-f0-9]{24}$/.test(record.phrase) || !['pending', 'approved'].includes(record.status) ||
          !Number.isFinite(record.expires) || record.expires > now() + TTL) throw Error('Invalid pairing record');
      if (record.expires <= now()) { fs.unlinkSync(file(id)); return null; }
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function write(id, record) {
    const temporary = path.join(directory, `${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file(id));
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return {
    create(binding, expires) {
      if (!valid(binding) || !Number.isFinite(expires) || expires <= now() || expires > now() + TTL) throw Error('Invalid pairing');
      return transaction(() => {
        let count = 0;
        for (const name of fs.readdirSync(directory)) {
          if (/^[a-f0-9]{64}\.json$/.test(name) && read(name.slice(0, -5))) count++;
          else if (/^[a-f0-9-]{36}\.tmp$/.test(name)) fs.unlinkSync(path.join(directory, name));
        }
        if (count >= limit) throw Error('Pairing capacity reached');
        let id; do { id = random(); } while (fs.existsSync(file(id)));
        write(id, { binding, expires, phrase: crypto.randomBytes(12).toString('hex'), status: 'pending' });
        return id;
      });
    },
    inspect(id) { return transaction(() => {
      const record = read(id);
      return record ? { phrase: record.phrase, expires: record.expires, status: record.status } : null;
    }); },
    status(id, binding) { return transaction(() => {
      const record = read(id);
      return record && equal(record.binding, binding) ? { phrase: record.phrase, expires: record.expires, status: record.status } : null;
    }); },
    approve(id, phrase) { return transaction(() => {
      const record = read(id);
      if (!record || record.status !== 'pending' || record.phrase !== phrase) return false;
      write(id, { ...record, status: 'approved' }); return true;
    }); },
    consume(id, binding) { return transaction(() => {
      const record = read(id);
      if (!record || record.status !== 'approved' || !equal(record.binding, binding)) return false;
      fs.unlinkSync(file(id)); return true;
    }); },
    revokeAll() { return transaction(() => {
      for (const name of fs.readdirSync(directory)) {
        if (/^[a-f0-9]{64}\.json$/.test(name) || /^[a-f0-9-]{36}\.tmp$/.test(name)) fs.unlinkSync(path.join(directory, name));
      }
    }); }
  };
}

function createPairing({ enabled = false, store = createPairingStore(), now = Date.now } = {}) {
  const sessions = new Map();
  let windowStart = now(); let requests = 0;
  return async function handle(req, res, url, begin) {
    if (url.pathname !== ENTRY) return false;
    const nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    const reply = (status, message, type = 'text/plain') => {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` }); res.end(message); return true;
    };
    const setCookie = (value, age) => res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`);
    if (!enabled) return reply(503, 'Browser pairing disabled');
    if (url.search) return reply(400, 'Query parameters are not accepted');
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return reply(405, 'Method not allowed'); }
    if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
    if (++requests > 300) { res.setHeader('Retry-After', '60'); return reply(429, 'Pairing rate limit exceeded'); }
    for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key);
    // Reject cross-origin loads as well as submissions, including sibling sites.
    if ((req.headers.origin && req.headers.origin !== ORIGIN) ||
        (req.headers['sec-fetch-site'] && !['same-origin', ...(req.method === 'GET' ? ['none'] : [])].includes(req.headers['sec-fetch-site']))) {
      return reply(403, 'Same-origin browser required');
    }
    const cookies = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${COOKIE}=`));
    const binding = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : '';
    const key = valid(binding) ? hash(binding) : '';
    let session = sessions.get(key);
    try {
      if (req.method === 'GET') {
        if (cookies.length > 1) return reply(400, 'Ambiguous browser session');
        if (!session) {
          if (sessions.size >= 100) return reply(429, 'Too many pending browser sessions');
          const value = random(); session = { csrf: random(), expires: now() + TTL, id: null, lastPoll: -Infinity };
          sessions.set(hash(value), session); setCookie(value, TTL / 1000);
        }
        // Native same-origin navigation POST must retain its non-null Origin.
        res.setHeader('Referrer-Policy', 'same-origin');
        const action = session.id ? 'continue' : 'create';
        return reply(200, `<!doctype html><meta charset="utf-8"><title>Connect Twitch</title>
<h1>Connect Twitch</h1><p>Demo authorization only. No payments or EventSub are enabled.</p>
<p id="status">${session.id ? 'Waiting for local operator approval.' : 'Create a request, then approve it from your private VPS terminal.'}</p>
<pre id="request"></pre><p id="phrase"></p>
<form method="post" action="${ENTRY}" autocomplete="off"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="action" value="${action}"><button${session.id ? ' disabled' : ''}>${session.id ? 'Continue to Twitch' : 'Create pairing request'}</button></form>
<p>Compare the phrase in this browser with the CLI. Never approve requests sent by another person. Requests expire within five minutes.</p>
<script nonce="${nonce}">
'use strict';
const form = document.querySelector('form');
const button = document.querySelector('button');
const deadline = ${session.expires};
let stopped = false;
form.addEventListener('submit', () => { stopped = true; button.disabled = true; });
async function poll() {
  if (stopped) return;
  if (Date.now() >= deadline) { button.disabled = true; document.querySelector('#status').textContent = 'Request expired. Reload to start again.'; return; }
  let retryDelay = 3000;
  try {
    const response = await fetch('${ENTRY}', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'status', csrf: '${session.csrf}' }) });
    if (!response.ok) {
      if (response.status !== 429 && response.status < 500) {
        button.disabled = true;
        document.querySelector('#status').textContent = 'Pairing unavailable or expired. Reload to check or start again.';
        return;
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryDelay = Math.min(60000, Math.max(3000, retryAfter * 1000));
      throw Error();
    }
    const data = await response.json();
    if (stopped || Date.now() >= deadline) return;
    document.querySelector('#request').textContent = 'Request: ' + data.id;
    document.querySelector('#phrase').textContent = 'Comparison phrase: ' + data.phrase;
    document.querySelector('#status').textContent = data.status === 'approved' ? 'Approved. Continue in this browser.' : 'Waiting for local operator approval.';
    button.disabled = data.status !== 'approved';
    if (data.status === 'approved') return;
  } catch { button.disabled = true; document.querySelector('#status').textContent = 'Status check temporarily unavailable. Retrying until this request expires.'; }
  if (!stopped) setTimeout(poll, Math.min(retryDelay, Math.max(0, deadline - Date.now())));
}
${session.id ? 'poll();' : ''}
addEventListener('pageshow', event => { if (event.persisted) location.replace('${ENTRY}'); });
</script>`, 'text/html');
      }
      if (req.headers.origin !== ORIGIN || !session) return reply(403, 'Browser session and exact Origin required');
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return reply(415, 'Form submission required');
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; if (size > 256) return reply(413, 'Request too large'); chunks.push(chunk);
      }
      // Recheck expiry after the asynchronous body read.
      if (session.expires <= now() || sessions.get(key) !== session) return reply(403, 'Browser session expired');
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if ([...fields.keys()].length !== 2 || !fields.has('action') || !fields.has('csrf')) return reply(400, 'Invalid pairing form');
      if (!equal(fields.get('csrf'), session.csrf)) return reply(403, 'Invalid CSRF token');
      const action = fields.get('action');
      if (action === 'create') {
        if (session.id) return reply(409, 'A pairing request already exists');
        session.id = store.create(key, session.expires);
        res.setHeader('Location', ENTRY); return reply(303, 'Pairing created');
      }
      if (!session.id) return reply(409, 'Create a pairing request first');
      if (action === 'status') {
        if (now() - session.lastPoll < 2000) return reply(429, 'Poll no more than once every two seconds');
        session.lastPoll = now();
        const record = store.status(session.id, key);
        if (!record) { sessions.delete(key); setCookie('', 0); return reply(410, 'Pairing expired or revoked'); }
        return reply(200, JSON.stringify({ id: session.id, ...record }), 'application/json');
      }
      if (action === 'continue') {
        if (!store.consume(session.id, key)) return reply(409, 'Pairing is unapproved, expired or already used');
        sessions.delete(key); setCookie('', 0);
        // Commit a document before navigating to Twitch. Chrome applies the
        // submitting page's form-action to the entire HTTP redirect chain.
        return begin(200);
      }
      return reply(400, 'Unknown pairing action');
    } catch { return reply(503, 'Browser pairing unavailable'); }
  };
}
module.exports = { createPairingStore, createPairing, ORIGIN, ENTRY, COOKIE, TTL, hash };
