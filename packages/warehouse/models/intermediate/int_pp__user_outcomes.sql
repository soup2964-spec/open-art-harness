-- Realised outcomes of users old enough to learn from (non-QA users with a complete 24h window),
-- over the fixed horizon [signup, signup + pp_horizon_days). Feeds the fits of the 24h score
-- (int_pp__fit_sets), its cross-fitted residuals (model-error variance) and the backtest.
--   realized_profit_90d = tax-exclusive revenue - refunds/chargebacks - serving cost - payment,
--                         affiliate and dispute fees, in the reporting currency
-- Only meaningful where is_horizon_complete; for other users it is a partial sum (never used
-- as an outcome).
{% set horizon_s = var('pp_horizon_days') * 86400 %}
{% set maturity_s = var('pp_conversion_maturity_days') * 86400 %}

with features as (

    select
        f.*,
        {{ pp_segment('f') }} as segment,
        {{ ts_add_seconds('f.signup_at', maturity_s) }} as maturity_end,
        {{ ts_add_seconds('f.signup_at', horizon_s) }} as horizon_end
    from {{ ref('fct_user_features_24h') }} as f
    where f.is_window_complete
      and not f.is_qa_account

),

purchases as (

    select user_id, event_id, event_name, occurred_at, cash_value_reporting, revenue_reporting
    from {{ ref('fct_conversion_ledger') }}
    where event_name like 'purchase%'

),

first_subscription as (

    select user_id, first_subscription_at, first_subscription_cash_usd
    from (
        select
            user_id,
            occurred_at as first_subscription_at,
            revenue_reporting as first_subscription_cash_usd,
            row_number() over (partition by user_id order by occurred_at, event_id) as purchase_rank
        from purchases
        where event_name = 'purchase_first'
    ) as ranked
    where purchase_rank = 1

),

horizon_purchases as (

    select
        f.user_id,
        p.event_id,
        p.cash_value_reporting,
        p.revenue_reporting
    from features as f
    inner join purchases as p
        on p.user_id = f.user_id
       and p.occurred_at >= f.signup_at
       and p.occurred_at < f.horizon_end

),

horizon_adjustments as (

    select
        hp.user_id,
        sum(a.revenue_reporting) as adjustments_usd,
        sum(case when a.event_name = 'chargeback' then 1 else 0 end) as chargebacks
    from horizon_purchases as hp
    inner join {{ ref('fct_conversion_ledger') }} as a
        on a.adjusts_event_id = hp.event_id
       and a.event_name in ('refund', 'chargeback')
       and a.occurred_at <= {{ as_of_ts() }}
    group by hp.user_id

),

horizon_money as (

    select
        user_id,
        sum(revenue_reporting) as gross_revenue_horizon_usd,
        sum(cash_value_reporting) as gross_cash_horizon_usd,
        count(*) as charges_horizon
    from horizon_purchases
    group by user_id

),

horizon_generations as (

    select
        f.user_id,
        sum(case when g.credit_field <> 'trial_credit_balance' and not g.is_failed_generation then g.credits_costed else 0 end) as paid_credits_horizon,
        sum(g.cost_usd) as generation_cost_horizon_usd
    from features as f
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = f.user_id
       and g.created_at >= f.signup_at
       and g.created_at < f.horizon_end
    group by f.user_id

),

outcomes as (

    select
        f.user_id,
        f.segment,
        f.signup_at,
        f.signup_week,
        f.cf_fold,
        f.arm_create_image,
        f.arm_create_video,
        f.maturity_end <= {{ as_of_ts() }} as is_conversion_mature,
        f.horizon_end <= {{ as_of_ts() }} as is_horizon_complete,
        coalesce(fs.first_subscription_at >= f.feature_window_end and fs.first_subscription_at < f.maturity_end, false) as converted_after_24h,
        coalesce(fs.first_subscription_at >= f.signup_at and fs.first_subscription_at < f.horizon_end, false) as converted_in_horizon,
        case when fs.first_subscription_at >= f.feature_window_end and fs.first_subscription_at < f.maturity_end
             then fs.first_subscription_cash_usd end as first_subscription_cash_usd,
        coalesce(hm.gross_revenue_horizon_usd, 0) as gross_revenue_horizon_usd,
        coalesce(hm.gross_cash_horizon_usd, 0) as gross_cash_horizon_usd,
        coalesce(hm.charges_horizon, 0) as charges_horizon,
        coalesce(ha.adjustments_usd, 0) as adjustments_horizon_usd,
        coalesce(ha.chargebacks, 0) as chargebacks_horizon,
        coalesce(hg.paid_credits_horizon, 0) as paid_credits_horizon,
        coalesce(hg.generation_cost_horizon_usd, 0) as generation_cost_horizon_usd,
        coalesce(acq.acquisition_channel = 'affiliate', false) as is_affiliate
    from features as f
    left join first_subscription as fs on fs.user_id = f.user_id
    left join horizon_money as hm on hm.user_id = f.user_id
    left join horizon_adjustments as ha on ha.user_id = f.user_id
    left join horizon_generations as hg on hg.user_id = f.user_id
    left join {{ ref('int_user__acquisition') }} as acq on acq.user_id = f.user_id

)

select
    o.*,
    round(
        o.gross_cash_horizon_usd * {{ var('payment_fee_pct') }}
        + o.charges_horizon * {{ var('payment_fee_fixed_usd') }}
        + case when o.is_affiliate then o.gross_revenue_horizon_usd * {{ var('affiliate_commission_pct') }} else 0 end
        + o.chargebacks_horizon * {{ var('dispute_fee_usd') }},
        6
    ) as fees_horizon_usd,
    round(
        o.gross_revenue_horizon_usd + o.adjustments_horizon_usd - o.generation_cost_horizon_usd
        - (o.gross_cash_horizon_usd * {{ var('payment_fee_pct') }}
           + o.charges_horizon * {{ var('payment_fee_fixed_usd') }}
           + case when o.is_affiliate then o.gross_revenue_horizon_usd * {{ var('affiliate_commission_pct') }} else 0 end
           + o.chargebacks_horizon * {{ var('dispute_fee_usd') }}),
        6
    ) as realized_profit_90d
from outcomes as o
