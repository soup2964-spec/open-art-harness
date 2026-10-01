# App patches: where each one goes

Each patch is a TypeScript module in `src/` with tests in `test/`. The tests run OpenArt's shipped code (extracted verbatim into `test/fixtures/`; sources and hashes in `../fixtures-provenance.json`) next to the replacement.

Placements are cited by **production chunk and Turbopack/webpack module id**. The source file names inside OpenArt's repos are not visible from outside [U]. Search the repo for the quoted code or export names.

**Labels**

- **[O]** observed in a capture.
- **[C]** read from shipped code.
- **[I]** inference.
- **[U]** unknown from outside.

## Rollout order

1. **Backend, if its validation is strict [U]**:
   - `POST /api/user/ad-click-ids` must accept the new `<key>` and `<key>_created_at` pairs (§1);
   - `POST /api/stripe/subscription` must ignore or store the new hidden inputs (§1).
2. **Suite**, one release:
   - §1 click-id keys;
   - §2 signup push;
   - §3 page-view contract, together with the Meta snippet flags;
   - §4 purchase reporting;
   - §5 UET event id;
   - §6 webview handoff.
3. **Legacy**, one release:
   - §3 (Pages Router hook plus Meta snippet);
   - §4 (module 68039) and §5 (module 49808);
   - §7 Amplitude init.

GTM changes (`../gtm/CHANGES.md`) can ship before or after. The fix pack works with today's pushes: `reg_<uid>` falls back to the `oa_signup_uid` cookie, and the GTM route settler covers page views until §3 ships.

## §1 Click-ID keys: `src/click-id-keys.ts`

**Today [C].**

- Suite module **162070** (`/suite/_next/static/chunks/91db8069961c7577.js`) hard-codes `let n=["gclid","fbclid","msclkid","ttclid"],r="oa_ad_clids"`.
- It exports `readAdClickIds`, `buildMigrationPayload`, `captureAdClickIds` and `readGclid`.
- Every consumer therefore drops `gbraid`, `wbraid`, `rdt_cid`, `twclid`, `li_fat_id` and `oppref`.
- `captureAdClickIds` rewrites `oa_ad_clids` with only those four keys, which **deletes** a `gbraid`/`wbraid` stored by the Astro shim [O `crawl/teardown2/T2c_gbraid_then_app_fbclid.json`; watchdog `google.gbraid_wbraid.persisted` FAIL].

**Replace module 162070's body** with thin adapters that keep the four export names and call signatures:

```ts
import * as oa from '@openart-signal/web-fixes/app-patches/click-id-keys';
const env = () => ({ cookie: document.cookie, localStorage: window.localStorage });
export const readAdClickIds = (maxAgeMs?: number) => oa.readAdClickIds(env(), maxAgeMs);
export const buildMigrationPayload = oa.buildMigrationPayload; // {keys, payload:{<key>, <key>_created_at}}
export const captureAdClickIds = () => { oa.captureAdClickIds({ location, document, localStorage }, {
  domain: isLocalDev ? undefined : '.openart.ai', secure: !isLocalDev }); };
export const readGclid = () => oa.readGclid(readAdClickIds());
```

Keep the existing `publicEnv.isLocalDev` rule for `Domain`/`Secure`.

**Consumers (unchanged code, more keys)**

| Module (chunk) | Today | After |
|---|---|---|
| **997659** (`82a8baa61b72c9cd.js`) | `useEffect(() => captureAdClickIds(), [])` | same call. It now merges all ten keys. |
| **807552** (`82a8baa61b72c9cd.js`) | after `useSession()` is authenticated: `post("/api/user/ad-click-ids", buildMigrationPayload(readAdClickIds()).payload)` | payload gains `gbraid, wbraid, rdt_cid, twclid, li_fat_id, oppref` and their `_created_at` values. **Backend must accept them.** |
| **107154** `GclidHiddenInput` (`91db8069961c7577.js`), rendered by `SubscriptionChangeForm` (module 587597, `48af52e9464d87bf.js`) | one hidden input `gclid` in the form that POSTs `/api/stripe/subscription` | render `checkoutHiddenInputs(readAdClickIds(), { fbc: cookie('_fbc') })` instead: every key, `<key>_created_at`, and `fbc`. [I] The backend then copies them into the Checkout Session metadata, so server conversions have click ids. |
| **111958** `eO()` (`d4f45453351837aa.js`) | `conversion_reported` carries `gclid/fbclid/msclkid/ttclid` from `readAdClickIds(12096e5)` | unchanged. It may add the new keys. |

