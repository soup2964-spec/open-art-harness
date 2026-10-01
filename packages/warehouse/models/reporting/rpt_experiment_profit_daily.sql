{{ config(materialized='view') }}
-- BI view (aggregate only): the bandit's daily mart without its segment columns.
select
    exposure_date,
    flag_key,
    arm,
    allocation_slice,
    sum(exposed_users) as exposed_users,
    sum(scored_users) as scored_users,
    sum(converted_users) as converted_users,
    sum(contaminated_users) as contaminated_users,
    sum(matured_users) as matured_users,
    {{ safe_divide('sum(sum_predicted_profit)', 'sum(scored_users)') }} as predicted_profit_per_scored_usd,
    {{ safe_divide('sum(sum_realised_profit_90d)', 'sum(matured_users)') }} as realised_profit_per_matured_usd,
    max(model_version) as model_version
from {{ ref('fct_experiment_profit_by_arm_daily') }}
group by exposure_date, flag_key, arm, allocation_slice
