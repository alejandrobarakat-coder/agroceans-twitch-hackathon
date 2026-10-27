(function () {
  'use strict';
  const glyphs = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const names = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  function parseFen(fen) {
    if (typeof fen !== 'string' || fen.length > 160) throw Error('Invalid FEN');
    const parts = fen.split(' '), rows = parts[0].split('/');
    if (parts.length !== 6 || !['w', 'b'].includes(parts[1]) || rows.length !== 8) throw Error('Invalid FEN');
    const cells = [];
    for (const [rank, row] of rows.entries()) {
      const pieces = [];
      for (const character of row) {
        if (/^[1-8]$/.test(character)) pieces.push(...Array(Number(character)).fill(null));
        else if (Object.hasOwn(glyphs, character)) pieces.push(character);
        else throw Error('Invalid FEN');
      }
      if (pieces.length !== 8) throw Error('Invalid FEN');
      pieces.forEach((piece, file) => cells.push({ piece, square: 'abcdefgh'[file] + (8 - rank), dark: (rank + file) % 2 === 1 }));
    }
    return cells;
  }
  function createDemo({ document, fetch, EventSource }) {
    const $ = id => document.getElementById(id);
    let stream, latest = null;
    function twitch(status) {
      if (status) $('twitch').textContent = 'Twitch: ' + (status.connected ? 'connected' : 'not connected') + ' · ' + status.subscription;
    }
    function render(data) {
      twitch(data.twitch);
      if (!Object.hasOwn(data, 'enabled')) return; // heartbeat carries status only
      if (!data.enabled) {
        latest = null; $('board').replaceChildren(); $('history').replaceChildren();
        $('source').textContent = 'Chess disabled'; $('source').className = 'tag';
        $('turn').textContent = 'Chess session disabled'; $('notice').textContent = 'Awaiting an operator-enabled chess session.';
        for (const id of ['fen', 'pgn', 'result']) $(id).textContent = '';
        $('lastMove').textContent = 'Last move: —'; $('ply').textContent = 'Ply —'; $('session').textContent = 'Session —'; return;
      }
      const match = data.match;
      if (!match || !Number.isSafeInteger(match.ply) || !Array.isArray(match.history)) throw Error('Invalid match snapshot');
      if (latest?.sessionId === match.sessionId && (match.ply < latest.ply || (match.ply === latest.ply && match.commands < latest.commands))) return;
      const cells = parseFen(match.fen);
      const squares = cells.map(cell => {
        const square = document.createElement('div');
        square.className = 'square ' + (cell.dark ? 'dark' : 'light') + ([match.lastMove?.from, match.lastMove?.to].includes(cell.square) ? ' last' : '');
        square.setAttribute('aria-label', cell.square + (cell.piece ? ' ' + (cell.piece === cell.piece.toUpperCase() ? 'White ' : 'Black ') + names[cell.piece.toLowerCase()] : ' empty'));
        const piece = document.createElement('span');
        piece.className = 'piece ' + (cell.piece && cell.piece === cell.piece.toUpperCase() ? 'white-piece' : 'black-piece');
        piece.textContent = glyphs[cell.piece] || ''; square.append(piece);
        const coordinate = document.createElement('span'); coordinate.className = 'coordinate'; coordinate.textContent = cell.square; square.append(coordinate);
        return square;
      });
      $('board').replaceChildren(...squares); $('board').setAttribute('aria-label', 'Server-authoritative chessboard, ply ' + match.ply);
      $('turn').textContent = match.terminal ? 'Match finished' : (match.turn === 'w' ? 'White' : 'Black') + ' to move' + (match.check ? ' · Check' : '');
      $('ply').textContent = 'Ply ' + match.ply;
      $('lastMove').textContent = 'Last move: ' + (match.lastMove ? match.lastMove.san + ' · ' + match.lastMove.uci : '—');
      $('history').replaceChildren(...match.history.map(move => {
        const item = document.createElement('li'); item.textContent = Math.ceil(move.ply / 2) + (move.ply % 2 ? '. ' : '… ') + move.san + ' · ' + move.uci; return item;
      }));
      $('session').textContent = 'Session ' + match.sessionId;
      $('result').textContent = match.terminal ? match.result + ' · ' + String(match.reason).replaceAll('_', ' ') : '';
      $('fen').textContent = match.fen; $('pgn').textContent = match.pgn;
      const simulated = data.simulated === true || data.source === 'simulation';
      $('source').textContent = simulated ? 'SIMULATED · local chess session' : 'Twitch session · ' + (match.ply ? 'live ingress' : 'awaiting moves');
      $('source').className = simulated ? 'tag simulation' : 'tag';
      $('notice').textContent = 'Read-only. Send moves in Twitch chat; reconnect restores the current server position.';
      latest = { sessionId: match.sessionId, ply: match.ply, commands: match.commands };
    }
    function message(event) {
      try { render(JSON.parse(event.data)); }
      catch { $('notice').textContent = 'Invalid chess update. Retaining the last valid board; recovering snapshot…'; recover(); }
    }
    async function recover() {
      try {
        const response = await fetch('/chess/snapshot', { cache: 'no-store' });
        if (!response.ok) throw Error('Snapshot unavailable');
        render(await response.json());
      } catch { $('notice').textContent = 'Snapshot unavailable. Retaining the last valid board; waiting for reconnect.'; }
    }
    async function start() {
      stream?.close();
      await recover();
      stream = new EventSource('/chess/events');
      for (const type of ['snapshot', 'move', 'result', 'status']) stream.addEventListener(type, message);
      stream.onopen = () => { $('transport').textContent = 'Chess bridge connected'; };
      stream.onerror = () => { $('transport').textContent = 'Bridge disconnected · reconnecting'; $('notice').textContent = 'Position may be stale. Reconnect will restore the server snapshot.'; };
    }
    return { start, close() { stream?.close(); } };
  }
  if (typeof module === 'object' && module.exports) module.exports = { parseFen, createDemo };
  else {
    const demo = createDemo({ document, fetch: window.fetch.bind(window), EventSource: window.EventSource });
    demo.start(); window.addEventListener('pagehide', () => demo.close());
    window.addEventListener('pageshow', event => { if (event.persisted) demo.start(); });
  }
}());
