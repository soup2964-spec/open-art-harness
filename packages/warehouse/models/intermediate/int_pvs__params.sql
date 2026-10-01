-- The other fitted inputs of the purchase value score, one row per FIT, each shrunk towards an
-- ILLUSTRATIVE prior (dbt_project.yml, dim_model_parameters) by empirical-Bayes pseudo-counts:
--   addon_revenue_per_month_usd   add-on + upgrade revenue per observed subscription month
--   plan_utilization              subscription credits burned / plan credits available (observed months)
--   burn_cv                       between-subscriber coefficient of variation of monthly burn (intervals)
--   pack_utilization              one-time-pack credits burned / pack credits bought
--   pack_future_revenue_usd       revenue in the 90 days after a pack, beyond the pack (complete windows)
--   pack_future_revenue_q90_usd   its 90th percentile (the interval's top), prior when < 10 packs
--   refund_rate_per_charge        refunds per charge (charges at least 30 days old)
--   chargeback_rate_per_charge    chargebacks per charge (idem)
{% set month_s = 30.4375 * 86400 %}

with fits as (

    select distinct fit_id from {{ ref('int_pp__fit_sets') }}

),

train as (

    select s.fit_id, f.*, o.is_horizon_complete, o.realized_revenue_90d
    from {{ ref('int_pp__fit_sets') }} as s
    inner join {{ ref('int_pvs__features') }} as f on f.user_id = s.user_id and not f.is_qa_account
    inner join {{ ref('int_pvs__outcomes') }} as o on o.event_id = f.event_id

),

subscription_months as (

    -- each first/renewal charge buys a period; count only the part already observed
    select
        fit_id,
        sum(months_observed) as months,
        sum(months_observed * plan_monthly_credits) as credit_capacity
    from (
        select
            fit_id,
            plan_monthly_credits,
            {{ least_of(
                "case when purchase_kind = 'annual' then 12.0 else 1.0 end",
                ts_diff_seconds(as_of_ts(), 'occurred_at') ~ ' / ' ~ month_s
            ) }} as months_observed
        from train
        where event_name in ('purchase_first', 'purchase_renewal')
          and purchase_kind in ('monthly', 'annual')
    ) as m
    group by fit_id

),

addons as (

    select fit_id, sum(revenue_reporting) as addon_revenue
    from train
    where event_name in ('purchase_add_on', 'purchase_upgrade')
    group by fit_id

),

fit_users as (

    select distinct s.fit_id, s.user_id
    from {{ ref('int_pp__fit_sets') }} as s

),

subscriber_burn as (

    select
        fu.fit_id,
        g.user_id,
        sum(case when g.credit_field in ('subscription_monthly_credit', 'subscription_sponsor_credit') then g.credits_costed else 0 end) as subscription_credits,
        sum(case when g.credit_field = 'one_time_pack_credit' then g.credits_costed else 0 end) as pack_credits_used
    from fit_users as fu
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = fu.user_id
       and not g.is_failed_generation
    group by fu.fit_id, g.user_id

),

subscriber_months as (

    select
        fit_id,
        user_id,
        sum({{ least_of(
            "case when purchase_kind = 'annual' then 12.0 else 1.0 end",
            ts_diff_seconds(as_of_ts(), 'occurred_at') ~ ' / ' ~ month_s
        ) }}) as months
    from train
    where event_name in ('purchase_first', 'purchase_renewal') and purchase_kind in ('monthly', 'annual')
    group by fit_id, user_id

),

burn_dispersion as (

    select
        sm.fit_id,
        count(*) as subscribers,
        avg(sb.subscription_credits / sm.months) as mean_monthly_burn,
        {{ stddev_samp('sb.subscription_credits / sm.months') }} as sd_monthly_burn,
        sum(sb.subscription_credits) as subscription_credits
    from subscriber_months as sm
    inner join subscriber_burn as sb on sb.fit_id = sm.fit_id and sb.user_id = sm.user_id
    where sm.months >= 1
    group by sm.fit_id

),

subscription_credits as (

    select sm.fit_id, sum(coalesce(sb.subscription_credits, 0)) as credits
    from subscriber_months as sm
    left join subscriber_burn as sb on sb.fit_id = sm.fit_id and sb.user_id = sm.user_id
    group by sm.fit_id

),

packs as (

    select
        t.fit_id,
        count(*) as packs,
        sum(t.pack_credits) as pack_credits_bought,
        sum(case when t.is_horizon_complete then 1 else 0 end) as matured_packs,
        sum(case when t.is_horizon_complete then t.realized_revenue_90d - t.revenue_reporting else 0 end) as future_revenue,
        {{ agg_quantile('case when t.is_horizon_complete then t.realized_revenue_90d - t.revenue_reporting end', 0.9) }} as future_revenue_q90
    from train as t
    where t.purchase_kind = 'pack'
    group by t.fit_id

),

pack_use as (

    select p.fit_id, sum(sb.pack_credits_used) as pack_credits_used
    from (select distinct fit_id, user_id from train where purchase_kind = 'pack') as p
    inner join subscriber_burn as sb on sb.fit_id = p.fit_id and sb.user_id = p.user_id
    group by p.fit_id

),

charge_outcomes as (

    select
        t.fit_id,
        count(*) as charges,
        sum(coalesce(r.refunds, 0)) as refunds,
        sum(coalesce(r.chargebacks, 0)) as chargebacks
    from train as t
    left join (
        select
            adjusts_event_id,
            sum(case when event_name = 'refund' then 1 else 0 end) as refunds,
            sum(case when event_name = 'chargeback' then 1 else 0 end) as chargebacks
        from {{ ref('fct_conversion_ledger') }}
        where event_name in ('refund', 'chargeback')
        group by adjusts_event_id
    ) as r on r.adjusts_event_id = t.event_id
    where {{ ts_add_seconds('t.occurred_at', 30 * 86400) }} <= {{ as_of_ts() }}
    group by t.fit_id

)

select
    f.fit_id,
    coalesce(sm.months, 0) as observed_subscription_months,
    round((coalesce(ad.addon_revenue, 0) + {{ var('pvs_addon_prior_strength_months') }} * {{ var('pvs_prior_addon_revenue_per_month_usd') }})
        / (coalesce(sm.months, 0) + {{ var('pvs_addon_prior_strength_months') }}), 9) as addon_revenue_per_month_usd,
    round((coalesce(sc.credits, 0) + {{ var('pvs_util_prior_strength_credits') }} * {{ var('pp_plan_utilization') }})
        / (coalesce(sm.credit_capacity, 0) + {{ var('pvs_util_prior_strength_credits') }}), 9) as plan_utilization,
    coalesce(bd.subscribers, 0) as burn_subscribers,
    round(case
        when coalesce(bd.subscribers, 0) >= 5 and bd.mean_monthly_burn > 0 then bd.sd_monthly_burn / bd.mean_monthly_burn
        else {{ var('pvs_prior_burn_cv') }}
    end, 9) as burn_cv,
    coalesce(pk.packs, 0) as packs,
    round((coalesce(pu.pack_credits_used, 0) + {{ var('pvs_util_prior_strength_credits') }} * {{ var('pp_plan_utilization') }})
        / (coalesce(pk.pack_credits_bought, 0) + {{ var('pvs_util_prior_strength_credits') }}), 9) as pack_utilization,
    coalesce(pk.matured_packs, 0) as matured_packs,
    round((coalesce(pk.future_revenue, 0) + {{ var('pvs_pack_prior_strength') }} * {{ var('pvs_prior_pack_future_revenue_usd') }})
        / (coalesce(pk.matured_packs, 0) + {{ var('pvs_pack_prior_strength') }}), 9) as pack_future_revenue_usd,
    round(case
        when coalesce(pk.matured_packs, 0) >= 10 then pk.future_revenue_q90
        else {{ var('pvs_prior_pack_future_revenue_q90_usd') }}
    end, 9) as pack_future_revenue_q90_usd,
    coalesce(co.charges, 0) as observed_charges,
    round((coalesce(co.refunds, 0) + {{ var('pvs_rate_prior_strength_charges') }} * {{ var('pp_refund_prob_per_charge') }})
        / (coalesce(co.charges, 0) + {{ var('pvs_rate_prior_strength_charges') }}), 9) as refund_rate_per_charge,
    round((coalesce(co.chargebacks, 0) + {{ var('pvs_rate_prior_strength_charges') }} * {{ var('pp_chargeback_prob_per_charge') }})
        / (coalesce(co.charges, 0) + {{ var('pvs_rate_prior_strength_charges') }}), 9) as chargeback_rate_per_charge
from fits as f
left join subscription_months as sm on sm.fit_id = f.fit_id
left join addons as ad on ad.fit_id = f.fit_id
left join subscription_credits as sc on sc.fit_id = f.fit_id
left join burn_dispersion as bd on bd.fit_id = f.fit_id
left join packs as pk on pk.fit_id = f.fit_id
left join pack_use as pu on pu.fit_id = f.fit_id
left join charge_outcomes as co on co.fit_id = f.fit_id
