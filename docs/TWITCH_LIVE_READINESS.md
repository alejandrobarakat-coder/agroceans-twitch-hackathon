# Stage 6A — real Twitch integration readiness, both projects

Source/test readiness only, reviewed 2026-10-27. No deployment, service restart,
live token validation/exchange, OAuth consent, subscription mutation, production
change, report ingestion, issuance, commit or push was performed in this stage.
Real credentials, broadcaster values and private provider state were not opened.

## What exists and what Stage 6A adds

- src/twitch-oauth.js: browser/state binding, fixed redirect URI, server-side code
  exchange and private persistence. Pairing/bootstrap are optional and disabled.
- src/twitch-client.js and scripts/twitch-eventsub.js: private credential loading,
  identity/grant validation, explicit/optional refresh and operator subscription
  lifecycle. register/remove/refresh require a private TTY and typed confirmation.
- src/twitch-chat.js: raw-body HMAC, freshness, broadcaster/reader/transport/ID
  binding, pending challenge handshake, revocation and durable delivery/logical
  message deduplication. Startup reconciles; it never creates a subscription.
- !move e2e4 passes through the validated router to the opt-in authoritative chess
  session. A bad legal move is rejected without changing FEN/ply; a malformed UCI
  command is discarded. It never changes Planet participation.
- !ocean updates durable Planet live-command/unique-participant counts. It never
  moves a chess piece, creates a report, issues STAMP or invokes a reward adapter.
- Existing judge snapshots/SSE expose separate chess/Planet identities, counters
  and sanitized projections. The editorial desk observes both without merging state.

The missing automated coverage was one signed HTTP path across both judge SSEs
and editorial, plus cross-domain restart/reconnect and fail-closed credentials.
Three Stage 6A integration tests now exercise that path against a fake Twitch API.
Two harness safety tests verify environment isolation and rejected live targets.
No production runtime module or feature-flag behavior was changed.

## Synthetic-only local harness

```sh
npm run test:twitch-readiness
```

This runs only the Stage 6A tests. It accepts no target/URL arguments, uses fixed
test entrypoints and a clean child environment containing only PATH, LANG and
NODE_ENV. It does not inherit operator credentials, production flags, NODE_OPTIONS
or an env-file setting. All API replies, authorization files and HMAC deliveries
are fixtures in private temporary test directories; listeners bind ephemeral
loopback ports and close afterward. No persistent public receiver is started.
The harness has a 60-second process timeout and no live-network fallback. A sandbox
must permit its loopback listeners/child process; failure is not a passing test.

Fixtures intentionally exercise the **real-ingress code branch**, so projections
inside these tests can contain simulated=false/source=twitch. That is a test
assertion about application behavior, **not evidence of actual Twitch delivery**.
The harness announces SYNTHETIC ONLY before running. The separate demo:judges
launcher instead wraps its generated events as simulated=true/verified=false and
shows explicit simulation labels. Do not use terminal simulator input as a live
Twitch acceptance result.

## Confirmed requirements from source and official Twitch documentation

The implementation uses channel.chat.message version 1, webhook transport, one
authorized numeric broadcaster ID and the same account as the reader. It requires
all three grants: user:read:chat, user:bot and channel:bot. Twitch also documents a
moderator alternative for the broadcaster grant; this minimal implementation does
not implement that alternative or a different bot-reader identity. Viewers do not
need to authorize the app; receive-only integration needs no user:write:chat grant.
See [channel.chat.message authorization](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage).

Twitch requires an app access token for webhook subscription creation; the saved
user authorization establishes grants and must match the configured app/account.
See [subscription management](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/).
OAuth success alone does not establish chat grants or a connected subscription.
Requested OAuth scopes and actual token grants are different observations;
preflight validates the actual grant set.

Fixed URLs in this source, which are separate contracts:

| Purpose | Required URL |
| --- | --- |
| Registered OAuth redirect | https://twitch.theagrostore.com/auth/twitch/callback |
| EventSub callback | https://twitch.theagrostore.com/twitch/eventsub |
| Browser pairing entry | https://twitch.theagrostore.com/auth/twitch/connect |

The webhook must be publicly reachable using HTTPS on port 443, preserving raw
bytes and headers without redirects, authentication middleware challenges or
sensitive body logging. A 202/pending registration is not enabled connectivity.
Challenges and notifications must be authenticated; duplicate deliveries can occur.
See [webhook requirements](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/).
Token validation is required on startup and at least hourly; this implementation
revalidates through its minute maintenance cycle when enabled, with refresh opt-in.
See [token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/).

## Configuration and remaining gates — not inspected or activated live

The existing private environment must be provisioned by the owner; never paste
IDs, client secrets, cookies, token files, callback query strings or HARs into logs.
Current real grants/account IDs, HTTPS forwarding, deployed code, subscription
enabled state and actual viewer delivery remain **unverified**, not assumed absent.
No PM2 process ID or old deployment note is treated as current evidence.

