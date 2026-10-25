'use strict';
const crypto = require('node:crypto');
const validTx = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const check = (ok, message) => { if (!ok) throw new Error(message); };
class JsonApi {
  constructor(base, fetcher = fetch) {
    this.base = new URL(base); this.fetcher = fetcher;
    check(this.base.protocol === 'https:' && !this.base.username && !this.base.password && !this.base.search && !this.base.hash, 'HTTPS API base required');
  }
  async get(route, headers = {}) {
    const response = await this.fetcher(new URL(route, this.base), { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    check(response.ok && /application\/json/i.test(response.headers.get('content-type') || ''), 'API authentication or availability failure');
    let size = 0; const chunks = [];
    for await (const bytes of response.body) { size += bytes.length; if (size > 2000000) throw new Error('API response too large'); chunks.push(Buffer.from(bytes)); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    check(value !== null && !(typeof value === 'object' && value.error), 'Invalid API response'); return value;
  }
}
class AgroExplorerClient {
  constructor(base, fetcher) { this.api = new JsonApi(base, fetcher); }
  async summary() {
    const value = await this.api.get('ext/summary'); const row = value.data?.[0];
    check(Number.isSafeInteger(row?.blockcount) && row.blockcount >= 0, 'Invalid chain summary');
    return { type: 'blockchain', source: 'AgroCoin explorer', simulated: false, blockHeight: row.blockcount, observedAt: new Date().toISOString() };
  }
  async tipTransaction() {
    const summary = await this.summary();
    const hash = await this.api.get('api/getblockhash?index=' + summary.blockHeight);
    check(validTx(hash), 'Invalid tip block hash');
    const block = await this.api.get('api/getblock?hash=' + hash);
    check(block.hash === hash && block.height === summary.blockHeight && validTx(block.tx?.[0]), 'Invalid tip block');
    return this.transaction(block.tx[0]);
  }
  async transaction(transactionId) {
    check(validTx(transactionId), 'Invalid transaction ID');
    const tx = await this.api.get('api/getrawtransaction?txid=' + transactionId + '&decrypt=1');
    check(tx.txid?.toLowerCase() === transactionId.toLowerCase() && Array.isArray(tx.vout), 'Transaction binding mismatch');
    const confirmations = tx.confirmations ?? 0;
    check(Number.isSafeInteger(confirmations), 'Invalid confirmations');
    check(confirmations <= 0 || validTx(tx.blockhash), 'Missing block hash');
    return { transactionId: tx.txid, confirmations, blockHash: tx.blockhash || null, status: confirmations < 0 ? 'conflicted' : confirmations >= 6 ? 'confirmed' : confirmations > 0 ? 'confirming' : 'pending', observedAt: new Date().toISOString(), simulated: false };
  }
}
class MatrixReportsClient {
  constructor(base, cookie, fetcher) { this.api = new JsonApi(base, fetcher); this.cookie = cookie; }
  async tracking(allowedFolios) {
    check(this.cookie && Array.isArray(allowedFolios) && allowedFolios.length > 0, 'Matrix session and consented folios required');
    const result = await this.api.get('index.php?r=agro_impact%2Freport%2Ftracking', { Cookie: this.cookie });
    check(result.ok === true && Array.isArray(result.reports), 'Invalid report tracking response');
    return result.reports.filter(row => allowedFolios.includes(row.folio)).map(row => {
      const s = row.stamp || {}; const reward = s.reward || {};
      // Tracking metadata is genuine service data, not proof of ownership or approval.
      return { folio: row.folio, stamp: { status: typeof s.status === 'string' ? s.status.slice(0, 80) : 'unknown', transactionId: validTx(s.txid) ? s.txid : null, verification: 'service-reported; evidence commitment not available' }, reward: { status: typeof reward.status === 'string' ? reward.status.slice(0, 80) : 'unknown', transactionId: validTx(reward.txid) ? reward.txid : null, amountAgro: typeof reward.amount_agro === 'string' && /^\d+(\.\d{1,8})?$/.test(reward.amount_agro) ? reward.amount_agro : null }, approval: 'not exposed by tracking API', simulated: false };
    });
  }
}
class EcosystemReader {
  constructor({ explorer, reports, folios = [], transactionIds = [] }) { this.explorer = explorer; this.reports = reports; this.folios = folios; this.transactionIds = transactionIds; }
  async refresh() {
    const snapshot = { type: 'ecosystem', simulated: false, observedAt: new Date().toISOString(), chain: null, reports: [], transactions: [], errors: [] };
    try { snapshot.chain = await this.explorer.summary(); } catch { snapshot.errors.push('Chain summary unavailable'); }
    if (this.reports) {
      try { snapshot.reports = await this.reports.tracking(this.folios); } catch { snapshot.errors.push('Matrix tracking unavailable; authenticated session and report access required'); }
    }
    const ids = [...new Set([...this.transactionIds, ...snapshot.reports.flatMap(r => [r.stamp.transactionId, r.reward.transactionId]).filter(Boolean)])];
    for (const id of ids.slice(0, 50)) {
      try { snapshot.transactions.push(await this.explorer.transaction(id)); } catch { snapshot.errors.push('A configured transaction could not be verified'); }
    }
    return snapshot;
  }
}
class TwitchWebhook {
  constructor({ secret, broadcasterId, subscriptionIds }) {
    check(typeof secret === 'string' && /^[\x21-\x7e]{32,100}$/.test(secret), 'Strong Twitch webhook secret required');
    check(/^\d+$/.test(broadcasterId || '') && subscriptionIds?.length > 0, 'Twitch broadcaster and subscription allowlist required');
    this.secret = secret; this.broadcasterId = broadcasterId; this.subscriptionIds = subscriptionIds;
  }
  verify({ headers, rawBody }) {
    const id = headers['twitch-eventsub-message-id']; const timestamp = headers['twitch-eventsub-message-timestamp'];
    check(typeof id === 'string' && id.length <= 512 && typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) && Math.abs(Date.now() - Date.parse(timestamp)) <= 300000, 'Invalid Twitch timestamp or message ID');
    const signature = headers['twitch-eventsub-message-signature'];
    const expected = 'sha256=' + crypto.createHmac('sha256', this.secret).update(id).update(timestamp).update(rawBody).digest('hex');
    check(typeof signature === 'string' && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)), 'Invalid Twitch signature');
    const payload = JSON.parse(rawBody.toString('utf8')); const sub = payload.subscription;
    check(sub?.type === 'channel.chat.message' && sub.version === '1' && sub.condition?.broadcaster_user_id === this.broadcasterId && this.subscriptionIds.includes(sub.id), 'Unapproved Twitch subscription');
    const type = headers['twitch-eventsub-message-type'];
    if (type === 'webhook_callback_verification') { check(typeof payload.challenge === 'string' && payload.challenge.length <= 1024, 'Invalid challenge'); return { kind: 'challenge', challenge: payload.challenge }; }
    if (type === 'revocation') return { kind: 'revocation' };
    check(type === 'notification' && sub.status === 'enabled' && payload.event?.broadcaster_user_id === this.broadcasterId && /^\d+$/.test(payload.event?.chatter_user_id || ''), 'Invalid Twitch notification');
    return { id: crypto.createHash('sha256').update(id).digest('hex'), twitchId: payload.event.chatter_user_id, kind: 'chat', verified: true, simulated: false, timestamp: Date.parse(timestamp) };
  }
}
module.exports = { AgroExplorerClient, MatrixReportsClient, EcosystemReader, TwitchWebhook, JsonApi };
