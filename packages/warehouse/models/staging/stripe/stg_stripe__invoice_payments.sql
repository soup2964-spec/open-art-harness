-- invoice_payment.paid: since API 2025-03-31.basil the only join from a charge/payment
-- intent back to its invoice (a Charge has no `invoice` field any more).
with payments as (

    select
        object_id as invoice_payment_id,
        stripe_event_id,
        created_at as event_created_at,
        event_object as pay,
        row_number() over (partition by object_id order by created_at, stripe_event_id) as event_number
    from {{ ref('stg_stripe__events') }}
    where event_type = 'invoice_payment.paid'

)

select
    invoice_payment_id,
    stripe_event_id,
    {{ json_str('pay', '$.invoice') }} as invoice_id,
    {{ json_str('pay', '$.payment.type') }} as payment_type,
    {{ json_str('pay', '$.payment.payment_intent') }} as payment_intent_id,
    {{ json_str('pay', '$.payment.charge') }} as charge_id,
    {{ json_int('pay', '$.amount_paid') }} as amount_paid_minor,
    upper({{ json_str('pay', '$.currency') }}) as currency,
    {{ json_str('pay', '$.status') }} as payment_status,
    {{ ts_from_unix_seconds(json_int('pay', '$.created')) }} as payment_created_at,
    event_created_at
from payments
where event_number = 1
