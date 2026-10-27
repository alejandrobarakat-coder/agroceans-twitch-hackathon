'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Chess, DEFAULT_POSITION } = require('chess.js');
const { ChessSession } = require('../src/chess-session');
const { commandEnvelope } = require('../src/command-router');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '../var-chess-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { directory: path.join(root, 'chess'), broadcasterId: '123', ...options };
  const session = new ChessSession(config);
  let sequence = 0;
  const envelope = (move, id = String(++sequence), participant = '456', timestamp = 1000 + sequence) => commandEnvelope({
    broadcaster_user_id: '123', chatter_user_id: participant, message_id: id, message: { text: '!move ' + move }
  }, { broadcasterId: '123', timestamp });
  const play = (move, options = {}) => session.apply(envelope(move), { expectedPly: session.snapshot().ply, ...options }).event;
  return { session, root, config, envelope, play };
}

test('legal UCI moves, FEN/PGN export, wrong side, stale ply and untrusted state', t => {
  const f = fixture(t);
  assert.equal(f.session.snapshot().fen, DEFAULT_POSITION);
  assert.equal(f.play('e7e5').rejection, 'wrong_side');
  assert.equal(f.play('e2e5').rejection, 'illegal_move');
  assert.equal(f.session.snapshot().ply, 0);
  const e4 = f.play('e2e4');
  assert.equal(e4.type, 'chess.move'); assert.equal(e4.ply, 1); assert.equal(e4.turn, 'b');
  assert.match(e4.pgn, /1\. e4/);
  assert.equal(f.play('e7e5', { expectedPly: 0 }).rejection, 'stale_ply');
  const e5 = f.session.apply({ ...f.envelope('e7e5'), fen: DEFAULT_POSITION, pgn: 'fake', board: 'fake', side: 'w' }, { expectedPly: 1 }).event;
  assert.equal(e5.ply, 2); assert.match(e5.pgn, /1\. e4 e5/);
  const exported = new Chess(); exported.loadPgn(e5.pgn); assert.equal(exported.fen(), e5.fen);
  const stranger = { ...f.envelope('g1f3'), channelId: '999' };
  assert.throws(() => f.session.apply(stranger, { expectedPly: 2 }));
  assert.throws(() => f.session.apply({ ...f.envelope('g1f3'), domain: 'planet' }, { expectedPly: 2 }));
  assert.equal(f.session.snapshot().ply, 2);
});

test('operator-owned side policy cannot be overridden by a command', t => {
  const f = fixture(t, { sideForParticipant: () => 'b' });
  assert.equal(f.session.apply({ ...f.envelope('e2e4'), side: 'w' }, { expectedPly: 0 }).event.rejection, 'wrong_side');
  const blocked = fixture(t, { sideForParticipant: () => null });
  assert.equal(blocked.play('e2e4').rejection, 'unauthorized_side');
});

