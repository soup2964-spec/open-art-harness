{{
  config(
    materialized='incremental',
    incremental_strategy=append_only_strategy(),
    full_refresh=false,
    on_schema_change='append_new_columns',
    partition_by={'field': 'scored_at', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none
  )
}}
-- APPEND-ONLY record of the purchase values the warehouse served (ML review 3): every run appends
-- the scores of purchases it had not logged yet under the same model version, tagged with its
-- run_id and fitted_params_ref. A logged value is never rewritten, so the value a platform received
-- can always be reproduced: its features are in features_snapshot, its parameters are
-- dim_model_parameters where fitted_params_ref matches. full_refresh is disabled: this is a log.
select
    s.event_id,
    s.invoice_id,
    s.user_id,
    s.occurred_at,
    s.scored_at,
    s.estimand,
    s.horizon_days,
    s.predicted_revenue_90d,
    s.predicted_generation_cost_90d,
    s.predicted_fees_90d,
    s.predicted_refund_risk,
    s.predicted_profit_90d,
    s.interval_low,
    s.interval_high,
    s.cash_value,
    s.currency,
    s.model_version,
    s.run_id,
    s.fitted_params_ref,
    s.features_snapshot,
    s.platform_value,
    s.is_qa_account
from {{ ref('fct_purchase_value_score') }} as s
{% if openart_is_incremental() %}
where not exists (
    select 1 from {{ this }} as l
    where l.event_id = s.event_id
      and l.model_version = s.model_version
)
{% endif %}
