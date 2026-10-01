# GTM-56CMP8K: the change pack, click by click

These steps take the live container (**GTM-56CMP8K v25**, account container id 92263201) to the fixed state. The fixed state is also what `proof/patched_resource.json` compiles for the watchdog replay.

Nothing here touches OpenArt's site code. The app-side changes are in `../app-patches/PATCHES.md`.

**Labels**

- **[O]** observed in a capture.
- **[C]** read from shipped code (the compiled container, a vendor library, or an OpenArt bundle).
- **[I]** inference.
- **[U]** unknown from outside.

**Tag names.** The compiled container has no tag names. Existing tags are identified by type, one identifying field and the compiled `tag_id`. [I] The `tag_id` is the number at the end of the tag's editor URL (`…/workspaces/<n>/tags/<tag_id>`).

## 0. Before you start

1. Create a new workspace, **OA-FIX openart-signal**, from the live version (v25).
2. Admin → Container Settings: turn on **Enable consent overview** (used in B12).
3. Existing tags this pack touches. Nothing else in the container changes.

| tag_id | Type | Identify it by | Change | Section |
|---|---|---|---|---|
| 17 | Google Ads Conversion Tracking | Conversion Label `rVk2CJ7Ot8EZEOSYw_Up`, trigger `new_user_signed_up` | pause (replaced) | B1 |
| 15 | Google Ads Conversion Tracking | Conversion ID `11252321380`, label `OfGcCJisoLQZEOSYw_Up` | trigger swap | B7 |
| 19 | Google Ads Conversion Tracking | Conversion ID `16854695811`, label `4Rf-CM6EhJMcEIP_-OQ-` | trigger swap | B7 |
| 58 | LinkedIn Insight Tag 2.0 (gallery) | Conversion ID `29290225` | Event ID + trigger swap (default); paused under B3 option b or c | B3 |
| 72 | LinkedIn Insight Tag 2.0 (gallery) | Conversion ID `29290241` | Event ID | B3 |
| 52 | LinkedIn Insight Tag 2.0 (gallery) | Partner ID `10481401`, no conversion id | + trigger | B3, B10 |
| 34 | Reddit Pixel (gallery) | Event Type `PageVisit` | firing option + trigger | B6, B10 |
| 35 | Reddit Pixel (gallery) | Event Type `Purchase` | trigger swap | B6 |
| 57 | Reddit Pixel (gallery) | Event Type `SignUp` | Conversion ID | B6 |
| 74 | Custom HTML | `twq("config","qwghh")` | pause (replaced) | B5 |
| 75 | Custom HTML | `tw-qwghh-13vj24` | trigger swap | B5 |
| 76 | Custom HTML | `tw-qwghh-13vj22` | pause (replaced) | B5 |
| 77 | Custom HTML | `a.load("D9QOQ5JC77U6RO6J21IG")` | pause (replaced) | B4, B10 |
| 79 | Custom HTML | `ttq.track("CompleteRegistration")` | pause (replaced) | B4 |
| 38 | Custom HTML | `ti:"187107444",enableAutoSpaTracking:!0` | pause (replaced) | B8, B10 |

Untouched:

- 10: Conversion Linker.
- 20: Google tag `AW-11252321380`.
- 78: TikTok `Purchase` on `first_purchase`. It already sends `event_id = sub_<invoiceId>`, which is the shared dedup key.

## A. Import the new items

1. Admin → **Import Container** → Choose file → `gtm/import/openart-gtm-fixpack.json`.
2. Workspace: **Existing** → *OA-FIX openart-signal*.
3. Import option: **Merge** → **Rename conflicting tags, triggers, and variables**. Every item is prefixed `OA-FIX`, and GTM matches conflicts by name, so nothing should conflict.
4. The preview should show **14 tags, 5 triggers, 13 variables, 1 tag template and 1 folder added, 0 modified, 0 deleted**. If it shows anything modified or deleted, stop.
5. Confirm. Everything lands in the folder **OA-FIX openart-signal**. The built-in variable **Event** is enabled if it is off.

Imported:

