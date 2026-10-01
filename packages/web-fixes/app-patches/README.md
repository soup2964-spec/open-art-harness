# app-patches/: Suite and legacy front-end patches

These are small TypeScript modules for OpenArt's two Next.js apps:

- the Suite (App Router, Turbopack);
- legacy (Pages Router, webpack).

They have no runtime dependencies. React and Next hooks are injected, so each module can be pasted into either app or imported from this package.

**Where each goes:** [`PATCHES.md`](PATCHES.md), cited by chunk and module id, with the rollout order and backend dependencies.

| Module | Fixes | Replaces or extends (shipped code) |
|---|---|---|
| `src/click-id-keys.ts` | The Suite keeps only 4 click ids and deletes `gbraid`/`wbraid` on rewrite. The migration POST and the checkout form miss 6 ids. | Suite module 162070 (consumers: 997659, 807552, 107154) |
| `src/signup-push.ts` | The `signup` push drops the uid, so no `reg_<uid>` in GTM | Suite module 764475 |
| `src/page-view-contract.ts` | 0–3 page views per SPA route. Meta's history hook fires per URL rewrite. | new root-layout component (Suite) / `_app` hook (legacy); inline Meta snippet |
| `src/fallback-purchase.ts` | Stale list-price value and a `Date.now()` id when the invoice lookup fails. No UET `event_id`. Invoice ids checked against the contracts rule; one server-computed value (`profitValueMajor`) for every purchase tag. | Suite modules 111958, 114607; legacy 68039, 49808 |
| `src/webview-handoff.ts` | The in-app-browser "open in browser" URL loses click ids and UTMs. Google OAuth is offered where Google blocks it. | Suite module 825073 (`em()`, `eb()`) |
| `src/legacy-amplitude-init.ts` | 2–3 Amplitude page views per legacy navigation, up to 6 payloads | legacy module 16585 `il`/`S1` ([`legacy-amplitude-dedupe.md`](legacy-amplitude-dedupe.md)) |
| `src/attribution-snapshot.ts` | shared reader for click ids and UTMs: `oa_ad_clids`, `oa_utm`, vendor cookies, and the Amplitude campaign cookie as fallback | used by the handoff and `../hubspot` |
| `src/proof-simulations.ts` | **proof only**: stand-ins so the watchdog replay can observe these patches without a deploy | bundled into `../gtm/proof/inject_web_fixes.min.js` |

## Conventions kept

- Analytics event names are snake_case: `virtual_page_view`, `signup`, `conversion_reported`.
- API fields are camelCase: `invoiceId`, `ltvValueMajor`, and the new `profitValueMajor` / `profitCurrency` (PATCHES.md §4).
- Storage formats are unchanged. `oa_ad_clids` stays `{key:{v,ts}}` for 90 days on `.openart.ai`.
- Pushes stay backwards compatible: same event names, new keys only.

## Tests

```bash
npx vitest run app-patches      # from packages/web-fixes
```

Each test file runs OpenArt's shipped function (verbatim extract in `test/fixtures/`) next to the replacement. It shows the bug, then parity wherever behaviour should not change.

| Test | Shipped code it runs |
|---|---|
| `click-id-keys.test.ts` | module 162070 |
| `signup-push.test.ts` | module 764475 |
| `page-view-contract.test.ts` | the Suite and legacy Meta snippets, and `fbevents.js` `signalsFBEventsSPANavigationUtil` |
| `fallback-purchase.test.ts` | modules 111958, 399331 and 114607 |
| `webview-handoff.test.ts` | module 825073's detector |
| `legacy-amplitude-init.test.ts` | module 16585 |

DOM tests use happy-dom with a browser-like cookie jar (`../test-utils`).
