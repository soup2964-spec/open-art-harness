-- Realised outcome of each purchase over the fixed horizon [purchase, purchase + pp_horizon_days):
-- what E[gross profit over 90 days | purchase] is fit on and evaluated against.
--   realized_profit_90d = tax-exclusive revenue of the user's purchases in the window (this one
--                         included) - their refunds/chargebacks in the window - serving cost of the
--                         user's generations in the window - payment, affiliate and dispute fees
-- Only rows with is_horizon_complete are ever used as outcomes. Also: whether a monthly charge
-- renewed within 45 days (the renewal survival the score is built from), and when that became
-- observable.
{% set horizon_s = var('pp_horizon_days') * 86400 %}

with purchases as (

    select event_id, event_name, user_id, subscription_id, occurred_at, billing_interval, purchase_kind, is_affiliate
    from {{ ref('int_pvs__features') }}

),

windows as (

    select
        p.*,
        {{ ts_add_seconds('p.occurred_at', horizon_s) }} as horizon_end
    from purchases as p

),

window_purchases as (

    select
        w.event_id,
        w.horizon_end,
        l.event_id as window_purchase_id,
        l.cash_value_reporting,
        l.revenue_reporting
    from windows as w
    inner join {{ ref('fct_conversion_ledger') }} as l
        on l.user_id = w.user_id
       and l.event_name like 'purchase%'
       and l.occurred_at >= w.occurred_at
       and l.occurred_at < w.horizon_end

),

money as (

    select
        event_id,
        sum(revenue_reporting) as revenue_90d,
        sum(cash_value_reporting) as cash_90d,
        count(*) as charges_90d
    from window_purchases
    group by event_id

),

adjustments as (

    select
        wp.event_id,
        sum(a.revenue_reporting) as adjustments_90d,
        sum(case when a.event_name = 'chargeback' then 1 else 0 end) as chargebacks_90d
    from window_purchases as wp
    inner join {{ ref('fct_conversion_ledger') }} as a
        on a.adjusts_event_id = wp.window_purchase_id
       and a.event_name in ('refund', 'chargeback')
       and a.occurred_at < wp.horizon_end
    group by wp.event_id

),

usage as (

    select
        w.event_id,
        sum(g.cost_usd) as generation_cost_90d,
        sum(case when g.credit_field <> 'trial_credit_balance' and not g.is_failed_generation then g.credits_costed else 0 end) as paid_credits_90d
    from windows as w
    inner join {{ ref('fct_generation_cost') }} as g
        on g.user_id = w.user_id
       and g.created_at >= w.occurred_at
       and g.created_at < w.horizon_end
    group by w.event_id

),

next_renewal as (

    select w.event_id, min(r.occurred_at) as next_renewal_at
    from windows as w
    inner join {{ ref('fct_conversion_ledger') }} as r
        on r.subscription_id = w.subscription_id
       and r.event_name = 'purchase_renewal'
       and r.occurred_at > w.occurred_at
    where w.subscription_id is not null
    group by w.event_id

)

select
    w.event_id,
    w.user_id,
    w.occurred_at,
    w.horizon_end,
    w.horizon_end <= {{ as_of_ts() }} as is_horizon_complete,
    round(coalesce(m.revenue_90d, 0), 6) as realized_revenue_90d,
    round(coalesce(m.cash_90d, 0), 6) as realized_cash_90d,
    coalesce(m.charges_90d, 0) as realized_charges_90d,
    round(coalesce(a.adjustments_90d, 0), 6) as realized_adjustments_90d,
    coalesce(a.chargebacks_90d, 0) as realized_chargebacks_90d,
    round(coalesce(u.generation_cost_90d, 0), 6) as realized_generation_cost_90d,
    coalesce(u.paid_credits_90d, 0) as realized_paid_credits_90d,
    round(
        coalesce(m.cash_90d, 0) * {{ var('payment_fee_pct') }}
        + coalesce(m.charges_90d, 0) * {{ var('payment_fee_fixed_usd') }}
        + case when w.is_affiliate then coalesce(m.revenue_90d, 0) * {{ var('affiliate_commission_pct') }} else 0 end
        + coalesce(a.chargebacks_90d, 0) * {{ var('dispute_fee_usd') }},
        6
    ) as realized_fees_90d,
    round(
        coalesce(m.revenue_90d, 0) + coalesce(a.adjustments_90d, 0) - coalesce(u.generation_cost_90d, 0)
        - (coalesce(m.cash_90d, 0) * {{ var('payment_fee_pct') }}
           + coalesce(m.charges_90d, 0) * {{ var('payment_fee_fixed_usd') }}
           + case when w.is_affiliate then coalesce(m.revenue_90d, 0) * {{ var('affiliate_commission_pct') }} else 0 end
           + coalesce(a.chargebacks_90d, 0) * {{ var('dispute_fee_usd') }}),
        6
    ) as realized_profit_90d,
    -- renewal survival: a monthly subscription charge either renews within 45 days or not;
    -- observable once 45 days have passed
    w.purchase_kind = 'monthly' and w.event_name in ('purchase_first', 'purchase_renewal', 'purchase_upgrade') as is_renewal_opportunity,
    {{ ts_add_seconds('w.occurred_at', 45 * 86400) }} <= {{ as_of_ts() }} as is_renewal_observable,
    coalesce(nr.next_renewal_at <= {{ ts_add_seconds('w.occurred_at', 45 * 86400) }}, false) as renewed_within_45d
from windows as w
left join money as m on m.event_id = w.event_id
left join adjustments as a on a.event_id = w.event_id
left join usage as u on u.event_id = w.event_id
left join next_renewal as nr on nr.event_id = w.event_id
