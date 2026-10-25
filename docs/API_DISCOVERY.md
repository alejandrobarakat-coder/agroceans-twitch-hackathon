# Existing Agro ecosystem API discovery

Historical offline review date: 2026-10-25. Subsequent source inspection and live read-only results are recorded in [LIVE_CONNECTIONS.md](LIVE_CONNECTIONS.md); the later implementation also removes the payout gate from read-only reward reconciliation. Evidence: `docs/INTEGRATION.md`, `src/integration.js`, and `src/server.js` in this repository. No production directories, credentials or APIs were accessed. No external documentation was queried. This document requests contract evidence from service owners; it does not establish production compatibility.

## Confirmed versus proposed

**Confirmed locally:** the CommonJS adapter methods, normalized data shapes, bridge routes and checks described below exist in the reviewed source. These are internal interfaces only. The existence of operational ecosystem services is supplied by the project owner; their network interfaces have not been verified.

**Unconfirmed:** every production URL, transport, method, version, authentication mechanism, scope, schema, error code, transaction encoding, identity proof and finality rule. No production endpoint is proposed here. The expected objects below describe the current bridge boundary; owners must supply the actual service contract and a mapping, or identify necessary bridge changes.

**Proposed architecture:** service-specific least-privilege clients, authoritative payout authorization, durable transactional storage and independent reconciliation. These are recommendations, not implemented production capabilities.

## Contract evidence to obtain for every service

- [ ] Owner and security contact; approved staging environment; published specification/version and sanitized request/response examples, including errors.
- [ ] Exact scheme/host/port/path or RPC method, HTTP method if applicable, headers, content type, pagination, schema constraints and version/deprecation policy.
- [ ] Actual authentication scheme (do not assume bearer tokens), service identity, audience, read/write scopes, credential provisioning/rotation/revocation, expiry, clock-skew rules and TLS/certificate requirements. Request credential metadata and provisioning procedures, never secret values in this document.
- [ ] Tenant/network boundaries, authorization rules, rate/concurrency limits, response-size limits, timeouts, availability and consistency guarantees.
- [ ] Distinct outcomes for invalid, unauthorized, forbidden, missing, pending, revoked, duplicate, conflicting, throttled, unavailable and ambiguous requests. Agree which errors can be retried, retry intervals and mutation lookup rules.
- [ ] Idempotency namespace, key length/encoding, retention, uniqueness boundary, conflict behavior and lookup after timeout. Define behavior after backup restoration and across independent reward issuers.
- [ ] Correlation IDs, audit retention, data classification, permissible public fields, operational monitoring and an approved conformance test dataset.

## AgroWallet: verified identity and address resolution

**Existing local port (read-only):**

```js
wallet.resolveVerifiedIdentity({ twitchId })
// normalized success
{ twitchId, identityId, address, verified: true }
```

The current bridge checks exact Twitch ID equality, `verified === true`, an identity ID matching `[A-Za-z0-9_.:-]{1,160}`, and a nonempty address string. It does not validate address encoding/network, link expiry, proof, uniqueness or revocation itself.

- [ ] Supply the existing lookup contract and canonical immutable Twitch user ID representation; do not use a mutable display name.
- [ ] Define identity/address cardinality, network identifiers, account/address format, checksum and wallet eligibility checks. Determine whether destination tags/memos are required; the current port has no field for these.
- [ ] Supply link status, verification time, expiration, version and revocation semantics. Require fresh authoritative verification and document cache limits.
- [ ] Describe the existing user linking flow: proof of Twitch account control, AgroWallet session/ownership, consent, challenge nonce, expiry, replay protection, unlinking and address changes. No linking UI or linking mutation is implemented here.
- [ ] Obtain read-only identity lookup permission. Creating/changing a link, if needed, is a separately authorized write in AgroWallet's existing flow; it must never accept an arbitrary viewer-provided address as verified.

Never transfer seed phrases, private keys, wallet passwords or signing sessions to this bridge or Twitch. Return only the minimum verified identity and payout destination.

## AgroCeans: authoritative approved environmental action

**Existing local port (read-only):**

```js
agroceans.getApprovedAction({ actionId, identityId })
// normalized success
{ actionId, identityId, approvalId, status: 'approved',
  evidenceVerified: true, rewardUnits: '10' }
```

