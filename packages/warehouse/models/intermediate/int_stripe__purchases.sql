-- Every money-in Stripe record, classified into the canonical purchase events
-- (integration-map §2.8):
--   subscription_create                      -> purchase_first (+ is_first_purchase)
--   subscription_cycle / subscription(_threshold) -> purchase_renewal
--   subscription_update with plan-change lines   -> purchase_upgrade
--   subscription_update with a CreditPack line   -> purchase_add_on
--   payment-mode Checkout                     -> purchase_one_time_pack
-- Any other billing_reason stays unclassified (event_name NULL): it is kept out of the ledger
-- and listed in fct_data_quality_quarantine (warned, not silently dropped).
--
-- Money columns:
--   cash_value_minor      what Stripe collected (amount_paid / amount_total), tax INCLUDED, in the
--                         charge currency's minor units (the ledger contract's value)
--   revenue_minor         the tax-exclusive part (amount_paid x total_excluding_tax / total;
--                         packs: amount_total - total_details.amount_tax)
--   *_reporting           both in MAJOR units of var reporting_currency, at the FX rate valid on
--                         the purchase date (int_fx__rates; minor-unit exponent per currency, so
--                         1400 JPY is 1,400 yen). NULL when the currency has no rate.

with sessions as (

    select *
    from {{ ref('stg_stripe__checkout_sessions') }}
    where session_status = 'complete'
      and payment_status = 'paid'

),

pack_sessions as (

    select * from sessions where checkout_mode = 'payment' and amount_total_minor > 0

),

invoices as (

    -- $0 invoices are not purchases (OpenArt runs no free trials: trial_period_days null, research/10 §5.3).
    select i.*
    from {{ ref('stg_stripe__invoices') }} as i
    where i.invoice_status = 'paid'
      and i.amount_paid_minor > 0
      and i.invoice_id not in (select p.invoice_id from pack_sessions as p where p.invoice_id is not null)

),

catalog as (

    select * from {{ ref('plan_catalog') }}

),

lines as (

    select
        l.invoice_id,
        l.line_id,
        l.amount_minor,
        l.quantity,
        c.item_type,
        c.plan_tier,
        c.billing_interval as price_billing_interval,
        c.plan_tier_code,
        c.unit_amount_minor as list_amount_minor
    from {{ ref('stg_stripe__invoice_lines') }} as l
    left join catalog as c on c.price_id = l.price_id

),

new_plan_line as (

    -- The plan the invoice charges for: its largest positive plan line.
    select *
    from (
        select
            invoice_id,
            plan_tier,
            price_billing_interval,
            plan_tier_code,
            list_amount_minor,
            row_number() over (partition by invoice_id order by amount_minor desc, line_id) as line_rank
        from lines
        where item_type = 'plan' and amount_minor > 0
    ) as ranked
    where line_rank = 1

),

old_plan_line as (

    -- "Unused time on <old plan>": the credit line of a plan change.
    select *
    from (
        select
            invoice_id,
            plan_tier as previous_plan_tier,
            list_amount_minor as previous_list_amount_minor,
            row_number() over (partition by invoice_id order by amount_minor, line_id) as line_rank
        from lines
        where item_type = 'plan' and amount_minor < 0
    ) as ranked
    where line_rank = 1

),

pack_lines as (

    select invoice_id, sum(quantity) as pack_line_quantity
    from lines
    where item_type = 'credit_pack' and amount_minor > 0
    group by invoice_id

),

unknown_price_lines as (

    select invoice_id, count(*) as unknown_lines
    from lines
    where item_type is null
    group by invoice_id

),

subscription_state as (

    -- Items after each customer.subscription.* change: plan and add-on pack quantity.
    select
        se.stripe_event_id,
        se.subscription_id,
        se.changed_at,
        coalesce(sum(case when c.item_type = 'credit_pack' then si.quantity end), 0) as pack_quantity,
        max(case when c.item_type = 'plan' then c.plan_tier end) as plan_tier,
        max(case when c.item_type = 'plan' then c.billing_interval end) as billing_interval,
        max(case when c.item_type = 'plan' then c.plan_tier_code end) as plan_tier_code
    from {{ ref('stg_stripe__subscription_events') }} as se
    left join {{ ref('stg_stripe__subscription_items') }} as si on si.stripe_event_id = se.stripe_event_id
    left join catalog as c on c.price_id = si.price_id
    group by se.stripe_event_id, se.subscription_id, se.changed_at

),

