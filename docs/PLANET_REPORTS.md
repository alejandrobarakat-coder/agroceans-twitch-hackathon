# Stage 4 — AgroCeans public environmental reports

Implemented only in the isolated hackathon repository. Existing wallets, rewards
and STAMP operate in the original ecosystem; this stage only reads observations.
It creates no report, certificate, transfer, reward or approval. No production
source edits, deployment, service restart, credential reads, authenticated live
report retrieval, commit or push were performed.

## Contracts inspected read-only on 2026-10-26

1. Authenticated report tracking:
   GET https://matrix.theagrostore.com/index.php?r=agro_impact%2Freport%2Ftracking
   Source: /var/www/love/protected/modules/agro_impact/controllers/ReportController.php,
   behaviors() and actionTracking(). HumHub role @ is required. It enumerates the
   authenticated user's reports and returns `{ok:true,reports:[{folio,...,stamp}]}`.
   **This is not a public report catalogue or a Matrix messaging API.**
   The unauthenticated GET returned 302, text/html; its body was not displayed.
2. Public publication:
   GET https://matrix.theagrostore.com/index.php?r=post%2Fpost%2Fview&id=<postId>
   /var/www/agrobol/tools/run-impact-publications.php sets VISIBILITY_PUBLIC and
   stores this URL after publication. Its body contains the exact marker
   `AgroCeans reference: <folio>`. HumHub's
   /var/www/love/protected/humhub/modules/post/controllers/PostController.php
   actionView() uses a readable() post query. The hackathon anonymously checks
   only explicitly configured post IDs, requiring HTTP 200 HTML and the matching
   body marker. Redirects, login forms, script/comment-only markers and mismatched
   folios fail closed. No credential is sent to this check. No particular public
   post was assumed/configured or privately discovered during implementation.
3. Existing STAMP observations:
   /var/www/agrobol/tools/export-impact-status.py exports folio, status,
   chain_status, txid and other existing status fields. Tracking passes this as
   stamp. The bridge preserves existing status, chain status, optional reference
   and transaction ID. Missing STAMP stays null. It does not fabricate pending
   issuance, a reward amount or a transaction.
4. Commitment contract:
   /var/www/agrobol/tools/prepare-impact-stamps.py computes SHA-256 of exact UTF-8
   canonical_manifest bytes. Parsed schema is agro.stamp-manifest.v1 with folio,
   report_sha256, report_file_sha256 and evidence hashes. The current status
   exporter/tracking response does not expose those proof bytes. Therefore the
   normal observation is **service-reported**, not cryptographically verified.
   If that existing commitment metadata is explicitly supplied in a future source
   response, the bridge checks exact bytes, folio/schema binding, optional manifest
   equivalence and any operator-pinned hash. A supplied mismatch fails ingestion;
   no new production proof endpoint was invented. Matching bytes do not prove
   environmental evidence, reviewer approval, ownership, payout or on-chain
   embedding. No on-chain commitment verification is claimed.

Source code, not private data files, was read. No workers were executed, including
dry-run modes. Only one unauthenticated live tracking request was made to inspect
HTTP status/content type; initial sandbox DNS failure required a network retry.
All implementation tests use fake providers and temporary local storage.

## Opt-in policy and authorization

Defaults are AGRO_PLANET_REPORTS_ENABLED=false and an empty
AGRO_PLANET_PUBLIC_REPORTS_FILE. When explicitly enabled, configuration requires:

- AGRO_REAL_PAYMENTS_ENABLED=false.
- Existing AGRO_MATRIX_URL and an operator-provisioned authorized
  AGRO_MATRIX_SESSION_COOKIE. No cookie was opened or copied in this task.
- AGRO_PLANET_PUBLIC_REPORTS_FILE pointing to an operator-reviewed JSON policy
  inside this repository. The file must be 0600 in a 0700 directory, with the
  existing private-file ownership/symlink checks. The policy authorizes disclosure
  of only those public identifiers; the remote tracking session alone does not.

Illustrative policy shape only; these are not actual published reports:

```json
{
  "version": 1,
  "reports": [
    { "folio": "impact:public-example", "postId": "123" }
  ]
}
```

Maximum 50 entries; duplicate folios, unsafe identifiers, URL/path injection and
malformed optional commitmentSha256 pins are rejected. A pin requires the source
to expose the matching commitment; current tracking usually cannot satisfy it.
The public page is checked before the authenticated tracking request. Any missing,
non-public, unauthorized, conflicting or malformed allowlisted report fails the
whole refresh. Reports outside the policy are excluded. Publications can fail
anonymous access even if an operator can see them while logged in; fail closed
rather than overriding this check with a session.

