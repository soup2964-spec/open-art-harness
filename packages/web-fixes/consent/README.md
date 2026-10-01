# consent/: Consent Mode v2 defaults

- Region-scoped Consent Mode v2 defaults: EEA, UK and CH denied (the `packages/contracts` region list); elsewhere granted, except that the ad signals are denied when the browser sends Global Privacy Control or a US sale/sharing opt-out is recorded.
- `ads_data_redaction` and `url_passthrough` on.
- A defined integration point for whichever CMP OpenArt chooses.

**CMP choice, wiring and the server-side consent path:** [`CONSENT.md`](CONSENT.md). **GTM steps:** `../gtm/CHANGES.md` B12.

| Path | What it is |
|---|---|
| `CONSENT.md` | Today's state, defaults, GPC and US opt-out handling across the web fixes and the edge, CMP options (Google-certified partners), wiring (GTM, the `oa_consent` cookie, the shim, Meta/OpenAI/TikTok), Cloudflare automated setup, server consent flow, verification |
| `src/consent-defaults.ts` | Regions (41 codes from `packages/contracts` `CONSENT_REQUIRED_REGIONS`), defaults, `consentDefaultCommands()`, `applyConsentDefaults()` (on-page `gtag` calls as real `Arguments` objects), and `renderConsentTemplate()` (the GTM `.tpl`: sandboxed JS using `setDefaultConsentState`, `gtagSet`, `copyFromWindow` and `getCookieValues`; fields; `access_consent`, `write_data_layer`, `access_globals` and `get_cookies` permissions) |
| `src/privacy-signals.ts` | `readPrivacySignals()` (GPC, `oa_consent` `opt_out_sale_sharing`, IAB `usprivacy`, explicit `ad_storage`) and `adConsentDecision()`, shared with `../shim` and `../hubspot` |
| `src/entry.ts` | Browser entry for the on-page build |
| `dist/openart-consent-defaults.min.js` | On-page build (3.3 KB). It must run **before** the GTM snippet. The watchdog proof injects it through `../gtm/proof/inject_web_fixes.min.js`. |
| `test/consent-defaults.test.ts` | Covers: the command order and shapes; `Arguments` pushes; the region list equal to the contracts list; GPC and opt-out defaults on the page; the template's sections, parameters and permissions; the sandboxed JS executed against a mock of the sandbox APIs and checked against the on-page commands for every signal combination |
| `test/privacy-signals.test.ts` | The US Privacy string parser, the signal reader (hostile environments included) and the decision order |

The template is shipped inside `../gtm/import/openart-gtm-fixpack.json` as a custom template, with a tag on *Consent Initialization - All Pages*. The OA-FIX build regenerates it from `src/consent-defaults.ts`, so the GTM and on-page variants cannot drift.
