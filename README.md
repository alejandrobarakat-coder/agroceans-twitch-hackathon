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