**First-seen timestamps.** A click id that is already stored with the same value keeps its first-seen `ts`; only a changed value is restamped. The shipped `captureAdClickIds` restamped it on every landing, while the Astro shim kept it. The shim, this module, the proof stand-in and the edge Worker now apply the same rule (and `readAdClickIds` keeps the earliest `ts` when the cookie and localStorage hold the same value).

Tests (`test/click-id-keys.test.ts`):

- The shipped module 162070 runs in happy-dom; the T2c deletion is reproduced.
- The replacement keeps every stored key, is read-compatible, and emits the same payload shape.
- First-seen `ts` rules, including agreement with the shim on the same landing (`../shim/test/shim.test.ts`).

## §2 Signup push with the user id: `src/signup-push.ts`

**Today [C].** Suite module **764475** (`82a8baa61b72c9cd.js`, `SignUpDataLayerEvent`):

- reads the one-shot cookie `oa_signup_uid = "<uid>:<email>"`;
- pushes `{event:"signup", user_data:{email}}` with the uid dropped;
- `console.info`s a masked email;
- removes the cookie.

**Patch.** Replace the effect body:

```ts
useEffect(() => {
  if (fired.current) return;
  if (pushSignupEvent(window, Cookies /* module 464143: get/remove, js-cookie-style [I] */) !== 'no_cookie') fired.current = true;
}, []);
```

The push becomes `{event:"signup", user_id:"<uid>", user_data:{email}}`.

- It uses the same cookie split as today and is otherwise backwards compatible.
- `user_id` is top-level on purpose: Google treats `user_data` as user-provided data.
- GTM builds `reg_<uid>` from it. That is the id Meta `CompleteRegistration` and OpenAI `registration_completed` already use, per modules 254079/555451.
- **The email is validated before the push** (`isValidSignupEmail`: at most 254 characters, a local part of at most 64 in the `input[type=email]` character set, a dotted domain). GTM passes `user_data.email` to Google, Reddit, X and TikTok as user-provided data. The shipped code pushed whatever followed the first `:` of the cookie, markup included. An invalid address is pushed as `''`, the shape the shipped code already uses for a cookie without one; the uid is kept.
- **At most one push per signup.** A marker (`reg_<uid>`, or a hash of the cookie when there is no uid; never the email) is written to the page and to `sessionStorage` (`oa_signup_pushed`) **before** the push, and nothing after the push can throw. A throw in logging or in the cookie removal, a re-mount, or a reload while the one-shot cookie is still there returns `'already_pushed'` instead of a second event. A browser push lost this way is backstopped by conversion-service's server twin (same `reg_<uid>`).

## §3 Exactly one page view per route: `src/page-view-contract.ts`

**Today [O].** For one Suite navigation, the URL is rewritten up to 4 times in about 500 ms (P07, 2026-09-30 watchdog baseline):

- Meta's own history hook sends 3 `PageView`s;
- `bat.js` sends 3;
- TikTok sends 2;
- Google, Reddit, LinkedIn and X send 0.

