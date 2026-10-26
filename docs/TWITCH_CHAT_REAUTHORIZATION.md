# Request the three missing Twitch chat permissions

Prepared configuration only; not applied to .env or PM2. No production token was
opened, refreshed or exchanged, and no consent attempt or subscription was
initiated. The local .env was parsed only to report booleans about scope/identity
configuration and the payment gate, without printing credential values.

## Findings

The local scope setting is empty. The local broadcaster setting does not match
the operator-verified broadcaster, the reader is unset or matches, and the local
payment flag is explicitly false. This file is not proof of the running PM2
process's loaded environment. Do not assume a local configuration edit changes
an already-running process.

src/server.js already passes TWITCH_OAUTH_SCOPES to createTwitchOAuth. The pairing
handoff places that space-delimited string in the official authorize URL through
URLSearchParams. No query override, new endpoint, default-permission change,
provider replacement or OAuth code change is needed. The required changes are
non-secret launch configuration only.

## Exact required configuration

Verified account: alejandrobarakat. Broadcaster and reader ID: 1592061028.
Use these exact values in the existing approved configuration mechanism after
separate authorization; replace the scope setting rather than append to it:

```dotenv
TWITCH_OAUTH_SCOPES="user:read:chat user:bot channel:bot"
TWITCH_BROADCASTER_ID=1592061028
TWITCH_CHAT_READER_ID=1592061028
AGRO_REAL_PAYMENTS_ENABLED=false
```

For the fresh authorization phase, retain/enable protected pairing and leave
EventSub activation and automatic refresh off:

```dotenv
TWITCH_OAUTH_PAIRING_ENABLED=true
TWITCH_OAUTH_BOOTSTRAP_ENABLED=false
TWITCH_EVENTS_ENABLED=false
TWITCH_TOKEN_REFRESH_ENABLED=false
```

Retain the existing client ID, client secret, operator token, registered callback,
HTTPS origin and private storage. Do not print, regenerate or copy them into this
file, a terminal command line, browser tooling or chat. Do not request chat:read,
chat:edit, user:write:chat or unrelated scopes. No force_verify implementation is
required to request newly missing permissions; the existing authorize request with
the new scope set is sufficient. Never handcraft/copy an authorize URL or state.

These three grants match the implemented broadcaster-as-reader webhook path:
user:read:chat and user:bot authorize the reader, and channel:bot authorizes the
broadcaster. The separate app token used for later EventSub registration cannot
grant missing user permissions. Refreshing the old token cannot add them either.

## Safe authorization sequence — no steps performed now

1. Review the above non-secret launch changes. Before using a new scope set,
   separately authorize their application and the owner-approved configuration
   reload for the isolated bridge. Do not start another process on port 8766,
   modify Nginx, or restart PM2 under the current task. The currently loaded flow
   will continue requesting its old scopes until the new configuration is loaded.
   Complete this reload before opening a fresh pairing; in-memory OAuth sessions
   do not survive restart.
2. Keep existing credentials and derived chat session intact. Do not delete,
   truncate, revoke or replace them in preparation for consent. Missing permissions
   are resolved through fresh consent, not by editing credentials.json. Avoid
   running refresh/registration commands concurrently with reauthorization.
3. In a trusted browser, sign into **alejandrobarakat**, then open the stable page:
   https://twitch.theagrostore.com/auth/twitch/connect . Create a new pairing request.
   The account choice matters: OAuth itself does not pin the Twitch login; the
   subsequent preflight enforces the expected numeric identity.
4. From the same unprivileged VPS account/checkout as the bridge, in a private
   interactive terminal, run:

   ```sh
   cd /home/domenzainro/agroceans-twitch-hackathon
   node scripts/oauth-pairing.js approve
   ```

   Enter only the request ID from your own browser, compare the phrase and type
   the matching phrase. Continue in that same browser. The existing 200 CSP
   handoff starts the top-level Twitch navigation without a form redirect chain.
   Confirm the intended app/account and requested chat access, then authorize.
   Do not export HARs, cookie/header dumps, callback URLs or token responses.
5. The callback checks the existing state/browser binding and consumes state before
   exchanging the new code once. The existing credential file is replaced atomically
   only after the successful token exchange and token-schema validation. Pairing,
   approval, denial, state mismatch, failed exchange and malformed/missing scope
   responses do not overwrite it. Do not paste or retry a callback/code manually.
6. After the browser confirms secure save, run the read-only EventSub preflight
   with the verified expected identity and payment gate supplied explicitly:

   ```sh
   TWITCH_BROADCASTER_ID=1592061028 TWITCH_CHAT_READER_ID=1592061028 AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env scripts/twitch-eventsub.js preflight
   ```

   This uses the saved token only server-side for validation. Require valid
   credentials, no missing permissions and the expected client/user binding.
   Preflight does not refresh, write OAuth credentials, mint an app token or create
   a subscription. identity_mismatch or missing_permissions means stop and review
   account/grants; do not bypass validation. No subscription is expected to be
   connected yet. A changed original credential revision causes the token loader
   to ignore any prior derived refresh session automatically; do not delete state.
7. Keep EventSub disabled and payments false. Subscription registration and runtime
   activation remain separate authorized work described in TWITCH_CHAT_ACTIVATION.md.
   Successful reauthorization alone neither subscribes to chat nor enables payments.

## Validation

A new mocked regression exercises the complete protected pairing with exactly the
three requested scopes, existing entry/handoff CSP, missing browser cookie, denial,
failed exchange and missing-scope response. It proves existing temporary credential
bytes remain unchanged until success, then validates the resulting token against
1592061028 and rejects another identity without modifying credentials. All tokens,
provider responses and credential files in this test are fixtures in private
repository-local temporary directories.

References: [Twitch authorization-code flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow)
and [channel.chat.message permissions](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage).

Local verification: npm run check passed; npm test passed all 92 tests;
git diff --check passed. No live authorization or production activation was run.
