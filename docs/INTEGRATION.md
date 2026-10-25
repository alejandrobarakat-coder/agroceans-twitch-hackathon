# Ecosystem integration contract

This repository supplies orchestration and adapter ports, not fabricated production clients. No live service has been contacted. Live payment flags are off by default. Real STAMP creation is also gated by these flags. Simulation cannot invoke this workflow.

## Required deployment module

`AGRO_INTEGRATION_MODULE` names a trusted CommonJS module inside this repository exporting `wallet`, `agroceans`, `stamp`, `agrocoin`, and `twitch`. Implement clients only after ecosystem owners supply authentic contracts. Keep credentials in environment variables or a secret manager. Never give this process private keys or wallet signing access. Provider clients must implement authenticated TLS, deadlines, bounded responses, schema validation and redacted operational logs. Do not blindly retry mutations.

The following are internal JavaScript port contracts, not claims about existing production HTTP endpoints:

- `wallet.resolveVerifiedIdentity({twitchId})` returns `{twitchId, identityId, address, verified:true}` from the existing AgroWallet linking workflow. That workflow must prove control of both identities, enforce link uniqueness, and handle expiry/revocation. No address supplied by a browser is trusted.
- `agroceans.getApprovedAction({actionId,identityId})` returns `{actionId,identityId,approvalId,status:'approved',evidenceVerified:true,rewardUnits}`. `rewardUnits` is a positive integer string in AGRO base units, set by the existing approval policy. This bridge never accepts user evidence or approves actions. The authoritative service must enforce approval ownership and payout eligibility atomically at issuance, including revocation checks.
- `stamp.ensureRecord({actionId,approvalId,identityId,idempotencyKey})` returns `{actionId,approvalId,id,status:'verified',reference}`. `reference` is a publicly safe verifiable identifier. The provider must enforce global uniqueness per approved action, including across other integrations, and validate identity binding. Only verified records permit payout.
- `agrocoin.requestReward({idempotencyKey,actionId,approvalId,stampId,address,rewardUnits})` returns `{status,transactionId,confirmations}`. Status is `pending`, `submitted`, `confirmed` or `failed`. Submitted/confirmed require a transaction ID; confirmed requires positive confirmations. The client must validate provider response binding to this exact request, chain/network, recipient and amount. The authoritative payout service must recheck eligibility, authorization and limits, deduplicate globally by action and key, and own signing. This bridge never signs transactions.
- `agrocoin.getReward({idempotencyKey,transactionId})` returns the same transaction shape with authoritative status. Lookup by idempotency key is mandatory for timeouts before a transaction ID exists. A changed transaction ID is rejected. The client must normalize chain-specific finality thresholds and reorg policy; `confirmed` must mean final according to the agreed policy.
- `twitch.verifyEvent({headers,rawBody})` verifies actual Twitch authenticity and returns `{id,twitchId,kind:'chat'|'interaction',verified:true,simulated:false,timestamp}` with timestamp in epoch milliseconds. Validate signatures against raw bytes, subscription status, message type, broadcaster allowlist, timestamp and identity. Handle subscription challenges at the upstream ingress. Never map demo activity to this port. The bridge adds durable replay rejection and a five-minute freshness limit. Chat events publish participation only.

## Bridge interfaces

All mutation routes require `Authorization: Bearer <AGRO_OPERATOR_TOKEN>` (minimum 32 characters). They are server-to-server routes; do not put the token in overlay URLs or browser JavaScript. Use a separate authenticated ingress to forward verified Twitch webhook requests while preserving original headers and raw bytes; do not expose the operator credential to Twitch viewers.

- `POST /integration/reward`: `{actionId,twitchId}`. Called only by the trusted authorized approval worker. Resolves wallet and approved action from authoritative services; callers cannot select an amount or address.
- `POST /integration/reconcile`: `{key}`. Run an authorized external reconciliation worker for pending/submitted/requesting records until terminal. A confirmed/failed record is terminal locally. Chain-specific reorg handling requires the provider finality policy before activation.
- `POST /integration/twitch`: original verified webhook body and headers, forwarded by trusted ingress. Cannot request rewards.
- `GET /events`: public SSE with recent reward snapshot, updates and heartbeat. Publishes action/reference/transaction identifiers and amounts, never wallet links, bearer tokens or private keys. Obtain consent for public identifiers and require providers to return only public-safe references.
- `GET /health`: reports configuration and payment gate, not proof of Twitch or blockchain connectivity. Connection booleans remain false until real connectivity monitoring exists.
- Existing localhost-only authenticated `POST /demo/ocean` remains simulation only.

