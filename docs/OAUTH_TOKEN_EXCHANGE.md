# Twitch token-exchange investigation

Status: local fix and tests only. No live authorization, token exchange, PM2
command, deployment or environment edit was performed during this investigation.

## Findings and evidence limits

The reported browser message is the bridge's generic 502 response. In the previous
implementation it could mean a Twitch HTTP rejection, network/timeout failure,
JSON parsing failure, or local token-response validation failure. It did not
record upstream status or a sanitized category. That status cannot be recovered
from the browser's generic message, and this investigation does not claim to have
identified which branch the production attempt took.

The authorization and token exchange use exactly the same hard-coded redirect
URI and the same factory-captured client ID. Neither comes from Host, Forwarded or
X-Forwarded-* headers. The exchange sends POST to the fixed HTTPS Twitch token
endpoint with an application/x-www-form-urlencoded body containing client_id,
client_secret, code, grant_type=authorization_code and redirect_uri. Redirects are
rejected and the existing ten-second timeout is retained. Local regression tests
check exact field equality, URL encoding and independence from proxy headers.

State is deleted before the asynchronous exchange. The code is sent only once for
that state, including overlapping callbacks and failed requests; there is no
exchange retry. A callback with missing/mismatched state or browser binding never
reaches the exchange. Local state expires after ten minutes. Twitch can still
reject a code as expired, previously redeemed elsewhere or otherwise invalid;
none of those provider-side conditions is established for the reported attempt.

## Correcting the clientIdPresent:false result

The earlier diagnostic used `args.some(arg => arg.includes('src/server.js'))`.
The diagnostic shell/Node command text itself included that substring. It therefore
misclassified diagnostic processes with no Twitch environment as bridge processes.
The false result is not evidence of missing credentials in the running PM2 bridge.

A subsequent read-only check restricted candidates to Node executables with an
exact PM2 pm_exec_path or exact server entry-point/title, the repository cwd, and
socket ownership where visible. It rejected two substring-only matches, found no
verified bridge process, and found no port-8766 listener in the current process/
network view. No actual production PM2 process environment has been established
from this environment. PM2 was not invoked, avoiding accidental daemon startup.

The local ignored .env was parsed in memory using Node's env parser. Both client
fields are nonempty and whitespace-free; scopes are empty. Only booleans were
printed. Their values, lengths, hashes and fingerprints were not printed. Presence
does not validate the secret, match it to Twitch's app registration, or prove what
the production process loaded. Also, /proc/PID/environ is initial environment
metadata: it may not reflect values Node later loaded with --env-file. A missing
field there alone must not be treated as missing effective configuration.

## Confirmed code defect and isolated fix

The old response validator required scope to be an array even when no scopes had
been requested. OAuth permits scope omission when unchanged. A successful response
with valid token fields but no scope was thus incorrectly turned into the same
502 message. This was reproduced with a fake 200 response before the runtime edit.
It is a confirmed local defect and a possible explanation of the production
symptom, not a captured production provider response.

The fix infers only an empty scope array when the response omits scope and the
configured request scopes are empty. Missing scope with requested permissions,
null/string/non-string-array scopes and invalid token fields still fail closed.
No nonempty permissions are invented. Tokens are still persisted server-side
through the existing private atomic store. OAuth state, cookies, binding, expiry
and replay checks are unchanged.

## Sanitized diagnostics

On exchange failure, the bridge now emits only:

```json
{"event":"twitch_oauth_exchange_failure","status":400,"category":"authorization_code_rejected"}
```

This is a synthetic example, not a live result. Status is an integer or null when
no HTTP response was available. Categories are fixed strings: client_rejected,
authorization_code_rejected, redirect_uri_rejected, request_rejected,
provider_rate_limited, provider_unavailable, http_rejected, transport_failure,
transport_timeout, invalid_json or invalid_token_response. Provider error strings
are recognized through exact allowlisted matches; arbitrary response text and
exception messages are never logged. Unknown details remain http_rejected.
A category is not proof of a more specific underlying cause: invalid_grant cannot
distinguish expiration from reuse. Tests cover reflected secrets in provider
messages, invalid JSON, transport errors, and diagnostic sink failure.

Do not enable raw fetch logging, dump PM2 environment/JSON, print .env, export HARs,
record callback URLs, retry the old code or initiate another OAuth attempt as a
read-only diagnostic. These local diagnostics do not change the already-running
service until a separately authorized release.

## Remaining blockers and minimal next step

First verify the existing bridge on the actual VPS, read-only, as its service
account. Correlate the exact PM2 executable entry and repository cwd with the
process owning the expected loopback listener. Inspect only boolean presence and
in-memory equality to the intended secure configuration; never print values or
full process arguments/environment. Account for Node env-file loading before
interpreting missing initial-environment entries. Review any already-recorded
numeric upstream status/sanitized category for the original failed attempt.

If no safe upstream record exists, the historic cause cannot be determined without
new evidence. After separately authorizing a release of the reviewed fix and
sanitized diagnostics, a separately authorized fresh pairing/consent can establish
success or the exact failure category. Do not reuse a callback/code or perform
that release/test under the present read-only production scope.

References: [Twitch's authorization-code exchange](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#authorization-code-grant-flow)
and [OAuth response scope rules, RFC 6749 §5.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1).
