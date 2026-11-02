## IMPORTANT — JUDGE ACCESS TO AGROCEANS

The hackathon judges can access the AgroCeans mobile app
using the following TEST ACCOUNT.

**Download Android APK:**
https://agroland.theagrostore.com/agroceans-release.apk

**AgroCeans / Mastodon login:**

- Email: `domenzainro@gmail.com`
- Password: `agrocoin12345`

### How to evaluate

1. Download and install the Android APK.
2. Open AgroCeans.
3. Enter the email and password shown above in the app login screen.
4. Explore environmental reports, community features and Pinche Chess.
5. Open the Live section.
6. Select Connect Twitch and authorize your own Twitch account.
7. Test Twitch chat and the integrated experience.

These credentials are for the AgroCeans app, NOT GitHub or Twitch.

# AgroCeans — Live, Play & Act

## Hackathon submission — AgroCeans

AgroCeans is our single Codex x TwitchCon hackathon submission.
Pinche Chess is an integrated experience within AgroCeans, not a separate entry.

AgroCeans brings environmental reports, cleanups, meditation, sport,
community participation and chess into one mobile experience.
The existing ecosystem records eligible activities, creates STAMP references
and processes eligible AGRO rewards through separate services.

Twitch provides the shared live video and conversation layer.
Users can connect their own Twitch account and send chat messages inside
AgroCeans, with automatic return after mobile authorization.

### Codex contribution and evidence

Codex assisted implementation, debugging and verification of:
- Individual Twitch OAuth and private server-side token handling.
- Chat sending through Twitch's API and verified EventSub chat history.
- Native iOS and Android authentication return.
- Android camera and microphone permission handling.
- Automated tests, deployment scripts and judge documentation.

Validation included 189 server tests with mocked providers, Flutter analysis,
three authentication-return tests and manual mobile authorization/chat tests.
These checks do not verify every ecosystem feature or reward flow.

Existing report and chess services have recorded confirmed AGRO payments.
Wallet persistence across updates and delivery to the currently selected
wallet remain under investigation. Twitch authorization alone does not
prove wallet ownership or trigger rewards.

Codex session evidence: the session ID/link still needs to be added.


## Judge access — November 1, 2026

