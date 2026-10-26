# Browser-first Twitch authorization

Implemented locally; not deployed. Pairing is disabled by default. It does not
activate EventSub, chat, STAMP issuance, rewards or payments. The legacy bootstrap
is separate and should remain disabled when using pairing.

## Operator workflow

Open the stable URL in a trusted browser:

`https://twitch.theagrostore.com/auth/twitch/connect`

Click **Create pairing request**. In a private interactive VPS terminal, using the
same Unix account and checkout as the bridge, run:

```sh
node scripts/oauth-pairing.js approve
```

At the prompt, enter the request ID shown in **your own browser**. Compare the
24-character phrase displayed by the CLI with the browser's phrase, then type the
complete matching phrase at the CLI prompt to approve. Do not approve a request
sent by someone else. No secret or identifier goes in shell arguments or URLs.
The browser checks status every three seconds while waiting. Click **Continue to
Twitch** after approval and complete Twitch consent in that same browser.

The request expires five minutes after the browser session was created, including
time spent before clicking Create. Refresh preserves an active request. Returning
from browser history reloads the page. A lost Continue response, process restart,
expired session or interrupted flow requires a fresh pairing. Approval cannot be
reused. A consumed request's credentials cannot be undone by revocation.

Revoke outstanding pending and approved requests using:

```sh
node scripts/oauth-pairing.js revoke-all
```

The CLI requires an interactive terminal for both commands and never accesses
`.env`, OAuth credentials or the network. Request IDs and comparison phrases are
not bearer credentials; still keep terminals and browser tooling private. Do not
record request/response bodies, cookies, OAuth callback queries or HAR files.

## Security and operational limits

The page creates a random, five-minute `__Host-twitch-pairing` Secure, HttpOnly,
SameSite=Lax cookie and a synchronizer CSRF token. Only hashes of browser bindings
are persisted. All browser POSTs require the exact configured HTTPS Origin, valid
CSRF, the original cookie, an unexpired server-side session, and a bounded form.
Fetch Metadata rejects cross-origin/sibling-origin access when present. The status
endpoint is also a protected POST: it accepts no supplied request ID and never
consumes approval. There is no HTTP approval endpoint. Extra or duplicate fields
and query parameters are rejected. CSP blocks embedding and external resources;
responses are no-store. Native-form pages use same-origin referrer policy to retain
a non-null Origin; POST/redirect responses use no-referrer.

Approval requires local filesystem ownership and explicit phrase confirmation.
Pairing records are owner-only, files `0600`, directory `0700`. The immediate
parent must be owned by the same account and not group/world-writable. The
checkout and its ancestor directories must also be trusted. Symlink records,
hard-linked records, unsafe modes, malformed records and unsafe directories fail
closed. Private filesystem ownership is the CLI authorization boundary: another
process running as that same Unix account is trusted and can modify approvals.
Use a local filesystem with reliable atomic mkdir/rename operations, not NFS.

A cross-process directory lock serializes read/approve/revoke/consume operations.
The operator prompt is outside the lock; approval rechecks phrase, expiry and
pending status after confirmation. Consuming approved state deletes it before
OAuth starts. Concurrent starts have one winner; busy storage fails closed with a
sanitized response. An interrupted process can leave `.lock`; no automatic stale
lock stealing is attempted. For recovery, the owner must first stop all bridge
and pairing CLI processes through an authorized maintenance operation, verify no
operation can still be running, then remove only the empty
`var/oauth-pairing/.lock` using `rmdir`, revoke outstanding requests and restart
through the approved procedure. Never remove an active lock.

Limits: 100 browser sessions/process, 100 active disk requests, 300 accepted-method
requests/minute/process, status checks at most once per two seconds/session, and
256-byte form bodies. Expired sessions are removed on requests; expired files and
interrupted temporary writes are cleaned during creation, or by CLI revocation.
A public attacker can exhaust these limits temporarily; they are bounds, not a
substitute for edge abuse controls. Synchronous filesystem transactions are small
but block the event loop; this is an isolated, low-volume prototype.

OAuth still uses independent random state and an independent browser-bound cookie,
ten-minute expiry and consume-before-exchange replay protection. Tokens are only
exchanged/stored server-side using the existing private atomic storage. Exactly
one bridge process is required because browser sessions and OAuth state are in
memory. Restart loses those sessions; persisted approval cannot bypass that loss.
OAuth success replaces the previously connected Twitch credentials, so approval
must be restricted to the intended account operator. Refresh and periodic Twitch
token validation remain prerequisites for ongoing API use.