`'10'` is illustrative integer base units, not an approved rate. Current checks enforce exact action/identity equality, approval status, verified evidence, an identifier-shaped approval ID and a positive decimal integer string of at most 30 digits.

- [ ] Supply report/action, mission, evidence and approval ID definitions and their uniqueness scope. Establish whether one action can have multiple beneficiaries, approvals, assets or reward installments; the current workflow permits one reward per action ID.
- [ ] Supply existing submission URL/workflow references, approval query and statuses, ownership rules, evidence verification meaning, reviewer authorization and approval version.
- [ ] Establish who computes the reward, unit policy/version, eligibility window, revocation/rejection/appeal rules and whether approval means reward authorization or only evidence validation.
- [ ] Supply an authorized approval event or polling contract, event ID, cursor, signature/authentication, ordering, retry and replay rules. No approval worker/subscription exists locally.
- [ ] Explain atomic consumption/claim semantics preventing the same approval from funding multiple integrations. Lookup alone cannot eliminate the gap between validation and payout.
- [ ] Determine whether a claim/consume write exists and who owns it. If needed, it belongs to the authorized reward authority; do not invent an approval mutation in this bridge.

Evidence submission and validation stay in AgroCeans. Read-only approval lookup is sufficient only when the payout authority independently enforces current eligibility and global uniqueness.

## STAMP: existing verified record and duplicate prevention

**Existing local port (potential authorized write):**

```js
stamp.ensureRecord({ actionId, approvalId, identityId, idempotencyKey })
// normalized success
{ actionId, approvalId, id, status: 'verified', reference }
```

The local adapter checks action/approval equality, verified status, record ID shape and nonempty reference. It does not cryptographically verify proofs or check returned identity binding; the production client must do both according to the actual contract.

- [ ] Determine whether approved AgroCeans actions already produce STAMP records. Prefer read-only lookup of existing verified records if so; `ensureRecord` may normalize that lookup without creating anything.
- [ ] If creation is necessary, obtain the actual authorized issuance contract, issuer identity, scopes, policy and global uniqueness constraints. Identify whether issuance itself causes a reward so the bridge does not issue a second payment.
- [ ] Supply lookup by action, approval and idempotency key, including timeout recovery; the current engine has no separate STAMP reconciliation method.
- [ ] Supply record schema/version, subject identity, approval/evidence bindings, issuer, verification proof/signature algorithm, trust anchor distribution/rotation, revoked/pending states and public reference resolution.
- [ ] Specify whether references are URLs or identifiers, public visibility and maximum lengths. Do not expose evidence, personal data or credential-bearing URLs in the overlay.
- [ ] Define concurrent duplicate behavior, canonical record selection and consistency between record issuance and approval consumption.

## AgroCoin: authorized rewards and chain observation

**Existing local ports:**

```js
// authorized write; does not sign locally
agrocoin.requestReward({ idempotencyKey, actionId, approvalId,
  stampId, address, rewardUnits })
// read-only lookup
agrocoin.getReward({ idempotencyKey, transactionId })
// normalized response from either operation
{ status: 'pending' /* or submitted, confirmed, failed */,
  transactionId: null, confirmations: 0 }
```

For lookup before the transaction ID is known, `transactionId` is `null`. Submitted/confirmed require a nonempty transaction ID. Confirmations must be a nonnegative safe integer; local confirmation validation accepts any positive value for `confirmed`. This is not a verified chain finality rule.

- [ ] Establish whether an existing reward/treasury authority can authorize and submit payments. A blockchain/mining node interface alone does not establish authority to pay environmental rewards. Identify the funding account and signing boundary without disclosing its credentials.
- [ ] Supply reward authorization, server-side policy checks, approval/STAMP ownership verification, current wallet validation, per-beneficiary/global budgets and atomic global duplicate prevention.
- [ ] Confirm asset and chain/network identifiers, AGRO base-unit exponent, supported numeric bounds, recipient encoding/checksum and destination memo/tag requirements.
- [ ] Supply the actual transaction schema: transaction ID encoding and canonicalization; inputs/outputs or account/nonce model as applicable; recipient/amount fields; asset; network; fee and fee payer; pending/rejected/dropped/replaced states; block ID/height; inclusion proof/receipt and execution result. Do not assume EVM, UTXO or a transfer serialization.
- [ ] Identify the authorized submission API and its exact response, distinct reward-request ID versus blockchain transaction ID, idempotent retry behavior, body hash binding and lookup by idempotency key even if submission times out.
- [ ] Define authoritative not-found versus temporarily unknown, queued versus broadcast, definitive rejection versus ambiguous failure, dropped transaction recovery and cancellation/replacement policy. Never normalize an uncertain result into terminal `failed`.
- [ ] Supply transaction lookup/indexing availability, confirmation count definition, finality threshold, reorg detection/rollback, replacement ID lineage and explorer/public verification references.
- [ ] Define mining network relevance to confirmations and finality; mining participation or Twitch chat must not independently mint a reward.
- [ ] Provide sanitized examples of successful, pending, rejected, replaced and reorganized transactions plus chain/network mismatch examples. The client must verify destination, amount, asset, network and request binding before normalizing responses.

