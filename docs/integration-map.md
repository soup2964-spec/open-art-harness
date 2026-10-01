# Integration map: where open-art-harness plugs into OpenArt

Every OpenArt touchpoint this project uses, what was observed there, where the evidence is, and which package integrates with it. The design rule throughout: **reuse OpenArt's existing identifiers, event names, endpoints and platforms, and change as little as possible.**

- **Evidence paths** are relative to the research workspace `openart_2026-09-29/` (`research/`, `raw/`, `crawl/`).
- **Contract paths** are relative to `packages/contracts/`.
- **Labels:**
  - **[O]** observed live or in a saved capture.
  - **[C]** read from OpenArt's shipped code.
  - **[I]** inference.
  - **[U]** unknown from outside.
- **Safety:** every sender in this repo defaults to dry-run. Nothing here sends data to OpenArt or to any ad platform.

## Packages at a glance

| Package | Role (as planned) | Main contracts it uses |
|---|---|---|
| `contracts` | Shared schemas, types, validators, id rules, platform mapping, fixtures and the cohort generator | all |
| `edge-attribution` | Cloudflare Worker. Captures every click id and UTM on first-party landings, keeps `oa_ad_clids` intact, and records the consent region | `ClickIdStoreRecordExtended`, `Consent`, `CLICK_ID_KEYS_EXTENDED`, `buildMetaFbc` |
| `web-fixes` | Minimal GTM and Suite patches, such as the dead signup trigger and missing dedup ids on the TikTok, Reddit, LinkedIn, X and UET tags | `PLATFORM_EVENT_MAPPING` rows with `requires_web_fix`, event-id rules |
| `conversion-service` | Stripe, ledger and HubSpot sources become `ConversionLedgerEvent` rows, which feed a per-platform outbox. Senders default to dry-run | `ConversionLedgerEvent`, `PlatformEventMapping`, `normalization.ts`, source schemas |
| `warehouse` | BigQuery models: staging, then `fct_conversion_ledger`, `fct_predicted_profit_24h` and exposures | source schemas, cohort fixtures, `model_costs.csv`, canonical schemas |
| `bandit-allocator` | Proposes allocations for the `suite-default-model-*` LaunchDarkly flags from profit by arm (dry-run) | `ExperimentExposure`, `PredictedProfit`, `OBSERVED_ARMS` |
| `audience-sync` | Builds per-platform audience lists from predicted profit (dry-run) | `AudienceMember`, `hashEmailFor`, `hashExternalIdFor` |
| `watchdog` | Detects regressions: tag and id drift, and reconciliation of browser vs Stripe | `PLATFORM_EVENT_MAPPING.browser_twin`, `parseBrowserDedupId` |

## 1. Identity: one key everywhere

| Key | Where it appears | Evidence | Contract |
|---|---|---|---|
| OpenArt uid (case-sensitive, Firebase-style) | Stripe customer id, Amplitude `user_id`, ledger `userId` and `businessId` for the trial, my-info `id`, success URL `uid=` | [O] `research/10` §7 | `common.schema.json#/$defs/userId` |
| Meta `external_id` | SHA-256 of the **lower-cased** uid | [O] `research/10` §7 | `metaExternalId()` |
| `oa_device_id` cookie | Amplitude `device_id` on all three front-ends | [O] `research/02` §1, `research/01` T4 | `ConversionLedgerEvent.device_id` |
| Stripe `invoice.id` | The conversion grain | [C] `research/02` §3.2 | `event_id` and `order_id` |

**Event-id rules** (`src/event-ids.ts`). The first three reuse ids the browser already sends; the rest are new.

| Event | Rule | Who already receives this id | Status |
|---|---|---|---|
| Signup | `reg_<uid>` | Meta `CompleteRegistration` eventID; OpenAI `registration_completed` | reused |
| Purchase | `event_id` = `purchase_<invoiceId>` | Meta `Purchase` eventID; OpenAI `subscription_created` | reused |
| Purchase | `order_id` = `sub_<invoiceId>` | Google `oid`, Reddit `transactionId` (and SHA-256 of it as `conversionId`), X `conversion_id`, TikTok `event_id`, UET `transaction_id` | reused |
| Activation | `activation_<uid>` | none | new |
| Checkout started | `checkout_<cs or Amplitude uuid>` | none | new |
| Refund | `refund_<chargeId>_<cumulative refunded minor>` | none | new |
| Chargeback | `chargeback_<disputeId>` | none | new |
| Enterprise lead | `lead_<hubspotConversionId>` | none | new |
| Lead stage change | `leadstage_<contactId>_<stage>` | none | new |

