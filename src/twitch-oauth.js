const crypto = require('node:crypto');
const { createBootstrap } = require('./oauth-bootstrap');
const { createPairing, ENTRY } = require('./oauth-pairing');
const fs = require('node:fs/promises');
const path = require('node:path');

const REDIRECT_URI = 'https://twitch.theagrostore.com/auth/twitch/callback';
const COOKIE = '__Host-twitch-oauth';
const TTL = 10 * 60 * 1000;
const DIRECTORY = path.resolve(__dirname, '../var/twitch-oauth');

async function rejectionCategory(response) {
  if (response.status === 429) return 'provider_rate_limited';
  if (response.status >= 500) return 'provider_unavailable';
  // Exact allowlist only: provider messages may contain reflected credentials.
  const categories = new Map([
    ['invalid_client', 'client_rejected'], ['invalid client', 'client_rejected'],
    ['invalid client secret', 'client_rejected'], ['invalid client id', 'client_rejected'],
    ['invalid_grant', 'authorization_code_rejected'], ['invalid authorization code', 'authorization_code_rejected'],
    ['redirect_uri mismatch', 'redirect_uri_rejected'], ['redirect uri mismatch', 'redirect_uri_rejected'],
    ['invalid_request', 'request_rejected'], ['unsupported_grant_type', 'request_rejected']
  ]);
  try {
    const body = await response.json();
    for (const value of [body?.error, body?.message]) {
      if (typeof value === 'string' && categories.has(value.toLowerCase())) return categories.get(value.toLowerCase());
    }
  } catch { /* Never log raw bodies or parse errors. */ }
  return 'http_rejected';
}

