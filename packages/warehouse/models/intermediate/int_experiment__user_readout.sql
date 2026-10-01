-- One row per (user, flag) exposed to a default-model experiment: the unit both readouts aggregate
-- (fct_experiment_profit_by_arm per arm, fct_experiment_profit_by_arm_daily per day x segment x
-- slice for the bandit-allocator). ML review 6:
--   intention to treat  the arm is the FIRST-exposed arm; users who later saw another arm are KEPT
--                       in it and flagged (is_contaminated), never filtered after treatment
--   exposure_date       UTC date of the first exposure
--   segment             the bandit's segment from the user's earliest Amplitude row (known at signup,
--                       before the exposure) and the fixed holdout slice from the uid
--   propensity          the logged assignment probability at exposure (int_experiment__allocation_log),
--                       NULL when no log exists
--   realised outcome    FIXED horizon [first exposure, + pp_horizon_days), only for users whose horizon
--                       is complete (is_matured); never truncated at the as-of instant
--   prediction          the 24h score (cross-fitted) and its p * V - C decomposition
--   residual            realised - predicted for matured scored users: the model-error variance
--   cuped covariate     CUPAC-style pre-exposure covariate: the cross-fitted mean realised 90-day
--                       profit of matured users in the same segment (other folds), EB-shrunk
{% set horizon_s = var('pp_horizon_days') * 86400 %}
{% set maturity_s = var('pp_conversion_maturity_days') * 86400 %}

with exposures as (

    select
        x.user_id,
        x.flag_key,
        x.arm,
        x.first_exposed_at,
        x.n_distinct_arms,
        {{ ts_add_seconds('x.first_exposed_at', horizon_s) }} as horizon_end
    from {{ ref('fct_experiment_exposures') }} as x
    where not x.is_qa_account

),

purchases as (

    select user_id, event_id, event_name, occurred_at, cash_value_reporting, revenue_reporting
    from {{ ref('fct_conversion_ledger') }}
    where event_name like 'purchase%'

),

window_purchases as (

    select e.user_id, e.flag_key, e.horizon_end, p.event_id, p.event_name, p.occurred_at, p.cash_value_reporting, p.revenue_reporting
    from exposures as e
    inner join purchases as p
        on p.user_id = e.user_id
       and p.occurred_at >= e.first_exposed_at
       and p.occurred_at < e.horizon_end

),

realised_money as (

    select
        w.user_id,
        w.flag_key,
        min(case when w.event_name = 'purchase_first' then w.occurred_at end) as first_subscription_at,
        sum(w.revenue_reporting) as revenue_usd,
        sum(w.cash_value_reporting) as cash_usd,
        count(*) as charges
    from window_purchases as w
    group by w.user_id, w.flag_key

),

realised_adjustments as (

    select
        w.user_id,
        w.flag_key,
        sum(a.revenue_reporting) as adjustments_usd,
        sum(case when a.event_name = 'chargeback' then 1 else 0 end) as chargebacks,
        count(*) as adjustments
    from window_purchases as w
    inner join {{ ref('fct_conversion_ledger') }} as a
        on a.adjusts_event_id = w.event_id
       and a.event_name in ('refund', 'chargeback')
       and a.occurred_at < w.horizon_end
    group by w.user_id, w.flag_key

),

realised_cost as (

    select e.user_id, e.flag_key, sum(g.cost_usd) as generation_cost_usd
    from exposures as e
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = e.user_id
       and g.created_at >= e.first_exposed_at
       and g.created_at < e.horizon_end
    group by e.user_id, e.flag_key

),

pre_exposure_events as (

    select e.user_id, e.flag_key, count(*) as pre_exposure_amplitude_events
    from exposures as e
    inner join {{ ref('stg_amplitude__events') }} as a
        on a.user_id = e.user_id
       and a.event_time < e.first_exposed_at
       and {{ amplitude_history_filter('a') }}
    group by e.user_id, e.flag_key

),

