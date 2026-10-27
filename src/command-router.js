'use strict';
const { check } = require('./twitch-client');
const { digest } = require('./twitch-storage');
const numericId = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uci = value => typeof value === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value) && value.slice(0, 2) !== value.slice(2, 4);

// Internal boundary only: the caller must authenticate EventSub before parsing.
// Syntax validation is not chess legality or environmental verification.
function commandEnvelope(value, { broadcasterId, timestamp }) {
  check(numericId(broadcasterId) && value?.broadcaster_user_id === broadcasterId &&
    (!value.source_broadcaster_user_id || value.source_broadcaster_user_id === broadcasterId), 'command_channel_mismatch');
  check(numericId(value.chatter_user_id) && typeof value.message_id === 'string' &&
    value.message_id.length > 0 && value.message_id.length <= 160 &&
    typeof value.message?.text === 'string' && value.message.text.length <= 2000 &&
    Number.isSafeInteger(timestamp) && timestamp >= 0, 'invalid_command');
  const text = value.message.text.trim().toLowerCase();
  let domain, command, move = null;
  if (text === '!ocean') { domain = 'planet'; command = '!ocean'; }
  else if (text.startsWith('!move ')) {
    move = text.slice(6);
    if (!uci(move)) return null;
    domain = 'chess'; command = '!move';
  } else return null;
  return Object.freeze({ version: 1, type: domain + '.command', domain, command, move,
    channelId: broadcasterId, id: digest(broadcasterId + ':' + value.message_id),
    participantId: digest(broadcasterId + ':' + value.chatter_user_id), timestamp });
}

// Pure transition, committed by the caller's existing storage transaction.
// No callbacks, financial clients, network operations or mutable shared state.
function routeCommand(state, envelope, broadcasterId) {
  check(envelope && numericId(broadcasterId) && envelope.channelId === broadcasterId, 'command_channel_mismatch');
  const { domain, command, move } = envelope;
  check(envelope.version === 1 && ['chess', 'planet'].includes(domain) && envelope.type === domain + '.command' &&
    hash(envelope.id) && hash(envelope.participantId) && Number.isSafeInteger(envelope.timestamp) && envelope.timestamp >= 0 &&
    (domain === 'planet' ? command === '!ocean' && move === null : command === '!move' && uci(move)), 'invalid_command');
  const current = state || {};
  for (const name of ['chess', 'planet']) {
    const row = current[name];
    if (row) check(Number.isSafeInteger(row.commands) && row.commands >= 0 && row.messages && typeof row.messages === 'object' && !Array.isArray(row.messages), 'invalid_chat_storage');
    if (row && Object.hasOwn(row.messages, envelope.id)) return null;
  }
  const row = current[domain] || { commands: 0, messages: {} };
  check(row.commands < Number.MAX_SAFE_INTEGER && Object.keys(row.messages).length < 50000, 'chat_capacity');
  const next = { ...current, [domain]: { commands: row.commands + 1, messages: { ...row.messages, [envelope.id]: true } } };
  return { state: next, event: { type: envelope.type, domain, command, ...(move ? { move } : {}),
    commandId: envelope.id, timestamp: envelope.timestamp, verified: true, simulated: false } };
}
module.exports = { commandEnvelope, routeCommand };
