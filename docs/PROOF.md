# Proof: OpenArt's live tags vs the same site with this repo's fixes applied

Both runs were made by `packages/watchdog` against **https://openart.ai** on **2026-09-30**, as an anonymous visitor.

- **What changed between runs:** the second run overlays the fixes locally, in a sealed browser. It uses the patched GTM container and Google tag config, the drop-in click-ID script and web patches, and the edge Worker (via its simulator). OpenArt's servers were not touched.
- **What reached OpenArt:** only ordinary anonymous page loads, 21 per run.
- **What reached any platform:** no collection or measurement request left the machine. See *Zero-leak* below.
- **Reports:** `packages/watchdog/reports/baseline-2026-09-30/` and `packages/watchdog/reports/patched-final-2026-09-30/` (the run against the post-review fix files; `patched-2026-09-30/` is the earlier pre-review run, kept for comparison, with identical check results). Each folder has `report.html` and `results.json`.

## Contract checks: 0/19 → 18/19

| Check | What "fixed" means | Live | Patched |
|---|---|---|---|
| signup.google_ads.user_data | the app's real `signup` push fires the Google Ads signup conversion, with user data | FAIL | PASS |
| signup.tiktok.event_id | TikTok CompleteRegistration carries `reg_<uid>` | FAIL | PASS |
| purchase.x.single_deterministic_event | exactly one X purchase, deterministic id | FAIL | PASS |
| purchase.linkedin.value_and_event_id | LinkedIn purchase has a value and an event id | FAIL | **FAIL** (see note) |
| business_subscription.consumed | business purchases reach the ad platforms | FAIL | PASS |
| generation.google.no_auto_form_events | clicking Generate sends no Google form_start/form_submit | FAIL | PASS |
| spa.page_views.* (7 platforms) | exactly one page view per in-app route change: Google Ads, Meta, TikTok, Reddit, LinkedIn, X, Microsoft | FAIL ×7 | PASS ×7 |
| meta.fbc.multi_hop / meta.fbc.return | Meta click id survives multi-page and return journeys | FAIL ×2 | PASS ×2 |
| openai.oppref.marketing_landing | ChatGPT-ads click ref survives marketing-page landings | FAIL | PASS |
| google.gbraid_wbraid.persisted | iOS Google click ids are stored first-party | FAIL | PASS |
| webview.handoff.attribution | the Instagram/TikTok in-app browser handoff carries attribution | FAIL | PASS |
| consent.eea_uk_ch.defaults | Consent Mode defaults are set for EEA/UK/CH | FAIL | PASS |

**LinkedIn note.** The Insight Tag has no documented purchase-value field.
- LinkedIn keeps the browser event when the browser and server ids match. So a server-side (CAPI) value is discarded unless the browser tag is removed for purchases.
- The fix pack ships two options:
  - **(a)** a paused browser variant using the undocumented `val` parameter (`web-fixes/gtm/proof/variants/`);
  - **(b)** a server-only LinkedIn purchase conversion with value, via `conversion-service`, with the browser purchase tag disabled.
- The check stays red until OpenArt picks one.

## Click-ID coverage by journey

Journeys: Meta one-hop, multi-hop, return, gbraid/wbraid, oppref landing (per platform relevance).

| Platform | Live | Patched |
|---|---|---|
| Google Ads | 4/4 | 4/4 |
| **Meta** | **2/4 (50%)** | **4/4 (100%)** |
| TikTok | 4/4 | 4/4 |
| Reddit | 3/3 | 3/3 |
| LinkedIn | 3/3 | 3/3 |
| X | 3/3 | 3/3 |
| Microsoft UET | 3/3 | 3/3 |
| **OpenAI (ChatGPT) Ads** | **0/4 (0%)** | **4/4 (100%)** |

**uBlock Origin users.** uBlock's default "Privacy" list strips gclid, gbraid, wbraid, fbclid, msclkid, twclid and ttclid from the URL *before the request is sent*. It also blocks every pixel and Amplitude.
- **Not recoverable by any server-side fix:** those click ids are gone before the request reaches OpenArt. Coverage for them stays 0% in both runs.
- **What the edge Worker still saves for these users** (verified with `edge-attribution/dist/edge-sim.js` on a uBlock-stripped URL):
  - the UTMs (first and last touch), in a signed, HttpOnly, 13-month `oa_attr` cookie
  - the surviving `li_fat_id` and `rdt_cid` (server-set `oa_ad_clids`)
  - `__oppref`
- **How they still get attributed:** combined with server-to-server conversions carrying hashed email (`conversion-service`), they become attributable at campaign level and email-matchable.

## Zero-leak

| Run | Sessions | Collection attempts | Blocked | Completed |
|---|---|---|---|---|
| Live baseline | 14 | 1,181 | 1,181 | **0** |
| Patched (final) | 14 | 1,172 | 1,172 | **0** |

**How the seal works:**
- The browser could reach only openart.ai hosts.
- Third-party scripts were fetched by the watchdog itself.
- Prefetch, prerender, service workers, WebSockets, popups and the Reporting API were disabled.
- Every browser profile was deleted after its run.

**Container:** GTM-56CMP8K was unchanged (v25) on both loaders during both runs.
