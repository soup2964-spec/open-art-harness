-- Refunds and disputes, each linked to the purchase it takes money back from.
--
-- Links (database review 3): a refund or dispute finds its purchase through ANY key the
-- purchase holds, in this order:
--   payment intent  invoice_payment.paid (API basil+: a Charge has no `invoice`) or the purchase's
--                   own payment_intent_id (packs; legacy invoice.payment_intent)
--   charge          invoice_payment.paid's charge or the purchase's own charge_id (legacy invoice.charge)
--   legacy invoice  charge.invoice on pre-basil refunds
-- An adjustment no key links is kept (money left Stripe) with adjusts_event_id NULL and listed in
-- fct_data_quality_quarantine; it never blocks the build.
--
-- Disputes (database review 2): a dispute can only take what is left of the purchase, so the
-- ledger amount is the disputed amount net of earlier refunds and earlier lost disputes; a dispute
-- that was won (funds reinstated) or is an inquiry takes nothing. Rows whose ledger amount is 0
-- stay here (disposition says why) but are not ledger events (is_ledger_event = FALSE).
-- restated_order_value_minor (what a value restatement sends) is clamped at 0.
-- *_reporting: var reporting_currency at the rate valid on the adjustment date (int_fx__rates).

with purchases as (

    select * from {{ ref('int_stripe__purchases') }} where event_name is not null

),

payment_intent_keys as (

    select ip.payment_intent_id, p.event_id, 1 as key_priority
    from {{ ref('stg_stripe__invoice_payments') }} as ip
    inner join purchases as p on p.invoice_id = ip.invoice_id
    where ip.payment_intent_id is not null
    union all
    select p.payment_intent_id, p.event_id, 2
    from purchases as p
    where p.payment_intent_id is not null

),

keys_by_payment_intent as (

    select payment_intent_id, event_id
    from (
        select *, row_number() over (partition by payment_intent_id order by key_priority, event_id) as key_rank
        from payment_intent_keys
    ) as ranked
    where key_rank = 1

),

charge_keys as (

    select ip.charge_id, p.event_id, 1 as key_priority
    from {{ ref('stg_stripe__invoice_payments') }} as ip
    inner join purchases as p on p.invoice_id = ip.invoice_id
    where ip.charge_id is not null
    union all
    select p.charge_id, p.event_id, 2
    from purchases as p
    where p.charge_id is not null

),

keys_by_charge as (

    select charge_id, event_id
    from (
        select *, row_number() over (partition by charge_id order by key_priority, event_id) as key_rank
        from charge_keys
    ) as ranked
    where key_rank = 1

),

refunds as (

    select
        'refund_' || r.charge_id || '_' || cast(r.amount_refunded_cumulative_minor as {{ dbt.type_string() }}) as event_id,
        'refund' as event_name,
        r.refunded_at as occurred_at,
        r.stripe_event_id as source_event_id,
        r.user_id as charge_user_id,
        r.charge_id,
        -r.refund_step_minor as cash_value_minor,
        r.currency,
        coalesce(bypi.event_id, bych.event_id, byinv.event_id) as adjusts_event_id,
        case
            when bypi.event_id is not null then 'payment_intent'
            when bych.event_id is not null then 'charge'
            when byinv.event_id is not null then 'legacy_invoice'
        end as link_path,
        cast(null as {{ dbt.type_string() }}) as dispute_reason,
        cast(null as {{ dbt.type_string() }}) as dispute_status,
        true as is_money_lost
    from {{ ref('stg_stripe__refunds') }} as r
    left join keys_by_payment_intent as bypi on bypi.payment_intent_id = r.payment_intent_id
    left join keys_by_charge as bych on bych.charge_id = r.charge_id
    left join purchases as byinv on byinv.invoice_id = r.legacy_invoice_id

),

