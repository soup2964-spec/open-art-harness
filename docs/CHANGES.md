# Every change, in detail

This is the complete record of what `open-art-harness` changes about OpenArt's growth measurement: what is wrong today, what each fix does, exactly where it plugs into OpenArt's existing systems, and how each one was proven. Everything described as "today" was observed on openart.ai or in its shipped code on 2026-09-29/30. Nothing in this repo has ever sent data to OpenArt or any ad platform.

Companion documents: [PROOF.md](PROOF.md) (the before/after run), [integration-map.md](integration-map.md) (every touchpoint), [30-60-90.md](30-60-90.md) (rollout order).

---

## Part 1 — How OpenArt's tracking works today

Understanding the fixes requires the current picture, all of it verified.

**Three front-ends, three different tag sets.**
- The marketing site (`/`, `/ai-model/*`, `/blog`) is an Astro site on Cloudflare Pages. It carries GTM, Amplitude, Clarity and an inline "click-ID shim", but **no Meta pixel**.
- The app ("Suite": `/home`, `/suite/*`, `/pricing`) is Next.js. It carries GTM, a hard-coded Meta pixel, the OpenAI Ads pixel, Amplitude, Clarity, Hotjar, Statsig and Chargeblast.
- A legacy app (`/image`, `/video`, `/story`) carries a different set again, including a GA4 property that exists nowhere else.

**One GTM container (GTM-56CMP8K, version 25)** with 18 tags, served both from googletagmanager.com and first-party through Google's tag gateway at `openart.ai/4vu8/`. Its triggers listen for four dataLayer events: `purchase`, `first_purchase`, `signup`, and `new_user_signed_up`.