state_at_invoice as (

    -- Latest subscription state at or before the invoice was paid (Stripe emits the
    -- customer.subscription.updated for an add-on/upgrade in the same second as its invoice).
    select *
    from (
        select
            i.invoice_id,
            s.pack_quantity,
            s.plan_tier,
            s.billing_interval,
            s.plan_tier_code,
            row_number() over (partition by i.invoice_id order by s.changed_at desc, s.stripe_event_id desc) as state_rank
        from invoices as i
        inner join subscription_state as s
            on s.subscription_id = i.subscription_id
           and s.changed_at <= i.paid_at
    ) as ranked
    where state_rank = 1

),

previous_invoice_plan as (

    -- Fallback for invoices without a plan line: the plan of the subscription's previous invoice.
    select *
    from (
        select
            i.invoice_id,
            np.plan_tier,
            np.price_billing_interval,
            np.plan_tier_code,
            row_number() over (partition by i.invoice_id order by prev.paid_at desc, prev.invoice_id desc) as prev_rank
        from invoices as i
        inner join invoices as prev
            on prev.subscription_id = i.subscription_id
           and prev.paid_at < i.paid_at
        inner join new_plan_line as np on np.invoice_id = prev.invoice_id
    ) as ranked
    where prev_rank = 1

),

invoice_payment as (

    select *
    from (
        select
            invoice_id,
            payment_intent_id,
            charge_id,
            row_number() over (partition by invoice_id order by payment_created_at, invoice_payment_id) as payment_rank
        from {{ ref('stg_stripe__invoice_payments') }}
    ) as ranked
    where payment_rank = 1

),

classified_invoices as (

    select
        i.invoice_id,
        i.paid_event_id as source_event_id,
        i.paid_at as occurred_at,
        i.user_id,
        i.subscription_id,
        i.amount_paid_minor as cash_value_minor,
        case
            when i.total_minor > 0 and i.total_excluding_tax_minor is not null
                then cast(round(i.amount_paid_minor * cast(i.total_excluding_tax_minor as {{ type_double() }}) / i.total_minor, 0) as {{ dbt.type_bigint() }})
            else i.amount_paid_minor
        end as revenue_minor,
        i.currency,
        i.billing_reason,
        i.period_start,
        i.period_end,
        np.plan_tier as new_plan_tier,
        op.previous_plan_tier,
        pl.pack_line_quantity,
        coalesce(up.unknown_lines, 0) > 0 as has_unknown_price_lines,
        coalesce(np.plan_tier, st.plan_tier, pp.plan_tier) as plan_tier,
        coalesce(np.plan_tier_code, st.plan_tier_code, pp.plan_tier_code) as plan_tier_code,
        coalesce(np.price_billing_interval, st.billing_interval, pp.price_billing_interval) as billing_interval,
        st.pack_quantity as state_pack_quantity,
        coalesce(ip.payment_intent_id, i.legacy_payment_intent_id) as payment_intent_id,
        coalesce(ip.charge_id, i.legacy_charge_id) as charge_id,
        case
            when i.billing_reason = 'subscription_create' then 'purchase_first'
            when i.billing_reason in ('subscription_cycle', 'subscription', 'subscription_threshold') then 'purchase_renewal'
            when i.billing_reason = 'subscription_update' and op.invoice_id is not null then 'purchase_upgrade'
            when i.billing_reason = 'subscription_update' and pl.invoice_id is not null then 'purchase_add_on'
            when i.billing_reason = 'subscription_update' then 'purchase_upgrade'
        end as event_name,
        case
            when i.billing_reason = 'subscription_create' then 'billing_reason_subscription_create'
            when i.billing_reason in ('subscription_cycle', 'subscription', 'subscription_threshold') then 'billing_reason_recurring'
            when i.billing_reason = 'subscription_update' and op.invoice_id is not null then 'plan_change_lines'
            when i.billing_reason = 'subscription_update' and pl.invoice_id is not null then 'credit_pack_line'
            when i.billing_reason = 'subscription_update' then 'subscription_update_other'
            else 'unclassified_billing_reason'
        end as classification_rule
    from invoices as i
    left join new_plan_line as np on np.invoice_id = i.invoice_id
    left join old_plan_line as op on op.invoice_id = i.invoice_id
    left join pack_lines as pl on pl.invoice_id = i.invoice_id
    left join unknown_price_lines as up on up.invoice_id = i.invoice_id
    left join state_at_invoice as st on st.invoice_id = i.invoice_id
    left join previous_invoice_plan as pp on pp.invoice_id = i.invoice_id
    left join invoice_payment as ip on ip.invoice_id = i.invoice_id

),