- [Android APK — repository access required](https://github.com/alejandrobarakat-coder/agroceans/releases/download/v1.0.0-20261103/app-release.apk)
- [Android release details — repository access required](https://github.com/alejandrobarakat-coder/agroceans/releases/tag/v1.0.0-20261103)
- Anonymous download currently returns 404 because the repository is private.
  A public APK mirror is proposed but has not been published. See the
  [delivery plan](docs/DELIVERY_ACCESS_PLAN.md) before sharing judge instructions.
  Verified APK SHA-256:
  `2c5a2a842625de6d2c5215a8ced654a6c6cd62501e31499e2b36780c10bde2d8`.
- iOS: build 5 tested internally; external TestFlight review pending.
  A public invitation will be added after approval.

### Quick test

1. Install the Android APK.
2. Open Live and select Connect Twitch.
3. Authorize your Twitch account. The mobile app returns automatically to Live.
4. Send a chat message and verify it on the Twitch channel.
5. Reopen Live to check the remembered connection.

The video depends on the broadcaster being online.
Twitch authorization does not link a wallet or trigger an AGRO payment.
Use a test wallet: wallet persistence across updates is under investigation.
Do not deposit funds for this evaluation.

### Built with Codex

Codex assisted implementation and debugging of individual Twitch OAuth,
server-side chat sending, verified EventSub chat history, native iOS and
Android authentication return, and Android camera/microphone permission handling.

Validation included 189 server tests using mocked providers, Flutter analysis,
three authentication-return tests, signed mobile builds, and manual account
authorization and chat tests on Android and iPhone.

Camera/microphone permission support does not by itself establish a broadcast
pipeline to Twitch. Historical development notes below describe earlier stages.


## Current Agroland Live implementation

Embedded Twitch video, individual account authorization and one chat composer.
One authorization includes the user:write:chat permission.
Messages are sent as the authorized user through Twitch's API.
Signed EventSub messages populate the shared history.
Sessions are remembered for up to seven days.
Tokens remain in private server storage and must never enter Git.
History contains up to 100 messages from the last ten minutes.
A server restart clears history, but retains saved account sessions.
Wallet ownership and reward delivery require separate integration.

### Local setup

Requires Node.js 22 or newer. Run:

    npm ci --ignore-scripts
    npm run check
    npm test
    node src/server.js

The server binds to 127.0.0.1:8766.
Tests use mocked providers; live authorization requires Twitch credentials.
Use .env.example as reference without overwriting existing configuration.
Load your private environment through the deployment system or:

    node --env-file=.env src/server.js

Use HTTPS and the registered callback:
https://twitch.theagrostore.com/auth/twitch/callback

Suppress query-string access logs on /auth/twitch/start and
/auth/twitch/callback. Use one Node process for authorization.
See docs/TWITCH_CHAT_ACTIVATION.md for channel EventSub setup.
Keep AGRO_REAL_PAYMENTS_ENABLED=false for this demonstration.

### Judge walkthrough

Open /pinche-live, connect Twitch, authorize and return to Live.
Send a message and verify it appears on Twitch.
Send from Twitch and verify it appears in Agroland.
Reopen Live to verify the remembered session.

Mobile source:
https://github.com/alejandrobarakat-coder/agroceans

Verification: 189 automated tests passed with mocked providers.
Android user testing confirmed authorization and message sending.
This does not establish hackathon submission status.

## Historical development notes

The material below records earlier stages, including deployment statements
that do not describe the current installation.


Codex x TwitchCon Hackathon 2026

Earlier development explored separate Chess and Planet demos. The final submission is one unified AgroCeans project, including Pinche Chess and the shared Twitch experience.

Current judge demos and setup: [Stage 5 guide](docs/JUDGE_DEMOS.md).
Historical source stages: [architecture and routing](docs/ARCHITECTURE.md).
Older activation/discovery notes below record earlier sessions, not current
deployment evidence. The existing AgroCeans wallets, rewards and STAMP work in
the original ecosystem; pending items here concern hackathon bridge integration.
SSE carries application events; actual Twitch video requires a broadcaster.

## Historical component demos — one final AgroCeans submission

| Component | Implemented demo behavior | Component judge view |
| --- | --- | --- |
| **Pinche Chess — Twitch Plays Chess** | Validated Twitch UCI commands feed an isolated authoritative chess session: legal moves, turn/king safety, special moves, game results, FEN/PGN, history and persistent idempotency. First legal move per turn; no voting. | `/judge/chess` |
| **AgroCeans — Twitch for Planet** | Exact `!ocean` participation plus authorized read-only ingestion of allowlisted, anonymously public reports; existing STAMP references/status, redaction, commitment mismatch rejection and report deduplication. | `/judge/planet` |

Both reuse Twitch authorization and signed EventSub ingress. Their state,
counters, identities and streams are separate. `/editorial` is a read-only
Pinche Tulum LIVE presentation with Alejandro Barakat, not a video publisher.
The source is implemented and tested with mocked providers; current live Twitch
activation and authenticated public-report retrieval are not established by that
test suite. Existing ecosystem wallets, STAMP and rewards are not rebuilt here.

Safety:
- No production modifications
- No real token transfers during development
- No changes to Android or iOS applications

## Local development

Requires Node.js 22 or newer and npm. The sole runtime dependency is exact-pinned
chess.js@1.4.0 with a committed lockfile. See [chess session](docs/CHESS_SESSION.md).

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit
git diff --check
```

The standalone simulations below need no `.env`, production credentials or Twitch
connection. All new capabilities default disabled; flags apply only to the process
in that command. Tests use fake providers, temporary repository-local storage,
ephemeral loopback listeners and child processes. A restrictive sandbox must allow
those test operations; EPERM is an environment restriction, not a passing test.

For a separately authorized bridge setup, create a private `.env` from
`.env.example` and load it with `node --env-file=.env src/server.js`. Never overwrite
an existing environment file. The bridge binds `127.0.0.1:8766` by default; it does
not start on installation or during a clone. `/overlay` is the legacy viewer.
Simulations never create STAMP records or AGRO payments. Generated state is ignored.

| Flag | Default | Scope |
| --- | --- | --- |
| `CHESS_SESSION_ENABLED` | `false` | Authoritative chess session; local chess simulator also requires it. |
| `AGRO_PLANET_REPORTS_ENABLED` | `false` | Real read-only public-report ingestion, requiring private policy/session and payment kill switch. |
| `JUDGE_DEMOS_ENABLED` | `false` | Two judge pages, their snapshots/SSE and editorial presentation. |
| `PLANET_DEMO_ENABLED` | `false` | Local judge simulator only; synthetic participation/reports, separate from live reports. |
| `TWITCH_EVENTS_ENABLED` | `false` | Signed Twitch ingress; separate authorization and subscription activation. |
| `TWITCH_TOKEN_REFRESH_ENABLED` | `false` | Optional ongoing user-token refresh. |
| `AGRO_REAL_PAYMENTS_ENABLED` | `false` | Must remain false for these demos; no issuance adapters are invoked. |

## Existing ecosystem integration

The bridge now includes AgroWallet, AgroCeans, STAMP and AgroCoin adapter
ports, durable reward state, idempotency, limits, verified Twitch ingress,
and an overlay displaying verified action references and transaction status.
Live payments are disabled by default. Financial adapter interfaces do not establish
a production payout integration. Read-only explorer/report clients are implemented
separately; original ecosystem capabilities remain in the original environment.

See [integration contracts, recovery procedures, activation blockers and deployment checklist](docs/INTEGRATION.md).
Do not activate payments before implementing and validating those contracts.

## Verified real connections

The bridge now includes clients for the existing AgroCoin explorer's chain
summary and raw transactions, optional authenticated Matrix report/STAMP
tracking, and a signature-verifying Twitch EventSub chat receiver.

See [verified endpoints, live test results and remaining blockers](docs/LIVE_CONNECTIONS.md).
The public chain and wallet-health clients were tested against real data.
Wallet ownership, approved-action eligibility, authenticated STAMP retrieval
and authorized reward submission remain blocked by the specific contracts
and access described there. No cryptocurrency transfer was attempted.

`node --env-file=.env scripts/verify-readonly.js` checks public chain and
wallet health. An authenticated local `POST /integration/refresh` updates
the new overlay section. Simulation remains separate. No production service
was deployed or restarted.

## Twitch OAuth (local implementation; deployment pending)

The authorization-code flow follows [Twitch's official documentation](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow).
Supply `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` and a random
`AGRO_OPERATOR_TOKEN` of at least 32 characters through the existing secure
environment mechanism. Protect `.env` with mode `0600`; do not commit it.
Set `TWITCH_OAUTH_SCOPES` to the space-delimited scopes needed by the intended
Twitch integration; the default is empty and grants no chat permissions.
The fixed registered redirect URI is
`https://twitch.theagrostore.com/auth/twitch/callback`.

`GET /auth/twitch/start` requires `Authorization: Bearer <operator token>`.
Use a trusted browser client capable of adding that header **only to this
same-origin start request** and following the redirect as a top-level navigation.
Do not put the operator token in a URL, frontend source, or a cross-origin header
rule. The browser must retain the Secure, HttpOnly, SameSite=Lax cookie for the
HTTPS callback. Direct navigation without the operator header returns 403.
The callback needs no operator header: its random state and browser cookie
are validated together. State expires after ten minutes, is consumed before
exchange, and is lost on restart. Start again after any failure. This in-memory
flow requires one server process (or sticky routing); it is not a shared PM2
cluster state store.

Tokens are exchanged server-side with a ten-second timeout and atomically saved
in ignored `var/twitch-oauth/credentials.json` (`0600`) within a private directory
(`0700`). An existing directory with broader permissions is rejected. Tokens and
provider errors are never returned or logged. Keep this directory excluded from
public static hosting and shared backups. Each successful connection replaces
the previous credentials. OAuth does not enable EventSub subscriptions, chat,
rewards or payments by itself. Ongoing token loading/validation, separately enabled
refresh and subscription lifecycle management now exist in `src/twitch-client.js`
and `src/twitch-chat.js`; see [EventSub implementation](docs/TWITCH_CHAT_ACTIVATION.md).
`/health` reports observed subscription/credential state, not proof of video broadcast.

Remaining deployment work: review scopes and secrets, verify existing proxy
access logs omit callback query strings (authorization codes), verify the
registered callback and HTTPS route forwarding, and arrange an explicitly
authorized deployment/restart with the environment loaded. No proxy, PM2, or
service configuration has been changed by this implementation. Never paste
callback URLs into logs or support reports.

### One-time browser authorization

A temporary VPS-only CLI can mint a two-minute, single-use fragment link for a
same-browser OAuth start, without sharing the operator token. Bootstrap is disabled
by default. See [bootstrap security prerequisites, exact activation and cleanup
commands](docs/OAUTH_BOOTSTRAP.md). The original operator-protected start remains
available. No EventSub, rewards or payments are enabled by this feature.

### Browser-first pairing (recommended; deployment pending)

The stable entry page is
`https://twitch.theagrostore.com/auth/twitch/connect`. With the separately enabled
pairing feature, create a request in your browser, approve it from a private VPS
terminal using `node scripts/oauth-pairing.js approve`, compare the displayed
phrase, and then continue to Twitch in the original browser. No bearer link or
browser header extension is needed. The CLI requires the same Unix account and
checkout as the bridge. Requests expire within five minutes and approvals are
one-time and browser-bound; OAuth state and server-side token storage are retained.

`TWITCH_OAUTH_PAIRING_ENABLED` defaults to false. Leave the legacy bootstrap,
EventSub and real payments disabled. See [pairing security, usage and exact gated
deployment steps](docs/OAUTH_PAIRING.md). No service or environment change has been
performed; deployment requires separate explicit authorization.

## EventSub !ocean participation (local implementation; activation pending)

The bridge can receive signed `channel.chat.message` webhooks, recognize exact
`!ocean` commands, and display durable live command/unique-participant counters
separately from simulation. Chat never initiates STAMP issuance or AGRO payments.
The existing OAuth credential file is preserved; any approved refresh rotation is
stored separately in private `var/twitch-chat/` state.

Use the local operator CLI `scripts/twitch-eventsub.js` for preflight, explicit
registration, reconciliation, removal and explicit refresh. No subscription is
created on startup. The broadcaster must be the authorized reader and grant
`user:read:chat user:bot channel:bot`. Missing permissions fail closed. Runtime
requires `TWITCH_EVENTS_ENABLED=true` and `AGRO_REAL_PAYMENTS_ENABLED=false`;
automatic refresh additionally requires `TWITCH_TOKEN_REFRESH_ENABLED=true`.

See [security boundaries, tests and exact separately authorized activation steps](docs/TWITCH_CHAT_ACTIVATION.md).
No deployment, PM2 restart, environment edit or live registration was performed.

## Standalone Pinche Chess browser demo (Stage 3)

See [routes, source labels, limits and local simulation](docs/CHESS_BROWSER_DEMO.md).
The main bridge serves `/chess`, `/chess/snapshot` and `/chess/events`. Chess is
disabled by default. Its events/snapshots are isolated from planet `/events`.

For an explicitly simulated local viewer, without Twitch credentials:

```sh
CHESS_SESSION_ENABLED=true PORT=8877 npm run demo:chess
```

Open `http://127.0.0.1:8877/chess` and enter UCI moves such as `e2e4`, `e7e5` in
the terminal. The page remains read-only. This command uses separate simulation
storage and changes no deployed environment. No local demo process is started
by these source changes.

## AgroCeans public environmental reports (Stage 4)

See [verified source contracts and read-only ingestion](docs/PLANET_REPORTS.md).
Stage 4 is disabled by default. It requires an operator-approved folio/post policy,
an anonymous public-publication check, an authorized Matrix tracking session and
the payment kill switch. `POST /planet/refresh` requires operator authentication;
`GET /planet/snapshot` and `/planet/events` publish only redacted observations.
Existing !ocean participation remains unchanged. No STAMP or AGRO is issued.

## AgroCeans module demos and editorial desk (Stage 5)

All new routes default disabled. See [judge demos and exact local commands](docs/JUDGE_DEMOS.md).
An isolated simulation for all three pages requires no Twitch credentials:

```sh
JUDGE_DEMOS_ENABLED=true CHESS_SESSION_ENABLED=true PLANET_DEMO_ENABLED=true PORT=8878 npm run demo:judges
```

- Pinche Chess: `http://127.0.0.1:8878/judge/chess`
- AgroCeans: `http://127.0.0.1:8878/judge/planet`
- Pinche Tulum LIVE with Alejandro Barakat: `http://127.0.0.1:8878/editorial`

Terminal inputs: `chess e2e4`, `chess e7e5`, `planet !ocean viewer1`,
`planet report sample1`. Reports are explicitly synthetic and have no STAMP.
The browser is read-only. No local process is started by these source changes.

## Twitch readiness for AgroCeans modules (Stage 6A)

Run `npm run test:twitch-readiness` for synthetic signed-webhook-to-judge coverage.
The harness uses fake providers and a clean child environment; it cannot target a
live receiver. See [readiness findings and later real-chat acceptance commands](docs/TWITCH_LIVE_READINESS.md).
No runtime activation, token exchange, subscription change or deployment is part
of this stage.
