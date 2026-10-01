-- One row per (purchase, ad platform): everything needed to rebuild, step by step, what each
-- platform reports for that purchase TODAY (seeds/platform_reporting_rules.csv; research/02 §3.2,
-- research/11 §3). QA accounts are excluded, as they are from Stripe truth.
with purchases as (

    select
        event_id,
        event_name,
        user_id,
        occurred_at,
        checkout_session_id,
        cash_value_minor,
        -- what the tag sends is the amount charged (tax included), in the reporting currency
        cash_value_reporting,
        is_first_purchase,
        plan_tier,
        billing_interval
    from {{ ref('fct_conversion_ledger') }}
    where event_name like 'purchase%'
      and not is_qa_account

),

adjustments as (

    -- Refunds and chargebacks of the purchase known at as-of (platforms never net these today).
    select adjusts_event_id, -sum(cash_value_reporting) as adjusted_reporting
    from {{ ref('fct_conversion_ledger') }}
    where event_name in ('refund', 'chargeback')
      and occurred_at <= {{ as_of_ts() }}
    group by adjusts_event_id

),

rules as (

    select * from {{ ref('platform_reporting_rules') }}

),

platform_clicks as (

    -- The platform's most recent click before the purchase (int_user__click_ids keeps every
    -- stored click, so a re-click after the purchase cannot hide the one before it).
    select
        p.event_id,
        c.platform,
        max(c.click_id_created_at) as click_at
    from purchases as p
    inner join {{ ref('int_user__click_ids') }} as c
        on c.user_id = p.user_id
       and c.click_id_created_at <= p.occurred_at
    group by p.event_id, c.platform

),

facts as (

    select
        p.event_id,
        p.event_name,
        p.user_id,
        p.occurred_at,
        r.platform,
        r.scope,
        r.value_rule,
        r.events_per_purchase,
        r.accepts_fallback_value,
        r.click_window_days,
        r.date_basis,
        r.account_timezone,
        p.cash_value_reporting as gross_usd,
        p.cash_value_reporting - coalesce(a.adjusted_reporting, 0) as net_usd,
        case r.scope
            when 'every_subscription_checkout' then p.event_name = 'purchase_first'
            when 'first_valid_purchase' then p.event_name = 'purchase_first' and coalesce(p.is_first_purchase, false)
            else false
        end as in_scope,
        -- blocker proxy: a user with no Amplitude events never ran the browser tags either
        coalesce(pr.has_amplitude_events, false) as browser_can_send,
        -- a purchase with no logged lookup is assumed to have resolved (flagged by lookup_logged)
        lk.checkout_session_id is not null as lookup_logged,
        coalesce(lk.lookup_ok, true) as lookup_ok,
        lk.ltv_value_major,
        fb.fallback_value_usd,
        pc.click_at
    from purchases as p
    cross join rules as r
    left join adjustments as a on a.adjusts_event_id = p.event_id
    left join {{ ref('int_user__profile') }} as pr on pr.user_id = p.user_id
    left join {{ ref('stg_app__invoice_lookups') }} as lk on lk.checkout_session_id = p.checkout_session_id
    left join {{ ref('fallback_price_table') }} as fb
        on fb.plan_tier = p.plan_tier and fb.billing_interval = p.billing_interval
    left join platform_clicks as pc on pc.event_id = p.event_id and pc.platform = r.platform

)

select
    f.*,
    -- value the tag would send if the invoice lookup succeeded
    round(
        case f.value_rule
            when 'invoice_amount' then f.gross_usd
            when 'ltv_else_amount' then coalesce(f.ltv_value_major, f.gross_usd)
            else 0
        end,
        2
    ) as rule_value_usd,
    -- whether the platform receives the purchase at all, given the lookup outcome
    (f.lookup_ok or f.accepts_fallback_value) as delivered,
    -- value actually sent: the rule value, or the stale fallback price when the lookup failed
    round(
        case
            when f.lookup_ok then
                case f.value_rule
                    when 'invoice_amount' then f.gross_usd
                    when 'ltv_else_amount' then coalesce(f.ltv_value_major, f.gross_usd)
                    else 0
                end
            when f.accepts_fallback_value then
                case when f.value_rule = 'none' then 0 else coalesce(f.fallback_value_usd, 0) end
            else 0
        end,
        2
    ) as sent_value_usd,
    f.click_at is not null as attributed,
    coalesce({{ ts_diff_seconds('f.occurred_at', 'f.click_at') }} <= f.click_window_days * 86400, false) as within_window,
    {{ month_start(date_in_tz('f.occurred_at', "'UTC'")) }} as month_utc,
    {{ month_start(date_in_tz('f.occurred_at', 'f.account_timezone')) }} as month_account_tz,
    case
        when f.date_basis = 'click' and f.click_at is not null
            then {{ month_start(date_in_tz('f.click_at', 'f.account_timezone')) }}
        else {{ month_start(date_in_tz('f.occurred_at', 'f.account_timezone')) }}
    end as month_report_basis
from facts as f
