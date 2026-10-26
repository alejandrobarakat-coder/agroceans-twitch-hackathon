# Local EventSub chat implementation and gated activation

Implemented locally and disabled until TWITCH_EVENTS_ENABLED=true. No production
credential file was opened by this implementation session, no live token request
or subscription registration was made, and no PM2/Nginx/environment/deployment
operation was executed. Existing OAuth routes and original saved credentials are
unchanged. All network activity in the new tests uses fake Twitch endpoints or
an ephemeral loopback webhook/SSE server.

## Implemented behavior

The new Twitch-only client loads the existing private
var/twitch-oauth/credentials.json, validates client ID, broadcaster identity,
permissions and expiry, and revalidates once a minute while enabled (stricter than
Twitch's startup/hourly requirement). For this minimal single-channel version,
the authorized reader must be the broadcaster. TWITCH_CHAT_READER_ID defaults to
TWITCH_BROADCASTER_ID; a different reader is rejected instead of assuming moderator
rights. The required user grants for this webhook/app-token path are:

- user:read:chat
- user:bot
- channel:bot

No user:write:chat grant, viewer authorization, IRC connection or chat-reply bot is
needed. Missing grants are reported by name, without account IDs or credentials.
This implementation deliberately requires channel:bot rather than implementing
the alternative moderator-role authorization path. Existing successful OAuth
alone, especially with empty requested scopes, is not evidence of these grants.

Refresh only occurs after a 401 and when explicitly enabled using
TWITCH_TOKEN_REFRESH_ENABLED=true, or by the separately confirmed CLI refresh
command. A private cross-process lock serializes validation/refresh. Rotated user
tokens are stored atomically in var/twitch-chat/user-session.json, associated with
a private hash of the original OAuth credential revision. The original OAuth
credential file and client secret are never overwritten. If a later approved
OAuth connection replaces the original file, the old derived session is ignored.

A durable refresh intent is written before the refresh POST. An ambiguous or
rejected refresh is not blindly retried: refresh_requires_review blocks another
refresh for that source revision. Replacement tokens are persisted before their
validation request, so a validation outage does not lose the rotated refresh
token. Invalid identity/scope results never authorize chat. Treat the derived
session as the current credential authority after rotation; do not copy the old
original token back over it. All token files are private credentials.

The operator CLI creates/list-reconciles/removes only this integration's managed
channel.chat.message v1 webhook subscription. It obtains a separate app access
token in memory; it never substitutes the user token for webhook registration.
Creation, removal and explicit refresh require a TTY and typed confirmation.
There is no public HTTP subscription-management endpoint or automatic registration
on startup. A subscription creation timeout/conflict is retained as a pending
intent for review, not automatically retried. Unmanaged matching subscriptions
are not adopted or deleted.

The private pending registration is committed before the create request. It binds
a generated per-subscription secret, five-minute deadline, channel, reader,
callback, type and version. A signed challenge can pin Twitch's assigned ID before
the API response, which must confirm that same ID. Both confirmations are required
for notifications. Full callback/transport/reader/broadcaster identity, raw-body
HMAC, constant-time signature comparison and five-minute timestamp freshness are
enforced. Revocation is durable and cannot be undone by a delayed list response.

Only trimmed, case-insensitive exact !ocean is a participation command. Other text
is discarded; foreign shared-chat source channels are rejected. The dedicated
Twitch state store persists counters, hashed participant/message IDs and delivery
replay records in one atomic transaction before SSE publication/acknowledgement.
It has no financial adapter dependencies and never calls reward(), STAMP or any
blockchain endpoint. This replaces the old webhook route's use of RewardEngine
with an isolated participation store; src/integration.js remains unchanged.
The legacy signature verifier remains unchanged for existing callers/tests.

Live command totals and unique participant totals survive restart. A repeated
logical chat message, even under a different delivery ID, does not count twice.
New SSE clients recover committed counters through the existing /events snapshot.
Simulation counters remain separate; chat is labeled participation with no payout,
not proof of environmental action or eligibility for the existing 0.1 AGRO reward.

## Health and failure handling

/health retains realPaymentsEnabled and adds truthful Twitch fields:

- twitchIngressConfigured: local receiver configured, not proof of connectivity.
- twitchConnected: credentials currently validated and the managed subscription
  observed enabled within the last two minutes. A fresh signed enabled notification
  or authenticated subscription reconciliation provides that observation.
- twitchSubscriptionStatus: disabled, unregistered, pending, enabled, unknown,
  missing, revoked, registration_expired or storage_unavailable.
- twitchCredentials, twitchMissingPermissions, twitchError and last verified event
  time: sanitized operational status; no IDs, tokens, scopes beyond required names,
  callbacks containing query data or private environment values.

On restart, persisted counts are available immediately but connectivity is unknown
until revalidated/reconciled. Every minute the process validates/reconciles again.
Transient API failures make connectivity false/unknown and are retried on the next
maintenance tick; subscription creation and ambiguous token refresh are not
retried. Malformed/unauthentic webhooks receive 403. Storage contention, capacity
limits or unavailable credential validation receive 503, allowing delivery retries.

Private directories are 0700, files 0600, owned by the bridge account; symlinks,
hard-linked files and unsafe modes are rejected. The immediate storage parent
must not be group/world writable. Use a trusted local filesystem and exactly one
bridge/SSE process. CLI and bridge share the same directory/account. Cross-process
locks fail closed on crashes; they are not automatically stolen by age.

Limits: 16 KiB webhook bodies, 256 KiB API responses, 100 subscription-list pages,
5,000 recent delivery IDs (10-minute retention), 50,000 counted logical message IDs
and 10,000 participant hashes. Counted logical IDs/participants are retained for
this demo's lifetime and are not silently evicted/reset. Capacity exhaustion fails
closed. Larger/long-running deployments need a reviewed database migration.

Recovery from a crash-left lock requires separately authorized maintenance: stop
all bridge/CLI operations, prove none remain active, remove only the empty relevant
.state-lock/.tokens-lock/.registration-lock directory with rmdir, and reconcile.
Do not remove live locks, delete chat-state.json to bypass replay protection, or
clear a refresh intent simply to retry an uncertain exchange. An uncertain refresh
requires operator/provider review or separately approved fresh OAuth consent.

## Exact activation sequence — only after separate authorization

These commands are instructions, not actions taken during implementation.

1. Review the release and run checks as the existing bridge account in the isolated
   repository. Preserve the existing OAuth credential directory and derived state.

   ```sh
   cd /home/domenzainro/agroceans-twitch-hackathon
   npm run check
   npm test
   git diff --check
   ```

2. Through the approved secure environment mechanism, make the existing client ID
   and secret and the intended broadcaster numeric ID available to both PM2 bridge
   process 35 and the CLI. Keep AGRO_REAL_PAYMENTS_ENABLED=false. Do not print or
   put values into shell command arguments/history; do not dump PM2 environment.
   The commands below assume those prerequisites are supplied through the existing
   trusted environment/.env loading, without editing .env as part of this change.
   Secure only this repository's storage if necessary, after authorization:

   ```sh
   chmod 700 var
   install -d -m 700 var/twitch-chat
   AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js preflight
   ```

   Preflight only validates the user token and reports sanitized health. It never
   refreshes or creates a subscription. Stop on missing_permissions or an identity
   mismatch. Any additional Twitch consent must be separately authorized using
   the existing protected OAuth flow. Do not replace a working authorization just
   to bypass a failed preflight. If expired, separately approve the interactive
   refresh operation (which makes a token request and persists rotation):

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js refresh
   ```

3. Independently verify the existing proxy forwards POST
   https://twitch.theagrostore.com/twitch/eventsub on HTTPS port 443 without redirect,
   body transformations or sensitive request/response logging; confirm /events
   forwards SSE without buffering. The OAuth callback URI is separate and unchanged.
   Do not create a subscription until the receiver is reachable. Missing routing
   requires its own authorized proxy task; no Nginx edits are supplied here.

4. After explicit release/restart authorization, install the reviewed application
   files using the existing owner-approved release procedure, verify that PM2 ID
   35 is still the isolated bridge (never restart all processes), and launch it with
   the existing OAuth settings preserved plus these non-secret overrides:

   ```sh
   TWITCH_EVENTS_ENABLED=true TWITCH_TOKEN_REFRESH_ENABLED=true AGRO_REAL_PAYMENTS_ENABLED=false pm2 restart 35 --update-env
   ```

   This step is NOT authorized or executed now. The bridge refuses chat activation
   unless the payment flag is exactly false. Startup does not create subscriptions.
   Verify /health reports payments false and ingress configured; subscription may
   be unregistered until the next step. Automatic refresh is enabled by this
   future command; omit that flag/set false if automatic refresh is not approved.

5. From a private interactive terminal as the same account, explicitly authorize
   creation of one managed subscription. Type REGISTER at its confirmation prompt:

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js register
   AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js reconcile
   ```

   A 202/pending state is not connectivity. Wait for the signed challenge and
   authenticated enabled reconciliation. The running bridge will also reconcile
   within a minute. On timeout/ambiguous registration, do not run registration
   repeatedly. Reconcile the pending record first. The confirmed managed ID can be
   removed only by the separately approved remove command; unknown/unmanaged IDs
   require review rather than broad deletion.

6. Run the separately approved live acceptance test: open /overlay, send !ocean in
   the intended chat, require one live counter/event update, send ordinary chat and
   require no command increment, reconnect the overlay and check the snapshot.
   Require /health payments false throughout. Do not run any payout or STAMP test.
   Never export tokens, request headers/bodies, raw provider responses or HARs.

7. For separately authorized cleanup, type REMOVE when prompted:

   ```sh
   AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js remove
   ```

   This deletes only the verified managed subscription, retains counters/replay
   data and leaves OAuth credentials untouched. If disabling runtime ingestion,
   use a separately authorized process-35 operation setting TWITCH_EVENTS_ENABLED
   and TWITCH_TOKEN_REFRESH_ENABLED false while keeping payments false; disabling
   the listener alone does not delete a remote subscription.

## Validation

npm run check, npm test (91 tests) and git diff --check passed locally. New tests
cover mocked registration and challenges before/after API responses, signatures,
identity/transport/freshness checks, wrong/unknown subscription IDs, revocation,
logical/concurrent/cross-process duplicates, restart counters, token validation,
refresh rotation/ambiguity, transient failures, unsafe storage, private CLI
confirmation, payment isolation, real loopback webhook-to-SSE flow and overlay
script behavior. No browser/live Twitch acceptance or production activation is
claimed.

Official references: [chat authorization](https://dev.twitch.tv/docs/chat/authenticating/),
[EventSub registration](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/),
[webhook verification](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/),
[token refresh](https://dev.twitch.tv/docs/authentication/refresh-tokens/).