## Deployment steps — only after explicit authorization

No deployment, PM2 restart, proxy change or environment edit was performed.
Do not run the activation commands until separately authorized.

1. Review the application changes and tests. Select the approved release checkout
   and the existing unprivileged bridge account. Use Node.js 22+. Run there:

   ```sh
   cd /home/domenzainro/agroceans-twitch-hackathon
   npm run check
   npm test
   git diff --check
   ```

2. Independently verify that the existing HTTPS proxy forwards **GET and POST** for
   `/auth/twitch/connect` to this bridge without redirects, header rewriting,
   caching, or body logging. Verify callback query logging is suppressed and no
   proxy/APM/WAF records cookies or response bodies. This is a new route; prior
   exact bootstrap locations do not prove it is forwarded. If absent, stop this
   deployment until the owner separately reviews and authorizes routing work.
   This implementation supplies no Nginx edits or reload commands.

3. Confirm existing Twitch client credentials are loaded through the approved
   secure mechanism, scopes are reviewed, and the registered callback is exactly
   `https://twitch.theagrostore.com/auth/twitch/callback`. Do not print or retrieve
   credentials. Do not change `.env`. Confirm the approved launch will have a
   single process and will override EventSub and payment enablement to false.

4. As that account, after permission to update **this prototype's** private storage,
   secure the parent and pairing directory. The local checkout currently has a
   group-writable `var/`; pairing refuses it until corrected. These commands change
   permissions only inside this repository and must not target shared storage:

   ```sh
   chmod 700 var
   install -d -m 700 var/oauth-pairing
   node scripts/oauth-pairing.js revoke-all
   ```

5. Use the approved service owner's release/restart procedure with these exact
   non-secret environment overrides:

   ```text
   TWITCH_OAUTH_PAIRING_ENABLED=true
   TWITCH_OAUTH_BOOTSTRAP_ENABLED=false
   TWITCH_EVENTS_ENABLED=false
   AGRO_REAL_PAYMENTS_ENABLED=false
   ```

   Do not guess a PM2 process name or restart all processes. The repository has no
   PM2 ecosystem file or verified process identifier; the owner must identify the
   isolated bridge and authorize its restart before that managed step is executable.
   Existing loaded secrets must be retained through the approved mechanism.

   Alternatively, **only when port 8766 is free**, the existing reviewed HTTPS
   proxy targets it, and foreground activation is explicitly authorized, run:

   ```sh
   TWITCH_OAUTH_PAIRING_ENABLED=true TWITCH_OAUTH_BOOTSTRAP_ENABLED=false TWITCH_EVENTS_ENABLED=false AGRO_REAL_PAYMENTS_ENABLED=false node --env-file=.env src/server.js
   ```

   Do not run this alongside an existing bridge or work around a busy port.

6. Check `/health` without credentials. Require `realPaymentsEnabled: false`,
   `twitchIngressConfigured: false`, and `twitchConnected: false` (OAuth alone does
   not connect chat). Open the stable URL in Chrome, create one request, approve
   from the CLI, continue once, and complete consent. Verify the cookie handoff,
   same-origin 200 handoff followed by a top-level Twitch GET, refresh/back
   behavior and replay rejection without
   exporting bodies, cookies, callback URLs or HAR files. Never copy a redirect
   from curl into the browser. Real-browser/HTTPS acceptance has not yet been run.

7. Revoke remaining pairings after testing. To disable new pairing, use the approved
   service operation with `TWITCH_OAUTH_PAIRING_ENABLED=false`, leaving legacy
   bootstrap/EventSub/payments false. In foreground mode, stop with Ctrl-C and
   restart only as authorized with the pairing flag false. Revocation leaves OAuth
   credentials and any already started OAuth flow untouched.

Automated validation includes store ownership/modes, limits, expiry, revocation,
strict Origin/CSRF, wrong-browser access, duplicate input, status without consumption,
CLI cancellation/confirmation/expiry, concurrent starts across processes, generated
page behavior, OAuth cookie/state replay and server-only credential handoff. Tests
use private temporary directories and fake Twitch responses, never live credentials.

## Investigation: CLI approved but Continue stays disabled

Confirmed local defect: the original generated page threw on every non-2xx status
response, then returned from its catch block before scheduling the next poll.
A network/JSON error followed the same path. Approval could succeed later in the
private store while that browser never checked status again. Approval does not
push to the browser: only a successful status poll enables Continue. These handled
HTTP failures do not require an uncaught exception or a PM2 error-log entry, and
`/health` does not test the polling loop.

