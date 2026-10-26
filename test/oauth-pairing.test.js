const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createPairingStore, ENTRY, COOKIE, ORIGIN, TTL, hash } = require('../src/oauth-pairing');
const { createTwitchOAuth } = require('../src/twitch-oauth');
const { run } = require('../scripts/oauth-pairing');

function fixture(t, options = {}) {
  fs.mkdirSync(path.resolve(__dirname, '../var'), { recursive: true });
  const parent = fs.mkdtempSync(path.resolve(__dirname, '../var/pairing-test-'));
  const directory = path.join(parent, 'records');
  fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let time = Date.now();
  const now = () => time;
  const store = createPairingStore({ directory, now, limit: options.limit || 100 });
  const saved = []; let exchanges = 0;
  const handle = createTwitchOAuth({ clientId: 'fixture-client', clientSecret: 'fixture-secret',
    pairingEnabled: true, pairingStore: store, now, authorize: () => false,
    fetchImpl: async () => { exchanges++; return { ok: true, json: async () => ({
      access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'bearer', scope: [], expires_in: 3600
    }) }; }, store: async data => saved.push(data), ...options.oauth });
  function browser() {
    let cookie = ''; let csrf;
    async function request(method = 'GET', action, extra = {}) {
      const body = extra.body ?? (action ? new URLSearchParams({ action, csrf }).toString() : '');
      const req = extra.req || Readable.from([Buffer.from(body)]);
      req.method = method;
      req.headers = { origin: ORIGIN, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded', cookie, ...extra.headers };
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
        writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
      await handle(req, res, new URL(extra.route || ENTRY, ORIGIN));
      for (const value of [].concat(res.headers['Set-Cookie'] || [])) {
        if (value.startsWith(`${COOKIE}=`)) cookie = value.split(';')[0];
      }
      const match = res.body?.match(/name="csrf" value="([a-f0-9]+)"/);
      if (match) csrf = match[1];
      return res;
    }
    return { request, cookie: () => cookie, csrf: () => csrf,
      async create() {
        assert.equal((await request()).status, 200);
        assert.equal((await request('POST', 'create')).status, 303);
        const res = await request('POST', 'status'); assert.equal(res.status, 200);
        return JSON.parse(res.body);
      } };
  }
  return { directory, now, store, browser, saved, exchanges: () => exchanges,
    advance: (ms = 3000) => { time += ms; } };
}

test('stable page creates only a private CSRF browser session; requests require explicit POST', async t => {
  const f = fixture(t); const b = f.browser(); const page = await b.request();
  assert.equal(page.status, 200);
  assert.match(page.headers['Set-Cookie'], /__Host-twitch-pairing=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300/);
  assert.match(page.headers['Cache-Control'], /no-store/);
  assert.equal(page.headers['Referrer-Policy'], 'same-origin');
  assert.match(page.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['Content-Security-Policy'], /connect-src 'self'/);
  assert.match(page.body, /button.disabled = true/);
  assert.doesNotMatch(page.body, /location.hash|fixture-secret|fixture-access/);
  assert.equal(fs.readdirSync(f.directory).length, 0);
  assert.equal((await b.request()).body.match(/name="csrf" value="([a-f0-9]+)"/)[1], b.csrf());
  assert.equal((await b.request('POST', 'continue')).status, 409);
  assert.equal((await b.request('GET', null, { route: '/auth/twitch/start' })).status, 403);
});

test('CLI-approved browser handoff preserves state/cookie binding and server-only tokens', async t => {
  const f = fixture(t); const b = f.browser(); const record = await b.create();
  assert.match(record.id, /^[a-f0-9]{64}$/); assert.match(record.phrase, /^[a-f0-9]{24}$/);
  assert.equal((await b.request('POST', 'continue')).status, 409);
  assert.equal(f.store.approve(record.id, 'wrong'), false);
  assert.equal(f.store.approve(record.id, record.phrase), true);
  assert.equal(f.store.approve(record.id, record.phrase), false);
  f.advance(); const status = await b.request('POST', 'status');
  assert.equal(JSON.parse(status.body).status, 'approved');
  assert.doesNotMatch(status.body, /binding|csrf|access_token|refresh_token/);
  f.advance(); assert.equal((await b.request('POST', 'status')).status, 200);
  const start = await b.request('POST', 'continue'); assert.equal(start.status, 200);
  assert.equal(start.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(start.headers['Set-Cookie'].length, 2);
  assert.match(start.headers['Set-Cookie'][0], /Max-Age=0/);
  const cookie = start.headers['Set-Cookie'][1].split(';')[0];
  const target = new URL(start.body.match(/<a href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(target.origin, 'https://id.twitch.tv');
  assert.match(target.searchParams.get('state'), /^[a-f0-9]{64}$/);
  assert.ok(!target.href.includes(record.id) && !target.href.includes(record.phrase));
  const callback = `/auth/twitch/callback?state=${target.searchParams.get('state')}&code=fixture-code`;
  const other = f.browser();
  assert.equal((await other.request('GET', null, { route: callback })).status, 400);
  assert.equal(f.exchanges(), 0);
  const result = await b.request('GET', null, { route: callback, headers: { cookie } });
  assert.equal(result.status, 200); assert.equal(f.saved.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-access|fixture-refresh|fixture-code/);
  assert.equal((await b.request('GET', null, { route: callback, headers: { cookie } })).status, 400);
  assert.equal(f.exchanges(), 1);
  assert.equal((await b.request('POST', 'continue')).status, 403);
});

test('identifiers and phrases cannot authorize another browser; injected IDs and browser approval rejected', async t => {
  const f = fixture(t); const a = f.browser(); const record = await a.create();
  const b = f.browser(); await b.request();
  assert.equal((await b.request('POST', 'status')).status, 409);
  assert.equal((await b.request('POST', 'approve')).status, 409);
  const body = new URLSearchParams({ action: 'continue', csrf: b.csrf(), id: record.id, phrase: record.phrase }).toString();
  assert.equal((await b.request('POST', null, { body })).status, 400);
  f.store.approve(record.id, record.phrase);
  const second = await b.create();
  assert.notEqual(record.id, second.id);
  assert.equal((await b.request('POST', 'continue')).status, 409);
  assert.equal(f.store.consume(record.id, hash(b.cookie().split('=')[1])), false);
  assert.equal((await a.request('POST', 'continue')).status, 200);
});

test('strict Origin, Fetch Metadata, CSRF, cookie, parameter and body gates fail closed', async t => {
  const f = fixture(t); const b = f.browser(); await b.request();
  for (const origin of [undefined, '', 'null', 'https://evil.test', 'https://other.theagrostore.com', 'http://twitch.theagrostore.com']) {
    assert.equal((await b.request('POST', 'create', { headers: { origin } })).status, 403);
  }
  for (const site of ['cross-site', 'same-site', 'none', 'bad']) {
    assert.equal((await b.request('POST', 'create', { headers: { 'sec-fetch-site': site } })).status, 403);
  }
  for (const site of ['cross-site', 'same-site']) assert.equal((await b.request('GET', null, { headers: { 'sec-fetch-site': site } })).status, 403);
  assert.equal((await b.request('POST', 'create', { headers: { cookie: '' } })).status, 403);
  assert.equal((await b.request('POST', 'create', { headers: { cookie: `${b.cookie()}; ${b.cookie()}` } })).status, 403);
  for (const body of ['action=create', `action=create&csrf=${'a'.repeat(64)}`, `action=create&csrf=${b.csrf()}&csrf=${b.csrf()}`, `action=create&csrf=${b.csrf()}&extra=x`]) {
    assert.ok([400, 403].includes((await b.request('POST', null, { body })).status));
  }
  assert.equal((await b.request('POST', null, { body: 'x'.repeat(257) })).status, 413);
  assert.equal((await b.request('POST', 'create', { headers: { 'content-type': 'application/json' } })).status, 415);
  assert.equal((await b.request('GET', null, { route: ENTRY + '?id=invalid' })).status, 400);
  assert.equal((await b.request('DELETE')).status, 405);
  assert.equal((await b.request('POST', 'create', { headers: { 'sec-fetch-site': undefined } })).status, 303);
});

test('expiry, revocation, polling bounds, reload and duplicate creation', async t => {
  const f = fixture(t); const b = f.browser(); const record = await b.create();
  assert.equal((await b.request('POST', 'status')).status, 429);
  assert.equal((await b.request('POST', 'create')).status, 409);
  const page = await b.request(); assert.match(page.body, /Waiting for local operator approval/);
  assert.match(page.body, /name="action" value="continue"/);
  f.store.revokeAll(); f.advance();
  assert.equal((await b.request('POST', 'status')).status, 410);
  assert.equal(f.store.approve(record.id, record.phrase), false);
  const next = await b.create(); f.store.approve(next.id, next.phrase);
  f.advance(TTL);
  assert.equal((await b.request('POST', 'continue')).status, 403);
  assert.equal(f.store.inspect(next.id), null);
  assert.equal((await b.request()).status, 200);
});

test('concurrent browser creates and starts have exactly one winner', async t => {
  const f = fixture(t); const b = f.browser(); await b.request();
  const creates = await Promise.all(Array.from({ length: 10 }, () => b.request('POST', 'create')));
  assert.equal(creates.filter(x => x.status === 303).length, 1);
  const record = JSON.parse((await b.request('POST', 'status')).body);
  f.store.approve(record.id, record.phrase);
  const starts = await Promise.all(Array.from({ length: 10 }, () => b.request('POST', 'continue')));
  assert.equal(starts.filter(x => x.status === 200).length, 1);
  assert.equal(f.store.inspect(record.id), null);
});

test('store enforces private permissions, hashed binding, limits and atomic consumption across processes', async t => {
  const f = fixture(t, { limit: 1 }); const binding = 'a'.repeat(64);
  const id = f.store.create(hash(binding), f.now() + TTL); const record = f.store.inspect(id);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  const filename = path.join(f.directory, id + '.json');
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(filename, 'utf8').includes(binding));
  assert.throws(() => f.store.create(hash(binding), f.now() + TTL), /capacity/);
  f.store.approve(id, record.phrase);
  const script = `const {createPairingStore}=require('./src/oauth-pairing'); const s=createPairingStore({directory:process.argv[1]}); process.stdout.write(String(s.consume(process.argv[2],process.argv[3])));`;
  const child = spawnSync(process.execPath, ['-e', script, f.directory, id, hash(binding)], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.ifError(child.error); assert.equal(child.status, 0); assert.equal(child.stdout, 'true');
  assert.equal(f.store.consume(id, hash(binding)), false);
  const other = f.store.create(hash(binding), f.now() + TTL);
  fs.chmodSync(path.join(f.directory, other + '.json'), 0o644);
  assert.throws(() => f.store.inspect(other), /Unsafe/);
  fs.chmodSync(f.directory, 0o755);
  assert.throws(() => f.store.inspect(other), /Unsafe/);
});

test('storage symlinks, corrupt records, lock contention and exceptions fail closed', async t => {
  const f = fixture(t); const b = f.browser(); const record = await b.create();
  const filename = path.join(f.directory, record.id + '.json');
  const contents = fs.readFileSync(filename); fs.unlinkSync(filename);
  const target = path.join(f.directory, 'target'); fs.writeFileSync(target, contents, { mode: 0o600 });
  fs.symlinkSync(target, filename); assert.throws(() => f.store.inspect(record.id));
  fs.unlinkSync(filename); fs.writeFileSync(filename, '{', { mode: 0o600 });
  assert.throws(() => f.store.inspect(record.id));
  f.advance(); assert.equal((await b.request('POST', 'status')).status, 503);
  fs.writeFileSync(filename, contents); fs.mkdirSync(path.join(f.directory, '.lock'), { mode: 0o700 });
  assert.throws(() => f.store.approve(record.id, record.phrase));
  f.advance(); const response = await b.request('POST', 'status');
  assert.equal(response.status, 503); assert.doesNotMatch(response.body, /\.lock|binding|fixture-secret/);
});

test('pairing disabled by default and global request/session capacity bounded', async t => {
  const f = fixture(t, { oauth: { pairingEnabled: false } });
  assert.equal((await f.browser().request()).status, 503);
  const g = fixture(t); const b = g.browser();
  for (let i = 0; i < 100; i++) assert.equal((await g.browser().request()).status, 200);
  assert.equal((await b.request()).status, 429);
  g.advance(TTL); assert.equal((await b.request()).status, 200);
  for (let i = 0; i < 299; i++) await b.request('DELETE'); // Unsupported methods do not use the rate budget.
  for (let i = 0; i < 299; i++) await b.request();
  assert.equal((await b.request()).status, 429);
  g.advance(60000); assert.equal((await b.request()).status, 200);
});

test('expiry is rechecked after a delayed POST body', async t => {
  const f = fixture(t); const b = f.browser(); await b.request();
  const req = new PassThrough();
  const result = b.request('POST', 'create', { req });
  f.advance(TTL); req.end(new URLSearchParams({ action: 'create', csrf: b.csrf() }).toString());
  assert.equal((await result).status, 403);
});

test('CLI refuses noninteractive approval and unexpected arguments without accessing storage', async () => {
  let touched = false;
  const store = { inspect() { touched = true; }, revokeAll() { touched = true; } };
  for (const args of [['approve'], ['revoke-all'], ['approve', 'id'], ['mint']]) {
    await assert.rejects(run({ args, input: { isTTY: false }, output: { isTTY: false }, store }));
  }
  assert.equal(touched, false);
});

test('CLI requires matching phrase, rechecks expiry after confirmation, and supports revocation', async t => {
  const f = fixture(t); const binding = hash('b'.repeat(64));
  let text = ''; let closed = 0;
  const output = { isTTY: true, write(value) { text += value; } };
  const input = { isTTY: true };
  async function approve(id, confirmation, beforeConfirmation = () => {}) {
    let question = 0;
    return run({ args: ['approve'], input, output, store: f.store,
      createTerminal: () => ({
        async question() { if (question++ === 0) return id; beforeConfirmation(); return confirmation; },
        close() { closed++; }
      }) });
  }
  const id = f.store.create(binding, f.now() + TTL); const record = f.store.inspect(id);
  await approve(id, 'wrong'); assert.equal(f.store.inspect(id).status, 'pending');
  assert.match(text, /Approval cancelled/);
  await approve(id, record.phrase); assert.equal(f.store.inspect(id).status, 'approved');
  assert.match(text, /Approved once/);
  await assert.rejects(approve(id, record.phrase));
  const expired = f.store.create(binding, f.now() + TTL); const phrase = f.store.inspect(expired).phrase;
  await assert.rejects(approve(expired, phrase, () => f.advance(TTL)));
  assert.equal(f.store.inspect(expired), null);
  const revoked = f.store.create(binding, f.now() + TTL);
  await run({ args: ['revoke-all'], input, output, store: f.store });
  assert.equal(f.store.inspect(revoked), null);
  assert.equal(closed, 4);
  assert.ok(!text.includes(binding));
});

test('independent processes race approval consumption and elect only one winner', async t => {
  const { spawn } = require('node:child_process');
  const f = fixture(t); const binding = hash('c'.repeat(64));
  const id = f.store.create(binding, f.now() + TTL);
  f.store.approve(id, f.store.inspect(id).phrase);
  const script = `const {createPairingStore}=require('./src/oauth-pairing'); try { const s=createPairingStore({directory:process.argv[1]}); process.stdout.write(s.consume(process.argv[2],process.argv[3])?'winner':'rejected'); } catch { process.stdout.write('busy'); }`;
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, f.directory, id, binding], { cwd: path.resolve(__dirname, '..') });
    let output = ''; child.stdout.on('data', data => { output += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output) : reject(Error('Child failed')));
  })));
  assert.equal(outcomes.filter(value => value === 'winner').length, 1);
  assert.ok(outcomes.every(value => ['winner', 'rejected', 'busy'].includes(value)));
});

