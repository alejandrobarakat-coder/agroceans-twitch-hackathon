'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);

// Ports intentionally contain no invented production URL, authentication, or wire format.
class AgroWalletAdapter {
  constructor(client) { this.client = client; }
  async resolve(twitchId) {
    const link = await this.client.resolveVerifiedIdentity({ twitchId });
    assert(link?.verified === true && link.twitchId === twitchId && identifier(link.identityId) && typeof link.address === 'string' && link.address.length > 0, 'Verified wallet link required');
    return link;
  }
}
class AgroCeansAdapter {
  constructor(client) { this.client = client; }
  async approved(actionId, identityId) {
    const action = await this.client.getApprovedAction({ actionId, identityId });
    assert(action?.actionId === actionId && action.identityId === identityId && action.status === 'approved' && action.evidenceVerified === true && identifier(action.approvalId), 'Verified AgroCeans approval required');
    assert(typeof action.rewardUnits === 'string' && /^[1-9][0-9]{0,29}$/.test(action.rewardUnits), 'Integer base-unit reward required');
    return action;
  }
}
class StampAdapter {
  constructor(client) { this.client = client; }
  async ensure(action, key) {
    const record = await this.client.ensureRecord({ actionId: action.actionId, approvalId: action.approvalId, identityId: action.identityId, idempotencyKey: key });
    assert(record?.actionId === action.actionId && record.approvalId === action.approvalId && record.status === 'verified' && identifier(record.id) && typeof record.reference === 'string' && record.reference.length > 0, 'Verifiable STAMP required');
    return record;
  }
}
class AgroCoinAdapter {
  constructor(client) { this.client = client; }
  async request(row) {
    return this.validate(await this.client.requestReward({ idempotencyKey: row.key, actionId: row.actionId, approvalId: row.approvalId, stampId: row.stamp.id, address: row.address, rewardUnits: row.rewardUnits }));
  }
  async track(row) { return this.validate(await this.client.getReward({ idempotencyKey: row.key, transactionId: row.transactionId || null })); }
  validate(tx) {
    assert(tx && ['pending', 'submitted', 'confirmed', 'failed'].includes(tx.status), 'Invalid transaction status');
    assert(Number.isSafeInteger(tx.confirmations) && tx.confirmations >= 0, 'Invalid confirmations');
    assert(!['submitted', 'confirmed'].includes(tx.status) || (typeof tx.transactionId === 'string' && tx.transactionId.length > 0), 'Transaction ID required');
    assert(tx.status !== 'confirmed' || tx.confirmations > 0, 'Confirmation required');
    return { status: tx.status, transactionId: tx.transactionId || null, confirmations: tx.confirmations };
  }
}
class RewardEngine {
  constructor({ directory, clients, enabled = false, authorized = false, maxRewardUnits = '0', dailyLimitUnits = '0', publish = () => {} }) {
    assert(directory && /^[0-9]+$/.test(maxRewardUnits) && /^[0-9]+$/.test(dailyLimitUnits), 'Storage and integer limits required');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'integration-state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { rewards: {}, replay: {}, audit: [] };
    this.enabled = enabled && authorized;
    this.max = BigInt(maxRewardUnits); this.daily = BigInt(dailyLimitUnits); this.publish = publish;
    this.wallet = new AgroWalletAdapter(clients.wallet); this.validation = new AgroCeansAdapter(clients.agroceans);
    this.stamp = new StampAdapter(clients.stamp); this.coin = new AgroCoinAdapter(clients.agrocoin);
    this.queue = Promise.resolve();
  }
  save(type, key) {
    this.state.audit.push({ type, key, timestamp: new Date().toISOString() });
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    const dir = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  serial(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  reward(input) { return this.serial(() => this.process(input)); }
  async process({ actionId, twitchId }) {
    assert(this.enabled, 'Real payouts disabled');
    assert(identifier(actionId) && identifier(twitchId), 'Invalid identifiers');
    const key = crypto.createHash('sha256').update('agroceans-action:' + actionId).digest('hex');
    let row = this.state.rewards[key];
    if (row) { assert(row.twitchId === twitchId, 'Action already bound'); return this.publicRow(row); }
    const link = await this.wallet.resolve(twitchId);
    const action = await this.validation.approved(actionId, link.identityId);
    const day = new Date().toISOString().slice(0, 10);
    const spent = Object.values(this.state.rewards).filter(r => r.day === day).reduce((sum, r) => sum + BigInt(r.rewardUnits), 0n);
    assert(BigInt(action.rewardUnits) <= this.max && spent + BigInt(action.rewardUnits) <= this.daily, 'Reward limit exceeded');
    row = { key, actionId, twitchId, identityId: link.identityId, address: link.address, approvalId: action.approvalId, rewardUnits: action.rewardUnits, day, status: 'reserved', confirmations: 0, simulated: false };
    this.state.rewards[key] = row; this.save('reward_reserved', key);
    // Persist intent before side effects. Recovery never blindly resubmits a payout.
    try {
      row.stamp = await this.stamp.ensure(action, key); row.status = 'stamp_verified'; this.save('stamp_verified', key);
      row.status = 'requesting'; this.save('reward_requesting', key);
      Object.assign(row, await this.coin.request(row)); this.save('reward_updated', key);
    } catch (error) { this.save('reconciliation_required', key); throw error; }
    this.publish(this.publicRow(row)); return this.publicRow(row);
  }
  reconcile(key) { return this.serial(async () => {
    // Observation remains available when the payout kill switch is off.
    const row = this.state.rewards[key]; assert(row, 'Unknown reward');
    if (['reserved', 'stamp_verified'].includes(row.status)) throw new Error('Manual recovery required before payout; revalidate approval and wallet');
    if (['confirmed', 'failed'].includes(row.status)) return this.publicRow(row);
    const tx = await this.coin.track(row);
    assert(!row.transactionId || row.transactionId === tx.transactionId, 'Transaction ID changed');
    Object.assign(row, tx); this.save('reward_reconciled', key); this.publish(this.publicRow(row)); return this.publicRow(row);
  }); }
  publicRow(row) { return { type: 'reward', key: row.key, actionId: row.actionId, participation: 'verified', approval: 'approved', stamp: row.stamp ? { id: row.stamp.id, reference: row.stamp.reference, status: row.stamp.status } : null, rewardUnits: row.rewardUnits, status: row.status, transactionId: row.transactionId || null, confirmations: row.confirmations, simulated: false }; }
  snapshot() { return Object.values(this.state.rewards).slice(-50).map(r => this.publicRow(r)); }
  twitch(event) { return this.serial(() => {
    assert(identifier(event.id) && identifier(event.twitchId) && ['chat', 'interaction'].includes(event.kind) && event.verified === true && event.simulated === false, 'Verified Twitch event required');
    assert(Number.isSafeInteger(event.timestamp) && Math.abs(Date.now() - event.timestamp) <= 300000, 'Expired Twitch event');
    assert(!this.state.replay[event.id], 'Replayed Twitch event');
    this.state.replay[event.id] = event.timestamp;
    for (const [id, timestamp] of Object.entries(this.state.replay)) if (Date.now() - timestamp > 600000) delete this.state.replay[id];
    this.save('twitch_received', event.id);
    const safe = { type: 'twitch_participation', simulated: false, verified: true, timestamp: event.timestamp };
    this.publish(safe); return safe; // Chat never invokes reward().
  }); }
}
module.exports = { RewardEngine, AgroWalletAdapter, AgroCeansAdapter, StampAdapter, AgroCoinAdapter };
