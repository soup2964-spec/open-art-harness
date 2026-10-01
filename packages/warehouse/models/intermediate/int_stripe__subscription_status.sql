-- One row per subscription with its state at the as-of instant. Active = not deleted and the
-- latest PAID SERVICE PERIOD has not ended (cancel-at-period-end subscriptions stay active until
-- then). The service period is the subscription line's period (lines.data[].period) of non-proration
-- lines: on real Stripe invoices the invoice-level period_start/period_end describe the PREVIOUS
-- period (database review 1), so they are only a fallback for invoices without line periods.
with paid_invoices as (

    select invoice_id, subscription_id, user_id, paid_at, period_end
    from {{ ref('stg_stripe__invoices') }}
    where invoice_status = 'paid'
      and subscription_id is not null
      and paid_at <= {{ as_of_ts() }}

),

line_periods as (

    select l.invoice_id, max(l.line_period_end) as line_period_end
    from {{ ref('stg_stripe__invoice_lines') }} as l
    where not l.is_proration
      and l.line_period_end is not null
    group by l.invoice_id

),

paid as (

    select
        i.subscription_id,
        i.user_id,
        min(i.paid_at) as first_paid_at,
        max(coalesce(lp.line_period_end, i.period_end)) as current_period_end
    from paid_invoices as i
    left join line_periods as lp on lp.invoice_id = i.invoice_id
    group by i.subscription_id, i.user_id

),

deletions as (

    select subscription_id, min(changed_at) as deleted_at
    from {{ ref('stg_stripe__subscription_events') }}
    where event_type = 'customer.subscription.deleted'
      and changed_at <= {{ as_of_ts() }}
    group by subscription_id

),

latest_plan as (

    select subscription_id, plan_tier, billing_interval
    from (
        select
            subscription_id,
            plan_tier,
            billing_interval,
            row_number() over (partition by subscription_id order by occurred_at desc, event_id desc) as purchase_rank
        from {{ ref('int_stripe__purchases') }}
        where subscription_id is not null and plan_tier is not null
    ) as ranked
    where purchase_rank = 1

)

select
    p.subscription_id,
    p.user_id,
    p.first_paid_at,
    p.current_period_end,
    d.deleted_at,
    lp.plan_tier,
    lp.billing_interval,
    case
        when d.deleted_at is not null then 'canceled'
        when p.current_period_end > {{ as_of_ts() }} then 'active'
        else 'lapsed'
    end as status_as_of
from paid as p
left join deletions as d on d.subscription_id = p.subscription_id
left join latest_plan as lp on lp.subscription_id = p.subscription_id
