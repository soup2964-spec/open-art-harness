-- Items of the subscription as of each subscription event (price and quantity after the change).
select
    s.stripe_event_id,
    s.changed_at,
    s.subscription_id,
    s.user_id,
    {{ json_str('item', '$.id') }} as subscription_item_id,
    {{ json_str('item', '$.price.id') }} as price_id,
    {{ json_int('item', '$.quantity') }} as quantity
from {{ ref('stg_stripe__subscription_events') }} as s
{{ json_array_join('s.items', '$.data', 'item') }}
