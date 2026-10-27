'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { run } = require('../scripts/twitch-readiness');

test('readiness harness runs only fixed synthetic tests in a clean child environment', () => {
  let called = false, text = '';
  const status = run({ output: { write: value => { text += value; } }, spawnImpl: (executable, args, options) => {
    called = true; assert.equal(executable, process.execPath);
    assert.deepEqual(args, ['--test', '--test-name-pattern=Stage 6A', path.resolve(__dirname, 'twitch-chat.test.js')]);
    assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'NODE_ENV', 'PATH']);
    assert.equal(options.cwd, path.resolve(__dirname, '..')); assert.equal(options.shell, false); assert.equal(options.timeout, 60000);
    return { status: 0, stdout: 'synthetic tests passed\n', stderr: '' };
  } });
  assert.equal(status, 0); assert.equal(called, true); assert.match(text, /^SYNTHETIC ONLY:/);
});

test('readiness harness rejects live-target arguments and cannot silently pass failed execution', () => {
  let calls = 0;
  assert.throws(() => run({ args: ['--url=https://example.test'], spawnImpl: () => { calls++; } }), /no arguments/);
  assert.equal(calls, 0);
  let text = '';
  assert.equal(run({ output: { write: value => { text += value; } }, spawnImpl: () => ({ status: null, error: { code: 'EPERM' } }) }), 1);
  assert.match(text, /no live fallback/);
});
