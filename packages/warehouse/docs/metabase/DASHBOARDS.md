# Metabase dashboards

Seven native questions (`docs/metabase/*.sql`) over the `openart_signal_reporting` dataset, grouped
into five dashboards. The SQL is written to run unchanged on BigQuery (production) and DuckDB (the
local fixture build): `python_tests/test_docs_sql.py` executes every question against the local
build and parses it with the BigQuery dialect.

**BI reads aggregate-only views, never the marts.** `openart_signal_reporting` holds the `rpt_*`
views (`models/reporting/`): every one is grouped to a day or month and a categorical dimension and
carries no user id, device id, click id, HubSpot contact id or purchase id. The marts keep those
identifiers for the services that need them (conversion-service, audience-sync, bandit-allocator)
and stay out of Metabase. Policy tags (BigQuery Data Catalog) belong on the marts' `user_id`,
`device_id`, `click_ids`, `utm`, `ga_client_id`, `ga_session_id`, `tolt_referral`, `invoice_id`,
`subscription_id`, `checkout_session_id`, `charge_id` and the ledger's `lead` JSON, so that even a
principal with dataset access cannot read them without the tag's role. Raw datasets hold the
personal data (emails, billing details, full Stripe and Amplitude payloads); the staging layer
whitelists fields on the way in (`macros/openart/stripe.sql`, `stg_amplitude__events`).

On the local target the platform-side numbers are **SYNTHETIC** (`platform_data_origin =
'synthetic'`, from `scripts/make_platform_reports.py`). Every reconciliation card shows that
column, so a synthetic number can never be mistaken for a platform export.

## Connecting Metabase to BigQuery

1. **Admin → Databases → Add database → BigQuery.**
2. Create a service account for Metabase only. Give it **BigQuery Data Viewer** on the
   `openart_signal_reporting` dataset ONLY and **BigQuery Job User** on the project that pays for
   queries. It needs nothing on the marts or the raw datasets: every question reads the `rpt_*`
   views, which are authorized views over the marts (grant the views' dataset access to the marts
   dataset in BigQuery, so the account never holds a marts role).
3. Upload that account's key in the connection form. Metabase stores it encrypted; the key never
   goes into this repo.
4. Set **Datasets → Only these: `openart_signal_reporting`** so the data browser shows the views only
   (a UI filter; the IAM grant in step 2 is what enforces it).
5. Schedule **sync** after the dbt job, e.g. hourly dbt → sync at :15. Turn on **question
   caching** (Admin → Performance) for a TTL just under the dbt cadence. The marts are rebuilt
   tables, so cached results stay consistent between runs.
6. The native questions refer to `openart_signal_reporting.<view>`, which resolves in the connection's
   default project. If the views live in another project, prefix the dataset with it.

Variables: in each question, open the variable panel and set the types and defaults listed in the
question's header comment (`@param`). Optional `[[ ... ]]` clauses drop out when a variable is empty.

## Dashboard 1: "Conversion signal: Stripe vs warehouse vs platforms"

The question it answers: where does each platform's reported number stop matching Stripe, and why?

| Card | Question | Visualization |
|---|---|---|
| Gap waterfall | `01_reconciliation_gap_waterfall.sql` | Waterfall. X `step_name`, sorted by `step_order`; Y `value_usd`; "Show total" on (= platform-reported). Duplicate the card with Y `conversions`. |
| Stripe vs warehouse vs platform | `02_reconciliation_summary.sql` | Table. Conditional formatting: `gap_vs_stripe_pct` red above +10% or below -10%; `unexplained_usd` red if not 0. |

Dashboard filters: **Platform** → `platform` (default `meta`), **Layer** → `report_layer`
(default `ads_attributed`), **Month** → `period_month`.

Reading the waterfall (research/08 §5.6 checklist, one bar per cause):

