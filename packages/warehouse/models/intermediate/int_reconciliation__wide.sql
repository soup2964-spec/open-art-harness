-- Stripe truth vs warehouse vs platform-reported purchases, per month and ad platform, as an
-- additive waterfall: every step is the change in (conversions, value) from applying one more
-- platform behaviour to the purchases, so
--     stripe_truth + sum(step deltas) = platform_reported      (exactly, by construction)
-- and `residual` is whatever the modelled behaviours do not explain.
--
-- Two layers per platform:
--   tag_received    what the platform's tag/pixel recorded (Events Manager / tag diagnostics)
--   ads_attributed  what the platform credits to its ads (Ads Manager / GAQL), which adds the
--                   attribution steps
-- Steps (research/08 §5.6 discrepancy checklist; platform rules in seeds/platform_reporting_rules.csv):
--   stripe_truth                 money-in from raw Stripe, net of refunds/disputes, by UTC purchase month
--   warehouse_vs_stripe          fct_conversion_ledger minus Stripe truth: pipeline defects (expect 0)
--   refunds_not_netted           platforms keep gross value; nobody sends retractions today
--   out_of_scope_purchase_types  renewals, upgrades, add-ons and packs never reach a tag; Meta/TikTok
--                                count the first valid purchase only
--   blocked_users                purchasers whose browser tags never ran (proxy: no Amplitude events)
--   double_counting              Google: both accounts count the same oid; X: tw-qwghh-13vj24 + gtm_purchase
--   ltv_in_value                 Meta/TikTok value = ltvValueMajor, not cash
--   value_not_sent               LinkedIn receives no value
--   fallback_misvaluation        failed invoice lookup: stale list price and unstable id (Google, Reddit,
--                                X, UET), or no event at all (Meta, TikTok)
--   time_zone                    months cut in the ad account's time zone instead of UTC
--   unattributed_users           purchasers with no click id from this platform
--   attribution_window           purchases outside the platform's click-through window
--   click_vs_conversion_date     platforms that report on the click date (Google) move purchases between months
-- On the local target the platform reports are SYNTHETIC (scripts/make_platform_reports.py).
--
-- This model holds the per (month, platform) totals every waterfall step is computed from; it is
-- materialised so fct_reconciliation's 29 step branches read a small table instead of
-- re-evaluating the whole CTE chain (BigQuery cost review). Money is in the reporting currency.

with facts as (

    select * from {{ ref('int_reconciliation__purchase_platform') }}

),

rules as (

    select platform, value_rule from {{ ref('platform_reporting_rules') }}

),

-- ----------------------------------------------------------- Stripe truth (independent path)
-- Built from the staging tables, not the ledger, with its own FX lookup and its own dispute rule:
-- a dispute takes only what earlier refunds left of the charge, won disputes take nothing.
truth_money_in as (

    select i.invoice_id as purchase_key, i.user_id, i.paid_at as purchased_at, i.amount_paid_minor as cash_minor, i.currency
    from {{ ref('stg_stripe__invoices') }} as i
    where i.invoice_status = 'paid'
      and i.amount_paid_minor > 0
      and not exists (
          select 1 from {{ ref('stg_stripe__checkout_sessions') }} as s
          where s.checkout_mode = 'payment' and s.invoice_id = i.invoice_id
      )

    union all

    select coalesce(s.invoice_id, s.checkout_session_id), s.user_id, s.completed_at, s.amount_total_minor, s.currency
    from {{ ref('stg_stripe__checkout_sessions') }} as s
    where s.checkout_mode = 'payment'
      and s.payment_status = 'paid'
      and s.amount_total_minor > 0

),

truth_payment_intents as (

    -- distinct: a pack Checkout with invoice_creation lists its payment intent twice
    -- (invoice_payment and the session), which double-counted its refund (database review 11)
    select distinct payment_intent_id, purchase_key
    from (
        select payment_intent_id, invoice_id as purchase_key
        from {{ ref('stg_stripe__invoice_payments') }}
        where payment_intent_id is not null

        union all

        select payment_intent_id, coalesce(invoice_id, checkout_session_id)
        from {{ ref('stg_stripe__checkout_sessions') }}
        where checkout_mode = 'payment' and payment_intent_id is not null
    ) as keys

),

