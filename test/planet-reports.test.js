'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PublicMatrixReportsClient, PlanetReports, policyEntries, createPlanetReports } = require('../src/planet-reports');
const folio = 'impact:public-one', txid = 'a'.repeat(64);
const policy = { version: 1, reports: [{ folio, postId: '42' }] };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function source(options = {}) {
  const state = { reports: [{ folio, stamp: { folio, status: 'confirmed', chain_status: 'confirmed', txid, reference: 'stamp:existing-reference' } }],
    publication: '<article>AgroCeans reference: ' + folio + '</article>', calls: [], ...options };
  const client = new PublicMatrixReportsClient({ base: 'https://matrix.example.test/', cookie: 'fixture-private-session', fetchImpl: async (url, request) => {
    state.calls.push({ url: url.href, method: request.method || 'GET', headers: request.headers });
    assert.equal(request.redirect, 'error'); assert.ok(request.signal);
    if (url.searchParams.get('r') === 'post/post/view') {
      assert.equal(request.headers.Cookie, undefined); assert.equal(url.searchParams.get('id'), '42');
      return new Response(state.publication, { status: state.publicStatus || 200, headers: { 'content-type': state.publicType || 'text/html' } });
    }
    assert.equal(url.searchParams.get('r'), 'agro_impact/report/tracking');
    assert.equal(request.headers.Cookie, 'fixture-private-session');
    if (state.login) return new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
    return json(state.response ?? { ok: true, reports: state.reports });
  } });
  return { state, client, read: () => client.read(policyEntries(policy)) };
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '../var-planet-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = source(options); const events = [];
  const config = { directory: path.join(root, 'reports'), policy, client: s.client, publish: event => events.push(event) };
  return { ...s, config, events, store: new PlanetReports(config) };
}
function proof(boundFolio = folio) {
  const manifest = { schema: 'agro.stamp-manifest.v1', folio: boundFolio, report_sha256: 'b'.repeat(64),
    report_file_sha256: 'c'.repeat(64), evidence: [{ kind: 'image', sha256: 'd'.repeat(64) }] };
  const canonical = JSON.stringify(manifest);
  return { manifest, canonical_manifest: canonical, commitment_sha256: crypto.createHash('sha256').update(canonical).digest('hex') };
}

test('public publication gate and authenticated GET preserve existing STAMP and redact private fields', async () => {
  const f = source();
  f.state.reports[0] = { ...f.state.reports[0], title: 'PRIVATE_TITLE', location: { latitude: 1 }, photos: ['PRIVATE_PHOTO'],
    wallet: 'PRIVATE_WALLET', approval: 'PRIVATE_APPROVAL', stamp: { ...f.state.reports[0].stamp, receiver: 'PRIVATE_RECEIVER', reward: { status: 'confirmed', destination: 'PRIVATE_DESTINATION', amount_agro: '0.1' } } };
  f.state.reports.push({ folio: 'private-report', title: 'PRIVATE_OTHER' });
  const rows = await f.read(); assert.equal(rows.length, 1);
  assert.equal(rows[0].stamp.reference, 'stamp:existing-reference'); assert.equal(rows[0].stamp.transactionId, txid);
  assert.equal(rows[0].stamp.status, 'confirmed'); assert.equal(rows[0].stamp.chainStatus, 'confirmed');
  assert.match(rows[0].stamp.verification, /^service-reported/);
  assert.equal(new URL(rows[0].publicUrl).searchParams.get('id'), '42');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|fixture-private-session|reward|latitude|photos|title|receiver|approval/);
  assert.ok(f.state.calls.every(call => call.method === 'GET'));
});

test('missing STAMP remains absent; no fabricated pending certificate, reward or transaction', async () => {
  for (const stamp of [undefined, null]) {
    const f = source({ reports: [{ folio, stamp }] }); const rows = await f.read();
    assert.equal(rows[0].stamp, null); assert.equal(rows[0].reward, undefined);
  }
});