async function storeCredentials(credentials, directory = DIRECTORY) {
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const parent = await fs.lstat(path.dirname(directory));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe credential parent');
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Unsafe credential directory');
  const temporary = path.join(directory, `${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(directory, 'credentials.json'));
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function createTwitchOAuth({ clientId, clientSecret, scopes = '', authorize,
  fetchImpl = globalThis.fetch, now = Date.now, store = storeCredentials,
  bootstrapEnabled = false, capabilityStore, pairingEnabled = false, pairingStore,
  reportExchangeFailure = record => console.warn(JSON.stringify(record)) } = {}) {
  const pending = new Map();
  const bootstrap = createBootstrap({ enabled: bootstrapEnabled, store: capabilityStore, now });
  const pairing = createPairing({ enabled: pairingEnabled, store: pairingStore, now });
  const cookie = (value, age) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
  return async function handle(req, res, url) {
    if (!['/auth/twitch/start', '/auth/twitch/callback', '/auth/twitch/bootstrap', ENTRY].includes(url.pathname)) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const reply = (status, message) => { res.writeHead(status); res.end(message); return true; };
    const begin = (status = 302) => {
      for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key);
      if (pending.size >= 1000) return reply(429, 'Too many pending authorizations');
      const state = crypto.randomBytes(32).toString('hex');
      const binding = crypto.randomBytes(32).toString('hex');
      pending.set(state, { binding, expires: now() + TTL });
      const target = new URL('https://id.twitch.tv/oauth2/authorize');
      target.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI,
        response_type: 'code', scope: scopes, state }).toString();
      // Pairing clears its own cookie in the same redirect response.
      const previous = res.getHeader?.('Set-Cookie');
      res.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), cookie(binding, TTL / 1000)] : cookie(binding, TTL / 1000));
      if (status === 200) {
        // End the same-origin form navigation here. A fresh document's script
        // (or normal fallback link) starts a GET, outside form-action checks on
        // Twitch's subsequent login redirects. The destination is server-built.
        const nonce = crypto.randomBytes(16).toString('base64');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
        return reply(200, `<!doctype html><meta charset="utf-8"><title>Continue to Twitch</title>
<p>Opening Twitch authorization. If you stay on this page, <a href="${target.href.replaceAll('&', '&amp;')}" rel="noreferrer">continue to Twitch</a>.</p>
<script nonce="${nonce}">location.replace(${JSON.stringify(target.href).replaceAll('<', '\\u003c')});</script>`);
      }
      res.setHeader('Location', target.href);
      return reply(status, 'Redirecting to Twitch');
    };
    if (url.pathname === ENTRY) {
      if (!clientId || !clientSecret) return reply(503, 'Twitch OAuth is not configured');
      return pairing(req, res, url, begin);
    }
    if (url.pathname === '/auth/twitch/bootstrap') {
      if (!clientId || !clientSecret) return reply(503, 'Twitch OAuth is not configured');
      return bootstrap(req, res, url, begin);
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, 'Method not allowed'); }
    if (!clientId || !clientSecret) return reply(503, 'Twitch OAuth is not configured');
    if (url.pathname === '/auth/twitch/start') {
      if (!authorize?.(req)) return reply(403, 'Operator authorization required');
      return begin();
    }
    res.setHeader('Set-Cookie', cookie('', 0));
    const state = url.searchParams.get('state');
    const entry = pending.get(state);
    const bindings = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${COOKIE}=`));
    const binding = bindings.length === 1 ? bindings[0].slice(COOKIE.length + 1) : '';
    if (!entry || url.searchParams.getAll('state').length !== 1 || !/^[a-f0-9]{64}$/.test(binding) ||
        !crypto.timingSafeEqual(Buffer.from(binding), Buffer.from(entry.binding))) {
      return reply(400, 'Invalid OAuth state or browser session; start authorization again');
    }
    pending.delete(state); // Consume before any asynchronous operation, including failed exchanges.
    if (entry.expires <= now()) return reply(400, 'OAuth state expired; start authorization again');
    if (url.searchParams.has('error')) return reply(400, 'Twitch authorization was declined or failed');
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.getAll('code').length !== 1 || code.length > 2048) return reply(400, 'Missing or invalid authorization code');
    let tokens;
    let upstreamStatus = null;
    let failureCategory = 'transport_failure';
    const exchangeFailed = category => {
      // Never pass request/provider objects, URLs, codes, tokens or exceptions.
      try { reportExchangeFailure({ event: 'twitch_oauth_exchange_failure', status: upstreamStatus, category }); } catch { /* Diagnostic failure must not change OAuth behavior. */ }
      return reply(502, 'Twitch token exchange failed; start authorization again');
    };
    try {
      const response = await fetchImpl('https://id.twitch.tv/oauth2/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code,
          grant_type: 'authorization_code', redirect_uri: REDIRECT_URI })
      });
      upstreamStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      if (!response.ok) return exchangeFailed(await rejectionCategory(response));
      failureCategory = 'invalid_json';
      tokens = await response.json();
      failureCategory = 'invalid_token_response';
      // OAuth 2.0 permits omitted scope when unchanged (RFC 6749 §5.1).
      // Only infer the unambiguous empty set; never invent nonempty permissions.
      if (tokens && tokens.scope === undefined && !scopes.trim()) tokens.scope = [];
      if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
          typeof tokens.refresh_token !== 'string' || !tokens.refresh_token ||
          tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 ||
          !Array.isArray(tokens.scope) || !tokens.scope.every(scope => typeof scope === 'string')) throw new Error('Invalid token response');
    } catch (error) {
      if (failureCategory === 'transport_failure' && ['TimeoutError', 'AbortError'].includes(error?.name)) failureCategory = 'transport_timeout';
      return exchangeFailed(failureCategory);
    }
    try {
      await store({ access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        token_type: 'bearer', scope: tokens.scope, expires_at: now() + tokens.expires_in * 1000 });
    } catch { return reply(500, 'Unable to securely save Twitch credentials; start authorization again'); }
    return reply(200, 'Twitch authorization completed. Credentials saved securely on the server.');
  };
}
module.exports = { createTwitchOAuth, storeCredentials, REDIRECT_URI };
