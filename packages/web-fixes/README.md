# @openart-signal/web-fixes

These are drop-in fixes for OpenArt's **existing** web tagging:

- the GTM container GTM-56CMP8K;
- the inline Astro click-ID shim;
- the Suite and legacy Next.js apps;
- the HubSpot `/enterprise` form;
- Consent Mode.

Every fix keeps OpenArt's identifiers, event names and storage formats. Each folder has a README with exact integration steps.

**Safety.** Nothing in this package sends data anywhere. Tests run offline in happy-dom, and `fetch`, XHR and `sendBeacon` throw in the test window. The proof files are served by the sealed watchdog only.

**Labels** (as in `docs/integration-map.md`)

- **[O]** observed in a capture.
- **[C]** read from shipped code.
- **[I]** inference.
- **[U]** unknown from outside.

## What is fixed, and where

The "Check" column refers to the watchdog baseline of 2026-09-30, which failed all of these.

| Break | Check | Fix | Where it ships | Folder |
|---|---|---|---|---|
| Google Ads signup conversion never fires: its trigger is `new_user_signed_up`, which nothing emits | `signup.google_ads.user_data` | Re-trigger on `signup`, with order id `reg_<uid>` and user-provided data | GTM | `gtm/` B1 |
| TikTok `CompleteRegistration` sends `event_id ""` | `signup.tiktok.event_id` | `event_id reg_<uid>` | GTM | `gtm/` B4 |
| LinkedIn conversions carry no `eventId` or value | `purchase.linkedin.value_and_event_id` | `eventId` (`reg_<uid>` / `sub_<invoiceId>`). Two value alternatives ship paused: server-only purchases via conversion-service (option b) and `lintrk` with value (option c). | GTM | `gtm/` B3 |
| X sends two purchase events per sale (automatic `gtm_purchase` plus the tag) | `purchase.x.single_deterministic_event` | `twq('set','dataLayerTracking','false',…)` before `config`, and deterministic ids only | GTM | `gtm/` B5 |
| `business_subscription` reaches no tag | `business_subscription.consumed` | New Google Ads secondary action | GTM + Google Ads | `gtm/` B2 |
| Reddit SignUp has no `conversionId`; purchases fire with unstable fallback ids | (replay) | `conversionId reg_<uid>`; deterministic-id purchase trigger for Google Ads, Reddit, LinkedIn and X | GTM | `gtm/` B6, B7 |
| Google tag auto-sends `form_start`/`form_submit` on the generation prompt | `generation.google.no_auto_form_events` | Form interactions off | Google tag settings | `gtm/` B11 |
| Page views per SPA route: Google, Reddit, LinkedIn and X send 0; Meta and UET send 3; TikTok sends 2 | `spa.page_views.*` (×7) | One `virtual_page_view` per settled route, used by every platform. The platforms' own history hooks are turned off (UET, TikTok, Meta). | GTM + Suite/legacy | `gtm/` B8–B10, `app-patches/` §3 |
| No Consent Mode signals at all (`gcd=…l1l1`) in DE, GB and CH | `consent.eea_uk_ch.defaults` | Region-scoped v2 defaults (the `packages/contracts` region list), GPC and US opt-outs honoured by the defaults, the shim and the HubSpot fill, `ads_data_redaction`, `url_passthrough`, CMP integration point | GTM + CMP | `consent/`, `gtm/` B12 |
| The Suite keeps only 4 click ids and deletes `gbraid`/`wbraid` on rewrite | `google.gbraid_wbraid.persisted` | All ten keys, merge on write, full migration payload and checkout inputs | Suite | `app-patches/` §1 |
| No `_fbc` after an Astro landing; `oppref` lost on the marketing → app hop | `meta.fbc.*`, `openai.oppref.marketing_landing` | Shim v2 mints `_fbc` and writes `__oppref`, plus the new click-id keys. Every stored or posted value must pass the click-id pattern (the original stored raw URL values). | Astro | `shim/` |
| The `signup` push drops the uid | (feeds `reg_<uid>`) | `user_id` added to the push; the email is validated; at most one push per signup | Suite | `app-patches/` §2 |
| A failed invoice lookup sends a stale list price (annual Starter = $7) with a `Date.now()` id | (replay `purchase_first`) | Skip client conversions and let the server own them. Deterministic `in_…` ids only (the contracts rule). Purchase tags send the server-computed `profitValueMajor` when the backend returns it. | Suite + legacy | `app-patches/` §4 |
| UET purchase has no event id for CAPI dedup | (contract `requires_web_fix`) | `event_id sub_<invoiceId>` | Suite + legacy | `app-patches/` §5 |
| The in-app-browser handoff URL has no click id or UTM; Google OAuth is offered in webviews | `webview.handoff.attribution` | Token URL (edge) or param URL; Google hidden or de-emphasised in webviews | Suite | `app-patches/` §6 |
| Legacy app: up to 6 Amplitude page-view payloads (2–3 kept) per navigation | (P08 capture) | Idempotent Amplitude init | legacy | `app-patches/` §7 |
| The HubSpot form hard-codes `lead_source=Event` / `Brandweek`; no UTMs, `li_fat_id`, `fbclid` or `ttclid` | (form definition) | Remove the defaults, add properties and hidden fields, fill from first-party stores | HubSpot + Astro | `hubspot/` |

