'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commandEnvelope, routeCommand } = require('../src/command-router');
const input = (text, id = 'message') => ({ broadcaster_user_id: '123', chatter_user_id: '456', message_id: id, message: { text } });
const parse = (text, id) => commandEnvelope(input(text, id), { broadcasterId: '123', timestamp: 1000 });

test('bounded canonical envelopes reject malformed commands and foreign channels', () => {
  assert.equal(parse(' !OcEaN ').type, 'planet.command');
  assert.equal(parse(' !MOVE E7E8Q ').move, 'e7e8q');
  for (const text of ['hello', '!ocean now', '!move', '!move e2e9', '!move e2e2', '!move e2e4 extra', '!move  e2e4', '!move <script>', '!move e7e8k']) assert.equal(parse(text), null);
  for (const extra of [{ broadcaster_user_id: '999' }, { source_broadcaster_user_id: '999' }, { chatter_user_id: 'bad' }, { message_id: '' }, { message: { text: 'x'.repeat(2001) } }]) {
    assert.throws(() => commandEnvelope({ ...input('!ocean'), ...extra }, { broadcasterId: '123', timestamp: 1000 }));
  }
  const envelope = parse('!move e2e4');
  assert.ok(Object.isFrozen(envelope));
  assert.doesNotMatch(JSON.stringify(envelope), /chatter_user_id|message_id|message"/);
  for (const extra of [{ domain: 'wallet' }, { type: 'planet.command' }, { move: 'e2e9' }, { version: 2 }, { timestamp: NaN }, { id: '__proto__' }]) {
    assert.throws(() => routeCommand({}, { ...envelope, ...extra }, '123'));
  }
  assert.throws(() => routeCommand({}, envelope, '999'));
});

test('domain transitions are immutable, isolated and logically deduplicated', () => {
  const initial = Object.freeze({});
  const chess = routeCommand(initial, parse('!move e2e4', 'chess-1'), '123');
  const before = JSON.stringify(chess.state);
  const planet = routeCommand(chess.state, parse('!ocean', 'planet-1'), '123');
  assert.equal(JSON.stringify(chess.state), before);
  assert.deepEqual(initial, {});
  assert.equal(planet.state.chess.commands, 1);
  assert.equal(planet.state.planet.commands, 1);
  assert.notEqual(planet.state.chess.messages, planet.state.planet.messages);
  assert.equal(chess.event.type, 'chess.command');
  assert.equal(planet.event.type, 'planet.command');
  assert.equal(routeCommand(planet.state, parse('!move e2e4', 'chess-1'), '123'), null);
  assert.equal(routeCommand(planet.state, parse('!ocean', 'chess-1'), '123'), null);
  assert.throws(() => routeCommand({ chess: { commands: -1, messages: {} } }, parse('!ocean'), '123'));
});