- **Tags.** All of them fire from the start except the two paused LinkedIn purchase alternatives of B3 (options b and c).
  - OA-FIX Consent Mode v2 - defaults (EEA/UK/CH denied)
  - OA-FIX Google Ads - signup conversion (rVk2) on signup
  - OA-FIX Google Ads - business_subscription (secondary action)
  - OA-FIX Google Ads - page_view on route change
  - OA-FIX X - base pixel (no automatic gtm_purchase)
  - OA-FIX X - signup tw-qwghh-13vj22 (conversion_id reg_\<uid\>)
  - OA-FIX TikTok - CompleteRegistration (event_id reg_\<uid\>)
  - OA-FIX UET - base (automatic SPA tracking off)
  - OA-FIX UET - page_view on route change
  - OA-FIX TikTok - base pixel (automatic SPA page views off)
  - OA-FIX TikTok - page on route change
  - OA-FIX LinkedIn - purchase 29290225 via lintrk (value variant, paused)
  - OA-FIX Route settler (History Change -> virtual_page_view)
  - OA-FIX LinkedIn - server-only purchases via conversion-service (option b, paused)
- **Triggers**
  - `OA-FIX CE - signup`
  - `OA-FIX CE - purchase (deterministic id)`: `purchase`, and `{{OA-FIX CJS - purchase order_id}}` matches `^sub_`
  - `OA-FIX CE - business_subscription`: same filter
  - `OA-FIX CE - virtual_page_view`
  - `OA-FIX HC - route change`: History Change
- **Variables**
  - Data Layer: `user_data.email`, `user_id`, `eventModel.transaction_id`, `eventModel.value`, `eventModel.currency`, `page_location`, `page_referrer`, `page_title`, `page_path`.
  - 1st-party cookie: `oa_signup_uid`.
  - Custom JavaScript:
    - **`OA-FIX CJS - reg event_id`**. Returns `reg_<uid>`, taking `user_id` from the push, or else the uid half of `oa_signup_uid`. Otherwise it returns undefined.
    - **`OA-FIX CJS - purchase order_id`**. Returns `sub_<invoiceId>`, or undefined for the unstable fallback ids `sub_<tier>_<n>_<uid>_<Date.now()>`.
  - User-Provided Data: `OA-FIX UPD - user_data.email` (manual, email).
- **Template.** *OA-FIX Consent Mode v2 defaults (region-scoped)*.

**Why `reg_<uid>` still resolves before the app patch ships [C].** Suite module 764475 pushes `signup` and only then removes the one-shot cookie `oa_signup_uid = "<uid>:<email>"`. GTM evaluates the variable while it processes that push, so the cookie is still there.

## B. Per-fix steps

### B1. Google Ads signup conversion fires again, with order id and user-provided data

**Today [O][C].** Tag 17 (`AW-11252321380/rVk2CJ7Ot8EZEOSYw_Up`) fires on `new_user_signed_up`, an event no shipped code emits. The app pushes `{event:"signup", user_data:{email}}` (Suite module 764475).

**Steps**

1. Open tag 17 → **Pause**. The imported *OA-FIX Google Ads - signup conversion (rVk2) on signup* replaces it with:
   - the same conversion ID and label;
   - trigger `OA-FIX CE - signup`;
   - Order ID `{{OA-FIX CJS - reg event_id}}`;
   - *Include user-provided data from your website* with `{{OA-FIX UPD - user_data.email}}`.
2. In Google Ads, open Goals → Settings → Enhanced conversions and check that it is on for the Google tag. [O] It already is at the tag level: hits carry the encrypted `eme` envelope.

**Dedup.** The order id `reg_<uid>` is the same `transactionId` the conversion service's server event uses (`packages/contracts`: google_ads signup `dedup_key_template reg_{user_id}`). A browser and server copy of one signup count once.

### B2. `business_subscription` is consumed

**Today [O][C].** Suite module 111958 `eA()` pushes `business_subscription` for the first valid business invoice. No tag listens to it. Business sales already fire the normal purchase conversions (tags 15 and 19). Counting them again in a primary action would double count.

**Steps (Google Ads, account 11252321380)**

1. Goals → Conversions → **+ New conversion action** → Website → *Add a conversion action manually*.
   - Goal category: Purchase (or Subscribe).
   - Name: **Business subscription (web)**.
   - Value: *Use different values for each conversion*.
   - Count: **One**.
   - Attribution: same as the purchase actions.
2. Copy the new action's **conversion label**.
3. In GTM, open *OA-FIX Google Ads - business_subscription (secondary action)*. Replace `OAFIX_BUSINESS_LABEL_TBD` in *Conversion Label* with the new label.
4. In Google Ads, set the action to a **Secondary** action (Goals → Conversions → the action → Edit settings → Action optimization: Secondary). It reports business revenue but does not change bidding.

The tag sends:

- order id `{{OA-FIX DLV - eventModel.transaction_id}}` (`sub_<invoiceId>`);
- the push's value and currency;
- user-provided data.