The Suite's fallback id `sub_<tierKey>_<code>_<uid>_<Date.now()>`, used when the invoice lookup fails, is not stable. `parseBrowserDedupId()` classifies it as `unstable_fallback`.

## 2. Touchpoints

### 2.1 Cloudflare edge

**Observed**
- Workers route all three front-ends: Astro "pageforge" on Cloudflare Pages, and the Suite and Legacy Next.js apps on a GCP origin. [O]
- Every HTML response carries `server-timing: cfWorker`. [O]
- The Google tag gateway serves GTM-56CMP8K and the AW config first-party at `/4vu8/`, through an edge-injected snippet with `developer_id.dYzg1YT`. [O]
- There is no sGTM and no first-party tagging subdomain. [O]

**Evidence:** `research/02` §0.7 and §8; `raw/infra/`; `research/11` §3.3.

**Integration:** `edge-attribution` runs as a Worker on the same zone, so it adds no new domain. It reads `oa_ad_clids` and the query string. It writes only additive cookie keys and posts `ClickIdStoreRecordExtended`. `watchdog` checks that `/4vu8/` keeps serving v25.

### 2.2 GTM-56CMP8K v25: 18 tags, rules keyed on dataLayer events

**Observed**

| dataLayer trigger | Tags that fire |
|---|---|
| `signup` | Reddit SignUp, LinkedIn 29290241, X `tw-qwghh-13vj22`, TikTok CompleteRegistration |
| `purchase` | AW-11252321380/`OfGcCJisoLQZEOSYw_Up` and AW-16854695811/`4Rf-CM6EhJMcEIP_-OQ-`, Reddit Purchase, LinkedIn 29290225, X `tw-qwghh-13vj24` |
| `first_purchase` | TikTok Purchase |
| `new_user_signed_up` | AW-11252321380/`rVk2CJ7Ot8EZEOSYw_Up`, but **nothing emits this event** |

- `business_subscription`, `purchase_first` and `conversion_event_purchase` reach no tag. [O]

**Evidence:** `raw/gtm_56CMP8K.js.json`; `research/02` §2; `research/11` §3 (sealed replay).

**Integration:**
- The `PlatformEventMapping` rows record each tag as a `browser_twin`, with the exact id it sends.
- `web-fixes` patches only the tags flagged `requires_web_fix`: TikTok, Reddit, LinkedIn and X signup, and LinkedIn and UET purchase. Each patch adds the reused dedup id.
- `watchdog` diffs the live container against v25.

### 2.3 Google Ads (2 accounts) and GA4

**Observed**
- Both accounts receive every web purchase with the same `oid=sub_<invoiceId>`. [O]
- Enhanced Conversions is live at the Google-tag level as an HPKE `eme` envelope, not `em=`. [O]
- The signup conversion is dead. [O]
- GA4 `G-QYRJB9TLG7` runs on Legacy routes only, with key event `purchase_first_server`, which points to a backend Measurement Protocol sender. [O]/[I]

**Evidence:** `research/11` claims 1, 2-EC and 4; `research/02` §5.

**Integration:** `conversion-service` sends through the Data Manager API. A multi-source `transactionId` of `sub_{invoice_id}` overrides the tag value without a second count. Refunds and chargebacks become value restatements keyed on `adjusts_order_id`. See `getPlatformMapping(*, 'google_ads')`.

### 2.4 Meta: pixel 843671884361709 and CAPI Gateway

