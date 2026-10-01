-- Default-model experiment readout: one row per (flag, arm). The same user-level rows
-- (int_experiment__user_readout) feed the bandit's daily mart (fct_experiment_profit_by_arm_daily).
--
-- Population (ML review 6): every first exposure, excluding QA accounts. Intention to treat: users
-- who later saw another arm stay in their first arm (contaminated_users counts them).
-- Realised profit (ML review 6): FIXED 90-day horizon from the first exposure, over MATURED users
-- only (horizon complete at as-of). Truncating growing arms at as-of biased them; this does not.
--   realised profit = tax-exclusive revenue + refunds/chargebacks (negative) - serving cost
--                     - payment, affiliate and dispute fees (reporting currency)
-- Predicted profit = fct_predicted_profit_24h (unconditional, scored at signup + 24h, cross-fitted).
-- Uncertainty (ML review 5), all 95% (ci_z):
--   predicted_profit_sampling_ci_*    predictions treated as independent draws (the old interval;
--                                     kept for exact sufficient-statistic recovery)
--   predicted_profit_ci_*             + model error: the variance of cross-fitted residuals
--                                     (realised - predicted) of the arm's matured users / their count
--                                     (the flag's pooled residual variance below
--                                     readout_min_matured_for_arm_error users)
--   predicted_profit_stratified_*     post-stratified on paid-within-24h (a few early payers carry
--                                     most of the variance), stratum weights pooled over the flag
--   ppi_profit_*                      prediction-powered estimate: mean prediction + mean residual of
--                                     matured users (bias-corrected), var = var(pred)/n + var(resid)/m
--   ppi_bootstrap_ci_*                percentile CI of the PPI estimate from a Poisson bootstrap
--                                     (var readout_bootstrap_replicates; NULL when off)
-- Decomposition (ML review 8): predicted profit = p * V - C per arm (mean_p_convert,
-- value_if_converted_usd, unconditional_cost_per_exposed_usd); V pooled over arms is the
-- lower-variance reward the bandit can use. realised_profit_cuped_* adjusts the realised mean with
-- the pre-exposure covariate (theta pooled within the flag).
{%- set z = var('ci_z') %}
{%- set min_m = var('readout_min_matured_for_arm_error') %}
{%- set b_var = var('readout_bootstrap_replicates', none) %}
{%- set b = (b_var | int) if b_var is not none else (200 if is_fixture_mode() else 0) %}

with users as (

    select * from {{ ref('int_experiment__user_readout') }}

),

strata_weights as (

    select
        flag_key,
        avg(case when paid_within_24h then 1.0 else 0.0 end) as w_paid_24h
    from users
    where is_scored
    group by flag_key

),

pooled_residuals as (

    select flag_key, var_samp(residual_90d) as residual_var_pooled, count(residual_90d) as residual_users_pooled
    from users
    group by flag_key

),

cuped_theta as (

    -- theta = cov(X, Y) / var(X) over matured users of the flag (all arms): the CUPED coefficient
    select
        flag_key,
        avg(cuped_covariate) as covariate_mean_matured,
        {{ safe_divide(
            'avg(cuped_covariate * realised_profit_90d) - avg(cuped_covariate) * avg(realised_profit_90d)',
            'avg(cuped_covariate * cuped_covariate) - avg(cuped_covariate) * avg(cuped_covariate)'
        ) }} as theta
    from users
    where is_matured
    group by flag_key

),

