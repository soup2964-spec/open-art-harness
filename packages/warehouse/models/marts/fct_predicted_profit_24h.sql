-- ESTIMAND: unconditional E[90-day contribution profit per exposed user], scored at signup + 24h.
-- USE: experiment and bandit readouts ONLY (fct_experiment_profit_by_arm, _daily). It is NOT an
-- ad value: for a user who buys on day 9 it is p x value at 24h, far below what that purchase is
-- worth. Ad-platform values come from fct_purchase_value_score (E[90d gross profit | purchase],
-- scored at the purchase). This mart therefore carries no platform value column.
--
-- Conforms to the PredictedProfit contract (packages/contracts/src/schemas/predicted-profit.schema.json):
-- the first 13 columns are the contract's; the rest are warehouse-only.
--   predicted_profit = predicted_revenue - predicted_generation_cost - predicted_fees - predicted_refund_risk
--                    = p_convert * value_if_converted - unconditional_cost        (ML review 8)
-- v0 is a TRANSPARENT estimator (int_pp__scores / macros/openart/predicted_profit.sql): segment
-- conversion rates, converter value and MEASURED serving cost per credit per arm, all empirical-
-- Bayes shrunk towards ILLUSTRATIVE priors (dim_model_parameters), fit with cross-fitting: a user
-- in fold k is scored with parameters fit on the other folds (fit_id xf<k>).
-- Signals-only by default (var pp_use_arm_calibration = false): no arm conversion/value
-- multipliers. predicted_profit_with_arm_terms shows the EB-shrunk, cross-fitted arm variant.
-- Accuracy: see python_tests/oot_eval.py (out-of-time backtest), not the in-sample plumbing check.
--
-- Swap-in interface: set var predicted_profit_source = 'external_scores' and write a trained
-- model's scores (same contract columns) to source('ml', 'predicted_profit_scores').

{% set use_arm = var('pp_use_arm_calibration') in [true, 'true', 'True', 1] %}

{% if var('predicted_profit_source') == 'external_scores' %}

select
    s.user_id,
    s.computed_at,
    {{ var('pp_horizon_days') }} as horizon_days,
    24 as feature_window_hours,
    'USD' as currency,
    s.predicted_revenue,
    s.predicted_generation_cost,
    s.predicted_fees,
    s.predicted_refund_risk,
    s.refund_probability,
    s.predicted_profit,
    s.model_version,
    s.features,
    'unconditional E[90d profit per exposed user]' as estimand,
    'experiment_and_bandit_readouts_only' as intended_use,
    cast(null as {{ type_double() }}) as predicted_profit_24h_signals_only,
    cast(null as {{ type_double() }}) as predicted_profit_with_arm_terms,
    cast(null as {{ type_double() }}) as p_convert,
    cast(null as {{ type_double() }}) as value_if_converted,
    cast(null as {{ type_double() }}) as unconditional_cost,
    cast(null as {{ dbt.type_string() }}) as segment,
    cast(null as {{ type_double() }}) as conversion_multiplier,
    cast(null as {{ type_double() }}) as value_multiplier,
    cast(null as {{ type_double() }}) as expected_charges,
    cast(null as {{ type_double() }}) as expected_paid_credits,
    cast(null as {{ type_double() }}) as cost_per_credit_mix_usd,
    f.generation_cost_24h_usd as realised_generation_cost_24h_usd,
    f.paid_within_24h,
    f.acquisition_channel,
    f.arm_create_image,
    f.arm_create_video,
    f.signup_at,
    f.cf_fold,
    cast(null as {{ dbt.type_string() }}) as fit_id,
    cast(null as {{ dbt.type_string() }}) as fitted_params_ref,
    '{{ invocation_id }}' as run_id,
    f.is_qa_account
from {{ source('ml', 'predicted_profit_scores') }} as s
inner join {{ ref('fct_user_features_24h') }} as f on f.user_id = s.user_id

{% else %}

select
    s.user_id,
    s.feature_window_end as computed_at,
    {{ var('pp_horizon_days') }} as horizon_days,
    24 as feature_window_hours,
    'USD' as currency,
    s.predicted_revenue,
    s.predicted_generation_cost,
    s.predicted_fees,
    s.predicted_refund_risk,
    s.refund_probability,
    s.predicted_profit,
    '{{ var("pp_model_version") }}{{ "+arm" if use_arm else "" }}@' || cast(cast({{ as_of_ts() }} as date) as {{ dbt.type_string() }}) as model_version,
    json_object(
        'segment', s.segment,
        'plan_tier', s.plan_tier,
        'billing_interval', s.billing_interval,
        'arm_create_image', s.arm_create_image,
        'arm_create_video', s.arm_create_video,
        'generations_24h', s.generations_24h,
        'video_generations_24h', s.video_generations_24h,
        'credits_consumed_24h', s.credits_consumed_24h,
        'generation_cost_24h_usd', s.generation_cost_24h_usd,
        'trial_depleted_24h', s.trial_depleted_24h,
        'paid_within_24h', s.paid_within_24h,
        'first_purchase_value_usd', s.first_purchase_value_usd,
        'acquisition_channel', s.acquisition_channel,
        'country_code', s.country_code,
        'device_class', s.device_class,
        'p_convert', s.p_convert,
        'conversion_multiplier', round(s.conversion_multiplier, 6),
        'value_multiplier', round(s.value_multiplier, 6),
        'cost_per_credit_mix_usd', round(s.cost_per_credit_mix_usd, 8),
        'fit_id', s.fit_id
    ) as features,

    -- ------------------------------------------------ warehouse-only columns
    'unconditional E[90d profit per exposed user]' as estimand,
    'experiment_and_bandit_readouts_only' as intended_use,
    -- the same estimator without the arm terms (= predicted_profit by default) and with them
    s.sig_predicted_profit as predicted_profit_24h_signals_only,
    s.cal_predicted_profit as predicted_profit_with_arm_terms,
    -- predicted_profit = p_convert * value_if_converted - unconditional_cost
    s.p_convert,
    s.value_if_converted,
    s.unconditional_cost,
    s.segment,
    round(s.conversion_multiplier, 6) as conversion_multiplier,
    round(s.value_multiplier, 6) as value_multiplier,
    s.expected_charges,
    s.expected_paid_credits,
    round(s.cost_per_credit_mix_usd, 8) as cost_per_credit_mix_usd,
    s.generation_cost_24h_usd as realised_generation_cost_24h_usd,
    s.paid_within_24h,
    s.acquisition_channel,
    s.arm_create_image,
    s.arm_create_video,
    s.signup_at,
    s.cf_fold,
    s.fit_id,
    (select max(fitted_params_ref) from {{ ref('int_model_parameters__current') }}) as fitted_params_ref,
    '{{ invocation_id }}' as run_id,
    s.is_qa_account
from {{ ref('int_pp__scores') }} as s
where s.purpose = 'serve'

{% endif %}
