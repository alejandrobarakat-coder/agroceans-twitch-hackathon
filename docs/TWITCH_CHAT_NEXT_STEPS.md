# Twitch chat demonstration: implementation assessment

The assessment below is preserved as the implementation plan. The approved
local implementation is now complete; see [behavior, tests and gated activation](TWITCH_CHAT_ACTIVATION.md).
Existing OAuth completion is reported by the operator. Saved
credentials and private environment values were not opened or changed. No PM2
command, subscription registration, OAuth attempt, token refresh or deployment
was performed. Only this proposal document was added by this assessment.

## Observed health and what it means

A read-only public GET /health returned 200 with realPaymentsEnabled=false,
twitchConnected=false and twitchIngressConfigured=false. These values do not
contradict successful OAuth: src/server.js hard-codes twitchConnected=false.
IngressConfigured is Boolean(twitchWebhook), set only when TWITCH_EVENTS_ENABLED
constructs the configured receiver and cleared on revocation. It does not prove
an active subscription, granted permissions or recent delivery. PM2 process 35
being online is operator-supplied information, not independently verified here.

## What exists and what is missing

| Component | Existing implementation | Remaining work |
| --- | --- | --- |
| OAuth | Browser pairing, CLI approval, state/browser binding, server-only token exchange and private persistence | No credential loader for ongoing Twitch use, startup/hourly validation, refresh or identity/scope preflight |
| Chat ingress | POST /twitch/eventsub; raw-body HMAC, freshness, broadcaster/type/version/subscription-ID checks; challenge and revocation responses | No subscription create/list/delete client, app-token manager, pending-subscription handshake, full reader/transport binding or enabled lifecycle tracking |
| Participation | Durable message-ID replay state; RewardEngine.twitch publishes a sanitized twitch_participation event without calling reward() | Safe command recognition, ingress-level duplicate acknowledgement under concurrency, standalone live-chat metrics |
| Overlay | /events SSE and public/overlay.html display verified Twitch participation with no payout | Participant counters are only changed by the simulated /demo/ocean route; add separate live command counters/status instead of treating chat as environmental verification |
| Ecosystem | Adapter interfaces and separate read-only observations exist | OAuth/chat do not establish AgroWallet ownership, an approved environmental action or reward eligibility; authoritative production write contracts remain outside this demo |

The verifier currently discards message text, event.message_id and the subscribed
reader ID. Thus every accepted chat message becomes generic participation; it
cannot currently distinguish !ocean from ordinary conversation. Raw chat text and
display names are not broadcast, which should remain the default.

## Minimal demonstration and transport decision

Demo objective: an allowed-channel viewer sends !ocean; the hackathon overlay
shows a genuine Twitch participation event and a separate live command count.
Label it "Twitch participation; no payout". It is not evidence of environmental
action, STAMP issuance, wallet ownership or an earned 0.1 AGRO reward.

Use **EventSub channel.chat.message v1 over the existing webhook transport**.
Chat is the event content; EventSub is its delivery mechanism. A separate IRC
reader, outbound chat bot replies, follows/subscriptions and multiple transports
are unnecessary for this demonstration. Reusing the existing webhook path is the
smallest change relative to this checkout.

Important authorization distinction: webhook subscriptions require an **app access
token**, not the saved user OAuth token. For channel.chat.message, the reader must
grant user:read:chat and user:bot when an app token is used, plus channel:bot from
the broadcaster or the reader's moderator status. Subscription condition must
include both broadcaster_user_id and user_id (the authorized reader). Do not ask
viewers to authorize the app and do not request user:write:chat for a receive-only
demo. Obtain any missing permissions only through separately authorized consent;
never assume the successfully saved token has these grants. Existing defaults
request no scopes. No actual saved scopes were inspected in this assessment.

WebSockets are an alternative if avoiding a public callback and extra app-token
chat permissions is the priority: they use the user token and user:read:chat.
They require a new WebSocket receiver, welcome/session subscription handshake,
keepalive/reconnect handling and new lifecycle tests. They are not required in
addition to webhooks and are not the recommended first implementation here.

## Smallest safe implementation sequence (not executed)

1. Add a private token manager/preflight in new Twitch-only modules: securely load
   existing credentials, verify owner/modes and reject symlinks, validate token and
   client/account binding, check required scopes and the intended channel/reader,
   and report only booleans/sanitized status. Validate on startup and hourly.
   Do not overwrite the saved authorization on missing permissions or validation
   failure. Any user-token refresh must later be explicitly enabled, serialized,
   and atomically persist rotated credentials; do not refresh during this review.
   Keep webhook app tokens separate from the saved user credentials.