per_arm as (

    select
        flag_key,
        arm,
        count(*) as exposed_users,
        sum(case when is_contaminated then 1 else 0 end) as contaminated_users,
        sum(case when converted_in_horizon_observed then 1 else 0 end) as converters,
        avg(case when converted_in_horizon_observed then 1.0 else 0.0 end) as conversion_rate,
        -- realised, matured only
        sum(case when is_matured then 1 else 0 end) as matured_users,
        avg(case when realised_converted_90d then 1.0 when is_matured then 0.0 end) as realised_conversion_rate_90d,
        avg(realised_net_revenue_90d) as revenue_per_exposed_usd,
        {{ stddev_samp('realised_net_revenue_90d') }} as revenue_sd,
        avg(realised_generation_cost_90d) as generation_cost_per_exposed_usd,
        {{ stddev_samp('realised_generation_cost_90d') }} as generation_cost_sd,
        avg(realised_fees_90d) as fees_per_exposed_usd,
        avg(realised_profit_90d) as realised_profit_per_exposed_usd,
        {{ stddev_samp('realised_profit_90d') }} as realised_profit_sd,
        avg(case when is_matured then cuped_covariate end) as covariate_mean_arm_matured,
        -- predicted
        sum(case when is_scored then 1 else 0 end) as scored_users,
        avg(predicted_profit) as predicted_profit_per_exposed_usd,
        {{ stddev_samp('predicted_profit') }} as predicted_profit_sd,
        avg(predicted_revenue) as predicted_revenue_per_exposed_usd,
        avg(predicted_generation_cost) as predicted_generation_cost_per_exposed_usd,
        avg(predicted_fees) as predicted_fees_per_exposed_usd,
        avg(predicted_refund_risk) as predicted_refund_risk_per_exposed_usd,
        avg(predicted_profit_24h_signals_only) as predicted_profit_24h_signals_only_per_exposed_usd,
        avg(predicted_profit_with_arm_terms) as predicted_profit_with_arm_terms_per_exposed_usd,
        -- p * V - C
        avg(p_convert) as mean_p_convert,
        {{ safe_divide('sum(expected_value_if_converted)', 'sum(p_convert)') }} as value_if_converted_usd,
        avg(unconditional_cost) as unconditional_cost_per_exposed_usd,
        -- model error from cross-fitted matured residuals
        count(residual_90d) as residual_users,
        avg(residual_90d) as model_bias_usd,
        var_samp(residual_90d) as residual_var_arm,
        -- strata (early payers)
        sum(case when is_scored and paid_within_24h then 1 else 0 end) as n_paid_24h,
        sum(case when is_scored and not paid_within_24h then 1 else 0 end) as n_not_paid_24h,
        avg(case when paid_within_24h then predicted_profit end) as mean_paid_24h,
        avg(case when is_scored and not paid_within_24h then predicted_profit end) as mean_not_paid_24h,
        var_samp(case when paid_within_24h then predicted_profit end) as var_paid_24h,
        var_samp(case when is_scored and not paid_within_24h then predicted_profit end) as var_not_paid_24h,
        avg(cuped_covariate) as cuped_covariate_mean,
        min(propensity) as min_propensity,
        max(propensity_source) as propensity_source
    from users
    group by flag_key, arm

),

{% if b > 0 %}
digits as (

    select 0 as d union all select 1 union all select 2 union all select 3 union all select 4
    union all select 5 union all select 6 union all select 7 union all select 8 union all select 9

),

replicates as (

    select a.d + 10 * b.d + 100 * c.d as replicate
    from digits as a cross join digits as b cross join digits as c
    where a.d + 10 * b.d + 100 * c.d < {{ b }}

),

draws as (

    -- a deterministic, engine-independent uniform per (user, flag, replicate)
    select
        u.flag_key,
        u.arm,
        r.replicate,
        u.predicted_profit,
        u.residual_90d,
        {{ uniform_from_key("u.user_id || ':' || u.flag_key || ':' || cast(r.replicate as " ~ dbt.type_string() ~ ")") }} as uni
    from users as u
    cross join replicates as r
    where u.is_scored

),

weighted as (

    -- Poisson(1) bootstrap weights (inverse CDF)
    select
        d.*,
        case
            when d.uni < 0.367879 then 0
            when d.uni < 0.735759 then 1
            when d.uni < 0.919699 then 2
            when d.uni < 0.981012 then 3
            when d.uni < 0.996340 then 4
            when d.uni < 0.999406 then 5
            else 6
        end as weight
    from draws as d

),

replicate_estimates as (

    select
        flag_key,
        arm,
        replicate,
        {{ safe_divide('sum(weight * predicted_profit)', 'sum(weight)') }}
          + coalesce({{ safe_divide('sum(case when residual_90d is not null then weight * residual_90d end)', 'sum(case when residual_90d is not null then weight end)') }}, 0) as ppi_estimate
    from weighted
    group by flag_key, arm, replicate

),

