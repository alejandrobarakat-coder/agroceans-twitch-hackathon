const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTwitchOAuth, storeCredentials, REDIRECT_URI } = require('../src/twitch-oauth');

function fixture(options = {}) {
  let time = 1000;
  const saved = [];
  const calls = [];
  const handle = createTwitchOAuth({ clientId: 'test-client', clientSecret: 'test-secret',
    reportExchangeFailure: () => {},
    authorize: req => req.headers.authorization === 'Bearer operator', now: () => time,
    store: async tokens => saved.push(tokens), fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => ({ access_token: 'private-access', refresh_token: 'private-refresh',
        expires_in: 3600, token_type: 'bearer', scope: [] }) };
    }, ...options });
  async function request(route, headers = {}, method = 'GET') {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await handle({ headers, method }, res, new URL(route, 'https://example.test'));
    return res;
  }
  async function start() {
    const res = await request('/auth/twitch/start', { authorization: 'Bearer operator' });
    assert.equal(res.status, 302);
    return { state: new URL(res.headers.Location).searchParams.get('state'), cookie: res.headers['Set-Cookie'].split(';')[0], res };
  }
  return { request, start, saved, calls, expire: () => { time += 600000; } };
}
const callback = state => `/auth/twitch/callback?state=${state}&code=private-code`;

test('authorization uses official endpoint, random state and secure cookie; operator required', async () => {
  const f = fixture();
  assert.equal((await f.request('/auth/twitch/start')).status, 403);
  const a = await f.start(); const b = await f.start();
  assert.match(a.state, /^[a-f0-9]{64}$/); assert.notEqual(a.state, b.state);
  const url = new URL(a.res.headers.Location);
  assert.equal(url.origin + url.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(a.res.headers['Set-Cookie'], /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(a.res.headers['Cache-Control'], 'no-store');
});
test('state mismatch and missing or different browser cookies cannot exchange tokens', async () => {
  const f = fixture(); const a = await f.start(); const b = await f.start();
  for (const [state, cookie] of [['wrong', a.cookie], [a.state, ''], [a.state, b.cookie]]) {
    assert.equal((await f.request(callback(state), { cookie })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});
test('expired state is rejected and consumed', async () => {
  const f = fixture(); const a = await f.start(); f.expire();
  const res = await f.request(callback(a.state), { cookie: a.cookie });
  assert.equal(res.status, 400); assert.match(res.body, /expired/); assert.equal(f.calls.length, 0);
});
test('success exchanges server side, stores credentials, and rejects replay without disclosure', async () => {
  const f = fixture(); const a = await f.start();
  const res = await f.request(callback(a.state), { cookie: a.cookie });
  assert.equal(res.status, 200); assert.equal(f.saved.length, 1);
  assert.equal(f.calls[0][0], 'https://id.twitch.tv/oauth2/token');
  const options = f.calls[0][1];
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.equal(options.body.get('client_secret'), 'test-secret');
  assert.equal(options.body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(options.body.get('grant_type'), 'authorization_code');
  assert.equal(f.saved[0].access_token, 'private-access');
  assert.doesNotMatch(JSON.stringify(res), /private-access|private-refresh|test-secret|private-code/);
  assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
  assert.equal(f.calls.length, 1);
});
for (const [label, fetchImpl] of [
  ['HTTP failure', async () => ({ ok: false })],
  ['network failure', async () => { throw new Error('test-secret private-access'); }],
  ['invalid JSON', async () => ({ ok: true, json: async () => { throw new Error('private-refresh'); } })],
  ['invalid tokens', async () => ({ ok: true, json: async () => ({}) })]
]) test(label + ' is sanitized and consumes state', async () => {
  const f = fixture({ fetchImpl }); const a = await f.start();
  const res = await f.request(callback(a.state), { cookie: a.cookie });
  assert.equal(res.status, 502); assert.equal(f.saved.length, 0);
  assert.doesNotMatch(JSON.stringify(res), /test-secret|private-access|private-refresh/);
  assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
});
test('denial, missing code, duplicate parameters and storage failures are handled', async () => {
  for (const suffix of ['&error=access_denied&error_description=private-secret', '', '&code=a&code=b', '&code=a&state=duplicate']) {
    const f = fixture(); const a = await f.start();
    const res = await f.request(`/auth/twitch/callback?state=${a.state}${suffix}`, { cookie: a.cookie });
    assert.equal(res.status, 400); assert.equal(f.calls.length, 0); assert.doesNotMatch(res.body, /private-secret/);
  }
  const f = fixture({ store: async () => { throw new Error('private-access'); } }); const a = await f.start();
  const res = await f.request(callback(a.state), { cookie: a.cookie });
  assert.equal(res.status, 500); assert.doesNotMatch(res.body, /private-access/);
});
test('unconfigured OAuth and unsupported methods fail closed', async () => {
  const f = fixture({ clientSecret: '' });
  assert.equal((await f.request('/auth/twitch/start')).status, 503);
  assert.equal((await f.request('/auth/twitch/callback', {}, 'POST')).status, 405);
});
test('credential persistence is private, atomic and rejects unsafe directories', async () => {
  const parent = path.join(__dirname, '../var');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'oauth-test-'));
  try {
    await storeCredentials({ access_token: 'test-only-first' }, directory);
    const file = path.join(directory, 'credentials.json');
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await storeCredentials({ access_token: 'test-only-second' }, directory);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).access_token, 'test-only-second');
    assert.deepEqual(await fs.readdir(directory), ['credentials.json']);
    await fs.chmod(directory, 0o755);
    await assert.rejects(storeCredentials({}, directory), /Unsafe credential directory/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('successful zero-scope token response may omit scope', async () => {
  const f = fixture({ scopes: '', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
    access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 3600
  }) }) });
  const a = await f.start();
  const res = await f.request(callback(a.state), { cookie: a.cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(f.saved[0].scope, []);
  assert.doesNotMatch(JSON.stringify(res), /private-access|private-refresh|test-secret|private-code/);
  assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
});

test('omitted scope with requested permissions and malformed scope values still fail closed', async () => {
  for (const [scopes, scopeFields] of [['chat:read', {}], ['', { scope: null }], ['', { scope: 'chat:read' }], ['', { scope: [1] }]]) {
    const diagnostics = [];
    const f = fixture({ scopes, reportExchangeFailure: data => diagnostics.push(data),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 3600, ...scopeFields
      }) }) });
    const a = await f.start();
    assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 502);
    assert.equal(f.saved.length, 0);
    assert.deepEqual(diagnostics, [{ event: 'twitch_oauth_exchange_failure', status: 200, category: 'invalid_token_response' }]);
    assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
    assert.equal(diagnostics.length, 1);
  }
});

