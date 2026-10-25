const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RewardEngine } = require('../src/integration');
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(__dirname, '../var-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requests = 0;
  const clients = {
    wallet: { resolveVerifiedIdentity: async ({ twitchId }) => ({ twitchId, verified: true, identityId: 'identity', address: 'provider-address' }) },
    agroceans: { getApprovedAction: async ({ actionId, identityId }) => ({ actionId, identityId, status: 'approved', evidenceVerified: true, approvalId: 'approval', rewardUnits: '10' }) },
    stamp: { ensureRecord: async x => ({ ...x, id: 'stamp', status: 'verified', reference: 'provider-reference' }) },
    agrocoin: { requestReward: async () => { requests++; return { status: 'submitted', transactionId: 'tx', confirmations: 0 }; }, getReward: async () => ({ status: 'confirmed', transactionId: 'tx', confirmations: 3 }) }
  };
  const config = { directory, clients, enabled: true, authorized: true, maxRewardUnits: '10', dailyLimitUnits: '10', ...options };
  return { engine: new RewardEngine(config), clients, config, requests: () => requests };
}
test('approved action issues once across concurrent retries and restart; confirms by lookup', async t => {
  const f = fixture(t); const input = { actionId: 'action', twitchId: 'viewer' };
  const [a,b] = await Promise.all([f.engine.reward(input), f.engine.reward(input)]);
  assert.deepEqual(a,b); assert.equal(f.requests(),1);
  const restarted = new RewardEngine(f.config);
  assert.equal((await restarted.reward(input)).transactionId, 'tx');
  assert.equal((await restarted.reconcile(a.key)).status, 'confirmed');
  await assert.rejects(restarted.reward({ ...input, twitchId: 'other' }), /bound/);
  await assert.rejects(restarted.reward({ ...input, actionId: 'second' }), /limit/);
});
test('defaults, unverified wallets and unapproved evidence fail closed', async t => {
  const f = fixture(t, { authorized: false });
  await assert.rejects(f.engine.reward({ actionId: 'a', twitchId: 'v' }), /disabled/);
  f.engine.enabled = true;
  f.clients.wallet.resolveVerifiedIdentity = async () => ({ verified: false });
  await assert.rejects(f.engine.reward({ actionId: 'a', twitchId: 'v' }), /wallet/);
  assert.equal(f.requests(),0);
});
test('chat replay and stale events rejected; chat cannot pay', async t => {
  const f = fixture(t); const event = { id: 'event', twitchId: 'v', kind: 'chat', verified: true, simulated: false, timestamp: Date.now() };
  await f.engine.twitch(event);
  await assert.rejects(f.engine.twitch(event), /Replayed/);
  await assert.rejects(f.engine.twitch({ ...event, id: 'old', timestamp: 0 }), /Expired/);
  assert.equal(f.requests(),0);
});
test('ambiguous payout timeout remains reserved and is reconciled without resending', async t => {
  const f = fixture(t);
  f.clients.agrocoin.requestReward = async () => { throw new Error('timeout'); };
  await assert.rejects(f.engine.reward({ actionId: 'a', twitchId: 'v' }), /timeout/);
  const row = f.engine.snapshot()[0]; assert.equal(row.status, 'requesting');
  assert.equal((await new RewardEngine(f.config).reconcile(row.key)).status, 'confirmed');
});
test('unapproved action and unverified STAMP never request payout', async t => {
  const f = fixture(t);
  const original = f.clients.agroceans.getApprovedAction;
  f.clients.agroceans.getApprovedAction = async x => ({ ...await original(x), status: 'pending' });
  await assert.rejects(f.engine.reward({ actionId: 'a', twitchId: 'v' }), /approval/);
  f.clients.agroceans.getApprovedAction = original;
  f.clients.stamp.ensureRecord = async () => ({ status: 'pending' });
  await assert.rejects(f.engine.reward({ actionId: 'a', twitchId: 'v' }), /STAMP/);
  assert.equal(f.requests(),0);
});
test('read-only reconciliation continues with payout gates disabled', async t => {
  const f = fixture(t);
  const row = await f.engine.reward({ actionId: 'a', twitchId: 'v' });
  const readOnly = new RewardEngine({ ...f.config, enabled: false, authorized: false });
  assert.equal((await readOnly.reconcile(row.key)).status, 'confirmed');
  await assert.rejects(readOnly.reward({ actionId: 'b', twitchId: 'v' }), /disabled/);
  assert.equal(f.requests(), 1);
});