bootstrap as (

    select
        flag_key,
        arm,
        {{ agg_quantile('ppi_estimate', 0.025) }} as ppi_bootstrap_ci_low,
        {{ agg_quantile('ppi_estimate', 0.975) }} as ppi_bootstrap_ci_high
    from replicate_estimates
    group by flag_key, arm

),
{% endif %}

with_ci as (

    select
        a.*,
        sw.w_paid_24h,
        -- model-error variance of the arm's mean: its own residuals, or the flag's pooled ones
        case when a.residual_users >= {{ min_m }} then a.residual_var_arm / a.residual_users
             when pr.residual_users_pooled > 1 then pr.residual_var_pooled / pr.residual_users_pooled
        end as model_error_var_of_mean,
        a.conversion_rate - {{ z }} * sqrt(a.conversion_rate * (1 - a.conversion_rate) / a.exposed_users) as conversion_rate_ci_low,
        a.conversion_rate + {{ z }} * sqrt(a.conversion_rate * (1 - a.conversion_rate) / a.exposed_users) as conversion_rate_ci_high,
        a.revenue_per_exposed_usd - {{ z }} * a.revenue_sd / sqrt(nullif(a.matured_users, 0)) as revenue_ci_low,
        a.revenue_per_exposed_usd + {{ z }} * a.revenue_sd / sqrt(nullif(a.matured_users, 0)) as revenue_ci_high,
        a.generation_cost_per_exposed_usd - {{ z }} * a.generation_cost_sd / sqrt(nullif(a.matured_users, 0)) as generation_cost_ci_low,
        a.generation_cost_per_exposed_usd + {{ z }} * a.generation_cost_sd / sqrt(nullif(a.matured_users, 0)) as generation_cost_ci_high,
        a.realised_profit_per_exposed_usd - {{ z }} * a.realised_profit_sd / sqrt(nullif(a.matured_users, 0)) as realised_profit_ci_low,
        a.realised_profit_per_exposed_usd + {{ z }} * a.realised_profit_sd / sqrt(nullif(a.matured_users, 0)) as realised_profit_ci_high,
        a.predicted_profit_per_exposed_usd - {{ z }} * a.predicted_profit_sd / sqrt(nullif(a.scored_users, 0)) as predicted_profit_sampling_ci_low,
        a.predicted_profit_per_exposed_usd + {{ z }} * a.predicted_profit_sd / sqrt(nullif(a.scored_users, 0)) as predicted_profit_sampling_ci_high,
        -- post-stratified mean: the flag's stratum weights applied to the arm's stratum means
        case when a.n_paid_24h > 0 and a.n_not_paid_24h > 0
             then sw.w_paid_24h * a.mean_paid_24h + (1 - sw.w_paid_24h) * a.mean_not_paid_24h
             else a.predicted_profit_per_exposed_usd
        end as predicted_profit_stratified_per_exposed_usd,
        case when a.n_paid_24h > 0 and a.n_not_paid_24h > 0
             then sw.w_paid_24h * sw.w_paid_24h * coalesce(a.var_paid_24h, 0) / a.n_paid_24h
                  + (1 - sw.w_paid_24h) * (1 - sw.w_paid_24h) * coalesce(a.var_not_paid_24h, 0) / a.n_not_paid_24h
             else a.predicted_profit_sd * a.predicted_profit_sd / nullif(a.scored_users, 0)
        end as stratified_sampling_var,
        (a.realised_profit_per_exposed_usd - ct.theta * (a.covariate_mean_arm_matured - ct.covariate_mean_matured)) as realised_profit_cuped_per_exposed_usd,
        ct.theta as cuped_theta
    from per_arm as a
    left join strata_weights as sw on sw.flag_key = a.flag_key
    left join pooled_residuals as pr on pr.flag_key = a.flag_key
    left join cuped_theta as ct on ct.flag_key = a.flag_key

),