test('identical duplicate reports collapse; conflicting STAMP rows and malformed fields fail closed', async () => {
  const f = source(); f.state.reports.push(structuredClone(f.state.reports[0])); assert.equal((await f.read()).length, 1);
  f.state.reports[1].stamp.status = 'pending'; await assert.rejects(f.read(), /duplicate/);
  for (const stamp of [{}, 'bad', { status: 'confirmed', txid: 'invalid' }, { status: 'pending', folio: 'another' }, { status: '<script>' }, { status: 'pending', reference: 'https://example.test/?token=private' }]) {
    f.state.reports = [{ folio, stamp }]; await assert.rejects(f.read());
  }
  for (const response of [{ ok: false, reports: [] }, { ok: true, reports: {} }, { ok: true, reports: [null] }, { ok: true, reports: [{ folio: '<script>' }] }, { ok: true, reports: [] }]) {
    f.state.response = response; await assert.rejects(f.read());
  }
});

test('login HTML, redirects, non-public/mismatched publication and hidden markers are rejected', async () => {
  const login = source({ login: true }); await assert.rejects(login.read(), /authentication/);
  for (const publication of ['<html>Login</html>', '<article>AgroCeans reference: other</article>',
    '<article>AgroCeans reference: ' + folio + '-extra</article>',
    '<script>AgroCeans reference: ' + folio + '</script>', '<!-- AgroCeans reference: ' + folio + ' -->',
    '<input type="password"><p>AgroCeans reference: ' + folio + '</p>']) {
    const f = source({ publication }); await assert.rejects(f.read());
    assert.equal(f.state.calls.length, 1); // no authenticated read after failed public check
  }
  for (const options of [{ publicStatus: 302 }, { publicStatus: 404 }, { publicType: 'application/json' }, { publication: 'x'.repeat(2000001) }]) await assert.rejects(source(options).read());
});

test('commitment bytes and folio binding are checked without claiming on-chain verification', async () => {
  const f = source(); const valid = proof();
  // Different key order in the optional manifest object is semantically identical.
  f.state.reports[0].stamp = { ...f.state.reports[0].stamp, ...valid, manifest: Object.fromEntries(Object.entries(valid.manifest).reverse()) };
  const row = (await f.read())[0]; assert.equal(row.stamp.commitment.canonicalBytesMatched, true);
  assert.match(row.stamp.commitment.verification, /not on-chain/);
  assert.doesNotMatch(JSON.stringify(row), /canonical_manifest|report_sha256|report_file_sha256|"evidence"/);
  f.state.reports[0].stamp.commitment_sha256 = 'e'.repeat(64); await assert.rejects(f.read(), /commitment mismatch/);
  f.state.reports[0].stamp = { status: 'pending', ...proof('different-folio') }; await assert.rejects(f.read(), /binding/);
});

test('pinned commitments reject missing/mismatched values; missing canonical bytes stay service-reported', async () => {
  const f = source(); const valid = proof();
  const entries = policyEntries({ version: 1, reports: [{ ...policy.reports[0], commitmentSha256: valid.commitment_sha256 }] });
  await assert.rejects(f.client.read(entries), /commitment/);
  f.state.reports[0].stamp = { status: 'confirmed', commitment_sha256: valid.commitment_sha256 };
  const row = (await f.client.read(entries))[0]; assert.equal(row.stamp.commitment.canonicalBytesMatched, false);
  f.state.reports[0].stamp = null; await assert.rejects(f.client.read(entries));
});

test('refresh coalesces concurrency, deduplicates events and recovers without duplicating report events', async t => {
  const f = fixture(t); assert.equal(f.store.snapshot().reports.length, 0);
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.store.refresh()));
  assert.equal(f.state.calls.length, 2); assert.equal(responses[0].reports.length, 1);
  assert.equal(f.events.filter(event => event.type === 'planet.report').length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(f.config.directory, 'reports.json'), 'utf8'), /fixture-private-session|canonical_manifest|receiver|reward/);
  const id = f.events.find(event => event.type === 'planet.report').eventId;
  await f.store.refresh(); assert.equal(f.events.filter(event => event.type === 'planet.report').length, 1);
  const restarted = new PlanetReports(f.config);
  assert.equal(restarted.snapshot().reports.length, 0); // publicness must be rechecked after restart
  await restarted.refresh(); assert.equal(f.events.filter(event => event.type === 'planet.report').length, 1);
  f.state.reports[0].stamp.status = 'confirming'; await restarted.refresh();
  assert.equal(f.events.filter(event => event.type === 'planet.report').length, 2);
  assert.notEqual(f.events.filter(event => event.type === 'planet.report')[1].eventId, id);
  f.state.reports[0].stamp.status = 'confirmed'; await restarted.refresh();
  assert.equal(new Set(f.events.filter(event => event.type === 'planet.report').map(event => event.eventId)).size, 3);
});