test('generated page polls only its own status, uses textContent, and prevents repeated submits', async t => {
  const vm = require('node:vm');
  const f = fixture(t); const b = f.browser(); const record = await b.create();
  f.store.approve(record.id, record.phrase);
  const page = await b.request();
  const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = new Map(['form', 'button', '#request', '#phrase', '#status'].map(key => [key, { disabled: true, textContent: '' }]));
  let submit; let fetches = 0;
  elements.get('form').addEventListener = (name, callback) => { if (name === 'submit') submit = callback; };
  const context = { document: { querySelector: selector => elements.get(selector) }, Date, URLSearchParams,
    addEventListener() {}, location: { replace() {} }, setTimeout() { throw Error('Approved polling should stop'); },
    async fetch(url, options) {
      fetches++; assert.equal(url, ENTRY); assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'same-origin');
      const fields = new URLSearchParams(options.body); assert.equal(fields.get('action'), 'status');
      assert.equal(fields.get('csrf'), b.csrf());
      return { ok: true, json: async () => record && { ...record, status: 'approved' } };
    } };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1); assert.equal(elements.get('button').disabled, false);
  assert.equal(elements.get('#request').textContent, 'Request: ' + record.id);
  submit(); assert.equal(elements.get('button').disabled, true);
  assert.equal(f.store.inspect(record.id).status, 'approved');
});