POST /planet/refresh requires the existing operator bearer authentication. It
accepts no submitted report/body; callers cannot inject report state or choose a
source URL. No polling, token refresh, issuance or production write is performed.
Tracking credentials are used only for the fixed same-origin tracking GET, with
HTTPS, redirect rejection, timeout, strict JSON content type and 2 MB response cap.

## Public output, persistence and deduplication

GET /planet/snapshot and /planet/events are read-only public routes. They expose
only folio, checked public URL, permitted STAMP fields, explicit verification
limitations, observation time, source, local revision and existing !ocean counters.
No titles, descriptions, photos, locations, wallet/receiver/destination addresses,
raw manifests/evidence, session cookies, identity links or reward data are emitted
or saved by Stage 4. Existing reference values are retained, not invented.

Private ignored var/planet-reports/reports.json stores only sanitized observations,
source/policy binding and a monotonic revision. Existing atomic/private storage
and filesystem exclusion apply. Identical duplicate source rows collapse; conflicting
duplicates fail. Unchanged refreshes emit no report event. Actual status changes,
including a return to a previous status, receive distinct transition IDs. Concurrent
refresh requests coalesce. There is no unbounded event log.

On startup/restart, no persisted report is exposed until revalidated. Public,
authentication, commitment or persistence failures hide reports and emit a clear
unavailable snapshot; repeated failures do not duplicate that status transition.
The legacy ecosystem cache is also stripped of cached report/transaction data on
failure. Successful revalidation restores current snapshots without counting old
unchanged reports as new events. Policy/source changes fail binding validation
and require operator review of local cache migration; there is no automatic reset.
Previously observed commitments cannot silently change or disappear under the
same folio. All observations describe the last explicit successful refresh, not
continuous proof of public availability. Refresh again to detect withdrawal.

The legacy /integration/refresh obtains report data only through this public gate.
Legacy AGRO_PUBLIC_REPORT_FOLIOS plus a cookie alone no longer authorize report
broadcast. Its chain-reading behavior and other production-facing APIs remain.
The existing legacy MatrixReportsClient is retained for compatibility/testing;
the public server no longer uses its tracking-only output as publication proof.

## Domain isolation and delivery

Planet named SSE events are snapshot, report, participation and status. No chess
or financial records enter this stream. Chess endpoints, sessions and counters
are unchanged. !ocean still produces the original twitch_participation event and
durable live counters on legacy /events; the Planet feed adds a redacted view.
Simulation participation is explicitly labeled and cannot create a public report.
The overlay subscribes to the report feed with safe textContent rendering and
clears report display on failure/disconnect. No reward amount is inferred.

Planet SSE is capped at 20 connections, four per socket address, with retryable
429, cleanup, heartbeats and backpressure disconnection. Behind a proxy these
conservative address caps may aggregate viewers; review before any later rollout.
Each reconnect receives a snapshot. A crash after persistence but before publishing
can lose a notification; snapshot recovery, not exactly-once SSE, is the guarantee.

## Tests and limits

test/planet-reports.test.js covers allowlists, public-page binding, missing STAMP,
duplicate/conflicting/malformed responses, redaction, canonical/pinned/mismatched
commitments, source/policy binding, concurrent refresh, restart, login/JSONP/redirect
rejection and failed writes. test/planet-http.test.js covers operator authorization,
read-only routes, report/event deduplication, SSE recovery, !ocean, financial tripwires,
legacy-cache privacy and chess/planet isolation. The existing overlay test now also
covers the dedicated report feed, safe text, missing STAMP and unavailable snapshots.

No authorized live session or real public report policy was provisioned/used.
Thus this stage implements and tests the safe integration, not a claim that an
authenticated real report or its commitment was retrieved during this session.

Final validation, 2026-10-26: npm run check passed; npm test passed 146 tests
(138 top-level), zero failures; git diff --check passed. This adds 18 tests to the
Stage 3 baseline of 128 and extends the overlay test. No dependency changes or
installations. Working tree excluding .git measured 1,480 KiB versus 1,420 KiB
before Stage 4 (+60 KiB); VPS filesystem remained 96% used. Filesystem-wide free
space also changes with unrelated activity and is not this patch's disk impact.