**Suite (App Router).** Add a client component to the root layout, next to `SignUpDataLayerEvent` (module 764475):

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { makeUsePageViewContract } from '@openart-signal/web-fixes/app-patches/page-view-contract';
const usePageViewContract = makeUsePageViewContract({ useEffect, useRef }, { usePathname });
export function PageViewContract() { usePageViewContract(); return null; }
```

**Legacy (Pages Router).** In `pages/_app`, call `makeUseLegacyPageViewContract({ useEffect, useRef }, { useRouter })()` inside the App component. It listens to `routeChangeComplete`.

**What it does**

- Waits for 500 ms of quiet (at most 2 s).
- Pushes one `{event:'virtual_page_view', page_view_id, page_location, page_path, page_title, page_referrer, page_view_source:'app'}` when the pathname changed.
- Flushes on `pagehide`.
- Sets `window.__oaPageViewContract = 'app'`, so the GTM route settler stands down.

**Meta: patch the inline pixel snippet in both apps.** The Suite's is `next/script id="meta-pixel-code"`; the legacy one is the inline script with the same body. Use `patchMetaPixelSnippet(snippet)`, or insert by hand right before `fbq('init', '843671884361709')`:

```js
fbq.disablePushState=true;fbq.allowDuplicatePageViews=true;
```

[C] In the captured `fbevents.js`:

- Module `signalsFBEventsSPANavigationUtil` wraps `pushState`/`replaceState` only when `fbq.disablePushState !== true`.
- It reads the flag once, on the first event, so it must be set on the stub before `init`.
- PageViews after the first are dropped unless `allowDuplicatePageViews` is set.

The contract then sends `fbq('track','PageView',{}, {eventID:'pv_<page_view_id>'})` once per route. The CAPI Gateway copy shares the `eventID`.

Tests:

- The P07 timings produce 1 event.
- The shipped `fbevents` module wraps history with the shipped snippet and does not with the patched one.
- The patch is idempotent on the Suite and legacy snippets.

## §4 Purchase reporting without stale fallbacks: `src/fallback-purchase.ts`

**Today, Suite [C].** Module **111958** (`d4f45453351837aa.js`):

- `eE()` builds a fallback payload from the `PRICES` table (module 399331 in `91db8069961c7577.js`):
  - Annual plans use a stale per-month figure. An annual Starter sale is reported as **$7**.
  - The id is `sub_<tierKey>_<tier>_<uid>_${Date.now()}`.
- `eT()` retries `/legacy/api/stripe/checkout-session-invoice` once.
- If both calls fail, `eR()` sends the fallback to Google Ads (both accounts), UET, Reddit, LinkedIn, X and Brevo.
- `ez()` (`purchase_first`, webhook-gated) always uses the fallback.

**Today, legacy [C].** Module **68039** (`pages/_app-a1820d4f2194dce7.js`) `u()`:

- always sends the `Date.now()` transaction id, even when the invoice resolves;
- sends value = LTV → amount → list price;
- sends Meta and OpenAI with no event id when the lookup fails.

**Patch, in the checkout-success handler of both apps**

```ts
const d = resolveClientPurchase(invoice /* eP()/c() result */, planItemFromParams({ tierParam, intervalParam }, tierKeyOf));
if (d.kind === 'skip') {
  // channels as in conversion_reported today: google_ads, ga4, meta_pixel, openai_ads, bing_uet, brevo, clarity
  for (const channel of channels) event('conversion_reported', conversionReportedForSkip(channel, 'purchase', d.reason));
  return; // the server sender (Stripe invoice.paid -> conversion service) reports it with the same ids
}
purchase({ ...toGtagPurchase(d), user_email });                    // module 114607 K() / legacy 49808 o(); value = d.orderValue
if (d.isFirstValid) push(toFirstPurchasePush(d, email));             // eN(); value = d.value
const biz = toBusinessSubscriptionPush(d, email); if (biz) push(biz); // eA(); value = d.value
// Meta Purchase and OpenAI subscription_created keep today's gating (Suite: first valid purchase only):
fbq(...toMetaPurchase(d));                                           // ['track','Purchase',{value,currency},{eventID: purchase_<invoiceId>}]
oaiq('measure', 'subscription_created', { type: 'plan_enrollment', amount: d.amountMinor, currency: d.cash.currency }, { event_id: d.eventId });
// Record which value each channel sent (see "Purchase value" below):
event('conversion_reported', { /* today's properties */ value_basis: d.value.value_basis /* meta_pixel, TikTok */ });
```

- `ez()`/`purchase_first` uses the same `d`, or is dropped.
- **Ids follow the contracts rule.** `resolveClientPurchase` builds `sub_<invoiceId>` and `purchase_<invoiceId>` with `packages/contracts` `purchaseOrderId`/`purchaseEventId`, which accept only a Stripe invoice id (`in_…`). Any other id, such as a constant `"undefined"` from a backend bug, skips with `invoice_id_invalid` instead of collapsing every purchase into one platform order id. `assertDeterministicId()` (contracts `parseBrowserDedupId`) guards anything leaving the browser. The GTM variable `OA-FIX CJS - purchase order_id` stays lenient on purpose (the watchdog's synthetic `sub_SEALTEST_*` ids must still fire); with this patch the app never pushes a non-invoice id.

### Purchase value: the same server-computed value on every tag

**Why.** Meta keeps the **first-received** copy of a deduplicated event, which is usually the browser pixel. LinkedIn keeps the Insight Tag event when the ids match (`../gtm/CHANGES.md` B3), and Google keeps the tag value until the Data Manager override applies. Today the pixel sends LTV (or cash) while conversion-service sends predicted profit, so which copy a platform keeps decides the value, and the values disagree across platforms.

**Backend change.** `/legacy/api/stripe/checkout-session-invoice` returns a new field **`profitValueMajor`** (with `profitCurrency`): the value conversion-service sends with this same purchase, taken from its value endpoint (`packages/contracts` `PurchaseValueScore`, `E[gross_profit_90d | purchase]`, floored as sent). Add both to the `eP()` (Suite) / `c()` (legacy) normalisation. Without `profitCurrency`, the invoice currency is assumed.

**Browser.** `choosePurchaseValue(invoice, legacy)` picks the field and says which one it used, as `value_basis`. `resolveClientPurchase` exposes two results:

| Result | Sent by | 1st choice | Fallback (today's value) |
|---|---|---|---|
| `d.value` | Meta Purchase (`toMetaPurchase`), TikTok Purchase via `first_purchase` (`toFirstPurchasePush`), `business_subscription` | `profitValueMajor` (`'profit'`) | `ltvValueMajor` (`'ltv'`, Suite `ek()`), else the amount (`'cash'`) |
| `d.orderValue` | `gtag('event','purchase')`: Google Ads (both accounts), Reddit, X and LinkedIn option c through GTM (`toGtagPurchase`); UET (`toUetPurchase`) | `profitValueMajor` (`'profit'`) | the amount (`'cash'`, Suite `eR()`) |

- Once the backend returns `profitValueMajor`, every value-carrying purchase tag sends that one number, the same one the server copy carries, whichever copy each platform keeps.
- Until then, each tag keeps exactly today's value (the parity tests with the shipped `eR()`/`ek()` still hold). A usable profit value is a finite number ≥ 0 with a valid currency; anything else falls back.
- **`value_basis` note.** With `'ltv'` or `'cash'`, the pixel copy and the server copy differ, and Meta reports the pixel's. Record the basis on `conversion_reported` (`value_basis`) so reporting can separate profit-valued conversions from fallbacks, and check that `'profit'` is close to 100% after the backend ships.
- OpenAI Ads `subscription_created` keeps the cash `amount`: conversion-service sends no OpenAI copy, so there is no second copy to disagree with.

Tests:

- The shipped `ek/eN/eE/eR/eA` run next to the replacement: same payloads when the invoice resolves (without `profitValueMajor`).
- The $7 evidence is reproduced.
- Every failure path skips; the accepted invoice ids are exactly those `packages/contracts` accepts.
- `choosePurchaseValue`: precedence, currency, unusable values; with `profitValueMajor`, gtag, UET, `first_purchase`, `business_subscription` and Meta all carry the same value.

## §5 UET purchase `event_id`: `toUetPurchase()` in `src/fallback-purchase.ts`

**Today [C].**

- Suite module **114607** `K()` (`08d6e61a49e7dfba.js`) and legacy module **49808** `o()` push `uetq.push("event","purchase",{transaction_id, revenue_value, currency})`.
- There is no event id, so a UET Conversions API twin cannot dedup.
- Microsoft: *"use the same UET `tagId`, `eventId`, and `eventName`"*. The UET JavaScript parameter is `event_id` (Microsoft Advertising, uet-conversion-api-integration).

**Patch.** Add `event_id: n.transaction_id` to that call, or push `toUetPurchase(d)`. This is safe once §4 ships, because `transaction_id` is then always `sub_<invoiceId>`. That is the key `packages/contracts` uses for Microsoft (`dedup_key_template sub_{invoice_id}`, event name `purchase`).

Tests run the shipped module 114607 and compare.

## §6 In-app-browser handoff: `src/webview-handoff.ts`

**Today [O][C].** Suite module **825073** (`ea9b966c01d84c18.js`):

- `em()` ("Option 2: copy the link") shows `window.location.href`. After the usual landing → `/home` hop that URL has no click id and no UTM [O T11a; watchdog `webview.handoff.attribution` FAIL].
- `eb()` renders Google OAuth enabled in webviews. Google blocks it there (`disallowed_useragent`).

**Patch**

1. **Handoff URL.** When the overlay opens, compute `const { url } = await getHandoffUrl(window)` and show and copy `url` instead of `window.location.href`.
   - **Token mode.** Used when `packages/edge-attribution` is deployed: `POST /api/attribution/handoff` → `https://openart.ai/r/<22-char token>`. It restores the webview's attribution in the external browser, once (single-use token). 1.5 s timeout.
   - The POSTed `path` is `handoffRequestPath(location)`: the pathname plus the attribution params only (click ids that pass the click-id pattern, clean `utm_*`). Any other query param (a magic-link code, a reset token, an email) is never sent: the Worker stores the target behind a bearer link. The Worker applies the same allow-list again.
   - **Param mode.** Needs no backend: the current URL plus every stored click id and UTM that is missing from it, capped at 2,000 characters.
   - Optional: call `decorateAddressBar(window, url)` while the overlay is open. The webview's own "Open in browser" menu then carries it too. It only replaces the query on the same path.