test('browser resumes polling after transient failures and observes later CLI approval', async t => {
  const vm = require('node:vm');
  for (const failure of ['reload-rate-limit', 'storage-busy', 'network']) {
    await t.test(failure, async t => {
      const f = fixture(t); const b = f.browser(); const record = await b.create();
      // create() includes a successful initial status check. Reloading immediately
      // starts a second script inside the server's two-second status window.
      if (failure !== 'reload-rate-limit') f.advance();
      if (failure === 'storage-busy') fs.mkdirSync(path.join(f.directory, '.lock'), { mode: 0o700 });
      const page = await b.request();
      const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
      const elements = new Map(['form', 'button', '#request', '#phrase', '#status'].map(key => [key, { disabled: true, textContent: '' }]));
      elements.get('form').addEventListener = () => {};
      const timers = []; const statuses = []; let calls = 0;
      const context = {
        document: { querySelector: selector => elements.get(selector) },
        Date: { now: f.now }, URLSearchParams, addEventListener() {}, location: { replace() {} },
        setTimeout(callback, delay) { timers.push({ callback, delay }); },
        async fetch(url, options) {
          assert.equal(url, ENTRY); calls++;
          if (failure === 'network' && calls === 1) throw Error('Simulated offline request');
          const result = await b.request('POST', null, { body: options.body.toString() });
          statuses.push(result.status);
          return { ok: result.status === 200, status: result.status,
            headers: { get: name => result.headers[name] || null }, json: async () => JSON.parse(result.body) };
        }
      };
      vm.runInNewContext(script, context);
      await new Promise(resolve => setImmediate(resolve));
      if (failure !== 'network') assert.equal(statuses[0], failure === 'reload-rate-limit' ? 429 : 503);
      assert.equal(elements.get('button').disabled, true);
      assert.equal(timers.length, 1, 'a transient status failure must schedule another poll');
      if (failure === 'storage-busy') fs.rmdirSync(path.join(f.directory, '.lock'));
      assert.equal(f.store.approve(record.id, record.phrase), true);
      const timer = timers.shift(); f.advance(timer.delay);
      await timer.callback();
      assert.equal(elements.get('button').disabled, false);
      assert.equal(elements.get('#status').textContent, 'Approved. Continue in this browser.');
      assert.equal(timers.length, 0, 'approval stops polling');
      assert.equal(f.store.inspect(record.id).status, 'approved', 'polling does not consume approval');
    });
  }
});

