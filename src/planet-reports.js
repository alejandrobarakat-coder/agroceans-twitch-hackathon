'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { JsonApi } = require('./ecosystem');
const { TwitchStorage, digest, readPrivate } = require('./twitch-storage');
const check = (ok, message = 'Invalid public report response') => { if (!ok) throw Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const folioId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/.test(value);
const stable = value => JSON.stringify(value, (_, row) => object(row) ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
function policyEntries(policy) {
  check(object(policy) && policy.version === 1 && Array.isArray(policy.reports) && policy.reports.length > 0 && policy.reports.length <= 50, 'Invalid public report policy');
  const seen = new Set();
  return policy.reports.map(row => {
    check(object(row) && folioId(row.folio) && typeof row.postId === 'string' && /^[1-9][0-9]{0,17}$/.test(row.postId) &&
      (!Object.hasOwn(row, 'commitmentSha256') || hex(row.commitmentSha256)) && !seen.has(row.folio), 'Invalid public report policy');
    seen.add(row.folio);
    return Object.freeze({ folio: row.folio, postId: row.postId, ...(row.commitmentSha256 ? { commitmentSha256: row.commitmentSha256.toLowerCase() } : {}) });
  });
}
function status(value, nullable = false) {
  if (nullable && (value === undefined || value === null)) return null;
  check(typeof value === 'string' && /^[a-z][a-z0-9_.:-]{0,79}$/i.test(value)); return value;
}
function stampRecord(value, folio, expectedCommitment) {
  if (value === undefined || value === null) { check(!expectedCommitment, 'Pinned STAMP commitment unavailable'); return null; }
  check(object(value));
  check(value.folio === undefined || value.folio === folio, 'STAMP folio mismatch');
  const tx = value.txid;
  check(tx === undefined || tx === null || hex(tx));
  const reference = value.reference;
  check(reference === undefined || reference === null || (typeof reference === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(reference)));
  const commitment = value.commitment_sha256;
  const canonical = value.canonical_manifest;
  if (value.manifest !== undefined) check(canonical !== undefined, 'Canonical manifest bytes required');
  let bytesMatched = false;
  if (commitment !== undefined || canonical !== undefined || expectedCommitment) {
    check(hex(commitment), 'Invalid STAMP commitment');
    check(!expectedCommitment || commitment.toLowerCase() === expectedCommitment, 'STAMP commitment mismatch');
    if (canonical !== undefined) {
      check(typeof canonical === 'string' && Buffer.byteLength(canonical) <= 100000, 'Invalid canonical manifest');
      const actual = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
      check(actual === commitment.toLowerCase(), 'STAMP commitment mismatch');
      const manifest = JSON.parse(canonical);
      check(object(manifest) && manifest.schema === 'agro.stamp-manifest.v1' && manifest.folio === folio &&
        hex(manifest.report_sha256) && hex(manifest.report_file_sha256) && Array.isArray(manifest.evidence) &&
        manifest.evidence.every(asset => object(asset) && typeof asset.kind === 'string' && hex(asset.sha256)), 'STAMP manifest binding mismatch');
      if (value.manifest !== undefined) check(stable(value.manifest) === stable(manifest), 'STAMP manifest mismatch');
      bytesMatched = true;
    }
  }
  return { status: status(value.status), chainStatus: status(value.chain_status, true),
    reference: reference ?? null, transactionId: tx ?? null,
    verification: 'service-reported; not evidence or blockchain verification',
    commitment: commitment ? { sha256: commitment.toLowerCase(), canonicalBytesMatched: bytesMatched,
      verification: bytesMatched ? 'SHA-256 bytes matched; not on-chain verification' : 'service-reported; canonical bytes unavailable' } : null };
}

class PublicMatrixReportsClient {
  constructor({ base, cookie, fetchImpl = fetch }) {
    check(typeof cookie === 'string' && cookie.length > 0 && !/[\r\n]/.test(cookie), 'Authorized Matrix session required');
    this.api = new JsonApi(base, fetchImpl); this.cookie = cookie; this.fetch = fetchImpl;
  }
  async publication(entry) {
    const url = new URL('index.php', this.api.base);
    url.searchParams.set('r', 'post/post/view'); url.searchParams.set('id', entry.postId);
    const response = await this.fetch(url, { method: 'GET', headers: { Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    check(response.status === 200 && !response.redirected && /text\/html\b/i.test(response.headers.get('content-type') || ''), 'Public publication unavailable');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; check(size <= 2000000, 'Public publication too large'); chunks.push(Buffer.from(chunk)); }
    const html = Buffer.concat(chunks).toString('utf8');
    check(!/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html), 'Login page is not a public report');
    // Publication route has no folio query input; require its actual visible marker,
    // never a script, comment, metadata attribute, redirect or login response.
    const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');
    const marker = 'AgroCeans reference: ' + entry.folio;
    const index = text.indexOf(marker);
    check(index >= 0 && !/[A-Za-z0-9:._-]/.test(text[index + marker.length] || ''), 'Public publication folio mismatch');
    return url.href;
  }
  async read(entries) {
    // Anonymous checks are separate from the authorized tracking request. The
    // session cookie is never forwarded to publication pages or another origin.
    const publicUrls = new Map();
    for (const entry of entries) publicUrls.set(entry.folio, await this.publication(entry));
    const raw = await this.api.get('index.php?r=agro_impact%2Freport%2Ftracking', { Cookie: this.cookie });
    check(object(raw) && raw.ok === true && Array.isArray(raw.reports) && raw.reports.length <= 10000);
    const allowed = new Map(entries.map(entry => [entry.folio, entry]));
    const rows = new Map();
    for (const row of raw.reports) {
      check(object(row) && folioId(row.folio));
      const entry = allowed.get(row.folio); if (!entry) continue;
      const normalized = { folio: row.folio, publicUrl: publicUrls.get(row.folio),
        stamp: stampRecord(row.stamp, row.folio, entry.commitmentSha256), simulated: false };
      if (rows.has(row.folio)) check(JSON.stringify(rows.get(row.folio)) === JSON.stringify(normalized), 'Conflicting duplicate report');
      rows.set(row.folio, normalized);
    }
    check(rows.size === entries.length, 'Allowlisted public report unavailable');
    return [...rows.values()].sort((a, b) => a.folio.localeCompare(b.folio));
  }
}

class PlanetReports {
  constructor({ directory, policy, client, publish = () => {}, now = () => new Date().toISOString() }) {
    this.entries = policyEntries(policy); this.client = client; this.publish = publish; this.now = now;
    this.storage = new TwitchStorage(directory);
    this.binding = digest(JSON.stringify([client.api.base.href, this.entries]));
    this.suspended = true; this.problem = 'not_refreshed'; this.pending = null;
  }
  load() {
    const state = this.storage.read('reports.json', { version: 1, binding: this.binding, revision: 0, reports: [], observedAt: null });
    check(state.version === 1 && state.binding === this.binding && Number.isSafeInteger(state.revision) && state.revision >= 0 && Array.isArray(state.reports) && state.reports.length <= 50, 'Invalid planet report storage');
    return state;
  }
  snapshot() {
    return this.storage.transaction(() => {
      const state = this.load();
      return { type: 'planet.snapshot', domain: 'planet', enabled: true, status: this.suspended ? this.problem : 'ready',
        revision: state.revision, reports: this.suspended ? [] : state.reports, observedAt: this.suspended ? null : state.observedAt,
        source: 'public HumHub publication + authorized Matrix tracking', simulated: false };
    });
  }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.perform().finally(() => { this.pending = null; }); return this.pending;
  }
  async perform() {
    try {
      const rows = await this.client.read(this.entries);
      const recovering = this.suspended;
      const events = this.storage.transaction(() => {
        const state = this.load(), changes = [];
        for (const row of rows) {
          const previous = state.reports.find(value => value.folio === row.folio);
          const oldHash = previous?.stamp?.commitment?.sha256, newHash = row.stamp?.commitment?.sha256;
          check(!oldHash || oldHash === newHash, 'STAMP commitment changed; review required');
          if (JSON.stringify(previous) !== JSON.stringify(row)) changes.push(row);
        }
        if (changes.length || recovering) { check(state.revision < Number.MAX_SAFE_INTEGER, 'Planet revision capacity'); state.revision++; }
        state.reports = rows; state.observedAt = this.now(); this.storage.write('reports.json', state);
        return changes.map(report => ({ type: 'planet.report', domain: 'planet', report,
          revision: state.revision, eventId: digest(JSON.stringify([this.binding, state.revision, report])), simulated: false }));
      });
      this.suspended = false; this.problem = null;
      if (recovering) this.publish(this.snapshot());
      for (const event of events) this.publish(event);
      return this.snapshot();
    } catch {
      const changed = !this.suspended || this.problem !== 'unavailable';
      this.suspended = true; this.problem = 'unavailable';
      if (changed) this.publish({ type: 'planet.unavailable', domain: 'planet', reports: [], simulated: false });
      throw Error('Public report refresh unavailable; publication, authorization or validation failed');
    }
  }
}
function createPlanetReports({ env = process.env, publish } = {}) {
  if (env.AGRO_PLANET_REPORTS_ENABLED !== 'true') return null;
  check(env.AGRO_REAL_PAYMENTS_ENABLED === 'false', 'Planet reports require payment kill switch');
  check(typeof env.AGRO_PLANET_PUBLIC_REPORTS_FILE === 'string' && env.AGRO_PLANET_PUBLIC_REPORTS_FILE.length > 0, 'Public report policy required');
  const root = path.resolve(__dirname, '..');
  const filename = path.resolve(root, env.AGRO_PLANET_PUBLIC_REPORTS_FILE);
  check(filename.startsWith(root + path.sep), 'Public report policy must be inside this repository');
  const policy = JSON.parse(readPrivate(filename, 64000));
  const client = new PublicMatrixReportsClient({ base: env.AGRO_MATRIX_URL, cookie: env.AGRO_MATRIX_SESSION_COOKIE });
  return new PlanetReports({ directory: path.join(root, 'var/planet-reports'), policy, client, publish });
}
module.exports = { PublicMatrixReportsClient, PlanetReports, policyEntries, createPlanetReports };