For the later minimal chat acceptance, the running approved receiver needs:

```text
TWITCH_EVENTS_ENABLED=true
CHESS_SESSION_ENABLED=true
JUDGE_DEMOS_ENABLED=true
AGRO_REAL_PAYMENTS_ENABLED=false
TWITCH_TOKEN_REFRESH_ENABLED=false
PLANET_DEMO_ENABLED=false
AGRO_PLANET_REPORTS_ENABLED=false
```

These are required non-secret settings, **not commands executed now**. The last
flag keeps the first live chat test independent of report access. Real report
display is a separate Stage 4 contract/consent gate; !ocean works while reports are
disabled. The owner must separately approve any deployment/configuration change,
new process, proxy update, missing-grant reauthorization, token exchange or remote
subscription operation. Do not restart an existing service using historical IDs.

Use the correct numeric TWITCH_BROADCASTER_ID; TWITCH_CHAT_READER_ID must match it
(or be empty and default to it). The running service and operator CLI must use the
same checkout, account, app and private credential/state stores. A preflight CLI
process may show twitchConnected=false/unknown before subscription reconciliation;
judge connectivity should be assessed from the running receiver. Legacy /health
mode describes integration/reward configuration; mode=simulation alone is not the
Twitch event-provenance field. Use actual chat delivery and Twitch-specific fields.

## Exact later real-chat acceptance commands — require separate approval

Do not run these as part of Stage 6A. They assume the reviewed code and HTTPS
receiver are already running under a separately approved configuration. This
runbook supplies no service restart or deployment command. Do not point an
unrouted second local instance at the same fixed callback and expect delivery.

1. In the repository/private operator terminal, validate existing user grants
   without enabling automatic refresh:

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false TWITCH_TOKEN_REFRESH_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js preflight
   ```

   This performs a real token-validation GET; it does not exchange or print tokens.
   Stop on missing_permissions, identity mismatch, expiry or unsafe storage. Missing
   authorization requires its own approved OAuth/refresh task; do not bypass checks.

2. Only if subscription management/token acquisition is separately authorized:

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false TWITCH_TOKEN_REFRESH_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js reconcile
   ```

   This lists/reconciles the managed subscription and can obtain an app access
   token. It is therefore not a zero-token-operation command. If unregistered and
   creation is explicitly approved, run the following once and type REGISTER:

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false TWITCH_TOKEN_REFRESH_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js register
   AGRO_REAL_PAYMENTS_ENABLED=false TWITCH_TOKEN_REFRESH_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js reconcile
   ```

   Wait for the verified challenge and enabled state. On conflict/ambiguous timeout,
   stop and inspect/reconcile; do not register repeatedly or delete unrelated IDs.
   If the managed subscription is already enabled, do not recreate it.

3. Capture only public sanitized baselines. These shell variables contain no secrets:

   ```sh
   READINESS_BASE=https://twitch.theagrostore.com
   install -d -m 700 var/live-acceptance
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/health" --output var/live-acceptance/health.before.json
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/judge/chess/snapshot" --output var/live-acceptance/chess.before.json
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/judge/planet/snapshot" --output var/live-acceptance/planet.before.json
   node <<'NODE'
   const fs = require('node:fs'), assert = require('node:assert/strict');
   const read = name => JSON.parse(fs.readFileSync('var/live-acceptance/' + name + '.json'));
   const h = read('health.before'), c = read('chess.before'), p = read('planet.before');
   assert.equal(h.realPaymentsEnabled, false); assert.equal(h.twitchConnected, true);
   assert.equal(c.simulated, false); assert.equal(p.simulated, false);
   assert.equal(c.twitch.connected, true); assert.equal(p.twitch.connected, true);
   assert.equal(c.match.ply, 0);
   assert.equal(c.match.fen, require('chess.js').DEFAULT_POSITION);
   console.log('Live acceptance baseline ready; no credentials displayed.');
   NODE
   ```

   Stop if the match is not at the initial position. Do not delete history, reset
   IDs or clear replay files. A fresh match/storage lifecycle needs separate owner
   authorization. The exact moves below assume that initial position and a quiet
   controlled window with no other viewers issuing commands.

4. Open these real receiver pages in a browser, not the simulator:

   - https://twitch.theagrostore.com/judge/chess
   - https://twitch.theagrostore.com/judge/planet
   - https://twitch.theagrostore.com/editorial

   Optional bounded SSE observers, each in its own terminal:

   ```sh
   curl --fail --silent --show-error --no-buffer --max-time 60 "$READINESS_BASE/judge/chess/events"
   curl --fail --silent --show-error --no-buffer --max-time 60 "$READINESS_BASE/judge/planet/events"
   ```

   curl exit 28 at the intentional 60-second observation limit is expected for an
   open SSE stream. Data are already sanitized; do not enable verbose/header/body
   tracing or capture OAuth pages. Connected SSE does not prove connected video.

5. A real viewer sends these separate messages **in the configured Twitch chat**:

   ```text
   hello
   !ocean
   !move e2e4
   !move e2e9
   !move d2d4
   !move e7e5
   !ocean
   ```

   Expected: two accepted legal moves, Black then White turn, history e4/e5; malformed
   e2e9 is discarded; d2d4 on Black's turn is rejected without moving a piece.
   Two distinct !ocean messages add two live commands but at most one unique viewer.
   Repeating text is a new message, not an EventSub retry. Delivery/logical-message
   retry deduplication is exercised synthetically; never copy webhook signatures or
   replay test fixtures into the real public receiver. Ordinary chat changes no
   domain command counter. No new report, STAMP or reward should appear from chat.

6. Capture/verify the result; then reload both browser pages to verify recovery:

   ```sh
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/health" --output var/live-acceptance/health.after.json
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/judge/chess/snapshot" --output var/live-acceptance/chess.after.json
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/judge/planet/snapshot" --output var/live-acceptance/planet.after.json
   curl --fail --silent --show-error --max-time 10 "$READINESS_BASE/editorial/snapshot" --output var/live-acceptance/editorial.after.json
   node <<'NODE'
   const fs = require('node:fs'), assert = require('node:assert/strict');
   const read = name => JSON.parse(fs.readFileSync('var/live-acceptance/' + name + '.json'));
   const b = read('planet.before'), c = read('chess.after'), p = read('planet.after'), e = read('editorial.after');
   assert.equal(read('health.after').realPaymentsEnabled, false);
   assert.equal(c.simulated, false); assert.equal(p.simulated, false);
   assert.equal(c.twitch.connected, true); assert.equal(p.twitch.connected, true);
   assert.equal(c.match.ply, 2); assert.equal(c.match.turn, 'w');
   assert.deepEqual(c.match.history.map(m => m.uci), ['e2e4', 'e7e5']);
   assert.equal(c.counters.commands, read('chess.before').counters.commands + 3);
   assert.equal(p.counters.liveCommands, b.counters.liveCommands + 2);
   const unique = p.counters.liveParticipants - b.counters.liveParticipants;
   assert.ok(unique === 0 || unique === 1);
   assert.equal(p.counters.simulatedCommands, b.counters.simulatedCommands);
   assert.deepEqual(p.reports, b.reports);
   assert.equal(e.chess.counters.acceptedMoves, 2);
   assert.equal(e.planet.counters.liveCommands, p.counters.liveCommands);
   assert.equal(e.video.status, 'not_observed');
   console.log('Both real-chat paths passed; reload judge pages and confirm the same board/counters.');
   NODE
   ```

   Reloading/reconnecting must restore that same FEN/history and counters. This does
   not restart a service. Record only public counts, status, observation time and
   sanitized screenshots; leave the ignored snapshots local. Do not export logs,
   private state, credentials, callback query strings or actual chat identities.

7. Stop local curl observers/browser tabs when finished. Removing a remotely created
   subscription is a separately authorized action, not an automatic acceptance step:

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false TWITCH_TOKEN_REFRESH_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js remove
   ```

   Type REMOVE only if approved for this managed subscription. Do not change existing
   production services or delete OAuth/counter/replay state during cleanup.

