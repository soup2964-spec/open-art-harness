-- Completed Checkout Sessions. Subscription mode links the first invoice to the session;
-- payment mode is the one-time pack (no invoice unless invoice_creation is on).
with sessions as (

    select
        object_id as checkout_session_id,
        stripe_event_id as completed_event_id,
        created_at as completed_at,
        event_object as cs,
        row_number() over (partition by object_id order by created_at, stripe_event_id) as event_number
    from {{ ref('stg_stripe__events') }}
    where event_type = 'checkout.session.completed'

)

select
    checkout_session_id,
    completed_event_id,
    completed_at,
    {{ ts_from_unix_seconds(json_int('cs', '$.created')) }} as session_created_at,
    {{ json_str('cs', '$.mode') }} as checkout_mode,
    {{ json_str('cs', '$.status') }} as session_status,
    {{ json_str('cs', '$.payment_status') }} as payment_status,
    {{ json_str('cs', '$.customer') }} as user_id,
    {{ json_str('cs', '$.subscription') }} as subscription_id,
    {{ json_str('cs', '$.invoice') }} as invoice_id,
    {{ json_str('cs', '$.payment_intent') }} as payment_intent_id,
    {{ json_int('cs', '$.amount_total') }} as amount_total_minor,
    {{ json_int('cs', '$.amount_subtotal') }} as amount_subtotal_minor,
    -- tax collected on the session (included in amount_total)
    {{ json_int('cs', '$.total_details.amount_tax') }} as amount_tax_minor,
    upper({{ json_str('cs', '$.currency') }}) as currency,
    {{ json_str('cs', '$.client_reference_id') }} as client_reference_id,
    -- OpenArt's success_url carries tier=<code>&interval=<month|year>&uid=<uid> (research/10 §5.3).
    cast({{ regexp_extract_group(json_str('cs', '$.success_url'), '[?&]tier=([0-9]+)') }} as {{ dbt.type_int() }}) as success_url_tier_code,
    {{ regexp_extract_group(json_str('cs', '$.success_url'), '[?&]interval=([a-z]+)') }} as success_url_interval,
    -- The checkout form posts these to OpenArt; if the backend copies them into Session metadata
    -- they land here (NULL today in the fixtures).
    {{ json_str('cs', '$.metadata.ga_client_id') }} as ga_client_id,
    {{ json_str('cs', '$.metadata.ga_session_id') }} as ga_session_id,
    {{ json_str('cs', '$.metadata.tolt_referral') }} as tolt_referral
from sessions
where event_number = 1