test('castling validates rights, attacked transit squares and both castle directions', t => {
  const f = fixture(t, { initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
  assert.equal(f.play('e1g1').san, 'O-O');
  assert.equal(f.play('e8c8').san, 'O-O-O');
  const board = new Chess(f.session.snapshot().fen);
  assert.equal(board.get('f1').type, 'r'); assert.equal(board.get('d8').type, 'r');
  const attacked = fixture(t, { initialFen: 'r3kr1r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
  assert.equal(attacked.play('e1g1').rejection, 'illegal_move');
  const noRights = fixture(t, { initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1' });
  assert.equal(noRights.play('e1c1').rejection, 'illegal_move');
});

test('en passant is legal immediately, expires, and survives restart', t => {
  const f = fixture(t);
  for (const move of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) assert.equal(f.play(move).type, 'chess.move');
  const recovered = new ChessSession(f.config);
  const ep = recovered.apply(f.envelope('e5d6'), { expectedPly: 4 }).event;
  assert.equal(ep.san, 'exd6'); assert.equal(new Chess(ep.fen).get('d5'), undefined);
  const expired = fixture(t);
  for (const move of ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'h2h3', 'a6a5']) expired.play(move);
  assert.equal(expired.play('e5d6').rejection, 'illegal_move');
});

test('promotion requires explicit piece and supports queen, rook, bishop and knight', t => {
  for (const piece of ['q', 'r', 'b', 'n']) {
    const f = fixture(t, { initialFen: '7k/P7/8/8/8/8/8/7K w - - 0 1' });
    assert.equal(f.play('a7a8').rejection, 'illegal_move');
    const promoted = f.play('a7a8' + piece);
    assert.equal(promoted.type, 'chess.move'); assert.equal(new Chess(promoted.fen).get('a8').type, piece);
  }
});

test('check and pinned pieces cannot expose own king', t => {
  const f = fixture(t, { initialFen: '4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1' });
  assert.equal(f.play('e2f2').rejection, 'illegal_move');
  const check = fixture(t, { initialFen: '4k3/8/8/8/8/8/8/R6K w - - 0 1' });
  assert.equal(check.play('a1e1').check, true);
  assert.equal(check.play('e8e7').rejection, 'illegal_move');
});

test('checkmate and stalemate are terminal and PGN records the result', t => {
  const f = fixture(t);
  for (const move of ['f2f3', 'e7e5', 'g2g4']) f.play(move);
  const mate = f.play('d8h4');
  assert.equal(mate.reason, 'checkmate'); assert.equal(mate.result, '0-1'); assert.equal(mate.check, true);
  assert.match(mate.pgn, /0-1$/); assert.equal(f.play('a2a3').rejection, 'game_over');
  assert.equal(new ChessSession(f.config).snapshot().reason, 'checkmate');
  const stale = fixture(t, { initialFen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' });
  assert.equal(stale.session.snapshot().reason, 'stalemate');
  assert.equal(stale.session.snapshot().result, '1/2-1/2');
  assert.equal(stale.play('h8g8').rejection, 'game_over');
});

test('insufficient material, fifty-move rule and threefold repetition terminate draws', t => {
  for (const fen of ['7k/8/8/8/8/8/8/7K w - - 0 1', '7k/8/8/8/8/8/8/5B1K w - - 0 1', '7k/8/8/8/8/8/8/5N1K w - - 0 1']) {
    const f = fixture(t, { initialFen: fen }); assert.equal(f.session.snapshot().reason, 'insufficient_material');
  }
  const fifty = fixture(t, { initialFen: '7k/8/8/8/8/8/8/R6K w - - 99 1' });
  assert.equal(fifty.play('a1a2').reason, 'fifty_move_rule');
  const repetition = fixture(t);
  for (const move of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']) repetition.play(move);
  const recovered = new ChessSession(repetition.config);
  assert.equal(recovered.apply(repetition.envelope('f6g8'), { expectedPly: 7 }).event.reason, 'threefold_repetition');
  assert.equal(new ChessSession(repetition.config).snapshot().reason, 'threefold_repetition');
});

test('concurrent commands use first legal move per original ply; rejected move does not win', async t => {
  const f = fixture(t);
  const replies = await Promise.all(['e2e5', 'e2e4', 'd2d4', 'e7e5'].map(move => f.session.submit(f.envelope(move))));
  assert.deepEqual(replies.map(row => row.event.rejection || 'accepted'), ['illegal_move', 'accepted', 'stale_ply', 'stale_ply']);
  assert.equal(f.session.snapshot().ply, 1);
  const mutable = f.envelope('e7e5');
  const queued = f.session.submit({ ...mutable });
  assert.equal((await queued).event.ply, 2);
  assert.equal((await f.session.submit(f.envelope('g1f3'), { expectedPly: 2 })).event.ply, 3);
});

test('logical-message receipts survive restart, reject conflicting reuse and do not reapply rejected moves', async t => {
  const f = fixture(t); const request = f.envelope('e2e4');
  const [first, duplicate] = await Promise.all([f.session.submit(request), f.session.submit(request)]);
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.event, first.event);
  f.play('e7e5');
  const recovered = new ChessSession(f.config);
  assert.deepEqual(recovered.apply({ ...request, timestamp: 9000 }, { expectedPly: 2 }).event, first.event);
  assert.equal(recovered.snapshot().ply, 2);
  assert.throws(() => recovered.apply({ ...request, move: 'd2d4' }, { expectedPly: 2 }), /chess_replay_mismatch/);
  const bad = f.envelope('a2a5'); const rejected = recovered.apply(bad, { expectedPly: 2 });
  assert.equal(recovered.apply(bad, { expectedPly: 2 }).duplicate, true);
  assert.equal(rejected.event.rejection, 'illegal_move');
  assert.equal(recovered.snapshot().commands, 3);
});

test('stale turn timestamps cannot execute delayed commands after the board advances', t => {
  const f = fixture(t);
  f.session.apply(f.envelope('e2e4', 'first', '456', 5000), { expectedPly: 0 });
  assert.equal(f.session.apply(f.envelope('e7e5', 'delayed', '456', 4000), { expectedPly: 1 }).event.rejection, 'stale_turn');
});

test('private storage fails closed on corruption, wrong binding, busy lock and write failure', t => {
  const f = fixture(t); f.play('e2e4');
  const before = fs.readFileSync(path.join(f.config.directory, 'session.json'), 'utf8');
  assert.equal(fs.statSync(path.join(f.config.directory, 'session.json')).mode & 0o777, 0o600);
  const release = f.session.storage.lease('state');
  assert.throws(() => f.session.apply(f.envelope('e7e5'), { expectedPly: 1 }), /storage_busy/); release();
  const write = f.session.storage.write;
  f.session.storage.write = () => { throw Error('injected write failure'); };
  assert.throws(() => f.session.apply(f.envelope('e7e5'), { expectedPly: 1 }), /injected write failure/);
  f.session.storage.write = write;
  assert.equal(fs.readFileSync(path.join(f.config.directory, 'session.json'), 'utf8'), before);
  assert.equal(f.session.snapshot().ply, 1);
  assert.throws(() => new ChessSession({ ...f.config, broadcasterId: '999' }).snapshot(), /invalid_chess_storage/);
  const state = JSON.parse(before); state.moves.push('e7e4');
  f.session.storage.transaction(() => f.session.storage.write('session.json', state));
  assert.throws(() => f.session.snapshot(), /invalid_chess_storage/);
});

test('independent sessions sharing storage serialize against the same expected ply', async t => {
  const f = fixture(t); const second = new ChessSession(f.config);
  const results = await Promise.all([f.session.submit(f.envelope('e2e4')), second.submit(f.envelope('d2d4'))]);
  assert.equal(results.filter(result => result.event.type === 'chess.move').length, 1);
  assert.equal(second.snapshot().ply, 1);
});

test('independent processes cannot commit two moves for one ply', async t => {
  const f = fixture(t); f.session.snapshot();
  const { spawn } = require('node:child_process');
  const script = `const {ChessSession}=require('./src/chess-session');
    const [config,envelope]=JSON.parse(process.argv[1]);
    const session=new ChessSession(config);
    async function run(){for(let n=0;n<100;n++){try{
      const result=session.apply(envelope,{expectedPly:0});
      process.stdout.write(JSON.stringify(result.event));return;
    }catch(error){if(error.category!=='storage_busy')throw error;
      await new Promise(resolve=>setTimeout(resolve,5));}}
      throw Error('lock retry exhausted');}
    run().catch(()=>{process.exitCode=1});`;
  const launch = envelope => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, JSON.stringify([f.config, envelope])], { cwd: path.resolve(__dirname, '..') });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.on('error', reject);
    child.on('close', code => { if (code !== 0) reject(Error('chess child failed')); else resolve(JSON.parse(output)); });
  });
  const results = await Promise.all([launch(f.envelope('e2e4')), launch(f.envelope('d2d4'))]);
  assert.equal(results.filter(event => event.type === 'chess.move').length, 1);
  assert.equal(results.filter(event => event.rejection === 'stale_ply').length, 1);
  assert.equal(f.session.snapshot().ply, 1);
  assert.equal(f.session.snapshot().commands, 2);
});

test('recovered castling rights and fifty-move counter resets follow move history', t => {
  const f = fixture(t, { initialFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
  for (const uci of ['h1h2', 'h8h7', 'h2h1', 'h7h8']) f.play(uci);
  const restored = new ChessSession(f.config);
  assert.equal(restored.apply(f.envelope('e1g1'), { expectedPly: 4 }).event.rejection, 'illegal_move');
  const pawn = fixture(t, { initialFen: '7k/8/8/8/8/8/P7/R6K w - - 99 1' });
  assert.equal(pawn.play('a2a3').terminal, false);
  assert.equal(pawn.session.snapshot().fen.split(' ')[4], '0');
});
