# open-art-harness

Working fixes and a server-side profit signal for OpenArt's growth measurement. It was built entirely from outside OpenArt, from its public site, its shipped code, and a logged-in free account, and it is designed to drop into the stack OpenArt already runs:

- Cloudflare Workers
- GTM-56CMP8K
- GCP, BigQuery and Metabase
- Stripe
- Amplitude
- LaunchDarkly
- HubSpot
- its own Meta CAPI Gateway

Every change reuses OpenArt's existing ids and dedup keys: `reg_<uid>`, `purchase_<invoiceId>`, `sub_<invoiceId>`, and one user id shared by Stripe, Amplitude and the credit ledger.

> Nothing in this repo has ever sent data to OpenArt's systems or any ad platform. Platform senders are dry-run by default, and tests fail on any network call. Browser runs are sealed. All fixtures are synthetic.

## The result

The watchdog ran on openart.ai on 2026-09-30, first against the live site and then with this repo's fixes applied in a sealed browser. Details are in **[docs/PROOF.md](docs/PROOF.md)**.

| | Live today | With these fixes |
|---|---|---|
| Tracking-contract checks passing | **0 / 19** | **18 / 19** |
| Meta click-id coverage (paid journeys) | 50% | 100% |
| ChatGPT-ads click-ref coverage | 0% | 100% |
| Collection requests that left the machine | 0 of 1,181 | 0 of 1,172 |

## What's broken today (verified on the live site and in shipped code)

**Signups:**
- The Google Ads signup conversion waits for `new_user_signed_up`, which nothing sends. The app sends `signup`.

**Purchases:**
- Each platform is told something different:
  - LinkedIn gets no value.
  - X counts each sale twice.
  - Meta and TikTok get only the first purchase, valued at lifetime value.
  - `business_subscription` goes nowhere.
- Renewals, upgrades, add-ons and refunds reach no platform from the browser.

**Click ids:**
- Lost on multi-page Meta journeys.
- ChatGPT-ads refs are lost on marketing landings.
- iOS Google ids (gbraid/wbraid) never reach the server store.
- The Instagram/TikTok in-app browser handoff drops everything.
- uBlock users are invisible to every browser signal.

**Page views:**
- Google, Reddit, LinkedIn and X miss in-app navigation.
- Meta fires up to 3 page views per click.
- Legacy Amplitude logs up to 6.

**Consent and forms:**
- No Consent Mode and no consent platform, while most traffic is non-US.
- The enterprise HubSpot form stamps every lead `lead_source = Event / Brandweek`.

## What's in the repo

| Package | What it does | Plugs into OpenArt's… |
|---|---|---|
| [`contracts`](packages/contracts) | Canonical conversion events, id rules, per-platform hashing, source schemas, synthetic fixtures and a 2,000-user cohort in OpenArt's real data shapes | everything below |
| [`watchdog`](packages/watchdog) | Daily sealed replay of every conversion path and click-id journey, plus consent checks and GTM container diffs, with a red/green report | GCP (Cloud Run Job + Scheduler) or GitHub Actions |
| [`web-fixes`](packages/web-fixes) | GTM merge-import + click-by-click changes, drop-in click-id script, app patches, HubSpot form fix, Consent Mode v2 | GTM-56CMP8K, their inline script, Next.js app, HubSpot form |
| [`edge-attribution`](packages/edge-attribution) | Server-set, ITP-proof capture of UTMs and every click id; `_fbc` minting; in-app handoff tokens; consent-gated | their existing Cloudflare Worker (as a module) and `/api/user/ad-click-ids` |
| [`warehouse`](packages/warehouse) | dbt: conversion ledger, generation cost, 24h features, predicted 90-day profit, experiment profit by arm, audience candidates, Ads-vs-Stripe reconciliation, Metabase questions | BigQuery + Metabase |
| [`conversion-service`](packages/conversion-service) | Stripe webhooks and app events become one canonical conversion, sent to Google (Data Manager API), Meta, TikTok, Reddit, LinkedIn, X and Microsoft with the browser's own dedup ids | Cloud Run, their Stripe webhook handler, their Meta CAPI Gateway |
| [`bandit-allocator`](packages/bandit-allocator) | Profit-rewarded Thompson sampling that updates the existing default-model LaunchDarkly flags, with guardrails and a holdout | LaunchDarkly flags `suite-default-model-create-*` (no app change) |
| [`audience-sync`](packages/audience-sync) | Profit-based seed audiences and suppression lists (subscribers, fraud, refunds), consent-filtered | Google Customer Match (Data Manager API), Meta, TikTok |

How the pieces connect: [docs/integration-map.md](docs/integration-map.md). Rollout: [docs/30-60-90.md](docs/30-60-90.md).

## Run it

```bash
npm install                                       # .npmrc sets legacy-peer-deps
npm test                                          # all TypeScript packages
bash packages/warehouse/scripts/build.sh          # dbt (DuckDB locally; compiles for BigQuery)
cd packages/watchdog && npx tsx src/cli.ts run --target live --out reports/baseline-$(date -u +%F)
cd packages/watchdog && npx tsx src/cli.ts run --target patched \
  --patch-container ../web-fixes/gtm/proof/patched_resource.json \
  --patch-gtag-config ../web-fixes/gtm/proof/patched_gtag_config.js \
  --inject-script ../web-fixes/gtm/proof/inject_web_fixes.min.js \
  --edge-sim ../edge-attribution/dist/edge-sim.js --out reports/patched-$(date -u +%F)
```

## What's verified, what's illustrative, what needs OpenArt

**Verified.** Everything about today's tag behaviour, ids, payload shapes and page-view counts comes from OpenArt's live site and shipped code. See the research evidence cited in each package README and in `docs/integration-map.md`.

**Illustrative (labelled in code):**
- the synthetic cohort's behaviour parameters
- the predicted-profit coefficients
- the simulation results
- generation costs at **public list prices** (OpenArt's negotiated costs are lower)

On the synthetic cohort, conversion and profit rank the default-model arms the same way. Whether they diverge on real data (for example during 0-credit "unlimited" promos) is exactly what the profit column is built to show.

**Needs OpenArt's systems to confirm:**
- how Stripe webhooks are consumed today
- whether Amplitude and the credit ledger already land in BigQuery
- Google multi-source allowlisting
- LinkedIn and X conversion-API access
- the LaunchDarkly context key
- real per-model costs
- EU consent behaviour (tested from the US only)
