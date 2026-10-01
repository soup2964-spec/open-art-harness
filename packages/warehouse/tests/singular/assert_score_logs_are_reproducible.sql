-- ML review 3: every logged score can be traced to the exact parameters behind it, and a score
-- logged under the current parameter set equals what the current model computes.
--   1. every fitted_params_ref in a log exists in dim_model_parameters with FITTED rows
--   2. log rows written with the CURRENT ref equal fct_purchase_value_score / fct_predicted_profit_24h
with refs as (

    select fitted_params_ref, sum(case when label = 'FITTED' then 1 else 0 end) as fitted_rows
    from {{ ref('dim_model_parameters') }}
    group by fitted_params_ref

),

log_refs as (

    select 'fct_purchase_value_score_log' as log_name, fitted_params_ref from {{ ref('fct_purchase_value_score_log') }}
    union distinct
    select 'fct_predicted_profit_24h_log', fitted_params_ref from {{ ref('fct_predicted_profit_24h_log') }}

),

missing_refs as (

    select l.log_name, l.fitted_params_ref, cast(null as {{ dbt.type_string() }}) as row_key, 'ref not in dim_model_parameters (or no FITTED rows)' as violation
    from log_refs as l
    left join refs as r on r.fitted_params_ref = l.fitted_params_ref
    where r.fitted_params_ref is null or r.fitted_rows = 0

),

pvs_drift as (

    select 'fct_purchase_value_score_log', l.fitted_params_ref, l.event_id, 'logged value differs from the current score under the same ref'
    from {{ ref('fct_purchase_value_score_log') }} as l
    inner join {{ ref('fct_purchase_value_score') }} as s
        on s.event_id = l.event_id
       and s.fitted_params_ref = l.fitted_params_ref
       and s.model_version = l.model_version
    where abs(s.predicted_profit_90d - l.predicted_profit_90d) > 1e-6
       or abs(s.interval_low - l.interval_low) > 1e-6
       or abs(s.interval_high - l.interval_high) > 1e-6

),

pp_drift as (

    select 'fct_predicted_profit_24h_log', l.fitted_params_ref, l.user_id, 'logged value differs from the current score under the same ref'
    from {{ ref('fct_predicted_profit_24h_log') }} as l
    inner join {{ ref('fct_predicted_profit_24h') }} as s
        on s.user_id = l.user_id
       and s.fitted_params_ref = l.fitted_params_ref
       and s.model_version = l.model_version
    where abs(s.predicted_profit - l.predicted_profit) > 1e-6

)

select * from missing_refs
union all select * from pvs_drift
union all select * from pp_drift