test('publication/auth failure hides cached public rows; commitment change requires review', async t => {
  const f = fixture(t); f.state.reports[0].stamp = { status: 'confirmed', ...proof() };
  await f.store.refresh();
  const original = fs.readFileSync(path.join(f.config.directory, 'reports.json'), 'utf8');
  f.state.login = true; await assert.rejects(f.store.refresh()); assert.deepEqual(f.store.snapshot().reports, []);
  await assert.rejects(f.store.refresh()); assert.equal(f.events.filter(event => event.type === 'planet.unavailable').length, 1);
  f.state.login = false; f.state.reports[0].stamp = { status: 'confirmed', commitment_sha256: 'f'.repeat(64) };
  await assert.rejects(f.store.refresh()); assert.deepEqual(f.store.snapshot().reports, []);
  assert.equal(fs.readFileSync(path.join(f.config.directory, 'reports.json'), 'utf8'), original);
});

test('failed persistence cannot publish report events or expose stale report cache', async t => {
  const f = fixture(t); await f.store.refresh(); f.events.length = 0;
  const before = fs.readFileSync(path.join(f.config.directory, 'reports.json'), 'utf8');
  f.state.reports[0].stamp.status = 'pending';
  f.store.storage.write = () => { throw Error('injected disk failure'); };
  await assert.rejects(f.store.refresh()); assert.deepEqual(f.store.snapshot().reports, []);
  assert.equal(f.events.some(event => event.type === 'planet.report'), false);
  assert.equal(fs.readFileSync(path.join(f.config.directory, 'reports.json'), 'utf8'), before);
});

test('configuration is opt-in, bounded and requires the payment kill switch and private policy', () => {
  assert.equal(createPlanetReports({ env: {} }), null);
  assert.throws(() => createPlanetReports({ env: { AGRO_PLANET_REPORTS_ENABLED: 'true', AGRO_REAL_PAYMENTS_ENABLED: 'true' } }), /kill switch/);
  assert.throws(() => createPlanetReports({ env: { AGRO_PLANET_REPORTS_ENABLED: 'true', AGRO_REAL_PAYMENTS_ENABLED: 'false', AGRO_PLANET_PUBLIC_REPORTS_FILE: '../outside-policy.json' } }), /inside/);
  for (const value of [{}, { version: 1, reports: [] }, { version: 1, reports: [policy.reports[0], policy.reports[0]] }, { version: 1, reports: [{ folio, postId: '../private' }] }]) assert.throws(() => policyEntries(value));
});

test('policy changes fail closed instead of exposing records from a previous allowlist', async t => {
  const f = fixture(t); await f.store.refresh();
  const other = new PlanetReports({ ...f.config, policy: { version: 1, reports: [{ folio: 'different-public-folio', postId: '77' }] } });
  assert.throws(() => other.snapshot(), /storage/);
});

test('tracking rejects HTML disguised as JSON, malformed JSON, redirects and JSONP media types', async () => {
  const { JsonApi } = require('../src/ecosystem');
  for (const [body, type] of [['<html>Login</html>', 'application/json'], ['{bad json', 'application/json'], ['{}', 'application/jsonp']]) {
    const api = new JsonApi('https://matrix.example.test/', async () => new Response(body, { headers: { 'content-type': type } }));
    await assert.rejects(api.get('index.php?r=agro_impact%2Freport%2Ftracking'));
  }
  const api = new JsonApi('https://matrix.example.test/', async () => ({ ok: true, redirected: true, headers: new Headers({ 'content-type': 'application/json' }) }));
  await assert.rejects(api.get('index.php'), /authentication/);
});
