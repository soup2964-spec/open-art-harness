-- Every 24h score the warehouse computes, one row per (purpose, fit_id, user_id), from ONE
-- implementation (macros/openart/predicted_profit.sql pp_score_24h_ctes):
--   serve               every user with a complete 24h window, fit xf<cf_fold> (cross-fitted:
--                       the parameters never saw the user) -> fct_predicted_profit_24h
--   oot_test            out-of-time backtest: users of each test week, fit oot_<week> (learnt only
--                       from earlier signups) -> python_tests/oot_eval.py
--   oot_train_crossfit  the backtest's training users, fit oot_<week>_xf<cf_fold>: residuals for
--                       the backtest's own model-error variance
-- Main variant: signals-only (`sig`) unless var pp_use_arm_calibration is true (`cal`).
{%- set use_arm = var('pp_use_arm_calibration') in [true, 'true', 'True', 1] %}
{%- set main = 'cal' if use_arm else 'sig' %}

with features as (

    select * from {{ ref('fct_user_features_24h') }} where is_window_complete

),

oot as (

    select fit_id, test_week_start from {{ ref('int_pp__oot_weeks') }}

),

scoring_rows as (

    select 'serve' as purpose, 'xf' || cast(f.cf_fold as {{ dbt.type_string() }}) as fit_id, f.*
    from features as f

    union all

    select 'oot_test' as purpose, o.fit_id, f.*
    from features as f
    inner join oot as o on f.signup_week = o.test_week_start
    where not f.is_qa_account

    union all

    select 'oot_train_crossfit' as purpose, o.fit_id || '_xf' || cast(f.cf_fold as {{ dbt.type_string() }}), f.*
    from features as f
    inner join oot as o on f.signup_week < o.test_week_start
    where not f.is_qa_account

),

{{ pp_score_24h_ctes('scoring_rows') }}

select
    s.*,
    '{{ main }}' as main_variant,
    round(s.{{ main }}_p_convert, 6) as p_convert,
    s.{{ main }}_predicted_revenue as predicted_revenue,
    s.{{ main }}_predicted_generation_cost as predicted_generation_cost,
    s.{{ main }}_predicted_fees as predicted_fees,
    s.{{ main }}_predicted_refund_risk as predicted_refund_risk,
    round(s.{{ main }}_refund_probability, 6) as refund_probability,
    s.{{ main }}_predicted_profit as predicted_profit,
    round(coalesce(s.{{ main }}_charges, 0), 6) as expected_charges,
    round(coalesce(s.{{ main }}_paid_credits, 0), 3) as expected_paid_credits,
    -- p * V - C: value if the user converts (everything but the unconditional cost, per unit of p)
    case when s.{{ main }}_p_convert > 0 then round(
        (s.{{ main }}_predicted_profit + s.unconditional_cost) / s.{{ main }}_p_convert, 6
    ) end as value_if_converted
from pp_scored as s
