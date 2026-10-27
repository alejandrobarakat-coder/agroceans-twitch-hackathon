# Shared architecture — stages 0 and 1 baseline

This document records the stages 0 and 1 baseline, not deployed connectivity.
Stage 2 now adds an opt-in authoritative session; see [chess session](CHESS_SESSION.md). The two
submissions are Pinche Chess — Twitch Plays Chess and AgroCeans — Twitch for
Planet. Existing AgroCeans wallets, AgroCoin rewards and STAMP work in the original
environment. Their hackathon integration is separate. No production code changes
or real issuance are part of these stages.

## Baseline recorded 2026-10-26

- AGENTS.md inspected; repository clean on main, tracking origin/main.
- npm run check: passed.
- Initial sandbox npm test: four files passed, two failed. Direct diagnosis showed
  EPERM for loopback listening and child-process execution in existing tests.
- Same npm test outside sandbox: 92 tests passed, zero failed (84 top-level).
- Filesystem: 96% used, 8,358,576 KiB available. Working tree excluding .git: 468 KiB.
- No builds, installs, deployments, service restarts, commits or pushes.

Post-change verification: npm run check passed; npm test outside the sandbox
passed 96 tests, zero failed (88 top-level); git diff --check passed. This adds
four focused tests and extends existing HTTP concurrency coverage. Working tree
excluding .git measured 488 KiB, up 20 KiB; filesystem remained 96% used with
8,355,232 KiB available at measurement. Filesystem-wide variation includes other
VPS activity and is not a measure of this patch's size. No dependencies installed.

## Shared ingress and domain contracts

src/twitch-chat.js authenticates exact raw EventSub bytes and validates channel,
reader, transport, subscription, freshness and shared-chat origin before invoking
src/command-router.js. That internal router is not an authentication endpoint.
No new HTTP routes or external production-facing API contracts are introduced.

The immutable internal command envelope has version=1, type, domain, command,
move (null for planet), channelId, hashed logical-message id, hashed participantId,
and integer timestamp. Raw text, names and credentials are excluded. Routing
revalidates the channel, domain/type/command pairing, hashes and move syntax.
Unknown/malformed chat commands are acknowledged and discarded without routing;
foreign-channel events are rejected by the authenticated ingress.

- planet.command: exact trimmed, case-insensitive !ocean. Existing public
  twitch_participation event, liveTwitch counters and snapshot shape are retained;
  domain=planet, eventType=planet.command and commandId are additive metadata.
- chess.command: !move followed by one UCI coordinate move, optionally q/r/b/n
  promotion, normalized to lowercase. Same-square moves are discarded. This means
  syntax accepted, not legal move accepted: no board, match or payment is changed.

commandDomains.chess and commandDomains.planet persist separate command counts and
message sets in the existing private chat-state.json transaction. Neither domain
increments the other's counters. Logical-message reuse across either domain is
ignored; delivery retries are acknowledged without a second publication. Legacy
planet message IDs/counters remain authoritative after upgrade. New domain counts
start when routing is introduced; legacy liveTwitch counts retain their history.
Routing constructs a new state; the caller commits it with legacy counters before
publishing. It accepts no handlers or financial clients and performs no I/O.

The existing bounded stores and filesystem lock still apply. This is single-process
runtime routing with cross-process storage exclusion, not a new job queue. SSE
has no durable per-command replay log: a crash after commit but before publication
can lose an individual command notification. Stage 2 must add authoritative chess
state/recovery before commands can cause moves. Stage 1 does not claim move execution.

## Existing routes and presentation

src/server.js retains /health, /events, /overlay, OAuth routes, signed
POST /twitch/eventsub, operator-protected /integration/* and loopback-token
POST /demo/ocean. public/overlay.html displays planet participation and ecosystem
observations. public/index.html is a local simulation page, not routed at /.
SSE is application event transport, not Twitch video. Distinct demo routes and
the Pinche Tulum LIVE/Alejandro Barakat editorial presentation remain later work.
Real report/STAMP reads remain in src/ecosystem.js. Chat never initiates issuance.
The legacy integration endpoints and src/integration.js are unchanged.

## Verification and next boundary

Run npm run check, npm test and git diff --check. Focused coverage lives in
test/command-router.test.js and test/twitch-chat.test.js: parsing, wrong channels,
domain isolation, immutable transitions, concurrent delivery retries over HTTP,
restart deduplication, legacy migration and runtime financial adapter tripwires.
All Twitch providers in these tests are fake; HTTP uses ephemeral loopback servers.

Next proposed stage: isolated authoritative chess state and legality tests, without
importing production server/publishing side effects. No deployment, subscription
write, service change or GitHub push is authorized by stages 0 and 1.