ranked as (

    select
        w.*,
        w.predicted_profit_per_exposed_usd
            - {{ z }} * sqrt(coalesce(w.predicted_profit_sd * w.predicted_profit_sd / nullif(w.scored_users, 0), 0) + coalesce(w.model_error_var_of_mean, 0)) as predicted_profit_ci_low,
        w.predicted_profit_per_exposed_usd
            + {{ z }} * sqrt(coalesce(w.predicted_profit_sd * w.predicted_profit_sd / nullif(w.scored_users, 0), 0) + coalesce(w.model_error_var_of_mean, 0)) as predicted_profit_ci_high,
        w.predicted_profit_stratified_per_exposed_usd - {{ z }} * sqrt(coalesce(w.stratified_sampling_var, 0) + coalesce(w.model_error_var_of_mean, 0)) as predicted_profit_stratified_ci_low,
        w.predicted_profit_stratified_per_exposed_usd + {{ z }} * sqrt(coalesce(w.stratified_sampling_var, 0) + coalesce(w.model_error_var_of_mean, 0)) as predicted_profit_stratified_ci_high,
        w.predicted_profit_per_exposed_usd + coalesce(w.model_bias_usd, 0) as ppi_profit_per_exposed_usd,
        rank() over (partition by w.flag_key order by w.conversion_rate desc) as conversion_rank,
        rank() over (partition by w.flag_key order by w.predicted_profit_per_exposed_usd desc) as predicted_profit_rank,
        rank() over (partition by w.flag_key order by w.realised_profit_per_exposed_usd desc) as realised_profit_rank
    from with_ci as w

),

conversion_winner as (

    select flag_key, max(predicted_profit_per_exposed_usd) as winner_predicted_profit_per_exposed_usd
    from ranked
    where conversion_rank = 1
    group by flag_key

),

profit_winner as (

    select flag_key, max(predicted_profit_per_exposed_usd) as best_predicted_profit_per_exposed_usd
    from ranked
    where predicted_profit_rank = 1
    group by flag_key

)

