-- Every source record the warehouse could not use as-is, one row per (issue, record), instead of an
-- error-severity test that stops the whole build (database review 2: one unlisted Stripe event type
-- used to skip 207 of 309 nodes; one orphan chargeback, 135). Each issue is warned about by
-- tests/singular/assert_quarantine_is_empty.sql; alert on it in production.
--   severity  excluded  the record is kept OUT of the ledger / scores (money, if any, in money_minor)
--             flagged   the record is used, but something about it needs a person
-- ledger_cash_difference_minor = what the ledger records minus what raw Stripe moved for the record,
-- so assert_ledger_net_cash_matches_stripe can prove ledger net = Stripe net + these differences.
with issues as (

    select
        'stripe_event_type_not_handled' as issue,
        'flagged' as severity,
        'stg_stripe__events' as source_model,
        e.stripe_event_id as record_id,
        cast(null as {{ dbt.type_string() }}) as user_id,
        e.created_at as occurred_at,
        cast(null as {{ dbt.type_bigint() }}) as money_minor,
        cast(null as {{ dbt.type_string() }}) as currency,
        cast(0 as {{ dbt.type_bigint() }}) as ledger_cash_difference_minor,
        e.event_type as detail
    from {{ ref('stg_stripe__events') }} as e
    where not e.is_handled_type

    union all

    select
        'invoice_line_unknown_price', 'flagged', 'stg_stripe__invoice_lines', l.line_id, l.user_id,
        cast(null as {{ dbt.type_timestamp() }}), l.amount_minor, l.currency, cast(0 as {{ dbt.type_bigint() }}),
        'price ' || coalesce(l.price_id, 'NULL') || ' is not in seeds/plan_catalog.csv (plan tier / interval may be wrong)'
    from {{ ref('stg_stripe__invoice_lines') }} as l
    where l.price_id is null
       or not exists (select 1 from {{ ref('plan_catalog') }} as c where c.price_id = l.price_id)

    union all

    select
        'purchase_unclassified', 'excluded', 'int_stripe__purchases', p.event_id, p.user_id,
        p.occurred_at, p.cash_value_minor, p.currency, -p.cash_value_minor,
        'billing_reason ' || coalesce(p.billing_reason, 'NULL') || ' has no canonical purchase event: kept out of the ledger'
    from {{ ref('int_stripe__purchases') }} as p
    where p.event_name is null

    union all

    select
        'money_without_fx_rate', 'excluded', 'int_stripe__purchases', p.event_id, p.user_id,
        p.occurred_at, p.cash_value_minor, p.currency, cast(0 as {{ dbt.type_bigint() }}),
        'no FX rate for ' || coalesce(p.currency, 'NULL') || ' on that date (seeds/fx_rates.csv): not valued, not scored'
    from {{ ref('int_stripe__purchases') }} as p
    where p.cash_value_reporting is null

    union all

    select
        'adjustment_not_linked_to_purchase', 'flagged', 'int_stripe__adjustments', a.event_id, a.user_id,
        a.occurred_at, a.ledger_cash_value_minor, a.currency, cast(0 as {{ dbt.type_bigint() }}),
        a.event_name || ' on charge ' || coalesce(a.charge_id, 'NULL') || ' matches no purchase key: in the ledger without adjusts_event_id'
    from {{ ref('int_stripe__adjustments') }} as a
    where a.adjusts_event_id is null

    union all

    select
        'dispute_' || a.disposition, 'flagged', 'int_stripe__adjustments', a.event_id, a.user_id,
        a.occurred_at, a.cash_value_minor, a.currency,
        -- Stripe withdrew the disputed amount; the ledger records only what was left (or nothing)
        case when a.disposition = 'dispute_after_full_refund' or (a.disposition = 'chargeback' and a.ledger_cash_value_minor <> a.cash_value_minor)
             then a.ledger_cash_value_minor - a.cash_value_minor else 0 end,
        'dispute of ' || cast(-a.cash_value_minor as {{ dbt.type_string() }}) || ' recorded as ' || cast(-a.ledger_cash_value_minor as {{ dbt.type_string() }})
    from {{ ref('int_stripe__adjustments') }} as a
    where a.event_name = 'chargeback'
      and (a.disposition in ('dispute_after_full_refund', 'dispute_won_or_inquiry') or a.ledger_cash_value_minor <> a.cash_value_minor)

    union all

    select
        'ledger_entry_without_user', 'excluded', 'raw credit ledger', r.id, cast(null as {{ dbt.type_string() }}),
        cast(null as {{ dbt.type_timestamp() }}), cast(null as {{ dbt.type_bigint() }}), cast(null as {{ dbt.type_string() }}), cast(0 as {{ dbt.type_bigint() }}),
        'credit ledger entry ' || r.type || ' has no userId'
    from {{ source('app', 'credit_ledger') }} as r
    where r.userId is null

    union all

    select
        'stripe_customer_not_an_app_user', 'flagged', 'stg_stripe__invoices', s.user_id, s.user_id,
        cast(null as {{ dbt.type_timestamp() }}), cast(null as {{ dbt.type_bigint() }}), cast(null as {{ dbt.type_string() }}), cast(0 as {{ dbt.type_bigint() }}),
        'Stripe customer id has no row in the app users table (the customer id must be the OpenArt uid)'
    from (
        select user_id from {{ ref('stg_stripe__invoices') }} where user_id is not null
        union distinct
        select user_id from {{ ref('stg_stripe__checkout_sessions') }} where user_id is not null
    ) as s
    where not exists (select 1 from {{ ref('stg_app__users') }} as u where u.user_id = s.user_id)

)

select
    issue,
    severity,
    source_model,
    record_id,
    user_id,
    occurred_at,
    money_minor,
    currency,
    ledger_cash_difference_minor,
    detail,
    {{ as_of_ts() }} as detected_as_of
from issues
