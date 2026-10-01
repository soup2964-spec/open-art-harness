-- Invoice line items (from the invoice.paid payload). The price id decides plan tier,
-- interval and whether a line is the Extra Credit add-on.
select
    i.invoice_id,
    i.user_id,
    {{ json_str('line', '$.id') }} as line_id,
    line_idx as line_position,
    {{ json_int('line', '$.amount') }} as amount_minor,
    upper({{ json_str('line', '$.currency') }}) as currency,
    coalesce(
        {{ json_str('line', '$.pricing.price_details.price') }},
        {{ json_str('line', '$.price.id') }}
    ) as price_id,
    coalesce(
        {{ json_str('line', '$.pricing.price_details.product') }},
        {{ json_str('line', '$.price.product') }}
    ) as product_id,
    {{ json_int('line', '$.quantity') }} as quantity,
    coalesce(
        {{ json_bool('line', '$.parent.subscription_item_details.proration') }},
        {{ json_bool('line', '$.proration') }},
        false
    ) as is_proration,
    coalesce(
        {{ json_str('line', '$.parent.subscription_item_details.subscription_item') }},
        {{ json_str('line', '$.subscription_item') }}
    ) as subscription_item_id,
    {{ ts_from_unix_seconds(json_int('line', '$.period.start')) }} as line_period_start,
    {{ ts_from_unix_seconds(json_int('line', '$.period.end')) }} as line_period_end,
    {{ json_str('line', '$.description') }} as line_description
from {{ ref('stg_stripe__invoices') }} as i
{{ json_array_join('i.lines', '$.data', 'line') }}