invoice_purchases as (

    select
        'purchase_' || c.invoice_id as event_id,
        'sub_' || c.invoice_id as order_id,
        c.event_name,
        c.occurred_at,
        c.source_event_id,
        c.user_id,
        c.invoice_id,
        c.subscription_id,
        s.checkout_session_id,
        c.payment_intent_id,
        c.charge_id,
        c.cash_value_minor,
        c.revenue_minor,
        c.currency,
        c.plan_tier,
        c.plan_tier_code,
        c.billing_interval,
        case when c.event_name = 'purchase_upgrade' then c.previous_plan_tier end as previous_plan_tier,
        case
            when c.event_name in ('purchase_add_on', 'purchase_upgrade')
                then coalesce(nullif(c.state_pack_quantity, 0), c.pack_line_quantity)
            else c.pack_line_quantity
        end as credit_pack_quantity,
        -- Mirrors the invoice lookup's isFirstPurchase: the user's first paid invoice ever.
        row_number() over (partition by c.user_id order by c.occurred_at, c.invoice_id) = 1 as is_first_purchase,
        coalesce(c.plan_tier in ('team', 'business'), false) as is_business,
        c.billing_reason,
        c.classification_rule,
        c.has_unknown_price_lines,
        s.ga_client_id,
        s.ga_session_id,
        s.tolt_referral
    from classified_invoices as c
    left join sessions as s
        on s.invoice_id = c.invoice_id
       and s.checkout_mode = 'subscription'
       and c.event_name = 'purchase_first'

),

pack_purchases as (

    select
        'purchase_' || coalesce(p.invoice_id, p.checkout_session_id) as event_id,
        'sub_' || coalesce(p.invoice_id, p.checkout_session_id) as order_id,
        'purchase_one_time_pack' as event_name,
        p.completed_at as occurred_at,
        p.completed_event_id as source_event_id,
        p.user_id,
        p.invoice_id,
        cast(null as {{ dbt.type_string() }}) as subscription_id,
        p.checkout_session_id,
        p.payment_intent_id,
        cast(null as {{ dbt.type_string() }}) as charge_id,
        p.amount_total_minor as cash_value_minor,
        p.amount_total_minor - coalesce(p.amount_tax_minor, 0) as revenue_minor,
        p.currency,
        cast(null as {{ dbt.type_string() }}) as plan_tier,
        cast(null as {{ dbt.type_int() }}) as plan_tier_code,
        cast(null as {{ dbt.type_string() }}) as billing_interval,
        cast(null as {{ dbt.type_string() }}) as previous_plan_tier,
        cast(null as {{ dbt.type_int() }}) as credit_pack_quantity,
        cast(null as {{ dbt.type_boolean() }}) as is_first_purchase,
        false as is_business,
        cast(null as {{ dbt.type_string() }}) as billing_reason,
        'payment_mode_checkout' as classification_rule,
        false as has_unknown_price_lines,
        p.ga_client_id,
        p.ga_session_id,
        p.tolt_referral
    from pack_sessions as p

),

all_purchases as (

    select * from invoice_purchases
    union all
    select * from pack_purchases

)

select
    p.event_id,
    p.order_id,
    p.event_name,
    p.occurred_at,
    p.source_event_id,
    p.user_id,
    p.invoice_id,
    p.subscription_id,
    p.checkout_session_id,
    p.payment_intent_id,
    p.charge_id,
    p.cash_value_minor,
    p.revenue_minor,
    p.currency,
    '{{ var("reporting_currency") }}' as reporting_currency,
    fx.reporting_per_unit as fx_rate_to_reporting,
    round(p.cash_value_minor / power(10, fx.minor_unit_digits) * fx.reporting_per_unit, 6) as cash_value_reporting,
    round(p.revenue_minor / power(10, fx.minor_unit_digits) * fx.reporting_per_unit, 6) as revenue_reporting,
    plan_tier,
    plan_tier_code,
    billing_interval,
    previous_plan_tier,
    credit_pack_quantity,
    case
        when event_name = 'purchase_one_time_pack'
            -- A pack is "first" when no earlier purchase of any kind exists (contracts golden row).
            then row_number() over (partition by user_id order by occurred_at, event_id) = 1
        else is_first_purchase
    end as is_first_purchase,
    is_business,
    billing_reason,
    classification_rule,
    has_unknown_price_lines,
    ga_client_id,
    ga_session_id,
    tolt_referral
from all_purchases as p
left join {{ ref('int_fx__rates') }} as fx
    on fx.currency = p.currency
   and fx.valid_from <= cast(p.occurred_at as date)
   and (fx.valid_to is null or cast(p.occurred_at as date) < fx.valid_to)