segment_value as (

    -- cross-fitted mean realised profit per bandit segment: for fold k, from matured users of the
    -- other folds, shrunk to those users' overall mean (a pre-exposure covariate for CUPED)
    select
        f.held_out_fold,
        fs.segment_country_bucket,
        fs.segment_device,
        fs.segment_acquisition_channel,
        count(*) as segment_users,
        sum(o.realized_profit_90d) as segment_profit
    from {{ ref('int_pp__fit_sets') }} as f
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = f.user_id
    inner join {{ ref('int_amplitude__user_first_seen') }} as fs on fs.user_id = f.user_id
    where f.fit_kind = 'crossfit'
      and o.is_horizon_complete
    group by f.held_out_fold, fs.segment_country_bucket, fs.segment_device, fs.segment_acquisition_channel

),

fold_value as (

    select
        f.held_out_fold,
        avg(o.realized_profit_90d) as fold_mean_profit
    from {{ ref('int_pp__fit_sets') }} as f
    inner join {{ ref('int_pp__user_outcomes') }} as o on o.user_id = f.user_id
    where f.fit_kind = 'crossfit'
      and o.is_horizon_complete
    group by f.held_out_fold

),

base as (

    select
        e.user_id,
        e.flag_key,
        e.arm,
        e.first_exposed_at,
        cast(e.first_exposed_at as date) as exposure_date,
        e.n_distinct_arms > 1 as is_contaminated,
        e.horizon_end <= {{ as_of_ts() }} as is_matured,
        coalesce(fs.segment_country_bucket, 'unknown') as country_bucket,
        coalesce(fs.segment_device, 'unknown') as device,
        coalesce(fs.segment_acquisition_channel, 'unknown') as acquisition_channel,
        {{ allocation_slice('e.user_id') }} as allocation_slice,
        mod({{ hex_prefix_to_int(sha256_hex('e.user_id'), 4) }}, {{ var('pp_crossfit_folds') }}) as cf_fold,
        coalesce(pe.pre_exposure_amplitude_events, 0) as pre_exposure_amplitude_events,
        -- conversion (first subscription) inside the conversion window, as observed so far
        coalesce(rm.first_subscription_at < {{ ts_add_seconds('e.first_exposed_at', maturity_s) }}, false) as converted_in_conversion_window,
        coalesce(rm.first_subscription_at is not null, false) as converted_in_horizon,
        coalesce(rm.revenue_usd, 0) as realised_revenue_usd,
        coalesce(rm.cash_usd, 0) as realised_cash_usd,
        coalesce(rm.charges, 0) as realised_charges,
        coalesce(ra.adjustments_usd, 0) as realised_adjustments_usd,
        coalesce(ra.chargebacks, 0) as realised_chargebacks,
        coalesce(ra.adjustments, 0) > 0 as has_refund_or_chargeback,
        coalesce(rc.generation_cost_usd, 0) as realised_generation_cost_usd,
        coalesce(acq.acquisition_channel = 'affiliate', false) as is_affiliate
    from exposures as e
    left join {{ ref('int_amplitude__user_first_seen') }} as fs on fs.user_id = e.user_id
    left join realised_money as rm on rm.user_id = e.user_id and rm.flag_key = e.flag_key
    left join realised_adjustments as ra on ra.user_id = e.user_id and ra.flag_key = e.flag_key
    left join realised_cost as rc on rc.user_id = e.user_id and rc.flag_key = e.flag_key
    left join pre_exposure_events as pe on pe.user_id = e.user_id and pe.flag_key = e.flag_key
    left join {{ ref('int_user__acquisition') }} as acq on acq.user_id = e.user_id

),

with_money as (

    select
        b.*,
        round(
            b.realised_cash_usd * {{ var('payment_fee_pct') }}
            + b.realised_charges * {{ var('payment_fee_fixed_usd') }}
            + case when b.is_affiliate then b.realised_revenue_usd * {{ var('affiliate_commission_pct') }} else 0 end
            + b.realised_chargebacks * {{ var('dispute_fee_usd') }},
            6
        ) as realised_fees_usd
    from base as b

)