2. **Providers.** In `eb()`, render `presentAuthProviders(['google','apple','discord','twitter'], { inAppBrowser: <module 825073 detector> })`.
   - Default `hide`: Google is replaced by the handoff CTA.
   - `deemphasize`: Google moves last, in secondary style, with the hint.

The UA lists are module 825073's verbatim. Tests check parity with the shipped detector.

## §7 Legacy Amplitude duplicate page views: `src/legacy-amplitude-init.ts`

See [`legacy-amplitude-dedupe.md`](legacy-amplitude-dedupe.md) for the evidence and the cause.

**Patch.** In legacy module **16585** (`pages/_app-a1820d4f2194dce7.js`), replace `il` (exported as `S1`):

```ts
export const S1 = createIdempotentAmplitudeInit(amplitude, () => readDeviceIdCookie(document.cookie));
```

- The first call is argument-for-argument the shipped `init`.
- Later calls from module 78491 `useInitAmplitude` and module 41545's layout effect only call `setUserId`/`setDeviceId` when those change.

## Proof stand-ins (not for production)

`src/proof-simulations.ts` holds stand-ins for §1, §3 and §6, so the sealed watchdog replay can observe their effect without a deploy. It is bundled into `../gtm/proof/inject_web_fixes.min.js`:

- a merge guard on `oa_ad_clids` writes;
- a trap that sets the Meta flags on the `fbq` stub;
- a History API page-view contract;
- decoration of the handoff overlay's URL.
