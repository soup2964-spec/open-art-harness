{{
  config(
    partition_by={'field': 'exposure_date', 'data_type': 'date', 'granularity': 'day'} if target.type == 'bigquery' else none,
    cluster_by=['flag_key', 'arm'] if target.type == 'bigquery' else none
  )
}}
-- The bandit-allocator's native input (packages/bandit-allocator/src/warehouse.ts): one row per
-- (exposure_date, flag_key, arm, country_bucket, device, acquisition_channel, allocation_slice).
-- The FIRST 17 COLUMNS are exactly its EXPERIMENT_PROFIT_BY_ARM_COLUMNS, in order and with its
-- enums; point BigQueryRowSource at <project>.<dataset>_marts.fct_experiment_profit_by_arm_daily.
-- test/bandit-readout.test.ts validates every row with the allocator's own zod schema and checks
-- the SQL segments and holdout slice against its TypeScript functions.
--
-- ML review 6:
--   exposures are counted by FIRST exposure (intention to treat): exposure_date and arm are the
--     user's first; a user who later saw another arm stays here and is counted in contaminated_users
--   no post-treatment filtering: every non-QA exposure is a row member (scored or not)
--   logged propensities when a log exists (propensity_source; NULL sums otherwise)
--   realised outcomes over a FIXED 90-day horizon, matured users only (matured_users and the
--     sum_realised_* columns), never truncated at the as-of instant
-- ML review 8: p * V - C sums (a lower-variance reward: pooled V x per-arm mean p - per-arm mean C)
-- and CUPED-ready sums (covariate, its square, cross products with predicted and realised profit).
-- Stratification: the scored_paid_within_24h_* columns isolate early payers.
with users as (

    select * from {{ ref('int_experiment__user_readout') }}

)

select
    -- ------------------------------------------ bandit-allocator columns (warehouse.ts), in order
    exposure_date,
    flag_key,
    arm,
    country_bucket,
    device,
    acquisition_channel,
    allocation_slice,
    count(*) as exposed_users,
    sum(case when is_scored then 1 else 0 end) as scored_users,
    sum(case when is_scored and converted_in_conversion_window then 1 else 0 end) as converted_users,
    coalesce(sum(predicted_profit), 0) as sum_predicted_profit,
    coalesce(sum(predicted_profit * predicted_profit), 0) as sum_sq_predicted_profit,
    coalesce(sum(predicted_revenue), 0) as sum_predicted_revenue,
    coalesce(sum(predicted_generation_cost), 0) as sum_predicted_generation_cost,
    coalesce(sum(predicted_fees), 0) as sum_predicted_fees,
    coalesce(sum(predicted_refund_risk), 0) as sum_predicted_refund_risk,
    coalesce(max(model_version), '{{ var("pp_model_version") }}') as model_version,

    -- ------------------------------------------ additional columns (documented in README)
    sum(case when is_contaminated then 1 else 0 end) as contaminated_users,
    -- early payers (paid within 24h) as their own stratum
    sum(case when is_scored and paid_within_24h then 1 else 0 end) as scored_paid_within_24h_users,
    coalesce(sum(case when paid_within_24h then predicted_profit end), 0) as sum_predicted_profit_paid_within_24h,
    coalesce(sum(case when paid_within_24h then predicted_profit * predicted_profit end), 0) as sum_sq_predicted_profit_paid_within_24h,
    -- p * V - C: sum_predicted_profit = sum_expected_value_if_converted - sum_unconditional_cost
    coalesce(sum(p_convert), 0) as sum_p_convert,
    coalesce(sum(p_convert * p_convert), 0) as sum_sq_p_convert,
    coalesce(sum(expected_value_if_converted), 0) as sum_expected_value_if_converted,
    coalesce(sum(unconditional_cost), 0) as sum_unconditional_cost,
    -- logged assignment probabilities (NULL when propensity_source = 'unavailable')
    max(propensity_source) as propensity_source,
    sum(propensity) as sum_propensity,
    sum(1.0 / nullif(propensity, 0)) as sum_inverse_propensity,
    min(propensity) as min_propensity,
    -- CUPED-ready pre-exposure covariate (cross-fitted segment value) and cross products
    coalesce(sum(case when is_scored then cuped_covariate end), 0) as sum_cuped_covariate,
    coalesce(sum(case when is_scored then cuped_covariate * cuped_covariate end), 0) as sum_sq_cuped_covariate,
    coalesce(sum(cuped_covariate * predicted_profit), 0) as sum_cuped_covariate_x_predicted_profit,
    coalesce(sum(pre_exposure_amplitude_events), 0) as sum_pre_exposure_amplitude_events,
    -- realised, fixed 90-day horizon, matured users only
    sum(case when is_matured then 1 else 0 end) as matured_users,
    sum(case when realised_converted_90d then 1 else 0 end) as realised_converted_users_90d,
    coalesce(sum(realised_profit_90d), 0) as sum_realised_profit_90d,
    coalesce(sum(realised_profit_90d * realised_profit_90d), 0) as sum_sq_realised_profit_90d,
    coalesce(sum(realised_net_revenue_90d), 0) as sum_realised_net_revenue_90d,
    coalesce(sum(realised_generation_cost_90d), 0) as sum_realised_generation_cost_90d,
    coalesce(sum(realised_fees_90d), 0) as sum_realised_fees_90d,
    coalesce(sum(case when is_matured then cuped_covariate end), 0) as sum_cuped_covariate_matured,
    coalesce(sum(case when is_matured then cuped_covariate * cuped_covariate end), 0) as sum_sq_cuped_covariate_matured,
    coalesce(sum(cuped_covariate * realised_profit_90d), 0) as sum_cuped_covariate_x_realised_profit,
    -- the allocator's optional groups (warehouse.ts MATURED / GUARDRAIL / COVARIATE columns), same names:
    --   matured at this mart's fixed horizon (pp_horizon_days); value winsorized at bandit_value_cap_usd
    sum(case when realised_converted_90d then 1 else 0 end) as matured_converted_users,
    coalesce(sum(matured_value_capped), 0) as sum_matured_value,
    coalesce(sum(matured_value_capped * matured_value_capped), 0) as sum_sq_matured_value,
    coalesce(sum(realised_generation_cost_90d), 0) as sum_matured_cost,
    coalesce(sum(realised_generation_cost_90d * realised_generation_cost_90d), 0) as sum_sq_matured_cost,
    sum(case when realised_refunded_90d then 1 else 0 end) as matured_refunded_users,
    sum(case when is_scored and activated_24h then 1 else 0 end) as activated_users,
    coalesce(sum(case when is_scored then generations_started_24h end), 0) as generations_24h,
    coalesce(sum(case when is_scored then failed_generations_24h end), 0) as failed_generations_24h,
    coalesce(sum(case when is_scored then cuped_covariate end), 0) as sum_covariate,
    coalesce(sum(case when is_scored then cuped_covariate * cuped_covariate end), 0) as sum_sq_covariate,
    coalesce(sum(cuped_covariate * predicted_profit), 0) as sum_predicted_profit_x_covariate,
    -- model error of the 24h score on matured users (cross-fitted residuals)
    count(residual_90d) as residual_users,
    coalesce(sum(residual_90d), 0) as sum_residual_90d,
    coalesce(sum(residual_90d * residual_90d), 0) as sum_sq_residual_90d,
    max(fitted_params_ref) as fitted_params_ref
from users
group by exposure_date, flag_key, arm, country_bucket, device, acquisition_channel, allocation_slice
