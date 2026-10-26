'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { TwitchStorage, TwitchFault, digest } = require('./twitch-storage');
const { TwitchClient, TwitchTokens, check } = require('./twitch-client');
const CALLBACK = 'https://twitch.theagrostore.com/twitch/eventsub';
const DIRECTORY = path.resolve(__dirname, '../var/twitch-chat');
const subscriptionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const freshState = () => ({ version: 1, registration: null, deliveries: {}, messages: {}, participants: {}, commands: 0, lastEventAt: null });
class TwitchChat {
  constructor({ client, tokens, storage, broadcasterId, readerId, now = Date.now, publish = () => {}, refreshEnabled = false, paymentsEnabled = false }) {
    check(!paymentsEnabled, 'payments_must_be_disabled');
    Object.assign(this, { client, tokens, storage, broadcasterId, readerId, now, publish, refreshEnabled });
    this.observed = { status: 'unknown', checkedAt: 0 }; this.timer = null; this.running = null;
  }
  state() {
    const state = this.storage.read('chat-state.json', freshState());
    check(state.version === 1 && Number.isSafeInteger(state.commands) && state.commands >= 0 && state.deliveries && state.messages && state.participants, 'invalid_chat_storage');
    return state;
  }
  matches(sub) {
    return sub?.type === 'channel.chat.message' && sub.version === '1' && sub.condition?.broadcaster_user_id === this.broadcasterId && sub.condition?.user_id === this.readerId && sub.transport?.method === 'webhook' && sub.transport.callback === CALLBACK;
  }
  bound(record) { return record && record.broadcasterId === this.broadcasterId && record.readerId === this.readerId && record.callback === CALLBACK; }
  snapshot() {
    return this.storage.transaction(() => {
      const s = this.state(); return { commands: s.commands, uniqueParticipants: Object.keys(s.participants).length, lastEventAt: s.lastEventAt };
    });
  }
  health() {
    try {
      const record = this.storage.transaction(() => this.state().registration);
      const credentials = this.tokens.health();
      let status = this.bound(record) ? record.status : 'unregistered';
      if (status === 'pending' && record.expires <= this.now()) status = 'registration_expired';
      if (status === 'enabled' && (this.observed.status !== 'enabled' || this.now() - this.observed.checkedAt >= 120000)) status = 'unknown';
      return { twitchConnected: status === 'enabled' && credentials.status === 'valid', twitchIngressConfigured: true,
        twitchSubscriptionStatus: status, twitchCredentials: credentials.status, twitchMissingPermissions: credentials.missingPermissions,
        twitchError: this.observed.error || null,
        twitchLastVerifiedEventAt: this.snapshot().lastEventAt };
    } catch { return { twitchConnected: false, twitchIngressConfigured: true, twitchSubscriptionStatus: 'storage_unavailable', twitchCredentials: this.tokens.health().status }; }
  }
  announce() { this.publish({ type: 'twitch_status', ...this.health(), liveTwitch: this.snapshot(), simulated: false }); }
  async preflight() { return this.tokens.check({ refresh: this.refreshEnabled }); }
  async reconcile() {
    try {
      await this.preflight();
      const remote = await this.client.list();
      this.storage.transaction(() => {
        const s = this.state(), r = s.registration;
        if (!this.bound(r) || !r.id) { this.observed = { status: 'unknown', checkedAt: this.now() }; return; }
        const sub = remote.find(item => item.id === r.id);
        if (!sub) r.status = 'missing';
        else {
          check(this.matches(sub), 'subscription_identity_mismatch');
          // Local revocation is sticky. A delayed API response cannot revive it.
          if (r.status !== 'revoked') r.status = sub.status === 'enabled' && r.challenged && r.apiConfirmed ? 'enabled' : sub.status === 'webhook_callback_verification_pending' ? 'pending' : 'revoked';
        }
        this.storage.write('chat-state.json', s);
        this.observed = { status: r.status, checkedAt: this.now() };
      });
      return this.health();
    } catch (e) { this.observed = { status: 'unknown', checkedAt: this.now(), error: e instanceof TwitchFault ? e.category : 'storage_unavailable' }; throw e; }
  }
  async register() {
    const release = this.storage.lease('registration');
    let intent;
    try {
      await this.preflight();
      const remote = await this.client.list();
      const current = this.storage.transaction(() => this.state().registration);
      const matching = remote.filter(sub => this.matches(sub));
      if (matching.length) {
        check(this.bound(current) && current.id && matching.length === 1 && matching[0].id === current.id && current.status !== 'revoked', 'existing_subscription_requires_review');
        return this.reconcile();
      }
      check(!current || ['missing', 'revoked'].includes(current.status), 'pending_registration_requires_review');
      intent = crypto.randomUUID();
      const secret = crypto.randomBytes(32).toString('hex');
      this.storage.transaction(() => {
        const s = this.state();
        s.registration = { intent, secret, id: null, apiConfirmed: false, challenged: false, status: 'pending', expires: this.now() + 300000,
          broadcasterId: this.broadcasterId, readerId: this.readerId, callback: CALLBACK };
        this.storage.write('chat-state.json', s);
      });
      const result = await this.client.subscriptions('POST', { type: 'channel.chat.message', version: '1',
        condition: { broadcaster_user_id: this.broadcasterId, user_id: this.readerId }, transport: { method: 'webhook', callback: CALLBACK, secret } });
      check(Array.isArray(result.data) && result.data.length === 1 && this.matches(result.data[0]) && subscriptionId(result.data[0].id), 'invalid_subscription_response');
      const sub = result.data[0];
      this.storage.transaction(() => {
        const s = this.state(), r = s.registration;
        check(r?.intent === intent && (!r.id || r.id === sub.id), 'subscription_identity_mismatch');
        r.id = sub.id; r.apiConfirmed = true; // Challenge may already have pinned it.
        this.storage.write('chat-state.json', s);
      });
      return this.health();
    } catch (e) { this.observed = { status: 'unknown', checkedAt: this.now() }; throw e; }
    finally { release(); }
  }
  async remove() {
    const release = this.storage.lease('registration');
    try {
      const record = this.storage.transaction(() => this.state().registration);
      check(this.bound(record), 'no_managed_subscription');
      if (record.id) {
        const remote = await this.client.list(), sub = remote.find(s => s.id === record.id);
        if (sub) { check(this.matches(sub), 'subscription_identity_mismatch'); await this.client.subscriptions('DELETE', null, '?id=' + encodeURIComponent(record.id)); }
      } else {
        const remote = await this.client.list();
        check(!remote.some(s => this.matches(s)), 'existing_subscription_requires_review');
      }
      this.storage.transaction(() => {
        const s = this.state(); check(s.registration?.intent === record.intent, 'subscription_identity_mismatch');
        // Keep the old secret/ID for authenticated revocation retries, but block
        // notifications and allow a later explicitly requested registration.
        s.registration.status = 'revoked'; this.storage.write('chat-state.json', s);
      });
      this.observed = { status: 'revoked', checkedAt: this.now() }; return this.health();
    } finally { release(); }
  }
  receive({ headers, rawBody }) {
    check(Buffer.isBuffer(rawBody) && rawBody.length <= 16384, 'invalid_webhook');
    const delivery = headers['twitch-eventsub-message-id'], timestamp = headers['twitch-eventsub-message-timestamp'];
    const signature = headers['twitch-eventsub-message-signature'], type = headers['twitch-eventsub-message-type'];
    check(typeof delivery === 'string' && delivery.length > 0 && delivery.length <= 512 && typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) && Math.abs(this.now() - Date.parse(timestamp)) <= 300000, 'invalid_webhook');
    let event;
    const result = this.storage.transaction(() => {
      const s = this.state(), r = s.registration;
      check(this.bound(r) && typeof r.secret === 'string' && /^[a-f0-9]{64}$/.test(r.secret), 'unapproved_subscription');
      const expected = 'sha256=' + crypto.createHmac('sha256', r.secret).update(delivery).update(timestamp).update(rawBody).digest('hex');
      check(typeof signature === 'string' && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)), 'invalid_signature');
      let payload; try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw new TwitchFault('invalid_webhook'); }
      const sub = payload?.subscription;
      check(this.matches(sub) && subscriptionId(sub.id), 'subscription_identity_mismatch');
      if (type === 'webhook_callback_verification') {
        check(r.status !== 'revoked' && (r.status === 'enabled' || r.expires > this.now()) && (!r.id || r.id === sub.id), 'registration_expired');
        check(sub.status === 'webhook_callback_verification_pending' && typeof payload.challenge === 'string' && payload.challenge.length > 0 && payload.challenge.length <= 1024, 'invalid_webhook');
        check(!r.challengeHash || r.challengeHash === digest(payload.challenge), 'challenge_mismatch');
        r.id = sub.id; r.challenged = true; r.challengeHash = digest(payload.challenge);
        this.storage.write('chat-state.json', s); return { status: 200, body: payload.challenge };
      }
      check(r.id === sub.id && r.challenged && r.apiConfirmed, 'unapproved_subscription');
      const key = digest(delivery), bodyHash = digest(rawBody);
      if (s.deliveries[key]) { check(s.deliveries[key].body === bodyHash, 'replay_mismatch'); return { status: 204 }; }
      for (const [key, value] of Object.entries(s.deliveries)) if (value.expires <= this.now()) delete s.deliveries[key];
      check(Object.keys(s.deliveries).length < 5000, 'chat_capacity');
      s.deliveries[key] = { body: bodyHash, expires: this.now() + 600000 };
      if (type === 'revocation') {
        r.status = 'revoked'; this.observed = { status: 'revoked', checkedAt: this.now() };
        event = { type: 'twitch_revoked', simulated: false };
      } else {
        check(type === 'notification' && ['pending', 'enabled'].includes(r.status) && sub.status === 'enabled', 'unapproved_subscription');
        // Credential expiry and startup reconciliation fail closed; transport
        // failures return 503 so Twitch can retry instead of losing commands.
        check(this.tokens.health().status === 'valid', 'credentials_not_validated');
        const value = payload.event;
        check(value?.broadcaster_user_id === this.broadcasterId && /^\d{1,30}$/.test(value.chatter_user_id || '') && typeof value.message_id === 'string' && value.message_id.length > 0 && value.message_id.length <= 160 && typeof value.message?.text === 'string' && value.message.text.length <= 2000, 'invalid_webhook');
        check(!value.source_broadcaster_user_id || value.source_broadcaster_user_id === this.broadcasterId, 'shared_chat_not_allowed');
        r.status = 'enabled'; this.observed = { status: 'enabled', checkedAt: this.now() }; s.lastEventAt = this.now();
        if (value.message.text.trim().toLowerCase() === '!ocean') {
          const message = digest(this.broadcasterId + ':' + value.message_id), participant = digest(this.broadcasterId + ':' + value.chatter_user_id);
          if (!s.messages[message]) {
            check(Object.keys(s.messages).length < 50000 && (s.participants[participant] || Object.keys(s.participants).length < 10000) && s.commands < Number.MAX_SAFE_INTEGER, 'chat_capacity');
            s.messages[message] = true; s.participants[participant] = true; s.commands++;
            event = { type: 'twitch_participation', command: '!ocean', verified: true, simulated: false, timestamp: this.now(),
              liveTwitch: { commands: s.commands, uniqueParticipants: Object.keys(s.participants).length, lastEventAt: s.lastEventAt } };
          }
        }
      }
      this.storage.write('chat-state.json', s); return { status: 204 };
    });
    // Persist deduplication and counters before publishing/acknowledging. An SSE
    // reconnect snapshot recovers a crash between persistence and publication.
    if (event) this.publish({ ...event, twitchStatus: this.health() });
    return result;
  }
  maintain() {
    if (this.running) return this.running;
    this.running = this.reconcile().catch(() => this.health()).then(() => {
      try { this.announce(); } catch { /* Storage contention is retried next tick. */ }
      return this.health();
    }).finally(() => { this.running = null; });
    return this.running;
  }
  start() { if (this.timer) return; void this.maintain(); this.timer = setInterval(() => { void this.maintain(); }, 60000); this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
function createTwitchChat({ env = process.env, fetchImpl, now, publish, directory = DIRECTORY, credentialsFile } = {}) {
  check(env.AGRO_REAL_PAYMENTS_ENABLED === 'false', 'payments_must_be_disabled');
  const storage = new TwitchStorage(directory), client = new TwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, fetchImpl });
  const broadcasterId = env.TWITCH_BROADCASTER_ID, readerId = env.TWITCH_CHAT_READER_ID || broadcasterId;
  const tokens = new TwitchTokens({ client, storage, broadcasterId, readerId, now, credentialsFile });
  return new TwitchChat({ client, tokens, storage, broadcasterId, readerId, now, publish, refreshEnabled: env.TWITCH_TOKEN_REFRESH_ENABLED === 'true' });
}
function eventSubHandler(chat) {
  return async (req, res, url) => {
    if (url.pathname !== '/twitch/eventsub') return false;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end('POST required'); return true; }
    if (!chat) { res.writeHead(503); res.end('Twitch ingress disabled'); return true; }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; check(size <= 16384, 'invalid_webhook'); chunks.push(Buffer.from(chunk)); }
      const result = chat.receive({ headers: req.headers, rawBody: Buffer.concat(chunks) });
      res.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(result.body);
    } catch (e) {
      res.writeHead(['storage_busy', 'storage_unavailable', 'unsafe_storage', 'invalid_chat_storage', 'chat_capacity', 'credentials_not_validated'].includes(e.category) ? 503 : e instanceof TwitchFault ? 403 : 503);
      res.end('Twitch event unavailable or rejected');
    }
    return true;
  };
}
module.exports = { TwitchChat, createTwitchChat, eventSubHandler, CALLBACK, DIRECTORY };
