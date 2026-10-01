# shim/: OpenArt Click ID Shim v2

This is a drop-in replacement for the inline `<!-- OpenArt Click ID Shim -->` script on the Astro marketing pages (captured in `raw/bundles/page_.html`, right after the Google tag gateway snippet).

It keeps everything the current shim does. It adds:

- the missing click ids;
- the Meta `_fbc` cookie;
- the OpenAI Ads `__oppref` cookie;
- a UTM store.

It also stops logging values to the console, and it stores or posts only values that pass the click-id pattern (the original stored raw URL values).

## Integration (Astro "pageforge" base layout)

1. Find the inline script that begins `<!-- OpenArt Click ID Shim -->` / `(function() { try { var params = new URLSearchParams(…`. [I] It is the first inline script in `<head>` of every Astro page.
2. Replace its body with the contents of **`dist/openart-click-id-shim.min.js`** (6.4 KB, ES2018, no dependencies, wrapped in `try/catch`).
   - Keep it **inline** (`<script is:inline>` in Astro, so it is not bundled or deferred).
   - Keep it in the same position: before any vendor script, so the cookies exist before GTM tags read them.
3. Deploy. Nothing else on the page changes. Existing readers (the Suite's `readAdClickIds`, Amplitude, Impact, Tolt) keep working.

**Consent** (see `../consent/CONSENT.md`; the same order as the consent defaults, the HubSpot fill and `packages/edge-attribution`):

- The shim holds back every write when `window.__oaConsent = {ad_storage: 'denied'}` or the `oa_consent` cookie says `ad_storage: "denied"`. The `oa_consent` cookie is the contract `packages/edge-attribution` also reads.
- Under **Global Privacy Control** (`navigator.globalPrivacyControl`) or a recorded **US "do not sell or share" opt-out** (`oa_consent` `"opt_out_sale_sharing": true`, or the IAB `usprivacy` cookie `1?Y?`), it holds back the ad identifiers (click-id cookies, `oa_ad_clids`, `_fbc`, `__oppref`), Impact and Tolt, and still writes the non-identifying `oa_utm`. A recorded sale/sharing opt-out wins even over an `ad_storage` grant; an explicit grant overrides GPC.
- The CMP's grant callback calls `window.oaClickIdShim.grant()` to persist what was held back, except the ad identifiers while a sale/sharing opt-out is recorded.
- `result.consent` reports the decision (`granted`, `denied`, `opt_out` or `none`). With no signal present, the shim behaves as it does today.

## What it writes

Cookies are `Path=/; Domain=.openart.ai; SameSite=Lax`, plus `Secure` on https. They are written only on `*.openart.ai`.

| Name | Value | Lifetime | New? |
|---|---|---|---|
| `gclid`, `fbclid`, `msclkid`, `rdt_cid`, `gbraid`, `wbraid` | the URL value, only when it passes the click-id pattern | 90 days | same cookies as today; **raw values are no longer stored** |
| `oa_ad_clids` (cookie + localStorage) | JSON `{key:{v,ts}}`. Merges the stored cookie, localStorage and the URL. A click id already stored with the same value keeps its first-seen `ts` (the rule `captureAdClickIds` and the edge Worker use). A rewrite re-stores only valid entries: the ten keys, plus up to 20 other writers' keys (the edge adds `dclid`, `irclickid`, `epik`, `sccid`) whose values pass the pattern. | 90 days | **All ten keys**: `gclid gbraid wbraid fbclid msclkid ttclid rdt_cid twclid li_fat_id oppref`. Today there are six, and the Suite rewrite deletes `gbraid`/`wbraid` (fixed in `../app-patches`). |
| `_fbc` | `fb.1.<ms>.<fbclid>` | 90 days | **new**. Minted when the URL has `fbclid`. An existing `_fbc` for the same fbclid is kept, so its timestamp does not move. |
| `__oppref` | the `oppref` value, when it passes the click-id pattern (the same value `oa_ad_clids` keeps) | 30 days | **new**. The OpenAI Ads SDK on app pages reads it when the URL no longer has `oppref`. |
| `oa_utm` (cookie + localStorage) | JSON of the last non-empty `utm_*` set, plus `ts` | 90 days | **new** (addition). Read by the HubSpot fill and the in-app-browser handoff. |
| `impact_clickid`, `impact_irpid` (localStorage), `POST /legacy/api/tracking/impact/store-clickid` | `im_ref` / `irpid`, only when they pass the click-id pattern | as today | same keys and endpoint; **raw values are no longer stored or posted** |
| Tolt `<script data-tolt=…>` | production host only | n/a | same as today |

**Why `_fbc` and `__oppref` [O].**

- The watchdog baseline shows the first app-page Meta hit after an Astro landing carries no `fbc` (`meta.fbc.*`). The Astro pages have no Meta pixel to set `_fbc`, and `/home` has no `fbclid` in its URL.
- The OpenAI SDK sends no `oppref` after the hop (`openai.oppref.marketing_landing`).

**Deliberate non-writes.**

- A cookie that already holds the same value is not rewritten. For example, one set server-side by the edge Worker, which Safari does not cap at 7 days.
- Invalid values are dropped, for every value the shim stores or posts: the six standalone cookies, `oa_ad_clids`, `_fbc`, `__oppref`, `im_ref`/`irpid` and the Impact POST. The pattern is `^[A-Za-z0-9._-]{1,512}$` (CLICK_ID_VALUE_PATTERN), the same as today's `oa_ad_clids` pattern and the Suite reader's. The original shim stored raw URL values, so one crafted link could plant a 3.8 KB cookie on every openart.ai request for 90 days, or markup in localStorage and the backend. The edge Worker, which also accepts base64 characters, still captures such refs server-side.

## Files

| Path | What it is |
|---|---|
| `src/shim.ts` | `runClickIdShim(window, {now})`: pure logic, returns what it wrote |
| `src/entry.ts` | Browser entry that the dist file is built from |
| `dist/openart-click-id-shim.min.js` | The paste-in build: `npx tsx scripts/build.ts` from `packages/web-fixes` |
| `test/shim.test.ts` | happy-dom tests. The original shim (`test/fixtures/original-click-id-shim.js`, verbatim) runs side by side for parity on cookies, Impact, Tolt and hosts. Also covers new keys, `_fbc`, `__oppref`, `oa_utm`, 3.8 KB and `<img…>` payloads on every stored or posted value, first-seen `ts` agreement with `captureAdClickIds`, the consent gate (denial, GPC, US opt-outs), coexistence with edge-set cookies, and robustness. |

## Verify after deploy

Open `https://openart.ai/?gclid=T1&gbraid=T2&fbclid=T3&oppref=T4&utm_source=test` in a fresh profile, then check in DevTools → Application → Cookies:

- `oa_ad_clids` holds `gclid`, `gbraid`, `fbclid` and `oppref`;
- `_fbc` = `fb.1.<13 digits>.T3`;
- `__oppref` = `T4`;
- `oa_utm` holds `utm_source`;
- the console shows no `value` logs.

`window.oaClickIdShim.version` should be `2.0.0`.
