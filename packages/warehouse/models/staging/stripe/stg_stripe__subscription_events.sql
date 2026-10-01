-- customer.subscription.created / .updated / .deleted: subscription state after each change.
select
    stripe_event_id,
    event_type,
    created_at as changed_at,
    object_id as subscription_id,
    {{ json_str('event_object', '$.customer') }} as user_id,
    {{ json_str('event_object', '$.status') }} as subscription_status,
    coalesce({{ json_bool('event_object', '$.cancel_at_period_end') }}, false) as cancel_at_period_end,
    {{ ts_from_unix_seconds(json_int('event_object', '$.cancel_at')) }} as cancel_at,
    {{ ts_from_unix_seconds(json_int('event_object', '$.canceled_at')) }} as canceled_at,
    {{ ts_from_unix_seconds(json_int('event_object', '$.ended_at')) }} as ended_at,
    {{ json_str('event_object', '$.latest_invoice') }} as latest_invoice_id,
    {{ json_query('event_object', '$.items') }} as items,
    previous_attributes
from {{ ref('stg_stripe__events') }}
where event_type in ('customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted')
