{{
  config(
    materialized='incremental',
    incremental_strategy=append_only_strategy(),
    full_refresh=false,
    on_schema_change='append_new_columns',
    partition_by={'field': 'computed_at', 'data_type': 'timestamp', 'granularity': 'day'} if target.type == 'bigquery' else none
  )
}}
-- APPEND-ONLY record of the 24h scores readouts used (ML review 3): each run appends the scores of
-- users it had not logged yet under the same model version, with run_id and fitted_params_ref
-- (dim_model_parameters). The contract columns come first, in PredictedProfit order.
select
    s.user_id,
    s.computed_at,
    s.horizon_days,
    s.feature_window_hours,
    s.currency,
    s.predicted_revenue,
    s.predicted_generation_cost,
    s.predicted_fees,
    s.predicted_refund_risk,
    s.refund_probability,
    s.predicted_profit,
    s.model_version,
    s.features,
    s.estimand,
    s.run_id,
    s.fitted_params_ref,
    {{ as_of_ts() }} as logged_as_of,
    s.is_qa_account
from {{ ref('fct_predicted_profit_24h') }} as s
{% if openart_is_incremental() %}
where not exists (
    select 1 from {{ this }} as l
    where l.user_id = s.user_id
      and l.model_version = s.model_version
)
{% endif %}