**Observed**
- The CAPI Gateway (plugin `openbridge`, AWS ECS us-east-2 with a GCP fallback) mirrors pixel events. [O]
- The pixel sends `CompleteRegistration` with eventID `reg_<uid>` and `Purchase` with `purchase_<invoiceId>`, first valid purchase only, valued at `ltvValueMajor` when present. [C]
- No code builds `_fbc`. [O]
- `metaCapiTestEventCode` points to a backend CAPI sender. [I]

**Evidence:** `research/02` §3.2, §3.4 and §4; `research/01` §0.

**Integration:** `conversion-service` reuses the same event names and ids. It builds `fbc` server-side as `fb.1.<fbclid_created_at>.<fbclid>` (`buildMetaFbc`). It can post to the existing gateway's `/capi/{pixel}/events`. `audience-sync` uses the lower-cased-uid `external_id`.

### 2.5 TikTok, Reddit, LinkedIn, X, Microsoft UET, OpenAI Ads

**Observed**

| Platform | Id | What the browser sends |
|---|---|---|
| TikTok | `D9QOQ5JC77U6RO6J21IG` | `Purchase` with `event_id=sub_<invoiceId>` (first purchase only); `CompleteRegistration` with `event_id=""` |
| Reddit | `a2_j6xo78gpljnf` | `conversionId` = SHA-256(`sub_<invoiceId>`) |
| LinkedIn | partner 10481401 | no value and no eventId |
| X | `qwghh` | `conversion_id=sub_<invoiceId>`, plus an automatic `gtm_purchase` |
| UET | 187107444 | `transaction_id`, no event id |
| OpenAI Ads | `MCEntnyMVfgRfepXXsrQLE` | `reg_<uid>` / `purchase_<invoiceId>` |

**Evidence:** `research/11` §3.1–§3.2; `research/02` §3.2.

**Integration:**
- `PLATFORM_EVENT_MAPPING` holds the field names, dedup keys and send windows, from `research/08` B3.
- Per-platform email normalisation lives in `normalization.ts`. The tests reproduce the replay's wire hashes.
- OpenAI Ads is left out of the server mapping, because the research verified no server API for it.

### 2.6 Click-id store

**Observed**
- The `oa_ad_clids` cookie and localStorage entry hold `{<key>:{v,ts}}`, with `Max-Age=7776000` and `Domain=.openart.ai`. [C]
- The Astro shim writes `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid` and `ttclid`. It also writes separate cookies for `rdt_cid`, `gbraid` and `wbraid`.
- The Suite keeps only `gclid`, `fbclid`, `msclkid` and `ttclid`. When it rewrites the value, it deletes `gbraid` and `wbraid`. [O]
- After login it runs `POST /api/user/ad-click-ids` with body `{gclid, gclid_created_at(ms), …}`. [C]
- `oppref` (OpenAI Ads) is lost on Astro landings; `li_fat_id` and `twclid` are never stored. [O]

**Evidence:** `raw/bundles/js/…91db8069961c7577.js` module 162070; `research/02` §3.3; `research/01` T2–T3.

**Integration:**
- Current shape: `click-id-store-record.schema.json`.
- Backward-compatible superset: `click-id-store-record-extended.schema.json`. Every current payload validates against it unchanged.
- `edge-attribution` fills the superset. `conversion-service` reads it with `clickIdsFromStoreRecord()`.

### 2.7 Checkout

**Observed**
- A native form runs `POST /api/stripe/subscription` with `tier` (1000, 2000, 3000 or 3500), `billing_interval`, `tolt_referral`, `cancel_path`, `ga_client_id`, `ga_session_id` and `gclid`, plus `coupon_id` when one applies. It returns a 303 to Stripe-hosted Checkout. [O]
- `customer` is the uid, `client_reference_id` is null, and Stripe receipts are off. [O]
- `success_url=/suite/subscriptions?success=subscription_purchased&tier=…&interval=…&uid=…&quantity=undefined&session_id=…`. [O]
- The Suite then calls `GET /legacy/api/stripe/checkout-session-invoice`, which returns `{invoiceId, isFirstPurchase, isValidInvoice, isBusiness, amountMinor, currency, ltvValueMajor, ltvCurrency}`. [C]

**Evidence:** `research/10` §5; `crawl/loggedin_billing/evidence_stripe_checkout_init_REDACTED.json` and `evidence_api_samples_REDACTED.json`.