truth_refunds as (

    select pi.purchase_key, r.refunded_at as out_at, r.refund_step_minor as out_minor
    from {{ ref('stg_stripe__refunds') }} as r
    inner join truth_payment_intents as pi on pi.payment_intent_id = r.payment_intent_id
    where r.refunded_at <= {{ as_of_ts() }}

),

truth_disputes as (

    select
        pi.purchase_key,
        d.disputed_at as out_at,
        -- capped at what refunds before it left of the charge
        {{ least_of('d.amount_minor', greatest_of('m.cash_minor - coalesce(refunded.before_minor, 0)', 0)) }} as out_minor
    from {{ ref('stg_stripe__disputes') }} as d
    inner join truth_payment_intents as pi on pi.payment_intent_id = d.payment_intent_id
    inner join truth_money_in as m on m.purchase_key = pi.purchase_key
    left join (
        select tr.purchase_key, td.dispute_id, sum(tr.out_minor) as before_minor
        from truth_refunds as tr
        inner join (
            select d2.dispute_id, pi2.purchase_key, d2.disputed_at
            from {{ ref('stg_stripe__disputes') }} as d2
            inner join truth_payment_intents as pi2 on pi2.payment_intent_id = d2.payment_intent_id
        ) as td on td.purchase_key = tr.purchase_key and tr.out_at < td.disputed_at
        group by tr.purchase_key, td.dispute_id
    ) as refunded on refunded.purchase_key = pi.purchase_key and refunded.dispute_id = d.dispute_id
    where d.disputed_at <= {{ as_of_ts() }}
      and d.is_money_lost

),

truth_money_out as (

    select purchase_key, sum(out_minor) as out_minor
    from (
        select purchase_key, out_minor from truth_refunds
        union all
        select purchase_key, out_minor from truth_disputes
    ) as money_out
    group by purchase_key

),

truth_fx as (

    select m.purchase_key, fx.reporting_per_unit, fx.minor_unit_digits
    from truth_money_in as m
    inner join {{ ref('int_fx__rates') }} as fx
        on fx.currency = m.currency
       and fx.valid_from <= cast(m.purchased_at as date)
       and (fx.valid_to is null or cast(m.purchased_at as date) < fx.valid_to)

),

stripe_truth as (

    select
        {{ month_start(date_in_tz('m.purchased_at', "'UTC'")) }} as period_month,
        count(*) as truth_n,
        sum((m.cash_minor - coalesce(o.out_minor, 0)) / power(10, fx.minor_unit_digits) * fx.reporting_per_unit) as truth_v
    from truth_money_in as m
    left join truth_money_out as o on o.purchase_key = m.purchase_key
    left join truth_fx as fx on fx.purchase_key = m.purchase_key
    where not exists (select 1 from {{ ref('qa_accounts') }} as q where q.user_id = m.user_id)
    group by {{ month_start(date_in_tz('m.purchased_at', "'UTC'")) }}

),

-- ------------------------------------------------ the platform view, one behaviour at a time
by_utc_month as (

    select
        platform,
        month_utc as period_month,
        count(*) as w_n,
        sum(net_usd) as w_v,
        sum(gross_usd) as gross_v,
        sum(case when in_scope then 1 else 0 end) as scope_n,
        sum(case when in_scope then gross_usd else 0 end) as scope_v,
        sum(case when in_scope and browser_can_send then 1 else 0 end) as sent_n,
        sum(case when in_scope and browser_can_send then gross_usd else 0 end) as sent_v,
        sum(case when in_scope and browser_can_send then events_per_purchase else 0 end) as counted_n,
        sum(case when in_scope and browser_can_send then gross_usd * events_per_purchase else 0 end) as counted_v,
        sum(case when in_scope and browser_can_send then rule_value_usd * events_per_purchase else 0 end) as valued_v,
        sum(case when in_scope and browser_can_send and delivered then events_per_purchase else 0 end) as delivered_n,
        sum(case when in_scope and browser_can_send and delivered then sent_value_usd * events_per_purchase else 0 end) as delivered_v
    from facts
    group by platform, month_utc

),

