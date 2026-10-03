# @openart-signal/watchdog

A daily, **zero-delivery** watchdog for OpenArt's existing tag stack — GTM-56CMP8K (served both from
`www.googletagmanager.com` and first-party through the Cloudflare Google tag gateway at `/4vu8/`), the
Google tag config for AW-11252321380 / AW-16854695811, the Meta pixel 843671884361709 + its CAPI
Gateway, TikTok, Reddit, LinkedIn, X, Microsoft UET and OpenAI Ads. It checks the **conversion
contract** (what each platform receives for the app's real signup / purchase pushes), **click-ID
propagation** across real user journeys, **consent mode**, and **container drift** — and proves, per
run, that none of the measurement requests it provokes ever leaves the machine.

It plugs into what OpenArt already runs: it loads the live site, the live container and the live
vendor SDKs; the only things it changes are local (failing collection requests inside Chrome, and —
in patched runs — serving a candidate container/config, a shim or an edge-cookie simulation).

| | |
|---|---|
| Run it | `npx tsx src/cli.ts run --target live` (from this directory) |
| Output | `results.json` + `report.html` (+ `raw/`, gitignored) |
| Schedule it | Cloud Run job + Cloud Scheduler, results to GCS (+ BigQuery) — [`infra/watchdog/`](../../infra/watchdog) |
| Baseline | [`reports/baseline-2026-09-30/report.html`](reports/baseline-2026-09-30/report.html) — see [Baseline](#baseline-2026-09-30-live) |

---

## What it checks

### 1. Conversion contract replay (full seal)

**All conversion scenarios fire together**, each in a separate browser session with its own
cookies, storage and tag state. Each session loads `/pricing` under the collection seal, then is
**fully sealed** (every Fetch-intercepted request is failed on every target, and the gatekeeper proxy
refuses every connection). Once every session has installed and probed its seal, a shared barrier
releases all scenarios without a delay between them. Independent sessions keep one scenario's user
data or event state from contaminating another's results. The app's real calls are replayed with
`WD_TEST_*` data — verbatim shapes
from the shipped Suite bundles ([`src/replay/scenarios.ts`](src/replay/scenarios.ts)):

| Scenario | The app's call (source chunk) |
|---|---|
| `signup` | server one-shot cookie `oa_signup_uid=<uid>:<email>` → `dataLayer.push({event:'signup',user_data:{email}})` → cookie removed (82a8baa61b72c9cd.js) |
| `new_user_signed_up` | control only — nothing in the app emits it (GTM's Google Ads signup tag listens for it) |
| `purchase` | `gtag('set','user_data',{email})`, `gtag('event','purchase',n)`, `gtag('event','conversion_event_purchase',n)`, `uetq.push('event','purchase',…)` (08d6e61a49e7dfba.js `K()`) |
| `first_purchase` | `dataLayer.push({event:'first_purchase',eventModel:{transaction_id:'sub_<invoiceId>',…},user_data:{email}})` (d4f45453351837aa.js `eN()`) |
| `business_subscription` | same shape, `event:'business_subscription'` (d4f45453351837aa.js `eA()`) |
| `purchase_first` | `gtag('set','user_data')` + `purchase_first` + `conversion_event_purchase_first` with the list-price payload (08d6e61a49e7dfba.js `Z()`) |

Every attempted request is decoded per vendor (Google Ads fan-out incl. the `/4vu8/` gateway paths,
multi-destination `tids`, batched GA4 bodies and the HPKE `eme` envelope, Meta `/tr` + CAPI Gateway,
TikTok incl. batch bodies, Reddit, LinkedIn `/collect` + `/wa/`, X `adsct` pairs, UET, OpenAI,
Amplitude). The replay records the page-load outcome and a tag-readiness probe; a scenario that did
not execute, threw, or whose vendor tag was not ready makes that check **ERROR**, never a false
FAIL/PASS. When the app's pushes change, pass the new shapes with `--scenarios file.json` — that file
*is* the dataLayer contract the app team owns.

“Together” means concurrent dispatch from that barrier; browser scheduling and vendor SDKs can
still add timing differences. `results.json` and `report.html` record each scenario's start/end
times and the measured start spread. The raw batch manifest links to the separate captures, with
readiness, seal probes and zero-leak evidence retained for every session. **The network blockade
prevents fake conversions from reaching ad accounts**; simultaneous timing and `WD_TEST_*` labels
are not the protection. The committed September 30 baseline remains the historical sequential run.

### 2. Click-ID journeys (collection seal)

Synthetic click ids (`WD_TEST_GCLID_<run>`, `…FBCLID…`, `…TTCLID…`, `…MSCLKID…`, `…RDTCID…`,
`…LIFATID…`, `…TWCLID…`, `…OPPREF…`, `…GBRAID…`, `…WBRAID…`) on real paid-landing URLs:

| Journey | Path |
|---|---|
| `meta_one_hop` | `/?…` → **Start for free** → `/home` |
| `meta_multi_hop` | `/?…` → `/ai-model/seedance-2-5/` → **Generate with Seedance 2.5** → app |
| `meta_return` | `/?…`, then a typed `/home` (no referrer) |
| `oppref_marketing` | `/?oppref=…` (ChatGPT ad) → CTA → `/home` |
| `gbraid_wbraid` | `/?gbraid=…` → CTA → `/home`, then an app landing `/home?wbraid=…&fbclid=…` |
| `instagram_webview` | Instagram iOS UA: `/?fbclid&ttclid` → CTA → `/home` → sign-in → "Trouble redirecting? Open page in your browser" overlay |
| `ubo_blocked` | uBlock Origin defaults simulated from the real default lists: `$removeparam` strips params from the navigation before it is sent, matching filters block requests (blocked requests are not counted as attempted hits) |
| `spa_pageviews` | `/home` → 3 Suite soft navigations → the anonymous sign-up wall closed (never filled) → a prompt typed into the create-image editor and **Generate** clicked (the request is failed like every POST) |

For each journey × platform the report records whether the click id reached the platform's
**dedicated attribution field** on its attempted hits (`gclaw`/`gclid`/`gbraid`/`gclgb`, `fbc` /
`fb.clickID`, `context.ad.callback`, `click_id`, `li_fat_id`, `twclid`, `msclkid`, `oppref`) — a
value that only appears inside a page-URL field does not count — and whether it was stored
first-party (`oa_ad_clids`, `_fbc`, `_gcl_*`, `ttclid`, `_rdt_cid`, `li_fat_id`, `_twclid`,
`_uetmsclkid`, `__oppref`, the shim cookies).

**CLICK-ID COVERAGE %** per platform = share of journeys whose ad URL carried the platform's click id
in which it reached that dedicated field on a hit fired **from an app page** (where signup and
purchase later fire). Journeys that did not run as specified (a step failed, or the app was never
reached) are excluded from the denominator and listed. The uBlock journey is the blocker cohort.

### 3. Consent

`gcd` / `gcs` are decoded on every attempted Google hit. Letter mapping (one letter per signal, order
`ad_storage, analytics_storage, ad_user_data, ad_personalization`), source: Simo Ahava, *Consent Mode
V2 for Google Tags* (decode by Markus Baersch), corroborated by giancampo.com (checked 2026-09-29):

| | no update | update → denied | update → granted |
|---|---|---|---|
| no default | `l` | `m` | `n` |
| default denied | `p` | `q` | `r` |
| default granted | `t` | `u` | `v` |

`gcs=G1xy` = ad_storage x, analytics_storage y (1 granted / 0 denied), sent only when consent mode is
active. **EEA/UK/CH probes**: Google embeds the visitor's geo in the served loaders; the probe
rewrites it locally to DE / GB / CH for one page load each — `blob["30"]`/`["31"]` and the geo the
tag's region matching actually reads, `blob["22"]` (unpadded base64 JSON; fields `"0"` country and
`"1"` region are replaced, everything else is kept). Region-scoped `gtag('consent','default',{…,
region:[…]})` or CMP-template defaults then apply exactly as for a real visitor; the check requires
denied defaults **declared for that region** (per `google_tag_data.ics`), not another region's.
A probe whose tag fell back to `www.google.com/ccm/geo`, or where no loader was rewritten, is invalid
(ERROR). The mechanism is verified on Google's own tag code in
[`test/consent-geo.int.test.ts`](test/consent-geo.int.test.ts) (US: no default; DE/GB: `p`; FR: none).

### 4. Container diff

Plain GETs of `https://www.googletagmanager.com/gtm.js?id=GTM-56CMP8K`, `https://openart.ai/4vu8/`
and `gtag/js?id=AW-11252321380` (redirects followed only to those two hosts). The embedded
`var data = {…}` block is parsed; the version and a stable hash (SHA-256 of the canonical, key-sorted
JSON of `resource`) are compared with [`baselines/`](baselines), and the diff lists changed **tags**
(by `tag_id`, named after research/02 §2.1), **triggers** (rules resolved to their conditions) and
**variables** (macros by function + parameter). The state is `UNCHANGED` only when every loader
matches its baseline and both container loaders agree; a loader that cannot be fetched or parsed is
`UNAVAILABLE`, which alerts like a change (fail-closed). The report also shows the hash of what Chrome
actually executed on each loader (and the patched hash in patched runs).

### 5. The contract — [`scenarios/contract.json`](scenarios/contract.json)

The TARGET behaviour (PASS = fixed). Evaluated by [`src/contract.ts`](src/contract.ts), unit-tested
against the saved 2026-09-29 captures: today's evidence evaluates to the research's verdicts, and
every check has a positive control that goes green.

| Check | Target |
|---|---|
| `signup.google_ads.user_data` | the real `signup` push produces the Google Ads **signup** conversion (label `rVk2CJ7Ot8EZEOSYw_Up`) carrying user-provided data on that conversion |
| `purchase.linkedin.value_and_event_id` | LinkedIn purchase hit carries `val` and a non-empty `eventId` |
| `purchase.x.single_deterministic_event` | exactly one X purchase event, id = transaction id |
| `signup.tiktok.event_id` | TikTok `CompleteRegistration` `event_id` = `reg_<uid>` |
| `business_subscription.consumed` | at least one ad platform records a conversion for it |
| `generation.google.no_auto_form_events` | no Google `form_start` / `form_submit` on a generation (requires Generate clicked and the Google tag running) |
| `spa.page_views.<platform>` ×7 | exactly one page view per route change (Google per destination) |
| `meta.fbc.multi_hop`, `meta.fbc.return` | the first app PageView to Meta carries `fbc` (journey path pinned by `stepPaths`) |
| `openai.oppref.marketing_landing` | the OpenAI SDK on the app sends the oppref from a marketing landing |
| `google.gbraid_wbraid.persisted` | `oa_ad_clids` keeps gbraid and wbraid |
| `webview.handoff.attribution` | the in-app-browser handoff URL carries a click id / UTM or a token |
| `consent.eea_uk_ch.defaults` | DE/GB/CH probes show denied defaults declared for that region |

**Statuses.** PASS / FAIL only when the source ran exactly as specified. **ERROR** when it did not:
a replay scenario that did not execute or threw, a vendor tag not ready on the replay page, a journey
step that failed, a journey that never reached an app page or deviated from its `stepPaths`, a route
change that was not a clean soft navigation, a platform with no page view on the hard load, a
consent probe whose geo could not be simulated. **SKIP** only for sources deliberately not requested
(`--no-replay`, `--journeys`, `--consent-regions none`); a requested source that produced nothing is
ERROR.

---

## How to run

From `packages/watchdog` (Node 22, Google Chrome installed; deps come from the repo root):

```bash
npx tsx src/cli.ts run --target live --out reports/run-$(date -u +%F)        # full run (~21 page loads, ~10 min)
npx tsx src/cli.ts run --target live --journeys meta_multi_hop,spa_pageviews --no-replay --consent-regions none
npx tsx src/cli.ts pilot                                                        # seal self-test only (loopback server, no internet)
npx tsx src/cli.ts container                                                    # container diff only (3 script GETs)
npx tsx src/cli.ts report --in reports/<dir>/results.json                       # re-render report.html
npx vitest run && npx tsc --noEmit -p tsconfig.json                             # 244 tests (3 drive real headless Chrome, hermetically)
```

### Patched runs — the before/after proof for the fix packages

```bash
npx tsx src/cli.ts run --target patched \
  --patch-container   ../web-fixes/gtm/proof/patched_resource.json \
  --patch-gtag-config ../web-fixes/gtm/proof/patched_gtag_config.js \
  --inject-script     ../web-fixes/gtm/proof/inject_web_fixes.min.js \
  --edge-sim          ../edge-attribution/dist/edge-sim.js \
  --out reports/patched-$(date -u +%F)
```

Any subset of the four flags works (`--target patched` requires at least one, `--target live` none);
`../web-fixes/gtm/proof/variants/patched_resource.linkedin-lintrk-value.json` is an alternative
`--patch-container`. The live run's `reports/baseline-*/results.json` is the "before".

| Flag | Contract |
|---|---|
| `--patch-container <file>` | A GTM **resource JSON** — the bare `resource` object (`{version, macros, tags, predicates, rules}`) or `{resource, targetId?}` — is spliced into the **live** runtime of *both* loaders (`gtm.js?id=GTM-56CMP8K` and `/4vu8/`), i.e. exactly what publishing a new container version changes. A compiled container `.js` (contains `var data = {`) is served wholesale instead. Bodies are matched by their embedded id (`blob["5"]`); a patch only ever replaces the loader it was built for (default GTM-56CMP8K). |
| `--patch-gtag-config <file>` | Same, for the Google tag config: served only in place of the config with the same id (the script's embedded id, or `targetId`; default AW-11252321380) — never for AW-16854695811 or G-QYRJB9TLG7. |
| `--inject-script <file>` | Plain JS inserted as `<script data-openart-watchdog-inject="1">` right after the document's real `<head>` tag (comments skipped) of every openart.ai HTML document, before the edge-injected gateway snippet — stand-in for a drop-in shim or an app patch. A script containing `</script`, `<!--` or `<script` is **rejected** (escaping would silently change regexes/strings; rewrite them, e.g. `'<' + '/script>'`). A sentinel appended to the block (`window.__openartWatchdogInjected`) shows whether it actually ran (a CSP would block it silently). |
| `--edge-sim <file.js>` | An ES module exporting `simulate(requestUrl, requestHeaders, {country}?) => {setCookies: string[]}` — e.g. [`packages/edge-attribution/dist/edge-sim.js`](../edge-attribution/dist/edge-sim.js). Called for every openart.ai **document** response; its `Set-Cookie` lines are added exactly as the Cloudflare Worker would (the origin's own `Set-Cookie` headers are kept). `requestHeaders` = the navigation's headers + `cookie` (the jar for that URL) + `cf-ipcountry`; `country` is `US`, or the probe's country in consent probes. It runs in a **worker thread** with an empty environment (no webhook secrets), no `fetch`/`WebSocket`, a 2.5 s per-call budget that terminates the worker (a synchronous loop cannot stall the paused browser), and a static check that it imports nothing but `node:crypto`/`buffer`/`util`/`url`. Cookies with a `Domain` outside `openart.ai`, control characters, or authentication/bot-management names (`__session`, `__client_uat`, `__clerk*`, `__cf_bm`, `cf_clearance`, `__Host-*`, `__Secure-*`) are rejected and reported. |
| `--scenarios <file.json>` | Replace the replayed app pushes: `[{id, desc, code, context: {uid?, email?, transaction_id?, invoice_id?}, source}]`. |
| `--contract <file.json>` | Evaluate against a different contract file (same schema). |

Other flags: `--journeys a,b`, `--no-replay`, `--replay-page URL`, `--consent-regions DE,GB,CH|none`,
`--max-page-loads 60` (integer 1–200), `--blocklists DIR`, `--chrome PATH` (or `WATCHDOG_CHROME`),
`WATCHDOG_CHROME_ARGS` (allowlist only: `--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage`,
… — a flag like `--no-proxy-server` aborts the run), `--slack-webhook-env VAR`,
`--fail-on never|fail|change`, `--no-pilot`. Everything is validated before any browser starts.
Exit codes: **0** ran · **1** `--fail-on` triggered (FAIL/ERROR, run errors, or a container change) ·
**2** zero-leak proof not proven · **3** crashed (incl. a failed seal self-test — nothing touched
openart.ai) · **4** an alert was due but could not be delivered.

---

## How OpenArt would schedule it on GCP

Everything is in [`infra/watchdog/`](../../infra/watchdog) — nothing is deployed by this repo.

1. **Image**: `docker build --platform linux/amd64 -f infra/watchdog/Dockerfile -t REGION-docker.pkg.dev/PROJECT/openart-signal/watchdog:TAG .`
   (Node 22 + Chrome stable; the monorepo lockfile; uBO default lists fetched at build time by
   [`scripts/fetch-blocklists.sh`](scripts/fetch-blocklists.sh)). Push to Artifact Registry.
2. **Cloud Run job**: `gcloud run jobs replace infra/watchdog/cloudrun-job.yaml` — gen2, 2 vCPU / 4 GiB,
   1 task, **`maxRetries: 0`** (a retry would repeat live page loads), 1 h timeout, a dedicated service
   account with only `storage.objectCreator` on the results bucket, `bigquery.dataEditor` on the
   optional dataset and `secretAccessor` on the Slack webhook secret.
3. **Cloud Scheduler**: `gcloud scheduler jobs create http openart-signal-watchdog-daily --flags-file infra/watchdog/cloud-scheduler.yaml`
   — daily 06:15 America/Los_Angeles, calls the Cloud Run Admin API `jobs.run` with an OAuth token of a
   service account that only has `run.invoker`; no retries.
4. **Results**: [`entrypoint.sh`](../../infra/watchdog/entrypoint.sh) runs the watchdog, then
   [`upload.mjs`](../../infra/watchdog/upload.mjs) writes `gs://BUCKET/runs/<date>/<runId>/{results.json,report.html}`
   and `gs://BUCKET/latest/…` (raw captures only with `WATCHDOG_UPLOAD_RAW=1`; put a 30-day lifecycle
   rule on `runs/`). With `WATCHDOG_BQ_DATASET=project.signal_watchdog` it also streams one row per run
   (`runs`: counts, zero-leak, container state, run errors, unlisted first-party patterns, coverage) and
   per check (`check_results`) — schemas in `infra/watchdog/bigquery/` — so the Data team can chart
   check status and click-ID coverage over time next to Stripe/Amplitude data.
5. **Alert**: the Slack incoming webhook (Secret Manager → `SLACK_WEBHOOK_URL`) fires on any FAIL/ERROR,
   a container change **or an unreadable container**, run errors, first-party requests outside the
   allowlist, or an unproven zero-leak — with the failing checks, the container problems and a link to
   the report in GCS. Site-controlled text is escaped for Slack, sections are kept under Slack's limits,
   only `https://hooks.slack.com/…` URLs are accepted (redirects refused), and a due alert that cannot
   be delivered makes the job exit 4.

**Alternative**: [`infra/watchdog/.github/workflows/watchdog.yml`](../../infra/watchdog/.github/workflows/watchdog.yml)
(copy to the repo-root `.github/workflows/` to activate): daily cron + manual dispatch, runs the unit
tests (incl. the hermetic Chrome tests) and the live run, uploads the report as an artifact, alerts
Slack, and fails the workflow if no results were produced.

After a GTM publish that is meant to fix something: update `baselines/container_v25.json` from the new
live container (`scripts/make-baseline.ts` shows the method) so the diff tracks the next change.

---

## Safety guarantees

What the watchdog sends to OpenArt and ad platforms: **ordinary anonymous page loads only** —
GET documents, scripts, stylesheets, fonts, images/media and the read-only first-party fetches the
pages need to render. Nothing else is delivered. Layered, and each layer is checked every run:

- **Collection seal** ([`src/policy/policy.ts`](src/policy/policy.ts)) — decided at the CDP Fetch
  layer for every request of the page, every frame and worker, and the browser target itself, before
  the request leaves Chrome:
  - **fail** every request to a known measurement endpoint — any method, any resource type, the host
    on any `openart.ai` subdomain and the path in raw *and* percent-decoded form: Google
    Ads/ccm/rmkt/pagead/conversion/doubleclick, the `/4vu8/` collection paths (incl. the gateway
    service worker), `facebook.com/tr`, the CAPI Gateway (`*.on.aws`, `*.run.app`), TikTok
    `/api/*`, `alb.reddit.com`, `px.ads.linkedin.com`, `t.co` / `analytics.twitter.com`,
    `bat.bing.com/action`, Amplitude, Clarity, Hotjar, Tolt, `bzr.openai.com`, Statsig, Chargeblast,
    Cloudflare RUM/NEL, Sentry, CRM/affiliates and OpenArt's own tracking paths;
  - **fail** every non-GET, every service-worker script, every third-party request carrying a
    `WD_TEST` marker (URL or Referer), and everything not explicitly allowed;
  - **allow first-party only from an allowlist** (build assets, the CDN, the gateway container/config
    loader, Clerk's `client`/`environment`, i18n files, the read-only `/suite/api/*` endpoints seen in
    the saved journeys, page navigations and RSC route data). Any other first-party request is
    **failed** and listed in the report for review ("unknown = failed, never delivered");
  - **allow third-party only** for the SDK scripts, fonts and configs on the render list.
- **The browser can reach first-party hosts only.** Chrome's only route out is the out-of-process
  gatekeeper proxy, which tunnels to `openart.ai` / `*.openart.ai` and refuses every other CONNECT
  before an upstream socket exists. Every allowed **third-party** GET (GTM, `fbevents.js`, the TikTok,
  UET, LinkedIn, X, Reddit, OpenAI SDKs, fonts) is fetched by the watchdog itself — GET only, no
  cookies, no credentials or conditional headers, redirects handed back to Chrome so each hop is
  decided again — and fulfilled into the page. So even a request CDP never saw cannot reach an ad
  platform. QUIC off, WebRTC restricted to proxied UDP, `--no-pings`.
- **Channels the Fetch domain cannot see are closed**, each verified on a loopback server that logs
  what it receives: speculation-rules **prefetch and prerender** (issued by the browser process —
  stopped by the profile preference "no preloading"; `Page.setPrerenderingAllowed(false)` and feature
  flags did not stop them); the **Reporting API / NEL** (disabled features; no report is ever
  queued); **WebSocket / WebSocketStream / WebTransport** (constructors throw in every page, frame,
  about:blank child frame and worker before any page script runs — including via
  `WebSocket.prototype.constructor`); **service workers** (registration refused in-page; a worker
  target that appears anyway is held paused and never runs — the Google gateway tries to register one
  on every page, and the report lists each refusal); **SharedWorker** and **popups** (refused;
  Chrome's popup blocker on; any extra page target is closed and fails the proof). A page or frame
  whose Fetch interception cannot be enabled is never resumed.
- **Full seal for synthetic events** (reused `sealed_replay.cjs`): fail-all on every target, new
  targets sealed before they resume, proxy refusing everything, seal probes, **SIGKILL while sealed**
  (no unload beacons). Synthetic signup/purchase events are only ever pushed under this seal.
- **Seal self-test first** ([`src/pilot.ts`](src/pilot.ts)): every run starts with the exact Chrome
  build, flags and harness pointed at a **loopback server that logs every request it receives**, and
  fires fetch, keepalive, `sendBeacon`, image, XHR, iframe, dedicated-worker fetch, link prefetch,
  speculation-rules prefetch + prerender, CSP/Reporting API reports, WebSockets (four ways, incl. a
  worker), a SharedWorker, a service-worker registration, a popup and a pagehide beacon at
  probe-only collection paths. It asserts on the **receiving side** that nothing arrived, that the page
  itself did arrive through the proxy (liveness), and that the proxy refuses an unlisted host. If any
  expectation fails, the run aborts before touching openart.ai.
- **Zero-leak proof per run** ([`src/observe/leakproof.ts`](src/observe/leakproof.ts)), fail-closed
  (missing evidence is never "clean"): browser-level and page Fetch were live with >0 decisions and
  the proxy carried the traffic; every collection request was failed (failRequest ok); an
  *independent* classifier (the research's vendor regexes + the rest of the endpoint inventory)
  re-audits every allowed request, including the watchdog's own third-party GETs; the Network event
  stream shows no failed request received a response and **every** network request Chrome made is
  accounted for — by its own Fetch decision, or as provably undelivered (blocked by Chrome, its CORS
  preflight failed by the seal, or a third-party host the proxy never connected to); no marker reached
  a third party; the proxy tunnelled first-party hosts only; no WebSocket, running service worker,
  popup or Reporting API report; the Chrome tree is dead, nothing references the profile, the profile
  is deleted, and the proxy was sealed before the kill. Any violation → `FAILED`, exit 2, Slack alert.
- **Hermetic proofs in the test suite**: `test/interceptor.int.test.ts` (real Chrome against a
  loopback server: collection paths, POSTs, the SW script and WebSocket handshakes never arrive;
  third-party SDKs reach the page only via the watchdog fetch), `test/consent-geo.int.test.ts`.
- **Isolation**: own Chrome via the pipe transport (no debugging port; port 9333 is never touched), a
  fresh `--user-data-dir` under `packages/watchdog/.profiles/` per session, deleted afterwards;
  anonymous only (no accounts, no forms submitted — the sign-up wall is closed, never filled — no
  checkout; the Stripe CLI is never used). `results.json` records no hostname or home-directory paths.
- **Traffic budget**: ~26 OpenArt page loads per full run with the six default isolated replay
  scenarios (hard cap `--max-page-loads`, default 60). All replay page loads are reserved before the
  batch starts; journeys retain 3–10 s dwell and quiet-network waits. Replay sessions prepare in
  parallel and dispatch together after sealing. Three container GETs; no retries in the scheduled job.

---

## Baseline 2026-09-30 (live)

`npx tsx src/cli.ts run --target live --out reports/baseline-2026-09-30` — run
`2026-09-30T17-19-26-309Z-ODE7HJ`, 21 page loads, ~10 min. [report.html](reports/baseline-2026-09-30/report.html) ·
[results.json](reports/baseline-2026-09-30/results.json)

**Contract: 19 / 19 FAIL (0 ERROR, 0 SKIP) — today's reds, each with decoded evidence:**

| Check | Observed on the live site |
|---|---|
| `signup.google_ads.user_data` | the real `signup` push reaches no Google Ads conversion at all (the rVk2 tag waits for `new_user_signed_up`) |
| `purchase.linkedin.value_and_event_id` | LinkedIn purchase hit carries neither value nor event id |
| `purchase.x.single_deterministic_event` | 2 X purchase events (explicit + automatic `gtm_purchase`), random ids |
| `signup.tiktok.event_id` | `CompleteRegistration` with `event_id: ""` |
| `business_subscription.consumed` | no platform converts it (3 diagnostic hits only) |
| `generation.google.no_auto_form_events` | Generate → 2 `form_start` + 2 `form_submit` Google events |
| `spa.page_views.*` | per soft route: Google Ads 0/0/0 · Meta 3/3/1 · TikTok 2/1/1 · Reddit, LinkedIn, X 0/0/0 · UET 3/3/1 |
| `meta.fbc.multi_hop` / `meta.fbc.return` | 0/3 app-page Meta hits carry fbc, `_fbc` absent |
| `openai.oppref.marketing_landing` | 4 OpenAI SDK hits on the app, none with the oppref |
| `google.gbraid_wbraid.persisted` | `oa_ad_clids` ends with fbclid only (gbraid/wbraid lost) |
| `webview.handoff.attribution` | the handoff URL is `https://openart.ai/home` — no click id, UTM or token |
| `consent.eea_uk_ch.defaults` | DE, GB and CH probes (geo rewritten on 2 loaders each): 12/12 Google hits `gcd=13l3l3l3l1l1` — no default at all |

**Click-ID coverage** (click id in the platform's dedicated field on an app-page hit; standard browsers):
Google Ads 100% (4/4) · **Meta 50% (2/4)** — lost on the multi-hop and return journeys · TikTok 100% (4/4) ·
Reddit 100% (3/3) · LinkedIn 100% (3/3) · X 100% (3/3) · Microsoft UET 100% (3/3) · **OpenAI Ads 0% (0/4)**.
With uBlock Origin's default lists: 0% for every platform (`$removeparam` strips the ids before the request).

**Zero-leak proof: PROVEN** — 14 browser sessions (seal self-test, replay load + full seal, 8 journeys,
3 consent probes): 1,181 collection attempts, **0 completed**; 4,505 requests seen, 3,165 allowed
(348 of them third-party SDK/font GETs fetched by the watchdog itself), 1,340 failed locally, 0 network
requests unaccounted for; the proxy tunnelled only `openart.ai`, `cdn.`, `clerk.`, `i18n.openart.ai`;
the Google tag gateway's service-worker registration was refused in every page; all profiles deleted.
**Container: UNCHANGED** — GTM-56CMP8K v25 on both loaders (hashes agree), gtag config v4.
**First-party requests outside the allowlist: none.**

---

## Limits (read before quoting results)

- The replay reproduces the app's **calls**, not the app: Meta `fbq` and OpenAI `oaiq` conversion
  calls live in app code and are not replayed (same limit as research/11 §8). Server-side acceptance,
  dedup and matching are invisible from the browser.
- Consent probes rewrite the Google geo **locally**; a CMP that geolocates by its own service, or
  Cloudflare-side logic keyed on the real exit IP, needs a real EEA/UK/CH vantage to confirm.
- One anonymous US vantage, desktop Chrome headless (+ an Instagram iOS UA). Safari/ITP and logged-in
  states differ. The uBO journey simulates the default lists with a validated engine (663/664 verdicts
  identical to @ghostery/adblocker on the saved requests; the one difference is documented), not the
  real extension; `redirect=` surrogates are treated as blocks.
- The in-page part of the seal (WebSocket / service worker / popup refusal) is JavaScript: hostile
  page code could in principle reach a pristine constructor. That cannot reach a third party (no
  route), and for first-party hosts the proof fails on any WebSocket, running service worker or popup
  that appears — the watchdog would report, not hide, such a bypass.
- The first-party allowlist is derived from today's journeys; a new read-only API used by the pages
  is failed (and listed) until it is added — the page may then render slightly differently.
- The in-app-browser overlay is observed when it opens; otherwise the check uses `location.href`
  (what Option 2 copies, by code) and is marked *inferred*.

## Layout

```
src/cli.ts              CLI            src/run.ts           orchestration + results assembly
src/policy/             collection seal (collection rules, first-party allowlist, render list)
src/browser/            harness, Fetch handler, third-party fetch, in-page seal (pagejs.ts)
src/pilot.ts            loopback seal self-test          src/replay/  sealed replay
src/journeys/           the 8 journeys                   src/vendors/decode.ts  per-vendor decoding
src/contract.ts         evaluator (validity gates)       scenarios/contract.json  target behaviour
src/observe/            click ids, page views, coverage, zero-leak proof
src/container/          parse / hash / diff / fetch      baselines/  v25 container + v4 config
src/ubo/engine.ts       uBlock default-list simulation   src/patches/ inject / edge-sim / container patches
src/report/html.ts      report.html    src/alert/slack.ts   Slack webhook
src/legacy/             copied research tools (sealed_replay.cjs, gatekeeper_proxy.cjs, decode.cjs), changes marked [watchdog]
test/                   vitest; fixtures derived from the saved captures (scripts/build-fixtures.ts)
```

The three `src/legacy/*.cjs` files are copies of the proven tools behind
`research/11_sealed_replay_verification.md` (original SHA-256 in each header); the journey logic ports
`crawl/teardown2/harness.cjs` + `run.cjs` with attribution.