2. Add an explicitly invoked local operator subscription command using the same
   app registration. Never expose token operations or subscription creation as a
   public unauthenticated route. No automatic subscription creation on startup.
   List/reconcile existing intended subscriptions before creating; accept 202 as
   verification-pending, not proof of connection. Use safe bounded API clients,
   timeouts, sanitized errors and a private per-subscription webhook secret.
3. Fix the initial challenge bootstrap: the current constructor requires a
   configured subscription ID before registration, but Twitch allocates it on
   creation and can challenge before the creation response is processed. Persist
   a short-lived pending intent **before** the create request, binding secret,
   exact type/version, broadcaster, reader and callback/transport. Verify the
   challenge HMAC and complete condition against that intent, pin the assigned
   ID, and reconcile it with the API response. Keep the strict active-ID allowlist
   for notifications. Do not simply accept arbitrary signed subscription IDs.
   Handle pending timeout, unexpected IDs, revocation and process recovery.
4. Extend only the Twitch verifier/adapter and server ingress: verify the full
   condition including reader ID, accept the intended transport, and reduce a
   bounded message.text to an exact allowlisted command such as !ocean. Reject
   unintended shared-chat source channels for this single-channel demo. Discard
   text/names before persistence or broadcast. Deduplicate EventSub deliveries
   and logical chat message IDs, serialize notification acknowledgement so racing
   retries receive success without a second event, and retain existing freshness
   and HMAC checks. Route participation to the existing twitch() path; never call
   reward() or any wallet/STAMP adapter. Do not modify src/integration.js or the
   production 0.1 AGRO policy.
5. Add truthful Twitch status and separate live metrics in src/server.js and the
   prototype overlay: credential validation, receiver configured, subscription
   pending/enabled/revoked/unknown, last verified event time and command count.
   Reconcile enabled state with Twitch after restart; absence of recent chat alone
   is not proof of a disconnected webhook. Keep private identifiers out of public
   health. Preserve existing health field compatibility and clearly define any
   newly implemented connection boolean.
6. Before later activation, verify existing HTTPS routing to /twitch/eventsub on
   port 443 without redirects or body transformations, plus /events SSE buffering
   behavior. No new Nginx route was inspected/assumed to work in this assessment.
   Keep AGRO_REAL_PAYMENTS_ENABLED=false, no ecosystem module activation, and fail
   chat activation if live payments are enabled. All service/environment changes
   and Twitch subscription writes require separate authorization.

## Test plan

- Token manager with fake providers/private temporary storage: no mutation during
  preflight, unchanged existing credentials on missing scopes, wrong client/user,
  expiry, 401/revocation, timeout, malformed responses, hourly scheduling, refresh
  serialization and safe atomic rotation only when explicitly enabled. No secret
  fields in logs, health, SSE, errors or URLs.
- Subscription lifecycle with fake Twitch: pending intent committed before create;
  challenge before API response; wrong reader/channel/type/version/transport/ID,
  bad HMAC, old/future timestamps, oversized/malformed bodies, timeout, conflict,
  revocation, restart reconciliation and no unintended subscriptions/deletions.
- HTTP ingress-to-SSE integration: one valid !ocean yields one sanitized event and
  live count; normal chat and other commands do not; duplicate deliveries and
  concurrent retries return success with one update; logical message duplicates,
  shared-chat leakage and XSS-shaped text are rejected or discarded. Simulations
  stay separately labeled. Retain reasonable webhook acknowledgement latency.
- Safety: inject tripwire wallet/STAMP/reward/payment clients and assert zero calls
  for challenge, notification, retry, revocation and command paths. Assert payment
  flag false and no reward state changes. Leave production reward logic untouched.
- Overlay/health: pending/enabled/revoked/restart states, safe SSE reconnect,
  separate simulation/live counters, correct no-payout labels and no credential
  disclosure. Existing tests cover crypto/replay primitives, not complete HTTP
  subscription lifecycle or a live Twitch-to-overlay demonstration.
- Later, separately authorized acceptance: one controlled channel, one subscription,
  signed challenge then enabled status, one real !ocean and one live overlay update;
  verify payments remain disabled. No such live test was run now.

Baseline validation for this assessment: npm run check, npm test (66 passed), and
 git diff --check passed. Tests use fake OAuth/Twitch responses. This establishes
local behavior, not production subscription activation.

## Official references

- [Chat authorization and transport setup](https://dev.twitch.tv/docs/chat/authenticating/)
- [channel.chat.message permissions and schema](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage)
- [Webhook/app versus WebSocket/user subscription tokens](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/)
- [Required startup and hourly validation](https://dev.twitch.tv/docs/authentication/validate-tokens/)