- `stripe_truth`: money in, net of refunds, by UTC month.
- `warehouse_vs_stripe`: pipeline defects. This must be 0. Alert on it.
- `refunds_not_netted`: platforms keep gross value.
- `out_of_scope_purchase_types`: renewals, upgrades, add-ons and packs no tag sees. Meta and TikTok also drop non-first purchases.
- `blocked_users`: purchasers with no Amplitude events (the blocker proxy).
- `double_counting`: Google's two accounts; X's second `gtm_purchase`.
- `ltv_in_value`: Meta and TikTok receive LTV, not cash.
- `value_not_sent`: LinkedIn receives no value.
- `fallback_misvaluation`: a failed invoice lookup sends a stale list price, or nothing at all to Meta and TikTok.
- `time_zone`: months cut in the ad account's zone.
- `unattributed_users`, `attribution_window`, `click_vs_conversion_date`: `ads_attributed` layer only.
- `residual`: whatever the modelled causes do not explain.

**Alerts** (Metabase alerts on saved questions):

- Alert when `02_reconciliation_summary.sql` has any row with `unexplained_usd <> 0` in production (a new platform behaviour, or a tag change).
- Alert when `stripe_net_usd <> warehouse_net_usd` (a pipeline defect).

## Dashboard 2: "Default-model experiment: profit per exposed user"

| Card | Question | Visualization |
|---|---|---|
| Arm readout | `03_experiment_profit_by_arm.sql` | Table. Highlight rows where `conversion_and_profit_rank_agree` is false. |
| Predicted profit per arm | same question | Bar. X `arm`, Y `predicted_profit_per_exposed_usd`; add `predicted_profit_ci_low` / `_high` (sampling + model error) as a range. |
| Conversion vs profit | same question | Scatter. X `conversion_rate_pct`, Y `predicted_profit_per_exposed_usd`, bubble size `exposed_users`. |
| Daily first exposures | `06_experiment_daily_srm.sql` | Line. X `exposure_date`, Y `exposed_users`, series `arm`; filter the holdout slice to eyeball sample-ratio mismatch. |

Dashboard filter: **Flag** → `flag_key`.

Notes:
- `realised_profit_per_exposed_usd` is money already booked over a FIXED 90-day horizon, for
  matured users only (`matured_users`, `share_matured`); it is never truncated at today.
- `predicted_profit_per_exposed_usd` is the 24h score (unconditional per exposed user, scored at
  signup + 24h), the early readout the bandit (packages/bandit-allocator) uses. Its interval
  `predicted_profit_ci_*` includes the cross-fitted model error; `predicted_profit_sampling_ci_*`
  is the old, too-narrow interval, kept for the allocator's sufficient-statistic recovery.
- `contaminated_users` saw more than one arm and are kept in their first arm (intention to treat).
- `predicted_24h_signals_only_usd` = the served score (arm terms are off by default);
  `predicted_profit_with_arm_terms_per_exposed_usd` shows the cross-fitted, shrunk arm variant.

## Dashboard 3: "Signal coverage"

| Card | Question | Visualization |
|---|---|---|
| Coverage by event | `04_signal_coverage.sql` | Table with progress bars on every `pct_*` column (max 100). |

Dashboard filter: **Since** → `since`.

What to watch:
- `pct_meta_fbc_buildable` on purchases: the share of Meta purchases that can carry a server-side `fbc`.
- `pct_google_click_id`.
- `pct_consent_region_known`: needed for consent gating (unknown fails closed).
- `web_fix_platforms`: browser twins that must be patched before server events go live.

## Dashboard 4: "Purchase value (the ad value) by channel"

| Card | Question | Visualization |
|---|---|---|
| Value by month | `05_purchase_value_by_channel.sql` | Stacked bar. X `purchase_month`, Y `platform_value_usd`, series `acquisition_channel`. |
| Channel table | same question | Table: purchases, `cash_value_usd` vs `predicted_profit_90d_usd`, `mean_interval_width_usd`, `negative_value_purchases`. |

Dashboard filter: **Model version** → `model_version`. The value is `fct_purchase_value_score`:
E[90-day gross profit | purchase], scored at the purchase from what was known then. A rising
`negative_value_purchases` share or a widening interval is the first sign the structural model
disagrees with the data; the out-of-time backtest (`target/oot_backtest_report.md`) is the check.

## Dashboard 5: "Data quality"

| Card | Question | Visualization |
|---|---|---|
| Quarantine | `07_data_quality.sql` | Table; conditional formatting: `severity = 'excluded'` red. |

**Alert** when any `excluded` row appears (money the ledger left out: an unclassified billing
reason, a purchase in a currency without an FX rate) and when `stripe_event_type_not_handled`
shows a type the staging layer should read.