**Integration:** `invoice-lookup-response.schema.json`. `ConversionLedgerEvent` carries `plan_tier_code`, `ga_client_id`, `ga_session_id` and `tolt_referral`. `checkout_started` comes from Amplitude `subscription_started`.

### 2.8 Stripe

**Observed**
- Account `acct_1JnWMnKVhG51tYSB`. [O]
- The production price and product map ships in the legacy `_app` bundle. Starter monthly is `price_1QWx4UKVhG51tYSBfdRth4n8`, and the live Checkout confirmed it. [O]/[C]
- Portal and cancel flow (Customer Portal and `update_credit_pack`): [C].
- The lifecycle behind `invoice.paid` (create, cycle and update), refunds and disputes: [I] standard Stripe.

**Evidence:** `research/10` §4–§8; `raw/bundles/js/…pages___app-a1820d4f2194dce7.js`.

**Integration:**
- `src/stripe-catalog.ts` holds the real ids. The credit-pack price id is synthetic and labelled as such.
- `stripe-event.schema.json` (dahlia shape) covers `checkout.session.completed`, `invoice.paid`, `invoice_payment.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded` and `charge.dispute.created`.
- Canonical purchase names follow `billing_reason`:

| Stripe billing reason or source | Canonical event |
|---|---|
| `subscription_create` | `purchase_first` (plus `is_first_purchase`) |
| `subscription_cycle` | `purchase_renewal` |
| `subscription_update` with a higher plan price | `purchase_upgrade` |
| `subscription_update` with a CreditPack line | `purchase_add_on` |
| payment-mode Checkout | `purchase_one_time_pack` |

### 2.9 Credit ledger

**Observed**
- The endpoint is `GET /suite/api/credits/logs?limit&filter&cursor` and returns `{success, entries[], hasMore, nextCursor}`.
- An entry has the shape `{id (UUIDv7), sequenceId, type, amount, creditField, balanceBefore, balanceAfter, previousSequenceId, reference{businessType, businessId}, idempotencyKey, createdAt, userId, businessDetails[], reason?}`.
- The observed rows are a trial `ADD 40` (`USER_SIGNUP_TRIAL`) and `CONSUME -1` (`openart-sdxl:text2image`, idempotency key `…:REDUCE:<historyId>`). [O]
- Both rows had `sequenceId 0` and `previousSequenceId null`. Order rows by `id` and `createdAt`, not by sequence. `createdAt` is truncated to whole seconds.

**Evidence:** `crawl/loggedin/generation/ledger_pre.json` and `ledger_post.json`; `research/10` §3.3.

**Integration:**
- `credit-ledger-entry.schema.json`.
- `businessType` is the model capability id `<model>:<mode>`. The 294 ids found in code are in `src/capability-ids.ts`. Only `openart-sdxl:text2image` is observed in a ledger row.
- The costs seed `fixtures/seeds/model_costs.csv` joins on (`business_type`, `setting`).
- The first `CONSUME` becomes `activation_first_generation`, and the trial `ADD` becomes `signup`.

### 2.10 Amplitude

**Observed**
- There is one project across all front-ends, with `device_id = oa_device_id`. [O]
- `asset_created` carries `{device, creation_panel_version, model, creation_mode, create_source, feature_name, asset_num, credits_num, reference_assets}`. [O]
- `subscription_started` carries `{subscription_tier, subscription_interval, click_source}`. [O]
- `conversion_reported` carries `{report_layer:"client", channel, conversion_type, environment, fired, outcome, gclid/fbclid/msclkid/ttclid}`, with channels `google_ads`, `ga4`, `meta_pixel`, `openai_ads`, `bing_uet`, `brevo` and `clarity`. [C]
- `$exposure` carries `{flag_key, variant, experiment_key?}`. [C]
- The attribution plugin stores `initial_*` and current click ids and UTMs as user properties. [O]

**Evidence:** `crawl/loggedin/generation/03_amplitude_events_after_click.json`; `research/02` §3.6; `research/01` T4.