## Dedup keys (one id per conversion, shared with `packages/contracts`)

| Conversion | Platform field | Id | Status |
|---|---|---|---|
| Signup | Meta `eventID`, OpenAI `event_id` | `reg_<uid>` | unchanged (app) |
| | Google Ads `orderId`, TikTok `event_id`, Reddit `conversionId`, LinkedIn `eventId`, X `conversion_id` | `reg_<uid>` | **new** (GTM) |
| Purchase | Meta `eventID`, OpenAI `event_id` | `purchase_<invoiceId>` | unchanged (app) |
| | Google Ads `oid` (both accounts), TikTok `event_id` (first purchase), Reddit `transactionId` (and its SHA-256 as `conversionId`), X `conversion_id`, UET `transaction_id` | `sub_<invoiceId>` | unchanged. The unstable fallback ids no longer reach any platform, and X's automatic duplicate is removed. |
| | LinkedIn `eventId` | `sub_<invoiceId>` | **new** (GTM) |
| | UET `event_id` | `sub_<invoiceId>` | **new** (app) |
| Business subscription | Google Ads secondary action `oid` | `sub_<invoiceId>` | **new** (GTM) |

## Rollout order

1. **GTM** (`gtm/CHANGES.md`): import, then the manual edits, preview and publish. It works with today's app code.
2. **Google Ads**: create the business action and paste its label; turn off the Google tag's *Form interactions*.
3. **Astro**: shim v2 on every page; the HubSpot fill on `/enterprise`.
4. **HubSpot**: properties, then the form edits.
5. **Backend**: accept the new `/api/user/ad-click-ids` pairs and the checkout hidden inputs, if validation is strict [U].
6. **Suite release, then legacy release** (`app-patches/PATCHES.md`).
7. **CMP** (a legal decision): consent wiring, then turn off Cloudflare automated script setup and tag the pages manually (`consent/CONSENT.md`).

**Rollback.** GTM: republish v25. The shim, the app patches and the HubSpot fill are single-file reverts.

## Proof files for the watchdog (`packages/watchdog`, sealed replay)

| Flag | File |
|---|---|
| `--patch-container` | `gtm/proof/patched_resource.json`. LinkedIn alternatives: `gtm/proof/variants/patched_resource.linkedin-server-only.json` (B3 option b) and `gtm/proof/variants/patched_resource.linkedin-lintrk-value.json` (option c) |
| `--patch-gtag-config` | `gtm/proof/patched_gtag_config.js` |
| `--inject-script` | `gtm/proof/inject_web_fixes.min.js`: consent defaults, shim v2, and the app-patch stand-ins (`shim/dist/openart-click-id-shim.min.js` alone is the shim-only option) |

**Expected result [I]: not run here, because the watchdog loads openart.ai.**

- **Expected to PASS** (the checks listed in the table above):
  - `signup.google_ads.user_data`, `signup.tiktok.event_id`;
  - `purchase.x.single_deterministic_event`, `business_subscription.consumed`;
  - `spa.page_views.{meta,tiktok,reddit,linkedin,x,microsoft_uet}`;
  - `meta.fbc.*`, `openai.oppref.marketing_landing`, `google.gbraid_wbraid.persisted`;
  - `webview.handoff.attribution`, `consent.eea_uk_ch.defaults`;
  - `generation.google.no_auto_form_events`, if the journey reaches the prompt. The baseline could not: ERROR.
- **Expected to FAIL:**
  - `purchase.linkedin.value_and_event_id` with the default proof. The template sends `eventId` but no value. The `lintrk` variant file (option c) passes; the server-only variant (option b) fails it by design, because LinkedIn then gets purchases from conversion-service only.
  - `spa.page_views.google_ads`, which also counts a container-level `ccm/collect` page view (no `tid`, `gtm=45E…`). That page view appears on hard loads only, and no tag re-fires it. The Ads destination (`tid=AW-11252321380`) gets exactly one per route. Consider counting `tid` streams only.