It fires only on deterministic ids.

### B3. LinkedIn: event ids, purchase value and SPA page views

**Today [O].** The sealed replay (research/11 §3.1) showed that both conversions send `conversionId` only: no `eventId` and no value.

**Steps**

1. **Tag 58** (Conversion ID `29290225`, purchase):
   - *Event ID* = `{{OA-FIX CJS - purchase order_id}}`.
   - Triggering: remove the `purchase` trigger and add `OA-FIX CE - purchase (deterministic id)`.
2. **Tag 72** (Conversion ID `29290241`, signup): *Event ID* = `{{OA-FIX CJS - reg event_id}}`.
3. **Tag 52** (base Insight tag): add the trigger `OA-FIX CE - virtual_page_view`. Keep *Once per event*.

**Purchase `eventId` = `sub_<invoiceId>`, not `purchase_<invoiceId>`.**

- The shared contract (`packages/contracts`, linkedin `purchase_first` `dedup_key_template: 'sub_{invoice_id}'`) is what the conversion service's LinkedIn CAPI twin sends.
- LinkedIn dedups only when the ids are equal.
- If the contract changes, change the one variable.

**Purchase value: read before relying on CAPI for value.**

- The LinkedIn gallery template has no value field [C]. The Insight Tag event therefore carries no value.
- LinkedIn's dedup rule: *"If we receive an Insight Tag event and a Conversions API event from the same account with the same `eventId`, we discard the Conversions API event and count only the Insight Tag event"* (learn.microsoft.com/linkedin/marketing/conversions/deduplication).
- So **LinkedIn keeps the browser event when the ids match**: the server event's `conversionValue` is dropped for every purchase the browser also reported, and value arrives only for purchases the browser missed. Sending the value from the server alone (option b) is the only documented way to give every purchase a value.

Three options. The import ships **a**, with **b** and **c** as paused alternatives:

| Option | How | Trade-off |
|---|---|---|
| **a. Default (this import)** | Template tag 58 with Event ID | Count dedups. Value is missing for browser-seen purchases. Uses LinkedIn's documented API only. |
| **b. Server only, with value** | Pause **tag 58** and unpause *OA-FIX LinkedIn - server-only purchases via conversion-service (option b, paused)* in the same version. That tag sends nothing: it records the choice in the container and fires on the deterministic purchase trigger, so Tag Assistant shows it where tag 58 used to fire. `packages/conversion-service` then sends every LinkedIn purchase through the Conversions API with `eventId sub_<invoiceId>` and `conversionValue` (the value conversion-service resolves for every platform: the purchase value score, else cash; `src/platforms/linkedin`). | Every matched purchase carries a value, through LinkedIn's documented API only. Needs conversion-service live for LinkedIn. Only CAPI-matched purchases count (`li_fat_id` from tag 52, or the hashed email). No browser copy is left to fall back on. |
| **c. Value from the browser** | Unpause *OA-FIX LinkedIn - purchase 29290225 via lintrk (value variant, paused)* and pause tag 58 in the same version | Sends `lintrk('track',{conversion_id, event_id, conversion_value, conversion_currency})`. `conversion_id` and `event_id` are documented. [C] `insight.beta.min.js`, which OpenArt loads, maps `conversion_value`/`conversion_currency` to `val`/`cur`; LinkedIn does not document these fields publicly. Check one purchase in Campaign Manager before you trust it. |

Decision support: choose **b** when conversion-service's LinkedIn sender is live and value-based bidding matters more than browser-side counting; stay on **a** until then. **c** gives value without the server but relies on undocumented fields.

Proof files: the default proof is option a, unchanged. `proof/variants/patched_resource.linkedin-server-only.json` is option b (tag 58 paused, the option-b tag in place). `proof/variants/patched_resource.linkedin-lintrk-value.json` is option c. The watchdog check `purchase.linkedin.value_and_event_id` expects option c: a browser LinkedIn purchase with value. The default proof passes its event-id half only, and option b fails it by design (LinkedIn gets the purchase server-side only; check it in Campaign Manager).

### B4. TikTok: CompleteRegistration event id and SPA page views

**Today [O][C].**

- Tag 79 sends `ttq.track("CompleteRegistration")`, so the replay shows `event_id ""`.
- The TikTok SDK's HistoryObserver sends one `Pageview` per URL change. That was 2 for one create-image navigation in the 2026-09-30 watchdog baseline, because the Suite rewrites the URL several times.

**Steps**

