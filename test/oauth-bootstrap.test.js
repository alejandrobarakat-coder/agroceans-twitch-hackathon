const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createCapabilityStore, ORIGIN, TTL } = require('../src/oauth-bootstrap');
const { createTwitchOAuth } = require('../src/twitch-oauth');

async function setup(t) {
  const parent = path.resolve(__dirname, '../var');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'bootstrap-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let time = Date.now();
  const options = { directory, now: () => time };
  const store = createCapabilityStore(options);
  return { directory, options, store, expire() { time += TTL; }, advance() { time += 60000; } };
}
function client(f, options = {}) {
  const saved = [];
  const handle = createTwitchOAuth({ clientId: 'fixture-client', clientSecret: 'fixture-secret',
    authorize: () => false, bootstrapEnabled: true, capabilityStore: f.store, now: f.options.now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh',
      token_type: 'bearer', scope: [], expires_in: 3600 }) }), store: async data => saved.push(data), ...options });
  async function request(method, route = '/auth/twitch/bootstrap', body = '', headers = {}) {
    const req = Readable.from([Buffer.from(body)]);
    req.method = method;
    req.headers = { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...headers };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
    await handle(req, res, new URL(route, ORIGIN));
    return res;
  }
  return { request, saved };
}

test('capabilities contain 256 random bits; disk contains only hashes and private expiration records', async t => {
  const f = await setup(t); const a = await f.store.mint(); const b = await f.store.mint();
  assert.match(a, /^[a-f0-9]{64}$/); assert.notEqual(a, b);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  for (const file of await fs.readdir(f.directory)) {
    assert.ok(!file.includes(a) && !file.includes(b));
    assert.equal((await fs.stat(path.join(f.directory, file))).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(f.directory, file), 'utf8'))), ['expires']);
  }
});
test('atomic consumption across independent stores permits exactly one concurrent winner', async t => {
  const f = await setup(t); const token = await f.store.mint();
  const other = createCapabilityStore(f.options);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? other : f.store).consume(token)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal(await other.consume(token), false);
});
test('expiry, malformed capabilities, revocation and permissive files fail closed', async t => {
  const f = await setup(t); const token = await f.store.mint(); f.expire();
  assert.equal(await f.store.consume(token), false);
  assert.equal(await f.store.consume('../credentials.json'), false);
  const revoked = await f.store.mint(); await f.store.revokeAll();
  assert.equal(await f.store.consume(revoked), false);
  const unsafe = await f.store.mint();
  const [name] = await fs.readdir(f.directory); await fs.chmod(path.join(f.directory, name), 0o644);
  assert.equal(await f.store.consume(unsafe), false);
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(f.store.mint(), /Unsafe bootstrap directory/);
});
test('landing page removes fragment before explicit POST and prevents cache, referrer and embedding leakage', async t => {
  const f = await setup(t); const c = client(f); const token = await f.store.mint();
  const res = await c.request('GET');
  assert.equal(res.status, 200); assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(res.headers['Referrer-Policy'], 'same-origin');
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(res.body, /history.replaceState/); assert.match(res.body, /method="post"/);
  assert.ok(!JSON.stringify(res).includes(token));
  assert.equal(await f.store.consume(token), true); // GET does not burn the link.
});
test('bootstrap redirects with secure cookie and preserves callback CSRF checks and storage', async t => {
  const f = await setup(t); const c = client(f); const token = await f.store.mint();
  assert.equal((await c.request('GET', '/auth/twitch/start')).status, 403);
  const res = await c.request('POST', undefined, `capability=${token}`);
  assert.equal(res.status, 303);
  const location = new URL(res.headers.Location);
  assert.equal(location.origin, 'https://id.twitch.tv');
  assert.match(res.headers['Set-Cookie'], /Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(JSON.stringify(res), new RegExp(`${token}|fixture-secret|fixture-access|fixture-refresh`));
  assert.equal((await c.request('POST', undefined, `capability=${token}`)).status, 400);
  const callback = `/auth/twitch/callback?state=${location.searchParams.get('state')}&code=fixture-code`;
  assert.equal((await c.request('GET', callback)).status, 400);
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  assert.equal((await c.request('GET', callback, '', { cookie })).status, 200);
  assert.equal(c.saved.length, 1);
  assert.equal((await c.request('GET', callback, '', { cookie })).status, 400);
});
test('cross-origin, invalid forms, oversized bodies, query strings and unsupported methods are rejected', async t => {
  const f = await setup(t); const c = client(f); const token = await f.store.mint();
  const body = `capability=${token}`;
  assert.equal((await c.request('POST', undefined, body, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await c.request('POST', undefined, body, { origin: '' })).status, 403);
  assert.equal((await c.request('POST', undefined, body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await c.request('POST', undefined, body, { 'content-type': 'application/json' })).status, 415);
  assert.equal((await c.request('POST', undefined, 'x'.repeat(257))).status, 413);
  assert.equal((await c.request('POST', undefined, `${body}&${body}`)).status, 400);
  assert.equal((await c.request('GET', '/auth/twitch/bootstrap?capability=redacted')).status, 400);
  assert.equal((await c.request('DELETE')).status, 405);
  assert.equal(await f.store.consume(token), true);
});
test('bootstrap defaults disabled; global rate limit has bounded state and resets after a minute', async t => {
  const f = await setup(t);
  assert.equal((await client(f, { bootstrapEnabled: false }).request('GET')).status, 503);
  const c = client(f);
  for (let i = 0; i < 30; i++) assert.equal((await c.request('POST', undefined, 'capability=invalid')).status, 400);
  const res = await c.request('GET'); assert.equal(res.status, 429); assert.equal(res.headers['Retry-After'], '60');
  f.advance(); assert.equal((await c.request('GET')).status, 200);
});
test('storage exceptions are sanitized', async t => {
  const f = await setup(t); const c = client(f, { capabilityStore: { consume: async () => { throw new Error('secret'); } } });
  const res = await c.request('POST', undefined, 'capability=invalid');
  assert.equal(res.status, 500); assert.doesNotMatch(res.body, /secret/);
});

// Fetch §3.2 makes Origin null for navigate-mode POSTs under no-referrer.
// Exercise the generated page's effective policy and the real request gate;
// browser header generation itself requires browser acceptance testing.
test('form landing policy preserves Origin while POST redirect suppresses cross-origin referrers', async t => {
  const f = await setup(t);
  let claims = 0;
  const c = client(f, { capabilityStore: { consume: async () => { claims++; return true; } } });
  const page = await c.request('GET');
  assert.equal(page.headers['Referrer-Policy'], 'same-origin');
  assert.match(page.body, /<form method="post" action="\/auth\/twitch\/bootstrap"/);
  assert.doesNotMatch(page.body, /<meta[^>]+name=["']referrer["']/i);
  assert.doesNotMatch(page.headers['Content-Security-Policy'], /(?:^|;)\s*sandbox(?:;|\s|$)/);
  const res = await c.request('POST', undefined, 'capability=test-fixture', { 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 303);
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(new URL(res.headers.Location).origin, 'https://id.twitch.tv');
  assert.equal(claims, 1);
});

test('null or missing Origin is rejected even with same-origin fetch metadata or matching Referer', async t => {
  const f = await setup(t);
  let claims = 0;
  const c = client(f, { capabilityStore: { consume: async () => { claims++; return true; } } });
  for (const origin of [undefined, '', 'null', 'https://other.theagrostore.com', 'http://twitch.theagrostore.com']) {
    const res = await c.request('POST', undefined, 'capability=test-fixture', {
      origin, 'sec-fetch-site': 'same-origin', referer: `${ORIGIN}/auth/twitch/bootstrap`
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  }
  assert.equal(claims, 0);
});

test('same-site, cross-site, none and invalid fetch metadata remain rejected with an exact Origin', async t => {
  const f = await setup(t);
  let claims = 0;
  const c = client(f, { capabilityStore: { consume: async () => { claims++; return true; } } });
  for (const site of ['same-site', 'cross-site', 'none', 'unexpected', 'same-origin, cross-site']) {
    assert.equal((await c.request('POST', undefined, 'capability=test-fixture', { 'sec-fetch-site': site })).status, 403);
  }
  assert.equal(claims, 0);
  // Compatibility without Fetch Metadata never substitutes for strict Origin.
  assert.equal((await c.request('POST', undefined, 'capability=invalid', { 'sec-fetch-site': undefined })).status, 303);
  assert.equal(claims, 1);
});