## Deviations from the brief, and why

1. **LinkedIn purchase `eventId` is `sub_<invoiceId>`, not `purchase_<invoiceId>`.** `packages/contracts` (linkedin `purchase_first`, `dedup_key_template: 'sub_{invoice_id}'`) defines what the conversion service's LinkedIn CAPI twin sends, and LinkedIn dedups only on equal ids. It is one variable (`OA-FIX CJS - purchase order_id`) if the contract changes.
2. **X purchase stays on the existing tag 75, with a trigger swap only.** Its `conversion_id` is already `sub_<invoiceId>`, the contract's X key. The duplicate came from `uwt.js` dataLayer tracking, which the base-tag fix removes.
3. **"Value via LinkedIn CAPI" does not work for purchases the browser also reports.** LinkedIn keeps the Insight Tag event and discards the matching CAPI event (LinkedIn dedup docs). So the import ships two paused alternatives to the default: **option b** pauses the browser purchase conversion and leaves LinkedIn purchases to conversion-service, server-only with value; **option c** sends the value from the browser through `lintrk`, whose `conversion_value` mapping to `val` [C] is undocumented. `gtm/CHANGES.md` B3 compares the three.
4. **Added:**
   - TikTok SPA page views: the SDK HistoryObserver is off via `ttq.load(pixel, {historyObserver:false})` [C, undocumented option], and `ttq.page()` fires on `virtual_page_view`. The baseline showed 2 per route.
   - UET purchase `event_id` (contract `requires_web_fix`).
   - The shim's `oa_utm` store, for the HubSpot fill and the handoff.
5. **The consent tag is a custom template, not Custom HTML.** In GTM's queue, a Custom HTML `gtag('consent','default')` is processed after the Google tag and Conversion Linker have already fired [C, v25 runtime]. The template's `setDefaultConsentState` applies synchronously on Consent Initialization. The template ships in the same import file.

## Not determinable from the captured code

- Whether LinkedIn attributes the `val` sent by `lintrk` (undocumented).
- Whether OpenArt's backend accepts the new `ad-click-ids` fields and checkout inputs.
- Invoice id format: `in_…` is assumed, but the GTM variable accepts any non-fallback id.
- Whether other server senders exist (`metaCapiTestEventCode`, GA4 `purchase_first_server`). If they do, they reuse the same ids and dedup.
- The exact `_twclid` cookie format [I].
- The TikTok Events Manager toggle behind `dynamic_web_pageview`.
- The business conversion label: a placeholder until the action is created.
- Whether the legacy checkout is still used.
- Real EEA behaviour: only geo-rewritten probes were possible.
- Whether HubSpot `utm_*` properties already exist, and the option list of `lead_source`.
- The `oppref` value format.
- GTM tag names and the source file paths in OpenArt's repos. Placements are cited by chunk and module id.

## Development

From `packages/web-fixes`. No dependencies beyond the repo root: vitest, happy-dom, typescript, tsx, zod, and esbuild via tsx.

```bash
npx vitest run                       # all tests (happy-dom for DOM code)
npx tsc -p tsconfig.json --noEmit    # typecheck
npx tsx scripts/build.ts             # rebuild dist bundles, the GTM import and the proof files
npx tsx scripts/build.ts --check     # CI: exit 1 if any committed output is stale
```

| Path | Contents |
|---|---|
| `gtm/` | Container change pack (import JSON, click-by-click steps, compiled proof) |
| `shim/` | Click-ID shim v2 (paste-in build) |
| `app-patches/` | Suite and legacy modules with placements |
| `hubspot/` | Form fix and fill script |
| `consent/` | Consent Mode v2 |
| `scripts/` | Build (esbuild IIFE bundles; import and proof generation) |
| `test-utils/` | Browser-like cookie jar, happy-dom window factory, fixture loader, provenance test |

`fixtures-provenance.json` lists every test fixture, with its capture source, extraction range and SHA-256. Sources are paths inside the research workspace `openart_2026-09-29/` (no absolute path or user name). `test-utils/test/provenance.test.ts` verifies the fixture hashes always, and the source hashes when the workspace is found: set `OPENART_RESEARCH_DIR`, or keep it next to the repository.

`.gitignore` re-includes `dist/`, which the repo root ignores. The bundles are deliverables.