1. Pause **tag 79**. *OA-FIX TikTok - CompleteRegistration (event_id reg_\<uid\>)* sends:
   - `ttq.identify({email})` as before;
   - `ttq.track('CompleteRegistration', {}, {event_id: {{OA-FIX CJS - reg event_id}}})`;
   - without an event id only when the uid cannot be derived, which is today's behaviour.
2. Pause **tag 77**. *OA-FIX TikTok - base pixel (automatic SPA page views off)* is tag 77 byte for byte, with one change: `a.load("D9QOQ5JC77U6RO6J21IG",{historyObserver:!1})`.
   - [C] The SDK (`main.MWU2MzIzODM0MQ.js`, `fo()`) observes history only when `options.historyObserver !== false`. The option is not in TikTok's public docs.
   - Tests run the shipped gate against both versions of the base code.
3. *OA-FIX TikTok - page on route change* calls `ttq.page()` on `virtual_page_view`.

Tag 78 (Purchase) stays as it is.

### B5. X: no automatic duplicate purchase, deterministic ids

**Today [C][O].** OpenArt's `uwt.js` is 2.4.11. Its module 9115 (dataLayer tracking) watches `window.dataLayer` and turns ecommerce events into automatic `gtm_<event>` events. `gtag('event','purchase', …)` therefore produces an automatic **`gtm_purchase`** with `order_id`, alongside tag 75's `tw-qwghh-13vj24`. That is two purchase events per sale (replay S3).

`twq('set','dataLayerTracking','false','qwghh')` (module 510, `OneTag.set`) switches it off, but only if it runs **before** `twq('config', …)`. Tests execute the real modules and show three cases:

- shipped: one `gtm_purchase`;
- fixed: zero;
- setting it after config: too late.

**Steps**

1. Pause **tag 74**. *OA-FIX X - base pixel (no automatic gtm_purchase)* is tag 74 plus that one statement before `twq("config","qwghh")`.
   - It fires on All Pages and on `OA-FIX CE - virtual_page_view`.
   - Re-running `config` is X's page view for an SPA route.
2. **Tag 75** (purchase `tw-qwghh-13vj24`): change the trigger only. Remove `purchase` and add `OA-FIX CE - purchase (deterministic id)`.
   - Its `conversion_id` is already the transaction id `sub_<invoiceId>`. That is the key the X CAPI twin uses (`packages/contracts`: x `dedup_key_template sub_{invoice_id}`).
   - The new trigger keeps the unstable fallback ids out.
3. Pause **tag 76**. *OA-FIX X - signup tw-qwghh-13vj22 (conversion_id reg_\<uid\>)* adds `conversion_id: {{OA-FIX CJS - reg event_id}}`.
4. In X Events Manager, if `gtm_purchase` was ever set up as a conversion event, archive it.

### B6. Reddit: signup conversion id, deterministic purchases and SPA page views

1. **Tag 57** (SignUp): *Conversion ID* = `{{OA-FIX CJS - reg event_id}}`. Today it has none (replay: email only), so a server twin cannot dedup.
2. **Tag 35** (Purchase): remove `purchase` and add `OA-FIX CE - purchase (deterministic id)`.
   - [C] Its Transaction ID and Conversion ID fields are already the transaction id.
   - [O] The pixel sends the conversion id SHA-256-hashed (replay S3).
3. **Tag 34** (PageVisit):
   - Advanced Settings → Tag firing options: **Once per event** (was *Once per page*).
   - Add the trigger `OA-FIX CE - virtual_page_view`.

### B7. Google Ads purchase conversions: deterministic ids only

**Tags 15 and 19**: remove `purchase` and add `OA-FIX CE - purchase (deterministic id)`. Nothing else changes.

- Order id stays `sub_<invoiceId>` for both accounts.
- [C] When the Suite's invoice lookup fails, it sends a list-price fallback with `transaction_id sub_<tier>_<n>_<uid>_<Date.now()>`. That id cannot dedup and the value is stale (annual Starter is reported as $7).
- These purchases are now left to the server sender. The app patch (`fallback-purchase.ts`) stops sending them at all. This trigger is the GTM-side guard.

### B8. Microsoft UET: one page view per route

**Today [C][O].** Tag 38 loads `bat.js` with `enableAutoSpaTracking:!0`. `bat.js` then wraps `pushState`/`replaceState` and sends a `pageLoad` per URL change: 3 for one create-image navigation (P07, and the 2026-09-30 baseline).

**Steps**

