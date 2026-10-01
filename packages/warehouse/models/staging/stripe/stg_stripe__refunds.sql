-- charge.refunded carries the CUMULATIVE amount_refunded. One row per refund step:
-- the step amount is the increase over the previous cumulative value for the same charge
-- (previous_attributes is a cross-check, not relied on: older API versions and replays omit it).
with refund_events as (

    select
        stripe_event_id,
        created_at as refunded_at,
        {{ json_str('event_object', '$.id') }} as charge_id,
        {{ json_str('event_object', '$.customer') }} as user_id,
        {{ json_str('event_object', '$.payment_intent') }} as payment_intent_id,
        {{ json_str('event_object', '$.invoice') }} as legacy_invoice_id,
        {{ json_int('event_object', '$.amount') }} as charge_amount_minor,
        {{ json_int('event_object', '$.amount_refunded') }} as amount_refunded_cumulative_minor,
        {{ json_int('previous_attributes', '$.amount_refunded') }} as previous_amount_refunded_minor,
        upper({{ json_str('event_object', '$.currency') }}) as currency
    from {{ ref('stg_stripe__events') }}
    where event_type = 'charge.refunded'

),

one_per_step as (

    -- Two events reporting the same cumulative amount describe the same refund step.
    select
        *,
        row_number() over (
            partition by charge_id, amount_refunded_cumulative_minor
            order by refunded_at, stripe_event_id
        ) as step_duplicate_number
    from refund_events
    where amount_refunded_cumulative_minor > 0

)

select
    stripe_event_id,
    refunded_at,
    charge_id,
    user_id,
    payment_intent_id,
    legacy_invoice_id,
    charge_amount_minor,
    amount_refunded_cumulative_minor,
    previous_amount_refunded_minor,
    amount_refunded_cumulative_minor - coalesce(
        lag(amount_refunded_cumulative_minor) over (partition by charge_id order by amount_refunded_cumulative_minor),
        0
    ) as refund_step_minor,
    currency
from one_per_step
where step_duplicate_number = 1
