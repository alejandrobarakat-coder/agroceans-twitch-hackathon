(function () {
  'use strict';
  const glyphs = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const pieceNames = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
  function parseFen(fen) {
    if (typeof fen !== 'string' || fen.length > 160) throw Error('Invalid FEN');
    const rows = fen.split(' ')[0].split('/'); if (rows.length !== 8) throw Error('Invalid FEN');
    return rows.flatMap((row, rank) => {
      const pieces = [];
      for (const symbol of row) {
        if (/^[1-8]$/.test(symbol)) pieces.push(...Array(Number(symbol)).fill(null));
        else if (Object.hasOwn(glyphs, symbol)) pieces.push(symbol); else throw Error('Invalid FEN');
      }
      if (pieces.length !== 8) throw Error('Invalid FEN');
      return pieces.map((piece, file) => ({ piece, square: 'abcdefgh'[file] + (8 - rank), dark: (rank + file) % 2 === 1 }));
    });
  }
  function createPresentation({ document, fetch, EventSource, page }) {
    if (!['chess', 'planet', 'editorial'].includes(page)) throw Error('Unknown presentation');
    const base = page === 'editorial' ? '/editorial' : '/judge/' + page;
    const $ = id => document.getElementById(id);
    const set = (id, value) => { if ($(id)) $(id).textContent = value; };
    let stream, latest, recovering, serial = 0, epoch = 0;
    const label = value => value.simulated ? 'SIMULATED · no live Twitch data' : value.source === 'disabled' ? 'Disabled' : 'Source: ' + value.source;
    const connection = value => 'Twitch: ' + (value.connected ? 'connected' : 'not connected') + ' · ' + value.subscription;
    function board(id, match) {
      if (!$(id)) return;
      const cells = match ? parseFen(match.fen) : [];
      $(id).replaceChildren(...cells.map(cell => {
        const item = document.createElement('div');
        item.className = 'square ' + (cell.dark ? 'dark' : 'light') + (cell.piece && cell.piece === cell.piece.toUpperCase() ? ' white' : '') + ([match.lastMove?.from, match.lastMove?.to].includes(cell.square) ? ' last' : '');
        item.textContent = glyphs[cell.piece] || '';
        item.setAttribute('aria-label', cell.square + (cell.piece ? ' ' + (cell.piece === cell.piece.toUpperCase() ? 'White ' : 'Black ') + pieceNames[cell.piece.toLowerCase()] : ' empty'));
        const coordinate = document.createElement('span'); coordinate.className = 'coordinate'; coordinate.textContent = cell.square; item.append(coordinate); return item;
      }));
      const description = cells.filter(cell => cell.piece).map(cell => (cell.piece === cell.piece.toUpperCase() ? 'White ' : 'Black ') + pieceNames[cell.piece.toLowerCase()] + ' ' + cell.square).join('; ');
      $(id).setAttribute('aria-label', match ? 'Server-authoritative chess position; ' + (match.turn === 'w' ? 'White' : 'Black') + ' to move. ' + description : 'Chess session disabled');
    }
    function reports(value) {
      const rows = value.reports;
      if (!Array.isArray(rows)) throw Error('Invalid report snapshot');
      $('reports')?.replaceChildren(...rows.map(row => {
        const item = document.createElement('li');
        const title = document.createElement('strong'); title.textContent = (row.simulated ? 'SIMULATED REPORT · ' : 'PUBLIC REPORT · ') + row.folio; item.append(title);
        const details = document.createElement('p');
        details.textContent = row.stamp ? 'STAMP ' + row.stamp.status + ' · reference ' + (row.stamp.reference || 'not exposed') + ' · TX ' + (row.stamp.transactionId || 'not exposed') + ' · ' + row.stamp.verification : 'STAMP not available. None is issued by this demo.';
        item.append(details); return item;
      }));
    }
    function render(value) {
      if (!value || value.domain !== page || !Number.isSafeInteger(value.revision) || typeof value.instanceId !== 'string') throw Error('Invalid presentation snapshot');
      if (latest?.instanceId === value.instanceId && value.revision < latest.revision) return;
      set('video', value.video.label);
      if (page === 'chess') {
        if (value.match) parseFen(value.match.fen); // validate before replacing the current view
        board('board', value.match);
        set('identity', value.identity.title + ' · ' + value.identity.id); set('source', label(value));
        if ($('source')) $('source').className = value.simulated ? 'simulated' : '';
        set('twitch', connection(value.twitch));
        set('counters', value.counters.acceptedMoves + ' accepted moves · ' + value.counters.commands + ' chess commands');
        const m = value.match;
        set('turn', !m ? 'Chess session disabled' : m.terminal ? 'Match finished' : (m.turn === 'w' ? 'White' : 'Black') + ' to move' + (m.check ? ' · Check' : ''));
        set('last-move', m?.lastMove ? 'Last move: ' + m.lastMove.san + ' · ' + m.lastMove.uci : 'Last move —');
        set('result', m?.terminal ? m.result + ' · ' + m.reason.replaceAll('_', ' ') : '');
        $('history')?.replaceChildren(...(m?.history || []).map(move => { const li = document.createElement('li'); li.textContent = Math.ceil(move.ply / 2) + (move.ply % 2 ? '. ' : '… ') + move.san + ' · ' + move.uci; return li; }));
        set('fen', m?.fen || ''); set('pgn', m?.pgn || '');
      } else if (page === 'planet') {
        set('identity', value.identity.title + ' · ' + value.identity.id); set('source', label(value));
        if ($('source')) $('source').className = value.simulated ? 'simulated' : '';
        set('mission-title', value.mission.title); set('mission-description', value.mission.description);
        set('twitch', connection(value.twitch));
        set('live-counters', value.counters.liveCommands + ' real !ocean commands · ' + value.counters.liveParticipants + ' real participants');
        set('simulated-counters', value.counters.simulatedCommands + ' simulated commands · ' + value.counters.simulatedParticipants + ' simulated participants');
        set('report-status', value.status + ' · ' + value.counters.publicReports + ' public reports · ' + value.counters.simulatedReports + ' simulated reports');
        reports(value);
      } else {
        const c = value.chess, p = value.planet;
        board('editorial-board', c.match);
        set('chess-source', label(c)); set('planet-source', label(p));
        set('chess-twitch', connection(c.twitch)); set('planet-twitch', connection(p.twitch));
        set('chess-summary', c.match ? c.counters.acceptedMoves + ' legal moves · ' + (c.match.terminal ? 'Result ' + c.match.result : (c.match.turn === 'w' ? 'White' : 'Black') + ' to move') + (c.match.lastMove ? ' · last move ' + c.match.lastMove.san : '') : 'Chess session disabled');
        set('mission-title', p.mission.title);
        set('planet-summary', p.counters.liveCommands + ' real commands · ' + p.counters.simulatedCommands + ' simulated commands · reports: ' + p.status);
        reports(p);
      }
      latest = { instanceId: value.instanceId, revision: value.revision };
      set('notice', 'Read-only server snapshot. No financial issuance.');
    }
    async function recover() {
      if (recovering) return recovering;
      const fence = serial;
      recovering = (async () => {
        try { const response = await fetch(base + '/snapshot', { cache: 'no-store' }); if (!response.ok) throw Error('Unavailable'); const value = await response.json(); if (serial === fence) render(value); }
        catch { set('notice', 'Snapshot unavailable. Awaiting a fresh server snapshot.'); $('reports')?.replaceChildren(); }
      })().finally(() => { recovering = null; }); return recovering;
    }
    async function start() {
      const started = ++epoch;
      stream?.close(); await recover(); if (started !== epoch) return; stream = new EventSource(base + '/events');
      const receive = event => { if (started !== epoch) return; serial++; try { render(JSON.parse(event.data)); } catch { set('notice', 'Invalid update; recovering server snapshot.'); recover(); } };
      stream.addEventListener('snapshot', receive); stream.addEventListener('update', receive);
      stream.onopen = () => { if (started === epoch) set('transport', 'Presentation data connected · video status is separate'); };
      stream.onerror = () => { if (started !== epoch) return; set('transport', 'Data disconnected · reconnecting'); set('notice', 'Displayed chess position may be stale. Reports await a fresh snapshot.'); $('reports')?.replaceChildren(); };
    }
    return { start, close() { epoch++; serial++; stream?.close(); } };
  }
  if (typeof module === 'object' && module.exports) module.exports = { createPresentation, parseFen };
  else {
    const demo = createPresentation({ document, fetch: window.fetch.bind(window), EventSource: window.EventSource, page: document.body.dataset.demo });
    demo.start(); window.addEventListener('pagehide', () => demo.close()); window.addEventListener('pageshow', event => { if (event.persisted) demo.start(); });
  }
}());