select
    m.user_id,
    m.flag_key,
    m.arm,
    m.first_exposed_at,
    m.exposure_date,
    m.is_contaminated,
    m.country_bucket,
    m.device,
    m.acquisition_channel,
    m.allocation_slice,
    m.cf_fold,
    al.assignment_probability as propensity,
    case when al.assignment_probability is not null then coalesce(al.data_origin, 'allocation_log') else 'unavailable' end as propensity_source,
    -- the 24h score (NULL until the 24h window closes)
    pp.user_id is not null as is_scored,
    coalesce(pp.paid_within_24h, false) as paid_within_24h,
    pp.predicted_profit,
    pp.predicted_revenue,
    pp.predicted_generation_cost,
    pp.predicted_fees,
    pp.predicted_refund_risk,
    pp.predicted_profit_24h_signals_only,
    pp.predicted_profit_with_arm_terms,
    pp.p_convert,
    pp.p_convert * pp.value_if_converted as expected_value_if_converted,
    pp.unconditional_cost,
    pp.model_version,
    pp.fitted_params_ref,
    m.converted_in_conversion_window,
    -- first subscription inside [exposure, + horizon), as observed so far (grows until matured)
    m.converted_in_horizon as converted_in_horizon_observed,
    -- realised, fixed horizon, matured users only
    m.is_matured,
    case when m.is_matured then m.converted_in_horizon end as realised_converted_90d,
    case when m.is_matured then m.realised_revenue_usd + m.realised_adjustments_usd end as realised_net_revenue_90d,
    case when m.is_matured then m.realised_generation_cost_usd end as realised_generation_cost_90d,
    case when m.is_matured then m.realised_fees_usd end as realised_fees_90d,
    case when m.is_matured then m.realised_adjustments_usd end as realised_adjustments_90d,
    case when m.is_matured then m.converted_in_horizon and m.has_refund_or_chargeback end as realised_refunded_90d,
    -- the allocator's "matured value" (bandit-allocator warehouse.ts): net value of a converter within
    -- the horizon (revenue + refunds - fees), winsorized at var bandit_value_cap_usd; 0 otherwise
    case when m.is_matured then
        case when m.converted_in_horizon
             then {{ least_of('m.realised_revenue_usd + m.realised_adjustments_usd - m.realised_fees_usd', var('bandit_value_cap_usd')) }}
             else 0 end
    end as matured_value_capped,
    case when m.is_matured
         then round(m.realised_revenue_usd + m.realised_adjustments_usd - m.realised_generation_cost_usd - m.realised_fees_usd, 6) end as realised_profit_90d,
    case when m.is_matured and pp.user_id is not null
         then round(m.realised_revenue_usd + m.realised_adjustments_usd - m.realised_generation_cost_usd - m.realised_fees_usd - pp.predicted_profit, 6) end as residual_90d,
    -- CUPED-ready pre-exposure covariates
    round(
        (coalesce(sv.segment_profit, 0) + {{ var('cuped_prior_strength_users') }} * fv.fold_mean_profit)
        / (coalesce(sv.segment_users, 0) + {{ var('cuped_prior_strength_users') }}),
        6
    ) as cuped_covariate,
    m.pre_exposure_amplitude_events,
    -- 24h guardrails (scored users)
    f.activated_24h,
    coalesce(f.generations_24h, 0) + coalesce(f.failed_generations_24h, 0) as generations_started_24h,
    coalesce(f.failed_generations_24h, 0) as failed_generations_24h
from with_money as m
left join {{ ref('fct_user_features_24h') }} as f on f.user_id = m.user_id
left join {{ ref('fct_predicted_profit_24h') }} as pp on pp.user_id = m.user_id
left join {{ ref('int_experiment__allocation_log') }} as al
    on al.flag_key = m.flag_key
   and al.arm = m.arm
   and al.allocation_slice = m.allocation_slice
   and al.valid_from <= m.exposure_date
   and (al.valid_to is null or m.exposure_date < al.valid_to)
left join segment_value as sv
    on sv.held_out_fold = m.cf_fold
   and sv.segment_country_bucket = m.country_bucket
   and sv.segment_device = m.device
   and sv.segment_acquisition_channel = m.acquisition_channel
left join fold_value as fv on fv.held_out_fold = m.cf_fold
