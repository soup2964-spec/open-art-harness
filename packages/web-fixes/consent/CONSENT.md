# Consent Mode v2 for openart.ai

**Labels**

- **[O]** observed.
- **[C]** shipped code (OpenArt's or a vendor's).
- **[I]** inference.
- **[U]** unknown from outside.

**Legal note.** Which CMP to use, and whether UTM-only first-party storage needs consent, are legal and product decisions for OpenArt. This document covers the technical wiring only.

## Today [O]

- There is no CMP and no consent signal at all. Every Google hit carries `gcd=13l3l3l3l1l1` ("not set"), including from Germany, the UK and Switzerland (research/11 §3.3; watchdog baseline 2026-09-30: `consent.eea_uk_ch.defaults` FAIL for DE, GB and CH).
- The site serves EU locales, and ad tags fire for EEA visitors before any choice.
- The server side withholds EEA/UK/CH rows until a CMP exists (`packages/conversion-service` ConsentResolver).

## What this folder ships

| Artifact | Use |
|---|---|
| **GTM custom template** *OA-FIX Consent Mode v2 defaults (region-scoped)* and the tag *OA-FIX Consent Mode v2 - defaults (EEA/UK/CH denied)* on **Consent Initialization - All Pages**, both in `../gtm/import/openart-gtm-fixpack.json` | The production path |
| `dist/openart-consent-defaults.min.js` (3.3 KB) | The same commands as on-page `gtag()` calls. Used for the watchdog proof, and for sites that set defaults outside GTM. It must run before the GTM snippet. |
| `src/consent-defaults.ts` | One source of truth for both: regions, defaults, the browser opt-out rule, template rendering (`.tpl`), permissions |
| `src/privacy-signals.ts` | The browser-side reader of GPC, US opt-out cookies and explicit choices, shared by the defaults, the click-ID shim and the HubSpot fill |

**Defaults**

| Scope | `ad_storage`, `ad_user_data`, `ad_personalization` | `analytics_storage`, `functionality_storage`, `personalization_storage` | `security_storage` | Other |
|---|---|---|---|---|
| **Regulated regions** (41 codes, from `packages/contracts` `CONSENT_REQUIRED_REGIONS`: EU27; IS, LI, NO; GB; CH; the EU territories RE, GF, GP, MQ, YT, MF, AX, the Canary Islands IC, Ceuta and Melilla EA) | denied | denied | granted | `wait_for_update: 500` ms for the CMP |
| Everywhere else, **browser opted out** (see below) | denied | granted | granted | The ad tags wait for a CMP grant |
| Everywhere else | granted | granted | granted | Same tag behaviour as today, but consent is now "set", so a CMP can update it and audits can see it |
| Global | | | | `ads_data_redaction: true` (no ad identifiers are sent while `ad_storage` is denied); `url_passthrough: true` (click ids carried in the URL while cookies are denied) |

**Region list.** It comes from `packages/contracts` (`src/consent-regions.ts`, `CONSENT_REQUIRED_REGIONS`), the one list `packages/edge-attribution`, `packages/conversion-service` and `packages/audience-sync` also gate on. The defaults use it normalised to the ISO codes geolocation reports: the contracts' input alias `UK` is `GB` here, which leaves 41 codes. The EU territories geolocate to their own ISO codes, so without them those visitors would get the global default. Tests enforce the equality.

## GPC and US opt-out signals (browser)

Every web fix that stores or sends an ad identifier reads the same signals, through `src/privacy-signals.ts`, and decides in the same order as `packages/edge-attribution`'s default policy:

| Signal | Where it is read |
|---|---|
| Global Privacy Control | `navigator.globalPrivacyControl === true` (the edge reads the same choice as `Sec-GPC: 1`) |
| US "do not sell or share" opt-out | the `oa_consent` cookie with `"opt_out_sale_sharing": true`; the IAB CCPA US Privacy cookie `usprivacy` with the opt-out-of-sale flag `Y` (`1YYN`) |
| Explicit Consent Mode choice | `window.__oaConsent.ad_storage`, else `oa_consent.ad_storage` |

| Decision (first match wins) | Consent Mode default (outside the regulated regions) | Click-ID shim | HubSpot fill | Edge (`edge-attribution`) |
|---|---|---|---|---|
| explicit `ad_storage: denied` | ad signals denied | holds every write, the Impact POST and Tolt until `grant()` | UTM fields only | utm-only, purge |
| sale/sharing opt-out recorded (even with `ad_storage: granted`: US CMPs often grant by default) | ad signals denied | holds the ad identifiers, Impact and Tolt; writes `oa_utm`. `grant()` does not release them while the opt-out stands | UTM fields only | utm-only, purge (an explicit choice) |
| explicit `ad_storage: granted` (overrides GPC: the visitor opted back in) | granted | writes everything | everything | full |
| GPC | ad signals denied | holds the ad identifiers, Impact and Tolt; writes `oa_utm`; `grant()` releases them | UTM fields only | utm-only |
| none of these | granted | as today | everything | full (outside the regulated regions) |

