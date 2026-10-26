# Temporary Twitch browser bootstrap

Legacy flow: prefer [browser-first CLI-approved pairing](OAUTH_PAIRING.md), which
avoids bearer links. Keep bootstrap disabled when using pairing. The following
bootstrap activation instructions are retained for reference, not executed.

The existing ecosystem ports, reward state, read-only clients and overlay remain
in place; their live activation blockers are listed in [INTEGRATION.md](INTEGRATION.md).
This feature only initiates OAuth. It never enables EventSub, STAMP issuance,
wallet operations or rewards. No production credentials or services were accessed.

## Design and security boundaries

The VPS CLI creates a 256-bit capability valid for two minutes. Only its SHA-256
hash (filename) and expiration are stored in ignored `var/oauth-bootstrap/`.
The directory is owner-only `0700`, files `0600`. CLI and bridge must run as the
same unprivileged Unix account. A filesystem rename atomically claims the file:
exactly one request can consume it across processes. Consumption burns expired
records and fails closed on storage errors. Do not use network filesystems with
weaker rename semantics. Interrupted claims cannot be reused; cleanup removes them.

The CLI prints an HTTPS URL whose **fragment**, never query or path, carries the
capability. Fragments are not transmitted in HTTP requests or normal access logs.
The landing page immediately removes the fragment from the current history entry,
loads no external resources and requires an explicit Continue click. A same-origin
form POST sends the capability in the request body. A 303 response sets the existing
Secure/HttpOnly/SameSite=Lax OAuth cookie and navigates to Twitch in that browser.
The existing random state, cookie binding, expiry, replay checks and private token
storage continue to apply. `/auth/twitch/start` still requires operator bearer auth.
Neither the operator token nor client secret is needed by the CLI or browser.

Bootstrap responses use no-store and a nonce-based CSP with embedding
blocked. The landing page uses `Referrer-Policy: same-origin` so its form POST
retains a verifiable Origin; cross-origin referrers are suppressed. POST responses
and the redirect to Twitch retain `Referrer-Policy: no-referrer`. POST requires the exact configured HTTPS Origin, form content type, and
a body of at most 256 bytes. No capability, body, provider error or secret is logged
by this feature. A global in-memory limit allows 30 bootstrap requests per minute
per process, without trusting proxy IP headers or retaining unbounded IP maps.
This is an abuse bound; a public attacker can temporarily exhaust it. Exactly one
bridge process is still required for OAuth's in-memory state. Minting requires
local filesystem ownership; the HTTP API cannot mint capabilities.

**Activation prerequisite:** independently verify that the current TLS proxy, WAF,
APM, request tracing and browser tooling do not log POST bodies, response bodies,
clipboard contents or URL fragments. Ordinary access logging does not log the
capability, but custom body logging would. This repository cannot enforce external
logging policy and does not change Nginx. Also verify existing callback logs omit
OAuth authorization-code query strings. Leave bootstrap disabled if these checks
cannot be met. Browser extensions, history synchronization, terminal recording,
clipboard managers and crash reporting can capture a bearer link before page code
removes it: use a private trusted browser and a private, unrecorded VPS terminal;
never share, paste into chat, screenshot, bookmark or save the link. A stolen link
can replace the connected Twitch account until consumed or expired.

## Exact operator commands (not executed by this change)

No activation takes effect in the already running PM2 process without a separately
authorized deployment/environment reload. No PM2 command is supplied or run here.
The existing application secret and operator token must already be configured by
the approved environment mechanism; do not retrieve or print them for bootstrap.

After a separately authorized release, the operator can run an isolated foreground
bridge using these commands **only if port 8766 is free** and the reviewed existing
HTTPS proxy forwards to it. Do not run alongside the public service or bypass a
busy port. Otherwise have the service owner load this same environment override
through their approved deployment procedure; until then the new endpoint is absent.

```sh
cd /home/domenzainro/agroceans-twitch-hackathon
TWITCH_OAUTH_BOOTSTRAP_ENABLED=true node --env-file=.env src/server.js
```

This sets only the temporary bootstrap flag; do not change EventSub/payment flags.
With the authorized bridge running, in a second private interactive VPS terminal,
as the same Unix account (no sudo, no environment file or secrets required):

```sh
cd /home/domenzainro/agroceans-twitch-hackathon
node scripts/oauth-bootstrap.js revoke-all
node scripts/oauth-bootstrap.js mint
```

Open the printed fragment link in the trusted browser within two minutes. Click
Continue and complete Twitch authorization in that same browser. The CLI refuses
minting into redirected output/pipes to avoid accidental log artifacts. It does
not open a browser, contact any production endpoint or consume the capability.
If a link expires or fails, revoke outstanding links and mint again. Revocation
also cleans expired and interrupted-claim files. An already claimed request may
finish; revocation cannot undo an OAuth flow that has started.

Cleanup immediately afterward:

```sh
cd /home/domenzainro/agroceans-twitch-hackathon
node scripts/oauth-bootstrap.js revoke-all
```

Close the private browser window and clear the clipboard. Cleanup leaves OAuth
credentials untouched. For an isolated foreground process, press Ctrl-C in its
terminal, then run without the override (default disabled):

```sh
TWITCH_OAUTH_BOOTSTRAP_ENABLED=false node --env-file=.env src/server.js
```

For a managed deployment, the owner must remove/set the override to `false` through
a separately authorized deployment operation. Revoking all files immediately
removes unused capabilities without restarting the currently running process.
No credentials, private keys, tokens or generated bootstrap links belong in Git.

## Verification and remaining blockers