1. Pause **tag 38**. *OA-FIX UET - base (automatic SPA tracking off)* is identical except for `enableAutoSpaTracking:!1`.
2. *OA-FIX UET - page_view on route change* pushes `uetq.push('event','page_view',{page_path, page_title})`. [C] That is the call `bat.js` itself makes for SPA page views; `bat.js` sends it as `evt=pageLoad`.

The UET purchase `event_id` for CAPI dedup is an app change: `../app-patches/PATCHES.md` §5.

### B9. Google Ads remarketing page views on SPA routes

*OA-FIX Google Ads - page_view on route change* sends `gtag('event','page_view',{send_to:['AW-11252321380','AW-16854695811'], page_location, page_referrer, page_title})` on `virtual_page_view`. Today Suite and legacy soft navigations send no Google page view at all [O].

[I] The container's own first-party `ccm/collect` page view (no `tid`, `gtm=45E…`) appears on hard loads only. No tag re-fires it. On route changes, expect one `tid=AW-11252321380` page view and no container one.

### B10. Exactly one page view per route change, per platform

**Source of `virtual_page_view`**

- **Now.** *OA-FIX Route settler (History Change -> virtual_page_view)*:
  - Custom HTML on All Pages and `OA-FIX HC - route change`, firing *Unlimited*.
  - It waits for 500 ms of quiet (at most 2 s), then pushes one `virtual_page_view` if the pathname changed.
  - The Suite rewrites the URL up to 4 times in about 500 ms for one navigation [O P07], and the largest gap was 296 ms.
  - Adding the History Change trigger is what makes GTM include its history listener. v25 has none.
- **Later.** The Suite app patch (`page-view-contract.ts`) pushes the same event from the router. It sets `window.__oaPageViewContract = 'app'`, and the settler then stands down. No double counting, no GTM edit.

| Platform | Hard load | Route change after this pack |
|---|---|---|
| Google Ads | unchanged | B9 tag (one event, both Ads destinations) |
| Reddit | tag 34 | tag 34 on `virtual_page_view` |
| LinkedIn | tag 52 | tag 52 on `virtual_page_view` |
| X | new X base | new X base on `virtual_page_view` |
| UET | new UET base | B8 page_view tag (automatic SPA off) |
| TikTok | new TikTok base | B4 page tag (HistoryObserver off) |
| Meta | app snippet | app patch: `fbq.disablePushState=true` plus one `PageView` per route with `eventID` (not in GTM) |

### B11. Google tag automatic form events (not a GTM setting)

**Today [C][O].** The Google tag config `AW-11252321380` (v4) has `__ogt_auto_events` with `vtp_enableForm: true`. Its `__ccd_em_form` then sends `form_start` / `form_submit` for any form, including the generation prompt. Those events are noise in Google Ads.

**Steps**

1. Google Ads → Tools (wrench) → Data manager → **Google tag** → `AW-11252321380`.
2. Configuration → **Manage automatic event detection** → turn off **Form interactions**.
3. Leave the other automatic events alone.

Google documents the same switch: *"clicking the tools icon … clicking 'Google tag', and switching off 'form interactions' in your tag configuration"* (Google Ads Help 13258081).

`proof/patched_gtag_config.js` is the v4 config with only that flag flipped. Tests show it is the flag that gates form listening.

### B12. Consent Mode v2

The imported tag *OA-FIX Consent Mode v2 - defaults (EEA/UK/CH denied)* runs the imported template on **Consent Initialization - All Pages**.

**What the template does**

- `setDefaultConsentState` for the 41 regulated region codes from `packages/contracts` `CONSENT_REQUIRED_REGIONS` (EU27, IS, LI, NO, GB, CH, and the EU territories RE, GF, GP, MQ, YT, MF, AX, IC, EA): all denied except `security_storage`, with `wait_for_update: 500`.
- A global default of granted. Behaviour outside those regions stays as it is today, but consent becomes "set".
- **GPC and US opt-outs** (field *respectOptOut*, on): when the browser sends Global Privacy Control (`navigator.globalPrivacyControl`), or `oa_consent` / the IAB `usprivacy` cookie record a "do not sell or share" opt-out or an `ad_storage` denial, the global default denies `ad_storage`, `ad_user_data` and `ad_personalization` instead. An explicit `ad_storage` grant overrides GPC, not a recorded sale/sharing opt-out. Same order as the shim, the HubSpot fill and edge-attribution (`../consent/CONSENT.md`).
- `ads_data_redaction` and `url_passthrough` set to true.

**Steps**