**Nine ad destinations:** Google Ads (two accounts, AW-11252321380 and AW-16854695811), Meta (pixel 843671884361709 plus OpenArt's own Conversions API Gateway on AWS), TikTok, Reddit, LinkedIn, X, Microsoft UET, and OpenAI (ChatGPT) Ads.

**What already works well** (and is therefore not touched): the Meta CAPI Gateway with event-ID de-duplication; first-party Google tag serving; Enhanced Conversions on purchases (verified: Google receives the email in encrypted form); a server-side click-ID store at `POST /api/user/ad-click-ids`; a post-checkout invoice lookup that returns a lifetime-value figure; and one user ID shared by Stripe (customer ID), Amplitude (user ID), the credit ledger (`userId`) and Meta (`external_id` = SHA-256 of the lower-cased ID).

---

## Part 2 — The defects, one by one

Each defect below is numbered D1–D16. Later sections refer back to these numbers.

### Conversions

**D1. The Google Ads signup conversion has never fired.** GTM tag 17 (label `rVk2CJ7Ot8EZEOSYw_Up`) fires only on the dataLayer event `new_user_signed_up`. The app's signup code pushes `{event:"signup", user_data:{email}}` instead. A search of ~1,090 saved OpenArt JavaScript files found no emitter of `new_user_signed_up`; the only matches are copies of the GTM container itself. The sealed replay confirmed it: the real `signup` push sends nothing to Google, and when `new_user_signed_up` is pushed artificially, the tag fires with `value=0` and no user data.

**D2. Each platform receives a different "purchase".** From the replay of the app's real purchase pushes:
- Google Ads (both accounts): every new subscription, at the actual first-invoice amount, with order ID `sub_<invoiceId>` and encrypted email.
- Reddit: every purchase, with a SHA-256 of the order ID as its dedup key, no email on a fresh page.
- LinkedIn: a conversion ID only. **No value, no event ID.**
- X: **two** purchase events per sale (the explicit conversion plus an automatic `gtm_purchase` from the base pixel), each with a random event ID.
- TikTok: first purchase only (fires on `first_purchase`), valued at lifetime value, with event ID `sub_<invoiceId>`.
- Meta: first purchase only, valued at lifetime value in the `value` field (not Meta's `predicted_ltv` field), event ID `purchase_<invoiceId>`.
- Microsoft UET: every purchase, from a direct app call.
- `business_subscription` and gtag `purchase_first` are pushed by the app and consumed by nothing.

**D3. Nothing after the first charge reaches any platform from the browser.** Renewals, upgrades, add-on credit packs, one-time packs, refunds and chargebacks are handled by the app only as screen refreshes. Whether the backend sends any of these server-side is not visible from outside.

**D4. The fallback purchase value is wrong.** If the post-checkout invoice lookup fails (it retries once after 2 seconds, then gives up), the app reports the purchase from a stale price table in which annual plans are listed at half the monthly price (Starter annual = $7) with a transaction ID built from `Date.now()`, which can never be de-duplicated.

**D5. TikTok's signup event has an empty `event_id`.** So a server-side twin could never de-duplicate against it.

**D6. Automatic form events fire on every generation.** Google's tag treats the prompt box as a form and sends `form_start` and `form_submit` on every click of Generate (two of each, observed). Meta's pixel sends `SubscribedButtonClick`, X sends `autobuttonclick`. None of it is a conversion, but it is noise in every platform's event stream.

### Click IDs and attribution

**D7. Meta loses the click on multi-page and return journeys.** The Meta pixel is absent on marketing pages, and no OpenArt code builds Meta's `_fbc` cookie from the `fbclid` the shim stores. Live tests: landing → direct CTA → app keeps the click (Meta's pixel reads it from the referrer); landing → a second marketing page → app loses it; a later typed visit loses it. The loss applies to both the browser pixel and the CAPI Gateway copy.

**D8. ChatGPT-ads click refs (`oppref`) are always lost on marketing-page landings.** The OpenAI SDK runs only in the app and reads only the current URL.

**D9. Google's iOS click IDs (`gbraid`, `wbraid`) never reach the server store.** The marketing shim saves them, but the app's click-ID module keeps only four keys (`gclid`, `fbclid`, `msclkid`, `ttclid`) and overwrites the stored JSON. The checkout form posts only `gclid`. Reddit's `rdt_cid` is dropped the same way.

**D10. The in-app browser handoff drops everything.** Inside Instagram and TikTok's in-app browsers, the "Trouble redirecting? Open page in your browser" option copies `window.location.href`. After the first navigation that URL is `https://openart.ai/home`, with no click IDs, UTMs or token. The external browser starts with an empty cookie jar. Google sign-in stays enabled in these browsers even though Google blocks OAuth inside embedded webviews.

**D11. Ad-blocker users are invisible to every browser signal.** uBlock Origin's default "Privacy" list strips `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `twclid` and `ttclid` from the URL before any request is sent, and blocks every pixel, Amplitude, and OpenArt's own `/4vu8/` tag path. For these users the CAPI Gateway receives nothing, because the pixel that feeds it is blocked. About 30% of US internet users block ads.

**D12. Click IDs live in JavaScript-set cookies.** Safari's tracking prevention caps script-set cookies at 7 days (24 hours for some link-decorated landings). Only `oa_device_id` is server-set.

### Page views, consent, forms

**D13. Page views are miscounted on every platform.** Measured on real in-app navigation: Google Ads, Reddit, LinkedIn and X send zero page views on route changes (their base tags fire only on hard loads). Meta sends up to 3 per navigation on some routes, UET up to 3, TikTok 2. Legacy Amplitude logs up to 6.

**D14. No consent handling.** No consent-management platform, no Consent Mode. All 348 captured Google hits carry `gcd=13l3l3l3l1l1` (every consent signal "not set"). None of the 18 GTM tags is consent-gated. Google auto-collects user-provided data, and about 72% of desktop traffic is non-US.

**D15. The enterprise form mislabels every lead.** The HubSpot form on `/enterprise` (portal 244977254, form `9f0b1fda-34f1-4364-93d5-bdc196c44004`) has hidden fields hard-coded to `lead_source = "Event"` and `lead_source_detail = "Brandweek"` (last edited 2026-09-16). It has hidden `gclid`/`gbraid`/`wbraid` fields that nothing fills, no UTM or LinkedIn fields, and no HubSpot tracking code on the page.

**D16. Smaller defects.** The marketing shim `console.log`s every click-ID value; TikTok's `ttclid` cookie lasts one day; the checkout success URL carries `quantity=undefined`; `ga_client_id` is empty at checkout for Suite users (GA4 runs only on legacy routes); the app loads the GTM container twice; the homepage sends a `Clear-Site-Data: cache` header on most visits.

---

## Part 3 — The changes

### 3.1 Watchdog (`packages/watchdog`) — a daily, sealed test of their live tracking

**What it is.** A CLI (`npx tsx src/cli.ts run --target live|patched`) that opens openart.ai in a locked-down browser, replays the app's real conversion events, walks the ad-click journeys, probes consent, diffs the GTM container, and grades 19 checks.

**The seal.** Every request to a collection endpoint (Google Ads, `/4vu8/` collection paths, `facebook.com/tr`, the CAPI Gateway, TikTok, Reddit, LinkedIn, X, Bing, Amplitude, Clarity, Hotjar, Tolt, OpenAI) is intercepted, recorded and failed locally. The browser can reach only openart.ai hosts; third-party scripts are fetched by the watchdog itself. Prefetch, prerender, service workers, WebSockets, popups and the Reporting API are disabled. Every profile is deleted after its run. Proof of zero leakage is part of every report (1,181 attempts blocked in the baseline run, 1,172 in the patched run, none completed).

**The 19 checks** (`scenarios/contract.json`), each mapped to a defect above:

| Check | Defect |
|---|---|
| `signup.google_ads.user_data` | D1 |
| `signup.tiktok.event_id` | D5 |
| `purchase.x.single_deterministic_event` | D2 |
| `purchase.linkedin.value_and_event_id` | D2 |
| `business_subscription.consumed` | D2 |
| `generation.google.no_auto_form_events` | D6 |
| `spa.page_views.{google_ads, meta, tiktok, reddit, linkedin, x, microsoft_uet}` (7) | D13 |
| `meta.fbc.multi_hop`, `meta.fbc.return` | D7 |
| `openai.oppref.marketing_landing` | D8 |
| `google.gbraid_wbraid.persisted` | D9 |
| `webview.handoff.attribution` | D10 |
| `consent.eea_uk_ch.defaults` | D14 |

**Journeys** replayed with synthetic click IDs: Meta one-hop, multi-hop and return; `oppref` landing; `gbraid`/`wbraid` persistence; an Instagram in-app browser session; a uBlock-stripped landing (using uBlock's actual default filter lists); in-app route changes; consent probes for DE, GB and CH.

**Patch inputs.** `--patch-container` and `--patch-gtag-config` serve a modified GTM container or Google tag config in place of the live one for both loaders; `--inject-script` inserts a script at the top of every document; `--edge-sim` applies a Cloudflare Worker simulation's `Set-Cookie` headers to document responses. These are how the "after" run is produced without touching OpenArt's servers.

**Output.** `results.json` plus `report.html`: a red/green table per check with evidence, click-ID coverage per platform, a consent summary, the container diff and the zero-leak proof.

**Scheduling.** `infra/watchdog/`: a Dockerfile (headless Chrome + Node), a Cloud Run Job and Cloud Scheduler config, a Slack-webhook alert on any FAIL or container change, and a GitHub Actions alternative. Nothing is deployed.

**Result.** Live baseline: 0 of 19 pass. With the fixes: 18 of 19.

### 3.2 Web fix pack (`packages/web-fixes`) — the browser-layer fixes

**GTM: a merge-mode import** (`gtm/import/openart-gtm-fixpack.json`: 14 tags, 5 triggers, 13 variables, 1 custom template) plus `gtm/CHANGES.md`, a click-by-click guide for the GTM and Google Ads UIs. Merge mode means only the new and changed items are added; nothing in the container is replaced. The tags:

| Tag | Fixes |
|---|---|
| Google Ads signup conversion (rVk2) re-triggered on `signup`, with a user-provided-data variable from `user_data.email` and order ID `reg_<uid>` | D1 |
| Google Ads `business_subscription` as a secondary conversion action (label placeholder until created) | D2 |
| X base pixel with the automatic `gtm_purchase` disabled (`twq('set','dataLayerTracking','false')` before `config`) | D2 |
| X signup with deterministic `conversion_id reg_<uid>` | D2 |
| TikTok CompleteRegistration with `event_id reg_<uid>` | D5 |
| LinkedIn purchase value variant via `lintrk` (**paused**; see the LinkedIn note) | D2 |
| LinkedIn server-only purchases via conversion-service (option b, **paused**) | D2 |
| A "route settler" History Change trigger emitting `virtual_page_view` once per route change, de-duplicated across Next.js's double history updates | D13 |
| Google Ads, UET and TikTok page-view tags on that trigger, with UET's and TikTok's own SPA tracking switched off | D13 |
| Consent Mode v2 defaults: denied in EEA/UK/CH, granted elsewhere, via a custom consent template (fires early enough; a Custom HTML tag does not), with `ads_data_redaction` and `url_passthrough` | D14 |
| The Google tag's automatic form-interaction events turned off (`gtm/proof/patched_gtag_config.js`) | D6 |

**The LinkedIn decision.** The Insight Tag has no documented value field. LinkedIn keeps the browser event when browser and server IDs match, so a server-side value is discarded unless the browser purchase tag is removed. Two options ship, both paused: (a) the undocumented `val` parameter on the browser tag; (b) disable the browser purchase tag and let `conversion-service` send LinkedIn purchases with value. This is the one check that stays red until OpenArt chooses.

**Drop-in click-ID script** (`shim/`, built to `dist/openart-click-id-shim.min.js`): a replacement for the inline marketing-page shim that keeps all of its existing behaviour (cookies, `oa_ad_clids` `{v,ts}` format, the Impact POST, Tolt) and adds: all ten click-ID keys stored (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`, `rdt_cid`, `twclid`, `li_fat_id`, `oppref`); `_fbc = fb.1.<ms>.<fbclid>` minted per Meta's rules on `.openart.ai` for 90 days; `__oppref` for 30 days so the OpenAI SDK's cookie fallback works; a UTM cookie; every stored or posted value validated against a length-and-charset pattern (3.8 KB values and `<img…>` payloads rejected); and no console logging. Fixes D7, D8, D9, D16.

**App patches** (`app-patches/`, each placed by chunk and module ID in their shipped code, documented in `PATCHES.md`):
- `click-id-keys.ts`: the full key list for the store, the migration payload and the checkout hidden inputs; first-seen timestamps preserved (D9).
- `signup-push.ts`: adds `user_id` to the `signup` push so GTM can set `reg_<uid>`; validates the email from the `oa_signup_uid` cookie; pushes once via a marker set before the push (D1, D5).
- `page-view-contract.ts`: a Next.js App Router hook emitting exactly one `virtual_page_view` per route change; sets `fbq.disablePushState = true` and sends Meta's PageView once with an event ID (D13).
- `legacy-amplitude-init.ts` + `legacy-amplitude-dedupe.md`: the cause and fix for the 6× page views in the legacy app (D13).
- `fallback-purchase.ts`: never reports stale fallback values; skips client conversions when the invoice lookup fails and lets the server send them; deterministic `in_…` IDs only (D4).
- `webview-handoff.ts`: builds the handoff URL from allow-listed click IDs and UTMs, or a short token from the edge Worker; hides Google OAuth when the webview detector matches (D10).
- `attribution-snapshot.ts`: a helper for choosing the purchase value field (`profitValueMajor` → `ltvValueMajor` → cash) with `value_basis` recorded (see 3.5).

**HubSpot** (`hubspot/`): `FORM_FIX.md` removes the hard-coded `Event`/`Brandweek` defaults and adds `utm_*`, `li_fat_id`, `fbclid` and `ttclid` hidden fields with the property definitions to create; `src/hubspot-fill.ts` fills the hidden fields from `oa_ad_clids`, `_fbc` and the UTM cookie through HubSpot's embed API (D15).

**Consent** (`consent/`): `CONSENT.md` with certified-CMP options, region scoping and how consent flows to server events; `privacy-signals.ts`, shared by the GTM defaults, the shim and the HubSpot fill, honours the browser's Global Privacy Control signal, an `oa_consent` opt-out cookie and the IAB `usprivacy` string (D14).

**Proof files for the watchdog**: `gtm/proof/patched_resource.json`, `patched_gtag_config.js`, `inject_web_fixes.min.js`, and `variants/` for the LinkedIn options. 279 tests; `build --check` confirms the committed outputs are fresh.

### 3.3 Edge attribution (`packages/edge-attribution`) — server-set capture at Cloudflare

OpenArt already routes all traffic through Cloudflare Workers, so this ships as a **module** (`withAttribution(handler, options)` wraps their existing fetch handler; `captureAttribution(request, env, ctx, options)` for finer control), not a new proxy.

On document navigations only (bots, prefetch and assets skipped), it:
- parses every click ID (`gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `msclkid`, `ttclid`, `twclid`, `li_fat_id`, `rdt_cid`, `oppref`, `irclickid`/`im_ref`, `epik`, `ScCid`), all UTMs, the referrer and the landing path;
- sets **server** cookies, which Safari's tracking prevention does not cap: `oa_attr` (HttpOnly, HMAC-signed with `ATTRIBUTION_SECRET`, first-touch plus last-touch, 13 months), a server-set `oa_ad_clids` in the existing `{key:{v,ts}}` format merged with the client's value, `_fbc` minted per Meta's rules, `__oppref` (30 days), and `ttclid` with a 28-day life (D7, D8, D9, D11, D12, D16);
- persists the record keyed by `oa_device_id` to KV (90-day TTL) via `ctx.waitUntil`, never blocking the response, or POSTs it to an origin endpoint that extends the existing `/api/user/ad-click-ids` shape. `mergeAttributionForSignup()` is the backend merge spec as runnable code;
- serves the in-app browser handoff: `POST /api/attribution/handoff` returns a short opaque token (KV, 30 minutes, **single-use**, allow-listed params and target path only, credential-looking paths refused); `GET /r/:token` restores the attribution cookies in the external browser and redirects to a same-origin path (D10);
- gates everything on consent: outside the EEA/UK/CH, eligible unless a Global Privacy Control signal, a US sale/sharing opt-out or an explicit denial is present; inside, advertising cookies need an explicit grant, and only non-identifying UTMs are stored before a choice. Cookiebot and OneTrust cookie parsers are included.

`dist/edge-sim.js` exposes the same cookie logic as `simulate(requestUrl, requestHeaders)` for the watchdog's `--edge-sim` option and is byte-consistent with the Worker. On a uBlock-stripped landing it still produces a signed `oa_attr` with the UTMs, the surviving `li_fat_id`/`rdt_cid`, and `__oppref`; combined with server-side conversions carrying hashed email, blocked users become attributable at campaign level. 339 tests, including a ReDoS fix in bot detection, a forged-device-ID path, and 45 hand-broken rules all caught.

### 3.4 Contracts (`packages/contracts`) — the shared foundation

Everything else imports from here.
- **Canonical events**: `signup`, `activation_first_generation`, `checkout_started`, `purchase_first`, `purchase_renewal`, `purchase_upgrade`, `purchase_add_on`, `purchase_one_time_pack`, `refund`, `chargeback`, `enterprise_lead`, `lead_stage_change`. JSON Schema 2020-12, TypeScript types and zod validators, with a compile-time drift guard between them.
- **ID rules that reuse the browser's IDs exactly**: signup `reg_<uid>`; purchases `purchase_<invoiceId>` for Meta/OpenAI and `sub_<invoiceId>` as the order ID for Google, Reddit, X, TikTok, Microsoft and LinkedIn; Reddit's dedup key is SHA-256 of `sub_<invoiceId>`, which is what its pixel sends.
- **Per-platform hashing and normalisation** (Reddit and Microsoft strip dots from every local part; Google only for gmail addresses; Meta lower-cases the external ID), verified against `node:crypto` on 3,305 cases.
- **`PlatformEventMapping`**: 84 rows stating, per canonical event and platform, the platform event name, dedup key, value field and user-data fields. Rows that would double-count until the web fixes land are flagged `requires_web_fix`.
- **Consent**: `CONSENT_REQUIRED_REGIONS` (EEA including outermost regions, GB/UK, CH) as the single source of truth, plus `gpc` and `opt_out_sale_sharing` fields on the consent object.
- **`PurchaseValueScore`**: the ad-value contract (see 3.5), with point-in-time invariants.
- **Source schemas** for Stripe events, the credit ledger entry (the exact observed shape: `type ADD|CONSUME`, `businessType "<model>:<mode>"`, `unitCredits`, `idempotencyKey`, …), Amplitude's BigQuery export rows, and HubSpot submissions.
- **Fixtures**: synthetic Stripe, ledger, Amplitude, click-ID and HubSpot data that validate against those schemas; a seed of 109 model costs at public list prices; and a deterministic 2,000-user synthetic cohort generator whose behaviour parameters are explicitly labelled illustrative.

### 3.5 Conversion service (`packages/conversion-service`) — server-side fan-out

A TypeScript service for Cloud Run (`node:http`, no framework) that turns Stripe and app events into one canonical conversion each and sends it to every platform.

**Inputs.** `POST /webhooks/stripe` (offline signature verification; `checkout.session.completed`, `invoice.paid` with `subscription_create`/`cycle`/`update`, `invoice_payment.paid`, `customer.subscription.updated`/`deleted`, `charge.refunded`, `charge.dispute.created`), `POST /events` for signup, activation, checkout started, enterprise lead and lead-stage change, a Pub/Sub alternative if OpenArt already has a webhook handler, and `GET /healthz`.

**Pipeline.** Normalise → ledger writer (BigQuery streaming insert) → value resolver → click-ID resolver (builds `fbc` from the stored `fbclid` and its `created_at`) → consent resolver (re-decided at send time, not just at enqueue) → an idempotent outbox per (platform, event_id) mirroring the ledger's `idempotencyKey` pattern, with backoff, dead-letter, per-document isolation of parked events, lease renewal, and out-of-order Stripe events parked until their join arrives.

**Senders**, each with a request schema validated against official docs: Google Data Manager API (the required route for new offline-conversion setups since 2026; the same `transactionId` as the browser tag lets a server value override the tag's), Meta CAPI (same `eventID`s, `external_id` lower-cased like the browser, `fbc`/`fbp`, `action_source=system_generated` for renewals, the 7-day guard), TikTok Events API, Reddit CAPI, LinkedIn CAPI, X CAPI, Microsoft UET CAPI. Dry-run by default: payloads are written to an output directory; the live mode requires explicit configuration, refuses in-memory stores and example secrets, and is never exercised by tests. Fixes D2, D3 (server side).

**Refunds and chargebacks.** Google: a value restatement, sent at least 24 hours after the original, within 54 days, and only if the original's send is confirmed (an unmatched adjustment would create a phantom conversion). Microsoft: restate or retract. Meta, TikTok, Reddit, LinkedIn, X: no retraction exists, so the service skips and records why. Refund risk is therefore priced into the predicted value instead.

**Value.** The conversion value is the **purchase-time** `PurchaseValueScore` (expected 90-day gross profit given the purchase), looked up by event ID within an SLA; otherwise the cash amount, tagged `value_basis=cash_fallback`. Loss-makers are floored but recorded (`value_floored`, `value_raw`). A `value-health` command reports floor share, fallback share, distinct-value count and max/min spread per platform against Meta's thresholds (100+ conversions, 5+ distinct values, max ≥ 3× min over 14 days).

**The Meta dedup reality.** Meta keeps the first copy it receives, which is the browser pixel. So a server-only profit value would reach only blocked users. The seamless fix: a `GET /value?invoice_id=` endpoint so OpenArt's existing `/legacy/api/stripe/checkout-session-invoice` can return the same value as a new field, `profitValueMajor`; the browser's purchase tags then send it too (helper in `web-fixes/app-patches/attribution-snapshot.ts`), and pixel and server agree.

**Retention and erasure.** Firestore TTLs, BigQuery partition expiry, terminal records blanked of identifiers, and `POST /tasks/erase` by user ID. 286 tests; the end-to-end test replays 27 Stripe events and 10 app events through the real server with a fetch mock that fails the run on any network call.

### 3.6 Warehouse (`packages/warehouse`) — dbt on BigQuery, runs locally on DuckDB

43 models (18 staging, 16 intermediate, the marts below), cross-database macros so the same SQL compiles for BigQuery and DuckDB, incremental `insert_overwrite` on Amplitude staging with partition and cluster recommendations.

| Mart | What it holds |
|---|---|
| `fct_conversion_ledger` | one row per canonical event, IDs in the browser's formats, refunds and chargebacks linked to purchases (via `invoice_payment.paid` and the purchase's own payment-intent/charge keys), `requires_web_fix` flags |
| `fct_data_quality_quarantine` | rows that fail validation, so one unexpected event type no longer blocks the build |
| `fct_generation_cost` | credit-ledger `CONSUME` rows × the model-cost seed, with a vendor-discount variable and route overrides |
| `fct_user_features_24h` | plan, interval, first-24h model mix, credits burned, video share, arm, country, device, channel, every feature time-bounded to the window |
| `fct_predicted_profit_24h` (+ `_log`) | the signup+24h **unconditional** expected 90-day profit per exposed user, for experiment and bandit readouts only |
| `fct_purchase_value_score` (+ `_log`) | the **purchase-time** expected 90-day gross profit given the purchase, the value sent to ad platforms |
| `fct_experiment_exposures`, `fct_experiment_profit_by_arm`, `fct_experiment_profit_by_arm_daily` | intention-to-treat readouts per flag and arm, per day × segment × slice, with model-error variance, early payers stratified, matured fixed-horizon outcomes, profit decomposed as p·V−C, and a CUPED covariate |
| `fct_audience_candidates` | seeds and suppression lists with consent flags |
| `fct_reconciliation` | Stripe truth vs warehouse vs platform-reported conversions, with every gap split by cause: attribution window, click-vs-conversion date basis, time zone, refunds, double counting (both Google accounts, X), lifetime-value-in-value (Meta), blocked users, fallback misvaluation |
| `dim_model_parameters` | every coefficient with its label and a snapshot of fitted values, referenced by each score's `fitted_params_ref` so any sent value is reproducible |

Currency handling uses a currency-exponent seed, FX conversion and `total_excluding_tax`. Subscription status uses the invoice line's service period (the invoice-level field looks back one period). PII is whitelisted at staging; Metabase gets aggregate-only views.

**Accuracy, honestly.** The in-sample check is labelled a plumbing check. An out-of-time backtest (fit on earlier synthetic cohorts, score later ones with complete 90 days) shows the purchase-time score beating first-charge revenue (capped error $10.93 vs $19.96, calibration slope 1.08, 79% of purchases inside the 80% interval). This is synthetic data: it proves the pipeline, not real-world accuracy. `docs/VALIDATION_PLAN.md` sets the real test: 2–4 weeks shadow, an out-of-time backtest on OpenArt's data, replay of past A/B tests, then a lift test.

Also: `docs/week1-sizing-queries.md` (BigQuery against OpenArt's real event and property names, bounded to the right windows), five Metabase questions, and `scripts/build.sh` (fixture load → dbt build → contract export → pytest → vitest → BigQuery compile). 505 dbt checks, 66 Python tests, 41 TypeScript tests; 27 of the database reviewer's 29 injected bugs are caught (the other two broke the harness, not the tests).

### 3.7 Bandit allocator (`packages/bandit-allocator`) — profit-rewarded default-model allocation

OpenArt assigns each user's default image and video model through LaunchDarkly flags (`suite-default-model-create-image`, `-create-video`), hand-tuned (28 and 27 edits). The allocator replaces the hand-tuning with Thompson sampling, one posterior per arm per segment (country bucket × device × acquisition channel), rewarded on the 24h unconditional profit signal decomposed as p·V−C (Beta-Binomial conversion rate, pooled winsorised value, measured cost per arm) for lower variance, with a CUPED hook.

Guardrails: a 5% exploration floor per arm, at most ±10 points of weight change per day, a fixed holdout slice the job never edits, a sequentially valid stop-loss (an always-valid confidence sequence on day-matched two-sample contrasts; the earlier point-estimate rule fired on 65–78% of null arms, this one on 0–2%), a fail-closed sample-ratio-mismatch check of every slice against logged per-day weights, an MDE-based minimum sample, a 14-day half-life, inverse-propensity weighting with logged propensities, resets on model or promo changes, warm-start shares for new arms, and activation/refund/failed-generation guardrails against the holdout.

Output: one LaunchDarkly semantic-patch request per flag, submitted through LaunchDarkly's approval workflow with a comment explaining each weight move, plus a report. **No app code change.** 163 tests.

Simulation (illustrative, 60 days × 2,000 signups/day × 10 replications): any bandit beats the hand-tuned split (regret per 1,000 users: fixed split 1,699, conversion bandit 808, profit bandit 791); profit vs conversion is not distinguishable on this synthetic cohort. Where profit rewards should matter is where credit prices stop tracking cost, such as 0-credit "unlimited" promos.

### 3.8 Audience sync (`packages/audience-sync`)

From the warehouse's audience candidates: two seed lists (top predicted-profit decile; positive predicted profit) and four suppression lists (active subscribers, fraud or chargeback, refunded, low predicted profit), consent-filtered using the contracts region list and the GPC/opt-out signals. Per-platform payloads for Google Customer Match (Data Manager API), Meta Custom Audiences and TikTok, with each platform's hashing rules, batch limits and minimum sizes; removals via diffs against the previous snapshot (keyed on identifier and value bucket, so a changed value re-uploads). Dry-run only. 78 tests.

---

## Part 4 — How it was built and checked

1. **Research** (2026-09-29): eight agents mapped OpenArt from outside (public site, shipped code, tag configs, ad libraries, 13 competitors, pricing and credit formulas, 328 customer reviews, company and leadership, platform rules), plus a logged-in pass with a free account. Every claim went through an independent fact-check; one was refuted (there is no single default model), five softened.
2. **Build** (2026-09-29/30): seven packages, test-first, against fixtures shaped like OpenArt's real payloads.
3. **Proof**: the watchdog's live baseline (0/19) and the patched run (18/19), both zero-leak.
4. **Review**: four independent reviews (security, TypeScript, database, machine-learning/statistics) raised about 60 findings, including one production-breaking bug (every Firestore read would have thrown under Node 22's fetch), a crash on malformed URLs, the profit model being scored at the wrong moment, a stop-loss that fired on most null arms, and warehouse tests that missed 18 of 29 injected bugs. All were fixed, each with a regression test, and the proof was re-run on the final code.

**Totals:** 1,484 TypeScript tests and 505 dbt checks, all passing; 703 files, 35 MB, public at github.com/soup2964-spec/open-art-harness.

---

## Part 5 — What is verified, what is illustrative, what needs OpenArt

**Verified** (on the live site or in shipped code): every defect in Part 2; every tag behaviour, ID format, payload shape and page-view count; the before/after results.

**Illustrative** (labelled in code): the synthetic cohort's behaviour parameters; the predicted-profit coefficients; the simulation results; generation costs at public list prices (OpenArt's negotiated costs are lower).

**Needs OpenArt's systems:** how Stripe webhooks are consumed today; whether Amplitude and the credit ledger already land in BigQuery; real per-model costs; EU consent behaviour (tested from the US only); Google multi-source allowlisting; LinkedIn and X conversion-API access; the LaunchDarkly context key; whether both Google Ads accounts count purchases as primary; whether a HubSpot workflow overwrites `lead_source`; whether the backend already sends anything server-side.
