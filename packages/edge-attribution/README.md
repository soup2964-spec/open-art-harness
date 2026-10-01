# @openart-signal/edge-attribution

Server-side attribution capture for OpenArt's **existing** Cloudflare Worker. This is a module, not a new proxy: it wraps the fetch handler OpenArt already runs on `openart.ai/*`, and the handler and origin routing stay as they are.

On every real page view (a document navigation), it:

- reads the click ids, UTMs, Referer and landing path;
- keeps them in a signed, `HttpOnly`, server-set cookie (`oa_attr`) that no script, blocker or Safari ITP cap can touch;
- re-issues the client-readable cookies the pixels and OpenArt's own code already read (`oa_ad_clids`, `_fbc`, `ttclid`, `__oppref`), server-set and in their exact formats;
- writes a device-keyed record to KV via `ctx.waitUntil`;
- hands attribution over from Instagram/TikTok webviews to the system browser.

Consent is gated per region by default. Nothing is ever sent to an ad platform from the edge.

Evidence paths below are relative to `openart_2026-09-29/` (the research folder: `research/`, `raw/`, `crawl/`).

---

## 1. Which leaks it fixes

| Leak (verdict) | Evidence | What the module does |
|---|---|---|
| **uBlock Origin**. uBO strips `gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `msclkid`, `twclid`, `ttclid` (and `_gl`, `gclsrc`, `gad_*`) before the page loads. It also blocks every pixel, Amplitude and the tag gateway `/4vu8/`, so `oa_ad_clids` is never created. | `research/01_live_teardown.md` §T7(b)(c) and §4 #1. `crawl/teardown2/blocklists/ubo_privacy.txt` L1209 (gateway path) and L1480–1654 (`$removeparam`). | The Worker handles OpenArt's own page request. uBO strips parameters from it and blocks scripts, but does not block the page itself, so the Worker still sees what arrives. It stores what survives (`utm_*`, `li_fat_id`, `rdt_cid`, `oppref`, plus the Referer host for the channel) in `oa_attr` and KV. Stripped parameters never reach any server, so they cannot be recovered (§9). |
| **Safari ITP**. Every click-id cookie is set by JavaScript and capped at 7 days (24 h after link-decorated landings). Only `oa_device_id` / `unique_device_id` are server-set. | `01` §4 #9. | `oa_attr` is server-set and `HttpOnly`. Nothing client-side can shorten or rewrite it, and it lives 13 months. The client-readable copies are re-issued server-side from `oa_attr` on the first navigation after ITP deletes them, with their **original** timestamps (tests: "restores _fbc with the ORIGINAL timestamp"). |
| **Meta multi-hop and return journeys** lose `fbc` in both the pixel and CAPIG (T1f, T1c2, T1g). No OpenArt code writes `_fbc`. Claim G4: CONFIRMED (multi-hop and return journeys; the direct hop recovers fbclid from the Referer). | `01` §T1, `crawl/teardown2/meta_fbc_matrix.json`, `02` §3.3–3.4, `00_claims_register.md`. | `_fbc = fb.1.<ms>.<fbclid>` is set on the **landing response itself**, before any pixel runs, following Meta's rules (`08` §2.4). It is deliberately not `HttpOnly`, so the pixel and the CAPI Gateway both read it. Meta's pixel keeps an existing `_fbc` whose fbclid matches (`maybeUpdatePayload`, verified in `crawl/teardown2/bodies/a169ba40…js`). |
| **ChatGPT-ads `oppref`** is lost on every marketing-page landing: the SDK runs only on the app and reads only `location.search`. | `01` §T3 (T3a vs T3b), `crawl/teardown2/js_fetch/oaiq.min.js`. | `__oppref` (30 d, raw value) is set on the landing response. The SDK already falls back to that cookie ("using stored click id from cookie", `01` §T3). |
| **gbraid / wbraid dropped**. The Suite reader keeps only 4 keys, and an app landing rewrites `oa_ad_clids` and deletes the stored gbraid (T2c). `rdt_cid`, `li_fat_id` and `twclid` never enter the store. Claim G6: CONFIRMED. | `01` §T2–T3. `02` §3.3. Suite module 162070 in `raw/bundles/js/openart.ai__suite___next__static__chunks__91db8069961c7577.js`. | The server-set `oa_ad_clids` carries all 14 keys in the same `{key:{v,ts}}` format. After the Suite's 4-key rewrite, the next navigation restores the dropped keys. `oa_attr`, KV and the origin payload always keep them. |
| **Webview handoff**. "Open page in your browser" copies `window.location.href`, so after the usual landing → `/home` hop it carries no click ids, no UTMs and no token. Google OAuth is blocked in webviews. Claim G5: CONFIRMED. | `01` §T11, `crawl/teardown2/T11a_ig_home.json`, `T11b…`, `T11c…`. | `POST /api/attribution/handoff` → `GET /r/:token` restores the attribution cookies in the external browser (§6). |
| **TikTok `ttclid`** cookie lives 1 day, so events more than 24 h after the click can't carry it. | `01` §T3 (TikTok row) and §4 #12. `crawl/teardown2/T3b_ctrl_home_otherclids.json`. | A server-set `ttclid` lasts ≥ 28 days in TikTok's own `<id>.<13-digit ms>` format. The pixel keeps it rather than overwriting it (`eB`, verified in `crawl/teardown2/bodies/854097695c4c…js`). |
| **No CMP / Consent Mode**. `gcd=13l3l3l3l1l1`. Claim G7: CONFIRMED (US vantage). | `01` §T6, `02` §3.8, `08` §1.7. | Consent is gated by region and CMP signal, and each record stores the consent snapshot for server-side propagation (§4). |

## 2. Drop-in (exactly how)

**1. Add the package** to the Worker repo as a workspace dependency or vendored copy. It has no runtime dependencies.

**2. Wrap the existing fetch handler.** This is the only code change:

```ts
import { withAttribution } from "@openart-signal/edge-attribution";