Run `npm run check`, `npm test`, and `git diff --check`. Tests use temporary private
directories inside this repository and fake Twitch responses; they verify atomic
concurrent claims, expiry, revocation, permissions, secure headers, same-origin and
size checks, replay, rate limiting, bootstrap-to-callback cookie binding, and token
storage handoff. No live OAuth exchange is performed. HTTPS/proxy/browser end-to-end
acceptance remains for an authorized deployment. Periodic Twitch token validation,
refresh and production ecosystem API contracts remain prerequisites for ongoing
live use; OAuth success alone is not a verified Twitch-to-AgroWallet link.

## Investigation: Chrome returns “Same-origin browser submission required”

Confirmed implementation defect: the original landing page returned
`Referrer-Policy: no-referrer`. The [Fetch Origin-header algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header)
sets Origin to `null` for non-CORS POST requests under that policy, including
ordinary navigation-mode HTML form submissions. Chrome can therefore send
`Origin: null` even when `Sec-Fetch-Site: same-origin`. The strict server check
correctly rejects that request. Manually supplying the expected Origin in curl
does not reproduce browser header generation. The local fix changes only the
landing-page policy to `same-origin`; there is no Origin/Referer fallback or CSRF
exception. This policy preserves the HTTPS same-origin form's Origin and sends no
cross-origin Referer. URL fragments are never included in Referer, and the script
also removes the fragment before the user submits. The POST response keeps
`no-referrer` for the 303 redirect to Twitch.

The actual failing Chrome request headers were not available in this workspace,
and no Chrome executable was available for a real-browser reproduction. This is
a source-and-standard-confirmed defect consistent with the reported symptoms,
not a claim that the original browser capture was inspected. Regression tests
cover the emitted policy, generated form/CSP, unchanged strict gate, and redirect
headers; browser acceptance remains required after an authorized release.

Read-only inspection of `/etc/nginx/conf.d/twitch-hackathon.conf` and
`/etc/nginx/nginx.conf` found exact bootstrap locations on HTTP and HTTPS,
`proxy_pass http://127.0.0.1:8766`, and `access_log off` for bootstrap/start/callback.
The inspected route has no Origin or Sec-Fetch-Site override, no redirect, and no
injected CSP/Referrer-Policy. Proxying internally over HTTP does not change the
browser's HTTPS Origin; this gate compares the fixed public Origin, not forwarded
scheme headers. No Nginx command, reload, or configuration edit was performed.
Files on disk are evidence of intended configuration, not proof of the running
worker's loaded configuration or any external proxy/CDN behavior.

Other failure cases remain deliberately rejected:

- A missing or literal `null` Origin: privacy extensions or managed policies may
  strip headers; sandboxed documents and cross-origin redirects may make an
  Origin opaque. Matching Referer or Fetch Metadata never replaces Origin.
- `Sec-Fetch-Site: same-site`: a sibling subdomain is a different origin.
  `cross-site` also fails. `none` can describe address-bar/bookmark navigation on
  the initial GET; it is not accepted for the subsequent form POST. Missing
  Fetch Metadata retains existing compatibility only with an exact Origin.
- HTTP, aliases and alternate ports: use the exact public HTTPS origin. The
  current HTTP vhost serves this page too; an HTTP form's Origin fails and its
  Secure OAuth cookie cannot establish the intended session.
- A 307/308 before the bootstrap handler may preserve the POST through an origin
  change, taint Origin, or carry the capability elsewhere. A 301/302/303 can
  instead change POST to GET. There should be no redirect before the same-origin
  bootstrap POST. The intended 303 **after successful consumption** goes to Twitch
  and cannot cause this bootstrap 403.
- CSP violations usually block submission or script execution in the browser,
  rather than return this application's 403. This page has no sandbox directive,
  its form targets the same-origin path, and form-action allows self and Twitch
  for the subsequent redirect. An additional injected CSP/sandbox must be checked
  in actual response headers if the browser still fails.

Safe corrective and verification steps:

1. Review the local policy change and passing checks. Arrange a separate,
   explicitly authorized release of these application files. Do not loosen the
   gate, synthesize Origin in Nginx, or change `.env` to work around the error.
   The existing PM2 process continues serving its loaded code until that release.
2. Without a link or capability, navigate directly to
   `https://twitch.theagrostore.com/auth/twitch/bootstrap` in a trusted Chrome
   window. Inspect Network response headers: the landing GET must be 200 with
   `Referrer-Policy: same-origin`, no-store, and the expected CSP. Do not save or
   share HAR files, request bodies, cookies, fragment URLs, or callback URLs.
3. To check the gate without minting or consuming any capability, run this exact
   snippet in that same-origin page's DevTools console after reviewing it:

   ```js
   const form = document.createElement('form');
   form.method = 'POST';
   form.action = '/auth/twitch/bootstrap';
   const field = document.createElement('input');
   field.type = 'hidden';
   field.name = 'capability';
   field.value = 'invalid-diagnostic';
   form.append(field);
   document.body.append(form);
   form.submit();
   ```

   This deliberately invalid native-form POST should return 400, with
   `Origin: https://twitch.theagrostore.com`, `Sec-Fetch-Site: same-origin`, and no
   intervening redirect. It does not authorize OAuth. Under the old policy the
   same native form may send `Origin: null` and return 403. A fetch diagnostic
   using default CORS mode does not test this navigate-mode policy interaction.
4. If it still returns 403, inspect only the Origin and Sec-Fetch-Site values,
   landing-page policy/CSP, final address and redirect statuses. Check a trusted
   clean browser profile if extensions or managed privacy policies suppress these
   headers. Do not disable global browser protections or spoof Origin. Any real
   OAuth end-to-end attempt needs separate operator authorization; none was made
   during this investigation.