test('poll recovery honors Retry-After and stops at authorization failure or expiry', async t => {
  const vm = require('node:vm');
  for (const status of [400, 403, 410, 429, 503]) {
    await t.test(String(status), async t => {
      const f = fixture(t); const b = f.browser(); await b.create();
      const page = await b.request();
      const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
      const elements = new Map(['form', 'button', '#request', '#phrase', '#status'].map(key => [key, { disabled: true, textContent: '' }]));
      elements.get('form').addEventListener = () => {};
      const timers = []; let calls = 0;
      vm.runInNewContext(script, {
        document: { querySelector: selector => elements.get(selector) }, Date: { now: f.now }, URLSearchParams,
        addEventListener() {}, location: { replace() {} }, setTimeout(callback, delay) { timers.push({ callback, delay }); },
        async fetch() {
          calls++;
          return { ok: false, status, headers: { get: name => name === 'Retry-After' ? '60' : null } };
        }
      });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(elements.get('button').disabled, true);
      const transient = status === 429 || status >= 500;
      assert.equal(timers.length, transient ? 1 : 0);
      if (transient) {
        assert.equal(timers[0].delay, 60000);
        f.advance(TTL); await timers.shift().callback();
        assert.equal(calls, 1, 'expired requests must not poll again');
        assert.equal(timers.length, 0);
        assert.match(elements.get('#status').textContent, /expired/);
      }
    });
  }
});

