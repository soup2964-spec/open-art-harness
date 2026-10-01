-- BigQuery objects the conversion-service writes or reads (nothing is created by this repo).
-- Run with: bq query --use_legacy_sql=false --project_id=PROJECT_ID < infra/conversion-service/bigquery/tables.sql
-- IAM is table-level (infra/conversion-service/iam.yaml): the service can touch exactly these tables.

-- 1. WRITTEN: raw landing table for the canonical ledger (streaming inserts, insertId = event_id).
--    Column order = contracts CONVERSION_LEDGER_COLUMNS + ingested_at. CASH ONLY: predicted value never lands here.
--    Streaming dedup is best effort, so the warehouse model fct_conversion_ledger keeps the first row per event_id:
--      SELECT * EXCEPT(rn) FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY ingested_at) rn
--                                FROM conversions.conversion_ledger_raw WHERE occurred_at >= ...) WHERE rn = 1
--    Retention: partitions expire after 760 days (25 months: two full years of year-over-year comparison);
--    set this to OpenArt's retention policy. require_partition_filter makes every read name an occurred_at
--    range (the service's lookups are bounded: src/adapters/ledger.ts), so nothing full-scans the ledger.
CREATE SCHEMA IF NOT EXISTS conversions OPTIONS (location = 'US');

CREATE TABLE IF NOT EXISTS conversions.conversion_ledger_raw (
  schema_version INT64 NOT NULL,
  event_id STRING NOT NULL,
  event_name STRING NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  source_system STRING NOT NULL,
  source_event_id STRING NOT NULL,
  user_id STRING,
  device_id STRING,
  order_id STRING,
  adjusts_event_id STRING,
  adjusts_order_id STRING,
  cash_value_minor INT64,
  currency STRING,
  invoice_id STRING,
  subscription_id STRING,
  checkout_session_id STRING,
  charge_id STRING,
  plan_tier STRING,
  plan_tier_code INT64,
  billing_interval STRING,
  previous_plan_tier STRING,
  credit_pack_quantity INT64,
  is_first_purchase BOOL,
  is_business BOOL,
  generation STRUCT<business_type STRING, model_id STRING, credits INT64>,
  lead STRUCT<
    hubspot_portal_id INT64,
    form_id STRING,
    contact_id STRING,
    lifecycle_stage STRING,
    previous_lifecycle_stage STRING,
    lead_source STRING,
    lead_source_detail STRING,
    company_size STRING
  >,
  click_ids JSON,
  utm JSON,
  ga_client_id STRING,
  ga_session_id STRING,
  tolt_referral STRING,
  consent STRUCT<
    ad_storage STRING,
    ad_user_data STRING,
    ad_personalization STRING,
    analytics_storage STRING,
    region STRING,
    source STRING,
    gpc BOOL,                  -- Global Privacy Control observed (contracts Consent.gpc)
    opt_out_sale_sharing BOOL  -- US-state "do not sell or share" opt-out (contracts Consent.opt_out_sale_sharing)
  >,
  experiment_arms JSON,
  ingested_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(occurred_at)
CLUSTER BY event_name, user_id
OPTIONS (
  description = 'openart-signal conversion-service: one canonical conversion per source event (contracts ConversionLedgerEvent). Cash only.',
  partition_expiration_days = 760,
  require_partition_filter = TRUE
);

-- An existing table (created before these options and consent fields):
--   ALTER TABLE conversions.conversion_ledger_raw SET OPTIONS (partition_expiration_days = 760, require_partition_filter = TRUE);
--   bq show --schema --format=prettyjson PROJECT_ID:conversions.conversion_ledger_raw > schema.json
--   (add {"name":"gpc","type":"BOOLEAN"} and {"name":"opt_out_sale_sharing","type":"BOOLEAN"} to consent.fields)
--   bq update PROJECT_ID:conversions.conversion_ledger_raw schema.json

-- 2. WRITTEN: erasure requests (POST /tasks/erase). Firestore documents are deleted at once; ledger rows may
--    still sit in the streaming buffer, where BigQuery refuses DML, so the service queues the user here and
--    the scheduled query below deletes their rows once the buffer has flushed.
CREATE TABLE IF NOT EXISTS conversions.erasure_requests (
  user_id STRING NOT NULL,
  requested_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(requested_at)
OPTIONS (description = 'conversion-service erasure requests; consumed by the scheduled ledger DELETE.', partition_expiration_days = 400);

-- Scheduled query (daily; BigQuery scheduled queries, run as a DML-capable service account):
--   bq query --use_legacy_sql=false --schedule='every 24 hours' --display_name='conversion-service erasure' '
--     DELETE FROM conversions.conversion_ledger_raw
--     WHERE occurred_at >= TIMESTAMP("2000-01-01")
--       AND user_id IN (SELECT user_id FROM conversions.erasure_requests
--                       WHERE requested_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 3 HOUR))'
-- (3 h: rows must have left the streaming buffer. Downstream models rebuilt from the raw table drop them too.)

-- 3. READ: latest ad-click-ids record per user (the body the Suite POSTs to /api/user/ad-click-ids, or the
--    extended superset edge-attribution writes), replicated from OpenArt's store. `record` must validate
--    against contracts click-id-store-record-extended.schema.json (rows that do not are ignored).
--    Retention: 100 days (a click older than the oa_ad_clids cookie's 90 days is never attached).
CREATE SCHEMA IF NOT EXISTS app OPTIONS (location = 'US');

CREATE TABLE IF NOT EXISTS app.ad_click_ids (
  user_id STRING NOT NULL,
  record JSON NOT NULL,
  received_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(received_at)
CLUSTER BY user_id
OPTIONS (partition_expiration_days = 100);

-- 4. READ: user context contract, an AUTHORIZED VIEW in its own restricted dataset (it holds raw email/phone).
--    The service is granted dataViewer on this view only (iam.yaml), never on the user-store dataset; authorize
--    the view on that dataset:  bq update --view ... / Console: dataset -> Sharing -> Authorize views.
--    The service reads exactly these 11 columns (no SELECT *) and hashes identifiers per platform in memory.
--    consent is a contracts Consent object: {ad_storage, ad_user_data, ad_personalization, analytics_storage,
--    region, source, gpc?, opt_out_sale_sharing?}; it is re-read right before every send, so a withdrawal,
--    Global Privacy Control or a US-state opt-out recorded here stops queued conversions.
-- CREATE SCHEMA IF NOT EXISTS conversion_context OPTIONS (location = 'US');
-- CREATE VIEW conversion_context.conversion_user_context AS
-- SELECT
--   u.id                     AS user_id,
--   u.email                  AS email,
--   u.phone                  AS phone,              -- E.164 or NULL
--   d.device_id              AS device_id,          -- oa_device_id / Amplitude device_id
--   c.consent                AS consent,            -- JSON (with gpc / opt_out_sale_sharing), NULL until a CMP exists
--   u.country_code           AS region,
--   s.client_ip_address, s.client_user_agent,      -- captured at signup / checkout POST
--   s.fbp, s.ttp, s.rdt_uuid,                       -- first-party cookies read by the backend
--   x.experiment_arms        AS experiment_arms,    -- JSON {flag_key: arm}
--   GREATEST(u.updated_at, s.updated_at) AS updated_at
-- FROM ...;

-- 5. READ: fct_purchase_value_score (built by packages/warehouse; contracts PurchaseValueScore). The ONLY source
--    of predicted ad values: E[gross_profit_90d | purchase], scored at purchase time from point-in-time features.
--    (fct_predicted_profit_24h is the unconditional per-exposed-user estimate for experiment readouts; the service
--    never reads it.) Expected shape, partitioned so the service's lookup (event_id + an occurred_at window) prunes:
-- CREATE TABLE marts.fct_purchase_value_score (
--   event_id STRING NOT NULL, invoice_id STRING, user_id STRING NOT NULL,
--   occurred_at TIMESTAMP NOT NULL, scored_at TIMESTAMP NOT NULL,
--   estimand STRING NOT NULL,            -- 'E[gross_profit_90d | purchase]'
--   horizon_days INT64 NOT NULL,         -- 90
--   predicted_revenue_90d FLOAT64, predicted_generation_cost_90d FLOAT64, predicted_fees_90d FLOAT64,
--   predicted_refund_risk FLOAT64, predicted_profit_90d FLOAT64, interval_low FLOAT64, interval_high FLOAT64,
--   cash_value FLOAT64, currency STRING, model_version STRING, run_id STRING, fitted_params_ref STRING,
--   features_snapshot JSON
-- ) PARTITION BY DATE(occurred_at) CLUSTER BY event_id OPTIONS (partition_expiration_days = 760);
--    Every row is validated with the contracts PurchaseValueScore validator (components add up, scored_at >=
--    occurred_at, no feature after the purchase) before it is used; a score counts only if scored within
--    VALUE_SCORE_SLA_MS of the purchase.