**Integration:** `amplitude-export-row.schema.json` follows Amplitude's documented BigQuery export columns. The JSON columns are `event_properties`, `user_properties` and `data`. `uuid` is the row id, and the export has **no** `insert_id`.

### 2.11 Experiments

**Observed**
- LaunchDarkly flags `suite-default-model-create-image`, `-create-video`, `-animate-video` and `-image-variations` are A/B arms.
- Observed image arms: `nano-banana-pro`, `gpt-image-2-5`, `nano-banana-2`, `gpt-image-2`.
- Observed video arms: `byte-plus-seedance-2`, `byte-plus-seedance-2-5`, `wan3-0`.
- The Suite identifies `ab_<flag>` user properties and fires `experiment_flags_ready`.
- Statsig also runs, with exposures to `prodregistryv2.org`. [O]

**Evidence:** `research/12` V4; bundle module 895206; `research/10` §9.

**Integration:**
- `ExperimentExposure` takes the first `$exposure`, or else the first row carrying `ab_<flag>`.
- `ARM_BUSINESS_TYPE` maps each arm to its ledger `businessType`.
- `bandit-allocator` proposes flag weights. It never writes to LaunchDarkly.

### 2.12 HubSpot enterprise funnel

**Observed**
- Portal 244977254, form `9f0b1fda-34f1-4364-93d5-bdc196c44004`. [O]
- Hidden fields hard-code `lead_source=Event` and `lead_source_detail=Brandweek`, plus `gclid`, `gbraid` and `wbraid`. [O]
- The form has no UTM or `li_fat_id` field, and the page has no `hubspotutk`. [O]
- No browser lead conversion fires. [O]

**Evidence:** `raw/enterprise/hs_form_render_definition.json`; `research/00` B1–B3.

**Integration:**
- `hubspot-form-submission.schema.json` becomes `enterprise_lead`.
- `hubspot-contact-property-change.schema.json` (`lifecyclestage`) becomes `lead_stage_change`.
- These go to Google (offline and EC for leads), LinkedIn and Meta `Lead`.

### 2.13 Warehouse and BI

- The JD says **BigQuery and Metabase**. Nothing about datasets is visible from outside. [U]
- `warehouse` models everything from the source shapes above.
- It can start from `fixtures/cohort/*.jsonl`: 2,000 synthetic users, deterministic, with `manifest.json` and `cohort_truth.jsonl` as ground truth.

## 3. Unknowns and adapters