test('approved form ends with an HTML document before navigating to Twitch outside the form redirect chain', async t => {
  const vm = require('node:vm');
  const f = fixture(t); const b = f.browser(); const record = await b.create();
  const page = await b.request();
  assert.match(page.body, /<form method="post" action="\/auth\/twitch\/connect"/);
  assert.doesNotMatch(page.body, /<base\b|http-equiv=["']Content-Security-Policy/i);
  assert.equal(f.store.approve(record.id, record.phrase), true);
  const handoff = await b.request('POST', 'continue');
  // A 3xx here makes all subsequent Twitch login redirects part of a form
  // navigation. Chrome then checks those redirects against the form's CSP.
  assert.equal(handoff.status, 200);
  assert.match(page.headers['Content-Security-Policy'], /(?:^|;)\s*form-action 'self';/);
  assert.equal(handoff.headers.Location, undefined);
  assert.equal(handoff.headers.Refresh, undefined);
  assert.match(handoff.headers['Content-Type'], /^text\/html/);
  assert.equal(handoff.headers['Referrer-Policy'], 'no-referrer');
  assert.match(handoff.headers['Cache-Control'], /no-store/);
  const csp = handoff.headers['Content-Security-Policy'];
  assert.equal(typeof csp, 'string');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /base-uri 'none'; frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /https:|\*|unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(handoff.body, /<form\b|<base\b|http-equiv|fixture-secret|fixture-access|fixture-refresh/);
  const script = handoff.body.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(script); assert.ok(csp.includes(`script-src 'nonce-${script[1]}'`));
  let destination;
  vm.runInNewContext(script[2], { location: { replace(value) { destination = value; } } });
  const anchor = handoff.body.match(/<a href="([^"]+)"[^>]*>/);
  assert.ok(anchor, 'a normal anchor remains usable if script execution is blocked');
  assert.equal(anchor[1].replaceAll('&amp;', '&'), destination);
  const target = new URL(destination);
  assert.equal(target.origin + target.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(target.searchParams.get('response_type'), 'code');
  assert.equal(target.searchParams.get('redirect_uri'), `${ORIGIN}/auth/twitch/callback`);
  assert.match(target.searchParams.get('state'), /^[a-f0-9]{64}$/);
  assert.ok(!destination.includes(record.id) && !destination.includes(record.phrase));
  assert.equal(handoff.headers['Set-Cookie'].length, 2);
  assert.match(handoff.headers['Set-Cookie'][0], /Max-Age=0/);
  assert.match(handoff.headers['Set-Cookie'][1], /__Host-twitch-oauth=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.equal(f.store.inspect(record.id), null);
  assert.equal((await b.request('POST', 'continue')).status, 403);
});

test('handoff safely encodes configured query values and keeps its destination fixed', async t => {
  const vm = require('node:vm');
  const scopes = 'test:"&</script><script>throw Error("injected")</script>';
  const f = fixture(t, { oauth: { scopes } }); const b = f.browser(); const record = await b.create();
  f.store.approve(record.id, record.phrase);
  const handoff = await b.request('POST', 'continue', { headers: { host: 'evil.test' } });
  assert.equal(handoff.status, 200);
  assert.equal((handoff.body.match(/<script\b/g) || []).length, 1);
  assert.equal((handoff.body.match(/<\/script>/g) || []).length, 1);
  assert.ok(!handoff.body.includes(scopes));
  let destination;
  vm.runInNewContext(handoff.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    location: { replace(value) { destination = value; } }
  });
  const target = new URL(destination);
  assert.equal(target.origin + target.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(target.searchParams.get('scope'), scopes);
  assert.equal(handoff.body.match(/<a href="([^"]+)"/)[1].replaceAll('&amp;', '&'), destination);
  assert.match(handoff.headers['Content-Security-Policy'], /form-action 'none'/);
});

test('chat reauthorization requests exactly three grants and preserves old credentials until callback success', async t => {
  const { storeCredentials } = require('../src/twitch-oauth');
  const { TwitchStorage } = require('../src/twitch-storage');
  const { TwitchClient, TwitchTokens } = require('../src/twitch-client');
  const permissions = ['user:read:chat', 'user:bot', 'channel:bot'];
  const broadcasterId = '1592061028';
  for (const outcome of ['denied', 'exchange-failed', 'missing-scope', 'success']) {
    const f = fixture(t); const credentialsDirectory = path.join(f.directory, 'oauth');
    await storeCredentials({ access_token: 'fixture-existing-access', refresh_token: 'fixture-existing-refresh', scope: [] }, credentialsDirectory);
    const filename = path.join(credentialsDirectory, 'credentials.json');
    const before = fs.readFileSync(filename, 'utf8'); let exchanges = 0;
    const handle = createTwitchOAuth({ clientId: 'fixture-client', clientSecret: 'fixture-secret', scopes: permissions.join(' '),
      pairingEnabled: true, pairingStore: f.store, now: f.now, authorize: () => false, reportExchangeFailure: () => {},
      store: data => storeCredentials(data, credentialsDirectory), fetchImpl: async () => {
        exchanges++;
        if (outcome === 'exchange-failed') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
        return { ok: true, status: 200, json: async () => ({ access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh',
          token_type: 'bearer', expires_in: 3600, ...(outcome === 'missing-scope' ? {} : { scope: permissions }) }) };
      } });
    let cookie = '', csrf;
    async function request(method, body = '', route = ENTRY, extraHeaders = {}) {
      const req = Readable.from([Buffer.from(body)]); req.method = method;
      req.headers = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', cookie, ...extraHeaders };
      const res = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
        writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(value) { this.body = value; } };
      await handle(req, res, new URL(route, ORIGIN));
      for (const value of [].concat(res.headers['Set-Cookie'] || [])) if (value.startsWith(`${COOKIE}=`)) cookie = value.split(';')[0];
      const match = res.body?.match(/name="csrf" value="([a-f0-9]+)"/); if (match) csrf = match[1];
      return res;
    }
    const form = action => new URLSearchParams({ action, csrf }).toString();
    const page = await request('GET'); assert.equal(page.status, 200);
    assert.match(page.headers['Content-Security-Policy'], /form-action 'self';/);
    assert.equal((await request('POST', form('create'))).status, 303);
    const pending = JSON.parse((await request('POST', form('status'))).body);
    assert.equal(f.store.approve(pending.id, pending.phrase), true);
    const handoff = await request('POST', form('continue')); assert.equal(handoff.status, 200);
    assert.match(handoff.headers['Content-Security-Policy'], /form-action 'none'/);
    const target = new URL(handoff.body.match(/<a href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
    assert.equal(target.searchParams.get('scope'), permissions.join(' '));
    assert.equal(target.searchParams.getAll('scope').length, 1);
    assert.equal(target.searchParams.get('response_type'), 'code');
    assert.equal(target.searchParams.get('redirect_uri'), `${ORIGIN}/auth/twitch/callback`);
    assert.equal(fs.readFileSync(filename, 'utf8'), before);
    const state = target.searchParams.get('state'); const oauthCookie = handoff.headers['Set-Cookie'].find(value => value.startsWith('__Host-twitch-oauth=')).split(';')[0];
    assert.equal((await request('GET', '', `/auth/twitch/callback?state=${state}&code=fixture-code`)).status, 400);
    assert.equal(fs.readFileSync(filename, 'utf8'), before); assert.equal(exchanges, 0);
    const callback = `/auth/twitch/callback?state=${state}` + (outcome === 'denied' ? '&error=access_denied' : '&code=fixture-code');
    const result = await request('GET', '', callback, { cookie: oauthCookie });
    assert.equal(result.status, outcome === 'denied' ? 400 : outcome === 'success' ? 200 : 502);
    if (outcome !== 'success') { assert.equal(fs.readFileSync(filename, 'utf8'), before); continue; }
    const after = fs.readFileSync(filename, 'utf8'); assert.notEqual(after, before);
    assert.deepEqual(JSON.parse(after).scope, permissions);
    let validatedUser = broadcasterId; const calls = [];
    const client = new TwitchClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(url, 'https://id.twitch.tv/oauth2/validate');
      assert.equal(options.headers.Authorization, 'OAuth fixture-new-access');
      return new Response(JSON.stringify({ client_id: 'fixture-client', user_id: validatedUser, scopes: permissions, expires_in: 3600 }), { status: 200 });
    } });
    const tokens = new TwitchTokens({ client, storage: new TwitchStorage(path.join(f.directory, 'chat')),
      credentialsFile: filename, broadcasterId, readerId: broadcasterId, now: f.now });
    assert.equal((await tokens.check({ refresh: false })).status, 'valid');
    validatedUser = '999'; await assert.rejects(tokens.check({ refresh: false }), { category: 'identity_mismatch' });
    assert.ok(calls.every(url => url.endsWith('/validate')));
    assert.equal(fs.readFileSync(filename, 'utf8'), after);
    assert.equal((await request('GET', '', callback, { cookie: oauthCookie })).status, 400);
    assert.equal(exchanges, 1);
  }
});