by_account_month as (

    select
        platform,
        month_account_tz as period_month,
        sum(case when in_scope and browser_can_send and delivered then events_per_purchase else 0 end) as tag_n,
        sum(case when in_scope and browser_can_send and delivered then sent_value_usd * events_per_purchase else 0 end) as tag_v,
        sum(case when in_scope and browser_can_send and delivered and attributed then events_per_purchase else 0 end) as attributed_n,
        sum(case when in_scope and browser_can_send and delivered and attributed then sent_value_usd * events_per_purchase else 0 end) as attributed_v,
        sum(case when in_scope and browser_can_send and delivered and attributed and within_window then events_per_purchase else 0 end) as window_n,
        sum(case when in_scope and browser_can_send and delivered and attributed and within_window then sent_value_usd * events_per_purchase else 0 end) as window_v
    from facts
    group by platform, month_account_tz

),

by_report_month as (

    select
        platform,
        month_report_basis as period_month,
        sum(case when in_scope and browser_can_send and delivered and attributed and within_window then events_per_purchase else 0 end) as ads_n,
        sum(case when in_scope and browser_can_send and delivered and attributed and within_window then sent_value_usd * events_per_purchase else 0 end) as ads_v
    from facts
    group by platform, month_report_basis

),

platform_reported as (

    select
        platform,
        report_month as period_month,
        sum(case when report_layer = 'tag_received' then conversions else 0 end) as actual_tag_n,
        sum(case when report_layer = 'tag_received' then conversion_value else 0 end) as actual_tag_v,
        sum(case when report_layer = 'ads_attributed' then conversions else 0 end) as actual_ads_n,
        sum(case when report_layer = 'ads_attributed' then conversion_value else 0 end) as actual_ads_v,
        max(data_origin) as platform_data_origin
    from {{ ref('stg_platforms__daily_conversions') }}
    group by platform, report_month

),

periods as (

    select period_month from stripe_truth
    union distinct select period_month from by_utc_month
    union distinct select period_month from by_account_month
    union distinct select period_month from by_report_month
    union distinct select period_month from platform_reported

),

wide as (

    select
        p.period_month,
        r.platform,
        r.value_rule,
        coalesce(t.truth_n, 0) as truth_n, coalesce(t.truth_v, 0) as truth_v,
        coalesce(u.w_n, 0) as w_n, coalesce(u.w_v, 0) as w_v,
        coalesce(u.gross_v, 0) as gross_v,
        coalesce(u.scope_n, 0) as scope_n, coalesce(u.scope_v, 0) as scope_v,
        coalesce(u.sent_n, 0) as sent_n, coalesce(u.sent_v, 0) as sent_v,
        coalesce(u.counted_n, 0) as counted_n, coalesce(u.counted_v, 0) as counted_v,
        coalesce(u.valued_v, 0) as valued_v,
        coalesce(u.delivered_n, 0) as delivered_n, coalesce(u.delivered_v, 0) as delivered_v,
        coalesce(a.tag_n, 0) as tag_n, coalesce(a.tag_v, 0) as tag_v,
        coalesce(a.attributed_n, 0) as attributed_n, coalesce(a.attributed_v, 0) as attributed_v,
        coalesce(a.window_n, 0) as window_n, coalesce(a.window_v, 0) as window_v,
        coalesce(b.ads_n, 0) as ads_n, coalesce(b.ads_v, 0) as ads_v,
        coalesce(pr.actual_tag_n, 0) as actual_tag_n, coalesce(pr.actual_tag_v, 0) as actual_tag_v,
        coalesce(pr.actual_ads_n, 0) as actual_ads_n, coalesce(pr.actual_ads_v, 0) as actual_ads_v,
        pr.platform_data_origin
    from periods as p
    cross join rules as r
    left join stripe_truth as t on t.period_month = p.period_month
    left join by_utc_month as u on u.period_month = p.period_month and u.platform = r.platform
    left join by_account_month as a on a.period_month = p.period_month and a.platform = r.platform
    left join by_report_month as b on b.period_month = p.period_month and b.platform = r.platform
    left join platform_reported as pr on pr.period_month = p.period_month and pr.platform = r.platform

)

select * from wide