| Unknown | What we can see | Adapter (no change to OpenArt required) |
|---|---|---|
| **How Stripe webhooks are consumed today** | The backend clearly processes Stripe events. The Suite's `useWebhookGate` polls `/suite/api/user/my-info` at 0, 2, 4 and 8 s for `subscription_active` and `first_purchase_at`, and a `one-time-pack:success` webhook gate exists [C, `research/10` §6 and §8]. The endpoint URL, the queue and the pinned API version are unknown. | Three routes, all accepting the same `stripe-event.schema.json` payloads: **(a)** an additional Stripe webhook endpoint owned by `conversion-service` (additive; Stripe supports several endpoints); **(b)** events forwarded from OpenArt's existing handler (for example Pub/Sub); **(c)** Stripe Data Pipeline to BigQuery for reconciliation (3 h refresh; too slow for Meta's ≤1 h target). The schema accepts both the dahlia shape (`parent.subscription_details.subscription`, `invoice_payment.paid`) and legacy top-level `subscription`, `charge` and `payment_intent`, so an older-pinned endpoint still parses. Dedupe on `event.id`; never trust event ordering. |
| **Whether Amplitude already exports to BigQuery** | Amplitude and BigQuery are both in the stack (JD). Whether the export destination is enabled is not visible. | If it is enabled, read `EVENTS_<project_id>` (or `deduplicated_<appid>`) directly. If not, enable Amplitude's BigQuery destination (hourly), or land the Export API into the same columns. The staging model keys on `uuid` either way. |
| **Whether the credit ledger is replicated to BigQuery** | The ledger is served per user through `/suite/api/credits/logs`, a paginated per-user endpoint with no bulk access. The storage engine is unknown. `firebase=openart-prod` (DNS TXT) and my-info's `created_at {_seconds,_nanoseconds}` (a Firestore Timestamp shape) point to Firebase/Firestore for user records [I]. | Replicate the ledger table or collection to BigQuery: the Firestore → BigQuery streaming extension, database CDC, or a nightly export. The contract is the API entry shape, which `credit-ledger-entry.schema.json` fixes, so any replication producing it plugs in unchanged. Model costs join via `model_costs.csv`. |
| **Backend runtime** | Behind Cloudflare, the origin is GCP (`x-cloud-trace-context` on API responses). The Legacy build rewrites `/_ah/warmup`, which points to App Engine. Next.js serves the Suite and Legacy apps. The Meta CAPI Gateway runs on AWS ECS with a GCP fallback [O `research/02` §8]. Cloud Run vs App Engine for the APIs is unknown. | `conversion-service`, `audience-sync` and `bandit-allocator` are plain Node/TypeScript with injectable HTTP clients. They run on Cloud Run Jobs or Scheduler next to BigQuery. `edge-attribution` runs as a Cloudflare Worker. Nothing requires changing OpenArt's backend. |
| **The CMP choice** | There is none. There are no consent signals (`gcd=13l3l3l3l1l1` on 348 hits), yet the site serves EU locales [O `research/01` §0, `research/11` §3.3]. A `country_code` cookie exists, used for pricing. | The contract's `consent` block is CMP-agnostic: the four Consent Mode v2 signals, plus `region` and `source` (`cmp`, `regional_default` or `none`). Live rows today are `unknown` / `none`. Until OpenArt picks a Google-certified CMP (Consent Mode v2 or TCF v2.2 for EEA, UK and CH), the platform outbox withholds EEA, UK and CH rows. Which CMP to use is a legal and product decision for OpenArt; the edge Worker can read any CMP's cookie into the same block. |
| OpenArt's own server senders | `metaCapiTestEventCode` (Meta CAPI), GA4 `purchase_first_server`, and Impact S2S all exist or are implied [C/I]. | Reuse the same ids (`purchase_<invoiceId>`, `sub_<invoiceId>`) so any overlap dedupes. A per-platform kill-switch in `conversion-service` covers destinations OpenArt already feeds. |
| Reddit hashed `conversionId` | The pixel sends SHA-256(`sub_<invoiceId>`). Whether CAPI hashes a plaintext `conversion_id` before matching is undocumented. | Verify in Reddit's dedup log before enabling the Reddit purchase twin (noted in the mapping row). |
| Google multi-source allowlist | The Data Manager page summary calls multi-source "allowlist-only". | Confirm with the Google rep. Until then, send server-only actions, not overrides. |
| Invoice lookup LTV model | `ltvValueMajor` comes from an unseen backend model. | The canonical ledger stores **cash** only. The ad value is `PurchaseValueScore` (E[90d gross profit \| purchase], scored at purchase; `value_basis` is recorded on every send, `cash_fallback` when no score exists in time). `PredictedProfit` (signup+24h, unconditional) feeds experiment and bandit readouts only. The seamless path is for the invoice lookup to also return this value (`profitValueMajor`), so the pixel and the server send the same number. |

## 4. Provenance of the synthetic data

| What | Source |
|---|---|
| Real public ids | Pixel ids, conversion labels, tier codes, price and product ids, HubSpot portal and form, capability ids. All come from shipped code or captures. |
| Values | Everything else is **synthetic**: uids start with `Synth`, emails use `.test`, Stripe ids contain `Synth`. |
| Personal data | None. No personal data was copied from `crawl/loggedin*`; only field names and shapes. |
| Inferred values (labelled in the fixture files) | Ledger `businessType` for every model except `openart-sdxl`; the `subscription-refill` name for `SUBSCRIPTION_ADJUSTMENT` rows; the upgrade grant of the credit difference; the add-on credit bucket (`subscription_monthly_credit`); the one-time-pack price and ids; the credit-pack price id. |
| Illustrative | Every behavioural rate in `src/cohort/params.ts`, and the `ltvValueMajor` and `PredictedProfit` example numbers. |
