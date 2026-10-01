# conversion-service

A Cloud Run service (Node 22, `node:http`, TypeScript). It turns OpenArt's Stripe events and app events into **one canonical conversion per event** (`ConversionLedgerEvent`, from `@openart-signal/contracts`). It then sends each conversion server-side to Google Ads, Meta, TikTok, Reddit, LinkedIn, X and Microsoft Advertising.

Every server event reuses the dedup id that the browser tag already sends (`reg_<uid>`, `purchase_<invoiceId>`, `sub_<invoiceId>`). Each platform therefore keeps one conversion, not two.

**Nothing is sent anywhere by default.** Every sender runs in dry-run mode: it writes the exact request it would make to `DRY_RUN_OUT_DIR/requests/<platform>/<ULID>-<instance>-<SEND|ADJUST>.json`. Live mode exists, but it needs three explicit settings, durable storage, real-looking secrets and that platform's credentials (see [Going live](#going-live)). No live code path has been exercised against a real platform.

```
Stripe ─webhook─┐                          ┌─ ledger (BigQuery streaming insert, cash only)
                ├─► verify ─► map ─► enrich ─┤
backend /events ┘   (sig/HMAC)  (contracts) │  user context · click ids + fbc · consent · value decision
                                            └─ dispatch: 1 outbox record per (platform, event_id)
                                                  │ pending / held (gate, value score) / skipped (why)
                     Cloud Scheduler ─► drain ────┘ re-checked at send: windows · gates · purchase-time
                                                    value · consent (current state) · refund supersession
                                                     └─► dry-run files  |  live HTTPS (opt-in)
backend GET /value ─► the same value decision ─► checkout-session-invoice ─► browser pixel
```

## What is sent where

The table comes from the contracts `PLATFORM_EVENT_MAPPING` (84 rows) plus this service's gates.

**Key to the table:**
- `twin`: the browser already sends this conversion, and the server event reuses its id.
- `server`: no browser twin exists.
- `adjust`: a value restatement or retraction of an earlier purchase.
- `–`: not sent. For refunds and chargebacks, the skip is recorded in the outbox.
- **[W]** held until the web fix is live.
- **[G]** held until Google confirms multi-source.
- **[R]** held until Reddit's dedup log confirms.
- **¹** first purchase only (`is_first_purchase = true`).

| canonical event | Google | Meta | TikTok | Reddit | LinkedIn | X | Microsoft |
|---|---|---|---|---|---|---|---|
| `signup` | server `tag action` | twin `CompleteRegistration` | twin [W] `CompleteRegistration` | twin [WR] `SIGN_UP` | twin [W] `rule↔29290241` | twin [W] `tw-qwghh-13vj22` | server `signup` |
| `activation_first_generation` | server | server | server | server `CUSTOM` | – | – | – |
| `checkout_started` | server `begin_checkout` | server `InitiateCheckout` | server `InitiateCheckout` | – | – | – | – |
| `purchase_first` | twin [G] `tag action` | twin¹ `Purchase` | twin¹ `Purchase` | twin [R] `PURCHASE` | twin [W] `rule↔29290225` | twin `tw-qwghh-13vj24` | twin [W] `purchase` |
| `purchase_renewal` / `_upgrade` / `_add_on` / `_one_time_pack` | server (secondary action) | server, renewals `system_generated` | server (custom) | server `CUSTOM` | – | – | server (custom) |
| `refund` | adjust (restate) | – (no API) | – | – | – | – | adjust (restate / retract) |
| `chargeback` | adjust (restate to 0) | – (no API) | – | – | – | – | adjust (retract) |
| `enterprise_lead` | server | server `Lead` | – | – | server (LEAD rule) | – | server |
| `lead_stage_change` (SQL) | server `qualified_lead` | – | – | – | server (SQL rule) | – | – |

### Sources

**Stripe** (`POST /webhooks/stripe`). Canonical names follow `billing_reason`:
- `checkout.session.completed`:
  - payment mode → `purchase_one_time_pack`.
  - subscription mode → join state only.
