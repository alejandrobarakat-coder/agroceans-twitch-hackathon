'use strict';
const { Chess, DEFAULT_POSITION } = require('chess.js');
const { TwitchStorage, TwitchFault, digest } = require('./twitch-storage');
const { routeCommand } = require('./command-router');
const requireState = (ok, category = 'invalid_chess_storage') => { if (!ok) throw new TwitchFault(category); };
const MAX_COMMANDS = 10000;
const MAX_PLIES = 2000;

function position(board) {
  let reason = null;
  if (board.isCheckmate()) reason = 'checkmate';
  else if (board.isStalemate()) reason = 'stalemate';
  else if (board.isInsufficientMaterial()) reason = 'insufficient_material';
  else if (board.isThreefoldRepetition()) reason = 'threefold_repetition';
  else if (board.isDrawByFiftyMoves()) reason = 'fifty_move_rule';
  const result = reason === 'checkmate' ? (board.turn() === 'w' ? '0-1' : '1-0') : reason ? '1/2-1/2' : '*';
  board.setHeader('Result', result);
  return { fen: board.fen(), pgn: board.pgn(), turn: board.turn(), check: board.isCheck(),
    terminal: Boolean(reason), reason, result };
}

// Internal API only. Commands must come from authenticated ingress. The constructor
// owns initial position and side policy; commands cannot replace either.
class ChessSession {
  constructor({ directory, broadcasterId, sessionId = 'hackathon', initialFen = DEFAULT_POSITION,
    sideForParticipant = () => 'both' }) {
    requireState(typeof broadcasterId === 'string' && /^\d{1,30}$/.test(broadcasterId) &&
      typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(sessionId), 'invalid_chess_configuration');
    new Chess(initialFen); // operator-owned configuration, never taken from chat
    this.storage = new TwitchStorage(directory);
    Object.assign(this, { broadcasterId, sessionId, initialFen, sideForParticipant });
    this.queue = Promise.resolve();
  }
  load() {
    const state = this.storage.read('session.json', null) || {
      version: 1, sessionId: this.sessionId, broadcasterId: this.broadcasterId,
      initialFen: this.initialFen, moves: [], receipts: {}, commands: 0, turnStartedAt: 0
    };
    requireState(state.version === 1 && state.sessionId === this.sessionId && state.broadcasterId === this.broadcasterId &&
      state.initialFen === this.initialFen && Array.isArray(state.moves) && state.moves.length <= MAX_PLIES &&
      state.receipts && typeof state.receipts === 'object' && !Array.isArray(state.receipts) &&
      Number.isSafeInteger(state.commands) && state.commands === Object.keys(state.receipts).length && state.commands <= MAX_COMMANDS &&
      Number.isSafeInteger(state.turnStartedAt) && state.turnStartedAt >= 0);
    // Full replay preserves repetition history, castling and en-passant rights.
    // Cached/exported FEN and PGN are never accepted as authoritative board input.
    const board = new Chess(state.initialFen);
    try {
      for (const move of state.moves) {
        requireState(!board.isGameOver() && typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move));
        board.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}) });
      }
    } catch { throw new TwitchFault('invalid_chess_storage'); }
    return { state, board };
  }
  view(state, board) {
    return { type: 'chess.snapshot', domain: 'chess', sessionId: this.sessionId,
      ply: state.moves.length, commands: state.commands, ...position(board) };
  }
  snapshot() { return this.storage.transaction(() => { const { state, board } = this.load(); return this.view(state, board); }); }

  // Synchronous transaction serializes ingress in one process. Independent
  // processes fail busy rather than racing; their caller may retry safely.
  apply(envelope, { expectedPly } = {}) {
    requireState(envelope?.domain === 'chess', 'invalid_chess_command');
    routeCommand({}, envelope, this.broadcasterId); // reuse the validated router boundary
    requireState(Number.isSafeInteger(expectedPly) && expectedPly >= 0, 'invalid_chess_command');
    return this.storage.transaction(() => {
      const { state, board } = this.load();
      const fingerprint = digest(JSON.stringify([envelope.move, envelope.participantId]));
      const prior = state.receipts[envelope.id];
      if (prior) {
        requireState(prior.fingerprint === fingerprint && prior.event?.commandId === envelope.id, 'chess_replay_mismatch');
        const historical = new Chess(state.initialFen);
        for (const uci of state.moves.slice(0, prior.event.ply)) historical.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
        return { duplicate: true, event: { ...prior.event, ...position(historical) } };
      }
      requireState(state.commands < MAX_COMMANDS, 'chess_capacity');
      const side = this.sideForParticipant(envelope.participantId);
      const status = position(board);
      let reason = status.terminal ? 'game_over' : expectedPly !== state.moves.length ? 'stale_ply' :
        envelope.timestamp < state.turnStartedAt ? 'stale_turn' :
        !['w', 'b', 'both'].includes(side) ? 'unauthorized_side' :
        side !== 'both' && side !== board.turn() ? 'wrong_side' : null;
      const piece = board.get(envelope.move.slice(0, 2));
      if (!reason && piece && piece.color !== board.turn()) reason = 'wrong_side';
      let move;
      if (!reason) {
        requireState(state.moves.length < MAX_PLIES, 'chess_capacity');
        try { move = board.move({ from: envelope.move.slice(0, 2), to: envelope.move.slice(2, 4),
          ...(envelope.move[4] ? { promotion: envelope.move[4] } : {}) }); }
        catch { reason = 'illegal_move'; }
      }
      if (move) { state.moves.push(envelope.move); state.turnStartedAt = Math.max(state.turnStartedAt, envelope.timestamp); }
      state.commands++;
      const event = { ...this.view(state, board), type: move ? 'chess.move' : 'chess.rejected',
        commandId: envelope.id, uci: envelope.move, ...(move ? { san: move.san } : { rejection: reason }),
        verified: true, simulated: false, timestamp: envelope.timestamp };
      // Keep PGN once as replayable moves, rather than duplicating growing PGN
      // text in every receipt. Duplicate responses reconstruct their original ply.
      const { pgn, ...receiptEvent } = event;
      state.receipts[envelope.id] = { fingerprint, event: receiptEvent };
      requireState(Buffer.byteLength(JSON.stringify(state)) <= 6 * 1024 * 1024, 'chess_capacity');
      this.storage.write('session.json', state);
      return { duplicate: false, event };
    });
  }
  // Capture ply when queued, not when executed: contenders for the same turn
  // cannot silently become commands for a later turn. Rejection doesn't win a turn.
  submit(envelope, options = {}) {
    const request = Object.freeze({ ...envelope });
    let expectedPly;
    try { expectedPly = options.expectedPly ?? this.snapshot().ply; }
    catch (error) { return Promise.reject(error); }
    const next = this.queue.then(() => this.apply(request, { expectedPly }));
    this.queue = next.catch(() => {});
    return next;
  }
}
module.exports = { ChessSession };