chargebacks as (

    select
        'chargeback_' || d.dispute_id as event_id,
        'chargeback' as event_name,
        d.disputed_at as occurred_at,
        d.stripe_event_id as source_event_id,
        cast(null as {{ dbt.type_string() }}) as charge_user_id,
        d.charge_id,
        -d.amount_minor as cash_value_minor,
        d.currency,
        coalesce(bypi.event_id, bych.event_id) as adjusts_event_id,
        case
            when bypi.event_id is not null then 'payment_intent'
            when bych.event_id is not null then 'charge'
        end as link_path,
        d.dispute_reason,
        d.dispute_status,
        d.is_money_lost
    from {{ ref('stg_stripe__disputes') }} as d
    left join keys_by_payment_intent as bypi on bypi.payment_intent_id = d.payment_intent_id
    left join keys_by_charge as bych on bych.charge_id = d.charge_id

),

adjustments as (

    select * from refunds
    union all
    select * from chargebacks

),

sequenced as (

    -- money already taken back from the same purchase BEFORE this adjustment (refunds as
    -- recorded, disputes only when funds were lost), to net disputes against
    select
        a.*,
        coalesce(sum(case when a.is_money_lost then -a.cash_value_minor else 0 end) over (
            partition by a.adjusts_event_id
            order by a.occurred_at, a.event_id
            rows between unbounded preceding and 1 preceding
        ), 0) as taken_before_minor
    from adjustments as a

),

netted as (

    select
        s.*,
        case
            when not s.is_money_lost then 0
            when s.event_name = 'refund' or s.adjusts_event_id is null then s.cash_value_minor
            -- a dispute can only take what is left of the purchase
            else -{{ least_of('-s.cash_value_minor', greatest_of('p.cash_value_minor - s.taken_before_minor', 0)) }}
        end as ledger_cash_value_minor
    from sequenced as s
    left join purchases as p on p.event_id = s.adjusts_event_id

)

select
    a.event_id,
    a.event_name,
    a.occurred_at,
    a.source_event_id,
    coalesce(a.charge_user_id, p.user_id) as user_id,
    a.charge_id,
    -- what Stripe reported (a dispute's full amount), and what the ledger records after netting
    a.cash_value_minor,
    a.ledger_cash_value_minor,
    a.ledger_cash_value_minor < 0 as is_ledger_event,
    case
        when a.event_name = 'refund' then 'refund'
        when not a.is_money_lost then 'dispute_won_or_inquiry'
        when a.ledger_cash_value_minor = 0 then 'dispute_after_full_refund'
        else 'chargeback'
    end as disposition,
    a.currency,
    '{{ var("reporting_currency") }}' as reporting_currency,
    round(a.ledger_cash_value_minor / power(10, fx.minor_unit_digits) * fx.reporting_per_unit, 6) as cash_value_reporting,
    -- the tax-exclusive part of the money taken back (the purchase's revenue share)
    round(
        a.ledger_cash_value_minor / power(10, fx.minor_unit_digits) * fx.reporting_per_unit
        * coalesce(cast(p.revenue_minor as {{ type_double() }}) / nullif(p.cash_value_minor, 0), 1.0),
        6
    ) as revenue_reporting,
    a.adjusts_event_id,
    a.link_path,
    p.order_id as adjusts_order_id,
    p.invoice_id,
    p.subscription_id,
    p.plan_tier,
    p.plan_tier_code,
    p.billing_interval,
    p.cash_value_minor as adjusted_purchase_cash_minor,
    -- What a value restatement would send for the purchase after this adjustment (Google
    -- Data Manager / Microsoft adjustments): never below zero.
    case when p.event_id is not null then
        {{ greatest_of(
            'p.cash_value_minor + sum(a.ledger_cash_value_minor) over (partition by a.adjusts_event_id order by a.occurred_at, a.event_id rows between unbounded preceding and current row)',
            0
        ) }}
    end as restated_order_value_minor,
    a.dispute_reason,
    a.dispute_status
from netted as a
left join purchases as p on p.event_id = a.adjusts_event_id
left join {{ ref('int_fx__rates') }} as fx
    on fx.currency = a.currency
   and fx.valid_from <= cast(a.occurred_at as date)
   and (fx.valid_to is null or cast(a.occurred_at as date) < fx.valid_to)