Read-only observation credentials should be separate from reward-write authorization. Signing remains inside the existing ecosystem authority. No raw transaction construction or signing belongs in the Twitch process.

## Twitch and internal bridge authorization

**Confirmed local routes:** `POST /integration/reward` accepts `{actionId,twitchId}`; `POST /integration/reconcile` accepts `{key}`; `POST /integration/twitch` accepts raw forwarded event bytes. All share the same operator bearer token (minimum 32 characters), and require a configured integration module. These routes are local bridge APIs, not ecosystem endpoints.

**Confirmed local verification port:**

```js
twitch.verifyEvent({ headers, rawBody })
// normalized verified event
{ id, twitchId, kind: 'chat' /* or interaction */, verified: true,
  simulated: false, timestamp: 0 /* actual epoch milliseconds required */ }
```

The engine checks identifiers, event kinds, flags and a five-minute freshness window and saves replay IDs. It does not verify Twitch signatures itself. Event ingestion never invokes reward issuance.

- [ ] Obtain actual integration transport, event types/schema versions, application identity, subscription/channel allowlist, authentication scopes, signature verification rules, challenges/revocations and key rotation from the authorized Twitch integration owner/documentation. No exact external Twitch contract has been verified during this offline review.
- [ ] Define authenticated forwarding of original headers/raw bytes without ambiguity; the operator bearer is an internal credential, not a Twitch credential. Separate challenge handling from reward routes.
- [ ] Define stable event IDs, timestamp conversion, user identity extraction, broadcaster checks, duplicate acknowledgments and recovery after freshness expiry.
- [ ] Separate ingress, approval-worker and reconciliation identities/scopes. The shared operator token currently gives a compromised ingress access to reward initiation (subject to approval checks).
- [ ] Agree response/error mappings for retryable versus rejected events. Currently all integration exceptions become generic HTTP 409, and failed authentication or absent engine becomes 403.

## Recommended trust boundaries and operation permissions

| Operation | Permission | Recommended owner |
| --- | --- | --- |
| Resolve verified wallet identity | Read-only | AgroWallet client with scoped lookup access |
| Link/unlink wallet identity | Authorized write | Existing AgroWallet user flow |
| Submit evidence / approve action | Authorized write | Existing AgroCeans workflow |
| Read approved action | Read-only | Bridge validation client |
| Claim eligibility, if required | Authorized write | Existing reward authority |
| Find/verify existing STAMP | Read-only | STAMP client |
| Issue missing STAMP | Authorized write | Existing authorized STAMP issuer |
| Submit reward | Authorized financial write | Existing AgroCoin reward authority |
| Lookup reward/transaction/finality | Read-only remotely | Separate reconciliation client; updates local state |
| Receive Twitch participation | Local state write only | Verified restricted ingress; no reward-write credential |
| Display sanitized event snapshot | Public read-only | Overlay/SSE |

Recommended path: verified Twitch ingress publishes participation; viewers use existing AgroCeans reporting and AgroWallet linking flows; a trusted approval worker supplies action/user identifiers; the bridge reads verified identity and approval; the ecosystem reward authority atomically enforces eligibility, limits and uniqueness, obtains/reuses STAMP, and authorizes AgroCoin payment; a read-only chain observer updates transaction state; sanitized events reach the overlay. Agree STAMP/reward sequencing with owners before changing orchestration. Use an outbox and transactional reward ledger for durable delivery and recovery. Separate live/staging networks, service identities, data and idempotency namespaces. No direct browser-to-payment path, signing key or wallet session is required.

## Current implementation limitations to resolve before live activation

### Storage and durability