1. Choose a CMP and wire it as described in `../consent/CONSENT.md`.
   - If the CMP's own GTM template sets region defaults, pause the OA-FIX consent tag so there is only one default.
   - Otherwise keep it and let the CMP call `gtag('consent','update', …)`.
2. Consent overview (shield icon on the Tags list): give every non-Google ad tag **Require additional consent for tag to fire: `ad_storage`**:
   - Reddit: 34, 35, 57.
   - LinkedIn: 52, 58, 72, and the lintrk variant.
   - TikTok: 78, and the new TikTok tags (already set by the import).
   - X: 75, and the new X tags (already set by the import).
   - Google tags have built-in consent checks. [C] UET reads Google consent itself (`bat.js` `enableAutoConsent` defaults to true).

   Tags that send **user-provided data** (an email) also need **`ad_user_data`**: consent to storage is not consent to sending the email.
   - Reddit SignUp **57** (advanced matching email), X purchase **75** (`email_address`) and TikTok Purchase **78** (`ttq.identify({email})`): add `ad_user_data` by hand.
   - *OA-FIX X - signup* and *OA-FIX TikTok - CompleteRegistration* already require `ad_storage` **and** `ad_user_data` (set by the import).
3. **Cloudflare.** Google says: *"If you use consent mode, you must turn off automated script set up"* (Google Ads Help 16061406, Google tag gateway with Cloudflare). Turn it off and add the GTM snippet (`j.src='/4vu8/'`) to each front-end's `<head>` yourself, after the CMP.

## C. Preview and QA (Tag Assistant)

Preview the workspace on `openart.ai`, then check each event:

| Action | Tags that must fire | Network check |
|---|---|---|
| Page load | Conversion Linker, Google tag, OA-FIX X/UET/TikTok base, LinkedIn 52, Reddit 34, route settler | exactly one TikTok `Pageview`, one UET `pageLoad`, one X `pageview` |
| Suite soft navigation (Home → Create image) | route settler, then one `virtual_page_view` with Google Ads page_view, Reddit 34, LinkedIn 52, X base, UET page_view, TikTok page | one page view per platform per route, not one per URL rewrite |
| Signup (`signup` push) | OA-FIX Google Ads signup, LinkedIn 72, Reddit 57, OA-FIX X signup, OA-FIX TikTok CompleteRegistration | Google Ads conversion `label=rVk2CJ7Ot8EZEOSYw_Up` with `oid=reg_<uid>`, plus a user-data hit; TikTok `event_id=reg_<uid>` |
| Purchase with invoice id | Google Ads 15 + 19, Reddit 35, LinkedIn 58, X 75 | X: exactly one purchase event, `conversion_id=sub_in_…`, no `gtm_purchase`; LinkedIn `eventId=sub_in_…` |
| Purchase with a fallback id (`sub_<tier>_…_<13 digits>`) | none | no ad-platform purchase hit |
| `business_subscription` | OA-FIX Google Ads business | conversion with the new label and `oid=sub_in_…` |
| Type in the generation prompt | none | no `form_start` / `form_submit` after B11 |

## D. Publish and roll back

- **Publish.** Version name *OA-FIX openart-signal*. List the paused originals in the description: 17, 38, 74, 76, 77, 79, and 58 if you chose option b or c of B3.
- **Roll back.** Versions → v25 → **Publish**. Every change is additive or a pause, so v25 is a complete rollback.
- After publishing, update the watchdog baseline (`packages/watchdog/baselines/`) so the container diff tracks the next change.

## E. What the proof files contain

`proof/patched_resource.json` is produced by `src/patch-container.ts` from the v25 resource. It is the state after A and B.

- New tags get compiled `tag_id` 1002–1011, the same numbers as their export `tagId`s.
- Replaced originals are paused, which means removed from every rule.
- Template-tag edits and trigger swaps are applied in place.
- It uses only function types whose code already ships in v25, so the watchdog can splice it into the live runtime.

Left out, because v25 has no runtime code for them:

- The consent template. The proof injects `consent/dist/openart-consent-defaults.min.js`, which pushes the same defaults.
- The History Change listener that the route settler needs. The proof's injected stand-in pushes `virtual_page_view`.

Also left out: additional-consent-check metadata. It only matters in denied regions.

Other files:

- `proof/patch-report.json` lists every added macro, predicate and tag, and every pause and edit.
- `proof/variants/patched_resource.linkedin-server-only.json` is option b of B3; `proof/variants/patched_resource.linkedin-lintrk-value.json` is option c.
