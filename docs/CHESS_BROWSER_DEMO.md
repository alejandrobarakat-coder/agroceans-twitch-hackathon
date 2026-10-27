# Stage 3 — Pinche Chess browser demo

Source-only changes. No deployment, service restart, configuration activation,
mobile build, video rendering, sibling change, commit or push. No new dependency.
The Stage 2 authoritative chess session continues to validate every move.

## Routes and isolation

- GET /chess (also /chess/): responsive read-only browser viewer.
- GET /chess/snapshot: current authoritative match and sanitized Twitch status.
- GET /chess/events: dedicated SSE connection with named snapshot, move, result
  and status events. Every new connection starts with current state, including
  reconnects with Last-Event-ID. There is no historical SSE replay promise.
- GET /chess/app.js and /chess/style.css: local assets, no CDN or external fonts.

Static and snapshot routes also accept HEAD. Write methods return 405; there is
no browser move/reset endpoint. Query-string board/FEN/PGN inputs are ignored.
Chess outcomes are no longer broadcast to planet /events, and planet snapshots
no longer contain a chess field. Planet routes and counters retain their behavior.
Shared Twitch status telemetry is sanitized separately for the chess viewer;
planet participation, ecosystem/financial data and simulation events never enter
the chess stream. Rejected chess moves remain in session receipts but do not
generate move/result stream events.

The browser displays server FEN, current turn/check/result, last move with board
highlighting, SAN/UCI history, FEN/PGN exports and separate bridge/Twitch status.
It has no local chess engine, move calculation or client-authoritative state.
Invalid updates retain the last valid board and trigger a snapshot fetch. An old
snapshot for the same session cannot roll the board backward. EventSource retries
automatically; the next initial snapshot recovers any missed update or previous
commit/publication gap. Disconnects explicitly mark the displayed position stale.

## Source labels and default configuration

CHESS_SESSION_ENABLED remains false by default. The main bridge requires the
explicit Stage 2 session flag plus its existing authorized Twitch configuration
to supply a match. The page is available while disabled and says so; it does not
manufacture a live match. Connected SSE does not imply connected Twitch. A Twitch
session label describes the configured ingress, while the separate Twitch badge
reports pending/enabled/revoked/etc. Simulation uses an explicit different source
label. This viewer is not a Twitch video encoder, stream or embedded video player.

Main bridge URL with its default port: http://127.0.0.1:8766/chess.
No existing process, environment file, token or subscription was changed.

## Standalone local simulation, requiring no Twitch credentials

From this repository, when ready to start an additional local-only process:

```sh
CHESS_SESSION_ENABLED=true PORT=8877 npm run demo:chess
```

Exact URL: http://127.0.0.1:8877/chess

Enter UCI moves into that process's terminal, for example e2e4 then e7e5, or the
sequence f2f3, e7e5, g2g4, d8h4 to display checkmate. Prefix !move is optional in
this terminal only. Each input goes through the validated command envelope and
authoritative session. Browser routes remain read-only. Ctrl+C stops that local
process. The launcher does not load .env, connect to Twitch, call financial
adapters or expose planet routes. Without the explicit flag it remains disabled.

Simulation persists in ignored var/chess-browser-simulation/session.json, separate
from the live var/chess session and planet state. Restart resumes that simulation;
there is no automatic terminal-match reset. Receipts/outcomes are wrapped as
simulated=true, verified=false before publication; the viewer labels the whole
simulation source explicitly. No AGRO or STAMP is issued.

## Safety and resource bounds

The chess SSE handler caps connections at 20 total and four per socket address.
It returns 429 with Retry-After: 5 when full, releases slots on disconnect and
destroys slow consumers when a write signals backpressure instead of accumulating
an unbounded queue. A 15-second status heartbeat detects broken connections and
refreshes sanitized Twitch status. Storage failures return sanitized 503 errors
or close the stream, allowing reconnect recovery. Caps do not affect planet SSE.

Behind a reverse proxy all clients may share the proxy's socket address. These
conservative limits require review alongside any future authorized proxy rollout;
the handler intentionally does not trust spoofable X-Forwarded-For headers.
Snapshots reconstruct bounded session history; this is a small demonstration,
not a horizontally scaled broadcast delivery service.

HTML/JS/CSS use same-origin assets and a restrictive CSP, no-store, no-referrer,
nosniff and frame blocking. Dynamic values use textContent and created DOM nodes,
never innerHTML. Public snapshots allowlist fields and omit receipts, participant
hashes, chat text, credentials, financial state and production API details.

## Verification

test/chess-demo.test.js exercises read-only HTTP behavior, disabled mode, accepted
move/result SSE, reconnect snapshots, source labels, planet isolation, connection
limits/slot cleanup, backpressure and sanitized failure behavior. The standalone
launcher is tested with a temporary simulation directory and ephemeral listener.
test/chess-browser.test.js uses a lightweight DOM/EventSource harness to verify
FEN rendering, history/highlights, safe text, stale snapshot rejection, disconnect
status, recovery fetches and simulation/disabled/result labels. It does not claim
a full graphical browser or live Twitch acceptance test. Existing signed ingress
and financial-tripwire coverage remains in test/twitch-chat.test.js.

Final checks on 2026-10-26: npm run check passed; npm test passed 128 tests
(120 top-level), zero failures; git diff --check passed. That adds 15 tests to the
Stage 2 total of 113. The full suite used the required loopback/child-process
permissions. No packages were installed or dependency versions changed. Working
tree excluding .git grew from 1,348 to 1,412 KiB (+64 KiB). Filesystem stayed 96%
used; its separate free-space changes include other VPS activity. No persistent
demo server was started; only temporary test listeners ran and were closed.