test('HTTP failure diagnostics contain only numeric status and an allowlisted category', async () => {
  const cases = [
    [401, { message: 'Invalid client secret' }, 'client_rejected'],
    [400, { error: 'invalid_client' }, 'client_rejected'],
    [400, { message: 'Invalid authorization code' }, 'authorization_code_rejected'],
    [400, { error: 'invalid_grant' }, 'authorization_code_rejected'],
    [400, { message: 'redirect_uri mismatch' }, 'redirect_uri_rejected'],
    [400, { error: 'invalid_request' }, 'request_rejected'],
    [429, {}, 'provider_rate_limited'],
    [503, {}, 'provider_unavailable'],
    [400, { error: '__proto__', message: 'test-secret private-code private-access private-refresh' }, 'http_rejected'],
    [400, { message: 'Invalid client secret: test-secret' }, 'http_rejected']
  ];
  for (const [status, body, category] of cases) {
    let requests = 0; const diagnostics = [];
    const f = fixture({ reportExchangeFailure: data => diagnostics.push(data), fetchImpl: async () => {
      requests++; return { ok: false, status, json: async () => body };
    } });
    const a = await f.start(); const response = await f.request(callback(a.state), { cookie: a.cookie });
    assert.equal(response.status, 502);
    assert.deepEqual(diagnostics, [{ event: 'twitch_oauth_exchange_failure', status, category }]);
    assert.doesNotMatch(JSON.stringify({ response, diagnostics }), /test-secret|private-code|private-access|private-refresh/);
    assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
    assert.equal(requests, 1); assert.equal(diagnostics.length, 1); assert.equal(f.saved.length, 0);
  }
});

