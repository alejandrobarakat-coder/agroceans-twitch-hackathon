# Stage 2 — isolated authoritative chess

Stage 3 now adds [a browser viewer and isolated routes](CHESS_BROWSER_DEMO.md).
The text below records the Stage 2 baseline; chess snapshots now use
/chess/snapshot and /chess/events, rather than the planet /events stream.

Implemented locally only. No deployment, service restart, subscription write,
commit, push, sibling edit or financial issuance is part of this stage.

## Rules and authority

src/chess-session.js uses chess.js@1.4.0 for legal UCI moves, turn/king safety,
castling, en passant, explicit q/r/b/n promotion, check, mate, stalemate,
insufficient material, threefold repetition and the fifty-move rule. Missing
promotion choice is rejected instead of silently choosing a queen. PGN exports
include the result; snapshots export FEN, PGN, ply, turn, check and terminal reason.
For this demo, threefold repetition and fifty moves automatically end the game,
following chess.js's game-over policy. There is no separate FIDE draw-claim UI,
clock, resignation, draw agreement, voting or new-game HTTP endpoint in Stage 2.

Initial position and participant-side policy belong to the server constructor.
Clients cannot supply a replacement FEN/PGN/board or authorize themselves for a
side. The default audience can propose moves for either side, but only the active
side's pieces can move. An internal operator-owned sideForParticipant function
can restrict immutable participant hashes to w/b; commands cannot override it.
This is an internal API downstream of authenticated Twitch ingress, not a public
endpoint that trusts an envelope's verified flag.

## First legal move and persistence

submit(envelope, {expectedPly}) serializes queued commands and captures the ply at
submission if omitted. An illegal command does not win a turn. After the first
legal move, other queued commands for that ply receive stale_ply. The synchronous
apply method is used by the existing synchronous Twitch receiver, with a server-
observed expected ply. Signed EventSub timestamps reject deliveries older than
the last accepted turn transition. Plain !move commands contain no client ply;
they target the server's current position when received. No voting occurs.

The authoritative session file is var/chess/session.json when created by the
runtime factory. It is separate from var/twitch-chat/chat-state.json and all
planet/financial state. The session saves operator-bound initial FEN, UCI history,
hashed-message receipts and its own counters. Board state is rebuilt from legal
history after every read, preserving repetition and special-move rights. Cached
client board state is never loaded. Rejected commands are also idempotent; reusing
a message ID with a different participant or move fails closed.

Existing private storage enforces 0700 directories, 0600 files, atomic rename,
fsync and exclusive filesystem leases. Independent processes seeing contention
must retry storage_busy with the same expected ply. Limits are 10,000 unique
commands, 2,000 plies and 6 MiB persisted JSON per session; exhaustion fails closed
instead of evicting idempotency records. Administrative rotation/reset is future
work. Existing stale-lock recovery remains manual: inspect stopped owners before
removing a lease. Never remove locks from a running process blindly.

Chess is committed before the chat delivery acknowledgement is persisted. If the
second write fails, retries cannot move twice. A crash between commit and event
publication can lose an individual SSE notification; the persisted chess snapshot
is the recovery authority. SSE delivery is not exactly-once. There is no video
stream or chess board UI in this stage.

## Local opt-in contract

CHESS_SESSION_ENABLED defaults false. When true alongside the existing Twitch
configuration and AGRO_REAL_PAYMENTS_ENABLED=false, the factory creates the
isolated session using CHESS_SESSION_ID (default hackathon). Enabling this in a
running service is a later, separately authorized operation. Changing a session
ID over existing storage fails binding validation; it never silently resets a
match. No existing environment file was edited.

The validated router remains the command boundary. Enabled sessions publish only
chess.move or chess.rejected with domain=chess, while /events adds a chess.snapshot
under the chess field for recovery. The generic Stage 1 chess.command behavior
remains when the session is disabled. Planet retains twitch_participation and
its own routing counters; chess session outcomes do not change them. Signed
delivery bookkeeping/last-event telemetry remains shared Twitch infrastructure.
No wallet, STAMP, issuance or payment adapter is a chess dependency.

## Dependency review

Approval: exact chess.js@1.4.0 with package-lock.json. Installed with --ignore-scripts;
the package's prepare/build scripts were not executed. No transitive runtime
dependencies. BSD-2-Clause license is retained in the installed package. Reviewed
metadata, lockfile integrity and runtime code paths for move validation, mate and
draw detection. The CommonJS distribution has no external require, network,
child-process or eval calls found in the targeted source search. This is a scoped
review, not a formal independent security audit.

Registry metadata: 26 files, 723,850 unpacked bytes. Installed package allocation:
816 KiB. npm audit --json reports zero known vulnerabilities (all severities zero)
on 2026-10-26. Registry access required an unrestricted retry after sandbox DNS
failure; lifecycle scripts remained disabled. Reproduce with npm ci --ignore-scripts.

## Verification

test/chess-session.test.js covers legality, wrong side, stale ply/timestamp,
client-state injection, special moves, check/pins, terminal results, draws,
FEN/PGN roundtrip, concurrent queues/processes, restart, rejected-message receipts,
conflicting replays, private permissions, lock contention and failed writes.
test/twitch-chat.test.js covers signed ingress through the real session, HTTP
delivery retries, SSE recovery, unchanged planet state, financial tripwires and
the chess-commit/chat-write failure boundary. Providers are mocked; HTTP servers
are ephemeral loopback listeners. No live Twitch delivery is claimed.

Final validation on 2026-10-26: npm run check passed; npm test passed 113 tests
(105 top-level), zero failures; git diff --check passed. The 17 additional tests
extend the Stage 1 total of 96. Tests needing loopback sockets or child processes
ran outside the restrictive sandbox. npm audit reported zero known vulnerabilities.
After removing this task's temporary npm cache, the working tree excluding .git
measured 1,348 KiB versus 488 KiB before Stage 2: +860 KiB, including 824 KiB for
node_modules. Disk remained 96% used, with 8,342,052 KiB available at measurement;
filesystem-wide changes include unrelated VPS activity and are not patch size.