## State and recovery

`var/integration/integration-state.json` stores wallet links, reservations, replay IDs and audit entries with private filesystem permissions. It is excluded from Git. A serialized queue, atomic replacement and fsync protect a single process. This store is not a distributed database, tamper-proof ledger or unlimited-throughput queue. Deploy exactly one writer; do not use cluster mode, replicas, shared writers or ephemeral disks. For scaling, replace it with transactional durable storage, unique constraints and append-only external audit storage before activation. Back up and protect this file; deleting it removes local limits and replay history. Provider-side uniqueness is mandatory regardless of local state.

Every action receives a deterministic idempotency key. Reservations consume a global UTC-day budget even after failure (conservative; no automatic refunds). The default zero limits reject payouts. Integer units avoid floating-point currency rounding. Persisted `requesting` records are queried, never automatically resubmitted. A failure during STAMP creation requires operator reconciliation with the provider using the recorded key. `reserved`/`stamp_verified` records require manual recovery with fresh wallet and approval checks; no automatic payout occurs. Audit entries record stages, keys and timestamps; provider audit must supply transaction-level evidence. Errors are not returned verbatim to browsers. Investigate failures through state audit and redacted provider logs.

## Activation blockers: obtain from ecosystem owners

1. Actual API URLs, versions, schemas, authentication and environment-specific credential scopes for each service.
2. AgroWallet ownership proof, verified linking lookup, address validation, supported network and revocation semantics.
3. AgroCeans approval lookup, policy amounts, evidence status, eligibility, ownership and atomic revocation enforcement.
4. STAMP creation/lookup, global duplicate keys, signature/proof verification and public reference format.
5. AgroCoin reward authorization, global idempotency, lookup after timeout, transaction schema, base-unit decimals, network, fees, finality and reorg handling.
6. Twitch application/subscription details, actual ingress verification implementation, allowed channels and event schemas.
7. Explicit operator authorization, limits, audit retention, public identifier consent, monitoring and tested recovery procedures.

No production endpoint, blockchain format or authentication method is assumed by this implementation.

## Deployment and security checklist

- [ ] Implement and review real clients against supplied contracts; test against authorized staging services.
- [ ] Validate identity revocation, approval revocation, duplicate requests across integrations, provider outages, ambiguous submissions, STAMP recovery and blockchain finality.
- [ ] Configure least-privilege service credentials, HTTPS ingress, operator authentication, allowlists, rate limits and request size/time limits; protect internal routes from public access.
- [ ] Verify no signing keys, secrets or production data appear in Git, logs, SSE or static assets.
- [ ] Use a persistent private state volume, one writer, backups and external audit/alerting. Monitor disk usage; local audit history grows over time.
- [ ] Configure authorized reconciliation scheduling, alerts for stuck reservations and documented manual recovery. SSE is a bounded snapshot, not an audit log.
- [ ] Establish provider-side uniqueness/atomic eligibility enforcement and finality policy. Run syntax checks and tests on Node 22 or newer.
- [ ] Review public overlay privacy and separate demo counters from verified records.
- [ ] Obtain explicit live payment authorization only after staging acceptance; set both payment gates and nonzero integer limits in the deployment environment. This task does not authorize activation.
- [ ] Deployment, service restart and live payment execution require a separate authorized operation. None was performed here.

## Implementation update: verified read-only services

See [LIVE_CONNECTIONS.md](LIVE_CONNECTIONS.md) for actual source-discovered
endpoints and real production read-only validation. `src/ecosystem.js`
implements explorer reads, optional Matrix tracking and Twitch signatures;
`POST /integration/refresh` publishes sanitized observations. STAMP tracking
metadata is not interpreted as approval or cryptographic proof. Provider
reconciliation of existing rewards now remains available with payouts off.
The production authenticated reward client and verified Twitch-to-wallet
link are still missing; no live payments are enabled.