- One in-process queue only: no process lock or multi-writer protection, no database uniqueness constraints. Multiple processes can overwrite state and bypass local limits.
- Full synchronous JSON rewrite and fsync per stage; rewards and audit grow without retention/rotation. Network calls block the shared queue indefinitely without client deadlines, including Twitch processing.
- State is loaded without schema/version/integrity validation. Plaintext includes identity and wallet address. Filesystem modes do not encrypt data, repair existing directory permissions or defend against tampering.
- In-memory mutation precedes disk persistence; a failed save can leave memory ahead of disk. Restart/restore may lose deduplication, budget accounting and replay history. No transactional outbox couples persistence to SSE publication.
- Audit covers selected workflow stages only; authentication failures and failures before reservation are not logged. It is mutable, lacks operator/provider correlation and cannot prove a financial audit trail.
- Replay entries are pruned only on successful event ingestion. Public SSE has no event IDs/replay cursor, delivery acknowledgment, client cap or backpressure handling. Snapshot includes the last 50 insertion-ordered rewards, not necessarily recently updated rewards.

### Reward authorization and state

- Positive gates and zero-default limits are useful local controls, not evidence of approval by a real authority. No real clients or approval worker exist; ports are not fully checked at startup.
- Wallet, approval, STAMP and payout are separate calls without an atomic eligibility claim. Revocation, address changes and cross-system duplicate issuance must be enforced at the authoritative payout boundary.
- Local idempotency is SHA-256 of `agroceans-action:` plus action ID. No tenant/network/asset/policy namespace exists. Confirm globally unique action IDs and single-beneficiary/single-reward policy before adopting this key scheme.
- Duplicate reward calls return existing state without refreshing identity/approval, resuming issuance or reconciling. Reservations consume budget permanently, including failures; the global UTC-day limit has no participant/channel/mission limits and does not cap delayed settlements by settlement day.
- No implemented STAMP recovery path for `reserved` or `stamp_verified`; retries return the row and reconciliation rejects those states. There is no compensation/revocation policy for a STAMP followed by a failed payment.
- Response checks are shallow: address/network, STAMP proof/identity, transaction recipient/amount/asset/request binding and response size bounds depend on unimplemented clients.
- `publicRow()` labels all reservations as verified participation and approved even after revocation; reward eligibility does not itself prove a real Twitch event or mission participation. Snapshot restoration can expose these stale labels. Future display must distinguish identity verification, action approval, Twitch observation and approval freshness.

### Transaction reconciliation

- No scheduler, retry/backoff, alerting or stuck-state service exists. An operator must call reconciliation while both payment gates remain enabled.
- Read-only provider reconciliation is unnecessarily blocked when payments are disabled. Separate observe/reconcile permission from issue permission so a payment kill switch does not stop monitoring already-issued rewards.
- `requesting` survives ambiguity and is looked up without resubmission, but the port has no explicit unknown/not-found outcome or separate provider request ID. Agree safe recovery before mapping these cases.
- Confirmed and failed are terminal locally and never queried again. No chain-specific finality, reorg recovery, replacement transaction handling, legal transition table or monotonicity rules are implemented. Changing an existing transaction ID is rejected; nonterminal status/confirmation regressions otherwise pass validation.
- A single transaction per reward is assumed; batched outputs, partial payouts, fees and replacements are not modeled. Provider adapters cannot safely hide all such behavior without an agreed mapping.
- Health reports configured mode and gate values while connection booleans stay false; it does not establish provider reachability or reconciliation health.

## Required handoff and acceptance gate

Request a reviewed contract package from each owner containing: actual API specification, sanitized fixtures, authentication/scope metadata, staging access procedure, identity/network/unit mappings, idempotency and error semantics, authorization and revocation policy, STAMP proof validation, transaction lookup/finality rules and an operations contact. Do not attach real credentials.

Then agree an explicit mapping from each real response to the local ports and document required source changes. Validate in an authorized staging environment: account unlink/revocation, evidence rejection, revoked approval, global duplicate issuance, concurrent retries, STAMP timeout, payout timeout before ID assignment, provider not-found, disk failure/restart, budget exhaustion, transaction replacement/reorg and public-data redaction. Resolve storage and authorization gaps above, provide an authorized recovery runbook, and obtain separate explicit payment activation authorization.

No live integration is confirmed by this discovery report. No endpoints were guessed, payments enabled, production APIs called, services changed, commits created or deployment performed.
