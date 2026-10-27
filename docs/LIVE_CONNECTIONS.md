> Historical assessment: implementation descriptions below may predate the current
> source. See [current architecture](ARCHITECTURE.md) and
> [EventSub implementation](TWITCH_CHAT_ACTIVATION.md). Historical observations
> do not establish current deployment or connectivity.

# Verified existing-service connections

Reviewed and tested 2026-10-25. Changes are confined to this repository. Production source was inspected read-only; no credentials, private keys, wallet databases or private report records were opened. No worker was executed, webhook subscription created, transaction submitted, service restarted or deployment made.

## Implemented and tested against production public data

`src/ecosystem.js` now implements real HTTPS clients for the following verified explorer contracts, not configurable guesses:

| Endpoint | Evidence and observed result |
| --- | --- |
| `https://agroland.theagrostore.com/ext/summary` | `routes/index.js` returns `{data:[{blockcount,...}]}`; live 200 JSON, height 378064 during initial probe, 378066 during Node client validation |
| `https://agroland.theagrostore.com/api/getblockcount` | Explorer `app.js` read-only RPC allowlist; live JSON integer |
| `https://agroland.theagrostore.com/api/getblockhash?index=<height>` | Same allowlist; live JSON block hash |
| `https://agroland.theagrostore.com/api/getblock?hash=<hash>` | Same allowlist; live block object with height, hash and transaction IDs |
| `https://agroland.theagrostore.com/api/getrawtransaction?txid=<id>&decrypt=1` | Same allowlist and `lib/explorer.js`; live transaction object with `txid`, `vout`, `blockhash`, `confirmations` |
| `https://agrocoin.theagrostore.com/public-wallet/health` | `/opt/agrocoin-public-wallet/public_wallet.py`; live `{service:'agrocoin-public-wallet',custody:false}` |

The implemented Node client successfully read the chain tip and a real transaction with one confirmation, and verified noncustodial wallet health. No identity or wallet balances were queried. Explorer transaction observations are not evidence that a transaction is an approved environmental reward. Negative confirmations remain conflicts. Six confirmations is used as the existing STAMP worker's observed display threshold; it is not a claim of irreversible consensus finality. Later refreshes can show changes.

Source locations: `/var/www/agrocoinexplorer/app.js`, `routes/index.js`, `models/tx.js`, `lib/explorer.js`; `/opt/agrocoin-public-wallet/public_wallet.py`. The explorer's `/ext/gettx/:id` top-level `confirmations` is a configured threshold, not actual transaction depth; the new client deliberately reads the raw transaction confirmation field instead.

## Existing Matrix community and reporting

The supplied Matrix hostname is a HumHub community site, confirmed by live redirect and controller code. No assumption of a Matrix Client-Server API is made. Its homepage is reachable at `https://matrix.theagrostore.com/`.

Implemented `MatrixReportsClient.tracking()` calls:

`GET https://matrix.theagrostore.com/index.php?r=agro_impact%2Freport%2Ftracking`

Source: `/var/www/love/protected/modules/agro_impact/controllers/ReportController.php`, `actionTracking()`. Authentication uses the existing HumHub authenticated user session (`AccessControl` role `@`). The live unauthenticated request redirected to user login. This client rejects redirects and HTML rather than mistaking a login page for report data. No session was accessed or copied. An explicitly provisioned authorized session is required to test authenticated retrieval.

Source response is `{ok:true,reports:[{folio,title,...,stamp}]}`. `stamp` can include `status`, `chain_status`, `txid`, `confirmations`, `category_code`, `amount_agro`, `receiver`, and nested `reward:{status,txid,confirmations,amount_agro,destination}` from the existing status exporter. The client returns only explicitly allowlisted/consented folios, STAMP status/transaction ID, and reward status/transaction ID/amount. It strips photos, evidence, title, location, receiver, destination and all other fields. Actual transaction confirmations are fetched separately from the explorer. Report credentials are never broadcast.

The tracking response does not expose authoritative approval, eligibility or a certificate commitment/proof. Consequently this client never marks a tracking record as reward-eligible, ownership-verified or cryptographically verified. STAMP is labeled service-reported. No authenticated production STAMP record has been retrieved in this session.

