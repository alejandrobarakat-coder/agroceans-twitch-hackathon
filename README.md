# AgroCeans — Twitch for Planet

Codex x TwitchCon Hackathon 2026

An independent Twitch web experience connecting
streamers and viewers with environmental action.

Planned features:
- Twitch streamer integration
- Interactive environmental missions
- Live participation and overlays
- AgroWallet identity
- AgroBOL activity records
- STAMP verification
- Eligible AgroCoin rewards

Safety:
- No production modifications
- No real token transfers during development
- No changes to Android or iOS applications

## Local development

Requires Node.js 22 or newer. No third-party dependencies are needed.

```sh
npm run check
npm test
node --env-file=.env src/server.js
```

Copy `.env.example` to `.env` and supply a local demo token for simulation.
The bridge listens on `127.0.0.1:8766`; open `/overlay` for SSE updates.
Demo events remain labeled and never create STAMP records or AGRO payments.

## Existing ecosystem integration

The bridge now includes AgroWallet, AgroCeans, STAMP and AgroCoin adapter
ports, durable reward state, idempotency, limits, verified Twitch ingress,
and an overlay displaying verified action references and transaction status.
Live payments are disabled by default. Production clients and API details
are not present in this repository; no real connectivity is claimed.

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
rewards or payments; `/health` continues to report chat as disconnected.
Token refresh and Twitch-required periodic token validation must be implemented
before using these credentials for an ongoing API session.

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