test('transport, timeout and parse failures are distinguished without exposing exceptions or bodies', async () => {
  const cases = [
    [async () => { throw Error('test-secret private-code'); }, null, 'transport_failure'],
    [async () => { const error = Error('private-access'); error.name = 'TimeoutError'; throw error; }, null, 'transport_timeout'],
    [async () => ({ ok: true, status: 200, json: async () => { throw Error('private-refresh'); } }), 200, 'invalid_json'],
    [async () => ({ ok: true, status: 200, json: async () => null }), 200, 'invalid_token_response'],
    [async () => ({ ok: false, status: 400, json: async () => { throw Error('private-code'); } }), 400, 'http_rejected'],
    [async () => ({ ok: false, status: 'private-code', json: async () => ({}) }), null, 'http_rejected']
  ];
  for (const [fetchImpl, status, category] of cases) {
    const diagnostics = [];
    const f = fixture({ fetchImpl, reportExchangeFailure: data => diagnostics.push(data) });
    const a = await f.start(); const response = await f.request(callback(a.state), { cookie: a.cookie });
    assert.equal(response.status, 502);
    assert.deepEqual(diagnostics, [{ event: 'twitch_oauth_exchange_failure', status, category }]);
    assert.doesNotMatch(JSON.stringify({ response, diagnostics }), /test-secret|private-code|private-access|private-refresh/);
  }
  const f = fixture({ fetchImpl: async () => { throw Error('private-code'); }, reportExchangeFailure: () => { throw Error('private-access'); } });
  const a = await f.start(); assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 502);
});

test('authorization and exchange use identical fixed client and redirect values regardless of proxy headers', async () => {
  const clientId = 'fixture-encoded-id&=+';
  const clientSecret = 'fixture-encoded-secret&=+';
  const requests = []; const diagnostics = [];
  const f = fixture({ clientId, clientSecret, reportExchangeFailure: data => diagnostics.push(data),
    fetchImpl: async (...args) => {
      requests.push(args); return { ok: true, status: 200, json: async () => ({
        access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 3600
      }) };
    } });
  const headers = { authorization: 'Bearer operator', host: 'internal.test:8766',
    'x-forwarded-host': 'wrong.test', 'x-forwarded-proto': 'http', forwarded: 'host=wrong.test;proto=http' };
  const start = await f.request('/auth/twitch/start', headers);
  const authorization = new URL(start.headers.Location);
  const cookie = start.headers['Set-Cookie'].split(';')[0];
  const result = await f.request(callback(authorization.searchParams.get('state')), { ...headers, cookie });
  assert.equal(result.status, 200);
  const [endpoint, options] = requests[0];
  assert.equal(endpoint, 'https://id.twitch.tv/oauth2/token'); assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const encoded = new URLSearchParams(options.body.toString());
  assert.deepEqual([...encoded.keys()].sort(), ['client_id', 'client_secret', 'code', 'grant_type', 'redirect_uri']);
  assert.equal(encoded.get('client_id'), authorization.searchParams.get('client_id'));
  assert.equal(encoded.get('client_id'), clientId); assert.equal(encoded.get('client_secret'), clientSecret);
  assert.equal(encoded.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  assert.equal(encoded.get('redirect_uri'), REDIRECT_URI);
  assert.equal(encoded.get('code'), 'private-code'); assert.equal(encoded.get('grant_type'), 'authorization_code');
  assert.equal(requests.length, 1); assert.deepEqual(diagnostics, []);
});

test('concurrent callbacks consume state before awaiting exchange and never exchange twice', async () => {
  let requests = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ fetchImpl: async () => { requests++; await pending; return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }; } });
  const a = await f.start(); const first = f.request(callback(a.state), { cookie: a.cookie });
  assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
  assert.equal(requests, 1); release(); assert.equal((await first).status, 502);
  assert.equal((await f.request(callback(a.state), { cookie: a.cookie })).status, 400);
  assert.equal(requests, 1);
});