- The GTM template does the same in sandboxed JavaScript (`copyFromWindow` of `navigator.globalPrivacyControl` and `__oaConsent.ad_storage`; `getCookieValues` of `oa_consent` and `usprivacy`). Tests run the template against a mock sandbox and check it against the on-page commands for every combination. The template field **"Deny ad_storage, ad_user_data and ad_personalization everywhere when the browser … opted out"** (`respectOptOut`) is on by default.
- Only the ad signals change. `analytics_storage` stays granted outside the regulated regions: GPC and the US opt-outs cover the sale and sharing of personal data, not first-party analytics.
- A CMP that honours GPC and US opt-outs itself stays in charge: its `consent update` replaces the default. It must not call `update` with `ad_storage: 'granted'` for an opted-out visitor.
- **Recording a US opt-out.** OpenArt's "Do Not Sell or Share My Personal Information" link, or the CMP's US banner, adds `"opt_out_sale_sharing": true` to the `oa_consent` object (wiring step 3), or the CMP writes the IAB `usprivacy` cookie. Other mechanisms (a GPP string, a CMP's own category) should be mapped onto that field. The edge records it as `opt_out_sale_sharing` (the `packages/contracts` `Consent` field) for the conversion ledger, where it blocks ad sharing in every region.

**Why a template and not Custom HTML [C].**

- GTM appends dataLayer pushes made while it is processing an event to the end of its queue.
- It puts `gtm.init_consent` in front of `gtm.init` and `gtm.js`. This is the v25 runtime, `CE()`.
- A `gtag('consent','default')` from Custom HTML would therefore apply only after the Google tag and Conversion Linker had fired.
- Template APIs (`setDefaultConsentState`, `gtagSet`) apply synchronously on Consent Initialization.

## Choosing a CMP

**Requirements**

- A **Google-certified CMP partner**, integrated with Consent Mode and Google Tag Manager.
- Consent Mode v2: all four ad and analytics signals.
- Geolocation rules, so the banner shows in the same regions as the defaults.
- IAB TCF v2.2 support if OpenArt ever serves ads or works with TCF vendors. [I] It is not required for an advertiser that uses only Consent Mode.

**Certified partners.** Google's list (cmppartnerprogram.withgoogle.com, fetched 2026-09-30) includes, among its Gold-tier partners:

- Usercentrics, Cookiebot, OneTrust, Didomi, CookieYes, iubenda, Axeptio;
- consentmanager, Osano, Ketch, TrustArc, Termly, Complianz.

Sourcepoint is Bronze tier. Features and pricing per vendor were not assessed.

**Lowest-effort choices.** Cookiebot or OneTrust. `packages/edge-attribution` already has parsers for their cookies (`parseCookiebotCookie`, `parseOneTrustCookie`), so the edge Worker and the server get consent without extra code. Any other CMP works through the `oa_consent` cookie below.

## Wiring (the integration points)

1. **GTM** (`../gtm/CHANGES.md` B12). Choose one:
   - **CMP template on Consent Initialization** (from the Community Template Gallery). Configure the same region defaults, `ads_data_redaction` and `url_passthrough` in it, and **pause** the OA-FIX consent tag. There must be only one default.
   - **Keep the OA-FIX defaults tag** and load the CMP with its own script. The CMP must call `gtag('consent','update', {…})` on every choice and on every page for returning visitors. With `wait_for_update: 500`, tags in regulated regions wait up to 500 ms for that update.
2. **Additional consent checks.** Put `ad_storage` on every non-Google ad tag: Reddit, LinkedIn, X and TikTok, including the OA-FIX ones. Tags that send user-provided data (an email) also need **`ad_user_data`**: Reddit SignUp (57), X purchase (75), TikTok Purchase (78), and the OA-FIX X signup and TikTok CompleteRegistration tags (set by the import).
   - Google tags have built-in checks.
   - [C] UET reads Google consent itself: `bat.js` `enableAutoConsent` defaults to true.
3. **The CMP's consent callback also does two things on the page:**
   ```js
   // 1. The contract edge-attribution, the click-ID shim, the HubSpot fill and the consent defaults read
   //    (the object passed to gtag consent update, plus opt_out_sale_sharing for a US "do not sell or share" choice):
   document.cookie = "oa_consent=" + encodeURIComponent(JSON.stringify(consent)) +
     "; Path=/; Domain=.openart.ai; Max-Age=15552000; Secure; SameSite=Lax";
   // 2. Let the click-ID shim persist what it held back while ad_storage was denied or GPC was on:
   if (consent.ad_storage === "granted" && window.oaClickIdShim) window.oaClickIdShim.grant();
   ```
   The shim holds back only when a signal says so (the table above). Before the first choice there is no `oa_consent` cookie. In regulated regions, set `window.__oaConsent = {ad_storage: 'denied'}` in an inline script **before** the shim until the CMP grants (`../shim/README.md`).
   - The source of "regulated" can be the CMP's synchronous region API, or [I] the `country_code` cookie OpenArt already sets for pricing.
   - Without that, the shim writes click ids as it does today, unless GPC or a US opt-out is present.
4. **Pixels outside GTM** (both apps' inline code):
   - **Meta** (`fbq`, `843671884361709`). In regulated regions without a grant, call `fbq('consent','revoke')` before `fbq('init', …)`. On grant, call `fbq('consent','grant')`. This goes in the same snippet as the SPA flags (`../app-patches/PATCHES.md` §3). [I] The `country_code` cookie OpenArt already sets for pricing, or the CMP's region, can decide "regulated".
   - **OpenAI Ads** (`oaiq`). [C] SDK `oaiq-web` 0.1.41 handles `oaiq('consent', true|false)`. `false` drops pending events, clears the click and browser refs (including `__oppref`), and stores `oaiq_consent` (localStorage) and `__oaiq_consent` (cookie, 720 h). Call it from the same callback.
   - **TikTok.** Consent for TikTok goes through GTM (step 2). [C] The base code also exposes `ttq.holdConsent()`, `ttq.grantConsent()` and `ttq.revokeConsent()`, if the CMP's TikTok integration uses them.
5. **Cloudflare Google tag gateway.** Google: *"If you use consent mode, you must turn off automated script set up"* (Google Ads Help 16061406).
   - Turn off the automated setup.
   - Add the GTM snippet (`j.src='/4vu8/'`, as injected today) to the `<head>` of the Astro, Suite and legacy layouts, **after** the CMP loader and, if you use the on-page option, after `dist/openart-consent-defaults.min.js`.

## How consent reaches server-side events

1. **Browser → edge.** `packages/edge-attribution` reads `oa_consent` (or the Cookiebot/OneTrust cookie), `usprivacy`, `Sec-GPC` and `cf-ipcountry` on every document request, and gates the country on the contracts region list. It stores a consent snapshot on each attribution record: mode, region, explicit or not, GPC, the sale/sharing opt-out (`opt_out_sale_sharing` in the payload) and the Consent Mode signals.
   - In regulated regions without a decision, it stores UTMs only.
   - An explicit refusal or a sale/sharing opt-out also expires `oa_ad_clids`, `_fbc`, `ttclid` and `__oppref`.
2. **Edge → conversion ledger.** Every `ConversionLedgerEvent` carries the `consent` block (`packages/contracts`: the four Consent Mode signals, `region`, `source` = `cmp` | `regional_default` | `none`).
3. **Ledger → platforms** (`packages/conversion-service` ConsentResolver, defaults):

| Case | Rule |
|---|---|
| EEA/UK/CH | Send only with an explicit grant of `ad_storage` **and** `ad_user_data`. Withheld today. |
| Unknown region | Withheld (fail closed) |
| Elsewhere, no CMP signal | Send, asserting nothing |
| Explicit opt-out | Dropped (default), or `restrict` mode (below) |
| GPC or a sale/sharing opt-out (`gpc`, `opt_out_sale_sharing`) | Never shared, in any region, a CMP grant included (`packages/contracts` `blocksAdSharing`) |

`restrict` mode sends to platforms that have a limited-use field:

- Google Data Manager: `consent.adUserData` / `adPersonalization` = `DENIED`;
- Meta: LDU (US);
- TikTok: `limited_data_use`;
- Reddit: `data_processing_options` LDU;
- Microsoft: `adStorageConsent: "D"`.

LinkedIn and X have no such field and are dropped.

The browser and server therefore apply the same regions and the same decision: the edge reads the same cookie the CMP writes.

## Verify

1. **Tag Assistant, from an EU IP or VPN.**
   - The Consent tab shows the defaults on *Consent Initialization*: denied for the four ad and analytics signals.
   - Google hits carry `gcd` with denied defaults. The watchdog check `consent.eea_uk_ch.defaults` probes DE, GB and CH.
   - After accepting, an update to granted.
2. **Outside the regions.** Defaults granted. Tags behave as today.
3. **In a regulated region, before a choice.**
   - Reddit, LinkedIn, X and TikTok tags show *Not fired: consent*.
   - With `window.__oaConsent` set as in wiring step 3: no `oa_ad_clids`, `_fbc` or `__oppref` is written, and `window.oaClickIdShim.pending() > 0`.
   - After accepting: `pending()` is 0 and the cookies exist.
4. **GPC, outside the regions.** In a browser with Global Privacy Control on (Firefox with the setting, Brave, DuckDuckGo), or with `usprivacy=1YYN` set by hand:
   - Tag Assistant shows the ad signals denied by default; the ad tags wait for a CMP grant.
   - The click-ID shim writes `oa_utm` only (`pending() > 0`); the `/enterprise` form gets UTM fields only.
