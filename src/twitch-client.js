'use strict';
const path = require('node:path');
const { TwitchFault, readPrivate, digest } = require('./twitch-storage');
const REQUIRED = ['user:read:chat', 'user:bot', 'channel:bot'];
const USER_FILE = path.resolve(__dirname, '../var/twitch-oauth/credentials.json');
const id = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const check = (ok, category) => { if (!ok) throw new TwitchFault(category); };
class TwitchClient {
  constructor({ clientId, clientSecret, fetchImpl = fetch }) { this.clientId = clientId; this.clientSecret = clientSecret; this.fetch = fetchImpl; this.app = null; }
  async request(url, options = {}) {
    let response;
    const { expectedStatus = 200, ...request } = options;
    try { response = await this.fetch(url, { ...request, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new TwitchFault('transport_failure'); }
    if (!response.ok) throw new TwitchFault(response.status === 401 ? 'credentials_rejected' : response.status === 429 ? 'rate_limited' : response.status === 409 ? 'subscription_conflict' : response.status >= 500 ? 'provider_unavailable' : 'request_rejected', response.status);
    check(response.status === expectedStatus, 'invalid_response');
    if (response.status === 204) return null;
    try {
      let length = 0; const chunks = [];
      for await (const chunk of response.body) { length += chunk.length; check(length <= 256000, 'invalid_response'); chunks.push(Buffer.from(chunk)); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      check(value && typeof value === 'object', 'invalid_response'); return value;
    } catch { throw new TwitchFault('invalid_response'); }
  }
  validate(access) { return this.request('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${access}` } }); }
  token(fields) {
    check(typeof this.clientId === 'string' && !!this.clientId && typeof this.clientSecret === 'string' && !!this.clientSecret, 'client_configuration_missing');
    return this.request('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...fields }) });
  }
  async appToken() {
    if (!this.app) {
      const data = await this.token({ grant_type: 'client_credentials' });
      check(typeof data.access_token === 'string' && !!data.access_token && data.token_type === 'bearer', 'invalid_response');
      this.app = data.access_token;
    }
    return this.app;
  }
  async subscriptions(method = 'GET', body, suffix = '') {
    const send = async () => this.request(`https://api.twitch.tv/helix/eventsub/subscriptions${suffix}`, {
      expectedStatus: method === 'POST' ? 202 : method === 'DELETE' ? 204 : 200,
      method, headers: { Authorization: `Bearer ${await this.appToken()}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    try { return await send(); } catch (e) {
      if (e.category !== 'credentials_rejected') throw e;
      this.app = null;
      // Only an idempotent observation is retried; never retry a registration.
      if (method !== 'GET') throw e;
      return send();
    }
  }
  async list() {
    const all = []; let cursor = ''; const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const result = await this.subscriptions('GET', null, cursor ? '?after=' + encodeURIComponent(cursor) : '');
      check(Array.isArray(result.data), 'invalid_response'); all.push(...result.data);
      cursor = result.pagination?.cursor || ''; if (!cursor) return all;
      check(typeof cursor === 'string' && cursor.length < 1000 && !seen.has(cursor), 'invalid_response'); seen.add(cursor);
    }
    throw new TwitchFault('subscription_list_limit');
  }
}
class TwitchTokens {
  constructor({ client, storage, broadcasterId, readerId, credentialsFile = USER_FILE, now = Date.now }) {
    check(id(broadcasterId) && id(readerId), 'identity_configuration_missing');
    // The minimal deployment uses the broadcaster as reader, avoiding a second
    // credential file and unverifiable moderator assertions.
    check(broadcasterId === readerId, 'reader_must_be_broadcaster');
    Object.assign(this, { client, storage, broadcasterId, readerId, credentialsFile, now });
    this.state = { status: 'unchecked', missingPermissions: [], validUntil: 0 }; this.pending = null;
  }
  health() { return { ...this.state, status: this.state.status === 'valid' && this.state.validUntil <= this.now() ? 'expired' : this.state.status }; }
  source() {
    let raw; try { raw = readPrivate(this.credentialsFile, 16384); } catch { throw new TwitchFault('credentials_unavailable'); }
    let original; try { original = JSON.parse(raw); } catch { throw new TwitchFault('credentials_invalid'); }
    check(typeof original.access_token === 'string' && !!original.access_token && typeof original.refresh_token === 'string' && !!original.refresh_token, 'credentials_invalid');
    const revision = digest(raw);
    const rotated = this.storage.transaction(() => this.storage.read('user-session.json'));
    return { revision, credentials: rotated?.source === revision ? rotated.credentials : original };
  }
  validateIdentity(data) {
    check(data.client_id === this.client.clientId && data.user_id === this.readerId, 'identity_mismatch');
    check(Array.isArray(data.scopes) && data.scopes.every(s => typeof s === 'string') && Number.isFinite(data.expires_in) && data.expires_in > 0, 'invalid_response');
    const missing = REQUIRED.filter(scope => !data.scopes.includes(scope));
    if (missing.length) { this.state.missingPermissions = missing; throw new TwitchFault('missing_permissions'); }
  }
  check({ refresh = false } = {}) {
    if (this.pending) return this.pending;
    this.pending = this.perform(refresh).finally(() => { this.pending = null; }); return this.pending;
  }
  async perform(refresh) {
    let release;
    try {
      release = this.storage.lease('tokens');
      this.state.missingPermissions = [];
      const source = this.source(); let credentials = source.credentials, validated;
      try { validated = await this.client.validate(credentials.access_token); }
      catch (e) {
        if (e.category !== 'credentials_rejected' || !refresh) throw e;
        this.storage.transaction(() => {
          const intent = this.storage.read('refresh-intent.json');
          check(intent?.source !== source.revision, 'refresh_requires_review');
          this.storage.write('refresh-intent.json', { source: source.revision, startedAt: this.now() });
        });
        const next = await this.client.token({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
        check(typeof next.access_token === 'string' && !!next.access_token && typeof next.refresh_token === 'string' && !!next.refresh_token && next.token_type === 'bearer' && Number.isFinite(next.expires_in) && next.expires_in > 0, 'invalid_response');
        // Persist rotation before further network requests: a subsequent outage
        // must not lose the replacement refresh token. Never overwrite OAuth's
        // original credentials or the client secret.
        credentials = { access_token: next.access_token, refresh_token: next.refresh_token, token_type: 'bearer', expires_at: this.now() + next.expires_in * 1000, scope: Array.isArray(next.scope) ? next.scope : [] };
        check(digest(readPrivate(this.credentialsFile, 16384)) === source.revision, 'authorization_changed');
        this.storage.transaction(() => {
          this.storage.write('user-session.json', { source: source.revision, credentials });
          this.storage.write('refresh-intent.json', null);
        });
        validated = await this.client.validate(credentials.access_token);
      }
      this.validateIdentity(validated);
      this.state = { status: 'valid', missingPermissions: [], validUntil: this.now() + Math.min(3600, validated.expires_in) * 1000 };
      return this.health();
    } catch (e) {
      this.state.status = e instanceof TwitchFault ? e.category : 'storage_unavailable'; this.state.validUntil = 0;
      const failure = new TwitchFault(this.state.status);
      failure.missingPermissions = [...this.state.missingPermissions];
      throw failure;
    } finally { if (release) release(); }
  }
}
module.exports = { TwitchClient, TwitchTokens, REQUIRED, USER_FILE, check, id };