Existing messaging source `/var/www/agroverse-matrix/index.js` defines `/api/matrix/feed`, `/api/matrix/post`, `/api/matrix/react` and `/api/messages` on port 3335. It is a separate legacy service; routing to the supplied Matrix hostname and a secure authenticated write contract were not established. No messaging writes or private message reads were attempted. Matrix messaging events are not connected.

## Wallet identity: real implementation located, safe linking remains blocked

- AgroCeans source `/home/domenzainro/agroceans/lib/agro_wallet/self_custody/impact_identity.dart` describes purpose `agro-impact-wallet-link-v1`, audience `https://matrix.theagrostore.com`, a 64-hex nonce, five-minute expiry, domain-prefixed SHA-256, public key and DER ECDSA proof. This is a wallet-side signer, not a discovered server challenge/consume API. No private key source or data was opened.
- Existing HumHub `IdentityController::actionDestination()` and Mastodon `/var/www/agromastodon/app/controllers/agro_impact_identity_controller.rb` accept a Base58Check AGRO destination with version byte 23, but explicitly persist `ownership_verified:false`.
- Mastodon `/agro-impact/identity` requires a signed-in web session and returns only destination metadata; the community handoff uses server-managed HMAC and authenticates the social account, not wallet ownership. The bridge must not ingest handoff secrets or upgrade this address to a verified wallet.
- `wallet.theagrostore.com` returns the existing Mastodon frontend; the noncustodial wallet service is a distinct service on the AgroCoin hostname.

Blocked: an existing server-issued, single-use wallet-proof challenge/verification contract and an authenticated binding from Twitch's immutable user ID to the verified ecosystem identity. No such lookup/consume endpoint was found. An authenticated payout cannot safely be implemented using address metadata alone.

## STAMP and reward infrastructure actually found

Production STAMP preparation source: `/var/www/agrobol/tools/prepare-impact-stamps.py`. It hashes evidence, preserves canonical manifest bytes, computes a SHA-256 commitment and exclusively creates a certificate record. Its existence does not mean an environmental reviewer approved the evidence.

Production STAMP worker `/var/www/agrobol/tools/run-impact-stamps.py` and status exporter `export-impact-status.py` matched the inspected copies in `/home/domenzainro/agroceans-update-v15/tools/` by hash. The STAMP worker signs/broadcasts inside the existing ecosystem, persists transaction intent, uses six confirmations, observes reorganizations and reports `hash_embedded_onchain:false`. Thus a confirmed STAMP transfer does not prove the report commitment was embedded on-chain.

Reward worker source copy `/home/domenzainro/agroceans-update-v15/tools/run-impact-rewards.py` describes fixed 0.1 AGRO rewards plus 0.001 fee, source/evidence rechecks, exclusive folio records, stored signed bytes, transaction lookup and identical-byte timeout recovery. **The production reward worker file remained permission denied, including under the available approved escalation; deployed equivalence is unverified.** No configuration or transfer files were read and no worker was run, including dry-run (which can still call node RPC and prepare transactions).

No authenticated HTTP request/lookup endpoint for this reward authority was discovered. The reviewed worker copy does not establish a Twitch binding or explicit reviewer approval gate. `POST /api/agro/send` exists in `/var/www/agrocoin-api/index.js` but the handler shown has no authentication, approval binding or idempotency checks and directly invokes `sendtoaddress`. It was not called and is not used by this integration. Public-wallet `/broadcast` relays already signed transactions; it is not an authorized environmental payout service and is not used.

**Authenticated AgroCoin payout integration remains blocked, not implemented against a verified production payout API.** The pre-existing local orchestration remains gated off. Needed: an owner-approved authenticated reward-authority contract with current wallet ownership, explicit approval/eligibility, global folio uniqueness, amount/fee limits, submission/request IDs, and lookup after uncertain responses. The integration must reuse that authority without accessing its wallet or executing its workers.

## Port findings

