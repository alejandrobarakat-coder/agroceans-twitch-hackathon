'use strict';
// Individual identity pairing. Never reads or writes the broadcaster credentials.
const crypto = require('node:crypto');
const ORIGIN = 'https://twitch.theagrostore.com';
const CALLBACK = ORIGIN + '/auth/twitch/callback';
const PREFIX = '/auth/twitch/user/';
const APP = '__Host-agro-twitch-user';
const BROWSER = '__Host-agro-twitch-browser';
const TTL = 10 * 60 * 1000;
const CHAT_SCOPE = 'user:write:chat';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const random = () => crypto.randomBytes(32).toString('hex');
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const valid = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function readCookie(req, name) {
  const values = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
  return valid(value) ? value : null;
}
function createTwitchUserOAuth({ clientId, clientSecret, broadcasterId, fetchImpl = globalThis.fetch, now = Date.now, capacity = 200, storage = null } = {}) {
  const devices = new Map(), tickets = new Map(), states = new Map();
  let messages = [];
  function observeChat(message) {
    messages = messages.filter(x => x.at > now() - 10 * 60 * 1000);
    if (!message || typeof message.id !== "string" || !message.id || message.id.length > 160 ||
        typeof message.login !== "string" || !/^[a-zA-Z0-9_]{1,40}$/.test(message.login) ||
        typeof message.text !== "string" || message.text.length > 2000 || messages.some(x => x.id === message.id)) return;
    messages.push({ id: message.id, login: message.login, text: message.text, at: now() });
    if (messages.length > 100) messages.splice(0, messages.length - 100);
  }
  let rateStart = now(), requests = 0;
  let loaded = false;
  function restore() {
    if (loaded) return;
    if (storage) {
      storage.prepare();
      const data = storage.read('identities.json', { version: 1, sessions: [] });
      if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > capacity) throw Error('Invalid identity storage');
      const restored = new Map();
      for (const [key, value] of data.sessions) {
        if (!valid(key) || value?.status !== 'connected' || !Number.isFinite(value.expires) ||
            value.expires > now() + SESSION_TTL || !/^\d{1,30}$/.test(value.identity?.id || '') ||
            !/^[a-zA-Z0-9_]{1,30}$/.test(value.identity?.login || '')) throw Error('Invalid identity record');
        if (value.expires > now()) restored.set(key, { status: 'connected', expires: value.expires,
          identity: { id: value.identity.id, login: value.identity.login } });
      }
      const authorizations = storage.read('authorizations.json', { version: 1, sessions: [] });
      if (authorizations.version !== 1 || !Array.isArray(authorizations.sessions) || authorizations.sessions.length > capacity) throw Error('Invalid authorization storage');
      for (const [key, auth] of authorizations.sessions) {
        if (!valid(key) || !validAuth(auth)) throw Error('Invalid authorization');
        if (restored.has(key)) restored.get(key).auth = auth;
      }
      for (const [key, value] of restored) devices.set(key, value);
    }
    loaded = true;
  }
  function remember() {
    if (!storage) return;
    storage.transaction(() => {
      const live = [...devices].filter(([, value]) => value.status === 'connected' && value.expires > now());
      storage.write('identities.json', { version: 1, sessions: live.map(([key, value]) => [key,
        { status: 'connected', expires: value.expires, identity: value.identity }]) });
      storage.write('authorizations.json', { version: 1, sessions: live.filter(([, value]) => value.auth).map(([key, value]) => [key, value.auth]) });
    });
  }

  function sweep() {
    for (const map of [devices, tickets, states]) for (const [key, entry] of map) if (entry.expires <= now()) map.delete(key);
  }
  async function jsonFetch(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { const error = Error('Provider failure'); error.status = response.status; throw error; }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 65536) throw Error('Provider response too large'); chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function validAuth(auth) {
    return auth && typeof auth.access === 'string' && auth.access.length > 0 && auth.access.length <= 4096 &&
      typeof auth.refresh === 'string' && auth.refresh.length > 0 && auth.refresh.length <= 4096 &&
      Number.isFinite(auth.expires) && Array.isArray(auth.scopes) && auth.scopes.every(s => typeof s === 'string');
  }
  function authFrom(tokens) {
    const auth = { access: tokens.access_token, refresh: tokens.refresh_token,
      expires: now() + tokens.expires_in * 1000, scopes: tokens.scope };
    if (tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || !validAuth(auth) || !auth.scopes.includes(CHAT_SCOPE)) throw Error('Invalid token');
    return auth;
  }
  function validateIdentity(identity, expectedId = null) {
    if (identity.client_id !== clientId || !/^\d{1,30}$/.test(identity.user_id || '') ||
        !/^[a-zA-Z0-9_]{1,30}$/.test(identity.login || '') || !Number.isFinite(identity.expires_in) || identity.expires_in <= 0 ||
        (expectedId && identity.user_id !== expectedId) || !Array.isArray(identity.scopes) || !identity.scopes.includes(CHAT_SCOPE)) throw Error('Invalid identity');
  }
  async function accessFor(device) {
    async function refresh() {
      const result = await jsonFetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
          grant_type: 'refresh_token', refresh_token: device.auth.refresh }) });
      device.auth = authFrom(result); remember();
    }
    if (device.auth.expires <= now() + 30000) await refresh();
    let identity;
    try { identity = await jsonFetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + device.auth.access } }); }
    catch (error) {
      if (error.status !== 401) throw error;
      await refresh();
      identity = await jsonFetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + device.auth.access } });
    }
    validateIdentity(identity, device.identity.id);
    return device.auth.access;
  }
  const handle = async function handle(req, res, url) {
    const isCallback = url.pathname === '/auth/twitch/callback' && url.searchParams.getAll('state').some(s => s.startsWith('u_'));
    const isUserStart = url.pathname === '/auth/twitch/start' && url.searchParams.has('user_ticket');
    if (!url.pathname.startsWith(PREFIX) && !isCallback && !isUserStart) return false;
    sweep();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const reply = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body); return true;
    };
    if (!clientId || !clientSecret) return reply(503, { error: 'User authorization unavailable' });
    try { restore(); } catch { return reply(503, { error: 'Account storage unavailable' }); }
    const action = isUserStart ? 'start' : url.pathname.slice(PREFIX.length);
    const allowed = isCallback || ['start', 'status', 'messages'].includes(action) ? 'GET' : 'POST';
    if (!isCallback && !['request', 'start', 'status', 'confirm', 'logout', 'send', 'messages'].includes(action)) return reply(404, { error: 'Not found' });
    if (req.method !== allowed) { res.setHeader('Allow', allowed); return reply(405, { error: 'Method not allowed' }); }
    if (req.method === 'POST' && (req.headers.origin !== ORIGIN || req.headers['content-type'] !== 'application/json')) return reply(403, { error: 'Same-origin JSON request required' });
    if (action !== 'start' && !isCallback && url.search) return reply(400, { error: 'Unexpected query' });
    const appCookie = readCookie(req, APP);
    const appKey = appCookie && digest(appCookie);
    const device = devices.get(appKey);
    if (action === 'request' && !isCallback) {
      if (now() - rateStart >= 60000) { rateStart = now(); requests = 0; }
      if (++requests > 60 || devices.size >= capacity || tickets.size >= capacity || states.size >= capacity) return reply(429, { error: 'Try again later' });
      // Invalidate the caller's previous pending flow, so stale windows cannot replace it.
      if (appKey) devices.delete(appKey);
      try { remember(); } catch { return reply(503, { error: 'Account storage unavailable' }); }
      const secret = random(), key = digest(secret), ticket = random(), expires = now() + TTL;
      devices.set(key, { status: 'pending', expires });
      tickets.set(digest(ticket), { key, expires });
      res.setHeader('Set-Cookie', cookie(APP, secret, (TTL + SESSION_TTL) / 1000));
      return reply(200, { authorizeUrl: ORIGIN + '/auth/twitch/start?user_ticket=' + ticket });
    }
    if (action === 'start' && !isCallback) {
      if (!isUserStart) return reply(400, { error: 'Invalid authorization request' });
      const ticket = url.searchParams.get('user_ticket');
      const native = url.searchParams.get('native');
      const nativeState = url.searchParams.get('native_state');
      const keys = [...url.searchParams.keys()];
      const nativeRequest = native === '1' && valid(nativeState) && keys.length === 3 &&
        ['user_ticket', 'native', 'native_state'].every(key => url.searchParams.getAll(key).length === 1);
      const browserRequest = keys.length === 1 && native === null && nativeState === null;
      if (!valid(ticket) || (!nativeRequest && !browserRequest)) return reply(400, { error: 'Invalid authorization request' });
      const record = tickets.get(digest(ticket));
      if (!record || !devices.has(record.key)) return reply(400, { error: 'Authorization expired; return to Live' });
      tickets.delete(digest(ticket));
      const binding = random(), state = 'u_' + random();
      states.set(state, { key: record.key, binding: digest(binding), expires: record.expires, nativeState: nativeRequest ? nativeState : null });
      const target = new URL('https://id.twitch.tv/oauth2/authorize');
      target.search = new URLSearchParams({ client_id: clientId, redirect_uri: CALLBACK, response_type: 'code', scope: CHAT_SCOPE, state, force_verify: 'true' }).toString();
      res.setHeader('Set-Cookie', cookie(BROWSER, binding, TTL / 1000));
      res.setHeader('Location', target.href); return reply(302, { status: 'redirecting' });
    }
    if (isCallback) {
      const state = url.searchParams.get('state'), record = states.get(state), binding = readCookie(req, BROWSER);
      if (url.searchParams.getAll('state').length !== 1 || !record || !binding || digest(binding) !== record.binding) return reply(400, { error: 'Invalid browser authorization; start again' });
      states.delete(state);
      res.setHeader('Set-Cookie', cookie(BROWSER, '', 0));
      const target = devices.get(record.key);
      if (!target || target.status !== 'pending') return reply(400, { error: 'Authorization expired' });
      const nativeReply = outcome => {
        const destination = new URL('agroceanstwitch://callback');
        destination.search = new URLSearchParams({ state: record.nativeState, result: outcome }).toString();
        res.setHeader('Location', destination.href);
        return reply(302, { status: 'returning_to_app' });
      };
      const fail = () => {
        target.status = 'failed';
        return record.nativeState ? nativeReply('error') : reply(400, { error: 'Twitch authorization failed; return to Live and retry' });
      };
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !code || code.length > 2048) return fail();
      try {
        const tokens = await jsonFetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: CALLBACK })
        });
        const auth = authFrom(tokens);
        const identity = await jsonFetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + auth.access } });
        validateIdentity(identity);
        // Recheck after network awaits. No token is persisted or sent to the app.
        if (devices.get(record.key) !== target || target.expires <= now()) throw Error('Expired');
        target.status = 'connected'; target.identity = { id: identity.user_id, login: identity.login };
        target.expires = now() + SESSION_TTL;
        target.auth = auth;
        remember();
        if (record.nativeState) return nativeReply('success');
        return reply(200, '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Twitch connected</title><h1>Twitch connected</h1><p>Your account is connected. Close this browser tab to return to Live.</p><p><a href="agroceans://live">Return to AgroCeans</a></p></html>', 'text/html');
      } catch { return fail(); }
    }
    if (action === 'send') {
      if (!device || device.status !== 'connected' || !device.auth?.scopes.includes(CHAT_SCOPE)) return reply(401, { error: 'Connect Twitch to send messages.' });
      if (!/^\d{1,30}$/.test(broadcasterId || '')) return reply(503, { error: 'Chat is temporarily unavailable.' });
      if (device.sending || now() < (device.nextSendAt || 0)) return reply(429, { error: 'Please wait before sending another message.' });
      device.sending = true;
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 4096) return reply(413, { error: 'Message is too long.' }); chunks.push(Buffer.from(chunk)); }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'Enter a message.' }); }
        if (!input || typeof input !== 'object' || Object.keys(input).length !== 1 || typeof input.message !== 'string' || !input.message.trim() || [...input.message.trim()].length > 500) return reply(400, { error: 'Enter a message of up to 500 characters.' });
        const access = await accessFor(device);
        if (devices.get(appKey) !== device || device.expires <= now()) return reply(401, { error: 'Connect Twitch again.' });
        device.nextSendAt = now() + 1500;
        // Never retry message POSTs, including ambiguous network failures.
        const sent = await jsonFetch('https://api.twitch.tv/helix/chat/messages', {
          method: 'POST', headers: { Authorization: 'Bearer ' + access, 'Client-Id': clientId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: device.identity.id, message: input.message.trim() }) });
        if (!Array.isArray(sent.data) || sent.data.length !== 1 || sent.data[0].is_sent !== true || typeof sent.data[0].message_id !== 'string') return reply(409, { error: 'Twitch did not send this message. Check channel restrictions.' });
        observeChat({ id: sent.data[0].message_id, login: device.identity.login, text: input.message.trim() });
        return reply(200, { sent: true });
      } catch (error) {
        return reply(502, { error: 'Delivery could not be confirmed. Check chat before sending again.' });
      } finally { device.sending = false; }
    }
    if (action === 'messages') {
      messages = messages.filter(x => x.at > now() - 10 * 60 * 1000);
      return reply(200, { messages });
    }
    if (action === 'status') return reply(200, device ? { status: device.status, identity: device.identity || null, chatReady: Boolean(device.status === 'connected' && device.auth?.scopes.includes(CHAT_SCOPE)) } : { status: 'disconnected', identity: null, chatReady: false });
    if (action === 'logout') {
      if (appKey) devices.delete(appKey);
      try { remember(); } catch { return reply(503, { error: 'Account storage unavailable' }); }
      res.setHeader('Set-Cookie', cookie(APP, '', 0)); return reply(200, { status: 'disconnected' });
    }
    if (action === 'confirm') {
      if (!device || device.status !== 'confirm') return reply(409, { error: 'No account awaiting confirmation' });
      device.status = 'connected';
      try { remember(); } catch { return reply(503, { error: 'Account storage unavailable' }); }
      return reply(200, { status: 'connected', identity: device.identity });
    }
    return reply(404, { error: 'Not found' });
  };
  handle.observeChat = observeChat;
  return handle;
}
module.exports = { createTwitchUserOAuth };