select
    w.flag_key,
    w.arm,
    w.exposed_users,
    w.contaminated_users,
    w.converters,
    round(w.conversion_rate, 6) as conversion_rate,
    round(w.conversion_rate_ci_low, 6) as conversion_rate_ci_low,
    round(w.conversion_rate_ci_high, 6) as conversion_rate_ci_high,
    -- realised (matured users, fixed 90-day horizon)
    w.matured_users,
    round(w.matured_users * 1.0 / w.exposed_users, 4) as share_matured,
    round(w.realised_conversion_rate_90d, 6) as realised_conversion_rate_90d,
    round(w.revenue_per_exposed_usd, 6) as revenue_per_exposed_usd,
    round(w.revenue_ci_low, 6) as revenue_ci_low,
    round(w.revenue_ci_high, 6) as revenue_ci_high,
    round(w.generation_cost_per_exposed_usd, 6) as generation_cost_per_exposed_usd,
    round(w.generation_cost_ci_low, 6) as generation_cost_ci_low,
    round(w.generation_cost_ci_high, 6) as generation_cost_ci_high,
    round(w.fees_per_exposed_usd, 6) as fees_per_exposed_usd,
    round(w.realised_profit_per_exposed_usd, 6) as realised_profit_per_exposed_usd,
    round(w.realised_profit_ci_low, 6) as realised_profit_ci_low,
    round(w.realised_profit_ci_high, 6) as realised_profit_ci_high,
    round(w.realised_profit_cuped_per_exposed_usd, 6) as realised_profit_cuped_per_exposed_usd,
    round(w.cuped_theta, 6) as cuped_theta,
    round(w.cuped_covariate_mean, 6) as cuped_covariate_mean,
    -- predicted (every scored exposed user)
    w.scored_users,
    round(w.predicted_profit_per_exposed_usd, 6) as predicted_profit_per_exposed_usd,
    round(w.predicted_profit_sd, 6) as predicted_profit_sd,
    round(w.predicted_profit_ci_low, 6) as predicted_profit_ci_low,
    round(w.predicted_profit_ci_high, 6) as predicted_profit_ci_high,
    round(w.predicted_profit_sampling_ci_low, 6) as predicted_profit_sampling_ci_low,
    round(w.predicted_profit_sampling_ci_high, 6) as predicted_profit_sampling_ci_high,
    round(w.predicted_profit_stratified_per_exposed_usd, 6) as predicted_profit_stratified_per_exposed_usd,
    round(w.predicted_profit_stratified_ci_low, 6) as predicted_profit_stratified_ci_low,
    round(w.predicted_profit_stratified_ci_high, 6) as predicted_profit_stratified_ci_high,
    w.residual_users,
    round(w.model_bias_usd, 6) as model_bias_usd,
    round(sqrt(w.model_error_var_of_mean), 6) as model_error_se_usd,
    round(w.ppi_profit_per_exposed_usd, 6) as ppi_profit_per_exposed_usd,
    round(w.ppi_profit_per_exposed_usd - {{ z }} * sqrt(coalesce(w.predicted_profit_sd * w.predicted_profit_sd / nullif(w.scored_users, 0), 0) + coalesce(w.model_error_var_of_mean, 0)), 6) as ppi_profit_ci_low,
    round(w.ppi_profit_per_exposed_usd + {{ z }} * sqrt(coalesce(w.predicted_profit_sd * w.predicted_profit_sd / nullif(w.scored_users, 0), 0) + coalesce(w.model_error_var_of_mean, 0)), 6) as ppi_profit_ci_high,
    {% if b > 0 -%}
    round(bs.ppi_bootstrap_ci_low, 6) as ppi_bootstrap_ci_low,
    round(bs.ppi_bootstrap_ci_high, 6) as ppi_bootstrap_ci_high,
    {%- else -%}
    cast(null as {{ type_double() }}) as ppi_bootstrap_ci_low,
    cast(null as {{ type_double() }}) as ppi_bootstrap_ci_high,
    {%- endif %}
    {{ b }} as bootstrap_replicates,
    round(w.predicted_revenue_per_exposed_usd, 6) as predicted_revenue_per_exposed_usd,
    round(w.predicted_generation_cost_per_exposed_usd, 6) as predicted_generation_cost_per_exposed_usd,
    round(w.predicted_fees_per_exposed_usd, 6) as predicted_fees_per_exposed_usd,
    round(w.predicted_refund_risk_per_exposed_usd, 6) as predicted_refund_risk_per_exposed_usd,
    round(w.predicted_profit_24h_signals_only_per_exposed_usd, 6) as predicted_profit_24h_signals_only_per_exposed_usd,
    round(w.predicted_profit_with_arm_terms_per_exposed_usd, 6) as predicted_profit_with_arm_terms_per_exposed_usd,
    -- p * V - C
    round(w.mean_p_convert, 6) as mean_p_convert,
    round(w.value_if_converted_usd, 6) as value_if_converted_usd,
    round(w.unconditional_cost_per_exposed_usd, 6) as unconditional_cost_per_exposed_usd,
    round(w.w_paid_24h, 6) as flag_share_paid_within_24h,
    w.n_paid_24h as scored_paid_within_24h_users,
    w.min_propensity,
    w.propensity_source,
    -- conversion-only vs profit ranking
    w.conversion_rank,
    w.predicted_profit_rank,
    w.realised_profit_rank,
    w.conversion_rank = 1 as is_conversion_winner,
    w.predicted_profit_rank = 1 as is_predicted_profit_winner,
    w.conversion_rank = w.predicted_profit_rank as conversion_and_profit_rank_agree,
    -- predicted profit per exposed user given up by shipping the conversion winner instead of this arm
    round(w.predicted_profit_per_exposed_usd - cw.winner_predicted_profit_per_exposed_usd, 6) as predicted_profit_vs_conversion_winner_usd,
    round(pw.best_predicted_profit_per_exposed_usd - cw.winner_predicted_profit_per_exposed_usd, 6) as profit_left_by_conversion_ranking_usd
from ranked as w
left join conversion_winner as cw on cw.flag_key = w.flag_key
left join profit_winner as pw on pw.flag_key = w.flag_key
{% if b > 0 %}left join bootstrap as bs on bs.flag_key = w.flag_key and bs.arm = w.arm{% endif %}