| Supplied port | Verified finding |
| --- | --- |
| 7778 | Listening Node process, working directory `/var/www`; precise source/service contract not established; unused |
| 7780 | No listener at inspection time; `/var/www/theagrostore/lab/server.js` declares an AgroWallet LAB service there; unused |
| 3333 | Listener with working directory `/var/www/agrobol`; candidate `/var/www/agrocoin-api/index.js` declares this port, but process-to-file mapping not proven; unsafe send route not used |
| 3334 | Listener process name starts `node /opt/agroc`; `/opt/agroclaw-api/index.js` declares port 3334 and promo/health routes. This is a candidate AgroClaw service, not a verified AgroCoin reward API; unused |

Listener evidence does not verify ownership, routing or safe operation contracts. No arbitrary port probing or mutation was used.

## Twitch implementation and remaining activation

`TwitchWebhook` implements the actual [Twitch EventSub webhook signature contract](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/): HMAC of message ID, timestamp and exact raw bytes, constant-time comparison, freshness validation, signed callback challenge handling and revocation handling. It accepts only configured `channel.chat.message` version 1 subscriptions and broadcaster IDs; the schema follows [Twitch's subscription reference](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage). No chat text or display names are published. Opaque Twitch message IDs are hashed for the durable local replay store. Duplicate notifications are acknowledged without republishing; chat never invokes payouts.

The separate `/twitch/eventsub` receiver does not require or expose the operator bearer token. It is disabled unless explicitly configured, and uses `var/twitch` for replay/audit state. Callback/revocation state is local to the process; subscription lifecycle must be verified again before re-enabling after a restart. Existing shared internal adapter ingress remains separate.

Genuine Twitch events are not connected: no authorized subscription ID, broadcaster numeric ID, provisioned webhook secret or verified callback deployment was supplied. No OAuth credential was opened and no subscription created. The channel name alone is insufficient. Deployment and subscription registration remain separate authorized actions.

## Use the implemented read-only integration locally

1. Copy the configuration example into a local secure environment. Set `AGRO_EXPLORER_URL` and optionally authorized Matrix session/consented folios. Keep real payment flags false. The server does not automatically load `.env`; use Node's env-file flag or a process manager.
2. Run `node --env-file=.env scripts/verify-readonly.js` for public chain/wallet-health verification only. This does not query user identities, STAMP data or sign/broadcast transactions.
3. Start an isolated local instance with a free port via `node --env-file=.env src/server.js`; do not restart or overwrite the running public overlay service.
4. A trusted operator calls local `POST /integration/refresh` with the configured operator bearer. This triggers only read-only source-verified APIs and broadcasts sanitized results. No polling starts automatically. Configure only consented public transaction IDs/folios. The overlay receives a real-data section alongside the unchanged simulation path.
5. Refresh to update observations; timestamps are displayed. Memory-only snapshots are cleared at restart; they are not financial audit records. Configured transaction observations never become reward authorization.

`AGRO_MATRIX_SESSION_COOKIE` is a credential and must remain server-side. It is an optional compatibility mechanism with the existing session API, not a new authentication scheme or a recommended long-lived service identity. A scoped service-to-service reporting contract is still needed for unattended production use. The public overlay was not redeployed, so it does not yet run this code.

## Validation and remaining gates

Syntax checks cover server, workflow, real clients and read-only verification script. Twelve tests cover existing reward safeguards, read-only reconciliation under a payment kill switch, real response mappings, transaction mismatch, conflicts, redaction, authentication response rejection, size bounds, partial failure and Twitch signatures/challenges/allowlists. Live Node validation returned chain height 378066, a verified raw transaction with one confirmation, healthy noncustodial wallet service and `paymentsAttempted:false`.

Before a controlled reward: resolve the wallet-proof/Twitch binding and authoritative approval APIs; obtain authenticated STAMP/proof access; verify the deployed reward-authority API and global idempotency; replace or harden the single-writer JSON financial store and audit trail; validate staging timeout/reorg/recovery behavior; provision scoped credentials; and obtain separate explicit transaction authorization. The current JSON store and generic payout reconciliation still have the limitations in `API_DISCOVERY.md`, except read-only reconciliation no longer requires payment gates to be enabled. Real transaction observation here supports changing confirmations but does not update terminal reward-ledger states after reorganizations.
