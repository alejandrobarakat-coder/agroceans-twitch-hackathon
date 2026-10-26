# Browser authorization investigation and proposal

Status: the proposal below has now been implemented locally; see
[usage, security and gated deployment steps](OAUTH_PAIRING.md). No deployment
was performed. Existing OAuth/bootstrap working-tree changes predate this investigation. No environment or service settings were read
or changed, and no live capability or OAuth request was submitted.

## What the current error establishes

`Invalid, expired or already used bootstrap link` is the bootstrap POST's 400
response. The exact-Origin gate has already passed; its failure is a different
403 response. The 400 covers duplicate/extra/missing form fields and a capability
store returning false. The store rejects malformed, absent, expired, previously
claimed, revoked or unsafe records. Storage exceptions instead return a sanitized
500. These distinctions come from the local source, not a browser capture.

A successful bootstrap POST consumes the file before returning 303. If the VPS
test submitted the same capability subsequently opened in Chrome, Chrome's 400
is expected. A landing GET alone does not consume it. Even when the response is
lost or navigation is blocked, consumption has already happened. Retrying the
POST or double-clicking Continue can therefore produce the reported error. The
current button is not disabled on submit.

The landing script removes the fragment immediately. Reloading the cleaned URL
loses the capability and leaves Continue disabled. The initial format check does
not verify that a capability is still present or unexpired on the server. A CLI
using a different checkout/storage directory from the running service also mints
records the service cannot find. Expiration is two minutes from minting, not page
load. None of these possibilities proves which occurred in the reported browser.

A VPS 303 also does not prove browser completion: the Secure OAuth cookie belongs
to that HTTP client, while pending OAuth state belongs to the handling process.
Copying the Twitch redirect URL to another browser loses cookie binding. A
restart or routing a callback to another process loses pending state. Those
conditions produce the callback's separate state/session error, not this 400.

For any later authorized browser acceptance test, use a newly minted capability
only in the intended browser. Record only response statuses and whether requests
were repeated, never bodies, cookies, links, state, authorization codes or HARs.
Confirm that CLI and service use the same checkout/account and storage location
without opening credential files. Do not test a real capability with curl first.

## Recommended replacement: browser-first, CLI-approved pairing

Keep the server-side Twitch authorization-code grant. Replace capability-link
transport with a stable HTTPS Connect page and explicit local operator approval:

1. A GET renders a private, no-store page and creates a short-lived preauthorization
   session using a random Secure, HttpOnly, host-only cookie and a synchronizer
   CSRF token. GET does not authorize Twitch or replace credentials.
2. An explicit same-origin POST, requiring that cookie, CSRF token and the exact
   configured Origin, creates one pending pairing request. Show a random request
   identifier and a separate comparison phrase, expiry and status. These values
   cannot themselves approve or start OAuth. Do not place secrets in URLs.
3. In a trusted VPS terminal, the operator supplies that request identifier to a
   new local CLI. It displays the request's comparison phrase and asks for explicit
   approval after the operator compares it with their own browser page. Never
   approve an unsolicited identifier received from another person. The CLI uses
   local private storage, not an operator bearer token pasted into the browser.
4. The browser checks approval through a cookie-bound, no-store status endpoint
   which exposes only its own request. Polling never consumes approval or returns
   a Twitch URL, state or credentials. Stop polling at expiry and bound its rate.
5. Once approved, an explicit Continue POST validates Origin, CSRF, cookie binding,
   expiry and approval, then atomically consumes that approval and invokes the
   existing OAuth begin function in the same browser response. It sets the existing
   OAuth cookie and returns 303 to Twitch. Disable Continue immediately on submit;
   concurrent submissions must have one winner. A failed/lost start requires a
   fresh pairing; never make approval replayable to improve retry behavior.
6. Keep the callback's random state plus browser-cookie comparison, ten-minute
   expiry, consumption before token exchange, fixed redirect URI and server-only
   credential storage. Clear the preauthorization session after use or expiry.

This removes the two-minute bearer URL, fragment/history dependence and browser
header-extension setup. Approval is bound to a browser session before OAuth starts;
an identifier leaked from the page cannot redeem approval in another browser.
It adds a small approval state machine and requires careful expiry, cleanup and
concurrency handling. It still depends on a trusted browser, terminal and origin;
comparison is necessary to resist approving an attacker's pairing request.

Use random high-entropy identifiers and bindings, store only hashes of bindings
in private files, and enforce owner/permission checks and atomic transitions.
Keep bounded pending requests, creation/polling limits, short expirations and CLI
revocation. Reject duplicate parameters. Preserve CSP, frame blocking, no-store,
strict Origin checks and no body/secret logging. Never turn a public Connect button
into permission to replace the globally connected Twitch account.

Retain the single-process requirement for in-memory OAuth state. If multi-process
support is later needed, use a reviewed shared store with atomic callback
consumption; filesystem approval alone does not solve OAuth-state routing.

## Validation before any deployment

The existing `npm run check` and `npm test` pass locally (four test files). Existing
tests cover atomic claims, expiry/revocation, Origin gates, 303/cookie handoff,
cookie mismatch, state replay and private credential persistence. They use fake
Twitch responses and do not reproduce Chrome navigation. No real-browser or live
VPS acceptance result is claimed.

Before implementing/releasing the proposal, test unapproved/expired/revoked pairing,
wrong-browser redemption, forged/missing CSRF, wrong Origin, duplicate parameters,
concurrent approval/start, polling without consumption, bounded storage, and
unchanged callback replay protection. Then verify native Chrome navigation,
refresh/back/double-click behavior and the complete callback using an authorized
isolated release. OAuth must leave payments, rewards and EventSub disabled.

References: [Twitch authorization-code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow)
and [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
