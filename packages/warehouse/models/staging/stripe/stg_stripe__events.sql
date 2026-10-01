-- One row per Stripe event id. Webhook endpoints can receive the same event more than once
-- and in any order (research/08 §6.2): keep the first delivery, never trust `created` order.
--
-- PII: only the whitelisted object fields (macros/openart/stripe.sql) are persisted; customer
-- email/name/address/phone, billing details, receipt and hosted-invoice URLs stay in raw.
-- As-of: deliveries received after the as-of instant are ignored, so a backfill pinned with
-- --vars '{as_of_timestamp: ...}' sees exactly what the warehouse knew then.
-- Unhandled event types are kept here (they cost nothing downstream: every stg_stripe__* model
-- filters its own types) and listed in fct_data_quality_quarantine; they never block the build.
with deliveries as (

    select
        id,
        type,
        created,
        api_version,
        livemode,
        data,
        received_at,
        row_number() over (partition by id order by received_at) as delivery_number
    from {{ source('stripe', 'events') }}
    where received_at <= {{ as_of_ts() }}
      {% if var('stripe_livemode_only') %}and livemode{% endif %}

),

first_delivery as (

    select
        id,
        type,
        created,
        api_version,
        livemode,
        received_at,
        {{ json_query('data', '$.object') }} as obj,
        {{ json_query('data', '$.previous_attributes') }} as prev
    from deliveries
    where delivery_number = 1

)

select
    id as stripe_event_id,
    type as event_type,
    created as created_unix,
    {{ ts_from_unix_seconds('created') }} as created_at,
    api_version,
    livemode,
    {{ stripe_object_whitelist('obj') }} as event_object,
    {{ stripe_previous_attributes_whitelist('prev') }} as previous_attributes,
    {{ json_str('obj', '$.id') }} as object_id,
    {{ json_str('obj', '$.object') }} as object_type,
    type in {{ sql_in(stripe_handled_event_types()) }} as is_handled_type,
    received_at
from first_delivery