Reproduced before editing the implementation with the generated script and real
local session/store handlers: an immediate reload after a successful poll returns
429 because `lastPoll` survives reload and enforces a two-second interval; a busy
store lock returns 503. Both cases, plus a simulated network failure, scheduled
zero retries and left Continue disabled. The previous generated-page test covered
only an immediately successful approved response, so it missed this failure path.

The minimal local fix retries network/JSON errors, 429 and 5xx until the original
session deadline, honors numeric Retry-After within bounded delays, and leaves the
button disabled until an approved response arrives. Other non-2xx responses remain
terminal. CSRF, exact Origin, cookies, store approval transitions, one-time
consumption and OAuth state checks were not changed. Regression tests verify
recovery after later CLI approval, no consumption during polling, Retry-After,
and stopping on authorization failure or expiry.

Read-only live HTTPS probes observed GET `/auth/twitch/connect` returning 200 with
the expected script, no-store, same-origin Referrer-Policy and one CSP permitting
same-origin connections. An empty POST without a session reached the application
and returned 403, with no redirect; `/health` returned 200. No live pairing was
created or approved by these probes. No cookies or response bodies were printed.
These observations verify basic public proxy forwarding, not the affected
browser's authenticated poll or the running Nginx configuration. The original
browser's failing POST status/message was not supplied, so the specific production
trigger (429, storage contention, network failure or another error) remains
unverified. Do not describe one of those triggers as an observed production fact.
No service restart, environment/proxy change or deployment was performed.


## Investigation: Chrome blocks the approved form navigation with CSP

The production browser now reports a `form-action` violation while showing
"Approved. Continue in this browser." This is a different failure from a stopped
status poll: that message proves the approved status was received. The submit
listener disables Continue before native submission. If Chrome aborts navigation
on CSP, the approved page remains visible with its button disabled.

A new read-only live GET confirmed a single enforcing CSP header with
`form-action 'self' https://id.twitch.tv`, no report-only CSP, no CSP meta tag and
no base element. The actual form is `method="post" action="/auth/twitch/connect"`.
The delivered headers match Node's policy; no additional conflicting policy was
observed through the public proxy. No Nginx configuration was read or edited in
this investigation, and no live approval or OAuth exchange was attempted.

The bridge previously returned 303 directly from this form POST to
`https://id.twitch.tv/oauth2/authorize`. Chromium checks `form-action` during form
navigation redirects, retaining the original navigation URL for violation
reporting. Thus a console message naming the same-origin form URL does not prove
that the initial POST was forbidden: a later redirect can be blocked instead.
Allowing the authorize origin does not allow other origins used by subsequent
Twitch login redirects. The affected browser's full redirect chain was not
supplied, so the exact disallowed hop/origin is not independently established;
no guessed Twitch login domains were added to CSP.

The minimal bridge fix ends the approved POST with a 200 HTML document, with the
same OAuth cookie/state generated and approval consumed exactly once. A new
nonce-authorized script then uses `location.replace` for a normal top-level GET
to the server-built official authorize URL. A normal link provides a fallback if
scripts are blocked. There is no Location or Refresh header, meta refresh, new
public route, client-supplied redirect target or form on this handoff page. The
original form navigation therefore ends before Twitch's redirects begin.
The entry policy is tightened to `form-action 'self'`; the handoff uses
`form-action 'none'`, `default-src 'none'`, a script nonce, `base-uri 'none'` and
`frame-ancestors 'none'`. Referrer suppression, no-store, CSRF/Origin/session
checks, replay protection, token storage and browser binding are retained. The
legacy bootstrap and operator-bearer start routes are unchanged.

Regression coverage checks the 200 response (the new test failed on the old
303 before the runtime edit), absence of HTTP redirects, restrictive policies,
nonce execution, fixed official destination, safe URL/HTML encoding, fallback
link, cookie handoff, one-time consumption and wrong-browser callback rejection.
There is no Chrome executable in this workspace; tests execute generated scripts
in Node's VM and exercise the real local handlers, not Chrome's CSP engine.
Browser acceptance after a separately authorized release remains pending.

Primary reference: [Chromium navigation CSP checks](https://chromium.googlesource.com/chromium/src/+/d8824447b19d8429ff23aa708a0f43f2c4eca319/content/browser/renderer_host/navigation_request.cc#5091).
