'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run({ args = [], spawnImpl = spawnSync, output = process.stdout } = {}) {
  if (args.length) throw Error('Readiness harness accepts no arguments or live endpoints');
  output.write('SYNTHETIC ONLY: fake Twitch API, locally signed fixtures, ephemeral loopback HTTP/SSE. No live credentials, video or issuance.\n');
  const root = path.resolve(__dirname, '..');
  const result = spawnImpl(process.execPath, ['--test', '--test-name-pattern=Stage 6A', path.join(root, 'test/twitch-chat.test.js')], {
    cwd: root, env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'test' },
    shell: false, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024
  });
  if (result.stdout) output.write(result.stdout);
  if (result.stderr) output.write(result.stderr);
  if (result.error) output.write('Synthetic harness could not complete. Check loopback/child-process permissions; no live fallback was attempted.\n');
  return Number.isInteger(result.status) ? result.status : 1;
}
if (require.main === module) {
  try { process.exitCode = run({ args: process.argv.slice(2) }); }
  catch { console.error('Readiness harness accepts no arguments or live endpoints.'); process.exitCode = 1; }
}
module.exports = { run };