- `invoice.paid`:
  - `subscription_create` → `purchase_first` (plus `is_first_purchase`; a win-back is `false`).
  - `subscription_cycle` → `purchase_renewal`.
  - `subscription_update` to a **higher tier** → `purchase_upgrade`. Tiers are ranked Starter < Plus < Pro < Wonder < Team < Business (OpenArt's tier codes). Within one tier and billing interval, a higher price counts (a bigger Business credit size). Raw prices are never compared across intervals: Pro annual → Wonder monthly is an upgrade, and Starter monthly → Starter annual is an interval change (`ignored: interval_change_not_upgrade`). A downgrade is `ignored: plan_downgrade`.
  - `subscription_update` with a CreditPack line → `purchase_add_on`.
- `invoice_payment.paid`: the payment-intent → invoice join.
- `customer.subscription.updated` / `.deleted`: plan state (version-guarded, compare-and-set).
- `charge.refunded` → `refund_<charge>_<cumulative>` with the incremental negative cash. The per-charge refund state is compare-and-set, so concurrent refunds never lower `max_cumulative_refunded`, and a replayed refund gets the same delta.
- `charge.dispute.created` → `chargeback_<dispute>`.

Only events whose `livemode` matches `STRIPE_LIVEMODE` count (live mode: `livemode=true` only). Others are acknowledged and `ignored: stripe_livemode_mismatch`: a test-mode purchase never reaches an ad platform.

**App events** (`POST /events`): `signup`, `activation_first_generation`, `checkout_started`, `enterprise_lead`, `lead_stage_change`. See [Plugging into OpenArt's stack](#plugging-into-openarts-stack).

## Dedup ids (equal to what the browser sends)

| Platform | Field | Signup | Purchase |
|---|---|---|---|
| Google Data Manager | `transactionId` | `reg_<uid>` | `sub_<invoiceId>` (the tag's `oid`, so multi-source **overrides** the tag value without a second count) |
| Meta CAPI | `event_name` + `event_id` | `CompleteRegistration` + `reg_<uid>` | `Purchase` + `purchase_<invoiceId>` |
| TikTok | `event` + `event_id` | `CompleteRegistration` + `reg_<uid>` (after the web fix) | `Purchase` + `sub_<invoiceId>` |
| Reddit | `metadata.conversion_id` | SHA-256(`reg_<uid>`) | **SHA-256(`sub_<invoiceId>`)**, exactly what the pixel sends as `conversionId` |
| LinkedIn | `eventId` | `reg_<uid>` | `sub_<invoiceId>` (the Insight tags send none today, so held) |
| X | Events Manager `event_id` + `conversion_id` | `tw-qwghh-13vj22` + `reg_<uid>` | `tw-qwghh-13vj24` + `sub_<invoiceId>` |
| Microsoft UET CAPI | `eventId` (+ `customData.transactionId`) | `reg_<uid>` | `sub_<invoiceId>` |

**Reddit:** Reddit states "If the conversion ID is unhashed, Reddit will use SHA-256 to hash it before storing it". Sending the pixel's exact hash is the safest match. `REDDIT_CONVERSION_ID_MODE=plaintext` switches the encoding. The Reddit twins stay **held** until Reddit's dedup log shows pairs collapsing (`REDDIT_DEDUP_VERIFIED=true`), as the contracts mapping requires.

Other identity rules:
- Meta `external_id` is SHA-256 of the **lower-cased** uid (the pixel's rule, `metaExternalId`). TikTok, Reddit, LinkedIn and Microsoft use the same hashed id.
- Emails are hashed **per platform** with contracts `normalization.ts`:
  - Google strips dots and `+suffix` only for gmail and googlemail.
  - Reddit and Microsoft strip them for every domain.
  - Meta, TikTok, LinkedIn and X trim and lowercase only.
- Meta `fbc` comes from the request's `_fbc`. Failing that, it is built as `fb.1.<fbclid_created_at_ms>.<fbclid>` from the ad-click-ids store. A click stored *after* the conversion, or older than the store's 90-day lifetime, is never attached.
- `event_source_url` is sent only as `https`, with the query string, fragment and credentials removed (OpenArt's success URL carries `uid=` and `session_id=`). Anything else falls back to the configured canonical page.

## Value

### The estimand

Ad platforms optimise the value of the conversion they are told about, so the value must be conditioned on that conversion. The value sent with an acquisition purchase is:

> **`PurchaseValueScore.predicted_profit_90d` = E[gross_profit_90d | purchase]**: the expected 90-day gross profit of the purchasing user, including this purchase, given that the purchase happened. It is scored **at purchase time** from point-in-time features (every feature ≤ `occurred_at`), and looked up by the purchase's event id (`purchase_<invoiceId>`).

The contract is `PurchaseValueScore` in `@openart-signal/contracts`, built by the warehouse as `fct_purchase_value_score`. Every row is validated before use: the components must add up, the interval must contain the estimate, the score must be computed after the purchase, and no feature may come from after the purchase.

The signup+24h `PredictedProfit` (`fct_predicted_profit_24h`) is a different estimand: the **unconditional E[90d profit per exposed user]**, averaged over payers and non-payers alike. It is the right number for experiment and bandit readouts and the wrong number for an ad value. The service never reads it: `BQ_PREDICTED_PROFIT_TABLE` is refused at startup.

### What each conversion carries

| Conversion | Value sent | `value_basis` |
|---|---|---|
| Acquisition purchase (`is_first_purchase=true`) with a purchase-time score computed within `VALUE_SCORE_SLA_MS` (default 10 min) of the purchase | `predicted_profit_90d`, converted to the reporting currency. Meta also gets `custom_data.predicted_ltv`. | `predicted_profit_90d` |
| Acquisition purchase, no such score | Its cash (`amount_paid`). | `cash_fallback` |
| Later purchases (renewal, upgrade, add-on) | Cash, by design. Predicted value belongs on the acquisition only, so a user's values never overlap. | `cash` |
| Signup, activation, checkout, leads | No value. | – |

How it works:
- **Waiting for the score.** While the SLA runs, every send of an acquisition purchase is **held** (`hold_gate: value_score`) and re-checked every `VALUE_SCORE_RECHECK_MS` (1 min). When the score exists, the held payload is patched in place with it (each platform module's `applyValue`, byte-identical to building with that value). When the SLA ends without one, the payload goes as cash with `value_basis=cash_fallback`. The 10-minute default is far inside every dedup window (48 h).
- **First decision wins.** The value of an acquisition purchase is decided once and stored (`value_decisions/<event_id>`). Every platform, and the browser via `GET /value`, gets the same number.
- **The floor is never silent.** A loss-making estimate sends `VALUE_FLOOR_USD` (default 0.01, in the reporting currency), because platforms need a positive value. The record keeps `value_floored=true` and the raw estimate (`value_raw`).
- **FX.** Amounts are converted to `REPORTING_CURRENCY` (default USD) with an injectable `FxRateProvider` (`FixedFxRates`, configured with `FX_RATES_TO_REPORTING`). An amount with no known rate is sent whole in its own currency (`value_in_reporting_currency=false`), never mixed with others.
- **Recorded on every send.** The outbox keeps `value`, `value_currency`, `value_basis`, `value_floored`, `value_raw` and `value_model_version`. Meta also receives `custom_data.value_basis`, a custom parameter, so Events Manager shows how each value was made.
- **The ledger stores cash only.** Predicted value never enters it.
- **Google:** the value **overrides** the tag's value once the conversion action's 14-day multi-source trial ends.

### value-health: is the value usable for bidding?

```bash
npm run value-health --workspace @openart-signal/conversion-service -- --from-json ./outbox.jsonl
STORE_BACKEND=firestore FIRESTORE_PROJECT_ID=PROJECT_ID FIRESTORE_DATABASE=conversion-service \
  npm run value-health --workspace @openart-signal/conversion-service -- --fail-on-threshold
```

The report covers purchase sends that reached each platform in the last 14 days (`sent`, `validated`, `dry_run` by default). For each platform it gives:
- the floor share
- the cash-fallback share of acquisition purchases
- the number of distinct values
- min, max and the max/min ratio, in the reporting currency only

It checks these against **Meta's value-optimisation thresholds**: at least 100 purchases, at least 5 distinct values, and a max at least 3× the min. `--fail-on-threshold` exits 1 when Meta misses one, for a scheduled check.

## Meta keeps the pixel's copy: make the browser send the same value

**The reality.** Meta deduplicates a browser and a server event with the same `event_name` + `event_id` by keeping the **first one received**. That is nearly always the browser pixel, because the server event follows the Stripe webhook. TikTok does the same. The pixel sends whatever the success page computes: today `ltvValueMajor` from `/legacy/api/stripe/checkout-session-invoice`. So the server's predicted profit would only count for users whose pixel was blocked, unless the pixel sends **the same value**.

**The fix.** OpenArt's backend asks this service for the purchase's value and returns it to the browser. Both copies then carry one number.

`GET /value?invoice_id=<in_...>&max_wait_ms=<0..3000>` (or `event_id=purchase_cs_...` for an invoice-less pack):
- **Auth:** `X-OpenArt-Signal-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.GET <path>?<query>")>`. This is the `POST /events` scheme, signed over the request line because a GET has no body (`signInternalBody(secret, "GET /value?invoice_id=…", t)`).
- **Behaviour:** the service waits up to `max_wait_ms` for the Stripe row and a purchase-time score, then **fixes** the decision: the score if it arrived, else `cash_fallback`. The server's own sends reuse that stored decision.
- **Response:** `{ "event_id": "purchase_in_…", "invoice_id": "in_…", "value": 22.11, "currency": "USD", "value_basis": "predicted_profit_90d", "value_floored": false }`.
- **Errors:** `404 unknown_purchase` when Stripe's webhook has not arrived within the wait; `400` for a malformed id; `401` without a valid signature.

**1. OpenArt's backend (`/legacy/api/stripe/checkout-session-invoice`), after it has resolved `invoiceId`:**

```ts
// New: ask the conversion-service for the value decided for this purchase (one decision per purchase).
const path = `/value?invoice_id=${encodeURIComponent(invoiceId)}&max_wait_ms=1500`;
const t = Math.floor(Date.now() / 1000);
const sig = createHmac('sha256', process.env.OPENART_SIGNAL_HMAC_SECRET!).update(`${t}.GET ${path}`).digest('hex');
let profit: { value: number; currency: string; value_basis: string } | null = null;
try {
  const r = await fetch(`${CONVERSION_SERVICE_URL}${path}`, {
    headers: { 'X-OpenArt-Signal-Signature': `t=${t},v1=${sig}` },
    signal: AbortSignal.timeout(2500),
    redirect: 'error',
  });
  if (r.ok) profit = await r.json();
} catch { /* leave profit null: the tags fall back to cash */ }
return res.json({
  ...existingResponse, // invoiceId, isFirstPurchase, isValidInvoice, isBusiness, amountMinor, amountMajor, currency, ltvValueMajor, ltvCurrency
  profitValueMajor: profit?.value ?? null,
  profitValueCurrency: profit?.currency ?? null,
  profitValueBasis: profit?.value_basis ?? null,
});
```

The new fields are additive: the contracts `invoice-lookup-response.schema.json` allows extra properties, and old tags ignore them.

**2. The purchase tags (`packages/web-fixes`, `app-patches/src/fallback-purchase.ts` `resolveClientPurchase`, and the GTM purchase tags that read the same data layer):**
- Prefer `profitValueMajor` / `profitValueCurrency` over `ltvValueMajor` / `ltvCurrency` for the value of **Meta `Purchase`** and **TikTok `Purchase`** (today's `ltvOrCash`).
- Fall back to cash (`amountMajor` / `currency`) when the new field is null.
- Keep the ids unchanged: `purchase_<invoiceId>` for Meta and `sub_<invoiceId>` for TikTok.
- Optionally push `value_basis` into Meta `custom_data` too.

Google's tag may keep cash: multi-source overrides it with the server value anyway.

**The trade-off.** If the browser asks before the score exists, the purchase is fixed at `cash_fallback` for every platform. That keeps both copies identical. The scorer therefore has to finish within the success page's latency, about 1.5 s after `invoice.paid`, or those purchases carry cash. `value-health` shows the cash-fallback share.

## Refunds and chargebacks

| | Google Data Manager API (implemented) | Google Ads API `ConversionAdjustmentUploadService` (not implemented) |
|---|---|---|
| How | `IngestEvents` with the **same `transactionId` and conversion action**. There is no adjustment type field. | `UploadConversionAdjustments`: `adjustment_type` RETRACTION / RESTATEMENT / ENHANCEMENT, `order_id`, `adjustment_date_time`, `restatement_value`, `partial_failure=true`. |
| Supports | Restating value; supplementing missing user data. "The Data Manager API doesn't support conversion retractions … the conversion count will remain the same." | Retraction (count and value to 0) and restatement. |
| Access | Data Manager is the API for new server-side conversion integrations. | New adopters of offline click imports are refused from 2026-06-15. Whether `UploadConversionAdjustments` is still open to new adopters is **undocumented**, and developer tokens were sunset on 2026-09-09 in favour of Cloud-project access. |

The implemented path sits behind `GOOGLE_ADJUSTMENTS=data_manager_restatement` (default `off`):
- **Restated value:** `sent value × remaining cash ÷ original cash`. The sent value comes from the original record's meta, since its payload is dropped once sent. A full refund or chargeback restates to `0`.
- **Supersession:** a lower cumulative refund processed after a higher one is skipped (`superseded_by_later_refund`). This is checked when the adjustment is queued **and again right before it is sent**.
- **Timing:**
  - The adjustment is sent **no earlier than 24 h after** the original conversion, and at most 54 days after it.
  - Only the first 7 days reach bidding. The outbox records `within_bidding_window`.
- **Existence guard:** an unmatched `transactionId` *creates* a conversion in the Data Manager API. So a **live** Google adjustment waits for an original our own send provably delivered: status `sent`, never `dry_run` or `validated` (a validateOnly or test-routed request is not recorded by the platform). While that send is pending or held, the adjustment waits. A dry-run adjustment may preview against a dry-run original.
- **Meta, TikTok, Reddit, LinkedIn and X:** there is no retraction API. The refund is logged and recorded as `skipped: no_adjustment_api`. Suppression belongs in audiences and pLTV training (`audience-sync`, `warehouse`).
- **Microsoft:** `OnlineConversionAdjustment`, keyed on `TransactionId = sub_<invoiceId>` (the UET tag already sends it):
  - `Restate` for a partial refund.
  - `Retract` for a full refund or chargeback.
  - Sits behind `MICROSOFT_ADJUSTMENTS=online_conversion_adjustments`.

## Windows, gates, consent

**Windows** are checked when a record is queued and again right before sending:

| Platform | Max age | Twin window (browser twin exists) |
|---|---|---|
| Google | 90 days | **7 days**. A value override reaches bidding only within 7 days, and Google advises against value backfills. |
| Meta | **7 days** (an older `event_time` fails the whole request) | **48 h** dedup |
| TikTok | 7 days (web limit unpublished; conservative) | 48 h dedup |
| Reddit | 7 days | 2 days dedup |
| LinkedIn | 90 days | none documented |
| X | 7 days (unpublished; conservative) | 48 h dedup |
| Microsoft UET | 7 days (offline import: 90 days) | none documented |

- Expired rows are `skipped: window_expired` or `twin_window_expired`. Future-dated rows are `skipped: event_time_in_future`.

**Gates** hold a row and release it at drain time:

| Gate | Released when | Rows that are dropped instead |
|---|---|---|
| **web_fix** (the contracts rows flagged `requires_web_fix`) | `WEB_FIXES_LIVE=signup:tiktok@2026-10-01T00:00:00Z,…` | Events *before* that time are dropped (`predates_web_fix`): their browser copy never carried the id, so a server copy would double count. |
| **google_multi_source** | `GOOGLE_MULTI_SOURCE_CONFIRMED=true` | – |
| **reddit_dedup** | `REDDIT_DEDUP_VERIFIED=true` | – |
| **value_score** (acquisition purchases) | a purchase-time score exists, or `VALUE_SCORE_SLA_MS` has passed (then `cash_fallback`) | – |

- A gate-held record is only read again at its deadline (to expire it, `window_expired_while_held`) or when the gate configuration changes. Then every held record is scanned once. The outbox is not re-read on every drain.

**Consent** (default policy; the legal call is OpenArt's):
- **Consent block on the row:** it comes from the event's explicit CMP state, else the user's stored CMP state, else "unknown" in the user's country. The contracts `Consent` also carries `gpc` (Global Privacy Control observed) and `opt_out_sale_sharing` (US-state "do not sell or share").
- **Regions:** `CONSENT_REQUIRED_REGIONS` from `@openart-signal/contracts` is the single source of truth. It covers the EEA including its outermost regions and Åland, plus GB (with a `UK` alias) and CH. Subdivisions like `GB-ENG` are normalised.
- **GPC or a sale/sharing opt-out:** nothing is sent to any platform, anywhere (`gpc_or_sale_opt_out`). A CMP grant and `restrict` handling do not override it.
- **An explicit `denied` counts whatever its source** (`cmp`, `regional_default` or `none`).
- **EEA, UK and CH:** sent only with a CMP grant of `ad_storage` and `ad_user_data`. Otherwise `consent_required_regulated_region`. Today there is no CMP, so every such row is withheld.
- **Unknown region:** withheld (`consent_region_unknown`, fail-closed). `CONSENT_UNKNOWN_REGION=allow` needs `CONSENT_UNKNOWN_REGION_ACK=send-unknown-region-users-without-a-consent-check`.
- **Elsewhere, no CMP (today):** sent, asserting nothing:
  - No Google `consent` object (the tag's `gcd` is "not set" too).
  - Meta `data_processing_options: []`.
  - Microsoft keeps its default.
- **CMP-granted:** Google receives `adUserData`/`adPersonalization` verbatim, and Microsoft `adStorageConsent:"G"`.
- **Explicit opt-out outside the EEA:** dropped (`CONSENT_OPT_OUT_HANDLING=drop`). `restrict` instead sends only where a limited-use mode exists:
  - Google `CONSENT_DENIED`.
  - Meta LDU with country `1` and state `1000` for CA. US only.
  - TikTok `limited_data_use` (needs the IP).
  - Reddit `data_processing_options` LDU.
  - Microsoft `"D"`.
  - LinkedIn and X have no such field, so they are dropped.
- **Decided again right before sending.** The row's consent is merged with the user's **current** state from the user-context view (`mergeConsentForSend`). A denial or opt-out on either side wins, so a withdrawal, GPC or an opt-out between queueing and sending stops the send (`<reason>_at_send`). A later grant never overrides a denial recorded with the event. A queued payload is sent only if its consent claims are no more permissive than what is allowed now (`consent_changed_since_enqueue`). If the user state cannot be read, the record stays queued: it is never sent without the check.

## Retention and erasure

**Firestore.** Every document carries `expire_at`, stored as a Timestamp so a **TTL policy** deletes it (`infra/conversion-service/firestore.indexes.json`, `ttl: true` on every collection group):

| Documents | Kept for |
|---|---|
| Outbox, terminal | 30 days; **100 days** for purchase sends (a refund adjustment must still find the original: Google adjusts up to 54 days, Microsoft 90) |
| Outbox, still sendable | until its send-by deadline + 30 days |
| Inbox | 35 days (Stripe retries for 3) |
| Parked Stripe events | 7 days (swept after 6 h anyway) |
| Dead letters | 30 days |
| Value decisions | 100 days |
| Stripe join state, HubSpot contact state | 400 days, refreshed on every write |

**Payloads are minimised.** A record that reaches a terminal state (`sent`, `validated`, `dry_run`, `skipped`, `dead`) drops its platform payload: hashed identifiers, IP and user agent. It keeps only the decision and non-PII meta (dedup key, value and `value_basis`).

**BigQuery.** `conversion_ledger_raw` partitions expire after 760 days and require a partition filter, and `ad_click_ids` partitions expire after 100 days (`bigquery/tables.sql`). **Dry-run files** are deleted by the bucket's 30-day lifecycle rule (`dry-run-bucket-lifecycle.json`).

**Erasure.** `POST /tasks/erase {"user_id": "<uid>"}` (or `{"hubspot_contact_id": "…"}`) uses the internal HMAC or the scheduler's OIDC token. It deletes at once every Firestore document about the person:
- outbox, parked events, inbox, dead letters and value decisions
- Stripe subscription, refund and checkout state
- payment-intent and charge links, found through the user's purchase invoices

It then erases the ledger. The in-memory and file ledgers delete at once. BigQuery **queues** the user in `conversions.erasure_requests`, and a scheduled `DELETE` removes their rows once they have left the streaming buffer (BigQuery refuses DML on buffered rows).

## Plugging into OpenArt's stack

### 1. Stripe: pick one of two routes

**A. Add an endpoint (additive).**
- Stripe supports several endpoints, so the existing handler is untouched.
- Add `https://<load balancer>/webhooks/stripe` with these 7 types: `checkout.session.completed`, `invoice.paid`, `invoice_payment.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`.
- Store the signing secret as `STRIPE_WEBHOOK_SECRETS`. Rotation is supported: list the new secret first.
- Signatures are verified **offline** with `stripe.webhooks.constructEvent`, with a 300 s tolerance.
- The source schema accepts the `2026-08-26.dahlia` shape and legacy (pre-basil) invoices.
- Redeliveries are deduped on `event.id`.
- Out-of-order events are **parked** on the missing join and replayed when it arrives. An example is a refund arriving before its `invoice_payment.paid`.
  - After parking, the event is mapped once more, so a join that landed in between is never left for the sweep.
  - A replay removes the parked copy only after it succeeded.
  - A re-park keeps the first parked time.
  - After `PARKING_MAX_MS` (default 6 h), a parked event is mapped in degraded form: the cash is kept and the joins stay empty.
  - A parked event whose replay keeps failing is dead-lettered after `PARKING_MAX_SWEEP_ATTEMPTS` sweeps, without blocking the others.

**B. Keep only the existing handler and publish (`infra/conversion-service/pubsub-subscription.yaml`).**
- After verifying an event, the handler publishes the raw body plus the original signature header:

```ts
await pubsub.topic('stripe-events').publishMessage({
  data: rawBody, // the exact bytes Stripe sent
  attributes: { stripe_signature: req.headers['stripe-signature'], stripe_event_id: event.id, stripe_event_type: event.type },
});
```

- A push subscription (OIDC as `stripe-events-push@…`) delivers the message to `POST /pubsub/stripe`.
- That route re-checks the Stripe signature. The tolerance is 4 days, to cover redelivery.
- **`PUBSUB_REQUIRE_STRIPE_SIGNATURE` defaults to `true`, and live mode refuses `false`.** Without the check, anyone able to publish to the topic could inject purchases. `false` is only for a dry-run test of a handler that cannot forward the header yet.
- A dead-letter topic catches poison messages.

### 2. OpenArt's backend → `POST /events` (and `GET /value`)

- **Signing:** each request is signed with `X-OpenArt-Signal-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. The scheme is Stripe's; the helper is `signInternalBody`. `GET /value` signs `"<t>.GET <path>?<query>"` instead (see [Meta keeps the pixel's copy](#meta-keeps-the-pixels-copy-make-the-browser-send-the-same-value)).
- **Body:** one envelope, or an array of up to 100. Each carries a **contracts source record**, validated against the contracts JSON Schema.

| Moment in OpenArt's backend | Envelope | Canonical event |
|---|---|---|
| The trial grant is written (`USER_SIGNUP_TRIAL` ADD) | `{ "kind": "credit_ledger_entry", "entry": <ledger entry> }` | `signup` → `reg_<uid>` |
| The first `CONSUME` of a capability | same kind | `activation_first_generation` (idempotent per user) |
| `POST /api/stripe/subscription` created a Checkout Session | `{ "kind": "checkout_session_created", "checkout": { user_id, checkout_session_id, tier, billing_interval, occurred_at, ga_client_id, ga_session_id, gclid, tolt_referral } }` | `checkout_started` → `checkout_<cs>` |
| (or) Amplitude `subscription_started` | `{ "kind": "amplitude_event", "row": <export row> }` | `checkout_<uuid>` |
| HubSpot /enterprise form | `{ "kind": "hubspot_form_submission", "submission": …, "contact_id": "…" }` | `enterprise_lead` |
| HubSpot `lifecyclestage` webhook | `{ "kind": "hubspot_contact_property_change", "change": … }` | `lead_stage_change` (SQL by default) |

Every envelope can carry the request `context` the backend already has:
- `consent`: the CMP state, as a contracts `Consent` (with `gpc` and `opt_out_sale_sharing` when known).
- `region`
- `email` / `phone`: hashed per platform on arrival; the raw values are never stored.
- `device_id`
- `client_ip_address` and `client_user_agent`. Meta *requires* the UA on website events, so capture it at signup and at the checkout form POST.
- `event_source_url`: kept only when `https`, with the query string and fragment removed.
- `fbc`, `fbp`, `ttp`, `rdt_uuid` cookies.
- `click_ids`: a contracts `ClickIdStoreRecordExtended`.

For Stripe events, the same fields come from the **user context** view and the **ad-click-ids** table (`infra/conversion-service/bigquery/tables.sql`). Purchase-time values come from `fct_purchase_value_score`. Invalid experiment arms from the user store are dropped (`enrich.experiment_arms_dropped`); they never cost the purchase.

### 3. Meta CAPI Gateway: unchanged

- The CAPIG keeps relaying pixel events exactly as today.
- This service posts **directly** to `graph.facebook.com/v26.0/843671884361709/events` with the **same `event_name` + `event_id`** the pixel passes to `fbq` (`CompleteRegistration`/`reg_<uid>`, `Purchase`/`purchase_<invoiceId>`). Meta keeps one copy within 48 h, usually the pixel's (see [Meta keeps the pixel's copy](#meta-keeps-the-pixels-copy-make-the-browser-send-the-same-value)).
- **Verify before relying on it:** check that the gateway's copy keeps the explicit `eventID` rather than the `openbridge3` plugin's `ob3_plugin-set_…` id (unverified in research). Use Events Manager test events and the Dataset Quality API's `dedupe_key_feedback`.
- The gateway still cannot add `fbc` to pixel events. The server events carry the rebuilt `fbc`.

## Platform access prerequisites

- **Google, Data Manager API**
  - OAuth scope `https://www.googleapis.com/auth/datamanager`.
  - Use the Cloud Run service account; add it as a user of the Google Ads account.
  - `GOOGLE_ADS_OPERATING_ACCOUNT_ID` is the 10-digit customer id, *not* `AW-11252321380`.
  - `GOOGLE_ADS_CONVERSION_ACTIONS` holds numeric conversion-action ids. `purchase_first` **must** be the action whose tag label is `OfGcCJisoLQZEOSYw_Up`, because multi-source only matches within the same action.
  - The events overview page summary calls multi-source "allowlist-only". **Confirm allowlisting with the Google rep.** Every action also has a 14-day trial with no value overrides.
  - `GOOGLE_VALIDATE_ONLY` must be **set explicitly** when google_ads is live (startup refuses otherwise). Keep `true` for the first live days: those requests end as `validated`, never `sent`, and never confirm an adjustment.
  - `AW-16854695811` receives the same `oid`. Send only to the account whose action is primary.
- **Meta:** a system-user token with access to pixel 843671884361709. It is sent as `Authorization: Bearer`, never in the URL.
- **TikTok:** an Events API access token from Events Manager for pixel `D9QOQ5JC77U6RO6J21IG`.
- **Reddit:** a conversion access token (scope `adsconversions`) for `a2_j6xo78gpljnf`.
- **LinkedIn:** the app needs Conversions API access (`rw_conversions`, `r_ads`, and an ad-account role).
  - Create **one CONVERSIONS_API conversion rule per event**, separate from the Insight Tag rules (dedup needs a rule per source).
  - Put the URNs in `LINKEDIN_CONVERSION_RULES`.
  - API version header `202609`.
- **X:** Ads API access for the app, plus OAuth 1.0a user tokens of an `AD_MANAGER`/`ACCOUNT_ADMIN` user. Make only one of `tw-qwghh-13vj24` and the automatic `gtm_purchase` a counted conversion.
- **Microsoft:** the UET Conversions API is a staged rollout ("Not everyone has this feature yet"), so ask the account team.
  - Until it is enabled, `MICROSOFT_SEND_MODE=offline_conversions` sends the **server-only** goals (renewals, add-ons, packs, leads) through `ApplyOfflineConversions` (hashed email/phone or MSCLKID, 90-day window).
  - In that mode, tag twins are skipped (`offline_import_cannot_dedupe_with_uet_tag`): offline imports never dedupe against UET tag conversions.
  - Offline import and adjustments need Ads API OAuth, a developer token and `MICROSOFT_CONVERSION_GOALS` (goal names).

## GTM changes before going live (GTM-56CMP8K; `packages/web-fixes` builds them)

1. **TikTok `CompleteRegistration`** (tag 79): set `event_id` = `reg_<uid>`. Today it sends `""`.
2. **Reddit `SignUp`** (tag 57): add `conversionId` = `reg_<uid>`.
3. **LinkedIn Insight conversions:**
   - `29290241` (tag 72): add `event_id` = `reg_<uid>`.
   - `29290225` (tag 58): add `event_id` = `sub_<invoiceId>` and the value.
4. **X signup `tw-qwghh-13vj22`** (tag 76): add `conversion_id` = `reg_<uid>`.
5. **UET purchase `uetq.push('event','purchase', …)`:** add `event_id` = `sub_<invoiceId>` next to `transaction_id`.
6. **Google signup:** the `new_user_signed_up` trigger is dead, so Google gets server signups only. If it is revived, it must set `transaction_id` = `reg_<uid>`.
7. **Fallback id:** stop the Suite's `Date.now()` fallback order id (`sub_<tier>_<code>_<uid>_<ms>`); it can never dedupe.
8. **Purchase value:** Meta and TikTok `Purchase` send `profitValueMajor`/`profitValueCurrency` from the invoice lookup (see [Meta keeps the pixel's copy](#meta-keeps-the-pixels-copy-make-the-browser-send-the-same-value)).
9. **Consent:** install a Google-certified CMP (Consent Mode v2 or TCF) before any EEA/UK/CH row is sent, and write its state into the user context. Include GPC and US-state opt-outs.
10. **Then:** publish the container, and set `WEB_FIXES_LIVE=<event>:<platform>@<publish time>` for exactly the tags that shipped.

## Running it

```bash
npm run test --workspace @openart-signal/conversion-service        # 286 tests (23 files), all offline
npm run typecheck --workspace @openart-signal/conversion-service
npm run dry-run:fixtures --workspace @openart-signal/conversion-service -- ./dry-run-out   # every fixture → request files
npm run value-health --workspace @openart-signal/conversion-service -- --from-json ./outbox.jsonl
npm run build --workspace @openart-signal/conversion-service       # esbuild → dist/server.mjs
STRIPE_WEBHOOK_SECRETS=whsec_local INTERNAL_EVENTS_HMAC_SECRETS=local-hmac-key-0123456789abcdef0123 \
  npm run start --workspace @openart-signal/conversion-service    # in-memory, dry-run, :8080
```

The two secrets in the last command are documented examples; live mode refuses them.

**The end-to-end test** (`test/e2e/e2e.test.ts`) replays the contracts fixtures through the real HTTP server on 127.0.0.1:
- The inputs are 27 signed Stripe events and 10 HMAC-signed app events.
- U02's history arrives 9 days late.
- Between deliveries, the Cloud Scheduler drain runs whenever something is due. For example, acquisition purchases wait for their purchase-time score, and gate holds expire.
- The web fixes and Reddit verification are then switched on.

It asserts:
- exact per-platform payload snapshots (`test/__snapshots__/e2e/requests.<platform>.json`, plus the outbox decision table and the ledger)
- dedup ids equal to the browser formats
- per-platform hashing
- purchase-time values: U01's score 22.11, U03's `cash_fallback`, and U05's loss-making pack sent at the recorded floor
- Meta renewals as `system_generated`
- a Google adjustment and a Meta skip for the refund
- window expiry
- consent handling
- web-fix holds
- **zero network calls**

Other suites cover:
- **Malformed request lines** sent over a raw socket (`GET ///`, `GET //[`): the process keeps serving.
- **Real `Request` construction** for the Firestore adapter: GET and DELETE carry no body.
- **At send time:** the consent re-check, value holds, credential retries and lease renewal.
- **Erasure**, and the value-health report.

The network guard (`test/setup/no-network.ts`) makes global `fetch`, every non-loopback socket and every DNS lookup fail the test.

### HTTP routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness only: `{"status":"ok"}`. No mode, no platforms. |
| `POST /webhooks/stripe` | Stripe signature | Stripe events |
| `POST /events` | HMAC over the body | app events |
| `GET /value` | HMAC over `GET <path>?<query>` | the purchase's value, for the browser pixel |
| `POST /pubsub/stripe` | OIDC + forwarded Stripe signature | Pub/Sub alternative |
| `POST /tasks/drain` | OIDC (scheduler) or HMAC | sweep parked events, then **always** drain (a failing sweep is reported as `sweep_error`) |
| `POST /tasks/erase` | OIDC (scheduler) or HMAC | erasure by user id or HubSpot contact |

A malformed request never becomes an unhandled rejection:
- URL parsing is inside the handler's `try`.
- The handler promise is always caught.
- `unhandledRejection` is logged as a last resort (`src/process.ts`).

On `SIGTERM`, the server stops accepting connections, waits for in-flight requests and the background drain, and then exits.

### Configuration

| Area | Variables |
|---|---|
| Required | `STRIPE_WEBHOOK_SECRETS` (`whsec_…`), `INTERNAL_EVENTS_HMAC_SECRETS` (≥32 chars) |
| Mode | `CONVERSION_SERVICE_MODE`, `LIVE_PLATFORMS`, `LIVE_CONFIRM`, `ENABLED_PLATFORMS` (kill switch), `DRY_RUN_OUT_DIR` |
| Stripe | `STRIPE_LIVEMODE` (`live`/`test`/`any`; default `live` in live mode, `any` in dry-run), `STRIPE_WEBHOOK_TOLERANCE_SECONDS`, `STRIPE_PUBSUB_TOLERANCE_SECONDS` |
| Gates and flags | `WEB_FIXES_LIVE`, `GOOGLE_MULTI_SOURCE_CONFIRMED`, `GOOGLE_ADJUSTMENTS`, `GOOGLE_VALIDATE_ONLY` (explicit when google_ads is live), `REDDIT_DEDUP_VERIFIED`, `REDDIT_CONVERSION_ID_MODE`, `MICROSOFT_SEND_MODE` (uet_capi/offline_conversions), `MICROSOFT_ADJUSTMENTS` |
| Destinations | `GOOGLE_ADS_OPERATING_ACCOUNT_ID`, `GOOGLE_ADS_LOGIN_ACCOUNT_ID`, `GOOGLE_ADS_CONVERSION_ACTIONS`, `LINKEDIN_CONVERSION_RULES`, `X_EVENT_IDS`, `MICROSOFT_ADS_CUSTOMER_ID`, `MICROSOFT_ADS_ACCOUNT_ID`, `MICROSOFT_CONVERSION_GOALS`, `META_API_VERSION` (v26.0), `LINKEDIN_VERSION` (202609), test codes (`META_TEST_EVENT_CODE`, `TIKTOK_TEST_EVENT_CODE`, `REDDIT_TEST_ID`: their requests end as `validated`) |
| Value | `VALUE_SCORE_SLA_MS` (600000), `VALUE_SCORE_RECHECK_MS` (60000), `VALUE_FLOOR_USD` (0.01, reporting currency), `REPORTING_CURRENCY` (USD), `FX_RATES_TO_REPORTING` (`{"EUR":1.08}`) |
| Policy | `CONSENT_OPT_OUT_HANDLING`, `CONSENT_UNKNOWN_REGION` (+ `CONSENT_UNKNOWN_REGION_ACK` for `allow`), `LEAD_CONVERSION_STAGES`, `EVENT_SOURCE_URLS` |
| Storage | `STORE_BACKEND` (memory/firestore), `FIRESTORE_*`, `LEDGER_BACKEND` (memory/file/bigquery), `BIGQUERY_PROJECT_ID`, `BQ_LEDGER_TABLE`, `BQ_PURCHASE_VALUE_TABLE`, `BQ_AD_CLICK_IDS_TABLE`, `BQ_USER_CONTEXT_TABLE`, `BQ_ERASURE_REQUESTS_TABLE` (`BQ_PREDICTED_PROFIT_TABLE` is refused) |
| Push auth | `OIDC_AUDIENCE`, `PUBSUB_PUSH_SERVICE_ACCOUNT`, `SCHEDULER_SERVICE_ACCOUNT`, `PUBSUB_REQUIRE_STRIPE_SIGNATURE` (default `true`) |
| Outbox | `OUTBOX_DRAIN_AFTER_INGEST` (async/sync/off), `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_*_BACKOFF_MS`, `OUTBOX_LEASE_MS`, `OUTBOX_LEASE_RENEW_MS`, `OUTBOX_CLAIM_CONCURRENCY`, `PARKING_MAX_MS`, `PARKING_MAX_SWEEP_ATTEMPTS` |

### Ingress and rate limiting

The service authenticates every route itself, but it should not take traffic straight from the internet:
- Deploy with ingress `internal-and-cloud-load-balancing`. Pub/Sub push and Cloud Scheduler count as internal.
- Put an external HTTPS load balancer with a **Cloud Armor** policy in front:
  - `/webhooks/stripe` only from Stripe's published webhook IPs.
  - `/events` and `/value` only from OpenArt's backend egress.
  - A per-IP rate-based ban on everything else.
- API Gateway is the alternative.

Commands are in `infra/conversion-service/cloudrun-service.yaml`. Least-privilege IAM is in `infra/conversion-service/iam.yaml`: table-level BigQuery grants, one Firestore database, a write-once custom role on the dry-run bucket, and per-secret access.

### Going live

Live mode needs all three of these, and the rest of the platforms stay dry-run:
- `CONVERSION_SERVICE_MODE=live`
- `LIVE_PLATFORMS=<platform list>`
- `LIVE_CONFIRM=send-real-conversions-to-ad-platforms`

Startup **refuses** to run (naming the variable, never the value) when any of these hold:
- the storage is in-memory (it needs `STORE_BACKEND=firestore` and `LEDGER_BACKEND=bigquery`)
- a secret is short, lacks the `whsec_` prefix, or is a documented example or placeholder (the README and Dockerfile values, `changeme`, `example`…)
- a live platform's credentials are missing or implausible (`infra/conversion-service/secrets.yaml`)
- `GOOGLE_VALIDATE_ONLY` is not set explicitly for a live google_ads
- `PUBSUB_REQUIRE_STRIPE_SIGNATURE=false`
- `STRIPE_LIVEMODE` is anything but `live`

Retry and delivery behaviour:
- Retries use exponential backoff with jitter and honour `Retry-After`.
- **Credential failures are retries, never dead letters:** 401/403, Meta OAuthException 190 and permission codes, TikTok token codes, and a token that cannot be minted. They do not use up attempts, so a broken token pauses sending until each record's send-by deadline.
- A rejected multi-event batch is split so only the bad event dead-letters.
- Every request is validated against the platform's JSON Schema before it is sent, and no request follows a redirect.
- A 2xx for a validation-only request (Google validateOnly, test_event_code, test_id) is recorded as `validated`, not `sent`.
- Leases are renewed while a drain is still sending, so a slow send is never reclaimed and resent by another drain.
- Delivery is at-least-once, bounded by leases. All seven platforms dedupe on our ids, except that Meta keeps consecutive **server** duplicates, which a crash between send and acknowledgement could produce.

## Not verified from official docs

- **Google:**
  - Whether multi-source is allowlisted for OpenArt: the page summary says "allowlist-only" but the body text does not.
  - Data Manager's maximum event age: `EVENT_TOO_OLD` exists without a documented window.
  - Whether identifiers are required on an adjustment event. They are sent to satisfy the send-events rule.
  - Whether `UploadConversionAdjustments` is open to new adopters.
  - The docs conflict on `WEBPAGE` vs `WEBSITE` naming for the action type.
- **Meta:**
  - Whether CAPIG keeps explicit `eventID`s.
  - Types in the `custom_data` table (taken from the official Business SDK).
  - LDU state codes beyond `1000` (the pages disagree), so other states use `0` (geolocate).
  - That every credential error arrives as code 190/102/10/2xx (the Graph API error reference).
- **TikTok:**
  - The maximum web-event age (7 days assumed).
  - Whether one bad event fails the batch.
  - The access-token and permission codes treated as credential retries (40001, 40101, 40102, 40104, 40105).
- **Reddit:** how it decides a `conversion_id` is already hashed (hence the gate).
- **LinkedIn:**
  - The dedup window.
  - The batch response body.
- **X:**
  - No live API reference exists. The fields come from the archived reference and current guides.
  - `value` number vs string: the docs example uses a string, while the reference says double.
  - The 500-events-per-request cap (this service uses 100).
  - The maximum `conversion_time` age.
  - The dedup window is from archived help text.
- **Microsoft:**
  - CAPI availability.
  - The online-adjustment time window and per-request maximum.
  - Whether `TransactionId` is required.
  - Access tokens must be refreshed outside the service.
