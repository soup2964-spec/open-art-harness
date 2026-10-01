-- Paid invoices (invoice.paid). One row per invoice: Stripe can also double-generate an event,
-- so dedupe on the invoice id, not only on the event id (research/08 §6.2).
with paid as (

    select
        object_id as invoice_id,
        stripe_event_id as paid_event_id,
        created_at as paid_event_created_at,
        event_object as inv,
        row_number() over (partition by object_id order by created_at, stripe_event_id) as event_number
    from {{ ref('stg_stripe__events') }}
    where event_type = 'invoice.paid'

)

select
    invoice_id,
    paid_event_id,
    paid_event_created_at,
    -- At OpenArt the Stripe customer id IS the OpenArt uid (research/10 §7).
    {{ json_str('inv', '$.customer') }} as user_id,
    {{ json_str('inv', '$.status') }} as invoice_status,
    {{ json_str('inv', '$.billing_reason') }} as billing_reason,
    upper({{ json_str('inv', '$.currency') }}) as currency,
    {{ json_int('inv', '$.amount_paid') }} as amount_paid_minor,
    {{ json_int('inv', '$.total') }} as total_minor,
    {{ json_int('inv', '$.subtotal') }} as subtotal_minor,
    -- amount_paid includes tax; profit models use the tax-exclusive share (int_stripe__purchases)
    {{ json_int('inv', '$.total_excluding_tax') }} as total_excluding_tax_minor,
    {{ ts_from_unix_seconds(json_int('inv', '$.created')) }} as invoice_created_at,
    -- The canonical purchase time: when the invoice was paid.
    coalesce(
        {{ ts_from_unix_seconds(json_int('inv', '$.status_transitions.paid_at')) }},
        {{ ts_from_unix_seconds(json_int('inv', '$.created')) }}
    ) as paid_at,
    {{ ts_from_unix_seconds(json_int('inv', '$.period_start')) }} as period_start,
    {{ ts_from_unix_seconds(json_int('inv', '$.period_end')) }} as period_end,
    -- dahlia/basil: parent.subscription_details.subscription; legacy: top-level subscription.
    coalesce(
        {{ json_str('inv', '$.parent.subscription_details.subscription') }},
        {{ json_str('inv', '$.subscription') }}
    ) as subscription_id,
    {{ json_str('inv', '$.charge') }} as legacy_charge_id,
    {{ json_str('inv', '$.payment_intent') }} as legacy_payment_intent_id,
    coalesce({{ json_bool('inv', '$.lines.has_more') }}, false) as lines_has_more,
    {{ json_query('inv', '$.lines') }} as lines
from paid
where event_number = 1