// before: export default { fetch: existingFetch };
export default {
  fetch: withAttribution(existingFetch, { cookieDomain: ".openart.ai" }),
  // keep any other handlers (scheduled, queue, ...) as they are
};
```

`existingFetch` gets the original, untouched request and runs **concurrently** with capture. Its response comes back with cookies appended. Body, status, streaming and redirects are unchanged, and errors the handler throws propagate unchanged.

Capture itself never throws. Internal failures go to `onError` and the response passes through. See `src/example-worker.ts`.

If you prefer the lower-level API:

```ts
const attribution = await captureAttribution(request, env, ctx, options);
const response = await existingFetch(request, env, ctx);
return attribution.apply(response); // Promise<Response>: appends Set-Cookie (the origin's own cookies win)
```

**3. Bindings** in the existing wrangler config (placeholders in `wrangler.toml`):

```toml
[[kv_namespaces]]
binding = "ATTRIBUTION_KV"
id = "<new namespace id>"

[secrets]
required = ["ATTRIBUTION_SECRET"]
```

```sh
wrangler secret put ATTRIBUTION_SECRET   # 32+ random chars; to rotate, move the old value to ATTRIBUTION_SECRET_PREVIOUS
```

**4. Routes: nothing new.** The handoff routes (`/api/attribution/handoff`, `/r/<22-char token>`) ride on the existing `openart.ai/*` route.

**5. Placement.** Make the wrapper the **outermost** layer. On a first visit the origin (or OpenArt's own Worker logic) mints `oa_device_id` on the response, and the module reads it from that `Set-Cookie` to key the KV record (`oa_device_id` is server-set, 365 d, `02` §1 and T3b).

**6. Try it locally** (never against a real origin):

```sh
cp .dev.vars.example .dev.vars        # ORIGIN_OVERRIDE points at a local stub
npx wrangler dev --local
curl -i -H 'Accept: text/html' -H 'Sec-Fetch-Dest: document' 'http://127.0.0.1:8787/?fbclid=F&utm_source=ig'
```

### Options (`CaptureOptions`)

| Option | Default | Purpose |
|---|---|---|
| `cookieDomain` | `".openart.ai"` | Domain attribute. Hosts outside it (previews, localhost) get host-only cookies. |
| `consentPolicy` | `createDefaultConsentPolicy()` | Injectable `(ctx) => ConsentDecision` (may be async). See §4. |
| `persistence` | KV when `ATTRIBUTION_KV` is bound | `kvPersistence()`, `originEndpointPersistence({url})`, an array of both, or `false`. |
| `excludedReferrers` | Stripe and Google/Apple OAuth hosts | Referrers that must never become a referral touch (payment/OAuth returns). |
| `skipPathPrefixes`, `hosts` | assets, APIs, `/4vu8/`; all hosts | Extra non-page paths and a host allow-list. |
| `isBot`, `minBotScore` | UA rules + Bot Management | Replaces bot detection. Bot Management score 1 and `verifiedBot` are skipped. |
| `ttclidTtlDays` | `28` (clamped 28..90) | TTL of the server-set `ttclid`. |
| `privateCacheOnSetCookie` | `true` | When cookies are added, `Cache-Control` becomes `private` (keeps shared caches from replaying another visitor's cookies). |
| `handoff` | enabled | `HandoffOptions` (paths, TTL, fallback) or `false`. |
| `onError`, `now` | `console.warn` once, `Date.now` | Telemetry hook; clock injection. |

## 3. What it sets, and when

**Processed requests.** Only `GET` top-level document navigations:
- detected by `Sec-Fetch-Dest: document`, falling back to `Accept: text/html` for older Safari.
- **Skipped:** prefetch and prerender (`Sec-Purpose`, `Purpose`, `X-Purpose`, `X-Moz`).
- **Skipped:** bots. That means crawler, unfurler, monitor and headless UAs, plus Cloudflare Bot Management `verifiedBot` or score 1. A phone model like "CUBOT X30" is not a bot.
- **Skipped:** assets and non-pages: static extensions, `/_next/`, `/suite/_next/`, `/_astro/`, `/api/`, `/suite/api/`, `/legacy/api/`, `/4vu8/`, `/cdn-cgi/`.

**Recovery.** If a landing was never processed (prerendered, consent given later, Worker skipped), the next navigation's same-origin `Referer` still carries the full landing URL: OpenArt sends `strict-origin-when-cross-origin` (`01` §T1 mechanism). Click ids and UTMs are then recovered from it, and never counted twice.

| Cookie | Attributes | Lifetime | Value | Read by |
|---|---|---|---|---|
| `oa_attr` | `HttpOnly; Secure; SameSite=Lax; Domain=.openart.ai; Path=/` | 390 d (13 × 30) from first touch, **never extended** | `1.<base64url JSON>.<base64url HMAC-SHA256>` | This module; the backend at signup |
| `oa_ad_clids` | `Secure; SameSite=Lax; Domain=.openart.ai` (not HttpOnly) | 90 d from the newest entry | `encodeURIComponent(JSON {key:{v,ts}})`, merged with the existing cookie, unknown keys kept | Astro shim, Suite module 162070 |
| `_fbc` | same, not HttpOnly | 90 d from first observation of that fbclid | `fb.1.<ms>.<fbclid>` (dots packed as `__DOT__`, like the pixel) | Meta pixel, CAPI Gateway |
| `ttclid` | same, not HttpOnly | ≥ 28 d from the click | `<ttclid>.<13-digit ms>` | TikTok pixel |
| `__oppref` | same, not HttpOnly | 30 d from the click | raw value | OpenAI Ads SDK |

**Rules**, all tested:
- A cookie is written only when absent or when its value would change. A new click value gets a new timestamp; the same value keeps its original one (Meta `maybeUpdatePayload`, TikTok `eB`).
- A navigation with nothing new sets **no** cookies.
- `Max-Age` counts down from the click, never from the request, and never exceeds 400 days (Chrome's cap).
- An observation older than its window is forgotten, not "original": the same click id on a fresh landing after 90 days gets a fresh timestamp.
- Ids recovered from a same-origin `Referer` only fill platforms nothing else knows. A stale landing tab never overrides a newer click or moves the last touch back.
- `Set-Cookie` headers the origin response already has win over the module's.
- **Size.** `oa_attr` stays under 2 KB, and everything this module stores in the browser stays under **4 KB together**, counting cookies already stored, so one crafted link cannot bloat every later request. Least-useful data is dropped first, deterministically.
- **Landing paths are redacted.** Paths under auth, reset-password, magic-link, verify or invite routes are cut to their prefix (`/reset-password/:redacted`). Token-shaped segments anywhere (UUIDs, JWTs, long hex, long mixed-case random ids) become `:token`, while ordinary slugs are kept.

**First/last touch.**
- **First touch** is the first observed arrival. It never changes until the record expires. It is flagged `seenBefore` if the visitor already had `oa_device_id` (left-censored after deploy).
- **Last touch** is the last non-direct arrival. A reload or back/forward within 30 min is the same touch, and Stripe/OAuth returns are ignored.
- **Touch type:** `paid` (any click id) > `campaign` (UTM) > `referral` (external Referer host) > `direct`.

`oa_attr` payload, decoded:

```json
{"v":1,"c":1790701320000,
 "f":{"a":1790701320000,"t":"p","p":"/","u":{"s":"ig","c":"seedance"},"k":["fbclid","ttclid"],"r":"www.facebook.com","b":"instagram"},
 "l":"f",
 "k":{"fbclid":["KJAUDIT_F",1790701320000],"ttclid":["KJAUDIT_T",1790701320000]},
 "m":"f","pa":1790701320000}
```

Top-level keys:
- `c` created (ms).
- `f` / `l` first and last touch. `"l":"f"` means the last touch is identical to the first.
- `k` click-id vault: key → [value, first-seen ms], pruned after 90 d.
- `m` consent mode: `f` full, `u` utm-only.
- `pa` persisted at.
- `hf` handoff-from device.

Touch keys:
- `a` at, `t` type (`p`/`c`/`r`/`d`), `p` landing path (no query).
- `u` UTM: `s` source, `m` medium, `c` campaign, `t` term, `n` content, `i` id.
- `k` platforms present, `r` referrer host, `b` in-app browser.
- `sb` seen before, `rv` recovered from Referer.

A validly signed payload that breaks this schema is still rejected.

## 4. Consent

**Default policy** (`createDefaultConsentPolicy`). Region comes from `request.cf.country` and `cf.isEUCountry`, gated on `packages/contracts` `CONSENT_REQUIRED_REGIONS` (`REGULATED_COUNTRIES` is that set), the one list every package uses; its `consentCountry()` normalises the code (`UK` → `GB`; `XX`, `T1`, `ZZ` → unknown). Only that side-effect-free module is imported, so the Worker bundle and `dist/edge-sim.js` inline the list, not the contracts package.

| | No CMP decision | `ad_storage` granted | `ad_storage` denied |
|---|---|---|---|
| EEA (EU27 + IS/LI/NO, incl. RE, GF, GP, MQ, YT, MF, AX, IC, EA), UK, CH | **utm-only** | full | utm-only + purge |
| Unknown geo (no cf, `XX`, Tor `T1`, `ZZ`) | **utm-only** (fail closed; configurable) | full | utm-only + purge |
| Elsewhere | full | full | utm-only + purge |
| Elsewhere with `Sec-GPC: 1` | **utm-only** (default; `gpc: "flag"` → full) | full | utm-only + purge |
| Any region with a US sale/sharing opt-out recorded (`usprivacy` `1?Y?`, or `oa_consent` `"opt_out_sale_sharing": true`) | **utm-only** + purge (default; `optOutSaleSharing: "flag"` → recorded only) | **utm-only** + purge (the opt-out wins) | utm-only + purge |

- **utm-only** keeps an `oa_attr` holding only non-identifying fields:
  - UTMs, landing path and referrer host;
  - touch type and *which* platforms were clicked (keys, no values).
  - It holds no click-id values and no device linkage. No advertising cookie is set, and nothing is written under the device id (§5).
- **Purge:** an explicit refusal (or a recorded sale/sharing opt-out) also expires any `oa_ad_clids`, `_fbc`, `ttclid` and `__oppref` present in the browser.
- **Denying `analytics_storage` as well** (with ads not granted) means **none**: nothing is stored and `oa_attr` is deleted.
- Set `withoutAdConsent: "none"` if legal decides even utm-only first-party storage needs consent.
- **GPC** (`Sec-GPC: 1`) is treated as an **ad-storage opt-out by default** (the CPRA reading) and recorded on the record. An explicit CMP grant still wins (the visitor opted back in). `gpc: "flag"` only records it.
- **US "do not sell or share" opt-out** (`optOutSaleSharing` on the decision, `opt_out_sale_sharing` in the payload, the `packages/contracts` `Consent` field). `readOptOutSaleSharing` maps the mechanisms that leave it in a first-party cookie:
  - the `oa_consent` contract with `"opt_out_sale_sharing": true`, written by OpenArt's "Do Not Sell or Share My Personal Information" link or the CMP's US banner (the same callback as below);
  - the IAB CCPA US Privacy string cookie `usprivacy` with the opt-out-of-sale flag `Y` (`1YYN`, `1NYN`); `1YNN` and `1---` are not opt-outs.

  It is an ad opt-out and an explicit choice by default: utm-only, and the advertising cookies are purged. Unlike GPC, it also wins over an `ad_storage` grant, because US CMPs often grant by default and the opt-out is the visitor's latest choice. `optOutSaleSharing: "flag"` only records it. Other mechanisms (a GPP string, a CMP-specific category) map through `readOptOut`, or by writing the `oa_consent` field. Downstream, `gpc` and `opt_out_sale_sharing` block ad sharing in every region (`packages/contracts` `blocksAdSharing`). The web fixes read the same signals in the browser (`packages/web-fixes/consent/CONSENT.md`).
- **Policy output is validated.** A custom policy that returns anything unexpected (for example an unknown mode) fails closed to `none` and reports to `onError("consent")`.
- **Before any choice.** In the EEA/UK/CH without a CMP decision, the utm-only `oa_attr` above *is* stored. That is the brief's "store only non-identifying UTMs"; set `withoutAdConsent: "none"` if counsel reads ePrivacy Art. 5(3) as needing consent for that too.
- Each record stores its consent snapshot (`mode`, `region`, `explicit`, `gpc`, `optOutSaleSharing`, Consent Mode `signals`). The conversion uploader can then set Data Manager `consent`, Meta LDU, Microsoft `adStorageConsent`, and TikTok/Reddit LDU per user (`08` §1.7 and §B6 "Consent propagation to server events").

**Mapping OpenArt's CMP** (none exists today, G7). Pick one:

1. **Recommended, CMP-agnostic.** Have the CMP's consent callback write the object it passes to `gtag('consent','update', …)`:
   ```js
   document.cookie = "oa_consent=" + encodeURIComponent(JSON.stringify(consent)) +
     "; Path=/; Domain=.openart.ai; Max-Age=15552000; Secure; SameSite=Lax";
   // consent = {ad_storage:"granted", analytics_storage:"granted", ad_user_data:"granted", ad_personalization:"denied"}
   ```
   The default policy reads `oa_consent` (`parseConsentModeCookie`).
2. **Cookiebot:** `createDefaultConsentPolicy({ cmpCookie: "CookieConsent", parseCmpCookie: parseCookiebotCookie })`. `marketing` maps to ad signals and `statistics` to `analytics_storage`; `-1` means no decision.
3. **OneTrust:** `parseCmpCookie: (raw) => parseOneTrustCookie(raw, { ads: "C0004", analytics: "C0002" })` on `OptanonConsent`. Use your tenant's category ids.
4. **Anything else** (for example a TCF string): pass your own `consentPolicy`.

Verify in a real EEA session: the teardown could not simulate EU traffic (`01` §T6).

## 5. Persistence and the backend change

**KV (default).**
- Key `dev:<oa_device_id>`, value the `AttributionRecord` JSON, `expirationTtl` 90 days.
- Written inside `ctx.waitUntil`, so the response never waits. A broken `waitUntil` is reported and never costs the visitor their cookies.
- **When it is written:** only with full ad consent (the device id is an identifier, so there are no device-keyed records in utm-only mode), and only for records that carry signal (a marketing touch or a click id; a bare direct visit writes nothing).
- **How often:** when the record's content changes (consent-signal changes included, so the stored snapshot stays accurate), or 30 days after the last write, which keeps active visitors' TTL alive. Change is judged by content, so re-importing and trimming can never cause a write loop.
- **Explicit withdrawal** deletes the record: `kv.delete("dev:<id>")`, or a signed `{"device_id", "forget": true}` POST for the origin adapter.
- On a first visit the device id comes from the origin's `Set-Cookie`. `apply()` then re-signs `oa_attr` with it, so the next request does not write again. With no device id at all, the record waits in the cookie until the next request that has one.
- Failures go to `onError("persist:kv")`, never the response.

**Origin endpoint (alternative or additional).**
- `originEndpointPersistence({ url })` POSTs the record, also from `waitUntil`.
- Body: the **extended `/api/user/ad-click-ids` shape** below.
- Headers: `X-OA-Attribution-Timestamp` (ms) and `X-OA-Attribution-Signature: v1=<base64url HMAC-SHA256(secret, "oa_attr_origin.1.<timestamp>.<body>")>`.
- Reference verifier: `verifyOriginSignature` (5-minute window, constant-time compare).
- Timeouts and non-2xx responses go to `onError("persist:origin")`.

**The shared contract (`packages/contracts`).** `conversion-service` reads the user's store record as `ClickIdStoreRecordExtended`, a flat, strict shape with 10 click keys, `utm_*`, `landing_url`, `referrer` and `context_captured_at`.
- `toClickIdStoreRecordExtended(record)` emits exactly that shape, from the last marketing touch or else the first. Click ids outside the contract (`dclid`, `irclickid`, `epik`, `sccid`) stay in the richer payload.
- `mergeAttributionForSignup(...).storeRecord` returns it for the signup write.
- `originEndpointPersistence({ url, format: "contract" })` posts it. The device id then goes in `X-OA-Device-Id`, bound by the signature input `oa_attr_origin.2.<ts>.<deviceId>.<body>`.
- `test/node/contracts.test.ts` validates all three against the contract's own Zod schema, `clickIdsFromStoreRecord`, `utmFromStoreRecord` and `buildMetaFbc`.

### Backend change: extend `/api/user/ad-click-ids`

Today the Suite posts `{gclid, gclid_created_at, fbclid, fbclid_created_at, msclkid, …, ttclid_created_at}` after login (`02` §3.3; `created_at` = ms from `oa_ad_clids.ts`). The extension is additive, so the current handler keeps working and new fields are optional:

```jsonc
{
  "device_id": "51e60b80-46f8-48c2-9780-f92e903bf8f8",      // edge writes only
  "gclid": "…", "gclid_created_at": 1790701320000,             // unchanged semantics
  "gbraid": "…", "gbraid_created_at": 1790701320000,           // + wbraid, dclid, twclid, li_fat_id,
  "rdt_cid": "…", "rdt_cid_created_at": 1790701320000,         //   rdt_cid, oppref, irclickid, epik, sccid
  "fbc": "fb.1.1790701320000.IwAR…",                           // ready for CAPI user_data.fbc
  "attribution": {
    "schema": "oa_attr/1", "source": "edge",
    "created_at": 1790701320000, "expires_at": 1824397320000, "updated_at": 1790701380000,
    "first_touch": {"at": 1790701320000, "type": "paid", "utm": {"source": "ig"}, "click_keys": ["fbclid"],
                    "referrer_host": "www.facebook.com", "landing_path": "/", "in_app_browser": "instagram",
                    "seen_before": false, "recovered": false},
    "last_touch": { … same shape … },
    "consent": {"mode": "full", "region": "unregulated", "explicit": false, "gpc": false, "opt_out_sale_sharing": false, "signals": {}},
    "handoff_from": null
  }
}
```

1. **Store device-keyed records.** Add a service path (for example `/api/internal/attribution`, reachable only from the Worker) that verifies the signature headers. It upserts `device_attribution(device_id PK, record JSONB, updated_at, expires_at = now() + 90 days)`.
2. **Merge at signup.** When an account is created, run the merge spec below. `mergeAttributionForSignup` in `src/merge.ts` is the reference implementation, with tests in `test/worker/merge.test.ts`; port it as-is. The inputs are:
   - the `oa_attr` cookie on the signup request, verified with `ATTRIBUTION_SECRET`;
   - `device_attribution[oa_device_id]`;
   - `device_attribution[record.handoff_from]`, if set;
   - the user's existing attribution.

   Call it as `mergeAttributionForSignup({ existing, cookie, records: [deviceRecord, handoffDeviceRecord], signupAt, consentMode })`. It returns `{ record, payload, storeRecord }`.

   **Binding.** Device ids are client-held, so anyone who knows one can make the edge write under it. When the verified cookie is present, merge only device records that belong to this browser:
   - records of the **same lineage** (same `created_at`, which only the edge sets);
   - the record of the device the **signed** cookie names in `handoff_from`.

   Ignore all other device records. Without a cookie (cleared before signup), fall back to all of them.

   The rules:
   1. Ignore records created, touches made and click ids observed **after** `signup_at`.
   2. The first touch is **immutable** once stored on the user. Otherwise take the earliest across inputs.
   3. The last touch is the latest non-`direct` touch at or before signup.
   4. For click ids, per platform, replay observations in time order. The same value keeps its earliest timestamp; a different value replaces it. Drop entries older than 90 days.
   5. If consent at signup is utm-only, strip every click id, `fbc` and `handoff_from`.
   6. For `fbc`, prefer a browser-observed value with the same fbclid; otherwise use `fb.1.<ts>.<fbclid>`.
   7. The result is order-independent and idempotent. Write it to the user and into the same storage `/api/user/ad-click-ids` uses.
3. **Client:** widen the Suite's `["gclid","fbclid","msclkid","ttclid"]` list (module 162070) to the 14 keys so the post-login migration also carries them (`01` §4 #5).

Verifying `oa_attr` in the backend (Python sketch; full validation mirrors `decodeStatePayload`):

```python
import base64, hashlib, hmac, json

def b64u(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def verify_oa_attr(value, secrets, now_ms):
    parts = value.split(".")
    if len(parts) != 3 or parts[0] != "1": return None
    _, payload, tag = parts
    msg = f"oa_attr.1.{payload}".encode()
    try: tag_bytes = b64u(tag)
    except Exception: return None
    if not any(hmac.compare_digest(hmac.new(s.encode(), msg, hashlib.sha256).digest(), tag_bytes) for s in secrets):
        return None
    state = json.loads(b64u(payload))
    if state.get("v") != 1 or not (0 <= now_ms - state["c"] <= 390 * 86_400_000): return None
    return state  # compact keys, see §3
```

## 6. In-app-browser handoff

```
webview (Instagram/TikTok)                 edge                               system browser
  overlay opens ─ POST /api/attribution/handoff {path} ─▶ verify oa_attr, apply consent,
                                                         KV.put(sha256(token)) TTL 30 min:
                                                         state + target PATH + attribution params
            ◀──── {token, url:"https://openart.ai/r/<token>", expiresAt, path}
  user opens url in the browser ──────────────────────────────────────▶ GET /r/<token>
                                                         claim + KV.delete (single use),
                                                         merge with that browser's own record,
                                                         set cookies (original click timestamps) ─▶ 302 <path>?<attribution params>
```

**What the app's "Trouble redirecting? Open page in your browser" overlay should do** (`01` §T11 describes today's overlay):

```ts
// The path plus the attribution params only, never the rest of the query (reset tokens, magic links).
// packages/web-fixes webview-handoff.ts handoffRequestPath() is the full version (it also validates
// the values); the Worker re-applies the allow-list either way.
function attributionPath(loc: Location): string {
  const keep = /^(gclid|gbraid|wbraid|dclid|fbclid|msclkid|ttclid|twclid|li_fat_id|rdt_cid|oppref|irclickid|im_ref|epik|sccid|ScCid|utm_(source|medium|campaign|term|content|id))$/;
  const params = new URLSearchParams([...new URLSearchParams(loc.search)].filter(([k]) => keep.test(k)));
  const query = params.toString();
  return query ? `${loc.pathname}?${query}` : loc.pathname;
}

async function handoffUrl(): Promise<string> {
  try {
    const res = await fetch("/api/attribution/handoff", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: attributionPath(location) }),
    });
    if (res.ok) return (await res.json()).url; // /r/<token>, or the plain URL when there is nothing to hand off
  } catch {}
  return location.href;
}
```

- **Option 2, "Copy the link"** (primary). Copy `await handoffUrl()` instead of `window.location.href`.
- **Option 1, "••• → Open in browser".** The webview's menu opens the *current* URL. Two choices:
  - While the overlay is open, point the URL at the token with `history.replaceState(history.state, "", new URL(url).pathname)`, and restore it on close. A reload inside the webview would spend the single-use token on the webview itself, so prefer the next choice. Caveat: in the Next.js App Router, `replaceState` syncs into `usePathname`, and Amplitude's history-based page views may log `/r/…`.
  - Or reword Option 1 to point users at Option 2.
- Also de-emphasise Google OAuth in detected webviews. Google blocks it there with `disallowed_useragent` (`01` §T11, §4 #7).

**Properties** (all tested):
- **Tokens:** 128-bit random, base64url, 22 chars. Only a **SHA-256 of the token** is stored in KV.
- **Lifetime:** 30 minutes, enforced both by KV `expirationTtl` and a stored `expiresAt`. After expiry the link still redirects but restores nothing.
- **What is stored:** the consent-filtered state, the target **path** (no query string) and the **allow-listed attribution params** (click ids under the alias they arrived with, `utm_*`), validated like a landing (`attributionParams`). A query string can carry a magic-link code, a reset token or an email; none of it reaches KV or the redirect. Click ids go into the entry, and into the redirect, only under full consent (the redeemer's effective consent is applied again at redemption). Entries written before this rule are re-sanitised when read.
- **Single use:** the first real navigation consumes the token. It is claimed in the isolate and **deleted from KV before anything is restored**; a second redemption gets a plain redirect and no cookies. Concurrent redemptions restore at most once per isolate, including when a KV read still returns the entry. KV has no atomic take, so across Cloudflare locations a second redemption can succeed only inside KV's delete-propagation window (seconds, rarely up to 60 s); put a Durable Object behind the claim if that window matters. Without a working `delete`, nothing is restored (fail closed).
- **What does not consume it:** bots and link unfurlers (they get the redirect without cookies, so sharing the link in a chat does not burn it), and non-document requests: an `<img>`, iframe or `fetch()` aimed at `/r/` gets the redirect and nothing else. Prefetch/prerender restores (and consumes), because an activated prerender must work. Redirects that restore nothing carry the path only.
- **Body reads:** streamed, with a 4 KB cap, so an endless body is never buffered.
- **Stored entries:** validated when read. Anything unexpected, such as an unknown consent mode, restores nothing (fail closed).
- **Redirect targets:** same-origin paths only. That rules out `//host`, backslashes, whitespace or control characters, and the handoff routes themselves. A path that carries a credential is refused too (`/invite/<id>`, `/reset-password/<uuid>`, `/auth/magic/<hex>`, any token-shaped segment: the rules `landingPath` redacts by), because the target is redirected to for bots and expired hits as well; the app then falls back to param mode. The normalised path (2,048) and the stored params (4,096) are capped at creation, so no token is issued that redemption could not use. Targets are normalised through `URL` and re-validated at redemption; an entry that fails is discarded, never redirected to.
- **Minting:** requires a same-origin `Origin` / `Sec-Fetch-Site`.
- **Responses:** `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
- **Consent never travels with the link.** The token is a bearer link. The external browser's own explicit choice wins; otherwise the webview's decision can only *narrow* the redeemer's own. A webview refusal carries over, a webview grant does not, so an EEA browser with no choice yet gets only the utm-level record until its CMP asks.
- **Merging:** the external browser's existing record is merged, not replaced: earliest first touch, latest last touch.
- **Lineage:** `handoffFrom` names the webview's device only if that is the device the *signed* cookie is bound to. A forged `Cookie: oa_device_id=<someone else>` on the POST cannot make the external browser inherit another device's record.
- **Route collisions:** only exact 22-char tokens under `/r/` are intercepted; other `/r/…` paths reach the origin. The prefix is configurable.

**Limits and ops notes:**
- **KV consistency:** KV is eventually consistent across PoPs, but webview and browser on one phone almost always hit the same PoP. A miss falls back to a plain redirect.
- **Rate limiting:** put a Cloudflare rate-limiting rule on `POST /api/attribution/handoff`.

## 7. edge-sim for the watchdog (`dist/edge-sim.js`)

```js
import { simulate, applySetCookies } from "@openart-signal/edge-attribution/edge-sim"; // = dist/edge-sim.js

const { setCookies, skipped, record, consent, changes } =
  simulate(requestUrl, requestHeaders, { now, country: "US", secret });   // synchronous
let jar = applySetCookies("", setCookies);                                 // chain the next hop with { cookie: jar }
```

- **Signature:** `simulate(requestUrl, requestHeaders) => { setCookies: string[] }`. It returns synchronously, so `await` is optional.
- **`requestHeaders`** may be a plain object, `[name, value]` tuples or a `Headers`. Include `cookie` to simulate a returning visitor.
- **Options** are optional:
  - `now` (ms), `country` (default `"US"`, the teardown's vantage; `null` means unknown geo);
  - `cf`, `secret` (default is an obviously fake key, so signatures are illustrative while names, attributes and payloads are exact);
  - `previousSecret`, `persistence`, `consentPolicy` (sync), plus every core option.
- **Shared code:** the Worker's parse, classify, consent, plan and render code, bundled by esbuild (from wrangler's dependency tree, so no new deps). Only the HMAC primitive differs (`node:crypto`).
- **Parity:** `test/node/edge-sim.test.ts` imports the **built file** and asserts byte-identical `Set-Cookie` lines and records against the Worker code path on 13 scenarios (including a US sale/sharing opt-out and a Canary Islands visit).
- **Build:** `npm run build`. `npm test` rebuilds first, and the parity test fails if `dist/` drifts from `src/`.

## 8. Privacy notes

- **Minimal data.**
  - No email, name or IP is stored. UTM values that look like email addresses are dropped.
  - Only the Referer **host** and the landing **pathname** (never the query) are kept.
  - Click ids are pseudonymous identifiers. In regulated regions they are kept only with ad consent, and so is device linkage (`handoffFrom`).
- **Retention.**
  - Click ids: 90 days (cookie and KV).
  - `oa_attr`: 13 months counted from the first touch and never extended by later visits, in line with the usual 13-month cookie guidance.
  - KV records: 90-day TTL, refreshed only by activity.
  - Handoff tokens: 30 minutes, single-use; only the path and the attribution params are stored.
- **Integrity and confidentiality.** `oa_attr` is `HttpOnly` and HMAC-signed with a domain-separated input. No third-party script (or XSS) can read or rewrite it, and forged or tampered values are ignored and replaced.
- **Device-keyed records are only as trustworthy as the device id.** KV records are keyed by the client-held `oa_device_id`, so the signup merge binds them to the signed cookie (same lineage, or the device the cookie names) rather than trusting them blindly (§5).
- **No ad-platform traffic.** The edge only sets first-party cookies and writes to OpenArt's own KV/backend. Any upload must honour the stored consent snapshot, GPC and the sale/sharing opt-out.
- **Withdrawal.** An explicit refusal purges the advertising cookies this module manages and strips identifiers from `oa_attr`.
- **Caching.** Per-visitor `Set-Cookie` responses are marked `private` (`public`/`s-maxage` removed). `Surrogate-Control` / `CDN-Cache-Control` are left alone: nothing caches downstream of this Worker. Revisit that if a CDN is ever put in front.
- **Attested, not sanitised.** UTM values, landing paths and referrer hosts are HMAC-attested as *what the edge saw*, not made safe. Treat them as untrusted text in every sink (HTML, SQL, spreadsheets).
- **Client-readable cookies can be tossed.** `oa_ad_clids`, `_fbc`, `ttclid` and `__oppref` live on `.openart.ai` and can be written by any subdomain or page script; they are inputs, re-validated on every request. Only `oa_attr` is signed.
- **Origin POSTs:** signed with a 5-minute window, not nonce- or endpoint-bound. Replays inside the window are idempotent upserts or deletes of the same record; bind the URL into the input if that endpoint ever does more.
- **Where cookies are set.** They are set by the Worker on `openart.ai`'s own document responses. Keep it that way rather than moving capture to a separate subdomain on other infrastructure, where WebKit's CNAME/third-party-IP defenses also cap server-set cookies.

## 9. Known limits (not fixed here)

- **Stripped parameters are gone.** Parameters uBO or Safari strips before the request never reach any server. For those users the module keeps UTMs, surviving click ids and the Referer channel. Browser pixels stay blocked, so closing that gap needs server-side conversion uploads, which this record feeds.
- **`_fbc` uplift is an inference.** That a server-set `_fbc` raises Meta match quality is inferred from Meta's docs (`08` §2.4). Measure it with the Dataset Quality API or Events Manager fbc coverage.
- **The Suite still posts only 4 keys** until its `KEYS` list is widened (§5).
- **Referer recovery depends on the Referrer-Policy.** It needs same-origin navigations to keep sending the full URL; the current `strict-origin-when-cross-origin` does.
- **No real EEA-IP QA yet** (`01` §T6).

## 10. Tests

```sh
npm test            # rebuilds dist/edge-sim.js, then vitest: workerd pool + Node project
npm run typecheck   # worker program (workers-types/latest) and Node program
```

- **339 tests in 17 files.**
- **workerd pool** (`@cloudflare/vitest-pool-workers` with the `wrangler.toml` KV binding), by file:
  - `parse`: click ids, aliases, charset/length caps, UTM hygiene, referrer classes, recovery.
  - `cookies`: attributes and domain; compatibility with the transcribed Suite reader and Astro shim; T2c healing; vendor formats; no churn; 4 KB budget; `apply()`.
  - `signing`: HMAC round-trip; the spec cross-check any backend can reproduce; tamper, rotation, expiry and schema rejection.
  - `fbc`: Meta's rules; the T1f/T1g journeys; ITP restore; `__DOT__`.
  - `touch`: first and last touch.
  - `consent`: every region and CMP case (the contracts region list, IC/EA/UK included), adapters, GPC default, the US sale/sharing opt-out (`usprivacy`, `oa_consent`), fail-closed policy output.
  - `skip`: bots, prefetch, assets.
  - `handoff`: lifecycle, expiry, open-redirect, credential paths, caps, CSRF, path-and-attribution-params-only storage, single use (sequential, racing, stale KV reads, a missing or failing KV delete, bots not consuming), legacy and unusable entries, consent carry-over, merge.
  - `persistence`: `waitUntil` never blocks, failures isolated, change-only writes, device id from the response, signed origin payload.
  - `ubo`: stripped landings built from the real `$removeparam` list.
  - `merge`: the signup spec, including binding device records to the signed cookie.
  - `integration`: the wrapper, documented options and the example Worker.
  - `properties`: replaying any scenario's request is a no-op (no cookies, no writes); exact boundaries (30 min, 90 d, 390 d, 30 d).
- **Node project:**
  - `edge-sim`: built-artifact parity on 13 first-visit scenarios and a 7-step returning journey (ITP deletion, EU visit, withdrawal, secret rotation).
  - `provenance`: constants re-derived from the evidence files: `ubo_privacy.txt`, the Astro shim, Suite module 162070, the fbevents and TikTok pixel code, the T3b cookies. Skipped if the research folder is absent; set `OPENART_RESEARCH_DIR` to point at it.
  - `config`: `wrangler.toml` holds placeholders only.
  - `contracts`: interop with `packages/contracts` (strict `ClickIdStoreRecordExtended` schema, `clickIdsFromStoreRecord`, `buildMetaFbc`).
- **Mutation check.** 45 hand-made mutants of the rules and defences above; all 45 are caught. Two defences are deliberately layered (the open-redirect guard, and ReDoS = bounded input + non-overlapping regexes), so each is mutated with both layers removed.
- **Independent review.** A security review and a TypeScript-correctness review (fuzzing, Worker-vs-sim journeys) reported no CRITICAL issues. Every confirmed finding is fixed with a regression test, except the three theoretical notes in §8.

`vitest.config.ts` uses `cloudflareTest()` inside vitest's `defineConfig`. `@cloudflare/vitest-pool-workers` 0.22 (vitest 4) no longer ships `defineWorkersConfig`; `cloudflareTest()` is its v4 replacement.

## 11. Files

| Path | Role |
|---|---|
| `src/capture.ts` | `captureAttribution`, `withAttribution` |
| `src/core/plan.ts` | the single decision function (state, touches, cookies, persistence) shared by Worker and sim |
| `src/core/parse.ts`, `classify.ts` | request facts; document/prefetch/bot/asset rules |
| `src/core/clicks.ts` | click-id vault; `oa_ad_clids`, `_fbc`, `ttclid` formats |
| `src/core/codec.ts`, `src/crypto.ts`, `src/core/secrets.ts` | compact encoding + validation; HMAC (Web Crypto); secret hygiene |
| `src/core/consent.ts` | default policy, regions (from `packages/contracts` `consent-regions`), CMP adapters, US sale/sharing opt-out mapping |
| `src/persistence.ts`, `src/runtime.ts` | KV and origin adapters; `waitUntil` plumbing, response cookie merge |
| `src/handoff.ts` | `/api/attribution/handoff`, `/r/:token` (path and attribution params only; single-use) |
| `src/merge.ts`, `src/core/record.ts` | merge-at-signup reference; extended `/api/user/ad-click-ids` payload; contract `ClickIdStoreRecordExtended` |
| `src/sim.ts` → `dist/edge-sim.js` | synchronous Node build for the watchdog |
| `src/example-worker.ts`, `wrangler.toml` | how to wrap the existing Worker; placeholder bindings |
