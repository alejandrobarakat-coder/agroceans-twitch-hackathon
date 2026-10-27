# Stage 5 — two judge demos and one editorial desk

New presentation routes are disabled unless JUDGE_DEMOS_ENABLED=true is explicitly
set for that process. No deployed configuration, service, sibling repository or
upstream API was modified. This stage has no dependency installation, mobile build,
video rendering, commit or push. Existing Stage 2–4 capabilities and endpoints keep
their previous flags and behavior.

## Distinct browser presentations

| Presentation | Page | Snapshot | SSE namespace |
| --- | --- | --- | --- |
| Pinche Chess — Twitch Plays Chess | /judge/chess | /judge/chess/snapshot | /judge/chess/events; judge.chess.snapshot |
| AgroCeans — Twitch for Planet | /judge/planet | /judge/planet/snapshot | /judge/planet/events; judge.planet.snapshot |
| Pinche Tulum LIVE with Alejandro Barakat | /editorial | /editorial/snapshot | /editorial/events; editorial.snapshot |

Page assets are /judge/app.js and /judge/style.css. Routes return 404 when the new
flag is false. Enabled routes permit GET (and HEAD except SSE); write methods
return 405. No judge endpoint changes board state, triggers report refresh, links
an identity or invokes a financial adapter. Existing explicit operator report
refresh stays under the Stage 4 authorization/publication gate.

The chess identity is pinche-chess; the Planet identity is agroceans-planet. They
use different snapshots, counters and source state. Chess renders legal server
PGN/FEN, active turn/check/result, last-move highlighting and SAN/UCI history.
Accepted moves and total chess commands are separate counters. Rejected commands
may update that command count but never move a piece.

Planet presents the environmental mission, existing allowlisted public reports,
service-reported STAMP status/reference/transaction IDs and Twitch !ocean audience
counts. Live and simulated participation/report counts are shown separately.
Chat does not establish evidence, STAMP issuance or reward entitlement. Missing
STAMP stays missing. Real reports still require the original Stage 4 public-page
check and authorized tracking read; judge GETs never fetch those upstream APIs.
The mission text describes engagement, not an invented cleanup completion.

The editorial desk only projects sanitized summaries from the two domains. It
does not merge their identities, commands, counters or persistence. It presents
both the chess board/last move and the Planet mission/reports. Pinche Tulum LIVE
is the editorial brand; Alejandro Barakat is the host label. The bridge does not
observe, encode, start or publish a video broadcast. Every page explicitly says
that connected SSE is application data and video status is unobserved. Twitch
connectivity has its own independent status.

## Output sanitization and recovery

src/judge-demos.js ignores arbitrary incoming event data and reprojects current
domain snapshots. It emits only allowlisted fields. Chess history/turn/result are
derived from legal PGN and checked against FEN; arbitrary PGN identity headers,
comments, forged history, raw chat, credentials and financial fields are omitted. Planet
URLs are constrained public-post references, not caller-selected links. Report
and source simulation labels must agree; simulation STAMPs are rejected rather
than inventing a certificate or transaction. The source STAMP verification string
is replaced with an explicit service-reported limitation, never upgraded to proof.
Unknown events, including reward/issuance events, are ignored by these feeds.

Each presentation has a bounded SSE client group: 20 total and four per socket
address by default. Full groups return 429/Retry-After; disconnects release slots,
and backpressure disconnects slow clients. Proxy address aggregation needs review
before any later authorized deployment; spoofed forwarding headers are not trusted.
Heartbeats recheck current projections, allowing recovery even if a notification
was missed. Identical projections are not rebroadcast as state changes. Every
connection/reconnect receives a fresh snapshot, not a promise of replayed events.

Snapshots carry a per-process instance ID and per-domain revision. The browser
rejects old revisions from the same instance and accepts a new snapshot epoch
after restart. It reconnects automatically, recovers invalid packets by fetching
the read-only snapshot, clears report display on disconnect and labels retained
chess positions stale. No client-supplied board/report data is accepted by HTTP.

Pages use created DOM nodes/textContent, restrictive same-origin CSP, no-store,
no-referrer and frame blocking. Responsive layouts, semantic headings/navigation,
skip links, current-page labels, visible keyboard focus, readable status text,
polite announcements and accessible board piece descriptions are included.
There is no external font/CDN or browser chess rules engine.

## Exact standalone local simulation command

From this repository, explicitly start a new loopback-only process:

```sh
JUDGE_DEMOS_ENABLED=true CHESS_SESSION_ENABLED=true PLANET_DEMO_ENABLED=true PORT=8878 npm run demo:judges
```

Open these exact URLs:

- http://127.0.0.1:8878/judge/chess
- http://127.0.0.1:8878/judge/planet
- http://127.0.0.1:8878/editorial

Send these lines to that terminal (browser routes remain read-only):

```text
chess e2e4
chess e7e5
planet !ocean viewer1
planet !ocean viewer2
planet report sample1
```

The local launcher uses the existing validated command envelope/router and legal
session. Simulation state is separate under ignored var/judge-simulation/chess/
and var/judge-simulation/planet/. Repeated report IDs deduplicate; repeated !ocean
messages count separately while unique simulated participants deduplicate. Report
items are synthetic, explicitly labeled and have no public URL, STAMP or reward.
No synthetic identifier is sent to real services. Restart resumes local state.
There is no automatic reset or deletion of a finished match.

The launcher does not load .env, read Twitch credentials, refresh tokens, register
subscriptions, query production reports or import financial integration adapters.
Omitting the explicit flags leaves the corresponding capabilities disabled.
Ctrl+C stops only that local process. No persistent local demo process was started
while implementing this stage; tests use ephemeral listeners and temporary state.

For a future authorized bridge process with JUDGE_DEMOS_ENABLED=true, the same
paths are on its configured PORT (8766 by default). Real chess/Planet data still
requires their separate original opt-ins and authorized contracts. This document
is not an instruction to restart or activate an existing deployed service.

## Verification

test/judge-demos.test.js covers disabled defaults and unchanged legacy routes,
read-only HTTP, domain identities/counters/storage, sanitized real and simulated
source projections, SSE isolation, editorial views, client caps/backpressure,
reconnect/restart, source corruption containment and financial tripwires.
test/judge-browser.test.js uses DOM/EventSource fixtures to test board/history,
safe text, separate simulation/live counts, video-status distinction and recovery.
These tests do not claim live Twitch delivery or full graphical browser acceptance.

Final validation on 2026-10-26: npm run check passed; npm test passed 162 tests
(154 top-level), zero failures; git diff --check passed. Sixteen new tests extend
the Stage 4 baseline of 146, including delayed recovery-response fencing and
closing during an initial pending snapshot. HTTP/SSE tests used the required
temporary loopback/child-process permissions. No dependencies changed. Working
tree excluding .git measured 1,560 KiB versus 1,480 KiB before Stage 5 (+80 KiB);
the VPS filesystem remained 96% used. No persistent demo process remains running.