## Interpretation and remaining work

- Real chat means a viewer typed into Twitch and a signed delivery reached the
  intended deployed receiver. Synthetic integration tests and local demos are not
  that evidence; source=twitch in a synthetic test is not a live connection claim.
- SSE carries browser application data. Actual Twitch video comes from a separate
  broadcaster/encoder and is not monitored by this bridge.
- Existing STAMP references/status remain service-reported. Missing proof stays
  missing; SHA-256 byte matching does not establish on-chain commitment or evidence.
- Simulation reward displays are illustrative. Actual issuance is a different
  authority; these chat/demo paths never invoke financial adapters or issue AGRO/STAMP.

Remaining: owner confirmation of real app/account/grants, approved current receiver
configuration/release and HTTPS routing, enabled managed subscription, suitable
initial match state and the actual viewer/browser acceptance above. No live token,
subscription or production-state inspection was performed to infer those values.

## Stage 6A verification results

On 2026-10-27: npm run check passed; npm run test:twitch-readiness passed its three
synthetic integration tests; npm test passed 167 tests (159 top-level), zero failures;
npm audit reported zero known vulnerabilities; git diff --check passed. Five tests
were added to the 162-test baseline. Test listeners were temporary and closed.

Changed files: README.md, package.json, test/twitch-chat.test.js,
test/twitch-readiness-harness.test.js, scripts/twitch-readiness.js and this document.
No src/, public/, .env.example or production configuration changed. No dependency
was installed/changed. Working tree excluding .git measured 1,644 KiB versus
1,600 KiB before this stage (+44 KiB); the filesystem remained 96% used with about
8.1 GiB available at the last observation. Free-space changes across the VPS are
not a measure of this patch's size. No staging, commit or push was performed.
